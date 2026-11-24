/**
 * 防回归：后端选择、探针缓存与 fail-closed。
 *
 * 最危险的回归是「没有后端时悄悄把原始 argv 返回」——那会让用户以为隔离生效了。
 * 这里断言无后端一律抛错；另断言探针只跑一次（每条命令探一次等于每条命令多起一个进程），
 * 以及 argv 是**整体包装**而不是拼字符串。
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'
import {
  createSandbox,
  resolveCommandSandbox,
  resolveWindowsRunner,
  sandboxPolicyForMode,
  SANDBOX_UNAVAILABLE,
  SandboxUnavailableError
} from './index'

const POLICY = { mode: 'workspace-write', workspaceRoot: '/work/space' } as const

describe('createSandbox - Linux', () => {
  it('探针通过时把 argv 整体包进 bwrap，并给出 bwrap 的拒绝方言', async () => {
    const probe = vi.fn(() => true)
    const box = createSandbox({ platform: 'linux', probe })
    const confined = await box.confine(['/bin/bash', '-lc', 'touch ../x'], POLICY)

    expect(confined.argv[0]).toBe('bwrap')
    expect(confined.argv).toContain('--ro-bind')
    // `--` 之后才是调用方的原始 argv，一个字节都不改
    const sep = confined.argv.indexOf('--')
    expect(confined.argv.slice(sep + 1)).toEqual(['/bin/bash', '-lc', 'touch ../x'])
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toEqual(['read-only file system'])
    expect(confined.runnerFailureRules[0]?.fatalSignatures).toEqual(['bwrap: '])
  })

  it('探针不通过时必须抛错，不能返回裸 argv', async () => {
    const box = createSandbox({ platform: 'linux', probe: () => false })
    await expect(box.confine(['/bin/bash', '-lc', 'ls'], POLICY)).rejects.toBeInstanceOf(
      SandboxUnavailableError
    )
    await expect(box.confine(['/bin/bash', '-lc', 'ls'], POLICY)).rejects.toMatchObject({
      code: SANDBOX_UNAVAILABLE
    })
  })

  it('探针在进程内只跑一次', async () => {
    const probe = vi.fn(() => true)
    const box = createSandbox({ platform: 'linux', probe })
    await box.confine(['bash', '-c', 'a'], POLICY)
    await box.confine(['bash', '-c', 'b'], POLICY)
    await box.availability()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('探针命令本身也走只读 profile', async () => {
    const probe = vi.fn((_argv: readonly string[], _timeoutMs: number) => true)
    await createSandbox({ platform: 'linux', probe }).availability()
    const argv = probe.mock.calls[0]?.[0] as string[]
    expect(argv[0]).toBe('bwrap')
    expect(argv).not.toContain('--bind')
    expect(argv.slice(-2)).toEqual(['--', 'true'])
  })
})

describe('createSandbox - macOS', () => {
  it('探针通过时用 sandbox-exec -p <profile> 包装', async () => {
    const box = createSandbox({ platform: 'darwin', probe: () => true })
    const confined = await box.confine(['/bin/bash', '-c', 'ls'], POLICY)
    expect(confined.argv[0]).toBe('sandbox-exec')
    expect(confined.argv[1]).toBe('-p')
    expect(confined.argv[2]).toContain('(deny file-write*)')
    expect(confined.denialSignatures).toEqual(['operation not permitted'])
  })

  it('探针不通过时同样不可用', async () => {
    const box = createSandbox({ platform: 'darwin', probe: () => false })
    await expect(box.confine(['/bin/bash', '-c', 'ls'], POLICY)).rejects.toBeInstanceOf(
      SandboxUnavailableError
    )
  })
})

describe('createSandbox - 未接入的平台', () => {
  it('显式声明没有 runner 时如实报不可用，且不跑探针', async () => {
    const probe = vi.fn(() => true)
    const box = createSandbox({ platform: 'win32', probe, windowsLauncher: [] })
    expect((await box.availability()).available).toBe(false)
    await expect(box.confine(['cmd', '/c', 'dir'], POLICY)).rejects.toMatchObject({
      code: SANDBOX_UNAVAILABLE
    })
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('createSandbox - Windows 受限令牌', () => {
  it('runner 探针通过后按合同包装，并如实报 partial', async () => {
    const box = createSandbox({
      platform: 'win32',
      windowsLauncher: ['C:/app/node.exe', 'C:/app/runner.js'],
      tempRoot: 'C:/temp',
      probe: (argv) => {
        // 探针必须是只读档 + cmd /c exit 0（只读不碰 DACL）
        expect(argv.slice(0, 2)).toEqual(['C:/app/node.exe', 'C:/app/runner.js'])
        expect(argv[argv.indexOf('--mode') + 1]).toBe('read-only')
        expect(argv.slice(-5)).toEqual(['--', 'cmd', '/c', 'exit', '0'])
        return true
      }
    })
    const confined = await box.confine(['bash', '-lc', 'ls'], POLICY)
    expect(confined.argv[0]).toBe('C:/app/node.exe')
    expect(confined.argv).toContain('--workspace')
    expect(confined.argv.slice(-4)).toEqual(['--', 'bash', '-lc', 'ls'])
    // NTFS 硬链接 / 读取不受限，不能承诺 full
    expect(confined.enforcement).toBe('partial')
    expect(confined.runnerFailureRules[0]?.allowedExitCodes).toEqual([127])
    expect(confined.denialSignatures).toContain('access is denied')
  })

  it('runner 需要的环境变量随包装一起带出（Electron 的 ELECTRON_RUN_AS_NODE）', async () => {
    const box = createSandbox({
      platform: 'win32',
      windowsLauncher: ['C:/app/Fizz.exe', 'C:/app/runner.js'],
      windowsLauncherEnv: { ELECTRON_RUN_AS_NODE: '1' },
      tempRoot: 'C:/temp',
      probe: () => true
    })
    const confined = await box.confine(['bash', '-lc', 'ls'], POLICY)
    expect(confined.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('runner 探针失败时不可用（命令不执行）', async () => {
    const box = createSandbox({
      platform: 'win32',
      windowsLauncher: ['C:/app/node.exe', 'C:/app/runner.js'],
      probe: () => false
    })
    await expect(box.confine(['bash', '-lc', 'ls'], POLICY)).rejects.toMatchObject({
      code: SANDBOX_UNAVAILABLE
    })
  })

  it('探针失败时把 runner 的原话带进原因（否则界面只剩一句猜的归因）', async () => {
    const box = createSandbox({
      platform: 'win32',
      windowsLauncher: ['C:/app/node.exe', 'C:/app/runner.js'],
      probe: () => ({ ok: false, detail: '退出码 1：Cannot find package "koffi"' })
    })
    const availability = await box.availability()
    if (availability.available) throw new Error('探针失败不该被当成可用')
    expect(availability.reason).toContain('windows-acl runner 探针失败')
    expect(availability.reason).toContain('Cannot find package "koffi"')
  })
})

describe('resolveWindowsRunner', () => {
  it('环境变量指定的 runner 优先（不依赖构建产物是否就位）', () => {
    // 用仓库里一定存在的文件当替身：这里验的是「解析顺序」，不是产物内容
    const explicit = fileURLToPath(new URL('../../package.json', import.meta.url))
    vi.stubEnv('FIZZ_WIN_SANDBOX_RUNNER', explicit)
    try {
      const runner = resolveWindowsRunner()
      expect(runner?.command[0]).toBe(process.execPath)
      expect(runner?.command[1]?.replaceAll('\\', '/')).toBe(explicit.replaceAll('\\', '/'))
      // 非 Electron 环境不需要 ELECTRON_RUN_AS_NODE
      if (process.versions.electron === undefined) expect(runner?.env).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('环境变量指向不存在的文件时退回内置候选，而不是拿一个死路径去 spawn', () => {
    vi.stubEnv('FIZZ_WIN_SANDBOX_RUNNER', 'C:/definitely/not/here/runner.mjs')
    try {
      const runner = resolveWindowsRunner()
      // 候选里可能也没有产物（没构建），两种情况都允许 —— 但不能返回那个死路径
      expect(runner?.command[1]).not.toBe('C:/definitely/not/here/runner.mjs')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('createSandbox - 取消', () => {
  it('已中止的信号在 spawn 前就拒绝', async () => {
    const box = createSandbox({ platform: 'linux', probe: () => true })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(box.confine(['bash', '-c', 'ls'], POLICY, { signal: ctrl.signal })).rejects.toThrow()
  })
})

describe('resolveCommandSandbox', () => {
  it('开关关着不产生策略（走原来的直跑路径）', () => {
    expect(resolveCommandSandbox('off', { root: '/w' })).toBeUndefined()
    expect(resolveCommandSandbox(undefined, { root: '/w' })).toBeUndefined()
  })

  it('开启时写边界就是工作区根', () => {
    expect(resolveCommandSandbox('workspace-write', { root: '/w' })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/w'
    })
  })

  it('远端工作区同样产出策略（包装由远端后端在远端主机上做）', () => {
    expect(resolveCommandSandbox('workspace-write', { root: '/srv/app' })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/srv/app'
    })
  })
})

describe('sandboxPolicyForMode', () => {
  it('完全访问不产生策略（提权结果就是它）', () => {
    expect(sandboxPolicyForMode('danger-full-access', '/w')).toBeUndefined()
  })

  it('只读档也能表达（未来档位），写边界仍是工作区根', () => {
    expect(sandboxPolicyForMode('read-only', '/w')).toEqual({
      mode: 'read-only',
      workspaceRoot: '/w'
    })
  })
})
