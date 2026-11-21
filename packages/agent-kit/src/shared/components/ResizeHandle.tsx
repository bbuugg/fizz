/**
 * 竖直拖拽条：拖动改变相邻面板宽度。视觉上是 1px 分隔线，但用负 margin 扩出更宽的抓取热区，
 * 不占额外布局宽度。
 *
 * ## 只跟手，不做弹性
 *
 * 这里曾经有「越界抵抗 + 松手回弹 + 逐帧写 SVG 的形变」三件套（橡胶带 + 欠阻尼弹簧）。
 * 手感确实好，但代价是**拖拽生命周期比一次 `pointerdown` 长**：松手后还要跑几十帧 rAF 才能
 * 收敛，而「松手」只有 `pointerup` 一条通道。指针在窗口外 / 跨源 `<iframe>` 上抬起时那条通道
 * 会断，rAF 就带着自己的起点快照活下来；多标签 / 多面板并存时几个僵尸循环轮流提交，
 * 宽度于是毫无规律地乱跳。**已整条拆掉**：现在值就是「起点 + 指针位移」夹进 `min`/`max`，
 * 抬手即收尾，没有任何跨帧状态。
 *
 * 抓手只保留「显隐」：悬停淡入、拖动中不透明。形变也试过（按拖动方向弯曲），调小两轮仍嫌多，
 * 一并撤了 —— 现在拖拽期间除了值在变，没有任何多余的每帧状态，抬手即收尾。
 *
 * 想加手感请先想清楚这条代价，别在原处重新长出一套弹簧。
 *
 * ## 触摸设备（手机 / 平板）要单独处理的三件事
 *
 * 桌面鼠标上「`pointerdown` + 监听 window 的 `pointermove`」就够了。触摸设备上这套会**直接失灵**，
 * 而且都跟 `e.preventDefault()` 无关 —— Chrome 56 起 preventDefault 已不再阻止滚动，触摸滚动只能靠
 * `touch-action` 声明式地关掉：
 *
 * 1. **缺 `touch-action: none`**：手指一动，浏览器就把它当成平移 / 滚动手势，向 window 发
 *    `pointercancel` 并停发 `pointermove`，拖拽当场夭折 —— 这就是「手机上根本拖不动」的直接原因。
 * 2. **缺 `pointercancel` 的收尾**：一旦被取消，挂在 window 上的 `pointermove` / `pointerup`
 *    永远不会被移除，`body` 的 `cursor: col-resize` / `user-select: none` 也永远解不掉，`onDragEnd`
 *    更是不会触发（面板的宽度过渡会一直关着）。之后**鼠标在页面上随便动一下就会改面板宽度**，
 *    光标与选中行为也被整页污染。`pointerup` / `pointercancel` / `blur` 统一走一个幂等的 `cleanup()`。
 * 3. **热区只有 8px，且指示线只在 hover 时浮现**：手指按不准；触摸又没有 hover，那条线压根不出现，
 *    用户连「这里能拖」都看不出来。故窄屏热区放宽到 16px，可拖提示交给常显的抓手。
 *
 * 改**高度**的分隔条（纵向，位置各异、套不进这个组件的 JSX）用同文件下面的 `useDragResize`：
 * 同一套管线，别在调用方再手写一遍 `pointermove`（漏掉 `touch-action` 就是手机拖不动）。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { ResizeGrip } from '@fizz/agent-kit/shared/components/ResizeGrip'

/** 面板宽度落值前压到 0.1px：存进 localStorage 的是一串整数好看点，视觉上也没差别 */
function quantize(value: number): number {
  return Math.round(value * 10) / 10
}

interface Props {
  /** 当前面板宽度（px） */
  width: number
  /** 最小宽度（px） */
  min: number
  /** 最大宽度（px） */
  max: number
  onResize: (width: number) => void
  /** 面板位于拖拽条右侧时传 true：向左拖动才是增大宽度 */
  invert?: boolean
  /** 拖拽开始 / 结束（调用方据此关掉宽度过渡 —— 过渡追不上指针，会露出空白） */
  onDragStart?: () => void
  onDragEnd?: () => void
  /** 双击分隔线（一般是「恢复默认宽度」）；传了就提示里带上 */
  onDoubleClick?: () => void
  className?: string
}

export function ResizeHandle({
  width,
  min,
  max,
  onResize,
  invert = false,
  onDragStart,
  onDragEnd,
  onDoubleClick,
  className
}: Props) {
  /**
   * min / max / onResize 每帧现取：拖到一半容器变窄会把 `max` 重算、调用方也可能换掉
   * `onResize`，不能把 props 关在 `pointerdown` 那一刻的闭包里。
   */
  const latest = useRef({ min, max, onResize })
  latest.current = { min, max, onResize }
  /** 面板长在抓手的哪一侧：换算成「屏幕方向 → 宽度变化」的正负号 */
  const dir = invert ? -1 : 1
  /** 拖动中（只用来让抓手保持不透明） */
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useDragResize<{ startWidth: number }>({
    axis: 'x',
    onStart: () => {
      setDragging(true)
      onDragStart?.()
      return { startWidth: width }
    },
    onMove: (delta, ctx) => {
      const { min, max, onResize } = latest.current
      const next = Math.max(min, Math.min(max, ctx.startWidth + delta * dir))
      onResize(quantize(next))
    },
    onEnd: () => {
      setDragging(false)
      onDragEnd?.()
    }
  })

  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title={onDoubleClick ? '拖动调整宽度（双击恢复默认）' : '拖动调整宽度'}
      // touch-none：关掉触摸滚动 / 平移，否则手势会被浏览器抢走（见文件头 1）
      // -mx-2 + w-4：触摸热区 16px（sm 以上回到 8px）；负 margin 保证不占布局宽度，只向两侧各压 8px
      // [-webkit-touch-callout:none]：长按别弹 iOS 的选择菜单。
      //   ⚠️ 必须用任意属性写法：Tailwind v4 **没有** `touch-callout-none` 这个类（实测编译不出来，
      //   v4 改用无前缀属性 + 自动加前缀，而 -webkit-touch-callout 没有无前缀对应物，就整条丢了）。
      //   同理 select-none 在 v4 里是有效的（它生成 -webkit-user-select + user-select）。
      className={cn(
        'group/resize relative z-10 -mx-2 w-4 shrink-0 cursor-col-resize touch-none select-none [-webkit-touch-callout:none] sm:-mx-1 sm:w-2',
        className
      )}
    >
      {/*
        这条热区上**不画任何线**（以前是一条常驻淡线 + 一条 hover 时变主色的线）。
        侧栏 / 助手面板本来就有 `border-l`，再加一条与它错开半根像素的线就是双线；分栏那边
        同理（见 `Splitter`）。可拖的提示统一交给抓手：桌面悬停淡入，
        触摸设备（没有 hover）靠 `[@media(hover:none)]` 常显。
      */}
      <ResizeGrip axis="x" dragging={dragging} />
    </div>
  )
}

/**
 * 全局**唯一**活动拖拽的收尾函数。
 *
 * 指针在窗口外 / 跨源 `<iframe>` / `<webview>` 上抬起时 `pointerup` 可能收不到，
 * 监听与 `body` 上的光标就会留在页面里。这里做一道**串行闸门**：新拖拽一开始先把上一个
 * 强行收掉。正常路径下它早已被 `cleanup` 清空，什么都不做。
 */
let activeDrag: (() => void) | null = null

/**
 * 拖拽分隔条的**指针管线**（触摸安全的唯一实现）。
 *
 * `ResizeHandle` 是「改宽度」的现成组件，但改高度的几条分隔条（API 页响应区、WS 页发送区、
 * 侧栏内容组标题行）位置与定位方式各不相同、套不进同一个 JSX，于是共用这个 hook；
 * `Splitter`（多标签分栏）也走它，只是单位从 px 换成权重。
 *
 * 一帧只落一次值：`pointermove` 在高刷屏上一帧可能来好几条，每条都算一遍会让面板里的
 * iframe / xterm 跟着重排好几次。抬手时补最后一帧，落点不会差一截。
 *
 * ⚠️ 调用方仍要在**自己的** className 里带上 `touch-none`（见上）：这个 hook 只管拖动开始后的
 * 管线，起点那一按能不能被识别成拖拽由元素的 `touch-action` 决定；热区宽窄（手机上要放宽到
 * 16px、桌面 8px）也由调用方按定位方式自己写。
 *
 * `onStart` 返回 `null` 表示「起点无效」（比如容器还没量到尺寸），此时不进入拖拽。
 * 返回的任意对象会原样交给 `onMove` —— 起点状态就放在那里，别在 `onMove` 里读 state
 * （那是闭包里的旧值）。
 */
export function useDragResize<C>({
  axis,
  cursor,
  onStart,
  onMove,
  onEnd
}: {
  axis: 'x' | 'y'
  /** 拖动期间 body 上的光标；缺省按轴用 `col-resize` / `row-resize` */
  cursor?: string
  onStart?: (e: ReactPointerEvent<HTMLDivElement>) => C | null
  onMove: (delta: number, ctx: C) => void
  onEnd?: () => void
}): (e: ReactPointerEvent<HTMLDivElement>) => void {
  /** 回调每次渲染都是新函数：存进 ref，免得拖拽中途换成新实现后读到旧值 */
  const latest = useRef({ onStart, onMove, onEnd })
  latest.current = { onStart, onMove, onEnd }
  /** 卸载时把还在跑的拖拽收掉 —— 否则 window 上的监听 / body 样式会漏在页面里 */
  const abortRef = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      abortRef.current?.()
    },
    []
  )

  return useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      // 只认主键 / 单指：右键（要弹菜单）、中键、以及另一根手指按在别处，都不该被当成拖拽起点
      if (!e.isPrimary) return
      if (e.pointerType === 'mouse' && e.button !== 0) return

      e.preventDefault()
      const handle = e.currentTarget
      const pointerId = e.pointerId
      const start = axis === 'x' ? e.clientX : e.clientY
      const ctx = latest.current.onStart?.(e)
      if (ctx === null) return

      /** 最新指针坐标（只在 rAF 里读它算值，`pointermove` 自己不落值） */
      let pointer = start
      let raf = 0
      let done = false

      const flush = (): void => {
        raf = 0
        latest.current.onMove(pointer - start, ctx as C)
      }

      const move = (ev: PointerEvent): void => {
        pointer = axis === 'x' ? ev.clientX : ev.clientY
        if (raf === 0) raf = requestAnimationFrame(flush)
      }

      /**
       * 幂等收尾：`pointerup` / `pointercancel` / `blur` 可能只来一个，也可能连着来
       * （触摸被浏览器接管时是 cancel，取消后再抬手还会补一个 up）。没有 `done` 闸门的话，
       * 后到的那个会把监听与 `body` 上的样式解第二遍。
       */
      const cleanup = (ev?: Event): void => {
        if (done) return
        done = true
        // 抬手 / 取消那一帧的坐标也要吃进来：上一帧之后可能还挪了几像素（`blur` 没坐标）
        if (ev && 'clientX' in ev) {
          const point = ev as PointerEvent
          pointer = axis === 'x' ? point.clientX : point.clientY
        }
        window.removeEventListener('pointermove', guardedMove)
        window.removeEventListener('pointerup', cleanup)
        window.removeEventListener('pointercancel', cleanup)
        window.removeEventListener('blur', cleanup)
        try {
          handle.releasePointerCapture(pointerId)
        } catch {
          // 指针已释放（如 pointercancel）时忽略
        }
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.body.style.touchAction = ''
        // 还没落地的那一帧补上，否则松手位置会差最后几个像素
        if (raf !== 0) {
          cancelAnimationFrame(raf)
          flush()
        }
        if (activeDrag === cleanup) activeDrag = null
        abortRef.current = null
        latest.current.onEnd?.()
      }

      /**
       * ⚠️ 这里兼当 `pointerup` 的兜底。
       *
       * 指针在**窗口外**（拖到屏幕边缘 / 浏览器外）或者跨源 `<iframe>` / `<webview>` 上抬起时，
       * window 收不到 `pointerup`（`setPointerCapture` 跨源也未必生效）。指针移回窗口后的
       * 第一个 `move` 一定带着 `buttons === 0`（没有任何键按着），据此补一次收尾即可。
       * 触摸没有这个信号（抬手后根本没有 move），但它一定会收到 `pointerup` / `pointercancel`，
       * 由那两个入口负责。
       */
      const guardedMove = (ev: PointerEvent): void => {
        if (ev.buttons === 0 && ev.pointerType !== 'touch') cleanup(ev)
        else move(ev)
      }

      // 先把可能残留的上一次拖拽收掉：它的收尾会把 body 上的光标 / 选中样式清空，
      // 放在下面那几行之后就会把本次刚设好的样式又抹掉
      activeDrag?.()

      try {
        handle.setPointerCapture(pointerId)
      } catch {
        // 合成事件没有真实指针，退化为 window 监听即可
      }
      document.body.style.cursor = cursor ?? (axis === 'x' ? 'col-resize' : 'row-resize')
      document.body.style.userSelect = 'none'
      // 手势起点已有 touch-none，这里在 body 上再关一次：手指滑出抓手后 iOS 仍可能开始橡皮筋回弹
      document.body.style.touchAction = 'none'
      window.addEventListener('pointermove', guardedMove)
      window.addEventListener('pointerup', cleanup)
      window.addEventListener('pointercancel', cleanup)
      window.addEventListener('blur', cleanup)

      abortRef.current = cleanup
      activeDrag = cleanup
    },
    [axis, cursor]
  )
}
