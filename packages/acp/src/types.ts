/**
 * @fizz/acp 的领域类型：外部 ACP agent 的配置、模型选择与会话更新内容。
 * 类型真源在本包，前端一律 `import type` 引用（类型会被编译期擦除，
 * 不会把 @agentclientprotocol/sdk 与 node 子进程拖进浏览器产物）。
 */

/**
 * 外部 agent 的「风格」（设置 → 外部 Agent 里手选）：决定会话输入区里模式 UI 的
 * 语义与摆放位置（见 ChatPanel 的 AcpModePill / AcpThoughtLevelSelect）。
 *
 * - `opencode`：Session Modes 表达**权限档** → 摆在权限 pill 的位置；
 * - `pi`：configOptions 的 `thought_level` 表达**思考档** → 摆在模型选择器之后；
 * - `generic`（缺省）：**不显示任何模式 UI**（哪怕 agent 广告了 modes）。
 */
export type AcpAgentType = 'opencode' | 'pi' | 'generic'

/**
 * 会话档为「完全放行」时，怎么答复 agent 的权限请求（`session/request_permission`）。
 *
 * - `once`（缺省）：**只允许这一次**（回 `allow_once`）—— 下次仍会问，把会话切回「确认」
 *   也还有得问。**默认必须是它**：回 `allow_always` 会被 agent 自己永久记住，
 *   之后切回「确认」也要不回询问了（实测踩过）。
 * - `always`：回 `allow_always`，由 agent 永久记住，此后同类不再问（用户明确想要才行）。
 *
 * 之所以**按 agent 配**：不同 agent 对 allow_always 的「记住」粒度 / 生效时机不一样，
 * 一律回 always 迟早会踩到「再也要不回询问」。
 */
export type AcpAllowStrategy = 'once' | 'always'

/** ACP 后端的外部 agent 启动配置（stdio 通信） */
export interface AcpAgentConfig {
  id: string
  /** 显示名称，如 Codex CLI / Gemini CLI */
  name: string
  /** 可执行文件（绝对路径或 PATH 可解析名；Windows 下 npm 脚本需 .cmd 后缀） */
  command: string
  args: string[]
  /** 风格（见 `AcpAgentType`）；缺省 = `generic`（不显示模式 UI） */
  type?: AcpAgentType
  /** 「完全放行」的答复策略（见 `AcpAllowStrategy`）；缺省 = `once`（只允许一次） */
  allowStrategy?: AcpAllowStrategy
  /**
   * **会话模型下拉里暴露哪几个模型**（设置 → 外部 Agent 里挑的，来自 agent 自己
   * 广告的 `configOptions`；一个 agent 往往能选十几二十个模型，全列出来太吵）。
   *
   * 空 / 未设置 = 一个都不列（会话里只能用「它的默认模型」）；
   * 每个会话再从中选一个用（存在 `AgentConversation.modelId`）。
   */
  models?: AcpModelOption[]
}

/** 本地 PATH 中检测到的已知 ACP agent */
export interface DetectedAcpAgent {
  /** 展示名称 */
  name: string
  /** 可执行命令（PATH 可解析名） */
  command: string
  /** 建议的启动参数（如 gemini -> ["--acp"]） */
  args: string[]
  /** 解析到的绝对路径 */
  path: string
}

/** 外部 agent（ACP）能选的一个模型 */
export interface AcpModelOption {
  /** 模型值（切模型时回传给 agent 的就是它，也就是会话记的 `modelId`） */
  value: string
  /** 展示名（agent 给的人类可读名） */
  name: string
  description?: string
}

/**
 * 某条 ACP 会话上「可选的模型」。
 *
 * ACP 没有独立的「列模型」方法：模型清单是 agent 在 `session/new` 的 `configOptions`
 * 里广告的（`category: 'model'`），所以这份清单得**拉起 agent 进程建立会话**才问得出来。
 */
export interface AcpModelChoices {
  /** 承载模型的那个 config 选项 id；null = 这个 agent 不支持选模型 */
  configId: string | null
  /** agent 当前的模型值 */
  current: string | null
  /** 可选模型；空 = 不支持选模型 */
  options: AcpModelOption[]
}

/**
 * ACP 工具调用的展示内容条目（`session/update` 里 toolCall.content 的收窄形状）。
 * 类型三选一：`content`（文本等内容块）/ `diff`（文件修改前后对比）/ `terminal`（终端引用，
 * 只有 terminalId —— 输出在 rawOutput / 后续 update 里）。未知类型由前端兜底忽略。
 */
export interface AcpToolCallContent {
  type: string
  /**
   * type === 'content'：内容块，消费 `text` 与 `image` 两种。
   *
   * `image` 是**工具结果里的图**（读图 / 截图 / 渲染预览这类工具回的
   * `ContentBlock::Image`）。前端拿 `data`(base64) + `mimeType` 拼 data URL 直接显示，
   * 不落盘（ACP 消息真源在 agent 侧，本地快照只在内存）。
   */
  content?: { type?: string; text?: string; data?: string; mimeType?: string }
  /** type === 'diff'：文件路径与修改前后文本 */
  path?: string
  oldText?: string
  newText?: string
  /** type === 'terminal'：终端引用 id */
  terminalId?: string
}
