/**
 * 防回归：旧重启入口不得打断生成 / 等答复；重启与历史恢复必须共享锁和回放，
 * 恢复期间也不能抢开新一轮。所有进程、领域存储和运行态均 mock，不启动服务器。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatMessage } from '@fizz/contracts/types'

const mock = vi.hoisted(() => ({
  abort: vi.fn(), replay: vi.fn(), conversation: vi.fn(), workspace: vi.fn(),
  resolveAgent: vi.fn(), extension: vi.fn(), refresh: vi.fn(), active: vi.fn(),
  reserve: vi.fn(), release: vi.fn(), getTranscript: vi.fn(), setTranscript: vi.fn(),
  carryIds: vi.fn(), carryErrors: vi.fn(), carryDurations: vi.fn(),
}))
vi.mock('@fizz/acp', () => ({ abortAcpTurn: mock.abort, replayAcpSession: mock.replay }))
vi.mock('@/lib/server/state', () => ({ domain: {
  getConversation: mock.conversation, getWorkspace: mock.workspace, resolveAcpAgent: mock.resolveAgent,
  listMcpServers: () => [],
} }))
vi.mock('@/lib/server/acp-extension', () => ({ ensurePiConfirmExtension: mock.extension }))
vi.mock('@/lib/server/acp-session-state', () => ({ refreshAcpSessionState: mock.refresh }))
vi.mock('@/lib/server/acp-mcp', () => ({ acpMcpServers: () => [] }))
vi.mock('@/lib/server/chat-run', () => ({
  findActiveByConversation: mock.active, summarize: (run: unknown) => run,
  reserveConversationRunStart: mock.reserve, releaseConversationRunStart: mock.release,
}))
vi.mock('@/lib/server/acp-transcripts', () => ({
  getAcpTranscript: mock.getTranscript, setAcpTranscript: mock.setTranscript,
  carryOverIds: mock.carryIds, carryOverErrors: mock.carryErrors, carryOverDurations: mock.carryDurations,
  acpTranscriptView: (_id: string, run: unknown) => ({ messages: mock.getTranscript() ?? [], run }),
}))
vi.mock('@/app/api/_lib/auth', () => ({
  parseJsonBody: async (request: Request) => request.json(),
  describeError: (err: unknown) => ({ status: 500, message: err instanceof Error ? err.message : String(err) }),
  jsonError: (status: number, error: string) => Response.json({ error }, { status }),
}))
import { POST } from './route'
import { GET } from '../transcript/route'

const params = () => ({ params: Promise.resolve({ id: 'agent' }) })
const restart = () => POST(new Request('http://localhost/api/acp/agents/agent/restart', {
  method: 'POST', body: JSON.stringify({ conversationId: 'conv' }),
}), params())
const reload = () => GET(new Request('http://localhost/api/acp/agents/agent/transcript?conversationId=conv&sessionId=session&cwd=/workspace'), params())
const messages: AgentChatMessage[] = [{ id: 'u', role: 'user', parts: [{ type: 'text', text: '问题' }], createdAt: 1 }]

beforeEach(() => {
  vi.resetAllMocks()
  mock.conversation.mockReturnValue({ id: 'conv', backend: 'acp', configId: 'agent', workspaceId: 'ws', acpSessionId: 'session' })
  mock.workspace.mockReturnValue({ id: 'ws', path: '/workspace' })
  mock.resolveAgent.mockReturnValue({ id: 'agent', name: 'Mock', command: 'mock-agent', args: [] })
  mock.reserve.mockReturnValue(true)
  mock.replay.mockResolvedValue(messages.map((message) => ({ ...message })))
  let snapshot: AgentChatMessage[] | undefined
  mock.getTranscript.mockImplementation(() => snapshot)
  mock.setTranscript.mockImplementation((_id: string, value: AgentChatMessage[]) => { snapshot = value })
})

describe('ACP · 统一会话恢复', () => {
  it.each(['生成中', '等待用户答复'])('%s时旧重启接口拒绝请求，不能杀进程', async () => {
    mock.active.mockReturnValue({ requestId: 'run', status: 'running' })
    const response = await restart()
    expect(response.status).toBe(409)
    expect(mock.abort).not.toHaveBeenCalled()
    expect(mock.replay).not.toHaveBeenCalled()
  })

  it('运行中重新加载只取快照，不启动回放或补装扩展', async () => {
    const run = { requestId: 'run', status: 'running' }
    mock.active.mockReturnValue(run)
    mock.setTranscript('conv', messages)
    expect(await (await reload()).json()).toEqual({ messages, run })
    expect(mock.replay).not.toHaveBeenCalled()
    expect(mock.extension).not.toHaveBeenCalled()
    expect(mock.reserve).not.toHaveBeenCalled()
  })

  it('重启和重新加载并发只回放一次，结果同步到历史快照', async () => {
    const completions: Array<(value: AgentChatMessage[]) => void> = []
    mock.replay.mockImplementation(() => new Promise<AgentChatMessage[]>((resolve) => { completions.push(resolve) }))
    const first = restart()
    await vi.waitFor(() => expect(mock.replay).toHaveBeenCalledTimes(1))
    const second = reload()
    await vi.waitFor(() => expect(mock.conversation).toHaveBeenCalledTimes(2))
    for (const complete of completions) complete(messages)
    const responses = await Promise.all([first, second])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(await responses[1].json()).toEqual({ messages, run: null })
    expect(mock.abort).not.toHaveBeenCalled()
    expect(mock.replay).toHaveBeenCalledTimes(1)
    expect(mock.reserve).toHaveBeenCalledTimes(1)
    expect(mock.release).toHaveBeenCalledTimes(1)
    expect(mock.extension).toHaveBeenCalledTimes(1)
  })

  it('重新加载同样补装权限扩展，并使用会话记录中的路径和 session', async () => {
    mock.conversation.mockReturnValue({ id: 'conv', backend: 'acp', configId: 'agent', workspaceId: 'ws', acpSessionId: 'authoritative-session' })
    expect((await reload()).status).toBe(200)
    expect(mock.extension).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent' }), '/workspace')
    expect(mock.replay).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'authoritative-session', workspacePath: '/workspace' }))
    expect(mock.refresh).toHaveBeenCalledWith('conv', 'agent')
  })

  it('启动位已被下一轮占用时拒绝恢复，不能 teardown 正在准备的进程', async () => {
    mock.reserve.mockReturnValue(false)
    expect((await reload()).status).toBe(409)
    expect(mock.replay).not.toHaveBeenCalled()
    expect(mock.release).not.toHaveBeenCalled()
  })

  it('缺少工作区时先报错，保留原进程和快照', async () => {
    mock.workspace.mockReturnValue(undefined)
    mock.setTranscript('conv', messages)
    mock.setTranscript.mockClear()
    const response = await restart()
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('工作区') })
    expect(mock.abort).not.toHaveBeenCalled()
    expect(mock.replay).not.toHaveBeenCalled()
    expect(mock.setTranscript).not.toHaveBeenCalled()
  })

  it('恢复失败释放锁，旧历史不丢，随后可以重试', async () => {
    mock.setTranscript('conv', messages)
    mock.setTranscript.mockClear()
    mock.replay.mockRejectedValueOnce(new Error('session missing'))
    const failed = await reload()
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ error: expect.stringContaining('session missing') })
    expect(mock.setTranscript).not.toHaveBeenCalled()
    expect(mock.release).toHaveBeenCalledTimes(1)
    expect((await reload()).status).toBe(200)
    expect(mock.replay).toHaveBeenCalledTimes(2)
  })

  it('空闲恢复占用与发送相同的启动位，直到回放收尾再释放', async () => {
    let reserved = false
    mock.reserve.mockImplementation(() => {
      if (reserved) return false
      reserved = true
      return true
    })
    mock.release.mockImplementation(() => { reserved = false })
    let complete!: (value: AgentChatMessage[]) => void
    mock.replay.mockImplementation(() => new Promise<AgentChatMessage[]>((resolve) => { complete = resolve }))
    const pending = reload()
    await vi.waitFor(() => expect(mock.replay).toHaveBeenCalledTimes(1))
    const canStart = mock.reserve('conv')
    complete(messages)
    await pending
    expect(canStart).toBe(false)
    expect(mock.reserve('conv')).toBe(true)
  })
})
