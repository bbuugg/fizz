/**
 * 这组测的是「重试次数只由外层（设置页的「模型请求重试」）决定，AI SDK 自己不再偷偷重试」。
 *
 * 防的回归：`runEngine` 的 `streamText` 一旦漏传 `maxRetries: 0`，AI SDK 会按默认
 * `maxRetries = 2` 在**单条请求内部**自己再打 3 次 —— 用户把设置页调到 20，界面里照样
 * 冒出写死次数的 `Failed after 3 attempts. Last error: …`；更糟的是外层每重试一次，
 * 内部又暗打 3 次，真实请求数是两层**相乘**（并发满时越重试越堵）。
 * 详见 `engine.ts` 里 `maxRetries: 0` 的那段注释。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { streamText } = vi.hoisted(() => ({ streamText: vi.fn() }))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText
}))

const { runEngine } = await import('./engine')

/** 只吐收尾帧：本组只关心「传给 streamText 的参数」，不关心事件映射 */
function fakeStream() {
  return {
    fullStream: (async function* () {
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      }
    })()
  }
}

describe('runEngine 交给 streamText 的参数', () => {
  beforeEach(() => {
    streamText.mockReset()
    streamText.mockReturnValue(fakeStream())
  })

  it('关掉 AI SDK 自己的重试，重试次数只由外层循环决定', async () => {
    const engine = runEngine({
      model: {} as never,
      system: 'SYS',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      maxSteps: 1
    })
    // 生成器必须被消费完：`done` 在它的 finally 里 resolve
    const events: unknown[] = []
    for await (const event of engine.events) events.push(event)
    await engine.done

    const firstCall = streamText.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(firstCall[0].maxRetries).toBe(0)
  })

  it('工具调用并发不超过配置上限', async () => {
    let active = 0
    let peak = 0
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })

    streamText.mockImplementation((options: { tools: Record<string, { execute: () => Promise<unknown> }> }) => ({
      fullStream: (async function* () {
        const calls = [options.tools.work!.execute(), options.tools.work!.execute()]
        await Promise.resolve()
        await Promise.resolve()
        release()
        await Promise.all(calls)
        yield { type: 'finish', finishReason: 'stop' }
      })()
    }))

    const engine = runEngine({
      model: {} as never,
      system: 'SYS',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {
        work: {
          execute: async () => {
            active += 1
            peak = Math.max(peak, active)
            await hold
            active -= 1
          }
        } as never
      },
      maxSteps: 1,
      toolCallConcurrency: 1
    })

    for await (const _event of engine.events) {
      // Consume the engine stream so its completion promise settles.
    }
    await engine.done

    expect(peak).toBe(1)
  })
})
