/**
 * 终端里的**悬浮球**（小米手机那套「悬浮球」的交互）：拖动换位置，松手后自动吸附到
 * 最近的一条边；点一下从**未贴边的那一侧**展开动作按钮（命令历史 / AI 终端助手 …），
 * 再点一下收起。
 *
 * ## 自动贴边 + 吸附动画
 *
 * - 拖动时球跟手走；松手后按球心到四条边的距离选最近的一条，吸附过去。位置只记
 *   吸附后的坐标，所以下次打开仍然贴着同一条边。
 * - 吸附用 `transform` 过渡（`cubic-bezier(0.16, 1, 0.3, 1)`，无回弹，避免越界被裁）。
 *   拖动期间必须关掉过渡，否则每帧都追不上指针。
 * - 按钮**只往容器内侧长**：沿球心朝容器内部的方向排成**半圈**（180° 的弧），每颗都是
 *   和球同款的圆形按钮。整圈画不了 —— 球是贴边的，朝外那半边必然跑出容器被裁掉，
 *   也白挡终端内容。球被拖到角落、这半圈塞不下时先缩半径，还不行才把按钮夹回可视区。
 *
 * ## 几个硬约定
 *
 * - **不许碰终端焦点**：球与动作按钮在 `pointerdown` 里 `preventDefault()`，并主动把
 *   焦点从 xterm 的 textarea 上摘掉（`blurTerminalFocus`）。只 preventDefault 不够：
 *   移动端终端 textarea 还带着焦点时，点一下球软键盘就会重新弹出来。
 * - **触摸手势必须就地截断**：终端容器上挂着自实现的单指滚动
 *   （`shared/lib/terminal-touch-scroll.ts`），拖球时若不拦，终端会跟着一起滚，指针还会被
 *   它 `preventDefault` 掉的 touchmove 变成 `pointercancel`。React 合成事件挂在根节点上，
 *   挡不住容器上的原生监听 —— 所以用**原生监听**（见下面的 effect）。
 * - **位置记在本机**（`fizz.web.terminalFabPos`，沿用 `fizz.web.*` 约定）：全局一份，
 *   所有终端标签共用；容器尺寸变了就按当前方向重新贴边。
 * - **测量层必须无条件渲染**（见下面 `pos` 那段注释里的死锁）—— 否则球根本不出现。
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Ellipsis } from 'lucide-react'
import { LiquidGlassButton } from '@fizz/ui/liquid-glass'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { TerminalAction } from '@fizz/agent-kit/features/terminal/terminal-actions'

/** 球的直径（小米悬浮球的规格：小到不碍事，大到还能按） */
const BALL = 40
/** 动作按钮的直径：与球一致 —— 组件本意是「一圈和球一样的圆」，大小不一就不成环了 */
const ITEM = 40
/** 球与容器边缘的留白（视觉上贴边，但不至于压到边框） */
const EDGE = 8
/** 球与环上按钮之间的空隙，也是相邻两颗按钮之间的最小空隙 */
const RING_GAP = 8
/** 位移超过它才算「拖」而不是「点」（手指抖动不算） */
const DRAG_THRESHOLD = 4
const POS_KEY = 'fizz.web.terminalFabPos'

interface Point {
  x: number
  y: number
}

/**
 * 动作都在终端容器内部，但终端自己的 textarea 只要还带着焦点，点悬浮球时
 * 浏览器 / xterm 就可能把软键盘重新唤起来。悬浮球不是输入入口，交互前先把
 * 终端焦点摘掉（只摘 xterm 内部的，不动输入框）。
 */
function blurTerminalFocus(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.xterm')) active.blur()
}

/** 读记住的位置；没记过 / 坏数据返回 null（调用方按容器右下角摆） */
function readPos(): Point | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const [x, y] = raw.split(',').map((value) => Number(value))
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
  } catch {
    return null
  }
}

function writePos(point: Point): void {
  try {
    localStorage.setItem(POS_KEY, `${Math.round(point.x)},${Math.round(point.y)}`)
  } catch {
    // 存不进去也不致命：本次会话内仍然生效
  }
}

type DockSide = 'left' | 'right' | 'top' | 'bottom'

/** 拖动中的自由位置：只保证球完整留在容器内，不吸附 */
function clampBall(x: number, y: number, width: number, height: number): Point {
  const maxX = Math.max(EDGE, width - BALL - EDGE)
  const maxY = Math.max(EDGE, height - BALL - EDGE)
  return {
    x: Math.max(EDGE, Math.min(x, maxX)),
    y: Math.max(EDGE, Math.min(y, maxY))
  }
}

/** 球心到哪条边最近 */
function nearestSide(x: number, y: number, width: number, height: number): DockSide {
  const distances: Record<DockSide, number> = {
    left: x + BALL / 2,
    right: width - x - BALL / 2,
    top: y + BALL / 2,
    bottom: height - y - BALL / 2
  }
  return (Object.keys(distances) as DockSide[]).reduce((best, side) =>
    distances[side] < distances[best] ? side : best
  )
}

/**
 * 吸附到最近一条边。沿边方向保留用户拖到的位置，只把它夹回容器内；容器太小时
 * 退化成左上角，至少球还在可视范围内。
 */
function dockPoint(
  x: number,
  y: number,
  width: number,
  height: number
): { point: Point; side: DockSide } {
  const side = nearestSide(x, y, width, height)
  const free = clampBall(x, y, width, height)
  switch (side) {
    case 'left':
      return { point: { x: EDGE, y: free.y }, side }
    case 'right':
      return { point: { x: Math.max(EDGE, width - BALL - EDGE), y: free.y }, side }
    case 'top':
      return { point: { x: free.x, y: EDGE }, side }
    default:
      return { point: { x: free.x, y: Math.max(EDGE, height - BALL - EDGE) }, side }
  }
}

/**
 * 贴边方向 → 环的**中心角**（角度制：x 向右、y 向下，0° = 右、90° = 下）。
 *
 * 环永远朝容器内侧展开：贴右边时按钮在球左边（180°）、贴左边时在右边（0°），上下同理。
 * 朝外那半边不给 —— 球本来就贴着边，朝外就是出界。
 */
function inwardAngle(side: DockSide): number {
  switch (side) {
    case 'left':
      return 0
    case 'right':
      return 180
    case 'top':
      return 90
    default:
      return 270
  }
}

/** 环上第 `index` 颗的角度：以 `base` 为中心、在 `span` 宽度里均匀铺开（含两端） */
function ringAngle(base: number, span: number, count: number, index: number): number {
  // 只有一颗时直接落在正内侧 —— 也就是「球 → 容器内部」那条线上
  if (count <= 1) return base
  return base - span / 2 + (span * index) / (count - 1)
}

/** 极坐标 → 按钮左上角（`left` / `top` 直接吃这个值，不用 transform，免得和动画打架） */
function ringPoint(center: Point, radius: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180
  return {
    x: center.x + radius * Math.cos(radians) - ITEM / 2,
    y: center.y + radius * Math.sin(radians) - ITEM / 2
  }
}

/** 一颗按钮是否完整落在容器内（四边都留 `EDGE`） */
function boxFits(point: Point, width: number, height: number): boolean {
  return (
    point.x >= EDGE &&
    point.y >= EDGE &&
    point.x + ITEM <= width - EDGE &&
    point.y + ITEM <= height - EDGE
  )
}

export function TerminalFab({ actions }: { actions: TerminalAction[] }) {
  /** 铺满终端的测量 / 定位层（`pointer-events-none`，只有球与动作托盘可点） */
  const hostRef = useRef<HTMLDivElement>(null)
  const ballRef = useRef<HTMLButtonElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  /** 球的左上角（相对容器）；null = 还没量到尺寸 */
  const [pos, setPos] = useState<Point | null>(null)
  const [open, setOpen] = useState(false)
  /** 按下中的视觉反馈（缩放）：拖动/点击共用，pointerup / cancel 后复位 */
  const [pressed, setPressed] = useState(false)
  /**
   * 正在拖动。拖动期间要关掉磨砂 —— `backdrop-filter` 的元素一移动，每帧都要重算它
   * 背后那一整块（压在 xterm 画布上尤其贵），会让球明显「追不上指针」。
   */
  const [dragging, setDragging] = useState(false)
  /** 拖动中的位置先攒在 ref 里，每帧只提交一次（高刷屏 pointermove 能到 120+ 次/秒） */
  const pendingPosRef = useRef<Point | null>(null)
  const frameRef = useRef(0)
  /** 一次按下-抬起的拖动现场（`id` 用来忽略别的指针） */
  const dragRef = useRef<{
    id: number
    /** 按下时的指针位置与球的起始位置 */
    px: number
    py: number
    x: number
    y: number
    moved: boolean
  } | null>(null)
  /**
   * 有没有动作可放。没有时整层不渲染（`hostRef` / `ballRef` 都是 null），所以下面两个
   * effect 必须跟着它重新跑 —— 动作可能是后到的（历史作用域随数据加载才成立）。
   */
  const enabled = actions.length > 0

  // 量容器 + 夹取当前位置。容器尺寸会变（助手展开把终端挤窄、面板拖宽），球必须跟着回到安全区。
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => {
      const rect = host.getBoundingClientRect()
      const width = rect.width
      const height = rect.height
      // 还没布局（非活动标签是 `hidden`，尺寸为 0）：别把球摆在 (10,10) 上，等
      // ResizeObserver 在真正显示时再量一次 —— 否则默认位置会停在左上角而不是右侧。
      if (width <= 0 || height <= 0) return
      setSize({ width, height })
      setPos((prev) => {
        // 默认贴右侧居中（小米悬浮球的默认位）；已有位置也重新吸附，兼容旧版
        // RING_MARGIN 留下的「离边很远」坐标。
        const base = prev ??
          readPos() ?? { x: width - BALL - EDGE, y: height / 2 - BALL / 2 }
        return dockPoint(base.x, base.y, width, height).point
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [enabled])

  // 拖动期间别让容器上的触摸手势（单指翻 scrollback）跟着接手，见文件头。
  useEffect(() => {
    const el = ballRef.current
    if (!el) return
    const stop = (e: Event): void => e.stopPropagation()
    const options = { passive: true } as const
    el.addEventListener('touchstart', stop, options)
    el.addEventListener('touchmove', stop, options)
    el.addEventListener('touchend', stop, options)
    return () => {
      el.removeEventListener('touchstart', stop)
      el.removeEventListener('touchmove', stop)
      el.removeEventListener('touchend', stop)
    }
  }, [enabled])

  // 卸载时别留着一帧没提交的位置
  useEffect(() => {
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  // Esc 收起动作托盘（捕获阶段：终端的 keydown 处理在更深处，别让它先吃掉）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // 不把焦点给球；同时摘掉终端的焦点，否则移动端点完球软键盘会重新弹出。
    e.preventDefault()
    blurTerminalFocus()
    e.currentTarget.setPointerCapture(e.pointerId)
    setPressed(true)
    const start = pos ?? { x: EDGE, y: EDGE }
    dragRef.current = {
      id: e.pointerId,
      px: e.clientX,
      py: e.clientY,
      x: start.x,
      y: start.y,
      moved: false
    }
  }

  /** 把攒下的位置在一帧里提交一次（拖动中的所有 setState 都走这里） */
  const flushPending = (): void => {
    frameRef.current = 0
    const next = pendingPosRef.current
    pendingPosRef.current = null
    if (next) setPos(next)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.id !== e.pointerId) return
    const dx = e.clientX - drag.px
    const dy = e.clientY - drag.py
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
      drag.moved = true
      // 一开始拖就收起圆环：手指正在换位置，圆环跟着飘只会碍事；同时关掉磨砂（`frosted={false}`）
      setOpen(false)
      setDragging(true)
    }
    pendingPosRef.current = clampBall(drag.x + dx, drag.y + dy, size.width, size.height)
    if (!frameRef.current) frameRef.current = requestAnimationFrame(flushPending)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.id !== e.pointerId) return
    dragRef.current = null
    setPressed(false)
    if (!drag.moved) {
      setOpen((value) => !value)
      return
    }
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
    pendingPosRef.current = null
    const next = dockPoint(
      drag.x + (e.clientX - drag.px),
      drag.y + (e.clientY - drag.py),
      size.width,
      size.height
    ).point
    setPos(next)
    writePos(next)
    setDragging(false)
  }

  const onPointerCancel = (): void => {
    dragRef.current = null
    setPressed(false)
    pendingPosRef.current = null
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
    setDragging(false)
  }

  // 一个动作都没有（容器工作台 / 侧栏终端且没有历史）：连球都不画
  if (actions.length === 0) return null

  /**
   * ⚠️ **测量层（`hostRef` 那个 div）必须无条件渲染**：它自己就是量尺寸的那个节点。
   * 曾经这里写的是「`pos` 为空就 `return null`」—— 首帧不渲染 host → `hostRef.current`
   * 恒为 null → 量尺寸的 effect 直接 return → `pos` 永远为空 → 球永远不出现（死锁）。
   * 所以只有**球 + 动作托盘**挂在 `pos` 上，测量层照旧铺满。
   */
  const count = actions.length
  const centerX = (pos?.x ?? 0) + BALL / 2
  const centerY = (pos?.y ?? 0) + BALL / 2
  const dockSide = pos ? nearestSide(pos.x, pos.y, size.width, size.height) : 'right'
  /**
   * 展开后每颗按钮的位置（左上角，与 `actions` 同序）。
   *
   * 一直开整圈是不可能的：球贴边，朝外那半边必然出界被裁。所以排的是朝内的**半圈**：
   * - `span`：一颗正对内；两颗收成 90°（张得太开会像两条竖线）；三颗起铺满 180°；
   * - 半径：至少「球半径 + 空隙 + 按钮半径」，再按**弦长**校验相邻两颗不叠
   *   （相邻夹角 step，弦长 = 2R·sin(step/2)，要不小于 ITEM + RING_GAP）。颗数一多
   *   弧长不够，半径自己长出去，环就变大而不是挤成一团；
   * - 放不下就缩半径：球被拖到角落时，半圈会顶到另一条边；缩到两颗相切为止，
   *   剩下的交给最后的夹取（宁可挨近一点，也不能有按钮落在可视区外点不到）。
   */
  const ring = ((): Point[] => {
    if (!pos || size.width <= 0 || size.height <= 0) return []
    const span = count <= 1 ? 0 : count === 2 ? 90 : 180
    const step = count > 1 ? ((span * Math.PI) / 180) / (count - 1) : Math.PI / 2
    const base = inwardAngle(dockSide)
    const radiusFloor = BALL / 2 + ITEM / 2
    const minRadius = Math.max(
      BALL / 2 + RING_GAP + ITEM / 2,
      (ITEM + RING_GAP) / 2 / Math.sin(step / 2)
    )
    const angles = actions.map((_, index) => ringAngle(base, span, count, index))
    const place = (radius: number): Point[] =>
      angles.map((degrees) => ringPoint({ x: centerX, y: centerY }, radius, degrees))
    let radius = minRadius
    let points = place(radius)
    while (!points.every((point) => boxFits(point, size.width, size.height)) && radius > radiusFloor) {
      radius = Math.max(radiusFloor, radius - 12)
      points = place(radius)
    }
    return points.map((point) => ({
      x: Math.max(EDGE, Math.min(point.x, Math.max(EDGE, size.width - EDGE - ITEM))),
      y: Math.max(EDGE, Math.min(point.y, Math.max(EDGE, size.height - EDGE - ITEM)))
    }))
  })()

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0 z-20">
      {pos && size.width > 0 && size.height > 0 ? (
        <>
          {/* 点空白处收起：透明遮罩在球与环形按钮之下 */}
          {open && (
            <div
              className="pointer-events-auto absolute inset-0"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpen(false)}
            />
          )}

          {/*
            动作按钮**只在展开时挂载**。收起态继续挂着的话，拖动中每帧都要重渲染
            这几颗 Radix Tooltip 包着的按钮、还要重排它们的 left/top —— 都是白白吃掉
            帧预算（按钮是收着的，用户根本看不见）。

            每颗都是**和球同款的圆形按钮**（同样的大小、同样的液态玻璃），沿环摆开；
            图标用 `grid place-items-center` 居中 —— 不同图标的 svg 自带宽高 / 对齐方式
            略有差别，靠容器居中最稳，别指望 svg 自己是居中的。
          */}
          {open &&
            actions.map((action, index) => {
              const spot = ring[index]
              if (!spot) return null
              return (
                <IconTip key={action.key} label={action.label}>
                  <LiquidGlassButton
                    tone="contrast"
                    aria-label={action.label}
                    // 不让按钮 / 终端抢焦点：移动端一点就弹软键盘。
                    onPointerDown={(e) => {
                      e.preventDefault()
                      blurTerminalFocus()
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setOpen(false)
                      action.onClick()
                    }}
                    style={{ left: spot.x, top: spot.y, width: ITEM, height: ITEM }}
                    selected={action.active}
                    className="pointer-events-auto absolute animate-in fade-in-0 zoom-in-90 duration-150"
                  >
                    <span className="grid size-4 place-items-center">{action.icon}</span>
                  </LiquidGlassButton>
                </IconTip>
              )
            })}

          {/* 球本体：iOS 26 液态玻璃（`LiquidGlassButton`）。按下时**整颗球**一起缩；
              拖动中按住但不缩，同时把磨砂关掉（渐变 / 高光 / 描边 / 投影都还在，
              玻璃感保留，只是不跑 backdrop-filter）—— 外层的 transform 只跑位置
              （拖动 / 贴边），玻璃层的缩放与描边、投影、图标都归内层管。 */}
          <LiquidGlassButton
            tone="contrast"
            ref={ballRef}
            aria-label="终端操作"
            aria-expanded={open}
            title="点击展开 · 拖动后自动贴边"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            frosted={!dragging}
            pressed={pressed && !dragging}
            style={{
              transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
              width: BALL,
              height: BALL,
              touchAction: 'none',
              // 松手后吸附用过渡；拖动 / 触摸跟手时绝不能有它
              transition: dragging
                ? 'none'
                : 'transform 320ms cubic-bezier(0.16, 1, 0.3, 1), background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease'
            }}
            className={cn(
              'pointer-events-auto absolute top-0 left-0',
              'cursor-grab active:cursor-grabbing',
              dragging && 'will-change-transform'
            )}
          >
            <Ellipsis className="size-4 text-foreground" />
          </LiquidGlassButton>
        </>
      ) : null}
    </div>
  )
}
