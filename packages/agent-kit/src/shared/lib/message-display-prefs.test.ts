/**
 * 这组测试防止消息默认展开偏好被坏数据打乱，以及已完成内容在自动折叠档位下仍保持展开。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MESSAGE_DISPLAY_PREFS,
  normalizeMessageDisplayPrefs,
  resolveInitialFoldOpen
} from './message-display-prefs'

describe('message display preferences', () => {
  it('falls back to defaults for malformed or unsupported saved values', () => {
    expect(normalizeMessageDisplayPrefs(null)).toEqual(DEFAULT_MESSAGE_DISPLAY_PREFS)
    expect(normalizeMessageDisplayPrefs({
      group: { defaultOpen: 'yes', autoCollapse: 'invalid' },
      tool: { defaultOpen: true, autoCollapse: 'reasoning-end' }
    })).toEqual({
      ...DEFAULT_MESSAGE_DISPLAY_PREFS,
      tool: { defaultOpen: true, autoCollapse: 'never' }
    })
  })

  it('uses default state while content is active and collapses only at its configured boundary', () => {
    expect(resolveInitialFoldOpen(true, 'item-end', { itemDone: false, turnDone: false })).toBe(true)
    expect(resolveInitialFoldOpen(true, 'item-end', { itemDone: true, turnDone: false })).toBe(false)
    expect(resolveInitialFoldOpen(true, 'turn-end', { itemDone: true, turnDone: false })).toBe(true)
    expect(resolveInitialFoldOpen(true, 'turn-end', { itemDone: true, turnDone: true })).toBe(false)
    expect(resolveInitialFoldOpen(false, 'never', { itemDone: false, turnDone: false })).toBe(false)
  })
})
