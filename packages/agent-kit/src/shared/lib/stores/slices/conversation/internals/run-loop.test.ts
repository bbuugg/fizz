/**
 * 会话装载期间的「装载中」标记（回归测试）。
 *
 * ## 防的是什么
 *
 * 刷新页面后进 ACP 会话会**闪一下空态**（消息区那句「在「工作区」里说点什么」）：
 *
 * 1. `loadConversation` 先 `await loadMessages(...)`，ACP 会话的服务端历史恒为空，
 *    收尾把 `messages` 写成 `[]`、并且**把 `loading` 撤成 false**；
 * 2. 接着还要走两个往返才知道有没有内容 —— `peekActiveRun`（这一轮还在不在跑）
 *    与 `session/load` 回放；
 * 3. 这两个往返之间 `loading` 是 false、`messages` 还是空，消息区就按「一条消息都没有」
 *    渲染空态，回放一到又被消息顶掉。
 *
 * 以前的补丁只在「会话清单还没落地」时重新亮灯（`!conversationsLoaded` 那条分支），
 * 而刷新后的恢复入口是 `PanelView` 等清单到位再把当前会话对齐到焦点标签 —— 进
 * `loadConversation` 时清单**已经** loaded，于是那条分支根本不进，空态必闪。
 *
 * 这里钉住：`peekActiveRun` 还没返回的那段窗口里，切片必须是 `loading: true`。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import { createConversationSlice } from '../index'
import { emptySlice } from '../state'
import type { ConvSlice } from '../types'

/** 手写一个可外部放行的 promise（模拟「探测在不在跑」那个往返） */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const CONVERSATION_ID = 'conv-acp'

const replayAssistant: AgentChatMessage = {
  id: 'a-1',
  role: 'assistant',
  parts: [{ type: 'text', text: '回放出来的回复' }],
  createdAt: 1
}

/**
 * 最小 store：只给 `loadConversation` 这条链路实际会读的字段。
 *
 * `set` 同时支持 patch 对象与 updater（zustand 两种写法切片里都在用）。
 */
function makeStore(api: Record<string, unknown>) {
  const state: Record<string, unknown> = {
    activeConversationId: CONVERSATION_ID,
    conversations: [
      {
        id: CONVERSATION_ID,
        backend: 'acp',
        configId: 'cfg-1',
        acpSessionId: 'sess-1',
        workspaceId: 'ws-1',
        title: 'acp 会话',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    conversationsLoaded: true,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    runningConversations: {},
    models: [],
    acpAgents: [],
    chatTarget: null,
    getApi: () => api,
    setBusy: () => undefined,
    setError: () => undefined
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
  // `createConversationSlice` 的初始值会覆盖上面铺的现场（它自己写 activeConversationId: null），
  // 装完再把这条会话摆回来
  Object.assign(state, {
    activeConversationId: CONVERSATION_ID,
    conversations: [
      {
        id: CONVERSATION_ID,
        backend: 'acp',
        configId: 'cfg-1',
        acpSessionId: 'sess-1',
        workspaceId: 'ws-1',
        title: 'acp 会话',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    conversationsLoaded: true,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    models: [],
    acpAgents: [],
    chatTarget: null,
    getApi: () => api,
    setBusy: () => undefined,
    setError: () => undefined
  })
  const read = (id: string): ConvSlice => (state.slices as Record<string, ConvSlice>)[id]
  return {
    state,
    read,
    slice,
    loadConversation: slice.loadConversation as (id: string) => Promise<void>
  }
}

function acpApi(peekGate: { promise: Promise<null> }, calls: { activeRun: number }) {
  return {
    // ACP 会话的服务端历史恒为空（回放才是真源）
    getConversation: vi.fn(async (id: string) => ({
      id,
      backend: 'acp' as const,
      configId: 'cfg-1',
      acpSessionId: 'sess-1',
      workspaceId: 'ws-1',
      title: 'acp 会话',
      createdAt: 1,
      updatedAt: 1,
      messages: [] as AgentChatMessage[]
    })),
    /**
     * 第一次是 `peekActiveRun`（挂住，模拟服务端往返），之后的是 `attachRun` 的探测
     * —— 没有在跑，直接给 null。
     */
    activeRun: vi.fn(async () => {
      calls.activeRun += 1
      if (calls.activeRun === 1) {
        await peekGate.promise
        return { run: null }
      }
      return { run: null }
    }),
    getAcpTranscript: vi.fn(async () => ({ messages: [replayAssistant] }))
  }
}

describe('loadConversation · ACP 装载窗口', () => {
  it('探测「有没有在跑」的往返期间保持装载中（不再闪空态）', async () => {
    const peekGate = deferred<null>()
    const calls = { activeRun: 0 }
    const api = acpApi(peekGate, calls)
    const { read, loadConversation, state } = makeStore(api)

    const done = loadConversation(CONVERSATION_ID)
    // 走到 peekActiveRun 的等待点：loadMessages 已经收尾（loading 被撤过一次）
    await vi.waitFor(() => expect(api.activeRun).toHaveBeenCalledTimes(1))
    expect(state.conversationsLoaded).toBe(true)
    // 关键断言：这一段消息区必须显示装载中，而不是「一条消息都没有」的空态
    expect(read(CONVERSATION_ID).loading).toBe(true)
    expect(read(CONVERSATION_ID).messages).toHaveLength(0)

    peekGate.resolve(null)
    await done

    // 回放落地、装载标记撤掉
    expect(read(CONVERSATION_ID).messages).toEqual([replayAssistant])
    expect(read(CONVERSATION_ID).loading).toBe(false)
  })
})

/**
 * 刷新撞上运行中的会话（回归测试）。
 *
 * ## 防的是什么
 *
 * 跑到一半刷新页面，历史消息整段不显示，只剩当前这一轮；要等这轮结束再刷新一次才回来。
 *
 * 装载时 `useAttachRemoteRun` 会先 `attachRun`（把 `loadGen` +1、挂上本轮助手占位），
 * 而 `loadMessages` 早在此之前就读走了旧的 `loadGen`。响应回来时代次已经不符 —— 以前
 * 直接 `return`，服务端那份历史就被**整份丢弃**了。
 *
 * 这里钉住：代次不符时也要**合并**（历史在前、本地独有的消息在后），而不是丢掉历史。
 */
describe('loadMessages · 代次变了也要保住历史', () => {
  it('历史响应晚于 attachRun 时仍合并进现场', async () => {
    const gate = deferred<{
      id: string
      messages: AgentChatMessage[]
    }>()
    const history: AgentChatMessage[] = [
      { id: 'u-old', role: 'user', parts: [{ type: 'text', text: '更早的问题' }], createdAt: 1 },
      { id: 'a-old', role: 'assistant', parts: [{ type: 'text', text: '更早的回复' }], createdAt: 2 }
    ]
    const placeholder: AgentChatMessage = {
      id: 'a-live',
      role: 'assistant',
      parts: [],
      createdAt: 3
    }
    const api = {
      getConversation: vi.fn(async (id: string) => {
        const { messages } = await gate.promise
        return {
          id,
          backend: 'builtin' as const,
          configId: null,
          workspaceId: 'ws-1',
          title: '会话',
          createdAt: 1,
          updatedAt: 1,
          messages
        }
      })
    }
    const { state, read } = makeStore(api)
    const slices = state.slices as Record<string, ConvSlice>
    slices[CONVERSATION_ID] = { ...emptySlice(), messages: [placeholder], loadGen: 0 }

    const pending = (sliceCall(state, 'loadMessages') as (id: string) => Promise<unknown>)(
      CONVERSATION_ID
    )
    // 历史请求已经发出、还没回来：模拟 attachRun 把代次 +1 并挂上占位
    await vi.waitFor(() => expect(api.getConversation).toHaveBeenCalledTimes(1))
    slices[CONVERSATION_ID] = { ...slices[CONVERSATION_ID], loadGen: 1 }

    gate.resolve({ id: CONVERSATION_ID, messages: history })
    await pending

    // 历史一条都不能少，本地占位接在后面（按 id 去重）
    expect(read(CONVERSATION_ID).messages.map((m) => m.id)).toEqual([
      'u-old',
      'a-old',
      'a-live'
    ])
  })
})

/** 从 store 现场里取动作（`makeStore` 把切片动作摊在 state 上） */
function sliceCall(state: Record<string, unknown>, name: string): unknown {
  return state[name]
}

/**
 * 本端正在跑这一轮时，装载会话**不许**再接第二条流（回归测试）。
 *
 * ## 防的是什么
 *
 * 用 ACP agent（pi）新建会话发第一条，正文每个字都重复显示两遍，只有整轮结束后
 * 手动「重新加载会话」才恢复。
 *
 * 链路：`newConversation` 建完会话先把 `activeConversationId` 切过去（界面立刻从
 * 空态页进会话），而 ACP 还要下发 `setAcpAgentMode` / `setAcpThoughtLevel`
 * （两次进程往返）才 `writeSlice` 落本轮占位。这段窗口里 `slices[id]` 还不存在，
 * 任何一次 `openConversation(id)`（PanelView 对齐标签 / 侧栏点会话 / 刷新后恢复）
 * 都会走完整装载 —— 那时 `runRound` 的 `streamChat` 已经上路，`peekActiveRun`
 * 探到的就是**自己这一轮**。
 *
 * 以前这里无条件 `attachRun`（而且 resume 路径还跳过 `subscribing` 去重）：
 * attach 先把 parts 清空再从头回放，`runRound` 那条直播同时在写，两条流把同一批
 * 帧各追加一遍 —— `handleFrame` 是追加式的，重复就是正文重复。
 */
describe('loadConversation · 本端正在跑时不再接第二条流', () => {
  it('runningConversations 里有这条会话就不 attach、也不拉快照', async () => {
    const api = {
      getConversation: vi.fn(async (id: string) => ({
        id,
        backend: 'acp' as const,
        configId: 'cfg-1',
        acpSessionId: 'sess-1',
        workspaceId: 'ws-1',
        title: 'acp 会话',
        createdAt: 1,
        updatedAt: 1,
        messages: [] as AgentChatMessage[]
      })),
      // 服务端确实有一条在跑的 run —— 但那是本端自己发起的这一轮
      activeRun: vi.fn(async () => ({
        run: { requestId: 'r-1', assistantMessageId: 'a-live' }
      })),
      getAcpTranscript: vi.fn(async () => ({ messages: [replayAssistant] })),
      attachRun: vi.fn(async () => undefined)
    }
    const { state, read, loadConversation } = makeStore(api)
    state.runningConversations = { [CONVERSATION_ID]: true }

    await loadConversation(CONVERSATION_ID)

    // 一条都不许再接：本端的 live 流就是真源
    expect(api.attachRun).not.toHaveBeenCalled()
    expect(api.getAcpTranscript).not.toHaveBeenCalled()
    // 装载标记仍然要撤（否则消息区一直转圈）
    expect(read(CONVERSATION_ID).loading).toBe(false)
  })
})

/**
 * `attachRun` 的 `resume` 兜底（回归测试）：本端 live 流没断时，带 `requestId`
 * 的强制重接也是「重接自己的流」，同样会把正文写两遍。
 */
describe('attachRun · 本端 live 流还活着时不重复接', () => {
  it('resume 传了 requestId 也直接放行给本端那条流', async () => {
    const api = {
      getConversation: vi.fn(async (id: string) => ({
        id,
        backend: 'acp' as const,
        configId: 'cfg-1',
        acpSessionId: 'sess-1',
        workspaceId: 'ws-1',
        title: 'acp 会话',
        createdAt: 1,
        updatedAt: 1,
        messages: [] as AgentChatMessage[]
      })),
      activeRun: vi.fn(async () => ({ run: null })),
      getAcpTranscript: vi.fn(async () => ({ messages: [] as AgentChatMessage[] })),
      attachRun: vi.fn(async () => undefined)
    }
    const { state, read, loadConversation } = makeStore(api)
    await loadConversation(CONVERSATION_ID)
    // 本端 `runRound` 正在直播这一轮
    const live = read(CONVERSATION_ID)
    live.streaming = true
    live.request = {
      id: 'r-1',
      controller: new AbortController(),
      assistantId: 'a-live'
    }

    const attachRun = state.attachRun as (
      id: string,
      opts: { requestId: string; assistantId: string }
    ) => Promise<boolean>
    const attached = await attachRun(CONVERSATION_ID, {
      requestId: 'r-1',
      assistantId: 'a-live'
    })

    expect(attached).toBe(true)
    expect(api.attachRun).not.toHaveBeenCalled()
  })
})
