/**
 * 防不同 SSE 响应共享 UTF-8 解码状态：一条异常截断的流不能污染后续正常响应。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeReasoningFetch } from './resolve-model'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeReasoningFetch', () => {
  it('截断的 UTF-8 字节不污染后续响应', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([0xe4]))
              controller.close()
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning":"中文"}}]}\n\n'))
              controller.close()
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      )
    vi.stubGlobal('fetch', fetchMock)

    const first = await normalizeReasoningFetch('https://first.example/chat')
    await first.text()
    const second = await normalizeReasoningFetch('https://second.example/chat')

    const secondText = await second.text()
    expect(secondText).toContain('"reasoning_content":"中文"')
    expect(secondText).not.toContain('\ufffd')
  })
})
