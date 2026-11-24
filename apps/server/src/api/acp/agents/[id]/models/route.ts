/**
 * 这个外部 Agent 自己能选哪些模型（设置页列候选用）。
 * GET /api/acp/agents/:id/models
 *
 * ACP 没有「列模型」方法：清单来自 agent 在 session/new 里广告的 configOptions，
 * 所以要真起一次它的进程问一句（一次性探针会话，问完就收掉）。
 */
import { AcpSpawnError, probeAcpModels, type AcpAgentConfig } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { acpProbeCwd } from '@/lib/server/acp-probe'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let agent: AcpAgentConfig
  try {
    agent = domain.resolveAcpAgent(id)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  try {
    // cwd 只用来起进程：第一个**目录还在**的项目，没有就交给 `probeAcpModels` 退回主目录
    const workspacePath = acpProbeCwd()
    return Response.json(await probeAcpModels({ agent, ...(workspacePath ? { workspacePath } : {}) }))
  } catch (err) {
    // 启动失败的结论已经是一行可读文案；命令 / 工作目录单独给，别让选择器里
    // 「加载失败：启动失败：…（路径）」叠成两层冒号
    if (err instanceof AcpSpawnError) {
      return Response.json({ error: err.message, detail: err.detail }, { status: 400 })
    }
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
