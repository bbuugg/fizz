import { useEffect, useRef } from 'react'
import { useT } from '@fizz/agent-kit/shared/lib/language'

// Adapted from the user-provided Dot Grid Loader in load.txt.
const SIZE = 360
const ORBS = [
  { rx: 90, ry: 70, sx: 0.7, sy: 1.1, px: 0, py: 0, pulse: 0 },
  { rx: 70, ry: 95, sx: -1.2, sy: 0.8, px: 2, py: 1.5, pulse: 0.35 }
]

export function ImageLoadingGrid() {
  const tr = useT()
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    const motion = window.matchMedia('(prefers-reduced-motion: no-preference)')
    let frame = 0
    let start: number | undefined

    const draw = (time: number) => {
      const focuses = ORBS.map(({ rx, ry, sx, sy, px, py, pulse }) => ({
        x: Math.sin(time * sx + px) * rx,
        y: Math.cos(time * sy + py) * ry,
        weight: pulse ? (Math.sin(time * pulse) + 1) / 2 : 1
      }))
      context.clearRect(0, 0, SIZE, SIZE)
      for (let i = 0; i < 400; i += 1) {
        const x = (i % 20 - 10) * 18
        const y = (Math.floor(i / 20) - 10) * 18
        let intensity = 0
        for (const focus of focuses) {
          const distance = Math.hypot(x - focus.x, y - focus.y)
          intensity += Math.max(0, 1 - distance / 110) ** 1.4 * focus.weight
        }
        intensity = Math.min(1, intensity)
        context.fillStyle = 'currentColor'
        context.globalAlpha = 0.24 + 0.66 * intensity
        context.beginPath()
        context.arc(x + 189, y + 189, 3 * (0.333 + 0.317 * intensity), 0, 2 * Math.PI)
        context.fill()
      }
    }

    const tick = (now: number) => {
      start ??= now
      draw((now - start) * 0.0012)
      // Keep the loading state visible for slow images without perpetual motion.
      if (now - start < 4800) frame = requestAnimationFrame(tick)
    }
    const syncMotion = () => {
      cancelAnimationFrame(frame)
      draw(0)
      if (motion.matches && !document.hidden) frame = requestAnimationFrame(tick)
    }
    syncMotion()
    motion.addEventListener('change', syncMotion)
    document.addEventListener('visibilitychange', syncMotion)
    return () => {
      cancelAnimationFrame(frame)
      motion.removeEventListener('change', syncMotion)
      document.removeEventListener('visibilitychange', syncMotion)
    }
  }, [])

  return (
    <span role="status" className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg bg-muted text-muted-foreground">
      <span className="sr-only">{tr('加载中…')}</span>
      <canvas ref={canvas} aria-hidden="true" width={SIZE} height={SIZE} className="aspect-square w-full max-w-60" />
    </span>
  )
}
