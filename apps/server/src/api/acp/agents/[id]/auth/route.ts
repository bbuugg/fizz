/**
 * 外部 Agent 的登录 / 退出登录。
 *
 * POST /api/acp/agents/:id/auth  { methodId } → { ok: true }
 * DELETE /api/acp/agents/:id/auth → { ok: true }（仅 v2 的 agent 支持 auth/logout）
 *
 * 登录方式由 agent 在 `initialize` 的 `authMethods` 里广告（设置页展示）。
 * `terminal` 类型的方法需要在终端里交互完成，服务端没有 PTY 通道，直接报错。
 */
import { authenticateAcpAgent, logoutAcpAgent, type AcpAgentConfig } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

async function resolveAgent(id: string): Promise<AcpAgentConfig> {
  return domain.resolveAcpAgent(id)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let agent: AcpAgentConfig
  try {
    agent = await resolveAgent(id)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  const body = await parseJsonBody<{ methodId?: string }>(request)
  const methodId = body?.methodId?.trim()
  if (!methodId) return jsonError(400, '缺少 methodId')
  try {
    await authenticateAcpAgent({ agent, methodId })
    return Response.json({ ok: true })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let agent: AcpAgentConfig
  try {
    agent = await resolveAgent(id)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  try {
    await logoutAcpAgent({ agent })
    return Response.json({ ok: true })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
