/**
 * 这条测试防的是「输入框上方那枚子智能体入口」的两个老坑：
 *
 * 1. **`live` 门**：进程被杀 / 断电时落盘的派活记录会一直停在 `running`，重启后照它
 *    画一枚「1 个子智能体」就是永远不消失的假信号 —— 本轮没在流式就一律不列。
 * 2. **只列运行中的**：跑完的子任务是回看内容（派活卡里），不该在输入框上方常驻。
 */
import { describe, expect, it } from 'vitest'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import type { SubagentDelegation } from '@fizz/contracts/types'
import { collectRunningSubagents } from './ComposerDock'

function delegation(status: SubagentDelegation['status']): SubagentDelegation {
  return {
    subagentId: 'explorer',
    name: '侦察',
    task: '找一下输入框在哪个文件',
    parts: [],
    status,
    startedAt: 1_000
  }
}

function message(deleg?: SubagentDelegation, tool?: string): AgentChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: 0,
    parts: [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'agent-explorer',
        input: {},
        ...(deleg ? { delegation: deleg } : {}),
        ...(tool ? { subagentTool: tool } : {})
      }
    ]
  }
}

describe('collectRunningSubagents', () => {
  it('本轮没在流式时一条都不列（重启后的假 running 记录）', () => {
    const items = collectRunningSubagents([message(delegation('running'), 'read')], false)
    expect(items).toEqual([])
  })

  it('列出运行中的子任务，带上它此刻的工具', () => {
    const items = collectRunningSubagents([message(delegation('running'), 'read')], true)
    expect(items).toHaveLength(1)
    expect(items[0]?.toolCallId).toBe('call-1')
    expect(items[0]?.tool).toBe('read')
  })

  it('跑完 / 中止的子任务留在派活卡里，不进这枚入口', () => {
    const messages = [
      message(delegation('done')),
      message(delegation('aborted')),
      message(undefined)
    ]
    expect(collectRunningSubagents(messages, true)).toEqual([])
  })
})
