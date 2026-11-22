/**
 * 实时 TPS 估算的回归测试：钉住「与服务端同口径」的那几条 —— 空窗丢弃、第一帧只记
 * 时刻、CJK 刻度、工具入参不重复计。
 *
 * 另外钉住**不出天文数字**这条（用户报过 4000+ tok/s）：分子只算落在窗口里的增量、
 * 窗口不足半秒不报数 —— 详见 `live-tps.ts` 文件头「分子只算…」。
 */
import { describe, expect, it } from 'vitest'
import { advanceLiveTps, type LiveTpsState } from './live-tps'

const text = (delta: string): { type: 'text-delta'; delta: string } => ({
  type: 'text-delta',
  delta
})

/** 一帧「abcd」= 1 token（4 字符 1 token） */
const TEXT_1_TOKEN = 'abcd'

describe('advanceLiveTps', () => {
  it('第一帧只记时刻：没有间隔就没有速度，token 只进展示量', () => {
    const state = advanceLiveTps(null, text(TEXT_1_TOKEN), 1_000)
    expect(state).toMatchObject({
      genMs: 0,
      lastAt: 1_000,
      outputTokens: 1,
      windowTokens: 0,
      tps: 0
    })
  })

  it('相邻增量的间隔进分母，只有后一帧的 token 进分子', () => {
    let state = advanceLiveTps(null, text(TEXT_1_TOKEN), 1_000)
    state = advanceLiveTps(state, text(TEXT_1_TOKEN), 1_500)
    // 窗口 500ms；属于这个窗口的是第二帧那 1 token → 2 tok/s
    // （两帧都算分子会得到 4 tok/s —— 第一帧的内容在窗口开始之前就生成好了）
    expect(state).toMatchObject({ genMs: 500, outputTokens: 2, windowTokens: 1, tps: 2 })
  })

  it('窗口不足 500ms 不报数（一两帧算不出速度）', () => {
    // 一帧内容极多、只隔 16ms 就来第二帧：旧实现会报上千 tok/s
    let state = advanceLiveTps(null, text('x'.repeat(4000)), 1_000)
    state = advanceLiveTps(state, text('x'.repeat(4000)), 1_016)
    expect(state?.genMs).toBe(16)
    expect(state?.tps).toBe(0)
  })

  it('超过 1s 的空窗整段丢弃（工具执行 / 等审批不计入分母）', () => {
    let state = advanceLiveTps(null, text(TEXT_1_TOKEN), 1_000)
    state = advanceLiveTps(state, text(TEXT_1_TOKEN), 5_000)
    expect(state).toMatchObject({ genMs: 0, outputTokens: 2, windowTokens: 0, tps: 0 })
    // 空窗之后重新起算：下一帧与 5000 之间的 500ms 才算，且只算这一帧的 token
    state = advanceLiveTps(state, text(TEXT_1_TOKEN), 5_500)
    expect(state).toMatchObject({ genMs: 500, outputTokens: 3, windowTokens: 1, tps: 2 })
  })

  it('宽字符按 1 token 估（与 agent 的 estimateTokens 同刻度）', () => {
    const state = advanceLiveTps(null, text('中文'), 1_000)
    expect(state?.outputTokens).toBe(2)
  })

  it('显示值按 500ms 节流、且取整（不保留小数）', () => {
    let state = advanceLiveTps(null, text(TEXT_1_TOKEN), 1_000)
    // 200ms：窗口还没到报数门槛
    state = advanceLiveTps(state, text(TEXT_1_TOKEN), 1_200)
    expect(state?.tps).toBe(0)
    // 400ms：仍然不够
    state = advanceLiveTps(state, text(TEXT_1_TOKEN), 1_400)
    expect(state?.tps).toBe(0)
    // 800ms、分子是 1200 / 1400 / 1800 三帧共 3 token → 3.75 tok/s → 取整 4
    state = advanceLiveTps(state, text(TEXT_1_TOKEN), 1_800)
    expect(state).toMatchObject({ genMs: 800, windowTokens: 3, tps: 4 })
    // 还没到下一个刷新点：显示值不动
    state = advanceLiveTps(state, text(TEXT_1_TOKEN), 2_000)
    expect(state?.tps).toBe(4)
  })

  it('同一毫秒的合批帧没有时长可摊，不算进速度的分子', () => {
    let state = advanceLiveTps(null, text(TEXT_1_TOKEN), 1_000)
    state = advanceLiveTps(state, text(TEXT_1_TOKEN), 1_000)
    expect(state).toMatchObject({ genMs: 0, outputTokens: 2, windowTokens: 0, tps: 0 })
  })

  it('空串增量不算输出帧，保持同一个引用', () => {
    const state: LiveTpsState = {
      genMs: 0,
      lastAt: 1_000,
      outputTokens: 1,
      windowTokens: 0,
      tps: 0,
      tpsAt: 0,
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
      { type: 'tool-call-delta', toolCallId: 't1', toolName: 'write', inputTextDelta: TEXT_1_TOKEN },
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

  /**
   * 用户报的「4000+ tok/s」的复现场景：写一个几千字符的文件，入参没有增量、整块落在
   * 一帧里。这一帧的 token 是**在窗口外**生成的（模型写了多久我们没看见增量），
   * 只能进展示量，绝不能把速度顶起来。
   */
  it('一次性到达的大入参不参与算速度（写文件轮不虚高）', () => {
    let state = advanceLiveTps(null, text(TEXT_1_TOKEN), 1_000)
    // 连续吐字 1s：每 100ms 一帧，共 11 帧 → 窗口 1000ms、分子 10 token
    for (let i = 1; i <= 10; i += 1) {
      state = advanceLiveTps(state, text(TEXT_1_TOKEN), 1_000 + i * 100)
    }
    const before = state?.tps ?? 0
    expect(before).toBeLessThanOrEqual(12)
    // 一帧 4000 字符（≈ 1000 token）的完整 tool-call
    state = advanceLiveTps(
      state,
      { type: 'tool-call', toolCallId: 't1', toolName: 'write', input: { content: 'x'.repeat(4000) } },
      2_050
    )
    // 展示量涨了，速度不涨
    expect(state?.outputTokens).toBeGreaterThan(1000)
    expect(state?.windowTokens).toBe(10)
    expect(state?.tps).toBe(before)
  })

  it('finish / error 收掉实时数字', () => {
    const state = advanceLiveTps(null, text(TEXT_1_TOKEN), 1_000)
    expect(advanceLiveTps(state, { type: 'finish', finishReason: 'done' }, 2_000)).toBeNull()
    expect(advanceLiveTps(state, { type: 'error', message: 'boom' }, 2_000)).toBeNull()
  })
})
