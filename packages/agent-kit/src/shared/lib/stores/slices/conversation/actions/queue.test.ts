/**
 * 回归：**待发送队列是「那条会话自己的事」，与用户此刻看哪块无关**。
 *
 * ## 防的是什么
 *
 * 队列的语义是「这一轮跑完，我自己把下一条接着发出去」。以前这条链路的每一环都按
 * **活跃会话**走：
 *
 * - `pump`（把下一条顶上来）恒取 `activeConversationId`；
 * - `settleRound` 收尾时还额外要求「必须仍然是焦点会话」才续 —— 于是分屏时在 B 标签
 *   排三条、随手点回 A 看别的，B 的第一轮跑完，队列就停在那儿不动了；
 * - `sendQueuedMessage`（队列里挑一条立刻发）同样按活跃会话走，在 B 上点会把 A 的
 *   消息发出去。
 *
 * 现在的口径：**队列自己跑到底**（`pump(conversationId)`），焦点只影响「屏幕上显示谁」。
 *
 * ## 钉住三件事
 *
 * 1. `pump(非焦点会话)` 发的是**那条会话**的队首（以前发的是焦点会话的队首）；
 * 2. 不传 scope 时仍是活跃会话（内部调用点的默认值不变）；
 * 3. `sendQueuedMessage(id, 会话)` 落到那条会话上。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationSlice } from '../index'

const FOCUS = 'conv-a'
const OTHER = 'conv-b'

function makeStore() {
  const api = {
    setConversationQueue: vi.fn(async () => ({ ok: true })),
    setConversationTarget: vi.fn(async () => ({ ok: true })),
    // 运行中「点队列发送」= 插话：投进服务端收件箱，回一条带 id 的消息
    steer: vi.fn(async (_id: string, text: string) => ({
      message: {
        id: 'steer-1',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text }],
        createdAt: 1
      }
    }))
  }
  const conversations = [
    { id: FOCUS, backend: 'builtin', workspaceId: 'ws-1', title: 'A' },
    { id: OTHER, backend: 'builtin', workspaceId: 'ws-1', title: 'B' }
  ]
  const boot = {
    conversations,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    runningConversations: {},
    models: [],
    acpAgents: [],
    chatTarget: null,
    reasoningEffort: null,
    mcpServerIds: [],
    browserSettings: null,
    slices: {},
    getApi: () => api,
    setBusy: () => undefined,
    setError: () => undefined
  }
  const state: Record<string, unknown> = { ...boot, activeConversationId: null }
  const set = (partial: unknown): void => {
    const patch =
      typeof partial === 'function' ? (partial as (s: unknown) => object)(state) : partial
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
  Object.assign(state, boot, { activeConversationId: FOCUS })

  // 开跑整轮太重（要 api / 目标 / SSE）：这里只关心「发到哪条会话、发了什么」
  const runRound = vi.fn(
    async (
      _text: string,
      _files?: unknown,
      _onStarted?: unknown,
      _scope?: string | null
    ) => true
  )
  state.runRound = runRound

  const readSlice = slice.readSlice as (id: string | null) => {
    queuedMessages: { id: string; text: string; files: [] }[]
    pendingSteers: { id: string }[]
    queuePausedReason: string | null
  }
  const writeSlice = slice.writeSlice as (
    id: string,
    fn: (s: Record<string, unknown>) => Record<string, unknown>
  ) => void

  /** 往某条会话的队列里塞两条（模拟在 B 标签连发几条，会话正在跑） */
  const queueIn = (id: string, texts: string[]): void => {
    writeSlice(id, (s) => ({
      ...s,
      queuedMessages: texts.map((text, i) => ({
        id: `${id}-q${i}`,
        text,
        files: [] as [],
        createdAt: i
      }))
    }))
  }

  return {
    state,
    api,
    runRound,
    readSlice,
    queueIn,
    pump: slice.pump as (scope?: string | null) => void,
    sendQueuedMessage: slice.sendQueuedMessage as (
      id: string,
      scope?: string | null
    ) => Promise<boolean>
  }
}

describe('pump：队列不看焦点', () => {
  it('非焦点会话的队列自己往下跑：发的是那条会话的队首', () => {
    const { runRound, readSlice, queueIn, pump } = makeStore()
    queueIn(OTHER, ['第二条', '第三条'])

    // 用户此刻在看 A（焦点），B 的第一轮刚收尾
    pump(OTHER)

    expect(runRound).toHaveBeenCalledTimes(1)
    // 关键：scope 是 B —— 以前这里发的是 A 的队首，B 的队列原地卡住
    expect(runRound.mock.calls[0][0]).toBe('第二条')
    expect(runRound.mock.calls[0][3]).toBe(OTHER)
    expect(readSlice(OTHER).queuedMessages.map((m) => m.text)).toEqual(['第三条'])
  })

  it('不传 scope 时仍按活跃会话（内部调用点的默认值不变）', () => {
    const { runRound, readSlice, queueIn, pump } = makeStore()
    queueIn(FOCUS, ['A 队首'])

    pump()

    expect(runRound.mock.calls[0][0]).toBe('A 队首')
    expect(runRound.mock.calls[0][3]).toBe(FOCUS)
    expect(readSlice(FOCUS).queuedMessages).toEqual([])
  })

  it('那条会话正在跑就不动队列（不会并发两轮）', () => {
    const { state, runRound, readSlice, queueIn, pump } = makeStore()
    queueIn(OTHER, ['第二条'])
    state.runningConversations = { [OTHER]: true }

    pump(OTHER)

    expect(runRound).not.toHaveBeenCalled()
    expect(readSlice(OTHER).queuedMessages.map((m) => m.text)).toEqual(['第二条'])
  })

  it('队列空 / 没有会话都是 no-op', () => {
    const { runRound, pump } = makeStore()
    pump(OTHER)
    pump(null)
    expect(runRound).not.toHaveBeenCalled()
  })
})

describe('sendQueuedMessage：作用域', () => {
  it('在非焦点标签点「立刻发」：发的是本标签那条，不是焦点会话的', async () => {
    const { runRound, readSlice, queueIn, sendQueuedMessage } = makeStore()
    queueIn(FOCUS, ['A 的消息'])
    queueIn(OTHER, ['B 的消息'])

    await sendQueuedMessage('conv-b-q0', OTHER)

    expect(runRound.mock.calls[0][0]).toBe('B 的消息')
    expect(runRound.mock.calls[0][3]).toBe(OTHER)
    // A 的队列原封不动
    expect(readSlice(FOCUS).queuedMessages.map((m) => m.text)).toEqual(['A 的消息'])
  })
})

describe('sendQueuedMessage：跑着时 = 插话', () => {
  it('投进当前轮收件箱：成功后从队列移入插话列表，不另起新一轮', async () => {
    const { state, api, runRound, readSlice, queueIn, sendQueuedMessage } =
      makeStore()
    queueIn(FOCUS, ['插话的内容'])
    state.runningConversations = { [FOCUS]: true }

    const started = await sendQueuedMessage('conv-a-q0', FOCUS)

    expect(started).toBe(true)
    expect(api.steer).toHaveBeenCalledWith(FOCUS, '插话的内容', [])
    expect(runRound).not.toHaveBeenCalled()
    expect(readSlice(FOCUS).queuedMessages).toEqual([])
    expect(readSlice(FOCUS).pendingSteers.map((m) => m.id)).toEqual(['steer-1'])
  })
})
