/**
 * 终端的**触摸手势**（手机 / 平板）：单指拖动翻 scrollback，双指捏合缩放字号。
 *
 * 为什么必须自己实现：xterm.js 6 的 DOM 里**没有任何可滚的容器**。
 * `Terminal.open()` 建出来的结构是
 *
 * ```
 * .xterm
 *   ├── .xterm-viewport            ← position:absolute; inset:0; overflow-y:scroll
 *   │                                 但是个**空 div**（实测 scrollHeight == clientHeight）
 *   └── .xterm-scrollable-element  ← position:relative，高 = 可见区
 *         └── .xterm-screen        ← 也只有可见区那么高（里面 .xterm-rows 只放看得见的行）
 * ```
 *
 * 真正在滚的 `.xterm-screen` 挂在 `.xterm-viewport` **外面**，而且这两个元素都不可滚
 * （实测 Chromium 手机模拟下 scrollHeight === clientHeight）。xterm 的滚动因此完全是
 * **程序化**的：滚轮（`ScrollableElement._onMouseWheel`）和自定义滚动条滑块各自算好目标行号，
 * 走 `scrollLines → scrollToLine`；整个库对原生 `scroll` 事件**一条监听都没有**。
 *
 * 后果：桌面上有滚轮没人发现，手机上「手指拖动」在 xterm 上**什么都不会发生**
 * （实测 touchmove 拖 300px，`buffer.viewportY` 一动不动）—— 回滚历史等于看不见。
 * 这个文件就把那段缺失的手势补上：
 * - 单指拖动：touch → 算行号 → `term.scrollToLine()`（滚动）；
 * - 单指**长按**（不移动）：进入「选区模式」，拖动即调用 `term.select()` 划词，
 *   松手保留选区，外层挂的「复制选中文本」按钮负责写剪贴板；
 * - 双指：捏合 → 算两指距离比例 → `onZoom(字号)`（缩放，与 PC 的 Ctrl+滚轮同一套夹取）。
 *
 * ⚠️ 只在**有触摸输入**的设备上挂（`supportsTouch()`）。桌面纯鼠标下恒为 false，
 * 挂不挂监听对桌面零影响 —— 所以这里按「能力」判断而不是按视口宽度：手机横屏宽度
 * 也超过 768px（`useIsMobile` 就是按 768px 算的），但它一样得能拖着滚。
 */
import type { Terminal } from '@xterm/xterm'

/**
 * 一根手指位移超过这么多 px 才算「拖动」，否则当点一下。
 *
 * 阈值要小于 xterm 自己判 tap 的 30px（它那个 `Gesture`：位移 < 30px 且时长 < 700ms
 * 才算 tap，tap 才会 focus 终端、弹软键盘）—— 但也不能太小，否则手一抖就滚走几行。
 */
const DRAG_THRESHOLD_PX = 8
/** 长按多久算「我要选文字」而不是「我要滚动」 */
const LONG_PRESS_MS = 450
/** 长按期间允许的抖动（两轴都算；超过就当作滚动，取消长按） */
const LONG_PRESS_SLOP_PX = 8

/** 松手后惯性滑行的速度下限（px/ms）：比这更慢就停，省得一直飘。
 *  取 0.3：慢拖（≈0.2px/ms）松手后就该稳稳停住，正常划一下（≥0.5）才该有惯性 */
const FLICK_MIN_VELOCITY = 0.3
/** 惯性滑行的速度上限（px/ms）：手指甩得再快也别变成瞬移 */
const FLICK_MAX_VELOCITY = 2.5
/** 惯性滑行每 16ms 的速度衰减系数（越接近 1 滑得越远） */
const FLICK_DECAY = 0.945

/** 双指缩放的基准字号兜底值（拿不到当前字号时用，与 TerminalPanel 的缺省一致） */
const FALLBACK_FONT_SIZE = 14

/**
 * 一行到底多少 px。
 *
 * 不能拿 `term.options.fontSize × lineHeight` 算（xterm 内部会取整，实测 14px × 1.25
 * 的配置 DOM 行高是 20px 而不是 17.5）—— **量真行**最稳：取 `.xterm-rows` 第一个
 * 子元素的高度。一次手势量一次就够（字号缩放后下一次手势自然会量到新值）。
 */
function measureRowHeight(term: Terminal): number {
  const row = term.element?.querySelector('.xterm-rows > div')
  const height = row?.getBoundingClientRect().height
  if (height && height > 0) return height
  const fallback = (term.options.fontSize ?? 14) * (term.options.lineHeight ?? 1.2)
  return fallback > 0 ? fallback : 18
}

/** 一次触摸对应的「字符格」；row 是**绝对 buffer 行**（viewportY + 可见行），
 * 因为 xterm 的 `select()` / `selectLines()` 用的都是绝对行号。 */
interface CellPoint {
  col: number
  row: number
}

/** 纯函数：一个像素坐标 → 字符格。抽出来是为了能在 node 环境单测（不碰 DOM）。 */
export function pointToCell(
  rect: { left: number; top: number; width: number },
  cols: number,
  rows: number,
  rowHeight: number,
  viewportY: number,
  clientX: number,
  clientY: number
): CellPoint {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  const cellWidth = rect.width / Math.max(1, cols)
  const col = clamp(Math.floor((clientX - rect.left) / cellWidth), 0, Math.max(0, cols - 1))
  const visibleRow = clamp(Math.floor((clientY - rect.top) / rowHeight), 0, Math.max(0, rows - 1))
  // xterm 的 select()/selectLines() 用的是**绝对 buffer 行**（ybase + 可见行）
  return { col, row: viewportY + visibleRow }
}

function cellAt(term: Terminal, clientX: number, clientY: number, rowHeight: number): CellPoint {
  const screen = term.element?.querySelector('.xterm-screen')
  const rect = (screen ?? term.element)?.getBoundingClientRect()
  if (!rect || !rect.width) {
    return { col: 0, row: term.buffer.active.viewportY }
  }
  return pointToCell(
    { left: rect.left, top: rect.top, width: rect.width },
    term.cols,
    term.rows,
    rowHeight,
    term.buffer.active.viewportY,
    clientX,
    clientY
  )
}

/**
 * 纯函数：两点之间的字符区间。`term.select(col,row,length)` 只认「从起点开始的
 * 线性字符数」，所以先把两点按前后排好（反方向拖也能选），再换算成长度。
 */
export function selectionRange(
  cols: number,
  a: CellPoint,
  b: CellPoint
): { start: CellPoint; length: number } {
  let start = a
  let end = b
  if (end.row < start.row || (end.row === start.row && end.col < start.col)) {
    ;[start, end] = [end, start]
  }
  const length = (end.row - start.row) * cols + (end.col - start.col) + 1
  return { start, length: Math.max(1, length) }
}

function selectBetween(term: Terminal, a: CellPoint, b: CellPoint): void {
  const { start, length } = selectionRange(term.cols, a, b)
  term.select(start.col, start.row, length)
}

/** 两个触摸点之间的距离（px）；不足两点返回 0 */
function pinchDistance(touches: TouchList): number {
  if (touches.length < 2) return 0
  const a = touches[0]
  const b = touches[1]
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/** 双指捏合缩放：手势状态（在 `surface` 上监听的双指距离）与回调 */
export interface TerminalTouchScrollOptions {
  /** 读当前字号：双指按下的那一刻取一次，作为整个捏合手势的缩放基准 */
  getFontSize?: () => number
  /** 缩放：传入目标字号（未夹取，由调用方 clamp 到合法范围并 fit） */
  onZoom?: (fontSize: number) => void
  /** 长按选中 / 选区被清掉：终端据此显示或收起「复制选中文本」按钮 */
  onSelectionChange?: (hasSelection: boolean) => void
}

/**
 * 在 `surface`（传给 `term.open()` 的那个容器）上挂触摸手势，返回卸载函数。
 *
 * 手势状态机分四种：`none` / `scroll` / `select` / `zoom`，单指与双指互斥。
 * `select` 由单指长按进入（见 `LONG_PRESS_MS`），此时接管 touchmove 但不滚 scrollback，
 * 而是把起点 → 当前手指之间的字符交给 xterm 自己的选区模型。
 * - `none → scroll`：`touchstart` 单指落下时进入（先不接管，点一下照样 focus / 弹软键盘）。
 * - `scroll`：`touchmove` 位移越过阈值才正式接管：从此 preventDefault（否则浏览器会去找
 *   「可滚的祖先」，这页面里一个都没有，手势就凭空消失了），并按手指位置滚到对应行；
 *   阈值之前的小位移直接忽略。中途若变成双指则切到 `zoom`（放弃滚动）。
 * - `zoom`：双指落下时进入（或从 `scroll` 中途切入），`touchmove` 按两指距离比例算目标字号
 *   喂给 `onZoom`。松手 / 只剩一指 / 触摸取消都退回 `none`，且**不**顺带回落到滚动，
 *   免得缩放完手指一动又开始翻页。
 * - `touchend`（单指滚动时）：按最近一段的速度接一段惯性滑行，衰减到停。
 *
 * 方向跟着手指走（跟页面 / 聊天列表一个道理）：**往下拖 = 看更早的行**，往上拖 = 回到底部。
 * ⚠️ 从前「拖动换滚动」的代价是**没法划词选中**（`preventDefault` 掐掉浏览器合成的
 * 鼠标事件，而 xterm 的选区是 mouse 驱动的）。现在补了一条「长按 = 选中」的分支：
 * 长按进入 `select` 后，xterm 的 `term.select()` 由我们按字符格直接驱动，不再依赖
 * 浏览器原生选区（`.xterm` 自带 `user-select:none`，原生长按在这块 DOM 上本来就没用）。
 */
export function attachTerminalTouchScroll(
  term: Terminal,
  surface: HTMLElement,
  options: TerminalTouchScrollOptions = {}
): () => void {
  const { getFontSize, onZoom, onSelectionChange } = options
  /** 当前手势：none=没跟踪；scroll=单指滚动；select=长按划词；zoom=双指缩放 */
  let mode: 'none' | 'scroll' | 'select' | 'zoom' = 'none'
  // --- scroll 用 ---
  /** 正在跟踪的手指；null = 没在跟踪（含被多指打断） */
  let trackingId: number | null = null
  /** 是否已越过阈值、正在滚动（决定要不要 preventDefault） */
  let dragging = false
  /** touchstart 时的手指位置：阈值判定用 */
  let gestureStartX = 0
  let gestureStartY = 0
  /** 越过阈值那一刻的锚点：手指 Y + 视口首行行号（从那一点起算滚动量，起点不跳） */
  let anchorY = 0
  let anchorLine = 0
  /** 一次手势里量到的行高 */
  let rowHeight = 0
  /** 最近一次 move 的时间与速度（向上为正，px/ms） */
  let lastTime = 0
  let lastY = 0
  let velocity = 0
  let flingFrame = 0
  // --- zoom 用 ---
  /** 双指按下那一刻的两指距离（缩放基准，捏合比例 = 当前距离 / 它） */
  let pinchStartDist = 0
  /** 双指按下那一刻的字号（缩放基准） */
  let zoomStartFontSize = 0
  // --- 长按选中用 ---
  /** 长按计时器；手指一动 / 抬起就清掉 */
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  /** 选区起点（绝对行） */
  let selectStart: CellPoint | null = null
  /** 当前有没有留着一段选区（决定新的一次 tap 要不要先清掉它） */
  let selectionActive = false

  const cancelLongPress = (): void => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
  }

  const notifySelection = (active: boolean): void => {
    selectionActive = active
    onSelectionChange?.(active)
  }

  const clearSelection = (): void => {
    term.clearSelection()
    selectStart = null
    notifySelection(false)
  }

  const enterSelect = (x: number, y: number): void => {
    term.clearSelection()
    selectStart = cellAt(term, x, y, rowHeight || measureRowHeight(term))
    term.select(selectStart.col, selectStart.row, 1)
    mode = 'select'
    notifySelection(true)
  }

  const cancelFling = (): void => {
    if (flingFrame) {
      cancelAnimationFrame(flingFrame)
      flingFrame = 0
    }
  }

  /** 进入双指缩放：以当前两指距离与字号为准。调用方已保证 `onZoom` 存在 */
  const enterZoom = (touches: TouchList): void => {
    cancelFling()
    trackingId = null
    dragging = false
    mode = 'zoom'
    // 两指重合时距离 0，做除法会 Inf；给个下限
    pinchStartDist = Math.max(1, pinchDistance(touches))
    zoomStartFontSize = getFontSize?.() ?? term.options.fontSize ?? FALLBACK_FONT_SIZE
  }

  const onTouchStart = (event: TouchEvent): void => {
    cancelFling()
    cancelLongPress()
    const n = event.touches.length
    if (n === 1) {
      const touch = event.changedTouches[0]
      if (!touch) return
      // 上一次长按留下的选区：新的单点先清掉（再点一下就没了，符合直觉）
      if (selectionActive) clearSelection()
      mode = 'scroll'
      trackingId = touch.identifier
      dragging = false
      gestureStartX = touch.clientX
      gestureStartY = touch.clientY
      lastY = touch.clientY
      lastTime = event.timeStamp
      velocity = 0
      rowHeight = measureRowHeight(term)
      // 长按计时：只有「一直没动、没变多指」才进入 select
      if (onSelectionChange) {
        const identifier = touch.identifier
        const x = touch.clientX
        const y = touch.clientY
        longPressTimer = setTimeout(() => {
          longPressTimer = null
          if (mode !== 'scroll' || trackingId !== identifier || dragging) return
          enterSelect(x, y)
        }, LONG_PRESS_MS)
      }
      return
    }
    if (n === 2 && onZoom) {
      // 双指（且启用了缩放）：放弃滚动跟踪，转入捏合
      enterZoom(event.touches)
      return
    }
    // 三指以上 / 双指但没启用缩放：全部放弃，交给浏览器
    cancelFling()
    trackingId = null
    dragging = false
    mode = 'none'
  }

  const onTouchMove = (event: TouchEvent): void => {
    if (mode === 'select') {
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === trackingId)
      if (!touch) return
      if (event.cancelable) event.preventDefault()
      if (selectStart) selectBetween(term, selectStart, cellAt(term, touch.clientX, touch.clientY, rowHeight))
      return
    }
    if (mode === 'zoom') {
      if (!onZoom) return
      // 中途少了一指：交给 touchend 收尾，别在这半拍里算
      if (event.touches.length < 2) return
      // 接管手势：别让浏览器拿双指去缩放页面
      if (event.cancelable) event.preventDefault()
      const ratio = pinchDistance(event.touches) / pinchStartDist
      onZoom(zoomStartFontSize * ratio)
      return
    }

    if (mode !== 'scroll' || trackingId === null) return
    // 单指滚动中途变成了双指：切成缩放（不打断，接着捏）
    if (event.touches.length >= 2 && onZoom) {
      enterZoom(event.touches)
      if (event.cancelable) event.preventDefault()
      onZoom(zoomStartFontSize * (pinchDistance(event.touches) / pinchStartDist))
      return
    }
    const touch = Array.from(event.changedTouches).find((t) => t.identifier === trackingId)
    if (!touch) return
    if (!dragging) {
      // 手指动了：长按不再是「长按」，取消计时（两轴都算，斜着挪一下也算滚动）
      if (
        Math.abs(touch.clientY - gestureStartY) >= LONG_PRESS_SLOP_PX ||
        Math.abs(touch.clientX - gestureStartX) >= LONG_PRESS_SLOP_PX
      ) {
        cancelLongPress()
      }
      if (Math.abs(touch.clientY - gestureStartY) < DRAG_THRESHOLD_PX) return
      dragging = true
      // 锚点取「现在」：从越阈值的这一帧开始算，滚到哪都不会先跳一下
      anchorY = touch.clientY
      anchorLine = term.buffer.active.viewportY
    }
    // 接管手势：阻止默认，避免浏览器把触摸当成「滚动页面 / 选中文字」
    if (event.cancelable) event.preventDefault()
    term.scrollToLine(Math.round(anchorLine + (anchorY - touch.clientY) / rowHeight))

    const dt = event.timeStamp - lastTime
    if (dt > 0) velocity = (lastY - touch.clientY) / dt
    lastY = touch.clientY
    lastTime = event.timeStamp
  }

  const onTouchEnd = (event: TouchEvent): void => {
    cancelLongPress()
    if (mode === 'select') {
      // 保留选区，等外层那颗「复制」按钮；别让 xterm 把这个长按当 tap 弹软键盘
      const active = document.activeElement
      if (active instanceof HTMLElement && active.closest('.xterm')) active.blur()
      mode = 'none'
      trackingId = null
      return
    }
    if (mode === 'zoom') {
      // 抬起任意一指就结束缩放并回到 none：不顺势滚，避免「放大完一带动就翻页」
      mode = 'none'
      trackingId = null
      dragging = false
      return
    }
    if (mode !== 'scroll' || trackingId === null) return
    if (!Array.from(event.changedTouches).some((t) => t.identifier === trackingId)) return
    trackingId = null
    // 只是点了一下：不接管，焦点 / 软键盘还是照应用原有那套来
    if (!dragging) return

    let speed = Math.max(-FLICK_MAX_VELOCITY, Math.min(FLICK_MAX_VELOCITY, velocity))
    let target = term.buffer.active.viewportY
    let prev = performance.now()
    const step = (): void => {
      flingFrame = 0
      const now = performance.now()
      // 切后台再回来 dt 会是几秒，夹住免得瞬移
      const dt = Math.min(64, now - prev)
      prev = now
      speed *= Math.pow(FLICK_DECAY, dt / 16)
      target += (speed * dt) / rowHeight
      term.scrollToLine(Math.round(target))
      if (Math.abs(speed) < FLICK_MIN_VELOCITY) return
      flingFrame = requestAnimationFrame(step)
    }
    flingFrame = requestAnimationFrame(step)
  }

  const onTouchCancel = (): void => {
    cancelLongPress()
    if (mode === 'select') clearSelection()
    mode = 'none'
    trackingId = null
    dragging = false
    cancelFling()
  }

  // touchmove 必须是非 passive：否则 preventDefault 不生效（控制台还会报警告）
  surface.addEventListener('touchstart', onTouchStart, { passive: true })
  surface.addEventListener('touchmove', onTouchMove, { passive: false })
  surface.addEventListener('touchend', onTouchEnd, { passive: true })
  surface.addEventListener('touchcancel', onTouchCancel, { passive: true })

  return () => {
    cancelFling()
    cancelLongPress()
    surface.removeEventListener('touchstart', onTouchStart)
    surface.removeEventListener('touchmove', onTouchMove)
    surface.removeEventListener('touchend', onTouchEnd)
    surface.removeEventListener('touchcancel', onTouchCancel)
  }
}
