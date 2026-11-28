/**
 * 这组测的是「一次尝试失败时，用户只该看到一条提示，且这一轮必须被标成失败」。
 *
 * 防的两个回归（都出在 `agent.ts` 的流内 error 分支 / 收尾判定）：
 *
 * 1. 同一个故障被说两遍：上游渠道全挂时 AI SDK 自己重试 3 次后往 fullStream 里吐一条
 *    error part（`Failed after 3 attempts. Last error: AI_APICallError: …`），以前我们
 *    当场下发了；这次尝试又一个内容都没产出，收尾时又合成一条「上游返回空响应」——
 *    对话框里两句 `⚠️ ` 各挂一颗「重新加载」。
 * 2. 吐了半截正文就报错，却被当成跑完了：多步续写时「下一步请求」撞上限流 / 断网
 *    （`concurrency reached` 这类）会留下半截回复 + 一句 `⚠️ `，收尾却报 `done`，
 *    于是既不重试、内容也不完整。现在按失败收尾，然后看有没有断点：
 *    - 有断点（工具跑完了、走到了步边界）→ 断点续跑：从失败那一步接着发，`retry` 事件
 *      带 `resume`，前端只回滚最后一步的半截输出，已完成的步骤不重跑；
 *    - 没断点且执行过工具 → 只标失败、不重跑（整轮重来会重复副作用）；
 *    - 没断点也没工具 → 整轮重来，`retry` 不带 `resume`，前端清空重跑。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent, AiModelConfig } from '@fizz/contracts/types'

const { streamText } = vi.hoisted(() => ({ streamText: vi.fn() }))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText
}))
vi.mock('./resolve-model', () => ({ resolveModel: () => ({ modelId: 'mock' }) }))
// 重试退避真的等 1s 会把整组拖慢，且与这里要验的东西无关（只关心「重试过」）
vi.mock('./retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./retry')>()),
  sleepWithSignal: async () => true
}))

const { buildTurnUsage, createTurnGenClock, isOutputDelta, markTurnOutputDelta, runAgent } =
  await import('./agent')

/** 造一份 AI SDK 的 fullStream：parts 就是上游依次吐出来的东西 */
function fakeStream(parts: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part
    })()
  }
}

const UPSTREAM_ERROR =
  'Failed after 3 attempts. Last error: AI_APICallError: No available channel for model ' +
  'cline/glm-5.3-flash under group default (distributor)'

/** 已经吐了半截正文之后才失败（在线表现：`concurrency reached, current: 11, limit: 10`） */
const MID_STREAM_ERROR =
  'Failed after 3 attempts. Last error: AI_APICallError: concurrency reached, ' +
  'current: 11, limit: 10'

function baseOptions(onEvent: (event: AgentStreamEvent) => void) {
  return {
    scope: { kind: 'global', id: 'w1', name: 'W' } as const,
    history: [],
    model: {
      provider: 'openai',
      apiKey: 'sk-test',
      models: [],
      model: 'm1'
    } as unknown as AiModelConfig,
    skills: [],
    /** 自造装配：不读工作区、不挂真实工具（本组只关心事件流） */
    assemble: () => ({ instructions: 'SYS' }),
    toolIntent: false,
    maxRetries: 1,
    onEvent
  }
}

type ErrorEvent = Extract<AgentStreamEvent, { type: 'error' }>
const errorEvents = (events: AgentStreamEvent[]): ErrorEvent[] =>
  events.filter((e): e is ErrorEvent => e.type === 'error')

describe('runAgent 的失败提示', () => {
  beforeEach(() => {
    streamText.mockReset()
  })

  it('流内已报错且整轮无内容时，只下发一条错误（不再追加「上游返回空响应」）', async () => {
    streamText.mockImplementation(() => fakeStream([{ type: 'error', error: new Error(UPSTREAM_ERROR) }]))

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    // 第 1 次失败 → 一次重试 → 第 2 次仍失败且次数到顶
    expect(streamText).toHaveBeenCalledTimes(2)
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1)

    const errors = errorEvents(events)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe(UPSTREAM_ERROR)
    expect(result.finishReason).toBe('error')
    expect(result.error).toBe(UPSTREAM_ERROR)
  })

  it('上游静默回空响应（没有任何 error part）时，仍然只报一条空响应', async () => {
    streamText.mockImplementation(() => fakeStream([]))

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    const errors = errorEvents(events)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('上游返回空响应')
    expect(result.finishReason).toBe('error')
  })

  it('已经产出过内容 + 尾部流内 error（未执行工具）：按失败处理并允许重试，不报成 done', async () => {
    streamText.mockImplementation(() =>
      fakeStream([
        { type: 'text-delta', text: '你好' },
        { type: 'error', error: new Error(MID_STREAM_ERROR) }
      ])
    )

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    // 半截正文 + 失败 → 重跑整轮（`retry` 事件让前端把半截内容清掉，避免正文重复）
    //
    // 这条同时钉住「重试计数什么时候**不**清零」：整轮重来会把产出清掉，那不算「回复了
    // 内容」，次数照常累计 —— 否则每次吐半截就断会成为无限重试（见下面那条续跑用例）。
    expect(streamText).toHaveBeenCalledTimes(2)
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1)
    expect(result.finishReason).toBe('error')
    expect(result.error).toBe(MID_STREAM_ERROR)

    // 每次尝试至多一条错误，且绝不掺「上游返回空响应」
    const errors = errorEvents(events)
    expect(errors.length).toBeLessThanOrEqual(2)
    expect(errors.every((e) => e.message === MID_STREAM_ERROR)).toBe(true)
  })

  it('首个请求前的 prepareStep 不应建立可续跑断点', async () => {
    streamText.mockImplementation(
      (opts: {
        messages: unknown[]
        prepareStep?: (args: { messages: unknown[]; stepNumber: number }) => Promise<unknown>
      }) => {
        const attempt = streamText.mock.calls.length
        return {
          fullStream: (async function* () {
            await opts.prepareStep?.({ messages: opts.messages, stepNumber: 0 })
            yield { type: 'text-delta', text: `第 ${attempt} 次半截` }
            if (attempt <= 2) {
              yield { type: 'error', error: new Error(MID_STREAM_ERROR) }
            } else {
              yield { type: 'finish', finishReason: 'stop' }
            }
          })()
        }
      }
    )

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    expect(streamText).toHaveBeenCalledTimes(2)
    const retry = events.find((event) => event.type === 'retry')
    expect(retry).toMatchObject({ attempt: 1 })
    expect(retry).not.toHaveProperty('resume')
    expect(result.finishReason).toBe('error')
  })

  it('执行过工具但**没有断点**（同一步内就失败）：不重试，避免重复副作用', async () => {
    // 真实 AI SDK 里工具执行完、发下一步请求之前一定会调 `prepareStep`，断点就在那里。
    // 这条用例模拟的是「同一步内工具结果之后立刻断流」：没有走到边界，也就没有断点可用，
    // 只能整轮重来 —— 而整轮重来会把工具再执行一遍，所以宁可不重试。
    streamText.mockImplementation(() =>
      fakeStream([
        { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: {} },
        { type: 'tool-result', toolCallId: 't1', toolName: 'echo', output: 'ok' },
        { type: 'text-delta', text: '好的' },
        { type: 'error', error: new Error(MID_STREAM_ERROR) }
      ])
    )

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    expect(streamText).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'retry')).toBe(false)
    expect(result.finishReason).toBe('error')
    expect(result.error).toBe(MID_STREAM_ERROR)

    // 流里已经下发过那条错误了，收尾不许再补一条
    expect(errorEvents(events)).toHaveLength(1)
  })

  it('执行过工具但有断点：断点续跑 —— 下一次请求带着已完成的工具结果，retry 标 resume', async () => {
    /** 断点里那份消息：工具执行完、下一步请求之前，AI SDK 传给 `prepareStep` 的就是它 */
    const withToolResult = [
      { role: 'user', content: '读一下文件' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: { path: 'a.ts' } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'echo',
            output: { type: 'text', value: 'ok' }
          }
        ]
      }
    ]
    const hasToolMessage = (messages: readonly { role: string }[]): boolean =>
      messages.some((m) => m.role === 'tool')

    streamText.mockImplementation(
      (opts: {
        messages: readonly { role: string }[]
        prepareStep?: (args: { messages: unknown[]; stepNumber: number }) => Promise<unknown>
      }) => {
        // 第 2 次调用 = 续跑：起点应当已经是断点那份（带着 tool 消息）
        if (hasToolMessage(opts.messages)) {
          return fakeStream([
            { type: 'text-delta', text: '继续写' },
            {
              type: 'finish',
              finishReason: 'stop',
              totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
            }
          ])
        }
        return {
          fullStream: (async function* () {
            yield { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: { path: 'a.ts' } }
            yield { type: 'tool-result', toolCallId: 't1', toolName: 'echo', output: 'ok' }
            // 工具跑完 → 引擎调 prepareStep（断点就是它返回的 messages）→ 下一步请求失败
            await opts.prepareStep?.({ messages: withToolResult, stepNumber: 1 })
            yield { type: 'error', error: new Error(MID_STREAM_ERROR) }
          })()
        }
      }
    )

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    // 一次续跑就接着跑完了：没有整轮重来，也没有重复执行工具
    expect(streamText).toHaveBeenCalledTimes(2)
    expect(events.find((e) => e.type === 'retry')).toMatchObject({ attempt: 1, resume: true })
    const resumed = streamText.mock.calls[1]?.[0] as { messages: { role: string }[] } | undefined
    expect(hasToolMessage(resumed?.messages ?? [])).toBe(true)
    expect(result.finishReason).toBe('done')
    // 续跑那一段的正文照常下发（前端保留前半段、接着往下写）
    const streamed = events
      .filter((e): e is Extract<AgentStreamEvent, { type: 'text-delta' }> => e.type === 'text-delta')
      .map((e) => e.delta)
      .join('')
    expect(streamed).toContain('继续写')
  })

  /**
   * 防的回归：重试次数曾是「整轮累计」，于是「开头抖动两次 + 中途再撞限流」时一次机会
   * 都不剩（用户报的「设置 20 却只重试两次，后面直接报错」）。
   *
   * 现在语义是「**连续**失败次数」：某次尝试产出过内容、且那份内容留得住（能续跑）时清零。
   * 这条用例里 `maxRetries = 1`，只要清零没生效，第 2 次失败就会直接收场（只调用 2 次）。
   */
  it('续跑中产出过内容后再失败：次数清零重计，而不是直接耗尽', async () => {
    const withToolResult = [
      { role: 'user', content: '读一下文件' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: { path: 'a.ts' } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'echo',
            output: { type: 'text', value: 'ok' }
          }
        ]
      }
    ]
    const hasToolMessage = (messages: readonly { role: string }[]): boolean =>
      messages.some((m) => m.role === 'tool')

    let call = 0
    streamText.mockImplementation(
      (opts: {
        messages: readonly { role: string }[]
        prepareStep?: (args: { messages: unknown[]; stepNumber: number }) => Promise<unknown>
      }) => {
        call += 1
        // 第 3 次 = 续跑：起点已是断点（带 tool 消息），这次正常跑完
        if (hasToolMessage(opts.messages)) {
          return fakeStream([
            { type: 'text-delta', text: '写完了' },
            {
              type: 'finish',
              finishReason: 'stop',
              totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
            }
          ])
        }
        // 第 1 次：没断点也没工具，吐了半截就断 → 整轮重来（这次**不**清零，见下个用例）
        if (call === 1) {
          return fakeStream([
            { type: 'text-delta', text: '开头' },
            { type: 'error', error: new Error(MID_STREAM_ERROR) }
          ])
        }
        // 第 2 次：跑到步边界（断点建立）之后才断 → 续跑，且这一段清零后重新计
        return {
          fullStream: (async function* () {
            yield { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: { path: 'a.ts' } }
            yield { type: 'tool-result', toolCallId: 't1', toolName: 'echo', output: 'ok' }
            await opts.prepareStep?.({ messages: withToolResult, stepNumber: 1 })
            yield { type: 'text-delta', text: '这一步也吐了字' }
            yield { type: 'error', error: new Error(MID_STREAM_ERROR) }
          })()
        }
      }
    )

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    // 第 2 次失败时若不重置，`retries(1) < maxRetries(1)` 已不成立 → 只有 2 次调用
    expect(streamText).toHaveBeenCalledTimes(3)
    const retries = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'retry' }> => e.type === 'retry'
    )
    expect(retries).toHaveLength(2)
    // 第一次是整轮重来；第二次是续跑，且次数**从 1 重新数**（不是 2）
    expect(retries[0]).toMatchObject({ attempt: 1 })
    expect(retries[1]).toMatchObject({ attempt: 1, resume: true })
    expect(result.finishReason).toBe('done')
  })
})

/**
 * TPS 的分母（回归测试 · 端到端）：**只累计有输出增量的时间片**。
   *
   * 防的回归：老口径是「首字 → 整轮结束」的墙钟。一轮十几次工具调用的轮次里，光工具
   * 执行就几十秒，分母被撑到几十秒 —— 用户看到 0.7 tok/s，既不反映模型吐字快慢，
   * 也没法在轮次之间比较（工具越多看着越"慢"）。
   *
   * 这里走真实链路（`runAgent` + 假时钟），钉住「工具执行的 30 秒不进分母」。
   */
describe('上下文圆环 · 收尾回归', () => {
  it('自定义 profile 也装配 todowrite，而不是只在文件工具 profile 中出现', async () => {
    streamText.mockImplementation((options) => {
      expect(options.tools).toHaveProperty('todowrite')
      return fakeStream([{ type: 'text-delta', text: 'done' },
        { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } }])
    })
    await runAgent(baseOptions(() => {}))
  })

  it('再次发送时沿用上轮匹配的测量，只增加新消息而不切回偏小的全量估算', async () => {
    streamText.mockImplementation((options) => ({
      fullStream: (async function* () {
        await options.prepareStep({ messages: options.messages, stepNumber: 0 })
        const usage = { inputTokens: 50000, outputTokens: 20 }
        await options.onStepEnd({ response: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }] }, usage })
        yield { type: 'text-delta', text: 'done' }
        yield { type: 'finish-step', finishReason: 'stop', usage }
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      })()
    }))
    const first = await runAgent(baseOptions(() => {}))
    const events: AgentStreamEvent[] = []
    await runAgent({ ...baseOptions((event) => events.push(event)), history: [
      { id: 'a', role: 'assistant', createdAt: 1, parts: [{ type: 'text', text: 'done' }], usage: first.usage },
      { id: 'u', role: 'user', createdAt: 2, parts: [{ type: 'text', text: '继续' }] }
    ] })
    const usage = events.find((event) => event.type === 'context-usage')
    expect(usage).toMatchObject({ used: 50022 })
  })
  for (const complete of [true, false]) {
    it(`最后一步${complete ? '完整' : '缺输入'} usage 不丢工具结果或骤降到输出量`, async () => {
      streamText.mockImplementation((options) => ({
        fullStream: (async function* () {
          await options.prepareStep({ messages: options.messages, stepNumber: 0 })
          const response = [
            { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: {} }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'read', output: { type: 'text', value: '中'.repeat(4000) } }] }
          ]
          const usage = complete ? { inputTokens: 10000, outputTokens: 20 } : { outputTokens: 20 }
          await options.onStepEnd({ response: { messages: response }, usage })
          yield { type: 'text-delta', text: 'done' }
          yield { type: 'finish-step', finishReason: 'stop', usage }
          yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
        })()
      }))
      const events: AgentStreamEvent[] = []
      const result = await runAgent(baseOptions((event) => events.push(event)))
      expect(result.usage?.contextTokens).toBeGreaterThanOrEqual(4000)
      if (complete) expect(result.usage?.contextTokens).toBe(14020)
      const finish = events.findLast((event) => event.type === 'finish')
      if (finish?.type !== 'finish') throw new Error('missing finish')
      expect(finish.usage?.contextTokens).toBe(result.usage?.contextTokens)
    })
  }
})

describe('TurnUsage.tps · 端到端', () => {
    it('工具执行的 30 秒空窗不计入 TPS 分母，整轮耗时仍按墙钟报', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      streamText.mockImplementation(() =>
        fakeStream([
          { type: 'text-delta', text: 'a' },
          { type: 'text-delta', text: 'b' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: {} },
          // 工具跑了 30 秒：这段时间模型一个 token 都没吐
          { type: 'tool-result', toolCallId: 't1', toolName: 'echo', output: 'ok' },
          { type: 'text-delta', text: 'c' },
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
          }
        ])
      )

      /**
       * 每一帧被消费的时刻。`Date.now()` 在 `emitEvent` **之前**读，所以在 `onEvent`
       * 里把时钟拨到下一帧 —— 本用例没有 `tool-call-delta`（那会触发 flush，多收一次
       * 回调），所以回调次数与内容帧一一对应。
       */
      const times = [0, 100, 200, 30_200, 30_300]
      let seen = 0
      const events: AgentStreamEvent[] = []
      const result = await runAgent(
        baseOptions((event) => {
          events.push(event)
          seen += 1
          if (times[seen] !== undefined) vi.setSystemTime(times[seen] as number)
        })
      )

      // 生成窗口 = 100 + 100 = 200ms → 20 tokens / 0.2s = 100 tok/s
      // 墙钟口径会是 20 / 30.3s ≈ 0.7 tok/s
      expect(result.usage?.tps).toBe(100)
      // 耗时那一格的口径不变：整轮墙钟
      expect(result.usage?.durationMs).toBe(30_300)
      expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * 「什么算模型在吐 token」的唯一判据（`isOutputDelta`）。
 *
 * 分母只认它放行的帧：工具自己产出的内容（shell 的实时 stdout）、子任务的事件、
 * 上游的空占位帧都不许进 —— 否则分母又会被「不是模型生成的东西」污染回去。
 */
describe('isOutputDelta · 只认模型自己生成的增量', () => {
  const cases: [string, AgentStreamEvent, boolean][] = [
    ['正文增量', { type: 'text-delta', delta: 'a' }, true],
    // 上游常先发一帧空 delta 占位；认了它窗口会被撑大
    ['空占位帧（正文）', { type: 'text-delta', delta: '' }, false],
    ['思考增量', { type: 'reasoning-delta', delta: '嗯' }, true],
    ['工具入参增量', { type: 'tool-call-delta', toolCallId: 't1', inputTextDelta: '{' }, true],
    // `tool-call-input-streaming-start` 只有 id 没有内容
    ['工具入参开始帧', { type: 'tool-call-delta', toolCallId: 't1', inputTextDelta: '' }, false],
    // 有的上游不发入参增量，完整 tool-call 是它吐过字的唯一证据
    ['完整工具调用', { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: {} }, true],
    // shell 实时 stdout：工具在产出，不是模型的生成速度
    [
      '工具输出增量',
      { type: 'tool-output-delta', toolCallId: 't1', stream: 'stdout', delta: 'ok' },
      false
    ],
    ['工具结果', { type: 'tool-result', toolCallId: 't1', toolName: 'echo', output: 'ok' }, false],
    // 子任务的 token 记在 `TurnUsage.subagents`，分子里没有，分母也不能有
    [
      '子任务事件',
      { type: 'subagent-event', toolCallId: 't1', event: { type: 'text-delta', delta: '子' } },
      false
    ],
    ['收尾帧', { type: 'finish', finishReason: 'stop' }, false]
  ]

  for (const [name, event, want] of cases) {
    it(`${name} → ${want}`, () => {
      expect(isOutputDelta(event)).toBe(want)
    })
  }
})

/** TPS 的算式本身：分子是整轮输出 token，分母是生成窗口（不是墙钟）。 */
describe('buildTurnUsage · TPS', () => {
  it('outputTokens ÷ 生成窗口秒数（保留 1 位小数）', () => {
    const usage = buildTurnUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }, 0, 2_000)
    expect(usage.tps).toBe(10)
    // 整轮耗时走墙钟，与生成窗口是两个数
    expect(usage.durationMs).toBeGreaterThan(0)
  })

  it('一个间隔都没采到时退回整轮耗时，不除零也不出天文数字', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    try {
      // genMs = 0：上游把整段攒成一帧下发（非流式网关）/ 只吐了一个 chunk
      const usage = buildTurnUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }, 0, 0)
      expect(usage.tps).toBe(1)
      expect(Number.isFinite(usage.tps)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

/** 生成窗口的累计规则（纯函数，不依赖真实时钟）。 */
describe('markTurnOutputDelta · 生成窗口', () => {
  it('首帧只记时刻（TTFT 不进分母），之后按相邻间隔累计', () => {
    const clock = createTurnGenClock()
    markTurnOutputDelta(clock, 1_000)
    markTurnOutputDelta(clock, 1_100)
    markTurnOutputDelta(clock, 1_260)
    expect(clock.genMs).toBe(260)
  })

  it('空窗（> 1s）整段丢弃，且不影响前后的累计', () => {
    const clock = createTurnGenClock()
    markTurnOutputDelta(clock, 1_000)
    markTurnOutputDelta(clock, 1_100) // +100
    markTurnOutputDelta(clock, 31_100) // 工具跑了 30 秒：丢弃
    markTurnOutputDelta(clock, 31_180) // +80
    expect(clock.genMs).toBe(180)
  })

  it('时钟回拨 / 同一毫秒两帧不累加，也不会变成负数', () => {
    const clock = createTurnGenClock()
    markTurnOutputDelta(clock, 1_000)
    markTurnOutputDelta(clock, 1_000)
    markTurnOutputDelta(clock, 900)
    expect(clock.genMs).toBe(0)
  })
})

/**
 * 单轮步数预算的收尾语义：撞上限时 `finishReason` 仍是 `done`，但多带一位
 * `stopReason: 'max-steps'`（界面、通知、落盘都靠它，见 AGENTS.md 的「步数预算三件套」）。
 */
describe('runAgent 的步数预算', () => {
  it('用满步数预算且最后一步还在调工具 → 报 stopReason: max-steps（不是静默 done）', async () => {
    // 真实链路：`stopWhen: stepCountIs(2)` 在第 2 步的工具执行完后停下，那一步的
    // finishReason 是 'tool-calls'，模型再没有机会回话。以前这一轮会被报成纯粹的
    // `done`，用户看到的是「工具卡都跑完了、然后没有下文」，也查不出原因。
    streamText.mockImplementation(() =>
      fakeStream([
        { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: {} },
        { type: 'tool-result', toolCallId: 't1', toolName: 'echo', output: 'ok' },
        { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        { type: 'tool-call', toolCallId: 't2', toolName: 'echo', input: {} },
        { type: 'tool-result', toolCallId: 't2', toolName: 'echo', output: 'ok' },
        { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } }
      ])
    )

    const events: AgentStreamEvent[] = []
    const result = await runAgent({ ...baseOptions((event) => events.push(event)), maxSteps: 2 })

    const finish = events.find(
      (e): e is Extract<AgentStreamEvent, { type: 'finish' }> => e.type === 'finish'
    )
    // finishReason 仍是 done（它不是错误、也不是用户停的），只是多了 stopReason
    expect(finish).toMatchObject({ finishReason: 'done', stopReason: 'max-steps', steps: 2 })
    expect(result).toMatchObject({ finishReason: 'done', stopReason: 'max-steps', steps: 2 })
  })

  it('步数没到预算就自然收尾 → 不带 stopReason', async () => {
    streamText.mockImplementation(() =>
      fakeStream([
        { type: 'text-delta', text: '做完了' },
        { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      ])
    )

    const events: AgentStreamEvent[] = []
    const result = await runAgent({ ...baseOptions((event) => events.push(event)), maxSteps: 2 })

    const finish = events.find(
      (e): e is Extract<AgentStreamEvent, { type: 'finish' }> => e.type === 'finish'
    )
    expect(finish?.stopReason).toBeUndefined()
    expect(result.stopReason).toBeUndefined()
  })
})

/**
 * 装配失败（插件挂载 / 审批壳 / filterTools / 提示词渲染抛错）时，这一轮直接起不来：
 * `runAgent` 的 `finish` 不会执行，本轮 context 只能由 `mountAssembly` 自己兜底卸载。
 * 漏掉的话，插件在装配阶段启动的定时器 / 连接 / 监听器会跟着进程一直留着。
 */
describe('装配失败时的 context 清理', () => {
  beforeEach(() => {
    streamText.mockReset()
  })

  it('mountAssembly 抛错时插件仍被卸载，错误照常冒出去', async () => {
    let disposed = false
    await expect(
      runAgent({
        ...baseOptions(() => {}),
        assemble: () => ({
          instructions: 'SYS',
          plugins: [{ plugin: () => () => { disposed = true } }],
          filterTools: () => {
            throw new Error('装配失败')
          }
        })
      })
    ).rejects.toThrow('装配失败')
    expect(disposed).toBe(true)
  })
})
