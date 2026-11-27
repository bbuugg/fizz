/**
 * 对外提供上传的附件：上传接口把文件存到数据目录的 `uploads/`（local 适配器），
 * 这里按文件名读出来以正确的 MIME 返回（支持 Range，便于大文件 / 视频流式）。
 *
 * 与 `/api/screenshots` 同款的两条设计约束：
 * - 文件名是服务端生成的 uuid + 白名单扩展名（挡路径穿越 + 高熵不可猜测），所以这条
 *   路由在 app.ts 的 isPublicPath 白名单里 —— 消息里的 `<img>` 带不了 Authorization 头，
 *   启用鉴权时也得能直接加载；
 * - 原始文件名不参与存储路径，扩展名是上传时由 MIME 白名单反推的。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from '@fizz/workspace'
import { UPLOAD_EXT_BY_MIME } from '@fizz/contracts/agent-api'
import { jsonError } from '@/app/api/_lib/auth'
import { mediaResponse } from '@/lib/server/lib/media'

// 只允许 <uuid>.<ext>：既挡路径穿越，也限定只服务 uploads 目录里的文件
const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z0-9]+)$/
const MIME_BY_EXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(UPLOAD_EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
  jpeg: 'image/jpeg'
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  return handleUpload(request, params)
}

export async function HEAD(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  return handleUpload(request, params)
}

async function handleUpload(
  request: Request,
  paramsPromise: Promise<{ name: string }>
) {
  const { name } = await paramsPromise
  if (!NAME_RE.test(name)) return jsonError(400, '非法文件名')
  const ext = name.slice(name.lastIndexOf('.') + 1)
  const mediaType = Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : undefined
  if (!mediaType) return jsonError(400, '非法文件类型')
  const abs = join(resolveDataDir(), 'uploads', name)
  const stat = await fs.stat(abs).catch(() => null)
  if (!stat?.isFile()) return jsonError(404, '附件不存在或已被清理')
  const response = mediaResponse(abs, mediaType, stat.size, request.headers.get('range'), request.method)
  response.headers.set('x-content-type-options', 'nosniff')
  if (!mediaType.startsWith('image/') && mediaType !== 'application/pdf') {
    response.headers.set('content-disposition', `attachment; filename="${name}"`)
  }
  return response
}
