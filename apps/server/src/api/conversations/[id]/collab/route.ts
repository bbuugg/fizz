/**
 * 协作会话配置与运行态：
 *
 * - `GET  /api/conversations/:id/collab` → 运行态快照（任务 / 消息 / 最近状态）
 * - `PATCH /api/conversations/:id/collab` → 全量覆盖协作配置（增删改 Agent / 并行与单轮上限）
 *
 * 运行态独立于会话主文件（`collab.json`），所以这里不返回会话对象，避免把大消息体带上。
 */
import type { ConversationCollabInput } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const conversation = domain.getConversation(id)
  if (!conversation) return jsonError(404, '会话不存在')
  if (conversation.kind !== 'collab') return jsonError(400, '这不是多智能体协作会话')
  try {
    const state = (await domain.getCollabState(id)) ?? {
      version: 1 as const,
      tasks: [],
      messages: [],
      statuses: {},
      updatedAt: Date.now()
    }
    return Response.json({ collab: state })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<ConversationCollabInput>(request)
  if (!body || !body.collab || typeof body.collab !== 'object') {
    return jsonError(400, '缺少 collab 配置')
  }
  try {
    domain.setConversationCollab(id, body.collab)
    return Response.json(domain.getConversation(id))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
