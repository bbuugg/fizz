/**
 * 内置 agent 的流式引擎：**AI SDK 的 `streamText` + 多步工具循环**，把它的 part 映射成
 * fizz 自己的 `AgentStreamEvent`。
 *
 * 直接用 AI SDK 的 part 契约（`text-delta` / `tool-call` / `finish-step` …）：
 * 字段名稳定、没有额外的 `payload` 包装，所以「字段写错 → 静默失效」这类问题只可能
 * 出在本文件的一处映射里（`adaptStreamPart`），排查成本最低。
 *
 * 本文件只负责「跑一轮、吐事件」，不碰领域逻辑（压缩、插话、用量记账都在 `agent.ts`）。
 */
import {
  asSchema,
  jsonSchema,
  stepCountIs,
  streamText,
  type FlexibleSchema,
  type JSONSchema7,
  type LanguageModel,
  type ModelMessage,
  type Schema,
  type ToolSet
} from 'ai'
import type { AgentStreamEvent, AiReasoningEffort } from '@fizz/contracts/types'
import { tr } from '@fizz/i18n'

/** 一个工具步结束、下一步请求之前：可以改写下一步的 messages（插话注入 / 轮中压缩） */
export interface EngineStepBoundary {
  /** 即将发出去的完整消息数组（含此前所有工具结果） */
  messages: ModelMessage[]
  /** 已经跑完的步数（0 = 第一次请求之前） */
  stepNumber: number
  /** 上一步请求 + 输出的原始测量，含工具结果；与当前消息版本显式关联。 */
  measurement?: EngineContextMeasurement
}

export interface EngineContextMeasurement {
  messages: ModelMessage[]
  usage: unknown
  /** 工具结果不在 input+output 内，需要单独计新增。 */
  toolMessages: ModelMessage[]
}

/**
 * 边界回调对下一步的改写。**两个字段都可省**：返回 `void` 与返回空对象等价（什么都不改）。
 *
 * `toolChoice` 目前只用来做一件事：**收尾步钉成纯文本**（`'none'`）。步数预算快用完时，
 * 与其让模型再发起一批工具调用、然后被 `stepCountIs` 硬停（用户拿到一个「工具跑完但没下文」
 * 的空回复），不如把最后一步钉死成文本，至少能拿到「做完了什么 / 还差什么」。
 */
export interface EngineStepOverride {
  /** 改写下一步真正发出去的消息（与老行为一致：返回它就会一路带下去） */
  messages?: ModelMessage[]
  /**
   * 下一步的工具选择策略。`'none'` = 这一步禁止调工具（只给收尾步用）。
   *
   * ⚠️ 个别第三方兼容网关不认 `tool_choice: "none"`（会 400）。真撞上就把
   * `agent.ts` 里那个 `FORCE_FINAL_TEXT_STEP` 关掉 —— 提醒照旧生效，只是不再硬钉。
   */
  toolChoice?: 'none'
}

export interface AgentEngineOptions {
  model: LanguageModel
  system: string
  messages: ModelMessage[]
  tools: ToolSet
  /** 最大步数（一次请求 + 一轮工具执行 = 1 步） */
  maxSteps: number
  abortSignal?: AbortSignal
  modelSettings?: {
    maxOutputTokens?: number
    temperature?: number
    /** AI SDK 顶层 `reasoning` 档位；缺省 = 不传（跟随模型） */
    reasoningEffort?: AiReasoningEffort
  }
  /**
   * 同时执行的工具调用上限。模型一批并行下发 tool-call 时，全放开会把彼此的
   * 命令 / 输出拖到超时（`bash` 尤其明显）。
   */
  toolCallConcurrency?: number
  onStepBoundary?: (
    ctx: EngineStepBoundary
  ) => Promise<EngineStepOverride | void> | EngineStepOverride | void
}

export interface AgentEngineResult {
  /** 'stop' | 'length' | 'tool-calls' | 'error' | 'other' | 'aborted' …（AI SDK 原值） */
  finishReason: string
  /**
   * 本次尝试实际跑完的步数（数 `finish-step`）。
   *
   * 调用方据此判断「是不是撞上了步数上限」—— 只看 `finishReason` 不够：被
   * `stepCountIs` 停下的那一步 `finishReason` 是 `'tool-calls'`，而正常跑完的一轮
   * 最后一步也可能是 `'tool-calls'`（工具跑完、模型还想继续但循环自然结束）。
   */
  steps: number
  /** 整轮累计（多步相加） */
  totalUsage?: unknown
  /** **最后一步**的 usage —— 它才是「当前上下文有多大」 */
  lastStepUsage?: unknown
  contextMeasurement?: EngineContextMeasurement
  error?: unknown
}

export interface AgentEngine {
  /** 内容事件流（不含 finish / error：那两个由调用方按自己的口径发） */
  events: AsyncIterable<AgentStreamEvent>
  /** 流结束（正常 / 中止 / 报错都会 resolve，不会悬挂） */
  done: Promise<AgentEngineResult>
}

/** 把 tool 的 execute 套一层信号量：并发超限就排队，不改变返回值 */
function limitToolConcurrency(tools: ToolSet, limit: number): ToolSet {
  if (!Number.isFinite(limit) || limit <= 0) return tools
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) =>
      waiting.push(() => {
        active += 1
        resolve()
      })
    )
  }
  const release = (): void => {
    active -= 1
    const next = waiting.shift()
    if (next) next()
  }
  const out: ToolSet = {}
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: (...args: unknown[]) => unknown }).execute
    if (typeof execute !== 'function') {
      out[name] = tool
      continue
    }
    out[name] = {
      ...tool,
      execute: async (...args: unknown[]) => {
        await acquire()
        try {
          return await execute(...args)
        } finally {
          release()
        }
      }
    } as ToolSet[string]
  }
  return out
}

/**
 * 工具入参里「这一步想干什么」的字段名。
 *
 * 由 `withToolIntent()` 统一注入到**每一个**工具 schema 里，模型每次调用都要填一句，
 * 渲染层拿它当工具卡的标题（否则卡片上只有「执行命令」「编辑文件」这种工具名，
 * 用户看不出这一步的目的）。字段名同时被 `@fizz/agent-kit` 的 `toolIntentOf()` 读，
 * 两边必须是同一个字符串。
 */
export const TOOL_INTENT_FIELD = 'intent'

/**
 * 注入给模型的 intent 字段说明。
 *
 * ⚠️ **这段话会在每一个工具的 schema 里各出现一次**，所以刻意写得极短：它是
 * 「每个工具 +N tokens」的固定成本（实测一段长说明是 73 tokens/工具，压短后约 30）。
 * 「怎么填、不要复述工具名」这类完整约定放在系统提示词里（见 `toolIntentHint`），
 * 只出现一次 —— schema 里只需要让模型知道这个字段是什么。
 *
 * 留一句「显示为卡片标题」是给**没有系统提示词那条约定**的路径兜底
 * （自造 `assemble` 的助手 profile 就走那条路）。
 */
function intentProperty(): JSONSchema7 {
  return {
    type: 'string',
    description: tr(
      '这一步的意图：一句话（≤20 字，用用户的语言）说明要达成什么，会显示为工具卡标题',
      'Intent of this step: one short sentence (≤20 chars, in the user’s language); shown as the card title'
    )
  }
}

/**
 * 把 `intent` 塞进工具 schema 的**第一位**，并保证校验后仍然留在入参里。
 *
 * 为什么在引擎这一层做、而不是改 40 个工具定义：内置工具是 zod、MCP / 插件工具是
 * JSON Schema、子任务工具是手写对象，三条来源各不相同，只有「送进 `streamText` 之前」
 * 是共同收口点（`runEngine` 全项目只有一个调用方）。
 *
 * 三个必须注意的点：
 * 1. **必须排第一位**。入参是流式生成的（`tool-input-delta` 一帧帧追加），排后面的话
 *    标题要等整段 JSON 收完才变，前面几秒还是「执行命令」；
 * 2. **原 `validate` 会把 intent 吃掉**：zod 默认 strip 未知字段，直接复用会让
 *    `tool-call` 的 `input` 里没有 intent（界面拿不到、工具也拿不到）。所以包一层：
 *    先摘掉 intent 再交给原校验（原 schema 可能是 `.strict()`，带着它会被判失败），
 *    校验通过后再把 intent 并回去；
 * 3. 只处理对象入参。非对象 schema 塞 `intent` 会让上游直接 400，遇到就原样放行。
 */
export async function withToolIntent(tools: ToolSet): Promise<ToolSet> {
  const out: ToolSet = {}
  for (const [name, entry] of Object.entries(tools)) {
    out[name] = await injectIntent(entry as ToolSet[string])
  }
  return out
}

async function injectIntent(entry: ToolSet[string]): Promise<ToolSet[string]> {
  const raw = (entry as { inputSchema?: FlexibleSchema<unknown> }).inputSchema
  let json: JSONSchema7
  try {
    // `jsonSchema` 可能是 PromiseLike（standard schema 那一路），统一 await 掉
    json = await asSchema(raw).jsonSchema
  } catch {
    return entry
  }
  if (!json || (json.type !== undefined && json.type !== 'object')) return entry
  // 根上是 `$ref` 的（个别 MCP server 这么写）：draft-07 里 `$ref` 的兄弟字段会被忽略，
  // 塞进去也到不了模型，还可能与严格校验器打架 —— 原样放行
  if (typeof json.$ref === 'string') return entry
  const properties = (json.properties ?? {}) as Record<string, JSONSchema7>
  // 已经有同名字段（工具自己就声明了 `intent`，比如某个 MCP server 的业务参数）就不重复注入
  if (TOOL_INTENT_FIELD in properties) return entry

  const injected = jsonSchema(
    {
      ...json,
      properties: { [TOOL_INTENT_FIELD]: intentProperty(), ...properties },
      // 放进 required 只是给模型的强提示：运行期校验只认 `validate`（下面那层），
      // 模型漏填不会让整轮报错，界面退回工具名当标题。
      required: [
        TOOL_INTENT_FIELD,
        ...((json.required ?? []) as string[]).filter((k: string) => k !== TOOL_INTENT_FIELD)
      ]
    },
    { validate: keepIntent(asSchema(raw)) }
  ) as FlexibleSchema<unknown>

  return { ...entry, inputSchema: injected } as ToolSet[string]
}

/** 原校验 + 「把 intent 原样带回解析结果」（见 `withToolIntent` 第 2 点） */
function keepIntent(base: Schema<unknown>) {
  return async (value: unknown) => {
    const raw =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    const rawIntent = raw[TOOL_INTENT_FIELD]
    const intent = typeof rawIntent === 'string' ? rawIntent.trim() : ''
    const { [TOOL_INTENT_FIELD]: _intent, ...rest } = raw
    const parsed = base.validate ? await base.validate(rest) : { success: true as const, value: rest }
    if (!parsed.success) return parsed
    return {
      success: true as const,
      value: intent ? { [TOOL_INTENT_FIELD]: intent, ...(parsed.value as object) } : parsed.value
    }
  }
}

/** 把 AI SDK 的一个 fullStream part 折成 fizz 的事件；不是内容就返回 null */
export function adaptStreamPart(part: unknown): AgentStreamEvent | null {
  if (!part || typeof part !== 'object') return null
  const p = part as Record<string, unknown>
  const type = typeof p.type === 'string' ? p.type : ''
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (type) {
    case 'text-delta':
      return { type: 'text-delta', delta: text(p.text) }
    case 'reasoning-delta':
      return { type: 'reasoning-delta', delta: text(p.text) }
    /**
     * 入参开始流式生成：只有 id + 工具名，还没有内容。转成一条空增量 ——
     * 卡片据此**先建出来**，标题马上是对的（否则要等完整 tool-call，卡片会先显示
     * 一会儿「工具调用」）。
     */
    case 'tool-input-start':
      return {
        type: 'tool-call-delta',
        toolCallId: text(p.id) || text(p.toolCallId),
        ...(text(p.toolName) ? { toolName: text(p.toolName) } : {}),
        inputTextDelta: ''
      }
    case 'tool-input-delta':
      return {
        type: 'tool-call-delta',
        toolCallId: text(p.id) || text(p.toolCallId),
        inputTextDelta: text(p.delta)
      }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: text(p.toolCallId) || text(p.id),
        toolName: text(p.toolName),
        input: p.input ?? p.args ?? null
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: text(p.toolCallId) || text(p.id),
        toolName: text(p.toolName),
        output: p.output
      }
    /** 工具自己抛错：仍然要落一条 result（带 isError），否则卡片永远转圈 */
    case 'tool-error':
      return {
        type: 'tool-result',
        toolCallId: text(p.toolCallId) || text(p.id),
        toolName: text(p.toolName),
        output: errorText(p.error),
        isError: true
      }
    case 'error':
      return { type: 'error', message: errorText(p.error) }
    default:
      return null
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

/**
 * 起一轮。调用方 `for await` 消费 `events`，结束后 `await done` 拿收尾信息。
 *
 * 时序要点：
 * - `prepareStep` 在**每次请求之前**调用（含第一次，stepNumber=0），返回值里的 `messages`
 *   就是下一步真正发出去的内容 —— 插话注入和轮中压缩都挂在这里；
 * - `prepareStep` **只在「还有下一步」时才会被调**，所以它天然不会出现
 *   「最后一步之后再压一次」的情形，不需要额外的 `isFinal` 判断；
 * - `finish` / `finish-step` part 带 usage：前者是整轮累计，后者是单步 —— 别混用。
 */
export function runEngine(opts: AgentEngineOptions): AgentEngine {
  const tools = limitToolConcurrency(opts.tools, opts.toolCallConcurrency ?? 0)
  let requestMessages = opts.messages
  let contextMeasurement: EngineContextMeasurement | undefined

  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools,
    /**
     * 关掉 AI SDK 自己的重试（它默认 `maxRetries = 2`，即单条请求内部再打 3 次）。
     *
     * 两套计数器互不相干，而用户只看得见设置页那一个 —— 设成 20，界面里照样会冒出一句
     * 写死次数的 `Failed after 3 attempts. Last error: …`；更糟的是外层每重试一次、
     * 内部又暗打 3 次，真实请求数是两层**相乘**（并发满时越重试越堵）。
     *
     * 重试权统一收在 `runAgent` 的外层循环（`RunAgentOptions.maxRetries`）：那里会发
     * `retry` 事件、按退避等待，并决定这次是**断点续跑**（有步边界）还是整轮重来。
     * 设置页的数字因此是唯一权威，日志里也只剩一套重试。
     *
     * 只在这一处关：`context.ts` 的压缩摘要与 `subagents.ts` 的子 run 是**独立请求**，
     * 没有外层循环接手重试，留着 AI SDK 的默认重试更划算。
     */
    maxRetries: 0,
    stopWhen: stepCountIs(Math.max(1, opts.maxSteps)),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.modelSettings
      ? {
          ...(opts.modelSettings.maxOutputTokens !== undefined
            ? { maxOutputTokens: opts.modelSettings.maxOutputTokens }
            : {}),
          ...(opts.modelSettings.temperature !== undefined
            ? { temperature: opts.modelSettings.temperature }
            : {}),
          ...(opts.modelSettings.reasoningEffort !== undefined
            ? { reasoning: opts.modelSettings.reasoningEffort }
            : {})
        }
      : {}),
    onStepEnd: (step) => {
      contextMeasurement = {
        messages: [...requestMessages, ...step.response.messages],
        usage: step.usage,
        toolMessages: step.response.messages.filter((message) => message.role === 'tool')
      }
    },
    prepareStep: async ({ messages, stepNumber }) => {
      const next = await opts.onStepBoundary?.({ messages, stepNumber, measurement: contextMeasurement })
      requestMessages = next?.messages ?? messages
      if (!next) return undefined
      return {
        ...(next.messages ? { messages: next.messages } : {}),
        ...(next.toolChoice ? { toolChoice: next.toolChoice } : {})
      }
    }
  })

  let finishReason = 'other'
  /** 已跑完的步数：每来一个 `finish-step` 就 +1（撞没撞上限全靠它，见 `AgentEngineResult.steps`） */
  let steps = 0
  let totalUsage: unknown
  let lastStepUsage: unknown
  let error: unknown
  let settle!: (result: AgentEngineResult) => void
  const done = new Promise<AgentEngineResult>((resolve) => {
    settle = resolve
  })

  /**
   * `done` 在生成器的 `finally` 里收尾：调用方可能中途 `break`（用户停止 / 看门狗），
   * 那时生成器会被 `return()`，finally 照常执行。
   *
   * ⚠️ 不能让 `done` 自己再 `for await` 一遍同一个流 —— 两个消费者会把事件对半分。
   * 也不能 `await result.finishReason`：流没跑完时它可能永远不 resolve。
   */
  /**
   * `FIZZ_DEBUG_CHUNKS=1`：把**本次出现过的 part 类型**逐个打一次（附原始片段）。
   *
   * 排障用。认不出来的类型在这里会露出来 —— 否则某个内容没渲染时，只能靠猜是「上游没发」
   * 还是「我们没认出来」。只在首次出现时打，避免流式期间刷屏。
   */
  const debugParts = process.env.FIZZ_DEBUG_CHUNKS === '1'
  const seenPartTypes = new Set<string>()

  async function* generate(): AsyncGenerator<AgentStreamEvent> {
    try {
      for await (const part of result.fullStream) {
        const p = part as Record<string, unknown>
        if (debugParts && typeof p.type === 'string' && !seenPartTypes.has(p.type)) {
          seenPartTypes.add(p.type)
          console.log(
            '[chunk] 首次出现的 part 类型：' + p.type + ' ' + JSON.stringify(part).slice(0, 300)
          )
        }
        if (p.type === 'finish-step') {
          steps += 1
          // 单步 usage：最后一次请求的那个才是「当前上下文有多大」
          if (p.usage) lastStepUsage = p.usage
          if (typeof p.finishReason === 'string') finishReason = p.finishReason
          continue
        }
        if (p.type === 'finish') {
          if (p.totalUsage) totalUsage = p.totalUsage
          if (typeof p.finishReason === 'string') finishReason = p.finishReason
          continue
        }
        if (p.type === 'abort') {
          finishReason = 'aborted'
          continue
        }
        const event = adaptStreamPart(part)
        if (!event) continue
        if (event.type === 'error') error = p.error ?? event.message
        yield event
      }
    } catch (err) {
      error = err
      throw err
    } finally {
      if (opts.abortSignal?.aborted && finishReason === 'other') finishReason = 'aborted'
      settle({ finishReason, steps, totalUsage, lastStepUsage, contextMeasurement, error })
    }
  }

  return { events: generate(), done }
}
