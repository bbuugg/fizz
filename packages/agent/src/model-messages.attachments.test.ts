/**
 * 附件投递（URL / 内联 base64 / 省略）在消息组装层的规则。
 *
 * 防四个回归：
 *
 * 1. **不传 `resolveAttachment` 就改行为**：老调用方（桌面端 / 容器）必须还是 URL 直传。
 * 2. **内联把形状写错**：`ImagePart.image` 要吃字节、`FilePart.data` 要吃字节，
 *    写成别的字段名不会报错，只会被 AI SDK 静默丢掉（用户看到的是「图没发出去」）。
 * 3. **预算按「先到先得」扣**：逐条消息各规划一次的话，最旧的图先吃满预算、最新的被挤掉，
 *    与用户预期正好相反。必须是整轮从新到旧。
 * 4. **同一张图跨两次组装重复扣预算**：一轮里重建一次上下文就全被降级成说明了。
 */
import { describe, expect, it } from 'vitest'
import {
  createInlineBudget,
  MAX_INLINE_TOTAL_BYTES,
  type ResolvedAttachment,
  toModelMessages
} from './model-messages'

const PIC = { url: '/api/uploads/a.png', mediaType: 'image/png', name: 'a.png' }
const PDF = { url: '/api/uploads/b.pdf', mediaType: 'application/pdf', name: 'b.pdf' }

const user = (parts: Array<{ type: 'text'; text: string } | { type: 'file'; url: string; mediaType: string; name: string }>) => ({
  role: 'user' as const,
  parts
})

describe('不传 resolveAttachment：仍是 URL 直传', () => {
  it('图片 / PDF 都拼成绝对地址交给 provider', async () => {
    const messages = await toModelMessages([user([{ type: 'file', ...PIC }, { type: 'file', ...PDF }])], {
      resolveFileUrl: (url) => `https://example.com${url}`
    })
    const content = messages[0].content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'image', mediaType: 'image/png' })
    expect(String(content[0].image)).toBe('https://example.com/api/uploads/a.png')
    expect(content[1]).toMatchObject({
      type: 'file',
      filename: 'b.pdf',
      mediaType: 'application/pdf'
    })
  })
})

describe('内联 / 省略的形状', () => {
  it('inline 走字节：图片进 image.image、PDF 进 file.data', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const messages = await toModelMessages(
      [user([{ type: 'file', ...PIC }, { type: 'file', ...PDF }])],
      { resolveAttachment: async () => ({ kind: 'inline', bytes }) }
    )
    const content = messages[0].content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'image', mediaType: 'image/png' })
    expect(content[0].image).toBe(bytes)
    expect(content[1]).toMatchObject({ type: 'file', filename: 'b.pdf' })
    expect(content[1].data).toBe(bytes)
  })

  it('omit 降级成一行说明，正文仍保留', async () => {
    const messages = await toModelMessages(
      [user([{ type: 'text', text: '这张图里是什么' }, { type: 'file', ...PIC }])],
      {
        resolveAttachment: async () => ({ kind: 'omit', note: '（附件「a.png」读取失败）' })
      }
    )
    expect(messages[0].content).toBe('这张图里是什么\n（附件「a.png」读取失败）')
  })

  it('resolveAttachment 抛错不炸整轮', async () => {
    const messages = await toModelMessages([user([{ type: 'file', ...PIC }])], {
      resolveAttachment: async () => {
        throw new Error('disk gone')
      }
    })
    expect(String(messages[0].content)).toContain('读取失败')
  })
})

describe('整轮内联预算', () => {
  const BIG = 10 * 1024 * 1024
  const inlineBig = async (): Promise<ResolvedAttachment> => ({
    kind: 'inline',
    bytes: new Uint8Array(BIG)
  })

  it('超限时牺牲最旧的，最新的照发', async () => {
    const budget = createInlineBudget(15 * 1024 * 1024)
    const messages = await toModelMessages(
      [
        user([{ type: 'file', url: '/api/uploads/old.png', mediaType: 'image/png', name: 'old.png' }]),
        user([{ type: 'file', url: '/api/uploads/new.png', mediaType: 'image/png', name: 'new.png' }])
      ],
      { resolveAttachment: inlineBig, inlineBudget: budget }
    )
    // 旧的那条：只剩一行说明（两张 10MB 塞不进 15MB）
    expect(String(messages[0].content)).toContain('超出本轮附件体积上限')
    // 新的那条：仍是 image part
    const content = messages[1].content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'image' })
    expect(budget.remainingBytes).toBe(15 * 1024 * 1024 - BIG)
  })

  it('同一张图跨两次组装只扣一次预算', async () => {
    const budget = createInlineBudget()
    const history = [user([{ type: 'file', ...PIC }])]
    const first = await toModelMessages(history, {
      resolveAttachment: async () => ({ kind: 'inline', bytes: new Uint8Array(10 * 1024 * 1024) }),
      inlineBudget: budget
    })
    const afterFirst = budget.remainingBytes
    const second = await toModelMessages(history, {
      resolveAttachment: async () => ({ kind: 'inline', bytes: new Uint8Array(10 * 1024 * 1024) }),
      inlineBudget: budget
    })
    expect(budget.remainingBytes).toBe(afterFirst)
    // 第二次组装不能因为「预算已被扣过」而把这张图降级掉
    expect((first[0].content as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'image' })
    expect((second[0].content as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'image' })
  })

  it('默认上限是 15MB', () => {
    expect(MAX_INLINE_TOTAL_BYTES).toBe(15 * 1024 * 1024)
    expect(createInlineBudget().remainingBytes).toBe(MAX_INLINE_TOTAL_BYTES)
  })
})

describe('模型不收图片', () => {
  it('图片被过滤成说明，PDF 照常内联', async () => {
    const messages = await toModelMessages(
      [user([{ type: 'file', ...PIC }, { type: 'file', ...PDF }])],
      {
        allowImages: false,
        resolveAttachment: async (f) =>
          f.mediaType === 'application/pdf'
            ? { kind: 'inline', bytes: new Uint8Array([1]) }
            : { kind: 'inline', bytes: new Uint8Array([2]) }
      }
    )
    const content = messages[0].content as Array<Record<string, unknown>>
    expect(content).toHaveLength(2)
    expect(content[0]).toMatchObject({ type: 'file', filename: 'b.pdf' })
    expect(content[1]).toMatchObject({ type: 'text' })
    expect(String(content[1].text)).toContain('未开启图片输入')
  })
})
