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
 * `/git-commit` 防的是另一件事：提交信息**只由模型生成**，所以命令必须是不带参数的
 * 形状直接就跑（不能被「缺参数」拦下），且提示词里要有「看 status / diff / log」与
 * 「不 push」这些边界。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@fizz/i18n'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import {
  builtinSlashCommands,
  resolveSlashDispatch,
  type SlashCommandContext
} from './slash-commands'

afterEach(() => setLanguage('zh'))

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

  it('界面是英文时，提示词与生成的文档都用英文', async () => {
    setLanguage('en')
    const { ctx, send } = makeContext()
    const init = builtinSlashCommands(ctx).find((c) => c.name === 'init')

    init?.run(ctx, '')
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    const prompt = String(send.mock.calls[0]?.[0] ?? '')
    expect(prompt).toContain('repository root')
    expect(prompt).toContain('Write in English')
    expect(prompt).not.toContain('项目根目录')
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
  it('无参也能跑（不拦「缺参数」），让模型看改动生成提交信息', async () => {
    const { ctx, send } = makeContext()
    const command = builtinSlashCommands(ctx).find((c) => c.name === 'git-commit')
    expect(command).toBeDefined()

    // 分发层不能因为「没参数」把它 reject —— 这条命令本来就不收参数
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

    command?.run(ctx, '')
    await flush()

    expect(send).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledTimes(1)
  })
})
