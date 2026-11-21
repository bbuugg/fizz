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
 * ## 黏球（metaball）
 *
 * 展开 / 收起时球与动作按钮之间会**拉出一段颈**，而不是凭空冒出几个圆：按钮从
 * 「与球同心」的位置滑到环上，球与按钮之间由一层 SVG 黏球底形（`MetaballGlass`）
 * 补上，成为一整块连着往上长的液体。要点：
 *
 * - 黏球层与按钮的位移**必须同一条曲线、同一个时长**（`MERGE_MS` / `MERGE_EASE`），
 *   差一点颈就会和按钮脱开、露出缝；
 * - 黏球只能靠**另一层 SVG** 补，不能给玻璃本体加 filter —— `backdrop-filter` 在
 *   带 `filter` 的祖先下会退化成一块半透明色（见 `MetaballGlass` 的注释）；
 * - 收起要等「融回」走完才卸载（`showRing`），拖动则**立刻**卸载：球每帧都在动，
 *   拖着一截正在回收的尾巴会和球错位。
 *
 * ## 几个硬约定
 *
 * - **不许碰终端焦点**：球与动作按钮在 `pointerdown` 里 `preventDefault()`，并主动把
 *   焦点从 xterm 的 textarea 上摘掉（`blurTerminalFocus`）。只 preventDefault 不够：
 *   移动端终端 textarea 还带着焦点时，点一下球软键盘就会重新弹出来。
 * - **触摸手势必须就地截断**：终端容器上挂着自实现的单指滚动
 *   （`shared/lib/terminal-touch-scroll.ts`），拖球时若不拦，终端会跟着一起滚，指针还会被
 *   它 `preventDefault` 掉的 touchmove 变成 `pointercancel`。React 合成事件挂在根节点上，
 *   挡不住容器上的原生监听 —— 所以用**原生监听**，挂在球的回调 ref 上（见 `setBallNode`）。
 * - **位置记在本机**（`fizz.web.terminalFabPos.v2`，沿用 `fizz.web.*` 约定）：全局一份，
 *   所有终端标签共用；容器尺寸变了就按当前方向重新贴边。没记过时**贴右、上下居中**。
 * - **只有角上要让开**（`cornerClearance`）：半圈朝内铺开，两端落在与贴边方向**垂直**的
 *   那条轴上 —— 贴左右时端点在上下，贴上下时端点在左右。所以贴着边的中间位置完全不用留
 *   距离，只有「贴边又贴角」那 8 个位置会把端点顶出容器，松手吸附时沿边让开即可。
 * - **测量层必须无条件渲染**（见下面 `pos` 那段注释里的死锁）—— 否则球根本不出现。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
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
/**
 * 位置键。
 *
 * 带 `.v2`：上一版默认落在角落、且坐标口径变过（RING_MARGIN 那会儿离边很远），
 * 老坐标会盖住新的「贴右居中」默认值。换键 = 一次性的位置复位，比在代码里猜
 * 「这份旧坐标是不是角落」干净。
 */
const POS_KEY = 'fizz.web.terminalFabPos.v2'
/** 旧键：读到新键缺失时顺手清掉，别在 localStorage 里留一份再也用不上的坐标 */
const LEGACY_POS_KEY = 'fizz.web.terminalFabPos'

/**
 * 黏球融合 / 分裂的时长。
 *
 * 三处必须**同一个值、同一条曲线**才不脱节：`<circle>` 的位置、真玻璃按钮的位置、
 * 以及「收起后多久才卸载环上的东西」（见 `MERGE_MS` 的延时卸载）。原效果是 550ms
 * `cubic-bezier(.25,.8,.25,1)`（快进慢出，液体的「黏」全靠尾巴这一段）。
 */
const MERGE_MS = 520
const MERGE_EASE = 'cubic-bezier(.25,.8,.25,1)'

/**
 * 黏球滤镜的模糊半径。
 *
 * 原效果 `stdDeviation=7` 配 r=22~27 的圆（≈0.28 倍半径）；这里的球 r=20，
 * 按同比例取 5.5。**小了粘不住**（两个圆之间拉不出颈），大了整坨糊成一团。
 */
const GOO_BLUR = 5.5

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
    if (!raw) {
      // 没有新键 = 还没在新口径下摆过：旧键那份一并丢掉，回到「贴右居中」
      localStorage.removeItem(LEGACY_POS_KEY)
      return null
    }
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

/**
 * 半圈要多大半径：颗数越多、弧越长，半径越大。
 *
 * 相邻两颗的弦长 `2R·sin(step/2)` 得容下 `ITEM + RING_GAP`，所以摊开之后半径会自己
 * 长出去（而不是把按钮挤成一团）。**布置环**与**留安全边距**必须用同一份数 ——
 * 两边各算一份，缩半径时边距就不够了。
 */
function ringRadius(count: number): number {
  const span = count <= 1 ? 0 : count === 2 ? 90 : 180
  const step = count > 1 ? ((span * Math.PI) / 180) / (count - 1) : Math.PI / 2
  return Math.max(
    BALL / 2 + RING_GAP + ITEM / 2,
    (ITEM + RING_GAP) / 2 / Math.sin(step / 2)
  )
}

/**
 * 贴边吸附时，球在**沿边方向**要为角落让出的距离（球边 → 容器边）。
 *
 * 半圈朝容器内侧铺开，两端落在「与贴边方向垂直」的那条轴上：贴左 / 贴右时端点朝上下，
 * 贴顶 / 贴底时端点朝左右。所以问题只出在**角上** —— 贴着左边又贴着上边时，朝上的那颗
 * 按钮无处可去（要么顶出容器被夹、要么缩半径硬塞）。
 *
 * 换算 = 球心到按钮外沿（环半径 + 按钮半径）− 球半径，再带一点贴边留白。四边共用这一个数，
 * 它描述的是「离角多远算让开」，**不是**「离边必须多远」：贴着边中间完全合法。
 */
function cornerClearance(count: number): number {
  return EDGE + Math.max(0, ringRadius(count) + ITEM / 2 - BALL / 2)
}

/**
 * 把沿边坐标让开两端角落：夹进 `[min + clearance, max - clearance]`。
 *
 * 区间倒挂（容器被压得太小，两边都让不出来）时退化成居中 —— 至少球还在可视范围内，
 * 也不会算出 `min > max` 那种来回抖的夹取。
 */
function alongEdge(value: number, min: number, max: number, clearance: number): number {
  const lo = min + clearance
  const hi = max - clearance
  if (hi < lo) return Math.max(0, Math.round((min + max) / 2))
  return Math.max(lo, Math.min(value, hi))
}

/**
 * 拖动中的自由位置：球完整留在容器内，**四边都能真贴住**。
 *
 * 不做任何边距：拖动时不展开环，没有「按钮没地方站」的问题；角上那点空间等松手吸附时
 * 再让（见 `dockPoint`）。这样跟手，也不会出现「明明拖到边了球却停在一截之外」。
 */
function clampBall(x: number, y: number, width: number, height: number): Point {
  return {
    x: Math.max(EDGE, Math.min(x, Math.max(EDGE, width - BALL - EDGE))),
    y: Math.max(EDGE, Math.min(y, Math.max(EDGE, height - BALL - EDGE)))
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
 * 吸附到最近一条边：沿边方向保留用户拖到的位置，只把**角落**让开（见 `cornerClearance`）。
 *
 * 贴左 / 贴右时端点朝上下 → 纵向让；贴顶 / 贴底时端点朝左右 → 横向让。所以终态可以是
 * 「贴着边的任意位置」，只有 4 边 × 2 端 = 8 个角落位置不行。
 */
function dockPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  clearance: number
): { point: Point; side: DockSide } {
  const side = nearestSide(x, y, width, height)
  const free = clampBall(x, y, width, height)
  const maxX = Math.max(EDGE, width - BALL - EDGE)
  const maxY = Math.max(EDGE, height - BALL - EDGE)
  const alongX = alongEdge(free.x, EDGE, maxX, clearance)
  const alongY = alongEdge(free.y, EDGE, maxY, clearance)
  switch (side) {
    case 'left':
      return { point: { x: EDGE, y: alongY }, side }
    case 'right':
      return { point: { x: maxX, y: alongY }, side }
    case 'top':
      return { point: { x: alongX, y: EDGE }, side }
    default:
      return { point: { x: alongX, y: maxY }, side }
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

/**
 * 极坐标 → 按钮**终点**的左上角。
 *
 * ⚠️ 不要把这个值直接喂给按钮的 `left` / `top`：按钮一律以「与球同心」为起点、
 * 靠 `transform` 平移出去（见 `originLeft` / `offsets`）。直接定位就没有位移，
 * 黏球的那段「拉出来」也就没了。
 */
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

/**
 * 黏球底形（metaball）：展开 / 收起时，球与动作按钮之间被「拉出一段颈」而不是
 * 凭空长出来 —— 效果取自原实现的 SVG filter 方案（模糊 + alpha 阈值）。
 *
 * ## 为什么必须是**另一层** SVG，而不是给按钮加个滤镜
 *
 * 黏连只能靠「先把整组形状糊开、再把 alpha 抬成硬边」把多个圆**并成一个轮廓**，
 * 滤镜得罩在整组形状上；单个元素自己加，得到的只是「自己变糊」。
 *
 * ## 为什么不干脆让玻璃本体做黏球
 *
 * `backdrop-filter`（液态玻璃的磨砂）**不能**待在带 `filter` 的祖先下面：祖先一旦
 * 有 filter 就成了新的 backdrop root，子元素采样不到页面背景，玻璃会退化成一块
 * 半透明色 —— 也就是说「黏连形状」和「真磨砂」在同一个元素上不可兼得。所以取舍：
 *
 * - 球与动作按钮仍是**真玻璃**（`LiquidGlassButton`：磨砂、1px 亮边、镜面高光、
 *   132° 扫光、跟随指针的光圈，一样不少）；
 * - 球与按钮之间的「颈」由这一层补：半透明玻璃色 + 1px 亮边。
 *
 * 终端底色是单一深色，磨砂在纯色上本来就没有可见差异，两截看起来是同一块玻璃。
 * 这是给终端做的效果，别当通用组件搬走。
 *
 * ## 别按直觉改的东西
 *
 * - `feColorMatrix` 最后一行 `28 -11`：alpha 先放大 28 倍再减 11，是原实现调出来的
 *   阈值。改小 → 颈断成两个圆；改大 → 整坨糊成一团（跟 `GOO_BLUR` 是一对）。
 * - `feMorphology` 那圈亮边：没有它，黏连处是一块没有厚度的色块，看不出是玻璃。
 * - 圆的位置用 CSS `transform` 过渡（不是 `cx` / `cy`）：几何属性只有部分浏览器
 *   能过渡，`transform` 是稳的，也和按钮的位移用同一条曲线。
 */
function MetaballGlass({
  width,
  height,
  cx,
  cy,
  spots,
  expanded,
  reduceMotion
}: {
  width: number
  height: number
  /** 球心（容器坐标） */
  cx: number
  cy: number
  /** 每颗动作按钮相对球心的位移：收起态是 0、展开态是环上的位置 */
  spots: { dx: number; dy: number }[]
  /** 是否已展开到位（与按钮用**同一个**状态，差一帧颈就会脱开） */
  expanded: boolean
  reduceMotion: boolean
}) {
  /** `useId` 会带冒号，塞进 `url(#...)` 不安全，洗一遍（滤镜与遮罩共用这一份） */
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const filterId = `fab-goo-${uid}`
  const maskId = `fab-goo-hole-${uid}`
  const transition = reduceMotion ? 'none' : `transform ${MERGE_MS}ms ${MERGE_EASE}`
  /**
   * 滤镜区域**只罩「球 + 环上所有按钮」的包围盒**，不要罩整个容器：高斯模糊是逐像素
   * 算的，容器多大就算多大，展开那 520ms 里每帧一遍很容易掉帧（原效果是个 220×144
   * 的小盒子，才敢每个圆都吃滤波器）。
   *
   * 过渡中间的位置是两端点之间的**直线插值**，一定落在「球心 ∪ 环上位置」的包围盒里，
   * 所以只按这两个端点算就够，不用再放余量给中间帧 —— `reach` 留的是模糊本身的扩散。
   */
  const reach = Math.max(BALL, ITEM) / 2 + GOO_BLUR * 2
  const nodes = [{ x: cx, y: cy }, ...spots.map((spot) => ({ x: cx + spot.dx, y: cy + spot.dy }))]
  const gooX = Math.min(...nodes.map((node) => node.x)) - reach
  const gooY = Math.min(...nodes.map((node) => node.y)) - reach
  const gooWidth = Math.max(...nodes.map((node) => node.x)) - gooX + reach
  const gooHeight = Math.max(...nodes.map((node) => node.y)) - gooY + reach
  /**
   * 位移样式：黏连层的圆、遮罩里的洞、真玻璃按钮三者**共用同一份**（同一个值、
   * 同一条曲线），任何一处单独改都会让颈和按钮脱开。
   */
  const shift = (spot: { dx: number; dy: number }): { transform: string; transition: string } => ({
    transform: expanded ? `translate(${spot.dx}px, ${spot.dy}px)` : 'translate(0px, 0px)',
    transition
  })
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      /**
       * 玻璃色按主题两档：亮色主题下终端是浅底时白玻璃会隐形（与 `LiquidGlassButton`
       * 的 `contrast` 档同一条理由），掺石板灰才看得出形状；暗色主题用淡白洗。
       *
       * ⚠️ 这几个 alpha 是这套效果里唯一「推不出来、只能实机看」的数：所有圆的内部
       * 都已被遮罩挖空，它们只决定**颈**有多实。调大 → 颈像一条实心色带；调小 →
       * 只剩两条亮边、没有体积。亮边那两档同理。
       */
      className="pointer-events-none absolute inset-0 [--fab-goo:rgba(100,116,139,0.35)] [--fab-goo-rim:rgba(255,255,255,0.85)] dark:[--fab-goo:rgba(255,255,255,0.22)] dark:[--fab-goo-rim:rgba(255,255,255,0.5)]"
    >
      <defs>
        {/*
          球本体底下**不铺**黏连层：球是半透明玻璃，底下多一层白会把它整体提亮、
          看起来「变实了」（液态玻璃的观感全靠它能透出背后的终端）。所以在球的位置
          挖一个洞 —— 颈断在球的边界上，接缝正好被球自己的 1px 亮边盖住。
        */}
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x={gooX}
          y={gooY}
          width={gooWidth}
          height={gooHeight}
        >
          <rect x={gooX} y={gooY} width={gooWidth} height={gooHeight} fill="#fff" />
          {/* 球 & 每颗按钮的内部都挖空：玻璃本来就半透明，底下再垫一层白会整块变实、
              和「真玻璃」的观感对不上（球与按钮必须一样，只挖球会让两者材质不一致）。
              洞跟着按钮一起位移（`shift`），否则过渡途中按钮底下会露出黏连圆盘。 */}
          <circle cx={cx} cy={cy} r={BALL / 2} fill="#000" />
          {spots.map((spot, index) => (
            <circle key={index} cx={cx} cy={cy} r={ITEM / 2} fill="#000" style={shift(spot)} />
          ))}
        </mask>
        <filter
          id={filterId}
          filterUnits="userSpaceOnUse"
          x={gooX}
          y={gooY}
          width={gooWidth}
          height={gooHeight}
        >
          <feGaussianBlur in="SourceAlpha" stdDeviation={GOO_BLUR} result="blurred" />
          <feColorMatrix
            in="blurred"
            type="matrix"
            values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 28 -11"
            result="silhouette"
          />
          {/* 玻璃体：整块形状填一层半透明玻璃色 */}
          <feFlood result="bodyInk" style={{ floodColor: 'var(--fab-goo)' }} />
          <feComposite in="bodyInk" in2="silhouette" operator="in" result="body" />
          {/* 亮边：把剪影往里蚀一圈再与原剪影做差，得到沿形状走的一圈 1.2px 边 */}
          <feMorphology in="silhouette" operator="erode" radius="1.2" result="inner" />
          <feComposite in="silhouette" in2="inner" operator="out" result="rimBand" />
          <feFlood result="rimInk" style={{ floodColor: 'var(--fab-goo-rim)' }} />
          <feComposite in="rimInk" in2="rimBand" operator="in" result="rim" />
          <feMerge>
            <feMergeNode in="body" />
            <feMergeNode in="rim" />
          </feMerge>
        </filter>
      </defs>
      <g filter={`url(#${filterId})`} mask={`url(#${maskId})`}>
        <circle cx={cx} cy={cy} r={BALL / 2} fill="#fff" />
        {spots.map((spot, index) => (
          <circle key={index} cx={cx} cy={cy} r={ITEM / 2} fill="#fff" style={shift(spot)} />
        ))}
      </g>
    </svg>
  )
}

export function TerminalFab({ actions }: { actions: TerminalAction[] }) {
  /** 铺满终端的测量 / 定位层（`pointer-events-none`，只有球与动作托盘可点） */
  const hostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  /** 球的左上角（相对容器）；null = 还没量到尺寸 */
  const [pos, setPos] = useState<Point | null>(null)
  const [open, setOpen] = useState(false)
  /**
   * 环上的东西（黏球 + 动作按钮）到底挂不挂在 DOM 里。
   *
   * 与 `open` 分开：收起不是删掉，而是「融回球里」—— 位置过渡要 `MERGE_MS` 才走完，
   * 这期间元素必须还在。所以 `open=false` 之后再迟一点才卸载（见下面的 effect）。
   * 拖动是例外：球每帧都在动，拖着一段正在回收的尾巴会错位，所以拖动一开始就立刻卸载。
   */
  const [showRing, setShowRing] = useState(false)
  /**
   * 「已经展开到位」—— **样式态**，比 `open` 晚一帧。
   *
   * ⚠️ 它存在的唯一理由：元素**首次挂载**就带终点样式的话，`transition` 没有起点可
   * 插值，按钮会「啪」地出现在环上、黏球也拉不出来。所以挂载那一帧先渲染成起点
   * （与球同心 / 透明），下一帧再切到这个状态，过渡才播得出来。
   */
  const [revealed, setRevealed] = useState(false)
  /** 系统是否要求减少动效：为真时黏球与位移直接跳变（`prefers-reduced-motion`） */
  const [reduceMotion, setReduceMotion] = useState(false)
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
   * 有没有动作可放。没有时整层不渲染（`hostRef` 是 null），所以量尺寸的 effect 必须
   * 跟着它重新跑 —— 动作可能是后到的（历史作用域随数据加载才成立）。
   */
  const enabled = actions.length > 0
  /** 角落要让出的距离：贴边吸附（含默认位置）都吃这一个数 */
  const clearance = cornerClearance(actions.length)

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
        // 没记过位置时**贴右、上下居中**（小米悬浮球的默认位）；已有位置也重新吸附一次，
        // 容器变窄 / 变矮时顺手把它夹回容器、把角落让开。
        const base =
          prev ?? readPos() ?? { x: width - BALL - EDGE, y: height / 2 - BALL / 2 }
        return dockPoint(base.x, base.y, width, height, clearance).point
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
    // `clearance` 也在依赖里：动作颗数变了（半圈变大 → 角落要让得更多）要重新吸附一次
  }, [enabled, clearance])

  /**
   * 球一挂上就把触摸手势**就地截断**（见文件头「触摸手势必须就地截断」）。
   *
   * ⚠️ 这段**不能写成 `useEffect` 里读球的 ref**：球是「量出 `pos` 之后」才渲染的，
   * 首次挂载那一刻 ref 还是 null，而 effect 的依赖只有 `enabled` —— 动作一开始就有的话
   * 它不会再跑，监听于是永远挂不上：手机上一拖球，`touchmove` 就冒泡到终端容器的单指
   * 滚动（`attachTerminalTouchScroll`），终端跟着上下翻（用户报的）。
   * 改成**回调 ref**：节点一挂上就绑，卸载 / 换节点时解。
   *
   * 只 `stopPropagation` 就够：终端的滚动监听挂在祖先容器上、走冒泡；球自己已经有
   * `touch-action: none`（见球的内联 style），浏览器也不会再去滚页面。
   */
  const detachBallTouch = useRef<(() => void) | null>(null)
  const setBallNode = useCallback((el: HTMLButtonElement | null) => {
    detachBallTouch.current?.()
    detachBallTouch.current = null
    if (!el) return
    const stop = (e: Event): void => e.stopPropagation()
    // passive 只让 preventDefault 失效，stopPropagation 照常生效 —— 这里不需要拦默认行为
    const options = { passive: true } as const
    el.addEventListener('touchstart', stop, options)
    el.addEventListener('touchmove', stop, options)
    el.addEventListener('touchend', stop, options)
    el.addEventListener('touchcancel', stop, options)
    detachBallTouch.current = () => {
      el.removeEventListener('touchstart', stop)
      el.removeEventListener('touchmove', stop)
      el.removeEventListener('touchend', stop)
      el.removeEventListener('touchcancel', stop)
    }
  }, [])

  // 卸载时别留着一帧没提交的位置
  useEffect(() => {
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  // 系统动效偏好：黏球 / 位移的时长都吃它
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (): void => setReduceMotion(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  /**
   * 展开 / 收起的两步走：**先挂上、下一帧再位移**（`revealed` 的来由见它的声明）。
   *
   * 收起时反过来：`revealed` 在同一批更新里归零 —— 元素已经挂在 DOM 上，样式一变
   * 就有回位过渡，等 `MERGE_MS` 走完再由下面那个 effect 卸载。
   */
  useEffect(() => {
    if (!open) {
      setRevealed(false)
      return
    }
    setShowRing(true)
    /**
     * ⚠️ **双 rAF**，不是一层。
     *
     * 第一帧只负责把「起点」（与球同心、透明）真的画出去；第二帧才切到终点。
     * 用一层的话它是「插入后的同一帧内改样式」—— 浏览器做样式计算时只看到终点值，
     * 没算过起点，transition 于是不播（按钮直接出现在环上）。
     */
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setRevealed(true))
    })
    return () => {
      cancelAnimationFrame(outer)
      if (inner) cancelAnimationFrame(inner)
    }
  }, [open])

  /**
   * 环上的东西（黏球 + 动作按钮）什么时候摘掉。
   *
   * ⚠️ 收起**不能**直接 `open && ...`：一收就卸载，黏球根本没机会融回球里。
   * 收起后等 `MERGE_MS` 才摘（`showRing` 进依赖是为了卸载之后停手）。
   */
  useEffect(() => {
    if (open || !showRing) return
    const timer = window.setTimeout(() => setShowRing(false), reduceMotion ? 0 : MERGE_MS)
    return () => window.clearTimeout(timer)
  }, [open, showRing, reduceMotion])

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
      // 一开始拖就收起圆环：手指正在换位置，圆环跟着飘只会碍事；同时关掉磨砂（`frosted={false}`）。
      // 黏球与圆形按钮**立刻卸载**（不走 MERGE_MS 的「融回」）：球每帧都在换位置，
      // 拖着一截正在回收的尾巴只会和球错位，看起来像两个东西。
      setOpen(false)
      setShowRing(false)
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
      size.height,
      clearance
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
   * - 半径直接用 `ringRadius(count)` —— 角落让位（`cornerClearance`）吃的是同一个数，两边各算
   *   一份就会「环按大半径排、球却按小边距放」；
   * - 放不下才缩半径（球还在角上、没松手时半圈会顶到另一条边）：缩到两颗相切为止，
   *   剩下的交给最后的夹取。吸附后的正常位不该走到这里。
   */
  const ring = ((): Point[] => {
    if (!pos || size.width <= 0 || size.height <= 0) return []
    const span = count <= 1 ? 0 : count === 2 ? 90 : 180
    const base = inwardAngle(dockSide)
    const radiusFloor = BALL / 2 + ITEM / 2
    const angles = actions.map((_, index) => ringAngle(base, span, count, index))
    const place = (radius: number): Point[] =>
      angles.map((degrees) => ringPoint({ x: centerX, y: centerY }, radius, degrees))
    let radius = ringRadius(count)
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

  /**
   * 动作按钮与球**同心**时的左上角。按钮永远以这个点为基准、靠 `transform` 位移到
   * 环上去 —— 收起态就是「滑回球心、被球盖住」，黏球效果全靠这一段位移。
   * （不用 `left` / `top` 过渡：那两条属性每帧都要重新布局，transform 只走合成。）
   */
  const originLeft = centerX - ITEM / 2
  const originTop = centerY - ITEM / 2
  /** 每颗按钮相对球心的位移；黏球层的圆用**同一组数**，两边差一点颈就会歪 */
  const offsets = ring.map((spot) => ({
    dx: spot.x - originLeft,
    dy: spot.y - originTop
  }))

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
            黏球底形：球与按钮之间那截「颈」。
            必须画在按钮**之下**（DOM 顺序在前）：按钮的 `backdrop-blur` 会把采样到
            的这一层一起糊进去，两截于是看起来是同一块玻璃，而不是「玻璃球 + 一块色板」。
          */}
          {showRing && (
            <MetaballGlass
              width={size.width}
              height={size.height}
              cx={centerX}
              cy={centerY}
              spots={offsets}
              expanded={revealed}
              reduceMotion={reduceMotion}
            />
          )}

          {/*
            动作按钮挂在 `showRing` 上而不是 `open`：收起要走完 `MERGE_MS` 的「融回」
            才卸载。收起态继续挂着的话，拖动中每帧都要重渲染这几颗 Radix Tooltip 包着
            的按钮 —— 所以拖动一开始就强制 `setShowRing(false)`（见 `onPointerMove`）。

            每颗都是**和球同款的圆形按钮**（同样的大小、同样的液态玻璃），但位置一律
            从「与球同心」出发、靠 `transform` 滑到环上：这就是黏球的那段位移，和黏球层
            的圆严格同步。图标用 `grid place-items-center` 居中 —— 不同图标的 svg 自带
            宽高 / 对齐方式略有差别，靠容器居中最稳，别指望 svg 自己是居中的。
          */}
          {showRing &&
            actions.map((action, index) => {
              const offset = offsets[index]
              if (!offset) return null
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
                    style={{
                      left: originLeft,
                      top: originTop,
                      width: ITEM,
                      height: ITEM,
                      transform: revealed
                        ? `translate3d(${offset.dx}px, ${offset.dy}px, 0)`
                        : 'translate3d(0, 0, 0)',
                      // 展开时晚 90ms 才变清晰：位移的头几十毫秒它还压在球底下，
                      // 提前露出来的话会先看到「球里透出一个圆」再滑出去，像重影。
                      opacity: revealed ? 1 : 0,
                      transition: reduceMotion
                        ? 'none'
                        : `transform ${MERGE_MS}ms ${MERGE_EASE}, opacity ${revealed ? '160ms' : '300ms'} ease-out ${revealed ? '90ms' : '180ms'}`,
                      // 融化中不接受点击（还在动，点它等于点空气）
                      pointerEvents: revealed ? 'auto' : 'none'
                    }}
                    selected={action.active}
                    className="pointer-events-auto absolute"
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
            ref={setBallNode}
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
              // 一颗「能点」的球：手型，不用 grab（拖动是隐藏操作，不该由光标预告）
              'cursor-pointer',
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
