/**
 * 防回归：审批卡倒计时的两个边界。
 *
 * 1. 过期后**不能**显示负数 / 负号（服务端已经按拒绝收场，卡正在被撤）；
 * 2. 最后一秒要用 ceil —— 剩 0.4 秒显示 `0:01`，floor 会提前露出 `0:00`，
 *    看起来像「该自动拒绝了却没反应」。
 */
import { describe, expect, it } from 'vitest'
import { formatCountdown, remainingMs } from './confirm-countdown'

describe('remainingMs', () => {
  it('返回剩余毫秒', () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000)
  })

  it('过期按 0（不返回负数）', () => {
    expect(remainingMs(10_000, 12_000)).toBe(0)
  })
})

describe('formatCountdown', () => {
  it('默认 10 分钟显示 10:00', () => {
    expect(formatCountdown(10 * 60 * 1000)).toBe('10:00')
  })

  it('分秒补零', () => {
    expect(formatCountdown(61_000)).toBe('1:01')
    expect(formatCountdown(5_000)).toBe('0:05')
  })

  it('最后一秒向上取整，不提前显示 0:00', () => {
    expect(formatCountdown(400)).toBe('0:01')
    expect(formatCountdown(1)).toBe('0:01')
  })

  it('超过一小时带小时段', () => {
    expect(formatCountdown(3_600_000)).toBe('1:00:00')
    expect(formatCountdown(3_661_000)).toBe('1:01:01')
  })

  it('0 与负数都显示 0:00', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-5_000)).toBe('0:00')
  })
})
