/**
 * 删除一条主机清单条目（SSH 主机 / 本机终端）。
 * DELETE /api/ssh/hosts/:id
 *
 * 指向它的跳板引用由领域层一并摘掉（不留悬空跳板）。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { dropHostMonitor } from '@/lib/server/ssh/monitor'
import { tunnelManager } from '@/lib/server/ssh/tunnels'
import { remoteExecService } from '@/lib/server/ssh/exec'
import { sftpService } from '@/lib/server/ssh/sftp'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    // 主机没了，挂它上面的隧道先停掉（配置由领域层一并删；不停会留下没人管得到的孤儿监听）
    tunnelManager.stopByHost(id)
    const next = domain.deleteSshHost(id)
    // 主机没了，它的采集连接也该跟着断（否则会一直连着那台机器直到空闲回收）
    dropHostMonitor(id)
    // 远端工作区用的执行 / SFTP 长连接同理：留着只会连一台已从清单里消失的机器
    remoteExecService.dispose(id)
    sftpService.close(id)
    return Response.json(next)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
