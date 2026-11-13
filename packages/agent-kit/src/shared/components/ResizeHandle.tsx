/**
 * 竖直拖拽条：拖动改变相邻面板宽度。视觉上是 1px 分隔线，但用负 margin 扩出更宽的抓取热区，
 * 不占额外布局宽度。
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
 *    用户连「这里能拖」都看不出来。故窄屏热区放宽到 16px、并常驻一条淡线。
 *
 * 改**高度**的分隔条（纵向，位置各异、套不进这个组件的 JSX）用同文件下面的 `useDragResize`：
 * 同一套管线，别在调用方再手写一遍 `pointermove`（漏掉 `touch-action` 就是手机拖不动）。
 */
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

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
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // 只认主键 / 单指：右键（要弹菜单）、中键、以及另一根手指按在别处，都不该被当成拖拽起点
    if (!e.isPrimary) return
    if (e.pointerType === 'mouse' && e.button !== 0) return

    e.preventDefault()
    const handle = e.currentTarget
    const pointerId = e.pointerId
    const startX = e.clientX
    const startWidth = width
    onDragStart?.()

    /**
     * 一帧只提交一次宽度。
     *
     * `pointermove` 在高刷屏 / 高轮询鼠标上可能一帧来好几次，而每次提交都是
     * 「写 store + 落 localStorage + React 重渲染 + 面板里 iframe 重排」—— 全按事件频率跑，
     * 主线程会被塞满，手感就是「拖了但跟不上」。收尾时把最后一帧补提交，避免松手位置差一点。
     */
    let frame = 0
    let pendingX = startX
    const apply = (): void => {
      frame = 0
      const delta = (pendingX - startX) * (invert ? -1 : 1)
      onResize(Math.max(min, Math.min(max, startWidth + delta)))
    }
    const move = (ev: PointerEvent): void => {
      pendingX = ev.clientX
      if (frame === 0) frame = requestAnimationFrame(apply)
    }

    /**
     * 幂等收尾：`pointerup` / `pointercancel` / `blur` 三者可能只来一个，也可能连着来
     * （触摸被浏览器接管时是 cancel，取消后再抬手还会补一个 up）。
     *
     * `done` 这个闸门是必需的：没有它，`pointercancel` 之后再来的 `pointerup` 会二次调用
     * `onDragEnd`，而更早的那个泄漏的 `pointermove` 至今还挂在 window 上。
     */
    let done = false
    const cleanup = (): void => {
      if (done) return
      done = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('blur', cleanup)
      // 把还没提交的那一帧补上：否则松手位置会比指针最后的位置差一小段
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        apply()
      }
      try {
        handle.releasePointerCapture(pointerId)
      } catch {
        // 指针已释放（如 pointercancel）时忽略
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.body.style.touchAction = ''
      onDragEnd?.()
    }

    /*
     * 捕获指针：不加的话，指针一移出这条 8px 热区就只剩 window 上的 `pointermove` 兜着 ——
     * 光标进到 `<iframe>` / `<webview>`（预览标签）里时连 window 都收不到事件，拖拽直接卡住。
     * 与 `useDragResize` 同一套做法（跨源 guest 上捕获不一定生效，所以调用方还要把面板内容
     * 设成 `pointer-events-none` 兜底，见 `SidePanel`）。
     */
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      // 合成事件没有真实指针，退化为 window 监听即可
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    // 手势起点已有 touch-none（见下面的 className），这里在 body 上再关一次：
    // iOS 上手指滑出抓手后，页面仍可能开始橡皮筋回弹，拖拽期间一并压掉，结束后原样还回去。
    document.body.style.touchAction = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    window.addEventListener('blur', cleanup)
  }

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
      {/* 触摸没有 hover，指示线默认透明的话手机上完全看不出这里能拖 —— 窄屏常驻一条淡线。
          与下面那条用 `sm:hidden` 互斥，不要合并成一条：那会让 sm 断点上的 `sm:bg-transparent`
          与 `group-hover` 抢同一个属性，最终谁生效取决于 Tailwind 生成 CSS 的先后顺序。 */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/50 sm:hidden" />
      {/* 桌面：默认透明，悬停（或拖着时指针仍压在上面）才浮现，不干扰静态视觉 */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/resize:bg-border" />
    </div>
  )
}

/**
 * 拖拽分隔条的**指针管线**（触摸安全的唯一实现）。
 *
 * `ResizeHandle` 是「改宽度」的现成组件，但改高度的几条分隔条（API 页响应区、WS 页发送区、
 * 侧栏内容组标题行、`PanelView` 分隔条）位置与定位方式各不相同、套不进同一个 JSX，于是各自抄了一份
 * `pointerdown + window pointermove` —— 抄的都是**桌面鼠标那一版**：缺 `touch-action`，
 * 手机上手指一动就被浏览器当成滚动手势抢走，紧接着一个 `pointercancel` 把拖拽打断，
 * 表现就是「一次只能拖一点点」。这里把文件头 1 / 2 两条（`touch-action` + 幂等收尾）收进来，
 * 调用方只管「按 `delta` 算新高度 / 新权重」。
 *
 * ⚠️ 调用方仍要在**自己的** className 里带上 `touch-none`（见下）：这个 hook 只管拖动开始后的
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

      const move = (ev: PointerEvent): void => {
        latest.current.onMove((axis === 'x' ? ev.clientX : ev.clientY) - start, ctx as C)
      }

      /**
       * 幂等收尾：`pointerup` / `pointercancel` / `blur` 可能只来一个，也可能连着来
       * （触摸被浏览器接管时是 cancel，取消后再抬手还会补一个 up）。没有 `done` 闸门的话，
       * 后到的那个会把监听与 `body` 上的样式解第二遍，而更早泄漏的 `pointermove` 仍挂在 window 上。
       */
      let done = false
      const cleanup = (): void => {
        if (done) return
        done = true
        window.removeEventListener('pointermove', move)
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
        latest.current.onEnd?.()
      }

      try {
        handle.setPointerCapture(pointerId)
      } catch {
        // 合成事件没有真实指针，退化为 window 监听即可
      }
      document.body.style.cursor = cursor ?? (axis === 'x' ? 'col-resize' : 'row-resize')
      document.body.style.userSelect = 'none'
      // 手势起点已有 touch-none，这里在 body 上再关一次：手指滑出抓手后 iOS 仍可能开始橡皮筋回弹
      document.body.style.touchAction = 'none'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', cleanup)
      window.addEventListener('pointercancel', cleanup)
      window.addEventListener('blur', cleanup)
    },
    [axis, cursor]
  )
}