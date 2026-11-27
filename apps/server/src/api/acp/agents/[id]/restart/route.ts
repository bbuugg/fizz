/**
 * 兼容旧客户端的重启入口：空闲时共用统一恢复流程，运行 / 等答复时拒绝重启。
 *
 * POST /api/acp/agents/:id/restart  { conversationId } → { ok, error? }
 *
 * 保留原 sessionId、补装权限扩展并刷新服务端历史快照；与 transcript 请求并发时只回放一次。
 * 还没有 agent 侧 session（新会话还没发过消息）时仍是幂等空操作。
 */
import { AcpSessionRecoveryError, recoverAcpConversation } from '../../../../../server/acp-session-recovery'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<{ conversationId?: string }>(request)
  const conversationId = body?.conversationId?.trim()
  if (!conversationId) return jsonError(400, '缺少 conversationId')

  try {
    await recoverAcpConversation(id, conversationId, { restartOnly: true })
  } catch (err) {
    if (err instanceof AcpSessionRecoveryError) return jsonError(err.status, err.message)
    const { status, message } = describeError(err)
    return jsonError(status, `重连失败：${message}`)
  }

  return Response.json({ ok: true })
}
