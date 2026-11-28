"use client";

/**
 * 侧边栏外壳：渲染**当前功能区**自己的侧边栏面板。
 *
 * 职责刻意收窄 —— 只做「解析当前功能区 → 把面板要的 props 灌进去」。宽度、折叠
 * 动画、右缘拖拽条都留在 `AppShell`（它们与主区域的排布耦合在一起，放这里会变成
 * 两个组件争同一份布局状态）。
 *
 * 面板要的数据（app…）从 `useAppContext()` 就地取；
 * 外壳本地的动作（新建弹窗…）由 `AppShell` 透传 —— 那些弹窗挂在 `AppShell` 顶层，
 * 状态也在那里。
 *
 * ⚠️ 设置 / 命令面板**不在**这份契约里：它们的入口是活动栏底部那个「菜单」
 * （`SidebarMenu`，由 `AppShell` 渲染），侧栏面板不必知道它们的存在。以前这里要
 * 透传 `onOpenSettings` / `onOpenCommandPalette` 是因为每个功能区侧栏
 * 底部各挂了一份菜单 —— 那三份已经合并成活动栏那一份了。
 * 主题（明暗 / 强调色 / 配色 / 背景）更不在：它是 设置 → 外观，菜单里那项已删除。
 */
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useActiveActivity } from '../activities'
import type { NewInWorkspaceKind } from '@fizz/agent-kit/shared/lib/new-in-workspace'

export interface SidebarProps {
  /** 落到**空态**对话页（初始页）—— 添加项目成功后的落点 */
  onOpenChatView: () => void
  /** 项目行上的新建入口：会话落到新建任务页，其余走各自弹窗（都在 AppShell） */
  onNewInWorkspace: (kind: NewInWorkspaceKind, workspaceId: string) => void
  /** 项目「更多」菜单里的「导入会话」：打开导入弹窗 */
  onImportInWorkspace: (workspaceId: string) => void
  /** 项目「更多」菜单里的「插件」：打开该项目级的插件弹窗 */
  onManagePlugins: (workspaceId: string) => void
  /** 侧边栏宽度（px）：由 AppShell 持有并持久化（右缘拖拽条也在 AppShell） */
  width: number
}

export function Sidebar({
  onOpenChatView,
  onNewInWorkspace,
  onImportInWorkspace,
  onManagePlugins,
  width
}: SidebarProps) {
  const { activity } = useActiveActivity()
  const {
    app,
    openConversation,
    deleteConversation,
    mobileSidebarOpen,
    setMobileSidebarOpen
  } = useAppContext()

  const Panel = activity.sidebar
  // 该功能区没有侧边栏（整页界面）：外壳按 `sidebarVisible=false` 收成 0 宽，这里不渲染
  if (!Panel) return null

  return (
    <Panel
      app={app}
      onOpenChatView={onOpenChatView}
      onOpenConversation={openConversation}
      onDeleteConversation={deleteConversation}
      onNewInWorkspace={onNewInWorkspace}
      onImportInWorkspace={onImportInWorkspace}
      onManagePlugins={onManagePlugins}
      width={width}
      mobileOpen={mobileSidebarOpen}
      onMobileOpenChange={setMobileSidebarOpen}
    />
  )
}
