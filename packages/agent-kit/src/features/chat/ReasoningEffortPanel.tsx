/**
 * 内置会话的「思考强度」滑块 —— 固定在模型选择下拉底部（不再单独占一颗 pill）。
 *
 * 只给内置 Agent，ACP 的思考档是另一个控件（`AcpThoughtLevelSelect`，走
 * `acpThoughtLevel` / `session/set_config_option`）。可见性由调用方（`ModelSelect`）
 * 判定：只有 `backend === 'builtin'` 且 `configId` / `modelId` 都在时才挂进来；
 * 切到 ACP 或还没选具体模型时，底部这一块整个不出现。
 *
 * 视觉参照 LeiBox 的 `reasoning-effort-slider`：轨道里是流动星空（canvas），已填充
 * 部分按档位比例裁切，拇指随拖动速度做果冻形变，松手吸附到最近档位。**档位沿用本
 * 项目的八档**（默认 / 无 / 最小 / 低 / 中 / 高 / 极高 / 最高），不支持的具体档位由
 * 服务商自己降级，UI 不做假设。
 *
 * 吸附 / 按压 / 果冻形变都由 gsap 补间驱动，canvas 动画挂在同一条 `gsap.ticker`
 * 上；`prefers-reduced-motion` 下停掉 ticker，只把当前帧静态画出来，交互照常可用。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { Slider } from '@fizz/ui/slider'
import type { AiReasoningEffort } from '@fizz/contracts/types'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { usePrefersReducedMotion } from '@fizz/agent-kit/shared/hooks/usePrefersReducedMotion'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { criticallyDampedEase } from '@fizz/agent-kit/features/chat/effort-spring'
import '@fizz/agent-kit/features/chat/reasoning-effort.css'

/** `null` = 默认（不向 provider 下发 reasoning）；其余按强度递增。 */
const LEVELS: readonly { value: AiReasoningEffort | null; label: string }[] = [
  { value: null, label: '默认' },
  { value: 'none', label: '无' },
  { value: 'minimal', label: '最小' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高' },
]

const MAX_INDEX = LEVELS.length - 1

/**
 * 档位文案（`null` / `'provider-default'` / 未设置都算「默认」）。
 *
 * 给**只读展示**用（定时任务详情那种一行「思考强度：高」）：`LEVELS` 是这里的私有表，
 * 别在别处再抄一份 —— 抄一份就会出现「滑块上叫『极高』、详情里叫『最高』」。
 */
export function reasoningEffortLabel(value: AiReasoningEffort | null | undefined): string {
  const current = value === 'provider-default' ? null : (value ?? null)
  return LEVELS.find((level) => level.value === current)?.label ?? '默认'
}

function clampIndex(value: number): number {
  return Math.min(MAX_INDEX, Math.max(0, Math.round(value)))
}

/** 与参考实现同一张弹簧曲线：吸附时先冲过头一点再落定 */
const SPRING: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.02, 0.015],
  [0.04, 0.0532],
  [0.06, 0.1065],
  [0.08, 0.1686],
  [0.1, 0.2351],
  [0.13, 0.3363],
  [0.16, 0.4332],
  [0.2, 0.5495],
  [0.24, 0.648],
  [0.28, 0.7287],
  [0.33, 0.807],
  [0.38, 0.8646],
  [0.44, 0.9128],
  [0.5, 0.9447],
  [0.57, 0.968],
  [0.65, 0.9834],
  [0.74, 0.9924],
  [0.85, 0.9975],
  [1, 1],
]

function glideEase(progress: number): number {
  const end = SPRING.findIndex(([x]) => x >= progress)
  if (end <= 0) return end === 0 ? 0 : 1
  const [x0, y0] = SPRING[end - 1]
  const [x1, y1] = SPRING[end]
  return y0 + ((y1 - y0) * (progress - x0)) / (x1 - x0)
}

/**
 * 果冻形变的回正曲线（松手 / 拖动中停住都走它）。
 *
 * 必须单调收敛：欠阻尼弹簧会在原地来回过冲，看起来就是「滑块在抖」（见
 * `effort-spring.ts` 的文件头与用例）。形变的**发生**仍然跟手走，只有回正是
 * 「一到就停」的。
 */
const settleEase = criticallyDampedEase(400, 0.6)

/**
 * 星空画布：底色是一条从深灰到档位色相的渐变，上面铺 7 条缓慢起伏的亮带和 64 颗
 * 闪烁的星点。`ratio` 越大流动越快、色相越暖 —— 与参考实现同一套配方。
 */
function createEffortField(canvas: HTMLCanvasElement, getRatio: () => number) {
  const ctx = canvas.getContext('2d')
  let width = 0
  let height = 0
  let phase = 0
  let lastTime = 0
  const stars = Array.from({ length: 64 }, (_, index) => ({
    x: (index * 0.61803398875) % 1,
    y: (index * 0.754877666) % 1,
    size: 0.35 + ((index % 5) * 0.13),
    speed: 0.3 + ((index % 7) * 0.1),
  }))

  const resize = () => {
    width = canvas.clientWidth
    height = canvas.clientHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  const draw = (time = 0, still = false, motionBoost = 1) => {
    if (!ctx || width <= 0 || height <= 0) return
    const ratio = Math.min(1, Math.max(0, getRatio()))
    if (!still) {
      phase +=
        Math.min(Math.max(time - lastTime, 0), 0.05) *
        (0.16 + ratio * 0.85) *
        Math.max(1, motionBoost)
    }
    lastTime = time

    const hue = 210 + ratio * ratio * 63
    const fill = 32 + (width - 32) * ratio
    ctx.clearRect(0, 0, width, height)

    const base = ctx.createLinearGradient(0, 0, Math.max(fill, 32), 0)
    base.addColorStop(0, '#30343a')
    base.addColorStop(0.28, `hsl(${hue - 12} 38% 47%)`)
    base.addColorStop(0.65, `hsl(${hue} 79% 70%)`)
    base.addColorStop(1, `hsl(${hue + 5} 88% 70%)`)
    ctx.fillStyle = base
    ctx.fillRect(0, 0, width, height)

    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    for (let band = 0; band < 7; band += 1) {
      ctx.beginPath()
      for (let x = 0; x <= width + 4; x += 4) {
        const y = height * (0.12 + band * 0.15) +
          Math.sin(x * 0.034 + phase + band * 1.8) * 5 +
          Math.sin(x * 0.079 - phase * 0.6 + band) * 2 - x * 0.035
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.lineWidth = 2 + ((band % 3) * 2)
      ctx.strokeStyle = `hsla(${hue + band * 2} 90% 87% / ${0.06 + ratio * 0.025})`
      ctx.stroke()
    }

    const glowX = fill * (0.6 + Math.sin(phase * 0.7) * 0.12)
    const glow = ctx.createRadialGradient(glowX, height * 0.7, 0, glowX, height * 0.7, 46)
    glow.addColorStop(0, `hsla(${hue - 12} 100% 88% / .35)`)
    glow.addColorStop(1, `hsla(${hue} 100% 80% / 0)`)
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, width, height)

    for (const [index, star] of stars.entries()) {
      const x = (((star.x + phase * star.speed * 0.08) % 1) * width)
      const y = ((((star.y - phase * star.speed * 0.04) % 1) + 1) % 1) * height
      const fade = Math.min(1, x / 55)
      const twinkle = 0.45 + Math.sin(phase * 2 + index * 1.9) * 0.25
      ctx.fillStyle = `rgba(255,255,255,${fade * twinkle * (0.4 + ratio * 0.6)})`
      ctx.beginPath()
      ctx.ellipse(x, y, star.size * (1 + ratio * 0.5), star.size * 0.65, -0.45, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

    const shade = ctx.createLinearGradient(0, 0, Math.max(fill, 32), 0)
    shade.addColorStop(0, 'rgba(36,39,44,.8)')
    shade.addColorStop(0.45, 'rgba(36,39,44,0)')
    ctx.fillStyle = shade
    ctx.fillRect(0, 0, width, height)
  }

  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          resize()
          draw(lastTime, true)
        })
  observer?.observe(canvas)
  resize()

  return { draw, dispose: () => observer?.disconnect() }
}

interface EffortMotion {
  moveTo(ratio: number, immediate: boolean): void
  press(): void
  drag(velocity: number): void
  release(): void
  setReducedMotion(next: boolean): void
  dispose(): void
}

interface EffortState {
  ratio: number
  press: number
  body: number
  lean: number
  boost: number
}

/**
 * 补间全部交给 gsap：吸附、按压、果冻各走独立 tween，插值不会互相覆盖；
 * canvas 相位动画挂在 `gsap.ticker` 上，与补间同一时钟。
 */
function createEffortMotion(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  initialRatio: number,
  initialReducedMotion: boolean
): EffortMotion {
  const state: EffortState = { ratio: initialRatio, press: 1, body: 0, lean: 0, boost: 1 }
  const field = createEffortField(canvas, () => state.ratio)
  let targetRatio = initialRatio
  let reduced = initialReducedMotion
  let disposed = false
  let attached = false
  let ratioTween: gsap.core.Tween | null = null
  let pressTween: gsap.core.Tween | null = null
  let shapeTween: gsap.core.Tween | gsap.core.Timeline | null = null
  let boostTween: gsap.core.Tween | null = null

  const paint = () => {
    if (disposed) return
    root.style.setProperty('--effort-ratio', String(state.ratio))
    root.style.setProperty('--effort-press', String(state.press))
    root.style.setProperty('--effort-jelly-x', String(1 + state.body))
    root.style.setProperty('--effort-jelly-y', String(1 - state.body * 0.3))
    root.style.setProperty('--effort-jelly-offset', `${-state.lean * 9}px`)
    root.style.setProperty('--effort-jelly-skew', `${-state.lean * 12}deg`)
    root.style.setProperty('--effort-jelly-left', `${50 + state.lean * 32}%`)
    root.style.setProperty('--effort-jelly-right', `${50 - state.lean * 24}%`)
    if (reduced) field.draw(gsap.ticker.time, true)
  }

  const draw = (time: number) => {
    if (!document.hidden) field.draw(time, false, state.boost)
  }

  const syncTicker = () => {
    if (attached) gsap.ticker.remove(draw)
    attached = !reduced
    field.draw(gsap.ticker.time, true)
    if (attached) gsap.ticker.add(draw)
  }

  paint()
  syncTicker()

  return {
    moveTo(ratio, immediate) {
      const next = Math.min(1, Math.max(0, ratio))
      targetRatio = next
      ratioTween?.kill()
      ratioTween = null
      if (immediate || reduced || Math.abs(next - state.ratio) < 1e-4) {
        state.ratio = next
        paint()
        return
      }
      ratioTween = gsap.to(state, {
        ratio: next,
        duration: 0.24,
        ease: glideEase,
        onUpdate: paint,
      })
    },
    press() {
      pressTween?.kill()
      pressTween = gsap.to(state, {
        press: reduced ? 1 : 0.96,
        duration: reduced ? 0 : 0.08,
        ease: 'power2.out',
        onUpdate: paint,
      })
    },
    drag(velocity) {
      if (reduced || disposed) return
      const speed = Math.min(3.5, Math.abs(velocity))
      const deformation = Math.min(0.46, 0.045 + speed * 0.17)
      const lean = Math.sign(velocity) * deformation
      shapeTween?.kill()
      shapeTween = gsap
        .timeline({ onUpdate: paint })
        .to(state, { body: deformation, lean, duration: 0.09, ease: 'power2.out' })
        .to(state, { body: 0, lean: 0, duration: 0.6, ease: settleEase }, '>0.07')
      boostTween?.kill()
      boostTween = gsap.to(state, {
        boost: 1 + Math.min(2.2, 0.55 + speed * 0.6),
        duration: 0.12,
        ease: 'power2.out',
      })
    },
    release() {
      pressTween?.kill()
      pressTween = gsap.to(state, {
        press: 1,
        duration: reduced ? 0 : 0.32,
        ease: 'power2.out',
        onUpdate: paint,
      })
      shapeTween?.kill()
      shapeTween = gsap.to(state, {
        body: 0,
        lean: 0,
        duration: reduced ? 0 : 0.6,
        ease: settleEase,
        onUpdate: paint,
      })
      boostTween?.kill()
      boostTween = gsap.to(state, { boost: 1, duration: reduced ? 0 : 0.7, ease: 'power2.out' })
    },
    setReducedMotion(next) {
      if (next === reduced) return
      reduced = next
      ratioTween?.kill()
      pressTween?.kill()
      shapeTween?.kill()
      boostTween?.kill()
      ratioTween = pressTween = boostTween = null
      shapeTween = null
      state.ratio = targetRatio
      state.press = 1
      state.body = 0
      state.lean = 0
      state.boost = 1
      syncTicker()
      paint()
    },
    dispose() {
      disposed = true
      ratioTween?.kill()
      pressTween?.kill()
      shapeTween?.kill()
      boostTween?.kill()
      if (attached) gsap.ticker.remove(draw)
      attached = false
      field.dispose()
    },
  }
}

interface DragGesture {
  id: number
  startX: number
  lastX: number
  time: number
  moved: boolean
}

export function ReasoningEffortPanel({
  value,
  onChange,
}: {
  /** `undefined` / `null` / `provider-default` 都按「默认」显示 */
  value: AiReasoningEffort | null | undefined
  /** 落库值：`null` = 默认（跟随模型） */
  onChange: (next: AiReasoningEffort | null) => void
}) {
  const t = useT()
  const reducedMotion = usePrefersReducedMotion()

  const current = value === 'provider-default' ? null : (value ?? null)
  const activeIndex = Math.max(
    0,
    LEVELS.findIndex((level) => level.value === current)
  )

  // 拖动中保存连续值（如 2.37），松手/点击档位后才吸附到整数档
  const [preview, setPreview] = useState(activeIndex)
  const [dragging, setDragging] = useState(false)
  const previewRef = useRef(activeIndex)
  const draggingRef = useRef(false)
  const gesture = useRef<DragGesture | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const motion = useRef<EffortMotion | null>(null)

  const selected = clampIndex(preview)
  const ratio = MAX_INDEX ? preview / MAX_INDEX : 0
  const currentLabel = LEVELS[selected]?.label ?? '默认'
  // 同 `AcpThoughtLevelSelect`：切换只影响下一轮（服务端每轮开跑时读会话值）
  const title = t('思考强度：{name}（下一轮生效；模型不支持时由服务商降级）', {
    name: t(currentLabel),
  })

  const updatePreview = (next: number) => {
    const clamped = Math.min(MAX_INDEX, Math.max(0, next))
    previewRef.current = clamped
    setPreview(clamped)
  }

  const commit = (next: number) => {
    const index = clampIndex(next)
    updatePreview(index)
    const target = LEVELS[index]
    if (target && target.value !== current) onChange(target.value)
  }

  const cancelGesture = () => {
    draggingRef.current = false
    gesture.current = null
    setDragging(false)
    updatePreview(activeIndex)
    motion.current?.release()
  }

  useEffect(() => {
    if (draggingRef.current) return
    previewRef.current = activeIndex
    setPreview(activeIndex)
  }, [activeIndex])

  useLayoutEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return
    const controller = createEffortMotion(root, canvas, previewRef.current / MAX_INDEX, reducedMotion)
    motion.current = controller
    return () => {
      controller.dispose()
      motion.current = null
    }
    // 只挂一次；后续 ratio / 减动效通过下面的 effect 更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    motion.current?.moveTo(ratio, dragging)
  }, [ratio, dragging])

  useLayoutEffect(() => {
    motion.current?.setReducedMotion(reducedMotion)
  }, [reducedMotion])

  const onPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return
    gesture.current = {
      id: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      time: event.timeStamp,
      moved: false,
    }
    motion.current?.press()
  }

  const onPointerMoveCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    const currentGesture = gesture.current
    if (!currentGesture || event.pointerId !== currentGesture.id) return
    if (!currentGesture.moved && Math.abs(event.clientX - currentGesture.startX) < 4) return
    currentGesture.moved = true
    draggingRef.current = true
    setDragging(true)
    const velocity =
      (event.clientX - currentGesture.lastX) / Math.max(8, event.timeStamp - currentGesture.time)
    motion.current?.drag(velocity)
    currentGesture.lastX = event.clientX
    currentGesture.time = event.timeStamp
  }

  const onPointerUpCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== gesture.current?.id) return
    gesture.current = null
    draggingRef.current = false
    setDragging(false)
    const snapped = Math.round(previewRef.current)
    updatePreview(snapped)
    /*
     * 吸附必须在松手这一帧就落地：改成滑行的话，低帧率下（弹层里有背景模糊，一帧
     * 可能上百毫秒）松手后那段位移是一串台阶，看起来就是拇指在抖。位置直接对齐，
     * 回弹只留给果冻形变的收尾。
     */
    motion.current?.moveTo(MAX_INDEX ? snapped / MAX_INDEX : 0, true)
    motion.current?.release()
  }

  return (
    <div
      ref={rootRef}
      className="reasoning-effort flex flex-col gap-2"
      data-dragging={dragging || undefined}
      data-maximum={selected === MAX_INDEX || undefined}
    >
      <div className="flex items-center justify-between gap-2 px-0.5" title={title}>
        <span className="text-xs font-medium">{t('思考强度')}</span>
        <span className="reasoning-effort-current text-xs">{t(currentLabel)}</span>
      </div>
      <div className="relative h-[30px]">
        <div aria-hidden className="reasoning-effort-track">
          <div className="reasoning-effort-fill">
            <canvas ref={canvasRef} />
          </div>
          <div className="reasoning-effort-dots">
            {LEVELS.map((level) => (
              <span key={level.value ?? 'default'} />
            ))}
          </div>
          <span className="reasoning-effort-thumb" />
        </div>
        <Slider
          min={0}
          max={MAX_INDEX}
          // 细步长让拖动连续顺滑，松手时再按最近档位吸附
          step={0.001}
          value={[preview]}
          onValueChange={([next]) => updatePreview(next ?? 0)}
          /*
           * 吸附只认**最新指针位置**（previewRef）：Radix 回调里的值是它上一次渲染的
           * 快照，快速甩动时会比指针落后一两步。两处各自取整还会「先吸到 A 再漂到 B」。
           */
          onValueCommit={() => commit(previewRef.current)}
          onPointerDownCapture={onPointerDownCapture}
          onPointerMoveCapture={onPointerMoveCapture}
          onPointerUpCapture={onPointerUpCapture}
          onPointerCancel={cancelGesture}
          onLostPointerCapture={() => {
            if (gesture.current) cancelGesture()
          }}
          onKeyDownCapture={(event) => {
            let next = selected
            if (['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key)) next += 1
            else if (['ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key)) next -= 1
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = MAX_INDEX
            else return
            event.preventDefault()
            event.stopPropagation()
            commit(next)
          }}
          aria-label={t('思考强度')}
          className="reasoning-effort-input absolute inset-0 z-10 h-[30px]"
          trackClassName="data-horizontal:h-[30px] rounded-full bg-transparent"
          rangeClassName="sr-only"
          thumbClassName="reasoning-effort-input-thumb"
        />
      </div>
      <div className="reasoning-effort-stops grid grid-cols-8 gap-0.5 px-0.5">
        {LEVELS.map((level, index) => (
          <button
            key={level.value ?? 'default'}
            type="button"
            aria-pressed={index === selected}
            onClick={() => commit(index)}
            className={cn(
              'rounded py-0.5 text-[10px] leading-tight transition-colors hover:text-foreground',
              index === selected ? 'font-medium' : 'text-muted-foreground'
            )}
          >
            {t(level.label)}
          </button>
        ))}
      </div>
    </div>
  )
}
