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
 * - `size="max"`：恒封顶（`max-height: 160px`），超出在组内滚。给**上面**的组用 —— 它下面还有
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
 * ## 多组侧栏：固定顺序 + 独立展开 + 可拖高度
 *
 * AI Agent 的「任务 / 工作区」、接口请求的「请求 / 历史记录」都是**多组共存**的
 * 同一列：顺序**永远固定**（展开 / 收起不会像手风琴那样把点开的那组挪到最前，
 * 与 VSCode 侧栏一致），每组独立展开，可以同时展开多组。展开组都用 `size="fill"`
 * 吃剩余高度，于是：
 *
 * - 只展开上面那组：下面那组的标题被挤到底部；
 * - 只展开下面那组：上面那组只剩一行标题留在原位（顺序不变），下面那组吃满；
 * - 两组都展开：**按上次的位置分** —— 没拖过就按 `grow` 权重（调用方都传 1，即
 *   1:1；刻意不做「刚展开的组拿 3/4」，那会让收起再展开时高度变一档）；交界处可以
 *   上下拖改比例（上面那组传 `height` / `onResizeHeight`），拖过之后按记住的像素走。
 *
 * ⚠️ 拖过的组记住的高度**必须一直传**（另一组收起时也传，另加 `solo` 让它吃满）：
 * 只在「两组都展开」时才传、只剩一组时清成 `undefined` 的写法会让 basis 在 0 ↔ H
 * 之间过渡，与 grow 的 1 ↔ 0 一起插值，展开动画会**先冲高再缩回**（2026-11 用户
 * 反馈）。basis 恒为记住的高度、只让 grow 变化，曲线才是单调的（见 `height` / `solo`）。
 *
 * 折叠态与拖出来的高度都只存内存（刷新回默认）—— 与单组时的口径一致，
 * **不落盘**：折叠态一旦持久化，改默认值或挪走内容之后老数据会把东西永久藏起来。
 *
 * ## 展开 / 收起是**高度过渡**，内容不卸载
 *
 * 内容区在收起后仍然留在 DOM 里（`flex-basis` / `min-height`（`fill`）或 `max-height`
 * （`max` / `half`）过渡到 0、`opacity` 到 0、`overflow-hidden`），所以动画能真的
 * 「收起来」而不是整块消失。收起时挂 `inert`，内容里的输入框 / 按钮不会被 Tab 到。
 *
 * ⚠️ 过渡里**包含 `flex-basis`**（拖动改的是它），而拖动时每帧都在改它 —— 所以拖动
 * 期间要关掉过渡（`dragging` 由 `SidebarGroupResizer` 上报），否则高度会追着指针
 * 慢慢滑，手感发黏。
 *
 * ## 组与组之间有一条**常显**的分隔线
 *
 * 多组同时展开时，交界处的拖拽条画一条 1px 的 `bg-border`（选中 / 悬停变主色）：
 * 默认透明的话没人知道那里能拖，而这里的分组是「同一个滚动区里的两段列表」，
 * 没有分区外壳那种看得见的边界，线就是唯一的抓手提示。
 *
 * ## 空态
 *
 * `empty` 传文案即可（`count` 为 0 时渲染）。**加载中不要传** —— 否则列表请求还没落地
 * 就会先闪一句「还没有项目」。需要骨架屏的调用方自己判断，把它放进 `children`。
 */
import {
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode
} from 'react'
import { Skeleton } from '@fizz/ui/skeleton'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useDragResize } from '@fizz/agent-kit/shared/components/ResizeHandle'
import { SectionHeader } from '@fizz/agent-kit/shared/components/StackedSections'

/** `size="fill"` 的内容区最小高度（px）；拖动分隔条时也按它给下组留位置 */
const FILL_MIN_HEIGHT = 96

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
  /**
   * 记住的像素高度（px）。**传了就一直是它**，另一组收起 / 展开都不清 —— 模式切换
   * 只改 `flex-grow`，`flex-basis` 恒等于它，过渡曲线才是单调的（见 `solo`）。
   *
   * - 另一组也展开：`flex: 0 0 Hpx`，固定高度，差额由下面那组吸收；
   * - 只有本组展开（`solo`）：`flex: 1 1 Hpx`，以 H 为基准长满剩余高度。
   *
   * ⚠️ 别在另一组收起时把 `height` 改成 `undefined`（曾经就是这么写的）：那样 basis
   * 会在 0 ↔ H 之间过渡，同时 grow 在 1 ↔ 0 之间过渡，两者一起插值会让另一组分到的
   * 高度在中间帧**先超过终值再回落**（2026-11 用户反馈的「展开先冲高再缩回」）。
   */
  height?: number
  /**
   * 只有本组展开（另一组已收起）时传 `true`：`height` 从「固定高度」变成「弹性基准」，
   * 本组吃满剩余高度。父组件按「两组是否都展开」取反传（`solo={!xxxResizable}`）。
   */
  solo?: boolean
  /**
   * 传了才渲染**底部分隔条**：上下拖动改的是本组展开内容的高度，差额由下面那组
   * （同样的 `fill`）自动吸收。只在「下面还有一组也展开」时才传 —— 否则本组本来
   * 就吃满剩余高度，拖了也没意义。
   */
  onResizeHeight?: (height: number) => void
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
  height,
  solo,
  onResizeHeight,
  className,
  children
}: SidebarGroupProps) {
  /** 不受控时的展开态：刷新即回默认展开（不落盘 —— 落盘的折叠态会把内容永久藏起来） */
  const [internalOpen, setInternalOpen] = useState(true)
  const expanded = open ?? internalOpen
  const toggle = onToggle ?? (() => setInternalOpen((v) => !v))
  /** 正在拖高度：期间关掉过渡，否则 `flex-basis` 的动画会追着指针慢慢滑 */
  const [dragging, setDragging] = useState(false)

  /**
   * 高度样式（展开 / 收起两套，靠 `transition` 过渡出动画）。
   *
   * 收起态不是 `display:none`：内容留在 DOM 里，`fill` 组把 `flex-basis` / `min-height`
   * 收到 0，`max` / `half` 组把 `max-height` 收到 0 —— 这样高度是**连续**变化的。
   *
   * ⚠️ 记住的高度在两种模式下都当 `flex-basis` 用（`solo` 时另加 `grow: 1`）：
   * 收起 / 展开另一组只改 `flex-grow`，basis 不变，过渡才是单调的。basis 跟着模式
   * 在 0 ↔ H 之间来回变、grow 同时在 1 ↔ 0 之间变，就会出现「先冲高再缩回」
   * （见 `height` 属性的注释）。
   */
  const sizeStyle: CSSProperties = expanded
    ? height !== undefined
      ? solo
        ? // 只有本组展开：以记住的高度为基准长满剩余高度
          { flex: `1 1 ${height}px`, minHeight: FILL_MIN_HEIGHT, opacity: 1 }
        : // 另一组也展开：固定高度，差额由下面那组吸收
          { flex: `0 0 ${height}px`, minHeight: FILL_MIN_HEIGHT, opacity: 1 }
      : size === 'fill'
        ? { flex: `${grow} 1 0`, minHeight: FILL_MIN_HEIGHT, opacity: 1 }
        : size === 'half'
          ? // 内容多高就多高，到外层容器的一半为止；不 `shrink-0`，窗口太矮时允许被压扁
            { flex: '0 1 auto', maxHeight: '50%', opacity: 1 }
          : { maxHeight: 160, opacity: 1 }
    : size === 'fill'
      ? { flex: '0 0 0px', minHeight: 0, opacity: 0 }
      : size === 'half'
        ? { flex: '0 1 auto', maxHeight: '0%', opacity: 0 }
        : { maxHeight: 0, opacity: 0 }

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
      <div
        // 拖动分隔条靠它量「这一组占多高」（见 `SidebarGroupResizer`）
        data-sidebar-group-content=""
        // 收起后内容仍挂载（动画需要），用 inert 把它从 Tab / 读屏里摘出去
        inert={!expanded}
        className={cn(
          'flex min-h-0 flex-col',
          // `max` 档：恒封顶、超出在组内滚（见文件头）。高度走内联样式：`max` / `half`
          // 要能过渡 `max-height`，`fill` 要带 `grow` 权重 —— Tailwind 拼不出动态类名。
          size === 'max' && 'shrink-0',
          // 收起（或正在收起）时必须是 `overflow-hidden`：内容盒已经缩到 0，不裁剪会画到组外面
          expanded ? scroll && 'overflow-auto no-scrollbar' : 'overflow-hidden',
          !dragging &&
            'transition-[flex-grow,flex-basis,min-height,max-height,opacity] duration-200 ease-out motion-reduce:transition-none',
          className
        )}
        style={sizeStyle}
      >
        {count === 0 && empty !== undefined ? (
          <div className="px-2 py-1 text-xs leading-5 text-muted-foreground">{empty}</div>
        ) : (
          children
        )}
      </div>
      {expanded && onResizeHeight && (
        <SidebarGroupResizer onResize={onResizeHeight} onDragStateChange={setDragging} />
      )}
    </>
  )
}

/**
 * 组与组之间的高度拖拽条（多组同时展开时才有意义，见 `SidebarGroup` 的 `onResizeHeight`）。
 *
 * 用 `h-0` 的兄弟节点 + 绝对定位的抓手：不参与 flex 高度分配，抓手的中心线正好压在
 * 两组内容的交界线上。拖动改的是**上面那组内容**的像素高度，下面那组是 `fill`，
 * 自动吃掉差额 —— 和 `StackedSections` 的分区分隔条同一套交互，但这里的高度存在
 * 调用方内存里（组不是分区，没有全局 id）。
 *
 * 视觉上常显一条 1px 的线（悬停 / 拖动变主色）：不画线就没人知道那里能拖。
 *
 * `onDragStateChange` 上报拖动起止：拖动期间上面的组要关掉高度过渡，否则每一步都
 * 在追动画，手感发黏。
 *
 * 指针管线走 `useDragResize`（`touch-action` + 幂等收尾），别手写 `pointermove`。
 */
function SidebarGroupResizer({
  onResize,
  onDragStateChange
}: {
  onResize: (height: number) => void
  onDragStateChange: (dragging: boolean) => void
}) {
  const tr = useT()
  const onPointerDown = useDragResize<{ startHeight: number; maxHeight: number }>({
    axis: 'y',
    onStart: (e) => {
      const content = e.currentTarget.previousElementSibling as HTMLElement | null
      const container = e.currentTarget.parentElement
      if (!content || !container) return null
      /**
       * 上限 = 容器高度 - 各组标题行 - 下组最小高度。
       * 标题行高度由「容器高度 - 所有展开内容高度」反推，不必知道有几组。
       */
      const contents = Array.from(
        container.querySelectorAll<HTMLElement>('[data-sidebar-group-content]')
      )
      const contentHeight = contents.reduce(
        (sum, el) => sum + el.getBoundingClientRect().height,
        0
      )
      const headersHeight = Math.max(0, container.clientHeight - contentHeight)
      // 放在校验之后：起点无效时 hook 会直接 return，`onEnd` 不会触发，这里不能先置 true
      onDragStateChange(true)
      return {
        startHeight: content.getBoundingClientRect().height,
        maxHeight: Math.max(
          FILL_MIN_HEIGHT,
          container.clientHeight - headersHeight - FILL_MIN_HEIGHT
        )
      }
    },
    // 拖动的是**分隔线本身**：向上拖（delta 为负）= 上面那组变矮、下面那组变高，
    // 分隔线跟着指针走（反过来会让线朝手指的反方向跑，像「拖反了」）
    onMove: (delta, drag) =>
      onResize(
        Math.max(
          FILL_MIN_HEIGHT,
          Math.min(drag.maxHeight, drag.startHeight + delta)
        )
      ),
    onEnd: () => onDragStateChange(false)
  })

  return (
    <div
      onPointerDown={onPointerDown}
      title={tr('拖动调整高度')}
      className="group/resize relative z-20 h-0 shrink-0 cursor-row-resize touch-none select-none [-webkit-touch-callout:none]"
    >
      <div className="absolute inset-x-0 top-0 h-3 -translate-y-1/2 sm:h-2">
        {/* 常显：不画线就没人知道这里能拖（选中 / 悬停时变成主色） */}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/resize:bg-primary group-active/resize:bg-primary" />
      </div>
    </div>
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
