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
 * - **主区域**：只渲染面板（`PanelView`），数据从 `useAppContext()` 拿。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
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
import {
  activeTabKey,
  conversationOfTab,
  openChatTab,
  openTabKeys,
  useDraftTabKey,
  useOpenTabsVersion,
  useTabOfConversation
} from '@fizz/agent-kit/shared/lib/panel-store'
import { isConversationTabKey } from '@fizz/agent-kit/shared/lib/panel-tabs'
import {
  aliveTabs,
  DRAFT_PANEL_SCOPE,
  focusTab,
  isTabMounted,
  isTerminalTabKey,
  resolvePanelWorkspace,
  resolveTerminalCwd,
  retargetPanelWorkspace,
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

/** 面板实例自增 id：渲染 key 用它，标签换指向（草稿 → 会话）时不变、组件不重挂 */
let panelSeq = 0

export function AppProvider({ children }: { children: React.ReactNode }) {
  const app = useAgentApp()
  const { mode: themeMode, theme, setMode: setThemeMode } = useTheme()
  /** 切换主题（快捷键 / 命令面板用）：在亮暗之间切；「跟随系统」态下切成明确的一方 */
  const toggleTheme = useCallback(
    () => setThemeMode(theme === 'dark' ? 'light' : 'dark'),
    [setThemeMode, theme]
  )

  /** 定时任务的状态（cron / 一次性规则） */
  const triggers = useTriggers(app.api)

  // ---------------------------------------------------------------------------
  // 打开某个具体对象
  // ---------------------------------------------------------------------------

  /**
   * 打开一个会话（侧栏点会话行 / 新建会话成功后）。
   *
   * ⚠️ 除了「选中」，这里还必须**顺手把面板标签也落到位** —— 光调 store 的
   * `openConversation` 不够：目标会话**已经是当前会话**时它直接早退
   * （见 `conversation.ts` 的「已是当前会话：什么都不做」），而「面板现在显示的是哪个
   * 标签」是面板自己的状态。于是「当前会话是 A、面板正显示一条终端标签」时点侧栏的 A，
   * 两边都没变化，表现就是**点了没反应**；先点别的会话、再点回来才开得了
   * （2026-10 反馈）。标签激活属于「用户手势」的一部分，只能在这里做 ——
   * `PanelView` 那条同步 effect 只认 `activeConversationId` 的**变化**。
   *
   * 标签的 key 不是会话 id（见 `panel-tabs.ts` 的铁律），所以走 `openChatTab`：它按
   * 指向表查「这条会话有没有标签」，有就只切过去，没有才新开一颗（单标签模式下 = 替换）。
   */
  const openConversation = useCallback(
    (conversationId: string, workspaceId?: string): void => {
      /*
       * 打开会话时把当前工作区也切到它所属的工作区。
       *
       * 通知点击只带会话 id；原来只在显式传 `workspaceId` 时才切，于是通知从别的
       * 工作区跳回来后会留下「对话标签是 A、activeWorkspaceId 还是 B」的错位 ——
       * 快捷操作 / 终端入口 / git 状态都读全局工作区，全落到 B 上。
       *
       * ⚠️ 必须读点击时的 store 快照：原生通知的 onClick 会保存到用户点击为止，
       * 闭包里的 `app` 可能已经过期。选择工作区时传 false，避免顺手打开该工作区
       * 最新会话和下面这次 openConversation 竞速。
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
      void app.openConversation(conversationId)
      openChatTab(conversationId)
    },
    [app]
  )

  /**
   * 删除会话（侧栏点 ×）。
   *
   * 落点（同工作区最近一条 / 空态）由 `useAgentApp.deleteConversation` 自己落到
   * `activeConversationId` 上，这里**不需要再做任何收尾** —— 以前要跟着写一次 URL
   * 是为了让地址栏与状态对齐，现在没有地址栏了。
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

  // ---- 「打开设置并落到某个分组」：状态在这里，弹窗本体在 AppShell ----
  const [settingsTab, setSettingsTab] = useState<'models' | 'acp' | null>(null)
  const openSettingsTab = useCallback((tab: 'models' | 'acp'): void => setSettingsTab(tab), [])
  const clearSettingsTab = useCallback((): void => setSettingsTab(null), [])

  // ---------------------------------------------------------------------------
  // 面板现场：**每颗对话标签各一份、常驻、隐藏不销毁**（状态在这里，跨导航存活）
  // ---------------------------------------------------------------------------
  /**
   * 真源是 ref，不是 `useState` —— 与 web / desktop 的
   * `packages/agent-kit/src/shell/app-provider.tsx` 同一套实现（改这里时两边一起改）。
   *
   * 现场按**标签 key** 存（不是会话 id）：现场属于标签，标签活着现场就在。草稿标签发出
   * 第一条消息只是换了个指向，key 不变，终端 / 文件现场原地不动。
   */
  const panelSessionsRef = useRef<Record<string, PanelSession>>({})
  const [, bumpPanelSessions] = useReducer((n: number) => n + 1, 0)
  /** 渲染期读到的现场（真源是 ref，这个别名只是让下面的读取不用到处写 `.current`） */
  const panelSessions = panelSessionsRef.current
  /**
   * 写面板现场的**唯一入口**：先写 ref，再触发一次重渲染。
   *
   * 命令式动作（`openTerminalTabOf`、`showSideTabOf`…）经常在同一个同步块里**写完现场
   * 紧接着读**。React state 要等下一次渲染才可见，那一帧读到的是旧现场 ⇒ 面板空一拍。
   * 写进 ref 后立刻可读，state 只负责让消费方重渲染。
   */
  const commitPanelSessions = useCallback(
    (updater: (prev: Record<string, PanelSession>) => Record<string, PanelSession>): void => {
      const prev = panelSessionsRef.current
      const next = updater(prev)
      if (next === prev) return
      panelSessionsRef.current = next
      bumpPanelSessions()
    },
    []
  )
  // 手机形态的侧栏抽屉：对话工具条的汉堡按钮和外壳都要读写。
  // ⚠️ 这份状态**只有一份**，而且不在这棵 React 树的 useState 里（模块级 + 落盘，
  // 见 `app/layout/mobile-sidebar.ts`）：活动栏竖条在不在是**从它派生**的
  // （`AppShell` 的 `railHidden`），两边各有一份就一定会不同步 —— 而不同步的那一瞬就是
  // 「竖条没了、侧栏还开着」的半截形态（用户明确要求这两个一起进出）。
  const mobileSidebarOpen = useMobileSidebarOpen()
  /**
   * 「当前会话的现场」挂在哪颗标签下：承载当前会话的那颗；当前没有会话（空态页）就是
   * 那颗草稿。两者都没有 = `null`（比如当前只开着一颗工具标签 —— 单标签模式下切到工具
   * 标签就会这样）。
   *
   * 下面那批不带 `Of` 的动作都是绑上它的薄壳，供快捷键 / 命令面板 / 外壳用；标签自己的
   * 操作一律走 `xxxOf(标签 key, …)`。
   */
  const draftTab = useDraftTabKey()
  const sessionKey = useTabOfConversation(app.activeConversationId) ?? draftTab
  const activePanel = sessionKey ? panelSessions[sessionKey] : undefined
  const sideTab = activePanel?.sideTab ?? null
  /**
   * 读任意标签的面板现场：分屏 / 多标签下每个对话标签读自己那份（见 AppContextValue）。
   *
   * 读 ref 而不是 state，且依赖为空：命令式动作刚写完现场，订阅方可能由外部 store
   * （`panel-store` 的 sync lane）驱动先渲染一步，本组件还没重渲染、闭包仍是旧的 ——
   * 只有读 ref 才能看到最新现场。
   */
  const panelOf = useCallback(
    (key: string): PanelSession | undefined => panelSessionsRef.current[key],
    []
  )

  /**
 * 会话 / 工作区 id 列表（join 成字符串）：给面板回收 effect / `patchPanelOf` 当依赖用。
 *
 * `app.conversations` / `app.workspaces` 每次渲染都是新引用，直接进依赖会让 memo 永远失效；
 * 而内容相同的两次渲染 join 出来是同一个字符串，所以它既稳定又精确。
 */
const conversationIdList = app.conversations.map((c) => c.id).join('\n')
const workspaceIdList = app.workspaces.map((w) => w.id).join('\n')
/**
 * 工作区 id + 目录（join 成字符串）：`cwd` 要跟着工作区目录变，光看 id 列表不够
 * （新建 / 导入的项目会先出现在列表里、路径稍后才填上）。
 */
const workspacePathList = app.workspaces.map((w) => `${w.id}=${w.path ?? ''}`).join('\n')
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
   * 按**标签指向的会话**取工作区：非当前标签的现场也得按它自己所属的工作区建（否则
   * 文件树 / 终端会挂到错误的工作区上）。草稿标签没有会话，落到现场已有的 / 当前选中的。
   */
  function blankPanelFor(tabKey: string): PanelSession {
    // 工作区 / cwd 的解析统一走纯函数（列表没就绪时会得到 null，见下面补算的 effect）
    const { workspaceId, cwd } = resolvePanelWorkspace(
      conversationOfTab(tabKey) ?? null,
      '',
      app.conversations,
      app.workspaces,
      app.activeWorkspaceId
    )
    return {
      id: `panel-${++panelSeq}`,
      workspaceId,
      cwd,
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
   * 改**指定标签**的面板现场（该标签还没有现场就按它自己的工作区建一个）。
   *
   * 这是所有面板变更的**唯一入口**：当前会话那批动作（`patchActivePanel` /
   * `showSideTab` / `toggleSideTab` / `closeSideTab` / `collapseSidePanel` /
   * `toggleSidePanel`）都只是它绑上 `sessionKey` 的薄壳；再由 `xxxOf(key, …)` 显式指向
   * 某个标签 —— 否则「在 A 标签点终端」会误改当前会话的现场。
   *
   * `key` 为 `null`（当前会话没有承载它的标签）= 什么都不做：没有标签就没有现场可改。
   * `fn` 原样返回入参（`next === base`）或返回 `null` = 本次无变化，**不落库**：
   * 「收起一个本来就收着的面板」不该凭空建出一个空现场。
   */
  const patchPanelOf = useCallback(
    (key: string | null, fn: (base: PanelSession) => PanelSession | null): void => {
      if (!key) return
      commitPanelSessions((prev) => {
        const base = prev[key] ?? blankPanelFor(key)
        const next = fn(base)
        if (!next || next === base) return prev
        return { ...prev, [key]: next }
      })
    },
    // blankPanelFor 每次渲染都是新引用，但它只读 app 的当前值 —— 用这几条稳定串驱动即可
    // （`workspacePathList` 也要在：路径晚于工作区 id 到达时，新建现场得拿到新路径）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationIdList, workspaceIdList, workspacePathList, app.activeWorkspaceId]
  )

  /**
   * 工作区 / 会话列表比首屏晚到：`activeWorkspaceId` 是**同步**从 localStorage 恢复的，
   * 首次渲染时 `app.workspaces` 还是空数组，`blankPanelFor` 于是把现场建成 `cwd: null`。
   * 这个空路径会一直缓存在 `panelSessions` 里 —— 表现就是「刷新后停在某个工作区，点终端
   * 没反应（`openTerminalTabOf` 拿不到 cwd 直接放弃）；切到别的工作区再切回来才好」
   * （切回来时列表已经加载完，新现场能拿到路径）。
   *
   * 列表一到就把现场补算一次。两种情况要修：
   * - `cwd` 为空（列表晚到 / 建现场那一刻还解析不出来）；
   * - 现场绑的 `workspaceId` **已经不在清单里**（旧临时工作区被丢弃、项目被删）——
   *   只看「cwd 非空就跳过」的话，这种现场会一直挂着一条死路径，点终端后 PTY 在
   *   不存在的目录里起不来（用户看到的还是「打不开」）。
   *
   * ⚠️ 这段逻辑 web / desktop 的 `packages/agent-kit/src/shell/app-provider.tsx` 里也有
   * 一份（手机壳的 Provider 是同一套实现）。改这里时两边一起改 —— 之前终端修复只改了
   * 那边，手机端仍然是旧逻辑，于是「刷新后点终端打不开」在手机上一修就是好几天。
   */
  useEffect(() => {
    commitPanelSessions((prev) => {
      const known = new Set(app.workspaces.map((w) => w.id))
      let changed = false
      const next: Record<string, PanelSession> = {}
      for (const [key, panel] of Object.entries(prev)) {
        if (panel.cwd && known.has(panel.workspaceId)) {
          next[key] = panel
          continue
        }
        const resolved = resolvePanelWorkspace(
          conversationOfTab(key) ?? null,
          panel.workspaceId,
          app.conversations,
          app.workspaces,
          app.activeWorkspaceId
        )
        if (!resolved.cwd) {
          next[key] = panel
          continue
        }
        if (resolved.cwd === panel.cwd && resolved.workspaceId === panel.workspaceId) {
          next[key] = panel
          continue
        }
        next[key] = { ...panel, workspaceId: resolved.workspaceId, cwd: resolved.cwd }
        changed = true
      }
      return changed ? next : prev
    })
    // app 每次渲染都是新引用，用这几条稳定串驱动（内容不变就不重跑）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePathList, conversationIdList, app.activeWorkspaceId])

  /**
   * 「新对话」页换了目标工作区 → 把草稿面板的**归属**跟着换（只改归属，现场不动）。
   *
   * 与 web / desktop 的 `packages/agent-kit/src/shell/app-provider.tsx` 同一份逻辑：
   * 草稿标签的 key 是稳定的身份，现场挂在它下面；`activeWorkspaceId` 一变（工作区入口
   * 换项目 / 点开别的工作区的对话 / 发消息时服务端建临时工作区）不能让现场换地方，
   * 否则右侧面板整块卸载、终端 PTY 被 kill（「终端被替换或关闭，历史全没了」）。
   * 改动必须两边一起做。
   */
  const draftWorkspaceRef = useRef(app.activeWorkspaceId)
  useEffect(() => {
    const prev = draftWorkspaceRef.current
    draftWorkspaceRef.current = app.activeWorkspaceId
    if (prev === app.activeWorkspaceId) return
    if (!draftTab) return
    const nextId = app.activeWorkspaceId ?? ''
    const nextCwd = app.workspaces.find((w) => w.id === nextId)?.path ?? null
    commitPanelSessions((prevSessions) => {
      const panel = prevSessions[draftTab]
      if (!panel) return prevSessions
      const next = retargetPanelWorkspace(panel, nextId, nextCwd)
      return next === panel ? prevSessions : { ...prevSessions, [draftTab]: next }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.activeWorkspaceId, draftTab])

  /**
   * 关掉**指定会话**的某个标签（内容随之卸载：该条终端会话被掐、文件树的展开状态丢掉）。
   * 正看着它就切到另一个还挂着的标签；一个都不剩才把面板收起来 —— 与根应用同一套兜底，
   * 免得「关掉 A 却把还开着的 B 一起收了」。
   */
  const closeSideTabOf = useCallback(
    (key: string | null, tabKey: PanelTabKey): void => {
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
  // 与桌面壳一致：当前会话没有承载标签时 key 为 null，由 patchPanelOf 原样忽略。
  const showSideTabOf = useCallback(
    (key: string | null, tabKey: PanelTabKey): void => {
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
    (sessionId: string | null, key: SideTabKey): void => {
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
    (key: string | null): void => {
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
    (key: string | null): void => {
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
  const chatStreaming = app.streaming
  useEffect(() => {
    // 没有承载当前会话的标签 = 没有现场可写（单标签模式下切到了工具标签）
    if (!sessionKey) return
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
   * 回收失效的面板现场：标签关了，它的现场就没。
   *
   * 与 web / desktop 同一条规则（那边有完整说明，别两边写出不同的判据）。手机是单标签
   * 模式，切到别的标签 = 旧标签被收起，所以它的现场也随之回收：切回来是全新的一份，
   * 不会列着一堆 PTY 早已不在的「死终端」。
   */
  const tabsVersion = useOpenTabsVersion()
  useEffect(() => {
    const open = new Set(openTabKeys())
    commitPanelSessions((prev) => {
      let changed = false
      const next: Record<string, PanelSession> = {}
      for (const [key, value] of Object.entries(prev)) {
        if (open.has(key)) next[key] = value
        else changed = true
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsVersion])

  /**
   * 面板宽度（`lib/panel-width.ts`）是**按会话**持久化的偏好，另按会话清单清。
   *
   * ⚠️ 必须等列表**真的加载完**（`conversationsLoaded`）才清：加载前 id 清单是空的，
   * 那会把 localStorage 里所有会话的宽度一次性误删 —— 页面一刷新全丢。
   */
  useEffect(() => {
    if (!app.conversationsLoaded) return
    prunePanelWidths([
      ...conversationIdList.split('\n').filter(Boolean),
      // 草稿的宽度记在常量作用域下，草稿标签开着就留着
      ...(draftTab ? [DRAFT_PANEL_SCOPE] : [])
    ])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationIdList, app.conversationsLoaded, draftTab])

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
   *
   * 返回 `null` = 目标现场没有可用目录、**没开成**。调用方要把 `null` 当失败提示，
   * 不能像以前那样返回一个「看起来开成了」的 id —— 快捷命令会干等 5 秒再报超时。
   */
  const openTerminalTabOf = useCallback(
    (
      targetKey: string | null,
      shellId?: string | null,
      container?: { workspaceId: string; shell?: string }
    ): string | null => {
      // 没有可挂的标签（单标签模式下当前是工具标签）= 开不成
      if (!targetKey) return null
      /*
        现场里的 cwd 可能是「工作区列表还没到」或「持久化的工作区已被丢弃」时留下的
        空值 / 旧路径。**点击这一刻再按最新数据解析一次**，且在 setState 之外算好结果 ——
        updater 里算的话，解析失败只能吞掉这次点击，调用方拿不到「没开成」。
      */
      const live = useAgentStore.getState()
      const existing = panelSessionsRef.current[targetKey]
      const resolved = resolveTerminalCwd(
        conversationOfTab(targetKey) ?? null,
        existing?.workspaceId,
        existing?.cwd,
        live.conversations,
        live.workspaces,
        live.activeWorkspaceId
      )
      // 没有工作区目录开不出终端（虚拟工作区里连入口都不渲染）
      if (!resolved) return null
      const id = `term-${++termSeqRef.current}`
      const tabKey = terminalTabKey(id)
      patchPanelOf(targetKey, (base) => {
        const panel: PanelSession =
          resolved.cwd === base.cwd && resolved.workspaceId === base.workspaceId
            ? base
            : { ...base, workspaceId: resolved.workspaceId, cwd: resolved.cwd }
        // 显式选了宿主 shell 就尊重它，不进容器（用户可能是要 docker 命令本身）
        const containerTarget =
          container ??
          (shellId === undefined &&
          !!panel.workspaceId &&
          containerWorkspaceIdList.split('\n').includes(panel.workspaceId)
            ? { workspaceId: panel.workspaceId }
            : undefined)
        const resolvedShell = shellId !== undefined ? shellId : getTerminalShell()
        const tab: TerminalTab = {
          id,
          shellId: resolvedShell,
          cwd: resolved.cwd,
          ...(containerTarget
            ? {
                containerWorkspaceId: containerTarget.workspaceId,
                ...(containerTarget.shell ? { containerShell: containerTarget.shell } : {})
              }
            : {})
        }
        return focusTab({ ...panel, terminals: [...panel.terminals, tab] }, tabKey)
      })
      return id
    },
    [patchPanelOf, containerWorkspaceIdList]
  )
  /**
   * 「当前该往哪份面板现场开终端」：按**焦点标签自己的**面板 key，而不是
   * `activeConversationId` 派生的 `sessionKey` —— 刷新 / 恢复期间两者会短暂错位
   * （草稿标签已挂出、当前会话还是旧的 / 反之），按 sessionKey 开终端会落进没挂出来的
   * 面板，`onReady` 永远不来，快捷命令只能 5 秒超时报错。
   *
   * 工具标签 / 没有标签时退回 `sessionKey`（当前会话那颗，没有就草稿那颗；都没有 = `null`）。
   */
  const terminalTargetKey = useCallback((): string | null => {
    const tab = activeTabKey()
    if (tab && isConversationTabKey(tab)) return tab
    return sessionKey
  }, [sessionKey])
  const openTerminalTab = useCallback(
    (shellId?: string | null): string | null => openTerminalTabOf(terminalTargetKey(), shellId),
    [openTerminalTabOf, terminalTargetKey]
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
    (key: string | null): void => {
      if (!key) return
      const panel = panelSessionsRef.current[key]
      if (isTerminalTabKey(panel?.sideTab)) {
        collapseSidePanelOf(key)
        return
      }
      const last = panel?.terminals[panel.terminals.length - 1]
      if (last) {
        showSideTabOf(key, terminalTabKey(last.id))
        return
      }
      if (!openTerminalTabOf(key)) {
        toast.error('这个工作区没有可用的目录，打不开终端')
      }
    },
    [collapseSidePanelOf, showSideTabOf, openTerminalTabOf]
  )
  const toggleTerminalPanel = useCallback(
    (): void => toggleTerminalPanelOf(terminalTargetKey()),
    [toggleTerminalPanelOf, terminalTargetKey]
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
      /*
       * 没开成要说清原因：以前不管开没开成都返回一个 id，这里只会干等 5 秒再报
       * 「终端打开超时」—— 真正的原因（工作区目录没了）被完全盖住。
       */
      if (!id) throw new Error('这个工作区没有可用的目录，打不开终端')
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

  const value: AppContextValue = {
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
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
