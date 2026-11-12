/**
 * `appendPartDelta` 的合并边界。
 *
 * 这是在防一条**肉眼很难发现**的错位：文本增量合并时从尾部往前找「最近一条同类
 * part」，若允许跨过 `file` 继续找，图片之后的正文会被并进图片**前面**那段文本里，
 * 渲染出来就是「先说完话，图又跑到开头」（ACP agent 回传图片后才出现的路径）。
 */
import { describe, expect, it } from 'vitest'
import type { AgentMessagePart } from './types'
import { appendPartDelta } from './types'

const image: AgentMessagePart = {
  type: 'file',
  name: 'image.png',
  mediaType: 'image/png',
  url: 'data:image/png;base64,AAAA',
}

describe('appendPartDelta', () => {
  it('相邻文本合并成一段（基础行为不能回归）', () => {
    const parts: AgentMessagePart[] = [{ type: 'text', text: 'a' }]
    appendPartDelta(parts, 'text', 'b')
    expect(parts).toEqual([{ type: 'text', text: 'ab' }])
  })

  it('file 是分段点：图片之后的文本另起一段', () => {
    const parts: AgentMessagePart[] = [
      { type: 'text', text: '这是截图：' },
      image,
    ]
    appendPartDelta(parts, 'text', '请看第二张')
    expect(parts).toEqual([
      { type: 'text', text: '这是截图：' },
      image,
      { type: 'text', text: '请看第二张' },
    ])
  })

  it('思考也停在同一处分段（reasoning 不会跨过图片）', () => {
    const parts: AgentMessagePart[] = [{ type: 'reasoning', text: '想' }, image]
    appendPartDelta(parts, 'reasoning', '继续想')
    expect(parts).toEqual([{ type: 'reasoning', text: '想' }, image, { type: 'reasoning', text: '继续想' }])
  })

  it('空增量不新建 part', () => {
    const parts: AgentMessagePart[] = []
    appendPartDelta(parts, 'text', '')
    expect(parts).toEqual([])
  })
})
