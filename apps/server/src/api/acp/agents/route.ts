/**
 * ACP agent 配置路由：列表 / 创建 / 设默认 / 删除。
 * GET    /api/acp/agents
 * POST   /api/acp/agents
 * POST   /api/acp/agents/:id/default
 * DELETE /api/acp/agents/:id
 */
import { probeAcpModels, type AcpAgentConfig } from '@fizz/acp'
import type {
  AcpAgentInput,
  DetectedAcpAgent
} from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { acpAgentViews } from '@/lib/server/acp-agent-views'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  // 出口处补 `imageInput`（探测值不落盘），与 WS 快照共用同一份拼装
  return Response.json(acpAgentViews(domain.listAcpAgents()))
}

export async function POST(request: Request) {
  const input = await parseJsonBody<AcpAgentInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')
  try {
    return Response.json(domain.saveAcpAgent(input))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
