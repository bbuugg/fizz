/**
 * local 适配器：落数据目录的 `uploads/` 子目录（`<dataDir>/uploads/<uuid>.<ext>`），
 * 对外 URL 是相对的 `/api/uploads/<uuid>.<ext>`，由 `api/uploads/[name]/route.ts`
 * 公开服务（`<img>` 带不了鉴权头，文件名是服务端生成的 uuid —— 与 screenshots 同思路）。
 *
 * 原始文件名**不参与存储路径**（只进消息历史的 file part 当展示名），扩展名由白名单
 * MIME 反推 —— 契约白名单（isUploadAllowedMime）是第一道闸，这里是第二道。
 *
 * `get()` 是模型附件的读回口：server 统一读取字节，供图片 / PDF 内联或文档文字提取。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDataDir } from '@fizz/workspace'
import { UPLOAD_EXT_BY_MIME } from '@fizz/contracts/agent-api'
import type { UploadAdapter } from './types'

/** MIME → 存储扩展名（键集合与 contracts 的 UPLOAD_ALLOWED_MIME 一致，svg 刻意不在内） */
const EXT_BY_MIME = UPLOAD_EXT_BY_MIME

export function uploadsDir(): string {
  return join(resolveDataDir(), 'uploads')
}

export class LocalUploadAdapter implements UploadAdapter {
  readonly id = 'local'

  async put(input: {
    name: string
    mediaType: string
    bytes: Uint8Array
    signal?: AbortSignal
  }): Promise<{ url: string }> {
    const ext = EXT_BY_MIME[input.mediaType]
    if (!ext) throw new Error(`不支持的附件类型：${input.mediaType}`)
    if (input.signal?.aborted) throw new DOMException('上传已取消', 'AbortError')
    const dir = uploadsDir()
    await mkdir(dir, { recursive: true })
    const name = `${randomUUID()}.${ext}`
    const target = join(dir, name)
    const temporary = join(dir, `.${name}.tmp`)
    try {
      if (input.signal?.aborted) throw new DOMException('上传已取消', 'AbortError')
      await writeFile(temporary, input.bytes, input.signal ? { signal: input.signal } : undefined)
      if (input.signal?.aborted) throw new DOMException('上传已取消', 'AbortError')
      await rename(temporary, target)
      if (input.signal?.aborted) {
        await rm(target, { force: true })
        throw new DOMException('上传已取消', 'AbortError')
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    return { url: `/api/uploads/${name}` }
  }

  /** uuid.ext 形状：挡路径穿越，也顺带把「别人的 URL」全拒掉 */
  owns(url: string): boolean {
    return /^\/api\/uploads\/[0-9a-f-]{36}\.[a-z0-9]+$/.test(url)
  }

  /** 取消恰好落在提交之后：把这条已经 rename 完成的文件删掉。 */
  async remove(url: string): Promise<void> {
    if (!this.owns(url)) return
    await rm(join(uploadsDir(), url.slice('/api/uploads/'.length)), { force: true })
  }

  async get(url: string): Promise<{ mediaType: string; bytes: Uint8Array } | null> {
    if (!this.owns(url)) return null
    const name = url.slice('/api/uploads/'.length)
    try {
      const bytes = await readFile(join(uploadsDir(), name))
      const mediaType =
        Object.entries(EXT_BY_MIME).find(([, ext]) => name.endsWith(`.${ext}`))?.[0] ??
        'application/octet-stream'
      return { mediaType, bytes }
    } catch {
      return null
    }
  }
}
