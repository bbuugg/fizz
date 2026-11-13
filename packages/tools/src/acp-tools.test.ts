/**
 * ACP 配置工具组的语义基线。
 *
 * 防的回归：
 * - **审批形同虚设**：配置是全局的（改错会让绑定的会话打不开），所以增 / 改 / 删必须
 *   走 `guardMutation`；`confirm` 档没有审批通道时**按拒绝**处理，不能静默落盘；
 * - **update 把没传的字段清掉**：args 只在显式传入时才带，否则应沿用原值；
 * - **删了不报剩哪些**：模型要能据此告诉用户「还剩哪几条」；
 * - **detect 不看是否已添加**：重复添加会被领域层挡下，模型却以为成功。
 */
import { describe, expect, it, vi } from 'vitest'
import { ACP_TOOLS, buildAcpTools, type AcpAgentSummary, type AcpToolsDeps } from './acp-tools'

function deps(over: Partial<AcpToolsDeps['acp']> = {}, confirm = true): AcpToolsDeps {
  const store: AcpAgentSummary[] = [
    { id: 'a1', name: 'Codex CLI', command: 'codex-acp', args: [] },
    { id: 'a2', name: 'opencode', command: 'opencode', args: ['acp'], type: 'opencode' }
  ]
  return {
    permissionMode: 'confirm',
    requestConfirm: vi.fn(async () => confirm),
    acp: {
      list: () => store,
      save: vi.fn((input) => {
        const saved: AcpAgentSummary = {
          id: input.id ?? 'new-id',
          name: input.name,
          command: input.command,
          args: input.args ?? [],
          ...(input.type ? { type: input.type } : {}),
          ...(input.allowStrategy ? { allowStrategy: input.allowStrategy } : {})
        }
        const index = store.findIndex((a) => a.id === saved.id)
        if (index >= 0) store[index] = saved
        else store.push(saved)
        return saved
      }),
      remove: vi.fn((id: string) => {
        const index = store.findIndex((a) => a.id === id)
        if (index >= 0) store.splice(index, 1)
        return store
      }),
      probeModels: vi.fn(async () => [
        { value: 'claude-sonnet-4', name: 'Sonnet 4' },
        { value: 'claude-opus-4', name: 'Opus 4', description: '最强' }
      ]),
      detect: vi.fn(async () => [
        { name: 'Codex CLI', command: 'codex-acp', args: [], path: '/usr/local/bin/codex-acp' },
        { name: 'Gemini CLI', command: 'gemini', args: ['--acp'], path: '/usr/local/bin/gemini' }
      ]),
      ...over
    }
  }
}

async function run(instance: AcpToolsDeps, name: string, input: unknown): Promise<string> {
  const entry = buildAcpTools(instance)[name] as unknown as {
    execute: (value: unknown, options: unknown) => Promise<unknown>
  }
  return String(await entry.execute(input, { toolCallId: 'call-1' }))
}

describe('工具清单', () => {
  it('ACP_TOOLS 与实际挂载的工具名逐字一致', () => {
    expect(Object.keys(buildAcpTools(deps())).sort()).toEqual([...ACP_TOOLS].sort())
  })
})

describe('list_acp_agents', () => {
  it('空配置给一条可执行的下一步', async () => {
    const out = await run(deps({ list: () => [] }), 'list_acp_agents', {})
    expect(out).toContain('detect_acp_agents')
  })

  it('有配置时给 id / 命令 / 参数', async () => {
    const out = await run(deps(), 'list_acp_agents', {})
    expect(out).toContain('"id": "a2"')
    expect(out).toContain('"acp"')
  })
})

describe('detect_acp_agents', () => {
  it('标明哪几条已经添加过', async () => {
    const out = await run(deps(), 'detect_acp_agents', {})
    const parsed = JSON.parse(out) as Array<{ command: string; alreadyAdded: boolean }>
    expect(parsed.find((a) => a.command === 'codex-acp')?.alreadyAdded).toBe(true)
    expect(parsed.find((a) => a.command === 'gemini')?.alreadyAdded).toBe(false)
  })
})

describe('probe_acp_models', () => {
  it('列出候选模型，失败时把原因带回而不是抛错', async () => {
    const instance = deps()
    const out = await run(instance, 'probe_acp_models', { id: 'a1' })
    expect(out).toContain('claude-sonnet-4')
    expect(out).toContain('Sonnet 4')
    expect(instance.acp.probeModels).toHaveBeenCalledWith('a1')
  })

  it('未知 id 不探测', async () => {
    const instance = deps()
    const out = await run(instance, 'probe_acp_models', { id: 'nope' })
    expect(out).toContain('没有 id 为 nope')
    expect(instance.acp.probeModels).not.toHaveBeenCalled()
  })
})

describe('create_acp_agent', () => {
  it('没有审批通道时不落盘（fail-closed）', async () => {
    const instance = deps({}, true)
    delete instance.requestConfirm
    const out = await run(instance, 'create_acp_agent', { name: 'X', command: 'x-acp' })
    expect(out).toContain('需要用户确认')
    expect(instance.acp.save).not.toHaveBeenCalled()
  })

  it('用户拒绝时不落盘', async () => {
    const instance = deps({}, false)
    const out = await run(instance, 'create_acp_agent', { name: 'X', command: 'x-acp' })
    expect(out).toContain('用户拒绝')
    expect(instance.acp.save).not.toHaveBeenCalled()
  })

  it('批准后按入参保存，并把「配好 ≠ 用上」说清楚', async () => {
    const instance = deps()
    const out = await run(instance, 'create_acp_agent', {
      name: ' Gemini ',
      command: ' gemini ',
      args: ['--acp'],
      type: 'generic'
    })
    expect(instance.acp.save).toHaveBeenCalledWith({
      name: 'Gemini',
      command: 'gemini',
      args: ['--acp'],
      type: 'generic'
    })
    expect(out).toContain('外部 Agent')
    expect(out).toContain('新建会话')
  })

  it('缺命令时直接回绝，不弹审批', async () => {
    const instance = deps()
    const out = await run(instance, 'create_acp_agent', { name: 'X', command: '  ' })
    expect(out).toContain('需要 command')
    expect(instance.requestConfirm).not.toHaveBeenCalled()
  })
})

describe('update_acp_agent', () => {
  it('不存在的 id 报「现有哪几个」而不是抛错', async () => {
    const out = await run(deps(), 'update_acp_agent', { id: 'nope', name: 'X' })
    expect(out).toContain('没有 id 为 nope')
    expect(out).toContain('a1')
  })

  it('models 整份替换（传 [] 也照样带下去，清空下拉）', async () => {
    const instance = deps()
    await run(instance, 'update_acp_agent', { id: 'a2', models: [] })
    expect(instance.acp.save).toHaveBeenCalledWith({
      id: 'a2',
      name: 'opencode',
      command: 'opencode',
      models: []
    })
  })

  it('只传名字时 args 沿用原值（不会被清空）', async () => {
    const instance = deps()
    await run(instance, 'update_acp_agent', { id: 'a2', name: 'opencode2' })
    expect(instance.acp.save).toHaveBeenCalledWith({
      id: 'a2',
      name: 'opencode2',
      command: 'opencode'
      // args 不带 → 领域层沿用旧值
    })
  })
})

describe('delete_acp_agent', () => {
  it('删除后回报剩下的条目', async () => {
    const instance = deps()
    const out = await run(instance, 'delete_acp_agent', { id: 'a1' })
    const parsed = JSON.parse(out) as { remaining: Array<{ id: string }> }
    expect(parsed.remaining.map((a) => a.id)).toEqual(['a2'])
    expect(instance.acp.remove).toHaveBeenCalledWith('a1')
  })
})
