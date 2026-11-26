/**
 * acp 会话的权限档位（ACP Session Modes 规范：agent 在 session/new / load 里广告
 * `modes.availableModes`，客户端用 `session/set_mode` 切换）。
 *
 * GET  /api/acp/agents/:id/mode?conversationId=<会话 id>   → 查询档位与当前档
 * POST /api/acp/agents/:id/mode  { conversationId, modeId } → 切换档位
 *
 * 只操作**已激活**的会话（进程活着），不起探针进程；agent 没广告档位时
 * GET 返回 `supported: false`，界面据此隐藏档位切换 pill。
 */
import { getAcpSessionModes, getAcpSessionSnapshot, setAcpSessionMode } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { acpMcpServers } from '@/lib/server/acp-mcp'
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
          ...(conversation.acpSessionId ? { loadSessionId: conversation.acpSessionId } : {})
        }
      : undefined
  const result = await setAcpSessionMode(id, conversationId, modeId, activate)
  if (result.ok) {
    // 持久化用户选的档：清单以 agent 当前广告的为准，`current` 记用户意图（下一轮下发 / 刷新后仍在）
    const snap = getAcpSessionSnapshot(id, conversationId)
    const prev = domain.getConversation(conversationId)
    // configId 有值 = 这条模式走 configOptions 通道（opencode），必须一起持久化
    const configId = snap?.modes?.configId ?? prev?.acpModes?.configId
    domain.setAcpSessionState(conversationId, {
      acpModes: {
        available: snap?.modes?.available ?? prev?.acpModes?.available ?? [],
        current: modeId,
        ...(configId ? { configId } : {})
      }
    })
  }
  return Response.json(result)
}
