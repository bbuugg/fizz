/**
 * 防回归：windows-acl runner 的 argv 契约。
 *
 * 这些参数是**跨进程契约**（runner 用 `parseArgs` 严格解析），拼错的表现是
 * 「所有命令都起不来」，拼漏 `--` 的表现更糟 —— 命令被当成 runner 的参数吞掉。
 * 这里按 harness `runner.ts` 的原文断言顺序与分隔符，不做任何「看起来更整齐」的重排。
 */
import { describe, expect, it } from 'vitest'
import {
  WINDOWS_ACL_DENIAL_SIGNATURES,
  WINDOWS_ACL_FAILURE_EXIT,
  WINDOWS_ACL_RUNNER_FAILURE_RULES,
  windowsAclArgv,
  windowsAclProbeArgv
} from './windows'

const LAUNCHER = ['C:/app/node.exe', 'C:/app/runner.js']
const POLICY = { mode: 'workspace-write', workspaceRoot: 'C:/work/space' } as const

describe('windowsAclArgv', () => {
  it('参数名与顺序与 runner 的 parseArgs 一一对应', () => {
    const argv = windowsAclArgv(LAUNCHER, POLICY, 'C:/tmp', ['C:/Program Files/Git/bin/bash.exe', '-lc', 'ls'])
    expect(argv).toEqual([
      ...LAUNCHER,
      '--workspace', 'C:/work/space',
      '--temp', 'C:/tmp',
      '--mode', 'workspace-write',
      '--',
      'C:/Program Files/Git/bin/bash.exe', '-lc', 'ls'
    ])
  })

  it('`--` 之后的 argv 原样保留（含空格与参数里的破折号）', () => {
    const argv = windowsAclArgv(LAUNCHER, POLICY, 'C:/tmp', ['bash', '-lc', 'echo --mode read-only'])
    const sep = argv.indexOf('--')
    expect(argv.slice(sep + 1)).toEqual(['bash', '-lc', 'echo --mode read-only'])
  })

  it('不传 --write-sid / --temp-write-sid（runner 自己管 DACL）', () => {
    const argv = windowsAclArgv(LAUNCHER, POLICY, 'C:/tmp', ['cmd', '/c', 'dir'])
    expect(argv).not.toContain('--write-sid')
    expect(argv).not.toContain('--temp-write-sid')
  })
})

describe('windowsAclProbeArgv', () => {
  it('探针走只读档并跑 cmd /c exit 0', () => {
    const argv = windowsAclProbeArgv(LAUNCHER, 'C:/tmp')
    expect(argv.slice(0, LAUNCHER.length)).toEqual(LAUNCHER)
    expect(argv).toContain('--mode')
    expect(argv[argv.indexOf('--mode') + 1]).toBe('read-only')
    expect(argv.slice(-5)).toEqual(['--', 'cmd', '/c', 'exit', '0'])
  })
})

describe('失败与拒绝的方言', () => {
  it('runner 失败只认 127 + 前缀（普通命令打印同样字不算）', () => {
    expect(WINDOWS_ACL_FAILURE_EXIT).toBe(127)
    const [rule] = WINDOWS_ACL_RUNNER_FAILURE_RULES
    expect(rule?.allowedExitCodes).toEqual([127])
    expect(rule?.fatalSignatures).toEqual(['windows-acl-run: '])
  })

  it('拒绝方言覆盖 cmd / .NET / Node 三种写法', () => {
    expect(WINDOWS_ACL_DENIAL_SIGNATURES).toContain('access is denied')
    expect(WINDOWS_ACL_DENIAL_SIGNATURES).toContain('access to the path')
    expect(WINDOWS_ACL_DENIAL_SIGNATURES).toContain('eperm: operation not permitted')
  })

  it('不收裸的通用串：普通失败不能被误报成沙箱拒绝', () => {
    // `permission denied` / `operation not permitted` 在工作区内的普通失败里到处都是，
    // 照收会让模型以为「越界被挡了」，进而去申请放宽沙箱。
    expect(WINDOWS_ACL_DENIAL_SIGNATURES).not.toContain('permission denied')
    expect(WINDOWS_ACL_DENIAL_SIGNATURES).not.toContain('operation not permitted')
  })
})
