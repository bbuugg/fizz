"use client";

/**
 * 主区域的多标签面板：**可拖拽 / 分离 / 分组**（类 VS Code 的编辑器区）。
 *
 * ## 状态从哪来
 *
 * 布局与分组状态全在 `panel-store.ts`（模块级 + `useSyncExternalStore`），本文件只**读**
 * 它、把用户手势翻译成 store 的调用。组件里**不手改布局树** —— 所有结构变更都走
 * `lib/panel-groups.ts` 的纯函数（它们自带 `verifyLayout` 自检）。
 *
 * ## 三个概念的分工（这是与参考实现最本质的区别）
 *
 * - `layout`（`lib/pane-layout.ts`）：**纯几何**。一棵 N 叉树，叶子只记 `groupId`，
 *   分隔节点按 `sizes` 权重排布子节点。它回答「哪一块在哪、多大」，**不回答**「哪一块里有谁」。
 * - `groups`（`lib/panel-groups.ts`）：**内容归属**。`Record<groupId, {tabIds, activeTabId}>`。
 * - 标签集合 = 各 `groups` 里 `tabIds` 的并集。**没有第二份「打开的标签列表」**。
 *
 * 参考实现（dogi）把这三样拆成 `panelTabs[]` + `groups{}` + `layout` 三份数据，每次拖拽
 * 都要在三处各改一遍，于是逼出一堆记账（`leafId` 命中判定、`splitOff` 单列入口、`verify`
 * 安全网、`registerCloseHost` 确认总线）。这里只有一份状态，纯函数负责不变量。
 *
 * ## 拖拽落区（照搬 dogi 的模型，见 `lib/dnd-context.ts`）
 *
 * - **标签条上**：按指针在目标标签上的水平相对位置分三档 —— 两侧各 25% = 插到它前 / 后，
 *   中间 50% = 并入它所属的组。
 * - **组车身**：按指针在整组矩形里的相对位置分五档 —— 四边各 1/4 = 向那一侧分屏，
 *   中间 = 并入该组。
 *
 * ## 标签 key 是身份，不是地址
 *
 * 每颗标签的 key 终生不变（`panel-tabs.ts` 的铁律）。对话标签指向哪条会话记在
 * `panel-store` 的指向表里：「新对话」草稿发出第一条消息，只是那颗标签的指向从「没有」
 * 变成那条会话 —— key、位置、焦点、内容实例都不动。所以这里**没有任何「替换标签 /
 * 交接现场」的步骤**，只有「当前会话变了 → 确保它有一颗标签」这一条对齐。
 *
 * 工具标签（终端 / 接口 / 笔记…）不对应任何会话 —— 点 / 关 / 拖它们都**不该**动
 * `activeConversationId`。判定在 `panel-tabs.ts`（纯函数）。
 *
 * ## 内容一律常挂载
 *
 * 非活动标签用 `hidden` 藏起来而**不卸载** —— 终端的 xterm 实例 / scrollback、文件树的
 * 展开状态、编辑器里未保存的内容都只在组件内存里，卸载即灭（`TerminalPanel` 的 cleanup
 * 还会 kill 掉那条 PTY）。这与 `SidePanel` 是同一条约束。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { findShortcutByEvent, isShortcutRecording, useShortcuts } from '@fizz/agent-kit/shared/lib/shortcuts'
import { pruneToolTabs } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { pruneTabReloads } from './tab-reload'
import {
  activeTabKey,
  alignConversationTab,
  allTabKeys,
  closeTabs,
  conversationOfTab,
  openDraftTab,
  openTabKeys,
  staleConversationTabs,
  usePanelState,
} from '@fizz/agent-kit/shared/lib/panel-store'
import { consumeDraftConversation } from '@fizz/agent-kit/shared/lib/draft-tab-handoff'
import { useGroupActions } from './panel-view/group-actions'
import { PanelContentLayer } from './panel-view/PanelContentLayer'
import { PaneNodeView } from './panel-view/PaneNodeView'

export function PanelView() {
  const state = usePanelState()
  const { app } = useAppContext()
  const { closeAndSync } = useGroupActions()

  const activeConversationId = app.activeConversationId

  /**
   * `app` 是 `agentAppFrom()` 每次渲染现造的、context 的 value 也是现造的 —— 把这类
   * 「每次渲染都换引用」的东西收进 ref，让下面那些兜底 effect 只由「当前会话 / 面板状态 /
   * 会话清单」变了触发，而不是每次无关重渲染都重跑。
   */
  const actionsRef = useRef({ app })
  actionsRef.current = { app }

  /**
   * 零标签 → 补一张「新对话」草稿标签（与手机端 `apps/mobile/.../PanelView.tsx` 同一套做法）。
   *
   * 「一个标签都没有」不是一个该被展示的状态：关光所有标签的本意就是收起手头的事，
   * 而空白页上什么也做不了。补一张草稿标签后，主区域直接落在「开始新对话」页
   * （没有项目时也是这一页 —— 加项目就在输入框下面那行，见 `ChatPanel` / `WorkspaceSelect`）。
   *
   * `useLayoutEffect`：在浏览器绘制前补上，不先闪一帧空白。
   *
   * ⚠️ **有待恢复的会话时不要补**：刷新 / 冷启动会经 `useAgentApp` 恢复上次的会话，
   * 那一刻先塞草稿的话，下面那个 effect 开完真实会话就会并排多出一张「新对话」。
   */
  useLayoutEffect(() => {
    if (openTabKeys().length > 0) return
    if (activeConversationId) return
    openDraftTab()
  }, [state, activeConversationId])

  /**
   * 「选中**具体会话** → 焦点标签」：侧栏选中一条会话 / 启动恢复时同步标签。
   * `null` 不代表「自动打开新对话」：它也意味着刚关完所有标签。冷启动和刷新时若
   * 因为会话尚未恢复就给这个 `null` 自动找一条会话，用户关光的会话会凭空长回来。
   * **显式**新建仍由侧栏动作开草稿标签；零标签的情况另有一支（见上面那句
   * `useLayoutEffect`）。
   *
   * 怎么对齐只有一条规则（`alignConversationTab`，三端共用、有单测）：
   * - 会话已经有标签 → 不动；
    * - 它是**在草稿页发消息**建出来的 → 只有发起创建的那颗草稿标签可接下它；若该标签
    *   已关闭，就新开会话标签，不能误绑到后来创建的新草稿（见 `draft-tab-handoff.ts`）；
   * - 草稿正被看着（启动恢复）→ 同样由草稿接下，不然会并排多出一张「新对话」；
   * - 其余 → 新开一颗。
   *
   * 首次挂载时面板里已经有别的标签（例如刚从「主机」侧栏开出来的主机标签）→ 只补进来、
   * 不抢焦点。
   */
  const mountedRef = useRef(false)
  useEffect(() => {
    const key = activeConversationId
    if (!key) return
    const firstMount = !mountedRef.current
    mountedRef.current = true
    alignConversationTab(key, {
      draftHandoff: consumeDraftConversation(key),
      focus: !(firstMount && activeTabKey() !== null),
    })
  }, [activeConversationId])

  /**
   * 「会话被**删除 / 归档** → 它的标签跟着消失」。
   *
   * 标签集合是**会话清单的视图**，但只有「当前会话 → 焦点标签」这一条同步线
   * （上面那个 effect 只认 `activeConversationId` 的**变化**）。于是：
   * - 删掉 / 归档一条**没在看的**会话，它的标签原封不动留在标签条上（标题退化成
   *   「对话」，点进去是一条空会话）；
   * - 删掉正在看的那条，store 会把当前会话切到邻居，但**旧标签照样留着**；
   * - 另一台客户端删 / 归档的（状态 WS 推来新清单）本地同样不处理。
   * 所以这里按**清单**对一次表：指向已消失会话的标签，直接裸关。
   *
   * ⚠️ 三个前提，缺一个就会误关：
   * 1. `conversationsLoaded`：首屏清单还没落地时，空清单会把所有对话标签判成「已消失」；
   * 2. 裸关（`closeTabs`，不过守卫）：会话都没了，再问一句「确定关掉吗」没有意义；
   * 3. 关完要把「当前会话」对齐到焦点组现在的活动标签 —— 归档的正是当前会话时，
   *    `activeConversationId` 还指着那条（已归档的）会话，而上面那个 effect 只认
   *    「变化」不会自己纠；更糟的是「零标签补草稿」那条会因为「有 active」而不补，
   *    面板就空在那儿。
   *
   * 依赖只给清单：`app` 每次渲染都换引用，走 `actionsRef` 读现值。
   */
  useEffect(() => {
    if (!app.conversationsLoaded) return
    // 活着的 = 还在清单里、且没被归档（归档的会话仍留在清单里，靠 `archivedAt` 区分）
    const alive = new Set(
      app.conversations.filter((c) => !c.archivedAt).map((c) => c.id)
    )
    const stale = staleConversationTabs(alive)
    if (stale.length) closeTabs(stale)

    const current = actionsRef.current.app.activeConversationId
    if (!current || alive.has(current)) return
    // 面板上焦点组顺移到的标签如果指向一条活着的会话 → 当前会话跟着它走；否则退回空态
    // （零标签时由上面那条 `useLayoutEffect` 补一张草稿标签）
    const next = activeTabKey()
    const nextConversation = next ? conversationOfTab(next) : undefined
    if (nextConversation) {
      // 用 store 的 `openConversation` 而不是 context 那个：这里只是纠状态，不该顺手
      // 再开标签、更不该替用户切视图。
      actionsRef.current.app.openConversation(nextConversation)
      return
    }
    actionsRef.current.app.openConversation(null, { keepScroll: nextConversation === null })
  }, [app.conversations, app.conversationsLoaded])

  /**
   * 面板级快捷键「关闭当前标签」（默认 Ctrl / ⌘ + W，可在「设置 → 快捷键」里改）。
   *
   * ## 为什么挂在 `PanelView` 上，而不是 app-shell 的全局分发器
   *
   * 关标签是**面板自己**的事（要读焦点组的活动标签、还要把「当前会话」对齐过去），而
   * app-shell 拿不到这些。`shortcuts.ts` 的 `PANEL_SCOPED_SHORTCUT_ACTIONS` 正是为这种
   * 动作准备的：全局分发器遇到它**直接放行、不拦截**（否则会先在捕获阶段把按键吃掉，这里
   * 永远收不到），由面板自己挂的 window 监听处理。副作用正好是想要的 —— 面板没挂出来时
   * 这组按键完全不被应用占用。
   *
   * ## 挂在 window 而不是面板根节点上
   *
   * 跟 `GitPanel` 的推送快捷键同一套理由：不要求标签条先聚焦 —— 焦点在内容区（会话正文 /
   * 终端）里也该关得掉当前标签。副作用是要自己多判两件事：
   * - 输入法组合中 / 长按重复不触发（与全局分发同一套判断）；
   * - 设置页正在**录制**快捷键时让路，否则在设置里录 `Ctrl+W` 会顺手把标签关掉
   *   （`isShortcutRecording`，app-shell 通过 `setShortcutRecording` 广播过来）。
   */
  const shortcuts = useShortcuts()
  const closeRef = useRef(closeAndSync)
  closeRef.current = closeAndSync
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.repeat) return
      if (isShortcutRecording()) return
      const hit = findShortcutByEvent(shortcuts, e)
      if (!hit || hit.action !== 'close-tab') return
      e.preventDefault()
      e.stopPropagation()
      // 面板空着时没有「当前标签」可关 —— 什么也不做，也不吞按键
      const key = activeTabKey()
      if (key) closeRef.current([key])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [shortcuts])

  /**
   * 回收工具标签的登记条目（`tool-tabs.ts`）：标签被关掉 / 被 `alignToTabs` 摘掉之后，
   * 那条元数据（工作目录、shell…）就该跟着没了。
   *
   * 集中在这里做，是因为「关标签」的路径不止一条（标签上的 ×、右键的关闭其他 / 左侧 /
   * 右侧 / 整个组、`alignToTabs` 的批量对齐）—— 每条都记得顺手清一次迟早会漏。
   */
  useEffect(() => {
    pruneToolTabs(allTabKeys(state))
    // 同一次回收里带上「刷新代号」：已关闭标签的代号留着也只是几个 map 条目，但重开同名
    // 标签（`local:1` / `api:<requestId>` 都可能复用 key）会莫名继承上一次的刷新状态
    pruneTabReloads(allTabKeys(state))
  }, [state])

  /**
   * 标签被关光 → **当前会话**退回空态（主区域由上面那个 `useLayoutEffect` 补一张草稿标签，
   * 所以这里不再产出「空态页面」，只负责选中态与落盘意图）。
   *
   * 关掉最后一个标签时 `panel-store` 会保留一个空组占位（布局树不能是 `null`），
   * 而「当前会话」还停在那条已经不存在的会话上。这里把它退回空态并持久化
   * `blankIntent`，刷新后不恢复旧会话。
   *
   * ⚠️ `hadTabsRef` 是必需的：挂载首帧的面板状态本来就是空的（`openTab` 的写入要到
   * 下一帧才可见），若不加这道闸，首次挂载（含 web 刷新进 `activeConversationId` 有值
   * 的情况）会被误判成「标签被关光了」而立刻把当前会话清掉。只有「**曾经有过标签**、
   * 现在没了」才算真的关光。
   */
  const hadTabsRef = useRef(false)
  useEffect(() => {
    const { app: a } = actionsRef.current
    if (allTabKeys(state).length > 0) {
      hadTabsRef.current = true
      return
    }
    if (!hadTabsRef.current) return
    if (activeConversationId === null) return
    a.openConversation(null)
  }, [state, activeConversationId])

  return (
    /*
     * `relative` 是内容层的定位基准：内容层 `absolute inset-0` 要正好盖住整个面板区，
     * 而每个标签的落位坐标是相对它的原点算的。
     */
    <div className="relative flex min-h-0 flex-1 flex-col rounded-lg overflow-hidden">
      {/* 布局骨架：只画组外壳（标签条 / 空态 / 落区），车身留成洞 */}
      <PaneNodeView node={state.layout} />
      {/* 内容层：全部标签在根部渲染一次，再摆到各自组的车身上（见组件注释） */}
      <PanelContentLayer state={state} />
    </div>
  )
}
