/**
 * ACP agent 列表的出口形态：落盘配置 + 一条**运行时探测值**。
 *
 * 为什么探测值不能进 `domain.listAcpAgents()`：`imageInput` 来自 `initialize`，
 * 进程重启就没了、也不该落盘（下次连接会重新广告），而 `packages/workspace` 那边
 * 是「只认落盘真源」的。所以拼在服务端出口处，GET 列表与 WS 快照共用这一份 ——
 * 两边各拼一套就会出现「设置页说能发图、输入框却不给回形针」。
 */
import { getAcpImageSupport } from '@fizz/acp'
import type { AcpAgentView } from '@fizz/contracts/agent-api'

/** 给每个 agent 补上 `imageInput`（未探测过的不加字段 = 前端按「乐观显示」处理） */
export function acpAgentViews(agents: AcpAgentView[]): AcpAgentView[] {
  return agents.map((agent) => {
    const imageInput = getAcpImageSupport(agent.id)
    return typeof imageInput === 'boolean' ? { ...agent, imageInput } : agent
  })
}
