/**
 * 这条测试在防什么回归：**轮前压缩结束后，状态槽不能是 invisible 占位**。
 *
 * 旧实现按「空 parts 但挂了压缩卡」把状态行排除掉，于是压缩摘要一写完、模型第一步
 * 还没吐字的整段时间里界面什么提示都没有 —— 用户看到的是「摘要结束 → 静默等待 →
 * 突然开始干活」。压缩卡只在 `status === 'streaming'` 时自己转圈；`done` 之后的
 * 空 parts 就是在等模型。
 */
import { describe, expect, it } from 'vitest'
import type { AgentMessagePart } from '@fizz/contracts/types'
import type { ContextCompactionState } from './stores/slices/conversation'
import { waitingIndicatorSlot } from './waiting-indicator'

function compaction(status: ContextCompactionState['status']): ContextCompactionState {
  return { status, text: '', phase: null, updatedAt: 0 }
}

const text = (value = '你好'): AgentMessagePart => ({ type: 'text', text: value })
const reasoning = (value = '想一想'): AgentMessagePart => ({ type: 'reasoning', text: value })
const toolOnce = (output?: string): AgentMessagePart => ({
  type: 'tool-call',
  toolCallId: 'call-1',
  toolName: 'read',
  input: {},
  ...(output === undefined ? {} : { output })
})

describe('waitingIndicatorSlot', () => {
  it('压缩摘要还在流：槽位整个不挂（卡自己转圈）', () => {
    expect(waitingIndicatorSlot([], compaction('streaming'))).toBe('hidden')
  })

  it('压缩已完成、本轮还没有任何 part：显示状态行（旧实现这里藏成了占位）', () => {
    expect(waitingIndicatorSlot([], compaction('done'))).toBe('status')
  })

  it('没有压缩、本轮还没有任何 part：显示状态行', () => {
    expect(waitingIndicatorSlot([], null)).toBe('status')
  })

  it('尾段正文：不补状态行，只占位撑高度', () => {
    expect(waitingIndicatorSlot([text()], compaction('done'))).toBe('placeholder')
  })

  it('尾段思考：思考条自己在闪，不补状态行', () => {
    expect(waitingIndicatorSlot([reasoning()], null)).toBe('placeholder')
  })

  it('尾段工具还没出结果：卡片是 Running，不补状态行', () => {
    expect(waitingIndicatorSlot([toolOnce()], null)).toBe('placeholder')
  })

  it('尾段工具已出结果：这一步落地了，显示状态行', () => {
    expect(waitingIndicatorSlot([toolOnce('done')], null)).toBe('status')
  })
})
