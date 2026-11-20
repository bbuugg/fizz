/**
 * 回归：刷新恢复必须先补齐历史，再回放同一轮并续上直播。
 * 用受控 Promise 模拟历史、运行态与 SSE 的不同到达顺序，不起服务器、不启动 agent。
 */
import { describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { AgentApi } from '@fizz/agent-client/api'
import type { AgentChatMessage, AgentConversation, ChatRequest, ChatRunSummary, ChatStreamFrame } from '@fizz/contracts/agent-api'
import type { QueuedMessage } from '@fizz/contracts/types'
import type { AgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { createConversationSlice } from '../index'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function message(id: string, role: AgentChatMessage['role'], text = id): AgentChatMessage {
  return { id, role, parts: [{ type: 'text', text }], createdAt: 1 }
}

const HISTORY = [message('u-old', 'user'), message('a-old', 'assistant'), message('u-now', 'user')]

function fixture(backend: 'builtin' | 'acp') {
  const id = `recovery-${backend}`
  const conversation: AgentConversation = {
    id, backend, configId: 'cfg', acpSessionId: 'session', workspaceId: 'ws',
    title: '恢复测试', createdAt: 1, updatedAt: 1,
    messages: backend === 'acp' ? [] : HISTORY
  }
  const run: ChatRunSummary = {
    requestId: `run-${id}`, conversationId: id, status: 'running', startedAt: 1,
    assistantMessageId: 'a-live'
  }
  const connection = deferred<void>()
  let emit!: (frame: ChatStreamFrame) => void
  const api = {
    getConversation: vi.fn(async () => conversation),
    activeRun: vi.fn(async (): Promise<{ run: ChatRunSummary | null }> => ({ run })),
    getAcpTranscript: vi.fn(async (): Promise<{ messages: AgentChatMessage[]; run: ChatRunSummary | null }> => ({ messages: HISTORY, run })),
    attachRun: vi.fn(async (_id: string, onFrame: (frame: ChatStreamFrame) => void) => {
      emit = onFrame
      onFrame({ type: 'start', requestId: run.requestId })
      onFrame({ type: 'event', requestId: run.requestId, event: { type: 'text-delta', delta: '已经生成' } })
      onFrame({ type: 'replay-end', requestId: run.requestId })
      await connection.promise
    }),
    getConversationQueue: vi.fn(async (): Promise<{ items: QueuedMessage[] }> => ({ items: [] }))
  }
  const store = createStore<AgentStore>((set, get, host) => ({
    ...createConversationSlice(set, get, host),
    conversations: [conversation], conversationsLoaded: true,
    activeConversationId: id,
    workspaces: [{ id: 'ws', name: 'workspace', path: '/workspace' }],
    models: [], acpAgents: [],
    getApi: () => api as unknown as AgentApi,
    setBusy: () => undefined, setError: vi.fn()
  }) as unknown as AgentStore)
  const read = () => store.getState().readSlice(id)
  const text = () => read().messages.find((m) => m.id === 'a-live')?.parts
  const finish = async () => {
    connection.resolve()
    await vi.waitFor(() => expect(read().streaming).toBe(false))
  }
  return { id, store, api, run, conversation, connection, read, text, finish,
    emit: (frame: ChatStreamFrame) => emit(frame) }
}

describe.each(['builtin', 'acp'] as const)('%s · 刷新恢复', (backend) => {
  it('空现场恢复完整历史、已输出正文与后续增量，loading 不等生成结束', async () => {
    const f = fixture(backend)
    let restored = false
    const pending = f.store.getState().loadConversation(f.id).then(() => { restored = true })
    try {
      await vi.waitFor(() => expect(f.api.attachRun).toHaveBeenCalledTimes(1))
      expect(f.read().messages.map((m) => m.id)).toEqual(['u-old', 'a-old', 'u-now', 'a-live'])
      await vi.waitFor(() => expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }]))
      expect(f.read().loading).toBe(false)
      expect(restored).toBe(true)
      expect(f.read().streaming).toBe(true)

      f.emit({ type: 'event', requestId: f.run.requestId, event: { type: 'text-delta', delta: '，继续输出' } })
      await vi.waitFor(() => expect(f.text()).toEqual([{ type: 'text', text: '已经生成，继续输出' }]))
    } finally {
      await f.finish()
      await pending
    }
  })

  it('首次打开与远端运行通知并发时只恢复一次、只保留一条订阅', async () => {
    const f = fixture(backend)
    const gate = deferred<{ run: ChatRunSummary | null }>()
    f.api.activeRun.mockImplementation(() => gate.promise)
    const first = f.store.getState().loadConversation(f.id)
    const second = f.store.getState().loadConversation(f.id)
    gate.resolve({ run: f.run })
    try {
      await vi.waitFor(() => expect(f.api.attachRun).toHaveBeenCalledTimes(1))
      expect(f.api.getConversation).toHaveBeenCalledTimes(1)
      expect(f.read().messages.map((m) => m.id)).toEqual(['u-old', 'a-old', 'u-now', 'a-live'])
    } finally {
      await f.finish()
      await Promise.all([first, second])
    }
  })

  it('切走焦点不会取消这条会话的历史恢复或续流', async () => {
    const f = fixture(backend)
    f.store.setState({ activeConversationId: 'another-conversation' })
    const pending = f.store.getState().loadConversation(f.id)
    try {
      await vi.waitFor(() => expect(f.api.attachRun).toHaveBeenCalledTimes(1))
      expect(f.read().messages.map((m) => m.id)).toEqual(['u-old', 'a-old', 'u-now', 'a-live'])
      expect(f.store.getState().activeConversationId).toBe('another-conversation')
    } finally {
      await f.finish()
      await pending
    }
  })

  it('已有直播时补拉历史不会擦掉占位或把同一批正文回放两遍', async () => {
    const f = fixture(backend)
    const attaching = f.store.getState().attachRun(f.id)
    await vi.waitFor(() => expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }]))
    const restoring = f.store.getState().loadConversation(f.id)
    try {
      await vi.waitFor(() => expect(f.api.getConversation).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(f.read().loading).toBe(false))
      expect(f.read().messages.map((m) => m.id)).toEqual(['u-old', 'a-old', 'u-now', 'a-live'])
      expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }])
      expect(f.api.attachRun).toHaveBeenCalledTimes(1)
      f.emit({ type: 'event', requestId: f.run.requestId, event: { type: 'text-delta', delta: '尾巴' } })
      await vi.waitFor(() => expect(f.text()).toEqual([{ type: 'text', text: '已经生成尾巴' }]))
    } finally {
      await f.finish()
      await Promise.all([attaching, restoring])
    }
  })

  it('手动重载复用恢复流程，返回时历史就绪但生成仍在继续', async () => {
    const f = fixture(backend)
    let result: boolean | undefined
    const pending = f.store.getState().reloadConversation(f.id).then((ok) => { result = ok })
    try {
      await vi.waitFor(() => expect(f.api.attachRun).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(result).toBe(true))
      expect(f.read().loading).toBe(false)
      expect(f.read().streaming).toBe(true)
      expect(f.read().messages.map((m) => m.id)).toEqual(['u-old', 'a-old', 'u-now', 'a-live'])
    } finally {
      await f.finish()
      await pending
    }
  })

  it('后台标签直接恢复时也要恢复这条会话的待发送队列', async () => {
    const f = fixture(backend)
    const queue = [{ id: 'q-remote', text: '下一条', createdAt: 2 }]
    f.api.getConversationQueue.mockResolvedValue({ items: queue })
    const pending = f.store.getState().loadConversation(f.id)
    try {
      await vi.waitFor(() => expect(f.read().queuedMessages).toEqual(queue))
    } finally {
      await f.finish()
      await pending
    }
  })
})

describe('ACP · 历史来源与轮次边界', () => {
  it('探测后恰好结束时采用空闲全量回放，不再拼入旧轮帧日志', async () => {
    const f = fixture('acp')
    const full = [message('u-replay-0', 'user'), message('a-replay-1', 'assistant', '最终回复')]
    f.api.getAcpTranscript.mockResolvedValue({ messages: full, run: null })
    let restored = false
    const pending = f.store.getState().loadConversation(f.id).then(() => { restored = true })
    try {
      await vi.waitFor(() => expect(restored).toBe(true))
      expect(f.read().messages).toEqual(full)
      expect(f.api.attachRun).not.toHaveBeenCalled()
      expect(f.read().loading).toBe(false)
    } finally {
      await f.finish()
      await pending
    }
  })

  it('本地有前几轮 user 消息也要补齐远端新一轮的提问', async () => {
    const f = fixture('acp')
    f.store.getState().writeSlice(f.id, (s) => ({ ...s, messages: HISTORY.slice(0, 2) }))
    const pending = f.store.getState().loadConversation(f.id)
    try {
      await vi.waitFor(() => expect(f.api.attachRun).toHaveBeenCalledTimes(1))
      expect(f.read().messages.map((m) => m.id)).toEqual(['u-old', 'a-old', 'u-now', 'a-live'])
    } finally {
      await f.finish()
      await pending
    }
  })

  it('运行态查询失败不冒充空闲并触发 session/load', async () => {
    const f = fixture('acp')
    f.api.activeRun.mockRejectedValue(new Error('offline'))
    await f.store.getState().loadConversation(f.id)
    expect(f.api.getAcpTranscript).not.toHaveBeenCalled()
    expect(f.read().loading).toBe(false)
    expect(f.read().error).toBeTruthy()
  })

  it('历史快照失败仍续上正在输出的轮次，保留可重试的历史错误', async () => {
    const f = fixture('acp')
    f.api.getAcpTranscript.mockRejectedValue(new Error('snapshot unavailable'))
    const pending = f.store.getState().loadConversation(f.id)
    try {
      await vi.waitFor(() => expect(f.api.attachRun).toHaveBeenCalledTimes(1))
      expect(f.read().error).toBe('snapshot unavailable')
      expect(f.read().loading).toBe(false)
      await vi.waitFor(() => expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }]))
    } finally {
      await f.finish()
      await pending
    }
  })

  it('空闲回放期间本端开出新一轮时，旧回放不能清掉新消息', async () => {
    const f = fixture('acp')
    f.api.activeRun.mockResolvedValue({ run: null })
    const gate = deferred<{ messages: AgentChatMessage[]; run: ChatRunSummary | null }>()
    f.api.getAcpTranscript.mockImplementation(() => gate.promise)
    const pending = f.store.getState().loadConversation(f.id)
    await vi.waitFor(() => expect(f.api.getAcpTranscript).toHaveBeenCalledTimes(1))
    const fresh = [...HISTORY, message('u-new', 'user'), message('a-new', 'assistant', '新输出')]
    f.store.getState().writeSlice(f.id, (s) => ({
      ...s, messages: fresh, loadGen: s.loadGen + 1, streaming: true,
      request: { id: 'r-new', assistantId: 'a-new', controller: new AbortController() }
    }))
    f.store.getState().markRunning(f.id, true)
    gate.resolve({ messages: [message('u-replay-0', 'user')], run: null })
    await pending
    expect(f.read().messages).toEqual(fresh)
    expect(f.read().request?.id).toBe('r-new')
    expect(f.api.attachRun).not.toHaveBeenCalled()
  })
})

describe('接流的唯一所有者', () => {
  it('本端 POST 断开后显式移交订阅，原占位复用且回放正文不重复', async () => {
    const f = fixture('acp')
    f.store.setState({ acpAgents: [{ id: 'cfg', name: 'test agent', command: 'mock-agent', args: [] }] })
    Object.assign(f.api, {
      setConversationTarget: vi.fn(async () => [f.conversation]),
      streamChat: vi.fn(async (_input: ChatRequest, emit: (frame: ChatStreamFrame) => void) => {
        emit({ type: 'start', requestId: f.run.requestId })
        emit({ type: 'event', requestId: f.run.requestId, event: { type: 'text-delta', delta: '已经生成' } })
        throw new Error('connection interrupted')
      })
    })
    const pending = f.store.getState().runRound('新的提问', undefined, undefined, f.id)
    try {
      await vi.waitFor(() => expect(f.api.attachRun).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => {
        const assistant = f.read().messages.find((m) => m.id === f.read().request?.assistantId)
        expect(assistant?.parts).toEqual([{ type: 'text', text: '已经生成' }])
      })
      expect(f.read().messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    } finally {
      await f.finish()
      await pending
    }
  })

  it('探测在途时本端先开跑，返回后不能再挂第二条流', async () => {
    const f = fixture('acp')
    const gate = deferred<{ run: ChatRunSummary | null }>()
    f.api.activeRun.mockImplementation(() => gate.promise)
    const pending = f.store.getState().attachRun(f.id)
    f.store.getState().writeSlice(f.id, (s) => ({
      ...s, streaming: true, messages: [message('a-own', 'assistant', '本端直播')],
      request: { id: 'r-own', assistantId: 'a-own', controller: new AbortController() }
    }))
    gate.resolve({ run: f.run })
    try {
      await vi.waitFor(() => expect(f.api.activeRun).toHaveBeenCalledTimes(1))
      await Promise.resolve()
      expect(f.api.attachRun).not.toHaveBeenCalled()
      expect(f.read().messages).toEqual([message('a-own', 'assistant', '本端直播')])
    } finally {
      f.connection.resolve()
      await pending
    }
  })

  it('旧订阅的迟到帧和收场不能清掉已经接管的新一轮', async () => {
    const f = fixture('acp')
    const pending = f.store.getState().attachRun(f.id)
    await vi.waitFor(() => expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }]))
    f.store.getState().writeSlice(f.id, (s) => ({
      ...s, messages: [message('a-new', 'assistant', '新一轮')],
      request: { id: 'r-new', assistantId: 'a-new', controller: new AbortController() }
    }))
    f.emit({ type: 'start', requestId: f.run.requestId })
    f.connection.resolve()
    await pending
    expect(f.read().request?.id).toBe('r-new')
    expect(f.read().streaming).toBe(true)
    expect(f.read().messages).toEqual([message('a-new', 'assistant', '新一轮')])
  })

  it('探测尚未返回时，带已知 requestId 的恢复也不能绕过去重闸门', async () => {
    const f = fixture('acp')
    const gate = deferred<{ run: ChatRunSummary | null }>()
    f.api.activeRun.mockImplementation(() => gate.promise)
    const first = f.store.getState().attachRun(f.id)
    const attach = f.store.getState().attachRun as (id: string, opts: { requestId: string; assistantId: string }) => Promise<boolean>
    const second = attach(f.id, { requestId: f.run.requestId, assistantId: 'a-live' })
    gate.resolve({ run: f.run })
    try {
      await vi.waitFor(() => expect(f.api.attachRun).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }]))
      expect(f.read().messages.filter((m) => m.id === 'a-live')).toHaveLength(1)
    } finally {
      await f.finish()
      await Promise.all([first, second])
    }
  })
})

describe('历史响应的并发保护', () => {
  it('请求期间现场被删除时，晚到的历史不能把它重新建出来', async () => {
    const f = fixture('builtin')
    const gate = deferred<AgentConversation>()
    f.api.getConversation.mockImplementation(() => gate.promise)
    f.store.getState().writeSlice(f.id, (s) => ({ ...s, messages: HISTORY }))
    const pending = f.store.getState().loadMessages(f.id)
    f.store.getState().dropSlice(f.id)
    gate.resolve(f.conversation)
    await pending
    expect(f.store.getState().slices[f.id]).toBeUndefined()
  })

  it('相同代次但直播已经开始时，晚到的历史仍不能覆盖本轮消息', async () => {
    const f = fixture('builtin')
    const attaching = f.store.getState().attachRun(f.id)
    await vi.waitFor(() => expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }]))
    try {
      await f.store.getState().loadMessages(f.id)
      expect(f.read().messages.map((m) => m.id)).toEqual(['u-old', 'a-old', 'u-now', 'a-live'])
      expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }])
    } finally {
      await f.finish()
      await attaching
    }
  })

  it('已完成回复的同 id 旧快照不能把直播正文倒退', async () => {
    const f = fixture('builtin')
    f.api.getConversation.mockResolvedValue({ ...f.conversation, messages: [...HISTORY, message('a-live', 'assistant', '过期正文')] })
    const attaching = f.store.getState().attachRun(f.id)
    await vi.waitFor(() => expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }]))
    try {
      await f.store.getState().loadMessages(f.id)
      expect(f.text()).toEqual([{ type: 'text', text: '已经生成' }])
    } finally {
      await f.finish()
      await attaching
    }
  })

  it('较早发出的历史请求晚返回时不能覆盖较新的响应', async () => {
    const f = fixture('builtin')
    const old = deferred<AgentConversation>()
    f.api.getConversation.mockImplementationOnce(() => old.promise)
    const first = f.store.getState().loadMessages(f.id)
    await f.store.getState().loadMessages(f.id)
    old.resolve({ ...f.conversation, messages: [] })
    await first
    expect(f.read().messages).toEqual(HISTORY)
  })

  it('ACP 元信息接口的空 messages 不能清空已有 transcript', async () => {
    const f = fixture('acp')
    f.store.getState().writeSlice(f.id, (s) => ({ ...s, messages: HISTORY }))
    await f.store.getState().loadMessages(f.id)
    expect(f.read().messages).toEqual(HISTORY)
  })
})
