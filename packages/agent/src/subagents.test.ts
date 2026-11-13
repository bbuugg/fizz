/**
 * 子任务「跑着跑着自己停了」的回归。
 *
 * ## 防的是什么
 *
 * `result.text` 只含**最后一步**的文本（AI SDK 的原文注释：「The text that was generated
 * in the final step」）。子 agent 用满步数上限的那一刻，最后一步往往还是一次工具调用，
 * 于是 `result.text` 是空串 —— 从前这里直接判成 `empty`：前面十几步写下的分析全被丢掉，
 * 父上下文只收到一句「子任务没有产出可用结论（可能在中间步骤就停了）」，
 * `subagent-end` 也报成 `empty`。
 *
 * 用户看到的「它经常自己停止」，大半是这一条：它并没停，是最后一次工具调用把结论挤掉了。
 *
 * 现在：逐步累积的正文兜底交回父上下文，并在前面标清楚「跑到步数上限才停」，父模型
 * 据此知道这是半成品（可以拆小重派），而不是当结论用。
 */
import { describe, expect, it, vi } from 'vitest'
import { streamText } from 'ai'
import { SUBAGENT_MAX_STEPS, SUBAGENT_META } from '@fizz/contracts/types'
import type { AgentStreamEvent, AiModelConfig, SubagentId } from '@fizz/contracts/types'
import { buildDelegationTools, makeDelegationStats, resolveMaxSteps } from './subagents'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: vi.fn()
}))

// 子 agent 的工具集在这里不参与断言：只要 `execute` 里那条流的行为，工具全替成空对象
vi.mock('@fizz/tools', () => ({
  buildAgentTools: () => ({}),
  buildWebFetchTool: () => ({}),
  buildGitReadTool: () => ({}),
  filterToolSet: (all: Record<string, unknown>) => all
}))

vi.mock('./resolve-model', () => ({ resolveModel: () => ({}) }))

type DelegationTool = {
  execute: (input: { task: string }, options: { toolCallId: string }) => Promise<string>
}

/** 造一条子 run 的流：正文可有可无，最后一步固定是一次工具调用（步数耗尽时的典型形状） */
function fakeStream(text: string) {
  return {
    fullStream: (async function* () {
      yield { type: 'start-step' }
      if (text) yield { type: 'text-delta', text }
      yield { type: 'tool-call', toolName: 'read_file', toolCallId: 'c1', input: { path: 'a.ts' } }
      yield { type: 'tool-result', toolName: 'read_file', toolCallId: 'c1', output: '…' }
    })(),
    // 关键：最后一步没有正文 —— 真实场景里 AI SDK 给的就是空串
    text: Promise.resolve(''),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    steps: Promise.resolve([])
  }
}

async function runDelegation(
  text: string,
  maxSteps?: Partial<Record<SubagentId, number>>
): Promise<{ out: string; events: AgentStreamEvent[] }> {
  const events: AgentStreamEvent[] = []
  const tools = buildDelegationTools(['explorer'], {
    workspacePath: 'D:/fake-workspace',
    workspaceName: 'fake',
    model: {} as AiModelConfig,
    ...(maxSteps ? { maxSteps } : {}),
    emit: (event) => events.push(event),
    stats: makeDelegationStats()
  })
  vi.mocked(streamText).mockClear()
  vi.mocked(streamText).mockReturnValue(fakeStream(text) as never)
  const out = await (tools['agent-explorer'] as DelegationTool).execute(
    { task: '看看 auth 的入口在哪' },
    { toolCallId: 'parent-1' }
  )
  return { out, events }
}

describe('子任务收尾 · 结论不能被「最后一步是工具调用」吃掉', () => {
  it('最后一步没正文时，交回已累积的正文，并标明是跑到上限才停', async () => {
    const { out, events } = await runDelegation('auth 的入口在 src/auth.ts:12。')

    expect(out).toContain('auth 的入口在 src/auth.ts:12。')
    expect(out).toContain('步数上限')
    // 交回了内容就算这一轮有产出，不该再报「没结论」
    expect(out).not.toContain('没有产出可用结论')
    const end = events.find((e) => e.type === 'subagent-end')
    expect(end && end.type === 'subagent-end' ? end.status : null).toBe('done')
  })

  it('一个字都没吐（真的空转）：仍然报 empty 并给兜底文案', async () => {
    const { out, events } = await runDelegation('')

    expect(out).toContain('没有产出可用结论')
    const end = events.find((e) => e.type === 'subagent-end')
    expect(end && end.type === 'subagent-end' ? end.status : null).toBe('empty')
  })
})

/**
 * 设置页的步数上限要真的走到 `stepCountIs` 上。
 *
 * 防的是「设置页存了、引擎没读」这种最常见的断链：UI 上看着是 30，跑起来还是 24，
 * 用户只会觉得「设了没用」。
 */
describe('子任务步数上限 · 设置 → 引擎', () => {
  it('没设过就用规格默认值（两端同一个真源）', () => {
    expect(resolveMaxSteps('explorer')).toBe(SUBAGENT_META.explorer.defaultMaxSteps)
    expect(resolveMaxSteps('reviewer')).toBe(SUBAGENT_META.reviewer.defaultMaxSteps)
  })

  it('设置页给的数优先', () => {
    expect(resolveMaxSteps('explorer', { explorer: 30 })).toBe(30)
    // 只管自己那一个 id：另一个子任务不受影响
    expect(resolveMaxSteps('reviewer', { explorer: 30 })).toBe(SUBAGENT_META.reviewer.defaultMaxSteps)
  })

  it('越界 / 非数字回默认（请求体不可信，引擎这层也要收敛）', () => {
    expect(resolveMaxSteps('explorer', { explorer: 0 })).toBe(SUBAGENT_META.explorer.defaultMaxSteps)
    expect(resolveMaxSteps('explorer', { explorer: SUBAGENT_MAX_STEPS + 1 })).toBe(
      SUBAGENT_META.explorer.defaultMaxSteps
    )
    expect(resolveMaxSteps('explorer', { explorer: Number.NaN })).toBe(
      SUBAGENT_META.explorer.defaultMaxSteps
    )
  })

  it('覆盖值确实传给了 stopWhen（少一步还继续，到数就停）', async () => {
    await runDelegation('结论', { explorer: 3 })

    const args = vi.mocked(streamText).mock.calls[0]?.[0] as {
      stopWhen?: (input: { steps: unknown[] }) => boolean
    }
    const stop = args?.stopWhen
    expect(typeof stop).toBe('function')
    expect(stop!({ steps: Array(2).fill({}) })).toBe(false)
    expect(stop!({ steps: Array(3).fill({}) })).toBe(true)
  })
})

/**
 * 派活卡上的停止钮：只停这一个子任务，父轮继续。
 *
 * 防的是三件事，任一漏掉都表现为「点了没反应 / 停错了东西」：
 * 1. execute 期间没把 stop 登记进 run 的 `commandStops` —— 前端点了后端查不到，
 *    `POST /api/chat/command/stop` 返回 `{ stopped: false }`；
 * 2. 登记了但没注销 —— 跑完之后那颗 stop 还挂在表里，成了点了不响的按钮；
 * 3. 把「用户主动停」当成失败 —— 父模型会换个姿势再派一次，正是用户刚掐掉的活。
 */
describe('子任务单条停止', () => {
  /** 子 run 一直挂着，直到 signal 被 abort（真实 SDK 中止时抛 AbortError） */
  function hangingStream(signal: AbortSignal | undefined) {
    return {
      fullStream: (async function* () {
        // 先吐一帧 start-step，确保 execute 已经进入迭代（与真实流同形）
        yield { type: 'start-step' }
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('AbortError')
      })(),
      text: Promise.resolve(''),
      totalUsage: Promise.resolve({})
    }
  }

  function setup(parent?: AbortController) {
    const events: AgentStreamEvent[] = []
    const commandStops = new Map<string, () => void>()
    const tools = buildDelegationTools(['explorer'], {
      workspacePath: 'D:/fake-workspace',
      workspaceName: 'fake',
      model: {} as AiModelConfig,
      emit: (event) => events.push(event),
      ...(parent ? { signal: parent.signal } : {}),
      commandStops,
      stats: makeDelegationStats()
    })
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    const running = (tools['agent-explorer'] as DelegationTool).execute(
      { task: '梳理 auth 的入口' },
      { toolCallId: 'parent-1' }
    )
    return { events, commandStops, running }
  }

  it('停止钮命中：abort 这一个子 run，收成 aborted 并注销停止表', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { events, commandStops, running } = setup()

    // 登记发生在 execute 的同步段里，不必等异步
    const stop = commandStops.get('parent-1')
    expect(typeof stop).toBe('function')
    stop?.()
    const out = await running

    // 交给父上下文的是「用户中止」，不是「执行失败」
    expect(out).toContain('用户中止')
    expect(out).not.toContain('执行失败')
    const end = events.find((e) => e.type === 'subagent-end')
    expect(end && end.type === 'subagent-end' ? end.status : null).toBe('aborted')
    expect(commandStops.has('parent-1')).toBe(false)
  })

  it('父轮中止仍然带走子 run（signal 取或没丢）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const parent = new AbortController()
    const { events, running } = setup(parent)

    parent.abort()
    const out = await running

    expect(out).toContain('用户中止')
    const end = events.find((e) => e.type === 'subagent-end')
    expect(end && end.type === 'subagent-end' ? end.status : null).toBe('aborted')
  })
})

describe('自定义子智能体', () => {
  const def = {
    id: 'custom-ab12cd34',
    name: '文档核对',
    description: '核对文档与代码是否一致',
    tools: ['read', 'grep'],
    maxSteps: 12
  }

  function build(
    ids: string[],
    definitions = [def],
    emit: (event: AgentStreamEvent) => void = () => {}
  ) {
    return buildDelegationTools(ids, {
      workspacePath: 'D:/fake-workspace',
      workspaceName: 'fake',
      model: {} as AiModelConfig,
      definitions,
      emit,
      stats: makeDelegationStats()
    })
  }

  it('按定义生成 agent-<id>；未定义的 id 被跳过而不是抛错', () => {
    const tools = build(['explorer', def.id, 'ghost'])
    expect(Object.keys(tools)).toEqual(['agent-explorer', 'agent-custom-ab12cd34'])
  })

  it('派活事件带上显示名（删掉定义后历史仍能显示）', async () => {
    const events: AgentStreamEvent[] = []
    const tools = build([def.id], [def], (event) => events.push(event))
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockReturnValue(fakeStream('结论') as never)
    await (tools[`agent-${def.id}`] as DelegationTool).execute(
      { task: '核对一下' },
      { toolCallId: 'parent-2' }
    )
    const start = events.find((e) => e.type === 'subagent-start')
    expect(start && start.type === 'subagent-start' ? start.name : undefined).toBe('文档核对')
  })

  it('步数优先级：设置页覆盖 > 定义值 > 默认', () => {
    expect(resolveMaxSteps(def.id, { [def.id]: 30 }, 12)).toBe(30)
    expect(resolveMaxSteps(def.id, undefined, 12)).toBe(12)
    expect(resolveMaxSteps('custom-unknown', undefined)).toBe(SUBAGENT_META.explorer.defaultMaxSteps)
  })
})
