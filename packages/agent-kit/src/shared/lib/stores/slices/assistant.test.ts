/**
 * 助手切片的「停止」与「会话池」语义（回归测试）。
 *
 * ## 停止（用户报过的 409）
 *
 * 开一轮对话 → 手动停止 → 再发一条 → HTTP 409「这个助手会话正在回复中,等它收尾再发」。
 * 根因是**只断了 SSE、没叫停服务端**：`controller.abort()` 掐的是这条 HTTP 连接，
 * 服务端那条 run 照旧在 `activeByConversation` 里跑；下一次 `startAssistantTurn`
 * 拿 sessionId 一查还活跃，就 409。这里把三条约束钉住：
 *
 * 1. 停止要**同时**发 `POST /api/chat/abort`（先服务端、后断连）；
 * 2. 停止要**立刻**把本地置闲（不等 fetch reject 回来）；
 * 3. 停止**不是错误**（abort 让 fetch 抛 AbortError，不该写成红字）。
 *
 * ## 会话池（「保存 + 助手间共享 + 支持切换」）
 *
 * 会话不再按面板 key 各存一份，而是**一个池子 + 一个 activeId**：`ensureAssistantSession`
 * 有就复用、`newAssistantSession` 才换新、`switchAssistantSession` 只挪指针（消息不动）、
 * `deleteAssistantSession` 删掉当前那段后要落到还剩下的一段（不能停在「无会话」）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createAssistantSlice, type AssistantSlice } from './assistant'

/** 一条永不自己结束的流：只有 abort 能把它 reject 掉（和真 SSE 一样） */
function hangingStream(
  _input: unknown,
  _onFrame: unknown,
  signal: AbortSignal
): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
}

type Sessions = AssistantSlice['assistantConversations']

/**
 * 最小 store：只有切片自己用到的字段。
 *
 * 用 `Object.assign` 就地改（不新建对象），这样 `get()` 拿到的永远是同一份，
 * 切片内部的 `set(...)` 也能被断言看到。
 */
function makeStore(api: Record<string, unknown>) {
  const state: Record<string, unknown> = {
    assistantConversations: {},
    assistantActiveId: null,
    getApi: () => api
  }
  const set = (partial: unknown): void => {
    Object.assign(
      state,
      typeof partial === 'function' ? (partial as (s: unknown) => object)(state) : partial
    )
  }
  const get = (): unknown => state
  const slice = (createAssistantSlice as unknown as (
    set: unknown,
    get: unknown,
    api: unknown
  ) => AssistantSlice)(set, get, {})
  Object.assign(state, slice)
  const read = (id: string) => (state.assistantConversations as Sessions)[id]
  const activeId = () => state.assistantActiveId as string | null
  return { slice, read, activeId }
}

describe('assistant slice · 停止', () => {
  it('停止 = 先叫停服务端 + 立刻置闲 + 不写错误', async () => {
    const abort = vi.fn().mockResolvedValue({ aborted: true })
    const streamAssistant = vi.fn(hangingStream)
    const { slice, read } = makeStore({ abort, streamAssistant })

    const sessionId = slice.ensureAssistantSession()
    const sending = slice.sendAssistant('看看日志', 'project')
    expect(streamAssistant).toHaveBeenCalledTimes(1)
    expect(read(sessionId).streaming).toBe(true)

    slice.stopAssistant()

    // ① 服务端也要停（requestId 还没从 start 帧拿到 → 用 sessionId 兜底）
    expect(abort).toHaveBeenCalledWith('', sessionId)
    // ② 按下停止，输入框立刻可用
    expect(read(sessionId).streaming).toBe(false)
    expect(read(sessionId).request).toBe(null)

    await sending
    // ③ AbortError 是预期收场，不是失败
    expect(read(sessionId).error).toBe(null)
  })

  it('停完立刻再发：等上一轮在服务端收尾后才发下一轮（不再 409）', async () => {
    let releaseAbort: (() => void) | undefined
    const abort = vi.fn(
      () =>
        new Promise<{ aborted: boolean }>((resolve) => {
          releaseAbort = () => resolve({ aborted: true })
        })
    )
    const streamAssistant = vi.fn(hangingStream)
    const { slice } = makeStore({ abort, streamAssistant })

    slice.ensureAssistantSession()
    void slice.sendAssistant('第一句', 'project')
    slice.stopAssistant()

    void slice.sendAssistant('第二句', 'project')
    // 上一轮还没在服务端收尾：第二轮不许发出去
    expect(streamAssistant).toHaveBeenCalledTimes(1)

    releaseAbort?.()
    await vi.waitFor(() => expect(streamAssistant).toHaveBeenCalledTimes(2))
  })
})

describe('assistant slice · 编辑重发', () => {
  it('回包在发出后立刻到（不等整轮跑完），面板才能及时清空草稿', async () => {
    const abort = vi.fn().mockResolvedValue({ aborted: true })
    const streamAssistant = vi
      .fn()
      .mockResolvedValueOnce(undefined) // 第一轮立刻收尾，留下一条可编辑的历史
      .mockImplementation(hangingStream) // 重发这一轮挂住（模拟正在回复）
    const { slice, read } = makeStore({ abort, streamAssistant })

    const sessionId = slice.ensureAssistantSession()
    await slice.sendAssistant('旧话', 'project')
    const userId = read(sessionId).messages[0]?.id
    expect(userId).toBeTruthy()

    let resendResult: boolean | null = null
    void slice.resendAssistantMessage(userId!, '改后的话', 'project').then((ok) => {
      resendResult = ok
    })

    // 重发已经开跑（这一轮流还挂着）……
    await vi.waitFor(() => expect(read(sessionId).streaming).toBe(true))
    // ……回包却已经到了：面板据此清草稿，输入框不会在整轮回复期间挂着已发出的文本
    await vi.waitFor(() => expect(resendResult).toBe(true))

    slice.stopAssistant()
    await vi.waitFor(() => expect(read(sessionId).streaming).toBe(false))
  })
})

describe('assistant slice · 会话池', () => {
  it('ensure 有就复用；new 才换新的一段并切过去', () => {
    const { slice, activeId } = makeStore({})

    const first = slice.ensureAssistantSession()
    expect(slice.ensureAssistantSession()).toBe(first)

    const second = slice.newAssistantSession()
    expect(second).not.toBe(first)
    expect(activeId()).toBe(second)

    // 切回去：指针动，会话本身不动
    slice.switchAssistantSession(first)
    expect(activeId()).toBe(first)
    // 切到不存在的 id = 空操作（切换器里点了已被删的一段）
    slice.switchAssistantSession('nope')
    expect(activeId()).toBe(first)
  })

  it('删掉当前这段：落到还剩下的一段；删光了自动建一段空的', () => {
    const { slice, activeId, read } = makeStore({})

    const first = slice.ensureAssistantSession()
    const second = slice.newAssistantSession()

    // 删的不是当前这段：指针不动
    slice.deleteAssistantSession(first)
    expect(activeId()).toBe(second)
    expect(read(first)).toBeUndefined()

    // 删的是当前这段且池子空了：必须留一段空的，面板不能停在「无会话」
    slice.deleteAssistantSession(second)
    const fallback = activeId()
    expect(fallback).toBeTruthy()
    expect(fallback).not.toBe(second)
    expect(read(fallback as string)).toBeTruthy()
  })

  it('删除会先停掉那段正在跑的一轮（别让迟到的帧写回来）', async () => {
    const abort = vi.fn().mockResolvedValue({ aborted: true })
    const streamAssistant = vi.fn(hangingStream)
    const { slice, read } = makeStore({ abort, streamAssistant })

    const sessionId = slice.ensureAssistantSession()
    void slice.sendAssistant('看看日志', 'project')
    expect(read(sessionId).streaming).toBe(true)

    slice.deleteAssistantSession(sessionId)
    expect(abort).toHaveBeenCalledWith('', sessionId)
    expect(read(sessionId)).toBeUndefined()
  })
})
