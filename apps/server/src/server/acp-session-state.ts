/**
 * ACP 会话运行态（Session Modes / 思考档）的**刷新合并规则**。
 *
 * 会话里记的 `current` 是**用户意图**，不是 agent 的运行时状态：`session/new` 与
 * `session/load` 会带上 agent 侧的清单与它自己的当前值，直接覆盖会把用户选的档冲掉
 * （load 之后 agent 常被重置成默认档）。规则（见 spec 4.5.1）：
 *
 * - 未收到完整配置时的 `null` → 保留；完整配置明确缺项 → 清除旧档位；
 * - 清单 / 候选项用 agent 报的覆盖；
 * - `current` 仍是用户意图：它还在新清单里就保留，否则回落成 agent 报的当前值。
 */
import type { AcpModesState, AcpThoughtLevelState } from '@fizz/contracts/types'
import { getAcpSessionSnapshot, setAcpSessionConfigListener } from '@fizz/acp'
import { domain } from '@/lib/server/state'

/** 合并 Session Modes 快照（保留用户选的档，见文件头规则） */
export function mergeAcpModes(
  prev: AcpModesState | undefined,
  incoming: AcpModesState | null,
  configOptionsKnown = false
): AcpModesState | undefined {
  // Session Modes 与 configOptions 是两条通道，完整配置只能明确移除后者。
  if (!incoming) return configOptionsKnown && prev?.configId ? undefined : prev
  const current =
    prev?.current && incoming.available.some((m) => m.id === prev.current)
      ? prev.current
      : incoming.current
  // configId 表示「这条模式走 configOptions 通道」（opencode），必须跟着 incoming 一起换
  return {
    available: incoming.available,
    current,
    ...(incoming.configId ? { configId: incoming.configId } : {})
  }
}

/** 合并思考档快照（同上） */
export function mergeAcpThoughtLevel(
  prev: AcpThoughtLevelState | undefined,
  incoming: AcpThoughtLevelState | null,
  configOptionsKnown = false
): AcpThoughtLevelState | undefined {
  if (!incoming) return configOptionsKnown ? undefined : prev
  const current =
    prev?.current && incoming.options.some((o) => o.value === prev.current)
      ? prev.current
      : incoming.current
  return { configId: incoming.configId, current, options: incoming.options }
}

/**
 * 把当前 entry 的运行态刷新进会话配置（保留用户意图）。
 *
 * 用在两个时机：打开会话（`session/load` 回放后）与每轮 `session/new` / `session/load`
 * 之后。进程不在（没有 entry）时什么都不做 —— 会话里已有的值保持不变。
 * 标脏由 `domain` 的 `store.mutate` 自动完成（`STORE_KEYS` 含 `conversations`），无需手动。
 */
export function refreshAcpSessionState(conversationId: string, agentId: string): void {
  const snap = getAcpSessionSnapshot(agentId, conversationId)
  if (!snap) return
  const conversation = domain.getConversation(conversationId)
  if (conversation?.backend !== 'acp' || conversation.configId !== agentId) return
  setAcpSessionConfigListener(agentId, conversationId, () => refreshAcpSessionState(conversationId, agentId))
  const acpModes = mergeAcpModes(conversation.acpModes, snap.modes, snap.configOptionsKnown)
  const acpThoughtLevel = mergeAcpThoughtLevel(conversation.acpThoughtLevel, snap.thoughtLevel, snap.configOptionsKnown)
  domain.setAcpSessionState(conversationId, {
    ...(acpModes || conversation.acpModes ? { acpModes: acpModes ?? null } : {}),
    ...(acpThoughtLevel || conversation.acpThoughtLevel ? { acpThoughtLevel: acpThoughtLevel ?? null } : {})
  })
}
