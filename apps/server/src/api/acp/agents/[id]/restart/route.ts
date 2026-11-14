/**
 * 重启 acp 会话：**杀掉 agent 进程、保留 sessionId，并立刻重连**。
 *
 * POST /api/acp/agents/:id/restart  { conversationId } → { ok, error? }
 *
 * 语义是「重连」而不是「新建」：`acpSessionId` 原样留着，abort 之后马上走一次
 * `replayAcpSession`（= `session/load`）把上下文接回来 —— 上下文不丢，只是 agent
 * 进程换了个新的，且**重启请求返回时新进程已经就绪**。agent 侧会话与本地历史都不动。
 *
 * 用途：让 **agent 侧的变更生效** —— 新装的 pi 权限扩展、改过的项目信任设置、agent 自己升级过。
 * 这些东西只在进程启动时读一次，老进程不会自己变。
 *
 * 会话本来就没在跑（进程早没了）时同样会重连；还没有 agent 侧 session（新会话还没发过
 * 消息）时是幂等空操作，照样返回 ok。
 */
import { abortAcpTurn, replayAcpSession } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { ensurePiConfirmExtension } from '@/lib/server/acp-extension'
import { refreshAcpSessionState } from '@/lib/server/acp-session-state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<{ conversationId?: string }>(request)
  const conversationId = body?.conversationId?.trim()
  if (!conversationId) return jsonError(400, '缺少 conversationId')

  const conversation = domain.getConversation(conversationId)
  if (!conversation) return jsonError(404, '会话不存在')
  if (conversation.backend !== 'acp') return jsonError(400, '只有外部 Agent（ACP）会话可以重启')

  /*
   * agent 以**会话里记的**为准，路径上的 `:id` 只用来拼 URL：entry 的 key 是
   * `agentId::conversationId`，拿前端传的 id 去杀，传错一个就是白杀一场（杀不到该杀的那个）。
   */
  const agentId = conversation.configId ?? id

  // 杀进程 + 丢 entry
  abortAcpTurn(agentId, conversationId)

  let agent: ReturnType<typeof domain.resolveAcpAgent>
  try {
    agent = domain.resolveAcpAgent(agentId)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }

  /*
   * 顺手补装 pi 的权限扩展：扩展同样只在进程启动时加载，而「新装的扩展」正是重启的典型用途，
   * 老会话（建立在这功能之前）也从没装过 —— 这里补上，紧接着的重连就能加载到它。
   * 装不上只 warn，不影响重启结果（这是附赠动作，不是重启的一部分）。
   */
  const workspace = domain.getWorkspace(conversation.workspaceId)
  if (workspace?.path) {
    try {
      ensurePiConfirmExtension(agent, workspace.path)
    } catch {
      // agent 配置已被删（设置里移除过）：不是重启的错，跳过装扩展即可
    }
  }

  /*
   * 立刻重连：不等下一轮消息。`replayAcpSession` 会从干净的进程走 `session/load`，
   * 上下文由 agent 侧接回；返回时新进程已经就绪。
   *
   * 还没有 agent 侧 session（新会话还没发过第一条消息）时没有东西可 load，
   * 保持幂等空操作，下一轮仍走 `session/new`。
   */
  const sessionId = conversation.acpSessionId
  if (!sessionId) return Response.json({ ok: true })
  if (!workspace?.path) return jsonError(400, '工作区目录不可用，无法重连')

  try {
    await replayAcpSession({
      agent,
      conversationId,
      workspacePath: workspace.path,
      sessionId
    })
    // load 会把 agent 广告的档位带回来：刷新进会话配置，保留用户选的档
    refreshAcpSessionState(conversationId, agentId)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, `重连失败：${message}`)
  }

  return Response.json({ ok: true })
}
