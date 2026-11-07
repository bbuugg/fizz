/**
 * 文件面板（文件树 / 文本读写 / 上传 / 复制移动删除 / 媒体预览）的服务端 backend。
 *
 * 本地工作区走 `createLocalBackend`（fs），远端工作区走 `createRemoteBackend`（SFTP）
 * —— 与 Agent 文件工具完全同一个 `WorkspaceBackend`。路由层只认 backend 的路径语义，
 * 本地 / 远端同一套代码：远端 `resolve` 用 `resolveInsidePosix` 做越界检查，本地仍是
 * `resolveInside`。
 *
 * backend 本身不持有连接（SSH 连接由 sftp / exec 两个 service 池化），每次请求现建一个。
 */
import { promises as fs } from 'node:fs'
import type { AgentWorkspace } from '@fizz/contracts/types'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import { createLocalBackend } from '@fizz/tools'
import { createRemoteBackend } from '@/lib/server/ssh/workspace-backend'
import { shellQuote } from '@/lib/server/ssh/remote-command'

export function workspaceFilesBackend(
  workspace: Pick<AgentWorkspace, 'path' | 'remote'>
): WorkspaceBackend {
  return workspace.remote
    ? createRemoteBackend(workspace.remote.hostId, workspace.path)
    : createLocalBackend(workspace.path)
}

/** `.git` / `.fizz` 不能进也不能出（删除 / 移动 / 复制 / 新建共用同一判据） */
export function reservedSegment(rel: string): string | null {
  const hit = rel.split(/[\\/]/).filter(Boolean).find((s) => s === '.git' || s === '.fizz')
  return hit ?? null
}

/**
 * 工作区内部复制（单个文件或整棵目录）。
 *
 * 远端走 `cp -a`：SFTP 协议没有「递归复制」原语，逐个文件 read + write 在几千个文件的
 * 目录上会慢一个量级；远端 backend 本来就有 shell 通道（搜索 / find 也用它）。
 * `-a` 保留时间戳 / 权限 / 符号链接，`--` 挡住以 `-` 开头的怪文件名。
 *
 * 两条路径都在工作区边界内：`srcAbs` / `dstAbs` 必须已经过 `backend.resolve`。
 */
export async function copyWithinWorkspace(
  backend: WorkspaceBackend,
  srcAbs: string,
  dstAbs: string
): Promise<void> {
  if (backend.kind === 'remote') {
    const res = await backend.exec(`cp -a -- ${shellQuote(srcAbs)} ${shellQuote(dstAbs)}`, {
      timeoutMs: 120_000
    })
    if (res.reason !== 'exit' || res.exitCode !== 0) {
      throw new Error(res.error ?? (res.stderr.trim() || `cp 以退出码 ${res.exitCode} 结束`))
    }
    return
  }
  // recursive 对文件同样适用（直接拷过去）；文件夹则整棵子树复制
  await fs.cp(srcAbs, dstAbs, { recursive: true })
}

