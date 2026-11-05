import { describe, expect, it } from 'vitest'
import { resolveWindowKind } from './window-kind'

describe('resolveWindowKind', () => {
  it('defaults to main when there is no window param', () => {
    expect(resolveWindowKind('')).toEqual({ kind: 'main' })
  })
  // 设置在 2026-11 并回了主区域的标签页（`agent-kit` 的 `settings:list`）。
  // 这条在防的回归：有人照着旧注释又加一条 `?window=settings` 分支，等于把独立设置窗口
  // （第二个渲染进程 = 第二份 store 单例）请回来。
  it('treats a stale ?window=settings as the main window', () => {
    expect(resolveWindowKind('?window=settings&tab=models')).toEqual({ kind: 'main' })
  })
  it('detects a conversation float window and passes its conversation id', () => {
    expect(resolveWindowKind('?window=conversation&conversationId=abc')).toEqual({
      kind: 'conversation',
      conversationId: 'abc'
    })
  })
  // 浮窗是「一条会话一个窗口」，正常路径一定带 id；没有 id 时仍要渲染窗口本身，
  // 由 `ConversationWindow` 给「没有指定会话」的空态 —— 别改成白屏或干脆不渲染。
  it('still resolves a float window without an id (renders an empty state)', () => {
    expect(resolveWindowKind('?window=conversation')).toEqual({ kind: 'conversation' })
  })
})
