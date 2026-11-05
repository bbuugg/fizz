/**
 * 设置面板的**标签页宿主**：把 `SettingsShell` 整块塞进主区域的一条标签，
 * 并按**标签容器宽度**在两栏 / 两级导航之间切换（窄面板里右侧表单不再被菜单挤扁）。
 *
 * 它是「设置」唯一的形态 —— 桌面端原先那个独立 BrowserWindow
 * （`apps/desktop/src/renderer/app/SettingsWindow.tsx`）已经退场，理由见
 * `shared/lib/panel-tabs.ts` 的 `settingsTabKey` 注释：两个渲染进程 = 两份模块级
 * store 单例，设置里改完主窗口不知道（插件图标、系统监控开关、子任务偏好都是这个病）。
 *
 * ## 为什么这里**不**包 AppProvider / TooltipProvider
 *
 * 标签内容本来就渲染在 `AppShell` 的 `AppProvider` 之内。再包一层不是「保险」，
 * 而是在同一个窗口里造第二份 store 单例 + 第二条 WS —— 正是要消灭的东西。独立窗口
 * 那个版本必须自己包（它没有外层），这里必须不包。
 *
 * ## 快捷键
 *
 * `useShortcuts()` 读的是模块级快照（`shared/lib/shortcuts.ts`），与 `AppShell` 里
 * 那个全局分发器**同一份**，所以设置里改完立刻生效，不需要跨窗口广播。录制态走
 * `setShortcutRecording()`：面板级监听器（推送 / 关标签）都读它，否则录制 `Ctrl+W`
 * 会顺手把当前标签关掉。
 *
 * ## 落到哪个分组
 *
 * 请求记在登记表的 `settingsTab` 上（见 `ToolTab.settingsTab`）。`openTab` 对已存在
 * 的 key 只做激活、不 emit，所以这里订阅登记表版本号重新读；再用 `key` 把外壳重挂
 * 一次 —— 与原 `SettingsWindow` 的 `key={`${tab}#${seq}`}` 是同一个手法。
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getAgentHost } from '@fizz/agent-client/host'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { settingsTabKey } from '@fizz/agent-kit/shared/lib/panel-tabs'
import {
  getToolTab,
  getToolTabsVersion,
  subscribeToolTabs
} from '@fizz/agent-kit/shared/lib/tool-tabs'
import {
  setShortcutRecording,
  setShortcuts,
  useShortcuts
} from '@fizz/agent-kit/shared/lib/shortcuts'
import { SettingsShell, settingsNavForm } from '@fizz/agent-kit/features/settings/SettingsShell'
import type { SettingsTabId } from '@fizz/agent-kit/features/settings/types'

/**
 * 两栏形态的**最小容器宽度**（不是视口宽度）。
 *
 * 低于它时左侧 `w-44` 菜单 + 间距已经吃掉太多，右侧表单只剩两三百像素；
 * 退成两级导航后，菜单与详情各自整宽，窄面板里也能正常填表。
 */
const TWO_COLUMN_MIN_WIDTH = 640

export function SettingsTabContent() {
  const { app } = useAppContext()
  const shortcuts = useShortcuts()
  // 登记表的版本号：`openSettingsTab(tab)` 就地改了表，`panel-store` 却不 emit
  useSyncExternalStore(subscribeToolTabs, getToolTabsVersion, getToolTabsVersion)

  const request = getToolTab(settingsTabKey())
  const initialTab = request?.settingsTab as SettingsTabId | undefined
  const platform = getAgentHost().platform
  /**
   * 响应式判据是**标签容器**的实际宽度，不是 `window`：设置标签可能在主区域里被拖窄
   * 或与别的面板分栏，窗口本身仍是宽的；按视口判会一直停两栏，右侧内容被挤成一条。
   * ResizeObserver 首帧回调在绘制前送达，窄容器不会先闪一帧两栏。
   */
  const [narrow, setNarrow] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < TWO_COLUMN_MIN_WIDTH)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const form = settingsNavForm(platform, narrow)

  // 标签关掉时若还停在「正在录制快捷键」，全局分发会一直被拦着（快捷键全哑）
  useEffect(() => () => setShortcutRecording(false), [])

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <SettingsShell
        // 换分组要把外壳重挂（`DesktopSettingsPanel` 的 `initialTab` 只吃首帧）；
        // 同分组连点两次靠 seq 区分，否则「模型齿轮」从别处再点一次不会有反应
        key={`${request?.settingsTab ?? 'general'}#${request?.settingsRequestSeq ?? 0}`}
        platform={platform}
        form={form}
        // 两栏形态要**定高**：它内部是 `min-h-0 flex-1` + `overflow-auto`，
        // 父级没确定高度的话右栏内容会把整个标签撑出可视区
        className={form === 'two-level' ? 'h-auto' : 'h-full'}
        initialTab={initialTab}
        app={app}
        shortcuts={shortcuts}
        onSaveShortcuts={setShortcuts}
        onShortcutRecordingChange={setShortcutRecording}
      />
    </div>
  )
}
