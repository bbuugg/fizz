/**
 * 服务端 SSH 终端会话：一条会话 = 一条 ssh shell 流。
 *
 * 与 `../terminal/pty.ts` 的本机 PTY 会话同形（`write` / `resize` / `kill`），
 * 由 `./ws.ts` 通过 `/api/ssh/terminal` 转发 —— 这样前端终端面板对两种会话
 * 用的是同一套协议，不必分叉。
 *
 * 字符集：
 * - 输出字节始终原样透传，供渲染端先识别 ZMODEM，再按主机字符集解码普通文本；
 * - 键入文本按会话字符集编码后发往远端；ZMODEM 的二进制输入始终原样透传。
 */
import { randomBytes } from 'node:crypto'
import iconv from 'iconv-lite'
import type { Client, ClientChannel } from 'ssh2'
import type { SshConnectProgress } from '@fizz/contracts/agent-api'
import type { SshCharset } from '@fizz/contracts/types'
import type { ResolvedSshHost } from '@fizz/workspace'
import { appLog, startTerminalTranscript, type TerminalTranscript } from '@fizz/workspace'
import { connectWithJumps, type ConnectedChain } from './connect'
import { buildCdLine } from './remote-command'

/** 必须是 256 色终端，否则 htop / lazygit 这类 ncurses 程序会渲染成黑白 */
const TERM_TYPE = 'xterm-256color'

export interface SshTerminalSession {
  id: string
  /**
   * `string` 是键入文本（非 UTF-8 会话按会话字符集编码后发出）；
   * `Uint8Array` 是**二进制直通** —— ZMODEM（rz/sz）的协议帧必须逐字节保真，
   * 绝不能过字符集编码（见下面实现里的注释）。
   */
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface SshTerminalHandlers {
  onData: (data: Buffer) => void
  onExit: (exitCode: number) => void
  /** 建连阶段上报（渲染端据此渲染连接进度浮层，见 `SshConnectProgress`） */
  onProgress: (progress: SshConnectProgress) => void
}

/** 把连接 / 打开 shell 失败的原因写进终端（红色一行），用户一眼能看到 */
function errorLine(message: string): Buffer {
  return Buffer.from(`\r\n\x1b[31m[SSH 连接失败] ${message}\x1b[0m\r\n`, 'utf8')
}

class SshSession implements SshTerminalSession {
  readonly id = `ssh-${randomBytes(8).toString('hex')}`
  /** 当前整条连接链（含跳板）；关闭时经它统一收尾 */
  private chain: ConnectedChain | null = null
  private stream: ClientChannel | null = null
  private killed = false
  /** 目标 PTY 尺寸：shell 流建立前收到的 resize 先缓存，建立后补应用 */
  private desiredCols: number
  private desiredRows: number
  private readonly charset: SshCharset
  private readonly handlers: SshTerminalHandlers
  /** 日志里的主机标识：`名（user@host:port）`，用 `host.id` 反查已删主机会拿不到名字 */
  private readonly hostLabel: string
  /** 日志转录：整场输入输出回填到「打开 SSH 终端」那一条（见 `../terminal/transcript.ts`） */
  private readonly transcript: TerminalTranscript
  /**
   * 输出解码器：远端输出是**按会话字符集**编码的字节，日志要文本 —— 直接用 utf8 解在 gbk
   * 会话下全是乱码。用 iconv 的解码器而不是逐帧 `decode`：它保持跨 chunk 的多字节状态，
   * 不会把一个汉字劈成两半解出半个乱码。
   */
  private readonly decoder: ReturnType<typeof iconv.getDecoder>
  /** 远端工作区目录：shell 就绪后切过去（缺省 = 登录目录） */
  private readonly cwd: string | undefined

  constructor(
    host: ResolvedSshHost,
    options: { cols: number; rows: number; cwd?: string },
    handlers: SshTerminalHandlers
  ) {
    this.desiredCols = Math.max(2, Math.floor(options.cols) || 80)
    this.desiredRows = Math.max(2, Math.floor(options.rows) || 24)
    this.cwd = options.cwd
    this.charset = host.charset ?? 'utf-8'
    this.handlers = handlers
    this.hostLabel = `${host.name ?? host.host}（${host.username}@${host.host}:${host.port || 22}）`
    this.decoder = iconv.getDecoder(this.charset)
    // 会话的生命周期事件 + **整场输入输出**都记进应用日志（`ssh` Tab）：与
    // `terminal/pty.ts` 同一条口径 —— 一次会话一条日志，转录持续回填到它上面。
    this.transcript = startTerminalTranscript(
      'ssh',
      `打开 SSH 终端 ${this.id}`,
      `主机: ${this.hostLabel}`,
      // 会话 id：整场输入输出除了回填日志条目，还落一份 `<dataDir>/logs/terminal/<id>.log`
      this.id
    )
    void this.connect(host)
  }

  private async connect(host: ResolvedSshHost): Promise<void> {
    try {
      const chain = await connectWithJumps(host, {
        // 逐阶段上报给渲染端（resolving → handshake → authenticating，跳板链会带 detail）
        onStage: (stage, detail) => this.handlers.onProgress({ stage, detail })
      })
      if (this.killed) {
        chain.dispose()
        return
      }
      this.chain = chain
      this.openShell(chain.client)
    } catch (err) {
      if (this.killed) return
      this.fail(err instanceof Error ? err.message : String(err))
    }
  }

  /** 在链尾已就绪的连接上打开 shell 流 */
  private openShell(client: Client): void {
    if (this.killed) return
    // 连接已建立，进入最后一步：shell 流（渲染端进度卡片停在「打开 shell」）
    this.handlers.onProgress({ stage: 'opening-shell' })
    client.shell(
      { term: TERM_TYPE, cols: this.desiredCols, rows: this.desiredRows },
      (err, stream) => {
        if (this.killed) return
        if (err || !stream) {
          this.fail(err?.message || '无法打开 shell')
          return
        }
        this.stream = stream
        // shell 就绪：通知渲染端收起连接进度浮层（首帧输出到达也同样会收起）
        this.handlers.onProgress({ stage: 'ready' })
        appLog.info('ssh', `SSH 终端 ${this.id} 已就绪`, `主机: ${this.hostLabel}`)
        // 握手期间收到的 resize 在此补应用，避免远端 PTY 停在创建时的初始尺寸
        this.applySize()
        // 输出始终按原始字节发给渲染端：ZMODEM 必须先检查协议字节，再解码普通文本。
        stream.on('data', (data: Buffer | string) => this.emitOutput(data))
        stream.stderr?.on('data', (data: Buffer | string) => this.emitOutput(data))
        // 远端工作区打开的终端：shell 就绪后切到工作区目录（回显照常进转录）
        if (this.cwd) this.write(buildCdLine(this.cwd))
        stream.on('close', () => {
          if (this.killed) return
          this.killed = true
          this.chain?.dispose()
          this.stream = null
          // 先收尾转录（回填到「打开 SSH 终端」那一条），再单独记一条断开事件
          this.transcript.finish('[SSH 连接已断开]')
          appLog.info('ssh', `SSH 终端 ${this.id} 已断开`, `主机: ${this.hostLabel}`)
          this.handlers.onExit(0)
        })
      }
    )
  }

  /** 连接 / 打开 shell 失败：把原因写进终端后当作退出 */
  private fail(message: string): void {
    this.handlers.onData(errorLine(message))
    this.killed = true
    this.chain?.dispose()
    this.stream = null
    this.transcript.finish(`[连接失败：${message}]`)
    // 记成 error：连不上 / 认证失败 / 打不开 shell 是 SSH 这条链路最需要留档的事，
    // 而且渲染端那行红色提示用户一关标签就没了
    appLog.error('ssh', `SSH 终端 ${this.id} 连接失败`, `主机: ${this.hostLabel}\n${message}`)
    this.handlers.onExit(1)
  }

  private emitOutput(data: Buffer | string): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    this.handlers.onData(buf)
    // 转录：解码成文本再记（渲染端那条路要的是原始字节，见文件头「字符集」）
    this.transcript.output(this.decoder.write(buf))
  }

  write(data: string | Uint8Array): void {
    if (!this.stream) return
    // 键入记进转录（`Uint8Array` 是 ZMODEM 二进制帧，`input()` 内部会跳过）
    this.transcript.input(data)
    try {
      if (typeof data === 'string') {
        this.stream.write(this.charset === 'utf-8' ? data : iconv.encode(data, this.charset))
      } else {
        // 二进制直通：ZMODEM 的协议帧 / 文件块不能经过字符集编码。
        this.stream.write(Buffer.from(data))
      }
    } catch {
      // 流可能刚关闭：静默（马上会收到 exit 帧）
    }
  }

  resize(cols: number, rows: number): void {
    this.desiredCols = Math.max(2, Math.floor(cols) || 80)
    this.desiredRows = Math.max(2, Math.floor(rows) || 24)
    this.applySize()
  }

  /** 应用最新目标尺寸；shell 流尚未建立时先缓存，待建立后补应用 */
  private applySize(): void {
    if (!this.stream) return
    try {
      this.stream.setWindow(this.desiredRows, this.desiredCols, 0, 0)
    } catch {
      // 忽略
    }
  }

  kill(): void {
    this.killed = true
    try {
      this.stream?.close()
    } catch {
      // 已关闭
    }
    this.chain?.dispose()
    // 只有已经连上过（shell 流建立过）才记「已关闭」：建连途中被关掉的不该记成一次正常关会话
    // （这条判据要在把 `stream` 置空**之前**算出来）
    const wasConnected = this.stream !== null
    this.stream = null
    this.chain = null
    if (wasConnected) {
      this.transcript.finish('[会话已关闭]')
      appLog.info('ssh', `SSH 终端 ${this.id} 已关闭`, `主机: ${this.hostLabel}`)
    }
  }
}

/** 起一条 SSH 终端会话（异步建连，失败时把原因写进输出流） */
export function openSshTerminalSession(
  host: ResolvedSshHost,
  options: { cols: number; rows: number },
  handlers: SshTerminalHandlers
): SshTerminalSession {
  return new SshSession(host, options, handlers)
}
