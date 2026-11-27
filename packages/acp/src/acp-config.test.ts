/** 防回归：模式通道优先级与模型 / 思考档完整刷新一致；所有进程和协议连接均为 mock。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { AcpConnection, AcpConnectionHandlers, AcpTurnSource } from './protocol/types'
import type { RunAcpAgentOptions } from './acp'

const mock = vi.hoisted(() => ({ connection: null as unknown as AcpConnection, handlers: null as unknown as AcpConnectionHandlers }))
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(),
  })),
}))
vi.mock('./protocol', async (importOriginal) => ({
  ...await importOriginal<typeof import('./protocol')>(),
  resolveAcpFactory: () => ({ connect: async (input: { handlers: AcpConnectionHandlers }) => {
    mock.handlers = input.handlers
    return mock.connection
  } }),
}))
import {
  createAcpSession, disposeAcpSessions, getAcpSessionSnapshot, probeAcpCapabilities,
  runAcpAgent, setAcpSessionConfigListener, setAcpSessionModel, setAcpSessionThoughtLevel, setAcpSessionMode, getAcpSessionModes,
} from './acp'

const agent = { id: 'opencode', name: 'OpenCode', command: 'mock-agent', args: [], type: 'opencode' as const }
const models = (currentValue = 'model-a') => ({
  id: 'model', category: 'model', type: 'select', currentValue,
  options: ['model-a', 'model-b', 'plain'].map((value) => ({ value, name: value })),
})

describe('ACP 模式通道', () => {
  const mode = { id: 'vendor.mode', category: 'mode', type: 'select', currentValue: 'build',
    options: [{ value: 'build', name: '构建' }, { value: 'plan', name: '规划' }] }
  const legacy = { currentModeId: 'build', availableModes: [{ id: 'build', name: '旧构建' }, { id: 'plan', name: '旧规划' }] }

  it('两种通道同时提供时，快照、查询与切换都优先 configOptions', async () => {
    vi.mocked(mock.connection.newSession).mockResolvedValueOnce({ source, configOptions: [mode], modes: legacy })
    await createAcpSession({ agent, conversationId: 'conv', workspacePath: '/workspace' })
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.modes?.configId).toBe('vendor.mode')
    expect(getAcpSessionModes(agent.id, 'conv').modes[0].name).toBe('构建')
    vi.mocked(mock.connection.setConfigOption).mockResolvedValueOnce([{ ...mode, currentValue: 'plan' }])
    expect(await setAcpSessionMode(agent.id, 'conv', 'plan')).toEqual({ ok: true })
    expect(mock.connection.setConfigOption).toHaveBeenCalledWith('session', 'vendor.mode', 'plan')
    expect(mock.connection.setMode).not.toHaveBeenCalled()
  })

  it('只有旧 Session Modes 时仍通过 set_mode 切换', async () => {
    vi.mocked(mock.connection.newSession).mockResolvedValueOnce({ source, configOptions: [], modes: legacy })
    await createAcpSession({ agent: { ...agent, type: 'generic' }, conversationId: 'conv', workspacePath: '/workspace' })
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.modes?.available).toEqual(legacy.availableModes)
    expect(await setAcpSessionMode(agent.id, 'conv', 'plan')).toEqual({ ok: true })
    expect(mock.connection.setMode).toHaveBeenCalledWith('session', 'plan')
    expect(mock.connection.setConfigOption).not.toHaveBeenCalled()
  })

  it('空闲配置通知可新增和明确移除模式，不依赖 Agent 类型', async () => {
    await createAcpSession({ agent: { ...agent, type: 'generic' }, conversationId: 'conv', workspacePath: '/workspace' })
    const listener = vi.fn()
    setAcpSessionConfigListener(agent.id, 'conv', listener)
    mock.handlers.onConfigOptions?.('session', [mode])
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.modes?.available.map((m) => m.id)).toEqual(['build', 'plan'])
    mock.handlers.onConfigOptions?.('session', [])
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.modes).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('完整配置移除 mode 时回落到独立的旧 Session Modes', async () => {
    vi.mocked(mock.connection.newSession).mockResolvedValueOnce({ source, configOptions: [mode], modes: legacy })
    await createAcpSession({ agent, conversationId: 'conv', workspacePath: '/workspace' })
    mock.handlers.onConfigOptions?.('session', [])
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.modes).toEqual({ available: legacy.availableModes, current: 'build' })
    expect((await setAcpSessionMode(agent.id, 'conv', 'plan')).ok).toBe(true)
    expect(mock.connection.setMode).toHaveBeenCalledWith('session', 'plan')
    expect(mock.connection.setConfigOption).not.toHaveBeenCalled()
  })

  it('configOptions 存在时，不允许切到仅旧通道提供的模式', async () => {
    vi.mocked(mock.connection.newSession).mockResolvedValueOnce({
      source, configOptions: [mode],
      modes: { ...legacy, availableModes: [...legacy.availableModes, { id: 'legacy-only', name: '旧通道独有' }] },
    })
    await createAcpSession({ agent, conversationId: 'conv', workspacePath: '/workspace' })
    expect((await setAcpSessionMode(agent.id, 'conv', 'legacy-only')).ok).toBe(false)
    await runAcpAgent({ ...options, modeId: 'legacy-only' })
    expect(mock.connection.setMode).not.toHaveBeenCalled()
    expect(mock.connection.setConfigOption).not.toHaveBeenCalled()
  })

  it('恢复响应立即提供模式和思考档，不必等待后续通知', async () => {
    vi.mocked(mock.connection.resumeSession).mockResolvedValueOnce({ source, configOptions: [mode, effort()], modes: legacy })
    await runAcpAgent({ ...options, loadSessionId: 'session' })
    expect(mock.connection.resumeSession).toHaveBeenCalled()
    expect(mock.connection.newSession).not.toHaveBeenCalled()
    expect(getAcpSessionSnapshot(agent.id, 'conv')).toMatchObject({
      modes: { configId: mode.id, available: mode.options.map((o) => ({ id: o.value, name: o.name })) },
      thoughtLevel: { configId: 'effort', current: 'low' },
    })
  })

  it('发送前按模型 → configOptions 模式 → 思考档下发，即使同时有旧模式', async () => {
    let configOptions = [models(), mode, effort()]
    vi.mocked(mock.connection.newSession).mockImplementationOnce(async () => ({ source, configOptions, modes: legacy }))
    vi.mocked(mock.connection.setConfigOption).mockImplementation(async (_session, id, value) => {
      configOptions = configOptions.map((option) => option.id === id ? { ...option, currentValue: value } : option)
      return configOptions
    })
    await runAcpAgent({ ...options, modelId: 'model-b', modeId: 'plan', thoughtLevel: 'high' })
    expect(mock.connection.setConfigOption).toHaveBeenNthCalledWith(1, 'session', 'model', 'model-b')
    expect(mock.connection.setConfigOption).toHaveBeenNthCalledWith(2, 'session', 'vendor.mode', 'plan')
    expect(mock.connection.setConfigOption).toHaveBeenNthCalledWith(3, 'session', 'effort', 'high')
    expect(mock.connection.setMode).not.toHaveBeenCalled()
  })

  it('未激活时恢复后先应用所选模型，再验证该模型的模式', async () => {
    vi.mocked(mock.connection.resumeSession).mockResolvedValueOnce({
      source, configOptions: [models(), { ...mode, options: [mode.options[0]] }], modes: null,
    })
    vi.mocked(mock.connection.setConfigOption)
      .mockResolvedValueOnce([models('model-b'), { ...mode, currentValue: 'plan', options: [mode.options[1]] }])
      .mockResolvedValueOnce([models('model-b'), { ...mode, currentValue: 'plan', options: [mode.options[1]] }])
    const result = await setAcpSessionMode(agent.id, 'conv', 'plan', {
      agent, workspacePath: '/workspace', modelId: 'model-b', loadSessionId: 'session',
    })
    expect(result).toEqual({ ok: true })
    expect(mock.connection.setConfigOption).toHaveBeenNthCalledWith(1, 'session', 'model', 'model-b')
    expect(mock.connection.setConfigOption).toHaveBeenNthCalledWith(2, 'session', 'vendor.mode', 'plan')
  })

  it('空闲切模式排在换模型之后，使用返回的新候选项', async () => {
    vi.mocked(mock.connection.newSession).mockResolvedValueOnce({
      source, configOptions: [models(), { ...mode, options: [mode.options[0]] }], modes: null,
    })
    await createAcpSession({ agent, conversationId: 'conv', workspacePath: '/workspace' })
    let finish!: (value: unknown[] | null) => void
    vi.mocked(mock.connection.setConfigOption)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce([models('model-b'), { ...mode, currentValue: 'plan', options: [mode.options[1]] }])
    const modelChange = setAcpSessionModel(agent.id, 'conv', 'model-b')
    await vi.waitFor(() => expect(mock.connection.setConfigOption).toHaveBeenCalledTimes(1))
    const modeChange = setAcpSessionMode(agent.id, 'conv', 'plan')
    finish([models('model-b'), mode])
    expect(await modelChange).toEqual({ ok: true })
    expect(await modeChange).toEqual({ ok: true })
    expect(mock.connection.setConfigOption).toHaveBeenNthCalledWith(2, 'session', 'vendor.mode', 'plan')
  })

  it('生成期间仍可立即切模式，不被整轮串行队列阻塞', async () => {
    vi.mocked(mock.connection.newSession).mockResolvedValueOnce({ source, configOptions: [mode], modes: null })
    vi.mocked(mock.connection.setConfigOption).mockResolvedValueOnce([{ ...mode, currentValue: 'plan' }])
    let finish!: (message: { kind: 'stop'; stopReason: string }) => void
    vi.mocked(source.nextUpdate).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const running = runAcpAgent(options)
    await vi.waitFor(() => expect(source.prompt).toHaveBeenCalled())
    let result: { ok: boolean } | undefined
    const change = setAcpSessionMode(agent.id, 'conv', 'plan').then((value) => { result = value })
    try {
      await vi.waitFor(() => expect(result).toEqual({ ok: true }))
    } finally {
      finish({ kind: 'stop', stopReason: 'end_turn' })
      await running
      await change
    }
  })
})
const effort = (values = ['low', 'high'], currentValue = values[0]) => ({
  id: 'effort', category: 'thought_level', type: 'select', currentValue,
  options: values.map((value) => ({ value, name: value })),
})
const options: RunAcpAgentOptions = {
  agent, conversationId: 'conv', requestId: 'request',
  workspace: { id: 'ws', name: 'Workspace', path: '/workspace', createdAt: 0, updatedAt: 0 },
  history: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'hello' }], createdAt: 0 }],
}
let source: AcpTurnSource
beforeEach(() => {
  vi.clearAllMocks()
  source = { sessionId: 'session', prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => ({ kind: 'stop' as const, stopReason: 'end_turn' })), drainAll: vi.fn(() => []) }
  const result = { source, configOptions: [models(), effort()], modes: null }
  mock.connection = {
    version: 'v1', initialize: vi.fn(async () => ({ promptImage: null, canList: false, canDelete: false,
      canFork: false, canClose: false, canCancel: true, authMethods: [] })),
    newSession: vi.fn(async () => result), resumeSession: vi.fn(async () => result),
    forkSession: vi.fn(async () => result), closeSession: vi.fn(), cancelTurn: vi.fn(),
    setConfigOption: vi.fn(async (_session, configId, value) => configId === 'model'
      ? [models(value), ...(value === 'plain' ? [] : [effort(['medium', 'max'])])]
      : [models(), effort(['low', 'high'], value)]),
    setMode: vi.fn(), listSessions: vi.fn(), deleteSession: vi.fn(), login: vi.fn(), logout: vi.fn(), close: vi.fn(),
  }
})
afterEach(() => { disposeAcpSessions(); vi.restoreAllMocks() })

describe('ACP 模型与思考档配置', () => {
  it('先应用模型再应用新模型的思考档，不能沿用旧清单', async () => {
    await runAcpAgent({ ...options, modelId: 'model-b', thoughtLevel: 'max' })
    expect(mock.connection.setConfigOption).toHaveBeenNthCalledWith(1, 'session', 'model', 'model-b')
    expect(mock.connection.setConfigOption).toHaveBeenNthCalledWith(2, 'session', 'effort', 'max')
  })

  it('完整配置移除思考档后，不能继续向不支持的模型下发旧档位', async () => {
    await runAcpAgent({ ...options, modelId: 'plain', thoughtLevel: 'high' })
    expect(mock.connection.setConfigOption).toHaveBeenCalledTimes(1)
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.thoughtLevel).toBeNull()
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.configOptionsKnown).toBe(true)
  })

  it('空闲期配置通知刷新全部选择器，并通知会话持久化；别的 session 不串台', async () => {
    await runAcpAgent(options)
    const listener = vi.fn()
    setAcpSessionConfigListener(agent.id, 'conv', listener)
    mock.handlers.onConfigOptions?.('other-session', [models('plain')])
    expect(listener).not.toHaveBeenCalled()
    mock.handlers.onConfigOptions?.('session', [models('model-b'), effort(['medium', 'max'])])
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.thoughtLevel?.options.map((o) => o.value)).toEqual(['medium', 'max'])
    expect(listener).toHaveBeenCalledTimes(1)
    mock.handlers.onConfigOptions?.('session', [])
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.thoughtLevel).toBeNull()
  })

  it('没有返回完整配置时保留已知能力，不误判为明确不支持', async () => {
    await runAcpAgent(options)
    vi.mocked(mock.connection.setConfigOption).mockResolvedValueOnce(null)
    expect(await setAcpSessionThoughtLevel(agent.id, 'conv', 'high')).toEqual({ ok: true })
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.thoughtLevel?.current).toBe('high')
  })

  it('运行中拒绝切档，非法值也不能发给 agent', async () => {
    let finish!: (message: { kind: 'stop'; stopReason: string }) => void
    vi.mocked(source.nextUpdate).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const running = runAcpAgent(options)
    await vi.waitFor(() => expect(source.prompt).toHaveBeenCalled())
    expect((await setAcpSessionThoughtLevel(agent.id, 'conv', 'high')).ok).toBe(false)
    expect(mock.connection.setConfigOption).not.toHaveBeenCalled()
    finish({ kind: 'stop', stopReason: 'end_turn' })
    await running
    expect((await setAcpSessionThoughtLevel(agent.id, 'conv', 'invented')).ok).toBe(false)
    expect(mock.connection.setConfigOption).not.toHaveBeenCalled()
  })

  it('空闲会话换模型立即刷新思考档；无需发送消息', async () => {
    await runAcpAgent(options)
    expect((await setAcpSessionModel(agent.id, 'conv', 'model-b')).ok).toBe(true)
    expect(getAcpSessionSnapshot(agent.id, 'conv')?.thoughtLevel?.options.map((o) => o.value)).toEqual(['medium', 'max'])
  })

  it('新建与草稿探测均针对选中的模型返回思考档', async () => {
    const created = await createAcpSession({ agent, conversationId: 'conv', workspacePath: '/workspace', modelId: 'model-b' })
    expect(created.thoughtLevel?.options.map((o) => o.value)).toEqual(['medium', 'max'])
    const probe = await probeAcpCapabilities({ agent, workspacePath: '/workspace', modelId: 'plain' })
    expect(probe.thoughtLevel).toBeNull()
  })
})
