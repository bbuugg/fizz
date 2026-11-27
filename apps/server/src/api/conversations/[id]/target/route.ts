/**
 * 设置 / 清除会话记住的模型、MCP 与浏览器偏好。
 * PATCH /api/conversations/:id/target
 *
 * body: ConversationTargetInput
 * 字段显式传 null = 清除（回到「默认」）；undefined = 不动该项。
 */
import type { ConversationTargetInput, ConversationTargetResult } from '@fizz/contracts/agent-api'
import { setAcpSessionModel } from '@fizz/acp'
import {
  agentBrowserSessionId,
  DEFAULT_BROWSER_SETTINGS,
  normalizeBrowserSettings,
  type BrowserSettings
} from '@fizz/contracts'
import { browserSessions } from '@fizz/tools'
import { domain } from '@/lib/server/state'
import { acpMcpServers } from '@/lib/server/acp-mcp'
import { refreshAcpSessionState } from '@/lib/server/acp-session-state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<ConversationTargetInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    const before = domain.getConversation(id)
    const next = domain.setConversationTarget(id, body)
    if (next.backend === 'acp' && next.configId && typeof body.modelId === 'string' && next.modelId) {
      const workspace = domain.getWorkspace(next.workspaceId)
      if (!workspace?.path) return jsonError(400, 'ACP 会话需要绑定到有目录的工作区')
      const result = await setAcpSessionModel(next.configId, id, next.modelId, {
        agent: domain.resolveAcpAgent(next.configId),
        workspacePath: workspace.path,
        mcpServers: acpMcpServers(domain.listMcpServers(), next.mcpServerIds),
        ...(next.acpSessionId ? { loadSessionId: next.acpSessionId } : {})
      })
      if (!result.ok) return jsonError(400, result.error ?? '切换模型失败')
      if (!result.deferred) {
        refreshAcpSessionState(id, next.configId)
        const current = domain.getConversation(id)!
        return Response.json({ acpSessionState: {
          modes: current.acpModes ?? null,
          thoughtLevel: current.acpThoughtLevel ?? null
        } } satisfies ConversationTargetResult)
      }
    }
    /**
     * 只有**来源（`channel`）真的变了**才把这个会话的浏览器收掉：引擎 `start()` 头一行是
     * 「已经有 browser 就直接返回」，不收的话面板里还是旧来源，看起来像「设置没生效」。
     *
     * `enabled` **不在此列** —— 它只决定下一轮挂不挂 `browser_*` 工具，跟已经在跑的浏览器
     * 进程毫无关系。以前按「`browserSettings` 传了就收」写，于是在输入框上方点一下那颗
     * Globe 开启工具，右侧面板里正跑着的浏览器就被关掉，只剩「浏览器未启动 / 连接已断开」。
     *
     * 现在 `channel` 归一化后恒为 `bundled`（界面上的来源选择已撤，见 contracts/browser.ts），
     * 所以这一收实际不会触发；留着是为了将来真加了来源时不用再想起这条。
     */
    const channelOf = (settings: BrowserSettings | undefined): string =>
      (settings ? normalizeBrowserSettings(settings) : DEFAULT_BROWSER_SETTINGS).channel
    if (
      body.browserSettings !== undefined &&
      channelOf(before?.browserSettings) !== channelOf(next.browserSettings)
    ) {
      await browserSessions
        .close(agentBrowserSessionId(id), '浏览器来源已改')
        .catch(() => undefined)
    }
    return new Response(null, { status: 204 })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
