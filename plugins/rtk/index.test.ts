/**
 * rtk 插件的**接线**测试：钩子有没有注册、按工具名匹配对不对、改写结果有没有替换到入参上。
 *
 * 防的回归：2026-11 内置命令工具从 `execute_command` 改名成 `bash`（对齐 dsh 工具集），
 * 而本插件是按**工具名**匹配的 `tool:call` 钩子 —— 名字对不上就原样放行，不报错、不打日志，
 * 用户看到的是「开关打开了，但 `git status` 还是原样跑」。
 *
 * mock `spawnSync`，不启动真实进程，也不依赖 POSIX 脚本或开发机上的 rtk。
 * 每条用例重载插件，隔离模块级缓存与「只警告一次」状态。
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))

type Listener = (toolName: string, input: unknown, next: () => unknown) => unknown

const BIN = 'rtk-test'
const spawn = vi.mocked(spawnSync)
let rtk: typeof import('./index')['default']

function result(status: number | null, stdout: string): SpawnSyncReturns<string> {
  return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status, signal: null }
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('RTK_SUPPRESS_HOOK_WARNING', undefined)
  spawn.mockReset().mockImplementation((_bin, args) => result(0, `rtk ${args?.[1]}`))
  rtk = (await import('./index')).default
})
afterEach(() => vi.unstubAllEnvs())

/** 用最小 ctx 挂载插件，收集它注册的钩子与设置项 */
function mount(config: Record<string, unknown>) {
  const hooks = new Map<string, Listener>()
  const settings: string[] = []
  const ctx = {
    logger: { warn: vi.fn() },
    inject: (_deps: string[], cb: (c: unknown) => unknown) => cb(ctx),
    ui: {
      icon: () => undefined,
      setting: (item: { id: string }) => settings.push(item.id)
    },
    hooks: {
      on: (name: string, listener: Listener) => hooks.set(name, listener)
    }
  }
  rtk.apply(ctx as never, { bin: BIN, ...config } as never)
  return { hooks, settings, warn: ctx.logger.warn }
}

/** 触发一次工具调用钩子（`next()` 返回原始入参，与真实 waterfall 的 around 范式一致） */
function call(hooks: Map<string, Listener>, toolName: string, input: unknown): unknown {
  const listener = hooks.get('tool:call')
  expect(listener, 'tool:call 钩子没注册').toBeTruthy()
  return listener!(toolName, input, () => input)
}

describe('rtk 插件 · 接线', () => {
  it('默认关：连钩子都不注册，只登记设置项', () => {
    const { hooks, settings } = mount({})
    expect(hooks.size).toBe(0)
    expect(settings).toEqual(['enabled', 'terminal', 'bin', 'timeoutMs'])
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([0, 3])('打开后 bash 的命令被改写（退出码 %s）', (status) => {
    spawn.mockReturnValue(result(status, 'rtk git status\n'))
    const { hooks } = mount({ enabled: true })
    expect(call(hooks, 'bash', { command: 'git status', description: '查看状态' })).toEqual({
      command: 'rtk git status',
      description: '查看状态'
    })
    expect(spawn).toHaveBeenCalledWith(BIN, ['rewrite', 'git status'], {
      encoding: 'utf8', timeout: 300, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    })
  })

  it('非 shell 工具原样透传', () => {
    const { hooks } = mount({ enabled: true })
    const input = { file_path: 'a.ts' }
    expect(call(hooks, 'read', input)).toBe(input)
  })

  it('run_in_terminal 受单独开关控制', () => {
    const off = mount({ enabled: true })
    const input = { command: 'git log' }
    expect(call(off.hooks, 'run_in_terminal', input)).toBe(input)

    const on = mount({ enabled: true, terminal: true })
    expect(call(on.hooks, 'run_in_terminal', input)).toEqual({ command: 'rtk git log' })
  })

  it('已经是 rtk 开头的命令不套娃', () => {
    const { hooks } = mount({ enabled: true })
    const input = { command: 'rtk status' }
    expect(call(hooks, 'bash', input)).toBe(input)
  })

  it('命令为空 / 不是字符串时不动', () => {
    const { hooks } = mount({ enabled: true })
    expect(call(hooks, 'bash', { command: '   ' })).toEqual({ command: '   ' })
    expect(call(hooks, 'bash', {})).toEqual({})
  })

  it.each([1, 2, null])('未改写、拒绝或超时保留原输入（退出码 %s）', (status) => {
    spawn.mockReturnValue(result(status, 'rtk git status'))
    const { hooks } = mount({ enabled: true })
    const input = { command: 'git status' }
    expect(call(hooks, 'bash', input)).toBe(input)
  })

  it('可执行文件不可用只警告一次，不缓存失败，恢复后重新改写', () => {
    spawn.mockReturnValueOnce({
      ...result(null, ''), error: Object.assign(new Error('not found'), { code: 'ENOENT' })
    }).mockReturnValueOnce({
      ...result(null, ''), error: Object.assign(new Error('not found'), { code: 'ENOENT' })
    })
    const { hooks, warn } = mount({ enabled: true })
    const input = { command: 'git status' }
    expect(call(hooks, 'bash', input)).toBe(input)
    expect(call(hooks, 'bash', input)).toBe(input)
    expect(warn).toHaveBeenCalledOnce()
    expect(call(hooks, 'bash', input)).toEqual({ command: 'rtk git status' })
    expect(spawn).toHaveBeenCalledTimes(3)
  })
})
