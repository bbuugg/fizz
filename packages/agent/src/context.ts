/**
 * 上下文压缩（compaction）：对话历史过长时，把「旧的那一段」摘要成一条检查点，
 * 只保留最近约 `keepRecentTokens` 的原文。
 *
 * ## 这套机制照搬 pi（`badlogic/pi-mono` 的 `packages/coding-agent/src/core/compaction/compaction.ts`）
 *
 * 只有四件事，别再往里加第五件：
 * 1. **触发**：`contextTokens > contextWindow - reserveTokens`（默认预留 16384）；
 * 2. **切点**：从尾部向前累计 token，够 `keepRecentTokens`（默认 20000）就切；
 *    切点只能落在消息边界（fizz 的历史里 tool 结果内嵌在 assistant 消息里，天然满足）；
 * 3. **摘要**：初始 prompt / 增量 prompt（带 `<previous-summary>` 合并）；
 *    切点落在回合中间时，额外生成 turn-prefix 摘要并合并；
 * 4. **拼装**：摘要作为一条 `user` 消息置顶 + 保留的近期原文；
 *    文件清单（`<read-files>` / `<modified-files>`）由框架从工具调用补，不让模型生成。
 *
 * ## 刻意**没有**的东西（都验证过是负优化，别再捡回来）
 *
 * - 没有「清旧工具结果」这一层（microcompact）：它会改动请求前缀，而上游前缀缓存一旦
 *   断了就要按全价重读整段历史；省下的只是命中价。清一次要十几轮才回本。
 * - 没有「判断厂商缓存 TTL / 命中率」的逻辑：那等于拿上一轮的观测去猜下一轮，判错就会
 *   亲手把前缀改掉。**前缀保持一致就够了**，缓存冷不冷是上游的事。
 * - 没有「按比例提前压」（窗口 × 0.8）：pi 用固定预留量，简单且和上游报的用量对得上。
 *
 * 为什么放这里而不是塞进 route：
 * - 压缩要调模型（生成摘要），得有 model 实例 —— `resolveModel` 在本包；
 * - 输入输出都是本包 `toModelMessages` 的产物，内聚；
 * - 桌面端不走 `runAgent`（它自己调 streamText），所以这里不会误伤桌面端。
 */
import { asSchema, streamText } from 'ai'
import {
  COMPACTION_MIN_KEEP_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  compactionKeepRecentTokens,
  compactionReserveTokens
} from '@fizz/contracts/types'
import { resolveModel } from './resolve-model'
import { toModelMessages } from './model-messages'
import type { AgentChatMessage, AiModelConfig } from '@fizz/contracts/types'
import type { ModelMessage } from 'ai'

/** pi 的默认压缩参数（`DEFAULT_COMPACTION_SETTINGS`） */
export interface CompactionSettings {
  enabled: boolean
  /** 给系统提示词与模型回复预留的空间 */
  reserveTokens: number
  /** 压缩后保留的近期上下文 token 数 */
  keepRecentTokens: number
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000
}

/**
 * pi 的触发判据：`contextTokens > contextWindow - reserveTokens`。
 *
 * fizz 支持的模型窗口跨度很大（32k~1M），16384 的固定预留放到小窗口上会占掉一半，
 * 于是按窗口封顶到 25%（**唯一的机械适配，不改机制**）。
 */
/** 保留区的下限：再怎么让位也要留这么多原文，否则模型连「刚才在干什么」都不知道 */
export const MIN_KEEP_TOKENS = COMPACTION_MIN_KEEP_TOKENS

export function resolveCompactionSettings(
  contextWindow: number,
  overrides?: Partial<CompactionSettings>,
  /**
   * **消息之外、压缩动不了的那部分**：系统提示词 + 工具 schema（`baseTokens`），
   * 有检查点时再加已落盘摘要的 token。
   *
   * 保留区必须给这块让位：否则 `base + 摘要` 一旦吃掉大半窗口，`base + keep` 仍然
   * 在触发线以上 —— 压完立刻又超、每轮白付一次摘要调用，而每次只摘要得动一两轮。
   */
  fixedTokens = 0
): CompactionSettings {
  const merged = { ...DEFAULT_COMPACTION_SETTINGS, ...overrides }
  const reserveTokens = Math.min(merged.reserveTokens, compactionReserveTokens(contextWindow))
  // 保留区不能把整个窗口吃掉，否则永远切不出「要压缩的那段」；
  // 还要和触发线留 20% 余量 —— keep == 触发线时，压完立刻又满足触发条件，每轮重压一次。
  // 上限取 `max(MIN_KEEP, budget × 0.8)`：预算被吃光时退到下限（能压多少算多少），
  // 但仍然允许调用方显式给一个更小的 override（测试 / 特殊场景）。
  //
  // 公式收在 contracts 的 `compactionKeepRecentTokens` 里：界面判断「手动压缩按钮能不能点」
  // 用的是同一个数，两边不能各算一套（曾用触发线当闸，按钮在 92% 以下永远灰着）。
  const keepRecentTokens = compactionKeepRecentTokens(contextWindow, fixedTokens, merged)
  return { ...merged, reserveTokens, keepRecentTokens }
}

/**
 * 留给「消息」的预算（token）。≤ `MIN_KEEP_TOKENS` 时压缩注定压不到触发线以下 ——
 * 该压的是系统提示词 / 工具定义，不是历史，调用方据此跳过（别再白付摘要调用）。
 */
export function compactionBudget(
  contextWindow: number,
  settings: CompactionSettings,
  fixedTokens: number
): number {
  return contextWindow - settings.reserveTokens - Math.max(0, fixedTokens)
}

/**
 * 摘要正文的 token 预算（写进 prompt 的软约束）。
 *
 * 取保留区的 40%：摘要 + 保留区一起要能塞进「窗口 − 预留 − base」里，给摘要留四成
 * 已经偏宽松，但它是**软**约束 —— 真正的保险是调用方压不下去时直接不压（见
 * `compactionBudget`），而不是靠模型听话。
 *
 * 下限 1500：再小的窗口也得容得下「目标 / 已完成 / 待办」这几段，否则摘要等于没用。
 */
function summaryBudgetTokens(keepRecentTokens: number): number {
  return Math.max(1500, Math.min(8000, Math.floor(keepRecentTokens * 0.4)))
}


export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings
): boolean {
  if (!settings.enabled) return false
  return contextTokens > contextWindow - settings.reserveTokens
}

/**
 * pi 的 `calculateContextTokens`（`core/compaction/compaction.ts`）：把一条助手消息的
 * `usage` 折成「发这条请求时上下文有多大」。
 *
 * ⚠️ 字段映射别照抄 pi 的四项相加：
 * - pi 的 `Usage` 把缓存拆在 `input` **之外**：`input + cacheRead + cacheWrite + output`；
 * - fizz 拿到的 AI SDK usage 里 `inputTokens` **已经包含**缓存命中的部分，
 *   `cachedInputTokens` 只是它的子集 —— 再加一遍就是重复计数。
 *
 * 所以等价式是 `totalTokens || inputTokens + outputTokens`。
 *
 * 这正是输入框圆环显示的数：最后一次请求上游**真实上报**的输入 + 输出，
 * 而不是本地按字符估出来的量。pi 的 `estimateContextTokens` 在此基础上再加
 * 「最后一条带 usage 的消息之后那些消息」的估算；一轮结束时后者为空，所以就是本函数。
 */
export function calculateContextTokens(usage: {
  totalTokens?: number
  inputTokens: number
  outputTokens: number
}): number {
  return usage.totalTokens || usage.inputTokens + usage.outputTokens
}

/**
 * 一条助手消息代表的上下文大小（pi 的 `getAssistantUsage` + `calculateContextTokens`）。
 *
 * 优先 `usage.contextTokens`：那是**最后一次请求**的 input+output；`TurnUsage.totalTokens`
 * 是整轮累计（多步循环里每步都加一遍），拿它当上下文会虚高。
 *
 * fizz 没有 `stopReason`，但中止 / 报错的那一轮 `usage` 本来就可能是 0，所以按
 * `> 0` 过滤 —— 与 pi 跳过 aborted / error / 全零 usage 等价。
 */
function assistantContextTokens(msg: AgentChatMessage | undefined): number {
  if (!msg || msg.role !== 'assistant' || !msg.usage) return 0
  const direct = msg.usage.contextTokens
  if (direct && direct > 0) return direct
  return calculateContextTokens(msg.usage)
}

/* ---------------- 摘要提示词（pi 原文，逐字照搬） ---------------- */

const SUMMARIZATION_SYSTEM_PROMPT = [
  'You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.',
  '',
  'Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.'
].join('\n')

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`

/**
 * 宽字符（CJK / 假名 / 谚文 / 全角符号）的个数。
 *
 * 只扫码点、不建数组：工具结果动辄几十万字符，`text.match(/…/g)` 会分配一个
 * 等长的字符串数组（纯中文时就是几十万个元素），在压缩判断这种每步都跑的热路径上
 * 是纯粹的浪费。`charCodeAt` 的循环没有分配，V8 能把它编成很紧的循环。
 */
function countWideChars(text: string): number {
  let wide = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    // 0x2E80 以下是 ASCII / 拉丁扩展 / 希腊 / 西里尔 —— 全是窄字符，先快速跳过
    if (c < 0x2e80) continue
    if (
      c <= 0x9fff || // CJK 部首、假名、CJK 统一表意文字
      (c >= 0xac00 && c <= 0xd7af) || // 谚文音节
      (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容表意文字
      (c >= 0xfe30 && c <= 0xfe4f) || // CJK 兼容形式
      (c >= 0xff01 && c <= 0xff60) || // 全角 ASCII（，。：；！？等）
      (c >= 0xffe0 && c <= 0xffe6) // 全角符号（￥ ￡ 等）
    ) {
      wide += 1
    }
  }
  return wide
}

/**
 * token 估算：**CJK 加权的 pi 公式**。
 *
 * pi 原式是 `Math.ceil(chars / 4)` —— 为英文写的。一个汉字在 JS 字符串里只算 1 个
 * char，于是被估成 0.25 token，而主流分词器里它接近 1~1.5 token：**纯中文会话被
 * 低估 4~6 倍**（AGENTS.md 这种全文注入的中文文档、中文工具结果都吃这个亏）。
 *
 * 「触发线按真实 usage、切点按这个低估的估算」这种半截修法会带来两种不对称的坏结果：
 * - 明明按真实用量该切掉 80k，实际只切了 20k 估算（≈ 真实 20k），界面报「压到 40k」
 *   而真实请求还有 100k，跑一个工具就又满了（用户实测的 120k → 40k → 120k 就是这个）；
 * - 压缩后的上下文仍按低估值判阈值 → 该压不压。
 *
 * 所以这里改成：宽字符按 1 token、其余按 4 字符 1 token。**纯 ASCII 的结果与 pi 逐字节
 * 相同**（`wide = 0` 时就是 `ceil(len / 4)`），只有中日韩内容会变准 —— 这不是「加一层
 * 压缩」，只是把同一把尺子换成和上游一致的刻度。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const wide = countWideChars(text)
  return wide + Math.ceil((text.length - wide) / 4)
}

/** 一张图按 1200 token 估（pi 的 `ESTIMATED_IMAGE_CHARS = 4800` 字符 ÷ 4） */
const ESTIMATED_IMAGE_TOKENS = 1200

/** 工具结果的文本值（AI SDK 的 `output` 有 text / json / error-text 几种形状） */
function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const o = output as { type?: string; value?: unknown }
    if ((o.type === 'text' || o.type === 'error-text') && typeof o.value === 'string') return o.value
    if (o.type === 'json') return JSON.stringify(o.value ?? null)
  }
  return output === undefined ? '' : JSON.stringify(output)
}

/**
 * 一条消息的 token 数，口径对齐 pi 的 `estimateTokens`（哪些部分算、哪些不算）：
 * 正文 + 思考 + toolCall 的 `name` 与 `JSON.stringify(arguments)` + 工具结果正文；
 * 图片按 `ESTIMATED_IMAGE_TOKENS` 直接计。
 *
 * ⚠️ 这里**直接产 token**，不再是「先数字符再除 4」：CJK 加权后除数是可变的
 * （见 `estimateTokens`），先合并字符数再除会把宽窄字符混在一起算错。
 */
function estimateMessageTokens(m: ModelMessage): number {
  const { content } = m
  if (typeof content === 'string') return estimateTokens(content)
  if (!Array.isArray(content)) return 0
  let tokens = 0
  for (const part of content as Array<{ type: string } & Record<string, unknown>>) {
    switch (part.type) {
      case 'text':
      // pi 把 thinking 也算进上下文（它确实占 token）
      case 'reasoning':
        tokens += estimateTokens(String(part.text ?? ''))
        break
      case 'image':
        tokens += ESTIMATED_IMAGE_TOKENS
        break
      case 'tool-call':
        tokens += estimateTokens(
          String(part.toolName ?? '') + JSON.stringify(part.input ?? {})
        )
        break
      case 'tool-result':
        tokens += estimateTokens(toolOutputText(part.output))
        break
      default:
        break
    }
  }
  return tokens
}

/**
 * 一组消息的 token 数（导出：runAgent 要用它算「本轮实际请求的上下文」）。
 *
 * 逐条求和 —— 与 pi 的 `sumTokens` 一致（不是先把总字符数加完再除）。
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let sum = 0
  for (const m of messages) sum += estimateMessageTokens(m)
  return sum
}

/**
 * 上下文占用的**唯一口径**：有可用真值就用真值（+ 其后的增量估算），没有才全量估算。
 *
 * 全仓只准用这一个式子回答「现在多满」：圆环、压缩触发、压缩卡片的 before/after
 * 都走它，三处数字因此永远对得上。
 *
 * 为什么真值优先：
 * - 上游报的 usage 是**唯一的事实**，估算只是它的近似；
 * - 估算的分词刻度（CJK 加权）各家差 20%~50%，一旦用它当判据，就会「估算说超了其实没超」。
 *
 * 为什么还要估算：真值只覆盖**已经发出去的那一次**，其后的新增（本轮新消息、刚产出的
 * 工具结果）只能估 —— 这是 `realWithTail` 里 tail 的部分。
 *
 * @param realWithTail 真值 + 其后新增内容的估算；没有真值时传 0
 * @param fallbackEstimate 一条真值都没有时的全量估算（首轮 / 刚压缩过）
 */
export function contextUsed(realWithTail: number, fallbackEstimate: number): number {
  return realWithTail > 0 ? realWithTail : fallbackEstimate
}

/**
 * 每个会话最近一次测到的「消息之外」开销（系统提示词 + 工具 schema）。
 *
 * 手动压缩那条路（`POST /api/chat/compress`）不建 agent，拿不到 `estimateBaseTokens`；
 * 不补这块，它报的 before/after 就只有消息部分，和圆环（含 base）差一个 base ——
 * 用户会看到「压完 32k，圆环还是 100k」。`runAgent` 每轮把测到的值记在这里兜底。
 *
 * 只活在进程内存里：重启后第一轮之前是空，退化成「只算消息」（老行为），不影响正确性。
 */
const baseTokensByConversation = new Map<string, number>()

export function rememberBaseTokens(conversationId: string, tokens: number): void {
  if (!conversationId || !Number.isFinite(tokens) || tokens <= 0) return
  if (baseTokensByConversation.size > 200) {
    const oldest = baseTokensByConversation.keys().next().value
    if (oldest !== undefined) baseTokensByConversation.delete(oldest)
  }
  baseTokensByConversation.set(conversationId, Math.round(tokens))
}

export function rememberedBaseTokens(conversationId: string): number | undefined {
  return baseTokensByConversation.get(conversationId)
}

/** 交接摘要的固定开头：轮中压缩靠它认出「这条是上一次的摘要」 */
const SUMMARY_MARKER = '（以下是对先前对话的交接摘要，替代原始历史）'

function messageText(m: ModelMessage | undefined): string {
  if (!m) return ''
  const c = m.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .map((part) => (part as { type?: string; text?: string }).type === 'text' ? String((part as { text?: string }).text ?? '') : '')
    .filter(Boolean)
    .join('\n')
}

function isSummaryMessage(m: ModelMessage | undefined): boolean {
  return !!m && m.role === 'user' && messageText(m).startsWith(SUMMARY_MARKER)
}

/** 最早的「有 tool-call 但还没有 tool-result」的那条消息下标；没有 = -1 */
function pendingToolCallIndex(messages: ModelMessage[]): number {
  const resolved = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      const part = raw as { type?: string; toolCallId?: string }
      if (part.type === 'tool-result' && part.toolCallId) resolved.add(part.toolCallId)
      else if (part.type === 'tool-call' && part.toolCallId && !resolved.has(part.toolCallId)) return i
    }
  }
  return -1
}

/** 从 ModelMessage 里抽文件操作清单（`<read-files>` / `<modified-files>`） */
function extractModelFileOps(messages: ModelMessage[], ops: FileOperations): void {
  for (const m of messages) {
    const content = m.content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      const part = raw as { type?: string; toolName?: string; input?: Record<string, unknown> }
      if (part.type !== 'tool-call') continue
      const path = inputPathOf(part.input)
      if (!path) continue
      if (part.toolName === 'read' || part.toolName === 'read_file') ops.read.add(path)
      else if (WRITE_TOOL_NAMES.has(part.toolName ?? '')) ops.modified.add(path)
    }
  }
}

export interface CompactMessagesResult {
  /** 压缩后的消息（未压缩时与输入同一引用） */
  messages: ModelMessage[]
  compressed: {
    beforeTokens: number
    afterTokens: number
    summarizedTurns: number
    keptTurns: number
  } | null
  summary: string | null
}

/**
 * 轮中压缩：工具步边界上把**在途消息**（`ModelMessage[]`）压一次，下一步请求立刻变小。
 *
 * 与 `compactHistory` 的差别只在输入：那边是落盘的 `AgentChatMessage`（有 id、能落检查点），
 * 这边是已经转换好的模型消息（没有 id，**落不了检查点**）。所以它只做「本轮自救」，
 * 下一轮由 pre-flight 按真实大小重压一次。
 */
export async function compactModelMessages(
  messages: ModelMessage[],
  opts: {
    contextWindow: number
    baseTokens?: number
    /** 上游最后一次请求的真实上下文（有就优先于逐条估算） */
    triggerTokens?: number
    settings?: Partial<CompactionSettings>
    model: AiModelConfig
    signal?: AbortSignal
    force?: boolean
    onSummaryStart?: (info: CompactionSummaryStart) => void
    onSummaryDelta?: (info: CompactionSummaryDelta) => void
  }
): Promise<CompactMessagesResult> {
  const unchanged: CompactMessagesResult = { messages, compressed: null, summary: null }
  if (messages.length === 0) return unchanged

  const baseTokens = Math.max(0, opts.baseTokens ?? 0)
  const settings = resolveCompactionSettings(opts.contextWindow, opts.settings, baseTokens)
  const estimated = baseTokens + estimateMessagesTokens(messages)
  // 调用方给的 triggerTokens 是「真值 + 尾部估算」；没给才退回全量估算
  const beforeTokens = contextUsed(opts.triggerTokens ?? 0, estimated)
  if (!opts.force && !shouldCompact(beforeTokens, opts.contextWindow, settings)) return unchanged
  /**
   * 与 `compactHistory` 同一条闸：`系统提示词 + 工具定义` 已经吃掉预算时，压也压不到
   * 触发线以下。这里更贵 —— 每个工具步边界都会白调一次摘要模型。
   */
  if (compactionBudget(opts.contextWindow, settings, baseTokens) <= MIN_KEEP_TOKENS) {
    return unchanged
  }

  const tokens = messages.map((m) => estimateMessagesTokens([m]))
  let cutIndex = 0
  let accumulated = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    accumulated += tokens[i] ?? 0
    if (accumulated >= settings.keepRecentTokens) {
      cutIndex = i
      break
    }
  }
  // 未完成的工具调用必须留在保留区，否则摘要会把 call 和后面的 result 拆开
  const pending = pendingToolCallIndex(messages)
  if (pending >= 0 && pending < cutIndex) cutIndex = pending
  /**
   * ⚠️ 切点**绝不能落在 `tool` 消息上**（实测报错：
   * `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）。
   *
   * `toModelMessages` 把一批工具结果单独收成一条 `tool` 消息，它的 `tool-call` 在
   * **前一条** assistant 里。切在 `tool` 上等于「只留结果、丢掉调用」，摘要置顶之后消息
   * 序列变成 `user(摘要) → tool → …`，provider 校验直接拒掉整轮 —— 而这一轮的工具其实
   * 都跑完了，用户看到的就是「压完就报协议错」。
   *
   * 往回退到那条 assistant 一起保留：少摘要一步换请求合法，而且它们本来就是同一批调用
   * （`while` 而不是 `if` —— 极端输入里可能连着几条 `tool`，退到第一个非 `tool` 为止）。
   */
  while (cutIndex > 0 && messages[cutIndex]?.role === 'tool') cutIndex -= 1
  if (cutIndex <= 0) return unchanged

  const summarized = messages.slice(0, cutIndex)
  const kept = messages.slice(cutIndex)
  /**
   * **上一次轮中压缩的产物**：一条轮中压缩可能压过不止一次，那时 `messages[0]` 就是
   * 上一份摘要。它不能当普通对话再摘要一遍（等于「摘要的摘要」，每压一次丢一层信息），
   * 要当 `previous-summary` 传，只摘要它**之后**的新消息。
   */
  const previousSummary = isSummaryMessage(summarized[0]) ? messageText(summarized[0]) : undefined
  const fresh = previousSummary ? summarized.slice(1) : summarized
  if (fresh.length === 0) return unchanged
  const conversationText = serializeConversation(fresh)
  if (!conversationText.trim()) return unchanged

  const fileOps = createFileOps()
  extractModelFileOps(summarized, fileOps)

  opts.onSummaryStart?.({
    beforeTokens,
    // 报「这次新摘要了几条」（合并上一份摘要时不算它自己）
    summarizedTurns: fresh.length,
    keptTurns: kept.length
  })
  const onDelta = opts.onSummaryDelta
    ? (delta: string) => opts.onSummaryDelta?.({ delta, phase: 'checkpoint' })
    : undefined
  const summary = await generateSummaryFromText(
    conversationText,
    opts.model,
    previousSummary,
    opts.signal,
    undefined,
    onDelta,
    summaryBudgetTokens(settings.keepRecentTokens)
  )
  const text = `${SUMMARY_MARKER}\n\n${summary}${formatFileOperations(fileOps)}`

  const firstKept = kept[0]
  let result: ModelMessage[]
  if (firstKept?.role === 'user') {
    // 避免连续两条 user：摘要并进保留区第一条 user 消息
    const content = firstKept.content
    const merged: ModelMessage = {
      ...firstKept,
      content: [
        { type: 'text', text },
        ...(typeof content === 'string'
          ? [{ type: 'text' as const, text: content }]
          : (content as Array<{ type: 'text' } | { type: 'image' } | { type: 'file' }>))
      ]
    } as ModelMessage
    result = [merged, ...kept.slice(1)]
  } else {
    result = [{ role: 'user', content: [{ type: 'text', text }] }, ...kept]
  }

  return {
    messages: result,
    compressed: {
      beforeTokens,
      afterTokens: baseTokens + estimateMessagesTokens(result),
      summarizedTurns: fresh.length,
      keptTurns: kept.length
    },
    summary: text
  }
}

/**
 * 把一条工具定义折成「模型实际看到的那部分文本」：描述 + 入参 JSON Schema。
 *
 * 拿不到 schema（不是 AI SDK 工具 / schema 是懒加载的 thenable 且 await 失败 / 转换抛错）
 * 就只算描述：宁可低估，也不要因为一个估不准的工具把整轮对话搞挂。
 */
async function toolToText(tool: unknown): Promise<string> {
  if (!tool || typeof tool !== 'object') return ''
  const t = tool as { description?: unknown; inputSchema?: unknown }
  const parts: string[] = [typeof t.description === 'string' ? t.description : '']
  if (t.inputSchema) {
    try {
      const schema = asSchema(t.inputSchema as never) as { jsonSchema?: unknown }
      const raw = schema?.jsonSchema
      const resolved =
        raw && typeof (raw as PromiseLike<unknown>).then === 'function'
          ? await (raw as PromiseLike<unknown>)
          : raw
      if (resolved) parts.push(JSON.stringify(resolved))
    } catch {
      // 认不出来的 schema：只留描述（见函数注释）
    }
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * 系统提示词 + 全部工具定义的 token 估算 —— 请求里**最容易被忽略的一块**。
 *
 * 它们不在 `messages` 里，但每次请求都要发出去，而且占比不小（项目约束文档 AGENTS.md
 * 是全文注入的 + 十来个工具的 schema）。压缩判断与圆环统计都把它算上，口径才和上游
 * 真正收到的东西对得上；不算的话「估算 190k、上游说超了」这种错位会一直存在。
 */
export async function estimateBaseTokens(
  instructions: string,
  tools: Record<string, unknown>
): Promise<number> {
  let total = estimateTokens(instructions)
  for (const tool of Object.values(tools)) total += estimateTokens(await toolToText(tool))
  return total
}

/** pi 的 `TOOL_RESULT_MAX_CHARS`：摘要输入里工具结果的上限 */
const TOOL_RESULT_MAX_CHARS = 2_000

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
}

/**
 * 摘要用的可见正文（pi 的 `contentText`）：**只取 text 块**。
 *
 * 思考 / 图片不进摘要 —— 与 pi 的 `serializeConversation` 一致（它只读 text 与 toolCall）。
 * 工具结果消息则取 `output` 的文本值。
 */
function contentText(m: ModelMessage): string {
  const { content } = m
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const part of content as Array<{ type: string } & Record<string, unknown>>) {
    if (part.type === 'text') out.push(String(part.text ?? ''))
    else if (part.type === 'tool-result') out.push(toolOutputText(part.output))
  }
  return out.join('\n').trim()
}

/** `[Assistant tool calls]` 那段：`name(k=v, k=v)`（pi 的拼法，v 走 JSON.stringify） */
function toolCallLines(m: ModelMessage): string[] {
  if (!Array.isArray(m.content)) return []
  const calls: string[] = []
  for (const part of m.content as Array<{ type: string } & Record<string, unknown>>) {
    if (part.type !== 'tool-call') continue
    const args = (part.input ?? {}) as Record<string, unknown>
    const argStr = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ')
    calls.push(`${String(part.toolName ?? '?')}(${argStr})`)
  }
  return calls
}

/**
 * pi 的 `serializeConversation`（逐字对齐）：
 * `[User]:` / `[Assistant]:` / `[Assistant tool calls]:` / `[Tool result]:`，`\n\n` 连接。
 *
 * 纯文本序列化是刻意为之：摘要模型拿到的是「文本」，不是可继续的对话结构，
 * 否则它会接着聊下去而不是输出检查点。工具结果截断到 2000 字符（pi 的做法）。
 */
function serializeConversation(messages: ModelMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const text = contentText(m)
      if (text) parts.push(`[User]: ${text}`)
    } else if (m.role === 'assistant') {
      const text = contentText(m)
      if (text) parts.push(`[Assistant]: ${text}`)
      const calls = toolCallLines(m)
      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`)
    } else if (m.role === 'tool') {
      const text = contentText(m)
      if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * 服务端生效的**兜底窗口**：环境变量 `FIZZ_CONTEXT_BUDGET` > `DEFAULT_CONTEXT_WINDOW`(200k)。
 *
 * 它只在「这个模型没有单独配上下文窗口」时生效 —— 模型自己的配置永远优先
 * （见 contracts 的 `resolveContextWindow`）。保留环境变量的意义是 dev 逃生门：
 * 接一个从没配过的本地模型时，不改代码就能把兜底值调小 / 调大。
 *
 * 导出给 `GET /api/chat/context`：前端算「兜底分母」要用同一个数，两端口径才一致。
 */
export function defaultContextWindowFromEnv(): number {
  const env = process.env.FIZZ_CONTEXT_BUDGET
  if (env) {
    const n = Number(env)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return DEFAULT_CONTEXT_WINDOW
}

/* ---------------- 压缩（照 pi：阈值 → 切点 → 摘要 → 拼装） ---------------- */

/**
 * 检查点缓存：按会话记住「保留起点 + 摘要正文」。
 *
 * pi 把检查点写进 `session.jsonl`，下一轮重新加载；fizz 的历史是调用方每轮传进来的
 * 未压缩全量，所以这里做等价的事：记住检查点，下一轮原样拼回同一个位置。
 * 没有这份状态，每轮都会重新摘要一次 —— 摘要文本每轮都不同，前缀缓存每轮全废。
 */
interface AutoSummaryEntry {
  /** 保留起点的消息 id（找不到 = 历史被改过，重新摘要） */
  keepFromMessageId: string
  /** 完整的摘要消息正文（含文件清单）—— 原样复用，前缀才稳定 */
  text: string
  at: number
}

const AUTO_SUMMARY_CACHE_LIMIT = 128
const autoSummaryCache = new Map<string, AutoSummaryEntry>()

/** 清自动摘要缓存（会话被删 / 测试用）。不传 = 全清 */
export function clearAutoSummaryCache(conversationId?: string): void {
  if (conversationId) autoSummaryCache.delete(conversationId)
  else autoSummaryCache.clear()
}

function rememberAutoSummary(conversationId: string, entry: AutoSummaryEntry): void {
  // 先删再插：Map 的插入顺序即 LRU 顺序
  autoSummaryCache.delete(conversationId)
  autoSummaryCache.set(conversationId, entry)
  while (autoSummaryCache.size > AUTO_SUMMARY_CACHE_LIMIT) {
    const oldest = autoSummaryCache.keys().next().value
    if (oldest === undefined) break
    autoSummaryCache.delete(oldest)
  }
}

/**
 * 文件操作追踪（pi 的 `readFiles` / `modifiedFiles`）。
 *
 * 由框架从工具调用里抽，不让摘要模型自己列 —— 模型会漏、会编。
 */
interface FileOperations {
  read: Set<string>
  modified: Set<string>
}

function createFileOps(): FileOperations {
  return { read: new Set(), modified: new Set() }
}

/** 会改文件的工具名：新名（dsh 对齐后的 `write` / `edit`）与历史里的旧名都认 */
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'write_file', 'edit_file'])

/** 工具入参里的路径：新 schema 叫 `file_path`，旧历史里叫 `path` */
function inputPathOf(input: Record<string, unknown> | undefined): string | undefined {
  const value = input?.file_path ?? input?.path
  return typeof value === 'string' ? value : undefined
}

/** fizz 的工具名：`read` / `write` / `edit`（旧历史里是 `read_file` 等） */
function extractFileOps(history: AgentChatMessage[], ops: FileOperations): void {
  for (const m of history) {
    for (const part of m.parts) {
      if (part.type !== 'tool-call') continue
      const call = part as unknown as { toolName?: string; input?: Record<string, unknown> }
      const path = inputPathOf(call.input)
      if (!path) continue
      if (call.toolName === 'read' || call.toolName === 'read_file') ops.read.add(path)
      else if (WRITE_TOOL_NAMES.has(call.toolName ?? '')) ops.modified.add(path)
    }
  }
}

/**
 * pi 的 `formatFileOperations`：`modified = written ∪ edited`、`read = read \ modified`，
 * 各排一次序保证逐字节稳定；整块以两个换行开头，段间也是两个换行。
 */
function formatFileOperations(ops: FileOperations): string {
  const modified = [...ops.modified].sort()
  const read = [...ops.read].filter((f) => !ops.modified.has(f)).sort()
  const sections: string[] = []
  if (read.length > 0) sections.push(`<read-files>\n${read.join('\n')}\n</read-files>`)
  if (modified.length > 0) {
    sections.push(`<modified-files>\n${modified.join('\n')}\n</modified-files>`)
  }
  if (sections.length === 0) return ''
  return `\n\n${sections.join('\n\n')}`
}

/** pi 的 `CutPointResult` */
interface CutPointResult {
  /** 从这个下标开始保留 */
  firstKeptIndex: number
  /** 切点所在回合的起点（-1 = 没切开回合） */
  turnStartIndex: number
  isSplitTurn: boolean
}

/**
 * pi 的 `findCutPoint`：从尾部向前累计，够 `keepRecentTokens` 就切。
 *
 * fizz 的历史里 tool 结果内嵌在 `tool-call` 的 `output` 上（没有独立的 tool-result
 * 消息），所以**每条消息都是合法切点** —— 「绝不切在 tool result 上」这条天然成立。
 */
function findCutPoint(
  history: AgentChatMessage[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
  tokens: number[]
): CutPointResult {
  let accumulated = 0
  let cutIndex = startIndex
  for (let i = endIndex - 1; i >= startIndex; i--) {
    accumulated += tokens[i] ?? 0
    if (accumulated >= keepRecentTokens) {
      cutIndex = i
      break
    }
  }

  const startsTurn = history[cutIndex]?.role === 'user'
  let turnStartIndex = -1
  if (!startsTurn) {
    for (let i = cutIndex; i >= startIndex; i--) {
      if (history[i]?.role === 'user') {
        turnStartIndex = i
        break
      }
    }
  }
  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1
  }
}

/** 摘要失败：pi 的 `getSummarizationFailure` —— 截断的半成品绝不能写成检查点 */
function assertSummary(text: string, finishReason: string | undefined, label: string): string {
  const trimmed = text.trim()
  if (finishReason === 'length') {
    throw new Error(`${label} failed: generation hit the token cap and the summary is incomplete`)
  }
  if (!trimmed) throw new Error(`${label} failed: empty summary`)
  return trimmed
}

/** 交接文档的两段：先摘要历史，切回合时再补一段 turn-prefix */
export type CompactionSummaryPhase = 'checkpoint' | 'turn-prefix'

export interface CompactionSummaryDelta {
  delta: string
  phase: CompactionSummaryPhase
}

export interface CompactionSummaryStart {
  beforeTokens: number
  summarizedTurns: number
  keptTurns: number
}

/**
 * 跑一次摘要，并把增量逐块交出去。
 *
 * ⚠️ **流式只影响展示，不影响落盘语义**：正文要等 `textStream` 走完、`finishReason`
 * 拿到且 `assertSummary` 通过后才返回。调用方据此才写 `autoSummary` / `contextSummary`
 * —— 中途 abort / 抛错时不会留下半份摘要。`onDelta` 只负责把已生成的片段推给界面。
 */
async function streamSummaryText(args: {
  model: AiModelConfig
  system: string
  prompt: string
  label: string
  signal: AbortSignal | undefined
  onDelta?: (delta: string) => void
}): Promise<string> {
  const result = streamText({
    model: resolveModel(args.model),
    system: args.system,
    messages: [{ role: 'user', content: args.prompt }],
    ...(args.signal ? { abortSignal: args.signal } : {})
  })

  let text = ''
  for await (const delta of result.textStream) {
    if (!delta) continue
    text += delta
    args.onDelta?.(delta)
  }
  const finishReason = await result.finishReason
  return assertSummary(text, finishReason, args.label)
}

/** 一次摘要调用（初始 prompt / 增量 prompt 走同一条路，pi 的 `generateSummaryWithUsage`） */
async function generateSummaryFromText(
  conversationText: string,
  model: AiModelConfig,
  previousSummary: string | undefined,
  signal: AbortSignal | undefined,
  customInstructions?: string,
  onDelta?: (delta: string) => void,
  /**
   * 摘要正文的 token 预算（软约束，写进 prompt）。
   *
   * 为什么需要：摘要**每轮都原样发出去、且不参与任何压缩**。`UPDATE_SUMMARIZATION_PROMPT`
   * 又是「PRESERVE all existing information」—— 几次增量合并之后它会单调膨胀，最后
   * 吃掉小半个窗口，那时历史压到保留区也没用（`base + 摘要 + 保留区` 本身就超标）。
   * 只给指令、不设 `maxOutputTokens`：硬截断会撞 `finishReason === 'length'`，
   * 而 `assertSummary` 会因此拒收整份摘要（宁可摘要长一点，也不能落不下检查点）。
   */
  budgetTokens?: number
): Promise<string> {
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT
  if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`
  if (budgetTokens) {
    basePrompt = `${basePrompt}

Length budget: the whole summary must stay within about ${budgetTokens} tokens. It is re-sent with every request, so its length is a direct cost. If it would exceed that, drop the least useful details (finished sub-tasks, superseded decisions, verbose examples) instead of growing — but never drop file paths, function names, error messages, open blockers, or the user's stated constraints.`
  }

  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
  promptText += basePrompt

  return streamSummaryText({
    model,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    prompt: promptText,
    label: 'Summarization',
    signal,
    ...(onDelta ? { onDelta } : {})
  })
}

async function generateSummary(
  messages: ModelMessage[],
  model: AiModelConfig,
  previousSummary: string | undefined,
  signal: AbortSignal | undefined,
  customInstructions?: string,
  onDelta?: (delta: string) => void,
  budgetTokens?: number
): Promise<string> {
  return generateSummaryFromText(
    serializeConversation(messages),
    model,
    previousSummary,
    signal,
    customInstructions,
    onDelta,
    budgetTokens
  )
}

/** 切点落在回合中间时，为被切掉的那半截单独生成一份小摘要（pi 的 turn-prefix） */
async function generateTurnPrefixSummary(
  messages: ModelMessage[],
  model: AiModelConfig,
  signal: AbortSignal | undefined,
  onDelta?: (delta: string) => void
): Promise<string> {
  const promptText = `# Conversation\n${serializeConversation(messages)}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`
  return streamSummaryText({
    model,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    prompt: promptText,
    label: 'Turn prefix summarization',
    signal,
    ...(onDelta ? { onDelta } : {})
  })
}

export interface CompactHistoryResult {
  /** 发给模型的历史（未触发 = 与输入同一引用） */
  history: AgentChatMessage[]
  /**
   * 压缩统计；**只有真的重算过摘要**才非 null。
   *
   * 复用检查点时故意返回 null：那是每轮都发生的常规拼接，不该每轮都往前端推一条
   * 「上下文已压缩」—— 用户会以为系统一直在压。
   */
  compressed: {
    beforeTokens: number
    afterTokens: number
    summarizedTurns: number
    keptTurns: number
  } | null
  /** 复用了上次的检查点（本轮没有调摘要模型） */
  reused: boolean
  /**
   * 没压成的原因（`compressed === null` 时给调用方一句准确的话，别再统一说
   * 「历史还没超出保留区」—— 那句话在「系统提示词已经把预算吃光」时是误导）。
   *
   * - `below-keep`：检查点之后的历史还不够一个保留区，没什么可摘要的；
   * - `no-budget`：`系统提示词 + 工具定义（+ 已有摘要）` 已经吃掉预算，压缩压不到
   *   触发线以下 —— 该减的是提示词 / 工具，不是历史。
   */
  skipped?: 'below-keep' | 'no-budget'
  /** 这次生成的摘要正文（含文件清单）；复用 / 未压缩时为 null */
  summary: string | null
  /**
   * 被摘要部分的**末条消息**（手动压缩落检查点用）。
   *
   * 切片的语义是「这条**之后**的消息保持原文」，所以必须是摘要覆盖到的最后一条，
   * 记在保留区末条会让最近一轮凭空消失。
   */
  summarizedUpTo: { id: string; createdAt: number } | null
}

/**
 * 上下文压缩主入口：**pi 的 `prepareCompaction` + `compact` 合并版**。
 *
 * 决策顺序（与 pi 一致）：
 * 1. 没到 `window - reserveTokens` → 原样返回；
 * 2. 有检查点、起点还在、起点之后的原文仍在 `keepRecentTokens` 内 → 只拼接，不调模型；
 * 3. 否则：找切点 → 摘要（有旧摘要就增量合并）→ 生成新检查点。
 *
 * `force`（手动压缩 / 上游 context overflow 恢复）：跳过阈值判断，切点逻辑不变。
 */
export async function compactHistory(
  history: AgentChatMessage[],
  opts: {
    /** 会话 id：检查点缓存的键。缺失 = 不固化（每轮重算，行为退回加这个能力之前） */
    conversationId?: string
    /** 落盘的检查点（进程重启后内存缓存是空的，用它接上）；`at` 用于判断 usage 是否陈旧 */
    seed?: { keepFromMessageId: string; text: string; at?: number }
    /** 摘要**真的重算**时回调（供 server 落盘） */
    onAutoSummary?: (entry: { keepFromMessageId: string; text: string }) => void
    /**
     * 交接文档开始生成（切点已定、马上就要调摘要模型）。
     * 只用于展示，不代表摘要一定成功 —— 失败 / 中止时不会有对应的 `context-compressed`。
     */
    onSummaryStart?: (info: CompactionSummaryStart) => void
    /** 交接文档的流式增量（仅展示；完整正文校验通过后才会落检查点） */
    onSummaryDelta?: (info: CompactionSummaryDelta) => void
    contextWindow: number
    baseTokens?: number
    /** 覆盖 pi 的默认参数（reserveTokens / keepRecentTokens） */
    settings?: Partial<CompactionSettings>
    /** 跳过阈值判断（手动压缩 / overflow 恢复） */
    force?: boolean
    /** 手动压缩时的额外关注点（pi 的 `customInstructions`） */
    customInstructions?: string
    model: AiModelConfig
    signal?: AbortSignal
  }
): Promise<CompactHistoryResult> {
  const unchanged: CompactHistoryResult = {
    history,
    compressed: null,
    reused: false,
    summary: null,
    summarizedUpTo: null
  }
  if (history.length === 0) return unchanged

  const baseTokens = Math.max(0, opts.baseTokens ?? 0)

  /** 逐条估算：历史是调用方传进来的全量，逐条转一次比整份转再猜要准 */
  const tokens: number[] = []
  for (const m of history) tokens.push(estimateMessagesTokens(await toModelMessages([m])))

  // ① 先找检查点，拼出「当前真正会发出去的上下文」—— 阈值判的是**它**，不是原始历史。
  //    反过来的话，压缩完之后原始历史仍然巨大，下一轮又判超阈值 → 每轮重压一次。
  const cached =
    (opts.conversationId ? autoSummaryCache.get(opts.conversationId) : undefined) ?? opts.seed
  const cachedIndex = cached ? history.findIndex((m) => m.id === cached.keepFromMessageId) : -1
  const hasCheckpoint = cachedIndex > 0 && cached !== undefined
  const checkpointIndex = hasCheckpoint ? cachedIndex : 0
  const assembled = hasCheckpoint ? withSummary(history, cachedIndex, cached!.text) : history

  /**
   * 压缩动不了的那两块：系统提示词 / 工具 schema，以及**已有摘要本身**。
   *
   * 摘要也必须算进去 —— 它每轮都原样发出去、且不参与任何压缩。增量合并几次之后
   * 它本身就可能吃掉小半个窗口，那时保留区还按 20000 算，压完必然还在触发线以上。
   */
  const fixedTokens = baseTokens + (hasCheckpoint ? estimateTokens(cached!.text) : 0)
  const settings = resolveCompactionSettings(opts.contextWindow, opts.settings, fixedTokens)

  /**
   * 触发量 = `max(即将发出去的那份估算, 上一轮最后一次请求的真实 usage)`。
   *
   * - **必须估「即将发出去的那份」**：`assembled` 才是这一轮真正发给模型的数组；
   *   上一轮的 usage 只代表上一轮，中间一旦发生过切片（手动检查点 / 轮中压缩），
   *   两者就不是一回事。
   * - **真实 usage 只当兜底下限**，而且必须在它**不早于检查点**时才采信：压完之后
   *   那条 usage 代表的是压缩前的大小，再拿它取 max 就会「压完立刻又判超」。
   */
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')
  const checkpointAt = cached?.at ?? 0
  const usageIsStale = hasCheckpoint && (!lastAssistant || lastAssistant.createdAt <= checkpointAt)
  const realUsage = usageIsStale ? 0 : assistantContextTokens(lastAssistant)
  /**
   * 「即将发出去的那份」的**纯估算**：检查点之后的消息 + 摘要正文 + base。
   *
   * ⚠️ 不能用 `estimateContextTokens(assembled)` —— 它内部会去捞「最后一条带 usage 的
   * 助手消息」，而那条 usage 可能早于检查点（就是 `usageIsStale` 要挡的东西），
   * 一捞回来就等于把陈旧值又算进去了。这里只求和 `tokens`（已经按条算好），不做二次推断。
   */
  let assembledTokens = baseTokens + (hasCheckpoint ? estimateTokens(cached!.text) : 0)
  for (let i = checkpointIndex; i < history.length; i += 1) assembledTokens += tokens[i] ?? 0
  /** 真值之后新增的部分（通常就是本轮那条 user 消息） */
  let trailingTokens = 0
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i] === lastAssistant) break
    trailingTokens += tokens[i] ?? 0
  }
  const beforeTokens = contextUsed(realUsage + trailingTokens, assembledTokens)
  const overBudget = shouldCompact(beforeTokens, opts.contextWindow, settings)

  if (!opts.force && !overBudget) {
    if (!hasCheckpoint) {
      // 低于阈值 = 不需要压（例如用户删过消息）→ 顺手清缓存，别留一段没用的摘要
      if (opts.conversationId) clearAutoSummaryCache(opts.conversationId)
      return unchanged
    }
    // 有检查点且总量没超 → **原样复用**（不调模型、前缀逐字节不变）
    if (opts.conversationId && !autoSummaryCache.has(opts.conversationId)) {
      rememberAutoSummary(opts.conversationId, {
        keepFromMessageId: cached!.keepFromMessageId,
        text: cached!.text,
        at: Date.now()
      })
    }
    return { history: assembled, compressed: null, reused: true, summary: null, summarizedUpTo: null }
  }

  /**
   * 预算被「压缩动不了的东西」吃光了：`系统提示词 + 工具 + 已有摘要` 已经把窗口顶到
   * 触发线附近，历史再怎么切也回不到阈值以下。这时**不再调摘要模型** —— 每轮白付一次
   * 调用、还会把请求前缀改掉（上游缓存全废），换来的只是「摘要了 1 轮、占用没降」。
   * 把原因交回调用方，让界面说人话。
   */
  if (compactionBudget(opts.contextWindow, settings, fixedTokens) <= MIN_KEEP_TOKENS) {
    return hasCheckpoint
      ? {
          history: assembled,
          compressed: null,
          reused: true,
          summary: null,
          summarizedUpTo: null,
          skipped: 'no-budget'
        }
      : { ...unchanged, skipped: 'no-budget' }
  }

  // ② 切点：只在上次检查点之后找（之前的内容已经在摘要里了）
  const cut = findCutPoint(
    history,
    checkpointIndex,
    history.length,
    settings.keepRecentTokens,
    tokens
  )
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex
  // 没有可摘要的（切点落在起点上）：不压，有检查点就继续用
  if (historyEnd <= checkpointIndex) {
    return hasCheckpoint
      ? {
          history: assembled,
          compressed: null,
          reused: true,
          summary: null,
          summarizedUpTo: null,
          skipped: 'below-keep'
        }
      : { ...unchanged, skipped: 'below-keep' }
  }

  const summarizeSlice = history.slice(checkpointIndex, historyEnd)
  const turnPrefixSlice = cut.isSplitTurn
    ? history.slice(cut.turnStartIndex, cut.firstKeptIndex)
    : []

  const fileOps = createFileOps()
  extractFileOps(summarizeSlice, fileOps)
  extractFileOps(turnPrefixSlice, fileOps)
  // 上一次检查点的文件清单继续向前继承（pi 的 `extractFileOperations`）
  if (cachedIndex > 0 && cached) extractFileOps(history.slice(0, cachedIndex), fileOps)

  const summarizedTurns = historyEnd - checkpointIndex
  const keptTurns = history.length - cut.firstKeptIndex
  opts.onSummaryStart?.({ beforeTokens, summarizedTurns, keptTurns })

  const checkpointDelta = opts.onSummaryDelta
    ? (delta: string) => opts.onSummaryDelta?.({ delta, phase: 'checkpoint' })
    : undefined
  const turnPrefixDelta = opts.onSummaryDelta
    ? (delta: string) => opts.onSummaryDelta?.({ delta, phase: 'turn-prefix' })
    : undefined

  // ③ 摘要：有旧摘要就增量合并，否则生成初始检查点
  //    摘要长度给一个软预算（见 `generateSummaryFromText` 的 `budgetTokens`）：
  //    它每轮都发出去且不参与压缩，膨胀了会把「保留区」挤到没有。
  const budget = summaryBudgetTokens(settings.keepRecentTokens)
  let summary: string
  if (cut.isSplitTurn && turnPrefixSlice.length > 0) {
    const historyText =
      summarizeSlice.length > 0
        ? await generateSummary(
            await toModelMessages(summarizeSlice),
            opts.model,
            cached?.text,
            opts.signal,
            opts.customInstructions,
            checkpointDelta,
            budget
          )
        : (cached?.text ?? 'No prior history.')
    const prefixText = await generateTurnPrefixSummary(
      await toModelMessages(turnPrefixSlice),
      opts.model,
      opts.signal,
      turnPrefixDelta
    )
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixText}`
  } else {
    summary = await generateSummary(
      await toModelMessages(summarizeSlice),
      opts.model,
      cached?.text,
      opts.signal,
      opts.customInstructions,
      checkpointDelta,
      budget
    )
  }

  const text = `${summary}${formatFileOperations(fileOps)}`
  const firstKept = history[cut.firstKeptIndex]

  const result = withSummary(history, cut.firstKeptIndex, text)
  const afterTokens = baseTokens + estimateMessagesTokens(await toModelMessages(result))

  // 落点：内存 + 调用方（server 落盘）。起点只会往后移，天然单调
  if (firstKept) {
    if (opts.conversationId) {
      rememberAutoSummary(opts.conversationId, {
        keepFromMessageId: firstKept.id,
        text,
        at: Date.now()
      })
    }
    opts.onAutoSummary?.({ keepFromMessageId: firstKept.id, text })
  }

  const lastSummarized = history[historyEnd - 1]
  return {
    history: result,
    compressed: {
      beforeTokens,
      afterTokens,
      summarizedTurns,
      keptTurns
    },
    reused: false,
    summary: text,
    summarizedUpTo: lastSummarized
      ? { id: lastSummarized.id, createdAt: lastSummarized.createdAt }
      : null
  }
}

/**
 * 把摘要并到「保留起点」那一条上（pi 是单独插一条 user；这里并进去）。
 *
 * 唯一的理由：fizz 支持的一批 provider 会拒连续两条 user 消息。顺序与内容与 pi 一致，
 * 只是省掉了那条独立的摘要消息 —— 这不属于压缩机制。
 */
function withSummary(
  history: AgentChatMessage[],
  firstKeptIndex: number,
  text: string
): AgentChatMessage[] {
  const rest = history.slice(firstKeptIndex)
  const first = rest[0]
  if (!first) {
    return [{ id: `compaction-${Date.now()}`, role: 'user', parts: [{ type: 'text', text }], createdAt: Date.now() }]
  }
  if (first.role === 'user') {
    return [{ ...first, parts: [{ type: 'text', text }, ...first.parts] }, ...rest.slice(1)]
  }
  // 兜底：起点不是 user（历史从中途开始）—— 单独插一条
  return [
    { id: `compaction-${first.id}`, role: 'user', parts: [{ type: 'text', text }], createdAt: first.createdAt },
    ...rest
  ]
}

/**
 * 上游报「上下文超窗」了吗（pi 的 overflow 恢复判据）。
 *
 * 各家文案不一，这里只认最常见的几种；宁可漏判（走正常报错），不要误判
 * （误判会白白多压一次上下文）。
 */
export function isContextOverflowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /context[ _-]?length|context[ _-]?window|maximum context|prompt is too long|too many tokens|exceeds the maximum/i.test(
    message
  )
}
