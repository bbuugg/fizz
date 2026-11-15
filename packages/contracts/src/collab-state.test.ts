/**
 * `normalizeCollabState` 是**白名单重建**：它只挑自己认识的字段，没列进去的直接消失。
 * 新增的过程记录（`CollabTask.parts`）一旦忘了在这里登记，就会「写得进内存、存不进盘」
 * —— 表现为任务刚跑完时右侧面板有工具卡，一刷新又退回一问一答两段纯文本。
 */
import { describe, expect, it } from 'vitest'
import { normalizeCollabState } from './types'

describe('normalizeCollabState', () => {
  it('任务的过程记录能落盘并读回', () => {
    const state = normalizeCollabState({
      tasks: [
        {
          id: 't1',
          agentId: 'a1',
          prompt: '查一下',
          status: 'done',
          output: '结论',
          parts: [
            { type: 'reasoning', text: '先看结构' },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'read',
              input: { path: 'a.ts' },
              output: 'body'
            },
            { type: 'text', text: '结论' }
          ]
        }
      ]
    })
    expect(state.tasks[0]?.parts).toHaveLength(3)
    expect(state.tasks[0]?.parts?.[1]).toMatchObject({ toolName: 'read', output: 'body' })
  })

  it('形状不对的分支整条丢掉，不影响同一任务的其他字段', () => {
    const state = normalizeCollabState({
      tasks: [
        {
          id: 't1',
          agentId: 'a1',
          prompt: '查一下',
          status: 'done',
          parts: [
            { type: 'tool-call' }, // 缺 toolCallId / toolName
            { type: 'text' }, // 缺 text
            { type: 'tool-result', toolCallId: 'c1', output: 'x' }, // 不收：已折叠到 tool-call 上
            { type: 'text', text: '留下' }
          ]
        }
      ]
    })
    expect(state.tasks[0]?.parts).toEqual([{ type: 'text', text: '留下' }])
  })

  it('没有过程记录时不留空数组（老任务不用改数据）', () => {
    const state = normalizeCollabState({
      tasks: [{ id: 't1', agentId: 'a1', prompt: '查一下', status: 'done' }]
    })
    expect(state.tasks[0]?.parts).toBeUndefined()
  })
})
