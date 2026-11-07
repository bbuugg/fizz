/**
 * 在工作区里新建文件夹：POST /api/workspaces/:id/files/mkdir
 * body: `FsWorkspaceMkdirInput`（`parent` 相对工作区根，`name` 单层目录名）→ `{ path }`
 *
 * 不能用 `/api/fs/dirs`（它是服务端**本机**路径选择器的建目录接口）：远端工作区的目录
 * 在另一台机器上，本机拼出来的绝对路径根本不存在。这条与其余 files 路由一样按工作区
 * 定位，本地 / 远端各走自己的 `WorkspaceBackend`。
 *
 * 已存在同名目录返回 409 —— 文件树的「新建文件夹」不该静默复用一个已有目录。
 */
import type { FsWorkspaceMkdirInput } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { reservedSegment, workspaceFilesBackend } from '@/lib/workspace-files'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const backend = workspaceFilesBackend(workspace)

  const body = await parseJsonBody<FsWorkspaceMkdirInput>(request)
  if (!body) return jsonError(400, '缺少请求体')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return jsonError(400, '文件夹名不能为空')
  if (name === '.' || name === '..' || /[/\\]/.test(name)) {
    return jsonError(400, '文件夹名里不能有 / 或 \\')
  }
  const reserved = reservedSegment(name) ?? reservedSegment(body.parent ?? '')
  if (reserved) return jsonError(400, `「${reserved}」是受保护的目录，不能使用`)

  let parentAbs: string
  let targetAbs: string
  try {
    parentAbs = backend.resolve(body.parent ?? '')
    targetAbs = backend.join(parentAbs, name)
  } catch {
    return jsonError(403, '路径越界')
  }
  const parentStat = await backend.stat(parentAbs)
  if (!parentStat || parentStat.type !== 'dir') return jsonError(404, '父目录不存在')
  if ((await backend.stat(targetAbs).catch(() => null)) !== null) {
    return jsonError(409, `已存在同名条目：${name}`)
  }

  try {
    await backend.mkdirp(targetAbs)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonError(500, `新建文件夹失败：${message}`)
  }
  return Response.json({ path: backend.rel(targetAbs) })
}
