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
  it('detects a conversation float window and passes its seed id', () => {
    expect(resolveWindowKind('?window=conversation&conversationId=abc')).toEqual({
      kind: 'conversation',
      initialConversationId: 'abc'
    })
  })
  it('renders the float window even without a seed id (draft / current)', () => {
    expect(resolveWindowKind('?window=conversation')).toEqual({ kind: 'conversation' })
  })
})
