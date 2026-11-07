import { promises as fs } from 'node:fs'
import { resolveInside } from '@fizz/contracts/workspace'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_BODY_BYTES = 2 * 1024 * 1024

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, '文件面板')
  if (denied) return denied
  const url = new URL(request.url)
  const rel = url.searchParams.get('path') ?? ''
  let abs: string
  try {
    abs = resolveInside(workspace.path, rel)
  } catch {
    return jsonError(403, '路径越界')
  }
  const stat = await fs.stat(abs).catch(() => null)
  if (!stat?.isFile()) return jsonError(404, '文件不存在')
  if (stat.size > MAX_READ_BYTES) {
    return jsonError(400, `文件过大（${(stat.size / 1048576).toFixed(1)} MB），暂不支持在编辑器里打开`)
  }
  const buf = await fs.readFile(abs)
  if (buf.includes(0)) return jsonError(400, '这是二进制文件，无法以文本方式打开')
  return Response.json({ path: rel, content: buf.toString('utf8'), size: stat.size })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, '文件面板')
  if (denied) return denied
  const body = await parseJsonBody<{ path?: string; content?: string }>(request)
  if (!body) return jsonError(400, '缺少请求体')
  const rel = body.path ?? ''
  if (!rel || typeof body.content !== 'string') return jsonError(400, '缺少 path 或 content')
  if (body.content.length > MAX_BODY_BYTES) return jsonError(400, '内容过大，拒绝写入')
  let abs: string
  try {
    abs = resolveInside(workspace.path, rel)
  } catch {
    return jsonError(403, '路径越界')
  }
  await fs.writeFile(abs, body.content, 'utf8')
  return new Response(null, { status: 204 })
}
