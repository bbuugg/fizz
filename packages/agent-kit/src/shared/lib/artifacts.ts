/**
 * 会话里的「文档产物」：从消息 parts 里抽出**本轮写出的 markdown 文档**，
 * 在消息下方挂一个可点击的入口（见 `ai-elements/artifact-chips.tsx`）。
 *
 * 数据来源 = 本轮助手的 `write_file` / `edit_file` 工具调用里，`path` 以
 * `.md` / `.mdx` / `.markdown` 结尾、且**确实写成功**的那些文件。
 *
 * 为什么是「兜底识别」而不是等模型显式投递：曾经有个 `present_document` 工具让模型
 * 主动投递，但模型压根不会为「给你一个入口」多调一次专门的工具（实测十几个会话 0 次）
 * —— 用户报「从来没见过这个功能」。改成从写文件调用推导后，文档入口「写了就有」，
 * 不依赖模型配合。
 *
 * ⚠️ **工具结果回填在 tool-call 上**（`parts.ts` 的 `applyEvent`：结果到了就把 `output` /
 * `isError` 合并进同 id 的 `tool-call` part，不单独留一条 `tool-result`）—— 所以成功与否
 * 要看 **tool-call 自己的 `output`**，别去找独立的 `tool-result`（落盘历史里没有）。
 *
 * ⚠️ **必须从 parts 推导，不能从渲染出的工具卡推导**：一轮结束后 reasoning / tool 这些
 * part 会被 `TurnStepGroup` 折叠进一条「思考 ×N · 工具调用 ×M」的摘要里，卡片已经
 * 不在 DOM 里了 —— 挂在卡片上的入口会跟着一起消失。
 */
import type { AgentChatMessage, AgentMessagePart } from '@fizz/contracts/types'

/** 一条可展示的文档入口 */
export interface PresentedDoc {
  /** 工作区相对路径（'/' 分隔）；读取时直接交给文件面板 / 读取接口 */
  path: string
  /** 展示用标题（用文件名） */
  title: string
}

/** 会产生 markdown 文档的写文件工具（其它工具不改文件，不参与识别；旧名留给历史会话） */
const DOC_TOOL_NAMES = new Set(['write', 'edit', 'write_file', 'edit_file'])

/** 工具调用 part 运行时携带的字段（合同类型没声明结果回填字段，与 `parts.ts` 同口径收窄） */
type ToolCallPart = Extract<AgentMessagePart, { type: 'tool-call' }> & {
  output?: unknown
  isError?: boolean
}

/** 文档后缀白名单（只认这些，别把任意写文件都当文档挂一排入口） */
function isDocPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.markdown')
}

/** 从一个工具调用里取出「被写的文件路径」；不是写文件工具 / 不是 md 文档则 null */
function docPathOfCall(part: ToolCallPart): string | null {
  if (!DOC_TOOL_NAMES.has(part.toolName)) return null
  const input = part.input
  if (!input || typeof input !== 'object') return null
  const fields = input as Record<string, unknown>
  const raw = fields.file_path ?? fields.path
  if (typeof raw !== 'string') return null
  const rel = raw.trim().replace(/\\/g, '/')
  if (!rel || !isDocPath(rel)) return null
  return rel
}

/**
 * 剥开工具结果的包装。结果在不同位置形状不同（回填在 tool-call 上的可能是字符串、
 * 也可能是 `{output: …}`），逐层剥到最里层 —— 与 `lib/tool-actions.ts` 的
 * `extractTargets` 同一套口径，别再写第二套。
 */
function unwrapToolOutput(output: unknown): unknown {
  let candidate = output
  if (
    candidate &&
    typeof candidate === 'object' &&
    'output' in (candidate as Record<string, unknown>)
  ) {
    candidate = (candidate as Record<string, unknown>).output
  }
  if (typeof candidate === 'string') {
    try {
      return JSON.parse(candidate)
    } catch {
      return candidate
    }
  }
  return candidate
}

/**
 * 该工具调用是否**真的写成功了**。
 *
 * 只认成功：`guardWrite` 的拒绝（只读模式 / 用户点拒绝）也是一条正常返回的文本结果
 * （不是 error），不判一下会把「没写成的文档」也挂上入口 —— 点开是空的。成功结果一律
 * 以 `Created file` / `Updated file` / `The file … has been updated` 开头，旧历史里则是
 * 「已写入 / 已应用」（见 `packages/tools` 的 write / edit）。
 */
function callSucceeded(part: ToolCallPart): boolean {
  if (part.isError) return false
  const output = unwrapToolOutput(part.output)
  if (typeof output !== 'string') return false
  return /^已(写入|应用)/.test(output) || /<content>\n(Created file|Updated file)\n<\/content>/.test(output) || /^The file .+ has been updated/.test(output)
}

/** 路径末段（两种分隔符都认 —— 数据从服务端来，Windows 上可能带反斜杠） */
function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] || path
}

/**
 * 一条消息里写出的 markdown 文档（按写出顺序，同一路径只留最后一条 ——
 * 先 write_file 建、再 edit_file 改会命中两次，入口只该有一颗）。
 *
 * 只认助手消息：用户消息不会有工具调用，早退省一次遍历。
 */
export function presentedDocsOf(message: AgentChatMessage): PresentedDoc[] {
  if (message.role !== 'assistant') return []
  const byPath = new Map<string, PresentedDoc>()
  for (const part of message.parts) {
    if (part.type !== 'tool-call') continue
    const call = part as ToolCallPart
    const path = docPathOfCall(call)
    if (!path || !callSucceeded(call)) continue
    byPath.set(path, { path, title: fileNameOf(path) })
  }
  return [...byPath.values()]
}
