/**
 * AI 助手的前端现场（zustand 分片）。
 *
 * ## 一个**共享的会话池**，不再是「一个面板一份」
 *
 * - `assistantConversations`：会话 id（= `sessionId`）→ 现场。全局面板、每个终端标签内嵌的
 *   助手**共用这一个池子** —— 在终端助手里聊的，打开项目助手照样能看到、能接着聊；
 * - `assistantActiveId`：当前在看哪一段。切换器改的就是它，所有面板一起跟着换（同一份
 *   状态，不存在「这个面板在看 A、那个在看 B」）。
 * - 落盘在 `lib/assistant-history.ts`（localStorage，会话池 + activeId）。**不再只放内存**：
 *   重启后仍在同一段对话上，历史会话也能从切换器里翻回来。
 *
 * ## 什么时候新建会话
 *
 * 只有两个入口：面板上的「新建会话」（`newAssistantSession`），和「池子空着」时的挂载
 * （`ensureAssistantSession` 建一段空的）。挂载 / 卸载 / 切标签**都不**动对话 ——
 * 收起再展开必须接着上一段聊（用户报过「折叠一下对话就没了」）。
 *
 * ## 消息存在哪
 *
 * 服务端不落盘、没有会话清单，消息只有前端一份：内存里是这个分片，跨刷新靠上面那个存档。
 * 每轮发送时把本地历史随请求带上（`AssistantSendInput.history`）。
 *
 * ## 与聊天切片的关系
 *
 * 帧协议与聊天完全一致（`ChatStreamFrame`）；工具结果帧经 `lib/tool-actions.ts` 的
 * 解释器广播 UI 动作（open-workspace / project-created）。
 * 差别是**收尾不做服务端对账** —— 历史本来就在本地，帧折进去就是最终结果。
 */
import type { StateCreator } from 'zustand'
import type {
  AgentChatMessage,
  AgentConfirmRequest,
  ChatStreamFrame
} from '@fizz/contracts/agent-api'
import type { AiPermissionMode } from '@fizz/contracts/types'
import { applyEvent } from '@fizz/agent-kit/shared/lib/parts'
import { clientToolsFor, handleClientToolCall } from '@fizz/agent-kit/shared/lib/client-tools'
import { errorMessage, nextLocalId } from '@fizz/agent-kit/shared/lib/stores/shared'
import { dispatchProjectUiAction, uiActionsFromEvent } from '@fizz/agent-kit/shared/lib/tool-actions'
import type { AssistantTarget } from '@fizz/agent-kit/shared/lib/assistant-target'
import {
  dropAssistantConversation,
  loadAssistantStore,
  saveAssistantActiveId,
  saveAssistantConversation
} from '@fizz/agent-kit/shared/lib/assistant-history'
import type { AgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'

/** 一段助手会话的现场 */
export interface AssistantSessionState {
  /**
   * 这段会话的 id（客户端生成）。既是会话池的键，也是服务端 run 注册表的键
   * （审批答复 / 中止按它找）—— 新建会话 = 换一个 id。
   */
  sessionId: string
  messages: AgentChatMessage[]
  /**
   * 输入框草稿（**不落盘**）。
   *
   * 放 store 而不是面板的 `useState`：面板收起就是卸载，草稿跟着没 —— 打了半句
   * 想看一眼终端、展开回来只剩空框，与「对话被清空」是同一个毛病。
   */
  draft: string
  streaming: boolean
  /**
   * 当前轮：requestId（停止用）+ 本地占位助手消息 id（帧往它身上折叠）+ 中止器。
   * null = 没有在跑的轮。
   */
  request: { id: string; assistantId: string; controller: AbortController } | null
  /** 等用户答复的审批卡（与聊天同款，答复走共享的 resolveConfirm） */
  pendingConfirms: AgentConfirmRequest[]
  /** 发送失败的人话错误 */
  error: string | null
  /**
   * 「发送」的信号：自增时面板让消息区**同帧同步**落底（与主会话的
   * `scrollResetSeq` 同一套，见 conversation.ts —— 自己发的消息必须立刻出现在底部）。
   * 流式追加的跟随 / 停跟交给 stick-to-bottom，不碰它。
   */
  scrollResetSeq: number
  /** 最后更新时间（会话切换器按它排序；落盘时一起存） */
  updatedAt: number
}

const emptySession = (): AssistantSessionState => ({
  sessionId: `asst-${nextLocalId('s')}`,
  messages: [],
  draft: '',
  streaming: false,
  request: null,
  pendingConfirms: [],
  error: null,
  scrollResetSeq: 0,
  updatedAt: Date.now()
})

/**
 * 落盘防抖：流式期间每来一帧都要写 store，逐帧 `JSON.stringify` + 同步写 localStorage
 * 会拖住渲染。400ms 足够「关窗口前基本都落了」，也不会在长回复里抖。
 */
const PERSIST_DELAY = 400
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 还没落盘的那份快照（会话 id → 内容）；页面被关掉时用它补最后一次写 */
const pendingWrites = new Map<
  string,
  { messages: AgentChatMessage[]; updatedAt: number }
>()

/** 立刻把待写的快照落盘（关页面 / 切到后台时调，别丢最后几百毫秒的回答） */
function flushPendingWrites(): void {
  for (const [id, entry] of pendingWrites) {
    // 定时器还在：先掐掉，否则它稍后还会再写一遍
    const timer = persistTimers.get(id)
    if (timer) clearTimeout(timer)
    persistTimers.delete(id)
    saveAssistantConversation(id, entry.messages, entry.updatedAt)
  }
  pendingWrites.clear()
}

// `pagehide` 而不是 `beforeunload`：移动端 / bfcache 下 beforeunload 常常不触发
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushPendingWrites)

/**
 * 「停止」还在服务端收尾的 promise（会话 id → promise）。
 *
 * 为什么需要它：`POST /api/chat/abort` 要**等这一轮真正收尾**才返回（服务端怕调用方
 * 抢在落盘前面拉历史）。停完立刻再发一句话，就可能在那条 run 还没从
 * `activeByConversation` 里摘掉时到达 `startAssistantTurn`，于是撞上 409
 * 「这个助手会话正在回复中」。发送前等一下这个 promise 就没这个缝。
 */
const stopSettling = new Map<string, Promise<void>>()

/**
 * 等上一轮停止收尾的上限。服务端自己有 10s 兜底，这里不重复等那么久 ——
 * 真卡住了就让它 409 出来给人话，别把输入框按在那里转圈。
 */
const STOP_SETTLE_WAIT_MS = 4_000

/** 从本地存档恢复会话池：刷新后仍在同一段对话上，历史会话也能翻回来 */
function hydrate(): {
  conversations: Record<string, AssistantSessionState>
  activeId: string | null
} {
  const store = loadAssistantStore()
  const conversations: Record<string, AssistantSessionState> = {}
  for (const [id, entry] of Object.entries(store.conversations)) {
    conversations[id] = {
      ...emptySession(),
      sessionId: entry.sessionId,
      messages: entry.messages,
      updatedAt: entry.updatedAt
    }
  }
  // 存档里的 activeId 可能指向一段已空（没消息就没落盘）的会话：那种情况按「没有当前会话」
  // 处理，由面板挂载时的 `ensureAssistantSession` 建一段新的
  const activeId = store.activeId && conversations[store.activeId] ? store.activeId : null
  return { conversations, activeId }
}

export interface AssistantSlice {
  /** 会话 id → 现场（所有助手面板共享这一个池子） */
  assistantConversations: Record<string, AssistantSessionState>
  /** 当前在看的会话 id（null = 还没有会话，面板挂载时会建一段） */
  assistantActiveId: string | null
  /**
   * 确保有「当前会话」（面板挂载时调）：activeId 有效就复用，否则落到最近更新的一段，
   * 池子空着才新建。返回会话 id。
   */
  ensureAssistantSession(): string
  /** 新建一段会话并切过去（面板上的「新建会话」） */
  newAssistantSession(): string
  /** 切到某段会话（切换器里点一行） */
  switchAssistantSession(sessionId: string): void
  /**
   * 删掉某段会话（内存 + 存档）。删的是当前这段就自动落到最近的一段；一段都不剩就新建空的。
   * 正在跑的那一轮会先停掉。
   */
  deleteAssistantSession(sessionId: string): void
  /** 改当前会话的输入框草稿（不落盘，只为「收起再展开」保住半句话） */
  setAssistantDraft(text: string): void
  /**
   * 在当前会话里发一句话。
   * `scope` 决定挂哪组工具（互斥）：`'project'` 只有项目工具，`'terminal'` 只有该终端的工具。
   * `terminalTabKey` 只在 `scope === 'terminal'` 时用于取终端工具。
   * `permissionMode` 是这一轮的工具权限档（输入框左侧那颗 pill）；不传 = 服务端按 `confirm`。
   */
  sendAssistant(
    text: string,
    scope: 'project' | 'terminal',
    target?: AssistantTarget,
    terminalTabKey?: string | null,
    permissionMode?: AiPermissionMode
  ): Promise<void>
  /** 停掉当前会话正在跑的那一轮 */
  stopAssistant(): void
  /**
   * 编辑并重发：把该条及其后的全部消息截掉，再用改后的文本发一轮。
   *
   * 与主会话 `resendMessage` 同一套语义，但**不用请求服务端删历史** —— 助手历史本来
   * 就只有前端一份（服务端每轮收 `history`、自己不存），截断 = 本地数组切片。
   *
   * 返回 `false` = 这一下没发出去（没有会话 / 那条不见了 / 正在回复中），此时
   * **一个字都没删**：先截再发会撞上 `sendAssistant` 的「跑着不发」守卫，历史已经
   * 删了却没发出去就是白丢一段。面板据此把编辑态还回去。
   *
   * 返回 `true` = 历史已截断、新一轮**已经发起**（不是「整轮跑完了」）：`sendAssistant`
   * 要等整条流结束才 resolve，所以这里**不 await** 它 —— 否则调用方拿到的「发出去了」
   * 信号会晚一整轮，输入框里已发出的草稿要等回复结束才清。
   */
  resendAssistantMessage(
    messageId: string,
    text: string,
    scope: 'project' | 'terminal',
    target?: AssistantTarget,
    terminalTabKey?: string | null,
    permissionMode?: AiPermissionMode
  ): Promise<boolean>
  /**
   * 删掉一条历史消息（`single` = 只删本条，`from` = 本条及其后全部）。
   *
   * 纯本地操作（本地切片 + 存档），没有服务端对账。正在回复中删到最后那条流式占位时，
   * 后续帧折叠不到目标就自然丢弃（`handleFrame` 按 id `map`），不会把它写回来。
   */
  deleteAssistantMessage(messageId: string, mode: 'single' | 'from'): void
  /**
   * 运行中切换这一轮的权限档（面板那颗 pill 切档时调）。把该 run 的活档改掉，
   * 闸门下一次工具调用立刻按新档裁决（不必等下一轮）。没有在跑的轮 = 空操作。
   */
  setAssistantPermissionMode(mode: AiPermissionMode): void
}

export const createAssistantSlice: StateCreator<AgentStore, [], [], AssistantSlice> = (
  set,
  get
) => {
  const initial = hydrate()

  /** 清掉某段会话的落盘定时器（删除 / 新建时用，别让旧快照晚一步写回来） */
  const cancelPersist = (sessionId: string): void => {
    pendingWrites.delete(sessionId)
    const timer = persistTimers.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    persistTimers.delete(sessionId)
  }

  const persistSoon = (session: AssistantSessionState): void => {
    const id = session.sessionId
    cancelPersist(id)
    pendingWrites.set(id, { messages: session.messages, updatedAt: session.updatedAt })
    persistTimers.set(
      id,
      setTimeout(() => {
        persistTimers.delete(id)
        pendingWrites.delete(id)
        saveAssistantConversation(id, session.messages, session.updatedAt)
      }, PERSIST_DELAY)
    )
  }

  /**
   * 往某段会话上做一次函数式更新（会话不存在 = 什么都不做）。
   *
   * `persist = false` 只给草稿用：打字不该触发落盘（消息没变，写一遍纯属浪费）。
   */
  const writeSession = (
    sessionId: string,
    fn: (s: AssistantSessionState) => AssistantSessionState,
    persist = true
  ): void => {
    const state = get()
    const current = state.assistantConversations[sessionId]
    if (!current) return
    const next = fn(current)
    set({
      assistantConversations: { ...state.assistantConversations, [sessionId]: next }
    })
    if (persist) persistSoon(next)
  }

  /** 池子里最近更新的一段（新建 / 删除之后落到哪里） */
  const mostRecentId = (): string | null => {
    const all = Object.values(get().assistantConversations)
    if (all.length === 0) return null
    return all.sort((a, b) => b.updatedAt - a.updatedAt)[0].sessionId
  }

  /** 建一段空会话并把它设为当前，返回 id（不落盘：空会话没有存的价值） */
  const createSession = (): string => {
    const fresh = emptySession()
    set((state) => ({
      assistantConversations: { ...state.assistantConversations, [fresh.sessionId]: fresh },
      assistantActiveId: fresh.sessionId
    }))
    saveAssistantActiveId(fresh.sessionId)
    return fresh.sessionId
  }

  /**
   * 停掉某段会话正在跑的那一轮（`deleteAssistantSession` 也走它）。
   *
   * ⚠️ **先让服务端停下 Agent 循环，再断开 HTTP**（与 `conversation.ts` 的
   * `stopConversation` 同一个顺序）。
   *
   * 顺序反了会留下一条孤儿 run：`controller.abort()` 只掐断这条 SSE（见
   * `api.streamAssistant` 的注释），服务端的 runner 照旧往下跑 —— 还在烧 token，
   * 终端作用域下**还在往用户眼前那条终端里下发命令**；那条 run 也就一直挂在
   * `activeByConversation` 里，下一次发送 `startAssistantTurn` 拿 sessionId 一查
   * 「还在回复中」，直接 409（用户报的就是这个）。
   *
   * `request.id` 为空 = `start` 帧还没到，此时按 sessionId 兜底（服务端按会话找）。
   */
  const stopSession = (sessionId: string): void => {
    const state = get().assistantConversations[sessionId]
    const request = state?.request
    if (!state || !request) return
    const api = get().getApi()
    if (api) {
      const settling = api
        .abort(request.id, sessionId)
        .then(() => undefined)
        .catch(() => undefined)
      stopSettling.set(sessionId, settling)
      void settling.then(() => {
        if (stopSettling.get(sessionId) === settling) stopSettling.delete(sessionId)
      })
    }
    request.controller.abort()
    /**
     * 本地立刻置闲（不等 fetch 的 reject 回来）：停止按钮按下去，输入框就该马上能再打字。
     * 带 sessionId 守卫 —— 这期间这段会话可能已经被删了，别写回去。
     */
    writeSession(sessionId, (s) =>
      s.sessionId === sessionId
        ? { ...s, streaming: false, request: null, pendingConfirms: [] }
        : s
    )
  }

  /**
   * 一帧 SSE → 现场状态（与 conversation.ts 的 handleFrame 同构，只保留助手用到的分支）。
   *
   * `sessionId` 是这一轮开跑时那段会话的 id：中途被删掉就不再写 —— 否则迟到的帧会往
   * 一段已经没了的会话里塞消息 / 审批卡。
   */
  const handleFrame = (sessionId: string, assistantId: string, frame: ChatStreamFrame): void => {
    const live = get().assistantConversations[sessionId]
    if (!live || live.sessionId !== sessionId) return
    if (frame.type === 'start') {
      writeSession(sessionId, (s) => ({
        ...s,
        request: s.request ? { ...s.request, id: frame.requestId } : s.request
      }))
      return
    }
    if (frame.type === 'confirm' && frame.confirm) {
      const confirm = frame.confirm
      writeSession(sessionId, (s) => ({
        ...s,
        pendingConfirms: s.pendingConfirms.some((c) => c.id === confirm.id)
          ? s.pendingConfirms
          : [...s.pendingConfirms, confirm]
      }))
      return
    }
    if (frame.type === 'confirm-resolved' && frame.confirmId) {
      writeSession(sessionId, (s) => ({
        ...s,
        pendingConfirms: s.pendingConfirms.filter((c) => c.id !== frame.confirmId)
      }))
      return
    }
    /**
     * 客户端工具调用：**就地执行**（驱动本机终端）再回填。
     * 与 confirm 同一类反向通道 —— 不阻塞这一帧的处理（执行是异步的，回填走另开的
     * HTTP），但必须在帧到达时就派出去，否则服务端那条 await 只能等超时。
     */
    if (frame.type === 'client-tool-call') {
      const api = get().getApi()
      if (api) void handleClientToolCall(frame, api)
      return
    }
    if (frame.type === 'end') return
    if (frame.type !== 'event' || !frame.event) return
    const event = frame.event
    // 项目管理工具的 UI 动作（打开项目 / 高亮新建）：广播给页面
    for (const action of uiActionsFromEvent(event)) dispatchProjectUiAction(action)
    writeSession(sessionId, (s) => ({
      ...s,
      updatedAt: Date.now(),
      messages: s.messages.map((message) =>
        message.id === assistantId ? { ...message, parts: applyEvent(message.parts, event) } : message
      )
    }))
  }

  return {
    assistantConversations: initial.conversations,
    assistantActiveId: initial.activeId,

    ensureAssistantSession: () => {
      const state = get()
      const active = state.assistantActiveId
      if (active && state.assistantConversations[active]) return active
      // 当前指针丢了（首次打开 / 那段被删）：落到最近更新的一段，池子空着才新建
      const recent = mostRecentId()
      if (recent) {
        set({ assistantActiveId: recent })
        saveAssistantActiveId(recent)
        return recent
      }
      return createSession()
    },

    newAssistantSession: () => {
      /**
       * 开新会话前把**当前这段**还在跑的一轮停掉。
       *
       * 不停的话它会变成一条「看不见的」后台 run：面板已经切到新会话、没有停止按钮能点到它，
       * 而终端作用域的助手还在往用户眼前那条终端里下发命令。切走（`switchAssistantSession`）
       * 不拦 —— 那本来就是「去看看另一段，这段继续跑」，切换器里会标「进行中」。
       */
      const activeId = get().assistantActiveId
      if (activeId) stopSession(activeId)
      return createSession()
    },

    switchAssistantSession: (sessionId) => {
      const state = get()
      if (!state.assistantConversations[sessionId] || state.assistantActiveId === sessionId) return
      set({ assistantActiveId: sessionId })
      saveAssistantActiveId(sessionId)
    },

    deleteAssistantSession: (sessionId) => {
      // 正在跑的那轮先停掉，别让它继续往一段已经删掉的会话里写
      stopSession(sessionId)
      cancelPersist(sessionId)
      dropAssistantConversation(sessionId)
      set((state) => {
        const next = { ...state.assistantConversations }
        delete next[sessionId]
        return { assistantConversations: next }
      })
      if (get().assistantActiveId !== sessionId) return
      // 删的是当前这段：落到最近的一段，一段都不剩就建个空的（面板不能停在「无会话」）
      const recent = mostRecentId()
      if (recent) {
        set({ assistantActiveId: recent })
        saveAssistantActiveId(recent)
      } else {
        createSession()
      }
    },

    setAssistantDraft: (text) => {
      const activeId = get().assistantActiveId
      if (!activeId) return
      writeSession(activeId, (s) => (s.draft === text ? s : { ...s, draft: text }), false)
    },

    sendAssistant: async (text, scope, target, terminalTabKey, permissionMode) => {
      const api = get().getApi()
      if (!api) return
      // 没有当前会话就先建一个（正常路径上挂载时已经 ensure 过）
      const key = get().ensureAssistantSession()
      const current = get().assistantConversations[key]
      if (!current || current.streaming) return
      /**
       * 上一轮刚被「停止」、服务端还在收尾：等它把 run 摘干净再发。
       * 不等就会撞上 `startAssistantTurn` 的 409（那里按 sessionId 查活跃 run）。
       * 上限 4s —— 真等不到就照发，让 409 的人话出来，别把输入框按死在这里。
       */
      const settling = stopSettling.get(key)
      if (settling) {
        await Promise.race([settling, new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_WAIT_MS))])
        // 等待期间现场可能变了（被删 / 被另一条消息抢先发了）：重新取一次
        const settled = get().assistantConversations[key]
        if (!settled || settled.streaming) return
      }
      const sessionId = get().assistantConversations[key]?.sessionId
      if (!sessionId) return
      /**
       * 本地历史（不含本轮这条）—— 服务端不存历史，每轮都要带上。
       * 取的是**加占位之前**的 messages。
       */
      const history = get().assistantConversations[key]?.messages ?? []
      /** 这一轮还是「同一段会话」吗（中途被删就为 false） */
      const stillLive = (): boolean =>
        get().assistantConversations[sessionId]?.sessionId === sessionId
      const controller = new AbortController()
      const assistantId = nextLocalId('a')
      /**
       * 客户端工具（终端操作）：**只有 terminal 作用域**才取清单随请求上送。
       * 全局助手（project）走 `clientToolsFor(undefined)` → 直接返回 undefined，
       * 于是它这一轮根本没有终端工具可调。
       */
      const clientTools =
        scope === 'terminal' ? await clientToolsFor(terminalTabKey ?? null) : undefined
      writeSession(sessionId, (s) => ({
        ...s,
        streaming: true,
        request: { id: '', assistantId, controller },
        error: null,
        updatedAt: Date.now(),
        // 自己发的消息必须立刻出现在底部:bump 落底信号(与主会话同一套)
        scrollResetSeq: s.scrollResetSeq + 1,
        messages: [
          ...s.messages,
          {
            id: nextLocalId('u'),
            role: 'user',
            parts: [{ type: 'text', text }],
            createdAt: Date.now()
          },
          { id: assistantId, role: 'assistant', parts: [], createdAt: Date.now() }
        ]
      }))
      try {
        await api.streamAssistant(
          {
            sessionId,
            text,
            history,
            // 作用域：决定服务端挂哪组工具（两组互斥）
            scope,
            // 面板的模型偏好:带了就让服务端严格解析(悬空给 400 人话),不带走服务端缺省
            ...(target ? { configId: target.configId, modelId: target.modelId } : {}),
            // 客户端工具(终端操作):只有 terminal 作用域会有值
            ...(clientTools ? { clientTools } : {}),
            // 工具权限档:服务端据此给客户端工具(以及项目工具的 readonly)套闸
            ...(permissionMode ? { permissionMode } : {}),
            /**
             * 模型请求重试次数:这是**客户端偏好**(设置页),与主会话同一份。
             * 少传这一个字段,助手就会退回服务端缺省的 2 次 —— 表现为「开头重试两次,
             * 中途再失败直接报错」,与设置页填的数字无关。
             */
            maxRetries: get().maxRetries
          },
          (frame) => handleFrame(sessionId, assistantId, frame),
          controller.signal
        )
        // 收尾：历史在本地，不做服务端对账，把「正在回复」撤掉即可
        if (stillLive()) writeSession(sessionId, (s) => ({ ...s, streaming: false, request: null }))
      } catch (err) {
        // 被删掉的那一轮：错误不该记到别的会话上
        if (stillLive())
          writeSession(sessionId, (s) => ({
            ...s,
            streaming: false,
            request: null,
            /**
             * 用户点「停止」= 预期收场，不是错误：abort 会让 fetch 抛 AbortError
             * （「The operation was aborted」），照原样写进去，面板上就多一条红字，
             * 看着像「停下来出错了」。与主会话 `stopConversation` 同一口径。
             */
            error: controller.signal.aborted ? null : errorMessage(err)
          }))
      }
    },

    stopAssistant: () => {
      const activeId = get().assistantActiveId
      if (activeId) stopSession(activeId)
    },

    resendAssistantMessage: async (messageId, text, scope, target, terminalTabKey, permissionMode) => {
      const key = get().assistantActiveId
      if (!key) return false
      const current = get().assistantConversations[key]
      // 跑着不发：截断放在这里做，一旦放行就是「先删后发」——所以守卫必须在切片之前
      if (!current || current.streaming) return false
      const index = current.messages.findIndex((m) => m.id === messageId)
      if (index < 0) return false
      /**
       * 先截断再发：`sendAssistant` 每轮把**当前** messages 当 `history` 上送，
       * 截断后那份自然就是「从这条之前重来」，不需要额外的重置参数。
       */
      writeSession(key, (s) => ({ ...s, messages: s.messages.slice(0, index) }))
      /**
       * ⚠️ **不 await**：`sendAssistant` 内部等整条流跑完才 resolve，await 它会让本函数
       * 的「已发出」回包晚一整轮 —— 面板据此清草稿时，输入框会在整个回复期间一直挂着
       * 已经发出去的文本（用户报的就是这个）。发起即返回，失败由会话自己的 `error` 承载。
       */
      void get().sendAssistant(text, scope, target, terminalTabKey, permissionMode)
      return true
    },

    deleteAssistantMessage: (messageId, mode) => {
      const activeId = get().assistantActiveId
      if (!activeId) return
      writeSession(activeId, (s) => {
        const index = s.messages.findIndex((m) => m.id === messageId)
        if (index < 0) return s
        return {
          ...s,
          messages:
            mode === 'single'
              ? s.messages.filter((m) => m.id !== messageId)
              : s.messages.slice(0, index),
          updatedAt: Date.now()
        }
      })
    },

    setAssistantPermissionMode: (mode) => {
      const activeId = get().assistantActiveId
      if (!activeId) return
      const requestId = get().assistantConversations[activeId]?.request?.id
      const api = get().getApi()
      if (!requestId || !api) return
      // 幂等：run 已结束 = 空成功，静默即可
      void api.setChatPermission(requestId, mode).catch(() => undefined)
    }
  }
}
