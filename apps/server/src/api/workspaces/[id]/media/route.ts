/**
 * 工作区媒体预览（图片 / 视频 / 音频）：GET / HEAD /api/workspaces/:id/media?path=相对路径
 *
 * 本地工作区直接流式读 fs；远端工作区经 SFTP `readRange` **分片**读（每次 ≤ 4MB），
 * 内存峰值与文件大小脱钩。Range 语义两边一致：`206` + `content-range`，视频可以拖动。
 */
import { SFTP_CHUNK_BYTES } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { workspaceFilesBackend } from '@/lib/workspace-files'
import { mediaResponse, mimeOf, parseRangeHeader } from '@/lib/server/lib/media'
import { sftpService } from '@/lib/server/ssh/sftp'
import { jsonError } from '@/app/api/_lib/auth'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleMedia(request, params)
}

export async function HEAD(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleMedia(request, params)
}

async function handleMedia(
  request: Request,
  paramsPromise: Promise<{ id: string }>
) {
  const { id } = await paramsPromise
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const backend = workspaceFilesBackend(workspace)
  const url = new URL(request.url)
  const rel = url.searchParams.get('path') ?? ''
  let abs: string
  try {
    abs = backend.resolve(rel)
  } catch {
    return jsonError(403, '路径越界')
  }
  const stat = await backend.stat(abs).catch(() => null)
  if (!stat || stat.type !== 'file') return jsonError(404, '文件不存在')

  const rangeHeader = request.headers.get('range')
  if (!workspace.remote) {
    return mediaResponse(abs, mimeOf(abs), stat.size, rangeHeader, request.method)
  }
  return remoteMediaResponse(
    workspace.remote.hostId,
    abs,
    mimeOf(abs),
    stat.size,
    rangeHeader,
    request.method
  )
}

/**
 * 远端媒体响应：按 Range（缺省整份）分片拉，`ReadableStream` 的 `pull` 保证**串行**读 ——
 * 同一 SFTP 连接上并发读多段不会更快，只会让内存峰值和请求乱序一起失控。
 */
function remoteMediaResponse(
  hostId: string,
  abs: string,
  mime: string,
  size: number,
  rangeHeader: string | null | undefined,
  method: string
): Response {
  const base = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'content-disposition': 'inline'
  }
  const range = parseRangeHeader(rangeHeader, size)
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = Math.max(0, end - start + 1)
  const headers: Record<string, string> = {
    ...base,
    'content-length': String(length),
    ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
  }
  if (method === 'HEAD') {
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  let offset = start
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const remaining = end - offset + 1
      if (remaining <= 0) {
        controller.close()
        return
      }
      try {
        const chunk = await sftpService.readRange(
          hostId,
          abs,
          offset,
          Math.min(SFTP_CHUNK_BYTES, remaining)
        )
        if (chunk.length === 0) {
          // 文件在预览期间被截短：按读完收场，别让 pull 空转
          controller.close()
          return
        }
        offset += chunk.length
        controller.enqueue(new Uint8Array(chunk))
      } catch (err) {
        controller.error(err)
      }
    }
  })
  return new Response(stream, { status: range ? 206 : 200, headers })
}
