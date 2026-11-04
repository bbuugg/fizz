"use client";

/**
 * 应用级状态的**形状**：`AppContextValue` 接口 + context 本体 + `useAppContext()`。
 *
 * ⚠️ 这里**没有 Provider 实现**（那个在 `app/app-provider.tsx`）。
 * 拆开的理由：`features/*` 的组件全都要 `useAppContext()`，而 Provider 要读视图状态、
 * 面板现场、终端进程表 —— 属于「应用装配」。两者放同一个文件时，领域组件就依赖了
 * 应用装配层（`shared → app` 反向依赖），拆包后方向是反的。
 *
 * 依赖方向：`features/* → shared/hooks/use-app-context`（本文件）← `app/app-provider`
 *
 * 导航原则：**没有前端路由**，也**没有第二块主视图**。地址栏恒为 `/`，主区域只有
 * `PanelView` 一套多标签面板；「打开某个对象」= 选中它（会话 / 标签），不再有「切视图」
 * 这一步，也就没有「URL 与状态对不上」这类问题。
 *
 * ⚠️ 这里曾经有 `view: 'chat' | 'flow'` 与 `flow` 数据层：流程功能整个删掉之后，主区域
 * 只剩对话一块，`view-state.ts` 也一并删了。**别再为了「以后可能加视图」把它加回来** ——
 * 单视图时那层状态唯一的作用是让每个入口都多写一句 `setActiveView('chat')`。
 */
import { createContext, useContext } from 'react'
import type { ShellDetectResult } from '@fizz/shells'
import type { WorkspaceConfigSnapshot } from '@fizz/contracts/workspace-config'
import { useAgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useTheme } from '@fizz/agent-kit/shared/hooks/useTheme'
import { useTriggers } from '@fizz/agent-kit/shared/hooks/useTriggers'
import type { NewInWorkspaceKind } from '@fizz/agent-kit/shared/lib/new-in-workspace'
import type { TerminalProcess } from '@fizz/agent-client/web-host'
import type { PanelSession, PanelTabKey, SideTabKey } from '@fizz/agent-kit/shared/lib/panel-session'

/**
 * 「新建弹窗」的目标种类 —— 直接复用侧栏的 `NewInWorkspaceKind`：
 * 两边本来描述的就是同一批入口（会话 / 协作 / 工作区），
 * 之前各写一份字面量联合，新增一项就要改三处、漏一处就是类型报错或弹错窗。
 */
export type NewDialogKind = NewInWorkspaceKind

export interface AppContextValue {
  /** 数据层（连接 / 工作区 / 会话 / 消息 / 模型 / 技能…） */
  app: ReturnType<typeof useAgentApp>
  /** 主题（亮 / 暗 / 跟随系统）与切换 */
  themeMode: ReturnType<typeof useTheme>['mode']
  theme: ReturnType<typeof useTheme>['theme']
  setThemeMode: ReturnType<typeof useTheme>['setMode']
  toggleTheme: () => void
  /** 定时任务的数据层 */
  triggers: ReturnType<typeof useTriggers>
  /**
   * 打开一个会话（侧栏点行 / 弹窗建成功后调用）：选中 + 把标签落到位。
   *
   * `opts.keepScroll`：别复位消息区的滚动位置 —— **只给「切标签」用**（那条会话的面板
   * 一直在内存里，用户翻到哪儿该留在哪儿）。从侧栏 / 通知 / 深链打开不要传，那时
   * 「跳到最新」才是用户要的。
   */
  openConversation: (
    conversationId: string,
    workspaceId?: string,
    opts?: { keepScroll?: boolean },
  ) => void
  /**
   * 删除会话（当前会话被删时由 store 把落点落到同工作区最近一条 / 空态）。
   * 返回**是否真删掉了**：失败时弹窗不该关，留给用户重试。
   */
  deleteConversation: (conversationId: string) => Promise<boolean>
  /** 项目树「新建」弹窗的目标（状态放这里天然互斥） */
  newTarget: {
    kind: NewDialogKind
    workspaceId: string
  } | null
  openNewDialog: (kind: NewDialogKind, workspaceId: string) => void
  closeNewDialog: () => void
  /**
   * 「打开设置并落到某个分组」的请求 —— **只有 `apps/mobile` 会用到非 null 值**
   * （它的设置是整页 `SettingsPage`，需要「请求了哪一页」来决定首屏落点）。
   *
   * web / desktop 里设置就是主区域的一条标签，分组请求直接写进标签登记表
   * （`ToolTab.settingsTab`），所以 `settingsTab` 恒为 `null`、`clearSettingsTab`
   * 是空操作。别在 web 侧又照着「读到 settingsTab 就开弹窗」写一遍。
   */
  settingsTab: 'models' | 'acp' | null
  openSettingsTab: (tab: 'models' | 'acp') => void
  clearSettingsTab: () => void
  /** 会话面板现场（终端 / 文件 / git）——跨导航存活的部分 */
  sessionKey: string
  /** **当前会话**的面板现场（= `panelOf(sessionKey)`；命令面板 / 快捷键读它） */
  activePanel: PanelSession | undefined
  patchActivePanel: (patch: Partial<PanelSession>) => void
  /** 右侧面板正显示哪个标签 key（null = 面板收起；命令面板 / 快捷键 / 顶栏按钮都读它） */
  sideTab: PanelTabKey | null
  /**
   * 顶栏「文件 / 源码管理」按钮的统一行为：**正看着这个标签就收起面板，否则切到它**。
   * 终端不在其中（它可以有多条，走 `toggleTerminalPanel`）。
   */
  toggleSideTab: (key: SideTabKey) => void
  /** 挂出并切到某个面板标签（不收起）—— 「关掉一个终端后切到下一个」这类场景用 */
  showSideTab: (key: PanelTabKey) => void
  /** 关掉标签（内容卸载）：正看着它就切到别的标签，一个都不剩才收起面板 */
  closeSideTab: (key: PanelTabKey) => void
  /**
   * 新开一条终端标签并切过去，返回它的标签 id（进程表 / 就绪桥按它索引）。
   * `shellId` 不传 = 用上次打开终端时记住的 shell（没有就平台默认）；显式传（含 null）就用它。
   */
  openTerminalTab: (shellId?: string | null) => string
  /** 顶栏「终端」主按钮：正看着某个终端就收起；否则回到最后一个终端，一条都没有就新开一条 */
  toggleTerminalPanel: () => void
  /** 收起面板（一个标签都不关） */
  collapseSidePanel: () => void
  /** 收起 / 恢复到上次看的标签（顶栏最右那个「门」按钮） */
  toggleSidePanel: () => void
  /** TerminalPanel 就绪回调：按**终端标签 id** 把 PTY 进程登记进来（快捷命令要往里写） */
  handleTerminalReady: (terminalTabId: string, proc: TerminalProcess) => void
  /**
   * 手机形态的侧栏抽屉开合。⚠️ 这是**唯一**那份状态（模块级，见 `mobile-sidebar.ts`）：
   * 活动栏竖条在不在由它派生，**不要**在这里再挂第二份。上下文只是把它透出去，
   * 让对话工具条的汉堡按钮 / 功能区图标 / 顶栏按钮共用同一个开关。
   */
  mobileSidebarOpen: boolean
  setMobileSidebarOpen: (open: boolean) => void
  /** 入口图标右上角的 git 改动数 badge（null = 不显示） */
  gitBadge: string | null
  /**
   * 关掉**指定会话**的某个面板标签（而不是「当前会话的」）。
   *
   * 为什么需要：多标签 / 分屏后每个会话各有一份面板，别的会话的面板虽然不在焦点上，
   * 但快捷键 / 命令面板 / 它自己的顶栏仍可能去操作它；那时必须改**它自己**那个会话的，
   * 不能误改当前会话正看着的那个。
   */
  closeSideTabOf: (key: string, tabKey: PanelTabKey) => void
  /**
   * 读**指定会话**的面板现场（没有现场时 `undefined`）。
   *
   * 每个对话标签渲染自己的顶栏 / 右侧面板时要读它自己那份现场，而不是「当前会话的」
   * —— 分屏下同时有好几个会话可见，读当前会话那份会串。
   */
  panelOf: (key: string) => PanelSession | undefined
  /** 改指定会话的面板现场（`fn` 原样返回入参 / 返回 null = 无变化，不落库） */
  patchPanelOf: (key: string, fn: (base: PanelSession) => PanelSession | null) => void
  /** 挂出并切到指定会话的某个面板标签 */
  showSideTabOf: (key: string, tabKey: PanelTabKey) => void
  /** 指定会话的「文件 / 源码管理」按钮语义：正看着就收起，否则挂出并切过去 */
  toggleSideTabOf: (key: string, tabKey: SideTabKey) => void
  /** 收起指定会话的面板（一个标签都不关） */
  collapseSidePanelOf: (key: string) => void
  /** 收起 / 恢复指定会话的面板（回到上次看的那个标签） */
  toggleSidePanelOf: (key: string) => void
  /**
   * 在指定会话里新开一条终端并切过去，返回标签 id。
   *
   * `shellId` 显式给了 = 要宿主那个 shell；`container` 给了 = 要容器内终端；
   * 两个都不给 = 按项目类型默认（容器型项目进容器，其余走宿主默认 shell）。
   */
  openTerminalTabOf: (
    key: string,
    shellId?: string | null,
    container?: { workspaceId: string; shell?: string }
  ) => string
  /** 指定会话的顶栏「终端」主按钮语义 */
  toggleTerminalPanelOf: (key: string) => void
  /**
   * 「新对话」占位标签被第一条消息建出的真实会话**就地替换**：把草稿那份面板现场
   * 交给新会话（终端 / 文件现场不丢）。
   *
   * ⚠️ 只有**就地替换**这一条路径该调它（`PanelView` 里 `activeTabKey() === NEW_TAB_KEY`
   * 那一支 —— 草稿正被看着、第一条消息把它换成真实会话；旁边还开着别的标签也算）。
   * 别改成「当前会话一变就把草稿现场交给它」—— 那正是老实现的做法：用户在草稿标签里
   * 开着终端，只要点了别的会话标签，现场就被搬到那个会话上（草稿标签反而空了）。
   */
  adoptDraftPanel: (conversationId: string) => void
  /** 「执行命令」类快捷操作：**每次都新开一条终端**跑（不占用已有的终端） */
  runQuickCommand: (command: string) => Promise<void>
  /** 工作区快捷功能（.fizz/workspace.json） */
  quickSnapshot: WorkspaceConfigSnapshot | null
  saveQuickConfig: (
    workspaceId: string,
    config: {
      version: number
      defaultTerminal: string | null
      quickActions: WorkspaceConfigSnapshot['config']['quickActions']
      approvedCommands: string[]
    }
  ) => Promise<void>
  /** 强制重拉某个工作区的配置快照（快捷功能弹窗打开时用，防陈旧覆盖） */
  refreshQuickConfig: (workspaceId: string) => Promise<void>
  quickManageOpen: boolean
  setQuickManageOpen: (open: boolean) => void
  /** 可选 shell 清单（终端「选择终端」菜单用） */
  terminalShells: ShellDetectResult | null
  /** 上次打开终端时记住的 shell id（null = 平台默认） */
  terminalShellId: string | null
  /** 「新终端默认用哪个 shell」= 记住的那个（null = 平台默认）；顶栏菜单打勾用 */
  defaultTerminalShellId: string | null
  /** 派生：当前工作区有没有目录 / 是不是虚拟工作区 */
  hasDirectory: boolean
  hasWorkspace: boolean
  canTerminal: boolean
}

export const AppContext = createContext<AppContextValue | null>(null)

/** 各页面 / 外壳取应用状态。必须在 `AppProvider` 之下使用。 */
export function useAppContext(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useAppContext 必须在 <AppProvider> 内使用')
  return value
}
