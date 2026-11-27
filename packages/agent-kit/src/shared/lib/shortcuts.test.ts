/**
 * 侧边栏快捷键的默认值与持久化迁移。
 *
 * 防的回归：旧 Alt+1 默认值升级后不变、迁移反复覆盖用户改键，以及改键 / 禁用后
 * Ctrl/Cmd+B 仍被应用快捷键占用。UI 原语不再自行监听，统一由应用配置决定绑定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_AGENT_SHORTCUTS,
  findShortcutByEvent,
  loadShortcuts,
  saveShortcuts,
  type AgentShortcutConfig,
  type KeyComboEvent
} from './shortcuts'

const STORAGE_KEY = 'fizz.agent.shortcuts'

let storage: Map<string, string>

beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function sidebarAccelerator(shortcuts: AgentShortcutConfig[]): string | undefined {
  return shortcuts.find((shortcut) => shortcut.action === 'toggle-sidebar-alt')?.accelerator
}

function keyEvent(overrides: Partial<KeyComboEvent> = {}): KeyComboEvent {
  return {
    code: 'KeyB',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('侧边栏快捷键：默认值与迁移', () => {
  it('首次使用与恢复默认均绑定 Ctrl/Cmd+B', () => {
    expect(sidebarAccelerator(loadShortcuts())).toBe('CommandOrControl+B')
    saveShortcuts(DEFAULT_AGENT_SHORTCUTS)
    expect(sidebarAccelerator(loadShortcuts())).toBe('CommandOrControl+B')
  })

  it('一次性迁移旧 Alt+1 默认值，并保留其他动作的自定义绑定', () => {
    storage.set(STORAGE_KEY, JSON.stringify([
      { action: 'toggle-sidebar-alt', accelerator: 'Alt+1' },
      { action: 'toggle-terminal', accelerator: 'Alt+T' }
    ]))

    const shortcuts = loadShortcuts()

    expect(sidebarAccelerator(shortcuts)).toBe('CommandOrControl+B')
    expect(shortcuts.find((shortcut) => shortcut.action === 'toggle-terminal')?.accelerator).toBe('Alt+T')
    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toMatchObject({
      version: 1,
      shortcuts
    })
  })

  it.each(['Alt+S', 'CommandOrControl+B', ''])('旧侧栏自定义 / 禁用配置原样保留：%j', (accelerator) => {
    storage.set(STORAGE_KEY, JSON.stringify([
      { action: 'toggle-sidebar-alt', accelerator }
    ]))

    expect(sidebarAccelerator(loadShortcuts())).toBe(accelerator)
  })

  it('Ctrl/Cmd+B 已被其他动作自定义占用时保留旧 Alt+1，避免迁移制造冲突', () => {
    storage.set(STORAGE_KEY, JSON.stringify([
      { action: 'toggle-sidebar-alt', accelerator: 'Alt+1' },
      { action: 'toggle-terminal', accelerator: 'Ctrl+B' }
    ]))

    const shortcuts = loadShortcuts()

    expect(sidebarAccelerator(shortcuts)).toBe('Alt+1')
    expect(findShortcutByEvent(shortcuts, keyEvent({ ctrlKey: true }))?.action).toBe('toggle-terminal')
  })

  it('迁移完成后用户主动改回 Alt+1，后续加载不再覆盖', () => {
    const shortcuts = DEFAULT_AGENT_SHORTCUTS.map((shortcut) => (
      shortcut.action === 'toggle-sidebar-alt' ? { ...shortcut, accelerator: 'Alt+1' } : shortcut
    ))
    saveShortcuts(shortcuts)

    expect(sidebarAccelerator(loadShortcuts())).toBe('Alt+1')
    expect(sidebarAccelerator(loadShortcuts())).toBe('Alt+1')
  })

  it('迁移落盘失败时本次加载仍使用新默认值', () => {
    storage.set(STORAGE_KEY, JSON.stringify([
      { action: 'toggle-sidebar-alt', accelerator: 'Alt+1' }
    ]))
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: () => { throw new Error('quota') }
    })

    expect(sidebarAccelerator(loadShortcuts())).toBe('CommandOrControl+B')
  })

  it.each(['null', '{}', 'invalid'])('损坏配置回落默认值：%s', (raw) => {
    storage.set(STORAGE_KEY, raw)

    expect(loadShortcuts()).toEqual(DEFAULT_AGENT_SHORTCUTS)
  })
})

describe('侧边栏快捷键：应用配置决定匹配', () => {
  it.each([{ ctrlKey: true }, { metaKey: true }])('默认匹配 Ctrl 或 Cmd：%j', (modifiers) => {
    expect(findShortcutByEvent(loadShortcuts(), keyEvent(modifiers))?.action).toBe('toggle-sidebar-alt')
  })

  it('修改绑定后只匹配新组合，Ctrl/Cmd+B 与旧 Alt+1 均不命中', () => {
    saveShortcuts([{ action: 'toggle-sidebar-alt', accelerator: 'Alt+S' }])
    const shortcuts = loadShortcuts()

    expect(findShortcutByEvent(shortcuts, keyEvent({ code: 'KeyS', altKey: true }))?.action).toBe('toggle-sidebar-alt')
    expect(findShortcutByEvent(shortcuts, keyEvent({ ctrlKey: true }))).toBeNull()
    expect(findShortcutByEvent(shortcuts, keyEvent({ metaKey: true }))).toBeNull()
    expect(findShortcutByEvent(shortcuts, keyEvent({ code: 'Digit1', altKey: true }))).toBeNull()
  })

  it('清除绑定后 Ctrl/Cmd+B 不命中', () => {
    saveShortcuts([{ action: 'toggle-sidebar-alt', accelerator: '' }])

    expect(findShortcutByEvent(loadShortcuts(), keyEvent({ ctrlKey: true }))).toBeNull()
    expect(findShortcutByEvent(loadShortcuts(), keyEvent({ metaKey: true }))).toBeNull()
  })
})
