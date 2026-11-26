/**
 * acp 会话的**思考档**（ACP configOptions 的 `category: 'thought_level'`，`pi` 用它）。
 *
 * POST /api/acp/agents/:id/thought-level  { conversationId, value }  → 切换思考档
 *
 * 与 `mode` 路由同形：只操作**已激活**的会话（进程活着），成功后把用户选的档
 * 持久化到会话配置（`acpThoughtLevel.current` = 用户意图），下一轮发送前按它下发。
 */
import { getAcpSessionSnapshot, setAcpSessionThoughtLevel } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { acpMcpServers } from '@/lib/server/acp-mcp'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<{ conversationId?: string; value?: string }>(request)
  if (!body?.conversationId || !body?.value) {
    return jsonError(400, '缺少 conversationId 或 value')
  }
  const conversationId = body.conversationId
  // 未激活就切档 → 自动激活（与 mode 路由同一套，见那边注释）
  const conversation = domain.getConversation(conversationId)
  const workspace = conversation ? domain.getWorkspace(conversation.workspaceId) : null
  const agent = domain.listAcpAgents().find((a) => a.id === id)
  const activate =
    conversation?.backend === 'acp' && conversation.configId === id && workspace && agent
      ? {
          agent,
          workspacePath: workspace.path,
          mcpServers: acpMcpServers(domain.listMcpServers(), conversation.mcpServerIds),
          ...(conversation.acpSessionId ? { loadSessionId: conversation.acpSessionId } : {})
        }
      : undefined
  const result = await setAcpSessionThoughtLevel(id, conversationId, body.value, activate)
  if (result.ok) {
    // 持久化用户选的档（清单 / configId 以 agent 当前广告的为准）
    const snap = getAcpSessionSnapshot(id, conversationId)
    const prev = domain.getConversation(conversationId)
    const options = snap?.thoughtLevel?.options ?? prev?.acpThoughtLevel?.options ?? []
    const configId = snap?.thoughtLevel?.configId ?? prev?.acpThoughtLevel?.configId ?? ''
    if (configId) {
      domain.setAcpSessionState(conversationId, {
        acpThoughtLevel: { configId, current: body.value, options }
      })
    }
  }
  return Response.json(result)
}
