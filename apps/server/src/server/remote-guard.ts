/**
 * 远端工作区「首期不支持」的本地能力统一闸。
 *
 * 文件面板 / Git / 终端历史 / 媒体预览 / scaffold / worktree 这些接口都直接拿
 * `workspace.path` 当**本机路径**去 `fs` / `git`：对远端工作区照跑，轻则报
 * 「目录不存在」，重则在本机同名路径上动文件。UI 会把这些入口藏起来，但接口
 * 不能只靠前端 —— 统一在这里给一句明确的话，而不是静默失败。
 *
 * 不挡的：对话本身（Phase 3 起走远端 backend）、工作区重命名 / 删除、会话读写。
 */
import { isRemoteWorkspace, type AgentWorkspace } from '@fizz/contracts/types'

/** 是远端工作区就返回 400（带 `remote_unsupported`），本地返回 null（调用方继续） */
export function remoteUnsupported(
  workspace: AgentWorkspace,
  feature: string
): Response | null {
  if (!isRemoteWorkspace(workspace)) return null
  return Response.json(
    {
      error: `远端工作区首期不支持${feature}，请通过 SSH 终端或 SFTP 面板操作`,
      code: 'remote_unsupported'
    },
    { status: 400 }
  )
}