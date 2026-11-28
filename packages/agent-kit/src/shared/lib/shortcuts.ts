/**
 * Agent 应用的应用内快捷键（从根应用 `src/shared/shortcuts.ts` 迁移）。
 *
 * 与根应用同一套机制：渲染端在 window 上监听 keydown 自己匹配（不走 Electron
 * globalShortcut，不占用系统级热键），配置存 localStorage（两个宿主都有）。
 *
 * 动作集是 agent 场景的子集 —— 根应用的「新建终端 / SSH」等不适用；
 * 这里的终端 / 文件 / 会话都绑定当前工作区。
 */
import { t } from '@fizz/i18n'
import { useEffect, useState } from 'react'

export type AgentShortcutAction =
  | 'open-command-palette'
  | 'open-settings'
  | 'toggle-sidebar-alt'
  | 'toggle-terminal'
  | 'toggle-files'
  | 'toggle-git'
  | 'toggle-assistant'
  | 'open-workspace-in-file-manager'
  | 'git-push'
  | 'toggle-theme'
  | 'new-conversation'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'voice-input'

export interface AgentShortcutConfig {
  action: AgentShortcutAction
  /** Electron accelerator 风格；空字符串 = 该动作禁用 */
  accelerator: string
}

/** 每个快捷键动作的可读元信息 */
export interface AgentShortcutMeta {
  action: AgentShortcutAction
  label: string
  /** 缺省 accelerator */
  defaultAccelerator: string
}

/** 可配置的动作清单（新增动作在这里登记，并在 AgentApp 的分发处接线） */
export const AGENT_SHORTCUT_ACTIONS: AgentShortcutMeta[] = [
  { action: 'open-command-palette', label: '打开命令面板', defaultAccelerator: 'CommandOrControl+Shift+P' },
  { action: 'open-settings', label: '打开设置', defaultAccelerator: 'CommandOrControl+Alt+S' },
  // desktop 标题栏最左那颗按钮也走这个动作（跨树广播）。
  // 侧边栏快捷键统一走应用配置，UI 原语不再另挂监听；action 名保持不变以沿用自定义配置。
  { action: 'toggle-sidebar-alt', label: '打开 / 关闭侧边栏', defaultAccelerator: 'CommandOrControl+B' },
  { action: 'toggle-terminal', label: '打开 / 关闭终端', defaultAccelerator: 'CommandOrControl+Alt+T' },
  { action: 'toggle-files', label: '打开 / 关闭工作区文件', defaultAccelerator: 'CommandOrControl+Alt+F' },
  { action: 'toggle-git', label: '打开 / 关闭源代码管理', defaultAccelerator: 'CommandOrControl+Alt+G' },
  { action: 'toggle-assistant', label: '打开 / 关闭 AI 助手', defaultAccelerator: 'CommandOrControl+Alt+H' },
  { action: 'open-workspace-in-file-manager', label: '用文件管理器打开工作区', defaultAccelerator: 'CommandOrControl+Shift+E' },
  // 面板级动作：不在 app-shell 的全局分发里（见 PANEL_SCOPED_SHORTCUT_ACTIONS），
  // 由源代码管理面板自己在可见时挂 window 监听 —— 所以焦点在面板里任何地方都生效。
  { action: 'git-push', label: '推送（源代码管理）', defaultAccelerator: 'CommandOrControl+Shift+Enter' },
  { action: 'toggle-theme', label: '切换亮 / 暗主题', defaultAccelerator: 'CommandOrControl+Alt+L' },
  { action: 'new-conversation', label: '新建会话', defaultAccelerator: 'CommandOrControl+Alt+N' },
  /*
   * 关掉「当前组」里正看着的那一个标签 —— 与点标签行尾那颗 × 完全等价（含把「当前会话」
   * 对齐到顺移后的活动标签）。
   *
   * ⚠️ 是**面板级**动作（见 `PANEL_SCOPED_SHORTCUT_ACTIONS`）：由 `PanelView` 自己挂的
   * window 监听处理，不进 app-shell 的全局分发 —— 面板没挂出来时这条按键完全不被应用
   * 占用，照常交给别人（浏览器 / 系统），不搞「吞掉按键又什么都不做」。
   *
   * ⚠️ 浏览器里 `Ctrl/Cmd + W` 是**保留键**（关掉当前网页标签页），页面在 Chromium 里
   * 根本收不到这个组合 —— 所以它在 web 端实际上生效不了，只在 Electron 桌面端有意义。
   * 这是浏览器层面的限制，不是实现漏了；想覆盖的话用设置里的快捷键录制改成别的组合。
   */
  { action: 'close-tab', label: '关闭当前标签', defaultAccelerator: 'CommandOrControl+W' },
  // 标签循环：只在当前焦点组里转，到头回绕。
  // ⚠️ 浏览器把 Ctrl/Cmd+Tab 当保留键（切浏览器标签页），web 端页面收不到；
  // 桌面端（Electron）可用，想换组合去设置里录制。
  { action: 'next-tab', label: '切换到下一个标签', defaultAccelerator: 'CommandOrControl+Tab' },
  { action: 'prev-tab', label: '切换到上一个标签', defaultAccelerator: 'CommandOrControl+Shift+Tab' },
  // 「按住说话」：按下开启麦克风、松开取消（松手时 Composer 会停止收音并聚焦输入框）。
  // 默认 Alt+V，可在设置里改；带 Alt 修饰，满足 isUsableAccelerator 的约束。
  { action: 'voice-input', label: '语音输入（按住说话）', defaultAccelerator: 'Alt+V' }
]

/** 缺省快捷键（首次使用 / 恢复默认时） */
export const DEFAULT_AGENT_SHORTCUTS: AgentShortcutConfig[] = AGENT_SHORTCUT_ACTIONS.map((a) => ({
  action: a.action,
  accelerator: a.defaultAccelerator
}))

/**
 * 「面板级」动作：只在对应面板**可见**时才有意义，因此不进 app-shell 的全局分发器。
 *
 * 全局分发器挂在 window 的**捕获阶段**、命中后 `preventDefault + stopPropagation`
 * （见 app-shell 的 onKey）；遇到这里的动作它直接放行、不拦截，交给面板自己挂的
 * window 监听去匹配（源代码管理面板的推送、主区域标签面板的「关闭当前标签」）。
 * 好处：面板没打开时这组按键完全不被应用占用，照常交给别的处理方。
 */
export const PANEL_SCOPED_SHORTCUT_ACTIONS: ReadonlySet<AgentShortcutAction> = new Set([
  'git-push',
  'close-tab'
])

/**
 * 设置页的快捷键**录制中**（模块级标记，两个 React 树都读得到）。
 *
 * ⚠️ 面板级动作的监听器要读它：录制时按下的按键既是「要录下来的那个」，也会被面板监听
 * 撞上 —— 不拦这一下的话，在设置里录制 `Ctrl+W` 会**顺手把标签也关掉**。全局分发器
 * 里有 `shortcutRecordingRef` 管这事，但它是 app-shell 的局部 ref，面板拿不到。
 */
let recordingShortcut = false

/** 录制状态变了由 app-shell 的 `onShortcutRecordingChange` 调进来 */
export function setShortcutRecording(recording: boolean): void {
  recordingShortcut = recording
}

/** 当前是否正在录制快捷键（面板级监听器据此让路） */
export function isShortcutRecording(): boolean {
  return recordingShortcut
}

const STORAGE_KEY = 'fizz.agent.shortcuts'

interface ShortcutStorage {
  version: number
  shortcuts: Partial<AgentShortcutConfig>[]
}

/** 从 localStorage 读取配置；损坏 / 缺动作时按缺省补齐 */
export function loadShortcuts(): AgentShortcutConfig[] {
  const fallback = () => DEFAULT_AGENT_SHORTCUTS.map((s) => ({ ...s }))
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback()
    const stored = JSON.parse(raw) as Partial<ShortcutStorage> | Partial<AgentShortcutConfig>[] | null
    const parsed = Array.isArray(stored) ? stored : stored?.shortcuts
    if (!Array.isArray(parsed)) return fallback()
    // 以缺省清单为准（新增动作能自动补上），只采用用户存过的 accelerator。
    const shortcuts = DEFAULT_AGENT_SHORTCUTS.map((def) => {
      const found = parsed.find((s) => s?.action === def.action)
      const accelerator =
        typeof found?.accelerator === 'string' ? found.accelerator : def.accelerator
      return { action: def.action, accelerator }
    })
    return shortcuts
  } catch {
    return fallback()
  }
}

export function saveShortcuts(shortcuts: AgentShortcutConfig[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, shortcuts }))
  } catch {
    // 存不进去也不致命：本次会话内仍生效
  }
}

// ---------- 运行期共享的配置（订阅式外部存储） ----------
//
// 配置原来是 app-shell 的一个 useState，只有它自己拿得到。面板级快捷键（推送）要按
// 用户改过的组合匹配，所以这里用一个极小的订阅式存储把配置共享出去：
// `setShortcuts` 写内存 + 落盘 + 通知订阅者，`useShortcuts` 让组件跟着重渲染。
// app-shell（全局分发 + 设置弹窗）与面板（GitPanel）读的都是这一份。

let currentShortcuts: AgentShortcutConfig[] | null = null
const shortcutSubscribers = new Set<() => void>()

/** 当前配置快照（首次访问时惰性加载；引用稳定，可安全用于 useSyncExternalStore / useState） */
export function getShortcutsSnapshot(): AgentShortcutConfig[] {
  if (!currentShortcuts) currentShortcuts = loadShortcuts()
  return currentShortcuts
}

export function subscribeShortcuts(listener: () => void): () => void {
  shortcutSubscribers.add(listener)
  return () => {
    shortcutSubscribers.delete(listener)
  }
}

/** 写入并落盘，随后通知所有订阅者（设置页保存走这里） */
export function setShortcuts(next: AgentShortcutConfig[]): void {
  currentShortcuts = next
  saveShortcuts(next)
  for (const listener of shortcutSubscribers) listener()
}

/** 组件里读当前配置；设置页改了之后会实时跟着更新 */
export function useShortcuts(): AgentShortcutConfig[] {
  const [snapshot, setSnapshot] = useState<AgentShortcutConfig[]>(getShortcutsSnapshot)
  useEffect(() => subscribeShortcuts(() => setSnapshot(getShortcutsSnapshot())), [])
  return snapshot
}

// 别的窗口改了快捷键：`storage` 事件只在**别的文档**里触发，正是 desktop「设置窗口」
// 与主窗口、以及两个标签页之间的关系。不接这一下的话，主窗口的全局分发器会一直用旧组合
// （用户改完快捷键还以为没生效，重启才认）。
// 内存快照置空 → 下一次 `getShortcutsSnapshot()` 从 localStorage 重读。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== STORAGE_KEY) return
    currentShortcuts = null
    for (const listener of shortcutSubscribers) listener()
  })
}

export function shortcutLabel(action: AgentShortcutAction): string {
  const label = AGENT_SHORTCUT_ACTIONS.find((a) => a.action === action)?.label
  return label ? t(label) : action
}

// ---------- 展示与匹配（逻辑与根应用一致，保证两边写出的配置语义相同） ----------

/** mac 判定：渲染端拿不到 process.platform，用 navigator 判（macOS 的 UA 一定带 Mac） */
export function isMacPlatform(): boolean {
  return /mac/i.test(navigator.platform || navigator.userAgent)
}

/**
 * 把 Electron accelerator 转成当前平台可读的展示文本。
 * mac 用符号（⌘⌥⇧），Win/Linux 用文字（Ctrl+Alt+Shift）。
 */
export function formatShortcutForPlatform(accelerator: string, platform: string): string {
  if (!accelerator) return ''
  const isMac = platform === 'darwin'
  const parts = accelerator.split('+').map((p) => p.trim())
  const mapped = parts.map((p) => {
    switch (p) {
      case 'CommandOrControl':
      case 'CmdOrCtrl':
        return isMac ? '⌘' : 'Ctrl'
      case 'Cmd':
      case 'Command':
        return '⌘'
      case 'Ctrl':
        return isMac ? '⌃' : 'Ctrl'
      case 'Alt':
        return isMac ? '⌥' : 'Alt'
      case 'Option':
        return '⌥'
      case 'Shift':
        return isMac ? '⇧' : 'Shift'
      case 'Super':
        return isMac ? '⌃' : 'Win'
      default:
        return p
    }
  })
  return isMac ? mapped.join('') : mapped.join('+')
}

/** 按当前平台格式化（内部判平台） */
export function formatShortcut(accelerator: string): string {
  return formatShortcutForPlatform(accelerator, isMacPlatform() ? 'darwin' : 'other')
}

/**
 * 找出存在冲突（相同非空 accelerator 被多个动作占用）的动作集合。
 */
export function findShortcutConflicts(shortcuts: AgentShortcutConfig[]): Set<AgentShortcutAction> {
  const count = new Map<string, number>()
  for (const s of shortcuts) {
    if (!s.accelerator) continue
    const key = normalizeAccelerator(s.accelerator)
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  const conflicted = new Set<AgentShortcutAction>()
  for (const s of shortcuts) {
    if (s.accelerator && (count.get(normalizeAccelerator(s.accelerator)) ?? 0) > 1) {
      conflicted.add(s.action)
    }
  }
  return conflicted
}

/** 参与匹配的按键事件（结构化类型，不依赖 DOM 的 KeyboardEvent） */
export interface KeyComboEvent {
  /** 物理键位，如 KeyA / Digit1 / F5 / ArrowUp */
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** 把 `KeyboardEvent.code` 转成 accelerator 里的键名（认不出返回 null） */
export function keyFromEventCode(code: string): string | null {
  // 部分输入法 / 虚拟键盘 / 合成事件没有 code（运行时可能是 undefined），直接跳过
  if (!code) return null
  let m: RegExpMatchArray | null
  if ((m = code.match(/^Key([A-Z])$/))) return m[1]
  if ((m = code.match(/^Digit([0-9])$/))) return m[1]
  if ((m = code.match(/^Numpad([0-9])$/))) return m[1]
  if (/^F([0-9]{1,2})$/.test(code)) return code
  const map: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    // 符号 / 标点键：应用内快捷键常绑这类键（如终端的 Ctrl+Shift+`），
    // 认不出就回退到原始 code（保证录制能捕获用户按下的键，而不是静默丢事件）
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/'
  }
  return map[code] ?? null
}

/** 把一次按键事件转成 accelerator（跨平台用 CommandOrControl）；认不出返回 null */
export function acceleratorFromEvent(e: KeyComboEvent): string | null {
  const mods: string[] = []
  if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const key = keyFromEventCode(e.code)
  if (!key) return null
  return [...mods, key].join('+')
}

/**
 * 把 accelerator 归一化成可比较的规范形式：`mod+alt+shift+键`。
 * `CommandOrControl` 与 `Ctrl`/`Cmd` 统一成 `mod`：本应用只生成 `CommandOrControl`，
 * 这样 Mac 上的 ⌘ 与手写配置里的 Ctrl 才能落到同一个槽位。
 */
export function normalizeAccelerator(accelerator: string): string {
  const mods = new Set<string>()
  let key = ''
  for (const raw of accelerator.split('+')) {
    const p = raw.trim()
    if (!p) continue
    switch (p.toLowerCase()) {
      case 'commandorcontrol':
      case 'cmdorctrl':
      case 'command':
      case 'cmd':
      case 'control':
      case 'ctrl':
      case 'meta':
      case 'super':
        mods.add('mod')
        break
      case 'alt':
      case 'option':
        mods.add('alt')
        break
      case 'shift':
        mods.add('shift')
        break
      default:
        key = p.toUpperCase()
    }
  }
  const parts: string[] = []
  if (mods.has('mod')) parts.push('mod')
  if (mods.has('alt')) parts.push('alt')
  if (mods.has('shift')) parts.push('shift')
  if (key) parts.push(key)
  return parts.join('+')
}

/**
 * 这个 accelerator 是否适合作为应用内快捷键：
 * 纯字母 / 数字组合（既没有 Ctrl/Alt，也不是功能键）不能用 ——
 * 应用内匹配是「命中就吃掉这个按键」，绑一个裸字母会让它在输入框里彻底打不出来。
 * 空字符串表示「禁用」，视为合法。
 */
export function isUsableAccelerator(accelerator: string): boolean {
  if (!accelerator.trim()) return true
  const parts = normalizeAccelerator(accelerator).split('+')
  const key = parts[parts.length - 1] ?? ''
  // 功能键可以不带修饰键（F5 之类）；其余必须带 Ctrl/Alt
  if (/^F([0-9]{1,2})$/.test(key)) return true
  return parts.includes('mod') || parts.includes('alt')
}

/** 找出某个按键事件命中的快捷键配置（未命中返回 null） */
export function findShortcutByEvent(
  shortcuts: AgentShortcutConfig[],
  e: KeyComboEvent
): AgentShortcutConfig | null {
  const acc = acceleratorFromEvent(e)
  if (!acc) return null
  const target = normalizeAccelerator(acc)
  return (
    shortcuts.find(
      (s) =>
        s.accelerator &&
        isUsableAccelerator(s.accelerator) &&
        normalizeAccelerator(s.accelerator) === target
    ) ?? null
  )
}
