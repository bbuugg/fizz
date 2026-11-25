/**
 * 分叉一个 agent 侧会话（`session/fork`）。
 *
 * POST /api/acp/agents/:id/fork  { sessionId, workspacePath? } → { sessionId }
 *
 * 返回的是**新会话 id**，调用方拿它建一条本地 ACP 会话（`acpSessionId` 绑上去）即可。
 * agent 不支持 `session/fork` 时接口直接报错 —— 前端据此提示，不要静默造一条空会话。
 */
import { forkAcpSession, type AcpAgentConfig } from '@fizz/acp'
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
  const body = await parseJsonBody<{ sessionId?: string; workspacePath?: string }>(request)
  const sessionId = body?.sessionId?.trim()
  if (!sessionId) return jsonError(400, '缺少 sessionId')
  try {
    return Response.json(
      await forkAcpSession({
        agent,
        sessionId,
        ...(body?.workspacePath ? { workspacePath: body.workspacePath } : {})
      })
    )
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
