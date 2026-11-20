/**
 * ACP 会话的进程内视图快照。
 *
 * ACP 的消息真源在 agent 侧（本地 `conversation.messages` 恒为空），打开会话本应走
 * `session/load`。但 `replayAcpSession` 的第一件事是 teardown 同 key 的进程 —— 这一轮
 * 还在跑时刷新页面，回放会把正在跑的 ACP 子进程杀掉，SDK 那边就报
 * `ACP connection closed`。
 *
 * 所以这里按 conversationId 留一份「已经折叠成前端消息」的视图：
 * - 每轮开始时补上用户消息，轮次收尾时补上助手消息；
 * - 空闲时 `session/load` 成功后用它整体重建（agent 侧仍是权威）；
 * - 跑动中的刷新只读它（配合 chat-run 的帧日志 attach 当前轮），不触发任何 ACP 调用。
 *
 * 只在内存里：服务端重启后连同 run 一起消失，下一次空闲打开会话会重新 load。
 */
import type { AgentChatMessage } from '@fizz/contracts/types'
import type { AcpTranscriptResult, ChatRunSummary } from '@fizz/contracts/agent-api'
import { acpTranscripts } from './state'

/** 取一份快照（只读；调用方不要原地修改消息）。没有记录时返回 undefined */
export function getAcpTranscript(conversationId: string): AgentChatMessage[] | undefined {
  const cached = acpTranscripts.get(conversationId)
  return cached ? cached.slice() : undefined
}

/** 同一个同步窗口中读取的运行态决定历史边界；当前轮由帧日志重建，不能出现两份。 */
export function acpTranscriptView(
  conversationId: string,
  run: ChatRunSummary | null
): AcpTranscriptResult {
  const messages = getAcpTranscript(conversationId) ?? []
  return {
    messages: run?.assistantMessageId
      ? messages.filter((m) => m.id !== run.assistantMessageId)
      : messages,
    run
  }
}

/** `session/load` 完成后整体替换快照（agent 侧权威视图） */
export function setAcpTranscript(
  conversationId: string,
  messages: AgentChatMessage[]
): void {
  acpTranscripts.set(conversationId, messages.slice())
}

/** 追加一轮里新产生的消息（用户消息在开跑时、助手消息在收尾时） */
export function appendAcpTranscript(
  conversationId: string,
  messages: AgentChatMessage[]
): void {
  if (!messages.length) return
  const cached = acpTranscripts.get(conversationId)
  acpTranscripts.set(conversationId, [...(cached ?? []), ...messages])
}

/** 删会话 / 转成内置会话时清掉，别让同名 id 的旧视图复活 */
export function forgetAcpTranscript(conversationId: string): void {
  acpTranscripts.delete(conversationId)
}

/**
 * 把上一份快照里记下的「本轮耗时」搬到 `session/load` 重建出来的消息上。
 *
 * 为什么要搬：ACP 一轮的耗时只在 finish 帧里出现过一次（`AgentChatMessage.durationMs`），
 * 服务端把它挂进快照就丢了源 —— agent 侧协议没有这个数，回放重建出来的消息天然没有它。
 * 不搬的话「刚跑完显示已工作 N 秒、刷新一下变回思考 ×3 · 工具调用 ×5」。
 *
 * 为什么只能按顺序搬，不能按 id：回放的消息 id 是现编的（`a-replay-N`），与快照里那个
 * （客户端给的 `assistantMessageId`）没有对应关系；唯一稳定的是「一轮 = 一条助手消息」。
 * 所以只在**两边助手消息条数一致**时逐条搬 —— 条数不一致就一定错位，宁可不搬
 * （抬头退回计数摘要，与没有这个字段时一致），也别把 A 轮的耗时挂到 B 轮上。
 */
export function carryOverDurations(
  from: AgentChatMessage[],
  to: AgentChatMessage[]
): void {
  const fromAssistants = from.filter((m) => m.role === 'assistant')
  const toAssistants = to.filter((m) => m.role === 'assistant')
  if (!fromAssistants.length || fromAssistants.length !== toAssistants.length) return
  for (let i = 0; i < toAssistants.length; i += 1) {
    const durationMs = fromAssistants[i].durationMs
    if (durationMs != null && toAssistants[i].durationMs == null) {
      toAssistants[i].durationMs = durationMs
    }
  }
}
