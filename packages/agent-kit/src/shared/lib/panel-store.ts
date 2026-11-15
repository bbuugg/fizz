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
 * ## 为什么只有一份状态
 *
 * 参考实现（dogi）同时维护 `panelTabs[]` + `groups{}` + `layout` 三份数据，任何一次
 * 拖拽都要在三处各改一遍，于是逼出 `alignToTabs` / `verify` / `registerCloseHost` 一堆
 * 记账。这里只有一份 `PanelState`（`layout` + `groups` + `activeGroupId`），
 * 标签集合 = 各 `groups` 里 `tabIds` 的并集，**没有第二份「打开的标签列表」**。
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

const listeners = new Set<() => void>()

/** 空布局起步：第一个会话被打开时由 `openTab` 铺出初始单组树 */
let state: PanelState = initialState([])

/**
 * **单标签模式**（手机壳）：打开一个标签 = **把它换成当前视图**，其余标签连同它们的分组
 * 一起收起。
 *
 * 手机壳没有标签条与标签列表（见 `apps/mobile` 的 `MobileAppBar`）：即便宽到 768px 以上、
 * 露出了桌面那条标签条，里面也恒只有一颗 —— 替换语义与宽度无关。多出来的标签就是
 * **看不见也关不掉**的后台实例：每个会话标签都挂着消息列表与流式订阅，终端标签还挂着
 * PTY，在 390px 的屏上只会把内存 / 连接堆到崩溃。所以手机壳在启动时（`main.tsx`）把
 * 它打开，`openTab` / `ensureTab` / `syncTabs` 在那之后都按「替换」语义工作。
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

/** 应用一次纯函数变更（无变化时保持原引用，避免无谓重渲染） */
function update(fn: (s: PanelState) => PanelState): void {
  const next = fn(state)
  if (next === state) return
  state = next
  emit()
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
 * 某个标签现在**是不是开着**。
 *
 * 快照是**布尔**，所以只有「开 → 关 / 关 → 开」那一下才触发重渲染 —— 拖分隔条
 * （`resizeSplit` 每帧 emit）不会把订阅者带进来。这一点很重要：订阅方是
 * `AppProvider`（整个应用树的根），订阅整棵状态会变成「每帧重渲染全应用」。
 *
 * 目前唯一的订阅方是「面板现场回收」（`use-app-context.tsx`）：草稿（`draft:*`）面板的
 * 存活期必须跟**「新对话」标签**一致，而不是跟「当前会话」一致 —— 后者会让草稿面板
 * 一离开焦点就被回收，终端现场（PTY）跟着一起没。
 */
export function useIsTabOpen(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => allTabKeys(state).includes(key),
    () => false
  )
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
// 变更
// ---------------------------------------------------------------------------

/**
 * 把状态对齐到给定的标签集合（新增的进焦点组、消失的摘掉）。
 *
 * 这是**唯一**的「批量对表」入口：外部（视图切换 / 侧栏）说「现在该开这几个标签」，
 * 由它一次性算好，而不是各自零散地增删。
 *
 * ⚠️ 单标签模式下只认**最后一个** key（= 替换）：这是 `openTab` / `ensureTab` 之外
 * 唯一能一次画进多颗标签的入口，漏了它，任何「批量对表」都会绕开单标签语义、把
 * 看不见的标签重新塞回面板。
 */
export function syncTabs(keys: string[]): void {
  update((s) => alignToTabs(s, singleTab ? keys.slice(-1) : keys))
}

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
 * 打开（或切到）某个标签：已在某组里 → 只切过去；不在 → 追加进焦点组。
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
 * 用一个新 key **就地替换**某个标签（同组、同位置，激活状态跟着走）。
 *
 * ## 为什么需要它（它修的 bug）
 *
 * 「新对话」草稿标签（`__new__`）里发出第一条消息会建出真实会话，那张草稿应当**变成**
 * 会话标签。原来只有「面板上**只有**这一张草稿」时才走就地替换（`syncTabs([key])`），
 * 一旦用户还开着别的会话 / 终端标签（极常见的状态：从某条会话里点「新建对话」），
 * 就会落到 `openTab(key)` —— 于是**草稿留着 + 又冒出一张会话标签**，用户看到
 * 「发个消息怎么又开了一个对话标签」。
 *
 * ## 为什么不直接用 `syncTabs`
 *
 * `syncTabs(keys)` 是「对齐到这批 key」：传 `[newKey]` 会把面板上**其它标签全摘掉**
 * （用户开着的终端、别的会话一起没）。这里只动 `oldKey` 这一颗，其余原样保留。
 *
 * 单标签模式（手机壳）下退化成「只剩新 key」：那里本来就不允许多标签，语义不变。
 */
export function replaceTab(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return
  update((s) => {
    if (singleTab) return singleTabOnly(s, newKey)
    const gid = groupOfTab(s, oldKey)
    // 旧标签已经不在（被别的路径先摘掉了）：当作普通打开，别把新会话弄丢
    if (!gid) {
      const all = allTabKeys(s)
      const next = all.includes(newKey) ? all : [...all, newKey]
      return activateTabPure(alignToTabs(s, next), newKey)
    }
    const g = s.groups[gid]!
    const at = g.tabIds.indexOf(oldKey)
    if (at < 0) return s
    // 新 key 已经在别处开着（极少见：同一会话被别的入口先开了标签）：摘掉旧的再切过去，
    // 不能就地替换 —— 否则同一个 key 会出现在两张标签上
    if (groupOfTab(s, newKey)) {
      return activateTabPure(closeTabPure(s, oldKey), newKey)
    }
    const tabIds = [...g.tabIds]
    tabIds[at] = newKey
    const next: PanelState = {
      ...s,
      groups: {
        ...s.groups,
        [gid]: {
          ...g,
          tabIds,
          activeTabId: g.activeTabId === oldKey ? newKey : g.activeTabId
        }
      },
      // 替换发生在哪一组，焦点就跟到哪一组（用户刚在草稿里发的消息，焦点本就该在那）
      activeGroupId: gid
    }
    return activateTabPure(next, newKey)
  })
}

/**
 * 把标签补进来但**不改变焦点**（已经在里面就是空操作）。
 *
 * 与 `openTab` 的差别只有一处：要不要切过去。`PanelView` 首次挂载时用它对齐「当前会话」
 * ——面板里已经有活动标签（例如刚从「主机」侧栏开出来的主机标签）时不该被当前会话顶掉；
 * 面板还是空的（首次启动 / web 刷新）才由 `openTab` 抢焦点。
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
 * 程序性关闭（`syncTabs` 对表、`alignToTabs` 摘标签、ApiPage/WsPage 保存草稿后的
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
  // await 期间面板可能已变（标签被拖走 / 被外部对表摘掉），关之前再过滤一次
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

/** 重置成「一个组、标签按给定顺序」的初始布局（调试 / 全部收起后用） */
export function resetLayout(keys: string[] = []): void {
  update(() => initialState(keys))
}
