/**
 * AI 助手会话的本地存档（localStorage）。
 *
 * ## 为什么是「一个池子」而不是「每个面板一格」
 *
 * 从前按 `panelKey` 存（全局面板 `'global'` + 每个终端标签各一格），结果是：
 * 在终端助手里聊的和在项目助手里聊的是两个**互不相干**的抽屉，谁也看不到谁；而且终端标签
 * 那格因为 key 是**本次运行内的序号**（重启后 `local:3` 会分给另一条终端）压根不敢落盘。
 *
 * 现在存的是一个**会话池**：`{ activeId, conversations }`。会话 id 就是 `sessionId`
 * （客户端生成的 run 注册表键，服务端不认识它），任何助手面板都能打开池子里的任何一段 ——
 * 「保存下来 + 助手间共享 + 支持切换」这三件事就是这一份数据撑起来的。
 *
 * ## 存什么、不存什么
 *
 * - 存 `sessionId` / `messages` / `updatedAt`：前两个是这段对话本身，`updatedAt` 只用于
 *   排序与「丢最老的」。
 * - **不存** `draft` / `streaming` / `pendingConfirms` / `request`：前两个是输入框与运行时
 *   状态，后两个的审批卡刷新后已经没有对应的 run 了（答复回去只会 404）。
 *
 * ## 上限（localStorage 只有 ~5MB，且是**同步**写）
 *
 * - 每份只留最后 {@link MAX_MESSAGES} 条消息；
 * - 最多留 {@link MAX_CONVERSATIONS} 段（按更新时间丢最老的）；
 * - 整份 JSON 超过 {@link MAX_CHARS} 就先丢老会话、再对半砍最新那份的消息。
 * 任何一步失败（配额满 / 隐私模式禁用 storage）都只静默放弃落盘 —— 内存里的现场不受影响。
 */
import type { AgentChatMessage, AssistantRemoteTarget } from '@fizz/contracts/agent-api'

/** v2：会话池。v1 是「按 panelKey 一格」的旧结构，读到时自动迁移 */
const STORAGE_KEY = 'fizz.agent.assistant.conversations.v2'
const LEGACY_KEY = 'fizz.agent.assistant.history.v1'
/** 每段会话最多留多少条消息（一轮问答 = 2 条） */
const MAX_MESSAGES = 60
/** 最多留几段会话 */
const MAX_CONVERSATIONS = 20
/** 整份 JSON 的字符上限（≈ 400KB，给 localStorage 留足余量） */
const MAX_CHARS = 400_000

/** 一段会话的存档（`sessionId` 既是键，也是 run 注册表的键） */
export interface AssistantConversationRecord {
  sessionId: string
  messages: AgentChatMessage[]
  /** 最后写入时间：排序 + 「丢最老的」用 */
  updatedAt: number
  /** 显式绑定的远端目标，随会话保存；旧存档没有此字段，首次发送时绑定。 */
  remoteTarget?: AssistantRemoteTarget
}

export interface AssistantStore {
  /** 当前在看的会话（所有助手面板共用；null = 还没有任何会话） */
  activeId: string | null
  /** 会话 id → 存档 */
  conversations: Record<string, AssistantConversationRecord>
}

const emptyStore = (): AssistantStore => ({ activeId: null, conversations: {} })

function normalize(entry: unknown): AssistantConversationRecord | null {
  if (!entry || typeof entry !== 'object') return null
  const rec = entry as Partial<AssistantConversationRecord>
  if (typeof rec.sessionId !== 'string' || !rec.sessionId) return null
  if (!Array.isArray(rec.messages)) return null
  return {
    sessionId: rec.sessionId,
    messages: rec.messages as AgentChatMessage[],
    updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
    ...(rec.remoteTarget && typeof rec.remoteTarget.hostId === 'string' && rec.remoteTarget.hostId &&
      (rec.remoteTarget.cwd === undefined || typeof rec.remoteTarget.cwd === 'string')
      ? { remoteTarget: { hostId: rec.remoteTarget.hostId, ...(rec.remoteTarget.cwd ? { cwd: rec.remoteTarget.cwd } : {}) } }
      : {})
  }
}

/**
 * 读 v1（`Record<panelKey, {sessionId, messages, updatedAt}>`）并转成会话池。
 *
 * 迁移规则：同一个 `sessionId` 出现在多格时留更新时间较新的那份；当前会话优先取
 * `global` 那格（它才是用户真正在用的），没有就取最近的一段。迁移成功后把 v1 删掉 ——
 * 留着只会让下次读又走一遍这段逻辑。
 */
function migrateLegacy(): AssistantStore {
  const store = emptyStore()
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LEGACY_KEY)
  } catch {
    return store
  }
  if (!raw) return store
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return store
    let globalId: string | null = null
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = normalize(value)
      if (!rec || rec.messages.length === 0) continue
      const prev = store.conversations[rec.sessionId]
      if (!prev || prev.updatedAt < rec.updatedAt) store.conversations[rec.sessionId] = rec
      if (key === 'global') globalId = rec.sessionId
    }
    const ids = Object.keys(store.conversations)
    store.activeId =
      globalId ??
      ids.sort((a, b) => store.conversations[b].updatedAt - store.conversations[a].updatedAt)[0] ??
      null
  } catch {
    return emptyStore()
  }
  /**
   * ⚠️ 顺序：**先写 v2、再删 v1**，而且只有 v2 真的写进去了才删。反过来的话，写 v2 失败
   * （配额满 / 隐私模式）时用户的历史就被永久删掉了 —— 旧结构留着不碍事，下次读还会再走
   * 一遍这段迁移（幂等）。
   */
  if (writeStore(store, store.activeId ?? undefined)) {
    try {
      localStorage.removeItem(LEGACY_KEY)
    } catch {
      // 删不掉就留着，下次读再迁一遍即可
    }
  }
  return store
}

/** 读出整份存档（坏数据整份丢弃：宁可空，也不要拿半个对象去渲染消息列） */
export function loadAssistantStore(): AssistantStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return migrateLegacy()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyStore()
    const shape = parsed as Partial<AssistantStore>
    const store = emptyStore()
    if (shape.conversations && typeof shape.conversations === 'object') {
      for (const [id, value] of Object.entries(shape.conversations as Record<string, unknown>)) {
        const rec = normalize(value)
        // 键与内部 sessionId 不一致的那条直接丢：拿它当 run 键会把两段会话搅在一起
        if (rec && rec.sessionId === id) store.conversations[id] = rec
      }
    }
    /**
     * `activeId` 原样带出，**这里不校验它指向的会话在不在** —— 刚新建、还没说话的那段
     * 本来就不在存档里（空消息 = 不写），校验会把指针抹掉，下一句写进来时反而丢当前会话。
     * 悬空指针由读的人处理（切片的 `hydrate` 会退回最近一段）。
     */
    store.activeId = typeof shape.activeId === 'string' ? shape.activeId : null
    return store
  } catch {
    return emptyStore()
  }
}

/** 写回整份存档（内部统一套上限）。返回 false = 没写进去（配额满 / storage 被禁 / 单段就超上限） */
function writeStore(store: AssistantStore, keepId?: string): boolean {
  try {
    // 份数上限：按更新时间从老到新丢，`keepId`（刚写的那段）永远保留
    const ids = Object.keys(store.conversations)
    if (ids.length > MAX_CONVERSATIONS) {
      ids
        .filter((id) => id !== keepId)
        .sort((a, b) => store.conversations[a].updatedAt - store.conversations[b].updatedAt)
        .slice(0, ids.length - MAX_CONVERSATIONS)
        .forEach((id) => {
          delete store.conversations[id]
        })
      if (store.activeId && !store.conversations[store.activeId]) store.activeId = keepId ?? null
    }

    let json = JSON.stringify(store)
    if (json.length > MAX_CHARS) {
      // 先丢**别的**会话（刚写的这段是用户正在看的，最后才动）
      for (const id of Object.keys(store.conversations).sort(
        (a, b) => store.conversations[a].updatedAt - store.conversations[b].updatedAt
      )) {
        if (json.length <= MAX_CHARS) break
        if (id === keepId) continue
        delete store.conversations[id]
        json = JSON.stringify(store)
      }
      // 还超就砍自己：保留后半段（最近的消息），一次砍一半
      const own = keepId ? store.conversations[keepId] : undefined
      while (own && own.messages.length > 1 && json.length > MAX_CHARS) {
        own.messages = own.messages.slice(Math.ceil(own.messages.length / 2))
        json = JSON.stringify(store)
      }
    }
    // 单段就超上限（一段超长工具输出）：宁可不落盘，也不要写爆配额把别的会话一起挤掉
    if (json.length > MAX_CHARS) return false

    if (Object.keys(store.conversations).length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, json)
    return true
  } catch {
    // 配额满 / storage 被禁：只保留内存里的现场（与其他客户端偏好一致）
    return false
  }
}

/**
 * 写一段会话。
 *
 * `messages` 为空 = **删掉**这一段（删会话 / 新建后还没说话），不写一个空壳进去 ——
 * 否则刷新后又「恢复」出一段空会话，还会占着 {@link MAX_CONVERSATIONS} 的名额。
 */
export function saveAssistantConversation(
  sessionId: string,
  messages: AgentChatMessage[],
  updatedAt: number,
  remoteTarget?: AssistantRemoteTarget
): void {
  const store = loadAssistantStore()
  if (messages.length === 0) delete store.conversations[sessionId]
  else
    store.conversations[sessionId] = {
      sessionId,
      messages: messages.slice(-MAX_MESSAGES),
      updatedAt,
      ...(remoteTarget ? { remoteTarget } : {})
    }
  if (store.activeId === sessionId && !store.conversations[sessionId]) store.activeId = null
  writeStore(store, sessionId)
}

/**
 * 记下「当前在看哪一段」（切会话 / 新建时写；刷新后接着看同一段）。
 *
 * 不校验这个 id 在不在存档里：刚新建、还没说话的那段本来就没落盘（空消息 = 不写），
 * 而空会话丢了也无所谓 —— 读的时候 `loadAssistantStore` 会把悬空的 activeId 归零。
 */
export function saveAssistantActiveId(activeId: string | null): void {
  const store = loadAssistantStore()
  if (store.activeId === activeId) return
  store.activeId = activeId
  writeStore(store)
}

/** 丢掉一段会话的存档 */
export function dropAssistantConversation(sessionId: string): void {
  const store = loadAssistantStore()
  if (!(sessionId in store.conversations) && store.activeId !== sessionId) return
  delete store.conversations[sessionId]
  if (store.activeId === sessionId) store.activeId = null
  writeStore(store)
}

/**
 * 会话标题（切换器 / 标签上显示的那一行）：**取第一条用户消息**的首行，截断到
 * {@link TITLE_CHARS}。没有用户消息 = 新会话 —— 不另存标题字段，改了消息标题自然跟着变。
 */
const TITLE_CHARS = 24

export function assistantConversationTitle(messages: AgentChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS)}…` : text
  }
  return '新会话'
}
