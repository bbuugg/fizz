/**
 * **分段控件**（横向单选）：一整条凹槽 + 首尾相接的段，选中项浮起。
 *
 * 用 Radix `ToggleGroup`（`type="single"`）而不是 `Tabs`：DOM 里是 `role="radiogroup"`
 * + 单选按钮，读屏念「单选按钮，已选中」；`Tabs` 才给得到「触发器 ↔ 面板」同源的
 * 无障碍关系（`aria-controls` / `aria-labelledby`），念的是「标签页 1/2」。
 *
 * ⚠️ 切换**面板**的地方一律用 `@fizz/ui/tabs`，不要用这里：
 *
 * - `ThemeEditor` 的颜色 / 字体 / 代码 / 背景页签；
 * - 「导入 OpenAPI / Swagger」弹窗的来源切换（从文件 / 从 URL）。
 *
 * 这里留下的是「选一个取值、内容不变」的字段级多选一：设置页的工具权限档 / 明暗 /
 * 界面语言 / 屏幕常亮 / 滚动缓冲 / 默认终端 / 背景质感 / 背景显示方式，以及 MCP 的
 * 传输方式、WS 页的日志筛选与消息编码。
 *
 * 视觉上刻意与 `@fizz/ui/tabs` 的 default 变体同源（`bg-muted` 凹槽 + 选中项
 * `bg-background` + `shadow-sm`）：设置页里它们就是同一类「选一个」的控件，长得一样才
 * 不会让人以为是两种东西。
 */
import type { ReactNode } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@fizz/ui/toggle-group'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** 悬停提示（有些档位光看标签说不清） */
  title?: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  fullWidth = false,
  className
}: {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  /** 撑满容器并让各段等宽（弹窗里的短枚举，如 stdio / http / sse） */
  fullWidth?: boolean
  className?: string
}) {
  const tr = useT()
  return (
    <ToggleGroup
      type="single"
      /*
       * `spacing` 保持默认的 2，段间不留缝改用 `gap-0` 压掉根上的 `gap-[--spacing(--gap)]`：
       * `spacing={0}` 会触发「相邻项共享边框」那一套 `first/last:rounded-*`，把每段自己的
       * 圆角改成直角，与「凹槽里各自圆角的滑块」冲突。
       */
      value={value}
      onValueChange={(next) => {
        // 再点一次选中的那项时 Radix 会回调空串：单选组必须始终有一项，忽略即可
        if (next) onChange(next as T)
      }}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-0 rounded-lg bg-muted p-[3px]',
        fullWidth && 'flex w-full',
        className
      )}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          title={typeof option.title === 'string' ? tr(option.title) : option.title}
          className={cn(
            // 尺寸与设置页其它小控件同档（`text-xs`）；`min-w-0` 让 `fullWidth` 下等宽不被最小宽顶开
            'h-7 min-w-0 rounded-md px-3 text-xs font-normal transition-colors',
            // 未选中项悬停只变字色，不铺底色（凹槽已经是一层底了，再叠一层发脏）
            'text-muted-foreground hover:bg-transparent hover:text-foreground',
            // 选中态：白/浮起，与 `Tabs` 的 default 变体一致；暗色下换 input/30，否则没有对比
            'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
            'data-[state=on]:hover:bg-background dark:data-[state=on]:bg-input/30',
            fullWidth && 'flex-1 basis-0'
          )}
        >
          {typeof option.label === 'string' ? tr(option.label) : option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
