/**
 * 关闭一个 agent 侧会话（`session/close`）：释放 agent 侧资源，但不删除落盘数据。
 *
 * POST /api/acp/agents/:id/close  { sessionId } → { ok, supported }
 *
 * 与删除（DELETE /sessions?sessionId=）区分：close 之后还能 resume，delete 是抹掉。
 */
import { closeAcpSession, type AcpAgentConfig } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(
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
  const body = await parseJsonBody<{ sessionId?: string }>(request)
  const sessionId = body?.sessionId?.trim()
  if (!sessionId) return jsonError(400, '缺少 sessionId')
  try {
    return Response.json(await closeAcpSession({ agent, sessionId }))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
