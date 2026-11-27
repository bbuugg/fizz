// 防止停止/重启与原生凭据请求交错时卡在连接页，或把旧引擎的结果写入新连接。
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeConnection } from './connection'
import type { RuntimeStatus } from './bridge'

const running: RuntimeStatus = { phase: 'running', progress: 100, logs: [] }
const stopped: RuntimeStatus = { phase: 'stopped', progress: 0, logs: [] }
const connection = { serverBase: 'http://127.0.0.1:31001', token: 'new-engine' }
const ready: RuntimeStatus = { ...running, connection }

function deferred() {
  let resolve!: (status: RuntimeStatus) => void
  let reject!: (error: Error) => void
  const promise = new Promise<RuntimeStatus>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(readStatus: () => Promise<RuntimeStatus>) {
  const options = {
    readStatus: vi.fn(readStatus), onStatus: vi.fn(), onConnect: vi.fn(),
    onDisconnect: vi.fn(), onError: vi.fn()
  }
  return { ...options, ...createRuntimeConnection(options) }
}

describe('native runtime connection', () => {
  it('reads credentials once despite repeated running/log events', async () => {
    const request = deferred()
    const state = setup(() => request.promise)
    state.apply(running)
    state.apply(running)
    expect(state.readStatus).toHaveBeenCalledTimes(1)
    request.resolve(ready)
    await vi.waitFor(() => expect(state.onConnect).toHaveBeenCalledWith(connection))
    state.apply(running)
    expect(state.readStatus).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh credential request while the old engine request is pending', async () => {
    const old = deferred()
    const state = setup(() => old.promise)
    // 第一轮显式延迟，第二轮模拟新引擎立即就绪。
    state.readStatus.mockReturnValueOnce(old.promise).mockResolvedValue(ready)
    state.apply(running)
    state.apply(stopped)
    state.apply(running)
    expect(state.readStatus).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(state.onConnect).toHaveBeenCalledWith(connection))
    old.resolve({ ...running, connection: { token: 'old-engine' } })
    await old.promise
    expect(state.onConnect).toHaveBeenCalledTimes(1)
  })

  it('ignores an old request failure after a new engine has connected', async () => {
    const old = deferred()
    const state = setup(() => old.promise)
    state.readStatus.mockReturnValueOnce(old.promise).mockResolvedValue(ready)
    state.apply(running)
    state.apply(stopped)
    state.apply(running)
    old.reject(new Error('old bridge request'))
    await vi.waitFor(() => expect(state.onConnect).toHaveBeenCalledWith(connection))
    expect(state.onError).not.toHaveBeenCalled()
  })

  it('uses a newer stopped status instead of reporting missing credentials', async () => {
    const state = setup(async () => stopped)
    state.apply(running)
    await vi.waitFor(() => expect(state.onStatus).toHaveBeenLastCalledWith(stopped))
    expect(state.onConnect).not.toHaveBeenCalled()
    expect(state.onError).not.toHaveBeenCalled()
    expect(state.onDisconnect).toHaveBeenCalledOnce()
  })

  it('ignores both success and failure after the gate has unmounted', async () => {
    const request = deferred()
    const state = setup(() => request.promise)
    state.apply(running)
    state.dispose()
    request.reject(new Error('late request'))
    await request.promise.catch(() => {})
    await Promise.resolve()
    expect(state.onConnect).not.toHaveBeenCalled()
    expect(state.onError).not.toHaveBeenCalled()
  })

  it('reports a running engine that genuinely omitted its credentials', async () => {
    const state = setup(async () => running)
    state.apply(running)
    await vi.waitFor(() => expect(state.onError).toHaveBeenCalledOnce())
    expect(state.onConnect).not.toHaveBeenCalled()
  })
})
