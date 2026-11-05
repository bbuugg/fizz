/**
 * 归档 / 取消归档会话：PATCH /api/conversations/:id/archive（body: { archived }）。
 *
 * 归档**不删任何数据**，只是给会话打一个 `archivedAt` 时间戳；侧栏据此把它从项目树
 * 收进「已归档」区。取回就是再 PATCH 一次 `archived: false`。
 *
 * 归档前会先停掉这一轮正在跑的对话（`stopConversationRun`）：归档是「这条会话先放下」，
 * 不该还有工具在后台跑、命令在占端口；等收尾落盘后再写 `archivedAt`，历史里能看到
 * 已经产生的半截回复。取消归档（`archived: false`）不停，人对旧会话的取回不涉及运行态。
 *
 * 应答回**整份会话清单**（与重命名 / 删除一致）：前端 store 直接 `set({ conversations })`，
 * 不用再发一次列表请求；跨标签页也由全局状态 WS 的 `conversations` 快照同步。
 */
import type { ConversationArchiveInput } from '@fizz/contracts/agent-api'
import { stopConversationRun } from '@/lib/server/chat-run'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<ConversationArchiveInput>(request)
  if (!body || typeof body.archived !== 'boolean') {
    return jsonError(400, '缺少 archived（布尔）')
  }
  try {
    // 先停再归档：等 run 收尾（含半截正文落盘）后再改状态，避免归档后被收尾写覆盖
    if (body.archived) await stopConversationRun(id)
    domain.setConversationArchived(id, body.archived)
    return Response.json(domain.listConversations())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
