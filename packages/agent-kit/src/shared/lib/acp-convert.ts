/**
 * ACP 会话 → 内置 agent（内置）会话的内容转换：**纯函数**，不碰网络也不碰状态。
 *
 * 为什么需要它：ACP 会话的历史**不在我们库里**（服务端落库时对 acp 强制清空 `messages`，
 * 见 `packages/workspace/src/domain.ts`），它是每次开会话时从外部 agent 侧
 * `session/load` 回放出来的（`conversation.ts` 的 loadConversation）。要「转成内置会话」，
 * 就得把那份回放结果原样搬进一条 内置会话的 `messages` —— 搬之前把内置侧不认的字段洗掉。
 *
 * 转换规则：**只做减法，且减的都是「内置侧不认 / 搬过去会误导」的字段，不动内容本身。**
 * - `text` / `reasoning` 原样保留（reasoning 喂模型时本来就被 `toModelMessages` 丢掉，
 *   留着是为了在新会话里仍然看得见思考过程）；
 * - `tool-call` 只留内置侧认的四项 + 落盘字段：丢掉 ACP 专有的 `acpKind` / `acpContent` /
 *   `title`（内置 UI 不认，留着只是脏数据），也丢掉三个**只喂流式渲染、不进落盘历史**
 *   的临时字段（`inputText` / `subagentText` / `liveOutput`，见契约里的注释）；
 * - `tool-result` 原样保留（含 `isError`）—— 悬空 tool-call / 孤儿 result 由
 *   `toModelMessages` 自己兜（补占位错误 / 丢弃），这里不替它裁定；
 * - `file` 保留：内置侧 user 消息认它（ACP 回放目前不产出附件 part，但哪天真有了，
 *   也不该在转换这一步被吃掉）；
 * - 消息级 `usage` / `contextUsage` **丢掉**：那是外部 agent 上报的用量 / 上下文快照，
 *   搬进新会话只会显示一个与这轮无关的数字（`usage` 是内置侧才有的字段，ACP 拿不到）。
 */
import type { AgentChatMessage, AgentMessagePart } from '@fizz/contracts/types'

export function toBuiltinHistory(messages: AgentChatMessage[]): AgentChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    parts: message.parts
      .map(toBuiltinPart)
      .filter((part): part is AgentMessagePart => part !== null)
  }))
}

/** 单个 part 的清洗：认得的原样（或收窄）留下，不认的返回 null 丢掉 */
function toBuiltinPart(part: AgentMessagePart): AgentMessagePart | null {
  switch (part.type) {
    case 'tool-call':
      // 只留内置侧认的字段：其余是 ACP 专有展示字段或流式临时字段（见文件头注释）
      return {
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input
      }
    case 'text':
    case 'reasoning':
    case 'tool-result':
      return part
    case 'file':
      /**
       * `data:` 的 file part 是 ACP 回放出来的图（用户发的 / agent 回传的，都只剩 base64）。
       * 内置会话的历史是**落盘**的，搬过去等于把几 MB base64 写进会话 JSON ——
       * 之后每次读会话都要全量解析，长会话会明显卡。只搬真正的上传文件引用。
       */
      return part.url.startsWith('data:') ? null : part
    default:
      // 将来新增的 part 类型：内置侧不认，宁可丢掉也别塞进历史（塞错会静默丢 / 报错）
      return null
  }
}
