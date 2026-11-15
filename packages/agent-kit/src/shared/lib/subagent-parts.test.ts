/**
 * 子任务（subagent）过程的前端折叠。
 *
 * 这条链路要保证三件事：
 * 1. `subagent-start` 在**派活卡**上建一份记录（找不到卡就丢弃，不串台）；
 * 2. 子 run 的事件**递归**折叠进 `delegation.parts` —— 与主消息同一个 `applyEvent`，
 *    这是「勾进子任务后看到的消息流和主任务一样」的唯一依据，工具结果必须能回填到子侧
 *    的 tool-call 上；
 * 3. `subagent-end` 落终态，且耗时按派活方报的数算（不是本地时钟）。
 *
 * 附带守住派活卡上那行轻量进度（正文累积 / 工具计数），它和过程记录是两个消费者。
 */
import { describe, expect, it } from 'vitest'
import { applyEvent } from './parts'
import type {
  AgentMessagePart,
  AgentStreamEvent,
  SubagentDelegation
} from '@fizz/contracts/types'

/** 父侧的派活卡：`agent-explorer` 那次工具调用 */
const call: AgentMessagePart = {
  type: 'tool-call',
  toolCallId: 'parent-1',
  toolName: 'agent-explorer',
  input: { task: '把 auth 相关代码找出来' }
}

const start: AgentStreamEvent = {
  type: 'subagent-start',
  toolCallId: 'parent-1',
  subagentId: 'explorer',
  task: '把 auth 相关代码找出来'
}

/** 取出那条记录（顺带断言它确实挂在派活卡上） */
const delegationOf = (parts: AgentMessagePart[]): SubagentDelegation => {
  const part = parts[0]
  if (part.type !== 'tool-call' || !part.delegation) throw new Error('派活卡上没有过程记录')
  return part.delegation
}

/** 把一串事件依次折叠，模拟流式到达 */
const foldAll = (events: AgentStreamEvent[]): AgentMessagePart[] =>
  events.reduce<AgentMessagePart[]>((parts, event) => applyEvent(parts, event), [call])

describe('applyEvent · 子任务过程', () => {
  it('start：在派活卡上建一份「运行中」的记录', () => {
    const delegation = delegationOf(foldAll([start]))
    expect(delegation.subagentId).toBe('explorer')
    expect(delegation.task).toBe('把 auth 相关代码找出来')
    expect(delegation.status).toBe('running')
    expect(delegation.parts).toEqual([])
    expect(delegation.endedAt).toBeUndefined()
    // 时间戳只要求是个正数（本地时钟），不钉死具体值
    expect(delegation.startedAt).toBeGreaterThan(0)
  })

  it('子 run 的事件递归折叠进 delegation.parts，工具结果能回填', () => {
    const parts = foldAll([
      start,
      { type: 'subagent-event', toolCallId: 'parent-1', event: { type: 'reasoning-delta', delta: '先看看目录' } },
      {
        type: 'subagent-event',
        toolCallId: 'parent-1',
        event: { type: 'tool-call', toolCallId: 'child-1', toolName: 'read', input: { file_path: 'a.ts' } }
      },
      {
        type: 'subagent-event',
        toolCallId: 'parent-1',
        event: { type: 'tool-result', toolCallId: 'child-1', toolName: 'read', output: 'export const a = 1' }
      },
      { type: 'subagent-event', toolCallId: 'parent-1', event: { type: 'text-delta', delta: '在 a.ts 里' } }
    ])
    const delegation = delegationOf(parts)
    // 与主消息同一套 part 形状：思考 → 工具卡（带结果）→ 正文
    expect(delegation.parts.map((p) => p.type)).toEqual(['reasoning', 'tool-call', 'text'])
    const toolPart = delegation.parts[1]
    if (toolPart.type !== 'tool-call') throw new Error('第二个 part 应该是工具调用')
    expect(toolPart.toolName).toBe('read')
    expect(toolPart.input).toEqual({ file_path: 'a.ts' })
    expect(toolPart.output).toBe('export const a = 1')

    // 派活卡上的轻量进度同时维护（两者是不同消费者，不能只剩一边）
    const card = parts[0]
    if (card.type !== 'tool-call') throw new Error('第一个 part 应该是派活卡')
    expect(card.subagentText).toBe('在 a.ts 里')
    expect(card.subagentTool).toBe('read')
    expect(card.subagentToolCount).toBe(1)
  })

  it('end：落终态，耗时按派活方报的数算', () => {
    const parts = foldAll([
      start,
      { type: 'subagent-end', toolCallId: 'parent-1', status: 'empty', durationMs: 1500 }
    ])
    const delegation = delegationOf(parts)
    expect(delegation.status).toBe('empty')
    expect(delegation.endedAt! - delegation.startedAt).toBe(1500)
  })

  it('找不到派活卡的事件不影响其它 part（不串台）', () => {
    const other = applyEvent([call], { ...start, toolCallId: 'parent-999' })
    expect(other[0]).toBe(call)
    expect(other).toHaveLength(1)
  })
})
