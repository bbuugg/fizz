/**
 * `carryOverDurations`：把快照里的「本轮耗时」搬到 session/load 重建的消息上。
 *
 * 这段逻辑只在**顺序对得上**时才成立（回放的 id 与本地 id 无关），所以这里重点锁
 * 三件事：条数一致才搬、只搬助手消息、目标已有值不覆盖。
 * `carryOverErrors` 防止 session/load 不回放工作台运行错误，导致错误正文与恢复按钮自动消失。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentChatMessage } from '@fizz/contracts/types'
import type { ChatRunSummary } from '@fizz/contracts/agent-api'

vi.mock('./state', () => ({ acpTranscripts: new Map() }))

const { carryOverDurations, carryOverErrors, setAcpTranscript, acpTranscriptView } = await import('./acp-transcripts')

function msg(
  id: string,
  role: AgentChatMessage['role'],
  durationMs?: number
): AgentChatMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text: id }],
    createdAt: 1,
    ...(durationMs != null ? { durationMs } : {})
  }
}

describe('carryOverDurations', () => {
  it('条数一致时按顺序把耗时搬到助手消息上（用户消息不参与）', () => {
    const from = [msg('u1', 'user'), msg('a1', 'assistant', 1000), msg('a2', 'assistant', 2000)]
    const to = [msg('u-replay-1', 'user'), msg('a-replay-1', 'assistant'), msg('a-replay-2', 'assistant')]

    carryOverDurations(from, to)

    expect(to.map((m) => m.durationMs)).toEqual([undefined, 1000, 2000])
  })

  it('两边助手消息条数不一致时一条也不搬（宁可没有，也别错位）', () => {
    const from = [msg('a1', 'assistant', 1000)]
    const to = [msg('a-replay-1', 'assistant'), msg('a-replay-2', 'assistant')]

    carryOverDurations(from, to)

    expect(to.some((m) => m.durationMs != null)).toBe(false)
  })

  it('目标已有耗时就不覆盖（回放自己带的更可信）', () => {
    const from = [msg('a1', 'assistant', 1000)]
    const to = [msg('a-replay-1', 'assistant', 500)]

    carryOverDurations(from, to)

    expect(to[0].durationMs).toBe(500)
  })

  it('快照里一轮都没跑过（没有助手消息）时什么都不做', () => {
    const from = [msg('u1', 'user')]
    const to = [msg('u-replay-1', 'user'), msg('a-replay-1', 'assistant')]

    carryOverDurations(from, to)

    expect(to[1].durationMs).toBeUndefined()
  })
})

describe('carryOverErrors', () => {
  const user = (id: string, text = '问题') => ({ ...msg(id, 'user'), parts: [{ type: 'text' as const, text }] })
  const error = { type: 'text' as const, text: '⚠️ ACP connection closed' }
  const failed = { ...msg('a-local', 'assistant', 1200), parts: [error] }

  it('回放缺少失败轮的助手消息时补回错误，重复同步不重复追加', () => {
    const from = [user('u-local'), failed]
    const to = [user('u-replay')]
    carryOverErrors(from, to)
    carryOverErrors(from, to)
    expect(to).toEqual([user('u-replay'), failed])
  })

  it('已有回放正文时只补错误，不把本地正文再抄一遍', () => {
    const from = [user('u-local'), { ...failed, parts: [{ type: 'text' as const, text: '半截正文' }, error] }]
    const to = [user('u-replay'), msg('a-replay', 'assistant')]
    carryOverErrors(from, to)
    carryOverErrors(from, to)
    expect(to[1].parts).toEqual([{ type: 'text', text: 'a-replay' }, error])
    expect(from[1].parts).toHaveLength(2)
  })

  it('失败请求连用户消息都未被 agent 存下时保留失败尾轮', () => {
    const from = [user('u-local'), failed]
    const to: AgentChatMessage[] = []
    carryOverErrors(from, to)
    expect(to).toEqual(from)
  })

  it('用户消息对不上时不把旧错误挂到另一轮', () => {
    const from = [user('u-local', '旧问题'), failed]
    const to = [user('u-replay', '新问题'), msg('a-replay', 'assistant')]
    carryOverErrors(from, to)
    expect(to[1].parts).toEqual([{ type: 'text', text: 'a-replay' }])
  })

  it('前一轮没有助手回放时也不能把错误挪到后一轮', () => {
    const from = [user('u1'), failed, user('u2', '下一题'), msg('a2', 'assistant')]
    const to = [user('u-replay-1'), user('u-replay-2', '下一题'), msg('a-replay-2', 'assistant')]
    carryOverErrors(from, to)
    expect(to.map((m) => m.id)).toEqual(['u-replay-1', 'a-local', 'u-replay-2', 'a-replay-2'])
    expect(to[3].parts).toEqual([{ type: 'text', text: 'a-replay-2' }])
  })
})

/** 防止查运行态与读取快照之间收尾，客户端把全量回放和旧轮正文拼成两份。 */
describe('acpTranscriptView', () => {
  it('运行快照明确携带所属 run，排除当前助手但保留历史与本轮提问', () => {
    const run: ChatRunSummary = {
      requestId: 'r', conversationId: 'c', status: 'running', startedAt: 1,
      assistantMessageId: 'a-live'
    }
    setAcpTranscript('c', [msg('u-old', 'user'), msg('a-old', 'assistant'), msg('u-now', 'user'), msg('a-live', 'assistant')])
    const view = acpTranscriptView('c', run)
    expect(view.messages.map((m) => m.id)).toEqual(['u-old', 'a-old', 'u-now'])
    expect(view.run).toEqual(run)
  })

  it('空闲视图明确标记 run 为 null，保留已完成的助手消息', () => {
    setAcpTranscript('c-idle', [msg('u-replay-0', 'user'), msg('a-replay-1', 'assistant')])
    const view = acpTranscriptView('c-idle', null)
    expect(view.messages.map((m) => m.id)).toEqual(['u-replay-0', 'a-replay-1'])
    expect(view.run).toBeNull()
  })
})
