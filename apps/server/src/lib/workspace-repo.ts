import { localGitExec, repoRoot, samePath, type GitExec } from '@fizz/git'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import type { AgentWorkspace } from '@fizz/contracts/types'
import { createLocalBackend } from '@fizz/tools'
import { createRemoteBackend } from '@/lib/server/ssh/workspace-backend'
import { createRemoteGitExec } from '@/lib/server/ssh/git-exec'

/**
 * 这个工作区**自己的**仓库根；不是仓库（或这台机器没装 git）返回 `null`。
 *
 * 为什么不能直接用 `repoRoot(workspace.path)`：
 *
 * 临时工作区（`scratch`）的目录在数据目录里 —— `<数据目录>/conversations/<会话 id>`，
 * 数据目录默认 `~/.fizz-server`。而用户主目录被 `git init` 过是常见情况（dotfiles 仓库），
 * 于是 `repoRoot()` 会从临时会话目录一路向上找到主目录，把它当成「这个工作区的仓库」：
 *
 * - `git status --untracked-files=all` 开始在**整个主目录**上枚举未跟踪文件
 *   （AppData / Documents / node_modules…），面板永远停在「读取仓库状态…」；
 * - 就算跑完，用户看到的是主目录仓库的分支，还能把会话 JSON 当未跟踪改动提交进去。
 *
 * 数据目录跟用户的仓库毫无关系 —— 这个仓库视角是凭空长出来的。所以判据收紧成：
 * **仓库根就是它自己**，或者它是普通工作区（用户主动登记的项目，本来就可能只是仓库的
 * 一个子目录，那份子目录视角是他自己选的，保留）。
 *
 * 临时会话目录里真的 `git init` 过（root 等于它自己）照常当仓库，面板里那条
 * 「初始化仓库」也仍然可用 —— `git init` 作用在 `workspace.path` 上，与这里无关。
 */
export async function workspaceRepoRoot(
  workspace: Pick<AgentWorkspace, 'path' | 'scratch'>,
  exec: GitExec = localGitExec
): Promise<string | null> {
  const root = await repoRoot(workspace.path, exec)
  if (!root) return null
  if (workspace.scratch === true && !samePath(root, workspace.path)) return null
  return root
}

/**
 * 这个工作区的 git 执行器：远端工作区把命令发到那台 SSH 主机上跑，其余仍走本机
 * （simple-git）。路由层拿到它之后，所有 `git(cwd, args, exec)` 本地 / 远端同一套代码。
 */
export function gitExecFor(workspace: Pick<AgentWorkspace, 'remote'>): GitExec {
  return workspace.remote ? createRemoteGitExec(workspace.remote.hostId) : localGitExec
}

/**
 * 以**仓库根**为边界的文件操作（diff 读未跟踪文件、回滚删未跟踪文件、目录回滚 stat）。
 * 远端走 SFTP，本机走 fs —— 语义与 Agent 工具用的 `WorkspaceBackend` 完全一致。
 */
export function repoBackendFor(
  workspace: Pick<AgentWorkspace, 'remote'>,
  root: string
): WorkspaceBackend {
  return workspace.remote
    ? createRemoteBackend(workspace.remote.hostId, root)
    : createLocalBackend(root)
}

/** 「不是仓库」的提示文案：远端工作区要把「没装 git / 连不上」一并说清，别指向本机 */
export function notRepoMessage(workspace: Pick<AgentWorkspace, 'remote'>): string {
  return workspace.remote
    ? '这个工作区不是 git 仓库（远端主机上也可能没装 git，或当前连不上）'
    : '这个工作区不是 git 仓库（也可能这台机器上没装 git）'
}
