import type { WorkspaceInput } from '@fizz/contracts/agent-api'
import { validateRemoteWorkspacePath } from '@fizz/contracts/workspace'
import { domain } from '@/lib/server/state'
import { normalizeSftpPath, sftpService } from '@/lib/server/ssh/sftp'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json(domain.listWorkspaces())
}

/**
 * 远端工作区的存在性探测。
 *
 * 必须在 `addWorkspace` **之前**做：目录在远端，领域层不能连网，只能由这一层用 SFTP
 * 问一次。三类结果分开反馈 —— 主机/凭据问题（502 `remote_unreachable`）、路径不存在
 * 或不是目录（400 `remote_path_missing`）、通过（继续登记）。
 */
async function probeRemoteWorkspace(
  hostId: string,
  rawPath: string
): Promise<Response | null> {
  let path: string
  try {
    path = validateRemoteWorkspacePath(rawPath)
  } catch (err) {
    const { message } = describeError(err)
    return jsonError(400, message)
  }

  // 主机不存在 / 是本机终端配置：先给一句人话，别让它表现成「连不上」
  try {
    domain.resolveSshHost(hostId)
  } catch (err) {
    const { message } = describeError(err)
    return jsonError(400, message)
  }

  try {
    const stat = await sftpService.stat(hostId, path)
    if (!stat) {
      return Response.json(
        { error: `远端目录不存在：${path}`, code: 'remote_path_missing' },
        { status: 400 }
      )
    }
    if (stat.type !== 'dir') {
      return Response.json(
        { error: `远端路径不是目录：${path}`, code: 'remote_path_missing' },
        { status: 400 }
      )
    }
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json(
      { error: `连接远端主机失败：${message}`, code: 'remote_unreachable' },
      { status: 502 }
    )
  }
}

export async function POST(request: Request) {
  const input = await parseJsonBody<WorkspaceInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')

  if (input.remote) {
    // 规范化后的路径原样交给领域层（两边同一口径，避免校验与落库解析出两个根）
    const failure = await probeRemoteWorkspace(
      input.remote.hostId,
      input.path
    )
    if (failure) return failure
    input.path = normalizeSftpPath(input.path)
  }

  try {
    return Response.json(await domain.addWorkspace(input))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}