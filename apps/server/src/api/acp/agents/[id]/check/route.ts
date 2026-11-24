/**
 * 检测这个 ACP agent 是否能正常启动并完成握手。
 * POST /api/acp/agents/:id/check
 *
 * 复用 `probeAcpModels`：一次 `session/new` 同时拿到模型清单，所以「检测可用性」与
 * 「刷新模型缓存」是同一趟，不需要再起第二个进程。
 *
 * 成功和失败都写进 `AcpAgentConfig.health`（失败也是检测结论，返回 200 +
 * `{ ok: false, error }`）；只有 agent 找不到 / 检测期间命令被改掉才走错误状态。
 */
import { AcpSpawnError, probeAcpModels, type AcpAgentConfig } from '@fizz/acp'
import { acpAgentKey, type AcpAgentCheckResult } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { acpProbeCwd } from '@/lib/server/acp-probe'
import { describeError, jsonError } from '@/app/api/_lib/auth'

/** 同时只跑一趟：多个客户端一起点「检测」时别把 agent 进程堆起来 */
const inFlightChecks = new Map<string, Promise<AcpAgentCheckResult>>()

/** 错误摘要进 tooltip：压成一行并截断，避免把整段 stderr 塞进配置 */
const MAX_ERROR_CHARS = 400

function summarizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const text = raw.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim()
  return text.slice(0, MAX_ERROR_CHARS) || '检测失败（没有返回错误信息）'
}

async function runCheck(
  id: string,
  agent: AcpAgentConfig,
  expectedKey: string
): Promise<AcpAgentCheckResult> {
  const workspacePath = acpProbeCwd()
  try {
    const choices = await probeAcpModels({
      agent,
      ...(workspacePath ? { workspacePath } : {})
    })
    const view = domain.recordAcpAgentCheck(id, {
      expectedKey,
      health: { status: 'ok', checkedAt: Date.now() },
      models: choices.options
    })
    return { ok: true, agent: view }
  } catch (err) {
    const error = summarizeError(err)
    const detail = err instanceof AcpSpawnError ? err.detail : undefined
    const view = domain.recordAcpAgentCheck(id, {
      expectedKey,
      health: {
        status: 'error',
        checkedAt: Date.now(),
        error,
        ...(detail ? { detail } : {})
      }
    })
    return { ok: false, error, agent: view }
  }
}

export async function POST(
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

  const pending = inFlightChecks.get(id)
  if (pending) {
    try {
      return Response.json(await pending)
    } catch (err) {
      const { status, message } = describeError(err)
      return jsonError(status, message)
    }
  }

  const task = runCheck(id, agent, acpAgentKey(agent))
  inFlightChecks.set(id, task)
  try {
    return Response.json(await task)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  } finally {
    inFlightChecks.delete(id)
  }
}