/**
 * 触屏上的模型 id 查看入口（手机 / 平板，与桌面端的悬停 tooltip 互补）。
 *
 * 桌面把 id 收在悬停 tooltip 里；`Tooltip` 在触屏被整体停用（没有悬停语义），
 * 所以手机额外给一颗 ⓘ —— 点开 Popover 看完整 id 与 agent 给的描述。
 *
 * 两处模型清单共用同一份（设置 → 模型「从上游拉取」、设置 → ACP「挑模型」）：
 * 那两个弹窗的列表都只显示可读文本，完整 id 都靠「悬停 tooltip + 触屏 ⓘ」这一套兜底。
 */
import { Info } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@fizz/ui/popover'
import { isTouchOnlyInput } from '@fizz/agent-kit/shared/hooks/useVirtualKeyBar'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function ModelIdInfo({ value, description }: { value: string; description?: string }) {
  const tr = useT()
  if (!isTouchOnlyInput()) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={tr('查看模型 ID')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-auto max-w-72 text-xs">
        <div className="break-all font-mono">{value}</div>
        {description ? (
          <div className="mt-1 text-muted-foreground">{description}</div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
