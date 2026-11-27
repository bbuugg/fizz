/**
 * 对话路由（SSE）：发一轮对话。
 * POST /api/chat
 *
 * 一轮对话的启动逻辑都在 `lib/server/chat-turn.ts` 的 `startTurn`（定时任务调度器
 * 起无人值守会话也走同一个服务），这里只剩 HTTP 的壳：
 * - 解析请求体 → startTurn → 把 run 接到这条 SSE 连接上（pipeRun）；
 * - 客户端断开 = 只退订，run 继续跑完并照常落盘（已产生的正文一点不少）；
 *   刷新后 / 切回会话时若发现 run 还在跑，用 GET /api/chat/stream?requestId=
 *   重新 attach：先回放帧日志再转直播，现场就回来了
 * - POST /api/chat/abort（用户点「停止」，或按 conversationId 兜底停孤儿 run）
 *   才会提前结束这一轮
 *
 * 审批 / 提问都是「服务端暂停等用户点一下」，SSE 没有上行，
 * 所以走另开的一条 HTTP 请求（POST /api/chat/confirm / /api/chat/followup）。
 *
 * 本轮同时往**全局状态 WS** 广播「瞬时事件」（`emitServerEvent`，见
 * `@fizz/contracts/types` 的 `ServerEvent`）：SSE 只发给发起这一轮的连接，
 * 别的标签页 / 别的会话靠这些事件知道「有会话在等你点头」「有会话跑完了」，
 * 好实时更新侧栏状态并发系统通知。事件是广播的，不带正文 —— 正文仍然只走 SSE。
 */
import type { ChatRequest } from '@fizz/contracts/agent-api'
import { startTurn } from '@/lib/server/chat-turn'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { pipeRun } from '@/app/api/_lib/chat-stream'

export async function POST(request: Request) {
  const body = await parseJsonBody<ChatRequest>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  const started = await startTurn(body)
  if (!started.ok) return jsonError(started.status, started.message)
  return pipeRun(started.run)
}
