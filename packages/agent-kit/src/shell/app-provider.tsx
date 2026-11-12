"use client";

/**
 * 应用级状态容器（Provider 实现）：把「数据层 + 跨页面共享的状态」收在一处。
 *
 * ⚠️ **形状**（`AppContextValue` / `AppContext` / `useAppContext`）在
 * `shared/hooks/use-app-context.ts`，这里只有实现。分开是为了让 `features/*`
 * 依赖「形状」而不是「应用装配」—— 否则拆包后方向是反的（见 docs/architecture/frontend-split.md）。
 *
 * 拆分原则（对应旧 `AgentApp` 巨石组件）：
 * - **这里（Provider）**：数据层（`useAgentApp` / `useTriggers`）、主题、
 *   会话面板现场（`panelSessions`）、快捷命令、工作区快捷配置 ——
 *   它们要么被多个页面消费，要么必须跨标签切换存活。
 * - **AppShell**（`app/app-shell.tsx`）：纯界面外壳 —— 侧栏、弹窗、命令面板、快捷键分发。
 * - **主区域**：只有 `PanelView` 一套多标签面板（流程视图已整个删除，见
 *   `shared/hooks/use-app-context.ts` 的头注释），数据从 `useAppContext()` 拿。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShellDetectResult } from '@fizz/shells'
import type { WorkspaceConfigSnapshot } from '@fizz/contracts/workspace-config'
import { useAgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { useTheme } from '@fizz/agent-kit/shared/hooks/useTheme'
import { useTriggers } from '@fizz/agent-kit/shared/hooks/useTriggers'
import { useTerminalShell, getTerminalShell } from '@fizz/agent-kit/shared/lib/terminal-shell'
import { toTerminalInput } from '@fizz/agent-kit/shared/lib/terminal-input'
import { prunePanelWidths } from '@fizz/agent-kit/shared/lib/panel-width'
import { setMobileSidebarOpen, useMobileSidebarOpen } from '@fizz/agent-kit/shared/lib/mobile-sidebar'
import { allTabKeys, openTab, useIsTabOpen } from '@fizz/agent-kit/shared/lib/panel-store'
import { NEW_TAB_KEY } from '@fizz/agent-kit/shared/lib/panel-tabs'
// 名字避开本组件自己导出的 `openSettingsTab`（那个是「带分组打开」的对外动作），
// 这里要的是底层那条「把设置标签开出来」的工具函数
import { openSettingsTab as openSettingsPanelTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import {
  aliveTabs,
  draftPanelKey,
  focusTab,
  isDraftPanelKey,
  isTabMounted,
  isTerminalTabKey,
  terminalTabKey,
  withSideTab,
  withoutMounted,
  type PanelSession,
  type PanelTabKey,
  type SideTabKey,
  type TerminalTab
} from '@fizz/agent-kit/shared/lib/panel-session'
import {
  AppContext,
  type AppContextValue,
  type NewDialogKind
} from '@fizz/agent-kit/shared/hooks/use-app-context'
import type { TerminalProcess } from '@fizz/agent-client/web-host'

/** 面板实例自增 id：渲染 key 用它，草稿 → 首个会话迁移时 key 不变、组件不重挂 */
let panelSeq = 0

/**
 * 浅比较的稳定对象：字段引用都没变就沿用上一份。
 *
 * `AppProvider` 每帧都会重渲染（`useAgentApp` 是整店订阅），`AppContext` 的值要是
 * 现场造字面量，**所有** `useAppContext()` 消费者（外壳、侧栏、标签条、每个面板）
 * 就跟着每帧全量重渲 —— 会话跑着时「整个软件都卡卡的」正是这么来的。这里逐字段
 * 比引用：都没变就返回旧对象，context 的传播在比较这一步自然停住。
 */
function useStableShallow<T extends object>(value: T): T {
  const ref = useRef(value)
  const prev = ref.current
  if (prev === value) return value
  const keys = Object.keys(value)
  if (keys.length === Object.keys(prev).length) {
    const prevRecord = prev as Record<string, unknown>
    const nextRecord = value as Record<string, unknown>
    let same = true
    for (const key of keys) {
      if (!Object.is(nextRecord[key], prevRecord[key])) {
        same = false
        break
      }
    }
    if (same) return prev
  }
  ref.current = value
  return value
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const app = useAgentApp()
  const { mode: themeMode, theme, setMode: setThemeMode } = useTheme()
  /** 切换主题（快捷键 / 命令面板用）：在亮暗之间切；「跟随系统」态下切成明确的一方 */
  const toggleTheme = useCallback(
    () => setThemeMode(theme === 'dark' ? 'light' : 'dark'),
    [setThemeMode, theme]
  )

  // ---------------------------------------------------------------------------
  // 数据层
  // ---------------------------------------------------------------------------

  /** 定时任务的状态（cron / 一次性规则） */
  const triggers = useTriggers(app.api)

  // ---------------------------------------------------------------------------
  // 打开某个具体对象：**选中 + 面板标签** 必须一起做
  // ---------------------------------------------------------------------------

  /**
   * 打开一个会话（侧栏点会话行 / 新建会话成功后）。
   *
   * ⚠️ 除了「选中 + 切视图」，这里还必须**顺手把面板标签也落到位** —— 光调 store 的
   * `openConversation` 不够：目标会话**已经是当前会话**时它直接早退
   * （见 `conversation.ts` 的「已是当前会话：什么都不做」），而「面板现在显示的是哪个
   * 标签」是面板自己的状态。于是「当前会话是 A、面板正显示一条终端标签」时点侧栏的 A，
   * 两边都没变化，表现就是**点了没反应**；先点别的会话、再点回来才开得了
   * （2026-10 反馈）。标签激活属于「用户手势」的一部分，只能在这里做 ——
   * `PanelView` 那条同步 effect 只认 `activeConversationId` 的**变化**。
   *
   * 唯一的例外：面板里**只有「新对话」占位标签**时不在这里开。那一支要就地替换占位
   * 标签、并把草稿的面板现场交给新会话（`adoptDraftPanel`），由 `PanelView` 的 effect
   * 负责；这里先插一条会把它挤成「两个标签」而绕开那段逻辑，草稿标签里开着的终端现场
   * 会连同标签一起丢。
   */
  const openConversation = useCallback(
    (
      conversationId: string,
      workspaceId?: string,
      /**
       * `keepScroll`：别复位消息区的滚动位置。**只有「切标签」传它** —— 那条会话的面板
       * 一直在内存里（后台标签只是 `hidden`），用户翻到哪儿就该留在哪儿；从侧栏 / 通知 /
       * 深链打开时「跳到最新」才是用户要的，不传。
       */
      opts?: { keepScroll?: boolean }
    ): void => {
      /*
       * 打开会话时把**当前工作区**也切到它所属的工作区。
       *
       * 原来只在显式传了 `workspaceId` 时才切，于是通知点击（`use-notify-watcher`
       * 只有会话 id）会留下「对话标签是 A、`activeWorkspaceId` 还是 B」的错位：
       * 顶栏按会话显示 A，但快捷操作 / 上传源 / 终端入口 / git 状态都读全局
       * `activeWorkspaceId`，全落到 B 上（用户实测：从通知跳回旧工作区后快捷操作
       * 整颗没了）。工作区能从会话清单反查，缺省就自己补上。
       *
       * 仍然**不让它顺手开「该工作区最新会话」**：selectWorkspace 的默认行为是自动
       * 打开最新会话，紧接着这里又打开目标会话 —— 两次 loadMessages 竞速，模型选择
       * 等状态先 A 后 B 闪一下。新建会话时更糟：conversationsRef 还没同步到刚建好的
       * 会话，selectWorkspace 会先打开「上一个会话」再切回来。
       */
      /*
       * ⚠️ 必须读**点击时**的 store 快照，不能用闭包里的 `app`：通知的 onClick 会被
       * 原生通知模块保存到点击为止，期间用户完全可能已经切到别的工作区。用旧快照比
       * `activeWorkspaceId` 会误判「已经在目标工作区」而跳过切换（用户实测：通知在
       * 切走前生成，点回来时快捷操作还停在上一个工作区）。
       */
      const current = useAgentStore.getState()
      const targetWorkspaceId =
        workspaceId ??
        current.conversations.find((c) => c.id === conversationId)?.workspaceId
      if (
        targetWorkspaceId &&
        targetWorkspaceId !== current.activeWorkspaceId
      ) {
        app.selectWorkspace(targetWorkspaceId, false)
      }
      void app.openConversation(conversationId, opts)
      const open = allTabKeys()
      if (!(open.length === 1 && open[0] === NEW_TAB_KEY)) openTab(conversationId)
    },
    [app]
  )

  /**
   * 删除会话（侧栏点 ×）。
   *
   * 落点（同工作区最近一条 / 空态）由 `useAgentApp.deleteConversation` 自己落到
   * `activeConversationId` 上，这里**不需要再做任何收尾**。
   *
   * 返回值如实透出给弹窗：false = 没删成，弹窗保持打开让用户重试。
   */
  const deleteConversation = useCallback(
    async (conversationId: string): Promise<boolean> => {
      const result = await app.deleteConversation(conversationId)
      return result.ok
    },
    [app]
  )

  // ---- 项目树「新建」弹窗的目标：几份共用一个状态，天然互斥 ----
  // worktree 与 worktree-load 是「新建工作区 / 管理工作区」两个弹窗，同属一个二级菜单
  const [newTarget, setNewTarget] = useState<{
    kind: NewDialogKind
    workspaceId: string
  } | null>(null)
  const openNewDialog = useCallback(
    (kind: NewDialogKind, workspaceId: string): void => setNewTarget({ kind, workspaceId }),
    []
  )
  const closeNewDialog = useCallback((): void => setNewTarget(null), [])

  /**
   * ---- 「打开设置并落到某个分组」：**主区域的一条标签**（`settings:list`），任何宽度
   * 都走这条 —— 标签条在窄屏也在（见 `AppShell` 的 `openSettings` 注释），按 `isMobile()`
   * 分叉成弹窗只会让同一份设置出现两种外壳。
   *
   * 与对话共享同一个 `AppProvider`，所以设置里改完立刻生效，不需要跨窗口广播。
   * 原先「宿主有 `openSettingsWindow` 就交给它」那条分支就是两个渲染进程的来源，
   * 已随独立设置窗口一起退场。
   *
   * `settingsTab` / `clearSettingsTab` 两个契约成员在 web / desktop 里**恒为空**：
   * 分组直接写进标签登记表（`ToolTab.settingsTab`）。留着它们只为 `apps/mobile` ——
   * 那边是整页 `SettingsPage`，要靠「请求了哪一页」来决定首屏落到哪个分组。
   */
  const settingsTab = null
  const openSettingsTab = useCallback((tab: 'models' | 'acp'): void => {
    openSettingsPanelTab(tab)
  }, [])
  const clearSettingsTab = useCallback((): void => {}, [])

  // ---------------------------------------------------------------------------
  // 会话面板现场：**按会话常驻、隐藏不销毁**（状态在这里，跨导航存活）
  // ---------------------------------------------------------------------------
  const [panelSessions, setPanelSessions] = useState<Record<string, PanelSession>>({})
  // 手机形态的侧栏抽屉：对话工具条的汉堡按钮和外壳都要读写。
  // ⚠️ 这份状态**只有一份**，而且不在这棵 React 树的 useState 里（模块级 + 落盘，
  // 见 `app/layout/mobile-sidebar.ts`）：活动栏竖条在不在是**从它派生**的
  // （`AppShell` 的 `railHidden`），两边各有一份就一定会不同步 —— 而不同步的那一瞬就是
  // 「竖条没了、侧栏还开着」的半截形态（用户明确要求这两个一起进出）。
  const mobileSidebarOpen = useMobileSidebarOpen()
  const sessionKey = app.activeConversationId ?? draftPanelKey(app.activeWorkspaceId)
  /**
   * 「新对话」占位标签是不是开着。
   *
   * 草稿（`draft:*`）面板的**存活期跟着这个标签**，而不是跟着「当前会话」—— 后者会让
   * 它一离开焦点就被回收（切一下标签，草稿标签里的终端现场连同 PTY 一起没）。
   * 快照是布尔，所以只有开 / 关那一下才重渲染（见 `panel-store` 的 `useIsTabOpen`）。
   */
  const draftTabOpen = useIsTabOpen(NEW_TAB_KEY)
  const activePanel = panelSessions[sessionKey]
  const sideTab = activePanel?.sideTab ?? null
  /** 读任意会话的面板现场：多标签 / 分屏下每个对话标签读自己那份（见 AppContextValue） */
  const panelOf = useCallback((key: string): PanelSession | undefined => panelSessions[key], [panelSessions])

  /**
 * 会话 / 工作区 id 列表（join 成字符串）：给面板回收 effect / `patchPanelOf` 当依赖用。
 *
 * `app.conversations` / `app.workspaces` 每次渲染都是新引用，直接进依赖会让 memo 永远失效；
 * 而内容相同的两次渲染 join 出来是同一个字符串，所以它既稳定又精确。
 */
const conversationIdList = app.conversations.map((c) => c.id).join('\n')
const workspaceIdList = app.workspaces.map((w) => w.id).join('\n')
/**
 * 容器型项目的工作区 id（join 成字符串）：`openTerminalTabOf` 要用它判「默认该开哪种终端」，
 * 而 `app.workspaces` 每次渲染都是新引用 —— 用这个稳定串当依赖，内容不变就不重建回调。
 */
const containerWorkspaceIdList = app.workspaces
  .filter((w) => w.container !== undefined)
  .map((w) => w.id)
  .join('\n')

  /**
   * 新建一个空白面板现场（首次打开时才真正落库，之后常驻）：面板收起、一个标签都没挂出。
   *
   * 按**会话 key** 取工作区：多标签 / 分屏之后每个会话各有一份面板，非当前会话的现场也得
   * 按它自己所属的工作区建（否则文件树 / 终端会挂到错误的工作区上）。
   */
  function blankPanelFor(key: string): PanelSession {
    const conv = app.conversations.find((c) => c.id === key)
    const workspaceId = conv?.workspaceId ?? app.activeWorkspaceId ?? ''
    const workspace = app.workspaces.find((w) => w.id === workspaceId)
    return {
      id: `panel-${++panelSeq}`,
      workspaceId,
      cwd: workspace?.path ?? null,
      sideTab: null,
      lastSideTab: null,
      tabOrder: [],
      // 终端标签全不预建：要用终端时由 openTerminalTab 现开（一条终端 = 一条 PTY）
      terminals: [],
      filesMounted: false,
      gitMounted: false,
      browserMounted: false,
      previewMounted: false,
      gitChanges: null,
      gitBranch: null
    }
  }

  /**
   * 改**指定会话**的面板现场（该会话还没有现场就按它自己的工作区建一个）。
   *
   * 这是所有面板变更的**唯一入口**：当前会话那批动作（`patchActivePanel` /
   * `showSideTab` / `toggleSideTab` / `closeSideTab` / `collapseSidePanel` /
   * `toggleSidePanel`）都只是它绑上 `sessionKey` 的薄壳；多标签 / 分屏下再由
   * `xxxOf(key, …)` 显式指向某个会话 —— 否则「在 A 标签点终端」会误改当前会话的现场。
   *
   * `fn` 原样返回入参（`next === base`）或返回 `null` = 本次无变化，**不落库**：
   * 「收起一个本来就收着的面板」不该凭空建出一个空现场。
   */
  const patchPanelOf = useCallback(
    (key: string, fn: (base: PanelSession) => PanelSession | null): void => {
      setPanelSessions((prev) => {
        const base = prev[key] ?? blankPanelFor(key)
        const next = fn(base)
        if (!next || next === base) return prev
        return { ...prev, [key]: next }
      })
    },
    // blankPanelFor 每次渲染都是新引用，但它只读 app 的当前值 —— 用这几个驱动即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationIdList, workspaceIdList, app.activeWorkspaceId]
  )

  /**
   * 关掉**指定会话**的某个标签（内容随之卸载：该条终端会话被掐、文件树的展开状态丢掉）。
   * 正看着它就切到另一个还挂着的标签；一个都不剩才把面板收起来 —— 与根应用同一套兜底，
   * 免得「关掉 A 却把还开着的 B 一起收了」。
   */
  const closeSideTabOf = useCallback(
    (key: string, tabKey: PanelTabKey): void => {
      patchPanelOf(key, (base) => {
        // 终端标签只是从列表里摘掉（组件卸载 → 对应 PTY 被 kill）；
        // files / git 是清挂出标记。两边都要从 tabOrder 里删掉。
        const dropped: PanelSession = isTerminalTabKey(tabKey)
          ? { ...base, terminals: base.terminals.filter((t) => terminalTabKey(t.id) !== tabKey) }
          : withoutMounted(base, tabKey as SideTabKey)
        const next: PanelSession = { ...dropped, tabOrder: dropped.tabOrder.filter((k) => k !== tabKey) }
        if (next.sideTab !== tabKey) return next
        const alive = aliveTabs(next)
        return withSideTab(next, alive[alive.length - 1] ?? null)
      })
    },
    [patchPanelOf]
  )

  /** 改当前会话的面板现场；该会话还没有现场就先按当前工作区建一个 */
  const patchActivePanel = useCallback(
    (patch: Partial<PanelSession>): void => {
      patchPanelOf(sessionKey, (base) => ({ ...base, ...patch }))
    },
    [patchPanelOf, sessionKey]
  )

  /**
   * 「挂出 + 切过去」，语义与根应用一致：只切标签，**从不关标签** ——
   * 关是标签条上那个 ×（`closeSideTab`）的事。终端标签已存在于 `terminals`，这里只补 tabOrder。
   */
  const showSideTabOf = useCallback(
    (key: string, tabKey: PanelTabKey): void => {
      patchPanelOf(key, (base) => focusTab(base, tabKey))
    },
    [patchPanelOf]
  )
  const showSideTab = useCallback(
    (key: PanelTabKey): void => showSideTabOf(sessionKey, key),
    [showSideTabOf, sessionKey]
  )

  /**
   * 顶栏「文件 / 源码管理」按钮的语义：正看着这个标签就**收起面板**（标签留着），
   * 否则挂出并切过去。收起 ≠ 关闭：文件树现场的展开状态都还在。
   * （终端不常用这套 —— 一个会话可能有多条终端，走 `toggleTerminalPanel`。）
   */
  const toggleSideTabOf = useCallback(
    (sessionId: string, key: SideTabKey): void => {
      patchPanelOf(sessionId, (base) =>
        base.sideTab === key ? withSideTab(base, null) : focusTab(base, key)
      )
    },
    [patchPanelOf]
  )
  const toggleSideTab = useCallback(
    (key: SideTabKey): void => toggleSideTabOf(sessionKey, key),
    [toggleSideTabOf, sessionKey]
  )

  /** 关掉当前会话的某个标签 */
  const closeSideTab = useCallback(
    (key: PanelTabKey): void => closeSideTabOf(sessionKey, key),
    [closeSideTabOf, sessionKey]
  )

  /** 收起面板（一个标签都不关）；无变化时不落库 */
  const collapseSidePanelOf = useCallback(
    (key: string): void => {
      patchPanelOf(key, (base) => (base.sideTab === null ? null : withSideTab(base, null)))
    },
    [patchPanelOf]
  )
  const collapseSidePanel = useCallback(
    (): void => collapseSidePanelOf(sessionKey),
    [collapseSidePanelOf, sessionKey]
  )

  /** 收起 / 恢复到**上次看的**那个标签（那个已经关掉了就退到最后一个还挂着的） */
  const toggleSidePanelOf = useCallback(
    (key: string): void => {
      patchPanelOf(key, (base) => {
        if (base.sideTab !== null) return withSideTab(base, null)
        const last = base.lastSideTab
        const restore = last && isTabMounted(base, last) ? last : (aliveTabs(base).pop() ?? null)
        return restore ? withSideTab(base, restore) : null
      })
    },
    [patchPanelOf]
  )
  const toggleSidePanel = useCallback(
    (): void => toggleSidePanelOf(sessionKey),
    [toggleSidePanelOf, sessionKey]
  )

  /** 入口图标右上角的 git 改动数（0 / null = 不显示）；改动过多（列表被截断）时显示成 `N+` */
  const gitChangeCount = activePanel?.gitChanges?.count ?? 0
  const gitBadge =
    gitChangeCount > 0 ? `${gitChangeCount}${activePanel?.gitChanges?.truncated ? '+' : ''}` : null

  /**
   * 一轮对话结束后（以及切到别的会话时）刷一次当前工作区的 git 状态。
   * 只在**没在跑**的时候刷 —— 正流式时文件还在变，查了也是白查。
   */
  const gitStatusRef = useRef(app.gitStatus)
  gitStatusRef.current = app.gitStatus
  const gitWorkspaceId = app.activeWorkspaceId
  /** 没有目录的虚拟工作区没有仓库可查 */
  const gitWorkspacePath = app.activeWorkspace?.path ?? null
  /**
   * 是否正在跑：**直接从 store 选**，不从 `app` 读。
   *
   * `useAgentApp()` 的返回值在「只有切片变化」时保持旧引用（省掉流式期间整棵
   * 应用树每帧重渲，见那边的投影缓存），`app.streaming` 会停在最后一次非切片
   * 变更时的值。需要切片状态的组件一律按选择器订阅。
   */
  const activeGeneralConversationId = app.activeConversationId
  const chatStreaming = useAgentStore(
    (state) =>
      (activeGeneralConversationId
        ? state.slices[activeGeneralConversationId]?.streaming
        : false) ?? false
  )
  useEffect(() => {
    if (chatStreaming || !gitWorkspaceId || !gitWorkspacePath) return
    let cancelled = false
    void gitStatusRef
      .current(gitWorkspaceId)
      .then((status) => {
        if (cancelled) return
        patchActivePanel({
          gitChanges: status.isRepo
            ? { count: status.changes.length, truncated: status.truncated }
            : null,
          // 分支与改动数同一次请求带回来（顶栏名字下面那行要用，不额外打接口）。
          // 分离头指针时没有分支名，标出来 —— 显示成空白会让人以为没查到
          gitBranch: status.isRepo
            ? (status.branch ?? (status.detached ? 'HEAD（分离）' : null))
            : null
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // app / patchActivePanel 每次渲染都是新引用，进依赖会让 effect 每帧重跑；
    // 这里靠 sessionKey 驱动（sessionKey 变 = 切了会话）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatStreaming, sessionKey, gitWorkspaceId, gitWorkspacePath])

  /**
   * 「草稿态 → 首个会话」：把草稿的面板现场交给新会话（保留终端 / 文件现场）。
   *
   * ⚠️ **由 `PanelView` 在「占位标签被就地替换」那一刻显式调用**，不是「`sessionKey` 一变
   * 就迁移」。老实现是后者，于是有个很难查的坑：用户在新对话标签里开着终端，只要点了
   * **别的**会话标签（`sessionKey` 从草稿变成那条会话），草稿现场就被搬走了 —— 那个会话
   * 凭空多出几条终端，草稿标签自己反而空了。现场属于**标签**，只有标签本身被换掉才该搬家。
   *
   * 找不到草稿现场（用户压根没在草稿里开过东西）或目标已有现场时不做事 —— 绝不覆盖。
   */
  const adoptDraftPanel = useCallback(
    (conversationId: string): void => {
      const from = draftPanelKey(app.activeWorkspaceId)
      setPanelSessions((sessions) => {
        const draft = sessions[from]
        if (!draft || sessions[conversationId]) return sessions
        const next = { ...sessions }
        delete next[from]
        next[conversationId] = draft
        return next
      })
    },
    [app.activeWorkspaceId]
  )

  /**
   * 回收失效的面板：会话被删除、或「新对话」标签已经关掉（草稿现场跟着它一起走）。
   *
   * ⚠️ 草稿那支判的是 `draftTabOpen`（标签开着吗），**不是** `key === sessionKey`（它是不是
   * 当前会话）。后者会让草稿面板在「切到别的标签」时当场被回收 —— 面板收起、终端 PTY 被 kill，
   * 切回新对话标签就是一片空白。`draftTabOpen` 变化会驱动本 effect 重跑（见 `useIsTabOpen`）。
   */
  useEffect(() => {
    const ids = new Set(conversationIdList ? conversationIdList.split('\n') : [])
    setPanelSessions((prev) => {
      let changed = false
      const next: Record<string, PanelSession> = {}
      for (const [key, value] of Object.entries(prev)) {
        const keep = isDraftPanelKey(key) ? draftTabOpen : ids.has(key)
        if (keep) next[key] = value
        else changed = true
      }
      return changed ? next : prev
    })
    // 面板宽度（`lib/panel-width.ts`）也按会话记，同一批会话没了就一起清。
    //
    // ⚠️ 必须等列表**真的加载完**（`conversationsLoaded`）才清：加载前 id 清单是空的，
    // 那会把 localStorage 里所有会话的宽度一次性误删 —— 页面一刷新全丢。
    // （面板状态本身不用这层保护：它是内存态，刷新后本来就是空的。）
    // 草稿标签开着时它的宽度也留着：不然切一趟标签回来，面板宽度就忘了。
    if (app.conversationsLoaded) {
      prunePanelWidths([
        ...ids,
        sessionKey,
        ...(draftTabOpen ? [draftPanelKey(app.activeWorkspaceId)] : [])
      ])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationIdList, sessionKey, app.conversationsLoaded, draftTabOpen, app.activeWorkspaceId])

  // ---- 工作区快捷功能（.fizz/workspace.json） ----
  // 快照按工作区缓存，供快捷功能菜单 / 快捷功能管理弹窗使用。
  /** 按工作区缓存的配置快照（null = 还没读到 / 读取失败） */
  const [quickConfigs, setQuickConfigs] = useState<Record<string, WorkspaceConfigSnapshot | null>>({})
  const [quickManageOpen, setQuickManageOpen] = useState(false)
  const quickWorkspaceId = app.activeWorkspaceId
  const quickSnapshot = quickWorkspaceId ? (quickConfigs[quickWorkspaceId] ?? null) : null

  // ---- 终端标签：一个会话可以开多条，每条规定一条 PTY ----
  /** 终端标签 id 自增源（`term-N`；全局唯一，进程表 / 就绪桥都按它索引） */
  const termSeqRef = useRef(0)
  /** 每条终端的 PTY 进程，按**终端标签 id** 存（背景会话的进程要留着，切回来还能用） */
  const terminalProcsRef = useRef<Record<string, TerminalProcess>>({})
  /** 等就绪桥：某条终端的 TerminalPanel onReady 时唤醒等待者。**只当信号，不带进程** */
  const terminalReadyRef = useRef<Record<string, () => void>>({})

  const handleTerminalReady = useCallback((terminalTabId: string, proc: TerminalProcess): void => {
    terminalProcsRef.current[terminalTabId] = proc
    // 进程退出（含被 kill）后失效：下次要往这条写命令会重新开一条
    void proc.onExit(() => {
      if (terminalProcsRef.current[terminalTabId] === proc) delete terminalProcsRef.current[terminalTabId]
    })
    const resolve = terminalReadyRef.current[terminalTabId]
    delete terminalReadyRef.current[terminalTabId]
    resolve?.()
  }, [])

  /**
   * 新开一条终端标签并切过去，**同步返回**它的标签 id（调用方要拿它等 PTY 就绪）。
   *
   * `shellId` 不传 = 用**上次打开终端时记住的 shell**（没有 / 已不可用就平台默认）；
   * 显式传（含 null）就用它 —— 顶栏「选择终端」选谁开谁（并顺手记住）。
   *
   * `container` 给了 = 容器型项目的**容器内**终端（服务端 `docker exec`）。
   * 两者都不给 = 按项目类型默认：容器型项目进容器，其余走宿主默认 shell
   * —— 容器项目里点终端自然该进容器，宿主 shell 在那个项目里没有意义。
   *
   * 默认 shell 按**目标会话自己所属的工作区**取（多标签 / 分屏下每个会话的工作区可能不同）。
   */
  const openTerminalTabOf = useCallback(
    (
      targetKey: string,
      shellId?: string | null,
      container?: { workspaceId: string; shell?: string }
    ): string => {
      const id = `term-${++termSeqRef.current}`
      const tabKey = terminalTabKey(id)
      patchPanelOf(targetKey, (base) => {
        // 没有工作区目录开不出终端（虚拟工作区里连入口都不渲染）
        if (!base.cwd) return null
        // 显式选了宿主 shell 就尊重它，不进容器（用户可能是要 docker 命令本身）
        const containerTarget =
          container ??
          (shellId === undefined &&
          !!base.workspaceId &&
          containerWorkspaceIdList.split('\n').includes(base.workspaceId)
            ? { workspaceId: base.workspaceId }
            : undefined)
        const resolvedShell =
          shellId !== undefined ? shellId : getTerminalShell()
        const tab: TerminalTab = {
          id,
          shellId: resolvedShell,
          cwd: base.cwd,
          ...(containerTarget
            ? {
                containerWorkspaceId: containerTarget.workspaceId,
                ...(containerTarget.shell ? { containerShell: containerTarget.shell } : {})
              }
            : {})
        }
        return focusTab({ ...base, terminals: [...base.terminals, tab] }, tabKey)
      })
      return id
    },
    [patchPanelOf, containerWorkspaceIdList]
  )
  const openTerminalTab = useCallback(
    (shellId?: string | null): string => openTerminalTabOf(sessionKey, shellId),
    [openTerminalTabOf, sessionKey]
  )

  /**
   * ⚠️ 这里**没有**「在面板里开一条 SSH 终端」那条路了。
   *
   * 远端主机的终端现在占的是**主区域**的一个内容标签（`host:<hostId>`，见
   * `app/layout/tool-tabs.ts`）—— 它要能和对话标签并排、一起拖拽分屏，右侧面板那条
   * 「一个会话一份现场」的路子做不到这件事。命令面板与「主机」侧栏都走那条路。
   */

  /** 顶栏「终端」主按钮：正看着某个终端就收起；否则回到最后一个终端，一条都没有就新开一条 */
  const toggleTerminalPanelOf = useCallback(
    (key: string): void => {
      const panel = panelSessions[key]
      if (isTerminalTabKey(panel?.sideTab)) {
        collapseSidePanelOf(key)
        return
      }
      const last = panel?.terminals[panel.terminals.length - 1]
      if (last) {
        showSideTabOf(key, terminalTabKey(last.id))
        return
      }
      openTerminalTabOf(key)
    },
    [panelSessions, collapseSidePanelOf, showSideTabOf, openTerminalTabOf]
  )
  const toggleTerminalPanel = useCallback(
    (): void => toggleTerminalPanelOf(sessionKey),
    [toggleTerminalPanelOf, sessionKey]
  )

  /**
   * 「执行命令」类快捷操作：**每次都新开一条终端**跑，不占用已有的终端
   * （用户可能正在某条终端里干活）。新终端就绪后把命令写进去。
   *
   * ⚠️ 写入用 `toTerminalInput`（多行 → 逐行**裸回车 CR**），**不是** `command + '\r'`：
   * 后者把用户填的多行命令里的 `\n` 原样送进 PTY，而 PowerShell 的 PSReadLine 把 LF 当
   * 「在当前行**上方**插入一行」，于是多条命令会**倒序执行**（实测 CCC、BBB、AAA）。
   * 详见 `shared/lib/terminal-input.ts`（运行脚本那条路一直用的是同一份实现）。
   */
  const runQuickCommand = useCallback(
    async (command: string): Promise<void> => {
      if (!app.activeWorkspace?.path) throw new Error('没有选中的工作区')
      const id = openTerminalTab()
      if (!terminalProcsRef.current[id]) {
        await new Promise<void>((resolve, reject) => {
          terminalReadyRef.current[id] = resolve
          // 等就绪最多 5 秒：TerminalPanel 挂载即建 PTY，正常毫秒级回来
          window.setTimeout(() => {
            if (terminalReadyRef.current[id] === resolve) {
              delete terminalReadyRef.current[id]
              reject(new Error('终端打开超时'))
            }
          }, 5000)
        })
      }
      /*
       * ⚠️ 就绪后**必须重新取一次**最新进程，不能用 onReady 那一刻给的那个。
       * dev 下 App Router 默认开着 React StrictMode（见 next 的 define-env：
       * 未配 reactStrictMode 时 App Router 取 true）：挂载的 effect 会「跑一遍 → 清理 →
       * 再跑一遍」，TerminalPanel 于是先建 PTY-A、立刻 kill-A、再建 PTY-B。
       * 第一次 onReady 报的是 A（随即成了死进程），拿它写命令 = 写进空气 ——
       * 现象正是「第一次点只把终端开出来、命令没跑，得再点一次」。
       * 此刻 ref 里已换成 B，重取即得活进程（B 的 WS 未开时 write 会入队，不会丢）。
       */
      const proc = terminalProcsRef.current[id]
      if (!proc) throw new Error('终端未就绪')
      // 多行命令逐行回车（CR）：直接把 `\n` 写进 PTY 会被 PowerShell 倒序执行，见上
      proc.write(toTerminalInput(command))
    },
    [app.activeWorkspace?.path, openTerminalTab]
  )

  // ---- 工作区快捷功能：状态声明已上移到终端那一段之前（见上方注释），这里只管加载 ----
  // 切换工作区就（懒）加载它的配置；读失败的错误由快照里的 error 字段带出来。
  // 必须走 app.api（内部 `request` 自带 Bearer 鉴权 + 统一 401 收场）——
  // 以前这里是裸 fetch，漏带 token，被 proxy 判 401；登录后又被自己的 401 踢回登录页（死循环）。
  useEffect(() => {
    if (!app.api || !quickWorkspaceId || quickConfigs[quickWorkspaceId]) return
    let cancelled = false
    void app.api
      .getWorkspaceConfig(quickWorkspaceId)
      .then((snapshot) => {
        if (!cancelled) setQuickConfigs((prev) => ({ ...prev, [quickWorkspaceId]: snapshot }))
      })
      .catch(() => {
        // 读失败不缓存，下次切换再试；UI 按「没有配置」展示。
        // 401 已由 api 层统一清数据 + 退登录，这里不再重复处理。
      })
    return () => {
      cancelled = true
    }
  }, [app.api, quickWorkspaceId, quickConfigs])

  const saveQuickConfig = useCallback(
    async (
      workspaceId: string,
      config: {
        version: number
        defaultTerminal: string | null
        quickActions: WorkspaceConfigSnapshot['config']['quickActions']
        approvedCommands: string[]
      }
    ): Promise<void> => {
      // 同样走 app.api：带鉴权头，401 由 api 层统一收场（清数据 + 退登录）
      if (!app.api) throw new Error('未连接')
      const snapshot = await app.api.saveWorkspaceConfig(workspaceId, config)
      setQuickConfigs((prev) => ({ ...prev, [workspaceId]: snapshot }))
    },
    [app.api]
  )

  /**
   * 强制重拉某个工作区的配置快照：快捷功能弹窗**打开时**调 —— 懒加载的缓存会盖住
   * 「agent 点『始终允许此命令』刚写进文件的那条」，弹窗里看不到、保存时还会把它
   * 整体覆盖掉。打开时刷新一次，看到的就是盘上现状。
   */
  const refreshQuickConfig = useCallback(
    async (workspaceId: string): Promise<void> => {
      if (!app.api || !workspaceId) return
      try {
        const snapshot = await app.api.getWorkspaceConfig(workspaceId)
        setQuickConfigs((prev) => ({ ...prev, [workspaceId]: snapshot }))
      } catch {
        // 拉失败保留旧快照（弹窗仍可用，只是内容可能旧一点）
      }
    },
    [app.api]
  )

  // ---- 可选 shell 清单（顶栏「终端」主按钮 / 面板「选择终端」共用） ----
  const [terminalShells, setTerminalShells] = useState<ShellDetectResult | null>(null)
  /**
   * 上次打开终端时记住的 shell（null = 平台默认）。来源只有一处：
   * 用户在「选择终端」菜单里选了什么就记什么（`setTerminalShell`），
   * 工作区设置里那个显式的「默认终端」已取消。
   */
  const terminalShellId = useTerminalShell()
  /** 「新终端默认用哪个 shell」= 记住的那个；顶栏「选择终端」菜单拿它打勾 */
  const defaultTerminalShellId = terminalShellId
  /**
   * ⚠️ 依赖必须是**「连上了没有」这个布尔值**，不能是 `[]`。
   *
   * `AppProvider` 挂在 `/login` 与工作台**共同的父层**（组间导航不重建它，见 app-shell），
   * 所以它挂载时人还在登录页、`getApi()` 还是 null：一次性 effect 会立刻走到 `.catch`
   * 把清单置成 null，而**登录成功之后再也没人重试** —— 整个运行期 `terminalShells`
   * 都是 null，终端的下拉与「添加本地终端」二级菜单只剩一句「正在检测终端…」。
   * 刷新一下页面就好了（那时 `hydrateConnection()` 已经先跑过）——正是那种
   * 「重新登录一次就正常」的幽灵 bug。
   *
   * 用布尔值而不是 `app.api` / `app` 本身进依赖：`apiForToken()` 每次调用都造新对象、
   * `app.*` 也是每次渲染新引用，直接进依赖会变成无限重拉（下面那句 ref 注释说的就是这个）。
   */
  const apiReady = Boolean(app.api)
  const listTerminalShellsRef = useRef(app.listTerminalShells)
  listTerminalShellsRef.current = app.listTerminalShells
  useEffect(() => {
    // 还没连上：等 `apiReady` 翻真再探测（否则只会白白把清单置空一次）
    if (!apiReady) return
    let cancelled = false
    void listTerminalShellsRef
      .current()
      .then((result) => {
        if (!cancelled) setTerminalShells(result)
      })
      .catch(() => {
        if (!cancelled) setTerminalShells(null)
      })
    return () => {
      cancelled = true
    }
  }, [apiReady])

  // ---- 派生布尔值：path 为空的工作区没有目录概念 ----
  const hasDirectory = !!app.activeWorkspace?.path
  const hasWorkspace = !!app.activeWorkspaceId
  const canTerminal = hasDirectory

  const value = useStableShallow<AppContextValue>({
    app,
    themeMode,
    theme,
    setThemeMode,
    toggleTheme,
    triggers,
    openConversation,
    deleteConversation,
    newTarget,
    openNewDialog,
    closeNewDialog,
    settingsTab,
    openSettingsTab,
    clearSettingsTab,
    sessionKey,
    activePanel,
    patchActivePanel,
    sideTab,
    toggleSideTab,
    showSideTab,
    closeSideTab,
    openTerminalTab,
    toggleTerminalPanel,
    collapseSidePanel,
    toggleSidePanel,
    handleTerminalReady,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    gitBadge,
    closeSideTabOf,
    panelOf,
    patchPanelOf,
    showSideTabOf,
    toggleSideTabOf,
    collapseSidePanelOf,
    toggleSidePanelOf,
    openTerminalTabOf,
    toggleTerminalPanelOf,
    adoptDraftPanel,
    runQuickCommand,
    quickSnapshot,
    saveQuickConfig,
    refreshQuickConfig,
    quickManageOpen,
    setQuickManageOpen,
    terminalShells,
    terminalShellId,
    defaultTerminalShellId,
    hasDirectory,
    hasWorkspace,
    canTerminal
  })

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
