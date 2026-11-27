/** 防回归：MCP 改动不打断运行轮次；恢复失败区分连接与历史错误并清理进程。全部使用假进程/连接。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import type { AcpConnection, AcpMcpServer, AcpTurnSource } from './protocol/types'
import type { RunAcpAgentOptions } from './acp'

const mock = vi.hoisted(() => ({ connection: null as unknown as AcpConnection }))
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(),
  })),
}))
vi.mock('./protocol', async (importOriginal) => ({
  ...await importOriginal<typeof import('./protocol')>(),
  resolveAcpFactory: () => ({ connect: async () => mock.connection }),
}))

import { createAcpSession, disposeAcpSessions, replayAcpSession, runAcpAgent, setAcpSessionMode } from './acp'

const servers: AcpMcpServer[] = [{
  type: 'http', name: 'docs', url: 'https://example.com/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer secret' }],
}]
const agent = { id: 'agent', name: 'Agent', command: 'mock-agent', args: [] }
const options: RunAcpAgentOptions = {
  agent, conversationId: 'conversation', requestId: 'request', mcpServers: servers,
  workspace: { id: 'workspace', name: 'Workspace', path: '/workspace', createdAt: 0, updatedAt: 0 },
  history: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'hello' }], createdAt: 0 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  const source: AcpTurnSource = {
    sessionId: 'session', prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => ({ kind: 'stop' as const, stopReason: 'end_turn' })),
    drainAll: vi.fn(() => []),
  }
  const result = { source, configOptions: null, modes: null }
  mock.connection = {
    version: 'v1',
    initialize: vi.fn(async () => ({
      promptImage: null, canList: false, canDelete: false, canFork: false,
      canClose: false, canCancel: true, authMethods: [],
    })),
    newSession: vi.fn(async () => result), resumeSession: vi.fn(async () => result),
    forkSession: vi.fn(async () => result), closeSession: vi.fn(), cancelTurn: vi.fn(),
    setConfigOption: vi.fn(), setMode: vi.fn(), listSessions: vi.fn(), deleteSession: vi.fn(),
    login: vi.fn(), logout: vi.fn(), close: vi.fn(),
  }
})
afterEach(() => { disposeAcpSessions(); vi.restoreAllMocks() })

describe('ACP 会话引擎 MCP 链路', () => {
  it('配置未变时复用活会话，不重启也不重复恢复', async () => {
    expect((await runAcpAgent(options)).finishReason).toBe('done')
    expect(mock.connection.newSession).toHaveBeenCalledWith('/workspace', servers)
    await runAcpAgent({ ...options, mcpServers: structuredClone(servers) })
    expect(mock.connection.newSession).toHaveBeenCalledTimes(1)
    expect(mock.connection.resumeSession).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(mock.connection.close).not.toHaveBeenCalled()
  })

  it('清空 MCP 后下一轮重启并恢复当前 session，后续不重复重启', async () => {
    await runAcpAgent(options)
    const onSessionCreated = vi.fn()

    expect((await runAcpAgent({ ...options, mcpServers: [], onSessionCreated })).finishReason).toBe('done')

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(mock.connection.close).toHaveBeenCalledTimes(1)
    expect(mock.connection.resumeSession).toHaveBeenCalledWith('session', '/workspace', [])
    expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }))
    await runAcpAgent({ ...options, mcpServers: [] })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(mock.connection.newSession).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['URL', [{ ...servers[0], type: 'http', url: 'https://example.com/new', headers: [] }]],
    ['凭据', [{ ...servers[0], type: 'http', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer changed' }] }]],
    ['新增 server', [...servers, { type: 'stdio', name: 'files', command: 'mcp-files', args: [], env: [] }]],
  ] satisfies [string, AcpMcpServer[]][])('所选 server 的%s变化也触发重启', async (_name, mcpServers) => {
    await runAcpAgent(options)

    await runAcpAgent({ ...options, mcpServers })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(mock.connection.resumeSession).toHaveBeenCalledWith('session', '/workspace', mcpServers)
  })

  it('配置项顺序变化不误重启，但 stdio 参数 / 环境变量变化会重启', async () => {
    const stdio: AcpMcpServer = {
      type: 'stdio', name: 'files', command: 'mcp-files', args: ['--root', '/workspace'],
      env: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }],
    }
    await runAcpAgent({ ...options, mcpServers: [...servers, stdio] })
    await runAcpAgent({ ...options, mcpServers: [{ ...stdio, env: [...stdio.env].reverse() }, ...servers] })
    expect(spawn).toHaveBeenCalledTimes(1)

    const changed = { ...stdio, args: ['/workspace', '--root'], env: [{ name: 'A', value: 'changed' }] }
    await runAcpAgent({ ...options, mcpServers: [...servers, changed] })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(mock.connection.resumeSession).toHaveBeenCalledWith('session', '/workspace', [...servers, changed])
  })

  it('重启后恢复失败时新建，并记录最新配置避免每轮重启', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runAcpAgent(options)
    vi.mocked(mock.connection.resumeSession).mockRejectedValueOnce(new Error('not supported'))

    expect((await runAcpAgent({ ...options, mcpServers: [] })).finishReason).toBe('done')
    expect(mock.connection.newSession).toHaveBeenLastCalledWith('/workspace', [])
    await runAcpAgent({ ...options, mcpServers: [] })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(mock.connection.newSession).toHaveBeenCalledTimes(2)
  })

  it('排队轮次等上一轮完成才重启，后续轮次仍串行复用新进程', async () => {
    const result = await vi.mocked(mock.connection.newSession).getMockImplementation()!('/workspace', servers)
    let finish!: (message: { kind: 'stop'; stopReason: string }) => void
    vi.mocked(result.source.nextUpdate).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const first = runAcpAgent(options)
    await vi.waitFor(() => expect(result.source.prompt).toHaveBeenCalledTimes(1))

    const second = runAcpAgent({ ...options, mcpServers: [] })
    const third = runAcpAgent({ ...options, mcpServers: [] })
    await Promise.resolve()
    expect(mock.connection.close).not.toHaveBeenCalled()
    finish({ kind: 'stop', stopReason: 'end_turn' })

    expect((await Promise.all([first, second, third])).map((r) => r.finishReason)).toEqual(['done', 'done', 'done'])
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(mock.connection.resumeSession).toHaveBeenCalledTimes(1)
    expect(result.source.prompt).toHaveBeenCalledTimes(3)
  })

  it('新建会话时就注入配置，第一轮无需额外重启', async () => {
    await createAcpSession({ agent, conversationId: 'conversation', workspacePath: '/workspace', mcpServers: servers })
    await runAcpAgent(options)

    expect(mock.connection.newSession).toHaveBeenCalledWith('/workspace', servers)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(mock.connection.resumeSession).not.toHaveBeenCalled()
  })

  it('恢复会话传入 MCP', async () => {
    expect((await runAcpAgent({ ...options, loadSessionId: 'old' })).finishReason).toBe('done')
    expect(mock.connection.resumeSession).toHaveBeenCalledWith('old', '/workspace', servers)
    expect(mock.connection.newSession).not.toHaveBeenCalled()
  })

  it('恢复失败退回新建时保留同一份 MCP', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(mock.connection.resumeSession).mockRejectedValueOnce(new Error('not supported'))
    expect((await runAcpAgent({ ...options, loadSessionId: 'old' })).finishReason).toBe('done')
    expect(mock.connection.newSession).toHaveBeenCalledWith('/workspace', servers)
  })

  it('打开会话/重启所用的回放入口透传 MCP', async () => {
    await replayAcpSession({ agent, conversationId: 'conversation', workspacePath: '/workspace', sessionId: 'old', mcpServers: servers })
    expect(mock.connection.resumeSession).toHaveBeenCalledWith('old', '/workspace', servers)
  })

  it('回放连接失败明确标出阶段，清理假进程后可以重新加载', async () => {
    vi.mocked(mock.connection.initialize).mockRejectedValueOnce(new Error('initialization failed'))
    await expect(replayAcpSession({ agent, conversationId: 'conversation', workspacePath: '/workspace', sessionId: 'old' }))
      .rejects.toThrow('Agent 启动或连接失败：initialization failed')
    expect(mock.connection.close).toHaveBeenCalledTimes(1)
    await replayAcpSession({ agent, conversationId: 'conversation', workspacePath: '/workspace', sessionId: 'old' })
    expect(mock.connection.resumeSession).toHaveBeenCalledWith('old', '/workspace', [])
  })

  it('回放历史失败保留原会话语义，不退回新建并清理连接', async () => {
    vi.mocked(mock.connection.resumeSession).mockRejectedValueOnce(new Error('session missing'))
    await expect(replayAcpSession({ agent, conversationId: 'conversation', workspacePath: '/workspace', sessionId: 'old' }))
      .rejects.toThrow('原会话历史加载失败：session missing')
    expect(mock.connection.newSession).not.toHaveBeenCalled()
    expect(mock.connection.close).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 'old'])('切档自动激活也携带 MCP（绑定会话：%s）', async (loadSessionId) => {
    await setAcpSessionMode(agent.id, 'conversation', 'mode', {
      agent, workspacePath: '/workspace', loadSessionId, mcpServers: servers,
    })
    if (loadSessionId) {
      expect(mock.connection.resumeSession).toHaveBeenCalledWith('old', '/workspace', servers)
    } else {
      expect(mock.connection.newSession).toHaveBeenCalledWith('/workspace', servers)
    }
  })
})
