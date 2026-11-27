/** 对话附件统一使用 JSON + base64 上传到内置存储，不支持 URL 或插件上传源。 */
import { normalizeUploadMediaType, UPLOAD_MAX_BYTES, type UploadInput } from '@fizz/contracts/agent-api'
import { jsonError } from '@/app/api/_lib/auth'
import { resolveUploadAdapter } from '@/lib/server/upload/index'
import { documentWarnings, extractDocumentText } from '@/lib/server/upload/documents'

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return jsonError(400, '上传必须使用 JSON + base64 请求体（不支持 multipart）')
  }
  let body: UploadInput
  try {
    body = (await request.json()) as UploadInput
  } catch {
    return jsonError(400, '请求体不是合法 JSON')
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 255 || /[/\\]/.test(name)) return jsonError(400, '非法文件名')
  const mediaType = normalizeUploadMediaType(name, body?.mediaType)
  if (!mediaType) return jsonError(400, '仅支持图片及 PDF、DOCX、TXT、Markdown、CSV、JSON 文档')
  if (typeof body?.dataBase64 !== 'string') return jsonError(400, '文件内容不是合法 base64')
  const data = body.dataBase64.replace(/\s/g, '')
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) {
    return jsonError(400, '文件内容不是合法 base64')
  }
  if (data.length > Math.ceil(UPLOAD_MAX_BYTES / 3) * 4) return jsonError(400, '附件不能超过 10MB')
  const bytes = new Uint8Array(Buffer.from(data, 'base64'))
  if (!bytes.length) return jsonError(400, '附件内容为空')
  if (bytes.length > UPLOAD_MAX_BYTES) return jsonError(400, '附件不能超过 10MB')
  // Buffer 的宽容解码不能把损坏数据当作上传成功；允许缺少末尾 padding。
  if (Buffer.from(bytes).toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) {
    return jsonError(400, '文件内容不是合法 base64')
  }
  if (request.signal.aborted) return new Response(null, { status: 499 })
  let warnings: string[] = []
  try {
    const document = extractDocumentText(mediaType, bytes)
    if (document) warnings = documentWarnings(document)
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : '文档读取失败')
  }
  const adapter = resolveUploadAdapter()
  try {
    const { url } = await adapter.put({ name, mediaType, bytes, signal: request.signal })
    if (request.signal.aborted) {
      await adapter.remove?.(url)
      return new Response(null, { status: 499 })
    }
    return Response.json({ url, name, mediaType, size: bytes.length, ...(warnings.length ? { warnings } : {}) })
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    return jsonError(500, `附件上传失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
