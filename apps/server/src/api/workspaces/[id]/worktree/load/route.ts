/**
 * 把 `<项目目录>/.worktree/<标识>` 里**已经存在**的目录登记成一个 worktree 项目。
 * POST /api/workspaces/:id/worktree/load（body: `WorktreeLoadInput`）
 *
 * 与同级的 POST /api/workspaces/:id/worktree 的区别：那个是「新建」（建目录 + 建分支），
 * 这个只是「加载」—— worktree 已经在磁盘上了（手工 `git worktree add` 出来的、
 * 或从别处拷过来的目录），把它补进工作区列表、挂到当前项目下面。
 *
 * 路径不做任何拼接上的自由发挥：只能取 `<项目目录>/.worktree/<标识>`，
 * 也就是 GET 扫描出来的那一批（工作区列表就是权限边界，别让这个接口变成任意目录登记口）。
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorktreeLoadInput } from '@fizz/contracts/agent-api'
import { WORKTREE_IDENTIFIER_RE } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

/** worktree 项目的目录容器（相对源项目目录） */
const WORKTREE_DIR = '.worktree'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, 'worktree')
  if (denied) return denied

  const input = await parseJsonBody<WorktreeLoadInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')

  const identifier = input.identifier?.trim() ?? ''
  if (!WORKTREE_IDENTIFIER_RE.test(identifier)) {
    return jsonError(400, 'worktree 标识只能包含字母、数字、-、_、.，且要以字母或数字开头')
  }

  const worktreePath = join(workspace.path, WORKTREE_DIR, identifier)
  const info = await stat(worktreePath).catch(() => null)
  if (!info?.isDirectory()) {
    return jsonError(404, `目录不存在：${worktreePath}`)
  }

  // 有 `.git` 指针文件才是 linked worktree；普通目录登记成「worktree 项目」只会误导用户
  if (!(await stat(join(worktreePath, '.git')).then(() => true).catch(() => false))) {
    return jsonError(400, `${worktreePath} 不是一个 git worktree（缺少 .git 指针）`)
  }

  try {
    // addWorkspace 按路径去重：目录已经在列表里时不会建重复项（等于一次幂等加载）
    const created = await domain.addWorkspace({
      path: worktreePath,
      name: input.name?.trim() || identifier,
      isWorktree: true,
      parentWorkspaceId: workspace.id
    })
    return Response.json(created)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
