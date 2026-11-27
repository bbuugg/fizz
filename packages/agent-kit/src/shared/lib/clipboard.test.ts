/**
 * 防回归：非安全上下文（http 自托管）里 `navigator.clipboard` 不存在，
 * 调用方曾直接 `.writeText` 抛 TypeError（消息划选浮层的「复制」）。
 * 这里锁死三条路：Clipboard API → execCommand 退路 → 明确 reject。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboard } from './clipboard'

function stubDocument(execResult: boolean) {
  const area = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn()
  }
  const execCommand = vi.fn(() => execResult)
  vi.stubGlobal('document', {
    createElement: () => area,
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    execCommand
  })
  return { area, execCommand }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('writeClipboard', () => {
  it('有 Clipboard API 时优先走 writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await writeClipboard('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('非安全上下文（navigator.clipboard 不存在）退回 execCommand', async () => {
    vi.stubGlobal('navigator', {})
    const { area, execCommand } = stubDocument(true)
    await expect(writeClipboard('你好')).resolves.toBeUndefined()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(area.value).toBe('你好')
    expect(area.setSelectionRange).toHaveBeenCalledWith(0, 2)
  })

  it('Clipboard API 被拒时也退到 execCommand', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { execCommand } = stubDocument(true)
    await expect(writeClipboard('x')).resolves.toBeUndefined()
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('两条路都不可用时 reject（而不是抛 TypeError）', async () => {
    vi.stubGlobal('navigator', {})
    stubDocument(false)
    await expect(writeClipboard('x')).rejects.toThrow('clipboard unavailable')
  })
})