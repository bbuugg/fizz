/**
 * 终端底部那条**虚拟快捷键盘**（Esc / Ctrl / Tab / 方向键…）该不该出现。
 *
 * ## 为什么不能用视口宽度
 *
 * 这条键条存在的唯一理由是：**屏幕上的软键盘没有修饰键与功能键**。这跟窗口多宽毫无关系。
 * 早先的判据是 `useIsMobile()`（`max-width: 767px`），于是两种明显不该出现的场合都会冒出它：
 *
 * - **Chrome 扩展**：外壳整棵复用手机版（`apps/extension` 的 `@` 别名指向 `apps/mobile/src`），
 *   面板只有 400px 宽 → 判成「手机」，但那是台有实体键盘的桌面机器；
 * - **桌面浏览器把窗口拖窄**：同一个道理。
 *
 * 反过来还会漏：手机**横屏**时宽度超过 768px，该有的键条反而消失。
 *
 * 所以判据换成**输入能力**，与 `shared/components/PanelTab.tsx` 对 `hover: none` 的处理
 * 同一套思路（那里也写了「触屏笔记本既窄又有鼠标」，所以不用宽度）。
 *
 * ## 两个信号取「或」
 *
 * `(hover: none)`：设备不能悬停（手机 / 平板）。
 * `(pointer: coarse)`：**主指针**是手指（不是精确指针）。
 *
 * 为什么不取「与」：三星带 S Pen 的机型有个老毛病 —— 笔在范围内时媒体查询会报
 * `hover: hover` / `pointer: fine`（笔能悬停），手指仍是主输入。取「或」时 `pointer: coarse`
 * 还能兜住，取「与」会让那类手机直接丢掉键条。
 *
 * 触屏笔记本不受影响：主指针仍是触摸板 / 鼠标（`pointer: fine`），能悬停（`hover: hover`），
 * 两个条件都不成立。
 *
 * ## 宿主可以显式否定
 *
 * 能力判据的边界是「这台机器像不像触屏」。扩展是**桌面程序**，就算跑在触屏笔记本上也不该
 * 给终端塞一条手机键条（那台机器有实体键盘）。这类「宿主自己更清楚」的情况用
 * `setVirtualKeyBar(false)` 显式关掉 —— 与 `panel-store` 的 `setSingleTabMode` 同一套做法：
 * 模块级开关，各端各打包一份，只在启动时调一次。
 */
import { useSyncExternalStore } from 'react'

/** 只有手指可用（不能悬停，或主指针是手指）→ 软键盘是唯一输入 */
export const TOUCH_ONLY_QUERY = '(hover: none), (pointer: coarse)'

/**
 * 宿主的显式裁决：`null` = 没意见，按上面的能力判据自动定。
 * 是模块级变量而不是 Context —— 这份 hook 每个端各打包一份，它表达的是「这个端的形态」。
 * 必须在**首帧渲染前**设定（各端 `main.tsx` 里调用），运行期改变不会广播。
 */
let override: boolean | null = null

/** 显式打开 / 关闭虚拟键条（只应由宿主在启动时调一次；扩展用来关掉它）。传 `null` = 收回意见 */
export function setVirtualKeyBar(on: boolean | null): void {
  override = on
}

/** 读当前裁决（`null` = 走能力判据）。给单测与非 React 调用方用。 */
export function virtualKeyBarOverride(): boolean | null {
  return override
}

/**
 * 裁决的核心（纯函数，便于单测）：宿主有意见时听宿主的，否则听能力判据。
 * `touchOnly` 是媒体查询的结果，由调用方量好传进来。
 */
export function resolveVirtualKeyBar(touchOnly: boolean): boolean {
  return override ?? touchOnly
}

function matchesTouchOnly(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(TOUCH_ONLY_QUERY).matches
}

/**
 * 同一判据的**非 React 版本**：这台设备是不是只有手指可用（软键盘是唯一输入）。
 *
 * 给「要不要主动把焦点塞进终端」这类一次性判断用 —— 手机 / 平板上一 focus 就等于弹出
 * 软键盘，而用户往往是**刚收起键盘**才去点菜单的（见 `run-script-command`：一键执行脚本
 * 不抢焦点，别把用户主动收起的键盘招回来）。
 */
export function isTouchOnlyInput(): boolean {
  return matchesTouchOnly()
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const mql = window.matchMedia(TOUCH_ONLY_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot(): boolean {
  return resolveVirtualKeyBar(matchesTouchOnly())
}

/**
 * 是否显示终端底部的虚拟键条。
 *
 * `useSyncExternalStore` 而不是 `useState` + `useEffect`：媒体查询是外部数据源，首次渲染
 * 就要拿到真值（否则触屏上首帧不显示、第二帧才冒出来，终端高度跟着跳一下）。
 */
export function useVirtualKeyBar(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => override === true)
}
