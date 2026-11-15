/**
 * token 估算的刻度（CJK 加权）+ 轮中压缩（`compactModelMessages`）的切点/合并行为。
 *
 * 估算为什么必须准：压缩的**切点**和「压缩后多大」都靠它，而触发线靠上游真实 usage。
 * 两者刻度不一致时，就会出现「压完还满、跑一个工具又爆红、每轮都在压」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { streamText } from 'ai'
import { compactModelMessages, estimateMessagesTokens, estimateTokens } from './context'
import type { ModelMessage } from 'ai'
import type { AiModelConfig } from '@fizz/contracts/types'

vi.mock('./resolve-model', () => ({ resolveModel: () => ({}) }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, streamText: vi.fn() }
})

function fakeStream(chunks: string[], finishReason = 'stop'): never {
  return {
    textStream: (async function* () {
      for (const chunk of chunks) yield chunk
    })(),
    finishReason: Promise.resolve(finishReason)
  } as never
}

const MODEL = {} as unknown as AiModelConfig
const ZH = '中'

describe('estimateTokens（CJK 加权刻度）', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('纯 ASCII 与 pi 的 ceil(chars / 4) 完全一致', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('x'.repeat(2000))).toBe(500)
  })

  it('汉字按 1 token 计，不再被除以 4', () => {
    expect(estimateTokens('中文')).toBe(2)
    expect(estimateTokens(ZH.repeat(400))).toBe(400)
  })

  it('中英混排：宽字符单独计、其余仍按 4 字符 1 token', () => {
    expect(estimateTokens('中文abcd')).toBe(3)
    expect(estimateTokens('，。')).toBe(2)
  })

  it('工具结果必须算进去（编码 agent 的上下文大头）', () => {
    const message: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'read',
          output: { type: 'text', value: 'x'.repeat(4000) }
        }
      ]
    }
    expect(estimateMessagesTokens([message])).toBeGreaterThan(990)
  })
})

describe('compactModelMessages（轮中压缩）', () => {
  const gen = vi.mocked(streamText)

  beforeEach(() => {
    gen.mockReset()
    gen.mockImplementation(() => fakeStream(['摘要', '正文']))
  })

  /** 一问一答 + 一条工具结果，约 500 token */
  const LONG = 'x'.repeat(2000)
  function turn(i: number): ModelMessage[] {
    return [
      { role: 'user', content: `第 ${i} 轮` },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: `c${i}`, toolName: 'read', input: { file_path: `src/${i}.ts` } }
        ]
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: `c${i}`, toolName: 'read', output: { type: 'text', value: LONG } }
        ]
      }
    ]
  }
  const history = (n: number): ModelMessage[] =>
    Array.from({ length: n }, (_, i) => turn(i + 1)).flat()

  /**
   * provider 的消息校验规则：每条 `tool` 消息都必须**紧跟在**带同名 `tool-call` 的
   * assistant 后面。不满足时上游直接拒掉整轮（OpenAI / DeepSeek 口径）：
   * `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。
   *
   * 压缩最容易踩这一条：`toModelMessages` 把结果收成独立的 `tool` 消息，切点落在它上面
   * 就只剩结果、丢掉调用，摘要置顶后序列第一条直接是 `tool`。
   */
  function expectToolPairing(messages: ModelMessage[]): void {
    messages.forEach((m, i) => {
      if (m.role !== 'tool') return
      const prev = messages[i - 1]
      expect(prev?.role).toBe('assistant')
      const calls = Array.isArray(prev?.content)
        ? (prev!.content as Array<{ type: string; toolCallId?: string }>)
            .filter((p) => p.type === 'tool-call')
            .map((p) => p.toolCallId)
        : []
      const results = (m.content as Array<{ type: string; toolCallId?: string }>).filter(
        (p) => p.type === 'tool-result'
      )
      for (const r of results) expect(calls).toContain(r.toolCallId)
    })
  }

  it('未越过阈值时不调摘要模型', async () => {
    const input = history(2)
    const r = await compactModelMessages(input, { contextWindow: 4000, model: MODEL })
    expect(r.compressed).toBeNull()
    expect(r.messages).toBe(input)
    expect(gen).not.toHaveBeenCalled()
  })

  it('越过阈值时摘要旧消息、保留近期原文', async () => {
    const r = await compactModelMessages(history(8), {
      contextWindow: 4000,
      model: MODEL,
      settings: { keepRecentTokens: 1024 }
    })
    expect(r.compressed).not.toBeNull()
    expect(gen).toHaveBeenCalledTimes(1)
    expect(r.messages.length).toBeLessThan(24)
    expect(r.summary).toContain('<read-files>')
  })

  it('切点落在 tool 结果上时退回到它的 tool-call，不留孤儿 tool 消息', async () => {
    // 这组参数下按 token 累加算出的切点正好是一条 `tool` 消息（每轮 ≈ 511 token，
    // 保留区 1024 → 退到「user / assistant / tool」中间那一格）
    const r = await compactModelMessages(history(8), {
      contextWindow: 4000,
      model: MODEL,
      settings: { keepRecentTokens: 1024 }
    })
    expect(r.compressed).not.toBeNull()
    expect(r.messages[0]?.role).toBe('user')
    expectToolPairing(r.messages)
  })

  it('切点前面只剩上一份摘要 → 不压、不调模型', async () => {
    const summary: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text: '（以下是对先前对话的交接摘要，替代原始历史）\n\n旧摘要' }]
    }
    // 保留区 = 原文总长 → 切点正好落在索引 1，切点前面只剩那条摘要
    const turns = history(5)
    const input = [summary, ...turns]
    const r = await compactModelMessages(input, {
      // 窗口要大一点：`resolveCompactionSettings` 会把 keep 钳到「预算的 80%」以内
      contextWindow: 20000,
      model: MODEL,
      triggerTokens: 16000,
      settings: { keepRecentTokens: estimateMessagesTokens(turns) }
    })
    expect(r.compressed).toBeNull()
    expect(gen).not.toHaveBeenCalled()
  })

  it('有新增消息时把旧摘要当 previous-summary，不再把它当对话重摘要', async () => {
    const summary: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text: '（以下是对先前对话的交接摘要，替代原始历史）\n\n旧摘要：已完成 A' }]
    }
    const r = await compactModelMessages([summary, ...history(6)], {
      contextWindow: 4000,
      model: MODEL,
      triggerTokens: 5000,
      settings: { keepRecentTokens: 2000 }
    })
    expect(r.compressed).not.toBeNull()
    const prompt = (
      gen.mock.calls[0]?.[0] as unknown as { messages: Array<{ content: string }> }
    ).messages[0]!.content
    expect(prompt).toContain('<previous-summary>')
    const conversation = prompt.slice(prompt.indexOf('<conversation>'), prompt.indexOf('</conversation>'))
    expect(conversation).not.toContain('旧摘要：已完成 A')
  })
})
