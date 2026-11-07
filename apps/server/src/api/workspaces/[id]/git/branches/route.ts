/**
 * 源代码管理（git）：分支清单（本地 + 远端，检出用）。
 * GET /api/workspaces/:id/git/branches[?prune=1]
 *
 * `prune=1` 时顺带`git fetch --prune --all`，把远端已删的分支从列表里抹掉。
 * **默认不修剪**：这个接口在面板每次可见 / 每次写操作后都会调，远端 fetch 要走网络，
 * 无脑带上会让「点一下就等一下」。修剪只挂在用户手动点刷新时（见 GitPanel 的刷新按钮）。
 */
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { workspaceRepoRoot } from '@/lib/workspace-repo'
import { jsonError } from '@/app/api/_lib/auth'
import { git, pruneRemoteRefs, type GitBranchesResult } from '@fizz/git'

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

  // 只在手动刷新时修剪远端跟踪分支：远端已删的分支不该继续挂在列表里
  // （留着的话用户点删除只会撞上 git 的 "remote ref does not exist"）。
  // 离线 / 没凭据 / 超时都直接跳过，用上一次 fetch 的结果，不影响列表可用性。
  if (new URL(request.url).searchParams.get('prune') === '1') {
    await pruneRemoteRefs(root)
  }

  const [local, remote, current] = await Promise.all([
    git(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']),
    git(root, ['for-each-ref', 'refs/remotes', '--format=%(refname:short)']),
    git(root, ['branch', '--show-current'])
  ])
  const lines = (text: string): string[] =>
    text.split('\n').map((s) => s.trim()).filter(Boolean)
  const result: GitBranchesResult = {
    current: current.stdout.trim() || null,
    branches: lines(local.stdout),
    /*
     * ⚠️ 过滤掉 `refs/remotes/<remote>/HEAD`。
     *
     * 它是符号引用（指向该远端的默认分支），**不是一条可检出的分支**。注意它的
     * `%(refname:short)` 是 **`origin`**（没有 `/HEAD` 后缀）—— 所以按 `endsWith('/HEAD')`
     * 判永远判不到，列表里会多出一条叫 `origin` 的假分支，点它等于检出 `origin/HEAD`
     * （还会进分离头指针）。远端跟踪分支的短名一定带 `<remote>/`，按「有没有 `/`」判最稳。
     */
    remotes: lines(remote.stdout).filter((r) => r.includes('/') && !r.endsWith('/HEAD'))
  }
  return Response.json(result)
}
