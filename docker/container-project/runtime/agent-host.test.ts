// 防止容器入口遗漏 runAgent 接口迁移，或丢失宿主提示词、工具白名单与交互通道。
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunAgentOptions, RunAgentResult } from '@fizz/agent'
import type { AgentToolOptions } from '@fizz/tools'
import { CONTAINER_AGENT_TOOL_KEYS } from '@fizz/contracts/types'

type Request = Readable & { method: string; url: string }
type Response = EventEmitter & {
  writeHead: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}
type Handler = (req: Request, res: Response) => Promise<void>

const mocks = vi.hoisted(() => ({
  handler: undefined as Handler | undefined,
  listen: vi.fn(),
  runAgent: vi.fn<(options: RunAgentOptions) => Promise<RunAgentResult>>(),
  buildAgentTools: vi.fn<(root: string, options: AgentToolOptions) => Record<string, unknown>>(),
  buildWebFetchTool: vi.fn(),
  buildAskFollowupTool: vi.fn(),
  filterToolSet: vi.fn(),
  rawToolsPlugin: vi.fn()
}))

vi.mock('node:http', () => ({
  createServer: (handler: Handler) => {
    mocks.handler = handler
    return { listen: mocks.listen }
  }
}))

vi.mock('./runtime.mjs', () => ({
  ...mocks,
  CONTAINER_AGENT_TOOL_KEYS,
  resolveContextWindow: () => 200_000,
  defaultContextWindowFromEnv: () => 200_000
}))

function response(): Response {
  return Object.assign(new EventEmitter(), {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn()
  })
}

async function post(url: string, body: object, res = response()): Promise<Response> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    url
  })
  await mocks.handler!(req, res)
  return res
}

const body = {
  protocolVersion: 1,
  runId: 'run-1',
  conversationId: 'conversation-1',
  systemPrompt: '宿主提供的完整系统提示词',
  permissionMode: 'confirm',
  history: [],
  skills: [{ path: '/workspace/.agents/skills/example/SKILL.md', name: 'example', description: '示例' }]
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.resetModules()
  mocks.runAgent.mockResolvedValue({ finishReason: 'done' })
  mocks.buildAgentTools.mockReturnValue(Object.fromEntries(
    [...CONTAINER_AGENT_TOOL_KEYS, 'outside_tool'].map((key) => [key, { execute: vi.fn() }])
  ))
  mocks.buildWebFetchTool.mockReturnValue({ web_fetch: { execute: vi.fn() } })
  mocks.buildAskFollowupTool.mockReturnValue({ ask: { execute: vi.fn() } })
  mocks.filterToolSet.mockImplementation((tools: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.map((key) => [key, tools[key]]))
  )
  mocks.rawToolsPlugin.mockReturnValue({ name: 'container:tools', apply: vi.fn() })
  const entry = './agent-host.mjs'
  await import(entry)
})

describe('容器 Agent 装配', () => {
  it('以 scope 和 assemble 调用运行时，保留宿主提示词且只挂白名单工具', async () => {
    const res = await post('/runs', body)
    const options = mocks.runAgent.mock.calls[0]![0]
    expect(options.scope).toMatchObject({
      kind: 'workspace',
      workspace: { id: body.runId, path: '/workspace' }
    })
    expect(options).not.toHaveProperty('setup')
    expect(options).not.toHaveProperty('workspace')
    expect(options.conversationId).toBe(body.conversationId)
    if (options.scope.kind !== 'workspace') throw new Error('缺少工作区作用域')
    const assembly = await options.assemble!({ workspace: options.scope.workspace })
    expect(assembly.instructions).toBe(body.systemPrompt)
    expect(assembly.plugins).toEqual([{ plugin: mocks.rawToolsPlugin.mock.results[0]!.value }])
    const [name, tools, registration] = mocks.rawToolsPlugin.mock.calls[0]!
    expect(name).toBe('container:tools')
    expect(Object.keys(tools).sort()).toEqual([...CONTAINER_AGENT_TOOL_KEYS].sort())
    expect(registration).toMatchObject({ origin: 'builtin' })
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"finishReason":"done"'))
  })

  it('保留技能、审批、追问和单条命令停止通道', async () => {
    const res = response()
    mocks.runAgent.mockImplementation(async () => {
      const [root, options] = mocks.buildAgentTools.mock.calls[0]!
      expect(root).toBe('/workspace')
      expect(options.permissionMode).toBe('confirm')
      expect(options.getPermissionMode?.()).toBe('confirm')
      expect(options.skills).toEqual([{
        id: body.skills[0]!.path,
        name: 'example',
        description: '示例',
        dir: '/workspace/.agents/skills/example',
        file: body.skills[0]!.path
      }])
      const confirmation = options.requestConfirm!({ toolCallId: 'command-1', toolName: 'bash', command: 'pwd' })
      const followup = mocks.buildAskFollowupTool.mock.calls[0]![0].ask({ question: '继续？' })
      const frames = res.write.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((chunk) => chunk.startsWith('data:'))
        .map((chunk) => JSON.parse(chunk.slice(5)))
      const confirmFrame = frames.find((frame) => frame.type === 'confirm-request')
      const followupFrame = frames.find((frame) => frame.type === 'followup-request')
      await post('/runs/run-1/answer', { kind: 'confirm', id: confirmFrame.confirm.id, approved: true })
      await post('/runs/run-1/answer', { kind: 'followup', id: followupFrame.id, answer: '继续' })
      expect(await confirmation).toBe(true)
      expect(await followup).toBe('继续')
      const stop = vi.fn()
      options.onCommandStart!('command-1', stop)
      await post('/runs/run-1/command-stop', { toolCallId: 'command-1' })
      expect(stop).toHaveBeenCalledOnce()
      return { finishReason: 'done' }
    })
    await post('/runs', body, res)
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"finishReason":"done"'))
  })

  it('工具白名单校验失败时不启动模型并结束响应', async () => {
    mocks.filterToolSet.mockImplementation(() => { throw new Error('缺少白名单工具') })
    const res = await post('/runs', body)
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('缺少白名单工具'))
    expect(res.end).toHaveBeenCalledOnce()
  })
})
