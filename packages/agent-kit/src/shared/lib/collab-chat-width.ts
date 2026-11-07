/**
 * 多智能体协作会话里「右侧共享会话面板」的宽度（左侧是 Agent 名单）。
 *
 * 与 `terminal-assistant-width.ts` 同一套：全局一份、`null` = 用户没拖过，
 * 默认宽度与拖拽上限都按容器宽度现场算。这个面板的开合不由用户控制（协作会话恒显示），
 * 没有可绑定的 scope，所以不按会话记，避免 localStorage 随会话增删攒键。
 */
import { useSyncExternalStore } from 'react'

const KEY = 'fizz.web.collabChatWidth'

/** 再窄消息就折行到没法读了 */
export const COLLAB_CHAT_MIN_WIDTH = 320
/** 名单至少留这么多，否则名字 / 状态挤成一团 */
export const COLLAB_CANVAS_MIN_WIDTH = 360
/** 容器宽度还没量到时的兜底（`useContainerWidth` 首帧是 0） */
const FALLBACK_CONTAINER_WIDTH = 1200

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function getCollabChatWidth(): number | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= COLLAB_CHAT_MIN_WIDTH ? Math.round(n) : null
  } catch {
    return null
  }
}

export function setCollabChatWidth(width: number): void {
  const next =
    Number.isFinite(width) && width >= COLLAB_CHAT_MIN_WIDTH ? Math.round(width) : null
  if (getCollabChatWidth() === next) return
  try {
    if (next === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(next))
  } catch {
    // 存不进去不影响本次会话
  }
  notify()
}

export function resetCollabChatWidth(): void {
  setCollabChatWidth(Number.NaN)
}

/** 窄容器下把最小宽度让到一半，避免名单被挤没 */
export function minCollabChatWidth(containerWidth: number): number {
  const w = containerWidth > 0 ? containerWidth : FALLBACK_CONTAINER_WIDTH
  return Math.min(COLLAB_CHAT_MIN_WIDTH, Math.round(w / 2))
}

/** 没拖过时给容器的大约三分之一（宽屏约 24rem） */
export function defaultCollabChatWidth(containerWidth: number): number {
  if (containerWidth <= 0) return COLLAB_CHAT_MIN_WIDTH
  return Math.max(
    minCollabChatWidth(containerWidth),
    Math.min(Math.round(containerWidth * 0.32), maxCollabChatWidth(containerWidth))
  )
}

/** 拖拽上限：容器宽 - 名单最小宽（名单最小宽随容器收缩） */
export function maxCollabChatWidth(containerWidth: number): number {
  const w = containerWidth > 0 ? containerWidth : FALLBACK_CONTAINER_WIDTH
  const canvasMin = Math.min(COLLAB_CANVAS_MIN_WIDTH, Math.round(w * 0.55))
  return Math.max(minCollabChatWidth(w), w - canvasMin)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useCollabChatWidth(): number | null {
  return useSyncExternalStore(subscribe, getCollabChatWidth, () => null)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === KEY) notify()
  })
}
