/**
 * 运行中切换权限档：POST /api/chat/permission
 *
 * 形状照抄 command/stop 路由（「另开的一条 HTTP 请求」）：SSE 只有下行，用户在一轮
 * 中途用输入框那颗 pill 切档时要一条并行上行。命中 `run.permissionMode` 就改那一轮
 * 的**活档** —— `runAgent` 拿的是 `() => run.permissionMode`，闸门每次工具调用现取，
 * 改完**下一次工具调用立刻按新档裁决**（不必等下一轮）。
 *
 * 幂等：run 不存在 / 已结束 / 档位非法之外的拼错 = `{ updated: false }`，不报错。
 */
import type { PermissionSetInput } from '@fizz/contracts/agent-api'
import { getRun } from '@/lib/server/chat-run'
import { isAiPermissionMode } from '@/lib/server/permission-mode'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<PermissionSetInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  if (typeof body?.requestId !== 'string' || typeof body?.permissionMode !== 'string') {
    return jsonError(400, '缺少 requestId 或 permissionMode')
  }
  if (!isAiPermissionMode(body.permissionMode)) {
    return jsonError(400, 'permissionMode 非法')
  }
  const run = getRun(body.requestId)
  // run 不存在 / 已结束 = 没东西可改（幂等空成功；下一轮会带新的档位正常开跑）
  if (!run || run.finishedAt !== undefined) return Response.json({ updated: false })
  run.permissionMode = body.permissionMode
  return Response.json({ updated: true })
}
