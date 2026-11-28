/**
 * 审批答复（confirm 模式）：解开对应那条 shell 的 await。
 * POST /api/chat/confirm
 */
import type { ConfirmReplyInput } from '@fizz/contracts/agent-api'
import { pendingConfirms } from '@/lib/server/state'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<ConfirmReplyInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  if (typeof body?.id !== 'string' || typeof body?.approved !== 'boolean') {
    return jsonError(400, '缺少 id 或 approved')
  }
  const entry = pendingConfirms.get(body.id)
  if (!entry) return Response.json({ resolved: false })
  pendingConfirms.delete(body.id)
  // optionId：ACP 权限请求里用户挑中的选项，原样回给 agent（内置审批没有它）
  entry.resolve({
    approved: body.approved,
    ...(typeof body.optionId === 'string' && body.optionId ? { optionId: body.optionId } : {})
  })
  return Response.json({ resolved: true })
}
