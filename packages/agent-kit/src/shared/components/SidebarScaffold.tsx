'use client';

/**
 * 功能区侧栏的**骨架**：外壳（`ActivitySidebar`）+ shadcn sidebar 结构 + 分区容器。
 *
 * ## 结构（shadcn `sidebar` 那一套）
 *
 * ```
 * ActivitySidebar          几何：桌面占位 / 手机抽屉、宽度、遮罩
 * └─ SidebarProvider       提供 state / toggle，快捷键由应用配置统一分发
 *    └─ Sidebar            **透明底**（压掉原语自带的 `bg-sidebar`）+ `text-sidebar-foreground`
 *       ├─ header（可选） 手机抽屉的品牌行，见下
 *       ├─ SidebarContent  只留滚动容器，滚动交给内层 StackedSections
 *       └─ SidebarFooter   `footer` 槽（git 告警那类常驻行）
 * ```
 *
 * `collapsible="none"`：折叠**不在这里做**。收成 0 宽是 `AppShell` 的外层宽度过渡
 * （入口在活动栏 / 状态栏，见那里的注释），这里再管一次就会两套状态打架。
 *
 * ## 为什么还留着 `ActivitySidebar` 这一层
 *
 * 那一层是「像素级行为」（手机抽屉内缩、阴影与 `visibility` 的过渡、`h-full` 与
 * `top/bottom` 的过约束……），这一层是「面板视觉结构」。合并后改抽屉动画得先读完槽位。
 *
 * ## 用法
 *
 * ```tsx
 * <SidebarScaffold
 *   width={width} mobileOpen={mobileOpen} onMobileOpenChange={onMobileOpenChange}
 *   footer={<GitAlert />}              // 可选：分区容器**下方**的常驻行
 * >
 *   <SectionShell spec={…}>…</SectionShell>
 * </SidebarScaffold>
 * ```
 *
 * **调用方自己持有的弹窗**（新增 / 删除确认…）不要塞进 `children`：它们要挂在
 * `SidebarScaffold` **外面**（同一个 fragment 里并列即可）。
 *
 * ## ⚠️ 骨架**没有**顶部栏，也不打算再加回来
 *
 * 三个功能区侧栏的第一行就是**第一个分区的标题栏**。顶部那行字不携带信息（用户点的是
 * 活动栏那颗图标），还让三条侧栏顶部对不齐。顶部也**不补 `pt-*`**：那是把「头顶没有东西」
 * 伪装成「头顶有一条看不见的栏」。
 *
 * 同理**没有底部用户信息块**：账号 / 菜单入口在底部状态栏（`StatusBar`），常驻、不随
 * 功能区切换消失。
 *
 * **唯一例外是 `header` 槽**：手机抽屉连窗口顶栏一起盖住（见 `apps/mobile` 的
 * `--sidebar-drawer-top`），顶上没有品牌了，那边的**外壳**（`apps/mobile/src/app/layout/
 * Sidebar.tsx` 的 `MobileShell`）会传一行 `AppBrand` 补回来。桌面 / web 不传 ——
 * 它们的品牌在窗口顶栏，侧栏再画一遍就是重复。
 */
import type { ReactNode } from 'react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarProvider
} from '@fizz/ui/sidebar'
import { ActivitySidebar } from '@fizz/agent-kit/shared/components/activity-sidebar'
import { StackedSections } from '@fizz/agent-kit/shared/components/StackedSections'
import {
  setSidebarCollapsed,
  useSidebarCollapsed
} from '@fizz/agent-kit/shared/lib/sidebar-collapsed'

export function SidebarScaffold({
  width,
  mobileOpen,
  onMobileOpenChange,
  forceDrawer,
  header,
  footer,
  children
}: {
  /** 侧栏宽度（px）：由 AppShell 持有并持久化（右缘拖拽条也在 AppShell） */
  width: number
  /** 手机端抽屉开关（isMobile 时生效） */
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
  /**
   * 强制抽屉形态、不看视口宽度。手机壳（及复用它的 Chrome 扩展）传 `true` ——
   * 那两端侧栏只有抽屉一种形态且 `width` 恒为 0，宽窗口下按断点走桌面分支会变成
   * 一条展不开的 0 宽缝。语义与判定见 `activity-sidebar.tsx` 的同名 prop。
   */
  forceDrawer?: boolean
  /**
   * 侧栏顶部那一行（分区容器**上方**）。留空 = 第一行就是第一个分区标题。
   * 目前只有手机的外壳在传（`apps/mobile` 的 `MobileShell`，一行 `AppBrand`）：
   * 那边抽屉连窗口顶栏一起盖住，顶上没有品牌了。
   */
  header?: ReactNode
  /**
   * 分区容器**下方**的常驻行（不随分区滚动、也不属于任何一个分区）。
   * 目前只有 AI Agent 侧栏的 git 告警走这里；它只在告警出现时才渲染，由调用方自己判断。
   */
  footer?: ReactNode
  /** 分区（`SectionShell` + `SectionHeader` + `SectionContent` 三段式），或任何自带分区块的内容 */
  children: ReactNode
}) {
  const collapsed = useSidebarCollapsed()

  return (
    <ActivitySidebar
      width={width}
      mobileOpen={mobileOpen}
      onMobileOpenChange={onMobileOpenChange}
      forceDrawer={forceDrawer}
    >
      {/*
        `open` 绑到全局折叠状态（活动栏按钮 / 应用配置的侧栏快捷键写的是同一份）。
        Provider 不另挂快捷键监听，避免绕过设置里的改键 / 禁用和录制状态。
        `className` 压掉自带的 `min-h-svh`：侧栏是列布局里的一格，高度由 `h-full` 决定。
      */}
      <SidebarProvider
        open={!collapsed}
        onOpenChange={(open) => setSidebarCollapsed(!open)}
        className="h-full min-h-0"
      >
        {/*
          宽度由 AppShell 的折叠外壳给（`width` prop），这里只负责撑满那一格。
          `bg-transparent!`：**不要 `bg-sidebar`** —— 侧栏与主区同底色，中间那条分隔线
          自己就能分开两栏；多一层灰底反而把分隔线衬得又脏又重。
          `!` 是必须的：原语把 `bg-sidebar` 写在基础类里，同属性工具类的胜负取决于
          生成顺序，不加强制修饰符就变成「看谁排后面」。
        */}
        <Sidebar collapsible="none" className="bg-transparent!" style={{ width: '100%' }}>
          {/* 手机抽屉的品牌行（可选，见 prop 注释）；不传时第一行就是分区标题 */}
          {header}
          {/*
            滚动交给 `StackedSections`（它按分区分配高度、各分区自己滚），
            所以这里把自带的 `overflow-auto` / `gap-2` 收掉，避免双滚动条与多出来的间距。
          */}
          <SidebarContent className="gap-0 overflow-hidden">
            <StackedSections>{children}</StackedSections>
          </SidebarContent>
          {footer && <SidebarFooter className="p-0">{footer}</SidebarFooter>}
        </Sidebar>
      </SidebarProvider>
    </ActivitySidebar>
  )
}
