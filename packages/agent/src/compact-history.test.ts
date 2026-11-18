/**
 * `compactHistory`（pi 的 compaction）的断言：
 * - **只验证「该不该调模型」**（成本行为），不验证摘要质量；
 * - 钉住切点与 split-turn 的行为（切点落在回合中间要额外摘要一次）。
 *
 * 模型被 mock 掉。这里要守的是：第一次超阈值摘要一次；之后历史增长只要**拼装后的上下文**
 * 还在阈值以下就**只拼接、不调模型**。这条一旦回归，症状是每轮多一次模型调用、
 * 且请求前缀每轮都变（缓存全废），但界面上完全看不出来。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { streamText } from 'ai'
import {
  calculateContextTokens,
  clearAutoSummaryCache,
  compactHistory,
  resolveCompactionSettings
} from './context'
import { compactionKeepRecentTokens } from '@fizz/contracts/types'
import type { AgentChatMessage, AiModelConfig } from '@fizz/contracts/types'

vi.mock('./resolve-model', () => ({ resolveModel: () => ({}) }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, streamText: vi.fn() }
})

/** 假流：按给定片段逐个吐，最后给出 finishReason（与真实 streamText 的最小形状一致） */
function fakeStream(chunks: string[], finishReason = 'stop'): never {
  return {
    textStream: (async function* () {
      for (const chunk of chunks) yield chunk
    })(),
    finishReason: Promise.resolve(finishReason)
  } as never
}

/** 2000 个 ASCII 字符 ≈ 500 token */
const LONG = 'x'.repeat(2000)
const MODEL = {} as unknown as AiModelConfig
/**
 * 4000 的窗口 → 预留 1024、触发线 2976。
 * `keepRecentTokens: 1024` 让切点落在一条 user 消息上（不触发 split-turn），
 * 同时给「拼装后仍低于触发线」留出余量 —— 复用的前提。
 */
const OPTS = {
  conversationId: 'conv-1',
  contextWindow: 4000,
  model: MODEL,
  settings: { keepRecentTokens: 1024 }
}

/** 纯文本轮：user 约 500 token + assistant 1 token —— 切点稳定落在 user 上（不触发 split） */
function chatTurn(n: number): AgentChatMessage[] {
  return [
    {
      id: `u${n}`,
      role: 'user',
      parts: [{ type: 'text', text: `${n}:` + LONG }],
      createdAt: n
    },
    {
      id: `a${n}`,
      role: 'assistant',
      parts: [{ type: 'text', text: 'ok' }],
      createdAt: n
    }
  ]
}

/** 带工具调用的轮：`<read-files>` 那份清单用它验 */
function toolTurn(n: number): AgentChatMessage[] {
  return [
    {
      id: `tu${n}`,
      role: 'user',
      parts: [{ type: 'text', text: `第 ${n} 轮` }],
      createdAt: n
    },
    {
      id: `ta${n}`,
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          toolCallId: `c${n}`,
          toolName: 'read',
          input: { file_path: `src/${n}.ts` },
          // 落盘形状：结果挂在 tool-call 的 output 上（见 agent-parts.ts）
          output: LONG
        }
      ],
      createdAt: n
    }
  ]
}

function chatHistory(turns: number): AgentChatMessage[] {
  const out: AgentChatMessage[] = []
  for (let n = 1; n <= turns; n++) out.push(...chatTurn(n))
  return out
}

function toolHistory(turns: number): AgentChatMessage[] {
  const out: AgentChatMessage[] = []
  for (let n = 1; n <= turns; n++) out.push(...toolTurn(n))
  return out
}

function firstText(m: AgentChatMessage | undefined): string {
  const p = m?.parts[0]
  return p && p.type === 'text' ? p.text : ''
}

describe('compactHistory（pi 的 compaction）', () => {
  const gen = vi.mocked(streamText)

  beforeEach(() => {
    gen.mockReset()
    gen.mockImplementation(() => fakeStream(['摘要正文']))
    clearAutoSummaryCache()
  })

  it('首次越过阈值时摘要一次', async () => {
    const r = await compactHistory(chatHistory(8), OPTS)
    expect(r.reused).toBe(false)
    expect(r.compressed).not.toBeNull()
    expect(gen).toHaveBeenCalledTimes(1)
    // 摘要并进保留区第一条，原始保留区原样跟在后面
    expect(firstText(r.history[0])).toContain('摘要正文')
  })

  it('切点落在回合中间时，额外生成 turn-prefix 摘要并合并', async () => {
    // 工具轮（assistant ≈ 500 token）+ 默认保留区（2380）会把某条 assistant 切开
    const r = await compactHistory(toolHistory(8), {
      conversationId: 'conv-split',
      contextWindow: 4000,
      model: MODEL
    })
    expect(gen).toHaveBeenCalledTimes(2)
    expect(firstText(r.history[0])).toContain('Turn Context (split turn)')
  })

  it('历史增长但拼装后的上下文仍在阈值内 → 复用，不再调模型', async () => {
    const first = await compactHistory(chatHistory(8), OPTS)
    expect(first.reused).toBe(false)

    const second = await compactHistory(chatHistory(9), OPTS)
    expect(second.reused).toBe(true)
    // 复用不算「发生了压缩」：每轮都推一条横幅会烦人
    expect(second.compressed).toBeNull()
    expect(gen).toHaveBeenCalledTimes(1)
    // 关键：摘要还在（不是回滚成全文），否则前缀每轮都变
    expect(firstText(second.history[0])).toContain('摘要正文')
  })

  it('拼装后的上下文再次超阈值 → 重新摘要', async () => {
    await compactHistory(chatHistory(8), OPTS)
    // 时间戳挪到「检查点之后」：模拟真的又跑了几轮（pi 按消息时间戳判陈旧）
    const later = chatHistory(14).map((m) => ({ ...m, createdAt: Date.now() + m.createdAt }))
    const again = await compactHistory(later, OPTS)
    expect(again.reused).toBe(false)
    expect(gen).toHaveBeenCalledTimes(2)
  })

  it('触发量用最后一次请求的真实 usage（逐条估算再大也不算）', async () => {
    const messages = chatHistory(8)
    const last = messages[messages.length - 1]!
    messages[messages.length - 1] = {
      ...last,
      usage: {
        inputTokens: 990,
        outputTokens: 10,
        totalTokens: 1_000,
        contextTokens: 1_000,
        durationMs: 1,
        tps: 1
      }
    }
    // 逐条估算 ≈4000 > 触发线 2976，但上游说这次请求只有 1000 → 不压
    const r = await compactHistory(messages, { ...OPTS, conversationId: 'conv-usage' })
    expect(r.compressed).toBeNull()
    expect(gen).not.toHaveBeenCalled()
  })

  it('同一份历史再调一次：复用检查点，不重复摘要', async () => {
    await compactHistory(chatHistory(8), OPTS)
    const again = await compactHistory(chatHistory(8), OPTS)
    expect(again.reused).toBe(true)
    expect(again.compressed).toBeNull()
    expect(gen).toHaveBeenCalledTimes(1)
  })

  it('早于检查点的 usage 不参与判定（否则压完立刻又压）', async () => {
    await compactHistory(chatHistory(8), OPTS)
    /**
     * 同一份历史，把最后一条助手消息的 usage 设成远超阈值。它早于检查点（压缩前那一轮
     * 的真实值），必须被忽略 —— 否则「压完 → 立刻判超 → 再压」就是死循环。
     * 判据只看「即将发出去的那份」的估算：摘要 + 保留区 ≈ 1100 < 触发线 2976。
     */
    const messages = chatHistory(8)
    const last = messages[messages.length - 1]!
    messages[messages.length - 1] = {
      ...last,
      usage: {
        inputTokens: 29_990,
        outputTokens: 10,
        totalTokens: 30_000,
        contextTokens: 30_000,
        durationMs: 1,
        tps: 1
      }
    }
    const r = await compactHistory(messages, OPTS)
    expect(r.reused).toBe(true)
    expect(r.compressed).toBeNull()
    expect(gen).toHaveBeenCalledTimes(1)
  })

  it('摘要末尾带上框架统计的文件清单（不让模型自己编）', async () => {
    const r = await compactHistory(toolHistory(8), {
      conversationId: 'conv-files',
      contextWindow: 4000,
      model: MODEL
    })
    expect(r.summary).toContain('<read-files>')
    expect(r.summary).toContain('src/1.ts')
    expect(r.summary).not.toContain('<modified-files>')
  })

  it('历史回落到阈值以下时清掉缓存', async () => {
    await compactHistory(chatHistory(8), OPTS)
    // 只剩 3 轮（≈1500 < 触发线 2976）→ 原样返回，并清掉过期摘要
    const dropped = await compactHistory(chatHistory(3), OPTS)
    expect(dropped.compressed).toBeNull()
    // 再涨回去必须重新摘要（缓存已被清掉）
    const again = await compactHistory(chatHistory(8), OPTS)
    expect(again.reused).toBe(false)
    expect(gen).toHaveBeenCalledTimes(2)
  })

  /**
   * 回归：切点是「至少保留 keepRecentTokens」，跨线的那条消息**整条**留在保留区。
   * 一条消息本身就有保留区那么大时（读了一个大文件 / 一条长输出），压完几乎没变小，
   * 于是下一轮立刻又超阈值 → 连压好几次才落地（用户实测：压三次才到 20k）。
   *
   * 期望：跨线那条不进保留区（一起摘要掉），保留区是**上限**而不是下限。
   */
  it('跨线的单条超大消息不整条留在保留区', async () => {
    const huge: AgentChatMessage = {
      id: 'huge',
      role: 'assistant',
      // 8000 字符 ≈ 2000 token，比 keepRecentTokens(1024) 还大
      parts: [{ type: 'text', text: 'y'.repeat(8000) }],
      createdAt: 50
    }
    const history = [...chatHistory(4), huge, ...chatTurn(5)]
    const r = await compactHistory(history, { ...OPTS, conversationId: 'conv-huge' })
    expect(r.compressed).not.toBeNull()
    // 那条巨型消息必须被摘要掉，不能原样留在保留区里
    expect(r.history.some((m) => m.id === 'huge')).toBe(false)
    // 压完必须真的落到保留区量级（base 0 + 摘要 + 最后那一轮）
    expect(r.compressed!.afterTokens).toBeLessThan(1024 + 800)
  })

  /**
   * 回归：**轮中压缩不落检查点**，于是最后一次请求的真实 usage 只代表「压过的那份」。
   *
   * 用户实测：某一轮跑出巨型工具输出 → 轮中压缩把当轮请求压回 50k（圆环显示很低）→
   * 落盘历史里那条巨消息原样还在 → 再发一条消息，真值 50k 判「没超」→ 整份巨消息照发
   * （超窗口、全价）→ 又靠轮中压缩救火 …… 每条新消息都复现一次。
   *
   * 判据：保留区里**单独一条消息就比上次请求还大**时，那次测量必然没包含它，
   * 只能改看估算 —— 否则压完就再也压不动了。
   */
  it('保留区里有单条消息比上次请求还大时，真值不作数', async () => {
    const giant: AgentChatMessage = {
      id: 'giant',
      role: 'assistant',
      // 8000 字符 ≈ 2000 token，比触发线（2976）之外还大；比下面那条 1000 的真值大得多
      parts: [{ type: 'text', text: 'z'.repeat(8000) }],
      createdAt: 3
    }
    const tail = chatTurn(4)
    // 上次请求是「压过的那份」：真值只有 1000，远小于保留区里那条巨消息
    tail[1] = {
      ...tail[1]!,
      usage: { inputTokens: 990, outputTokens: 10, totalTokens: 1_000, contextTokens: 1_000, durationMs: 1, tps: 1 }
    }
    const history: AgentChatMessage[] = [
      ...chatTurn(1),
      ...chatTurn(2),
      giant,
      ...tail,
      { id: 'u9', role: 'user', parts: [{ type: 'text', text: '再发一条' }], createdAt: 9 }
    ]
    const r = await compactHistory(history, { ...OPTS, conversationId: 'conv-stale-usage' })
    expect(r.compressed).not.toBeNull()
    // 巨型消息必须真的被摘要掉，否则下一轮还是这份数组
    expect(r.history.some((m) => m.id === 'giant')).toBe(false)
    expect(gen).toHaveBeenCalled()
  })

  /**
   * 回归：检查点正好压在一条助手消息上（历史版本留下的落盘点），切点又落回同一条回合的
   * 助手消息时，`turnStartIndex === checkpointIndex` —— 按「切回合」算会一路退化成
   * `historyEnd <= checkpointIndex`（什么都不压），那份内容每轮照发、每轮判超。
   * 期望：起点就在检查点上时按不切回合处理，一路摘要到切点。
   */
  it('切回合的起点正好在检查点上时照常摘要，不返回 below-keep', async () => {
    const history: AgentChatMessage[] = [
      ...chatTurn(1),
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: '2:开始' }], createdAt: 2 },
      { id: 'a2x', role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(7200) }], createdAt: 2 },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(2400) }], createdAt: 2 },
      { id: 'a2b', role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(2400) }], createdAt: 2 }
    ]
    const r = await compactHistory(history, {
      ...OPTS,
      conversationId: undefined,
      seed: { keepFromMessageId: 'u2', text: '旧摘要' }
    })
    expect(r.skipped).not.toBe('below-keep')
    expect(r.compressed).not.toBeNull()
    expect(gen).toHaveBeenCalled()
  })

  it('没有 conversationId 时不固化（每轮重算，与加这个能力之前一致）', async () => {
    await compactHistory(chatHistory(8), { ...OPTS, conversationId: undefined })
    await compactHistory(chatHistory(8), { ...OPTS, conversationId: undefined })
    expect(gen).toHaveBeenCalledTimes(2)
  })

  it('命中落盘 seed 时直接复用（模拟进程重启后的第一轮）', async () => {
    const entries: Array<{ keepFromMessageId: string; text: string }> = []
    await compactHistory(chatHistory(8), { ...OPTS, onAutoSummary: (e) => entries.push(e) })
    expect(entries).toHaveLength(1)

    // 进程重启：内存缓存清空，只剩会话里落盘的那份
    clearAutoSummaryCache()
    gen.mockClear()

    const next = await compactHistory(chatHistory(9), {
      ...OPTS,
      conversationId: undefined,
      seed: entries[0]!
    })
    expect(next.reused).toBe(true)
    expect(gen).not.toHaveBeenCalled()
  })

  it('复用时不回写落盘点（避免每轮刷会话文件）', async () => {
    const entries: unknown[] = []
    const collect = (e: { keepFromMessageId: string; text: string }): void => {
      entries.push(e)
    }
    await compactHistory(chatHistory(8), { ...OPTS, onAutoSummary: collect })
    const second = await compactHistory(chatHistory(9), { ...OPTS, onAutoSummary: collect })
    expect(second.reused).toBe(true)
    expect(entries).toHaveLength(1)
  })

  it('上下文数 = 最后一次请求的 input + output（上游真实值，不再本地估）', () => {
    // 有 totalTokens 就直接用
    expect(
      calculateContextTokens({ totalTokens: 51_234, inputTokens: 50_000, outputTokens: 1_234 })
    ).toBe(51_234)
    // 没有就 input + output
    expect(
      calculateContextTokens({ inputTokens: 50_000, outputTokens: 1_234 })
    ).toBe(51_234)
    // ⚠️ cachedInputTokens 是 input 的子集，再加一遍就是重复计数（pi 的字段语义不同）
    expect(
      calculateContextTokens({
        inputTokens: 50_000,
        outputTokens: 1_234,
        cachedInputTokens: 40_000
      } as { inputTokens: number; outputTokens: number })
    ).toBe(51_234)
  })

  it('摘要流式回调：先 start，再按顺序吐 delta，正文与终稿一致', async () => {
    gen.mockImplementation(() => fakeStream(['## Goal\n', '完成交接']))
    const starts: unknown[] = []
    const deltas: Array<{ delta: string; phase: string }> = []
    const r = await compactHistory(chatHistory(8), {
      ...OPTS,
      onSummaryStart: (info) => starts.push(info),
      onSummaryDelta: (info) => deltas.push(info)
    })
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      beforeTokens: expect.any(Number),
      summarizedTurns: expect.any(Number),
      keptTurns: expect.any(Number)
    })
    expect(deltas.map((d) => d.delta).join('')).toBe('## Goal\n完成交接')
    expect(deltas.every((d) => d.phase === 'checkpoint')).toBe(true)
    expect(r.summary).toContain('## Goal')
  })

  it('切回合时第二段摘要以 turn-prefix 相位流出', async () => {
    const phases: string[] = []
    const r = await compactHistory(toolHistory(8), {
      conversationId: 'conv-split-stream',
      contextWindow: 4000,
      model: MODEL,
      onSummaryDelta: (info) => phases.push(info.phase)
    })
    expect(r.compressed).not.toBeNull()
    expect(phases).toContain('checkpoint')
    expect(phases).toContain('turn-prefix')
  })

  it('摘要输出被截断（finishReason=length）时抛错，不落检查点', async () => {
    gen.mockImplementation(() => fakeStream(['半截摘要'], 'length'))
    const entries: unknown[] = []
    await expect(
      compactHistory(chatHistory(8), { ...OPTS, onAutoSummary: (e) => entries.push(e) })
    ).rejects.toThrow(/incomplete/)
    expect(entries).toHaveLength(0)
  })
})

/**
 * 保留区必须给「压缩动不了的那块」让位。
 *
 * 用户实测的死循环：128k 窗口、系统提示词 + 工具定义很大，保留区还是固定 20000，
 * 于是 `base + 20000` 仍在触发线以上 —— 压完立刻又超、下一轮又压，而每次只能
 * 摘要一两轮（检查点之后刚好就是一个保留区）。占用一点没降，还白付摘要调用。
 *
 * 现在 `resolveCompactionSettings` 按 `窗口 − 预留 − base` 的 80% 算保留区，
 * 保证「压完能落到触发线以下」；预算被吃光时直接返回 `no-budget`、不调模型。
 */
describe('保留区按预算收缩（base 吃掉窗口时）', () => {
  const gen = vi.mocked(streamText)

  beforeEach(() => {
    gen.mockReset()
    gen.mockImplementation(() => fakeStream(['摘要', '正文']))
  })

  /** 窗口 10000 → 预留 2500、触发线 7500；base 5000 只剩 2500 给消息 */
  const BUDGET_OPTS = {
    contextWindow: 10000,
    baseTokens: 5000,
    model: MODEL
  }

  it('base 占掉大半窗口时，压完真的落到触发线以下', async () => {
    const r = await compactHistory(chatHistory(6), {
      ...BUDGET_OPTS,
      conversationId: 'conv-budget'
    })
    expect(r.compressed).not.toBeNull()
    // 12 条 × 约 250 token + base 5000 = 8000+，越过 7500
    expect(r.compressed!.beforeTokens).toBeGreaterThan(7500)
    // 关键：压完在触发线以下 —— 旧口径（keep = 6000）根本切不动，压完仍是 8000
    expect(r.compressed!.afterTokens).toBeLessThan(7500)
  })

  it('base 自己就顶到触发线：不调摘要模型，返回 no-budget', async () => {
    const r = await compactHistory(chatHistory(6), {
      ...BUDGET_OPTS,
      baseTokens: 7600,
      conversationId: 'conv-budget-dry'
    })
    expect(r.compressed).toBeNull()
    expect(r.skipped).toBe('no-budget')
    expect(gen).not.toHaveBeenCalled()
  })
})

/**
 * 保留区公式必须**只有一份**：界面判断「手动压缩按钮能不能点」用的是
 * `compactionKeepRecentTokens`（contracts），服务端切点用的是
 * `resolveCompactionSettings`（本包）。两边各算一套就会重演「按钮在 92% 以下永远灰着」
 * ——那条闸当时拿的是**自动**压缩的触发线，和切点根本不是一回事。
 */
describe('保留区公式（界面 / 服务端同源）', () => {
  it('resolveCompactionSettings 的 keepRecentTokens 与 contracts 的 helper 逐值一致', () => {
    for (const contextWindow of [8000, 32000, 128000, 200000, 1000000]) {
      for (const fixedTokens of [0, 5000, 60000]) {
        expect(resolveCompactionSettings(contextWindow, undefined, fixedTokens).keepRecentTokens).toBe(
          compactionKeepRecentTokens(contextWindow, fixedTokens)
        )
      }
    }
  })

  it('默认窗口下保留区远小于触发线（手动压缩不该等到 92%）', () => {
    const contextWindow = 200_000
    const keep = compactionKeepRecentTokens(contextWindow, 20_000)
    expect(keep).toBe(20000)
    // 触发线 ≈ 窗口 − 预留（≈92%），拿它当手动压缩的闸就是这个 bug 的成因
    expect(keep).toBeLessThan(contextWindow * 0.5)
  })
})
