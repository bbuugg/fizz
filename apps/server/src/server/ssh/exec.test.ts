/**
 * 远端命令执行服务（mock ssh2，不连真实主机）。
 *
 * 防的回归：流式输出 / 退出码 / 断线判定 / 截断语义与本地执行不一致；超时与中止
 * 之后进程树收不干净（TERM 后没有 KILL，或 pid 文件被提前删掉）。
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { connectMock, resolveHostMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  resolveHostMock: vi.fn()
}))

vi.mock('./connect', () => ({ connectWithJumps: connectMock }))
vi.mock('../state', () => ({ domain: { resolveSshHost: resolveHostMock } }))

import { remoteExecService } from './exec'

interface Behavior {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  closeWithoutExit?: boolean
  hang?: boolean
  error?: Error
}

class FakeStream extends EventEmitter {
  stderr = new EventEmitter()
  resume = vi.fn()
}

class FakeClient extends EventEmitter {
  private calls = 0
  exec = vi.fn(
    (_script: string, cb: (err: Error | undefined, stream: FakeStream | undefined) => void) => {
      this.calls += 1
      if (this.behavior.error) {
        cb(this.behavior.error, undefined)
        return
      }
      const stream = new FakeStream()
      cb(undefined, stream)
      // 主命令可以「一直不结束」；辅助通道（TERM / KILL / 清理）必须能正常收场
      const isMain = this.calls === 1
      if (isMain && this.behavior.hang) return
      queueMicrotask(() => {
        if (isMain && this.behavior.stdout) stream.emit('data', Buffer.from(this.behavior.stdout))
        if (isMain && this.behavior.stderr) {
          stream.stderr.emit('data', Buffer.from(this.behavior.stderr))
        }
        if (isMain && this.behavior.closeWithoutExit) {
          stream.emit('close')
          return
        }
        if (isMain) stream.emit('exit', this.behavior.exitCode ?? 0)
        stream.emit('close')
      })
    }
  )
  dispose = vi.fn()

  constructor(readonly behavior: Behavior) {
    super()
  }
}

function install(client: FakeClient): void {
  connectMock.mockResolvedValue({ client, dispose: client.dispose })
}

beforeEach(() => {
  vi.resetAllMocks()
  resolveHostMock.mockReturnValue({ username: 'u', host: 'example.com' })
})

afterEach(() => {
  remoteExecService.disposeAll()
  vi.useRealTimers()
})

describe('exec', () => {
  it('已经中止的 signal 立即返回，不建连接', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await remoteExecService.exec('h-aborted', 'ls', { signal: ctrl.signal })
    expect(result).toMatchObject({ reason: 'aborted', stdout: '', exitCode: null })
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('收集 stdout / stderr 与退出码，命令经 pid 文件包装', async () => {
    const client = new FakeClient({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 })
    install(client)
    const result = await remoteExecService.exec('h-ok', 'npm test', { timeoutMs: 1000 })
    expect(result).toMatchObject({
      stdout: 'out\n',
      stderr: 'err\n',
      exitCode: 3,
      reason: 'exit',
      truncated: false
    })
    expect(client.exec.mock.calls[0][0]).toContain('npm test')
    expect(client.exec.mock.calls[0][0]).toContain('setsid sh -c')
    expect(client.exec.mock.calls[0][0]).toContain('/tmp/fizz-exec-')
  })

  it('没有 exit 事件就关闭 = 链路断开，不当成退出码 0', async () => {
    const client = new FakeClient({ closeWithoutExit: true })
    install(client)
    const result = await remoteExecService.exec('h-drop', 'ls', { timeoutMs: 1000 })
    expect(result.reason).toBe('error')
    expect(result.error).toBe('连接已断开')
  })

  it('打开通道失败时把原因带回来', async () => {
    const client = new FakeClient({ error: new Error('boom') })
    install(client)
    const result = await remoteExecService.exec('h-err', 'ls', { timeoutMs: 1000 })
    expect(result).toMatchObject({ reason: 'error', error: 'boom' })
  })

  it('超过 maxBytes 保留最后一段并标记 truncated', async () => {
    // 解码器按行吐出：给带换行的输出，才会在流里被裁剪
    const client = new FakeClient({ stdout: 'aaaa\nbbbb\ncccc\n', exitCode: 0 })
    install(client)
    const result = await remoteExecService.exec('h-trunc', 'ls', {
      timeoutMs: 1000,
      maxBytes: 5
    })
    expect(result.stdout).toBe('cccc\n')
    expect(result.truncated).toBe(true)
  })

  it('超时先 TERM，2 秒后补 KILL 再清 pid 文件', async () => {
    vi.useFakeTimers()
    const client = new FakeClient({ hang: true })
    install(client)
    const pending = remoteExecService.exec('h-timeout', 'sleep 999', { timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toMatchObject({ reason: 'timeout' })

    const commands = () => client.exec.mock.calls.map((call) => String(call[0]))
    expect(commands().some((cmd) => cmd.includes('kill -TERM'))).toBe(true)
    expect(commands().some((cmd) => cmd.includes('kill -KILL'))).toBe(false)

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(0)
    expect(commands().some((cmd) => cmd.includes('kill -KILL'))).toBe(true)
    expect(commands().some((cmd) => cmd.includes('rm -f'))).toBe(true)
  })

  it('运行中中止：立即返回 aborted，并发出 TERM', async () => {
    vi.useFakeTimers()
    const client = new FakeClient({ hang: true })
    install(client)
    const ctrl = new AbortController()
    const pending = remoteExecService.exec('h-abort', 'sleep 999', {
      timeoutMs: 60_000,
      signal: ctrl.signal
    })
    await vi.advanceTimersByTimeAsync(0)
    ctrl.abort()
    await expect(pending).resolves.toMatchObject({ reason: 'aborted' })
    expect(client.exec.mock.calls.some((call) => String(call[0]).includes('kill -TERM'))).toBe(true)
  })
})