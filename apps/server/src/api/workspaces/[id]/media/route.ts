import { resolveInside } from '@fizz/contracts/workspace'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { mediaResponse, mimeOf } from '@/lib/server/lib/media'
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
  const denied = remoteUnsupported(workspace, '媒体预览')
  if (denied) return denied
  const url = new URL(request.url)
  const rel = url.searchParams.get('path') ?? ''
  let abs: string
  try {
    abs = resolveInside(workspace.path, rel)
  } catch {
    return jsonError(403, '路径越界')
  }
  const { promises: fs } = await import('node:fs')
  const stat = await fs.stat(abs).catch(() => null)
  if (!stat?.isFile()) return jsonError(404, '文件不存在')
  return mediaResponse(abs, mimeOf(abs), stat.size, request.headers.get('range'), request.method)
}
