/**
 * 打开 acp 会话时把 agent 侧会话 load 回来（重建视图用）。
 * GET /api/acp/agents/:id/transcript?conversationId=&sessionId=&cwd=
 *
 * 消息本体在 agent 侧（本地不落盘）：这里做「视图恢复」—— `session/load` 的
 * 历史回放（含用户消息）折成结构化消息一次性返回，客户端 setMessages 直接渲染。
 * agent 没广告 loadSession 能力 / 会话失效 → 报错，客户端保持空视图不阻塞对话。
 */
import { replayAcpSession, type AcpAgentConfig } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { findActiveByConversation, summarize } from '@/lib/server/chat-run'
import {
  carryOverDurations,
  acpTranscriptView,
  getAcpTranscript,
  setAcpTranscript
} from '@/lib/server/acp-transcripts'
import { refreshAcpSessionState } from '@/lib/server/acp-session-state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let agent: AcpAgentConfig
  try {
    agent = domain.resolveAcpAgent(id)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')?.trim() || ''
  const sessionId = url.searchParams.get('sessionId')?.trim() || ''
  const cwd = url.searchParams.get('cwd')?.trim() || ''
  if (!conversationId) {
    return jsonError(400, '缺少 conversationId')
  }
  /**
   * ⚠️ 这一轮还在跑时**绝不能**走 `replayAcpSession`：它开头就 teardown 同 key 的
   * ACP 进程，正在等 nextUpdate 的 ActiveSession 会以 `ACP connection closed` 失败。
   * 此时视图由进程内快照 + 前端 attach 帧日志恢复；等 idle 了才用 session/load。
   */
  const active = findActiveByConversation(conversationId)
  if (active) {
    return Response.json(acpTranscriptView(conversationId, summarize(active)))
  }
  if (!sessionId || !cwd) {
    return jsonError(400, '缺少 sessionId / cwd')
  }
  try {
    const before = getAcpTranscript(conversationId)
    const messages = await replayAcpSession({
      agent,
      conversationId,
      workspacePath: cwd,
      sessionId
    })
    /**
     * idle 时 load 是权威视图：顺手刷新快照，供下一次「跑动中刷新」使用。
     *
     * ⚠️ 回放是异步的，期间用户可能已经发出新一轮（beginTurnUserMessage 会往快照里
     * 追加用户消息）。这里只把**回放期间新增的尾巴**接回去，别整份覆盖掉。
     */
    const after = getAcpTranscript(conversationId) ?? []
    const appended = before ? after.slice(before.length) : after
    // 回放重建出来的消息没有「本轮耗时」（agent 协议不给）：把快照里记的那份按顺序搬回来，
    // 否则刷新一下折叠条抬头就从「已工作 1 分 12 秒」退回计数摘要
    if (before) carryOverDurations(before, messages)
    setAcpTranscript(conversationId, [...messages, ...appended])
    // load 会把 agent 广告的档位带回来（可能被重置成默认）：刷新进会话配置，保留用户选的档
    refreshAcpSessionState(conversationId, agent.id)
    // load 期间可能又开了下一轮：返回最新快照及其所属轮次，不让调用方接回旧 run。
    const current = findActiveByConversation(conversationId)
    return Response.json(acpTranscriptView(conversationId, current ? summarize(current) : null))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
