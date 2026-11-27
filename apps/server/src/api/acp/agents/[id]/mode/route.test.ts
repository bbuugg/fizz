/** 防回归：模式路由恢复所选模型，原样持久化实际模式通道；失败不改会话。全程 mock，无服务器。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  modes: vi.fn(), snapshot: vi.fn(), setMode: vi.fn(), conversation: vi.fn(), save: vi.fn(), refresh: vi.fn(),
}))
vi.mock('@fizz/acp', () => ({
  getAcpSessionModes: mock.modes, getAcpSessionSnapshot: mock.snapshot, setAcpSessionMode: mock.setMode,
}))
vi.mock('@/lib/server/state', () => ({ domain: {
  getConversation: mock.conversation, setAcpSessionState: mock.save,
  getWorkspace: () => ({ id: 'ws', path: '/workspace' }),
  listAcpAgents: () => [{ id: 'agent', name: 'Custom', command: 'mock-agent', args: [] }],
  listMcpServers: () => [],
} }))
vi.mock('@/lib/server/acp-mcp', () => ({ acpMcpServers: () => [] }))
vi.mock('@/lib/server/acp-session-state', () => ({ refreshAcpSessionState: mock.refresh }))
vi.mock('@/app/api/_lib/auth', () => ({
  parseJsonBody: async (request: Request) => request.json(),
  jsonError: (status: number, error: string) => Response.json({ error }, { status }),
}))
import { GET, POST } from './route'

const params = () => ({ params: Promise.resolve({ id: 'agent' }) })
const request = (body = { conversationId: 'conv', modeId: 'vendor:plan' }) => new Request('http://localhost/api/acp/agents/agent/mode', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const available = [{ id: 'vendor:build', name: '构建' }, { id: 'vendor:plan', name: '规划' }]
beforeEach(() => {
  vi.resetAllMocks()
  mock.conversation.mockReturnValue({ id: 'conv', backend: 'acp', configId: 'agent', workspaceId: 'ws', modelId: 'selected-model',
    acpSessionId: 'session', acpModes: { configId: 'old-config', current: 'vendor:build', available } })
  mock.snapshot.mockReturnValue({ modes: { configId: 'vendor-mode', current: 'vendor:plan', available } })
  mock.modes.mockReturnValue({ supported: true, currentModeId: 'vendor:plan', modes: available })
  mock.setMode.mockResolvedValue({ ok: true })
})

describe('ACP 模式路由', () => {
  it('查询保留实际模式名称和原始值', async () => {
    const response = await GET(new Request('http://localhost/api/acp/agents/agent/mode?conversationId=conv'), params())
    expect(await response.json()).toEqual({ supported: true, currentModeId: 'vendor:plan', modes: available })
    expect(mock.modes).toHaveBeenCalledWith('agent', 'conv')
  })

  it('恢复信息包含当前模型，保存 configOptions 原始通道与模式值', async () => {
    expect(await (await POST(request(), params())).json()).toEqual({ ok: true })
    expect(mock.setMode).toHaveBeenCalledWith('agent', 'conv', 'vendor:plan', expect.objectContaining({
      modelId: 'selected-model', loadSessionId: 'session', workspacePath: '/workspace',
    }))
    expect(mock.save).toHaveBeenCalledWith('conv', { acpModes: { configId: 'vendor-mode', current: 'vendor:plan', available } })
    expect(mock.refresh).toHaveBeenCalledWith('conv', 'agent')
  })

  it('当前快照走旧 Session Modes 时，不能把过期 configId 补回去', async () => {
    mock.snapshot.mockReturnValue({ modes: { available, current: 'vendor:plan' } })
    await POST(request(), params())
    expect(mock.save).toHaveBeenCalledWith('conv', { acpModes: { current: 'vendor:plan', available } })
  })

  it('Agent 拒绝时不保存也不刷新', async () => {
    mock.setMode.mockResolvedValueOnce({ ok: false, error: '已移除的模式' })
    expect(await (await POST(request(), params())).json()).toEqual({ ok: false, error: '已移除的模式' })
    expect(mock.save).not.toHaveBeenCalled()
    expect(mock.refresh).not.toHaveBeenCalled()
  })

  it('缺少模式值时拒绝请求', async () => {
    expect((await POST(request({ conversationId: 'conv', modeId: '' }), params())).status).toBe(400)
    expect(mock.setMode).not.toHaveBeenCalled()
  })
})
