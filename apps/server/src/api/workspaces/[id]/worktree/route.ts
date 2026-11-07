/**
 * 某个项目下的 worktree:
 * - POST:**新建**一个 git worktree(建目录 + 建分支)并登记成新项目 ——
 *   校验与落库在 `lib/server/projects.ts` 的 `createWorktree`,与 AI 工具 `create_worktree` 共用;
 * - GET:扫描 `<项目目录>/.worktree/` 下**磁盘上既有**的 worktree,给「管理工作区」弹窗列清单。
 *
 * 这是给人在浏览器里开一个独立工作树的普通项目,与容器型项目(系统分配的目录)无关。
 */
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { WorktreeInput, WorktreeScanEntry } from '@fizz/contracts/agent-api'
import { listWorktrees, resolveRepoRoot } from '@fizz/git'
import { createWorktree, projectError } from '@/lib/server/projects'
import { WORKTREE_DIR } from '@/lib/server/projects-pure'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const input = await parseJsonBody<WorktreeInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')

  try {
    return Response.json(await createWorktree(id, input))
  } catch (err) {
    const e = projectError(err)
    return jsonError(e.status, e.message)
  }
}

/**
 * 扫描 `<项目>/.worktree/` 下的既有目录(「管理工作区」弹窗的数据源)。
 *
 * 只看**单层子目录**、跳过隐藏目录:`<项目>/.worktree/<标识>` 就是本项目的 worktree 约定
 * (见 POST 的落点),别处的手工目录不猜。
 *
 * 分支名用**一次** `git worktree list` 全量拿回来再按路径索引:worktree 一多,
 * 逐条 spawn git 就是 N 次进程启动,弹窗打开会明显卡一下。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, 'worktree')
  if (denied) return denied

  const baseDir = join(workspace.path, WORKTREE_DIR)
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => null)
  // 目录还不存在 = 这个项目还没建过 worktree:空清单,不是错误
  if (!entries) return Response.json([])

  const repoPath = await resolveRepoRoot(workspace.path).catch(() => null)
  const branchByPath = new Map<string, string | null>()
  if (repoPath) {
    for (const worktree of await listWorktrees(repoPath)) {
      branchByPath.set(pathKey(worktree.path), worktree.branch)
    }
  }

  // 已登记的工作区(按路径索引):扫到的目录命中它就是「已加载」,弹窗里置灰不可选
  const registered = new Map(domain.listWorkspaces().map((w) => [pathKey(w.path), w]))

  const out: WorktreeScanEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const worktreePath = join(baseDir, entry.name)
    const known = registered.get(pathKey(worktreePath))
    const isWorktree = await stat(join(worktreePath, '.git')).then(() => true).catch(() => false)
    out.push({
      identifier: entry.name,
      path: worktreePath,
      branch: branchByPath.get(pathKey(worktreePath)) ?? null,
      isWorktree,
      ...(known ? { workspaceId: known.id } : {})
    })
  }
  // 按标识排序:界面顺序稳定,不受文件系统返回顺序影响
  out.sort((a, b) => a.identifier.localeCompare(b.identifier))
  return Response.json(out)
}

/** 路径比对用的归一化 key:Windows 大小写不敏感,git 输出的分隔符也未必与 path 一致 */
function pathKey(p: string): string {
  const resolved = resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
