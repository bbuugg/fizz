/** 内置附件存储与引用校验；插件不能注册上传源，模型只接收内联字节。 */
import { isUploadAllowedMime } from '@fizz/contracts/agent-api'
import type { UploadFileRef } from '@fizz/contracts/types'
import { adapterFor } from './adapters'

export type { UploadAdapter } from './types'
export { adapterFor, resolveUploadAdapter } from './adapters'
export { createAttachmentResolver, readAttachmentBytes } from './attachments'

/** 新消息、队列与插话只接受内置存储的图片 / 文档引用。 */
export function validateUploadFiles(files: UploadFileRef[]): string | null {
  for (const file of files) {
    const name = typeof file?.name === 'string' ? file.name : ''
    if (!name || typeof file.url !== 'string' || !adapterFor(file.url) || !isUploadAllowedMime(file.mediaType)) {
      return `附件不合法：${name || '缺失文件名'}（仅支持已上传的图片 / 文档）`
    }
  }
  return null
}
