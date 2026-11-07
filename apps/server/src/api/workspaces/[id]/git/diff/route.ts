/**
 * 源代码管理（git）：单文件 diff。
 * GET /api/workspaces/:id/git/diff?path=&staged=1
 */
import { isAbsolute } from 'node:path'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import { domain } from '@/lib/server/state'
import {
  gitExecFor,
  notRepoMessage,
  repoBackendFor,
  workspaceRepoRoot
} from '@/lib/workspace-repo'
import { jsonError } from '@/app/api/_lib/auth'
import { git, type GitDiffResult, type GitExec } from '@fizz/git'

const MAX_DIFF_CHARS = 400_000
const MAX_UNTRACKED_BYTES = 1024 * 1024

function invalidRelPath(p: string): string | null {
  if (!p) return '路径不能为空'
  if (p.startsWith('-')) return `非法路径：${p}`
  if (isAbsolute(p) || /^[A-Za-z]:/.test(p)) return '只能操作仓库内的相对路径'
  if (p.split(/[\\/]/).includes('..')) return '路径不能越出仓库（含 ..）'
  return null
}

async function isTracked(root: string, path: string, exec: GitExec): Promise<boolean> {
  const res = await git(root, ['ls-files', '--error-unmatch', '--', path], exec)
  return res.ok
}

/**
 * 未跟踪文件没有 git diff，这里补一份「空 → 全文」。
 * 读文件走 backend：远端工作区是 SFTP，本机仍是 fs —— 与 Agent 工具同一套路径语义。
 */
async function untrackedDiff(
  root: string,
  path: string,
  backend: WorkspaceBackend
): Promise<string> {
  const abs = backend.join(root, path)
  const stat = await backend.stat(abs).catch(() => null)
  if (!stat || stat.type !== 'file' || stat.size > MAX_UNTRACKED_BYTES) return ''
  const buf = await backend.readFile(abs, { maxBytes: MAX_UNTRACKED_BYTES }).catch(() => null)
  if (!buf || buf.includes(0)) return ''
  const lines = buf.toString('utf8').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const head = [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`
  ].join('\n')
  return `${head}\n${lines.map((l) => `+${l}`).join('\n')}\n`
}

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
  const path = url.searchParams.get('path') ?? ''
  const bad = invalidRelPath(path)
  if (bad) return jsonError(400, bad)
  const staged = url.searchParams.get('staged') === '1'

  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
  if (staged) args.push('--cached')
  args.push('--', path)

  const res = await git(root, args, exec)
  if (!res.ok) return jsonError(500, res.stderr || 'git diff 失败')
  let diff = res.stdout
  if (!diff.trim() && !staged && !(await isTracked(root, path, exec))) {
    diff = await untrackedDiff(root, path, repoBackendFor(workspace, root))
  }
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS)

  const result: GitDiffResult = { path, diff }
  return Response.json(result)
}
