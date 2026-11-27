/**
 * `emitSafe` 的失败隔离。
 *
 * 长驻的会话状态钩子（`conversation:*`）走这条广播：一个通知插件写坏（网络、格式化、
 * 空指针）不该让会话收尾跟着炸，也不该让排在后面的插件收不到通知。这条测试钉住
 * 「抛错的监听器被跳过并记日志、其余监听器照常执行、异常不冒到调用方」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, createAppContext } from './context'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Context.emitSafe', () => {
  it('单个监听器抛错后，后面的监听器与父层监听器都照常执行', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = createAppContext('app')
    const child = app.isolate('turn:1')
    const calls: string[] = []

    app.on('conversation:finished', () => calls.push('parent'))
    child.on('conversation:finished', () => {
      calls.push('broken')
      throw new Error('通知插件炸了')
    })
    child.on('conversation:finished', () => calls.push('sibling'))

    expect(() => child.emitSafe('conversation:finished', { id: 1 })).not.toThrow()
    expect(calls).toEqual(['broken', 'sibling', 'parent'])
  })

  it('抛错只打一条 warn，不中断调用方', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = new Context(null, 'conversation-hooks:global')
    ctx.on('conversation:finished', () => {
      throw new Error('boom')
    })

    ctx.emitSafe('conversation:finished', {})

    expect(console.warn).toHaveBeenCalledTimes(1)
    const [prefix, message] = vi.mocked(console.warn).mock.calls[0]!
    expect(String(prefix)).toContain('[plugin:conversation-hooks:global]')
    expect(String(message)).toContain('conversation:finished')
  })

  it('没有监听器时静默通过', () => {
    const ctx = createAppContext()
    expect(() => ctx.emitSafe('conversation:started', {})).not.toThrow()
  })
})

describe('Context 能力边界', () => {
  it('不再提供附件上传服务入口', () => {
    const ctx = createAppContext()
    expect('uploads' in ctx).toBe(false)
    expect(ctx.get('uploads')).toBeUndefined()
  })
})
