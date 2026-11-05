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
 * - 「导入 OpenAPI / Swagger」弹窗的来源切换（从文件 / 从 URL）；
 * - 「添加 / 编辑主机」弹窗顶部的本地终端 ↔ SSH（`HostDialog`）—— 两种类型连字段
 *   集合都不同（本机终端没有凭据、SSH 没有 shell / 工作目录），换的是整块表单，不是
 *   同一个值。它长得像分段控件只是因为它就贴在表单顶上，读屏应该念「标签页 2/2」。
 *
 * 这里留下的是「选一个取值、内容不变」的字段级多选一：设置页的工具权限档 / 明暗 /
 * 界面语言 / 屏幕常亮 / 滚动缓冲 / 默认终端 / 背景质感 / 背景显示方式，以及 MCP 的
 * 传输方式、WS 页的日志筛选与消息编码。
 *
 * 视觉上刻意与 `@fizz/ui/tabs` 的 default 变体同源（`bg-muted` 凹槽 + 选中项
 * `bg-background` + `shadow-sm`）：设置页里它们就是同一类「选一个」的控件，长得一样才
 * 不会让人以为是两种东西。
 *
 * ⚠️ **暗色下选中项不能用 `bg-input/30`**（shadcn 上游写法，本项目 `tabs.tsx` 已同步
 * 改成 `bg-input`）：`--input` 本身就是 `oklch(1 0 0 / 15%)`，再乘 30% ≈ 4.5% 白叠在
 * `--muted` 上，实测只差一个灰阶（#2e2e2e → #373737），满屏扫一眼分不出哪项被选中。
 * 这里用 `--input` 本色（≈ `#4d4d4d`），并让 hover 保持同一底色 —— 否则 hover 已选中项
 * 会被亮色那条规则拉回 `bg-background`，反而更暗。
 *
 * ⚠️ **选项多到装不下时换行，不横向溢出**（`flex-wrap` + `max-w-full`）。
 * 段内文字是 `whitespace-nowrap`（见 `toggle.tsx`），整条控件的最小宽度 = 各段文字宽之和；
 * 段数又不固定 —— 比如「默认终端」= `跟随系统默认` + 宿主探测到的每个 shell（Windows 上全装
 * 齐了是 7 段，约 540px）。不换行的话控件会顶穿容器，而设置页的滚动容器是
 * `overflow-auto`（`overflow-y: auto` 时 `overflow-x` 按规范也算 auto），于是整页底下多出
 * 一条横向滚动条 —— 内容没被截断，但看着像布局坏了。换成换行后宽度永远不超过容器，
 * 窄了就在凹槽里排成两行。
 *
 * `gap-y-1`：换行后两行之间留 4px，否则上下两行的圆角滑块会贴在一起。
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
        // `flex-wrap max-w-full`：装不下就换行，宽度永不超过容器（理由见文件头）；`gap-y-1`
        // 只管换行后的行间距，单行时不起作用
        'inline-flex w-fit max-w-full shrink-0 flex-wrap items-center gap-0 gap-y-1 rounded-lg bg-muted p-[3px]',
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
            // 选中态：白/浮起，与 `Tabs` 的 default 变体一致
            'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
            'data-[state=on]:hover:bg-background',
            // 暗色下换 input 本色（≈15% 白）拉开一档；hover 同色，避免已选中项被亮色规则拉回更暗的 background
            'dark:data-[state=on]:bg-input dark:data-[state=on]:hover:bg-input',
            fullWidth && 'flex-1 basis-0'
          )}
        >
          {typeof option.label === 'string' ? tr(option.label) : option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
