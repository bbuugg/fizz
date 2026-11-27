/** 防回归：模式 / 思考档保存失败只能撤回自己的乐观更新，不能覆盖新配置或其他会话。 */
import { describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { AgentApi } from '@fizz/agent-client/api'
import type { AgentStore } from '../agent-store'
import { createServerListsSlice } from './server-lists'

vi.mock('@fizz/agent-kit/shared/lib/state-ws', () => ({
  initStateClient: vi.fn(), subscribe: vi.fn(), getSnapshot: vi.fn(),
}))
vi.mock('@fizz/agent-kit/shared/lib/language', () => ({ persistLanguage: vi.fn() }))

function setup() {
  let finish!: (result: { ok: boolean; error?: string }) => void
  const save = () => new Promise<{ ok: boolean; error?: string }>((done) => { finish = done })
  const api = { setAcpAgentThoughtLevel: vi.fn(save), setAcpAgentMode: vi.fn(save) }
  const thought = { configId: 'vendor-effort', current: 'fast', options: [
    { value: 'fast', name: '快速' }, { value: 'deep', name: '深入' },
  ] }
  const modes = { configId: 'vendor-mode', current: 'build', available: [
    { id: 'build', name: '构建' }, { id: 'plan', name: '规划' },
  ] }
  const initial = {
    getApi: () => api as unknown as AgentApi,
    conversations: [
      { id: 'conv', backend: 'acp', configId: 'agent', modelId: 'model-a', acpThoughtLevel: thought, acpModes: modes },
      { id: 'other', backend: 'acp', configId: 'agent', acpThoughtLevel: thought, acpModes: modes },
    ],
    slices: { conv: { streaming: false } },
  }
  const store = createStore<AgentStore>(() => initial as unknown as AgentStore)
  store.setState(createServerListsSlice(store.setState, store.getState, store))
  store.setState(initial as unknown as Partial<AgentStore>)
  return { store, api, thought, modes, finish: (result: { ok: boolean; error?: string }) => finish(result) }
}

describe('ACP 思考档保存', () => {
  it('失败时恢复已确认档位，其他会话不受影响', async () => {
    const { store, api, thought, finish } = setup()
    const pending = store.getState().setAcpThoughtLevel('agent', 'conv', 'deep')
    expect(api.setAcpAgentThoughtLevel).toHaveBeenCalledWith('agent', 'conv', 'deep')
    expect(store.getState().conversations[0].acpThoughtLevel?.current).toBe('deep')
    finish({ ok: false, error: '保存失败' })
    await pending
    expect(store.getState().conversations[0].acpThoughtLevel).toBe(thought)
    expect(store.getState().conversations[1].acpThoughtLevel).toBe(thought)
  })

  it.each([undefined, { configId: 'new-effort', current: 'max', options: [{ value: 'max', name: '尽力' }] }])(
    '旧请求失败不能复活旧模型的档位：%j', async (nextThought) => {
      const { store, finish } = setup()
      const pending = store.getState().setAcpThoughtLevel('agent', 'conv', 'deep')
      store.setState((s) => ({ conversations: s.conversations.map((c) => c.id === 'conv'
        ? { ...c, modelId: 'model-b', acpThoughtLevel: nextThought } : c) }))
      finish({ ok: false, error: '旧模型已失效' })
      await pending
      expect(store.getState().conversations[0].acpThoughtLevel).toBe(nextThought)
    },
  )

  it('生成期间或同步模型配置期间不能发送思考档变更', async () => {
    const { store, api, thought } = setup()
    for (const patch of [{ streaming: true }, { streaming: false, acpConfigLoading: true }]) {
      store.setState((s) => ({ slices: { ...s.slices, conv: { ...s.slices.conv, ...patch } } }))
      expect((await store.getState().setAcpThoughtLevel('agent', 'conv', 'deep')).ok).toBe(false)
    }
    expect(api.setAcpAgentThoughtLevel).not.toHaveBeenCalled()
    expect(store.getState().conversations[0].acpThoughtLevel).toBe(thought)
  })

  it('拒绝已移除的档位和不匹配的 Agent', async () => {
    const { store, api } = setup()
    expect((await store.getState().setAcpThoughtLevel('agent', 'conv', 'removed')).ok).toBe(false)
    expect((await store.getState().setAcpThoughtLevel('other-agent', 'conv', 'deep')).ok).toBe(false)
    expect(api.setAcpAgentThoughtLevel).not.toHaveBeenCalled()
  })
})

describe('ACP 模式保存', () => {
  it('失败只恢复本会话的已确认模式', async () => {
    const { store, modes, finish } = setup()
    const pending = store.getState().setAcpAgentMode('agent', 'conv', 'plan')
    expect(store.getState().conversations[0].acpModes?.current).toBe('plan')
    finish({ ok: false })
    await pending
    expect(store.getState().conversations[0].acpModes).toBe(modes)
    expect(store.getState().conversations[1].acpModes).toBe(modes)
  })

  it.each([undefined, { current: 'new', available: [{ id: 'new', name: '新模式' }] }])(
    '旧失败不能恢复换模型后已移除或替换的模式：%j', async (nextModes) => {
      const { store, finish } = setup()
      const pending = store.getState().setAcpAgentMode('agent', 'conv', 'plan')
      store.setState((s) => ({ conversations: s.conversations.map((c) => c.id === 'conv'
        ? { ...c, modelId: 'model-b', acpModes: nextModes } : c) }))
      finish({ ok: false })
      await pending
      expect(store.getState().conversations[0].acpModes).toBe(nextModes)
    },
  )

  it('同模型的新配置通知也不能被旧失败覆盖', async () => {
    const { store, modes, finish } = setup()
    const pending = store.getState().setAcpAgentMode('agent', 'conv', 'plan')
    const updated = { ...modes, current: 'plan' }
    store.setState((s) => ({ conversations: s.conversations.map((c) => c.id === 'conv' ? { ...c, acpModes: updated } : c) }))
    finish({ ok: false })
    await pending
    expect(store.getState().conversations[0].acpModes).toBe(updated)
  })

  it('拒绝错误 Agent、无效模式及模型配置刷新中的操作', async () => {
    const { store, api } = setup()
    // 无效调用不应该进入未完成的网络请求。
    api.setAcpAgentMode.mockResolvedValue({ ok: true })
    expect((await store.getState().setAcpAgentMode('other', 'conv', 'plan')).ok).toBe(false)
    expect((await store.getState().setAcpAgentMode('agent', 'conv', 'removed')).ok).toBe(false)
    store.setState((s) => ({ slices: { ...s.slices, conv: { ...s.slices.conv, acpConfigLoading: true } } }))
    expect((await store.getState().setAcpAgentMode('agent', 'conv', 'plan')).ok).toBe(false)
    expect(api.setAcpAgentMode).not.toHaveBeenCalled()
  })
})
