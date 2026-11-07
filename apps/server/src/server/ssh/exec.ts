/**
 * 远端工作区的**命令执行**：按主机池化长连接，一条命令一个 exec 通道。
 *
 * 与 `SftpService` 分开各用一条连接（而不是共用）：SFTP 的 64KB 分片池很成熟，
 * 把 exec 的流塞进同一条通道只会让两边的空闲回收互相牵制；ssh2 一条连接本来就能
 * 多路复用多个 channel，这里池化的是「连接」，不是「通道」。
 *
 * 生命周期：
 * - 每台主机懒建一条 `connectWithJumps` 长连接，空闲 5 分钟关闭；
 * - 删除 SSH 主机时 `dispose(hostId)`，进程退出时 `disposeAll()`；
 * - 命令在执行中被中止 / 超时：按 pid 文件打**进程组**，2 秒后补 `KILL`。
 *
 * 输出与本地 `localExec` 同一套形状：`stdout / stderr / exitCode / reason / truncated`，
 * 缓冲上限内保留**最后** `maxBytes` 字符（与本地截尾一致），不因为输出长就杀进程。
 */
import { randomUUID } from 'node:crypto'
import type { Client, ClientChannel } from 'ssh2'
import type { WorkspaceExecOptions, WorkspaceExecResult } from '@fizz/contracts/workspace'
import { createAnsiStripper, createOutputDecoder } from '@fizz/tools'
import { domain } from '../state'
import { connectWithJumps } from './connect'
import { buildCleanupScript, buildExecScript, buildKillScript, pidFileFor } from './remote-command'

/** 闲置多久回收连接（与 SFTP 池同一量级；太短会让连续命令反复握手） */
const IDLE_MS = 5 * 60 * 1000

/** 单条输出流的默认缓存上限（与本地 backend 的 MAX_CMD_CAPTURE 对齐） */
const MAX_CAPTURE = 4_000_000

/** TERM 之后多久补 KILL */
const KILL_GRACE_MS = 2_000

interface PooledExec {
  hostId: string
  title: string
  client: Client
  dispose: () => void
  idleTimer?: NodeJS.Timeout
}

class RemoteExecService {
  private conns = new Map<string, PooledExec>()
  /** 在建中的连接（并发命令只建一条，避免重复握手） */
  private opening = new Map<string, Promise<PooledExec>>()

  private async acquire(hostId: string): Promise<PooledExec> {
    const existing = this.conns.get(hostId)
    if (existing) {
      this.touch(existing)
      return existing
    }
    const pending = this.opening.get(hostId)
    if (pending) return pending

    const task = this.connect(hostId)
    this.opening.set(hostId, task)
    try {
      const entry = await task
      this.conns.set(hostId, entry)
      return entry
    } finally {
      this.opening.delete(hostId)
    }
  }

  private async connect(hostId: string): Promise<PooledExec> {
    const host = domain.resolveSshHost(hostId)
    const title = `${host.username}@${host.host}`
    const chain = await connectWithJumps(host)
    const entry: PooledExec = {
      hostId,
      title,
      client: chain.client,
      dispose: chain.dispose
    }
    chain.client.on('error', () => this.drop(hostId))
    chain.client.on('close', () => this.drop(hostId))
    this.touch(entry)
    return entry
  }

  private touch(entry: PooledExec): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => this.close(entry.hostId), IDLE_MS)
    entry.idleTimer.unref?.()
  }

  /** 辅助通道：终止 / 清理脚本的输出没人要，drain 掉即可 */
  private runAux(entry: PooledExec, command: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        entry.client.exec(command, (err, stream) => {
          if (err || !stream) {
            done()
            return
          }
          stream.on('error', done)
          stream.on('close', done)
          stream.resume()
        })
      } catch {
        done()
      }
    })
  }

  exec(hostId: string, command: string, opts: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000
    const maxBytes = opts.maxBytes ?? MAX_CAPTURE

    return new Promise<WorkspaceExecResult>((resolve) => {
      if (opts.signal?.aborted) {
        resolve({ stdout: '', stderr: '', exitCode: null, reason: 'aborted', truncated: false })
        return
      }

      void this.acquire(hostId)
        .then((entry) => {
          this.start(entry, command, { timeoutMs, maxBytes }, opts, resolve)
        })
        .catch((err: unknown) => {
          resolve({
            stdout: '',
            stderr: '',
            exitCode: null,
            reason: 'error',
            error: err instanceof Error ? err.message : String(err),
            truncated: false
          })
        })
    })
  }

  private start(
    entry: PooledExec,
    command: string,
    limits: { timeoutMs: number; maxBytes: number },
    opts: WorkspaceExecOptions,
    resolve: (result: WorkspaceExecResult) => void
  ): void {
    const pidFile = pidFileFor(randomUUID().replace(/-/g, ''))
    const script = buildExecScript(command, {
      pidFile,
      ...(opts.cwd ? { cwd: opts.cwd } : {})
    })

    let settled = false
    let stdout = ''
    let stderr = ''
    let truncated = false
    let exitCode: number | null = null
    let exitSeen = false
    let killTimer: NodeJS.Timeout | undefined

    const decodeOut = createOutputDecoder()
    const decodeErr = createOutputDecoder()
    const stripOut = createAnsiStripper()
    const stripErr = createAnsiStripper()

    const finish = (reason: WorkspaceExecResult['reason'], error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      stdout += decodeOut.flush()
      stderr += decodeErr.flush()
      this.touch(entry)
      if (reason === 'timeout' || reason === 'aborted') {
        /**
         * 结果**立即**返回（与本地 abort 一致），但进程还没死透：2 秒后补 `KILL`，
         * 再删 pid 文件。顺序不能反 —— 先删 pid 文件的话 `KILL` 脚本读不到 pid，
         * 整棵进程树就留在远端了。
         */
        killTimer = setTimeout(() => {
          void this.runAux(entry, buildKillScript(pidFile, 'KILL')).then(() =>
            this.runAux(entry, buildCleanupScript(pidFile))
          )
        }, KILL_GRACE_MS)
        killTimer.unref?.()
      } else {
        void this.runAux(entry, buildCleanupScript(pidFile))
      }
      resolve({
        stdout,
        stderr,
        exitCode,
        reason,
        ...(error ? { error } : {}),
        truncated
      })
    }

    const terminate = (reason: 'timeout' | 'aborted'): void => {
      if (settled) return
      void this.runAux(entry, buildKillScript(pidFile, 'TERM'))
      finish(reason)
    }

    const onAbort = (): void => terminate('aborted')
    const timer = setTimeout(() => terminate('timeout'), limits.timeoutMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const append = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (!chunk) return
      if (stream === 'stdout') {
        stdout += chunk
        if (stdout.length > limits.maxBytes) {
          stdout = stdout.slice(-limits.maxBytes)
          truncated = true
        }
      } else {
        stderr += chunk
        if (stderr.length > limits.maxBytes) {
          stderr = stderr.slice(-limits.maxBytes)
          truncated = true
        }
      }
      opts.onOutput?.(stream, stream === 'stdout' ? stripOut(chunk) : stripErr(chunk))
    }

    try {
      entry.client.exec(script, (err, stream: ClientChannel | undefined) => {
        if (err || !stream) {
          finish('error', err?.message ?? '无法打开远端命令通道')
          return
        }
        stream.on('data', (data: Buffer) => append('stdout', decodeOut.decode(data)))
        stream.stderr.on('data', (data: Buffer) => append('stderr', decodeErr.decode(data)))
        stream.on('exit', (code: number | null) => {
          exitSeen = true
          exitCode = typeof code === 'number' ? code : null
        })
        stream.on('error', (streamErr: Error) => {
          if (settled) return
          exitCode = null
          finish('error', streamErr.message)
        })
        stream.on('close', () => {
          if (settled) return
          // 没有 exit 事件就关了 = 链路先断（远端重启 / 网络抖动），不能当成「退出码 0」
          finish(exitSeen ? 'exit' : 'error', exitSeen ? undefined : '连接已断开')
        })
      })
    } catch (err) {
      finish('error', err instanceof Error ? err.message : String(err))
    }
  }

  /** 主动关闭某台主机的执行连接（删除主机 / 收尾走它） */
  dispose(hostId: string): void {
    this.close(hostId)
  }

  disposeAll(): void {
    for (const hostId of [...this.conns.keys()]) this.close(hostId)
  }

  private close(hostId: string): void {
    const entry = this.conns.get(hostId)
    if (!entry) return
    this.conns.delete(hostId)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    try {
      entry.dispose()
    } catch {
      // 可能已在掉线流程里关过
    }
  }

  private drop(hostId: string): void {
    const entry = this.conns.get(hostId)
    if (!entry) return
    this.conns.delete(hostId)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    try {
      entry.dispose()
    } catch {
      // 忽略
    }
  }
}

export const remoteExecService = new RemoteExecService()