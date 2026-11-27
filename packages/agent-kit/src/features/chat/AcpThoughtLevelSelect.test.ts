/**
 * 防回归：任何广告 thought_level 的 Agent 都**列成一排可点的档位**（内置模型那颗滑块不适用：
 * 外部 Agent 的档位没有「强度递增」语义）；原始值、草稿和会话状态不能混用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { Button } from '@fizz/ui/button'
import { AcpThoughtLevelSelect } from './AcpThoughtLevelSelect'

type ButtonProps = ComponentProps<typeof Button>
const mocks = vi.hoisted(() => ({ buttons: [] as ButtonProps[], error: vi.fn() }))
// 桩掉 Button：静态渲染拿不到 DOM，只能靠记下的 props 断言语义与触发点击
vi.mock('@fizz/ui/button', () => ({
  Button: (props: ButtonProps) => {
    mocks.buttons.push(props)
    return createElement(
      'button',
      { type: 'button', title: props.title, disabled: props.disabled },
      props.children
    )
  }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@fizz/agent-kit/shared/lib/language', () => ({ useT: () => (text: string) => text }))

const thought = {
  configId: 'vendor.config.effort', current: 'vendor:fast', options: [
    { value: 'vendor:deep', name: '深入', description: 'Agent 的原始说明' },
    { value: 'vendor:fast', name: '快速' },
  ],
}
function app(patch: Partial<AgentApp> = {}) {
  return {
    activeConversationId: 'conv',
    conversations: [{ id: 'conv', backend: 'acp', configId: 'agent', modelId: 'model', acpThoughtLevel: thought }],
    acpAgents: [{ id: 'agent', type: 'opencode' }],
    streaming: false, creatingConversation: false, acpConfigLoading: false,
    setAcpThoughtLevel: vi.fn(async () => ({ ok: true })),
    setDraftAcpThought: vi.fn(), setReasoningEffort: vi.fn(), ...patch,
  } as unknown as AgentApp
}
const render = (state: AgentApp) => renderToStaticMarkup(createElement(AcpThoughtLevelSelect, { app: state }))
/** 点第 `index` 个档位（生产代码的 onClick 不读事件对象） */
const click = (index: number) => mocks.buttons[index].onClick?.({} as never)

beforeEach(() => { mocks.buttons = []; mocks.error.mockClear() })

describe('ACP 思考档：一排可点的档位', () => {
  it.each(['pi', 'opencode', 'custom'])('%s 按能力显示，保留选项名称、原值和顺序', (type) => {
    const state = app()
    state.acpAgents[0].type = type as typeof state.acpAgents[0]['type']
    const html = render(state)
    expect(mocks.buttons).toHaveLength(thought.options.length)
    // 顺序 = agent 给的顺序；title 优先用 agent 的描述
    expect(mocks.buttons.map((button) => button.title)).toEqual(['Agent 的原始说明', '快速'])
    expect(html).toContain('深入')
    expect(html).toContain('快速')
    // 当前值是第二项，且只勾它
    expect(mocks.buttons[1]['aria-pressed']).toBe(true)
    expect(mocks.buttons[0]['aria-pressed']).toBe(false)
    click(0)
    expect(state.setAcpThoughtLevel).toHaveBeenCalledWith('agent', 'conv', 'vendor:deep')
    expect(state.setReasoningEffort).not.toHaveBeenCalled()
  })

  it('草稿先记选择，不向尚未创建的会话发请求', () => {
    const state = app({
      activeConversationId: null, conversations: [],
      chatTarget: { backend: 'acp', configId: 'agent', modelId: 'model' },
      draftAcp: { agentId: 'agent', modelId: 'model', loading: false, error: null, modes: null, mode: null, thoughtLevel: thought, thought: 'vendor:fast' },
    })
    render(state)
    click(0)
    expect(state.setDraftAcpThought).toHaveBeenCalledWith('vendor:deep')
    expect(state.setAcpThoughtLevel).not.toHaveBeenCalled()
  })

  it('生成期间禁用；别的标签正在建会话不会锁住本会话', () => {
    const state = app({ streaming: true })
    render(state)
    expect(mocks.buttons.map((button) => button.disabled)).toEqual([true, true])
    click(0)
    expect(state.setAcpThoughtLevel).not.toHaveBeenCalled()
    render(app({ creatingConversation: true }))
    expect(mocks.buttons.slice(-2).map((button) => button.disabled)).toEqual([false, false])
  })

  it('模型刷新中显示状态、失败显示错误，明确不支持则整个隐藏', () => {
    expect(render(app({ acpConfigLoading: true }))).toContain('role="status"')
    expect(mocks.buttons).toHaveLength(0)
    expect(render(app({ acpConfigError: '失败' }))).toContain('role="alert"')
    expect(mocks.buttons).toHaveLength(0)
    const state = app()
    state.conversations[0].acpThoughtLevel = undefined
    expect(render(state)).toBe('')
  })

  it('只展示当前模型的草稿探测结果', () => {
    const state = app({
      activeConversationId: null, conversations: [],
      chatTarget: { backend: 'acp', configId: 'agent', modelId: 'new-model' },
      draftAcp: { agentId: 'agent', modelId: 'old-model', loading: false, error: null, modes: null, mode: null, thoughtLevel: thought, thought: null },
    })
    expect(render(state)).toBe('')
  })

  it('正在保存时拒绝重复提交，失败会提示且允许重试', async () => {
    let finish!: (result: { ok: boolean; error?: string }) => void
    const state = app({ setAcpThoughtLevel: vi.fn(() => new Promise<{ ok: boolean; error?: string }>((done) => { finish = done })) })
    render(state)
    click(0)
    click(0)
    expect(state.setAcpThoughtLevel).toHaveBeenCalledTimes(1)
    finish({ ok: false, error: '失败' })
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
    click(0)
    expect(state.setAcpThoughtLevel).toHaveBeenCalledTimes(2)
    finish({ ok: true })
  })
})
