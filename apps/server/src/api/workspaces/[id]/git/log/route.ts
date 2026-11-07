/**
 * 源代码管理（git）：提交历史。
 * GET /api/workspaces/:id/git/log?limit=30
 */
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { workspaceRepoRoot } from '@/lib/workspace-repo'
import { jsonError } from '@/app/api/_lib/auth'
import { gitPanel, type GitLogResult } from '@fizz/git'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, 'Git 面板')
  if (denied) return denied
  const root = await workspaceRepoRoot(workspace)
  if (!root) return jsonError(400, '这个工作区不是 git 仓库（也可能这台机器上没装 git）')

  const url = new URL(request.url)
  const rawLimit = Number(url.searchParams.get('limit') ?? 30)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 30

  // %aI 是作者时间的严格 ISO 8601（等价于旧的 --date=iso-strict + %ad），
  // 自定义 format 让 simple-git 直接按契约字段名解析，不再手工切 \x1f 分隔符
  try {
    const log = await gitPanel(root).log({
      n: limit,
      format: { hash: '%H', short: '%h', author: '%an', date: '%aI', subject: '%s' }
    })
    // simple-git 返回 readonly 列表且行类型带索引签名，按契约字段显式落一遍
    const commits = log.all.map((c) => ({
      hash: c.hash,
      short: c.short,
      author: c.author,
      date: c.date,
      subject: c.subject
    }))
    return Response.json({ commits } satisfies GitLogResult)
  } catch {
    // 空仓库（unborn HEAD）上 git log 会失败 —— 与旧实现一致：回空列表而不是报错
    return Response.json({ commits: [] } satisfies GitLogResult)
  }
}

