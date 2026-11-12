/**
 * 附件（图片 / PDF）的前端状态与校验。交互对齐 ainav/sdk 的 ChatInput：
 * 选中即占位（图片立刻本地预览）、上传进度、失败标记、发送前剥掉未完成的附件。
 *
 * 真正的上传在 `lib/api.ts` 的 `uploadFile`（desktop 走 IPC 桥、web 走 XHR 带进度），
 * 这里只管「哪些文件能传」与「附件列表条目长什么样」。
 */
import { UPLOAD_ALLOWED_MIME, UPLOAD_MAX_BYTES, isUploadAllowedMime } from '@fizz/contracts/agent-api'
import type { AgentMessagePart, UploadFileRef } from '@fizz/contracts/types'

/** 输入框附件区的一条待发送附件（与 ainav 的 ChatAttachment 同形状） */
export interface ChatAttachment {
  id: string
  name: string
  mediaType: string
  /** 服务端地址（上传完成后填入）；占位期为空串 */
  url: string
  /** 是否已上传完成（含编辑回显——那些本来就是历史里的服务端 url） */
  uploaded: boolean
  /** 本地预览：刚选的图片是 data URL；编辑回显的图片直接用服务端 url（渲染端统一经 loadMediaObjectUrl 解析） */
  previewUrl?: string
  /** 上传进度 0-100；100 = 完成 */
  progress: number
  /** 上传失败原因（非空 = 失败态，发送时被剥掉） */
  error?: string
  /**
   * 这条附件传到哪个上传源（`local` = 内置存储，其余 = 插件注册的上传源）。
   * 选中文件时就定下来（整个批次的附件用同一个源），随引用一起提交 / 落盘。
   */
  provider?: string
}

let attachmentSeq = 0
export function nextAttachmentId(): string {
  attachmentSeq += 1
  return `att-${Date.now()}-${attachmentSeq}`
}

/** 本地预校验用的容量口径（按「所有可用上传源的并集」算出来，见 ChatPanel 的 providers） */
export interface UploadLimits {
  /** 任一可用源接受的 MIME 精确集合 */
  mime: readonly string[]
  /** 其中最大的单文件上限 */
  maxBytes: number
}

/**
 * 类型（精确 MIME 白名单，svg 刻意排除）与大小校验。**缺省按契约口径**（图片 + PDF / 10MB），
 * 传了 `limits` 就按它判 —— 插件注册的上传源可以声明自己的 accept，比契约宽或窄都行。
 *
 * 拒绝项带可直接 toast 的人话原因，`file.name` 拼在前面。
 */
export function splitUploadable(
  files: FileList | File[],
  limits?: UploadLimits
): {
  ok: File[]
  rejected: Array<{ name: string; reason: string }>
} {
  const allowed = new Set(limits?.mime ?? [...UPLOAD_ALLOWED_MIME])
  const maxBytes = limits?.maxBytes ?? UPLOAD_MAX_BYTES
  const ok: File[] = []
  const rejected: Array<{ name: string; reason: string }> = []
  for (const file of Array.from(files)) {
    // 知道目标上传源时**只按它**判（插件可以比契约宽，也可以更窄）；不知道就按契约口径
    const typeOk = limits ? allowed.has(file.type) : isUploadAllowedMime(file.type)
    if (!typeOk) {
      rejected.push({
        name: file.name,
        reason: limits ? '选定的上传源不支持这种文件类型' : '仅支持图片和 PDF 文件'
      })
    } else if (file.size > maxBytes) {
      rejected.push({
        name: file.name,
        reason: `文件大小不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`
      })
    } else {
      ok.push(file)
    }
  }
  return { ok, rejected }
}

/**
 * 待发送附件 → 提交给服务端的引用（剥掉还在上传 / 已失败的）。
 *
 * 三个出口共用这一份：普通发送（`ChatRequest.files`）、入队（`QueuedMessage.files`）、
 * 插话（`SteerInput.files`）。各自写一遍 `.filter(a => a.uploaded && a.url)` 的话，
 * 早晚有一处漏掉过滤，把一条半截附件递上去（服务端会 400，用户只看到莫名的报错）。
 */
export function sendableAttachments(attachments: ChatAttachment[]): UploadFileRef[] {
  return attachments
    .filter((a) => a.uploaded && a.url)
    .map(({ name, mediaType, url, provider }) => ({
      name,
      mediaType,
      url,
      ...(provider ? { provider } : {})
    }))
}

/**
 * 从消息 parts 里取出附件引用 —— 三处「编辑回显」共用：
 * 编辑并重发（历史消息）、编辑队列消息、编辑插话。
 *
 * parts 里附件是 file 分支（`{ type:'file', url, mediaType, name }`，见 contracts/types）。
 * 传空数组是**合法且有语义**的：调用方的 `restoreAttachments` 会用「整份替换」的方式
 * 铺进输入框，所以「这条没附件」= 清空输入框里现有的附件（与「编辑」语义一致）。
 */
export function fileRefsOfParts(parts: AgentMessagePart[]): UploadFileRef[] {
  return parts.flatMap((p) =>
    // `data:` 的是**显示副本**而不是上传文件：ACP 回放里的图片（用户发的 / agent 回传的）
    // 只剩 base64，没有可重发的 `/api/uploads/...` 地址。带上它去「编辑重发」会被
    // 服务端当非法附件拒掉，所以这里直接排除。
    p.type === 'file' && !p.url.startsWith('data:')
      ? [{ name: p.name, mediaType: p.mediaType, url: p.url, ...(p.provider ? { provider: p.provider } : {}) }]
      : []
  )
}

/** 图片的本地预览（data URL）。失败不致命：调用方吞掉，附件走「无预览」形态 */
export function readImagePreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsDataURL(file)
  })
}
