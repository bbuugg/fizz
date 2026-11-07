/**
 * 远端工作区下的派活白名单。
 *
 * ## 防的是什么
 *
 * 子任务的只读白名单里固定含 `git_read`，而远端工作区首期**不建**这个工具
 * （git 视图依赖本地仓库与进程，远端还没接）。如果只在「不建」那一侧动手、
 * 白名单照旧，`filterToolSet` 会抛「includeTools 里有不存在的工具」——
 * 表现为远端工作区一开子任务就整个炸掉，父轮连兜底文案都拿不到。
 *
 * 这里用**真的** `filterToolSet`（不 mock `@fizz/tools`）把两种后端都建一遍：
 * 远端剔掉 `git_read` 后必须正常建出 `agent-*`，本地则保持原样。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AiModelConfig } from '@fizz/contracts/types'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import { buildDelegationTools, makeDelegationStats } from './subagents'

vi.mock('./resolve-model', () => ({ resolveModel: () => ({}) }))

/** 远端后端只需要 `kind` 就能走对分支；工具定义阶段不会真的调用它 */
const remoteBackend = { kind: 'remote', root: '/srv/app' } as WorkspaceBackend

function build(backend?: WorkspaceBackend): Record<string, unknown> {
  return buildDelegationTools(['explorer', 'reviewer'], {
    workspacePath: '/srv/app',
    workspaceName: 'remote',
    model: {} as AiModelConfig,
    ...(backend ? { backend } : {}),
    emit: () => undefined,
    stats: makeDelegationStats()
  })
}

describe('子任务白名单 · 远端工作区', () => {
  it('远端不建 git_read，白名单过滤不抛错', () => {
    const tools = build(remoteBackend)

    expect(Object.keys(tools).sort()).toEqual(['agent-explorer', 'agent-reviewer'])
  })

  it('本地仍建 git_read（白名单保持完整）', () => {
    const tools = build()

    expect(Object.keys(tools).sort()).toEqual(['agent-explorer', 'agent-reviewer'])
  })
})