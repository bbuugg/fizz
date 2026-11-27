/**
 * ACP 分叉：必须分叉指定会话的 agent 侧 session，再绑定新的本地 ACP 会话。
 * 防止误用焦点会话、误走本地消息截断、失败造空会话，以及连点创建重复分支。
 */
import { describe, expect, it, vi } from 'vitest'
import { getLanguage, setLanguage } from '@fizz/i18n'
import type { ConversationSummary } from '@fizz/contracts/agent-api'
import type { ConvInternals } from '../internals/context'
import { createConversationForkActions } from './conversation-fork'

function setup() {
  const source: ConversationSummary = {
    id: 'source', workspaceId: 'ws-source', backend: 'acp',
    configId: 'agent-source', modelId: 'model-source', acpSessionId: 'session-source',
    title: '原会话', createdAt: 1, updatedAt: 1, messageCount: 0,
    mcpServerIds: ['mcp-source'], acpPermissionMode: 'allow'
  }
  const created = { ...source, id: 'branch', acpSessionId: 'session-branch' }
  const api = {
    activeRun: vi.fn(async (): Promise<{ run: { id: string } | null }> => ({ run: null })),
    forkAcpSession: vi.fn(async () => ({ sessionId: 'session-branch' })),
    createConversation: vi.fn(async () => created)
  }
  const state = {
    conversations: [source],
    activeConversationId: 'unrelated-focus', activeWorkspaceId: 'unrelated-workspace',
    workspaces: [{ id: 'ws-source', path: '/project/source' }],
    runningConversations: {} as Record<string, unknown>,
    getApi: () => api,
    setError: vi.fn(), openConversation: vi.fn(), selectWorkspace: vi.fn()
  }
  const slice = { streaming: false, pendingConfirms: [] as unknown[], followupRequests: {} }
  const ctx = {
    get: () => state,
    set: (patch: unknown) => Object.assign(state,
      typeof patch === 'function' ? patch(state) : patch),
    readSlice: vi.fn(() => slice)
  } as unknown as ConvInternals
  return { source, created, api, state, slice, actions: createConversationForkActions(ctx) }
}

describe('forkAcpConversation', () => {
  it('按传入 id 分叉并绑定新 session，保留 ACP 配置，由外壳打开独立标签', async () => {
    const { actions, api, state, source, created } = setup()

    expect(await actions.forkAcpConversation('source')).toBe('branch')

    expect(api.activeRun).toHaveBeenCalledWith('source')
    expect(api.forkAcpSession).toHaveBeenCalledWith('agent-source', {
      sessionId: 'session-source', workspacePath: '/project/source'
    })
    expect(api.createConversation).toHaveBeenCalledWith({
      workspaceId: 'ws-source', title: '原会话（分支）', backend: 'acp',
      configId: 'agent-source', modelId: 'model-source', acpSessionId: 'session-branch',
      mcpServerIds: ['mcp-source'], acpPermissionMode: 'allow'
    })
    expect(state.conversations).toEqual([created, source])
    expect(source.acpSessionId).toBe('session-source')
    expect(state.activeConversationId).toBe('unrelated-focus')
    expect(state.activeWorkspaceId).toBe('unrelated-workspace')
    expect(state.openConversation).not.toHaveBeenCalled()
    expect(state.selectWorkspace).not.toHaveBeenCalled()
  })

  it.each(['missing', 'builtin', 'no-agent', 'no-session', 'no-workspace'])(
    '%s：无效来源不能调用 agent fork 或创建本地会话', async (kind) => {
      const { actions, api, source, state } = setup()
      if (kind === 'missing') state.conversations = []
      if (kind === 'builtin') source.backend = 'builtin'
      if (kind === 'no-agent') delete source.configId
      if (kind === 'no-session') delete source.acpSessionId
      if (kind === 'no-workspace') state.workspaces = []

      expect(await actions.forkAcpConversation('source')).toBeNull()
      expect(api.forkAcpSession).not.toHaveBeenCalled()
      expect(api.createConversation).not.toHaveBeenCalled()
    }
  )

  it('本地运行中或等待答复时拒绝分叉', async () => {
    const { actions, api, slice, state } = setup()
    slice.pendingConfirms = [{}]
    expect(await actions.forkAcpConversation('source')).toBeNull()
    slice.pendingConfirms = []
    slice.followupRequests = { question: {} }
    expect(await actions.forkAcpConversation('source')).toBeNull()
    slice.followupRequests = {}
    slice.streaming = true
    expect(await actions.forkAcpConversation('source')).toBeNull()
    slice.streaming = false
    state.runningConversations.source = true
    expect(await actions.forkAcpConversation('source')).toBeNull()
    expect(api.forkAcpSession).not.toHaveBeenCalled()
  })

  it('保留原会话的浏览器偏好，不继承焦点会话的草稿设置', async () => {
    const { actions, source, api } = setup()
    source.browserSettings = { enabled: true, channel: 'bundled' }
    expect(await actions.forkAcpConversation('source')).toBe('branch')
    expect(api.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      browserSettings: { enabled: true, channel: 'bundled' }
    }))
  })

  it('英文界面翻译新分支标题及不支持分叉的提示', async () => {
    const previousLanguage = getLanguage()
    try {
      setLanguage('en')
      const { actions, api, state } = setup()
      expect(await actions.forkAcpConversation('source')).toBe('branch')
      expect(api.createConversation).toHaveBeenCalledWith(expect.objectContaining({ title: '原会话 (branch)' }))
      api.forkAcpSession.mockRejectedValue(new Error('这个 agent 不支持 session/fork'))
      expect(await actions.forkAcpConversation('source')).toBeNull()
      expect(state.setError).toHaveBeenCalledWith('This Agent does not support session/fork')
    } finally {
      setLanguage(previousLanguage)
    }
  })

  it('服务端仍有活跃轮次（含等待答复）时拒绝分叉', async () => {
    const { actions, api, state } = setup()
    api.activeRun.mockResolvedValue({ run: { id: 'running-elsewhere' } })
    expect(await actions.forkAcpConversation('source')).toBeNull()
    expect(api.forkAcpSession).not.toHaveBeenCalled()
    expect(state.setError).toHaveBeenCalled()
  })

  it('运行态探测失败时不冒险分叉', async () => {
    const { actions, api, state } = setup()
    api.activeRun.mockRejectedValue(new Error('离线'))
    expect(await actions.forkAcpConversation('source')).toBeNull()
    expect(api.forkAcpSession).not.toHaveBeenCalled()
    expect(state.setError).toHaveBeenCalledWith('离线')
  })

  it('agent 不支持分叉时透出具体错误，不创建空的本地会话', async () => {
    const { actions, api, state } = setup()
    api.forkAcpSession.mockRejectedValue(new Error('这个 agent 不支持 session/fork'))
    expect(await actions.forkAcpConversation('source')).toBeNull()
    expect(api.createConversation).not.toHaveBeenCalled()
    expect(state.setError).toHaveBeenCalledWith('这个 agent 不支持 session/fork')
  })

  it.each(['', 'session-source'])('agent 未返回新的 session id（%s）时不绑定', async (sessionId) => {
    const { actions, api } = setup()
    api.forkAcpSession.mockResolvedValue({ sessionId })
    expect(await actions.forkAcpConversation('source')).toBeNull()
    expect(api.createConversation).not.toHaveBeenCalled()
  })

  it('本地落库失败时保留原会话，并说明可从 agent 侧导入找回分支', async () => {
    const { actions, api, state, source } = setup()
    api.createConversation.mockRejectedValue(new Error('写入失败'))
    expect(await actions.forkAcpConversation('source')).toBeNull()
    expect(state.conversations).toEqual([source])
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('导入会话'))
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('写入失败'))
  })

  it('同一会话并发点击只提交一次，失败后释放锁允许重试', async () => {
    const { actions, api } = setup()
    let rejectFork!: (error: Error) => void
    api.forkAcpSession.mockImplementationOnce(() => new Promise((_, reject) => { rejectFork = reject }))
    const first = actions.forkAcpConversation('source')
    await vi.waitFor(() => expect(api.forkAcpSession).toHaveBeenCalledTimes(1))
    expect(await actions.forkAcpConversation('source')).toBeNull()
    rejectFork(new Error('暂时不可用'))
    expect(await first).toBeNull()

    expect(await actions.forkAcpConversation('source')).toBe('branch')
    expect(api.forkAcpSession).toHaveBeenCalledTimes(2)
    expect(api.createConversation).toHaveBeenCalledTimes(1)
  })
})
