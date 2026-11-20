/**
 * `carryOverDurations`：把快照里的「本轮耗时」搬到 session/load 重建的消息上。
 *
 * 这段逻辑只在**顺序对得上**时才成立（回放的 id 与本地 id 无关），所以这里重点锁
 * 三件事：条数一致才搬、只搬助手消息、目标已有值不覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentChatMessage } from '@fizz/contracts/types'
import type { ChatRunSummary } from '@fizz/contracts/agent-api'

vi.mock('./state', () => ({ acpTranscripts: new Map() }))

const { carryOverDurations, setAcpTranscript, acpTranscriptView } = await import('./acp-transcripts')

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
