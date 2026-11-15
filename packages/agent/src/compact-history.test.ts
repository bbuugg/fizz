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
