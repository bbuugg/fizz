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
  const api = { setConversationTarget: vi.fn(async () => ({ ok: true })) }
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

  return { state, selectWorkspace, draftOf }
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
