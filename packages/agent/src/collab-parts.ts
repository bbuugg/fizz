/**
 * 子 Agent 一轮任务的**过程记录**（parts 累积 + 落盘裁剪）。
 *
 * 为什么需要它：子 Agent 没有会话记录，`CollabTask` 原先只存 `prompt` 与最终 `output`。
 * 于是右侧面板里一轮任务只有「一问一答两段纯文本」—— 主对话那边每轮都有的思考折叠条、
 * 一行行工具调用（`read · 路径`）、可展开的输出，子 Agent 一概没有，观感差得很远。
 *
 * 形状刻意与主消息完全同构（`AgentMessagePart[]`）：`CollabAgentChatPanel` 把它交给同一个
 * `MessageList`，折叠条 / 工具卡 / 代码块就都是同一套渲染，不用为子 Agent 再写一套 UI。
 * 与内置子任务的 `SubagentDelegation.parts` 同一口径。
 *
 * ## 为什么要裁剪
 *
 * 这些 parts 会随 `collab.json` 落盘，而 `snapshot()` 保留最近 200 个任务。一轮
 * `find /` + `read` 的输出很容易几万字符 —— 不设预算，一个协作会话就能把盘写爆，
 * 而且前端每次收状态都要把整坨 JSON 传一遍。所以收口时按字符预算从**最新的 part 往前**
 * 保留，更早的一律丢掉，只留一句「更早的过程已省略」。
 */
import type { AgentMessagePart } from '@fizz/contracts/types'

/** 单条 part 的文本上限 */
const PART_TEXT_LIMIT = 4_000
/** 一轮任务过程记录的总字符预算 */
const PART_BUDGET = 16_000
/** 一轮任务最多保留多少个 part */
const PART_MAX = 60

/*
 * 累积 / 折叠这两个动作**前后端共用**，实现在 `@fizz/contracts/types`：
 * 服务端收口 `CollabTask.parts`，前端拼运行中的实时预览，两处口径必须一致 ——
 * 否则工具卡在「任务跑完、快照覆盖上来」的那一刻会跳一下（比如文本分段位置变了）。
 */
export {
  appendPartDelta,
  appendToolCallPart as appendToolCall,
  foldToolResult
} from '@fizz/contracts/types'

/** 一条 part 的大致字符开销（只需量级正确，不必精确） */
function partWeight(part: AgentMessagePart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text.length
    case 'tool-call':
      return textLength(part.input) + (part.output === undefined ? 0 : textLength(part.output))
    default:
      return 0
  }
}

function textLength(value: unknown): number {
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value ?? '').length
  } catch {
    return 0
  }
}

/** 超长值降级成截断字符串：渲染端对字符串照样能展示，不至于整段丢掉 */
function clampValue(value: unknown, limit: number): unknown {
  if (typeof value === 'string') {
    return value.length > limit ? `${value.slice(0, limit)}\n…（已截断）` : value
  }
  const text = textLength(value)
  if (text <= limit) return value
  try {
    return `${JSON.stringify(value ?? '').slice(0, limit)}\n…（已截断）`
  } catch {
    return '（内容过大，已省略）'
  }
}

function clampPart(part: AgentMessagePart): AgentMessagePart {
  if (part.type === 'text' || part.type === 'reasoning') {
    if (part.text.length <= PART_TEXT_LIMIT) return part
    return { ...part, text: `${part.text.slice(0, PART_TEXT_LIMIT)}\n…（已截断）` }
  }
  if (part.type === 'tool-call') {
    return {
      ...part,
      input: clampValue(part.input, PART_TEXT_LIMIT),
      ...(part.output === undefined ? {} : { output: clampValue(part.output, PART_TEXT_LIMIT) })
    }
  }
  return part
}

/**
 * 收口：按预算保留最近的过程记录。
 *
 * 从尾部往前累计，超预算（或超条数）就停 —— 用户最关心的是「最后几步做了什么」，
 * 开头那几步在被折叠的思考 / 工具卡里本来也看不到。
 */
export function trimCollabParts(parts: readonly AgentMessagePart[]): AgentMessagePart[] {
  const kept: AgentMessagePart[] = []
  let budget = PART_BUDGET
  let dropped = false
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (!part) continue
    if (kept.length >= PART_MAX) {
      dropped = true
      break
    }
    const weight = partWeight(part)
    // 至少留一条：最后一步本身就是超大工具输出时，宁可截断它也不能什么都不给
    if (weight > budget && kept.length > 0) {
      dropped = true
      break
    }
    budget -= weight
    kept.push(part)
  }
  const ordered = kept.reverse().map(clampPart)
  if (!dropped) return ordered
  return [{ type: 'text', text: '（更早的过程已省略）' }, ...ordered]
}
