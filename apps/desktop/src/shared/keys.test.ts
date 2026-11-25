/**
 * 防回归：F11 全屏判定必须只吃「无修饰键的 keyDown」。
 *
 * 主进程 `before-input-event` 直接拿它做开关。若把 keyUp / autoRepeat 放进来，
 * 长按 F11 会在全屏里反复进出；若放过修饰键，Ctrl+F11 这类组合键会被误吞。
 */
import { describe, expect, it } from 'vitest'
import { isToggleFullScreenKey, isViewMenuKey } from './keys'

const f11 = { type: 'keyDown', key: 'F11' } as const

describe('isToggleFullScreenKey', () => {
  it('无修饰键的 F11 keyDown 返回 true', () => {
    expect(isToggleFullScreenKey(f11)).toBe(true)
  })

  it('小写 f11 同样命中', () => {
    expect(isToggleFullScreenKey({ ...f11, key: 'f11' })).toBe(true)
  })

  it('keyUp 不触发（否则一次按键切两次）', () => {
    expect(isToggleFullScreenKey({ ...f11, type: 'keyUp' })).toBe(false)
  })

  it('按住不放的自动重复不触发', () => {
    expect(isToggleFullScreenKey({ ...f11, isAutoRepeat: true })).toBe(false)
  })

  it('带修饰键的 F11 不触发', () => {
    for (const modifier of ['control', 'meta', 'alt', 'shift'] as const) {
      expect(isToggleFullScreenKey({ ...f11, [modifier]: true })).toBe(false)
    }
  })

  it('其它功能键不触发', () => {
    expect(isToggleFullScreenKey({ ...f11, key: 'F12' })).toBe(false)
    expect(isToggleFullScreenKey({ ...f11, key: 'Escape' })).toBe(false)
  })
})

/**
 * 防回归：`视图(V)` 的 Alt+V 只认「Alt + V 的 keyDown」。
 *
 * 放过多余修饰键会和 Ctrl+Alt+V 之类的组合撞车；放过 keyUp / 重复会把菜单
 * 开一下又关掉。macOS 不绑这条（Option+V 要用于输入 √），由调用方跳过。
 */
describe('isViewMenuKey', () => {
  const altV = { type: 'keyDown', key: 'v', alt: true } as const

  it('Alt+V 命中（大小写都认）', () => {
    expect(isViewMenuKey(altV)).toBe(true)
    expect(isViewMenuKey({ ...altV, key: 'V' })).toBe(true)
  })

  it('没按 Alt 不命中', () => {
    expect(isViewMenuKey({ ...altV, alt: false })).toBe(false)
  })

  it('带其它修饰键不命中', () => {
    for (const modifier of ['control', 'meta', 'shift'] as const) {
      expect(isViewMenuKey({ ...altV, [modifier]: true })).toBe(false)
    }
  })

  it('keyUp / 自动重复不命中', () => {
    expect(isViewMenuKey({ ...altV, type: 'keyUp' })).toBe(false)
    expect(isViewMenuKey({ ...altV, isAutoRepeat: true })).toBe(false)
  })

  it('Alt+其它字母不命中', () => {
    expect(isViewMenuKey({ ...altV, key: 'f' })).toBe(false)
  })
})
