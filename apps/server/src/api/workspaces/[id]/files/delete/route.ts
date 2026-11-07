import { promises as fs } from 'node:fs'
import { resolveInside } from '@fizz/contracts/workspace'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { describeError, jsonError } from '@/app/api/_lib/auth'

/**
 * 删工作区里的文件 / 文件夹（文件夹递归删）。
 * DELETE /api/workspaces/:id/files/delete?path=相对路径
 *
 * 三道闸门都是**服务端**把关（前端菜单只是入口，改不了这里的判定）：
 * - 缺 `path` / `path` 为空 = 工作区根目录，删了整个工作区就没了；
 * - 越界路径（`../` / 绝对路径）不给过 —— 这一步交给 `resolveInside`，它抛什么
 *   这里回 403（与 files/read 那条路由同一套语义）；
 * - 保留段（`.git` / `.fizz`）不给碰 —— 前者是仓库生命线，后者是本应用
 *   自己的数据目录（store.json 就在里面，删了等于删库）。文件树本来也不展示它们，
 *   这里是从「万一被直接构造请求打到」的角度兜底。
 */
function guardRelPath(rel: string | null): string | null {
  if (rel === null) return '缺少 path 参数'
  if (!rel) return '不能删除工作区根目录'
  const hit = rel.split('/').filter(Boolean).find((s) => s === '.git' || s === '.fizz')
  return hit ? `「${hit}」是受保护的目录，不能删除` : null
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, '文件面板')
  if (denied) return denied
  const raw = new URL(request.url).searchParams.get('path')
  const reason = guardRelPath(raw)
  if (reason) return jsonError(400, reason)
  let abs: string
  try {
    abs = resolveInside(workspace.path, raw!)
  } catch {
    return jsonError(403, '路径越界')
  }
  try {
    // recursive + force：文件夹连内容一起删；目标本来就不存在也算成功（幂等，
    // 菜单连点两下第二次不该弹错）
    await fs.rm(abs, { recursive: true, force: true })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, `删除失败：${message}`)
  }
  return new Response(null, { status: 204 })
}
