/**
 * 标签装饰登记表的单测。
 *
 * 防两件回归：
 *
 * 1. **内容没变也要通知** —— 调用方常在 effect / 每次渲染里写（图省事），无脑 bump 版本号
 *    会让整条标签条跟着每帧重渲染；流式输出期间每来一个 token 一次，直接卡死。所以
 *    「同内容写入 = 不通知」是契约，不是优化。
 * 2. **写进表却没人重渲染** —— 这张表与 `panel-store` 没有任何关系（`openTab` 对已存在的
 *    key 不 emit），全靠版本号订阅；订阅链路断了，界面就停在旧图标上。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  clearTabDecoration,
  getTabDecoration,
  getTabDecorationsVersion,
  setTabDecoration,
  subscribeTabDecorations
} from './tab-decorations'

describe('tab-decorations', () => {
  it('写进去能读出来', () => {
    setTabDecoration('t:read', { icon: 'icon-a', status: { tone: 'ok' } })
    expect(getTabDecoration('t:read')).toEqual({ icon: 'icon-a', status: { tone: 'ok' } })
    clearTabDecoration('t:read')
  })

  it('内容没变就不通知（否则流式期间标签条每帧重渲染）', () => {
    setTabDecoration('t:same', { icon: 'icon-a', status: { tone: 'ok', label: '活着' } })
    const listener = vi.fn()
    const off = subscribeTabDecorations(listener)
    const before = getTabDecorationsVersion()

    setTabDecoration('t:same', { icon: 'icon-a', status: { tone: 'ok', label: '活着' } })

    expect(listener).not.toHaveBeenCalled()
    expect(getTabDecorationsVersion()).toBe(before)

    off()
    clearTabDecoration('t:same')
  })

  it('内容变了（含只换 tone / label）就通知一次', () => {
    setTabDecoration('t:change', { status: { tone: 'ok' } })
    const listener = vi.fn()
    const off = subscribeTabDecorations(listener)
    const before = getTabDecorationsVersion()

    setTabDecoration('t:change', { status: { tone: 'error' } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getTabDecorationsVersion()).toBe(before + 1)

    setTabDecoration('t:change', { status: { tone: 'ok', label: '变了' } })
    expect(listener).toHaveBeenCalledTimes(2)

    off()
    clearTabDecoration('t:change')
  })

  it('清理后读不到；清一个不存在的 key 不通知', () => {
    setTabDecoration('t:gone', { icon: 'icon-a' })
    const listener = vi.fn()
    const off = subscribeTabDecorations(listener)
    const before = getTabDecorationsVersion()

    clearTabDecoration('t:gone')
    expect(getTabDecoration('t:gone')).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)

    clearTabDecoration('t:gone')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getTabDecorationsVersion()).toBe(before + 1)

    off()
  })
})
