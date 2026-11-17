/**
 * `POST /api/conversations` 的请求体 → `ConversationInput`。
 *
 * 单独一层是因为这个映射**必须有唯一一份**：路由里两处建会话（ACP 的 `session/new` 分支
 * 与普通落库分支）各自手抄一遍字段，抄漏一个就是「明明给服务端发了、落库却没了」。
 *
 * ## 这里曾经漏掉的两项（用户报的 bug）
 *
 * 「开始新对话」页选的 **MCP** 与 **浏览器开关** 都活在 `draftSettings` 里，由
 * `newConversation` 塞进创建请求；`ConversationInput` 与 `saveConversation` 早就支持这两个
 * 字段（fork 也在用）。但路由的 `parseJsonBody<...>` 内联类型里没有它们，于是：
 *
 * - 请求体带着 `mcpServerIds` / `browserSettings` 到达；
 * - 路由只挑它认识的字段调 `saveConversation` → 落库的会话这两项是空 / 缺省；
 * - 前端那一刻是乐观改的清单项（看着还在），下一次清单刷新被服务端那份覆盖
 *   → **「消息发出去，浏览器关了、MCP 一个都不剩」**。
 *
 * 所以新增字段的规矩：**加在这里**，别在路由里就地挑；`conversation-create-fields.test.ts`
 * 把这两项钉住了。
 *
 * 这里是**唯一**的建会话入口：助手侧那条「在项目下建一个空会话」的路已随
 * `create_conversation` 工具一起移除（2026-11），别再把工具侧的建会话逻辑加回来。
 */
import type {
  AgentChatMessage,
  AiReasoningEffort,
  BrowserSettings,
  CollabSettings,
  ConversationInput
} from '@fizz/contracts'

/**
 * 创建会话的原始请求体。
 *
 * 与 `ConversationInput` 的差别只有两项：`id` / `workspaceId` 由路由解析（工作区可能要先
 * 建临时目录），不从这里过。
 */
export interface ConversationCreateBody {
  id?: string
  /**
   * 会话归属的项目。**缺省 = 用户没选项目**：路由会当场建一个临时工作区再绑上去
   * （见 `ensureScratchWorkspace`），所以它不是 `conversationCreateFields` 的字段。
   */
  workspaceId?: string
  title?: string
  /** 会话形态（缺省 = 普通对话）；`collab` 只支持内置 Agent 后端 */
  kind?: 'chat' | 'collab'
  collab?: CollabSettings
  backend?: 'builtin' | 'acp'
  configId?: string
  modelId?: string
  reasoningEffort?: AiReasoningEffort
  acpSessionId?: string
  /** 「开始新对话」页勾的 MCP server；缺省 = 全不选 */
  mcpServerIds?: string[]
  /** 「开始新对话」页开的浏览器（开关 + 来源）；缺省 = 全局默认（关） */
  browserSettings?: BrowserSettings
  messages?: AgentChatMessage[]
}

/**
 * 只挑「允许从请求体带进来」的字段。
 *
 * `undefined` 一律**不传**而不是传 `undefined`：`saveConversation` 的语义是
 * 「不传 = 沿用已有」（见 `ConversationInput` 各字段注释），传了 `undefined` 虽然等价，
 * 但少一层「到底是没给还是给了空」的歧义。
 *
 * 例外是 `mcpServerIds` 用 `Array.isArray` 判：`[]` 是**有效值**（= 一个都不用），
 * 与「没给」在语义上一致，但保留调用方显式表达。
 */
export function conversationCreateFields(
  body: ConversationCreateBody
): Omit<ConversationInput, 'id' | 'workspaceId'> {
  return {
    ...(body.title ? { title: body.title } : {}),
    ...(body.kind === 'collab' ? { kind: 'collab' as const } : {}),
    ...(body.kind === 'collab' && body.collab ? { collab: body.collab } : {}),
    ...(body.backend ? { backend: body.backend } : {}),
    ...(body.configId ? { configId: body.configId } : {}),
    ...(body.modelId ? { modelId: body.modelId } : {}),
    ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
    ...(body.acpSessionId ? { acpSessionId: body.acpSessionId } : {}),
    ...(Array.isArray(body.mcpServerIds) ? { mcpServerIds: body.mcpServerIds } : {}),
    ...(body.browserSettings ? { browserSettings: body.browserSettings } : {}),
    ...(Array.isArray(body.messages) ? { messages: body.messages } : {})
  }
}
