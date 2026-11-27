/**
 * 防回归：新对话变成正式会话后，发送回调不能只清旧草稿键，导致关标签再打开恢复已发送的文字。
 * 在 Node 中捕获 Provider 的状态和 effect，重放异步回调 / 草稿迁移顺序，不引入 DOM 环境。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptInputProvider, type PromptInputControllerProps } from './prompt-input'
import { loadChatDraft } from '@fizz/agent-kit/shared/lib/chat-draft'
import { DRAFT_PANEL_SCOPE } from '@fizz/agent-kit/shared/lib/panel-session'

const hooks = vi.hoisted(() => ({
  index: 0,
  slots: [] as unknown[],
  effects: [] as Array<() => void | (() => void)>,
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.index++
    if (!(index in hooks.slots)) {
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial
    }
    return [hooks.slots[index], (value: unknown) => {
      hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value
    }]
  },
  useRef: (initial: unknown) => {
    const index = hooks.index++
    return hooks.slots[index] ??= { current: initial }
  },
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.index++
    const previous = hooks.slots[index] as unknown[] | undefined
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
      hooks.effects.push(effect)
      hooks.slots[index] = deps
    }
  },
}))

function render(draftKey: string) {
  hooks.index = 0
  const element = PromptInputProvider({ draftKey })
  const controller: PromptInputControllerProps = element.props.value
  return {
    input: controller.textInput,
    commit: () => {
      const effects = hooks.effects.splice(0)
      for (const effect of effects) effect()
    },
  }
}

function reopen(draftKey: string) {
  hooks.slots = []
  hooks.effects = []
  return render(draftKey)
}

beforeEach(() => {
  hooks.index = 0
  hooks.slots = []
  hooks.effects = []
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('PromptInputProvider 草稿发送清理', () => {
  it('已有会话发送后同步清除存档，关闭标签再打开输入框为空', () => {
    const first = render('conv-a')
    first.commit()
    first.input.setInput('已发送的消息')
    render('conv-a').input.clear()
    expect(loadChatDraft('conv-a')).toBeNull()
    expect(reopen('conv-a').input.value).toBe('')
  })

  it('草稿已迁移到会话后，提交时捕获的清理回调也必须清掉新键', () => {
    const first = render(DRAFT_PANEL_SCOPE)
    first.commit()
    first.input.setInput('第一条消息')
    const submitting = render(DRAFT_PANEL_SCOPE)
    submitting.commit()

    render('conv-a').commit()
    expect(loadChatDraft('conv-a')).toBe('第一条消息')
    submitting.input.clear() // 建会话后迟到的 onStarted，仍持有提交那一刻的回调。

    expect(loadChatDraft(DRAFT_PANEL_SCOPE)).toBeNull()
    expect(loadChatDraft('conv-a')).toBeNull()
    expect(reopen('conv-a').input.value).toBe('')
  })

  it('发送清理发生在迁移 effect 前，effect 不能把旧正文重新存回去', () => {
    const first = render(DRAFT_PANEL_SCOPE)
    first.commit()
    first.input.setInput('第一条消息')
    const submitting = render(DRAFT_PANEL_SCOPE)
    submitting.commit()

    const migrated = render('conv-a')
    submitting.input.clear()
    migrated.commit()

    expect(loadChatDraft(DRAFT_PANEL_SCOPE)).toBeNull()
    expect(loadChatDraft('conv-a')).toBeNull()
    expect(reopen('conv-a').input.value).toBe('')
  })

  it('迁移前捕获的输入回调只写当前会话，未发送的新草稿仍可恢复', () => {
    const first = render(DRAFT_PANEL_SCOPE)
    first.commit()
    render('conv-a').commit()
    first.input.setInput('接着写的下一条')

    expect(loadChatDraft(DRAFT_PANEL_SCOPE)).toBeNull()
    expect(loadChatDraft('conv-a')).toBe('接着写的下一条')
    expect(reopen('conv-a').input.value).toBe('接着写的下一条')
  })

  it('迁移 effect 尚未执行时继续输入，不能用渲染时的旧值覆盖新草稿', () => {
    const first = render(DRAFT_PANEL_SCOPE)
    first.commit()
    first.input.setInput('原来的草稿')
    render(DRAFT_PANEL_SCOPE).commit()

    const migrated = render('conv-a')
    migrated.input.setInput('接着写的新草稿')
    migrated.commit()

    expect(loadChatDraft(DRAFT_PANEL_SCOPE)).toBeNull()
    expect(loadChatDraft('conv-a')).toBe('接着写的新草稿')
    expect(reopen('conv-a').input.value).toBe('接着写的新草稿')
  })
})
