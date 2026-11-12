/**
 * 对话编排（直接基于 AI SDK 的 `streamText`，多步循环在 `./engine`）。
 *
 * 全链路只有**一个消息形状**（`ModelMessage`）：历史转换、压缩切点、token 估算、
 * 插话注入都作用在它上面；对外仍产出 `AgentStreamEvent`，三端渲染逻辑不变。
 *
 * 与桌面端保持一致的关键点：
 * - 系统提示词与工具集是同一份（./prompt 与 ./tools），技能也是同一套渐进式披露；
 * - 历史消息用同一份 `toModelMessages` 转（原生 tool-call/tool-result，不压成文本）；
 * - 事件仍产出桌面端同款的 `AgentStreamEvent`，所以三个端的消息渲染逻辑可以一致。
 */
import {
  calculateContextTokens,
  compactHistory,
  compactModelMessages,
  estimateBaseTokens,
  estimateMessagesTokens,
  contextUsed,
  rememberBaseTokens,
  defaultContextWindowFromEnv,
  isContextOverflowError,
  type CompactionSummaryDelta,
  type CompactionSummaryStart
} from './context'
import { ASK_FOLLOWUP_HINT, ASK_FOLLOWUP_TOOL } from '@fizz/tools'
import {
  createAppContext,
  HOOKS,
  HooksService,
  hookValue,
  PromptService,
  ToolsService,
  ModelsService,
  WorkspaceService
} from '@fizz/plugin'
import {
  MAX_STEPS,
  attachmentParts,
  buildAgentSystemPrompt,
  createInlineBudget,
  STEP_BUDGET_MARKER,
  stepBudgetHint,
  stepBudgetRemaining,
  stepBudgetReminder,
  stepBudgetWarnSteps,
  toModelMessages,
  toolIntentHint,
  type ResolveAttachment
} from './prompt'
import {
  fileToolsPlugin,
  rawToolsPlugin,
  webToolsPlugin,
  wrapToolsWithApproval,
  wrapToolsWithHooks,
  type MountedPlugin
} from './plugins'
import { buildDelegationTools, makeDelegationStats, type SubagentId } from './subagents'
import { runEngine, withToolIntent } from './engine'
import { resolveModel } from './resolve-model'
import { isEmptyStreamOutputError, isRetryableNetworkError, retryDelayMs, sleepWithSignal } from './retry'
import { resolveMaxRetries, resolveToolCallConcurrency } from '@fizz/contracts/agent-api'
import {
  resolveModelSettings,
  withModelApiStyle,
  type AgentStopReason
} from '@fizz/contracts/types'
import { extractNestedDocPaths, readNestedProjectDocs, type ProjectDoc } from './project-doc'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import type { Context, TurnFinishPayload, TurnStartPayload } from '@fizz/plugin'
import type {
  AgentChatMessage,
  AgentConfirmInput,
  AgentStreamEvent,
  AgentWorkspace,
  AiModelConfig,
  AiPermissionMode,
  AiReasoningEffort,
  RunAgentResult,
  SubagentTurnUsage,
  TurnUsage
} from '@fizz/contracts/types'
import type { SkillInfo } from '@fizz/skills'

// 这两个形状下沉到了 contracts（@fizz/acp 的 acp.ts 也要用），这里转出保持原公开 API 不变
export type { AgentConfirmInput, RunAgentResult } from '@fizz/contracts/types'

export interface RunAgentOptions {
  workspace: AgentWorkspace
  /**
   * 工作区后端（本地 / 远端）。不传 = 按 `workspace.path` 现建本地后端（行为与从前一致）。
   * 远端工作区由服务端注入 SSH 后端；此时子任务白名单会自动剔除 `git_read`。
   */
  workspaceBackend?: WorkspaceBackend
  history: AgentChatMessage[]
  model: AiModelConfig
  skills: SkillInfo[]
  /**
   * 规则文档（全局 `~/.config/fizz/AGENTS.md` + 工作区根 `AGENTS.md`）：由调用方用
   * `readProjectDoc` 读好传进来（server 端在 chat 路由里读，与技能扫描同一处）。
   * 不传 / null = 一份都没有，系统提示词里就不出现这一段。
   */
  projectDoc?: ProjectDoc | null
  permissionMode?: AiPermissionMode
  /**
   * 内置 Agent 的思考强度（AI SDK 顶层 `reasoning`）。缺省 = 不传，跟随模型默认；
   * 只有服务端按会话解析到非空档位时才传。
   */
  reasoningEffort?: AiReasoningEffort
  /**
   * 运行中实时读取权限档（优先于 `permissionMode`）。
   *
   * 工具集一轮建一次，静态 `permissionMode` 会把权限快照死在整轮里 —— 用户在一轮
   * 中途切换权限（确认 ↔ 完全访问）时下一轮才生效。传本 getter，闸门就**每次工具
   * 调用现取**，中途切换立刻生效。server 传 `() => run.permissionMode`（改档端点在
   * 运行中改的就是这个字段）。不传 = 退回静态快照（行为与从前一致）。
   */
  getPermissionMode?: () => AiPermissionMode
  /**
   * 启用哪些子任务（subagent）。缺省 / 空数组 = 一个派活工具都不挂，与没有这个能力时
   * 逐字节一致。
   *
   * 子 agent 恒为只读（白名单见 subagents.ts）；它只收到派活时那一条任务文本，父的
   * 系统提示词与完整历史不下发，派活 prompt 上另有一层注入防线。详见
   * docs/superpowers/specs/2026-10-06-subagent-integration-design.md 的 §8。
   */
  subagents?: SubagentId[]
  /**
   * 子任务专用模型（完整配置：含明文 key / baseURL）。不传 = 沿用父会话模型；
   * 传了但某个子任务自己的 `preferredModelId` 在父配置里命中时，仍以子任务规格为准。
   *
   * server 从 `SubagentSettings.modelConfigId/modelId` 解析后传进来；配置被删 /
   * 模型被移除时**不要抛错**，退回父模型并记日志即可。
   */
  subagentModel?: AiModelConfig
  /**
   * 设置页给的子任务步数上限（按 id）。缺省 = 各子任务的规格默认值
   * （真源是 contracts 的 `SUBAGENT_META.defaultMaxSteps`，见 `resolveMaxSteps`）。
   */
  subagentMaxSteps?: Partial<Record<SubagentId, number>>
  /**
   * confirm 模式下执行破坏性操作（execute_command / delete_file）前的请示。
   *
   * ⚠️ **不传就等于 full**：`buildAgentTools` 里 `needConfirm = 权限是 confirm && 有回调`，
   * 所以调用方必须真的提供一个会等待用户的回调（桌面端走 IPC、服务端走 SSE+POST、
   * CLI 走 readline），否则「确认模式」只是名义上的。
   */
  requestConfirm?: (req: AgentConfirmInput) => Promise<boolean>
  /**
   * 命令停止表（toolCallId → 只停那一条 execute_command 的 stop）。调用方创建
   * （server 挂在 run 上：`run.commandStops`），runAgent 往里面登记 / 注销；
   * `POST /api/chat/command/stop` 与服务端外部的停止按钮命中它。不传 = 没有
   * 单条停止能力（与从前逐字节一致）。
   */
  commandStops?: Map<string, () => void>
  /**
   * 后台命令登记：`execute_command` 带 `runInBackground` 时调它，拿到任务 id。
   *
   * 由 server 注入（它持有任务登记表，也知道这条命令属于哪个会话）；不传 = 不提供
   * 后台执行（工具会如实回绝）。进程归登记表持有，本轮的 signal / 超时都打不到它。
   */
  onBackgroundCommand?: (req: {
    command: string
    cwd: string
    title: string
  }) => Promise<{ id: string }>
  signal?: AbortSignal
  /**
   * 运行中插话（steer）的收件箱轮询：每个迭代边界（一次 LLM 调用 + 其工具执行完成）
   * 调一次，返回一条就消费一条（调用方自行 shift）。返回 null = 没有插话。
   *
   * 消费到的插话会作为一条 user 消息追加进下一步的 messages（`prepareStep` 的返回值），
   * 模型因此接着干活；广播出去的那条与落盘历史保持用户原话。
   * 只有内置后端会传（ACP 是外部 agent，协议给不了插话）。
   */
  pollSteer?: () => Promise<AgentChatMessage | null>
  /**
   * 附件 URL 的绝对化策略（历史里 file part 的 url 可能是相对路径）：提交模型前
   * 对每个附件 url 调一次，返回给 provider 的最终地址。server 端注入
   * `UploadAdapter.resolveModelUrl`（`FIZZ_PUBLIC_BASE_URL ?? 请求 origin`）；
   * 不传 = 原样使用（相对地址由 localhost base 兜底，见 model-messages.ts）。
   */
  resolveFileUrl?: (url: string) => string
  /**
   * 附件投递策略（`resolveFileUrl` 的上一级）：决定一条附件是**给 URL**、
   * **内联字节**，还是**不发**（附一行说明）。
   *
   * server 端注入 `createAttachmentResolver`（`upload/attachments.ts`）：没有公网地址时
   * 改为内联 base64，云端 provider 不必回连 `127.0.0.1`。不传 = 全部按 URL 直传，
   * 行为与从前一致。
   */
  resolveAttachment?: ResolveAttachment
  /**
   * 额外注入的工具（工具名 → VercelTool），合并进 `buildAgentTools` 之上。
   * 用来挂 transport 无关但与用户交互挂钩的工具 —— 最典型的是
   * `ask_followup_question`（server 端用它把提问推成本地 SSE 通道）。
   * 桌面端这里传空，它自己用 `buildAgentTools` + `buildAskFollowupTool`。
   */
  extraTools?: Record<string, unknown>
  /**
   * 额外挂载的插件（`@fizz/plugin` 的 Plugin）。
   *
   * 与 `extraTools` 的分工：`extraTools` 是「一批现成工具」的旧通道（transport 相关、
   * 与用户交互挂钩的），`plugins` 是「带生命周期、可注册工具 / 提示词 / 钩子」的新通道。
   * 两者最终都进同一个工具注册表，同名冲突按 priority 规则处理（见 `@fizz/plugin`）。
   * 挂载顺序：内置文件工具 → extraTools → plugins → web_fetch / screenshot。
   */
  plugins?: MountedPlugin[]
  /**
   * 覆盖「静态部分」（系统提示词 + 工具集）整个装配结果：提供时 `buildAgentSetup`
   * 完全不执行 —— 不建工作区文件工具、不用工作区版提示词。给**不走单一工作区**的
   * 调用方用（如项目管理助手：自定义身份提示词 + 纯项目工具集）。
   * ⚠️ 提供时 `workspace / skills / projectDoc / permissionMode / extraTools / plugins` 全部失效。
   */
  setup?: AgentSetup
  /**
   * 模型请求失败后的自动重试次数（**0 = 不限制**，一直重试）。缺省 = `DEFAULT_MAX_RETRIES`。
   *
   * 只对**可重试的这一次请求**生效（网络中断 / 上游空响应，见 ./retry）。重来方式看有没有
   * 断点：
   * - 已经跑完若干步（工具执行过、走到了步边界）→ **断点续跑**：从失败的那一步接着发请求，
   *   已完成的工具不会重跑，所以这种情况也照样重试；
   * - 没有断点（第一步就失败）→ 整轮重来，但因为会重复文件写入 / 命令等副作用，**执行过
   *   工具的尝试不重试**。
   */
  maxRetries?: number
  /**
   * 同一批 tool-call 最多同时执行几个（1 = 串行）。
   * 缺省 = `DEFAULT_TOOL_CALL_CONCURRENCY`；服务端把设置页里的偏好按轮传进来。
   */
  toolCallConcurrency?: number
  /**
   * 是否让模型为每次工具调用写一句「意图」（见 `withToolIntent`）。缺省 = 开启。
   *
   * 服务端把设置页里的偏好按轮传进来；关掉时既不注入 `intent` 字段，提示词里那条
   * 约定也一起撤掉（否则模型会被告知填一个 schema 里没有的字段）。
   */
  toolIntent?: boolean
  /** 每条流事件（已经转成桌面端同款的 AgentStreamEvent） */
  onEvent?: (event: AgentStreamEvent) => void
  /**
   * 会话 id：自动摘要**固化缓存**的键（见 `context.ts` 的 `compactHistory`）。
   *
   * ⚠️ 不是 `workspace.id` —— 一个工作区下可能有多个会话，串用会拿到别的会话的摘要。
   * 不传 = 不固化（每轮重算摘要），行为与加这个能力之前一致。
   */
  conversationId?: string
  /**
   * 落盘的自动摘要固化点（`conversation.autoSummary`）。
   *
   * 进程重启后内存缓存是空的，用它接上 —— 否则重启后第一轮又要摘要一次。
   * 与内存缓存同一条判定：起点消息还在 + 后续原文没超预算才复用。
   */
  autoSummarySeed?: { keepFromMessageId: string; text: string }
  /**
   * 摘要**真的重算**时回调（供调用方落盘）。
   *
   * 复用缓存 / 没到阈值 / 摘要失败都不调（那三种情况下落盘内容没有变化）。
   */
  onAutoSummary?: (entry: { keepFromMessageId: string; text: string }) => void
  /**
   * 这个模型的**上下文窗口**（token，见 `AiModelEntry.contextWindow`）。
   *
   * 由调用方按「会话选中的模型」解析好传进来（contracts 的 `resolveContextWindow`）——
   * 本包不碰领域配置。判据与 pi 一致：`用量 > 窗口 - reserveTokens` 才摘要。
   * 不传 = 环境变量 `FIZZ_CONTEXT_BUDGET` 兜底 / 默认 200k。
   */
  contextWindow?: number
  /**
   * 交接文档开始生成（旧历史已切好，马上调摘要模型）。
   * 服务端用它推 `context-compaction-start`，让用户在压缩期间看到进度而不是干等。
   */
  onContextCompactionStart?: (info: CompactionSummaryStart) => void
  /** 交接文档的流式增量（仅展示；完整摘要校验通过后才会落检查点） */
  onContextCompactionDelta?: (info: CompactionSummaryDelta) => void
  /**
   * 压缩发生时的回调：把「压了多少轮 / 压前压后 token 数」告诉调用方。
   * 服务端用它推一条 `context-compressed` 帧，让用户知道这一轮上下文被压过了。
   * `summary` 是完整交接文档（含文件清单），前端用它覆盖流式拼接结果。
   */
  onContextCompressed?: (info: {
    beforeTokens: number
    afterTokens: number
    summarizedTurns: number
    keptTurns: number
    summary?: string
  }) => void
  /**
   * 是否启用浏览器工具（browser_* 工具集 + 系统提示词里的浏览器使用说明）。
   * 由调用方按「本后端能不能跑浏览器」决定（desktop / web 的共享后端都行，直接传 true）。
   */
  browser?: boolean
  /** 追加在系统提示词末尾的调用方专属说明（多智能体协作的派活规则等）。 */
  extraPrompt?: string
  /**
   * 覆盖本轮的最大步数（工具循环上限）。缺省 = `MAX_STEPS`。
   * 多智能体协作的子 Agent 用它收紧单任务步数。
   */
  maxSteps?: number
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}


/**
 * 一次尝试里「重发同一条请求通常能成功」的错误：网络中断 **或** 上游返回了空响应
 * （`runAgent` 按 `finishReason === 'other'` + 零内容合成，见 ./retry 的两条判定）。
 */
function isRetryableAttemptError(err: unknown): boolean {
  return isRetryableNetworkError(err) || isEmptyStreamOutputError(err)
}

/**
 * 一次尝试「整体失败」时抛出的错误：`message` 是给用户看的那一句，另标一个可重试位。
 *
 * 为什么自己造一条而不是复用 `isEmptyStreamOutputError` 的文案匹配：流内已经报过错时，
 * 文案是上游原文（形如 `AI_APICallError: concurrency reached, current: 11, limit: 10`），
 * 既不含 `finishReason "other"`
 * 也不带 `isRetryable` —— 但性质与「静默空响应」完全一样：**同一条请求重发通常就有内容**。
 * 把这件事标在位上是同一个判定的两种写法，比匹配文案稳（文案一改就静默失效）。
 * `isRetryableNetworkError` 认这个位（APICallError 也用它）。
 */
function attemptFailure(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { isRetryable?: boolean }).isRetryable = true
  return err
}

/**
 * 一次尝试发给引擎的消息数组（AI SDK 的 `ModelMessage[]`）。
 *
 * 单独起个名字是为了让「断点续跑」的缓存有准确的类型：它存的就是边界那一刻的**完整**
 * 消息数组（历史 + 本轮已完成步骤的 assistant / tool 消息），下次尝试原样发出去。
 */
type EngineMessages = Parameters<typeof runEngine>[0]['messages']

/**
 * 最后一步是否**钉成纯文本**（`toolChoice: 'none'`）。
 *
 * 开着时，剩余步数只剩 1 的那一步不允许再调工具，模型只能把结论写出来 —— 用户至少能
 * 拿到「做完了什么 / 还差什么」，而不是「工具卡都跑完了，然后没有下文」。
 *
 * ⚠️ 这是唯一需要为兼容性关掉的地方：极个别第三方兼容网关不认 `tool_choice: "none"`
 * 会直接 400。关掉它只是退回老行为（模型可能再调一次工具然后被硬停），提醒照旧生效。
 */
const FORCE_FINAL_TEXT_STEP = true

/**
 * 把「步数预算提醒」放进消息尾部：**有旧的就原地换掉，没有才追加**。
 *
 * 为什么必须幂等：`prepareStep` 返回的 messages 会一路带到后面的步骤，所以上一步注入的
 * 提醒本来就还在数组里。直接 push 会在 8 个边界上堆出 8 条互相矛盾的「还剩 N 步」。
 *
 * 为什么按**内容标记**找、不记下标：轮中压缩会把数组重排（`compactModelMessages` 返回
 * 新数组），下标一失效就再也找不回来。
 *
 * 替换发生在**尾部**：前缀缓存命中的是「提醒之前」的那一段，被作废的只有这条提醒本身
 * （几十个 token），所以每步更新一次是划算的 —— 换来的是模型看到的数字永远准确。
 */
export function applyStepBudgetReminder(
  messages: EngineMessages,
  text: string | null
): EngineMessages {
  if (!text) return messages
  const isReminder = (message: EngineMessages[number]): boolean => {
    if (message.role !== 'user') return false
    const content = message.content
    if (typeof content === 'string') return content.startsWith(STEP_BUDGET_MARKER)
    if (!Array.isArray(content)) return false
    const first = content[0] as { type?: unknown; text?: unknown } | undefined
    return (
      first?.type === 'text' &&
      typeof first.text === 'string' &&
      first.text.startsWith(STEP_BUDGET_MARKER)
    )
  }
  const reminder = {
    role: 'user',
    content: [{ type: 'text', text }]
  } as EngineMessages[number]
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (!isReminder(out[i])) continue
    out[i] = reminder
    return out
  }
  out.push(reminder)
  return out
}

/** 累加两段用量（断点续跑：失败那几段白烧的 token 也要算进 finish 帧） */
function mergeRawUsage(a: RawUsage | null, b: RawUsage | null): RawUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }
      : {}),
    ...(a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined
      ? { cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) }
      : {})
  }
}

/** 模型上报的原始 token 用量（各家字段名不同，统一到这里） */
export type RawUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cachedInputTokens?: number
}

/**
 * 把各家形状的 usage 归一化。
 *
 * 字段名按版本 / 供应商做了防御式兼容（v4 的 promptTokens/completionTokens、v5 的
 * inputTokens/outputTokens；思考与缓存的明细在 output/inputTokenDetails 里）。
 */
function normalizeUsage(usage: unknown): RawUsage | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const inputTokens = num(u.inputTokens ?? u.promptTokens) ?? 0
  const outputTokens = num(u.outputTokens ?? u.completionTokens) ?? 0
  const totalTokens = num(u.totalTokens) ?? inputTokens + outputTokens
  const reasoningTokens =
    num(u.reasoningTokens) ??
    num((u.outputTokenDetails as Record<string, unknown> | undefined)?.reasoningTokens)
  const cachedInputTokens =
    num(u.cachedInputTokens) ??
    num((u.inputTokenDetails as Record<string, unknown> | undefined)?.cacheReadTokens)
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {})
  }
}


/**
 * 把原始用量 + 计时折成对外展示的统计（TPS 按「首字 → 结束」的生成窗口算）。
 *
 * `contextTokens` 是**本轮最后一次请求**的上下文大小（pi 的 `calculateContextTokens` =
 * 最后一步上游上报的 `input + output`），见 `TurnUsage.contextTokens` 的说明
 * （整轮累计的 `inputTokens` 不能当上下文大小用）。
 */
function buildTurnUsage(
  raw: RawUsage,
  startedAt: number,
  firstOutputAt: number | null,
  contextTokens?: number,
  /** 本轮的派活用量（subagent）；没有派过活 = undefined，字段整个不出现 */
  subagents?: Record<string, SubagentTurnUsage>
): TurnUsage {
  const endedAt = Date.now()
  const durationMs = Math.max(0, endedAt - startedAt)
  // 生成窗口排除首字延迟（TTFT），否则 TPS 会被网络 / 排队时间拉低
  const genMs = Math.max(1, endedAt - (firstOutputAt ?? startedAt))
  const tps = raw.outputTokens > 0 ? Math.round((raw.outputTokens / (genMs / 1000)) * 10) / 10 : 0
  return {
    ...raw,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    durationMs,
    tps,
    ...(subagents ? { subagents } : {})
  }
}

/**
 * 工具**入参增量**的节流阈值：攒够这么多字符、或距上次下发超过这么久才发一帧。
 *
 * 写文件这类调用入参数 KB 起，上游会把它拆成成百上千个 `tool-call-delta`，
 * 比正文的 text-delta 还密（provider 至少会对正文做一次聚合）—— 每帧都要入帧日志
 * （`chat-run.ts` 的 `frames`）、走一趟 SSE、触发一次 React 更新，不攒一下会白白
 * 吃掉带宽和主线程。60ms 是「肉眼仍觉得是连续的」下限。
 */
const INPUT_DELTA_FLUSH_CHARS = 240
const INPUT_DELTA_FLUSH_MS = 60

export interface AgentSetup {
  instructions: string
  /** 工具名 → AI SDK 工具对象；估算上下文时也读它（见 `estimateBaseTokens`） */
  tools: Record<string, unknown>
  /**
   * 钩子总线（`buildAgentSetup` 提供）。外部自造 setup（如 assistant-turn）可不传 ——
   * 所有钩子调用都走可选链，缺了就等于「没有插件要拦截」。
   */
  hooks?: HooksService
  /**
   * 这一轮自建的 turn context（`buildAgentSetup` 提供）。`runAgent` 收尾时卸载它，
   * 好让「每轮重建」真正闭环（插件加的工具 / 监听器随轮结束一起回收）。
   * 外部自造 setup 不传 = 这一轮没有需要我们回收的东西。
   */
  ctx?: Context
}

/**
 * 组装一次运行的静态部分（系统提示词 + 工具集）。
 *
 * 单独拆出来是因为**上下文估算要用它**：系统提示词与工具 schema 每轮都要发出去，
 * 却不在 `messages` 里 —— `runAgent` 得拿到这两样，才能把「本轮实际请求多大」算准
 * （见 `estimateBaseTokens`）。建 Agent 本身只是 `new Agent(...)`，无副作用。
 *
 * **实现已改为「由插件注册表产出」**：这里起一个一次性的 Context，把内置能力
 * （文件 / 联网工具）与调用方给的工具 / 插件按固定顺序挂上去，最后从
 * `ctx.tools` / `ctx.prompt` 读回结果。挂载顺序与从前手工 spread 的顺序**逐一对齐**，
 * 所以产出的工具键序、提示词正文都与改造前一致：
 *   文件工具 → extraTools → plugins → web_fetch → screenshot。
 *
 * 钩子（P3）：`hooks` 服务**先于插件挂载**建在这一轮的 context 上，插件 apply 里就能
 * `ctx.hooks.on(...)`；工具集在产出后再套一层钩子壳（`wrapToolsWithHooks`），
 * 提示词正文最后过一遍 `prompt:render`。没插件挂钩子时，这两步都是原样透传。
 */

export function buildAgentSetup(opts: {
  workspace: AgentWorkspace
  /** 工作区后端（见 RunAgentOptions.workspaceBackend）；不传 = 本地 */
  workspaceBackend?: WorkspaceBackend
  skills: SkillInfo[]
  /** 工作区根目录的项目约束文档（AGENTS.md），见 RunAgentOptions.projectDoc */
  projectDoc?: ProjectDoc | null
  permissionMode?: AiPermissionMode
  /**
   * 运行中实时读取权限档（优先于 `permissionMode`）。工具集一轮建一次，静态档会把权限
   * 快照死在整轮里；传 getter 则闸门**每次工具调用现取**，用户中途切档立刻生效。
   */
  getPermissionMode?: () => AiPermissionMode
  requestConfirm?: (req: AgentConfirmInput) => Promise<boolean>
  /** 流事件出口：工具输出增量经它直出（不与入参增量的缓冲混用） */
  onEvent?: (event: AgentStreamEvent) => void
  /** 命令停止表（见 RunAgentOptions.commandStops） */
  commandStops?: Map<string, () => void>
  /** 后台命令登记（见 RunAgentOptions.onBackgroundCommand） */
  onBackgroundCommand?: (req: {
    command: string
    cwd: string
    title: string
  }) => Promise<{ id: string }>
  extraTools?: Record<string, unknown>
  /** 调用方额外挂的插件（server 的项目工具 / 浏览器 / MCP 桥接等），按数组顺序挂载 */
  plugins?: MountedPlugin[]
  /** 是否启用浏览器工具（挂 browser_* 工具集 + 在系统提示词追加浏览器使用说明） */
  browser?: boolean
  /** 追加在系统提示词末尾的调用方专属说明（例如多智能体协作的派活规则） */
  extraPrompt?: string
  /**
   * 子目录规则的按需加载钩子（见 `AgentToolOptions.nestedDocs`）。`runAgent` 用
   * `readNestedProjectDocs` + 历史里的 marker 建好传进来；不传 = 不加载。
   */
  nestedDocs?: (absPath: string, isDirectory: boolean) => Promise<string | null>
  /**
   * 是否让模型为每次工具调用写一句「意图」。缺省开启；关掉时提示词里那条约定不追加
   * （否则模型会被告知填一个 schema 里没有的字段，见 `toolIntentHint`）。
   */
  toolIntent?: boolean
  /**
   * 本轮的**工具步数预算**（`runAgent` 的 `opts.maxSteps`）。给了就在系统提示词末尾追加
   * 一段「这轮有 N 步」的约定（见 `stepBudgetHint`）。
   *
   * 为什么值得说：模型不知道有闸，就会一直「再查一个文件 / 再跑一次」，直到被
   * `stepCountIs` 硬停 —— 那时它连一句「做到哪了」都没机会说。提前知道预算，它才会先规划、
   * 把结论排进前 N 步。
   *
   * 只放**常量预算**：剩余步数每步都变，进系统提示词会让上游前缀缓存从第一个 token 起
   * 全部失效（见 `stepBudgetHint` 的警告）；动态的那部分走步骤边界的 `stepBudgetReminder`。
   */
  maxSteps?: number
}): AgentSetup {
  const ctx = createAppContext('agent-setup')
  ctx.set('tools', new ToolsService(ctx))
  // 工作区级插件可能声明 `inject: ['models']`：给一份空注册表只为不推迟挂载。
  // 这里注册的模型**不会**进全局模型列表（模型是全局的，见 server/plugin-models.ts）。
  ctx.set('models', new ModelsService(ctx))
  ctx.set('prompt', new PromptService(ctx))
  // 钩子总线挂在**这一轮的 context**（不是插件 fiber）上：监听器落在这一层，
  // 插件卸载时 disposer 随 fiber 回收。见 @fizz/plugin 的 hooks.ts 注释。
  const hooks = new HooksService(ctx)
  ctx.set('hooks', hooks)
  // 工作区根目录：插件的工具要按「相对工作区根」的路径约定解析（模型的系统提示词就是这么
  // 要求的），没有这个服务它们只能要求绝对路径。未绑定目录的会话（path 为空）不提供 ——
  // 声明 `inject: ['workspace']` 的插件在那里会被推迟挂载，不会拿到一个空目录乱拼路径。
  if (opts.workspace.path) {
    ctx.set('workspace', new WorkspaceService(ctx, { path: opts.workspace.path, name: opts.workspace.name }))
  }

  // ① 内置文件 / 命令工具（未绑定目录的会话不注册，见 fileToolsPlugin）
  ctx.plugin(
    fileToolsPlugin(opts.workspace.path, {
      // 三种模式原样透传（readonly 不能被吞成 full）
      permissionMode: opts.permissionMode ?? 'full',
      // 运行中活取权限档（用户在整轮中途切档时，闸门立刻按新档裁决）
      ...(opts.getPermissionMode ? { getPermissionMode: opts.getPermissionMode } : {}),
      // exactOptionalPropertyTypes 下不能传 undefined，条件展开
      ...(opts.requestConfirm ? { requestConfirm: opts.requestConfirm } : {}),
      // 单条命令停止 + 实时输出：三个回调成组注入（缺 commandStops = 都不注入，
      // 行为与加这个能力之前逐字节一致；subagent 那条 buildAgentTools 刻意不传）
      ...(opts.workspaceBackend ? { backend: opts.workspaceBackend } : {}),
      ...(opts.commandStops
        ? {
            onCommandStart: (id: string, stop: () => void) => opts.commandStops!.set(id, stop),
            onCommandEnd: (id: string) => opts.commandStops!.delete(id),
            // 实时输出**直出**：不经 emitEvent 的 pendingDelta（那是入参增量的收口逻辑）
            onCommandOutput: (id: string, stream: 'stdout' | 'stderr', delta: string) =>
              opts.onEvent?.({ type: 'tool-output-delta', toolCallId: id, stream, delta })
          }
        : {}),
      // 后台执行通道：不传就没有 runInBackground（工具会如实回绝），
      // 与「这个环境不支持后台命令」是同一件事
      ...(opts.onBackgroundCommand ? { onBackgroundCommand: opts.onBackgroundCommand } : {}),
      skills: opts.skills,
      ...(opts.nestedDocs ? { nestedDocs: opts.nestedDocs } : {})
    })
  )
  // ② 调用方注入的工具（transport 相关，如 ask_followup_question）
  if (opts.extraTools) ctx.plugin(rawToolsPlugin('extra-tools', opts.extraTools, { source: 'extra-tools' }))
  // ③ 调用方挂的插件（server 的项目工具 / 浏览器 / MCP 桥接）
  // **逐个 try/catch**：一个插件挂载失败不该拖垮整轮对话（与 loadPlugins 的取舍一致）。
  // 典型失败：注册的工具形状不对（缺 execute，见 ToolsService.register）、与内置工具同名
  // 并列最高 priority —— 这种插件本轮缺席，其余照常挂。
  for (const mounted of opts.plugins ?? []) {
    try {
      ctx.plugin(mounted.plugin, mounted.config)
    } catch (err) {
      const name = (mounted.plugin as { name?: string } | null)?.name ?? '匿名插件'
      console.warn(`[agent] 插件挂载失败，本轮跳过：${name}`, err)
    }
  }
  // ④ web_fetch / screenshot 是全局只读工具：不依赖工作区，任何会话（含未绑定目录的「任务」会话）都可用。
  //    `screenshot` 只在装了内置浏览器运行时的那一轮挂上（判据在 webToolsPlugin 里）。
  // ② 内置 web 工具。`web_fetch` 也接同一张停止表：抓一个卡住的站点动辄 30s，
  //    用户应该能只停这一条，而不是中止整轮。
  ctx.plugin(
    webToolsPlugin(
      opts.workspace.path ?? '',
      opts.commandStops
        ? {
            onStart: (id: string, stop: () => void) => opts.commandStops!.set(id, stop),
            onEnd: (id: string) => opts.commandStops!.delete(id)
          }
        : {},
      // 远端工作区把 web_fetch 的超长正文落回远端 .fizz/tool-output（不传 = 本地）
      opts.workspaceBackend
    )
  )

  // 审批闸门：`mutating: true` 的工具按权限模式走（readonly 拒绝 / confirm 询问 / full 放行）。
  // 内置文件工具**不经这里**（它们自己管自己的 guardWrite），所以行为与加这个能力之前一致。
  const tools = wrapToolsWithApproval(ctx.tools.entries(), {
    permissionMode: opts.permissionMode ?? 'full',
    ...(opts.getPermissionMode ? { getPermissionMode: opts.getPermissionMode } : {}),
    // exactOptionalPropertyTypes 下不能传 undefined，条件展开（与上面 requestConfirm 的用法一致）
    ...(opts.requestConfirm ? { requestConfirm: opts.requestConfirm } : {})
  })
  // 桌面端**总是**在系统提示词后追加提问提示词；server 只在真正注入了 ask_followup_question
  // 工具时追加，避免给 CLI（没有卡片 UI）塞一个用不上的指引。
  // 判据从「查 extraTools」改成「查注册表产出的工具集」——语义不变，但不再关心工具来自哪条通道。
  const askHint = ASK_FOLLOWUP_TOOL in tools ? ASK_FOLLOWUP_HINT : ''
  // 未绑定目录（path 为空）的会话：不用工作区版提示词，只告诉模型「只能对话」
  const base = opts.workspace.path
    ? buildAgentSystemPrompt(
        opts.workspace.path,
        opts.workspace.name,
        opts.skills,
        opts.projectDoc ?? null,
        opts.browser
      )
    : '你是 Fizz 的对话助手。本会话没有绑定工作区，因此不能读写文件或执行命令，但可以使用 web_fetch 工具打开网页抓取资料；只能基于对话内容或抓取到的网页内容回答问题、整理思路。'
  // 提示词也走注册表：内置提示词是唯一一段，插件可再追加（priority 更大的排在后面）
  // 「工具意图」的约定：只有真的往 schema 注入 `intent` 时才追加（见 toolIntentHint）
  const intentHint = opts.toolIntent === false ? '' : toolIntentHint()
  // 「这轮有多少步」的约定：调用方没给预算（比如自造 setup 的项目助手）就不追加 ——
  // 说了也没有闸，模型只会为一个不存在的上限做无谓的收尾
  const budgetHint =
    typeof opts.maxSteps === 'number' && Number.isFinite(opts.maxSteps)
      ? stepBudgetHint(Math.max(1, Math.trunc(opts.maxSteps)))
      : ''
  ctx.prompt.section('builtin', base + askHint + intentHint + budgetHint, { priority: 0 })
  if (opts.extraPrompt?.trim()) {
    ctx.prompt.section('caller', opts.extraPrompt.trim(), { priority: 1 })
  }
  // 渲染完再过一遍钩子：插件可以整段改写最终正文（没插件时 hookValue 原样返回）
  const instructions = hooks.waterfall(HOOKS.promptRender, [ctx.prompt.render()], hookValue) as string
  return { instructions, tools: wrapToolsWithHooks(tools, hooks), hooks, ctx }
}

/** 用静态部分 + 模型配置建一个 内置 Agent（每次尝试现建，代价只是一个配置对象） */

/** 这一轮的序号（与时间戳拼成 turnId）：轮次之间可能重叠，得有个能区分的东西 */
let turnSeq = 0

/**
 * 子任务空闲看门狗：父 agent 派活后，多久没有**任何子任务事件**就判定卡死。
 *
 * 60~120 秒是「模型在正常工作但还没吐字」的常见上限；慢模型 / 大仓库可调到更大，
 * 0 = 关闭。看门狗触发后中止**整轮**（子 run 没有单独的取消句柄），
 * 用户会看到一条明确的 `子任务超时` 错误，而不是无限等待。
 */
function resolveSubagentIdleTimeoutMs(): number {
  const raw = process.env.FIZZ_SUBAGENT_IDLE_TIMEOUT_MS?.trim()
  const parsed = raw ? Number(raw) : NaN
  if (Number.isFinite(parsed) && parsed >= 0) return parsed
  return 120_000
}

/** 跑一轮对话，把事件按顺序回调出去；返回值是这一轮的终态 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  // 整轮计时的起点（用量统计里的耗时 / TPS 都以它为基准）
  const startedAt = Date.now()
  /** 这一轮的 id：`turn:start` / `turn:finish` 钩子与排障日志用它串起同一轮 */
  const turnId = `turn-${startedAt.toString(36)}-${++turnSeq}`

  /**
   * 本轮自己的中止控制器：外部 signal 只做转发，看门狗也能中止。
   *
   * ⚠️ 不能直接改 `opts.signal` —— 它可能是调用方的全局控制器；看门狗只该结束这一轮。
   */
  const runAbort = new AbortController()
  const forwardAbort = () => runAbort.abort(opts.signal?.reason)
  if (opts.signal?.aborted) runAbort.abort(opts.signal.reason)
  else opts.signal?.addEventListener('abort', forwardAbort, { once: true })
  const runSignal = runAbort.signal
  /**
   * 用户中止的「可 await 信号」：看门狗让 `next()` 变成可打断的 race 之后，中止也要
   * 参与同一次 race —— 否则子任务卡在 provider 上时，点停止还得等看门狗超时才收场。
   * resolve `null` 而不是 reject：race 的结果统一按「没拿到 chunk」处理，避免无人
   * 接管的 Promise rejection。
   */
  const abortedSignal = new Promise<null>((resolve) => {
    if (runSignal.aborted) resolve(null)
    else runSignal.addEventListener('abort', () => resolve(null), { once: true })
  })

  /**
   * 正在跑的子任务（父侧 toolCallId → 最近一次活动）。`agent-*` 的 tool-call 到达时登记，
   * tool-result 回填时删除；子 agent 的正文 / 工具进度 / reasoning 都能续命。
   */
  const activeDelegations = new Map<string, { toolName?: string; lastAt: number }>()
  const subagentIdleTimeoutMs = resolveSubagentIdleTimeoutMs()
  let watchdogFired: string | null = null

  /**
   * 距离「最早一个子任务超时」还有多少毫秒；没有活动派活 / 关闭看门狗时返回 null。
   * 用 `Promise.race` 包住每次 `next()`，才能真正打断一个**卡在 provider 上、
   * 一个 chunk 都不来**的子任务（只靠 abortSignal 时，流可能根本不响应）。
   */
  const subagentIdleRemaining = (): number | null => {
    if (subagentIdleTimeoutMs <= 0 || activeDelegations.size === 0) return null
    const now = Date.now()
    let earliest = Number.POSITIVE_INFINITY
    for (const info of activeDelegations.values()) {
      earliest = Math.min(earliest, info.lastAt + subagentIdleTimeoutMs - now)
    }
    return earliest
  }

  const fireSubagentWatchdog = (): string => {
    const now = Date.now()
    for (const [toolCallId, info] of activeDelegations) {
      if (now - info.lastAt < subagentIdleTimeoutMs) continue
      const seconds = Math.round(subagentIdleTimeoutMs / 1000)
      const label = info.toolName ?? toolCallId
      watchdogFired =
        `子任务「${label}」超过 ${seconds} 秒没有任何进展，已中止本轮。` +
        '可以重试；如果经常发生，请在设置 →「子任务」里给它换一个更快的模型。'
      console.error('[subagent] ' + watchdogFired)
      // 子 run 没有单独的取消句柄，只能中止整轮；这是有意取舍：
      // 宁可给一句明确错误，也不让父 agent 无限等一个已经卡死的子任务。
      runAbort.abort(new Error(watchdogFired))
      return watchdogFired
    }
    return ''
  }

  /**
   * 静态部分是不是**本轮自建**的。自建的那份带一个 turn context（插件加的工具 / 监听器
   * 都挂在里面），收尾时必须卸载；调用方传进来的 `setup` 不归我们管（也不含 hooks）。
   */
  const ownSetup = !opts.setup
  /** 生效的重试上限（设置里 0 = 不限制 → Infinity） */
  const maxRetries = resolveMaxRetries(opts.maxRetries)
  /**
   * 这个模型的进阶设置（按**本轮选中的模型 id** 解析，见 `AiModelEntry.settings`）。
   * 老数据没有该项 = 工具 / 图片 / 思考全开、输出不限，行为与加这个能力之前完全一致。
   */
  const modelSettings = resolveModelSettings(opts.model.models, opts.model.model)
  /**
   * 接口风格按模型覆盖（`resolveModel` 只读 `model` 与 `apiStyle`）。
   * 其余设置是调用时参数，不能塞进配置对象（见 contracts 的 withModelApiStyle 注释）。
   */
  const effectiveModel: AiModelConfig = withModelApiStyle(opts.model)
  /**
   * 单次回复的输出上限：模型设置 > 配置上的旧字段 `maxTokens`（历史遗留，无 UI）。
   * 非法值（0 / NaN / 负数）一律当「不限制」，别让手改坏的数据把模型钉死。
   */
  const maxOutputTokens =
    modelSettings.maxOutputTokens ??
    (typeof opts.model.maxTokens === 'number' &&
    Number.isFinite(opts.model.maxTokens) &&
    opts.model.maxTokens > 0
      ? Math.floor(opts.model.maxTokens)
      : undefined)
  const temperature =
    typeof opts.model.temperature === 'number' && Number.isFinite(opts.model.temperature)
      ? opts.model.temperature
      : undefined
  /**
   * **连续**失败了几次（发 retry 事件时先 +1，作为「第几次重试」）。
   *
   * ⚠️ 不是「整轮累计」：如果失败的这次尝试**产出过内容、且那份内容留得住**（能续跑，
   * 前端不清空），这里就清零（catch 里 `if (canResume && attemptProduced) retries = 0`）。
   * 语义上它衡量的是「上游连续抽了几次」，而不是「这一轮一共重试了几次」。
   *
   * 为什么必须这样（用户报的）：一轮里上游会发多次请求（多步续写，每步一次）。开头
   * 网络抖动用掉几次重试、随后某步正常产出，再往后撞上限流 —— 若按整轮累计，`retries`
   * 早已顶到 `maxRetries`，最后一次机会都没有，只能直接报错。而那段「正常产出」恰好
   * 证明上游是好的，后面的失败是新的一段故障，理应重新给足次数。
   */
  let retries = 0
  /**
   * 这一轮是否**已经真实执行过工具**（发出过 tool-call）。
   *
   * 它决定「重来」能不能做：**整轮重来**会把工具再执行一遍（重复文件写入 / 命令）；有断点
   * 时改走断点续跑就没这个问题。与桌面端文案「只重试请求本身，不重复已执行过的工具」一致。
   */
  let toolExecuted = false
  /**
   * 这一轮是否**已经消费过插话**（steer）。消费过就不再自动重试：重试 = 从头再跑
   * 一轮，会把已经注入用户可见的插话弄丢，也会把服务端按注入边界记下的切片位置
   * 打穿（parts 被清空重建，边界 index 全部失效）。
   */
  let steered = false
  /**
   * **断点续跑**的起点：上一次尝试在最后一步边界留下的完整消息（含已完成的工具调用与
   * 原样结果）。非 null = 下一次尝试从这里接着发请求 —— 不重跑已完成的步骤、不会重复
   * 文件写入 / 命令，也就没有「整轮重来」的副作用，因此**执行过工具也可以重试**。
   *
   * 只在「还有下一步」时被 `onStepBoundary` 写入，所以第一步就失败的尝试它是 null，
   * 那时仍然退回整轮重来（也是唯一能走的路）。
   */
  let resumeMessages: EngineMessages | null = null
  /** 续跑起点之前已完成的步数：从总步数预算里扣掉，续跑不会把 `MAX_STEPS` 翻倍 */
  let resumeSteps = 0
  /**
   * 跨尝试累加的用量。续跑前那些失败的段落**token 已经烧掉了**，不累加的话 finish 帧
   * 报出来的 token 只算最后一段（用户看到的数会比实际少一大截）。
   */
  let carriedUsage: RawUsage | null = null
  /**
   * 整轮**第一个字**的时刻（TPS 的生成窗口起点）。跨尝试保留：续跑会让 token 累加，
   * 若时间窗口只算最后一段，算出来的 TPS 会虚高几倍。
   */
  let turnFirstOutputAt: number | null = null

  /** 攒着的入参增量（null = 没有）。攒够阈值才下发，见 INPUT_DELTA_FLUSH_* */
  let pendingDelta: { toolCallId: string; toolName?: string; text: string } | null = null
  /**
   * 这一轮的派活统计（subagent 用量 + 钩子错误）。**每轮一个对象**：轮次之间可能重叠
   * （队列里排着下一轮 + steer 插话），模块级会把 A 轮的账记到 B 轮头上。
   */
  const stats = makeDelegationStats()
  /** 上一次下发入参增量的时刻（节流的时间基准） */
  let lastDeltaFlushAt = 0

  /** 把攒着的入参增量冲出去 */
  const flushDelta = (): void => {
    if (!pendingDelta) return
    const { toolCallId, toolName, text } = pendingDelta
    pendingDelta = null
    lastDeltaFlushAt = Date.now()
    opts.onEvent?.({
      type: 'tool-call-delta',
      toolCallId,
      ...(toolName ? { toolName } : {}),
      inputTextDelta: text
    })
  }

  /**
   * 整轮的**唯一返回出口**（四个 return 点都走它：收尾 / 中止 / 异常 / 打日志）。除了
   * 拼返回值，还负责把派活过程里记下的错误与用量打出来 —— 那些错误只记录、不冒泡，
   * 不打出来就是「派活行为莫名不对但日志一片干净」（对齐仓库「不许静默失败」的价值观）。
   *
   * 它同时是**唯一的收尾动作**：广播 `turn:finish` 并卸载本轮自建的 turn context
   * （所以它是异步的）。调用点一律 `return finish(...)` 直接交出去，由 async 函数 flatten。
   *
   * `stats` 是**这一轮**的派活统计（不是模块级）：轮次之间可能重叠（队列里排着下一轮 +
   * steer 插话），模块级会把 A 轮的用量与错误记到 B 轮头上。
   */
  const finish = async (
    finishReason: RunAgentResult['finishReason'],
    usage?: TurnUsage,
    error?: string,
    /** 被预算截断时补的两个字段（见 `AgentStopReason`）：只有「正常跑完但用满步数」那条路给 */
    stop?: { stopReason: AgentStopReason; steps: number }
  ): Promise<RunAgentResult> => {
    opts.signal?.removeEventListener('abort', forwardAbort)
    if (stats.hookErrors.length > 0) {
      const detail = stats.hookErrors.map((e) => '  ' + e.where + ': ' + e.message).join('\n')
      console.error('[subagent] delegation 钩子出错 ' + stats.hookErrors.length + ' 处（派活可能行为异常）:\n' + detail)
    }
    if (Object.keys(stats.subagents).length > 0) {
      const lines = Object.entries(stats.subagents)
        .map(([id, s]) => id + ' ' + s.calls + ' 次共 ' + s.totalTokens + ' tok')
        .join('，')
      console.error('[subagent] 派活汇总：' + lines)
    }
    // 一轮收尾：先广播 `turn:finish`（插件据此记账 / 落状态），再卸载本轮自建的 context。
    // 顺序不能反 —— 卸载会把监听器一起摘掉，之后就没人收得到这个事件了。
    try {
      agentSetup.hooks?.emit(HOOKS.turnFinish, {
        turnId,
        finishReason,
        ...(usage ? { usage } : {})
      } satisfies TurnFinishPayload)
    } catch (err) {
      console.error('[plugin] turn:finish 钩子出错：', err)
    }
    if (ownSetup) {
      try {
        await agentSetup.ctx?.dispose()
      } catch (err) {
        console.error('[plugin] 本轮 context 卸载失败：', err)
      }
    }
    return {
      finishReason,
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
      ...(stop ? { stopReason: stop.stopReason, steps: stop.steps } : {})
    }
  }


  /**
   * 这一轮所有事件的下发出口：**任何非 delta 事件之前先把攒着的增量冲干净**。
   *
   * 顺序不能乱 —— 同一个 toolCallId 的 delta 必须全部排在它自己的完整 `tool-call`
   * / `tool-result` 之前，否则前端会把「已经收口的 input」又用旧增量盖回去。
   * finish / error / retry 同样走这里，所以不存在「攒着没发出去」的尾巴。
   */
  const emitEvent = (event: AgentStreamEvent): void => {
    /**
     * 模型设置里关掉「思考」= 思考内容**不往客户端发**（因此也不会被落进历史）。
     * 上游照常生成（不碰 provider 参数：各家关闭思考的字段各不相同，写错就是静默失效），
     * 我们只在下发口把它挡掉 —— 与 `AiModelSettings.reasoning` 的语义一致。
     */
    if (event.type === 'reasoning-delta' && !modelSettings.reasoning) return
    if (event.type !== 'tool-call-delta') {
      flushDelta()
      opts.onEvent?.(event)
      return
    }
    // 换了工具：上一个的尾巴先结掉（不同 id 的增量不能拼在一起）
    if (pendingDelta && pendingDelta.toolCallId !== event.toolCallId) flushDelta()
    const toolName = pendingDelta?.toolName ?? event.toolName
    pendingDelta = {
      toolCallId: event.toolCallId,
      ...(toolName ? { toolName } : {}),
      text: (pendingDelta?.text ?? '') + event.inputTextDelta
    }
    const now = Date.now()
    if (
      pendingDelta.text.length >= INPUT_DELTA_FLUSH_CHARS ||
      now - lastDeltaFlushAt >= INPUT_DELTA_FLUSH_MS
    ) {
      flushDelta()
    }
  }

  /**
   * finish 帧上的「这一轮工作了多久」。
   *
   * 有 `usage` 时它自带 `durationMs`（**别再重复给**，两个数会打架），没有时单独给一个
   * 裸耗时 —— **被中止 / 出错的那一轮常常一个 usage chunk 都没收到**（用户点停止时模型
   * 可能正卡在思考或工具执行里），可「已经工作了 3 分 12 秒」仍然是用户想看的信息：
   * 缺了这个数，折叠条抬头只能退回「思考 ×5 · 工具调用 ×5」的计数摘要
   * （见 `packages/agent-kit/.../message-parts.tsx` 的 `durationMs`）。
   */
  const finishTiming = (
    usage?: TurnUsage
  ): { usage?: TurnUsage; durationMs?: number } =>
    usage ? { usage } : { durationMs: Math.max(0, Date.now() - startedAt) }

  /**
   * 静态部分（系统提示词 + 工具集）整轮只建一次：它们同时是**上下文估算**的输入
   * （见 `estimateBaseTokens`），重建不会变，但每次尝试重算会白跑一遍 schema 序列化。
   */
  // 子目录规则：从历史里恢复已注入过的 marker，同一份只进一次上下文。
  // 远端工作区首期不注入 AGENTS.md（文件在远端主机，本地读不到），由服务端不传 projectDoc 配合。
  const loadedNestedDocs = extractNestedDocPaths(opts.history)
  const nestedDocs =
    opts.workspace.path && !opts.workspace.remote
      ? (absPath: string, isDirectory: boolean) =>
          readNestedProjectDocs(opts.workspace.path, absPath, loadedNestedDocs, isDirectory)
      : null
  const agentSetup =
    opts.setup ??
    buildAgentSetup({
      workspace: opts.workspace,
      ...(opts.workspaceBackend ? { workspaceBackend: opts.workspaceBackend } : {}),
      skills: opts.skills,
      projectDoc: opts.projectDoc ?? null,
      permissionMode: opts.permissionMode,
      ...(opts.getPermissionMode ? { getPermissionMode: opts.getPermissionMode } : {}),
      ...(opts.requestConfirm ? { requestConfirm: opts.requestConfirm } : {}),
      ...(opts.commandStops ? { commandStops: opts.commandStops } : {}),
      ...(opts.onBackgroundCommand ? { onBackgroundCommand: opts.onBackgroundCommand } : {}),
      onEvent: (event) => emitEvent(event),
      ...(opts.extraTools ? { extraTools: opts.extraTools } : {}),
      ...(opts.plugins ? { plugins: opts.plugins } : {}),
      ...(opts.browser ? { browser: true } : {}),
      ...(opts.extraPrompt ? { extraPrompt: opts.extraPrompt } : {}),
      ...(nestedDocs ? { nestedDocs } : {}),
      ...(opts.toolIntent === false ? { toolIntent: false } : {}),
      // 预算只报**总量**：续跑时本次尝试的剩余会变，那部分由边界提醒现算（见 onStepBoundary）
      maxSteps: opts.maxSteps ?? MAX_STEPS
    })
  /**
   * 工具调用开关关掉时**一个工具都不下发**（`AiModelSettings.toolCall`）。
   *
   * 闸放在这里而不是 `buildAgentSetup` 里：`opts.setup` 可能是调用方自造的
   * （项目管理助手那套），只有这里能把所有入口一网打尽。提示词里补一句能力限制 ——
   * 否则系统提示词还在教模型怎么用工具，它只能输出假的工具调用文本。
   *
   * 开着的这一支要**先注入 `intent`**（见 `withToolIntent`）：注入放在 `estimateBaseTokens`
   * 之前，工具 schema 的 token 估算才把这一字段算进去，圆环不会越跑越偏。
   */
  const toolsForModel = modelSettings.toolCall
    ? opts.toolIntent === false
      ? agentSetup.tools
      : await withToolIntent(agentSetup.tools as Parameters<typeof withToolIntent>[0])
    : {}
  const setupForModel: AgentSetup = modelSettings.toolCall
    ? agentSetup
    : {
        ...agentSetup,
        instructions:
          agentSetup.instructions +
          '\n\n【能力限制】当前模型未启用工具调用：不要尝试调用任何工具，也不要输出工具调用的 JSON；' +
          '只能基于对话内容直接回答，需要读写文件或执行命令时请让用户换一个开启了工具调用的模型。',
        tools: toolsForModel
      }
  const baseTokens = await estimateBaseTokens(setupForModel.instructions, toolsForModel)
  // 记下来给手动压缩那条路兜底（它不建 agent，算不出 base —— 不补就差一整个 base）
  if (opts.conversationId) rememberBaseTokens(opts.conversationId, baseTokens)

  // `turn:start`：静态部分（提示词 / 工具集）已定稿、即将发第一次请求。
  // 放在这里而不是更早，是为了让插件看到的本轮提示词就是最终那一份。
  agentSetup.hooks?.emit(HOOKS.turnStart, {
    turnId,
    workspaceId: opts.workspace.id,
    workspaceName: opts.workspace.name
  } satisfies TurnStartPayload)

  /**
   * 上游报 context overflow 时置为 true，下一次尝试**强制压缩**再发（pi 的 pre-turn 恢复）。
   *
   * 只允许恢复一次：压完还溢出说明单条消息本身就超窗（摘要也装不下），再试没有意义。
   */
  let forceCompact = false
  let overflowRecovered = false

  // 重试循环：每一次「尝试」要么是完整的一轮（建 Agent → 压缩 → 建流 → 消费流），要么是
  // **断点续跑**（上一次已经跑完若干步 → 从那份消息接着发，跳过压缩）。
  // 重来条件：可重试的这一次请求（网络中断 / 上游空响应 / context overflow）、未到次数上限，
  // 并且 —— 要么有断点（续跑不重跑工具），要么压根没执行过工具（整轮重来才不会重复副作用）。
  for (;;) {
    /**
     * 首字时刻（TPS 的生成窗口起点）、模型上报的原始用量、本轮上下文估算。
     * **每次尝试各算一份**：放到 try 外面是为了 catch（异常 / 中止）分支里也能把已产出的
     * token 补推出去 —— 路由侧只在 finish 事件带 usage 时才落盘（见 chat/route.ts 的 onEvent）。
     */
    let firstOutputAt: number | null = null
    /**
     * 这一次尝试里**流内已经报过分**的错误文案（引擎把上游 / AI SDK 的 error part 转成的
     * `error` 事件）。null = 没报过。
     *
     * 只在「一个内容都没产出」时攒着、不当场下发 —— 那种尝试收尾时还会合成一条
     * 「上游返回空响应」，两条 `⚠️ ` 各挂一颗「重新加载」，同一个故障被说了两遍。
     * 见流循环里的 error 分支与收尾处的失败判定。
     */
    let attemptError: string | null = null
    /**
     * 这一次尝试**是否已经产出了实质内容**（正文 / 思考有字，或已发出工具调用）。
     *
     * 命中就把 `retries` 清零 —— 上游已经正常工作了，之后若再失败属于**新的一段**故障，
     * 不该继续吃开头几次抖动消耗掉的额度（见 `retries` 的注释）。
     *
     * ⚠️ 判据只认「带内容的事件」：`finish` / `usage` 这类收尾事件**不算**。空响应尝试
     * 也会收到 `finish`，拿它当产出就等于给「上游永远回空」开了无限重试（次数永远不涨）。
     */
    let attemptProduced = false
    /**
     * 这条错误是不是**已经下发给前端**了。有产出时不攒着、当场下发，收尾处就不能再说一遍
     * （重试用尽时的终态分支用它去重）。
     */
    let errorSent = false
    let rawUsage: RawUsage | null = null
    /**
     * **最后一次请求**的 usage（不是整轮累计）。
     *
     * pi 的 `calculateContextTokens` 取「最后一条助手消息的 usage」—— 消息上的 usage 就是
     * 那次请求的 input + output。多步循环里只有最后一步的 input 才是「当前上下文有多大」，
     * 累计值会把每一步都加一遍。
     */
    let lastStepUsage: RawUsage | null = null
    /**
     * 上一次**轮中压缩**之后的大小（`afterTokens`）。只用于冷却：见
     * `onIterationComplete` 里那段注释。每次「尝试」各一份 —— 重试是从全量历史
     * 重新起跑，上一份压缩结果已经不在了。
     */
    let midTurnCompactAfter: number | null = null
    /** 收到几个带 usage 的 finish chunk：只有一个时才敢把「整轮累计」当单步用 */
    let finishChunks = 0
    /** 本轮**最后一次请求**的上下文大小（见 `TurnUsage.contextTokens`） */
    let contextTokens: number | undefined
    try {
      // ⚠️ 构造 Agent 也要放进 try：`resolveModel` 会因为「模型配置不对」这类问题抛错，
      // 放在外面会让整轮**一个事件都不发**（前端只能干等，日志里也看不到原因）
      // 子任务（subagent）：每次尝试都现建，和父 agent 同一节奏；不启用时 undefined，
      // 不挂 `agents` 也不传 `delegation`。
      // 工具调用关掉的模型也不挂子任务 —— 派活本身就是一个工具，下发了也用不了。
      const contextWindow = opts.contextWindow ?? defaultContextWindowFromEnv()
      /**
       * 本次尝试的**起点**：有断点就接着上一次失败的那一步，没断点才按老路走。
       *
       * 续跑**不重做轮前压缩**：那份 `messages` 本身就是上一次轮前 / 轮中压缩过的结果，
       * 再压一遍只会把刚写好的摘要再摘要一次。唯一的例外是 context overflow 恢复
       * （`forceCompact`）—— 那条路明确要求重新压，调用处已经把断点清掉了。
       */
      /**
       * 内联附件（base64）的**整轮**预算：主历史的组装与运行中插话共用一份，
       * 同一张图跨多次组装只扣一次（见 `createInlineBudget`）。
       * 每次「尝试」各建一份 —— 重试是从全量历史重新起跑。
       */
      const inlineBudget = createInlineBudget()
      let messages: EngineMessages
      if (resumeMessages) {
        messages = resumeMessages
      } else {
        /**
         * 上下文压缩只有一层（pi 的 compaction）：`compactHistory` 在 history 层做
         * 「摘要 + 保留近期原文」。它必须作用在 `toModelMessages` 之前 —— 保留起点要锚
         * **消息 id**（ModelMessage 的 index 不稳定）。
         *
         * ⚠️ 别再往这里加「清旧工具结果」「按缓存冷热决定清不清」那一类层：它们会改动
         * 请求前缀，而上游前缀缓存一断就按全价重读整段历史。前缀保持一致就够了。
         */
        const compacted = await compactHistory(opts.history, {
          ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
          ...(opts.autoSummarySeed ? { seed: opts.autoSummarySeed } : {}),
          ...(opts.onAutoSummary ? { onAutoSummary: opts.onAutoSummary } : {}),
          ...(opts.onContextCompactionStart
            ? { onSummaryStart: opts.onContextCompactionStart }
            : {}),
          ...(opts.onContextCompactionDelta
            ? { onSummaryDelta: opts.onContextCompactionDelta }
            : {}),
          contextWindow,
          baseTokens,
          ...(forceCompact ? { force: true } : {}),
          model: effectiveModel,
          signal: runSignal
        })
        if (compacted.compressed) {
          opts.onContextCompressed?.({
            ...compacted.compressed,
            ...(compacted.summary ? { summary: compacted.summary } : {})
          })
          // 首轮 / 轮前压缩：把圆环从上一轮的峰值直接拉到压缩后的真实占用。
          emitEvent({
            type: 'context-usage',
            used: compacted.compressed.afterTokens,
            size: contextWindow,
            base: baseTokens
          })
        }
        messages = await toModelMessages(compacted.history, {
          resolveFileUrl: opts.resolveFileUrl,
          resolveAttachment: opts.resolveAttachment,
          inlineBudget,
          allowImages: modelSettings.imageInput
        })
      }
      /**
       * 兜底值（估算）：一轮里**连一个 usage 都没收到**（立刻中止 / 上游直接失败）时，
       * 圆环至少还有个数。真正显示的值在收尾时用上游 usage 覆盖。
       */
      contextTokens = baseTokens + estimateMessagesTokens(messages)

      /**
       * 子任务：每个 id 一个 `agent-<id>` 工具，`execute` 里跑一条独立的子 run
       * （见 `subagents.ts`）。不启用时是空对象 —— 与没有这个能力时逐字节一致。
       */
      const delegationTools =
        opts.subagents?.length && modelSettings.toolCall
          ? buildDelegationTools(opts.subagents, {
              workspacePath: opts.workspace.path,
              workspaceName: opts.workspace.name,
              ...(opts.workspaceBackend ? { backend: opts.workspaceBackend } : {}),
              model: effectiveModel,
              ...(opts.subagentModel
                ? { subagentModel: withModelApiStyle(opts.subagentModel) }
                : {}),
              ...(opts.subagentMaxSteps ? { maxSteps: opts.subagentMaxSteps } : {}),
              /**
               * 子 run 的事件**不经过父流**（它是工具里自己起的流），所以看门狗的心跳
               * 必须在这里刷新 —— 否则一个跑了 3 分钟但一直在吐字的子任务会被当成卡死。
               */
              emit: (event: AgentStreamEvent) => {
                if (
                  (event.type === 'subagent-start' ||
                    event.type === 'subagent-event' ||
                    event.type === 'subagent-end') &&
                  event.toolCallId
                ) {
                  const info = activeDelegations.get(event.toolCallId)
                  if (info) info.lastAt = Date.now()
                }
                emitEvent(event)
              },
              signal: runSignal,
              /**
               * 单条停止：派活卡上的停止钮与 `execute_command` 走**同一张表**、
               * 同一个 `POST /api/chat/command/stop` —— 停一个子任务不必废掉整轮。
               */
              ...(opts.commandStops ? { commandStops: opts.commandStops } : {}),
              stats
            })
          : {}

      type EngineInput = Parameters<typeof runEngine>[0]
      const engineTools = { ...toolsForModel, ...delegationTools } as EngineInput['tools']
      /** 上一次边界时 messages 的长度：只用来估「这一步新增的那部分」 */
      let boundaryCount = messages.length
      /** 进入本次尝试时整轮已完成的步数（续跑时非 0）：checkpoint 的基数，见那里 */
      const stepsAtAttemptStart = resumeSteps
      /** 本次尝试的步数预算（续跑会扣掉已跑的，见下面的 `maxSteps`） */
      const attemptBudget = Math.max(1, (opts.maxSteps ?? MAX_STEPS) - resumeSteps)
      /** 提醒从「还剩几步」开始出现（绝对值与比例取小，见 `stepBudgetWarnSteps`） */
      const warnAt = stepBudgetWarnSteps(attemptBudget)
      /**
       * 有没有工具可「禁」：`tool_choice: 'none'` 在**一个工具都没下发**时是非法请求
       * （OpenAI 明确报 tool_choice is only allowed when tools are specified）。
       * 关掉工具调用的模型走不到末步钉住这条路。
       */
      const hasTools = Object.keys(engineTools).length > 0
      /** 末步是否已经被钉成纯文本（撞没撞上限的判据之一，见 `finished.steps` 那一段） */
      let forcedWrapUp = false

      const engine = runEngine({
        model: resolveModel(effectiveModel) as unknown as EngineInput['model'],
        system: setupForModel.instructions,
        messages,
        tools: engineTools,
        // 续跑会新建一个引擎，步数预算要扣掉已经跑完的：否则每续跑一次都是一份完整的
        // `MAX_STEPS`，一个反复失败的轮次能把步数上限放大很多倍
        maxSteps: attemptBudget,
        abortSignal: runSignal,
        toolCallConcurrency: resolveToolCallConcurrency(opts.toolCallConcurrency),
        ...(maxOutputTokens !== undefined ||
          temperature !== undefined ||
          opts.reasoningEffort !== undefined
          ? {
              modelSettings: {
                ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
                ...(temperature !== undefined ? { temperature } : {}),
                ...(opts.reasoningEffort !== undefined
                  ? { reasoningEffort: opts.reasoningEffort }
                  : {})
              }
            }
          : {}),
        /**
         * 工具步骤边界（下一次请求之前）。这里是唯一能安全介入的位置：
         * 1. 推一帧 `context-usage`，让圆环在一轮之内也走；
         * 2. 轮中压缩：压完返回新数组，下一步请求立刻变小（不落检查点）；
         * 3. 步数预算提醒：进了提醒区就往尾部放一条「还剩几步」（原地更新，见
         *    `applyStepBudgetReminder`）；剩最后一步时顺手把它钉成纯文本；
         * 4. 消费一条运行中插话，追加成 user 消息。
         *
         * ⚠️ 不再需要 `isFinal` 判断 —— `prepareStep` 只在「还有下一步」时被调用，
         * 天然不会出现「最后一步之后再压一次」。
         */
        onStepBoundary: async ({ messages: current, stepNumber }) => {
          let next = current
          /**
           * 记下断点：这一步已经跑完（`current` 里含它的 assistant 消息与工具结果），
           * 下一次请求万一失败，下次尝试就从这个**完整**的消息数组接着发 —— 已完成的部分
           * 不重跑，也就没有「整轮重来」的重复副作用。
           *
           * 存的是返回给引擎的 `next`（可能被轮中压缩 / 插话 / 预算提醒改过），不是入参
           * `current`：续跑要接的是**实际发出去的那份上下文**。
           *
           * 顺带决定这一步要不要**钉成纯文本**（`toolChoice: 'none'`）：剩余步数只够这一步
           * 时，与其让模型再发起一批工具调用、然后被 `stepCountIs` 硬停（用户拿到一个
           * 「工具跑完但没下文」的空回复），不如强制它把结论写出来。
           */
          const checkpoint = (value: EngineMessages) => {
            // 存一份浅拷贝：引擎会把返回的数组接着用于下一步，直接存引用的话后续步骤可能
            // 就地往里追加，快照就不再是「边界那一刻」的消息了
            resumeMessages = [...value]
            // 续跑会新建引擎，`stepNumber` 是从 0 重新数的：必须加上进入本次尝试时的基数，
            // 否则每续跑一次步数预算就重置一次
            resumeSteps = stepsAtAttemptStart + stepNumber
            const forceFinal =
              FORCE_FINAL_TEXT_STEP &&
              hasTools &&
              stepBudgetRemaining({
                maxSteps: attemptBudget,
                used: stepNumber
              }) <= 1
            if (forceFinal) forcedWrapUp = true
            return {
              messages: value,
              ...(forceFinal ? { toolChoice: 'none' as const } : {})
            }
          }
          /**
           * 显示与判据用**同一个数**：`真值 + 本步新增的估算`，没有真值才全量估算。
           * 两条腿互相兜底 —— 估算漏了某种 part 形状时真实值兜住，真实值过期时
           * （刚压缩完 / 第一步）估算兜住。
           */
          const tailTokens = estimateMessagesTokens(next.slice(boundaryCount))
          const estimatedAll = baseTokens + estimateMessagesTokens(next)
          const realWithTail = lastStepUsage
            ? calculateContextTokens(lastStepUsage) + tailTokens
            : 0
          const observedContextTokens = contextUsed(realWithTail, estimatedAll)
          emitEvent({
            type: 'context-usage',
            used: observedContextTokens,
            size: contextWindow,
            base: baseTokens
          })
          /**
           * 冷却：上一次轮中压缩没把上下文压下来时，再压一遍只会把刚写好的摘要再摘要
           * 一次。要求自那以后真的增长 50% 才允许再压；上限卡在窗口上，别等到溢出。
           */
          const cooldownCeiling =
            midTurnCompactAfter === null
              ? 0
              : Math.min(midTurnCompactAfter * 1.5, contextWindow)
          const cooled = midTurnCompactAfter !== null && observedContextTokens < cooldownCeiling
          if (!cooled) {
            try {
              const compactedMid = cooled
                ? null
                : await compactModelMessages(next, {
                    contextWindow,
                    baseTokens,
                    triggerTokens: observedContextTokens,
                    model: effectiveModel,
                    signal: runSignal,
                    ...(opts.onContextCompactionStart
                      ? { onSummaryStart: opts.onContextCompactionStart }
                      : {}),
                    ...(opts.onContextCompactionDelta
                      ? { onSummaryDelta: opts.onContextCompactionDelta }
                      : {})
                  })
              if (compactedMid?.compressed) {
                next = compactedMid.messages
                midTurnCompactAfter = compactedMid.compressed.afterTokens
                /**
                 * `lastStepUsage` 是**压缩前**那一步的真实 usage，压缩后已经不代表当前
                 * 上下文了。作废它，让下一个边界退回逐条估算，直到拿到新的真实值。
                 */
                lastStepUsage = null
                opts.onContextCompressed?.({
                  ...compactedMid.compressed,
                  ...(compactedMid.summary ? { summary: compactedMid.summary } : {})
                })
                emitEvent({
                  type: 'context-usage',
                  used: compactedMid.compressed.afterTokens,
                  size: contextWindow,
                  base: baseTokens
                })
              }
            } catch (err) {
              // 摘要模型挂了不该把已经跑完的工具步骤整轮作废；下一步若真超窗会走 overflow 恢复
              console.error('[compaction] 轮中压缩失败：' + describeError(err))
            }
          }
          boundaryCount = next.length
          /**
           * 步数预算提醒：进了提醒区就在**消息尾部**放一条（并原地更新上一条）。
           *
           * 为什么是 user 消息、且必须带框题：模型天然把「最后一条 user 消息」当当前任务，
           * 裸着放一句「快收尾」会被当成新指令、把正在做的事丢掉 —— 与插话注入踩过的坑
           * 完全一样（见下面那段框题说明）。
           *
           * 为什么不改 `system`：那是请求最前面的几 k token，一动前缀缓存就整段失效。
           * 放在尾部只影响尾部的几条消息，成本可忽略。
           */
          const remainingNow = stepBudgetRemaining({ maxSteps: attemptBudget, used: stepNumber })
          if (remainingNow <= warnAt) {
            next = applyStepBudgetReminder(
              next,
              stepBudgetReminder({ maxSteps: attemptBudget, used: stepNumber })
            )
            // 提醒也算「这一步之前就有的」：下一步的「新增尾巴」估算从它之后算起
            boundaryCount = next.length
          }

          const steer = (await opts.pollSteer?.()) ?? null
          if (!steer) return checkpoint(next)
          steered = true
          // 先广播再注入：服务端据此记下「parts 到此为止」的切片边界。
          opts.onEvent?.({ type: 'user-injected', message: steer })
          const steerText = steer.parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
            .trim()
          /**
           * 插话带的附件：这里是 **ModelMessage** 的 part 形状（与 `toModelMessages`
           * 产出的那条路一致）。写错形状**不会报错**，附件会被静默丢掉。
           */
          const allSteerFiles = steer.parts.flatMap((p) =>
            p.type === 'file' ? [{ mediaType: p.mediaType, url: p.url, name: p.name }] : []
          )
          // 模型不收图片：插话里的图片同样摘掉，并在框题里明说（与 toModelMessages 同口径）
          const steerFiles = modelSettings.imageInput
            ? allSteerFiles
            : allSteerFiles.filter((f) => !f.mediaType.startsWith('image/'))
          const omittedSteerImages = allSteerFiles.length - steerFiles.length
          // 只带附件、没写文字的插话：框题里补一句，免得模型看到一条空的「插话」正文
          const steerBody =
            [
              steerText,
              omittedSteerImages > 0
                ? `（有 ${omittedSteerImages} 张图片因当前模型未开启图片输入被省略）`
                : ''
            ]
              .filter(Boolean)
              .join('\n') ||
            (steerFiles.length
              ? '（本条插话只带了附件，没有文字说明）'
              : '（本条插话没有可发送的内容）')
          /**
           * 附件的投递与主历史同一套（`attachmentParts`）：没有公网地址时同样走内联字节，
           * 预算与主历史共用一份 —— 插话带的大图不会绕过整轮上限。
           */
          const steerAttachments = await attachmentParts(steerFiles, {
            resolveAttachment: opts.resolveAttachment,
            resolveFileUrl: opts.resolveFileUrl,
            budget: inlineBudget
          })
          // 形状由 `attachmentParts` 统一产出（ImagePart / FilePart），这里只负责拼成一条消息
          const steerContent: unknown[] = [...steerAttachments.parts]
          for (const note of steerAttachments.notes) {
            steerContent.push({ type: 'text', text: note })
          }
          /**
           * ⚠️ 注入给模型的文本必须**带框**：插话是一条普通 user 消息，而模型天然把
           * 「最后一条 user 消息」当成当前任务 —— 原样发的话，用户一句问话就会把整轮
           * 任务接管过去。框里点明「这是运行中插话、不是新任务」，末尾再禁掉复述
           * （不写这句时模型每轮续跑都会先客套 + 照抄插话原文）。
           *
           * 只改**模型上下文**：`user-injected` 广播出去的那条与落盘历史都保持用户原话。
           */
          steerContent.push({
            type: 'text',
            text:
              `【用户在任务运行中的插话】${steerBody}\n` +
              '（这是运行中插话，不是新任务：把它纳入当前任务一并处理 —— 需要回答就回答、' +
              '要改方向就改方向，但继续完成你原本在做的事，不要把它当成新任务从头开始，也不要丢掉原任务。' +
              '回复时不要在开头复述或引用这段插话的原文与上面这个框题 —— 用户已经看到自己写了什么；' +
              '直接接着干活，至多一句话带过。）'
          })
          next = [
            ...next,
            { role: 'user', content: steerContent } as unknown as EngineInput['messages'][number]
          ]
          boundaryCount = next.length
          // 插话后的上下文也记下来（`steered` 会让这一轮不再自动重试，这里是防御性的）
          return checkpoint(next)
        }
      })
      /**
       * ⚠️ 不能直接 `for await`：看门狗需要在「一个事件都不来」时打断等待，
       * 而 for-await 会一直挂在 `next()` 上。手动拿迭代器，每次 `next()` 与
       * 「子任务剩余空闲时间」赛跑。
       */
      const streamIterator = engine.events[Symbol.asyncIterator]()
      let pendingChunk = streamIterator.next()
      for (;;) {
        if (runSignal.aborted) {
          void pendingChunk.catch(() => undefined)
          break
        }
        const idleRemaining = subagentIdleRemaining()
        let idleTimer: ReturnType<typeof setTimeout> | null = null
        let idleTimedOut = false
        let chunkResult: IteratorResult<AgentStreamEvent> | null = null
        try {
          chunkResult =
            idleRemaining === null
              ? await pendingChunk
              : await Promise.race([
                  pendingChunk,
                  abortedSignal,
                  new Promise<null>((resolve) => {
                    idleTimer = setTimeout(() => {
                      idleTimedOut = true
                      resolve(null)
                    }, Math.max(0, idleRemaining))
                  })
                ])
        } finally {
          if (idleTimer) clearTimeout(idleTimer)
        }
        // 中止优先于看门狗：两个 race 同时落地时按「用户主动停止」收场，别报成超时。
        if (runSignal.aborted) {
          void pendingChunk.catch(() => undefined)
          break
        }
        if (idleTimedOut) {
          /**
           * 定时器到点只是「父流这段时间没事件」，不等于子任务卡死 —— 子 run 的事件不走
           * 父流，它可能正在正常吐字。真正的判定在 `fireSubagentWatchdog` 里（按每个
           * 子任务各自的 `lastAt` 算），没判超时就继续等。
           */
          if (!fireSubagentWatchdog()) continue
          void pendingChunk.catch(() => undefined)
          void Promise.resolve(streamIterator.return?.()).catch(() => undefined)
          break
        }
        if (!chunkResult || chunkResult.done) break
        const event = chunkResult.value
        pendingChunk = streamIterator.next()
        /**
         * 流内 `error` = **这次请求失败了**（引擎把上游 / AI SDK 的 error part 原样转出来，
         * 典型是上游限流 / 断网，如 `AI_APICallError: concurrency reached, current: 11, limit: 10`）。
         * 主循环已关掉 AI SDK 自己的重试（`engine.ts` 的 `maxRetries: 0`），所以这里是
         * **第一次**失败的原话，不会再包一层 `Failed after 3 attempts. Last error: …`。
         *
         * ⚠️ 一个内容都没产出的尝试里**不能当场把它下发**：这种尝试收尾时 `finishReason`
         * 会停在 `other`、首字时刻仍是 null，于是还会合成一条「上游返回空响应」——
         * 两条 `⚠️ ` 各挂一颗「重新加载」，同一个故障被说了两遍。
         * 所以先攒进 `attemptError`，收尾时按一次失败统一处理（文案优先用上游原文）。
         *
         * 已经产出过内容的**当场下发**（让用户知道后半截为什么停了），但同样记进
         * `attemptError`：这一轮其实**没跑完**（典型是模型要多步续写时，下一步请求撞上
         * 并发上限 / 断网，AI SDK 自己重试到顶）。收尾必须按失败处理，不能报成
         * `done` —— 否则半截回复被当成完整回答落盘，只剩一句不知所以的 `⚠️ `。
         */
        if (event.type === 'error') {
          attemptError = event.message
          if (firstOutputAt === null) {
            // 已攒着的工具入参增量要冲出去（`emitEvent` 平时负责这步，这里绕过了它）
            flushDelta()
            continue
          }
          errorSent = true
        }
        /**
         * 记下「这次尝试产出了实质内容」（只判一次）。真正拿它清零重试计数的是 catch 里的
         * 重试分支 —— 那里才知道这份产出**留不留得住**（能不能续跑）。
         *
         * 正文 / 思考判空串：上游常常先发一个 `delta: ''` 的占位，那不是「回复了内容」，
         * 认它会让「空响应 + 空增量」的故障无限重试。
         */
        if (
          !attemptProduced &&
          (event.type === 'tool-call' ||
            ((event.type === 'text-delta' || event.type === 'reasoning-delta') &&
              event.delta.trim() !== ''))
        ) {
          attemptProduced = true
        }
        if (event.type === 'tool-call') {
          toolExecuted = true
          // 派活工具：从这一刻开始盯它，直到对应的 tool-result 回来
          if (event.toolName.startsWith('agent-')) {
            activeDelegations.set(event.toolCallId, {
              toolName: event.toolName,
              lastAt: Date.now()
            })
          }
        }
        if (event.type === 'tool-result' && activeDelegations.has(event.toolCallId)) {
          activeDelegations.delete(event.toolCallId)
        }
        // 子任务的任何动静都算「它还活着」（看门狗判的是「完全没动静」）
        if (
          event.type === 'subagent-start' ||
          event.type === 'subagent-event' ||
          event.type === 'subagent-end'
        ) {
          const info = activeDelegations.get(event.toolCallId)
          if (info) info.lastAt = Date.now()
        }
        // 首字（正文 / 思考 / 工具参数都算）到达即开始计生成窗口
        if (firstOutputAt === null && event.type !== 'error') {
          firstOutputAt = Date.now()
          // 整轮的第一个字（跨尝试保留）：续跑时 token 是累加的，生成窗口也得从整轮起点算，
          // 否则 TPS = 累计 token / 最后一段时长，会虚高好几倍
          turnFirstOutputAt ??= firstOutputAt
        }
        emitEvent(event)
      }
      /**
       * ⚠️ 手动迭代 + `break` **不会**自动关掉生成器（只有 `for await` 会）。
       * 不显式 `return()` 的话，引擎的 `finally` 不跑、`engine.done` 永远不 resolve ——
       * 用户点停止后整轮就挂在这里。生成器已经跑完时 return() 是空操作。
       */
      await Promise.resolve(streamIterator.return?.()).catch(() => undefined)
      // 收尾：流跑完 / 被中止都会 resolve（引擎在 finally 里收尾，不会悬挂）
      const finished = await engine.done
      /**
       * 这次尝试的收尾失败。两种形状走同一条路：
       *
       * - 流里已经报过错（`attemptError`）—— 典型是 AI SDK 自己的 3 次重试全失败。
       *   **产出过内容也算失败**：多步续写时「下一步请求」撞上限流 / 断网，正文只吐了半截，
       *   报成 `done` 会把半截回复当成完整回答落盘（用户看到「说一半就没了」还查不出原因）。
       * - 上游静默回了个空响应（`finishReason` 归到 `other`，首字时刻仍为 null）。这条
       *   必须带「无产出」限定：有工具调用的轮次最后一步也常归到 `other`。
       *
       * 抛出去交给统一的收场（`catch` 里的重试判定 + 只报一条错误）。文案优先用上游原文：
       * 有流内错误时**别再拼一条**「上游返回空响应」—— 那正是提示重复的来源。
       * 中止不算 —— 那是用户主动停。
       */
      /**
       * 上游已上报的用量：**失败的尝试也要收下**。下面马上就要 throw，`finished` 出了 try
       * 就取不到了，而断点续跑要靠这份 usage 累加（失败那几段白烧的 token 也得显示）。
       */
      if (!rawUsage) {
        rawUsage = normalizeUsage(finished.totalUsage)
        if (rawUsage) finishChunks = Math.max(finishChunks, 1)
      }
      if (
        !runSignal.aborted &&
        (attemptError !== null || (firstOutputAt === null && finished.finishReason === 'other'))
      ) {
        throw attemptFailure(
          attemptError ?? '上游返回空响应（finishReason "other"，整轮没有任何内容）'
        )
      }
      // 续跑前那几段白烧的 token 一并计入（finish 帧只报最后一段的话，用户看到的数会少一截）
      rawUsage = mergeRawUsage(carriedUsage, rawUsage)
      if (!lastStepUsage) {
        const stepUsage = normalizeUsage(finished.lastStepUsage)
        if (stepUsage) lastStepUsage = stepUsage
      }
      /**
       * 上下文大小 = **最后一次请求上游真实上报的 input + output**（pi 的
       * `calculateContextTokens`，见 `context.ts`）。一轮结束时最后一条消息就是助手回复，
       * 「其后消息」为空，所以不需要再估 tail。
       *
       * 不再用 `baseTokens + estimateMessagesTokens` 当显示值：那是本地估的（CJK 加权后
       * 已经贴近真实，但仍拿不到「上游到底发了多少」），而上游上报的 input 已经把
       * 系统提示词、工具 schema、缓存命中的部分全算在内了。
       * 只在拿不到 usage 时才退回估算（上面那个兜底值）。
       */
      if (lastStepUsage) {
        contextTokens = calculateContextTokens(lastStepUsage)
      } else if (finishChunks === 1 && rawUsage) {
        // 只有一步 = 累计值就是那一步的值（这一步兜住「只报 totalUsage 的上游」）
        contextTokens = calculateContextTokens(rawUsage)
      }
      // 看门狗中止：不是用户主动停止，必须明确告诉用户原因，不能走 aborted 静默收场。
      if (watchdogFired) {
        const usage = rawUsage
          ? buildTurnUsage(rawUsage, startedAt, turnFirstOutputAt, contextTokens, stats.subagents)
          : undefined
        emitEvent({ type: 'error', message: watchdogFired })
        emitEvent({ type: 'finish', finishReason: 'error', ...finishTiming(usage) })
        return finish('error', usage, watchdogFired)
      }
      // 手动 break 出来的收尾：与 catch 里的中止分支同一语义，不算错误。
      // 没 abort 就说明 fullStream 是自然流尽的，走下面的正常返回。
      if (runSignal.aborted) {
        const usage = rawUsage
          ? buildTurnUsage(rawUsage, startedAt, turnFirstOutputAt, contextTokens, stats.subagents)
          : undefined
        emitEvent({ type: 'finish', finishReason: 'aborted', ...finishTiming(usage) })
        return finish('aborted', usage)
      }
      const usage = rawUsage
        ? buildTurnUsage(rawUsage, startedAt, turnFirstOutputAt, contextTokens, stats.subagents)
        : undefined
      /**
       * 撞没撞步数上限 —— **只看步数不够，也不能只看 `finishReason`**：
       *
       * - `forcedWrapUp`：最后一步被我们钉成了纯文本（`toolChoice: 'none'`）。这种情况
       *   `finishReason` 会是 `'stop'`（模型正常吐完字），但它是被闸停的 —— 模型本来
       *   还想继续，只是没机会了。
       * - `finished.steps >= attemptBudget && finishReason === 'tool-calls'`：没钉住
       *   （关掉了 `FORCE_FINAL_TEXT_STEP`，或网关不认 `tool_choice`）时由
       *   `stepCountIs` 硬停，特征是最后一步仍然是「工具调用」。
       *
       * 步数用**整轮累计**（续跑前那几段也算），用户看到的是「这一轮一共跑了多少步」。
       */
      const hitStepLimit =
        !runSignal.aborted &&
        (forcedWrapUp || (finished.steps >= attemptBudget && finished.finishReason === 'tool-calls'))
      const stop = hitStepLimit
        ? { stopReason: 'max-steps' as const, steps: stepsAtAttemptStart + finished.steps }
        : undefined
      emitEvent({
        type: 'finish',
        finishReason: 'done',
        ...finishTiming(usage),
        ...(stop ?? {})
      })
      return finish('done', usage, undefined, stop)
    } catch (err) {
      // 失败尝试的用量先并进来：下面算 usage、以及「续跑时累加白烧的 token」都以它为准
      rawUsage = mergeRawUsage(carriedUsage, rawUsage)
      const message = describeError(err)
      // 异常 / 中止时也要把已经产出的 token 补推出去（见上面 rawUsage 的注释）
      const usage = rawUsage
        ? buildTurnUsage(rawUsage, startedAt, turnFirstOutputAt, contextTokens, stats.subagents)
        : undefined
      if (watchdogFired) {
        emitEvent({ type: 'error', message: watchdogFired })
        emitEvent({ type: 'finish', finishReason: 'error', ...finishTiming(usage) })
        return finish('error', usage, watchdogFired)
      }
      // 用户主动中止：不算错误（桌面端同样是 aborted 语义）
      const aborted = runSignal.aborted || /abort/i.test(message)
      if (aborted) {
        emitEvent({ type: 'finish', finishReason: 'aborted', ...finishTiming(usage) })
        return finish('aborted', usage)
      }
      /**
       * context overflow 恢复（pi 的 pre-turn 触发点）：上游说装不下，就强制压一次再发。
       *
       * 只恢复一次 —— 压完还溢出说明单条消息本身超窗，再压也是同一个结果。
       * 放在普通重试之前：它比「网络抖动重试」更具体，且不该占用重试次数。
       */
      if (!overflowRecovered && isContextOverflowError(err) && !toolExecuted) {
        overflowRecovered = true
        forceCompact = true
        // 溢出说明「续跑起点」本身也塞不进窗口：清掉断点，从头压一遍再发
        resumeMessages = null
        resumeSteps = 0
        carriedUsage = rawUsage
        emitEvent({ type: 'retry', attempt: retries + 1, maxRetries: null, message })
        continue
      }
      /**
       * 可重试的这一次请求（网络中断 / 上游空响应）→ 退避后重来。重来的方式有两种：
       *
       * - **断点续跑**（`resumeMessages` 非空）：上一次尝试已经跑完若干步，那些步骤的
       *   assistant 消息与工具结果都在断点里，接着**失败的那一步**重新发请求即可。已完成
       *   的工具不会重跑，所以「执行过工具」不再是否决项 —— 这正是它存在的意义。
       * - **整轮重来**（没有断点，通常是第一步就失败）：老路，前端把这次尝试的输出清掉。
       *
       * 两种都发同一条 `retry` 事件，靠 `resume` 区分前端要不要清空已渲染的内容。
       */
      const canResume = resumeMessages !== null
      /**
       * 这一段失败之前**已经产出过内容、且这份内容留得住**（能续跑，前端不清空）→ 重试
       * 计数清零，重新计。
       *
       * 语义从「整轮累计」改成「连续失败次数」（用户要求）：上游既然正常吐过内容，之后
       * 撞上限流就是新的一段故障，理应重新给足 `maxRetries`。否则开头几次抖动把额度吃光，
       * 走到中途再失败时一次机会都不剩 —— 也就是「开头重试两次，后面直接报错」。
       *
       * ⚠️ 两个限定缺一不可：
       * - `canResume`：**整轮重来**会把这次尝试的输出整个清掉（前端清空、模型也当没发生），
       *   那不算「回复了内容」；拿它清零就成了「吐半截就断」的无限重试（`agent.test.ts`
       *   里那条「半截正文 + 失败 → 重跑整轮」的用例正是在钉这个上限）。
       * - `attemptProduced`：只判能续跑还不够 —— 续跑起点是上一次留下的断点，这一次请求
       *   一个字节都没吐就撞限流（并发上限一直没降下来时就是这样）若也清零，同样会无限重试。
       */
      if (canResume && attemptProduced) retries = 0
      if (
        isRetryableAttemptError(err) &&
        !steered &&
        (canResume || !toolExecuted) &&
        retries < maxRetries
      ) {
        retries += 1
        carriedUsage = rawUsage
        emitEvent({
          type: 'retry',
          attempt: retries,
          // Infinity 无法 JSON 序列化：不限制时用 null 表示
          maxRetries: Number.isFinite(maxRetries) ? maxRetries : null,
          // 失败原文一并带上：前端那条提示据此说明「为什么在重试」（限流 / 断网 / 空响应）
          message,
          ...(canResume ? { resume: true } : {})
        })
        const waited = await sleepWithSignal(retryDelayMs(retries), runSignal)
        // 退避期间用户点了停止：按中止收场，不再重试
        if (!waited) {
          emitEvent({ type: 'finish', finishReason: 'aborted', ...finishTiming(usage) })
          return finish('aborted')
        }
        continue
      }
      // 有产出的那次尝试里，这条错误已经随流下发过（见流循环的 error 分支）—— 别再补一条
      if (!errorSent) emitEvent({ type: 'error', message })
      emitEvent({ type: 'finish', finishReason: 'error', ...finishTiming(usage) })
      return finish('error', usage, message)
    }
  }
}
