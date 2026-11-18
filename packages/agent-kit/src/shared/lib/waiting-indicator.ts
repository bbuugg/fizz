/**
 * 流式末条消息底部状态槽的判据（纯函数，调用处见 `chat-surface` 的 `MessageList`）。
 *
 * 抽出来是为了能单独测：这里踩过一次回归 —— **轮前压缩结束后 `parts` 还是空的**，
 * 旧判断按「有没有压缩卡」把状态行整个藏成 invisible 占位，用户看到摘要写完、
 * 静默等很久，模型才开始干活。压缩卡只在**流式**期间自己转圈；`done` 之后空 parts
 * 就只可能是在等模型第一步。
 */
import type { AgentMessagePart } from '@fizz/contracts/types'
import { toolState } from '@fizz/agent-kit/shared/lib/parts'
import type { ContextCompactionState } from '@fizz/agent-kit/shared/lib/stores/slices/conversation'

/**
 * `status`：显示真状态行（正在思考… / 第 N 次重试 / 正在重连）；
 * `placeholder`：没什么可报，但**仍然占住那一行高度**（`ThinkingRow placeholder`）；
 * `hidden`：槽位整个不挂（压缩摘要还在流，卡自己转圈）。
 */
export type WaitingIndicatorSlot = 'status' | 'placeholder' | 'hidden'

/**
 * 整轮还在跑，但**最后一段已经落地**、正在等模型下一步输出 —— 这时要在消息底部把最初那个
 * 「正在思考…」补回来，否则界面看着像已经结束了（用户要求：「思考结束了、工具调用结束了，
 * 下方应该显示刚开始那个思考中的效果，直到有其他消息或者停止」）。
 *
 * 判据只看**尾段自己有没有「正在进行」的观感**，有就不补：
 * - `text`：正文还在流，本身就是进行中；
 * - `reasoning`：思考条的触发器在 streaming 时自己闪着「正在思考…」（`ShimmerLabel`）；
 * - `tool-call` **还没出结果**：卡片上是 Running 徽章 —— 出了结果（`hasOutput`）才算落地；
 * - 孤儿 `tool-result`：落地。
 *
 * 这个判据顺带把「在等用户」的情况排掉了：`ask` 和「等审批」的工具都还没有
 * output，所以不会在那种时刻冒出「正在思考…」误导人。
 */
export function isWaitingNextStep(parts: AgentMessagePart[]): boolean {
  const last = parts[parts.length - 1]
  // 一个 part 都还没有的情况由 `waitingIndicatorSlot` 单独认（同一个状态行）
  if (!last) return false
  if (last.type === 'text' || last.type === 'reasoning') return false
  if (last.type === 'tool-call') return toolState(last).hasOutput
  return true
}

/**
 * 状态槽该显示什么。
 *
 * - 压缩摘要还在流：槽位不挂（卡自己带 loader，再叠一条「正在思考」会像两个进度）；
 * - 本轮还没有任何 part：**就是在等模型**。典型是轮前压缩刚 `done`、第一步请求还没吐字 ——
 *   这里不能再按「有没有压缩卡」排除，否则摘要结束后整段静默；
 * - 其余交给 `isWaitingNextStep`。
 */
export function waitingIndicatorSlot(
  parts: AgentMessagePart[],
  compaction: ContextCompactionState | null | undefined
): WaitingIndicatorSlot {
  if (compaction?.status === 'streaming') return 'hidden'
  if (parts.length === 0) return 'status'
  return isWaitingNextStep(parts) ? 'status' : 'placeholder'
}
