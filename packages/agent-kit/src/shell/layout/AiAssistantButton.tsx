/**
 * 顶栏右上角的「AI 助手」开关。
 *
 * 助手面板是**全局**右侧停靠（与当前视图无关，对话 / 流程都能用），所以它的开关键
 * 要放在窗口级 chrome 上 —— web 是 `WebTitleBar`（手机、桌面浏览器同一份），desktop 是
 * 自绘标题栏（那边是另一棵 React 树，自己渲染一份、共用 `assistant-panel` 这份模块级状态）。
 *
 * 原先它在**底部状态栏**（与「应用日志」同一条），现按用户要求整体上移到顶栏右上角：
 * 顶栏右侧是空的（品牌在左、中间留白），把「常用主操作」放这儿比压在底栏角落更顺手。
 * 「应用日志」则反向下沉到底部状态栏最右端（见 `LogsButton`）。
 *
 * ⚠️ 不再按手机隐藏：手机上助手以**整屏浮层**呈现（见 `app-shell`），这颗键在手机上同样有效。
 */
import { Sparkles } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { setAssistantPanelOpen, useAssistantPanelOpen } from '@fizz/agent-kit/shared/lib/assistant-panel'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function AiAssistantButton({ className }: { className?: string }) {
  const open = useAssistantPanelOpen()
  const label = open ? '关闭 AI 助手' : '打开 AI 助手'

  return (
    <IconTip label={label} side="bottom">
      <Button
        size="sm"
        variant="ghost"
        className={cn(
          'size-7! shrink-0 p-0!',
          // 图标颜色即开关状态：收起时灰、展开时主题色，一眼能看出面板是否在场
          open ? 'text-primary hover:text-primary' : 'text-muted-foreground hover:text-foreground',
          className
        )}
        aria-expanded={open}
        aria-label={label}
        onClick={() => setAssistantPanelOpen(!open)}
      >
        <Sparkles className="size-4" />
      </Button>
    </IconTip>
  )
}
