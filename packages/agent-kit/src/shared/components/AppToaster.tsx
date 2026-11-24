/**
 * 全局 toast 挂载点：web / desktop / 手机三端的**位置只在这里定义**。
 *
 * - web / desktop：固定右下角；
 * - 手机壳（`safeArea`）：固定**顶部居中** —— 软键盘弹出、底部手势导航条都不会盖住提示。
 *
 * git 面板那条顶中提示是 sonner 的**逐条** `position` 覆盖
 * （见 `features/git/GitPanel.tsx` 的 `GIT_TOAST`），不经过这里。
 *
 * `safeArea` 只有手机壳（Capacitor）传：toast 是 portal 到 `document.body` 的，不在外壳
 * 那条带 `--safe-area-*` 内边距的容器里 —— 不补的话顶部 toast 会压进状态栏、
 * 右下角的 toast 会压住手势导航条。变量由 SystemBars 注入 `<html>`，web / 桌面 fallback 0。
 *
 * 边距在安全区上**叠加** sonner 的默认值（底部：宽视口 24px / 窄视口 16px）。一旦传了
 * `offset` / `mobileOffset`，sonner 就不再替你填另一侧，所以四条都得写全；升级 sonner
 * 时回来对一眼那两个默认值。顶部沿用 0.5rem —— 手机顶部提示与 git 那条顶中 toast 同一档。
 */
import { Toaster } from '@fizz/ui/sonner'

const SAFE_AREA_OFFSET = {
  top: 'calc(var(--safe-area-inset-top, 0px) + 0.5rem)',
  bottom: 'calc(var(--safe-area-inset-bottom, 0px) + 24px)'
}

const SAFE_AREA_MOBILE_OFFSET = {
  top: 'calc(var(--safe-area-inset-top, 0px) + 0.5rem)',
  bottom: 'calc(var(--safe-area-inset-bottom, 0px) + 16px)'
}

export function AppToaster({
  theme,
  safeArea = false
}: {
  theme: 'light' | 'dark'
  safeArea?: boolean
}) {
  if (!safeArea) return <Toaster theme={theme} position="bottom-right" />
  return (
    <Toaster
      theme={theme}
      position="top-center"
      offset={SAFE_AREA_OFFSET}
      mobileOffset={SAFE_AREA_MOBILE_OFFSET}
    />
  )
}
