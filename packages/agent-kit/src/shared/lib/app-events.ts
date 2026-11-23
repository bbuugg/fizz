/**
 * 跨组件的全局事件名（用 `window` CustomEvent 在「快捷键分发」与「输入框 Composer」
 * 之间传信号 —— 两者不在同一棵可直接传 props 的树里，事件是最省事的解耦方式）。
 *
 * - `voiceStart` / `voiceStop`：按住说话语音快捷键 —— app-shell 监听到快捷键后向
 *   Composer 广播，Composer 把信号转成对 `useVoiceInput` 的 start / stop 调用。
 *   `detail` 带**焦点组正在显示的那个标签 key**（见 `VoiceShortcutDetail`）：分屏时
 *   两栏各有一个 Composer 都挂着监听，不带这一项就会两边同时开麦。
 * - `uiAction`：项目管理工具的 UI 动作（见 `lib/tool-actions.ts`）—— 会话 / 助手切片
 *   收到工具结果帧后广播，app-shell 订阅执行（切工作区 + 跳转）。
 * - `titleAction`：自定义标题栏（desktop 宿主，另一棵 React 树）上的功能按钮 ——
 *   标题栏与 `AppShell` 不在同一棵树里、拿不到它的回调，所以按钮按下时广播一个
 *   `AgentShortcutAction`（复用快捷键那套动作分发），由 app-shell 接住执行。
 */
export const APP_EVENTS = {
  /** 开启语音输入（快捷键按下）；detail: VoiceShortcutDetail */
  voiceStart: 'fizz:voice-start',
  /** 取消语音输入（快捷键松开）：停止收音并把焦点交回输入框；detail: VoiceShortcutDetail */
  voiceStop: 'fizz:voice-stop',
  /** 项目管理工具触发的 UI 动作（detail: ProjectUiAction） */
  uiAction: 'fizz:ui-action',
  /** 自定义标题栏的功能按钮（detail: AgentShortcutAction） */
  titleAction: 'fizz:title-action'
} as const

/**
 * `voiceStart` / `voiceStop` 的 `detail`。
 *
 * `tabKey` = 焦点组（`activeGroupId`）当时正在显示的那个标签 key（`activeTabKey()`）：
 * 会话标签的 key 就是会话 id，空态是 `__new__`，终端等工具标签各是前缀 key。
 * 只有自己那一栏的 Composer 该响应 —— 分屏时两栏同时挂载，没有这一项会两边一起开麦。
 */
export interface VoiceShortcutDetail {
  tabKey: string | null
}

/**
 * 标题栏按钮广播一个动作给 app-shell 执行。
 *
 * 参数故意用 `string` 而不是 `AgentShortcutAction`：desktop 的 `TitleBar` 是
 * 独立的一棵 React 树，不应为了一个动作名把 shortcuts 模块（及其 `AgentShortcutConfig`
 * 等一堆类型）拖进自己的产物 —— 反向依赖不值得。真正的校验在收方（app-shell 的
 * `runShortcutAction` 用 switch 穷举，传错名字自然什么都不做）。
 */
export function dispatchTitleAction(action: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(APP_EVENTS.titleAction, { detail: action }))
}
