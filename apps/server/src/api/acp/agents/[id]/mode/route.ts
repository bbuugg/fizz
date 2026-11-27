/**
 * ACP 会话模式：优先 configOptions 的 mode，兼容旧 Session Modes，不解释为权限档。
 *
 * GET  /api/acp/agents/:id/mode?conversationId=<会话 id>   → 查询档位与当前档
 * POST /api/acp/agents/:id/mode  { conversationId, modeId } → 切换档位
 *
 * GET 只读已激活会话，不起探针；POST 可恢复所选模型后切换模式。
 * Agent 未提供模式时 GET 返回 `supported: false`。
 */
import { getAcpSessionModes, getAcpSessionSnapshot, setAcpSessionMode } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { acpMcpServers } from '@/lib/server/acp-mcp'
import { refreshAcpSessionState } from '@/lib/server/acp-session-state'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')?.trim()
  if (!conversationId) return jsonError(400, '缺少 conversationId')
  return Response.json(getAcpSessionModes(id, conversationId))
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<{ conversationId?: string; modeId?: string }>(request)
  if (!body?.conversationId || !body?.modeId) {
    return jsonError(400, '缺少 conversationId 或 modeId')
  }
  const conversationId = body.conversationId
  const modeId = body.modeId
  // 未激活就切档 → 自动激活（方案 A）：与「重新打开会话」同一条激活路径（spawn +
  // session/load），激活后立即切换。缺会话 / 工作区记录时退回旧行为（报「未激活」）。
  const conversation = domain.getConversation(conversationId)
  const workspace = conversation ? domain.getWorkspace(conversation.workspaceId) : null
  const agent = domain.listAcpAgents().find((a) => a.id === id)
  const activate =
    conversation?.backend === 'acp' && conversation.configId === id && workspace && agent
      ? {
          agent,
          workspacePath: workspace.path,
          mcpServers: acpMcpServers(domain.listMcpServers(), conversation.mcpServerIds),
          ...(conversation.modelId ? { modelId: conversation.modelId } : {}),
          ...(conversation.acpSessionId ? { loadSessionId: conversation.acpSessionId } : {})
        }
      : undefined
  const result = await setAcpSessionMode(id, conversationId, modeId, activate)
  if (result.ok) {
    // 持久化用户选的档：清单以 agent 当前广告的为准，`current` 记用户意图（下一轮下发 / 刷新后仍在）
    const snap = getAcpSessionSnapshot(id, conversationId)
    const prev = domain.getConversation(conversationId)
    // 快照已知时连同通道一起采用，不能把旧 configId 补回当前的 Session Modes。
    const configId = snap ? snap.modes?.configId : prev?.acpModes?.configId
    domain.setAcpSessionState(conversationId, {
      acpModes: {
        available: snap?.modes?.available ?? prev?.acpModes?.available ?? [],
        current: modeId,
        ...(configId ? { configId } : {})
      }
    })
    refreshAcpSessionState(conversationId, id)
  }
  return Response.json(result)
}
