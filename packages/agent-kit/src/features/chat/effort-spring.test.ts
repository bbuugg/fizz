/**
 * 防的回归：思考强度滑块**松手后会抖**（用户报的 bug）。
 *
 * 旧版收尾用欠阻尼弹簧（阻尼比 0.575），松手后 0.6s 内过冲两次；这里的曲线
 * 必须单调、不过冲，首尾精确落在 0 / 1，否则 gsap 收尾时会看到一次「回弹」。
 */
import { describe, expect, it } from 'vitest'
import { criticallyDampedEase } from './effort-spring'

describe('criticallyDampedEase', () => {
  const ease = criticallyDampedEase(400, 0.6)

  it('首尾精确落在 0 / 1', () => {
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(-0.5)).toBe(0)
    expect(ease(1.5)).toBe(1)
  })

  it('全程单调递增且不过冲', () => {
    let previous = 0
    for (let step = 1; step <= 200; step += 1) {
      const value = ease(step / 200)
      expect(value).toBeGreaterThanOrEqual(previous)
      expect(value).toBeLessThanOrEqual(1)
      previous = value
    }
  })

  it('前半程就把大部分路走完（「停住了」要一眼看出来）', () => {
    expect(ease(0.5)).toBeGreaterThan(0.95)
  })
})