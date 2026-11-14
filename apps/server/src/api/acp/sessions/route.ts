/**
 * ACP 常驻进程诊断与手动回收。
 *
 * GET    /api/acp/sessions   → `{ sessions: AcpProcessInfo[] }`
 * DELETE /api/acp/sessions   body `{ agentId, conversationId }` → `{ ok: true }`
 *
 * GET 是只读快照（pid / agent / conversation / sessionId / 是否在跑 / 空闲时长），
 * 不触发任何清理；DELETE 直接 `abortAcpTurn` 杀掉该会话的 agent 进程（幂等）——
 * 空闲进程杀完下一轮会走 `session/load` 重建，上下文不丢；正在跑的轮次应由 UI 先停止。
 */
import { abortAcpTurn, listAcpProcesses } from '@fizz/acp'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json({ sessions: listAcpProcesses() })
}

export async function DELETE(request: Request) {
  const body = await parseJsonBody<{ agentId?: string; conversationId?: string }>(request)
  const agentId = body?.agentId?.trim()
  const conversationId = body?.conversationId?.trim()
  if (!agentId) return jsonError(400, '缺少 agentId')
  if (!conversationId) return jsonError(400, '缺少 conversationId')
  abortAcpTurn(agentId, conversationId)
  return Response.json({ ok: true })
}
