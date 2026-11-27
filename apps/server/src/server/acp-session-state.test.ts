/** 防回归：模型换档清除已失效的思考档，未知配置不误清，空闲通知也要持久化且不串会话。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpModesState, AcpThoughtLevelState } from '@fizz/contracts/types'

const mock = vi.hoisted(() => ({
  snapshot: vi.fn(), listen: vi.fn(), getConversation: vi.fn(), save: vi.fn()
}))
vi.mock('@fizz/acp', () => ({ getAcpSessionSnapshot: mock.snapshot, setAcpSessionConfigListener: mock.listen }))
vi.mock('@/lib/server/state', () => ({ domain: { getConversation: mock.getConversation, setAcpSessionState: mock.save } }))
import { mergeAcpModes, mergeAcpThoughtLevel, refreshAcpSessionState } from './acp-session-state'

const thought = (values = ['low', 'high'], current = values[0]): AcpThoughtLevelState => ({
  configId: 'effort', current, options: values.map((value) => ({ value, name: value }))
})
beforeEach(() => {
  vi.clearAllMocks()
  mock.getConversation.mockReturnValue({ id: 'conv', backend: 'acp', configId: 'agent', acpThoughtLevel: thought(['low', 'high'], 'high') })
})

describe('ACP 配置快照合并', () => {
  it('原档仍有效时保留用户选择；失效时采用新模型当前档', () => {
    expect(mergeAcpThoughtLevel(thought(['low', 'high'], 'high'), thought())?.current).toBe('high')
    expect(mergeAcpThoughtLevel(thought(['low', 'high'], 'high'), thought(['medium', 'max']))?.current).toBe('medium')
  })
  it('没收到完整配置与完整配置明确缺项是两种状态', () => {
    const prev = thought()
    expect(mergeAcpThoughtLevel(prev, null)).toBe(prev)
    expect(mergeAcpThoughtLevel(prev, null, true)).toBeUndefined()
    const mode: AcpModesState = { configId: 'mode', available: [{ id: 'build' }], current: 'build' }
    expect(mergeAcpModes(mode, null, true)).toBeUndefined()
  })
  it('完整配置没有思考档时显式清除落盘旧值，并订阅后续通知', () => {
    mock.snapshot.mockReturnValue({ modes: null, thoughtLevel: null, configOptionsKnown: true })
    refreshAcpSessionState('conv', 'agent')
    expect(mock.save).toHaveBeenCalledWith('conv', { acpThoughtLevel: null })
    expect(mock.listen).toHaveBeenCalledWith('agent', 'conv', expect.any(Function))
    mock.snapshot.mockReturnValue({ modes: null, thoughtLevel: thought(['medium', 'max']), configOptionsKnown: true })
    mock.listen.mock.calls[0][2]()
    expect(mock.save).toHaveBeenLastCalledWith('conv', { acpThoughtLevel: thought(['medium', 'max']) })
  })
  it('未知配置保留旧值，错误 agent 的通知不能写入此会话', () => {
    mock.snapshot.mockReturnValue({ modes: null, thoughtLevel: null, configOptionsKnown: false })
    refreshAcpSessionState('conv', 'agent')
    expect(mock.save).toHaveBeenCalledWith('conv', { acpThoughtLevel: thought(['low', 'high'], 'high') })
    mock.save.mockClear()
    refreshAcpSessionState('conv', 'different-agent')
    expect(mock.save).not.toHaveBeenCalled()
  })
})
