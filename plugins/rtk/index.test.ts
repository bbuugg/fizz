/**
 * rtk 插件的**接线**测试：钩子有没有注册、按工具名匹配对不对、改写结果有没有替换到入参上。
 *
 * 防的回归：2026-11 内置命令工具从 `execute_command` 改名成 `bash`（对齐 dsh 工具集），
 * 而本插件是按**工具名**匹配的 `tool:call` 钩子 —— 名字对不上就原样放行，不报错、不打日志，
 * 用户看到的是「开关打开了，但 `git status` 还是原样跑」。
 *
 * 这里用一个**替身 `rtk` 可执行文件**（`/bin/sh` 脚本）而不是真的 rtk：
 * 单测不该依赖开发机上装没装它、装的是哪个版本。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import rtk from './index'

type Listener = (toolName: string, input: unknown, next: () => unknown) => unknown

const dir = mkdtempSync(join(tmpdir(), 'fizz-rtk-'))
/** 替身 rtk：`rtk rewrite <cmd>` → 打印 `rtk <cmd>`，退出码 0（与真 rtk 的改写口径一致） */
const STUB = join(dir, 'rtk')
writeFileSync(STUB, '#!/bin/sh\nprintf "rtk %s" "$2"\n')
chmodSync(STUB, 0o755)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 用最小 ctx 挂载插件，收集它注册的钩子与设置项 */
function mount(config: Record<string, unknown>) {
  const hooks = new Map<string, Listener>()
  const settings: string[] = []
  const ctx = {
    logger: { warn: () => undefined },
    inject: (_deps: string[], cb: (c: unknown) => unknown) => cb(ctx),
    ui: {
      icon: () => undefined,
      setting: (item: { id: string }) => settings.push(item.id)
    },
    hooks: {
      on: (name: string, listener: Listener) => hooks.set(name, listener)
    }
  }
  rtk.apply(ctx as never, { bin: STUB, ...config } as never)
  return { hooks, settings }
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
  })

  it('打开后 bash 的命令被改写', () => {
    const { hooks } = mount({ enabled: true })
    expect(call(hooks, 'bash', { command: 'git status', description: '查看状态' })).toEqual({
      command: 'rtk git status',
      description: '查看状态'
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
})
