"use client";

/**
 * **web 版**的窗口级顶栏（desktop 有自绘标题栏，见 `apps/desktop/src/renderer/TitleBar.tsx`，
 * 那边是另一棵 React 树 + 原生窗口控制；web 没有窗口可拖，这儿只负责「身份 + 手机入口」）。
 *
 * ## 为什么 web 也要有这一条
 *
 * web 桌面宽度下此前**完全没有窗口级 chrome**：品牌（logo + 名字）被挤在侧栏顶栏里，
 * 而侧栏一折叠品牌就跟着消失（`SidebarTopBar` 那块地让给了「当前工作区」）。于是浏览器
 * 里打开的 Fizz 和别的网页长得一模一样，顶端也没有窗口身份的落点。这一条补的就是它：
 * 一行 `h-9`、`bg-sidebar`，与侧栏 / 底部状态栏同色连成一片，视觉上和桌面端一致。
 *
 * 品牌用**同一个 `AppBrand`**（名字与 logo 只有一份来源，见它的注释）—— 别在这里再写
 * 一份 logo + 「Fizz」，改名时必漏。
 *
 * ## 手机上左边那颗「展开」
 *
 * 手机上这一条里的开关是 **web 端**进入竖条 + 侧栏抽屉的入口；desktop 的自绘标题栏
 * 挂的是同一颗组件（`MobileSidebarToggle`），两边语义只有一份。它俩**同进同出**：点一下 =
 * 竖条回到占位 + 抽屉打开；再点一下 = 一起收掉。
 *
 * ⚠️ 不要把它们拆成两个开关。早先底部状态栏有颗「功能区栏」开关、抽屉入口又是功能区图标
 * 本身，于是出现「竖条没了、侧栏还开着」这种半截形态（手机上只剩内容区，用户连自己在哪个
 * 功能区都看不出来），用户明确要求**一起**。所以手机版**没有独立的「隐藏侧栏」能力**：
 * 想让出横向空间就是连竖带侧栏一起收 —— 它们读的是**同一份状态**
 * （`app/layout/mobile-sidebar.ts` 的抽屉开关，竖条在不在由它派生），所以不存在不同步。
 *
 * ## 右上角的「AI 助手」
 *
 * 助手开关放这儿（`AiAssistantButton`）—— 顶栏右侧本就留白，把「全局主操作」放右上角比
 * 压在底栏角落顺手，且手机、桌面浏览器同一份顶栏、两端一致。「应用日志」则**下沉到底部
 * 状态栏最右端**（`LogsButton`）：它低频、且属于「全局工具」，交给状态栏的 `actions` 槽。
 */
import { AppBrand } from '@fizz/agent-kit/shared/components/AppBrand'
import { AiAssistantButton } from './AiAssistantButton'
import { MobileSidebarToggle } from './MobileSidebarToggle'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function WebTitleBar({ className }: { className?: string }) {
  return (
    <header
      className={cn('flex h-8 shrink-0 items-center gap-1 px-2', className)}
    >
      {/* 手机入口：与 desktop 自绘标题栏共用同一颗（见 MobileSidebarToggle） */}
      <MobileSidebarToggle />
      {/* 品牌区：`size-4.5` / `text-xs` 是给 36px 高的顶栏挑的（与 desktop 标题栏一致） */}
      <AppBrand iconClassName="size-4.5" nameClassName="text-xs" />
      {/*
        中间留白：web 没有可拖拽的窗口区域。品牌在左、助手开关在右，两端内容都靠边，
        中间这段空出来既有呼吸感，也避免小屏下两者贴到一起。
      */}
      <div className="min-w-0 flex-1" />
      {/* 右上角：AI 助手开关（全局右侧停靠面板）。手机上也渲染，面板以整屏浮层呈现 */}
      <AiAssistantButton />
    </header>
  )
}