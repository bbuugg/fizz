/**
 * 打开 acp 会话时把 agent 侧会话 load 回来（重建视图用）。
 * GET /api/acp/agents/:id/transcript?conversationId=&sessionId=&cwd=
 *
 * 消息本体在 agent 侧（本地不落盘）：这里做「视图恢复」—— `session/load` 的
 * 历史回放（含用户消息）折成结构化消息一次性返回，客户端 setMessages 直接渲染。
 * agent 没广告 loadSession 能力 / 会话失效 → 报错，客户端保持空视图不阻塞对话。
 */
import { AcpSessionRecoveryError, recoverAcpConversation } from '../../../../../server/acp-session-recovery'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')?.trim() || ''
  if (!conversationId) {
    return jsonError(400, '缺少 conversationId')
  }
  try {
    return Response.json(await recoverAcpConversation(id, conversationId))
  } catch (err) {
    if (err instanceof AcpSessionRecoveryError) return jsonError(err.status, err.message)
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
