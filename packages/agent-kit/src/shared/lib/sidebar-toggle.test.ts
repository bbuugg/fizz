/**
 * `resolveSidebarToggleTarget` 的判据。
 *
 * 防的回归：**Alt+1（打开 / 关闭侧边栏）在手机宽度下什么都不做**。
 * 侧栏有两份状态（桌面 = 折叠偏好 `sidebar-collapsed`，窄屏 = 抽屉 `mobile-sidebar`），
 * 早先快捷键无条件写前者，而前者在 `isMobile` 时对界面毫无影响 —— 按键被吃掉、
 * 状态翻了、屏幕不动，用户看到的就是「快捷键失效」。
 */
import { describe, expect, it } from 'vitest'
import { resolveSidebarToggleTarget } from './sidebar-toggle'

describe('切换侧栏：按形态选目标', () => {
  it('桌面 / 宽屏 → 折叠偏好', () => {
    expect(resolveSidebarToggleTarget({ isMobile: false, hasSidebar: true })).toBe('collapsed')
  })

  it('桌面形态不看 hasSidebar：折叠偏好是持久化设置，照样该翻', () => {
    expect(resolveSidebarToggleTarget({ isMobile: false, hasSidebar: false })).toBe('collapsed')
  })

  it('手机形态 → 抽屉开关（这条就是那个 bug）', () => {
    expect(resolveSidebarToggleTarget({ isMobile: true, hasSidebar: true })).toBe('drawer')
  })

  it('手机形态 + 当前功能区没有侧栏 → 什么都不写', () => {
    expect(resolveSidebarToggleTarget({ isMobile: true, hasSidebar: false })).toBe('none')
  })
})
