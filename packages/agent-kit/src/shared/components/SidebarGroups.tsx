'use client'

/**
 * 侧栏里的**内容组**（可折叠标题 + 内容）与**顶部动作区**。
 *
 * ## 为什么不放在 `StackedSections` 里
 *
 * `StackedSections` 管的是**分区**（`SectionShell`）：按 `grow` 权重瓜分高度、边界可拖、
 * 折叠态曾经落盘 —— 那是「布局」。这里管的是**同一个滚动区里的内容组**：折叠只切内容、
 * 不动布局高度、状态在内存里。两者语义不同，混在一个文件里必然又有人给分区挂 `onToggle`。
 *
 * ## 谁在用
 *
 * - AI Agent 侧栏（`features/chat/AgentSidebar`）：任务 / 工作区两组 + 顶部「新对话 /
 *   定时任务」；
 * - 主机侧栏（`features/hosts/HostsSidebar`）：主机与终端一组 + 顶部「新建主机 / 隧道 /
 *   脚本」（脚本清单在主区域那一页，这里只是入口）。
 *
 * 三条侧栏（含接口请求、笔记）的**组标签**本来就是同一档视觉（`SectionHeader` 的 12px 灰字），
 * 所以抽出来之后不会出现「AI Agent 的组标签比主机的高一档」这种漂移。
 *
 * ## 高度策略只有三档（别再加第四档）
 *
 * - `size="max"`：恒封顶（`max-h-40`），超出在组内滚。给**上面**的组用 —— 它下面还有
 *   别的组，不封顶的话条数一多就把下面的挤出视野；
 * - `size="half"`：**按内容高度、最多占一半**（`max-height: 50%`）。同样给上面的组用，
 *   但它的条数波动很大（AI Agent 侧栏的「任务」）：固定 160px 在宽屏上只能看到几行，
 *   而内容少时又不该留一块空白 —— 内容多高就多高，到一半为止，超出在组内滚；
 * - `size="fill"`：吃剩余高度（`flex-1`），超出才在组内滚。给**最后一块**用。
 *
 * ⚠️ 别让 `max` / `half` 组在自己成为最后一块时改吃剩余高度：标签行还在它下面，
 * `flex-1` 会把下面那行推到侧栏底部（用户看到的就是「一折叠，标题自己跑到底下去了」）。
 *
 * ⚠️ `half` 的 50% 是**相对外层滚动容器**的高度（不是相对侧栏）：百分比 `max-height`
 * 要一个确定高度的包含块，那个容器正是被 flex 分配好高度的那个。所以它上面还有动作区
 * （「新对话 / 定时任务」）时，一半是按**动作区之下**的剩余高度算的，符合直觉。
 * 另外它**没有** `shrink-0`：窗口太矮时它允许被压扁（组内滚），不会把下面的组挤出去。
 *
 * ## 空态
 *
 * `empty` 传文案即可（`count` 为 0 时渲染）。**加载中不要传** —— 否则列表请求还没落地
 * 就会先闪一句「还没有项目」。需要骨架屏的调用方自己判断，把它放进 `children`。
 */
import { useState, type ComponentType, type ReactNode } from 'react'
import { Skeleton } from '@fizz/ui/skeleton'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { SectionHeader } from '@fizz/agent-kit/shared/components/StackedSections'

/**
 * 顶部动作区：贴在清单最上方、与下面各内容组分开的一排**整行动作**。
 *
 * 与组标签的区别是刻意的：动作是 `h-8` 圆角 + hover 底色 + 行首图标（一眼看出能点），
 * 组标签是一行 12px 灰字（只是标签）。别把动作做成 `SectionHeader`。
 *
 * `pb-2` 比顶部 `pt-1` 厚：这排动作与第一块内容组之间要留一段肉眼可见的间隔，
 * 否则几颗按钮和「任务 (n)」挤成一坨，读起来像同一个列表。
 */
export function SidebarActions({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 flex-col gap-0.5 px-2 pt-1 pb-2">{children}</div>
}

/** 动作区里的一行：图标 + 文字（+ 可选的行尾数字） */
export function SidebarAction({
  icon: Icon,
  label,
  trailing,
  title,
  disabled,
  onClick
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  /** 行尾的附加内容（定时任务那种「有几条」的计数） */
  trailing?: ReactNode
  /** 悬停提示；不传就用 `label` */
  title?: string
  /** 不可用（例如正在跑同一个动作）：置灰且不吃点击 */
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      disabled={disabled}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-50"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {trailing}
    </button>
  )
}

export interface SidebarGroupProps {
  title: string
  /** 标题后的数量（0 不显示括号，见 `SectionHeader`） */
  count?: number
  /** 组收起时也要提示「里面有一条没看过」 */
  dot?: boolean
  /** 缩进到 40px，与顶部动作区的文字左对齐 */
  alignIndent?: boolean
  /** 受控展开态；不传则组件自己管（默认展开） */
  open?: boolean
  onToggle?: () => void
  /** 高度策略，见文件头 */
  size?: 'max' | 'half' | 'fill'
  /** `size="fill"` 时参与瓜分剩余空间的权重（同一容器内相对值），默认 1 */
  grow?: number
  /** 标题栏右侧的操作按钮 */
  extra?: ReactNode
  /** 内容容器自己滚（默认）。传 `false` 时容器不滚，children 自己负责（例如「搜索框 + 列表」） */
  scroll?: boolean
  /** `count` 为 0 时显示的空态文案；**加载中不要传**，见文件头 */
  empty?: ReactNode
  className?: string
  children?: ReactNode
}

/**
 * 一个可折叠内容组：标题行 + （展开时）内容容器。
 *
 * 高度策略落在**内容容器**上（不是标题行）：`max` 组封顶后组内自己滚，`fill` 组吃掉
 * 外层剩下的高度 —— 这样两条侧栏的空间分配规则是同一份，不会各写一遍 flex 类名。
 */
export function SidebarGroup({
  title,
  count,
  dot,
  alignIndent,
  open,
  onToggle,
  size = 'max',
  grow = 1,
  extra,
  scroll = true,
  empty,
  className,
  children
}: SidebarGroupProps) {
  /** 不受控时的展开态：刷新即回默认展开（不落盘 —— 落盘的折叠态会把内容永久藏起来） */
  const [internalOpen, setInternalOpen] = useState(true)
  const expanded = open ?? internalOpen
  const toggle = onToggle ?? (() => setInternalOpen((v) => !v))

  return (
    <>
      <SectionHeader
        title={title}
        count={count}
        dot={dot}
        alignIndent={alignIndent}
        extra={extra}
        open={expanded}
        onToggle={toggle}
      />
      {expanded && (
        <div
          className={cn(
            'flex min-h-0 flex-col',
            // `max` 档：恒封顶、超出在组内滚（见文件头）。`half` / `fill` 档的高度走内联
            // 样式：前者是百分比 `max-height`，后者要带 `grow` 权重 —— Tailwind 拼不出
            // `flex-${n}` 这种动态类名，百分比任意值也不如直接写清楚。
            size === 'max' && 'max-h-40 shrink-0',
            scroll && 'overflow-auto no-scrollbar',
            className
          )}
          style={
            size === 'fill'
              ? { flex: `${grow} 1 0`, minHeight: 96 }
              : size === 'half'
                ? // 内容多高就多高，到外层容器的一半为止；不 `shrink-0`，窗口太矮时允许被压扁
                  { flex: '0 1 auto', maxHeight: '50%' }
                : undefined
          }
        >
          {count === 0 && empty !== undefined ? (
            <div className="px-2 py-1 text-xs leading-5 text-muted-foreground">{empty}</div>
          ) : (
            children
          )}
        </div>
      )}
    </>
  )
}

/**
 * 组内容的加载骨架：几行等高的假行（`h-7` 对齐一条侧栏行）。
 *
 * 与 `empty` 是**配套**的两半，见文件头那条「加载中不要传空态」：加载中 `count` 也是 0，
 * 传了 `empty` 就会先闪一句「还没有…」；正确做法是加载中把 `empty` 留空、把这里放进
 * `children`，等清单位落（`hostsLoaded` / `conversationsLoaded`）之后再交回真实列表 / 空态。
 *
 * 不自带水平内边距：调用方的组往往已经有 `px-2`（真实行自带同样的内边距），这里再加一层
 * 会比真实行窄一档，骨架切列表时横向抖一下。
 */
export function SidebarRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-0.5" aria-busy="true" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full rounded-md" />
      ))}
    </div>
  )
}
