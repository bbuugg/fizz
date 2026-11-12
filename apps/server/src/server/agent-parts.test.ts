/**
 * `foldEventIntoParts` 对**多模态输出**（`file-part`）的折叠。
 *
 * 这是服务端的落盘形状（ACP 快照也走它）。防的回归：agent 回传的图片只在 SSE 上
 * 闪一下、进了快照就没了 —— 表现为「对话时能看到图，切走再切回来图消失」。
 * 另外钉住「图片是位置性的，文本不能跨过它合并」这条（与 `appendPartDelta` 同一口径）。
 */
import { describe, expect, it } from 'vitest'
import type { AgentMessagePart } from '@fizz/contracts/types'
import { foldEventIntoParts } from './agent-parts'

const imageEvent = {
  type: 'file-part' as const,
  url: 'data:image/png;base64,AAAA',
  mediaType: 'image/png',
  name: 'image.png',
}

describe('foldEventIntoParts：agent 回传图片', () => {
  it('file-part 折成 file part（与用户附件同形）', () => {
    const parts: AgentMessagePart[] = []
    foldEventIntoParts(parts, imageEvent)
    expect(parts).toEqual([
      { type: 'file', name: 'image.png', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
    ])
  })

  it('图片之后的文本另起一段，图片位置不被前移', () => {
    const parts: AgentMessagePart[] = []
    foldEventIntoParts(parts, { type: 'text-delta', delta: '截图：' })
    foldEventIntoParts(parts, imageEvent)
    foldEventIntoParts(parts, { type: 'text-delta', delta: '看到了' })
    expect(parts.map((part) => part.type)).toEqual(['text', 'file', 'text'])
    expect(parts[0]).toMatchObject({ type: 'text', text: '截图：' })
  })
})
