/**
 * ACP 协议版本无关的连接抽象。
 *
 * 背景：v1（stable）与 v2（draft）的方法集 / 会话生命周期差异很大（`session/load` →
 * `session/resume`、`session/set_mode` 被移除、消息改为可扩展 union、prompt 只回
 * 「已插入」而不是「已完成」）。本层把差异收进各自的 adapter，向上只暴露一套
 * **v1 形状的规范化接口**，让 `acp.ts` 的会话引擎不用区分版本。
 *
 * 设计要点：
 * - `session_update` 的字段名一律规整成 v1 的形状（`agent_message_chunk` /
 *   `agent_thought_chunk` / `tool_call_update` / `usage_update`），这样既有的
 *   `toAcpStreamEvent` 一张表通吃两个版本。
 * - `prompt()` 的语义统一成「整轮结束才 resolve」（v2 把 idle `state_update` 折算成 stop）。
 * - 权限选项 / 答复结构两个版本本来就同形，直接复用。
 */

/** 支持的 ACP 协议版本 */
export type AcpProtocolVersion = 'v1' | 'v2'

/** ACP 权限请求里的一个可选项（两版同形） */
export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: string
}

/**
 * 规范化后的权限请求（agent → client）。
 *
 * v1 从 `params.toolCall` 取，v2 从 `params.subject.toolCall` / `params.subject` 取；
 * 字段缺失时由 adapter 回填空值，`acp.ts` 再按 `toolCallId` 回查本轮 tool_call 记忆。
 */
export interface AcpPermissionRequest {
  toolCallId: string
  /** 面向用户的标题（v1 的 toolCall.title / v2 的 params.title） */
  title: string
  /** 程序化工具名（可能缺） */
  name?: string
  /** 工具种类（可能缺） */
  kind?: string
  options: AcpPermissionOption[]
}

/** 用户对一次权限请求的答复（挑中的 optionId，或缺省布尔） */
export interface AcpPermissionReply {
  approved: boolean
  optionId?: string
}

/** 会话模式（`session/new.modes` 或 v2 的 configOptions category=mode） */
export interface AcpSessionModeInfo {
  id: string
  name?: string
  description?: string
}

/** 会话模式快照 */
export interface AcpModesSnapshot {
  availableModes: AcpSessionModeInfo[]
  currentModeId: string | null
}

/** 轮次里流动的一条消息（与 acp.ts 的 TurnMessage 同形） */
export type AcpTurnMessage =
  | { kind: 'session_update'; update: { sessionUpdate: string; [key: string]: unknown } }
  | { kind: 'stop'; stopReason: string }

/** 一轮对话的交互来源（ActiveSession 或 resume 后的手写队列） */
export interface AcpTurnSource {
  readonly sessionId: string
  /** 发送一轮 prompt；整轮结束（stop）后才 resolve */
  prompt(prompt: unknown[]): Promise<void>
  nextUpdate(): Promise<AcpTurnMessage>
  /** 取走队列里已攒着的全部消息（resume 的回放历史就在这里） */
  drainAll(): AcpTurnMessage[]
  /**
   * 把错误交给正在等消息的轮次（仅手写队列需要；SDK 的 ActiveSession 在传输断开时
   * 自己会 reject）。进程退出时由 `acp.ts` 调用，避免界面一直停在「思考中」。
   */
  fail?(err: unknown): void
}

/** initialize 后 agent 广告的能力（已规整成跨版本字段） */
export interface AcpInitResult {
  /** 是否收图片输入；null = agent 没广告（未知，不等于不支持） */
  promptImage: boolean | null
  /** 是否支持列会话（session/list） */
  canList: boolean
  /** 是否支持删会话（session/delete） */
  canDelete: boolean
  /** 是否支持分叉会话（session/fork） */
  canFork: boolean
  /** 是否支持主动关闭会话（session/close） */
  canClose: boolean
  /** 是否支持取消进行中的轮次（session/cancel） */
  canCancel: boolean
  /** agent 广告的登录方式；空数组 = 不需要 / 不支持认证 */
  authMethods: AcpAuthMethod[]
}

/** `session/new` 的结果 */
export interface AcpNewSessionResult {
  source: AcpTurnSource
  configOptions: unknown[] | null
  modes: AcpModesSnapshot | null
}

/** agent 广告的一种登录方式（两版字段名不同，这里统一成 `id`） */
export interface AcpAuthMethod {
  id: string
  name: string
  description?: string
  /** `agent`（走 authenticate / auth.login）或 `terminal`（客户端起交互进程） */
  type?: string
}

/**
 * agent → client 的结构化追问（elicitation）。
 *
 * `form` 带 JSON Schema（`schema`），`url` 带要用户打开的地址；两版同形，这里只保留
 * 展示所需字段。
 */
export interface AcpElicitationRequest {
  sessionId?: string
  toolCallId?: string
  mode: string
  message: string
  /** url 模式的目标地址 */
  url?: string
  /** form 模式的 JSON Schema（原样透传，界面自定义渲染） */
  schema?: unknown
}

/** 用户对 elicitation 的答复 */
export type AcpElicitationReply =
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' }

/** `session/load`（v1）或 `session/resume`（v2）的结果 */
export interface AcpResumeResult {
  source: AcpTurnSource
  configOptions: unknown[] | null
  modes: AcpModesSnapshot | null
}

/** agent 侧既有会话的一行（session/list） */
export interface AcpSessionInfo {
  sessionId: string
  cwd: string
  title?: string
  updatedAt?: string
}

/** 连接期间 agent 回调 client 的处理器 */
export interface AcpConnectionHandlers {
  onPermission: (req: AcpPermissionRequest) => Promise<AcpPermissionReply>
  /** 结构化追问；缺省 = 一律 decline（不挂住 agent） */
  onElicitation?: (req: AcpElicitationRequest) => Promise<AcpElicitationReply>
  /** url 模式的 elicitation 在浏览器里完成后 agent 会回一条通知 */
  onElicitationComplete?: (elicitationId: string) => void
}

/** 建立连接所需的字节流 + 处理器 */
export interface AcpConnectInput {
  /** 写入 agent stdin 的流 */
  toAgent: WritableStream<Uint8Array>
  /** 从 agent stdout 读取的流 */
  fromAgent: ReadableStream<Uint8Array>
  handlers: AcpConnectionHandlers
}

/** 一个已建立的 ACP 连接（协议版本无关） */
export interface AcpConnection {
  readonly version: AcpProtocolVersion
  /** 发 initialize，返回规整后的能力；重复调用返回同一结果 */
  initialize(): Promise<AcpInitResult>
  newSession(cwd: string): Promise<AcpNewSessionResult>
  resumeSession(sessionId: string, cwd: string): Promise<AcpResumeResult>
  /** `session/fork`：从既有会话分叉出一条新会话（返回的新 sessionId 可直接 resume） */
  forkSession(sessionId: string, cwd: string): Promise<AcpResumeResult>
  /** `session/close`：让 agent 释放会话（不删除落盘数据） */
  closeSession(sessionId: string): Promise<void>
  /** `session/cancel`：取消该会话进行中的轮次（通知，不等回包） */
  cancelTurn(sessionId: string): Promise<void>
  /** `session/set_config_option`；返回最新的 configOptions */
  setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown[] | null>
  /** `session/set_mode`（仅 v1；v2 抛错） */
  setMode(sessionId: string, modeId: string): Promise<void>
  /** `session/list`（探针 / 导入用） */
  listSessions(cwd?: string): Promise<AcpSessionInfo[]>
  /** `session/delete`（探针 / 删除用） */
  deleteSession(sessionId: string): Promise<void>
  /** `authenticate`（v1）/ `auth/login`（v2） */
  login(methodId: string): Promise<void>
  /** `auth/logout`（仅 v2；v1 抛错） */
  logout(): Promise<void>
  /** 关掉传输（不负责杀进程，进程由调用方管理） */
  close(): void
}

/** 按版本解析出来的连接工厂 */
export interface AcpConnectionFactory {
  readonly version: AcpProtocolVersion
  connect(input: AcpConnectInput): Promise<AcpConnection>
}
