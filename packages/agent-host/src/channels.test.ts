/** 防止桌面端一次性 IPC 请求在取消后仍被调用方无限等待。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invokeWithAbort } from './channels'

describe('invokeWithAbort', () => {
  afterEach(() => vi.restoreAllMocks())

  it('中止活跃请求、通知宿主并立即以 AbortError 收场', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(async () => undefined)
    const invoke = vi.fn(() => new Promise<string>(() => undefined))
    const result = invokeWithAbort(controller.signal, invoke, cancel)

    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('信号已中止时不再启动 IPC 请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const invoke = vi.fn(async () => 'unexpected')
    const cancel = vi.fn(async () => undefined)

    await expect(invokeWithAbort(controller.signal, invoke, cancel)).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('正常响应时不调用取消回调', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(async () => undefined)

    await expect(invokeWithAbort(controller.signal, async () => 'ok', cancel)).resolves.toBe('ok')
    expect(cancel).not.toHaveBeenCalled()
  })
})
