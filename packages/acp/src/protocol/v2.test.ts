/**
 * 防回归：v2 的 `agent_message` / `agent_thought` 是**整条替换**（带 messageId），
 * 不是增量。直接当 chunk 下发会把已显示的文字再发一遍（界面重复段落）。
 *
 * 这里锁定「按 messageId 记住上一次全文、只发新增部分」的行为。
 */
import { describe, expect, it } from 'vitest'
import { V2UpdateNormalizer } from './v2'

function textOfUpdate(update: ReturnType<V2UpdateNormalizer['normalize']>): string {
  const content = (update as { content?: { text?: string } } | null)?.content
  return typeof content?.text === 'string' ? content.text : ''
}

describe('V2UpdateNormalizer', () => {
  it('agent_message 整条重发时只发新增的尾巴', () => {
    const n = new V2UpdateNormalizer()
    const first = n.normalize({
      sessionUpdate: 'agent_message',
      messageId: 'm1',
      content: [{ type: 'text', text: 'Hel' }],
    })
    expect(first?.sessionUpdate).toBe('agent_message_chunk')
    expect(textOfUpdate(first)).toBe('Hel')

    const second = n.normalize({
      sessionUpdate: 'agent_message',
      messageId: 'm1',
      content: [{ type: 'text', text: 'Hello' }],
    })
    expect(textOfUpdate(second)).toBe('lo')

    // 没有新增（同一份全文又发一次）→ 不占一条消息
    expect(
      n.normalize({
        sessionUpdate: 'agent_message',
        messageId: 'm1',
        content: [{ type: 'text', text: 'Hello' }],
      }),
    ).toBeNull()
  })

  it('不同 messageId 各自独立计数', () => {
    const n = new V2UpdateNormalizer()
    n.normalize({
      sessionUpdate: 'agent_message',
      messageId: 'm1',
      content: [{ type: 'text', text: 'A' }],
    })
    const other = n.normalize({
      sessionUpdate: 'agent_message',
      messageId: 'm2',
      content: [{ type: 'text', text: 'B' }],
    })
    expect(textOfUpdate(other)).toBe('B')
  })

  it('增量型的 *_chunk 原样透传', () => {
    const n = new V2UpdateNormalizer()
    const raw = {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'x' },
    }
    expect(n.normalize(raw)).toBe(raw)
  })
})
