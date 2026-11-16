/**
 * 这个外部 Agent 的**完整能力快照**（模型清单 + 模式 / 思考档）。
 * GET /api/acp/agents/:id/capabilities
 *
 * 与 `/models` 是同一次探针：ACP 没有「列能力」方法，模型与档位都是 agent 在
 * `session/new` 应答里广告的，所以要真起一次它的进程问一句（一次性会话，问完就收掉）。
 *
 * 为什么要多这一个接口：「开始新对话」页在**建会话之前**选中 ACP agent 时，输入框上方
 * 那排模式 / 思考档 pill 需要有数据，而这些数据平时只存在会话配置里。
 */
import { probeAcpCapabilities, type AcpAgentConfig } from "@fizz/acp";
import { domain } from "@/lib/server/state";
import { acpProbeCwd } from "@/lib/server/acp-probe";
import { describeError, jsonError } from "@/app/api/_lib/auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let agent: AcpAgentConfig;
  try {
    agent = domain.resolveAcpAgent(id);
  } catch (err) {
    const { status, message } = describeError(err);
    return jsonError(status, message);
  }
  try {
    // 探测只需要一个能起的 cwd：优先用第一个**目录还在**的项目（agent 的启动参数里可能读项目配置）
    const workspacePath = acpProbeCwd();
    return Response.json(
      await probeAcpCapabilities({
        agent,
        ...(workspacePath ? { workspacePath } : {}),
      }),
    );
  } catch (err) {
    const { status, message } = describeError(err);
    return jsonError(status, message);
  }
}
