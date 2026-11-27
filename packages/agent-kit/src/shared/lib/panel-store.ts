"use client";

/**
 * 主区域多标签面板的**运行时状态**（模块级 + `useSyncExternalStore`）。
 *
 * ## 为什么用模块级 store 而不是 Context / zustand
 *
 * 面板状态被好几处读：`PanelView` 渲染树、`ActivityBar`/命令面板要「打开/关闭某个标签」、
 * 顶栏要读当前焦点组。这些位置分属不同的组件层级，用 Context 就得把 Provider 提到很外层
 * 并让所有中间层都重渲染；而它又**只属于主区域**、与数据层无关。所以照搬
 * `lib/sidebar-collapsed.ts` 的做法：模块级变量 + 订阅，最小且够用。
 *
 * ## 标签 key 是身份，不是地址
 *
 * 每颗标签有一个**终生不变**的 key（`panel-tabs.ts` 文件头的铁律）。对话标签指向哪条会话
 * 记在下面的**指向表**里：草稿标签发出第一条消息，只是它的指向从「没有」变成那条会话，
 * key、位置、焦点、以及所有按 key 索引的东西（落位缓存 / 刷新代号 / 关闭守卫 / 面板现场）
 * 一概不动 —— **没有任何「交接」步骤**。
 *
 * 「一条会话最多一颗标签」「草稿最多一颗」两条不变量也由指向表保证：开会话前先查表，
 * 查到就只激活。所以别再写 `openTab(会话 id)`：会话 id 不是标签 key，那样会开出一颗
 * 没有指向的标签。对话标签一律走 `openChatTab` / `openDraftTab` / `alignConversationTab`。
 *
 * ## 为什么只有一份状态
 *
 * 参考实现（dogi）同时维护 `panelTabs[]` + `groups{}` + `layout` 三份数据，任何一次
 * 拖拽都要在三处各改一遍，于是逼出 `alignToTabs` / `verify` / `registerCloseHost` 一堆
 * 记账。这里只有一份 `PanelState`（`layout` + `groups` + `activeGroupId`），
 * 标签集合 = 各 `groups` 里 `tabIds` 的并集，**没有第二份「打开的标签列表」**。
 * 指向表不是第二份列表：它的键恒等于那个并集的子集，标签一关条目就没了。
 *
 * ## 只持久化偏好
 *
 * 布局树（分屏、分组、标签归属）**不落盘**：它是「这一次拖出来的样子」，重启后应当回到
 * 干净的初始布局。宽度 / 活动栏顺序 / 侧栏折叠这些偏好另有其存储（见 `activity-state.ts`
 * 与 `lib/sidebar-collapsed.ts`）。
 *
 * 所有变更都走 `panel-groups.ts` 的纯函数，并在结构变化后自检（`verifyLayout`）——
 * 自检不过就**放弃这次更新**（保住旧树），宁可不响应一次拖拽，也不能把用户正在看的那一格弄丢。
 */
import { useSyncExternalStore } from 'react'
import {
  activateTab as activateTabPure,
  alignToTabs,
  closeTab as closeTabPure,
  groupOfTab,
  initialState,
  moveGroupToGroup,
  moveTabToGroup,
  reorderInGroup,
  splitTabToGroup,
  type PanelState
} from '@fizz/agent-kit/shared/lib/panel-groups'
import { updateSizes, type PaneNode, type SplitDirectionInput } from '@fizz/agent-kit/shared/lib/pane-layout'
import { askTabCloseGuards } from '@fizz/agent-kit/shared/lib/tab-close'
import { chatTabKey } from './panel-tabs'

const listeners = new Set<() => void>()

/** 空布局起步：第一个标签被打开时由 `openTab` 铺出初始单组树 */
let state: PanelState = initialState([])

/**
 * **单标签模式**（手机壳）：打开一个标签 = **把它换成当前视图**，其余标签连同它们的分组
 * 一起收起。
 *
 * 手机壳没有标签条与标签列表（见 `apps/mobile` 的 `MobileAppBar`）：即便宽到 768px 以上、
 * 露出了桌面那条标签条，里面也恒只有一颗 —— 替换语义与宽度无关。多出来的标签就是
 * **看不见也关不掉**的后台实例：每个会话标签都挂着消息列表与流式订阅，终端标签还挂着
 * PTY，在 390px 的屏上只会把内存 / 连接堆到崩溃。所以手机壳在启动时（`main.tsx`）把
 * 它打开，`openTab` / `ensureTab` 在那之后都按「替换」语义工作。
 *
 * 为什么是模块级开关而不是参数：这份 store **每个 app 各打包一份**，所以它表达的是
 * 「这个端的形态」而不是共享行为；web / desktop 永远不调它，行为逐行不变。
 */
let singleTab = false

/** 打开 / 关闭单标签模式（只应由手机壳在启动时调一次） */
export function setSingleTabMode(on: boolean): void {
  singleTab = on
}

function emit(): void {
  for (const listener of listeners) listener()
}

// ---------------------------------------------------------------------------
// 对话标签的指向表
// ---------------------------------------------------------------------------

/**
 * 对话标签 key → 它现在是哪条会话。`null` = 还是「新对话」草稿（没发过消息）。
 * 工具标签不在这张表里。
 *
 * 这张表是「草稿 → 会话」唯一的落点：改一个条目就完事。早先的做法是把标签 key 从 `__new__`
 * 改写成会话 id，于是按 key 索引的每张表都得跟着搬家，漏了落位缓存就是用户报的
 * 「发个消息，右侧面板整个重建」。
 */
const chatTargets = new Map<string, string | null>()

let chatSeq = 0

/**
 * 「开着哪些标签」这一集合的版本号。
 *
 * 给 `AppProvider` 的面板现场回收用：它要知道「哪颗标签关了」，但**不能**订阅整棵状态
 * —— 拖分隔条每帧都 emit，会把应用树每帧重渲染一遍。这里只在标签集合真的变了
 * （开 / 关 / 替换）时才 +1，快照是个数字，其余的 emit 对订阅方不可见。
 */
let tabsVersion = 0
let openKeys: string[] = []

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

/** 当前开着的全部标签 key（稳定引用：集合没变就是同一个数组） */
export function openTabKeys(): readonly string[] {
  return openKeys
}

/** 订阅「标签集合变了」（只在开 / 关标签那一下触发重渲染） */
export function useOpenTabsVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => tabsVersion,
    () => 0
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getPanelState(): PanelState {
  return state
}

/** 订阅整棵面板状态（`PanelView` 渲染树用） */
export function usePanelState(): PanelState {
  return useSyncExternalStore(subscribe, getPanelState, getPanelState)
}

/**
 * 这条会话的标签 key（没开着 = `null`）。订阅版：标签开 / 关那一下才重渲染。
 *
 * ⚠️ 面向 `AppProvider`（应用树的根）的订阅都只能是**原始值快照**（字符串 / 数字 /
 * 布尔）：拖分隔条时 `resizeSplit` 每帧都 emit，快照不是稳定原始值就会变成
 * 「每帧重渲染全应用」。
 */
export function useTabOfConversation(conversationId: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => tabOfConversation(conversationId),
    () => null
  )
}

/** 「新对话」草稿标签的 key（没开着 = `null`），订阅版，口径同 `useTabOfConversation` */
export function useDraftTabKey(): string | null {
  return useSyncExternalStore(subscribe, draftTabKey, () => null)
}

/**
 * 一颗对话标签指向的会话（订阅版，返回值口径同 `conversationOfTab`）：草稿变成会话的
 * 那一刻，读了它的组件自动重渲染，不必依赖上层恰好也重渲染。
 */
export function useTabConversation(key: string): string | null | undefined {
  return useSyncExternalStore(subscribe, () => conversationOfTab(key), () => undefined)
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 当前打开的**全部**标签 key（各组的并集，按组的先后 + 组内顺序） */
export function allTabKeys(s: PanelState = state): string[] {
  const out: string[] = []
  for (const g of Object.values(s.groups)) out.push(...g.tabIds)
  return out
}

/** 某组里的标签 key */
export function tabKeysOfGroup(s: PanelState, groupId: string): string[] {
  return s.groups[groupId]?.tabIds ?? []
}

/**
 * 每个打开的标签 → 它所属的组 + 是不是该组当前显示的那一个。
 *
 * 内容层（`PanelContentLayer`）要把「标签内容」摆到对应组的车身上，需要一份
 * 「标签 → 组」的映射。这份映射只能从 `groups` 推出来（没有第二份数据），
 * 所以在这里算一次，而不是让渲染层自己遍历 `groups`。
 */
export function tabOwners(
  s: PanelState = state
): Map<string, { groupId: string; active: boolean }> {
  const out = new Map<string, { groupId: string; active: boolean }>()
  for (const [groupId, group] of Object.entries(s.groups)) {
    for (const key of group.tabIds) out.set(key, { groupId, active: key === group.activeTabId })
  }
  return out
}

/**
 * 焦点组当前显示的标签 key（null = 该组没有标签）。
 * 主区域用它与 `activeConversationId` 对表。
 */
export function activeTabKey(s: PanelState = state): string | null {
  return s.groups[s.activeGroupId]?.activeTabId ?? null
}

/** 一颗对话标签指向的会话：`null` = 还是草稿；`undefined` = 不是对话标签 */
export function conversationOfTab(key: string): string | null | undefined {
  return chatTargets.get(key)
}

/** 某条会话开着的那颗标签（没开着 = `null`）。一条会话最多一颗，由这里保证 */
export function tabOfConversation(conversationId: string | null): string | null {
  if (!conversationId) return null
  for (const [key, target] of chatTargets) {
    if (target === conversationId) return key
  }
  return null
}

/** 开着的那颗「新对话」草稿标签（没开着 = `null`）。草稿最多一颗，由这里保证 */
export function draftTabKey(): string | null {
  for (const [key, target] of chatTargets) {
    if (target === null) return key
  }
  return null
}

/** 这个标签是不是「新对话」草稿（是草稿 = 是对话标签，且还没指向任何会话） */
export function isDraftTab(key: string): boolean {
  return chatTargets.get(key) === null
}

/**
 * 指向**已不存在 / 已归档**会话的对话标签（`PanelView` 据此把它们裸关）。
 * 草稿与工具标签不在此列。
 */
export function staleConversationTabs(alive: ReadonlySet<string>): string[] {
  return allTabKeys().filter((key) => {
    const target = chatTargets.get(key)
    return typeof target === 'string' && !alive.has(target)
  })
}

/**
 * 在**当前焦点组**里切到相邻标签（`delta=1` 向右，`-1` 向左），到头回绕。
 *
 * 只转动焦点组：分组布局由用户拖出来，切标签不该把焦点带到别的组。
 * 单标签模式（手机壳）组里只有一颗，直接空操作。
 */
export function cycleTab(delta: 1 | -1): void {
  update((s) => {
    const group = s.groups[s.activeGroupId]
    if (!group || group.tabIds.length < 2) return s
    const active = group.activeTabId
    if (!active) return s
    const at = group.tabIds.indexOf(active)
    if (at < 0) return s
    const next = group.tabIds[(at + delta + group.tabIds.length) % group.tabIds.length]
    return next === active ? s : activateTabPure(s, next)
  })
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

/** 提交一次已经算好的状态（无变化时什么也不做），并顺手回收已关闭标签的指向 */
function apply(next: PanelState): void {
  if (next === state) return
  state = next
  const keys = allTabKeys(state)
  if (!sameKeys(openKeys, keys)) {
    openKeys = keys
    tabsVersion += 1
  }
  pruneChatTargets()
  emit()
}

/** 应用一次纯函数变更（无变化时保持原引用，避免无谓重渲染） */
function update(fn: (s: PanelState) => PanelState): void {
  apply(fn(state))
}

/**
 * 指向变了（草稿变成会话）：布局 / 分组一个字段都没动，但**读 `usePanelState` 的渲染方
 * 必须重渲染** —— 标签名、标签内容（`ConversationTab` 的 `conversationId`）、容器门都从
 * 指向表取值。所以换一个状态引用再通知：对订阅方来说就是「面板变了」，与别的变更同一条路。
 */
function touchState(): void {
  state = { ...state }
  emit()
}

function pruneChatTargets(): void {
  if (chatTargets.size === 0) return
  const open = new Set(allTabKeys(state))
  for (const key of [...chatTargets.keys()]) {
    if (!open.has(key)) chatTargets.delete(key)
  }
}

// ---------------------------------------------------------------------------
// 变更：开标签
// ---------------------------------------------------------------------------

/**
 * 单标签模式下「打开它」= 「只剩它」。
 *
 * 走 `alignToTabs` 而不是 `closeTab` 循环：它一次算完（`verifyLayout` 只跑一次），
 * 被摘空的组连同它的格子一起收起，不会留下孤儿组占位。
 */
function singleTabOnly(s: PanelState, key: string): PanelState {
  return activateTabPure(alignToTabs(s, [key]), key)
}

/**
 * 打开（或切到）某个**工具**标签：已在某组里 → 只切过去；不在 → 追加进焦点组。
 *
 * ⚠️ 对话标签别走这里（要查指向表去重），走 `openChatTab` / `openDraftTab`。
 *
 * 「打开」不改变标签归属 —— 已在别的组里的标签不会被搬走（用户在那边分屏看的布局
 * 不该被一次点击打乱）。**例外是单标签模式**（手机壳，见 `setSingleTabMode`）：
 * 那里「打开」= 「替换」，历史标签直接收起。
 *
 * ⚠️ 单标签模式的替换**不走关闭守卫**（`requestCloseTabs`）：守卫是「用户在多标签里
 * 主动关掉一个」的交互（「终端还在跑，确定关吗」），而手机上用户只是「切到另一个会话」
 * —— 弹窗挡在导航上反而奇怪，行为上与手机应用切页一致。
 */
export function openTab(key: string): void {
  update((s) => {
    if (singleTab) return singleTabOnly(s, key)
    const all = allTabKeys(s)
    const next = all.includes(key) ? all : [...all, key]
    return activateTabPure(alignToTabs(s, next), key)
  })
}

/**
 * 把标签补进来但**不改变焦点**（已经在里面就是空操作）。
 *
 * 与 `openTab` 的差别只有一处：要不要切过去。面板里已经有活动标签（例如刚从「主机」
 * 侧栏开出来的主机标签）时不该被当前会话顶掉。
 *
 * ⚠️ 单标签模式下它退化成 `openTab`（只剩这一个并切过去）：面板里只允许有一个标签，
 * 若此时已被别的标签占住，保留两个就回到了「看不见也关不掉的隐藏标签」那个坑。
 */
export function ensureTab(key: string): void {
  update((s) => {
    if (singleTab) return singleTabOnly(s, key)
    const all = allTabKeys(s)
    return all.includes(key) ? s : alignToTabs(s, [...all, key])
  })
}

/** 新建一颗对话标签（指向表先写好，再进面板：首帧渲染时它已经知道自己是谁） */
function addChatTab(target: string | null, focus: boolean): string {
  const key = chatTabKey(++chatSeq)
  chatTargets.set(key, target)
  if (focus) openTab(key)
  else ensureTab(key)
  return key
}

/**
 * 打开（或切到）某条会话的标签。这条会话已经有标签 → 只切过去；没有 → 新开一颗。
 *
 * 这里**不**管草稿：从侧栏 / 通知 / 深链打开一条会话，草稿标签原样留着。草稿「变成」
 * 会话只有一条路 —— 在草稿里发第一条消息，并由发起请求的标签身份认领。
 */
export function openChatTab(conversationId: string): string {
  const existing = tabOfConversation(conversationId)
  if (existing) {
    openTab(existing)
    return existing
  }
  return addChatTab(conversationId, true)
}

/**
 * 打开「新对话」草稿标签（显式新建 / 零标签兜底）。已经有一颗草稿 → 只切过去。
 *
 * 草稿是全局单例：两颗草稿看起来一模一样，却各有一份面板现场，用户分不清哪颗开着终端。
 */
export function openDraftTab(): string {
  const existing = draftTabKey()
  if (existing) {
    openTab(existing)
    return existing
  }
  return addChatTab(null, true)
}

/**
 * 把草稿标签**指向**一条会话：这颗草稿从此就是这条会话的标签。
 *
 * 只改指向表里的一个值 —— key、位置、焦点、落位缓存、刷新代号、关闭守卫、面板现场
 * 全都不动，所以 `ConversationTab` 不重挂，右侧面板里的终端 PTY 活着。
 *
 * 三种结果：`bound` = 指过去了；`already-open` = 这条会话已经有标签，草稿不动；
 * `no-draft` = 没有草稿可指。
 */
export function bindDraftTab(
  conversationId: string,
  expectedDraftKey?: string
): 'bound' | 'already-open' | 'no-draft' {
  if (tabOfConversation(conversationId)) return 'already-open'
  const draft = expectedDraftKey ?? draftTabKey()
  if (!draft || conversationOfTab(draft) !== null) return 'no-draft'
  chatTargets.set(draft, conversationId)
  touchState()
  return 'bound'
}

/**
 * 「当前会话变成了 `conversationId`」之后，标签该怎么对齐（`PanelView` 的同步 effect 用，
 * web / desktop / 手机壳同一条）。
 *
 * - 会话已经有标签 → 什么都不做；
 * - `draftTabKey`（会话是**从这颗草稿标签**发消息建出来的）→ 只有这颗仍开着的草稿
 *   可认领（`bindDraftTab`）。建会话是异步的（ACP 要起进程），用户可能关闭原草稿并打开
 *   新草稿；不能把新草稿误绑定给旧请求；
 * - 草稿正被看着（启动恢复：先补的草稿，恢复到位后当前会话才到）→ 也由草稿接下，
 *   否则会并排多出一张「新对话」；
 * - 其余 → 正常开一颗（`focus: false` = 只补进来、不抢焦点，首次挂载时用）。
 *
 * ⚠️ 「草稿正被看着」这一条**不能**放宽成「面板上有草稿」：删掉当前会话时 store 会把
 * 当前会话切到邻居，那一刻要是把**后台**那张草稿指过去，草稿里的终端现场就凭空变成
 * 邻居会话的了。
 */
export function alignConversationTab(
  conversationId: string,
  opts: { draftHandoff?: { tabKey: string | null } | null; focus?: boolean }
): void {
  if (tabOfConversation(conversationId)) return
  if (opts.draftHandoff) {
    const sourceTab = opts.draftHandoff.tabKey
    if (sourceTab && bindDraftTab(conversationId, sourceTab) === 'bound') return
    // 创建源标签已关闭 / 不再是草稿：不要把新草稿认领给旧请求。
    // 若当前没有可见标签则显示新会话，否则后台补入而不抢用户焦点。
    addChatTab(conversationId, activeTabKey() === null)
    return
  }
  const draft = draftTabKey()
  if (draft && activeTabKey() === draft) {
    bindDraftTab(conversationId)
    return
  }
  // `focus: false` = 只补进来、不抢焦点（首次挂载时用）
  addChatTab(conversationId, opts.focus !== false)
}

// ---------------------------------------------------------------------------
// 变更：关标签
// ---------------------------------------------------------------------------

/**
 * 关掉某个标签。
 *
 * 组里还有别的标签 → 走 `closeTab` 的纯函数（正看着它就切到相邻的一个）；
 * 组里只剩它一个 → 整树对齐到「没有它」，保留一个空组占位（主区域显示空态，
 * 而不是把布局树弄成 `null`）。
 */
export function closeTab(key: string): void {
  update((s) => {
    const gid = groupOfTab(s, key)
    if (!gid) return s
    if (s.groups[gid].tabIds.length === 1) {
      return alignToTabs(
        s,
        allTabKeys(s).filter((k) => k !== key)
      )
    }
    return closeTabPure(s, key)
  })
}

/**
 * 一次关掉一批标签（标签右键菜单里的「关闭其他 / 左侧 / 右侧 / 整个组」）。
 *
 * 走 `alignToTabs` 一次算完，而不是循环调 `closeTab`：后者每关一个都重算一遍布局树，
 * 中间态（某组刚好被摘空）还会触发多次 `verifyLayout`；批量对齐只有一次结构变更。
 */
export function closeTabs(keys: string[]): void {
  if (keys.length === 0) return
  update((s) => {
    const all = allTabKeys(s)
    const drop = new Set(keys)
    const rest = all.filter((k) => !drop.has(k))
    return rest.length === all.length ? s : alignToTabs(s, rest)
  })
}

/** 关掉整个组（连同它的格子）—— 右键菜单里的「关闭整个组」 */
export function closeGroup(groupId: string): void {
  const group = getPanelState().groups[groupId]
  if (!group) return
  closeTabs(group.tabIds)
}

// ---------------------------------------------------------------------------
// 「用户主动关闭」：先问标签守卫，再关
// ---------------------------------------------------------------------------

/** 过滤出**当前确实开着**的键（保序去重） */
function existingTabKeys(keys: readonly string[]): string[] {
  const open = new Set(allTabKeys())
  const out: string[] = []
  for (const k of keys) {
    if (open.has(k) && !out.includes(k)) out.push(k)
  }
  return out
}

/**
 * 用户主动关一批标签（标签 × / 右键各关闭项 / 关闭整个组）的**统一入口**。
 *
 * 与上面的裸关闭原语（`closeTab` / `closeTabs` / `closeGroup`）的分工：这里只在
 * 「用户自己点了关闭」时用 —— 它会先**逐个问标签登记的守卫**（`askTabCloseGuards`），
 * 守卫可以直接放行、也可以弹确认 / 先做异步收尾（停会话）再答复，只关掉放行的那些。
 *
 * 程序性关闭（会话被删后的 `closeTabs`、ApiPage/WsPage 保存草稿后的
 * `closeTab(apiTabKey(NEW_*))`）继续走裸关闭，**不弹任何窗**（见 `tab-close.ts` 纪律 1）。
 *
 * 返回「是否真的关掉了至少一个标签」——调用方据此决定要不要同步「当前会话」
 * （用户取消时绝不能动当前会话）。
 */
export async function requestCloseTabs(keys: string[]): Promise<boolean> {
  const existing = existingTabKeys(keys)
  if (existing.length === 0) return false
  const approved = await askTabCloseGuards(existing)
  if (approved.length === 0) return false
  // await 期间面板可能已变（标签被拖走 / 被外部摘掉），关之前再过滤一次
  const stillOpen = existingTabKeys(approved)
  if (stillOpen.length === 0) return false
  if (stillOpen.length === 1) closeTab(stillOpen[0])
  else closeTabs(stillOpen)
  return true
}

/** 用户主动关一个标签（等价于 `closeTab`，但先过守卫） */
export function requestCloseTab(key: string): Promise<boolean> {
  return requestCloseTabs([key])
}

/** 用户主动关掉整组（等价于 `closeGroup`，但先过每个标签的守卫） */
export function requestCloseGroup(groupId: string): Promise<boolean> {
  const group = getPanelState().groups[groupId]
  if (!group) return Promise.resolve(false)
  return requestCloseTabs(group.tabIds)
}

/** 切到某组里的某个标签，并把这组设为焦点组 */
export function activateTab(key: string): void {
  update((s) => activateTabPure(s, key))
}

/** 把某组设为焦点组（点组内空白 / 内容区时用） */
export function setActiveGroup(groupId: string): void {
  update((s) => (s.activeGroupId === groupId ? s : { ...s, activeGroupId: groupId }))
}

/** 组内重排：把标签挪到组内 `toIndex` */
export function reorderTab(groupId: string, tabId: string, toIndex: number): void {
  update((s) => reorderInGroup(s, groupId, tabId, toIndex))
}

/** 跨组移动标签（不传 index = 追加到组尾）；源组被摘空时连同它的格子一起收起 */
export function moveTab(tabId: string, targetGroupId: string, index?: number): void {
  update((s) => moveTabToGroup(s, tabId, targetGroupId, index))
}

/** 把标签拆到目标组旁边新开一格（拖到组边缘 / 右键「拆分」） */
export function splitTab(tabId: string, targetGroupId: string, direction: SplitDirectionInput): void {
  update((s) => splitTabToGroup(s, tabId, targetGroupId, direction))
}

/** 把整组搬到目标组旁边（拖组头 / 拖组内空白）：并入（center）或新切一格 */
export function moveGroup(
  groupId: string,
  targetGroupId: string,
  direction: SplitDirectionInput | 'center'
): void {
  update((s) => moveGroupToGroup(s, groupId, targetGroupId, direction))
}

/** 拖动分隔条：更新某个分隔节点的弹性权重 */
export function resizeSplit(splitId: string, sizes: number[]): void {
  update((s) => {
    const layout: PaneNode = updateSizes(s.layout, splitId, sizes)
    return layout === s.layout ? s : { ...s, layout }
  })
}

/**
 * 重置成「一个组、标签按给定顺序」的初始布局（调试 / 全部收起后用）。
 * 对话标签的指向一并清空 —— 重置之后没有哪颗标签知道自己指向谁。
 */
export function resetLayout(keys: string[] = []): void {
  chatTargets.clear()
  update(() => initialState(keys))
}
