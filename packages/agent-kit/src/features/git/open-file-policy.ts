/** Git 行内「打开文件」的路径判据：只返回文件面板可打开的工作区相对路径。 */
import type { GitChange } from '@fizz/git'
import { workspaceRelativePath } from '@fizz/agent-kit/shared/lib/workspace-path'

export function gitChangeOpenPath(
  change: GitChange,
  letter: string,
  workspaceRoot: string,
  repoRoot: string | null | undefined
): string | null {
  if (letter === 'D' || change.worktree === 'D') return null
  if (!workspaceRoot || !repoRoot) return null
  return workspaceRelativePath(`${repoRoot}/${change.path}`, workspaceRoot)
}
