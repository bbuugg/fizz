/**
 * ACP 会话的附件：图片读成字节拼 image 块，DOCX / 文本文档提取为文本块。
 *
 * 与内置会话一样只读取本地字节；图片内联 base64，DOCX / 文本文档提取为文字。stdio JSON-RPC
 * 的整轮字节上限更保守，因此单独处理支持类型与预算。
 *
 * 读不到 / 不支持的（历史外部地址、PDF、超大）不阻断这一轮，降级成一句说明发给
 * agent —— 与内置会话「省略但告诉模型」同一口径，别让用户以为图发出去了。
 */
import type { AcpPromptAttachment } from '@fizz/acp'
import type { UploadFileRef } from '@fizz/contracts/types'
import { isTextDocumentMime } from '@fizz/contracts/agent-api'
import { createInlineBudget } from '@fizz/agent'
import { adapterFor } from './upload/adapters'
import { createAttachmentResolver } from './upload/attachments'

/** 单张上限：与内置会话一致（5MB）。base64 后 ≈ 6.7MB，走管道可接受 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/**
 * 一轮总量上限：**比内置会话的 15MB 更保守**。内置那次是一次 HTTP body，
 * 这里是 stdio 上的单行 JSON-RPC —— 一行几十兆会让 agent 侧的读循环长时间占满。
 */
const MAX_TURN_BYTES = 10 * 1024 * 1024

const MB = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}MB`

export interface AcpTurnAttachments {
  attachments: AcpPromptAttachment[]
  /** 文档提取正文及未发送附件的说明，作为文本块发出去。 */
  note?: string
}

/**
 * 把本轮的附件读成 ACP 内容块原料。
 *
 * 顺序按用户选择的顺序来（不重排）：`runAcpAgent` 会按「说明 → 图片 → 正文」发出去。
 */
export async function acpPromptAttachments(
  files: UploadFileRef[],
): Promise<AcpTurnAttachments> {
  const attachments: AcpPromptAttachment[] = []
  const skipped: string[] = []
  const documents: string[] = []
  const resolver = createAttachmentResolver()
  let remainingTextChars = createInlineBudget().remainingTextChars
  let total = 0

  for (const file of files) {
    if (isTextDocumentMime(file.mediaType)) {
      const result = await resolver(file)
      if (result.kind !== 'text') {
        skipped.push(result.kind === 'omit' ? result.note ?? `「${file.name}」读取失败` : `「${file.name}」不是文本文档`)
        continue
      }
      const bytes = new TextEncoder().encode(result.text).byteLength
      if (result.text.length > remainingTextChars || total + bytes > MAX_TURN_BYTES) {
        skipped.push(`「${file.name}」超过本轮文档文字或附件总量上限`)
        continue
      }
      documents.push(result.text)
      remainingTextChars -= result.text.length
      total += bytes
      continue
    }
    if (!file.mediaType.startsWith('image/')) {
      skipped.push(`「${file.name}」不是图片`)
      continue
    }
    const adapter = adapterFor(file.url)
    if (!adapter) {
      // 历史外部地址没有本地字节，不下载第三方内容。
      skipped.push(`「${file.name}」本地取不到内容`)
      continue
    }
    let bytes: Uint8Array | null = null
    let mediaType = file.mediaType
    try {
      const got = await adapter.get(file.url)
      if (got) {
        bytes = got.bytes
        mediaType = got.mediaType || mediaType
      }
    } catch {
      bytes = null
    }
    if (!bytes?.byteLength) {
      skipped.push(`「${file.name}」读取失败`)
      continue
    }
    if (!mediaType.startsWith('image/')) {
      skipped.push(`「${file.name}」不是图片`)
      continue
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      skipped.push(`「${file.name}」超过 ${MB(MAX_IMAGE_BYTES)}`)
      continue
    }
    if (total + bytes.byteLength > MAX_TURN_BYTES) {
      skipped.push(`「${file.name}」超过本轮附件总量上限 ${MB(MAX_TURN_BYTES)}`)
      continue
    }
    total += bytes.byteLength
    attachments.push({ mediaType, data: bytes, name: file.name })
  }

  const note = [
    ...documents,
    ...(skipped.length ? [`（这轮有附件没随消息发出：${skipped.join('、')}。需要的话可以把文件放进工作区，我用文件工具直接读。）`] : [])
  ].join('\n\n')
  return { attachments, ...(note ? { note } : {}) }
}
