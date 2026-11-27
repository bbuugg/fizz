/** 防回归：模式按实际能力显示，原值 / 草稿 / 保存状态隔离；SSR+原语 mock，不冒充浏览器测试。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, Fragment, type ComponentProps, type PropsWithChildren, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { AcpModePill } from './AcpModePill'

const mocks = vi.hoisted(() => ({
  change: null as ((value: string) => void) | null,
  value: undefined as string | undefined,
  items: [] as Array<{ value: string; title?: string; disabled?: boolean }>,
  trigger: null as ComponentProps<'button'> | null,
  error: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@fizz/agent-kit/shared/lib/language', () => ({ useT: () => (text: string, vars?: Record<string, unknown>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars?.[key] ?? `{${key}}`)) }))
vi.mock('@fizz/agent-kit/features/chat/composer', () => ({ CHAT_ICON_PILL: 'test-pill' }))
vi.mock('@fizz/agent-kit/shared/components/IconTip', () => ({ IconTip: ({ children }: PropsWithChildren) => children }))
vi.mock('@fizz/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren) => createElement(Fragment, null, children),
  DropdownMenuContent: ({ children }: PropsWithChildren) => createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactElement<ComponentProps<'button'>> }) => {
    mocks.trigger = children.props
    return children
  },
  DropdownMenuRadioGroup: ({ children, value, onValueChange }: PropsWithChildren<{
    value?: string; onValueChange: (value: string) => void
  }>) => {
    mocks.value = value
    mocks.change = onValueChange
    return createElement('div', { role: 'group' }, children)
  },
  DropdownMenuRadioItem: ({ children, ...props }: PropsWithChildren<{ value: string; title?: string; disabled?: boolean }>) => {
    mocks.items.push(props)
    return createElement('button', { type: 'button', role: 'menuitemradio', 'aria-checked': props.value === mocks.value,
      disabled: props.disabled, title: props.title }, children)
  },
}))

const modes = { configId: 'vendor:mode', current: 'vendor:build', available: [
  { id: 'vendor:review', name: '审阅', description: '供应方的说明' },
  { id: 'vendor:build', name: '构建' },
] }
function app(patch: Partial<AgentApp> = {}) {
  return {
    activeConversationId: 'conv',
    conversations: [{ id: 'conv', backend: 'acp', configId: 'agent', modelId: 'model', acpModes: modes,
      acpThoughtLevel: { configId: 'effort', current: 'deep', options: [{ value: 'deep', name: '深入' }] } }],
    acpAgents: [{ id: 'agent' }], streaming: false, creatingConversation: false,
    acpConfigLoading: false, acpConfigError: null,
    setAcpAgentMode: vi.fn(async () => ({ ok: true })), setDraftAcpMode: vi.fn(), ...patch,
  } as unknown as AgentApp
}
function render(state: AgentApp) {
  mocks.items = []; mocks.change = null; mocks.trigger = null; mocks.value = undefined
  return renderToStaticMarkup(createElement(AcpModePill, { app: state }))
}
function draftApp(): AgentApp {
  return app({ activeConversationId: null, conversations: [],
    chatTarget: { backend: 'acp', configId: 'agent', modelId: 'model' },
    draftAcp: { agentId: 'agent', modelId: 'model', loading: false, error: null, modes,
      mode: 'vendor:build', thoughtLevel: null, thought: null },
  })
}
beforeEach(() => { mocks.error.mockReset() })

describe('ACP 能力驱动模式选择', () => {
  it.each([undefined, 'generic', 'pi', 'opencode'] as const)('%s 有能力就显示；与思考档同时存在，保留原始名称、顺序和提交值', (type) => {
    const state = app()
    state.acpAgents[0].type = type
    expect(render(state)).toContain('模式：构建')
    expect(mocks.items.map((item) => item.value)).toEqual(['vendor:review', 'vendor:build'])
    expect(mocks.items[0].title).toBe('供应方的说明')
    expect(mocks.value).toBe('vendor:build')
    mocks.change!('vendor:review')
    expect(state.setAcpAgentMode).toHaveBeenCalledWith('agent', 'conv', 'vendor:review')
  })

  it('没有模式能力就隐藏，内置会话也不借用 ACP 能力', () => {
    const state = app()
    state.conversations[0].acpModes = undefined
    expect(render(state)).toBe('')
    state.conversations[0] = { ...state.conversations[0], backend: 'builtin', acpModes: modes }
    expect(render(state)).toBe('')
  })

  it('草稿只记录本地选择，不请求尚未创建的会话', () => {
    const state = draftApp()
    render(state)
    mocks.change!('vendor:review')
    expect(state.setDraftAcpMode).toHaveBeenCalledWith('vendor:review')
    expect(state.setAcpAgentMode).not.toHaveBeenCalled()
  })

  it('ACP 目标与草稿能力尚未就绪时隐藏，不读取 null 草稿', () => {
    expect(render(app({
      activeConversationId: null,
      conversations: [],
      chatTarget: { backend: 'acp' },
      draftAcp: null
    }))).toBe('')
  })

  it.each([{ configId: 'other', modelId: 'model' }, { configId: 'agent', modelId: 'other-model' }])(
    '不展示其他 Agent 或模型的旧草稿能力：%j', (target) => {
      const state = draftApp()
      state.chatTarget = { backend: 'acp', ...target }
      expect(render(state)).toBe('')
    },
  )

  it('加载和失败分别呈现状态，不能再选择旧模式', () => {
    expect(render(app({ acpConfigLoading: true }))).toContain('role="status"')
    expect(mocks.change).toBeNull()
    expect(render(app({ acpConfigError: '读取失败' }))).toContain('读取模式失败：读取失败')
    expect(mocks.change).toBeNull()
  })

  it('单模式只读，非法值与当前值都不提交', () => {
    const state = app()
    render(state)
    mocks.change!('invented')
    mocks.change!('vendor:build')
    expect(state.setAcpAgentMode).not.toHaveBeenCalled()
    state.conversations[0].acpModes = { ...modes, available: [modes.available[1]] }
    render(state)
    expect(mocks.trigger?.disabled).toBe(true)
    mocks.change!('vendor:review')
    expect(state.setAcpAgentMode).not.toHaveBeenCalled()
  })

  it('草稿建会话期间禁用，但不禁止已有会话在生成期间切模式', () => {
    const draft = draftApp()
    draft.creatingConversation = true
    render(draft)
    expect(mocks.trigger?.disabled).toBe(true)
    mocks.change!('vendor:review')
    expect(draft.setDraftAcpMode).not.toHaveBeenCalled()
    const existing = app({ streaming: true, creatingConversation: true })
    render(existing)
    expect(mocks.trigger?.disabled).toBe(false)
    mocks.change!('vendor:review')
    expect(existing.setAcpAgentMode).toHaveBeenCalledTimes(1)
  })

  it('防止保存中重复提交，失败提示且允许重试', async () => {
    let finish!: (result: { ok: boolean; error?: string }) => void
    const state = app({ setAcpAgentMode: vi.fn(() => new Promise<{ ok: boolean; error?: string }>((done) => { finish = done })) })
    render(state)
    const change = mocks.change!
    change('vendor:review'); change('vendor:review')
    expect(state.setAcpAgentMode).toHaveBeenCalledTimes(1)
    finish({ ok: false, error: '保存失败' })
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith('切换模式失败：保存失败'))
    change('vendor:review')
    expect(state.setAcpAgentMode).toHaveBeenCalledTimes(2)
    finish({ ok: true })
  })

  it('同候选项换模型或会话也更换组件标识，丢弃旧保存状态', () => {
    const state = app()
    const first = AcpModePill({ app: state })!.key
    state.conversations[0] = { ...state.conversations[0], modelId: 'other-model' }
    const second = AcpModePill({ app: state })!.key
    expect(second).not.toBe(first)
    state.activeConversationId = 'other-conv'
    state.conversations[0] = { ...state.conversations[0], id: 'other-conv' }
    expect(AcpModePill({ app: state })!.key).not.toBe(second)
  })
})
