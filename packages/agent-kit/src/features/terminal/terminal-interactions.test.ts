/** 防回归：安卓长按不能被鼠标右键粘贴拦截，导致剪贴板读失败且系统菜单被吞。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { getTerminalPasteOnRightClick } from '@fizz/agent-kit/shared/lib/terminal-prefs'
import { attachTerminalInteractions } from './terminal-interactions'

vi.mock('@fizz/agent-kit/shared/lib/terminal-prefs', () => ({
  getTerminalCopyOnSelect: vi.fn(() => false),
  getTerminalPasteOnRightClick: vi.fn(() => true)
}))
vi.mock('@fizz/agent-kit/shared/lib/clipboard', () => ({
  writeClipboard: vi.fn().mockResolvedValue(undefined)
}))

const readText = vi.fn<() => Promise<string>>()

beforeEach(() => {
  readText.mockReset().mockRejectedValue(new Error('clipboard permission denied'))
  vi.mocked(getTerminalPasteOnRightClick).mockReturnValue(true)
  vi.stubGlobal('navigator', { clipboard: { readText } })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** 只调用注册的事件处理器，不启动浏览器、不依赖 jsdom。 */
function setup() {
  const listeners = new Map<string, EventListener>()
  const addEventListener = vi.fn((type: string, handler: EventListener) => {
    listeners.set(type, handler)
  })
  const removeEventListener = vi.fn((type: string, handler: EventListener) => {
    if (listeners.get(type) === handler) listeners.delete(type)
  })
  const container = { addEventListener, removeEventListener } as unknown as HTMLElement
  const disposeSelection = vi.fn()
  const term = {
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    focus: vi.fn(),
    onSelectionChange: vi.fn(() => ({ dispose: disposeSelection }))
  }
  const sendInput = vi.fn()
  const onPasteFailed = vi.fn()
  const detach = attachTerminalInteractions({
    term: term as unknown as Terminal,
    container,
    fontSizeRef: { current: 14 },
    applyFontSize: vi.fn(),
    sendInput,
    onPasteFailed,
    isCurrent: () => true
  })
  return {
    term,
    sendInput,
    onPasteFailed,
    detach,
    listeners,
    removeEventListener,
    disposeSelection,
    fire(type: string, event: object) { listeners.get(type)?.(event as Event) }
  }
}

function contextMenu(properties: Record<string, unknown> = {}) {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn(), ...properties }
}

describe('terminal context menu paste', () => {
  it.each(['touch', 'pen'])('%s 长按交给系统菜单，不主动读取剪贴板', async (pointerType) => {
    const h = setup()
    const event = contextMenu({ pointerType })
    h.fire('contextmenu', event)
    await Promise.resolve()

    expect(readText).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(h.onPasteFailed).not.toHaveBeenCalled()
    expect(h.sendInput).not.toHaveBeenCalled()
  })

  it.each([undefined, ''])('旧 WebView 的 contextmenu.pointerType 为 %s 时记住触摸来源', async (pointerType) => {
    const h = setup()
    h.fire('pointerdown', { pointerType: 'touch' })
    const event = contextMenu({ pointerType })
    h.fire('contextmenu', event)
    await Promise.resolve()

    expect(readText).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(h.onPasteFailed).not.toHaveBeenCalled()
  })

  it('触摸合成的鼠标事件也保留系统菜单', async () => {
    const h = setup()
    const event = contextMenu({ pointerType: 'mouse', sourceCapabilities: { firesTouchEvents: true } })
    h.fire('contextmenu', event)
    await Promise.resolve()

    expect(readText).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('真正的鼠标右键仍直接粘贴，并剥掉末尾换行', async () => {
    readText.mockResolvedValue('echo ok\r\n')
    const h = setup()
    h.fire('pointerdown', { pointerType: 'mouse' })
    const event = contextMenu({ pointerType: 'mouse' })
    h.fire('contextmenu', event)
    await Promise.resolve()

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(h.sendInput).toHaveBeenCalledWith('echo ok')
    expect(h.term.focus).toHaveBeenCalledOnce()
  })

  it('触摸后改用鼠标时，不会把之后的右键一直当成长按', async () => {
    readText.mockResolvedValue('pwd')
    const h = setup()
    h.fire('pointerdown', { pointerType: 'touch' })
    h.fire('pointerdown', { pointerType: 'mouse' })
    h.fire('contextmenu', contextMenu())
    await Promise.resolve()

    expect(h.sendInput).toHaveBeenCalledWith('pwd')
  })

  it('鼠标右键确实读失败时仍向调用方报告', async () => {
    const h = setup()
    h.fire('contextmenu', contextMenu({ pointerType: 'mouse' }))
    await Promise.resolve()

    expect(h.onPasteFailed).toHaveBeenCalledOnce()
  })

  it('有选区时保留原菜单', () => {
    const h = setup()
    h.term.hasSelection.mockReturnValue(true)
    const event = contextMenu({ pointerType: 'mouse' })
    h.fire('contextmenu', event)

    expect(readText).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('关闭右键粘贴后不接管菜单', () => {
    vi.mocked(getTerminalPasteOnRightClick).mockReturnValue(false)
    const h = setup()
    const event = contextMenu({ pointerType: 'mouse' })
    h.fire('contextmenu', event)

    expect(readText).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('没有浏览器剪贴板 API 时保留原菜单', () => {
    vi.stubGlobal('navigator', { clipboard: undefined })
    const h = setup()
    const event = contextMenu({ pointerType: 'mouse' })
    h.fire('contextmenu', event)

    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('拆掉终端时移除输入来源监听，不泄漏到下一实例', () => {
    const h = setup()
    h.detach()

    expect(h.listeners.size).toBe(0)
    expect(h.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), { capture: true })
    expect(h.disposeSelection).toHaveBeenCalledOnce()
  })
})
