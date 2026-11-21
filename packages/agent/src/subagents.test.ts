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
import { asSchema, streamText, type FlexibleSchema } from 'ai'
import { SUBAGENT_MAX_STEPS, SUBAGENT_META } from '@fizz/contracts/types'
import type { AgentStreamEvent, AiModelConfig, SubagentId } from '@fizz/contracts/types'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import { buildDelegationTools, makeDelegationStats, resolveMaxSteps, SUBAGENT_SPECS } from './subagents'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: vi.fn()
}))

/**
 * 工具集按「点名的键」造：白名单是契约的一部分，用例要能看出到底挂了哪些
 * （例如读图子任务不该带 `web_fetch`）。真实白名单过滤在 `@fizz/tools` 里另有测试。
 */
vi.mock('@fizz/tools', () => ({
  buildAgentTools: () => ({}),
  buildWebFetchTool: () => ({}),
  buildGitReadTool: () => ({}),
  filterToolSet: (_all: Record<string, unknown>, names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, {}])),
  createLocalBackend: () => {
    throw new Error('用例必须显式给 backend，别在这里落盘')
  }
}))

// 原样返回配置：用例靠「传进 streamText 的 model 是哪个对象」判断模型选择
vi.mock('./resolve-model', () => ({ resolveModel: (config: unknown) => config }))

type DelegationTool = {
  description: string
  inputSchema: FlexibleSchema<{ task: string; summary?: string; images?: string[] }>
  execute: (
    input: { task: string; summary?: string; images?: string[] },
    options: { toolCallId: string }
  ) => Promise<string>
}

type WaitTool = {
  description: string
  execute: (input: { taskId: string }) => Promise<string>
}

type CancelTool = {
  description: string
  execute: (input: { taskIds?: string[] }) => Promise<string>
}

type ListTool = {
  description: string
  execute: (input: Record<string, never>) => Promise<string>
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

/**
 * 吐一帧正文后挂住，直到测试放行；**不响应 abort**。
 *
 * 用来制造「取消请求发出时还没结束、但实际收尾已经赢了」那一瞬：真实链路里
 * `isFinished()` 判定与 `abort()` 生效之间没有原子性，先到的可能是子任务自己的完成。
 */
function gatedStream(text: string) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    release: () => release(),
    stream: {
      fullStream: (async function* () {
        yield { type: 'start-step' }
        yield { type: 'text-delta', text }
        await gate
      })(),
      text: Promise.resolve(text),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    }
  }
}

/** 永远不结束、也不响应 abort 的流（用来验证 task_wait 的超时文案） */
function neverStream() {
  return {
    fullStream: (async function* () {
      yield { type: 'start-step' }
      await new Promise<void>(() => undefined)
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
    /** 每个子智能体自己的模型（断言对象身份用） */
    perIdModels?: Record<string, AiModelConfig>
    /** 本轮用户消息里的图片附件 + 读字节的回调 */
    images?: {
      attachments?: Array<{ name: string; url: string; mediaType: string }>
      read?: (url: string) => Promise<{ mediaType: string; bytes: Uint8Array } | null>
    }
    backend?: WorkspaceBackend
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
    ...(extra.perIdModels ? { perIdModels: extra.perIdModels } : {}),
    ...(extra.images ? { images: extra.images } : {}),
    ...(extra.backend ? { backend: extra.backend } : {}),
    emit: (event) => events.push(event),
    ...(extra.parent ? { signal: extra.parent.signal } : {}),
    commandStops,
    stats: makeDelegationStats()
  })
  return { tools: set.tools, events, settle: set.settle, commandStops }
}

/** 最小的假后端：只实现读图实际用到的 resolve / stat / readFile */
function fakeBackend(files: Record<string, Uint8Array>): WorkspaceBackend {
  return {
    resolve: (p: string) => {
      // 与真实后端同款：越界直接抛，读图那边应当把它变成「跳过」而不是崩掉
      if (p.includes('..')) throw new Error('outside workspace')
      return `/ws/${p.replace(/^\/+/, '')}`
    },
    stat: async (abs: string) => {
      const bytes = files[abs.slice('/ws/'.length)]
      return bytes ? { type: 'file', size: bytes.byteLength } : null
    },
    readFile: async (abs: string) => {
      const bytes = files[abs.slice('/ws/'.length)]
      if (!bytes) throw new Error('ENOENT')
      return bytes
    }
  } as unknown as WorkspaceBackend
}

/** 一张合法 PNG 的头几个字节（格式靠头认，不靠扩展名） */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
/** 不是图片（zip 头）：应当被挡在「送进模型」之前 */
const NOT_IMAGE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])

/** 最后一次子 run 的入参（`streamText` 已被 mock） */
function lastRunArgs(): {
  messages: Array<{ role: string; content: unknown }>
  tools: Record<string, unknown>
  model: unknown
} {
  const calls = vi.mocked(streamText).mock.calls
  return calls[calls.length - 1]?.[0] as never
}

/** 派活：立即返回句柄（子任务还在后台跑） */
function delegate(built: Built, task = '看看 auth 的入口在哪', toolCallId = 'parent-1') {
  return (built.tools['agent-explorer'] as DelegationTool).execute({ task }, { toolCallId })
}

/** 领结论 */
function wait(built: Built, taskId = 'parent-1') {
  return (built.tools.task_wait as WaitTool).execute({ taskId })
}

/** 主模型主动结束后台子任务（单条也传数组） */
function cancel(built: Built, input: { taskIds?: string[] } = { taskIds: ['parent-1'] }) {
  return (built.tools.task_cancel as CancelTool).execute(input)
}

/** 查看本轮所有后台子任务 */
function listTasks(built: Built) {
  return (built.tools.task_list as ListTool).execute({})
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

/**
 * 主模型自己结束子任务 + 「还在跑」要说清总时长。
 *
 * 用户报的两个问题：
 * 1. 领结论超时只显示「已等 60 秒」，看不出子任务其实已经跑了十分钟 —— 模型与用户
 *    都判断不了「该继续等还是该放弃」；
 * 2. 主 Agent 没有任何工具能结束一个子任务，只能干等超时或停掉整轮。
 */
describe('子任务总时长与主动取消', () => {
  it('task_wait 超时同时报「已运行」与「本次等待」', async () => {
    vi.useFakeTimers()
    try {
      const built = build()
      vi.mocked(streamText).mockClear()
      vi.mocked(streamText).mockReturnValue(neverStream() as never)
      await delegate(built)

      const pending = wait(built)
      await vi.advanceTimersByTimeAsync(60_000)
      const out = await pending

      expect(out).toContain('还在跑')
      // 子任务从派出去那一刻开始算，不是本次等待的 60 秒
      expect(out).toContain('已运行 1 分')
      expect(out).toContain('本次等待 1 分')
      // 要给模型一条「别干等」的出路
      expect(out).toContain('task_cancel')
    } finally {
      vi.useRealTimers()
    }
  })

  it('task_cancel 结束还在跑的子任务：收成 aborted，并带上总运行时长', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await delegate(built)

    const out = await cancel(built)

    expect(out).toContain('已结束')
    expect(out).toContain('侦察')
    const end = built.events.find((e) => e.type === 'subagent-end')
    expect(end && end.type === 'subagent-end' ? end.status : null).toBe('aborted')
    // 停止表随终态一起注销（与用户点停止钮同一条路）
    expect(built.commandStops.has('parent-1')).toBe(false)
  })

  it('一次可以结束多个：taskIds 批量取消', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build({ ids: ['explorer', 'reviewer'] })
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await (built.tools['agent-explorer'] as DelegationTool).execute(
      { task: '查 auth', summary: '查 auth 入口' },
      { toolCallId: 'p1' }
    )
    await (built.tools['agent-reviewer'] as DelegationTool).execute(
      { task: '复核登录', summary: '复核登录改动' },
      { toolCallId: 'p2' }
    )

    const out = await cancel(built, { taskIds: ['p1', 'p2'] })

    expect(out).toContain('已结束 2 个子任务')
    expect(out).toContain('查 auth 入口')
    expect(out).toContain('复核登录改动')
    const ends = built.events.filter((e) => e.type === 'subagent-end')
    expect(ends).toHaveLength(2)
    expect(ends.every((e) => e.type === 'subagent-end' && e.status === 'aborted')).toBe(true)
  })

  it('没传 taskIds 时列出在跑的任务，而不是误伤全部', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await (built.tools['agent-explorer'] as DelegationTool).execute(
      { task: 'a', summary: '甲' },
      { toolCallId: 'p1' }
    )

    const out = await cancel(built, {})

    expect(out).toContain('没有传 taskIds')
    expect(out).toContain('p1')
    expect(await listTasks(built)).toContain('运行中')
    await built.settle()
  })

  it('批量里混入不存在的 id：能结束的照常结束，失配的单独说明', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await (built.tools['agent-explorer'] as DelegationTool).execute(
      { task: 'a', summary: '甲' },
      { toolCallId: 'p1' }
    )

    const out = await cancel(built, { taskIds: ['p1', 'nope'] })

    expect(out).toContain('已结束 1 个子任务')
    expect(out).toContain('没有这些 taskId：nope')
  })

  it('已经跑完的子任务不会被 task_cancel 丢掉结论', async () => {
    const built = build()
    vi.mocked(streamText).mockReturnValue(fakeStream('结论在 src/auth.ts') as never)
    await delegate(built)
    expect(await wait(built)).toContain('结论在 src/auth.ts')

    const out = await cancel(built)
    expect(out).toContain('已经跑完了')
    expect(out).toContain('task_wait')
  })

  it('取消请求输给收尾时：结论仍然有效，不标「已取消」', async () => {
    const built = build()
    const gated = gatedStream('结论在 src/auth.ts')
    vi.mocked(streamText).mockReturnValue(gated.stream as never)
    await delegate(built)

    // 取消发出时它还在跑；abort 生效前它自己收尾了（假流不响应 abort，正是这个竞态）
    const cancelling = cancel(built)
    gated.release()
    const out = await cancelling

    // 归到「已经跑完，结论还在」：模型不会把有效结论当成作废而重新派活
    expect(out).toContain('已经跑完了')
    expect(out).toContain('task_wait')
    const list = await listTasks(built)
    expect(list).toContain('已完成')
    expect(list).not.toContain('已取消')
    expect(list).toContain('结论未领取')
    await built.settle()
  })

  it('被 task_cancel 的子任务不算「结论白跑」：settle 不留告警', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await delegate(built)
    await cancel(built)
    await built.settle()

    const warnings = vi.mocked(console.warn).mock.calls.map((call) => String(call[0]))
    expect(warnings.some((line) => line.includes('结论没被领走'))).toBe(false)
  })
})

/**
 * 同时派多个后台子任务时，模型回来要能分清「哪条是哪条」。
 *
 * 只有 taskId + 子任务类型时，三条「侦察」摆在一起还是认不出谁在查 auth、谁在查构建；
 * 所以每条派活在派发时都要带一句很短的说明，`task_list` 把它与状态 / 时长一起列出来。
 */
describe('列出后台子任务', () => {
  it('用派发时的简短说明区分多个子任务，并给出状态与时长', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build({ ids: ['explorer', 'reviewer'] })
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await (built.tools['agent-explorer'] as DelegationTool).execute(
      { task: '读 auth 相关文件并汇总入口', summary: '查 auth 入口' },
      { toolCallId: 'p1' }
    )
    await (built.tools['agent-reviewer'] as DelegationTool).execute(
      { task: '复核这次登录改动', summary: '复核登录改动' },
      { toolCallId: 'p2' }
    )

    const out = await listTasks(built)
    expect(out).toContain('p1')
    expect(out).toContain('查 auth 入口')
    expect(out).toContain('p2')
    expect(out).toContain('复核登录改动')
    expect(out).toContain('运行中')
    await built.settle()
  })

  it.each([undefined, '', '   '])('说明缺失或空白时通过 schema 校验并回退到任务首行（%j）', async (summary) => {
    const built = build()
    vi.mocked(streamText).mockReturnValue(fakeStream('ok') as never)
    const tool = built.tools['agent-explorer'] as DelegationTool
    const parsed = await asSchema(tool.inputSchema).validate!({
      task: '先看 src/auth.ts\n再看 index.ts',
      ...(summary !== undefined ? { summary } : {})
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw parsed.error
    await tool.execute(parsed.value, { toolCallId: 'p1' })

    expect(await listTasks(built)).toContain('先看 src/auth.ts')
    await wait(built, 'p1')
    await built.settle()
  })

  it('派发说明超过 20 字时按 20 字截断（与工具描述的口径一致）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const built = build()
    vi.mocked(streamText).mockImplementation(
      ((args: { abortSignal?: AbortSignal }) => hangingStream(args.abortSignal)) as never
    )
    await (built.tools['agent-explorer'] as DelegationTool).execute(
      { task: '查入口', summary: '一二三四五六七八九十一二三四五六七八九十末尾不要' },
      { toolCallId: 'p1' }
    )

    const out = await listTasks(built)
    expect(out).toContain('一二三四五六七八九十一二三四五六七八九十')
    expect(out).not.toContain('末尾不要')
    await cancel(built, { taskIds: ['p1'] })
    await built.settle()
  })

  it('跑完的标「已完成」并提示结论还没领', async () => {
    const built = build()
    vi.mocked(streamText).mockReturnValue(fakeStream('结论在 src/auth.ts') as never)
    await (built.tools['agent-explorer'] as DelegationTool).execute(
      { task: '查入口', summary: '查入口' },
      { toolCallId: 'p1' }
    )

    // 等子 run 落地（刻意不走 task_wait：要验证「未领取」那一句）
    await vi.waitFor(async () => {
      expect(await listTasks(built)).toContain('已完成')
    })
    const out = await listTasks(built)
    expect(out).toContain('结论未领取')
    expect(out).toContain('task_wait')
  })

  it('还没派过活时说清楚，而不是返回一张空表', async () => {
    expect(await listTasks(build())).toContain('还没有派过子任务')
  })
})

describe('没有启用任何子智能体', () => {
  it('一个 agent-<id> 都没建出来时，连 task_wait / task_cancel 也不挂', async () => {
    // 设置里一个都没开
    expect(build({ ids: [] }).tools).toEqual({})
    // 开着但全都不是有效定义（被删 / 手改坏）：同样整组缺席，而不是只剩两个领取工具
    expect(build({ ids: ['ghost'] }).tools).toEqual({})
    // settle 仍可调（调用方无脑 await，不该炸）
    await expect(build({ ids: [] }).settle()).resolves.toBeUndefined()
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
    expect(Object.keys(built.tools)).toEqual([
      'agent-explorer',
      `agent-${def.id}`,
      'task_wait',
      'task_cancel',
      'task_list'
    ])
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

describe('读图子任务（image_reader）', () => {
  /** 本轮用户上传的一张图（读字节永远内联，不吃 url 交付判据） */
  const shot = { name: 'shot.png', url: '/api/uploads/shot.png', mediaType: 'image/png' }

  it('规格自己就是「不带工具、不联网、认图片」——这三条错一个都会悄悄跑偏', () => {
    expect(SUBAGENT_SPECS.image_reader.readsImages).toBe(true)
    // 内置默认追加 web_fetch，读图必须显式关掉
    expect(SUBAGENT_SPECS.image_reader.webFetch).toBe(false)
    expect(SUBAGENT_SPECS.image_reader.includeTools).toEqual([])
    expect(SUBAGENT_SPECS.image_reader.maxSteps).toBe(SUBAGENT_META.image_reader.defaultMaxSteps)
  })

  it('挂出来的工具集是空的：图片靠消息进，不挂任何 read* 工具', () => {
    const built = build({ ids: ['image_reader'] })
    expect(Object.keys(built.tools)).toEqual([
      'agent-image_reader',
      'task_wait',
      'task_cancel',
      'task_list'
    ])
  })

  it('内置 agent 仍带 web_fetch（关掉读图那一行不能顺手把所有内置都关掉）', async () => {
    const built = build({ ids: ['explorer'] })
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockReturnValue(fakeStream('ok') as never)
    await delegate(built)
    await wait(built)

    expect(Object.keys(lastRunArgs().tools)).toContain('web_fetch')
  })

  it('不传 images 时取本轮附件，图片作为首条消息的 ImagePart 排在问题之前', async () => {
    const built = build({
      ids: ['image_reader'],
      images: { attachments: [shot], read: async () => ({ mediaType: 'image/png', bytes: PNG }) }
    })
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockReturnValue(fakeStream('报错是 EACCES，权限不够。') as never)
    await (built.tools['agent-image_reader'] as DelegationTool).execute(
      { task: '这张图里的报错是什么原因' },
      { toolCallId: 'p1' }
    )
    const out = await wait(built, 'p1')

    const args = lastRunArgs()
    const content = args.messages[0].content as Array<{ type: string; mediaType?: string; text?: string }>
    expect(Array.isArray(content)).toBe(true)
    expect(content[0]).toMatchObject({ type: 'image', mediaType: 'image/png' })
    expect(content[content.length - 1]?.type).toBe('text')
    // 图片是输入、不是工具结果；工具集为空也确认了这一点
    expect(args.tools).toEqual({})
    expect(out).toContain('EACCES')
  })

  it('默认附件用唯一 URL 识别，两个同名文件都能传给读图子任务', async () => {
    const attachments = [
      { name: 'screenshot.png', url: '/api/uploads/one.png', mediaType: 'image/png' },
      { name: 'screenshot.png', url: '/api/uploads/two.png', mediaType: 'image/png' }
    ]
    const read = vi.fn(async (_url: string) => ({ mediaType: 'image/png', bytes: PNG }))
    const built = build({ ids: ['image_reader'], images: { attachments, read } })
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockReturnValue(fakeStream('两张截图都已查看。') as never)

    await (built.tools['agent-image_reader'] as DelegationTool).execute(
      { task: '比较这两张截图' },
      { toolCallId: 'p1' }
    )
    await wait(built, 'p1')

    const content = lastRunArgs().messages[0].content as Array<{ type: string }>
    expect(read.mock.calls.map(([url]) => url)).toEqual(['/api/uploads/one.png', '/api/uploads/two.png'])
    expect(content.filter((part) => part.type === 'image')).toHaveLength(2)
  })

  it('显式给工作区路径也能读；越界 / 非图片被跳过并写进任务说明', async () => {
    const built = build({
      ids: ['image_reader'],
      backend: fakeBackend({ 'shots/ui.png': PNG, 'notes.txt': NOT_IMAGE })
    })
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockReturnValue(fakeStream('两栏布局。') as never)
    await (built.tools['agent-image_reader'] as DelegationTool).execute(
      { task: '设计稿有几个区块', images: ['shots/ui.png', '../secret.png', 'notes.txt'] },
      { toolCallId: 'p1' }
    )
    await wait(built, 'p1')

    const content = lastRunArgs().messages[0].content as Array<{ type: string; text?: string }>
    // 只有一张真的进了消息
    expect(content.filter((part) => part.type === 'image')).toHaveLength(1)
    const text = content[content.length - 1]?.text ?? ''
    expect(text).toContain('设计稿有几个区块')
    // 没带上的必须说出来：静默丢掉会让它把「没看到」编成结论
    expect(text).toContain('../secret.png')
    expect(text).toContain('notes.txt')
  })

  it('接受 Windows 盘符形式的工作区绝对路径', async () => {
    const path = 'C:\\repo\\shots\\ui.png'
    const backend: WorkspaceBackend = {
      resolve: (value: string) => {
        if (value !== path) throw new Error('outside workspace')
        return value
      },
      stat: async (absolute: string) => absolute === path ? { type: 'file', size: PNG.byteLength } : null,
      readFile: async (absolute: string) => {
        if (absolute !== path) throw new Error('ENOENT')
        return PNG
      }
    } as unknown as WorkspaceBackend
    const built = build({ ids: ['image_reader'], backend })
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockReturnValue(fakeStream('设计稿包含两栏。') as never)

    await (built.tools['agent-image_reader'] as DelegationTool).execute(
      { task: '看看设计稿', images: [path] },
      { toolCallId: 'p1' }
    )
    await wait(built, 'p1')

    const content = lastRunArgs().messages[0].content as Array<{ type: string }>
    expect(content.filter((part) => part.type === 'image')).toHaveLength(1)
  })

  it('一张都没拿到就当场拒绝，不空跑一次子 run', async () => {
    const built = build({ ids: ['image_reader'] })
    vi.mocked(streamText).mockClear()
    const out = await (built.tools['agent-image_reader'] as DelegationTool).execute(
      { task: '图里写了什么' },
      { toolCallId: 'p1' }
    )

    expect(out).toContain('没有拿到可读的图片')
    expect(streamText).not.toHaveBeenCalled()
  })

  it('所配模型没开图片输入就当场拒绝：不能让 provider 400 顶掉原因', async () => {
    const noVision = {
      id: 'cfg-1',
      models: [{ id: 'text-only', settings: { imageInput: false } }],
      model: 'text-only'
    } as unknown as AiModelConfig
    const built = build({
      ids: ['image_reader'],
      perIdModels: { image_reader: noVision },
      images: { attachments: [shot], read: async () => ({ mediaType: 'image/png', bytes: PNG }) }
    })
    vi.mocked(streamText).mockClear()
    const out = await (built.tools['agent-image_reader'] as DelegationTool).execute(
      { task: '图里写了什么' },
      { toolCallId: 'p1' }
    )

    expect(out).toContain('没有开启图片输入')
    expect(streamText).not.toHaveBeenCalled()
  })

  it('每个子智能体自己的模型优先于兜底 / 父模型', async () => {
    const own = { id: 'cfg-own', model: 'm' } as unknown as AiModelConfig
    const built = build({ ids: ['explorer'], perIdModels: { explorer: own } })
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockReturnValue(fakeStream('ok') as never)
    await delegate(built)
    await wait(built)

    expect(lastRunArgs().model).toBe(own)
  })

  it('没配专用模型时沿用传入的父模型', async () => {
    const built = build({ ids: ['explorer'] })
    vi.mocked(streamText).mockClear()
    vi.mocked(streamText).mockReturnValue(fakeStream('ok') as never)
    await delegate(built)
    await wait(built)

    // build() 里的父模型是空对象：没配 perIdModels 时必须原样传下去
    expect(lastRunArgs().model).toEqual({})
  })
})
