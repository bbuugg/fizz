/**
 * ask 的答复（上行）：解开对应那条提问工具的 await。
 * POST /api/chat/followup
 */
import type { FollowupReplyInput } from '@fizz/contracts/agent-api'
import { pendingFollowups } from '@/lib/server/state'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<FollowupReplyInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  if (typeof body?.id !== 'string' || (body.answer !== null && typeof body.answer !== 'object')) {
    return jsonError(400, '缺少 id 或 answer')
  }
  const entry = pendingFollowups.get(body.id)
  if (!entry) return Response.json({ resolved: false })
  pendingFollowups.delete(body.id)
  entry.resolve(body.answer)
  return Response.json({ resolved: true })
}
