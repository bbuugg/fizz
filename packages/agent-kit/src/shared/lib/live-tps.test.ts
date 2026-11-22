/**
 * 实时 TPS 估算的回归测试：钉住「与服务端同口径」的那几条 —— 空窗丢弃、第一帧只记
 * 时刻、CJK 刻度、工具入参不重复计。
 */
import { describe, expect, it } from 'vitest'
import { advanceLiveTps, type LiveTpsState } from './live-tps'

const text = (delta: string): { type: 'text-delta'; delta: string } => ({
  type: 'text-delta',
  delta
})

describe('advanceLiveTps', () => {
  it('第一帧只记时刻：没有间隔就没有速度', () => {
    const state = advanceLiveTps(null, text('abcd'), 1_000)
    expect(state).toMatchObject({ genMs: 0, lastAt: 1_000, outputTokens: 1, tps: 0 })
  })

  it('相邻增量累计成生成窗口，tps = 估算 token ÷ 窗口', () => {
    let state = advanceLiveTps(null, text('abcd'), 1_000)
    state = advanceLiveTps(state, text('abcd'), 1_500)
    // 两个 "abcd" = 2 token，窗口 500ms → 4 tok/s
    expect(state).toMatchObject({ genMs: 500, outputTokens: 2, tps: 4 })
  })

  it('超过 1s 的空窗整段丢弃（工具执行 / 等审批不计入分母）', () => {
    let state = advanceLiveTps(null, text('abcd'), 1_000)
    state = advanceLiveTps(state, text('abcd'), 5_000)
    expect(state).toMatchObject({ genMs: 0, outputTokens: 2, tps: 0 })
    // 空窗之后重新起算：下一帧与 5000 之间的 500ms 才算
    state = advanceLiveTps(state, text('abcd'), 5_500)
    expect(state).toMatchObject({ genMs: 500, outputTokens: 3, tps: 6 })
  })

  it('宽字符按 1 token 估（与 agent 的 estimateTokens 同刻度）', () => {
    const state = advanceLiveTps(null, text('中文'), 1_000)
    expect(state?.outputTokens).toBe(2)
  })

  it('空串增量不算输出帧，保持同一个引用', () => {
    const state: LiveTpsState = {
      genMs: 0,
      lastAt: 1_000,
      outputTokens: 1,
      tps: 0,
      streamedToolCalls: []
    }
    expect(advanceLiveTps(state, text(''), 2_000)).toBe(state)
    expect(
      advanceLiveTps(state, { type: 'tool-result', toolCallId: 't1', toolName: 'x', output: 'y' }, 2_000)
    ).toBe(state)
  })

  it('入参增量 + 完整 tool-call：只算一次，不重复计入参', () => {
    let state = advanceLiveTps(
      null,
      { type: 'tool-call-delta', toolCallId: 't1', toolName: 'write', inputTextDelta: 'abcd' },
      1_000
    )
    expect(state?.outputTokens).toBe(1)
    state = advanceLiveTps(
      state,
      { type: 'tool-call', toolCallId: 't1', toolName: 'write', input: { content: 'x'.repeat(400) } },
      1_500
    )
    expect(state?.outputTokens).toBe(1)
  })

  it('上游不发入参增量时，完整 tool-call 按入参文本估一次', () => {
    const state = advanceLiveTps(
      null,
      { type: 'tool-call', toolCallId: 't1', toolName: 'write', input: { path: 'a' } },
      1_000
    )
    expect(state?.outputTokens).toBeGreaterThan(0)
  })

  it('finish / error 收掉实时数字', () => {
    const state = advanceLiveTps(null, text('abcd'), 1_000)
    expect(advanceLiveTps(state, { type: 'finish', finishReason: 'done' }, 2_000)).toBeNull()
    expect(advanceLiveTps(state, { type: 'error', message: 'boom' }, 2_000)).toBeNull()
  })
})
