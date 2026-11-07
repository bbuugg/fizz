/**
 * 源代码管理（git）：**一次提交**的元信息 + 文件清单 + unified diff。
 * GET /api/workspaces/:id/git/commit?hash=<rev>
 *
 * 与 `git/log` 的分工：log 给「最近有哪几次提交」，这个给「点开的那一次到底改了什么」。
 * 面板的历史列表原先只有 subject 一行字，想看 diff 只能去敲 `git show`。
 *
 * ⚠️ `hash` 直接拼进 `git show` 的 argv，必须先过 `isSafeRev`：形如
 * `--upload-pack=<cmd>` 的串会被 git 当选项解析（进而执行命令）。判据放在
 * `@fizz/git` 里（白名单形状），这里只负责转成 400。
 */
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { workspaceRepoRoot } from '@/lib/workspace-repo'
import { jsonError } from '@/app/api/_lib/auth'
import { commitShow, isSafeRev, type GitCommitDiffResult } from '@fizz/git'

/** 单次提交 diff 的字符上限（与 `git/diff` 同口径：超长就截断，不让一次点击把内存吃满） */
const MAX_DIFF_CHARS = 400_000

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

  const rev = (new URL(request.url).searchParams.get('hash') ?? '').trim()
  if (!isSafeRev(rev)) return jsonError(400, `提交引用不合法：${rev || '（空）'}`)

  try {
    const result = await commitShow(root, rev)
    // 与 git/diff 一致：超长只截断正文，文件清单照全给（那个便宜，用户还想知道「都动了哪些文件」）
    const body: GitCommitDiffResult =
      result.diff.length > MAX_DIFF_CHARS
        ? { ...result, diff: result.diff.slice(0, MAX_DIFF_CHARS) }
        : result
    return Response.json(body)
  } catch (err) {
    // git 的原话（`fatal: bad revision` / `unknown revision`）比我们自己组织的信息有用
    const text = err instanceof Error ? err.message : String(err)
    return jsonError(400, text || '读取这次提交失败')
  }
}
