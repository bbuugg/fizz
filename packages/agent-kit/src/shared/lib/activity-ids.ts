/**
 * 功能区（活动栏条目）id 常量。
 *
 * 单独放在这个「叶子模块」（不 import 任何东西）是为了避免循环依赖：
 * `activities.tsx` 需要 import 各面板组件，而面板组件（或外壳）又要引用功能区 id，
 * 若 id 定义在 `activities.tsx` 就会形成
 * `AgentSidebar → activities → AgentSidebar` 的环，求值顺序不巧时注册表拿到的
 * 会是尚未初始化的组件。所以 id 下沉到这里。
 */

/** AI Agent：工作区 / 会话树，主区域是会话多标签 */
export const AGENT_ACTIVITY_ID = 'agent'

/**
 * 主机：SSH 主机清单 + 本机终端入口。
 *
 * 它**没有自己的主区域**——从这里打开的主机 / 终端都落在同一块面板里（`PanelView`），
 * 因为那些标签必须能和对话标签并排、一起拖拽分屏。
 */
export const HOSTS_ACTIVITY_ID = 'hosts'

/**
 * 接口请求：Postman 式的 HTTP 调试（保存的请求按分组树管理 + 请求历史）。
 *
 * 与「主机」同款：**没有自己的主区域**——点一条保存的请求，就在 `PanelView` 里开一个
 * `api:<requestId>` 标签，和对话 / 终端标签并排、一起拖拽分屏。
 */
export const API_CLIENT_ACTIVITY_ID = 'api-client'

/**
 * 笔记：登记若干本地 / 服务端目录，在其中管理 Markdown。
 *
 * 与「主机」「接口请求」同款：**没有自己的主区域** —— 点树里的一篇笔记，就在
 * `PanelView` 里开一个 `note:<n>` 标签，和对话 / 终端标签并排、一起拖拽分屏。
 */
export const NOTES_ACTIVITY_ID = 'notes'

/**
 * 插件：**所有插件共用的一个入口**。
 *
 * 图标栏里只有这一颗，侧栏是「插件列表」（`features/plugins/PluginsSidebar.tsx`），
 * 点某个插件就在 `PanelView` 里开它的标签页 —— 插件**不占**图标栏、也没有自己的侧栏。
 *
 * 为什么不像早先那样「一个插件一颗图标 + 一份侧栏」：图标栏会被插件数量撑成一片，
 * 而每颗图标后面那列只服务一个插件，用户还得先记住「哪个图标是哪个插件」。
 * 一个入口 + 一份列表把这件事收敛成一次点击。
 */
export const PLUGINS_ACTIVITY_ID = 'plugins'
