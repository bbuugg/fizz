/**
 * 系统「减少动态效果」（`prefers-reduced-motion: reduce`）。
 *
 * 边框流光 / 弹簧 / 逐字入场这类**持续在动**的东西，开启后应当停掉 —— 但别把状态本身
 * 一起藏了：收音、拖拽、「后台还有活在跑」这些仍然需要可见反馈，所以调用方一律退成
 * 一圈**静态**内描边（见 `composer.tsx` 的输入卡片、`ComposerDock.tsx` 的入口药丸）。
 *
 * 用订阅（`useSyncExternalStore`）而不是渲染时读一次：系统设置可以随时改，改完界面
 * 要跟得上。`getServerSnapshot` 给 false —— 服务端没有这个媒体查询，按「允许动」渲染，
 * 客户端首帧再纠正。
 */
import { useSyncExternalStore } from 'react'

/** 判定字符串。**导出**是为了让非 React 的模块（gsap 补间、canvas 循环）用同一条查询。 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(REDUCED_MOTION_QUERY)
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false
  )
}
