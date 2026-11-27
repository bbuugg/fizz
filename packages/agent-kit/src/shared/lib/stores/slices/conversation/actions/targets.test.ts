/**
 * 回归：**分屏两个标签时，模型 pill 不能同步成同一个**。
 *
 * ## 防的是什么
 *
 * 用户报的现象：主区域开两个对话标签、并排分离（分屏），各自用不同模型；点第一个
 * 标签，两个标签的模型 pill 都变成第一个的；点第二个，又都变成第二个的。
 *
 * 根因：`chatTarget` / `reasoningEffort` / `mcpServerIds` / `browserSettings` 当时是
 * store 上的**一份全局状态**，语义是「焦点会话的现场」，`openConversation` 每开一个会话
 * 就按那个会话重写一遍。单标签时「焦点即视图」没问题，分屏时两个标签同时可见，非焦点
 * 那个的 composer 读的也是这份 —— 于是跟着焦点标签一起变。
 *
 * ## 现在的口径（本文件钉住）
 *
 * 会话的现场**只有一份真源**：会话清单里那条（`persist*` 先乐观改清单项再发请求）。
 * 全局只剩草稿页那一份 `draftSettings`，它跟任何会话都无关。
 *
 * 1. `scopedSettingsOf(会话)` 一律从**清单项**派生 —— 焦点标签也不例外；`null` 才读草稿；
 * 2. 清单里还没有那条会话（刚建好、清单没刷到）时退回草稿：那份选择正是建它用的；
 * 3. `setChatTarget(target, 会话)` 只改那条会话，既不碰草稿也不碰别的会话；
 * 4. `setChatTarget(target, null)` 只改草稿，一个会话都不碰；
 * 5. 不传 scope 的旧调用行为不变（作用于焦点会话）。
 * 6. ACP 的 MCP 选择同样写草稿 / 会话并持久化，不能因后端类型被丢弃。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationSlice } from '../index'
import type { ConversationTargetInput, ConversationTargetResult } from '@fizz/contracts/agent-api'
import type { AcpProbeResult } from '@fizz/acp'

const FOCUS = 'conv-a'
const OTHER = 'conv-b'
const DRAFT_TARGET = {
  backend: 'builtin',
  configId: 'cfg-c',
  modelId: 'model-c'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const effort = (values: string[], current = values[0]) => ({
  configId: 'effort', current, options: values.map((value) => ({ value, name: value }))
})
const capability = (values: string[]): AcpProbeResult => ({
  models: { configId: null, options: [], current: null }, modes: null,
  thoughtLevel: values.length ? effort(values) : null, authMethods: [],
})

/** 两条会话 + 一份不同的草稿：三者各不相同，断言才有意义 */
function makeStore() {
  const api = {
    setConversationTarget: vi.fn<(id: string, target: ConversationTargetInput) => Promise<ConversationTargetResult | null>>(async () => null),
    probeAcpCapabilities: vi.fn<(agentId: string, modelId?: string) => Promise<AcpProbeResult>>(),
  }
  const conversations = [
    {
      id: FOCUS,
      backend: 'builtin',
      configId: 'cfg-a',
      modelId: 'model-a',
      workspaceId: 'ws-1',
      title: 'A',
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: OTHER,
      backend: 'builtin',
      configId: 'cfg-b',
      modelId: 'model-b',
      workspaceId: 'ws-1',
      title: 'B',
      createdAt: 2,
      updatedAt: 2
    }
  ]
  const models = [
    { id: 'cfg-a', name: 'A', models: [{ id: 'model-a', name: 'model-a' }] },
    { id: 'cfg-b', name: 'B', models: [{ id: 'model-b', name: 'model-b' }] },
    { id: 'cfg-c', name: 'C', models: [{ id: 'model-c', name: 'model-c' }] }
  ]
  const boot = {
    conversations,
    conversationsLoaded: true,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    runningConversations: {},
    models,
    acpAgents: [],
    // 草稿页（「开始新对话」）那份待定选择：与两条会话都不同
    draftSettings: {
      chatTarget: DRAFT_TARGET,
      reasoningEffort: null,
      mcpServerIds: [],
      browserSettings: null
    },
    slices: {},
    getApi: () => api,
    setBusy: () => undefined,
    setError: () => undefined
  }
  const state: Record<string, unknown> = {
    ...boot,
    activeConversationId: null
  }
  const set = (partial: unknown): void => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: unknown) => object)(state)
        : partial
    Object.assign(state, patch as object)
  }
  const get = (): unknown => state
  const slice = (
    createConversationSlice as unknown as (
      set: unknown,
      get: unknown,
      api: unknown
    ) => Record<string, unknown>
  )(set, get, {})
  Object.assign(state, slice)
  // slice 初始化会写回 `activeConversationId: null` 等默认值：摆成「焦点在 A」的那一刻
  Object.assign(state, boot, { activeConversationId: FOCUS })

  const conversationOf = (id: string): Record<string, unknown> =>
    (state.conversations as Record<string, unknown>[]).find(
      (c) => c.id === id
    ) as Record<string, unknown>

  const scopedOf = slice.scopedSettingsOf as (id: string | null) => {
    chatTarget: unknown
    mcpServerIds: string[]
  }

  return { state, api, slice, conversationOf, scopedOf }
}

describe('scopedSettingsOf：按会话取现场', () => {
  it('焦点会话也从清单项派生，不是「store 里那份」', () => {
    const { scopedOf } = makeStore()

    expect(scopedOf(FOCUS).chatTarget).toEqual({
      backend: 'builtin',
      configId: 'cfg-a',
      modelId: 'model-a'
    })
    expect(scopedOf(OTHER).chatTarget).toEqual({
      backend: 'builtin',
      configId: 'cfg-b',
      modelId: 'model-b'
    })
  })

  it('只有新对话页（null）才读草稿那份', () => {
    const { scopedOf } = makeStore()

    expect(scopedOf(null).chatTarget).toEqual(DRAFT_TARGET)
    // 会话读的永远不是草稿：以前两处共用一份，分屏时就是它俩互相污染
    expect(scopedOf(FOCUS).chatTarget).not.toEqual(DRAFT_TARGET)
  })

  it('清单里还没有这条会话时退回草稿（刚建好、清单没刷到）', () => {
    const { scopedOf } = makeStore()

    // 退回草稿而不是 null：那份选择正是建它用的，第一轮不能变成「请先选择模型」
    expect(scopedOf('conv-just-created').chatTarget).toEqual(DRAFT_TARGET)
  })
})

describe('setChatTarget：作用域', () => {
  it('在某个会话上选模型：只写那条会话，草稿与别的会话都不动', () => {
    const { state, api, slice, conversationOf } = makeStore()
    const setChatTarget = slice.setChatTarget as (
      target: { backend: string; configId: string; modelId: string },
      scope?: string | null
    ) => void

    // 模拟「在 B 标签的下拉里从 model-b 换成 model-c」
    setChatTarget({ ...DRAFT_TARGET }, OTHER)

    // B 自己那条被改（乐观写本地清单，pill 立刻生效；同时落盘）
    expect(conversationOf(OTHER).modelId).toBe('model-c')
    expect(api.setConversationTarget).toHaveBeenCalledWith(
      OTHER,
      expect.objectContaining({ configId: 'cfg-c', modelId: 'model-c' })
    )
    // 焦点会话 A 的清单项不能被顺手改掉
    expect(conversationOf(FOCUS).modelId).toBe('model-a')
    // 草稿那份也不能被改（以前「焦点会话仍同步全局那份」就是从这里串的）
    expect(
      (state.draftSettings as { chatTarget: unknown }).chatTarget
    ).toEqual(DRAFT_TARGET)
  })

  it('在新对话页选模型：只写草稿，一个会话都不碰', () => {
    const { state, api, slice, conversationOf } = makeStore()
    const setChatTarget = slice.setChatTarget as (
      target: { backend: string; configId: string; modelId: string },
      scope?: string | null
    ) => void

    setChatTarget({ backend: 'builtin', configId: 'cfg-a', modelId: 'model-a' }, null)

    expect(
      (state.draftSettings as { chatTarget: unknown }).chatTarget
    ).toEqual({ backend: 'builtin', configId: 'cfg-a', modelId: 'model-a' })
    expect(conversationOf(FOCUS).modelId).toBe('model-a')
    expect(conversationOf(OTHER).modelId).toBe('model-b')
    expect(api.setConversationTarget).not.toHaveBeenCalled()
  })

  it('不传 scope 时行为不变：作用于焦点会话', () => {
    const { api, slice, conversationOf } = makeStore()
    const setChatTarget = slice.setChatTarget as (target: {
      backend: string
      configId: string
      modelId: string
    }) => void

    setChatTarget({ ...DRAFT_TARGET })

    expect(conversationOf(FOCUS).modelId).toBe('model-c')
    expect(api.setConversationTarget).toHaveBeenCalledWith(
      FOCUS,
      expect.objectContaining({ configId: 'cfg-c', modelId: 'model-c' })
    )
  })
})

// 防回归：模型卡只能用当前模型的档位，迟到响应不能串会话、串模型或复活已删除的能力。
describe('ACP 模型卡配置同步', () => {
  it.each([{ loading: true, error: null }, { loading: false, error: '读取失败' }, { loading: false, error: null }])(
    '模式草稿拒绝未就绪配置或无效候选：%j', ({ loading, error }) => {
      const { state, slice } = makeStore()
      const draft = { agentId: 'agent', modelId: 'model', loading, error,
        modes: { current: 'vendor:build', available: [{ id: 'vendor:build', name: '构建' }, { id: 'vendor:plan', name: '规划' }] },
        mode: 'vendor:build', thoughtLevel: null, thought: null }
      state.draftAcp = draft
      const select = slice.setDraftAcpMode as (value: string | null) => void
      select(loading || error ? 'vendor:plan' : 'invented')
      expect(state.draftAcp).toBe(draft)
    },
  )

  it('模式草稿保留原始值，允许清除选择；不触碰任何已有会话', () => {
    const { state, slice, api, conversationOf } = makeStore()
    state.draftAcp = { agentId: 'agent', modelId: 'model', loading: false, error: null,
      modes: { current: 'vendor:build', available: [{ id: 'vendor:build', name: '构建' }] },
      mode: null, thoughtLevel: null, thought: null }
    const select = slice.setDraftAcpMode as (value: string | null) => void
    select('vendor:build')
    expect(state.draftAcp).toHaveProperty('mode', 'vendor:build')
    select(null)
    expect(state.draftAcp).toHaveProperty('mode', null)
    expect(api.setConversationTarget).not.toHaveBeenCalled()
    expect(conversationOf(FOCUS).modelId).toBe('model-a')
    expect(conversationOf(OTHER).modelId).toBe('model-b')
  })

  it('已有会话立即使用 target 回传的新档位，明确 null 会清掉旧档', async () => {
    const { state, api, slice, conversationOf } = makeStore()
    const change = slice.setChatTarget as (target: { backend: 'acp'; configId: string; modelId: string }, scope: string) => void
    Object.assign(conversationOf(OTHER), { backend: 'acp', configId: 'agent', acpThoughtLevel: effort(['low', 'high'], 'high') })
    const first = deferred<ConversationTargetResult>()
    api.setConversationTarget.mockReturnValueOnce(first.promise)
    change({ backend: 'acp', configId: 'agent', modelId: 'new-model' }, OTHER)
    expect((state.slices as Record<string, { acpConfigLoading: boolean }>)[OTHER].acpConfigLoading).toBe(true)
    first.resolve({ acpSessionState: { modes: null, thoughtLevel: effort(['medium', 'max']) } })
    await vi.waitFor(() => expect(conversationOf(OTHER).acpThoughtLevel).toEqual(effort(['medium', 'max'])))
    api.setConversationTarget.mockResolvedValueOnce({ acpSessionState: { modes: null, thoughtLevel: null } })
    change({ backend: 'acp', configId: 'agent', modelId: 'plain' }, OTHER)
    await vi.waitFor(() => expect(conversationOf(OTHER).acpThoughtLevel).toBeUndefined())
    expect(api.probeAcpCapabilities).not.toHaveBeenCalled()
    expect(conversationOf(FOCUS).modelId).toBe('model-a')
  })

  it('快速换模型串行保存，旧响应不能覆盖最终模型和思考档', async () => {
    const { api, slice, conversationOf } = makeStore()
    const change = slice.setChatTarget as (target: { backend: 'acp'; configId: string; modelId: string }, scope: string) => void
    Object.assign(conversationOf(OTHER), { backend: 'acp', configId: 'agent' })
    const old = deferred<ConversationTargetResult>()
    api.setConversationTarget.mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ acpSessionState: { modes: null, thoughtLevel: effort(['max']) } })
    change({ backend: 'acp', configId: 'agent', modelId: 'model-old' }, OTHER)
    change({ backend: 'acp', configId: 'agent', modelId: 'model-latest' }, OTHER)
    expect(api.setConversationTarget).toHaveBeenCalledTimes(1)
    old.resolve({ acpSessionState: { modes: null, thoughtLevel: effort(['low']) } })
    await vi.waitFor(() => expect(conversationOf(OTHER).acpThoughtLevel).toEqual(effort(['max'])))
    expect(conversationOf(OTHER).modelId).toBe('model-latest')
    expect(api.setConversationTarget).toHaveBeenCalledTimes(2)
  })

  it('草稿按 agent + 模型缓存；新模型保留有效选择、移除无效选择', async () => {
    const { state, api, slice } = makeStore()
    const probe = slice.probeDraftAcp as (agent: string, model?: string) => Promise<void>
    api.probeAcpCapabilities.mockResolvedValueOnce(capability(['low', 'high']))
      .mockResolvedValueOnce(capability(['high', 'max'])).mockResolvedValueOnce(capability([]))
    await probe('agent', 'model-a')
    ;(slice.setDraftAcpThought as (value: string) => void)('high')
    await probe('agent', 'model-b')
    expect(state.draftAcp).toMatchObject({ modelId: 'model-b', thought: 'high' })
    await probe('agent', 'plain')
    expect(state.draftAcp).toMatchObject({ modelId: 'plain', thought: null, thoughtLevel: null })
    await probe('agent', 'model-b')
    expect(api.probeAcpCapabilities).toHaveBeenCalledTimes(3)
    expect(state.draftAcp).toMatchObject({ modelId: 'model-b', thoughtLevel: effort(['high', 'max']) })
  })

  it('草稿探测旧响应晚到也不能覆盖刚选的新模型', async () => {
    const { state, api, slice } = makeStore()
    const probe = slice.probeDraftAcp as (agent: string, model?: string) => Promise<void>
    const old = deferred<AcpProbeResult>()
    api.probeAcpCapabilities.mockReturnValueOnce(old.promise).mockResolvedValueOnce(capability(['max']))
    const pending = probe('agent', 'model-old')
    await probe('agent', 'model-latest')
    old.resolve(capability(['low']))
    await pending
    expect(state.draftAcp).toMatchObject({ modelId: 'model-latest', thoughtLevel: effort(['max']), loading: false })
  })
})

describe('setMcpServerIds：作用域', () => {
  it('ACP 新对话的选择留在草稿，不误写焦点会话', () => {
    const { state, api, slice, scopedOf } = makeStore()
    Object.assign(state.draftSettings as object, {
      chatTarget: { backend: 'acp', configId: 'agent-a' }
    })
    const setMcpServerIds = slice.setMcpServerIds as (
      ids: string[], scope: string | null
    ) => void

    setMcpServerIds(['mcp-files'], null)

    expect(scopedOf(null).mcpServerIds).toEqual(['mcp-files'])
    expect(api.setConversationTarget).not.toHaveBeenCalled()
  })

  it('已有 ACP 会话选择和清空 MCP 都更新自身并请求持久化', () => {
    const { api, slice, conversationOf, scopedOf } = makeStore()
    conversationOf(OTHER).backend = 'acp'
    const setMcpServerIds = slice.setMcpServerIds as (
      ids: string[], scope: string
    ) => void

    setMcpServerIds(['mcp-files'], OTHER)

    expect(scopedOf(OTHER).mcpServerIds).toEqual(['mcp-files'])
    expect(api.setConversationTarget).toHaveBeenLastCalledWith(OTHER, {
      mcpServerIds: ['mcp-files']
    })
    setMcpServerIds([], OTHER)
    expect(scopedOf(OTHER).mcpServerIds).toEqual([])
    expect(api.setConversationTarget).toHaveBeenLastCalledWith(OTHER, { mcpServerIds: [] })
    expect(conversationOf(FOCUS).mcpServerIds).toBeUndefined()
    expect(scopedOf(null).mcpServerIds).toEqual([])
  })

  it('某个会话只改自己的清单，草稿那份不动', () => {
    const { state, slice, conversationOf } = makeStore()
    const setMcpServerIds = slice.setMcpServerIds as (
      ids: string[],
      scope?: string | null
    ) => void

    setMcpServerIds(['mcp-files'], OTHER)

    expect(conversationOf(OTHER).mcpServerIds).toEqual(['mcp-files'])
    expect(conversationOf(FOCUS).mcpServerIds).toBeUndefined()
    expect(
      (state.draftSettings as { mcpServerIds: string[] }).mcpServerIds
    ).toEqual([])
  })
})
