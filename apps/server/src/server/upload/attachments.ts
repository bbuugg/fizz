/** 附件只读本地字节：图片 / PDF 内联，其他受支持文档提取文字，不透传公网 URL。 */
import type { ResolvedAttachment } from '@fizz/agent'
import type { UploadFileRef } from '@fizz/contracts/types'
import { adapterFor } from './adapters'
import { extractDocumentText, formatDocumentText } from './documents'

/** 保留单文件内联上限，避免超大附件撑爆上游请求体。 */
const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024

export function createAttachmentResolver(): (file: UploadFileRef) => Promise<ResolvedAttachment> {
  return async (file) => {
    const adapter = adapterFor(file.url)
    const got = await adapter?.get(file.url).catch(() => null)
    if (!got || got.bytes.byteLength === 0) {
      return { kind: 'omit', note: `（附件「${file.name}」读取失败，未随本轮发送）` }
    }
    // MIME 以存储层为准，避免调用方把 DOCX 假标成 PDF 而绕过文本提取。
    try {
      const document = extractDocumentText(got.mediaType || file.mediaType, got.bytes)
      if (document) return { kind: 'text', text: formatDocumentText(file.name, document) }
    } catch (err) {
      return { kind: 'omit', note: `（文档「${file.name}」未随本轮发送：${err instanceof Error ? err.message : '读取失败'}）` }
    }
    if (got.bytes.byteLength > MAX_INLINE_FILE_BYTES) {
      return {
        kind: 'omit',
        note: `（附件「${file.name}」超过 ${MAX_INLINE_FILE_BYTES / (1024 * 1024)}MB，未随本轮发送）`
      }
    }
    return { kind: 'inline', bytes: got.bytes }
  }
}

/** 读图子任务也只读取内置附件，不下载第三方地址。 */
export async function readAttachmentBytes(
  url: string
): Promise<{ mediaType: string; bytes: Uint8Array } | null> {
  if (!url) return null
  const adapter = adapterFor(url)
  const got = await adapter?.get(url).catch(() => null)
  if (!got || got.bytes.byteLength === 0 || got.bytes.byteLength > MAX_INLINE_FILE_BYTES) return null
  return { mediaType: got.mediaType, bytes: got.bytes }
}
