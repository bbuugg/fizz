import { domain } from '@/lib/server/state'
import { workspaceFilesBackend } from '@/lib/workspace-files'
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
  const backend = workspaceFilesBackend(workspace)
  const url = new URL(request.url)
  const rel = url.searchParams.get('path') ?? ''
  let abs: string
  try {
    abs = backend.resolve(rel)
  } catch {
    return jsonError(403, '路径越界')
  }
  const stat = await backend.stat(abs)
  if (!stat || stat.type !== 'file') return jsonError(404, '文件不存在')
  if (stat.size > MAX_READ_BYTES) {
    return jsonError(400, `文件过大（${(stat.size / 1048576).toFixed(1)} MB），暂不支持在编辑器里打开`)
  }
  const buf = await backend.readFile(abs)
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
  const backend = workspaceFilesBackend(workspace)
  const body = await parseJsonBody<{ path?: string; content?: string }>(request)
  if (!body) return jsonError(400, '缺少请求体')
  const rel = body.path ?? ''
  if (!rel || typeof body.content !== 'string') return jsonError(400, '缺少 path 或 content')
  if (body.content.length > MAX_BODY_BYTES) return jsonError(400, '内容过大，拒绝写入')
  let abs: string
  try {
    abs = backend.resolve(rel)
  } catch {
    return jsonError(403, '路径越界')
  }
  try {
    // createParents: false —— 与旧的 fs.writeFile 一致，父目录不存在就报错
    await backend.writeFile(abs, body.content, { createParents: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonError(500, `写入失败：${message}`)
  }
  return new Response(null, { status: 204 })
}
