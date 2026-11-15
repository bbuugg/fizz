/**
 * 子 Agent 的工具白名单过滤。
 *
 * 抽成纯函数是为了能单测：`CollabRuntime` 那条链路要 mock 模型与 agent 循环，
 * 而这里真正要保证的只是一句 `entries().filter()` 的取舍口径。
 */

/**
 * 不受 `agent.tools` 白名单约束的工具。
 *
 * `skill` 必须在这里：技能清单是**系统提示词**里的固定一段（`buildAgentSetup`
 * 按 `opts.skills` 自动拼进去），提示词还明确写着「判断任务与某个技能相关时，先调用
 * skill 读完整说明」。白名单一旦把它挡掉，模型就是「看得见清单、手里没有读的
 * 工具」—— 只会回一句「我没有读取技能的能力」，而主智能体还当它能用。
 *
 * 放行它不扩大权限面：只读，且读写范围被 `buildReadSkillTool` 锁在已发现的技能目录内。
 * 它也不在配置弹窗的勾选项里（`AgentConfigDialog` 的 `TOOL_OPTIONS`），用户没有
 * 「主动取消」这个动作，所以放行不会造成「配置说不用、实际在用」的矛盾。
 */
const ALWAYS_ALLOWED: readonly string[] = ['skill']

/**
 * 按白名单挑工具。
 *
 * `tools` 里没有的键自然跳过 —— 配置里留着已下线的工具名（或某个环境不提供的工具，
 * 比如没有后台通道时的 `run_in_background`）不会炸掉整轮。
 */
export function pickCollabTools(
  tools: Record<string, unknown>,
  allowed: Iterable<string>
): Record<string, unknown> {
  const keys = new Set(allowed)
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => keys.has(name) || ALWAYS_ALLOWED.includes(name))
  )
}
