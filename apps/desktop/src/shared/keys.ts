/**
 * 窗口级快捷键的纯判定（主进程 `before-input-event` 用）。
 *
 * 为什么放在 shared：主进程要按它拦键，单测又要能直接跑（node 环境、不起 Electron），
 * 所以只留一个纯函数，不碰任何 Electron 类型。
 *
 * F11 必须在**主进程**拦：终端（xterm）这类自己吞键的区域拿到焦点后，渲染端的
 * 键盘监听收不到，只有浏览器进程的 `before-input-event` 一定先看到。
 */

/** `before-input-event`（Electron Input）与 DOM `KeyboardEvent` 的公共子集 */
export interface KeyInput {
  type: string
  key: string
  control?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
  isAutoRepeat?: boolean
}

/**
 * 是不是「切换全屏」的 F11。
 *
 * - 只认 keyDown：keyUp 再切一次会把状态原样翻回去；
 * - 按住不放的自动重复不算：否则长按 F11 会在全屏里反复进出；
 * - 带任何修饰键都不算：Ctrl+F11 / Shift+F11 在别处另有含义，别抢。
 */
export function isToggleFullScreenKey(input: KeyInput): boolean {
  if (input.type.toLowerCase() !== 'keydown' || input.isAutoRepeat) return false
  if (input.control || input.meta || input.alt || input.shift) return false
  return input.key.toLowerCase() === 'f11'
}

/**
 * 是不是「打开视图菜单」的 Alt+V（与 Windows 菜单的 `视图(V)` 助记符对应）。
 *
 * 与 F11 不同，这条在**渲染端**捕获阶段拦：菜单是渲染端的状态，走一趟主进程反而
 * 多两条通道。macOS 不绑（Option+V 在输入框里要打 √），调用方按 IS_MAC 跳过。
 *
 * ⚠️ 桌面端的「语音输入」默认也是 Alt+V（`shared/lib/shortcuts.ts`），但它的
 * `capabilities.voice` 是 false、全局分发会直接放行，所以这里不会撞。
 */
export function isViewMenuKey(input: KeyInput): boolean {
  if (input.type.toLowerCase() !== 'keydown' || input.isAutoRepeat) return false
  if (!input.alt || input.control || input.meta || input.shift) return false
  return input.key.toLowerCase() === 'v'
}
