/**
 * 客户端根（安卓壳）。
 *
 * 与 `apps/web` 的那一份**故意不同**：
 *
 * 1. **不注册 Service Worker**。壳里的外壳资源来自 APK 自己的 `www`（`dist` 打进去的），
 *    更新由「装新 APK」负责；SW 只会把旧外壳缓存住 —— 用户升级后仍看到旧界面，且排查时
 *    「代码明明改了页面还是旧的」，与 dev 下那条已知坑同源。web 端要 SW 是为了「服务端
 *    短暂不可达时外壳还能打开」，安卓壳没有这个需求（外壳本来就在本地）。
 * 2. **状态栏图标颜色跟着应用主题走**（见下面 `useStatusBarIconStyle`）。
 *
 * 其余（`App` 那棵树）与 web / desktop 完全共用。
 */
import { useEffect } from 'react'
import { StatusBar, Style } from '@capacitor/status-bar'
import { useThemeColor } from '@fizz/agent-kit/shared/hooks/useTheme'
import { App } from '@/app/App'
import { useAndroidAppResume, useAndroidBackButton } from '@/app/android-back'
import { useBootSplash } from '@/app/boot-splash'
import { scheduleSilentAppUpdateCheck } from '@/update/mobile-update'
import { RuntimeGate } from '@/runtime/RuntimeGate'

/**
 * 状态栏图标（时间 / 电量 / 信号）用深色还是浅色。
 *
 * edge-to-edge 之后状态栏是透明的，图标颜色由 `isAppearanceLightStatusBars` 决定，而系统
 * 只按**它自己的**深色模式设，不认我们存在 `localStorage` 里的主题。于是「应用暗色 + 系统
 * 亮色）时图标是黑的，压在 `bg-background` 上根本看不见。
 *
 * `Style.Dark` 是 Capacitor 的命名习惯：**给深色背景用的样式**，即浅色图标。
 *
 * ⚠️ 插件对象是 Capacitor 的 Proxy（任何属性都返回函数），只能 `await` 它的方法，
 * 不能 `await` 对象本身 —— 否则原生侧会收到 `StatusBar.then()` 并报未实现。
 */
function useStatusBarIconStyle(): void {
  useEffect(() => {
    const apply = (): void => {
      const dark = document.documentElement.classList.contains('dark')
      void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {
        /* 插件未就绪 / 老系统不支持：保持系统默认，不值得报错 */
      })
    }

    apply()
    // 主题切换只改 `<html class="dark">`（见 `useTheme`），没有事件可订阅，只能观察
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
}

export function ClientRoot() {
  // 首屏启动屏（index.html 里的静态层）在 React 画出第一帧后退场，见 boot-splash.ts
  useBootSplash()
  useStatusBarIconStyle()
  // 「已安装的 PWA」（浏览器访问 `/m` 后安装）里，系统栏配色由 <meta name="theme-color"> 决定，
  // 这里让它跟着主题走（Capacitor 壳里这条栏是透明的、无影响）。
  useThemeColor()
  /*
   * 安卓返回手势：整个 App 只在这里装一次（为什么必须接管、按什么顺序退，见
   * `android-back.ts` 的文件头）。挂在根而不是 `AppShell` 上 —— 未连接时的
   * `ConnectGate` 也要能靠返回键回桌面。
   */
  useAndroidBackButton()
  // 从后台回来时重建状态 WS（切后台久了连接会半死，界面看起来像「暂停」）
  useAndroidAppResume()
  // 静默检查新版本（只在 APK 里生效：首查延迟 8s，之后每 6h / 回前台补查；失败无声）
  useEffect(() => {
    scheduleSilentAppUpdateCheck()
  }, [])
  return <RuntimeGate><App /></RuntimeGate>
}
