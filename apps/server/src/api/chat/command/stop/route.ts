/**
 * 单条命令停止：POST /api/chat/command/stop
 *
 * 形状照抄 confirm 路由（「另开的一条 HTTP 请求」）：SSE 只有下行，停一条在跑的
 * bash 要一条并行上行。命中 `run.commandStops` 就杀那一条命令的进程树
 * （工具结果收尾成「（已中止）」，Agent 同一回合据此收场，整轮不受影响）。
 *
 * 幂等：命令已结束 / run 已结束 / toolCallId 拼错 = `{ stopped: false }`，不报错。
 */
import type { CommandStopInput } from '@fizz/contracts/agent-api'
import { getRun } from '@/lib/server/chat-run'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<CommandStopInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  if (typeof body?.requestId !== 'string' || typeof body?.toolCallId !== 'string') {
    return jsonError(400, '缺少 requestId 或 toolCallId')
  }
  const run = getRun(body.requestId)
  // run 不存在 / 已结束 = 没东西可停（幂等空成功）
  if (!run || run.finishedAt !== undefined) return Response.json({ stopped: false })
  const stop = run.commandStops.get(body.toolCallId)
  // 这条命令不在跑（已自然结束 / 已超时被收掉）= 空成功
  if (!stop) return Response.json({ stopped: false })
  stop()
  return Response.json({ stopped: true })
}
