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

/**
 * 「重新加载会话」撞上正在直播的一轮（回归测试）。
 *
 * ## 防的是什么
 *
 * 跑到一半刷新页面，偶尔看到「本轮输出先单独出现在最顶部（还没有历史），随后历史
 * 消息一出现，这段输出就没了」。宿主的自动补拉（`MessageList` 那条「一条消息都没有
 * 就静默 reload 一次」）会在刷新恢复的窗口里触发 `reloadAcpSession`：
 *
 * 1. `useAttachRemoteRun` 先接上这一轮，占位消息上已经回放出正文（= 最顶部那段输出）；
 * 2. `reloadAcpSession` 拿到的快照是**进程内快照再把本轮助手消息摘掉**（见 transcript
 *    路由），它在没跑的那条路上是「整份换掉」—— 于是直接把直播那条连 id 一起盖没；
 * 3. 紧接着那次 `attachRun(resume)` 看到本端 live 流还活着，直接放行（不会再建占位）：
 *    没人把助手消息加回来，之后每一帧都因 `liveIndex < 0` 被静默丢弃 —— 正文永久消失。
 *
 * 这里钉住：跑动中的重载必须**合并**快照（历史在前、本地直播消息接在后面），
 * 正在写的那条助手消息连 parts 一起原样留着。
 */
describe('reloadAcpSession · 跑动中重载不能抹掉正在直播的助手消息', () => {
  it('快照与本地现场合并，直播消息（含已回放正文）保留', async () => {
    const currentUser: AgentChatMessage = {
      id: 'u-1',
      role: 'user',
      parts: [{ type: 'text', text: '这一轮的提问' }],
      createdAt: 3
    }
    const liveAssistant: AgentChatMessage = {
      id: 'a-live',
      role: 'assistant',
      parts: [{ type: 'text', text: '已经回放出来的正文' }],
      createdAt: 4
    }
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
      activeRun: vi.fn(async () => ({
        run: { requestId: 'r-1', assistantMessageId: 'a-live' }
      })),
      // 跑动中服务端只给快照，且把本轮助手消息摘掉了（见 transcript 路由）
      getAcpTranscript: vi.fn(async () => ({ messages: [currentUser] })),
      attachRun: vi.fn(async () => undefined)
    }
    const { state, read } = makeStore(api)
    const slices = state.slices as Record<string, ConvSlice>
    slices[CONVERSATION_ID] = {
      ...emptySlice(),
      messages: [liveAssistant],
      streaming: true,
      request: {
        id: 'r-1',
        controller: new AbortController(),
        assistantId: 'a-live'
      },
      loadGen: 1
    }

    const reload = state.reloadAcpSession as (id: string) => Promise<boolean>
    const ok = await reload(CONVERSATION_ID)

    expect(ok).toBe(true)
    // 历史在前、本地直播消息在后；live 那条的正文一个 part 都不能少
    expect(read(CONVERSATION_ID).messages.map((m) => m.id)).toEqual([
      'u-1',
      'a-live'
    ])
    expect(
      read(CONVERSATION_ID).messages.find((m) => m.id === 'a-live')?.parts
    ).toEqual(liveAssistant.parts)
    // 本端这条 live 流还活着：不许再挂第二条
    expect(api.attachRun).not.toHaveBeenCalled()
    expect(read(CONVERSATION_ID).streaming).toBe(true)
  })
})

/**
 * 刷新撞上运行中的 ACP 会话（回归测试 · 第二轮）。
 *
 * ## 防的是什么
 *
 * 「历史消息未加载：刷新后只有输出，没有历史消息」。
 *
 * 1. `useAttachRemoteRun` 先接上这一轮：占位 + 回放正文，并把 `runningConversations`
 *    置位（它只接流、不拉历史 —— ACP 那条路刻意跳过 `loadMessages`）；
 * 2. `loadConversation` 的 `peekActiveRun` 这时才回来：以前看见 `runningConversations`
 *    有这条会话就当成「本端自己正在跑」整段跳过（连快照都不拉）；
 * 3. 于是没有任何一处把历史写进切片 —— 界面只剩本轮那条输出，再刷新一次才回来
 *    （那次走的是 idle 回放）。
 *
 * 这里钉住：本端已订着流时**仍然**补拉快照并合并历史，只是不再 attach。
 */
describe('loadConversation · 先 attach 也要补历史', () => {
  it('runningConversations 已有这条会话时仍拉快照合并，且不再 attach', async () => {
    const gate = deferred<{ run: { requestId: string; assistantMessageId: string } }>()
    const snapshot: AgentChatMessage[] = [
      { id: 'u-old', role: 'user', parts: [{ type: 'text', text: '更早的问题' }], createdAt: 1 },
      { id: 'a-old', role: 'assistant', parts: [{ type: 'text', text: '更早的回复' }], createdAt: 2 },
      { id: 'u-now', role: 'user', parts: [{ type: 'text', text: '这一轮的提问' }], createdAt: 3 }
    ]
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
      activeRun: vi.fn(async () => gate.promise),
      getAcpTranscript: vi.fn(async () => ({ messages: snapshot })),
      attachRun: vi.fn(async () => undefined)
    }
    const { state, read, loadConversation } = makeStore(api)
    const done = loadConversation(CONVERSATION_ID)
    // loadMessages 已经收尾、正在等 peekActiveRun —— 这时远程流先接上了
    await vi.waitFor(() => expect(api.activeRun).toHaveBeenCalledTimes(1))
    const slices = state.slices as Record<string, ConvSlice>
    slices[CONVERSATION_ID] = {
      ...emptySlice(),
      messages: [
        {
          id: 'a-live',
          role: 'assistant',
          parts: [{ type: 'text', text: '直播出来的正文' }],
          createdAt: 4
        }
      ],
      streaming: true,
      request: { id: 'r-1', controller: new AbortController(), assistantId: 'a-live' },
      loadGen: 1
    }
    state.runningConversations = { [CONVERSATION_ID]: true }

    gate.resolve({ run: { requestId: 'r-1', assistantMessageId: 'a-live' } })
    await done

    // 历史在前、直播那条接在后面（正文一个 part 都不能少）
    expect(read(CONVERSATION_ID).messages.map((m) => m.id)).toEqual([
      'u-old',
      'a-old',
      'u-now',
      'a-live'
    ])
    // 本端已经有一条流：不许再挂第二条
    expect(api.attachRun).not.toHaveBeenCalled()
    expect(read(CONVERSATION_ID).streaming).toBe(true)
  })
})

/**
 * 同一场景的另一半：刷新恢复的窗口里这一轮**已经收尾**。
 *
 * `peekActiveRun` 回来时 run 已结束 → 走 idle 的 `session/load` 回放。以前那条
 * 「本地消息必须为空才写」的判据把回放整份丢掉（本地有 attach 接出来的占位），
 * 界面同样是「只有输出、没有历史」。
 *
 * 回放是权威全量，整份换掉才对；本地存在 user 消息（用户刚发出了新一轮）才让位。
 */
describe('loadConversation · 收尾恰好发生在装载途中', () => {
  it('idle 回放整份替换掉 attach 残留的占位，历史不再丢', async () => {
    const gate = deferred<{ run: null }>()
    const full: AgentChatMessage[] = [
      { id: 'u-old', role: 'user', parts: [{ type: 'text', text: '更早的问题' }], createdAt: 1 },
      { id: 'a-old', role: 'assistant', parts: [{ type: 'text', text: '更早的回复' }], createdAt: 2 },
      { id: 'u-now', role: 'user', parts: [{ type: 'text', text: '这一轮的提问' }], createdAt: 3 },
      { id: 'a-final', role: 'assistant', parts: [{ type: 'text', text: '这一轮的回复' }], createdAt: 4 }
    ]
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
      activeRun: vi.fn(async () => gate.promise),
      getAcpTranscript: vi.fn(async () => ({ messages: full })),
      attachRun: vi.fn(async () => undefined)
    }
    const { state, read, loadConversation } = makeStore(api)
    const done = loadConversation(CONVERSATION_ID)
    await vi.waitFor(() => expect(api.activeRun).toHaveBeenCalledTimes(1))
    const slices = state.slices as Record<string, ConvSlice>
    slices[CONVERSATION_ID] = {
      ...emptySlice(),
      messages: [
        {
          id: 'a-live',
          role: 'assistant',
          parts: [{ type: 'text', text: '直播出来的正文' }],
          createdAt: 5
        }
      ],
      loadGen: 1
    }

    gate.resolve({ run: null })
    await done

    // 回放是全量：占位（同一条回复的临时 id）被换掉，不重复
    expect(read(CONVERSATION_ID).messages.map((m) => m.id)).toEqual([
      'u-old',
      'a-old',
      'u-now',
      'a-final'
    ])
  })
})

/**
 * 「跑动中重载」把本地历史整段挂到了新消息后面（回归测试）。
 *
 * ## 防的是什么
 *
 * 用户报的：「我发出的消息跑到了上一条 AI 回复的上方」——ACP 会话在后台被回收后重新
 * 拉取（`session/load`）会重建出一份消息列表，回放的 id 是现编的（`u-replay-N` /
 * `a-replay-N`）。客户端此时已经把这一轮发出去了（快照末尾追加了那条用户消息），重载
 * 回来走 `mergeHistory`：历史在前、本地独有的接在后面。按 id 求差时两批基本对不上，
 * 本地那一整段历史就被当成「历史里没有的新消息」接在了末尾 —— 界面读作「刚发出的消息
 * 下面又跟了一整套旧对话」，直到这一轮结束走「整份替换」才复位。
 *
 * 服务端已经按轮把 id 换回去了（`carryOverIds`），这里钉住**第二道闸**：角色序列对得上
 * 时，本地那一段算「已被历史覆盖」，只接真正的尾巴，绝不整段重复。
 */
describe('mergeHistory · 快照 id 与本地历史对不上时不能重复挂一整段', () => {
  it('角色序列对得上就只接尾巴，历史在前、直播在后', async () => {
    const gate = deferred<{ run: { requestId: string; assistantMessageId: string } }>()
    /** 服务端快照：历史两轮都是回放现编的 id，末尾那条是本轮用户消息（id 与客户端一致） */
    const snapshot: AgentChatMessage[] = [
      { id: 'u-replay-1', role: 'user', parts: [{ type: 'text', text: '更早的问题' }], createdAt: 1 },
      { id: 'a-replay-2', role: 'assistant', parts: [{ type: 'text', text: '更早的回复' }], createdAt: 2 },
      { id: 'u-2', role: 'user', parts: [{ type: 'text', text: '这一轮的提问' }], createdAt: 3 }
    ]
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
      activeRun: vi.fn(async () => gate.promise),
      getAcpTranscript: vi.fn(async () => ({ messages: snapshot })),
      attachRun: vi.fn(async () => undefined)
    }
    const { state, read, loadConversation } = makeStore(api)
    const done = loadConversation(CONVERSATION_ID)
    // loadMessages 已收尾、正在等这一轮的探测 —— 这时本地现场是本轮之前的客户端 id
    await vi.waitFor(() => expect(api.activeRun).toHaveBeenCalledTimes(1))
    const slices = state.slices as Record<string, ConvSlice>
    slices[CONVERSATION_ID] = {
      ...emptySlice(),
      messages: [
        { id: 'u-1', role: 'user', parts: [{ type: 'text', text: '更早的问题' }], createdAt: 1 },
        { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: '更早的回复' }], createdAt: 2 },
        { id: 'u-2', role: 'user', parts: [{ type: 'text', text: '这一轮的提问' }], createdAt: 3 },
        { id: 'a-live', role: 'assistant', parts: [{ type: 'text', text: '直播出来的正文' }], createdAt: 4 }
      ],
      streaming: true,
      request: { id: 'r-1', controller: new AbortController(), assistantId: 'a-live' },
      loadGen: 1
    }
    state.runningConversations = { [CONVERSATION_ID]: true }

    gate.resolve({ run: { requestId: 'r-1', assistantMessageId: 'a-live' } })
    await done

    // 没有多出来的旧对话：本地那两轮被判成「已被历史覆盖」，只接本轮直播那条
    expect(read(CONVERSATION_ID).messages.map((m) => m.id)).toEqual([
      'u-replay-1',
      'a-replay-2',
      'u-2',
      'a-live'
    ])
    expect(read(CONVERSATION_ID).messages.find((m) => m.id === 'a-live')?.parts).toEqual([
      { type: 'text', text: '直播出来的正文' }
    ])
  })
})
