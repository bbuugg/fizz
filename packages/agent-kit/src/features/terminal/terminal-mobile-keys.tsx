/**
 * 手机端虚拟键盘缺修饰键 / 功能键：底部快捷键条的「粘连修饰键」与按键合成。
 *
 * 从 `TerminalPanel` 拆出来的原因很单纯：这些是**纯函数 + 一个无状态按钮**，
 * 跟终端的会话生命周期、PTY、xterm 实例毫无关系。
 */
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 手机端虚拟键盘缺修饰键 / 功能键：底部快捷键条用的「粘连」修饰键状态。 */
export type ModsState = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

export const NO_MODS: ModsState = { ctrl: false, alt: false, shift: false, meta: false }

/** xterm 修饰参数：1 + shift(1) + alt(2) + ctrl(4) + meta(8) */
function modParam(m: ModsState): number {
  return 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0) + (m.meta ? 8 : 0)
}

/** 功能键在带修饰键时的转义序列（无修饰走 xterm 默认短序列） */
export function specialSeq(token: string, m: ModsState): string {
  const p = modParam(m)
  switch (token) {
    case 'Tab':
      return m.alt ? `\x1b\t` : '\t'
    case 'Escape':
      return '\x1b'
    case 'ArrowUp':
      return p === 1 ? '\x1b[A' : `\x1b[1;${p}A`
    case 'ArrowDown':
      return p === 1 ? '\x1b[B' : `\x1b[1;${p}B`
    case 'ArrowRight':
      return p === 1 ? '\x1b[C' : `\x1b[1;${p}C`
    case 'ArrowLeft':
      return p === 1 ? '\x1b[D' : `\x1b[1;${p}D`
    case 'Home':
      return p === 1 ? '\x1b[H' : `\x1b[1;${p}H`
    case 'End':
      return p === 1 ? '\x1b[F' : `\x1b[1;${p}F`
    case 'PageUp':
      return p === 1 ? '\x1b[5~' : `\x1b[5;${p}~`
    case 'PageDown':
      return p === 1 ? '\x1b[6~' : `\x1b[6;${p}~`
    default:
      return ''
  }
}

/** 软键盘字符套上粘连修饰键：Ctrl 清高位成控制字符，Alt 前缀 ESC。 */
export function transformChar(data: string, m: ModsState): string {
  if (data.length !== 1) return data
  const code = data.charCodeAt(0)
  let out = data
  if (m.ctrl) out = String.fromCharCode(code & 0x1f)
  if (m.alt) out = `\x1b${out}`
  return out
}

export const hasAnyMod = (m: ModsState): boolean => m.ctrl || m.alt || m.shift || m.meta

/** 长按开始连发的等待时间 */
const REPEAT_DELAY = 400
/** 连发间隔 */
const REPEAT_INTERVAL = 70

/** 手机端底部快捷键条上的单个键（粘连修饰键高亮） */
export function MobileKey({
  label,
  active,
  onClick,
  ariaLabel,
  repeat = false,
  className
}: {
  label: string
  active?: boolean
  onClick: () => void
  ariaLabel?: string
  /** 长按连续触发（方向键 / 翻页键） */
  repeat?: boolean
  className?: string
}) {
  const holdTimer = useRef<number | null>(null)
  const repeatTimer = useRef<number | null>(null)
  /** 这一轮按下已经进入连发：用来吞掉松手时浏览器补发的那次 click */
  const repeating = useRef(false)
  const onClickRef = useRef(onClick)
  onClickRef.current = onClick

  const clearTimers = useCallback(() => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    if (repeatTimer.current !== null) {
      window.clearInterval(repeatTimer.current)
      repeatTimer.current = null
    }
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const start = useCallback(() => {
    clearTimers()
    repeating.current = false
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      repeating.current = true
      onClickRef.current()
      if (repeat) {
        repeatTimer.current = window.setInterval(() => onClickRef.current(), REPEAT_INTERVAL)
      }
    }, REPEAT_DELAY)
  }, [clearTimers, repeat])

  const stop = useCallback(() => {
    clearTimers()
  }, [clearTimers])

  const handleClick = useCallback(() => {
    if (repeating.current) {
      repeating.current = false
      return
    }
    onClickRef.current()
  }, [])

  /**
   * 按下时 `preventDefault()`，**别让按钮抢走终端的焦点**。
   *
   * 焦点一换，软键盘就会跟着开合：终端 textarea 仍聚焦时安卓用返回键收起键盘并不丢焦点，
   * 这时点一下键条又 focus 一次，键盘就重新弹出来了。拦住默认行为后，终端原本聚焦就
   * 继续聚焦（键盘不动），原本没聚焦也不会被按钮或终端抢回来 —— 按键只发字节，不碰
   * 输入状态。`click` 不受影响（不是 compatibility mouse event）。
   */
  const onPointerDown = repeat
    ? (e: ReactPointerEvent<HTMLButtonElement>): void => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        start()
      }
    : (e: ReactPointerEvent<HTMLButtonElement>): void => e.preventDefault()

  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      aria-pressed={active}
      onClick={repeat ? handleClick : onClick}
      onPointerDown={onPointerDown}
      onPointerUp={repeat ? stop : undefined}
      onPointerLeave={repeat ? stop : undefined}
      onPointerCancel={repeat ? stop : undefined}
      onContextMenu={repeat ? (e) => e.preventDefault() : undefined}
      className={cn(
        'flex h-8 w-full min-w-0 select-none items-center justify-center px-0.5 text-xs font-medium transition-colors',
        repeat && 'touch-manipulation',
        className,
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-background text-foreground hover:bg-accent active:bg-accent/70'
      )}
    >
      {label}
    </button>
  )
}
