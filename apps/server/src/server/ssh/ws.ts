/**
 * SSH 终端 WebSocket 端点：`/api/ssh/terminal?hostId=...&cols=&rows=`。
 *
 * 与 `/api/terminal`（本机 PTY）**协议逐条相同**（分发 / 心跳 / 清场共用
 * `../terminal/channel.ts` 那一份），区别只在「会话怎么建」：
 * 这里用 `?hostId=` 指定服务端存的一台 SSH 主机，凭据由服务端解密后连接，**不回传渲染端**。
 *
 * ⚠️ 同 `../terminal/ws.ts`：不自己挂 `server.on('upgrade')`，统一由 `../ws.ts` 分流。
 *
 * 鉴权：`?token=` 查询参数 + timingSafeEqual（浏览器 `WebSocket` 带不了自定义请求头）。
 */
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { domain } from '../state'
import { handleTerminalChannel, type TerminalChannelSession } from '../terminal/channel'
import { parseTerminalCwd } from './remote-command'
import { openSshTerminalSession } from './session'

export function handleSshTerminalUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  auth = true
): void {
  const hostId = url.searchParams.get('hostId') ?? ''
  const cols = Number(url.searchParams.get('cols') ?? 80)
  const rows = Number(url.searchParams.get('rows') ?? 24)
  // 远端工作区打开终端时带上的目录：shell 就绪后切过去，缺省停在登录目录
  const cwd = parseTerminalCwd(url.searchParams.get('cwd'))

  handleTerminalChannel({
    req,
    socket,
    head,
    url,
    auth,
    logScope: 'ssh',
    failureTitle: 'SSH 终端启动失败',
    // 主机不存在 / 凭据解密失败时，日志里得先说清是哪台主机
    failureContext: () => `主机 id: ${hostId || '(未传)'}`,
    create: (sink): TerminalChannelSession => {
      if (!hostId) throw new Error('缺少 hostId')
      // 凭据在这里解密（明文只在服务端内存里流转，绝不出网）
      const host = domain.resolveSshHost(hostId)
      return openSshTerminalSession(
        host,
        {
          cols: Number.isFinite(cols) ? cols : 80,
          rows: Number.isFinite(rows) ? rows : 24,
          ...(cwd ? { cwd } : {})
        },
        // 输出 / 退出 / 建连进度怎么下发到 WS 上，已经由通道接好（见 channel.ts 的 sink）
        sink
      )
    }
  })
}
