/**
 * 防回归：远端 bwrap 探针的缓存语义。
 *
 * 探针是一次完整的 SSH 往返，按命令付这个成本不可接受；但**失败必须能自愈** ——
 * 用户很可能在会话中途去远端装 bubblewrap，死缓存会让「装好了还得重启服务端」。
 * 所以：成功永久缓存，失败 30 秒后重探。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execMock } = vi.hoisted(() => ({ execMock: { exec: vi.fn() } }))
vi.mock('./exec', () => ({ remoteExecService: execMock }))

const { clearRemoteSandboxCache, forgetRemoteSandbox, remoteSandboxAvailability } = await import(
  './sandbox'
)

const OK = { stdout: '', stderr: '', exitCode: 0, reason: 'exit' as const, truncated: false }

beforeEach(() => {
  clearRemoteSandboxCache()
  execMock.exec.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('remoteSandboxAvailability', () => {
  it('探针通过时按主机缓存（不再重复往返）', async () => {
    execMock.exec.mockResolvedValue(OK)
    await expect(remoteSandboxAvailability('h1')).resolves.toEqual({ available: true })
    await expect(remoteSandboxAvailability('h1')).resolves.toEqual({ available: true })
    expect(execMock.exec).toHaveBeenCalledTimes(1)
    // 探针必须是只读 bwrap + true，不绑定工作区
    const [, script] = execMock.exec.mock.calls[0] as [string, string]
    expect(script.startsWith('bwrap ')).toBe(true)
    expect(script.endsWith(`'--' 'true'`)).toBe(true)
  })

  it('失败原因取 stderr 最后一行，并在 30 秒后重探（用户可能刚装好 bwrap）', async () => {
    vi.useFakeTimers()
    execMock.exec.mockResolvedValue({
      stdout: '',
      stderr: 'bwrap: setting up uid map: Permission denied\n',
      exitCode: 1,
      reason: 'exit',
      truncated: false
    })
    await expect(remoteSandboxAvailability('h2')).resolves.toEqual({
      available: false,
      reason: 'bwrap: setting up uid map: Permission denied'
    })
    // 30 秒内复用失败结果
    await remoteSandboxAvailability('h2')
    expect(execMock.exec).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(31_000)
    execMock.exec.mockResolvedValue(OK)
    await expect(remoteSandboxAvailability('h2')).resolves.toEqual({ available: true })
    expect(execMock.exec).toHaveBeenCalledTimes(2)
  })

  it('删除主机后缓存一并丢弃', async () => {
    execMock.exec.mockResolvedValue(OK)
    await remoteSandboxAvailability('h3')
    forgetRemoteSandbox('h3')
    await remoteSandboxAvailability('h3')
    expect(execMock.exec).toHaveBeenCalledTimes(2)
  })

  it('连不上主机时按不可用收场（不抛）', async () => {
    execMock.exec.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: null,
      reason: 'error',
      error: '连接已断开',
      truncated: false
    })
    await expect(remoteSandboxAvailability('h4')).resolves.toEqual({
      available: false,
      reason: '连接已断开'
    })
  })
})
