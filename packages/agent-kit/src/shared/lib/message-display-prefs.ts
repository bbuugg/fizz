/**
 * 消息流中过程组 / 工具详情 / 思考内容的默认开合与自动折叠偏好。
 *
 * 这是设备侧的显示偏好：走本地偏好总线，支持同设备多窗口同步，不写入会话数据或服务端配置。
 */
import { useSyncExternalStore } from 'react'
import { readPref, subscribePrefs, writePref } from '@fizz/agent-kit/shared/lib/prefs-sync'

const STORAGE_KEY = ['fizz', 'chat', 'messageDisplay', 'v1'].join('.')

export type GroupAutoCollapse = 'never' | 'turn-end'
export type ToolAutoCollapse = 'never' | 'tool-end' | 'turn-end'
export type ReasoningAutoCollapse = 'never' | 'reasoning-end' | 'turn-end'

export interface MessageDisplayPrefs {
  group: { defaultOpen: boolean; autoCollapse: GroupAutoCollapse }
  tool: { defaultOpen: boolean; autoCollapse: ToolAutoCollapse }
  reasoning: { defaultOpen: boolean; autoCollapse: ReasoningAutoCollapse }
}

export const DEFAULT_MESSAGE_DISPLAY_PREFS: MessageDisplayPrefs = {
  group: { defaultOpen: false, autoCollapse: 'never' },
  tool: { defaultOpen: false, autoCollapse: 'never' },
  reasoning: { defaultOpen: false, autoCollapse: 'never' }
}

/** 保持现有行为：所有内容初始折叠，用户展开后不自动收起。 */
export const COLLAPSED_MESSAGE_DISPLAY_PRESET: MessageDisplayPrefs =
  DEFAULT_MESSAGE_DISPLAY_PREFS

/** 生成期间展开，整轮结束时收起。 */
export const EXPAND_WHILE_RUNNING_MESSAGE_DISPLAY_PRESET: MessageDisplayPrefs = {
  group: { defaultOpen: true, autoCollapse: 'turn-end' },
  tool: { defaultOpen: true, autoCollapse: 'turn-end' },
  reasoning: { defaultOpen: true, autoCollapse: 'turn-end' }
}

export type MessageDisplayPreset = 'collapsed' | 'expand-while-running' | 'custom'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取并校验持久化偏好；旧版 / 手工损坏的值逐字段回落到默认值。 */
export function normalizeMessageDisplayPrefs(value: unknown): MessageDisplayPrefs {
  const raw = isRecord(value) ? value : {}
  const group = isRecord(raw.group) ? raw.group : {}
  const tool = isRecord(raw.tool) ? raw.tool : {}
  const reasoning = isRecord(raw.reasoning) ? raw.reasoning : {}

  return {
    group: {
      defaultOpen:
        typeof group.defaultOpen === 'boolean'
          ? group.defaultOpen
          : DEFAULT_MESSAGE_DISPLAY_PREFS.group.defaultOpen,
      autoCollapse:
        group.autoCollapse === 'turn-end'
          ? 'turn-end'
          : group.autoCollapse === 'never'
            ? 'never'
            : DEFAULT_MESSAGE_DISPLAY_PREFS.group.autoCollapse
    },
    tool: {
      defaultOpen:
        typeof tool.defaultOpen === 'boolean'
          ? tool.defaultOpen
          : DEFAULT_MESSAGE_DISPLAY_PREFS.tool.defaultOpen,
      autoCollapse:
        tool.autoCollapse === 'tool-end' || tool.autoCollapse === 'turn-end'
          ? tool.autoCollapse
          : tool.autoCollapse === 'never'
            ? 'never'
            : DEFAULT_MESSAGE_DISPLAY_PREFS.tool.autoCollapse
    },
    reasoning: {
      defaultOpen:
        typeof reasoning.defaultOpen === 'boolean'
          ? reasoning.defaultOpen
          : DEFAULT_MESSAGE_DISPLAY_PREFS.reasoning.defaultOpen,
      autoCollapse:
        reasoning.autoCollapse === 'reasoning-end' || reasoning.autoCollapse === 'turn-end'
          ? reasoning.autoCollapse
          : reasoning.autoCollapse === 'never'
            ? 'never'
            : DEFAULT_MESSAGE_DISPLAY_PREFS.reasoning.autoCollapse
    }
  }
}

export function resolveInitialFoldOpen(
  defaultOpen: boolean,
  autoCollapse: 'never' | 'item-end' | 'turn-end',
  status: { itemDone: boolean; turnDone: boolean }
): boolean {
  if (!defaultOpen) return false
  if (autoCollapse === 'turn-end' && status.turnDone) return false
  if (autoCollapse === 'item-end' && status.itemDone) return false
  return true
}

export function resolveMessageDisplayPreset(prefs: MessageDisplayPrefs): MessageDisplayPreset {
  if (samePrefs(prefs, COLLAPSED_MESSAGE_DISPLAY_PRESET)) return 'collapsed'
  if (samePrefs(prefs, EXPAND_WHILE_RUNNING_MESSAGE_DISPLAY_PRESET)) return 'expand-while-running'
  return 'custom'
}

export function messageDisplayPrefsForPreset(
  preset: Exclude<MessageDisplayPreset, 'custom'>
): MessageDisplayPrefs {
  return preset === 'collapsed'
    ? COLLAPSED_MESSAGE_DISPLAY_PRESET
    : EXPAND_WHILE_RUNNING_MESSAGE_DISPLAY_PRESET
}

function samePrefs(a: MessageDisplayPrefs, b: MessageDisplayPrefs): boolean {
  return (
    a.group.defaultOpen === b.group.defaultOpen &&
    a.group.autoCollapse === b.group.autoCollapse &&
    a.tool.defaultOpen === b.tool.defaultOpen &&
    a.tool.autoCollapse === b.tool.autoCollapse &&
    a.reasoning.defaultOpen === b.reasoning.defaultOpen &&
    a.reasoning.autoCollapse === b.reasoning.autoCollapse
  )
}

let cachedPrefs: MessageDisplayPrefs | undefined
const listeners = new Set<() => void>()
let unsubscribePrefsBus: (() => void) | undefined

function loadPrefs(): MessageDisplayPrefs {
  if (cachedPrefs) return cachedPrefs
  const raw = readPref(STORAGE_KEY)
  if (raw === null) {
    cachedPrefs = DEFAULT_MESSAGE_DISPLAY_PREFS
    return cachedPrefs
  }
  try {
    cachedPrefs = normalizeMessageDisplayPrefs(JSON.parse(raw))
  } catch {
    cachedPrefs = DEFAULT_MESSAGE_DISPLAY_PREFS
  }
  return cachedPrefs
}

function notifyListeners(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!unsubscribePrefsBus) {
    unsubscribePrefsBus = subscribePrefs(STORAGE_KEY, () => {
      cachedPrefs = undefined
      notifyListeners()
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unsubscribePrefsBus?.()
      unsubscribePrefsBus = undefined
    }
  }
}

export function saveMessageDisplayPrefs(value: MessageDisplayPrefs): void {
  cachedPrefs = normalizeMessageDisplayPrefs(value)
  writePref(STORAGE_KEY, JSON.stringify(cachedPrefs))
  notifyListeners()
}

export function useMessageDisplayPrefs(): MessageDisplayPrefs {
  return useSyncExternalStore(subscribe, loadPrefs, () => DEFAULT_MESSAGE_DISPLAY_PREFS)
}
