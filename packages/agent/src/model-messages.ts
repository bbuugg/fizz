/**
 * 历史消息 -> 模型消息的转换。
 *
 * **独立成文件的原因**：本文件对 `ai` / contracts 只有 type-only import，验证脚本
 * （`scripts/verify-uploads.mjs`）可以直接加载它做纯函数测试；prompt.ts 对
 * `@fizz/tools` 有运行时 import，整文件不可独立加载。改这里的转换规则时，
 * 两边的测试一起跑。
 *
 * 工具过程必须用**原生 tool-call / tool-result 结构**，不能压成
 * `[调用工具 xxx]` / `[工具 xxx 返回] xxx` 这类纯文本摘要 ——
 * 模型会把这个格式当成「助手的说话方式」，在自己的正文里照抄出来
 * （实测：多步工具链后开始输出 `[调用工具 read_file]` 这种假调用文本）。
 *
 * 一轮里的工具过程是扁平交错的（text, call, result, text, call, result…），
 * 按「一批 tool-call 及其全部结果」切成若干段：每段 = assistant（文本 + tool-call）
 * + tool（结果），与模型 API 要求的消息顺序一致。
 */
import type { FilePart, ImagePart, ModelMessage, TextPart, ToolCallPart, ToolResultPart } from 'ai'

/**
 * Agent 消息（渲染端历史的结构化镜像，与 `@fizz/contracts/types.AgentMessagePart`
 * 同构 —— **两边改动必须同步**，否则 server 侧全量 typecheck 会红）。
 */
export type AgentMessagePart =
  | { type: 'text'; text: string }
  | {
      /**
       * 附件（图片 / PDF）：`url` 是**取文件的地址**，落盘形态与存储无关。
       * 组装模型消息时由 `resolveAttachment` 决定这一条是给 URL 还是给字节
       * （见 toModelMessages），仍然不抽文本。
       */
      type: 'file'
      url: string
      mediaType: string
      name: string
    }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
      /**
       * 工具结果。**落盘形状是回填在 tool-call 上**（没有独立的 tool-result part，
       * 见 `apps/server/src/server/agent-parts.ts`），缺省 = 没有结果。
       */
      output?: unknown
      isError?: boolean
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }

/** 工具结果的输出结构（ai 包没有单独导出这个类型，从 ToolResultPart 派生） */
type ToolResultOutput = ToolResultPart['output']

/**
 * 非字符串工具结果回给模型时的字符上限。
 *
 * 字符串结果由工具自己负责分页（read_file / search_files）或落盘（output-log）；
 * 但**结构化结果没人管** —— `JSON.stringify` 出来的数组 / 对象能任意大，
 * 且它不在工具作者的控制范围内（工具只是返回一个对象）。这里兜一道底：
 * 超限就截断并明确告诉模型「截断位置」，而不是让它以为拿到的是完整数据。
 *
 * 8000 字符 ≈ 2000 token，比单个工具结果的预算（MAX_TOOL_RESULT_CHARS=4000）宽松，
 * 因为结构化结果通常需要保持 JSON 可读性，不宜裁得太狠。
 */
const MAX_STRUCTURED_OUTPUT_CHARS = 8000

/**
 * 工具结果 -> 模型消息的输出结构（字符串走 text，其余序列化成 json；失败走 error-text）。
 *
 * 这里**不做落盘**：output-log（全文落盘 + 行号续读）只用于 execute_command /
 * web_fetch（见 @fizz/tools 的 output-log.ts），其余工具的超长输出要么靠自己的参数
 * 分页（read_file / search_files），要么在这里按字符上限截断 —— 结构化结果至少
 * 要有上限，否则一个返回大数组的工具能把整轮上下文顶爆。
 */
function toToolOutput(output: unknown, isError?: boolean): ToolResultOutput {
  let value: string
  if (typeof output === 'string') {
    value = output
  } else {
    // 紧凑序列化：`JSON.stringify(v, null, 1)` 每层缩进都要 token，
    // 而模型读紧凑 JSON 毫无障碍 —— 缩进纯属浪费
    const json = JSON.stringify(output) ?? String(output)
    value =
      json.length > MAX_STRUCTURED_OUTPUT_CHARS
        ? `${json.slice(0, MAX_STRUCTURED_OUTPUT_CHARS)}\n…（结构化结果过长已截断：共 ${json.length} 字符，仅保留前 ${MAX_STRUCTURED_OUTPUT_CHARS}。请用更精确的参数收窄返回内容）`
        : json
  }
  return isError ? { type: 'error-text', value } : { type: 'text', value }
}

/** 附件在模型请求里的三种形态（由调用方决定用哪种，本文件零存储知识）。 */
export type ResolvedAttachment =
  /** 让 provider 自己去取（公网可达的绝对地址） */
  | { kind: 'url'; url: string }
  /** 把字节直接塞进请求体：AI SDK 会编码成 data URL，provider 不再回连我们的地址 */
  | { kind: 'inline'; bytes: Uint8Array }
  /** 不发这一条（读不到 / 太大），`note` 会作为一行说明进上下文 */
  | { kind: 'omit'; note?: string }

/** 附件的最小描述（与 `UploadFileRef` / file part 同构，两边都传得进来） */
export interface UploadLikeFile {
  url: string
  mediaType: string
  name: string
}

/**
 * 附件投递策略：给一条附件，回答「这次用 URL、内联字节，还是干脆不发」。
 *
 * 返回 `undefined` = 不知道 / 不归我管，调用方按 `resolveFileUrl` 的老路走。
 * 抛错被当成「读取失败」，降级成一行说明而不是让整轮炸掉。
 */
export type ResolveAttachment = (file: UploadLikeFile) => Promise<ResolvedAttachment | undefined>

/**
 * 一轮请求里内联附件的**总字节**上限（按 URL 去重后累加）。
 *
 * 15MB 的原始字节在请求体里会膨胀成约 20MB（base64 ×4/3）—— 给 Anthropic 的 32MB
 * body 上限留出正文与工具结果的余量。超过就从**最旧**的附件开始降级成一行说明：
 * 用户刚发的图更可能被追问，老图看一眼就够。
 *
 * ⚠️ 这不是「省 token」的闸：token 由像素决定，跟内联与否无关（见 `toModelMessages`
 * 的说明）；它挡的是**每轮重发**把请求体顶爆。
 */
export const MAX_INLINE_TOTAL_BYTES = 15 * 1024 * 1024

/**
 * 整轮共享的内联预算：一次 run 建一个，主历史与运行中插话共用同一份。
 *
 * `counted` 用来**跨多次组装去重**：同一张图在 `toModelMessages` 与插话里各出现一次
 * （或一轮内重建两次上下文），只应该扣一次预算，否则第二次会被误判成超限。
 */
export interface InlineBudget {
  remainingBytes: number
  /** 已经扣过预算的附件 URL */
  counted: Set<string>
}

export function createInlineBudget(maxBytes: number = MAX_INLINE_TOTAL_BYTES): InlineBudget {
  return { remainingBytes: maxBytes, counted: new Set() }
}

/** 规划后的单条附件 */
export interface PlannedAttachment {
  file: UploadLikeFile
  resolved: ResolvedAttachment
}

async function resolveOne(
  file: UploadLikeFile,
  resolve: ResolveAttachment | undefined
): Promise<ResolvedAttachment> {
  if (!resolve) return { kind: 'url', url: file.url }
  try {
    return (await resolve(file)) ?? { kind: 'url', url: file.url }
  } catch {
    return { kind: 'omit', note: `（附件「${file.name}」读取失败，未随本轮发送）` }
  }
}

/**
 * 把一批附件解析成「URL / 内联 / 省略」，并扣一遍总字节预算。
 *
 * 预算**从后往前**分配（`files` 的调用方按「旧 → 新」排列）：超限时先牺牲最旧的，
 * 而不是先到先得把最新的挤掉。
 */
export async function planAttachments(
  files: UploadLikeFile[],
  opts?: { resolveAttachment?: ResolveAttachment; budget?: InlineBudget }
): Promise<PlannedAttachment[]> {
  const planned: PlannedAttachment[] = await Promise.all(
    files.map(async (file) => ({ file, resolved: await resolveOne(file, opts?.resolveAttachment) }))
  )
  const budget = opts?.budget
  if (!budget) return planned
  for (let i = planned.length - 1; i >= 0; i--) {
    const item = planned[i]
    if (item.resolved.kind !== 'inline') continue
    if (budget.counted.has(item.file.url)) continue
    const size = item.resolved.bytes.byteLength
    if (size > budget.remainingBytes) {
      item.resolved = {
        kind: 'omit',
        note: `（附件「${item.file.name}」超出本轮附件体积上限，未随本轮发送）`
      }
      continue
    }
    budget.counted.add(item.file.url)
    budget.remainingBytes -= size
  }
  return planned
}

/**
 * 规划好的附件 -> 模型 part（+ 需要附在正文里的说明）。
 *
 * 形状写错**不会报错**，附件会被静默丢掉，所以这里集中一处产出、两条路
 * （历史组装 / 运行中插话）都调它。
 */
export function attachmentsToParts(
  planned: PlannedAttachment[],
  opts?: { resolveFileUrl?: (url: string) => string }
): { parts: Array<ImagePart | FilePart>; notes: string[] } {
  const parts: Array<ImagePart | FilePart> = []
  const notes: string[] = []
  for (const { file, resolved } of planned) {
    if (resolved.kind === 'omit') {
      notes.push(resolved.note ?? `（附件「${file.name}」未随本轮发送）`)
      continue
    }
    if (resolved.kind === 'inline') {
      parts.push(
        file.mediaType.startsWith('image/')
          ? ({ type: 'image', image: resolved.bytes, mediaType: file.mediaType } satisfies ImagePart)
          : ({
              type: 'file',
              data: resolved.bytes,
              mediaType: file.mediaType,
              filename: file.name
            } satisfies FilePart)
      )
      continue
    }
    const url = new URL(
      opts?.resolveFileUrl ? opts.resolveFileUrl(resolved.url) : resolved.url,
      'http://localhost'
    )
    parts.push(
      file.mediaType.startsWith('image/')
        ? ({ type: 'image', image: url, mediaType: file.mediaType } satisfies ImagePart)
        : ({
            type: 'file',
            data: url,
            mediaType: file.mediaType,
            filename: file.name
          } satisfies FilePart)
    )
  }
  return { parts, notes }
}

/** 单批附件的快捷入口（运行中插话用：一条消息，不存在跨消息的预算排序） */
export async function attachmentParts(
  files: UploadLikeFile[],
  opts?: {
    resolveAttachment?: ResolveAttachment
    resolveFileUrl?: (url: string) => string
    budget?: InlineBudget
  }
): Promise<{ parts: Array<ImagePart | FilePart>; notes: string[] }> {
  const planned = await planAttachments(files, opts)
  return attachmentsToParts(planned, opts)
}

/**
 * 渲染端对话历史 -> 模型消息。
 *
 * `resolveFileUrl`：附件 URL 的绝对化策略由调用方注入（server 端经 UploadAdapter
 * 拼 `FIZZ_PUBLIC_BASE_URL ?? origin`）—— 本文件零存储知识。未传时用 localhost
 * base 兜底：`new URL('/api/...')` 会抛错，不能让一条附件把整轮炸掉。
 *
 * `resolveAttachment`：更进一步的投递策略（URL / 内联字节）。不传 = 全部按 URL
 * 直传，行为与从前逐字节一致。
 *
 * ⚠️ **内联 base64 不占额外 token**：图片 token 由 provider 按**像素**计，传 URL 还是
 * 传字节算出来是同一个数；变的只是请求体大小（×4/3，且每轮重发）。所以真正的闸是
 * `MAX_INLINE_TOTAL_BYTES`（每轮总量），不是单条消息。
 */
export async function toModelMessages(
  history: Array<{ role: 'user' | 'assistant'; parts: AgentMessagePart[] }>,
  opts?: {
    resolveFileUrl?: (url: string) => string
    resolveAttachment?: ResolveAttachment
    /** 整轮共享的内联预算；不传 = 不限总量（调用方自己保证） */
    inlineBudget?: InlineBudget
    /**
     * 这个模型能不能收图片（`AiModelSettings.imageInput`）。缺省 true。
     *
     * 关掉时历史里的图片附件被**过滤成一行说明**，不是整条消息丢掉 —— 用户换过模型之后
     * 老会话仍要能继续跑（那些图片是当时模型真看过的，新模型看不见就说一句）。
     * 新消息里的图片在发送时就被拒绝（见 server 的 startTurn），不会走到这里。
     */
    allowImages?: boolean
  }
): Promise<ModelMessage[]> {
  /**
   * 先一次性规划**整段历史**的附件：预算要按「整轮、从新到旧」分配，
   * 逐条消息各规划一次会变成按时间先到先得 —— 最旧的图反而挤掉最新的。
   */
  const perMessage = new Map<number, { kept: UploadLikeFile[]; omittedImages: number }>()
  const flat: UploadLikeFile[] = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    if (msg.role !== 'user') continue
    const allFiles = msg.parts.filter(
      (p): p is Extract<AgentMessagePart, { type: 'file' }> => p.type === 'file'
    )
    // 模型不收图片：只摘掉 image/*，PDF 等文件仍照常直传
    const kept =
      opts?.allowImages === false
        ? allFiles.filter((f) => !f.mediaType.startsWith('image/'))
        : allFiles
    perMessage.set(i, { kept, omittedImages: allFiles.length - kept.length })
    flat.push(...kept)
  }
  const planned = await planAttachments(flat, {
    resolveAttachment: opts?.resolveAttachment,
    budget: opts?.inlineBudget
  })
  const plannedByMessage = new Map<number, PlannedAttachment[]>()
  {
    let cursor = 0
    for (const [index, entry] of perMessage) {
      plannedByMessage.set(index, planned.slice(cursor, cursor + entry.kept.length))
      cursor += entry.kept.length
    }
  }

  const messages: ModelMessage[] = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    if (msg.role === 'user') {
      const text = msg.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
        .trim()
      const entry = perMessage.get(i)
      const omittedImages = entry?.omittedImages ?? 0
      const omittedNote =
        omittedImages > 0
          ? `（用户发送了 ${omittedImages} 张图片，但当前模型未开启图片输入，这些图片已省略）`
          : ''
      const { parts, notes } = attachmentsToParts(plannedByMessage.get(i) ?? [], {
        ...(opts?.resolveFileUrl ? { resolveFileUrl: opts.resolveFileUrl } : {})
      })
      if (parts.length === 0) {
        const body = [text, omittedNote, ...notes].filter(Boolean).join('\n')
        if (body) messages.push({ role: 'user', content: body })
        continue
      }
      // 有附件：content 升级为数组（AI SDK 的 UserContent 原生支持），附件在前文本在后
      const content: Array<ImagePart | FilePart | TextPart> = [...parts]
      if (text) content.push({ type: 'text', text })
      if (omittedNote) content.push({ type: 'text', text: omittedNote })
      for (const note of notes) content.push({ type: 'text', text: note })
      messages.push({ role: 'user', content })
      continue
    }

    let content: Array<TextPart | ToolCallPart> = []
    let results: ToolResultPart[] = []
    /** 已发出、还没配到结果的 toolCallId */
    const pending = new Set<string>()

    const flush = () => {
      // 有调用没结果（用户中止 / 工具没跑完）：补一条占位结果，
      // 否则 assistant 里的 tool-call 在协议上找不到配对，请求会被 provider 拒掉
      for (const id of pending) {
        const call = content.find(
          (p): p is ToolCallPart => p.type === 'tool-call' && p.toolCallId === id
        )
        if (call) {
          results.push({
            type: 'tool-result',
            toolCallId: id,
            toolName: call.toolName,
            output: { type: 'error-text', value: '该工具调用未执行完成（被中止或对话已结束）' }
          })
        }
      }
      pending.clear()
      if (content.length) messages.push({ role: 'assistant', content })
      if (results.length) messages.push({ role: 'tool', content: results })
      content = []
      results = []
    }

    for (const part of msg.parts) {
      if (part.type === 'text') {
        if (part.text.trim()) content.push({ type: 'text', text: part.text })
      } else if (part.type === 'tool-call') {
        content.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? {}
        })
        /**
         * ⚠️ 落盘形状把结果**回填在 tool-call 的 `output` 上**（没有独立的
         * tool-result part，见 `apps/server/src/server/agent-parts.ts`）。
         *
         * 只认 `tool-result` 的话，历史里每个工具调用都会掉进 pending、被补成
         * 「未执行完成」占位 —— 下一轮模型会真的以为上一轮的工具全被中止了
         * （实测：问「刚才工具返回的是什么」，模型答「被中止了、输出是空的」）。
         */
        if (part.output !== undefined) {
          results.push({
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: toToolOutput(part.output, part.isError)
          })
          // 这一批调用全部有结果了，收束成一段
          if (pending.size === 0) flush()
        } else {
          pending.add(part.toolCallId)
        }
      } else if (part.type === 'tool-result') {
        // 孤儿结果（找不到对应调用）：丢弃，否则同样过不了 provider 校验
        if (!pending.has(part.toolCallId)) continue
        pending.delete(part.toolCallId)
        results.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toToolOutput(part.output, part.isError)
        })
        // 这一批调用全部有结果了，收束成一段
        if (pending.size === 0) flush()
      }
      // reasoning：思考内容不回传（对模型无价值，部分 provider 还要求签名才能回传）
    }
    flush()
  }
  return messages
}
