/**
 * 子 Agent 过程记录的回归守卫。
 *
 * 防的是「子 Agent 面板又退回一问一答两段纯文本」：累积 / 折叠 / 裁剪三件事任何一件
 * 写岔，工具卡和思考条就在界面上消失，而单测以外很难发现（面板里照样有内容）。
 */
import { describe, expect, it } from 'vitest'
import type { AgentMessagePart } from '@fizz/contracts/types'
import {
  appendPartDelta,
  appendToolCall,
  foldToolResult,
  trimCollabParts
} from './collab-parts'

describe('appendPartDelta', () => {
  it('同类型的相邻增量合并成一段', () => {
    const parts: AgentMessagePart[] = []
    appendPartDelta(parts, 'text', '你好')
    appendPartDelta(parts, 'text', '，世界')
    expect(parts).toEqual([{ type: 'text', text: '你好，世界' }])
  })

  /**
   * 防的回归：思考与正文**交替**流（ACP 侧常见，`[思考两字][正文三字]…`）时又变回
   * 「一段一个 part」。碎片化后渲染端会把每段思考各包一个「思考过程」分组，一段话被拆成
   * 十几个段落；整轮结束后除最后一小段正文，其余全被收进折叠条。
   */
  it('思考 / 正文来回切换时不拆碎，各自收成一条', () => {
    const parts: AgentMessagePart[] = []
    appendPartDelta(parts, 'text', '正')
    appendPartDelta(parts, 'reasoning', '想')
    appendPartDelta(parts, 'text', '文')
    appendPartDelta(parts, 'reasoning', '一')
    appendPartDelta(parts, 'text', '接着写')
    expect(parts).toEqual([
      { type: 'text', text: '正文接着写' },
      { type: 'reasoning', text: '想一' }
    ])
  })

  it('工具调用是边界：跨过工具卡就另起一段', () => {
    const parts: AgentMessagePart[] = []
    appendPartDelta(parts, 'text', '动手前')
    appendToolCall(parts, { toolCallId: 'c1', toolName: 'read_file', input: {} })
    appendPartDelta(parts, 'text', '看到了')
    expect(parts.map((part) => part.type)).toEqual(['text', 'tool-call', 'text'])
  })

  it('错误块是边界：正文不会并进「⚠️ …」里', () => {
    const parts: AgentMessagePart[] = [{ type: 'text', text: '⚠️ 上游 500' }]
    appendPartDelta(parts, 'text', '正文')
    expect(parts).toEqual([
      { type: 'text', text: '⚠️ 上游 500' },
      { type: 'text', text: '正文' }
    ])
  })
})

describe('工具结果折叠', () => {
  it('结果回填到同一次调用上，不单起一条结果', () => {
    const parts: AgentMessagePart[] = []
    appendToolCall(parts, { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.ts' } })
    foldToolResult(parts, { toolCallId: 'c1', output: 'file body' })
    expect(parts).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'read_file',
        input: { path: 'a.ts' },
        output: 'file body'
      }
    ])
  })

  it('失败标记一起回填', () => {
    const parts: AgentMessagePart[] = []
    appendToolCall(parts, { toolCallId: 'c1', toolName: 'execute_command', input: 'pnpm test' })
    foldToolResult(parts, { toolCallId: 'c1', output: 'boom', isError: true })
    const part = parts[0]
    expect(part && part.type === 'tool-call' && part.isError).toBe(true)
  })

  it('找不到对应调用时整条丢弃（结果单独飘着没有意义）', () => {
    const parts: AgentMessagePart[] = []
    foldToolResult(parts, { toolCallId: 'ghost', output: 'x' })
    expect(parts).toEqual([])
  })
})

describe('trimCollabParts', () => {
  it('没超预算时原样返回', () => {
    const parts: AgentMessagePart[] = [{ type: 'text', text: '短' }]
    expect(trimCollabParts(parts)).toEqual(parts)
  })

  it('超预算时丢最早的几步，只留一句提示', () => {
    const parts: AgentMessagePart[] = []
    for (let index = 0; index < 20; index += 1) {
      parts.push({ type: 'text', text: `第 ${index} 步${'x'.repeat(2000)}` })
    }
    const kept = trimCollabParts(parts)
    expect(kept[0]).toEqual({ type: 'text', text: '（更早的过程已省略）' })
    expect(kept.length).toBeLessThan(parts.length)
    const last = kept[kept.length - 1]
    expect(last && last.type === 'text' && last.text.startsWith('第 19 步')).toBe(true)
  })

  it('单条就超预算时仍然保留（截断，而不是全丢）', () => {
    const kept = trimCollabParts([{ type: 'text', text: 'y'.repeat(50_000) }])
    expect(kept).toHaveLength(1)
    const only = kept[0]
    expect(only && only.type === 'text' && only.text.length).toBeLessThan(10_000)
  })
})
