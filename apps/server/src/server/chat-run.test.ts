/**
 * 帧日志压缩的等价性：交接文档的 delta 是全场最密的之一，必须按 phase 合并；
 * 合并后回放出的文本要与合并前逐字一致，且不能跨 phase 拼（两段摘要标题不同）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatStreamFrame } from '@fizz/contracts/agent-api'
import type { ChatRun } from './chat-run'
import { chatRuns } from './state'

vi.mock('./state', () => ({
  chatRuns: {
    runs: new Map(),
    activeByConversation: new Map(),
    doneResolves: new Map()
  }
}))

const { compactFrames, stopConversationRun } = await import('./chat-run')

function frame(event: ChatStreamFrame['event']): ChatStreamFrame {
  return { type: 'event', requestId: 'req-1', event }
}

describe('compactFrames', () => {
  it('相邻同 phase 的交接文档 delta 合并，不同 phase 不跨拼', () => {
    const merged = compactFrames([
      frame({
        type: 'context-compaction-start',
        beforeTokens: 1000,
        summarizedTurns: 3,
        keptTurns: 2
      }),
      frame({ type: 'context-compaction-delta', phase: 'checkpoint', delta: 'a' }),
      frame({ type: 'context-compaction-delta', phase: 'checkpoint', delta: 'b' }),
      frame({ type: 'context-compaction-delta', phase: 'turn-prefix', delta: 'c' }),
      frame({ type: 'context-compaction-delta', phase: 'turn-prefix', delta: 'd' }),
      frame({
        type: 'context-compressed',
        beforeTokens: 1000,
        afterTokens: 400,
        summarizedTurns: 3,
        keptTurns: 2
      })
    ])

    const deltas = merged
      .map((f) => f.event)
      .filter((e) => e?.type === 'context-compaction-delta')
    expect(deltas).toEqual([
      { type: 'context-compaction-delta', phase: 'checkpoint', delta: 'ab' },
      { type: 'context-compaction-delta', phase: 'turn-prefix', delta: 'cd' }
    ])
    expect(merged).toHaveLength(4)
  })
})

/**
 * 归档 / 删除会话前必须先停掉正在跑的这一轮：
 * 这条用例防的是「删完会话，agent 还在后台跑工具 / 占端口，收尾落盘又撞会话不存在」。
 */
describe('stopConversationRun', () => {
  it('abort 正在跑的 run 并等它收尾后才返回', async () => {
    const controller = new AbortController()
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    // 真实收尾里 chat-turn 挂的 abort 监听器会落盘并 finishRun；这里用同一条信号收尾
    controller.signal.addEventListener('abort', () => resolveDone())

    const run = {
      requestId: 'req-run',
      conversationId: 'conv-running',
      controller,
      commandStops: new Map(),
      frames: [],
      subscribers: new Set(),
      done
    } as unknown as ChatRun
    chatRuns.runs.set(run.requestId, run)
    chatRuns.activeByConversation.set(run.conversationId, run.requestId)

    await expect(stopConversationRun(run.conversationId)).resolves.toBe(true)
    expect(controller.signal.aborted).toBe(true)
    // 收尾不是这里负责：active 映射由 finishRun 清（这里保持原状，验证不越权）
    expect(chatRuns.activeByConversation.get(run.conversationId)).toBe(run.requestId)

    chatRuns.runs.delete(run.requestId)
    chatRuns.activeByConversation.delete(run.conversationId)
  })

  it('没有在跑的轮次时是 no-op', async () => {
    await expect(stopConversationRun('conv-idle')).resolves.toBe(false)
  })
})
