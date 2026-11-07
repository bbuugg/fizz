/**
 * 源代码管理（git）：提交历史。
 * GET /api/workspaces/:id/git/log?limit=30
 */
import { domain } from '@/lib/server/state'
import { gitExecFor, notRepoMessage, workspaceRepoRoot } from '@/lib/workspace-repo'
import { jsonError } from '@/app/api/_lib/auth'
import { gitLog, type GitLogResult } from '@fizz/git'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const exec = gitExecFor(workspace)
  const root = await workspaceRepoRoot(workspace, exec)
  if (!root) return jsonError(400, notRepoMessage(workspace))

  const url = new URL(request.url)
  const rawLimit = Number(url.searchParams.get('limit') ?? 30)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 30

  // %aI 是作者时间的严格 ISO 8601；自定义 format 里的字段由 @fizz/git 的 parseLogOutput 切。
  // 空仓库（unborn HEAD）上 git log 会失败 —— gitLog 按空列表返回，与旧实现一致
  const commits = await gitLog(root, limit, exec)
  return Response.json({ commits } satisfies GitLogResult)
}

