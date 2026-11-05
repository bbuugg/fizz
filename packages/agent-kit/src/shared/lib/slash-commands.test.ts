/**
 * 内置斜线命令的行为。
 *
 * `/init` 必须**让模型读项目后写** AGENTS.md，不是落一份空模板。这条测试在防一次
 * 已经发生过的回归：`/init` 早先走服务端脚手架（`scaffoldFile({kind:'agents'})`），
 * 落下来的是「标题 + 四个空小节」——用户敲完命令，拿到一个还得自己填的骨架，而
 * AGENTS.md 的全部价值就在正文（每轮全文注入的硬约束）。断言分两层：**发了提示词**
 * （`app.send` 被调用、文本点名 AGENTS.md 与项目根目录）、**没碰脚手架**
 * （`scaffoldWorkspaceFile` 一次都没被调）。后者是关键 —— 只测前者的话，将来有人
 * 「顺手」再加一条落模板的调用，测试照样绿。
 *
 * `/git-commit` 防的是另一件事：用户给的提交信息必须**原样**进提示词（模型不许改写），
 * 而没给信息时命令也不能被「缺参数」拦下 —— 它得照常发出去让模型生成。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import {
  builtinSlashCommands,
  resolveSlashDispatch,
  type SlashCommandContext
} from './slash-commands'

/** 造一个只带命令用到的几块的 app：`send` / `setError` / `activeWorkspace` */
function makeContext(hasWorkspace = true): {
  ctx: SlashCommandContext
  send: ReturnType<typeof vi.fn>
  setError: ReturnType<typeof vi.fn>
  scaffold: ReturnType<typeof vi.fn>
} {
  const send = vi.fn(async () => true)
  const setError = vi.fn()
  const scaffold = vi.fn()
  const app = {
    activeWorkspace: hasWorkspace ? { id: 'w1', name: 'demo', path: '/tmp/demo' } : null,
    send,
    setError,
    scaffoldWorkspaceFile: scaffold
  } as unknown as AgentApp
  return { ctx: { app, running: false }, send, setError, scaffold }
}

/** 让 `void runInit(...)` 里的 await 走完 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('/init', () => {
  it('把提示词发给模型，且不落空模板', async () => {
    const { ctx, send, scaffold } = makeContext()
    const init = builtinSlashCommands(ctx).find((c) => c.name === 'init')
    expect(init).toBeDefined()

    init?.run(ctx, '')
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    const prompt = String(send.mock.calls[0]?.[0] ?? '')
    // 落点与「先读再写」这两件事必须在提示词里，否则模型很容易写成项目介绍
    expect(prompt).toContain('AGENTS.md')
    expect(prompt).toContain('项目根目录')
    expect(prompt).toContain('先读，再动笔')
    // 关键：不再走脚手架
    expect(scaffold).not.toHaveBeenCalled()
  })

  it('没有磁盘目录时报错，不发消息', async () => {
    const { ctx, send, setError } = makeContext(false)
    const init = builtinSlashCommands(ctx).find((c) => c.name === 'init')

    init?.run(ctx, '')
    await flush()

    expect(send).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledTimes(1)
  })
})

describe('/git-commit', () => {
  it('用户给了信息：原样进提示词，并要求一字不改', async () => {
    const { ctx, send } = makeContext()
    const command = builtinSlashCommands(ctx).find((c) => c.name === 'git-commit')
    expect(command).toBeDefined()

    command?.run(ctx, 'fix: 修正标题栏高度')
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    const prompt = String(send.mock.calls[0]?.[0] ?? '')
    expect(prompt).toContain('fix: 修正标题栏高度')
    expect(prompt).toContain('原样使用，一字不改')
    expect(prompt).toContain('不要 push')
  })

  it('没给信息：不拦（参数可选），让模型看改动生成', async () => {
    const { ctx, send } = makeContext()
    const command = builtinSlashCommands(ctx).find((c) => c.name === 'git-commit')
    expect(command).toBeDefined()

    // 分发层不能因为「缺参数」把它 reject —— 自动生成正是这条命令的一半用途
    const outcome = resolveSlashDispatch('/git-commit', builtinSlashCommands(ctx))
    expect(outcome.kind).toBe('run')

    command?.run(ctx, '')
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    const prompt = String(send.mock.calls[0]?.[0] ?? '')
    expect(prompt).toContain('git status')
    expect(prompt).toContain('git log')
    expect(prompt).toContain('提交信息由你根据改动生成')
    expect(prompt).toContain('不要 push')
  })

  it('没有磁盘目录时报错，不发消息', async () => {
    const { ctx, send, setError } = makeContext(false)
    const command = builtinSlashCommands(ctx).find((c) => c.name === 'git-commit')

    command?.run(ctx, 'whatever')
    await flush()

    expect(send).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledTimes(1)
  })
})
