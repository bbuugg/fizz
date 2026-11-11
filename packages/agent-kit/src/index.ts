/**
 * Fizz 领域组件包入口。
 *
 * 这里只放**零件**：消息渲染、会话列表、终端、文件树、流程画布、设置页……
 * **不放装配好的 `<App>`** —— 外壳（侧栏 + 主区域 + 活动栏怎么拼）属于各宿主自己的
 * `apps/<端>/src/(app|renderer/app)`（P4 之后每个端各写一份，原 `packages/agent-ui` 已删除）。
 *
 * 数据层（`@fizz/agent-client`）在它下面，界面原语（`@fizz/ui`）也在它下面；
 * 本包**不得**反向依赖 `agent-host` / `apps`（`check-boundaries` 的
 * `kit-no-upward` 会拦）。
 *
 * 下面这批导出是**给宿主用的公共 API**（不只是给 app-shell 内部用）：desktop 的自绘
 * 标题栏是独立的一棵 React 树，拿不到 app-shell 内部的东西，只能从这里取。
 */

export { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
export { useAgentApp, useAgentAppView } from '@fizz/agent-kit/shared/hooks/useAgentApp'
export type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export { useTheme } from '@fizz/agent-kit/shared/hooks/useTheme'
/** 主题纯函数碰 DOM，留在 UI 层（client 包不许有 DOM） */
export { applyThemeClass, resolveTheme } from '@fizz/agent-kit/shared/hooks/useTheme'

/** 宿主注入后补读一次连接（desktop 的连接来自宿主，见 agent-store 的说明） */
export { hydrateConnection } from '@fizz/agent-kit/shared/lib/stores/agent-store'

/**
 * part 维护的公共工具。`toolErrorText` 是对外的那一个：把工具失败时的 output（可能是
 * 字符串、也可能是 ACP 后端那种对象）抠成人话 —— 别的宿主（精简壳）也要
 * 把同一份 output 渲染给用户，**这份逻辑只能有一处定义**，否则两边会漂。
 */
export { toolErrorText, textOf, toolState, toolLabel } from '@fizz/agent-kit/shared/lib/parts'

/**
 * 侧边栏折叠状态：导出给**另一棵 React 树**（宿主窗口）用，保证它和 AgentApp 读同一个值。
 *
 * ⚠️ 目前包外没有调用方：desktop 自绘标题栏那颗「收起侧栏」按钮已在标题栏精简时移除，
 * 侧栏自己那几颗也在改成 `SidebarTopBar` 时移除（那个动作现在归活动栏）。
 * 留着是给宿主备用的公共 API；原先还有一个 `toggleSidebarCollapsed`（取反），
 * 随最后一批按钮一起删了。
 */
export {
  useSidebarCollapsed,
  setSidebarCollapsed,
  getSidebarCollapsed
} from '@fizz/agent-kit/shared/lib/sidebar-collapsed'

/**
 * 自定义标题栏（desktop 宿主，另一棵 React 树）的功能按钮：按钮按下时广播一个动作，
 * 由 app-shell 接住执行（复用快捷键那套分发）。参数是动作名字符串 —— 宿主不必为了
 * 一个名字把 shortcuts 模块整个拖进来。
 */
export { dispatchTitleAction } from '@fizz/agent-kit/shared/lib/app-events'

/**
 * 「关于」弹窗：desktop 自定义标题栏的 About 菜单打开它。内容与视觉走与设置弹窗
 * 同一套原语，所以放在共享包里而不是 desktop 自己那份 —— 别的宿主（如 web）要放
 * 关于入口时可以直接复用。
 */
export { AboutDialog } from '@fizz/agent-kit/features/settings/AboutDialog'

/**
 * 品牌标识（logo + 名字）：desktop 自绘标题栏要渲染它（标题栏是独立的一棵 React 树，
 * 拿不到侧栏里那份），web / 手机侧栏顶栏也在用同一个。名字与图片只有这一处来源。
 */
export { AppBrand, APP_NAME } from '@fizz/agent-kit/shared/components/AppBrand'

/**
 * 打开全局工具标签（应用日志 / 文件管理 / SSH 隧道）。
 *
 * desktop 自绘标题栏是独立的一棵 React 树，点不到 `app-shell` 内部的东西 ——
 * 它的日志入口只能直接调这个函数（与 `AppBrand` 同一个理由）。
 */
export { openFilesTab, openLogsTab, openSysmonTab } from '@fizz/agent-kit/shared/lib/tool-tabs'

/**
 * AI 助手面板的开关状态（模块级 + 订阅）。
 *
 * desktop 自绘标题栏（独立 React 树）要放一颗「AI 助手」按钮、直接读写这份状态 ——
 * 与 `openLogsTab` 同一个理由。状态是模块级单例，标题栏与 app-shell 在同一份 bundle 里，
 * 因此两边读写的是同一个开关。
 */
export { setAssistantPanelOpen, useAssistantPanelOpen } from '@fizz/agent-kit/shared/lib/assistant-panel'

/**
 * 下拉菜单原语：desktop 标题栏的 Window 菜单要用（标题栏是独立的一棵 React 树，
 * 不能从 app-shell 里拿组件）。与 Tooltip 同样是「供宿主复用的浮层原语」。
 */
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'

// 界面原语：供其它宿主（如 精简壳 的浮窗）复用同一套消息渲染，
// 避免两边各写一套、观感漂移。这些是桌面端主界面也在用的同一组组件。
export { PartView } from '@fizz/agent-kit/features/chat/PartView'
export {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationEmptyState
} from '@fizz/agent-kit/shared/ai-elements/conversation'
export { Message, MessageContent } from '@fizz/agent-kit/shared/ai-elements/message'
export { ConfirmCard, ConfirmQueue } from '@fizz/agent-kit/features/chat/ConfirmCard'
export { MessageOutline } from '@fizz/agent-kit/features/chat/MessageOutline'

// 浮层原语：Tooltip 依赖 Provider，宿主在应用根包一层即可（App 内部也包了，嵌套无害）。
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@fizz/ui/tooltip'

export { bootstrapLanguage, useLanguage, useT, persistLanguage } from './shared/lib/language'

/**
 * 标签装饰：给主区域标签条上的**任意一颗标签**换图标、加状态点（右上角小圆点）。
 *
 * 标签图标本来由 `useTabMeta` 按 key 前缀硬编码，外部改不了；这个登记表是那条旁路
 * （插件面板自己的忙碌态、某个标签的特殊图标都走它）。会话「在跑 / 等你点头」与终端
 * 「活着 / 已退出」是**内建**的，不用外部写。
 *
 * ⚠️ 写入方要在标签关闭 / 卸载时 `clearTabDecoration(key)`：这张表不随面板布局回收。
 */
export {
  clearTabDecoration,
  getTabDecoration,
  getTabDecorationsVersion,
  setTabDecoration,
  subscribeTabDecorations
} from '@fizz/agent-kit/shared/lib/tab-decorations'
export type {
  TabDecoration,
  TabStatus,
  TabStatusTone
} from '@fizz/agent-kit/shared/lib/tab-decorations'
