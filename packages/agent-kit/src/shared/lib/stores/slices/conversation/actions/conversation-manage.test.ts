/**
 * 回归：**切到远端工作区之后，草稿页不能还挂着外部 Agent（ACP）**。
 *
 * ## 防的是什么
 *
 * 远端工作区的目录在 SSH 主机上，而 ACP agent 是服务端在**本机** spawn 的进程（cwd 就是
 * 工作区目录），够不着那个目录 —— 服务端建会话时明确拒掉（`POST /api/conversations`：
 * 「远端工作区首期不支持外部 Agent（ACP）」）。
 *
 * 模型下拉那一组现在会整组不可选，但**已经选好的目标还挂在 `draftSettings` 上**：
 * 切完工作区，pill 上照样显示那个 agent，一发送就被服务端打回 —— 用户看到的是
 * 「我明明没选它」。所以 `selectWorkspace` 切到远端工作区时要把 ACP 那一份清掉。
 *
 * ## 边界（本文件钉住）
 *
 * 1. 切到**远端**工作区 + 草稿是 ACP → 清掉目标，连同 ACP 档位槽（`draftAcp`）；
 * 2. 切到**远端**工作区 + 草稿是内置模型 → **原样保留**（内置模型在远端照常能用，
 *    不能顺手把用户的选择抹掉）；
 * 3. 切到**本地**工作区 → ACP 目标原样保留（本地跑 ACP 是正常用法）。
 * 4. 新建 ACP 会话时，草稿选中的 MCP 要提交给服务端，并保留在会话清单中。
 * 5. 创建请求等待期间切到其他标签，迟到的创建结果不能抢走焦点及工作区。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationSlice } from '../index'

/** 本地工作区 + 远端工作区各一个：判据只看 `remote.hostId` 在不在 */
const LOCAL_WS = { id: 'ws-local', path: '/tmp/local', name: 'local' }
const REMOTE_WS = {
  id: 'ws-remote',
  path: '/srv/app',
  name: 'remote',
  remote: { hostId: 'host-1' }
}

const ACP_TARGET = { backend: 'acp', configId: 'agent-a', modelId: 'model-x' }
const BUILTIN_TARGET = { backend: 'builtin', configId: 'cfg-a', modelId: 'model-a' }

function makeStore(draftTarget: Record<string, unknown>) {
  const api = {
    setConversationTarget: vi.fn(async () => ({ ok: true })),
    listWorkspaces: vi.fn(async () => [LOCAL_WS, REMOTE_WS]),
    createConversation: vi.fn(async () => ({
      id: 'conv-acp', workspaceId: LOCAL_WS.id, backend: 'acp', configId: 'agent-a'
    }))
  }
  const boot = {
    conversations: [],
    conversationsLoaded: true,
    workspaces: [LOCAL_WS, REMOTE_WS],
    runningConversations: {},
    models: [{ id: 'cfg-a', name: 'A', models: [{ id: 'model-a', name: 'model-a' }] }],
    acpAgents: [{ id: 'agent-a', name: 'Agent A', models: [{ value: 'model-x', name: 'X' }] }],
    draftSettings: {
      chatTarget: draftTarget,
      reasoningEffort: null,
      mcpServerIds: [],
      browserSettings: null
    },
    // 草稿页上已经探过档位：清目标时这个槽也必须一起清，否则 ACP 的档位 pill 还亮着
    draftAcp: {
      agentId: 'agent-a',
      loading: false,
      error: null,
      modes: [],
      thoughtLevel: null
    },
    slices: {},
    getApi: () => api,
    setAcpAgentMode: vi.fn(async () => ({ ok: true })),
    setAcpThoughtLevel: vi.fn(async () => ({ ok: true })),
    setBusy: () => undefined,
    setError: () => undefined
  }
  const state: Record<string, unknown> = { ...boot, activeConversationId: null, activeWorkspaceId: null }
  const set = (partial: unknown): void => {
    const patch =
      typeof partial === 'function' ? (partial as (s: unknown) => object)(state) : partial
    Object.assign(state, patch as object)
  }
  const get = (): unknown => state
  const slice = (
    createConversationSlice as unknown as (
      set: unknown,
      get: unknown,
      api: unknown
    ) => Record<string, unknown>
  )(set, get, {})
  Object.assign(state, slice)
  // slice 初始化会按 localStorage 写回 `activeWorkspaceId` 等默认值：摆成「草稿页」的那一刻
  Object.assign(state, boot, { activeConversationId: null, activeWorkspaceId: null })

  const selectWorkspace = slice.selectWorkspace as (
    workspaceId: string | null,
    openNewest?: boolean
  ) => void
  const draftOf = (): Record<string, unknown> => state.draftSettings as Record<string, unknown>

  const newConversation = slice.newConversation as (
    workspaceId: string | undefined, title: string | undefined, target: typeof ACP_TARGET
  ) => Promise<string | null>

  return {
    state, api, selectWorkspace, draftOf, newConversation,
    setAcpAgentMode: boot.setAcpAgentMode,
    setAcpThoughtLevel: boot.setAcpThoughtLevel
  }
}

describe('selectWorkspace：远端工作区清掉草稿上的 ACP 目标', () => {
  it('切到远端工作区：草稿里的 ACP 目标与档位槽一起清空', () => {
    const { state, selectWorkspace, draftOf } = makeStore(ACP_TARGET)

    selectWorkspace(REMOTE_WS.id, false)

    expect(draftOf().chatTarget).toBeNull()
    expect(state.draftAcp).toBeNull()
  })

  it('切到远端工作区但草稿是内置模型：原样保留（内置模型在远端照常能用）', () => {
    const { selectWorkspace, draftOf } = makeStore(BUILTIN_TARGET)

    selectWorkspace(REMOTE_WS.id, false)

    expect(draftOf().chatTarget).toEqual(BUILTIN_TARGET)
  })

  it('切到本地工作区：ACP 目标原样保留（本地跑 ACP 是正常用法）', () => {
    const { selectWorkspace, draftOf } = makeStore(ACP_TARGET)

    selectWorkspace(LOCAL_WS.id, false)

    expect(draftOf().chatTarget).toEqual(ACP_TARGET)
  })
})

describe('newConversation：ACP 的 MCP 选择', () => {
  it('将草稿 MCP 选择提交并保留到新会话，即使服务端没有回显', async () => {
    const { state, api, draftOf, newConversation } = makeStore(ACP_TARGET)
    draftOf().mcpServerIds = ['mcp-files']

    expect(await newConversation(LOCAL_WS.id, undefined, ACP_TARGET)).toBe('conv-acp')

    expect(api.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'acp',
      configId: 'agent-a',
      mcpServerIds: ['mcp-files']
    }))
    expect(state.conversations).toEqual([
      expect.objectContaining({ id: 'conv-acp', mcpServerIds: ['mcp-files'] })
    ])
  })
})

describe('newConversation：异步创建与标签焦点隔离', () => {
  it('焦点未变化时正常激活新会话与工作区', async () => {
    const { state, newConversation } = makeStore(ACP_TARGET)

    expect(await newConversation(LOCAL_WS.id, undefined, ACP_TARGET)).toBe('conv-acp')
    expect(state.activeConversationId).toBe('conv-acp')
    expect(state.activeWorkspaceId).toBe(LOCAL_WS.id)
  })

  it('等待创建期间切到其他会话，响应不能把焦点和工作区切回新会话', async () => {
    const { state, api, newConversation } = makeStore(ACP_TARGET)
    let resolveCreated!: (created: Awaited<ReturnType<typeof api.createConversation>>) => void
    api.createConversation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreated = resolve
    }))
    state.activeWorkspaceId = LOCAL_WS.id

    const creating = newConversation(LOCAL_WS.id, undefined, ACP_TARGET)
    // 用户在服务端创建会话的往返期间主动切到了远端工作区的另一个会话。
    state.activeConversationId = 'conv-other'
    state.activeWorkspaceId = REMOTE_WS.id
    resolveCreated({
      id: 'conv-acp', workspaceId: LOCAL_WS.id, backend: 'acp', configId: 'agent-a'
    })

    expect(await creating).toBe('conv-acp')
    expect(state.conversations).toEqual([
      expect.objectContaining({ id: 'conv-acp', workspaceId: LOCAL_WS.id })
    ])
    expect(state.activeConversationId).toBe('conv-other')
    expect(state.activeWorkspaceId).toBe(REMOTE_WS.id)
  })

  it('等待期间只切换工作区，也不能被创建响应切回', async () => {
    const { state, api, newConversation } = makeStore(ACP_TARGET)
    let resolveCreated!: (created: Awaited<ReturnType<typeof api.createConversation>>) => void
    api.createConversation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreated = resolve
    }))
    state.activeWorkspaceId = LOCAL_WS.id

    const creating = newConversation(LOCAL_WS.id, undefined, ACP_TARGET)
    state.activeWorkspaceId = REMOTE_WS.id
    resolveCreated({ id: 'conv-acp', workspaceId: LOCAL_WS.id, backend: 'acp', configId: 'agent-a' })

    expect(await creating).toBe('conv-acp')
    expect(state.activeConversationId).toBeNull()
    expect(state.activeWorkspaceId).toBe(REMOTE_WS.id)
  })

  it('等待临时工作区清单刷新时切走，刷新结束后也不能抢焦点', async () => {
    const { state, api, newConversation } = makeStore(ACP_TARGET)
    let resolveWorkspaces!: (workspaces: Awaited<ReturnType<typeof api.listWorkspaces>>) => void
    api.listWorkspaces.mockImplementationOnce(() => new Promise((resolve) => {
      resolveWorkspaces = resolve
    }))

    // undefined 对应发送时未选工作区，服务端创建临时工作区后还需刷新清单。
    const creating = newConversation(undefined, undefined, ACP_TARGET)
    await vi.waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledOnce())
    state.activeConversationId = 'conv-other'
    state.activeWorkspaceId = REMOTE_WS.id
    resolveWorkspaces([LOCAL_WS, REMOTE_WS])

    expect(await creating).toBe('conv-acp')
    expect(state.activeConversationId).toBe('conv-other')
    expect(state.activeWorkspaceId).toBe(REMOTE_WS.id)
  })

  it('只下发发起创建时的 ACP 档位，保留等待期间新选的草稿档位', async () => {
    const { state, api, newConversation, setAcpAgentMode, setAcpThoughtLevel } = makeStore(ACP_TARGET)
    let resolveCreated!: (created: Awaited<ReturnType<typeof api.createConversation>>) => void
    api.createConversation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreated = resolve
    }))
    state.draftAcp = { agentId: 'agent-a', mode: 'plan', thought: 'deep' }

    const creating = newConversation(LOCAL_WS.id, undefined, ACP_TARGET)
    const nextDraft = { agentId: 'agent-a', mode: 'code', thought: 'fast' }
    state.draftAcp = nextDraft
    resolveCreated({ id: 'conv-acp', workspaceId: LOCAL_WS.id, backend: 'acp', configId: 'agent-a' })

    expect(await creating).toBe('conv-acp')
    expect(setAcpAgentMode).toHaveBeenCalledWith('agent-a', 'conv-acp', 'plan')
    expect(setAcpThoughtLevel).toHaveBeenCalledWith('agent-a', 'conv-acp', 'deep')
    expect(state.draftAcp).toBe(nextDraft)
  })
})
