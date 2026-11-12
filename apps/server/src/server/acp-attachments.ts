/**
 * ACP 会话的附件：把 `UploadFileRef` 读成**字节**，交给 `runAcpAgent` 拼成 image 块。
 *
 * 为什么不用现成的 `createAttachmentResolver`（内置会话给模型用的那套）：
 * 它判的是「云端 provider 能不能拉到这个 URL」，公网部署时优先返回 URL。ACP 那边
 * 相反 —— agent 是同机子进程、`session/prompt` 走 stdio JSON-RPC，**没有 URL 这条路**，
 * 图片只能 base64 内联。所以这里只关心「能不能读到字节」。
 *
 * 读不到 / 不支持的（插件源存的、非图片、超大）不阻断这一轮，降级成一句说明发给
 * agent —— 与内置会话「省略但告诉模型」同一口径，别让用户以为图发出去了。
 */
import type { AcpPromptAttachment } from '@fizz/acp'
import type { UploadFileRef } from '@fizz/contracts/types'
import { adapterFor } from './upload/adapters'

/** 单张上限：与内置会话一致（5MB）。base64 后 ≈ 6.7MB，走管道可接受 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/**
 * 一轮总量上限：**比内置会话的 15MB 更保守**。内置那次是「云端拉 URL / 一次 HTTP body」，
 * 这里是 stdio 上的单行 JSON-RPC —— 一行几十兆会让 agent 侧的读循环长时间占满。
 */
const MAX_TURN_BYTES = 10 * 1024 * 1024

const MB = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}MB`

export interface AcpTurnAttachments {
  attachments: AcpPromptAttachment[]
  /** 没带上的那几张的说明（拼成一行话，作为首个文本块发出去） */
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
  let total = 0

  for (const file of files) {
    if (!file.mediaType.startsWith('image/')) {
      skipped.push(`「${file.name}」不是图片`)
      continue
    }
    const adapter = adapterFor(file.url)
    if (!adapter?.get) {
      // 插件源（S3 / 图床之类）只回 URL，字节不在本机 —— 我们不替用户去下载第三方内容
      skipped.push(`「${file.name}」由插件源保存，本地取不到内容`)
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
    if (!bytes) {
      skipped.push(`「${file.name}」读取失败`)
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

  return {
    attachments,
    ...(skipped.length
      ? {
          note: `（这轮有附件没随消息发出：${skipped.join('、')}。需要的话可以把文件放进工作区，我用文件工具直接读。）`,
        }
      : {}),
  }
}
