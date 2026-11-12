/**
 * local 适配器：落数据目录的 `uploads/` 子目录（`<dataDir>/uploads/<uuid>.<ext>`），
 * 对外 URL 是相对的 `/api/uploads/<uuid>.<ext>`，由 `api/uploads/[name]/route.ts`
 * 公开服务（`<img>` 带不了鉴权头，文件名是服务端生成的 uuid —— 与 screenshots 同思路）。
 *
 * 原始文件名**不参与存储路径**（只进消息历史的 file part 当展示名），扩展名由白名单
 * MIME 反推 —— 契约白名单（isUploadAllowedMime）是第一道闸，这里是第二道。
 *
 * `get()` 是「内联投递」的读回口：没有公网地址时（桌面端 / 局域网），provider 拉不到
 * `/api/uploads/...`，server 会把字节读出来塞进请求体（见 `attachments.ts`）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDataDir } from '@fizz/workspace'
import type { UploadAdapter } from './types'

/** MIME → 存储扩展名（键集合与 contracts 的 UPLOAD_ALLOWED_MIME 一致，svg 刻意不在内） */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf'
}

export function uploadsDir(): string {
  return join(resolveDataDir(), 'uploads')
}

export class LocalUploadAdapter implements UploadAdapter {
  readonly id = 'local'

  async put(input: { name: string; mediaType: string; bytes: Uint8Array }): Promise<{ url: string }> {
    const ext = EXT_BY_MIME[input.mediaType]
    if (!ext) throw new Error(`不支持的附件类型：${input.mediaType}`)
    const dir = uploadsDir()
    await mkdir(dir, { recursive: true })
    const name = `${randomUUID()}.${ext}`
    await writeFile(join(dir, name), input.bytes)
    return { url: `/api/uploads/${name}` }
  }

  /** uuid.ext 形状：挡路径穿越，也顺带把「别人的 URL」全拒掉 */
  owns(url: string): boolean {
    return /^\/api\/uploads\/[0-9a-f-]{36}\.[a-z0-9]+$/.test(url)
  }

  resolveModelUrl(url: string, origin: string): string {
    const base = process.env.FIZZ_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || origin.replace(/\/+$/, '')
    return `${base}${url}`
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
