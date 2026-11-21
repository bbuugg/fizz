/*!
 * dissolve-ui@0.0.6 · UploadTile 粒子引擎（裁剪版：只保留 dust / snap 两个预设）
 * MIT License
 *
 * Copyright (c) 2026 Rayan Selmi
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * 来源：https://leibox.pantoria.cn/docs/animations/upload-tile （原站 dissolve.rselmi.com）
 *
 * 只搬了「上传瓦片」这条链路真正用到的部分：
 * - 颗粒拼合（上传进度驱动的 grain assembly）在 `upload-tile.ts` 里直接用 `grainField`；
 * - 取消 / 移除 / 失败散开走 `playDissolve`（snap / dust 两个预设）。
 *
 * 演示页、goo 滤镜、peel / melt / shatter 等预设在 Fizz 里没有使用场景，一并删掉，
 * 少一份要维护的渲染路径。**保留版权与许可声明**是 MIT 的要求，别删。
 */

const DPR = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1)
const MAX_GRAINS = 5000
const DEFAULT_END = 1.2
const BASE = 8

/** 瓦片颗粒边长（CSS px）。与 `grainField` / `drawAsm` 共用，改一处要三处同步 */
export const GRAIN = 2
/** 每颗粒子的出现窗口：进度滑过这一小段时逐颗落位 */
export const WINDOW = 0.18
/** 落位前的随机漂移幅度 */
export const DRIFT = 10
/** 画布物理像素比（上限 2，避免 4K 屏上白烧 GPU） */
export const PIXEL_RATIO = DPR

export const clamp = (x: number, a = 0, b = 1): number => (x < a ? a : x > b ? b : x)

const hash = (i: number, k: number): number => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
  return x - Math.floor(x)
}

function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const X = (t: number): number => ((ax * t + bx) * t + cx) * t
  const dX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx
  const Y = (t: number): number => ((ay * t + by) * t + cy) * t
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const e = X(t) - x
      const d = dX(t)
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break
      t -= e / d
    }
    if (t < 0 || t > 1 || Math.abs(X(t) - x) > 1e-4) {
      let lo = 0
      let hi = 1
      t = x
      for (let i = 0; i < 40; i++) {
        if (X(t) < x) lo = t
        else hi = t
        t = (lo + hi) / 2
      }
    }
    return Y(t)
  }
}

/** 瓦片里所有补间共用的缓动（与 `CALM_CSS` 同一条曲线） */
export const CALM = bezier(0.32, 0.72, 0, 1)
export const CALM_CSS = 'cubic-bezier(0.32, 0.72, 0, 1)'

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 触觉反馈：只有用户真点过（`userActivation`）才振动，避免加载时自己抖 */
export function haptic(pattern: number | number[]): void {
  if (typeof navigator === 'undefined' || !navigator.userActivation?.hasBeenActive) return
  navigator.vibrate?.(pattern)
}

/** 一次动画 / 交互的生命周期：定时器、rAF、监听器都挂在这里，销毁时一次清干净 */
export interface MotionScope {
  alive: boolean
  wait(ms: number): Promise<void>
  raf(fn: (now: number) => void): number
  onDispose(fn: () => void): void
  dispose(): void
}

export function createScope(): MotionScope {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const rafs = new Set<number>()
  const disposers: Array<() => void> = []
  const sc: MotionScope = {
    alive: true,
    wait: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (sc.alive) resolve()
        }, ms)
        timers.add(timer)
      }),
    raf(fn) {
      const id = requestAnimationFrame((now) => {
        rafs.delete(id)
        if (sc.alive) fn(now)
      })
      rafs.add(id)
      return id
    },
    onDispose(fn) {
      disposers.push(fn)
    },
    dispose() {
      if (!sc.alive) return
      sc.alive = false
      timers.forEach((timer) => clearTimeout(timer))
      rafs.forEach((id) => cancelAnimationFrame(id))
      disposers.forEach((fn) => fn())
      timers.clear()
      rafs.clear()
      disposers.length = 0
    }
  }
  return sc
}

/** 一个可补间的数值（tween 而不是直接 setState：每帧重绘 canvas 不该惊动 React） */
export interface MotionValue {
  v: number
  set(x: number): void
  to(to: number, ms: number, ease?: (x: number) => number): Promise<boolean>
}

export function createMotionValue(
  sc: MotionScope,
  initial: number,
  onChange: () => void
): MotionValue {
  let generation = 0
  /** 当前补间的 resolve：被新的补间 / set / dispose 打断时要让它收场，不能永远 pending */
  let pending: ((value: boolean) => void) | null = null
  const settle = (value: boolean): void => {
    pending?.(value)
    pending = null
  }
  sc.onDispose(() => settle(false))
  const value: MotionValue = {
    v: initial,
    set(x) {
      generation++
      settle(false)
      value.v = x
      onChange()
    },
    to(to, ms, ease = CALM) {
      const mine = ++generation
      settle(false)
      const from = value.v
      return new Promise<boolean>((resolve) => {
        pending = resolve
        const start = performance.now()
        const step = (now: number): void => {
          if (mine !== generation || !sc.alive) {
            if (pending === resolve) pending = null
            return resolve(false)
          }
          const k = ms > 0 ? Math.min(1, (now - start) / ms) : 1
          value.v = from + (to - from) * ease(k)
          onChange()
          if (k < 1) sc.raf(step)
          else {
            if (pending === resolve) pending = null
            resolve(true)
          }
        }
        sc.raf(step)
      })
    }
  }
  return value
}

// ---------------------------------------------------------------------------
// 全屏粒子舞台（散开效果画在 fixed 画布上：颗粒要飞出瓦片，不能被输入区裁掉）
// ---------------------------------------------------------------------------

interface Stage {
  overlay: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

let stage: Stage | null = null

function ensureStage(): Stage {
  if (stage) return stage
  const overlay = document.createElement('canvas')
  overlay.className = 'dissolve-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  Object.assign(overlay.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    pointerEvents: 'none',
    zIndex: 'var(--dissolve-overlay-z, 2147483000)'
  })
  document.body.appendChild(overlay)
  const resize = (): void => {
    overlay.width = Math.round(innerWidth * DPR)
    overlay.height = Math.round(innerHeight * DPR)
    overlay.style.width = `${innerWidth}px`
    overlay.style.height = `${innerHeight}px`
  }
  resize()
  addEventListener('resize', resize)
  window.visualViewport?.addEventListener('resize', resize)
  stage = { overlay, ctx: overlay.getContext('2d')! }
  return stage
}

interface GrainSeed {
  lx: number
  ly: number
  r1: number
  r2: number
  r3: number
  r4: number
}

interface BurstParams {
  x: number
  y: number
  w: number
  h: number
  grain: number
  cols: number
  rows: number
  maxR: number
  sec: number
  ox: number
  oy: number
  maxD: number
  n0: number
}

interface Particle {
  cx: number
  cy: number
  s: number
  rot: number
  a: number
}

interface Variant {
  grain: number
  ownsOrigin?: boolean
  extra?: number
  timing: (g: GrainSeed, P: BurstParams) => { delay: number; life: number }
  prepare?: (d: Float32Array, stride: number, count: number, P: BurstParams) => void
  step: (p: Particle, t: number, d: Float32Array, k: number, P: BurstParams) => void
}

/** 从瓦片中心向外弹开（snap 用；`randomDir` 时完全随机方向） */
function burstOut(
  d: Float32Array,
  P: BurstParams,
  strength: number,
  extraIdx: number,
  randomDir: boolean
): (k: number) => void {
  return (k) => {
    const dx = d[k] - P.ox
    const dy = d[k + 1] - P.oy
    const dist = Math.sqrt(dx * dx + dy * dy)
    let ux: number
    let uy: number
    if (dist < 1) {
      const angle = (randomDir ? Math.random() : d[k + 5]) * Math.PI * 2
      ux = Math.cos(angle)
      uy = Math.sin(angle)
    } else {
      ux = dx / dist
      uy = dy / dist
    }
    const push = (30 + d[k + 3] * 110) * strength
    const swirl = (d[k + 4] - 0.5) * 30
    d[k + extraIdx] = ux * push - uy * swirl
    d[k + extraIdx + 1] = uy * push + ux * swirl
  }
}

/** 失败：向上扬尘（右半先走，带一点旋） */
const dust: Variant = {
  grain: 3,
  timing: (g, P) => ({
    delay: (g.lx / P.w) * 0.62 + (1 - g.ly / P.h) * 0.04 + g.r1 * 0.1,
    life: 0.42
  }),
  step(p, t, d, k) {
    const e = t * t
    p.cx += (50 + d[k + 3] * 150) * e
    p.cy += -(15 + d[k + 4] * 110) * e + Math.sin(t * 7 + d[k + 5] * 6.28) * 5 * t
    p.s = 1 - t * 0.55
    p.rot = (d[k + 5] - 0.5) * 6 * e
  }
}

/** 取消 / 移除：从点击点（或右上角）向外炸开 */
const snap: Variant = {
  grain: 3,
  ownsOrigin: true,
  extra: 2,
  timing: (g, P) => ({
    delay: (Math.hypot(g.lx - P.ox, g.ly - P.oy) / (P.maxD || 1)) * 0.55 + g.r1 * 0.08,
    life: 0.45
  }),
  prepare(d, stride, count, P) {
    const push = burstOut(d, P, P.n0 > 0 ? P.n0 : 1, 8, true)
    for (let i = 0; i < count; i++) push(i * stride)
  },
  step(p, t, d, k) {
    const u = 1 - t
    const e = 1 - u * u * u
    p.cx += d[k + 8] * e
    p.cy += d[k + 9] * e - 20 * t * t
    p.s = 1 - 0.6 * t
    p.rot = (d[k + 5] - 0.5) * 4 * e
  }
}

const VARIANTS = { dust, snap }
export type DissolvePreset = keyof typeof VARIANTS

interface Burst {
  source: HTMLCanvasElement
  x: number
  y: number
  w: number
  h: number
  v: Variant
  P: BurstParams
  d: Float32Array
  stride: number
  count: number
  end: number
  duration: number
  sx0: number
  sy0: number
  start: number
  finish: () => void
}

const bursts = new Set<Burst>()
let running = false

const particle: Particle = { cx: 0, cy: 0, s: 1, rot: 0, a: 1 }

function frame(now: number): void {
  const { overlay, ctx } = ensureStage()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, overlay.width, overlay.height)
  for (const burst of bursts) {
    const raw = ((now - burst.start) / burst.duration) * burst.end
    if (raw >= burst.end) {
      bursts.delete(burst)
      burst.finish()
      continue
    }
    // 快照是「按下那一刻的视口坐标」，页面在这之后滚过的话要把差值补回去
    const offX = burst.sx0 - scrollX
    const offY = burst.sy0 - scrollY
    const { P, d, stride, v } = burst
    const grain = P.grain
    const physical = grain * DPR
    for (let i = 0; i < burst.count; i++) {
      const k = i * stride
      let t = (raw - d[k + 6]) / d[k + 7]
      t = t < 0 ? 0 : t > 1 ? 1 : t
      particle.cx = P.x + d[k]
      particle.cy = P.y + d[k + 1]
      particle.s = 1
      particle.rot = 0
      particle.a = 1 - t * t * (3 - 2 * t)
      v.step(particle, t, d, k, P)
      if (particle.a <= 0.01 || particle.s <= 0) continue
      const cs = Math.cos(particle.rot) * particle.s * DPR
      const sn = Math.sin(particle.rot) * particle.s * DPR
      ctx.setTransform(
        cs,
        sn,
        -sn,
        cs,
        (particle.cx + offX) * DPR,
        (particle.cy + offY) * DPR
      )
      ctx.globalAlpha = particle.a > 1 ? 1 : particle.a
      ctx.drawImage(
        burst.source,
        d[k] * DPR - physical / 2,
        d[k + 1] * DPR - physical / 2,
        physical,
        physical,
        -grain / 2,
        -grain / 2,
        grain,
        grain
      )
    }
  }
  ctx.globalAlpha = 1
  if (bursts.size) requestAnimationFrame(frame)
  else {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, overlay.width, overlay.height)
    running = false
  }
}

function launch(burst: Burst, handle: DissolveHandle): void {
  ensureStage()
  handle.cancel = () => {
    bursts.delete(burst)
    burst.finish()
  }
  bursts.add(burst)
  if (!running) {
    running = true
    requestAnimationFrame(frame)
  }
}

export interface DissolvePlayOptions {
  /** 散开前的快照（瓦片整块或拼合中的画面） */
  source: HTMLCanvasElement
  /** 快照左上角的视口坐标 */
  x: number
  y: number
  w: number
  h: number
  preset?: DissolvePreset
  /** snap：散开的原点（瓦片内坐标） */
  origin?: { x: number; y: number }
  duration?: number
  grain?: number
}

export interface DissolveHandle {
  done: Promise<void>
  cancel(): void
}

export function playDissolve(opts: DissolvePlayOptions): DissolveHandle {
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => (resolveDone = resolve))
  const handle: DissolveHandle = { done, cancel: () => {} }
  const variant = VARIANTS[opts.preset ?? 'dust']
  if (!variant || prefersReducedMotion() || !(opts.w > 0 && opts.h > 0)) {
    resolveDone()
    return handle
  }
  let grain = opts.grain ?? variant.grain
  const minGrain = Math.sqrt((opts.w * opts.h) / MAX_GRAINS)
  if (grain < minGrain) grain = Math.ceil(minGrain * 2) / 2

  const duration = opts.duration ?? 1500
  const w = opts.w
  const h = opts.h
  const origin = opts.origin ?? { x: w / 2, y: h / 2 }
  const maxD = Math.max(
    Math.hypot(origin.x, origin.y),
    Math.hypot(w - origin.x, origin.y),
    Math.hypot(origin.x, h - origin.y),
    Math.hypot(w - origin.x, h - origin.y)
  )
  const P: BurstParams = {
    x: opts.x,
    y: opts.y,
    w,
    h,
    grain,
    cols: Math.ceil(w / grain),
    rows: Math.ceil(h / grain),
    maxR: Math.hypot(w / 2, h / 2),
    sec: duration / 1000,
    ox: origin.x,
    oy: origin.y,
    maxD,
    n0: 0
  }
  const stride = BASE + (variant.extra ?? 0)
  const count = P.cols * P.rows
  const d = new Float32Array(count * stride)
  for (let row = 0; row < P.rows; row++) {
    for (let col = 0; col < P.cols; col++) {
      const i = row * P.cols + col
      const k = i * stride
      const g: GrainSeed = {
        lx: (col + 0.5) * grain,
        ly: (row + 0.5) * grain,
        r1: Math.random(),
        r2: Math.random(),
        r3: Math.random(),
        r4: Math.random()
      }
      const timing = variant.timing(g, P)
      d[k] = g.lx
      d[k + 1] = g.ly
      d[k + 2] = g.r1
      d[k + 3] = g.r2
      d[k + 4] = g.r3
      d[k + 5] = g.r4
      d[k + 6] = timing.delay
      d[k + 7] = timing.life
    }
  }
  variant.prepare?.(d, stride, count, P)
  launch(
    {
      source: opts.source,
      x: opts.x,
      y: opts.y,
      w,
      h,
      v: variant,
      P,
      d,
      stride,
      count,
      end: DEFAULT_END,
      duration,
      sx0: scrollX,
      sy0: scrollY,
      start: performance.now(),
      finish: resolveDone
    },
    handle
  )
  return handle
}

/** 按 DPR 把一段绘制录成快照画布（散开效果把它当颗粒纹理） */
export function snapshotCanvas(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(w * DPR)
  canvas.height = Math.ceil(h * DPR)
  const ctx = canvas.getContext('2d')!
  ctx.scale(DPR, DPR)
  draw(ctx)
  return canvas
}

// ---------------------------------------------------------------------------
// 瓦片表面的绘制工具（tile 控制器共用）
// ---------------------------------------------------------------------------

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** 名字放不下时按像素宽截断并补省略号 */
export function fitText(ctx: CanvasRenderingContext2D, str: string, maxW: number): string {
  if (ctx.measureText(str).width <= maxW) return str
  let out = str
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1)
  return `${out.trimEnd()}…`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface GrainField {
  n: number
  data: Float32Array
}

/**
 * 每颗粒子的本地坐标、出现阈值（从左到右）和落位前漂移。
 * 阈值 = (0.78 * 横向位置 + 0.22 * 噪声) * (1 - WINDOW)，所以进度越高、左侧先亮。
 */
export function grainField(size: number): GrainField {
  const n = Math.floor(size / GRAIN)
  const data: number[] = []
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col
      const lx = (col + 0.5) * GRAIN
      const ly = (row + 0.5) * GRAIN
      data.push(
        lx,
        ly,
        (0.78 * (lx / size) + 0.22 * hash(i, 1)) * (1 - WINDOW),
        (hash(i, 2) - 0.5) * 2 * DRIFT,
        (hash(i, 3) - 0.5) * 2 * DRIFT
      )
    }
  }
  return { n, data: new Float32Array(data) }
}
