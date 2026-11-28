/**
 * 回归：`openConversation` 的两条「什么时候该动消息区」的规矩。
 *
 * ## 1. 「已是当前会话」早退必须带上「本地现场还在」
 *
 * 新建会话后消息区**永远停在骨架屏**（用户报「打开后消息列表始终
 * 显示 loading」）：
 *
 * 1. `newConversation` 建完会话就把 `activeConversationId` 设成它（界面要立刻切进去）；
 * 2. 调用方紧接着那次 `openConversation(id)` 命中「已是当前会话，什么都不做」早退；
 * 3. 可那一刻 `slices[id]` 根本不存在 —— **没有任何人发装载请求**，也没有任何请求在飞；
 * 4. `messagesLoading` 的兜底是「本屏绑了会话、现场还没建 → true」，于是骨架屏永不消失
 *    （重试按钮也不会出现：`messagesError` 同样是空的）。
 *
 * 刷新后恢复标签同理会中：`activeConversationId` 已从 localStorage 还原成同一条，
 * 而 `slices` 是空的。
 *
 * 这里钉住两件事：**现场没建时必须装载**；**现场在时仍然早退**（切回来不该白闪重拉）。
 *
 * ## 2. `scrollResetSeq` 只在「真的要看最新」时 bump
 *
 * 它是**复位落底**的信号（`ChatPanel` 把它拼进 `resetKey`），不是「切过去了」的信号。
 * 无条件 bump 的表现是「翻上去读历史 → 点另一个标签 → 点回来，列表自己跳到底部」
 * （用户报的）。切标签走 `keepScroll`，不 bump；侧栏 / 通知 / 深链打开照旧 bump。
 *
 * ## 3. 切回仍打开的新对话标签，不能重新初始化它的模型 / MCP / ACP 草稿。
 * 标签导航（keepScroll）只切焦点，显式新建才初始化草稿。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationSlice } from '../index'
import type { ConvSlice } from '../types'

const CONVERSATION_ID = 'conv-chat'

/** 普通会话的最小 api 桩：装载链路会读的那几个方法 */
function makeApi() {
  return {
    getConversation: vi.fn(async () => ({
      id: CONVERSATION_ID,
      workspaceId: 'ws-1',
      backend: 'builtin',
      title: '新会话',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })),
    // 收尾时 `attachRun` 的探测：null = 这条会话没有在跑的 run
    activeRun: vi.fn(async () => ({ run: null })),
    // 打开会话顺带同步队列
    getConversationQueue: vi.fn(async () => ({ items: [] }))
  }
}

/** 最小 store：只给 `openConversation` / `loadConversation` 这条链路实际会读的字段 */
function makeStore(api: Record<string, unknown>) {
  const conversation = {
    id: CONVERSATION_ID,
    backend: 'builtin',
    configId: 'cfg-1',
    workspaceId: 'ws-1',
    title: '普通会话',
    createdAt: 1,
    updatedAt: 1
  }
  const boot = {
    conversations: [conversation],
    conversationsLoaded: true,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    runningConversations: {},
    models: [],
    acpAgents: [],
    chatTarget: null,
    slices: {} as Record<string, ConvSlice>,
    getApi: () => api,
    setBusy: () => undefined,
    setError: () => undefined
  }
  const state: Record<string, unknown> = {
    ...boot,
    activeConversationId: null
  }
  const set = (partial: unknown): void => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: unknown) => object)(state)
        : partial
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
  // `createConversationSlice` 的初始现场会盖掉上面铺的字段（它自己写 activeConversationId: null、
  // 空 slices），装完再摆回「新建会话刚建好、还没人装载」的那一刻
  Object.assign(state, boot, { activeConversationId: CONVERSATION_ID })

  const sliceOf = (id: string): ConvSlice | undefined =>
    (state.slices as Record<string, ConvSlice>)[id]
  return { state, slice, sliceOf }
}

function open(
  slice: Record<string, unknown>,
  id: string,
  opts?: { keepScroll?: boolean }
): void {
  ;(
    slice.openConversation as (conversationId: string, o?: { keepScroll?: boolean }) => void
  )(id, opts)
}

describe('openConversation：已是当前会话时的早退', () => {
  it('本地现场没建时必须装载（否则消息区永远停在骨架屏）', async () => {
    const api = makeApi()
    const { state, slice, sliceOf } = makeStore(api)

    // 刚建会话的那一刻：已经激活，但没有人装载过
    expect(state.activeConversationId).toBe(CONVERSATION_ID)
    expect(sliceOf(CONVERSATION_ID)).toBeUndefined()

    open(slice, CONVERSATION_ID)

    // 现场被建出来，且装载走完（loading 落地为 false）
    await vi.waitFor(() => {
      expect(sliceOf(CONVERSATION_ID)?.loading).toBe(false)
    })
    expect(api.getConversation).toHaveBeenCalledWith(CONVERSATION_ID)
  })

  it('现场还在时仍然早退，不重复重拉', async () => {
    const api = makeApi()
    const { slice, sliceOf } = makeStore(api)

    open(slice, CONVERSATION_ID)
    await vi.waitFor(() => {
      expect(sliceOf(CONVERSATION_ID)?.loading).toBe(false)
    })

    api.getConversation.mockClear()
    open(slice, CONVERSATION_ID)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 切走再切回来时消息已在内存里：重拉只会让界面白闪一次
    expect(api.getConversation).not.toHaveBeenCalled()
  })
})

describe('openConversation：什么时候复位消息区的滚动位置', () => {
  /** 先把会话装载出来，再「切走」（把 active 清掉），模拟「它现在挂在后台标签里」 */
  async function loadedThenAway(
    api: ReturnType<typeof makeApi>
  ): Promise<{ state: Record<string, unknown>; slice: Record<string, unknown>; sliceOf: (id: string) => ConvSlice | undefined }> {
    const store = makeStore(api)
    open(store.slice, CONVERSATION_ID)
    await vi.waitFor(() => {
      expect(store.sliceOf(CONVERSATION_ID)?.loading).toBe(false)
    })
    store.state.activeConversationId = null
    return store
  }

  it('切标签（keepScroll）：不 bump，否则翻上去读的历史会被拽回底部', async () => {
    const { state, slice, sliceOf } = await loadedThenAway(makeApi())
    const before = sliceOf(CONVERSATION_ID)?.scrollResetSeq ?? 0

    open(slice, CONVERSATION_ID, { keepScroll: true })

    expect(state.activeConversationId).toBe(CONVERSATION_ID)
    expect(sliceOf(CONVERSATION_ID)?.scrollResetSeq).toBe(before)
  })

  it('从侧栏 / 通知打开（不传）：照旧 bump 一次，落底看最新', async () => {
    const { state, slice, sliceOf } = await loadedThenAway(makeApi())
    const before = sliceOf(CONVERSATION_ID)?.scrollResetSeq ?? 0

    open(slice, CONVERSATION_ID)

    expect(state.activeConversationId).toBe(CONVERSATION_ID)
    expect(sliceOf(CONVERSATION_ID)?.scrollResetSeq).toBe(before + 1)
  })
})

describe('openConversation：切回草稿标签', () => {
  it('保留这个新对话标签已选好的模型、MCP、思考强度与 ACP 档位', () => {
    const { state, slice } = makeStore(makeApi())
    const settings = {
      chatTarget: { backend: 'acp', configId: 'agent-a', modelId: 'model-a' },
      mcpServerIds: ['mcp-a'],
      browserSettings: null,
      reasoningEffort: 'high'
    }
    const acp = { agentId: 'agent-a', modelId: 'model-a', mode: 'code' }
    state.draftSettings = settings
    state.draftAcp = acp

    ;(slice.openConversation as (
      id: string | null, opts?: { keepScroll?: boolean }
    ) => void)(null, { keepScroll: true })

    expect(state.activeConversationId).toBeNull()
    expect(state.draftSettings).toEqual(settings)
    expect(state.draftAcp).toEqual(acp)
  })

  it('显式开始新对话仍初始化草稿，不继承旧 MCP、思考强度或 ACP 档位', () => {
    const { state, slice } = makeStore(makeApi())
    state.draftSettings = {
      chatTarget: { backend: 'acp', configId: 'agent-a' },
      mcpServerIds: ['mcp-a'],
      browserSettings: null,
      reasoningEffort: 'high'
    }
    state.draftAcp = { agentId: 'agent-a', mode: 'code' }

    ;(slice.openConversation as (id: string | null) => void)(null)

    expect(state.activeConversationId).toBeNull()
    expect(state.draftSettings).toEqual({
      chatTarget: null,
      mcpServerIds: [],
      browserSettings: null,
      reasoningEffort: null
    })
    expect(state.draftAcp).toBeNull()
  })
})
