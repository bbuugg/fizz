/**
 * 流事件 → 消息 parts 的折叠:聊天(`chat-turn.ts`)与项目管理助手(`assistant-turn.ts`)
 * 共用一份「落盘形状」逻辑,保证两种会话的历史形状完全一致(前端 PartView / ai-elements
 * 直接可渲染)。
 *
 * 纯内存操作:不 emit、不落盘 —— 事件下发与持久化由调用方自己做。
 */
import type { AgentChatMessage, AgentMessagePart, AgentStreamEvent } from '@fizz/contracts/types'
import { appendPartDelta, ERROR_TEXT_PREFIX } from '@fizz/contracts/types'

/**
 * 错误占位的文本 part（`⚠️ ` 前缀，渲染成醒目的一段）。
 *
 * 前缀与前端 `shared/lib/parts.ts` 共用 contracts 里那个常量：客户端靠它把这段文本认成
 * 「错误」并挂上「重新加载」按钮（历史里只有纯文本，没有独立 part 类型可认）。
 */
export function errorPart(message: string): AgentMessagePart {
  return { type: 'text', text: `${ERROR_TEXT_PREFIX}${message}` }
}

/** 助手正文的摘要:取第一段文本(截断)当通知正文 */
export function excerptOf(parts: AgentChatMessage['parts'], max = 120): string | undefined {
  const first = parts.find((p) => p.type === 'text' && p.text.trim())
  if (!first || first.type !== 'text') return undefined
  const text = first.text.trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 把一条流事件折叠进 parts 数组(原地修改)。
 *
 * - delta 类:合并进本步内最近的一条同类型 part(见 `appendPartDelta`),没有就新建;
 * - tool-call:按 toolCallId 更新或追加;
 * - tool-result:按 toolCallId 回填输出;
 * - tool-call-delta:只喂流式渲染,不进落盘形状(落盘以完整 tool-call 的 input 为准);
 * - subagent-start / subagent-event / subagent-end:派活卡上的**子任务过程记录**,
 *   子 run 的事件递归折叠进 `part.delegation.parts`(与主消息同一套形状,所以**会落盘**);
 * - retry:整轮重来丢掉失败尝试已累积的输出;断点续跑(`resume`)只回滚到最后一个工具结果;
 * - finish / context-usage:不产生 part(finish 的 usage 由调用方自行采集)。
 */
export function foldEventIntoParts(parts: AgentMessagePart[], event: AgentStreamEvent): void {
  if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
    // 合并口径见 `appendPartDelta`：思考与正文交替流（ACP 常见）时也必须各自收成一条，
    // 否则一段正文会被拆成十几条 part，渲染端每段思考都单独成一个「思考过程」分组。
    appendPartDelta(parts, event.type === 'text-delta' ? 'text' : 'reasoning', event.delta)
  } else if (event.type === 'tool-call') {
    const index = parts.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
    if (index >= 0) {
      const call = parts[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
      parts[index] = {
        ...call,
        toolName: call.toolName && call.toolName !== 'tool' ? call.toolName : event.toolName,
        input: { ...(call.input ?? {}), ...(event.input ?? {}) },
        // agent 的展示标题单独存(ACP 的 title 不是工具名,可能是整段命令)
        ...(event.title || call.title ? { title: event.title ?? call.title } : {})
      }
    } else {
      parts.push({
        type: 'tool-call',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        ...(event.title ? { title: event.title } : {})
      })
    }
  } else if (event.type === 'tool-result') {
    const index = parts.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
    if (index >= 0) {
      // 收窄成 tool-call 变体再写 `output` / `isError`：这两个字段就定义在它上面
      // （见 contracts 的 AgentMessagePart），不需要再强转整个 union。
      const call = parts[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
      parts[index] = {
        ...call,
        output: event.output,
        ...(event.isError ? { isError: true } : {})
      }
    } else {
      parts.push({
        type: 'tool-result',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
        ...(event.isError ? { isError: true } : {})
      })
    }
  } else if (event.type === 'subagent-start') {
    /**
     * 派活开跑:在**派活卡**上建一份过程记录。找不到卡就丢弃 —— 父侧 tool-call 一定
     * 先于 start 到达(引擎先发 tool-call 才开始执行工具),丢了只是少一份过程记录。
     */
    const index = parts.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
    if (index < 0) return
    const call = parts[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
    parts[index] = {
      ...call,
      delegation: {
        subagentId: event.subagentId,
        task: event.task,
        parts: [],
        status: 'running',
        startedAt: Date.now()
      }
    }
  } else if (event.type === 'subagent-event') {
    // 子 run 的过程事件:递归折叠进它自己那份 parts —— 与主消息用**同一个函数**,
    // 这正是「勾进子任务后看到的消息流和主任务完全一样」的保证。
    const index = parts.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
    if (index < 0) return
    const call = parts[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
    if (!call.delegation) return
    foldEventIntoParts(call.delegation.parts, event.event)
  } else if (event.type === 'subagent-end') {
    const index = parts.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
    if (index < 0) return
    const call = parts[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
    if (!call.delegation) return
    parts[index] = {
      ...call,
      delegation: { ...call.delegation, status: event.status, endedAt: Date.now() }
    }
  } else if (event.type === 'error') {
    parts.push(errorPart(event.message))
  } else if (event.type === 'retry') {
    // 重试有两种,对已累积内容的影响不同:
    // - 整轮重来:丢掉失败尝试已累积的全部输出(避免正文重复);
    // - 断点续跑(`resume`):模型接着失败那一步跑,已完成的步骤它看得见 —— 全清会让落盘
    //   内容比上下文少一截,只回滚到最后一个已落定的工具结果(它之后属于失败的那一步)。
    // 两种都不落成 part,只把这一帧下发给前端(它据此显示「第 N 次重试」并按同样规则回滚)。
    if (event.resume) truncateToLastSettledTool(parts)
    else parts.length = 0
  }
}

/**
 * 回滚到最后一个**已落定**的工具结果(含),其后的一律丢掉。
 *
 * 断点续跑的边界就是工具结果:失败那一步可能已经吐了半截正文 / 半个工具调用参数,
 * 这些模型会重新生成,留着就会和新的增量重复。一个已落定的工具都没有时清空 —— 那种
 * 情况本来就没有断点,退回「整轮重来」是安全的。
 */
function truncateToLastSettledTool(parts: AgentMessagePart[]): void {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (!part) continue
    // tool-result 是「找不到对应 tool-call」时的兜底 part，它本身就是落定的结果
    if (part.type === 'tool-result') {
      parts.length = i + 1
      return
    }
    if (part.type === 'tool-call' && part.output !== undefined) {
      parts.length = i + 1
      return
    }
  }
  parts.length = 0
}
