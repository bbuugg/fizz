/**
 * 内置模型的动态档位滑块（ACP 的思考档不用它：外部 Agent 的档位没有强度递增语义，
 * 在 `AcpThoughtLevelSelect` 里列成一排按钮）。只处理有序候选项与选中值，不认识模型、
 * 配置 id 或 API。星空、果冻形变和松手吸附沿用原内置滑块；所有几何按实际档位数量计算。
 * 标签由调用方处理：内置翻译固定档位。
 *
 * 吸附 / 按压 / 果冻形变都由 gsap 补间驱动，canvas 动画挂在同一条 `gsap.ticker`
 * 上；`prefers-reduced-motion` 下停掉 ticker，只把当前帧静态画出来，交互照常可用。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { gsap } from 'gsap'
import { Slider } from '@fizz/ui/slider'
import { NativeSelect, NativeSelectOption } from '@fizz/ui/native-select'
import { usePrefersReducedMotion } from '@fizz/agent-kit/shared/hooks/usePrefersReducedMotion'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { criticallyDampedEase } from '@fizz/agent-kit/features/chat/effort-spring'
import '@fizz/agent-kit/features/chat/reasoning-effort.css'

function clampIndex(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0
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

export interface EffortSliderLevel<Value extends string | null> {
  value: Value
  label: string
  description?: string
}

interface EffortSliderProps<Value extends string | null> {
  levels: readonly EffortSliderLevel<Value>[]
  value: Value | undefined
  onChange: (next: Value) => void
  label: string
  unsetLabel: string
  disabled?: boolean
  busy?: boolean
  title?: string | ((currentLabel: string) => string)
  /** 模型 / 会话变化，即使候选项相同也应取消旧拖动。 */
  resetKey?: string
}

/**
 * 松手后要不要把拇指拉回落库档位。判据只有一条：落库值不再是「自己上一次提交的那个档位」。
 * 自己那次提交的回声必须保留预览 —— `value` 比 `onChange` 晚一拍到达时，一旦回落就会看到
 * 拇指先滑回原位再滑回来，用户会以为没拖上，得再拖第二次（2026-11-26 的回归）。
 */
export function shouldResetPreview<Value extends string | null>(input: {
  levels: readonly { value: Value }[]
  value: Value | undefined
  submitted: Value | undefined
  disabled: boolean
}): boolean {
  if (input.disabled) return true
  const indexOf = (target: Value | undefined) => input.levels.findIndex((level) => level.value === target)
  return indexOf(input.value) !== indexOf(input.submitted)
}

export function EffortSlider<Value extends string | null>(props: EffortSliderProps<Value>) {
  if (!props.levels.length) return null
  // 候选项重排或移除时丢弃旧下标和手势，不能把旧模型的预览提交给新模型。
  const key = JSON.stringify([props.resetKey ?? null, props.levels.map((level) => level.value)])
  return <EffortSliderControl key={key} {...props} />
}

function EffortSliderControl<Value extends string | null>({
  levels,
  value,
  onChange,
  label,
  unsetLabel,
  disabled: disabledProp = false,
  busy = false,
  title,
}: EffortSliderProps<Value>) {
  const reducedMotion = usePrefersReducedMotion()
  const max = levels.length - 1
  const foundIndex = levels.findIndex((level) => level.value === value)
  const activeIndex = Math.max(0, foundIndex)
  const disabled = disabledProp || busy || max === 0

  // 拖动中保存连续值（如 2.37），松手/点击档位后才吸附到整数档
  const [preview, setPreview] = useState(activeIndex)
  const [dragging, setDragging] = useState(false)
  const previewRef = useRef(activeIndex)
  const gesture = useRef<DragGesture | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const motion = useRef<EffortMotion | null>(null)
  const alive = useRef(true)
  const cancelled = useRef(false)
  const submitted = useRef(value)
  const liveDisabled = useRef(disabled)
  liveDisabled.current = disabled

  /*
   * 显示永远跟本地预览走。松手那一帧 `onChange` 已经发出，但落库值回灌到 `value` 可能
   * 晚一拍：此时若按 `interacting ? preview : activeIndex` 回落到旧档位，拇指会先滑回
   * 原位再滑回来 —— 用户看到的就是「松手就滚回去了，得再拖第二次」。只有外部真的改了值
   * （见下面那个 `useLayoutEffect`）才把预览拉回落库档位。
   */
  const shownPreview = preview
  const selected = clampIndex(shownPreview, max)
  const ratio = max ? shownPreview / max : 0
  const hasSelection = foundIndex >= 0 || shownPreview !== activeIndex
  const currentLevel = levels[selected]
  const currentLabel = hasSelection ? currentLevel.label : unsetLabel
  // 档位过多或名称过长时，保留滑块并用完整选单代替拥挤的底部标签。
  const denseLabels = levels.length > 8 || levels.some((level) => Array.from(level.label).length > 12)

  const updatePreview = (next: number) => {
    const clamped = Number.isFinite(next) ? Math.min(max, Math.max(0, next)) : 0
    previewRef.current = clamped
    setPreview(clamped)
  }

  const commit = (next: number) => {
    if (!alive.current || liveDisabled.current) return
    const index = clampIndex(next, max)
    updatePreview(index)
    const target = levels[index]
    // Radix commit、指针收尾和快速连点共享同一闸门；一次操作至多提交一次。
    if (target && target.value !== submitted.current) {
      submitted.current = target.value
      onChange(target.value)
    }
  }

  const cancelGesture = () => {
    cancelled.current = true
    gesture.current = null
    setDragging(false)
    updatePreview(activeIndex)
    motion.current?.release()
  }

  useLayoutEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useLayoutEffect(() => {
    // 只有外部真的改了值（服务端推送、保存失败回退、换模型、生成开始）才作废旧手势。
    const reset = shouldResetPreview({ levels, value, submitted: submitted.current, disabled })
    submitted.current = value
    if (reset) cancelGesture()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foundIndex, value, disabled])

  useLayoutEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return
    const controller = createEffortMotion(root, canvas, max ? previewRef.current / max : 0, reducedMotion)
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
    if (liveDisabled.current || !event.isPrimary || event.button !== 0) return
    cancelled.current = false
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
    if (liveDisabled.current || !currentGesture || event.pointerId !== currentGesture.id) return
    if (!currentGesture.moved && Math.abs(event.clientX - currentGesture.startX) < 4) return
    currentGesture.moved = true
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
    setDragging(false)
    const snapped = Math.round(previewRef.current)
    updatePreview(snapped)
    /*
     * 吸附必须在松手这一帧就落地：改成滑行的话，低帧率下（弹层里有背景模糊，一帧
     * 可能上百毫秒）松手后那段位移是一串台阶，看起来就是拇指在抖。位置直接对齐，
     * 回弹只留给果冻形变的收尾。
     */
    motion.current?.moveTo(max ? snapped / max : 0, true)
    motion.current?.release()
  }

  return (
    <div
      ref={rootRef}
      className="reasoning-effort flex flex-col gap-2"
      data-dragging={dragging || undefined}
      data-maximum={(max > 0 && hasSelection && selected === max) || undefined}
      data-disabled={disabled || undefined}
      aria-busy={busy || undefined}
    >
      <div className="flex items-center justify-between gap-2 px-0.5" title={typeof title === 'function' ? title(currentLabel) : title}>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium">
          {label}
          {busy && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
        </span>
        <span className="reasoning-effort-current truncate text-xs" title={currentLevel.description ?? currentLabel}>{currentLabel}</span>
      </div>
      {max > 0 && <div className="relative h-[30px]">
        <div aria-hidden className="reasoning-effort-track">
          <div className="reasoning-effort-fill">
            <canvas ref={canvasRef} />
          </div>
          <div className="reasoning-effort-dots">
            {levels.map((level) => (
              <span key={JSON.stringify(level.value)} />
            ))}
          </div>
          <span className="reasoning-effort-thumb" />
        </div>
        <Slider
          min={0}
          max={max}
          disabled={disabled}
          // 细步长让拖动连续顺滑，松手时再按最近档位吸附
          step={0.001}
          value={[shownPreview]}
          onValueChange={([next]) => {
            if (!liveDisabled.current && !cancelled.current) updatePreview(next ?? 0)
          }}
          /*
           * 吸附只认**最新指针位置**（previewRef）：Radix 回调里的值是它上一次渲染的
           * 快照，快速甩动时会比指针落后一两步。两处各自取整还会「先吸到 A 再漂到 B」。
           */
          onValueCommit={() => { if (!cancelled.current) commit(previewRef.current) }}
          onPointerDownCapture={onPointerDownCapture}
          onPointerMoveCapture={onPointerMoveCapture}
          onPointerUpCapture={onPointerUpCapture}
          onPointerCancel={cancelGesture}
          onLostPointerCapture={() => {
            if (gesture.current) cancelGesture()
          }}
          onKeyDownCapture={(event) => {
            if (liveDisabled.current) return
            let next = clampIndex(previewRef.current, max)
            if (['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key)) next += 1
            else if (['ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key)) next -= 1
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = max
            else return
            event.preventDefault()
            event.stopPropagation()
            cancelled.current = false
            commit(next)
          }}
          aria-label={label}
          thumbProps={{ 'aria-label': label, 'aria-valuetext': currentLabel }}
          className="reasoning-effort-input absolute inset-0 z-10 h-[30px]"
          trackClassName="data-horizontal:h-[30px] rounded-full bg-transparent"
          rangeClassName="sr-only"
          thumbClassName="reasoning-effort-input-thumb"
        />
      </div>}
      {max > 0 && (denseLabels ? (
        <NativeSelect
          size="sm"
          className="w-full"
          aria-label={label}
          value={hasSelection ? selected : ''}
          disabled={disabled}
          onChange={(event) => commit(Number(event.target.value))}
        >
          {foundIndex < 0 && <NativeSelectOption value="" disabled>{unsetLabel}</NativeSelectOption>}
          {levels.map((level, index) => <NativeSelectOption key={JSON.stringify(level.value)} value={index}>{level.label}</NativeSelectOption>)}
        </NativeSelect>
      ) : <div
        className="reasoning-effort-stops grid gap-0.5 px-0.5"
        style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}
      >
        {levels.map((level, index) => (
          <button
            key={JSON.stringify(level.value)}
            type="button"
            aria-pressed={hasSelection && index === selected}
            disabled={disabled}
            title={level.description ?? level.label}
            onClick={() => commit(index)}
            className={cn(
              'rounded py-0.5 text-[10px] leading-tight transition-colors hover:text-foreground',
              hasSelection && index === selected ? 'font-medium' : 'text-muted-foreground'
            )}
          >
            {level.label}
          </button>
        ))}
      </div>)}
    </div>
  )
}
