"use client";

/**
 * 一个对话标签的内容：工作区工具条（`ViewHeader`）+ 对话面板（`ChatPanel`）+
 * 该会话自己的右侧多标签面板（终端 / 工作区文件 / 源代码管理 / 浏览器）。
 *
 * ## 与旧 `ChatView` 的关系
 *
 * 旧实现是「**一个**主区域视图」：右侧面板只有**一个**可见槽位，别的会话的面板要
 * `parked`（隐藏但不卸载）才能保住终端 / 文件树现场。主区域改成多标签后，每个对话标签
 * **自带**一份面板，槽位不再共享 —— 于是那套 `parkedPanels` 记账可以整块去掉：
 * 标签自己的面板永远属于自己，不需要「停放」。
 *
 * ## 数据来源
 *
 * 对话数据（消息 / 流式 / 队列）走 `useAgentAppView(conversationId)` —— 它只换「看哪个
 * 会话」，**不挂任何副作用**（WS 绑定 / 自动恢复那些只在 `useAgentApp` 里挂一次）。
 * 唯一的例外是 `useAttachRemoteRun`：它管的是「**这一个**会话在服务端跑着、而本连接
 * 没有它的流」（别的端发起的轮次），判据天然是按标签的，所以挂在标签上。
 *
 * 面板现场（挂了哪些标签、正看哪个）走 `useAppContext()` 的**按会话**访问器
 * （`panelOf` / `xxxOf(key, …)`）：分屏下同时有好几个会话可见，读「当前会话那份」会串。
 *
 * ## 已知边界
 *
 * 顶栏里**工作区级**的入口（快捷功能、终端 shell 选择）读的是「当前工作区」的全局状态。
 * 同一工作区开多个对话标签时完全准确；若两个分屏标签来自**不同**工作区，非焦点那个的
 * 这两处菜单可能显示的是焦点标签的工作区 —— 第一版接受这个边界（切换标签会同步工作区）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Box,
  Check,
  ChevronDown,
  Files,
  GitBranch,
  Globe,
  MonitorPlay,
  PanelRightClose,
  PanelRightOpen,
  SquareTerminal
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { LiquidGlassButton } from '@fizz/ui/liquid-glass'
import { Skeleton } from '@fizz/ui/skeleton'
import { ChatPanel } from '@fizz/agent-kit/features/chat/ChatPanel'
import { CollabWorkspace } from '@fizz/agent-kit/features/collab/CollabWorkspace'
import { MobilePanelMenu } from '@fizz/agent-kit/features/chat/MobilePanelMenu'
import { FilesPanel } from '@fizz/agent-kit/features/files/FilesPanel'
import { GitPanel } from '@fizz/agent-kit/features/git/GitPanel'
import { SidePanel, useContainerWidth, type SidePanelTab } from '@fizz/agent-kit/features/chat/SidePanel'
import { TerminalPanel } from '@fizz/agent-kit/features/terminal/TerminalPanel'
import { BrowserPane } from '@fizz/agent-kit/features/chat/BrowserPane'
import { PreviewPane } from '@fizz/agent-kit/features/preview/PreviewPane'
import { ViewHeader } from '@fizz/agent-kit/shared/components/view-header'
import { WorkspaceQuickActions } from '@fizz/agent-kit/features/projects/WorkspaceQuickActions'
import {
  draftPanelKey,
  isTerminalTabKey,
  orderTabs,
  terminalTabKey
} from '@fizz/agent-kit/shared/lib/panel-session'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useAgentAppView, useAttachRemoteRun } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { setTerminalShell } from '@fizz/agent-kit/shared/lib/terminal-shell'
import { registerTabCloseGuard } from '@fizz/agent-kit/shared/lib/tab-close'
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { openExternal } from '@fizz/agent-client/web-host'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef
} from '@fizz/ui/resizable'
import {
  defaultCollabChatWidth,
  maxCollabChatWidth,
  minCollabChatWidth,
  resetCollabChatWidth,
  setCollabChatWidth,
  useCollabChatWidth
} from '@fizz/agent-kit/shared/lib/collab-chat-width'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'

/** 会话详情顶栏的快捷按钮：液态玻璃 + 紧凑尺寸（同终端悬浮球，见 `LiquidGlassButton`） */
const HEADER_GLASS_BUTTON =
  'inline-flex h-7 w-8 items-center justify-center rounded-md p-0 focus-visible:ring-2 focus-visible:ring-ring/50'

export function ConversationTab({
  conversationId,
  hostTabKey,
  active = true
}: {
  conversationId: string | null
  /**
   * 这个标签在**主区域标签条**里的 key（`PanelView` 传进来的）。守卫表按标签 key 索引：
   * 真实会话上它恰好等于 `conversationId`，而「新对话」占位标签的 key 是 `__new__`、
   * 会话 id 是 null —— 没有它就登记不上守卫（关 / 刷新那个草稿标签会静默杀掉它面板里的终端）。
   *
   * ⚠️ 叫 `hostTabKey` 而不是 `tabKey`：本文件下面侧栏那个 `tabs` 映射里有个**同名局部变量**
   * `tabKey`（那是侧栏标签的 key），沿用同名会被遮蔽（`TerminalPanel` 那边没有这层同名作用域，
   * 所以它叫 `tabKey`）。
   */
  hostTabKey: string
  /**
   * 这个标签是不是它所在组**当前显示的那一个**（`PanelContentLayer` 的 `owner.active`）。
   *
   * 标签内容一律常挂载，非活动标签只是 `hidden` 藏在原地 —— 所以「是不是这个面板在屏幕上」
   * 不能只看侧栏停在哪个标签（见下面 `gitVisible`）。缺省 `true`：单独渲染这个标签时
   * 按「正被看着」处理。
   */
  active?: boolean
}) {
  // 订阅语言：顶栏 / 侧栏标签 / 确认框的文案都在渲染期用 `t()` 现算
  const tr = useT()
  const ctx = useAppContext()
  const {
    terminalShells,
    defaultTerminalShellId,
    handleTerminalReady,
    runQuickCommand,
    quickSnapshot,
    setQuickManageOpen,
    panelOf,
    patchPanelOf,
    showSideTabOf,
    toggleSideTabOf,
    closeSideTabOf,
    collapseSidePanelOf,
    toggleSidePanelOf,
    openTerminalTabOf,
    toggleTerminalPanelOf
  } = ctx

  /** 只看这一个会话的数据（不挂副作用，见文件头） */
  const app = useAgentAppView(conversationId)

  /**
   * 接上**别的端**（远程 web / 另一个窗口）在这个会话上发起的一轮。
   *
   * 这是本标签**自己的**副作用，不是全局副作用 —— 所以放在这里而不是 `useAgentApp`：
   * 判据是「**这一个**会话在服务端跑着、而本连接没有它的流」。消息正文与流式输出
   * 是按会话订阅的 SSE，只有发起那一轮的连接订着它，别的端不主动接就只看得到侧栏转圈。
   */
  useAttachRemoteRun(conversationId)

  /**
   * 面板现场挂在哪个 key 下：**由这个标签自己决定** —— 有会话就是会话 id；
   * 「新对话」占位标签用 `draft:<它所属的工作区>`（`draftPanelKey`）。
   *
   * ⚠️ 以前这里写的是 `conversationId ?? ctx.sessionKey`，而 `sessionKey` 是「**当前**
   * 会话」——多标签下它不是这个标签的属性。于是「新对话」标签的面板会跟着当前会话跑：
   * 点一下别的标签，它就去读**别人**的面板现场（表现为「新对话的面板跟着其他会话走」），
   * 而它自己那份现场被当成「已离开的草稿」回收掉，终端 PTY 一起没。
   * 现场属于**标签**，key 必须只由标签自己算出来（工作区在标签切换时不变，所以它是稳的）。
   */
  const key = conversationId ?? draftPanelKey(app.activeWorkspaceId)

  /**
   * 守卫：关闭 / 刷新这个标签之前先问一句。
   *
   * - `beforeClose`：会话正在跑 → 先确认，确认后**先停这一条会话再放行关闭**。
   * - `beforeReload`：**只拦「面板里挂着终端」**。重挂会卸载 `ConversationTab`，连带右侧
   *   面板里的 `TerminalPanel` 一起卸载 —— 它们的 cleanup 会 kill 掉 PTY。会话本身
   *   （消息、正在跑的回合、后台会话）都在 store 里，重挂只是换一份视图，所以**不**因为
   *   「正在生成」而拦（那会是一个没有后果的确认框）。
   *
   * ⚠️ 「是否在跑」「停会话」「终端条数」都走 ref：登记只随标签变（标签常挂载，每次流式
   * 状态变化 / 面板变更都重登记没有意义，还会在弹窗 await 期间把守卫换掉）。判「在跑」用
   * `runningConversations`（**后台会话也算**），不是 `app.streaming`（那只反映当前标签这条）。
   */
  const confirm = useConfirm()
  const guardRef = useRef({ running: false, stop: app.stopConversation, terminals: 0 })
  guardRef.current.running = conversationId ? !!app.runningConversations[conversationId] : false
  guardRef.current.stop = app.stopConversation
  useEffect(() => {
    return registerTabCloseGuard(hostTabKey, {
      beforeClose: async () => {
        const id = conversationId
        if (!id || !guardRef.current.running) return 'close'
        const ok = await confirm({
          title: tr('停止并关闭这个对话？'),
          description: tr('这条会话正在生成回复，关闭标签会先停止当前回合（已生成的内容保留）。'),
          confirmLabel: tr('停止并关闭'),
          destructive: true
        })
        if (!ok) return 'cancel'
        await guardRef.current.stop(id)
        return 'close'
      },
      beforeReload: async () => {
        const terminals = guardRef.current.terminals
        if (terminals === 0) return 'reload'
        const ok = await confirm({
          title: tr('刷新这个对话？'),
          description: tr('这个标签右侧面板里挂着的 {count} 条终端会一起重开，里面正在运行的进程会一起结束。', { count: terminals }),
          confirmLabel: tr('刷新标签'),
          destructive: true
        })
        return ok ? 'reload' : 'cancel'
      }
    })
  }, [hostTabKey, conversationId, confirm])

  /** 面板容器的实测宽度（算面板默认宽度与拖拽上限） */
  const [contentRef, contentWidth] = useContainerWidth()
  /** 协作布局这一行的实测宽度：最右侧对话面板的默认宽 / 拖拽上限按它算 */
  const [collabRef, collabWidth] = useContainerWidth()
  const isMobile = useIsMobile()
  const userCollabChatWidth = useCollabChatWidth()
  /** 右侧对话面板的命令式句柄：拖拽结束读回像素宽落盘、双击复位直接改尺寸都靠它 */
  const chatPanelRef = usePanelRef()
  const collabChatMin = minCollabChatWidth(collabWidth)
  const collabChatMax = maxCollabChatWidth(collabWidth)
  const collabChatWidth =
    userCollabChatWidth === null
      ? defaultCollabChatWidth(collabWidth)
      : Math.min(Math.max(userCollabChatWidth, collabChatMin), collabChatMax)
  /** 双击拖拽条：清掉记忆值，面板回到「按容器算的默认宽」（不是固定 320） */
  const resetChatPanelWidth = () => {
    resetCollabChatWidth()
    chatPanelRef.current?.resize(defaultCollabChatWidth(collabWidth))
  }

  const panel = panelOf(key)
  const sideTab = panel?.sideTab ?? null
  /**
   * 「侧栏停在源代码管理这一页」**且**「这个会话标签正被看着」。
   *
   * ⚠️ 那个 `active` 不能省：标签内容一律常挂载，切走的会话只是被 `hidden` 藏起来，
   * 它的面板照样在渲染、照样挂 window 键盘监听。少了 `active`，切过别的会话之后按推送
   * 快捷键会同时打到后台那几个面板上（它们服务的是别的工作区，可能根本不是仓库），
   * 表现出来就是「当前仓库明明有远端，却弹出『管理远端』」。
   */
  const gitVisible = active && sideTab === 'git'
  /** 刷新守卫读的「面板里挂着几条终端」（见上面守卫的注释）—— 每次渲染刷一次 ref */
  guardRef.current.terminals = panel?.terminals.length ?? 0

  /**
   * 这个标签所属的工作区：按**会话自己的** `workspaceId` 取，而不是全局的
   * `activeWorkspaceId` —— 分屏下两个标签可能来自不同工作区。
   */
  const conversation = conversationId
    ? app.conversations.find((c) => c.id === conversationId)
    : undefined
  /**
   * 协作布局左侧的 Agent 名单由 `CollabWorkspace` 自己管；右侧始终是**同一条共享会话**
   * （所有 Agent 的回复都带名字进这条时间线）。不再有「点节点看子 Agent 独立消息」。
   */
  const workspaceId = conversation?.workspaceId ?? app.activeWorkspaceId ?? ''
  const workspace = app.workspaces.find((w) => w.id === workspaceId)
  /**
   * 临时工作区（没选项目就发消息时自动建的）名字就叫「临时会话」，直接用 `name` 即可；
   * 找不到 workspace 行只可能是清单还没拉回来，给个中性名字顶着。
   */
  const workspaceName = workspace?.name ?? tr('工作区')
  /**
   * 顶栏标题：**临时会话显示它自己的会话标题**，不显示工作区名。
   *
   * 临时工作区是一条会话一个、名字全都叫「临时会话」—— 拿它当标题等于没有信息，
   * 而侧栏会话行显示的是 `conversation.title`，两处对不上更让人困惑。普通项目仍显示
   * 项目名：顶栏是**工作区**工具条（终端 / 文件 / 源码都以这个工作区为前提），
   * 同一项目下多个会话的区分交给标签栏。
   *
   * 标题还没生成（新会话 / 草稿标签）时回退到工作区名，别留一条空标题。
   */
  const headerTitle =
    workspace?.scratch && conversation?.title?.trim() ? conversation.title : workspaceName

  /** 「任务」这类虚拟工作区（path 为空）没有目录概念：终端 / 文件 / 快捷功能全部隐藏 */
  const hasDirectory = !!workspace?.path
  /**
   * 远端工作区：文件面板走 SFTP（列 / 读写 / 上传 / 打包下载 / 媒体），终端走 SSH 通道，
   * 源码管理由服务端把 git 命令发到远端主机上跑（见 `gitExecFor`）—— 三者入口照常给。
   * 只剩**浏览器画面**仍按本机预览通道工作，远端下不露头。
   */
  const isRemote = !!workspace?.remote
  const gitChangeCount = panel?.gitChanges?.count ?? 0
  const gitBadge =
    gitChangeCount > 0 ? `${gitChangeCount}${panel?.gitChanges?.truncated ? '+' : ''}` : null
  /** 面板里已挂出的终端条数：顶栏终端按钮右上角挂个徽标（0 条不挂） */
  const terminalCount = panel?.terminals.length ?? 0

  /**
   * 是不是容器型项目：**只有这类项目才有预览按钮、才有「容器终端」菜单项**。
   *
   * 判据只看「工作区上有没有 `container` 配置」（有没有配预览端口由面板自己说，
   * 别让按钮在 `containerProjects` 快照到达前忽隐忽现）。
   */
  const containerPreview = workspace?.container !== undefined

  /**
   * 列表加载窗口（与 Sidebar / ChatPanel 同一判据）：刷新后工作区列表没落地之前，
   * 「未选择工作区」这个结论**不成立** —— 顶栏标题先上骨架屏，别闪占位文案。
   */
  const listsLoading = !app.conversationsLoaded && !app.error

  /** ACP 会话：名字右侧要跟一个「外部 Agent 名称」徽标 */
  const isAcpConversation = conversation?.backend === 'acp'
  const acpAgent = isAcpConversation
    ? app.acpAgents.find((a) => a.id === conversation.configId)
    : undefined

  /**
   * 「选择终端」菜单里打勾的那一项：**上次用过并被记住的 shell**（`terminalShellId`）；
   * 它不在探测列表里（没装 / 卸了）就退回服务端给的 defaultId。
   * 工作区设置里那个显式的「默认终端」已移除 —— 现在点菜单里的某个 shell 就顺手记住，
   * 下次开终端直接用它。
   */
  const checkedShellId =
    terminalShells && defaultTerminalShellId && terminalShells.shells.some((s) => s.id === defaultTerminalShellId)
      ? defaultTerminalShellId
      : (terminalShells?.defaultId ?? null)

  /**
   * 正看着的侧栏标签是不是「容器终端」：菜单里给容器项打勾。
   * 与本地 shell 那组的勾语义不同 —— 那边勾的是「默认 shell」，容器项只有一个，
   * 勾表示「你正在看的就是它」。
   */
  const activeTerminalIsContainer =
    isTerminalTabKey(sideTab) &&
    !!panel?.terminals.find((t) => terminalTabKey(t.id) === sideTab)?.containerWorkspaceId

  /**
   * 面板里要挂的标签：**挂出来的才算**（顺序按打开先后，见 `orderTabs`）。
   * 终端的「挂出」以它在 `terminals` 里为准（一旦挂出，PTY 就常驻，收起面板不掐它）。
   */
  const tabKeys = useMemo(() => {
    const mounted = [
      ...(panel?.terminals ?? []).map((t) => terminalTabKey(t.id)),
      ...(panel?.filesMounted ? ['files'] : []),
      ...(panel?.gitMounted ? ['git'] : []),
      ...(panel?.browserMounted ? ['browser'] : []),
      // 预览只在容器型项目下挂得出来：项目从容器改成普通 / 被删掉时，别把这条标签
      // 恢复成一个点开只有「这个项目已经不存在」的壳
      ...(panel?.previewMounted && containerPreview ? ['preview'] : [])
    ]
    return panel ? orderTabs(panel, mounted) : mounted
  }, [panel, containerPreview])

  const tabs: SidePanelTab[] = tabKeys.map((tabKey) => {
    if (isTerminalTabKey(tabKey) && panel) {
      // tabKey 就是从 panel.terminals 拼出来的，必然找得到
      const tab = panel.terminals.find((t) => terminalTabKey(t.id) === tabKey)!
      const isContainerTerminal = !!tab.containerWorkspaceId
      /**
       * 远端工作区：侧栏终端走 SSH 主机那条通道，`tab.cwd` 是远端 POSIX 目录。
       * 此时不再传 `workspaceId`（SSH 终端的命令历史是全局一份，不挂项目）。
       */
      const sshHostId = workspace?.remote?.hostId
      const label =
        panel.terminals.length > 1
          ? tr('终端 {index}', { index: panel.terminals.indexOf(tab) + 1 })
          : tr('终端')
      return {
        key: tabKey,
        label,
        title: isContainerTerminal ? tr('终端 · 容器内') : tr('终端 · {cwd}', { cwd: tab.cwd }),
        icon: isContainerTerminal ? <Box className="size-4" /> : <SquareTerminal className="size-4" />,
        content: (
          <TerminalPanel
            key={tab.id}
            cwd={tab.cwd}
            // 停用时不抢焦点（否则切回来会直接抢走输入焦点）
            visible={sideTab === tabKey}
            shellId={sshHostId ? undefined : tab.shellId}
            // 容器终端不带宿主项目的命令历史（与主区域容器工作台一致）
            workspaceId={isContainerTerminal || sshHostId ? undefined : workspaceId || undefined}
            sshHostId={sshHostId}
            containerWorkspaceId={sshHostId ? undefined : tab.containerWorkspaceId}
            containerShell={sshHostId ? undefined : tab.containerShell}
            onReady={(proc) => handleTerminalReady(tab.id, proc)}
          />
        ),
        onClose: () => closeSideTabOf(key, tabKey)
      }
    }
    if (tabKey === 'files') {
      return {
        key: tabKey,
        label: tr('文件'),
        title: tr('工作区文件 · {name}', { name: workspaceName }),
        icon: <Files className="size-4" />,
        content: (
          <FilesPanel app={app} workspaceId={workspaceId} visible={sideTab === 'files'} />
        ),
        onClose: () => closeSideTabOf(key, tabKey)
      }
    }
    if (tabKey === 'git') {
      return {
        key: tabKey,
        label: tr('源码管理'),
        title: tr('源代码管理 · {name}', { name: workspaceName }),
        icon: <GitBranch className="size-4" />,
        content: (
          <GitPanel
            app={app}
            workspaceId={workspaceId}
            visible={gitVisible}
            // 面板刷完把改动数 + 当前分支回报到**本会话**的面板上
            onChanges={(info) =>
              patchPanelOf(key, (base) => ({
                ...base,
                gitChanges: info,
                gitBranch: info?.branch ?? null
              }))
            }
          />
        ),
        onClose: () => closeSideTabOf(key, tabKey)
      }
    }
    if (tabKey === 'browser') {
      return {
        key: tabKey,
        label: tr('浏览器'),
        title: tr('浏览器画面'),
        icon: <Globe className="size-4" />,
        /*
         * 不传「正被看着」这类信号、也不给面板内关闭按钮：浏览器**不自动启动**了，面板里
         * 给一颗「启动浏览器」按钮由用户点（见 `BrowserPane` 文件头）；收起面板就是关标签
         * （标签条上的 X 一步到位），顶栏再放一颗只是重复。
         */
        content: <BrowserPane conversationId={key} />,
        onClose: () => closeSideTabOf(key, tabKey)
      }
    }
    if (tabKey === 'preview' && workspaceId) {
      return {
        key: tabKey,
        label: tr('预览'),
        title: tr('预览 · {name}', { name: workspaceName }),
        icon: <MonitorPlay className="size-4" />,
        // 桌面端是 `<webview>`（不受 X-Frame-Options 限制），其余宿主退回 iframe
        content: <PreviewPane workspaceId={workspaceId} />,
        onClose: () => closeSideTabOf(key, tabKey)
      }
    }
    return {
      key: tabKey,
      label: tr('未知标签'),
      title: tabKey,
      icon: null,
      content: null,
      onClose: () => closeSideTabOf(key, tabKey)
    }
  })

  /**
   * 快捷功能的系统能力。`openExternal` 直接用 web-host 的实现；`openPath` 没有实现
   * （浏览器碰不到本机文件系统），保留一条明确的错误而不是删掉这个动作。
   */
  const openPath = async (path: string): Promise<{ ok: boolean; error?: string }> => ({
    ok: false,
    error: tr('浏览器里打不开本机路径：{path}（这个动作需要在宿主机上执行）', { path })
  })

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent">
      {/* 工作区工具条：当前工作区 + 功能入口；手机上多一个侧栏按钮 */}
      <ViewHeader
        title={
          listsLoading ? (
            <Skeleton className="h-5 w-36" />
          ) : workspace ? (
            headerTitle
          ) : (
            tr('未指定工作区')
          )
        }
        titleHint={
          workspace
            ? workspace.scratch
              ? tr('{title} · 临时会话：不指定项目的对话（目录在服务端数据目录）', { title: headerTitle })
              : `${workspaceName}（${workspace.path}）`
            : undefined
        }
        afterTitle={
          conversation?.kind === 'collab' ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground"
              title={tr('@ 点名由该智能体处理；不点名时全体判断是否需要接手')}
            >
              <Bot className="size-3 shrink-0" />
              {tr('多智能体协作')}
            </span>
          ) : acpAgent ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground"
              title={tr('外部 Agent：{name}', { name: acpAgent.name })}
            >
              <Bot className="size-3 shrink-0" />
              {acpAgent.name}
            </span>
          ) : undefined
        }
        subtitle={
          panel?.gitBranch ? (
            <span className="flex min-w-0 shrink-0 items-center gap-1">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate font-mono">{panel.gitBranch}</span>
            </span>
          ) : undefined
        }
        trailing={
          <>
            {hasDirectory && !isRemote && (
              /* ⚡ 快捷功能：**始终渲染**（0 条时也是唯一入口），增删改在它下拉的最底部 */
              <WorkspaceQuickActions
                workspaceId={workspaceId}
                workspacePath={workspace!.path}
                actions={quickSnapshot?.config.quickActions ?? []}
                onRunCommand={runQuickCommand}
                onOpenExternal={openExternal}
                onOpenPath={openPath}
                onManage={() => setQuickManageOpen(true)}
              />
            )}
            {hasDirectory && (
              /* 分裂按钮：左半开/收终端，右半箭头弹 shell 菜单 —— 选一项就新开一条终端。
                 徽章挂在整组右上角（不是左半按钮上）：挂左半会被紧挨着的下拉按钮盖住一半。 */
              <div className="relative flex items-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <LiquidGlassButton tone="contrast"
                      className={cn(
                        HEADER_GLASS_BUTTON,
                        // 远端工作区只有一种终端（SSH 到那台主机），没有 shell 可选，
                        // 右侧箭头下拉不渲染 —— 这一颗就按整颗按钮的圆角收口
                        isRemote ? undefined : 'rounded-l-md rounded-r-none',
                        isTerminalTabKey(sideTab) ? 'text-primary' : undefined
                      )}
                      aria-label={isRemote ? tr('远端终端') : tr('终端')}
                      disabled={!workspaceId}
                      onClick={() => toggleTerminalPanelOf(key)}
                    >
                      <SquareTerminal className="size-4" />
                    </LiquidGlassButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isTerminalTabKey(sideTab)
                      ? tr('收起面板')
                      : terminalCount > 0
                        ? tr('终端（已开 {count} 条）', { count: terminalCount })
                        : isRemote
                          ? tr('远端终端')
                          : tr('终端')}
                  </TooltipContent>
                </Tooltip>
                {/*
                  远端工作区下拉整块不渲染：能选的只有「本机 shell」和「容器终端」，
                  两者都连不到远端主机；那颗主按钮已经开的是 SSH 终端。
                */}
                {!isRemote && (
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <LiquidGlassButton tone="contrast"
                            className={cn(HEADER_GLASS_BUTTON, '-ml-px w-5 rounded-l-none')}
                            aria-label={tr('选择终端')}
                            disabled={!workspaceId}
                          >
                            <ChevronDown className="size-3.5" />
                          </LiquidGlassButton>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{tr('选择终端')}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent
                      align="end"
                      className="w-48"
                      /* 选完 shell 焦点别弹回工具栏按钮：终端面板打开时会自己 focus */
                      onCloseAutoFocus={(e) => e.preventDefault()}
                    >
                      <DropdownMenuLabel className="text-xs text-muted-foreground">{tr('选择终端')}</DropdownMenuLabel>
                      {/*
                        容器型项目才有这一项：开的是容器内的终端（服务端 `docker exec`），
                        不是宿主 shell。放最上面 —— 这类项目里它是常用项，宿主 shell 是例外。
                      */}
                      {containerPreview && (
                        <>
                          <DropdownMenuItem
                            onSelect={() =>
                              workspaceId && openTerminalTabOf(key, null, { workspaceId })
                            }
                          >
                            <Box className="size-3.5" />
                            <span className="truncate">{tr('容器终端')}</span>
                            {activeTerminalIsContainer && <Check className="ml-auto size-3.5" />}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      {terminalShells && terminalShells.shells.length > 0 ? (
                        terminalShells.shells.map((shell) => (
                          <DropdownMenuItem
                            key={shell.id}
                            onSelect={() => {
                              // 选谁就记住谁：下次（任何会话的）新终端都用它。
                              // 显式默认终端设置已去掉，偏好就靠这一次选择累积。
                              setTerminalShell(shell.id)
                              openTerminalTabOf(key, shell.id)
                            }}
                          >
                            <span className="truncate">{shell.name}</span>
                            {shell.id === checkedShellId && <Check className="ml-auto size-3.5" />}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                          {terminalShells ? tr('没有检测到可选的终端') : tr('正在检测终端…')}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {/* 面板里开着几条终端：收起面板时才知道「回去」有几条。挂在整组右上角，
                    `z-10` 保证不被紧挨着的下拉按钮压住。 */}
                {terminalCount > 0 && (
                  <span className="pointer-events-none absolute -top-1.5 -right-1.5 z-10 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] font-medium leading-4 text-primary-foreground tabular-nums">
                    {terminalCount}
                  </span>
                )}
              </div>
            )}
            {/*
              浏览器画面：Agent 调 `browser_*` 时会自动挂出来（见 `app-shell` 的
              `browser-active`），这颗按钮是「收起来之后想再看一眼」的**手动入口** ——
              与 Agent 共用同一个浏览器，面板里能自己点、自己输地址（见 `BrowserPane`）。

              ⚠️ 只在真实会话里给：草稿标签的 key 是 `draft:<工作区>`，面板会连到一个
              不存在的 `agent-browser:` 会话（只显示「浏览器未启动」）。发第一条消息后
              标签被复用成真实会话，按钮自然出现。

              ⚠️ ACP 会话不给：运行的是外部 Agent，`browser_*` 那套工具它根本用不上，
              这颗入口点开只会是个永远「未启动」的空面板。
            */}
            {conversationId && !isAcpConversation && !isRemote && (
              <div className="hidden sm:flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <LiquidGlassButton tone="contrast"
                      className={cn(HEADER_GLASS_BUTTON, sideTab === 'browser' && 'text-primary')}
                      aria-label={tr('浏览器')}
                      disabled={!workspaceId}
                      onClick={() => toggleSideTabOf(key, 'browser')}
                    >
                      <Globe className="size-4" />
                    </LiquidGlassButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {sideTab === 'browser' ? tr('收起面板') : tr('浏览器画面')}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            {/* 容器型项目才有「预览」：在会话面板里直接看容器跑起来的页面。
                桌面端是 `<webview>`（不受 X-Frame-Options 限制），web / 手机端退回 iframe。 */}
            {containerPreview && (
              <div className="hidden sm:flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <LiquidGlassButton tone="contrast"
                      className={cn(HEADER_GLASS_BUTTON, sideTab === 'preview' && 'text-primary')}
                      aria-label={tr('预览')}
                      disabled={!workspaceId}
                      onClick={() => toggleSideTabOf(key, 'preview')}
                    >
                      <MonitorPlay className="size-4" />
                    </LiquidGlassButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {sideTab === 'preview' ? tr('收起面板') : tr('预览（容器页面）')}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            {/* 下面这些入口（文件 / 源码 / 面板）手机上收进「更多」菜单，
                见下面 `MobilePanelMenu` —— 顶栏按钮一多就会把标题挤成两三个字。
                （「打开工作区目录」是**项目级**动作，已搬到左侧栏项目行的「更多操作」，
                见 `features/projects/OpenWorkspaceItems`。） */}
            {hasDirectory && (
              /* 桌面（`sm` 以上）才平铺。⚠️ 不能在 Button 自身写 `hidden sm:inline-flex`：
                 Button 的 base class 里有 `inline-flex`，同层 display 工具类里
                 `inline-flex` 会盖过 `hidden`，手机上照样露出来 —— 所以用外层
                 `<div>` 做显隐（它没有冲突的 base class）。 */
              <div className="hidden sm:flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <LiquidGlassButton tone="contrast"
                      className={cn(HEADER_GLASS_BUTTON, sideTab === 'files' && 'text-primary')}
                      aria-label={tr('工作区文件')}
                      disabled={!workspaceId}
                      onClick={() => toggleSideTabOf(key, 'files')}
                    >
                      <Files className="size-4" />
                    </LiquidGlassButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {sideTab === 'files' ? tr('收起面板') : tr('工作区文件')}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            {hasDirectory && (
              <div className="hidden sm:flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <LiquidGlassButton tone="contrast"
                      className={cn(HEADER_GLASS_BUTTON, sideTab === 'git' && 'text-primary')}
                      aria-label={tr('源代码管理')}
                      disabled={!workspaceId}
                      onClick={() => toggleSideTabOf(key, 'git')}
                    >
                      <GitBranch className="size-4" />
                      {gitBadge && (
                        <span className="pointer-events-none absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] font-medium leading-4 text-primary-foreground tabular-nums">
                          {gitBadge}
                        </span>
                      )}
                    </LiquidGlassButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {sideTab === 'git'
                      ? tr('收起面板')
                      : gitChangeCount > 0
                        ? tr('源代码管理（{count} 处改动）', { count: gitChangeCount })
                        : tr('源代码管理')}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            {/* 「门」按钮：不挂新标签，只开关面板 */}
            {hasDirectory && tabKeys.length > 0 && (
              <div className="hidden sm:flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <LiquidGlassButton tone="contrast"
                      className={cn(HEADER_GLASS_BUTTON, sideTab !== null && 'text-primary')}
                      aria-label={tr('展开/收起面板')}
                      aria-pressed={sideTab !== null}
                      onClick={() => toggleSidePanelOf(key)}
                    >
                      {sideTab !== null ? (
                        <PanelRightClose className="size-4" />
                      ) : (
                        <PanelRightOpen className="size-4" />
                      )}
                    </LiquidGlassButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {sideTab !== null ? tr('收起面板') : tr('展开面板')}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            {/* 手机顶栏的溢出菜单：文件 / 源码 / 面板三颗按钮收成一颗「更多」，
                顶栏因此从七颗降到三颗（快捷功能 / 终端 / 更多），标题不再被挤没。
                「工作区设置」已随弹窗一起移除 —— 管理快捷功能走 ⚡ 下拉最底部那项，
                手机顶栏同样有那颗 ⚡，所以不需要在这里再开一个入口。 */}
            {hasDirectory && (
              <MobilePanelMenu
                sideTab={sideTab}
                gitChangeCount={gitChangeCount}
                /* 一个标签都没挂出来时没有「展开面板」可展开 —— 桌面那颗按钮是这么判的，
                   菜单里的这一项也得跟着判，否则手机上会出现一颗点开没反应的开关。 */
                canExpandPanel={tabKeys.length > 0}
                showPreview={containerPreview}
                showBrowser={!isRemote && !!conversationId && !isAcpConversation}
                onToggleFiles={() => toggleSideTabOf(key, 'files')}
                onToggleGit={() => toggleSideTabOf(key, 'git')}
                onTogglePreview={() => toggleSideTabOf(key, 'preview')}
                onToggleBrowser={() => toggleSideTabOf(key, 'browser')}
                onTogglePanel={() => toggleSidePanelOf(key)}
              />
            )}
          </>
        }
      />
      {/* 内容区：左边对话、右边多标签面板 */}
      <div ref={contentRef} className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {conversation?.kind === 'collab' ? (
            /*
              协作布局：左边 Agent 名单（增删改 / 实时状态），右边**同一条共享会话**。
              所有 Agent 的回复都带名字进这条时间线，不再有「点节点看子 Agent 独立消息」。
            */
            <div
              ref={collabRef}
              className={cn('flex min-h-0 flex-1', isMobile ? 'flex-col' : 'flex-row')}
            >
              {isMobile ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="max-h-[38dvh] shrink-0 overflow-y-auto border-b">
                    <CollabWorkspace app={app} />
                  </div>
                  <div className="min-h-0 flex-1">
                    <ChatPanel app={app} panelKey={key} />
                  </div>
                </div>
              ) : (
                <ResizablePanelGroup
                  orientation="horizontal"
                  className="min-h-0"
                  onLayoutChanged={(_, meta) => {
                    /*
                      只记**用户拖出来的**尺寸：挂载、容器变化、`defaultSize` 变更也会触发这个
                      回调（`meta.isUserInteraction` 为 false），把那些值写回 localStorage 会
                      冲掉用户调好的宽度。
                    */
                    if (!meta.isUserInteraction) return
                    const px = chatPanelRef.current?.getSize().inPixels
                    if (px && px > 0) setCollabChatWidth(px)
                  }}
                >
                  <ResizablePanel
                    className="flex min-h-0 flex-col"
                    style={{ overflow: 'hidden' }}
                  >
                    <CollabWorkspace app={app} />
                  </ResizablePanel>
                  {collabChatMax > collabChatMin && (
                    <ResizableHandle
                      /*
                        库自带的双击复位会回到 `defaultSize`（= 用户记忆的宽度），而这里要的是
                        「回到按容器算的默认宽」，所以关掉它自己接。
                      */
                      disableDoubleClick
                      onDoubleClick={resetChatPanelWidth}
                      className="relative z-10 cursor-col-resize"
                    />
                  )}
                  <ResizablePanel
                    panelRef={chatPanelRef}
                    defaultSize={collabChatWidth}
                    minSize={collabChatMin}
                    maxSize={collabChatMax}
                    /*
                      窗口缩放时对话面板保持像素宽、名单吃剩下的（改造前就是这个行为）。
                      默认的按比例缩放会把窄窗口里的聊天框一路压小。
                    */
                    groupResizeBehavior="preserve-pixel-size"
                    className={cn(
                      'flex min-h-0 flex-col',
                      collabChatMax <= collabChatMin && 'border-l'
                    )}
                    style={{ overflow: 'hidden' }}
                  >
                    <ChatPanel app={app} panelKey={key} />
                  </ResizablePanel>
                </ResizablePanelGroup>
              )}
            </div>
          ) : (
            <ChatPanel app={app} panelKey={key} />
          )}
        </div>
        <SidePanel
          open={sideTab !== null && tabs.length > 0}
          tabs={tabs}
          activeKey={sideTab}
          // 标签条上点标签只是「切过去」；收起是点正看着的那个顶栏按钮 / 标签条右边的按钮
          onSelect={(k) => showSideTabOf(key, k)}
          onCollapse={() => collapseSidePanelOf(key)}
          containerWidth={contentWidth}
          // 宽度按**会话**各记一份（见 lib/panel-width.ts）
          scope={key}
        />
      </div>
    </div>
  )
}
