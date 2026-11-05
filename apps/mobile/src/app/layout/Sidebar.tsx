"use client";

/**
 * 侧边栏外壳 —— 手机版**固定渲染会话列表**（`AgentSidebar`）。
 *
 * 与 `apps/web` / `apps/desktop` 的同名文件**故意不同**：那两端的侧栏按「当前功能区」
 * （`useActiveActivity()`）分发到主机 / 接口请求 / 笔记 / 插件等面板，手机版没有活动栏
 * （见 `app/activities.tsx`），侧栏只有一件事 —— 会话列表。
 *
 * 职责仍然收窄 —— 只做「把面板要的 props 灌进去」。本工程侧栏**恒为抽屉**：没有桌面
 * 那种占位宽度、折叠动画与右缘拖拽条。抽屉本身仍是共享组件的覆盖式 `fixed` 层，
 * 但手机壳在 `styles.css` 里把正文一起右移（`--mobile-sidebar-width`），视觉上是
 * App 那种「推挤」而不是原地盖一层。
 *
 * 抽屉左侧的让位**不在这里管**：`activity-sidebar.tsx` 读 `--sidebar-mobile-inset`
 * （公共默认 `2.5rem` = 活动栏竖条宽度），本工程的 `src/styles.css` 把它覆盖成 `0`
 * （竖条不存在，抽屉贴左缘）。所以这里不传任何「有没有竖条」的 prop —— 形态差异落在
 * token 上，共享组件零改动。
 *
 * ## 外壳归本工程（`AgentSidebar` 的 `shell`）
 *
 * `AgentSidebar` 只管内容（分区 + git 告警 + 弹窗）；抽屉外面的形态由这一层挑：
 * `MobileShell` 就是同一个 `SidebarScaffold`，只多传一个 `header`（品牌行 + 设置入口）。
 * 抽屉连窗口顶栏一起盖住（`styles.css` 的 `--sidebar-drawer-top`），顶栏里的品牌
 * 就看不见了，所以在抽屉自己的第一行补回来。web / desktop 不传 `shell`，
 * 用共享组件里的默认骨架（品牌在窗口顶栏）。
 *
 * 设置入口在抽屉**左下角**（`footer` 槽的最底一行）：手机版**没有底部导航**，
 * 设置是常驻的那一颗。原先它挂在抽屉头右上角（与品牌两端对齐），后来按用户要求
 * 挪到左下角 —— 低频入口放在底部，不与品牌抢顶行。
 *
 * **系统监控**（CPU / 内存 / 进程表）跟在设置右边同一行：它原本是桌面底部状态栏的一颗
 * （`SysmonButton`），手机壳没有那条栏。诊断类入口低频、全局、与当前会话无关，
 * 和设置同属「一周点一次」的东西，放一起最不占地方。跑着的后台任务另有常驻位 ——
 * 顶栏那颗徽标（见 `MobileAppBar`），它是「随时要看」的，不能也塞进抽屉。
 *
 * 抽屉头右上角现在是**搜索**（命令面板）：手机上没有 Ctrl+K 这类键盘入口，不给一颗
 * 常驻按钮的话命令面板在真机上基本打不开。
 */
import { useMemo, useRef } from 'react'
import { Gauge, Search, Settings } from 'lucide-react'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import {
  AgentSidebar,
  type AgentSidebarShellProps
} from '@fizz/agent-kit/features/chat/AgentSidebar'
import { SidebarScaffold } from '@fizz/agent-kit/shared/components/SidebarScaffold'
import { setMobileSidebarOpen } from '@fizz/agent-kit/shared/lib/mobile-sidebar'
import { openSysmonTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { AppBrand } from '@fizz/agent-kit/shared/components/AppBrand'
import type { NewInWorkspaceKind } from '@fizz/agent-kit/shared/lib/new-in-workspace'

/**
 * 手机的外壳：共享骨架 + 顶上那行品牌（`h-11` 与 `MobileAppBar` 同高，两行对齐），
 * 设置入口放在 `footer` 槽的最底一行、贴左（左下角常驻）。
 *
 * 模块级组件（不是内联箭头函数）：否则每次 render 换一次组件标识、侧栏会被重挂。
 */
function MobileShell({
  width,
  mobileOpen,
  onMobileOpenChange,
  footer,
  children,
  onOpenSettings,
  onOpenCommandPalette
}: AgentSidebarShellProps & {
  onOpenSettings: () => void
  /** 抽屉右上角那颗搜索：打开命令面板（手机上没有键盘快捷键，这是唯一常驻入口） */
  onOpenCommandPalette: () => void
}) {
  const tr = useT()
  return (
    <SidebarScaffold
      width={width}
      mobileOpen={mobileOpen}
      onMobileOpenChange={onMobileOpenChange}
      /*
       * ⚠️ **必须传 true**：本工程的外壳是手机形态写死的（见 `app-shell.tsx` 文件头），
       * 侧栏只有抽屉一种形态，`width` 传的是 0。
       *
       * 不传的话形态由 `useIsMobile()`（768px 断点）决定 —— 窗口一旦更宽
       * （Chrome 扩展的侧栏被拖宽 / 大屏上开成标签页），共享组件就落进桌面分支：
       * 那支按 `width: 0` 占位，侧栏变成一条展不开的 0 宽缝，连开关都没有。
       * 用户报的「屏幕宽了手机版侧栏就展不开」就是这个。
       *
       * 强制的必须是**本外壳这一个分支**，不是全局断点：`useIsMobile` 还管着模型
       * 选择器是下拉还是抽屉、工具卡走不走触摸交互，那些在宽屏 + 鼠标下仍要桌面形态。
       */
      forceDrawer
      header={
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <AppBrand iconClassName="size-6" nameClassName="text-sm" />
          {/*
            搜索（命令面板）：放在品牌行**右端**。手机版既没有 Ctrl+K 这类键盘入口，
            也没有底部导航，命令面板否则只能靠外接键盘才打得开 —— 等于不存在。
            尺寸 / 悬停样式与左下角那颗设置一致，两颗常驻入口看起来是同一套。
          */}
          <button
            type="button"
            aria-label={tr('搜索')}
            title={tr('搜索')}
            onClick={onOpenCommandPalette}
            className="ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
          >
            <Search className="size-5" />
          </button>
        </div>
      }
      footer={
        <div className="flex flex-col">
          {footer}
          <div className="flex shrink-0 items-center gap-0.5 px-2 py-1.5">
            <button
              type="button"
              aria-label={tr('设置')}
              title={tr('设置')}
              onClick={onOpenSettings}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
            >
              <Settings className="size-5" />
            </button>
            {/*
              系统监控（+ 任务管理器）：桌面在底部状态栏那颗 `SysmonButton`，手机壳没有
              那条栏（`--status-bar-height: 0`）。它和设置一样是低频、全局、与当前会话无关的
              入口，所以并排放在抽屉左下角这一行。

              ⚠️ 点它要**先收抽屉**：面板是主区域的内容（单标签模式下等于替换当前视图），
              抽屉还开着的话会把刚打开的面板整个盖住，看起来像「点了没反应」。
              `PanelView` 早就接好了这条标签（`isSysmonTabKey` → `SysmonPanel`，窄屏会
              隐藏几列进程表），缺的只是入口。
            */}
            <button
              type="button"
              aria-label={tr('系统监控')}
              title={tr('系统监控')}
              onClick={() => {
                setMobileSidebarOpen(false)
                openSysmonTab()
              }}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
            >
              <Gauge className="size-5" />
            </button>
          </div>
        </div>
      }
    >
      {children}
    </SidebarScaffold>
  )
}

export interface SidebarProps {
  /** 落到**空态**对话页（初始页）—— 添加项目成功后的落点 */
  onOpenChatView: () => void
  /** 项目行上的三种「新建」：会话落到新建任务页，协作直接建，其余走各自弹窗（都在 AppShell） */
  onNewInWorkspace: (kind: NewInWorkspaceKind, workspaceId: string) => void
  /** 项目「更多」菜单里的「导入会话」：打开导入弹窗 */
  onImportInWorkspace: (workspaceId: string) => void
  /** 项目「更多」菜单里的「插件」：打开该项目级的插件弹窗 */
  onManagePlugins: (workspaceId: string) => void
  /** 抽屉左下角的设置入口（手机版没有底部导航，这里是唯一常驻入口） */
  onOpenSettings: () => void
  /** 抽屉右上角的搜索入口：打开命令面板 */
  onOpenCommandPalette: () => void
}

export function Sidebar({
  onOpenChatView,
  onNewInWorkspace,
  onImportInWorkspace,
  onManagePlugins,
  onOpenSettings,
  onOpenCommandPalette
}: SidebarProps) {
  const {
    app,
    openConversation,
    deleteConversation,
    mobileSidebarOpen,
    setMobileSidebarOpen
  } = useAppContext()

  /**
   * `shell` 是个组件类型，多出来的 `onOpenSettings` 没法经 `AgentSidebar` 转交，
   * 所以在这里把回调收进 ref、造一个**只建一次**的稳定外壳 —— 每次 render 新造组件
   * 会让侧栏整棵重挂（抽屉动画与滚动位置都丢）。
   */
  const openSettingsRef = useRef(onOpenSettings)
  openSettingsRef.current = onOpenSettings
  const openPaletteRef = useRef(onOpenCommandPalette)
  openPaletteRef.current = onOpenCommandPalette
  const Shell = useMemo(() => {
    const StableShell = (props: AgentSidebarShellProps) => (
      <MobileShell
        {...props}
        onOpenSettings={() => openSettingsRef.current()}
        onOpenCommandPalette={() => openPaletteRef.current()}
      />
    )
    return StableShell
  }, [])

  return (
    <AgentSidebar
      app={app}
      onOpenChatView={onOpenChatView}
      onOpenConversation={openConversation}
      onDeleteConversation={deleteConversation}
      onNewInWorkspace={onNewInWorkspace}
      onImportInWorkspace={onImportInWorkspace}
      onManagePlugins={onManagePlugins}
      // 手机形态恒为抽屉，宽度用不到 —— 强制抽屉后共享组件的桌面分支永远不会走
      width={0}
      mobileOpen={mobileSidebarOpen}
      onMobileOpenChange={setMobileSidebarOpen}
      // 选完一行就收起抽屉：内容组件只负责「知会一声」，收不收是外壳的事
      onNavigate={() => setMobileSidebarOpen(false)}
      // 外壳：本工程自己的抽屉头（品牌行 + 设置入口），见文件头
      shell={Shell}
    />
  )
}
