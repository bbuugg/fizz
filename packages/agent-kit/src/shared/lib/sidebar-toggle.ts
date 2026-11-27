/**
 * 「打开 / 关闭侧边栏」该写**哪一份状态**——按形态判定。
 *
 * ## 为什么需要这一层
 *
 * 侧栏有两份互不相干的状态，各自管一种形态：
 * - `sidebar-collapsed.ts` 的**折叠偏好**：桌面 / web 宽屏下侧栏是占位的一列，收起来 = 0 宽；
 * - `mobile-sidebar.ts` 的**抽屉开关**：窄屏（`<768px`，含把桌面窗口缩到手机宽度）下侧栏是
 *   覆盖抽屉，竖条与它同进同出。
 *
 * 折叠偏好在窄屏**完全无效**（`AppShell` 里 `sidebarHidden` 在 `isMobile` 时恒为 false、
 * 侧栏容器宽度也恒为 0），所以侧栏快捷键动作必须按形态选目标 ——
 * 早先它无条件写折叠偏好，症状就是用户报的「缩到手机宽度后快捷键切不动侧栏」：
 * 按键确实被吃掉了、状态也确实翻了，界面上什么都不动。
 *
 * ## 为什么单独抽成纯函数
 *
 * 判断本身只有三行，但它**曾经写错过一次**，而且错法没有编译期信号（两份状态都合法）。
 * 抽出来就能用单测钉住（见 `sidebar-toggle.test.ts`），组件那边只剩「按结论落一次副作用」。
 */

/** 一次「切换侧栏」要动谁 */
export type SidebarToggleTarget =
  /** 手机形态：写抽屉开关（`setMobileSidebarOpen`） */
  | 'drawer'
  /** 桌面 / 宽屏：写折叠偏好（`setSidebarCollapsed`） */
  | 'collapsed'
  /** 当前功能区没有侧栏，且是手机形态：不写任何状态（开了也只是平白盖一层遮罩） */
  | 'none'

/**
 * @param isMobile `useIsMobile()` 的结果（`<768px` 为真）
 * @param hasSidebar 当前功能区有没有侧栏（`activity.sidebar` 非空）
 *
 * ⚠️ 桌面形态**不看 `hasSidebar`**：折叠偏好是持久化的用户设置，切功能区时照样该生效
 * （没有侧栏的功能区按下它只是悄悄改偏好，与从前一致）。手机形态则必须看 —— 抽屉是
 * 一次性的开合，没有侧栏还打开只会盖出一层空遮罩。
 */
export function resolveSidebarToggleTarget(input: {
  isMobile: boolean
  hasSidebar: boolean
}): SidebarToggleTarget {
  if (!input.isMobile) return 'collapsed'
  return input.hasSidebar ? 'drawer' : 'none'
}
