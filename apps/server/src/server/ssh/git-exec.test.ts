/**
 * 远端 git 执行器：命令拼装与结果映射（不连真实 SSH）。
 *
 * 这里钉住两件事：
 * 1. 每个参数都经过单引号转义 —— 分支名 / 提交信息 / 路径都可能带引号或空格，
 *    漏一个就等于让它们直接进 shell；
 * 2. `RemoteExecService` 的四种 reason 都要收敛成 `GitRun`，别让超时 / 断线被当成
 *    「git 正常失败」的原话（面板会把 stderr 直接弹给用户，文案得说人话）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))
vi.mock('./exec', () => ({ remoteExecService: { exec: execMock } }))

import { buildGitCommand, createRemoteGitExec } from './git-exec'

describe('buildGitCommand', () => {
  it('带上禁提示 / 关路径转义 / safe.directory，参数逐项单引号转义', () => {
    expect(buildGitCommand(['checkout', "it's a branch"])).toBe(
      "GIT_TERMINAL_PROMPT=0 git -c 'core.quotePath=false' -c 'safe.directory=*' 'checkout' 'it'\\''s a branch'"
    )
  })

  it('safe.directory 的 `*` 在引号里，不会被 shell 展开', () => {
    expect(buildGitCommand(['status'])).toContain("-c 'safe.directory=*'")
  })

  it('参数里的空格 / 分号不会跑出 argv', () => {
    expect(buildGitCommand(['commit', '-m', 'a; rm -rf /'])).toBe(
      "GIT_TERMINAL_PROMPT=0 git -c 'core.quotePath=false' -c 'safe.directory=*' 'commit' '-m' 'a; rm -rf /'"
    )
  })
})

describe('createRemoteGitExec', () => {
  beforeEach(() => execMock.mockReset())

  it('退出码 0 = 成功，cwd / 超时原样透传', async () => {
    execMock.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, reason: 'exit', truncated: false })
    const res = await createRemoteGitExec('h1')('/srv/app', ['status'], { timeoutMs: 1234 })
    expect(res).toEqual({ ok: true, stdout: 'ok', stderr: '' })
    expect(execMock).toHaveBeenCalledWith('h1', buildGitCommand(['status']), {
      cwd: '/srv/app',
      timeoutMs: 1234,
      maxBytes: 16_000_000
    })
  })

  it('非 0 退出码 = 失败，stderr 原样带回', async () => {
    execMock.mockResolvedValue({
      stdout: '',
      stderr: 'fatal: not a git repository',
      exitCode: 128,
      reason: 'exit',
      truncated: false
    })
    const res = await createRemoteGitExec('h1')('/srv/app', ['status'])
    expect(res.ok).toBe(false)
    expect(res.stderr).toContain('not a git repository')
  })

  it('超时 / 断线 / 中止收敛成可读原因', async () => {
    execMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: null, reason: 'timeout', truncated: false })
    await expect(createRemoteGitExec('h1')('/srv/app', ['status'], { timeoutMs: 5000 })).resolves.toEqual({
      ok: false,
      stdout: '',
      stderr: 'git 命令超时（5 秒）'
    })

    execMock.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: null,
      reason: 'error',
      error: 'connect ECONNREFUSED',
      truncated: false
    })
    const broken = await createRemoteGitExec('h1')('/srv/app', ['status'])
    expect(broken.ok).toBe(false)
    expect(broken.stderr).toContain('连不上远端主机')

    execMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: null, reason: 'aborted', truncated: false })
    expect((await createRemoteGitExec('h1')('/srv/app', ['status'])).stderr).toBe('git 命令已中止')
  })
})
