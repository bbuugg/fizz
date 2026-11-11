/**
 * 手机形态的「竖条 + 侧栏抽屉」开关：**web 顶栏与 desktop 自绘标题栏共用这一颗**。
 *
 * 手机上活动栏竖条与侧栏抽屉**同进同出**（见 `mobile-sidebar.ts`），所以这里只有一个
 * 开关、读的也是同一份状态；`AppShell` 的 `railHidden` 由它派生，不存在两处各写一份。
 *
 * 为什么必须抽出来：web 端的入口在 `WebTitleBar`，desktop 端是另一份自绘标题栏 ——
 * 两份各写一颗按钮，迟早漂成两种图标 / 两种语义。桌面窗口能缩到手机宽度（`<768px`
 * 用同一套移动布局），没有这颗按钮时抽屉打不开、整个活动栏就再也回不来了（用户报过）。
 *
 * 当前功能区没有侧栏（整页界面）时不渲染：点了什么都不会发生。
 */
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import {
  setMobileSidebarOpen,
  useMobileSidebarOpen
} from '@fizz/agent-kit/shared/lib/mobile-sidebar'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useActiveActivity } from '../activities'

export function MobileSidebarToggle({ className }: { className?: string }) {
  const isMobile = useIsMobile()
  const { activity } = useActiveActivity()
  const open = useMobileSidebarOpen()

  const canOpenSidebar = Boolean(activity.sidebar)
  // 抽屉开 → 竖条也在（由 AppShell 派生）；关 → 两个一起消失。没有第二个开关可写
  const expanded = canOpenSidebar && open

  if (!isMobile || !canOpenSidebar) return null

  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn(
        'size-7! shrink-0 p-0! text-muted-foreground hover:text-foreground',
        className
      )}
      aria-label={expanded ? '收起侧栏' : '展开侧栏'}
      aria-pressed={expanded}
      onClick={() => setMobileSidebarOpen(!expanded)}
    >
      {expanded ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
    </Button>
  )
}
