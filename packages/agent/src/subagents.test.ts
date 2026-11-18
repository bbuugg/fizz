/**
 * 子任务派活的两份契约。
 *
 * ## 一、结论不能被「最后一步是工具调用」吃掉
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
 *
 * ## 二、派活**不阻塞**父轮
 *
 * `agent-<id>` 从前是「跑完整条子 run 才 return」，于是模型那句「同时我自己看看这个文件」
 * 只能排在子任务后面：一步之内模型发完 tool-call 就把话轮交出去了，必须等这一步的工具
 * **全部** resolve 才能发下一次请求。现在拆成「立即返回 taskId」+「`task_wait` 领结论」，
 * 等的时机归模型自己定。下面的用例盯这个拆分的四个面：立刻返回 / 领得到 / 领不到要说清 /
 * 收尾要掐干净。
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
  description: string
  execute: (input: { task: string }, options: { toolCallId: string }) => Promise<string>
}

type WaitTool = {
  description: string
  execute: (input: { taskId: string }) => Promise<string>
}

/** 造一条子 run 的流：正文可有可无，最后一步固定是一次工具调用（步数耗尽时的典型形状） */
function fakeStream(text: string) {
  return {
    fullStream: (async function* () {
      yield { type: 'start-step' }
      if (text) yield { type: 'text-delta', text }
      yield { type: 'tool-call', toolName: 'read', toolCallId: 'c1', input: { file_path: 'a.ts' } }
      yield { type: 'tool-result', toolName: 'read', toolCallId: 'c1', output: '…' }
    })(),
    // 关键：最后一步没有正文 —— 真实场景里 AI SDK 给的就是空串
    text: Promise.resolve(''),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    steps: Promise.resolve([])
  }
}

/** 子 run 一直挂着，直到 signal 被 abort（真实 SDK 中止时抛 AbortError） */
function hangingStream(signal: AbortSignal | undefined) {
  return {
    fullStream: (async function* () {
      // 先吐一帧 start-step，确保子 run 已经进入迭代（与真实流同形）
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

interface Built {
  tools: Record<string, unknown>
  events: AgentStreamEvent[]
  /** 父轮收尾（真实调用点在 `agent.ts`：流结束 / 出错 / 重试换一份之前） */
  settle: () => Promise<void>
  commandStops: Map<string, () => void>
}

function build(
  extra: {
    ids?: string[]
    maxSteps?: Partial<Record<SubagentId, number>>
    definitions?: Array<{
      id: string
      name: string
      description: string
      tools: string[]
      maxSteps: number
    }>
    parent?: AbortController
  } = {}
): Built {
  const events: AgentStreamEvent[] = []
  const commandStops = new Map<string, () => void>()
  const set = buildDelegationTools((extra.ids ?? ['explorer']) as SubagentId[], {
    workspacePath: 'D:/fake-workspace',
    workspaceName: 'fake',
    model: {} as AiModelConfig,
    ...(extra.maxSteps ? { maxSteps: extra.maxSteps } : {}),
    ...(extra.definitions ? { definitions: extra.definitions } : {}),
    emit: (event) => events.push(event),
    ...(extra.parent ? { signal: extra.parent.signal } : {}),
    commandStops,
    stats: makeDelegationStats()
  })
  return { tools: set.tools, events, settle: set.settle, commandStops }
}

/** 派活：立即返回句柄（子任务还在后台跑） */
function delegate(built: Built, task = '看看 auth 的入口在哪', toolCallId = 'parent-1') {
  return (built.tools['agent-explorer'] as DelegationTool).execute({ task }, { toolCallId })
}

/** 领结论 */
function wait(built: Built, taskId = 'parent-1') {
  return (built.tools.task_wait as WaitTool).execute({ taskId })
}

/** 派活 + 立刻领结论：绝大多数用例关心的是结论，不关心中间那段 */
async function runDelegation(
  text: string,
  maxSteps?: Partial<Record<SubagentId, number>>
): Promise<{ out: string; events: AgentStreamEvent[] }> {
  const built = build({ ...(maxSteps ? { maxSteps } : {}) })
  vi.mocked(streamText).mockClear()
  vi.mocked(streamText).mockReturnValue(fakeStream(text) as never)
  await delegate(built)
  const out = await wait(built)
  return { out, events: built.events }
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
 * 派活不再阻塞父轮。
 *
 * 防的是回退：`execute` 一旦又开始 `await` 子 run，父模型就得等它跑完才能发下一步请求，
 * 「同时我自己看看这个文件」重新变成排队 —— 并行能力白给。
 */
describe('派活不阻塞父轮', () => {
  it('子任务还在跑时 execute 就已经返回句柄，句柄里带 taskId 与领取方式', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )

    const handle = await delegate(built)

    // 流还挂着，句柄已经回来了 —— 这一步不等子任务
    expect(handle).toContain('parent-1')
    expect(handle).toContain('task_wait')
    // 没有 `subagent-end`：它确实还在跑，不是「跑完了被藏起来」
    expect(built.events.some((e) => e.type === 'subagent-end')).toBe(false)
    await built.settle()
  })

  it('派活工具的说明里写清了「立即返回 + 结论靠 task_wait 领」', () => {
    const built = build()
    const tool = built.tools['agent-explorer'] as DelegationTool

    // 这两句是行为契约：少了模型会「派完就当自己有结论了」，或者干等在那儿
    expect(tool.description).toContain('立即返回')
    expect(tool.description).toContain('task_wait')
    expect(tool.description).toContain('收尾前必须把派出去的活都领回来')
  })

  it('task_wait 能领到结论（结论没丢）', async () => {
    const built = build()
    vi.mocked(streamText).mockReturnValue(fakeStream('结论在 src/auth.ts') as never)
    await delegate(built)

    expect(await wait(built)).toContain('结论在 src/auth.ts')
  })

  it('task_wait 认不出的 taskId 要说清当前有哪些在跑，而不是一句「没有」', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await delegate(built)

    const out = await wait(built, 'task-typo')
    expect(out).toContain('没有这个 taskId')
    expect(out).toContain('parent-1')
    await built.settle()
  })
})

/**
 * 父轮收尾要把没领的派活掐掉。
 *
 * 不掐的话子 run 继续烧 token、`subagent-end` 发往一个已经关掉的事件通道 ——
 * 派活卡在界面上永远转圈，用户以为还在跑。
 */
describe('父轮收尾 · 没被领走的派活', () => {
  it('掐掉未领的派活，收成 aborted，并留一行日志（不许静默丢掉）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await delegate(built)

    await built.settle()

    const end = built.events.find((e) => e.type === 'subagent-end')
    expect(end && end.type === 'subagent-end' ? end.status : null).toBe('aborted')
    // 「派了但结论没人领」= 白跑一趟，必须留得下痕迹
    expect(warn.mock.calls.some((args) => String(args[0]).includes('没被领走'))).toBe(true)
  })

  it('领过的派活不再算「白跑」，settle 是空操作（不给用户刷日志）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockReturnValue(fakeStream('结论') as never)
    await delegate(built)
    await wait(built)

    await built.settle()

    expect(warn.mock.calls.some((args) => String(args[0]).includes('没被领走'))).toBe(false)
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
 * 1. 派活后没把 stop 登记进 run 的 `commandStops` —— 前端点了后端查不到，
 *    `POST /api/chat/command/stop` 返回 `{ stopped: false }`；
 * 2. 登记了但没注销 —— 跑完之后那颗 stop 还挂在表里，成了点了不响的按钮；
 * 3. 把「用户主动停」当成失败 —— 父模型会换个姿势再派一次，正是用户刚掐掉的活。
 */
describe('子任务单条停止', () => {
  it('停止钮命中：abort 这一个子 run，收成 aborted 并注销停止表', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await delegate(built)

    // 登记发生在 execute 的同步段里，不必等异步
    const stop = built.commandStops.get('parent-1')
    expect(typeof stop).toBe('function')
    stop?.()
    // 交给父上下文的是「用户中止」，不是「执行失败」
    const out = await wait(built)

    expect(out).toContain('用户中止')
    expect(out).not.toContain('执行失败')
    const end = built.events.find((e) => e.type === 'subagent-end')
    expect(end && end.type === 'subagent-end' ? end.status : null).toBe('aborted')
    expect(built.commandStops.has('parent-1')).toBe(false)
  })

  it('父轮中止仍然带走子 run（signal 取或没丢）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const parent = new AbortController()
    const built = build({ parent })
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await delegate(built)

    parent.abort()

    expect(await wait(built)).toContain('用户中止')
    const end = built.events.find((e) => e.type === 'subagent-end')
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

  it('按定义生成 agent-<id>；未定义的 id 被跳过而不是抛错', () => {
    const built = build({ ids: ['explorer', def.id, 'ghost'], definitions: [def] })
    expect(Object.keys(built.tools)).toEqual(['agent-explorer', `agent-${def.id}`, 'task_wait'])
  })

  it('派活事件带上显示名（删掉定义后历史仍能显示）', async () => {
    const built = build({ ids: [def.id], definitions: [def] })
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockReturnValue(fakeStream('结论') as never)
    await (built.tools[`agent-${def.id}`] as DelegationTool).execute(
      { task: '核对一下' },
      { toolCallId: 'parent-2' }
    )

    const start = built.events.find((e) => e.type === 'subagent-start')
    expect(start && start.type === 'subagent-start' ? start.name : undefined).toBe('文档核对')
  })

  it('步数优先级：设置页覆盖 > 定义值 > 默认', () => {
    expect(resolveMaxSteps(def.id, { [def.id]: 30 }, 12)).toBe(30)
    expect(resolveMaxSteps(def.id, undefined, 12)).toBe(12)
    expect(resolveMaxSteps('custom-unknown', undefined)).toBe(SUBAGENT_META.explorer.defaultMaxSteps)
  })
})
