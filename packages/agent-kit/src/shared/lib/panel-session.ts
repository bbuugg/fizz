/**
 * 会话面板现场（终端 / 工作区文件 / 源代码管理）的**类型与纯函数**。
 *
 * 从 `shared/hooks/use-app-context` 抽出来的：Provider 只负责持有状态，
 * 这些类型与推导函数被 `features/*` 直接引用 —— 留在 Provider 文件里会让
 * 「领域组件」依赖「应用装配层」，拆包时方向是反的（见 docs/architecture/frontend-split.md）。
 *
 * 这里**只有纯函数**，不 import react、不碰任何 store。
 */

/**
 * 面板里「种类固定」的标签：工作区文件 / 源代码管理 / 浏览器画面 / 容器预览。
 *
 * 终端**不在此列**：一个会话可以开多条终端，每条有自己的 key（见 `terminalTabKey`）——
 * 若把终端也塞进这个联合，两条终端就会撞成同一个 key。
 *
 * `preview` 只有**容器型项目**的会话才挂得出来（顶栏那颗按钮也只在那种项目下出现）：
 * 一个项目一条预览，跟着工作区走，不按会话区分。
 */
export type SideTabKey = 'files' | 'git' | 'browser' | 'preview'

/** 面板标签的**实际 key**：`files` / `git` 就是自身；每条终端是 `terminal:<id>` */
export type PanelTabKey = string

/** 终端标签 key 前缀（用来把终端标签和 files / git 区分开） */
const TERMINAL_TAB_PREFIX = 'terminal:'

/** 由终端标签 id 拼出它在面板里的 key */
export function terminalTabKey(id: string): string {
  return `${TERMINAL_TAB_PREFIX}${id}`
}

/** 这个面板 key 是不是终端标签 */
export function isTerminalTabKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(TERMINAL_TAB_PREFIX)
}

/**
 * 一条终端标签：每条规定一条 PTY。
 * 一个会话可以开多条 —— 「执行命令」类快捷操作每次都新开一条，顶栏「选择终端」选谁开谁。
 *
 * 终端跑在**服务端那台机器**上：默认是宿主的本机 shell；容器型项目可以开**容器内**的
 * 终端（`containerWorkspaceId` 非空 → 服务端把 spawn 换成 `docker exec`）。
 * 连远端 SSH 主机的终端**不在这份面板里**：它在主区域占一个内容标签（`host:<hostId>`，
 * 见 `app/layout/tool-tabs.ts`），因为它必须能和对话标签并排、一起拖拽分屏。
 */
export interface TerminalTab {
  /** 标签 id（`term-N`，全局自增不撞）：进程表 / 就绪桥 / 面板 key 都用它 */
  id: string
  /** 这条终端用的 shell（null = 跟随平台默认；容器终端不参与） */
  shellId: string | null
  /** 工作目录（建标签时按面板现场定下，之后不变；容器终端里是宿主路径，仅作展示） */
  cwd: string
  /**
   * 容器型项目的终端：目标**工作区 id**（服务端据此现算容器名并校验）。
   * 缺省 = 宿主本机终端。**不存容器名** —— `fizz-proj-<slug>` 这条约定只在服务端有一份。
   */
  containerWorkspaceId?: string
  /** 容器内 shell（缺省 `/bin/bash`）；只有容器终端有意义 */
  containerShell?: string
}

/** 一个会话各自的「面板现场」（若干终端 + 工作区文件 + 源代码管理）。 */
export type PanelSession = {
  /** 面板实例 id（稳定；渲染 key 用它，迁移 / 改 map key 时不重挂组件） */
  id: string
  /** 该会话所属工作区 */
  workspaceId: string
  /** 该工作区目录（无目录 = null，终端不可用） */
  cwd: string | null
  /**
   * 面板正显示哪个标签（null = 面板**收起**）。
   *
   * 收起不关标签：文件 / git 的挂出标记保持 true、终端标签也都还在，各自的 PTY 更还活着
   * —— 所以这里一个字段就替掉了原来的「三个 open 布尔」。
   */
  sideTab: PanelTabKey | null
  /** 收起前面看的那个标签：再展开时回到它（「门」按钮来回点不会丢现场） */
  lastSideTab: PanelTabKey | null
  /** 标签的**打开顺序**（标签条按它排）；新开的排到最后 */
  tabOrder: PanelTabKey[]
  /** 该会话开着的终端标签（顺序 = 打开顺序；数组里有它就等于「终端已挂出」） */
  terminals: TerminalTab[]
  /** 文件 / 源码管理是否已挂出（挂出 = 内容常驻） */
  filesMounted: boolean
  gitMounted: boolean
  /** 浏览器画面面板是否已挂出（挂出 = 连接 screencast WS，常驻） */
  browserMounted: boolean
  /** 容器型项目的预览面板是否已挂出（挂出 = webview 常驻，切标签不重载页面） */
  previewMounted: boolean
  /**
   * 该会话工作区的 git 改动数（null = 不是仓库 / 还没查到）—— 入口图标右上角的 badge。
   * 两个来源：面板开着时由面板回报；**任务结束**时由这里自己查一次（面板没开也要有数字）。
   */
  gitChanges: { count: number; truncated: boolean } | null
  /**
   * 该会话工作区当前的分支名（null = 不是仓库 / 还没查到）—— 顶栏名字下面那一行。
   * 与 `gitChanges` 同一次请求带回来，不额外打接口。
   */
  gitBranch: string | null
}

/** 某个面板标签是否「已挂出」：终端看 terminals 列表，其余看各自的挂出标记 */
export function isTabMounted(panel: PanelSession, key: PanelTabKey): boolean {
  if (isTerminalTabKey(key)) return panel.terminals.some((t) => terminalTabKey(t.id) === key)
  if (key === 'browser') return panel.browserMounted
  if (key === 'preview') return panel.previewMounted
  return key === 'files' ? panel.filesMounted : panel.gitMounted
}

/** 挂出 files / git / browser / preview（已挂出时原样返回，避免无谓的新对象） */
export function withMounted(panel: PanelSession, key: SideTabKey): PanelSession {
  if (key === 'browser') return panel.browserMounted ? panel : { ...panel, browserMounted: true }
  if (key === 'preview') return panel.previewMounted ? panel : { ...panel, previewMounted: true }
  if (key === 'files') return panel.filesMounted ? panel : { ...panel, filesMounted: true }
  return panel.gitMounted ? panel : { ...panel, gitMounted: true }
}

/** 摘掉 files / git / browser / preview（内容随之卸载） */
export function withoutMounted(panel: PanelSession, key: SideTabKey): PanelSession {
  if (key === 'browser') return panel.browserMounted ? { ...panel, browserMounted: false } : panel
  if (key === 'preview') return panel.previewMounted ? { ...panel, previewMounted: false } : panel
  if (key === 'files') return panel.filesMounted ? { ...panel, filesMounted: false } : panel
  return panel.gitMounted ? { ...panel, gitMounted: false } : panel
}

/** 改「面板正在看哪个标签」，顺带记住刚离开的那个（收起后展开能回到它） */
export function withSideTab(panel: PanelSession, next: PanelTabKey | null): PanelSession {
  if (next === null)
    return panel.sideTab === null ? panel : { ...panel, sideTab: null, lastSideTab: panel.sideTab }
  return { ...panel, sideTab: next, lastSideTab: next }
}

/**
 * 「挂出 + 切过去」。终端标签在 `openTerminalTab` 里就已经进了 `terminals`（等于已挂出），
 * 这里只补一下 `tabOrder`；文件 / git 才需要 toggle 挂出标记。
 */
export function focusTab(panel: PanelSession, key: PanelTabKey): PanelSession {
  let next = isTerminalTabKey(key) ? panel : withMounted(panel, key as SideTabKey)
  if (!next.tabOrder.includes(key)) next = { ...next, tabOrder: [...next.tabOrder, key] }
  return withSideTab(next, key)
}

/** 标签条的顺序：`tabOrder` 里记过的按记录排，没记到的按固定顺序补在后面 */
export function orderTabs(panel: PanelSession, tabs: PanelTabKey[]): PanelTabKey[] {
  return [...tabs].sort((a, b) => {
    const ia = panel.tabOrder.indexOf(a)
    const ib = panel.tabOrder.indexOf(b)
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib)
  })
}

/** 现在还挂着的面板标签（按标签条顺序）—— 关标签 / 恢复现场时的兜底用 */
export function aliveTabs(panel: PanelSession): PanelTabKey[] {
  return orderTabs(panel, [
    ...panel.terminals.map((t) => terminalTabKey(t.id)),
    ...(panel.browserMounted && panel.workspaceId ? ['browser'] : []),
    ...(panel.previewMounted && panel.workspaceId ? ['preview'] : []),
    ...(panel.filesMounted && panel.workspaceId ? ['files'] : []),
    ...(panel.gitMounted && panel.workspaceId ? ['git'] : [])
  ])
}

/** 「草稿态」（还没建会话）的面板 key 前缀：离开即回收，避免常驻面板泄漏 */
const DRAFT_PREFIX = 'draft:'

/**
 * 「新对话」占位标签（`NEW_TAB_KEY`）的面板现场 key：`draft:<工作区>`。
 *
 * ⚠️ 它**只由工作区决定**，绝不能跟着 `activeConversationId` 走 —— 「面板现场挂在哪个
 * key 下」必须由**这个标签是谁**决定。`ConversationTab` 以前写的是
 * `conversationId ?? sessionKey`，而 `sessionKey` 是「当前会话」：于是「新对话」标签的
 * key 会跟着当前会话跑，切一下标签，它的面板就串到别的会话上（现场被抢走、面板看起来
 * 「自己收起了」）。现在标签那边直接用这个函数算，两边同一个来源。
 *
 * 工作区**在标签切换时不会变**（`openConversation` 不动 `activeWorkspaceId`），所以
 * 同一个工作区里来回切标签，这个 key 是稳定的。
 */
export function draftPanelKey(workspaceId: string | null | undefined): string {
  return `${DRAFT_PREFIX}${workspaceId ?? ''}`
}

/** 这个面板 key 是不是「草稿态」 */
export function isDraftPanelKey(key: string): boolean {
  return key.startsWith(DRAFT_PREFIX)
}

/**
 * 面板现场该挂到哪个工作区、拿哪条目录：**会话自己的** > 现场已有的 > 当前选中的。
 *
 * ⚠️ 为什么必须有这层「事后可重算」的解析：`activeWorkspaceId` 是同步从 localStorage
 * 恢复的，而 `workspaces` 列表是异步拉回来的 —— 首帧里建出来的现场只能拿到
 * `cwd: null`（工作区还不在列表里）。这个空路径一旦写进现场就会被缓存，表现为
 * 「刷新后停在某个工作区，点终端没反应；切走再切回来才好」。工作区 / 会话列表到达后
 * 用本函数把缺目录的现场补算一次即可。
 *
 * ⚠️ 候选要**取第一个仍在清单里的**，不能只认优先级最高的那个：持久化的
 * `activeWorkspaceId` / 现场里的 `workspaceId` 可能指向已经被删掉的工作区（旧临时
 * 工作区被丢弃、项目被删）。只认最高优先级的话，解析结果永远是空路径 —— 补算也救不回来。
 * 清单还没到（一个都不在）时保留最高优先级的 id，`cwd` 留给下一次补算。
 */
export function resolvePanelWorkspace(
  key: string,
  panelWorkspaceId: string | null | undefined,
  conversations: readonly { id: string; workspaceId: string | null }[],
  workspaces: readonly { id: string; path: string | null }[],
  activeWorkspaceId: string | null | undefined
): { workspaceId: string; cwd: string | null } {
  // 候选按优先级排队；空串（历史数据）当作没有
  const candidates = [
    conversations.find((c) => c.id === key)?.workspaceId,
    panelWorkspaceId,
    activeWorkspaceId
  ].filter((id): id is string => !!id)
  const known = candidates.find((id) => workspaces.some((w) => w.id === id))
  const workspaceId = known ?? candidates[0] ?? ''
  return {
    workspaceId,
    cwd: workspaces.find((w) => w.id === workspaceId)?.path ?? null
  }
}

/**
 * 把「新对话」草稿的面板现场并进目标会话的现场（目标已存在时**不能整份覆盖**）。
 *
 * 什么时候目标会有现场：刷新 / 切会话时，后台动作（典型是 `gitStatus` 回来后的
 * `patchActivePanel`）可能先给目标会话建出一个**空壳**。旧实现遇到这种就直接放弃迁移
 * （`if (sessions[conversationId]) return`），于是草稿里刚开出来的终端留在没人认领的
 * 草稿 key 上，随后被回收 effect 连 PTY 一起清掉 —— 用户看到的就是「终端闪一下、
 * 或者点了没反应」（刷新后点终端的主力现象）。
 *
 * 这里把草稿那份**合并**进来：终端按 id 去重拼接、挂出标记取并集、正看着的标签优先
 * 用草稿的（用户刚在草稿里点开终端，要接着看它）。目录 / 归属只在目标还没有时补。
 */
export function mergeDraftPanel(existing: PanelSession, draft: PanelSession): PanelSession {
  const terminals = [...existing.terminals]
  for (const t of draft.terminals) {
    if (!terminals.some((x) => x.id === t.id)) terminals.push(t)
  }
  const tabOrder = [...existing.tabOrder]
  for (const k of draft.tabOrder) {
    if (!tabOrder.includes(k)) tabOrder.push(k)
  }
  return {
    ...existing,
    ...(existing.cwd ? {} : { workspaceId: draft.workspaceId, cwd: draft.cwd }),
    terminals,
    tabOrder,
    // 正看着的标签：草稿里开着终端 / 文件面板就接着看它，否则保持目标的
    sideTab: draft.sideTab ?? existing.sideTab,
    lastSideTab: draft.lastSideTab ?? existing.lastSideTab,
    filesMounted: existing.filesMounted || draft.filesMounted,
    gitMounted: existing.gitMounted || draft.gitMounted,
    browserMounted: existing.browserMounted || draft.browserMounted,
    previewMounted: existing.previewMounted || draft.previewMounted
  }
}

/**
 * 「点开终端」这一刻解析最终要用的目录（两条 provider，一个口径）。
 *
 * 为什么要单独一个函数：这条判断以前**在 `openTerminalTabOf` 的 setState updater 里**
 * （`if (!base.cwd) return null`），而 `base` 是上次渲染建出来的现场 —— 刷新后工作区
 * 列表还没落地时建成的现场会把 `cwd: null` **永久缓存**，于是之后每次点终端都静默
 * 什么都不做、快捷命令等到 5 秒超时，用户看到的正是「刷新后终端打不开」。
 *
 * 现在改成**点击这一刻**按最新数据重算：
 * - 先用 `resolvePanelWorkspace` 的优先级重新解析（会话自己的工作区 > 现场 > 当前选中）；
 * - 解析不到新路径时退回现场里已有的 `panelCwd`（工作区列表暂时没到也别把点击吞掉）。
 *
 * 返回 `null` = **确实没有可用的目录**（虚拟工作区 / 工作区与目录都没了）。调用方必须
 * 把 `null` 当「失败」并给出提示，绝不能静默返回 —— 那会退化成那个 5 秒超时。
 */
export function resolveTerminalCwd(
  key: string,
  panelWorkspaceId: string | null | undefined,
  panelCwd: string | null | undefined,
  conversations: readonly { id: string; workspaceId: string | null }[],
  workspaces: readonly { id: string; path: string | null }[],
  activeWorkspaceId: string | null | undefined
): { workspaceId: string; cwd: string } | null {
  const resolved = resolvePanelWorkspace(
    key,
    panelWorkspaceId,
    conversations,
    workspaces,
    activeWorkspaceId
  )
  const cwd = resolved.cwd ?? panelCwd ?? null
  if (!cwd) return null
  // 只有解析出了新路径才认新的归属；退回现场 cwd 时保持现场的工作区不变
  return {
    workspaceId: resolved.cwd ? resolved.workspaceId : (panelWorkspaceId || resolved.workspaceId),
    cwd
  }
}
