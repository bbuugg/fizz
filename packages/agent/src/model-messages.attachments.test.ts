/**
 * 附件投递（内联 base64 / 省略）在消息组装层的规则。
 *
 * 防四个回归：
 *
 * 1. **缺少附件读取器时回退 URL**：只接受已内联的 base64，绝不让模型抓取外部地址。
 * 2. **内联把形状写错**：`ImagePart.image` 要吃字节、`FilePart.data` 要吃字节，
 *    写成别的字段名不会报错，只会被 AI SDK 静默丢掉（用户看到的是「图没发出去」）。
 * 3. **预算按「先到先得」扣**：逐条消息各规划一次的话，最旧的图先吃满预算、最新的被挤掉，
 *    与用户预期正好相反。必须是整轮从新到旧。
 * 4. **同一张图跨两次组装重复扣预算**：一轮里重建一次上下文就全被降级成说明了。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  attachmentParts,
  createInlineBudget,
  MAX_INLINE_TOTAL_BYTES,
  planAttachments,
  type ResolvedAttachment,
  type UploadLikeFile,
  toModelMessageGroups,
  toModelMessages
} from './model-messages'

const PIC = { url: '/api/uploads/a.png', mediaType: 'image/png', name: 'a.png' }
const PDF = { url: '/api/uploads/b.pdf', mediaType: 'application/pdf', name: 'b.pdf' }

const user = (parts: Array<{ type: 'text'; text: string } | { type: 'file'; url: string; mediaType: string; name: string }>) => ({
  role: 'user' as const,
  parts
})

describe('不传 resolveAttachment：不回退到 URL', () => {
  it('普通地址只生成附件读取失败说明', async () => {
    const messages = await toModelMessages([user([{ type: 'file', ...PIC }, { type: 'file', ...PDF }])])
    expect(messages[0].content).toContain('读取失败')
    expect(messages[0].content).not.toContain('/api/uploads/')
  })

  it('容器的 base64 图片与 PDF 解码为原始字节，不做 UTF-8 文本转换', async () => {
    const { parts } = await attachmentParts([
      { ...PIC, url: 'data:image/png;base64,AID/' },
      { ...PDF, url: 'data:application/pdf;base64,AID/' }
    ])
    expect(parts[0]).toMatchObject({ type: 'image', image: new Uint8Array([0, 128, 255]) })
    expect(parts[1]).toMatchObject({ type: 'file', data: new Uint8Array([0, 128, 255]), filename: 'b.pdf' })
  })

  it('读取器没有结果也不透传远程 URL', async () => {
    const result = await attachmentParts([{ ...PIC, url: 'https://cdn.example.com/a.png' }], {
      resolveAttachment: async () => undefined
    })
    expect(result.parts).toEqual([])
    expect(result.notes.join()).toContain('读取失败')
  })
})

describe('按原始消息分组转换', () => {
  it('一次批量转换仍保留每条原始消息的 token 估算边界', async () => {
    const history = [
      user([{ type: 'text', text: 'hello' }]),
      {
        role: 'assistant' as const,
        parts: [
          {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'read',
            input: { path: 'a.ts' },
            output: 'contents'
          }
        ]
      }
    ]
    const groups = await toModelMessageGroups(history)

    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual([{ role: 'user', content: 'hello' }])
    expect(groups[1]?.map((message) => message.role)).toEqual(['assistant', 'tool'])
    expect(groups.flat()).toEqual(await toModelMessages(history))
  })
})

describe('内联 / 省略的形状', () => {
  it('已提取文档进入原生文本 part，历史里仍是文件引用', async () => {
    const history = [user([{ type: 'file', url: '/api/uploads/a.docx', name: 'a.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }])]
    const original = structuredClone(history)
    const messages = await toModelMessages(history, {
      resolveAttachment: async () => ({ kind: 'text', text: '【文档 a.docx】\n正文' })
    })
    expect(messages[0].content).toEqual([{ type: 'text', text: '【文档 a.docx】\n正文' }])
    expect(history).toEqual(original)
  })
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
  it('文档文字也受整轮预算限制，保留最新的文档，重建时不重复扣账', async () => {
    const files = ['old', 'new'].map((name) => ({ name: `${name}.txt`, url: `/api/uploads/${name}.txt`, mediaType: 'text/plain' }))
    const budget = createInlineBudget()
    const resolveAttachment = async (): Promise<ResolvedAttachment> => ({ kind: 'text', text: '文'.repeat(60_000) })
    const result = await planAttachments(files, { resolveAttachment, budget })
    expect(result[0].resolved).toMatchObject({ kind: 'omit', note: expect.stringContaining('文档文字上限') })
    expect(result[1].resolved.kind).toBe('text')
    expect(budget.remainingTextChars).toBe(40_000)
    await planAttachments([files[1]], { resolveAttachment, budget })
    expect(budget.remainingTextChars).toBe(40_000)
    expect(budget.remainingBytes).toBe(MAX_INLINE_TOTAL_BYTES - 180_000)
  })

  it('重复附件在读取前去重，读取过程串行且从最新开始', async () => {
    let active = 0
    let peak = 0
    const resolver = vi.fn(async (_file: UploadLikeFile): Promise<ResolvedAttachment> => {
      peak = Math.max(peak, ++active)
      await Promise.resolve()
      active--
      return { kind: 'text', text: '正文' }
    })
    await planAttachments([PIC, PDF, PIC], { resolveAttachment: resolver, budget: createInlineBudget() })
    expect(peak).toBe(1)
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(resolver.mock.calls.map(([file]) => file.url)).toEqual([PIC.url, PDF.url])
  })
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

  it('同一 URL 在历史重复出现时只内联一次，避免重复字节绕过预算', async () => {
    const budget = createInlineBudget(15 * 1024 * 1024)
    const history = [
      user([{ type: 'file', ...PIC }]),
      user([{ type: 'file', ...PIC }])
    ]
    const messages = await toModelMessages(history, {
      resolveAttachment: async () => ({ kind: 'inline', bytes: new Uint8Array(10 * 1024 * 1024) }),
      inlineBudget: budget
    })

    const inlineParts = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as Array<Record<string, unknown>>).filter((part) => part.type === 'image')
        : []
    )
    expect(inlineParts).toHaveLength(1)
    expect(String(messages[0]?.content)).toContain('重复附件')
    expect(budget.remainingBytes).toBe(5 * 1024 * 1024)
  })

  it('插话不能再次内联本轮已发送的同一 URL', async () => {
    const budget = createInlineBudget(15 * 1024 * 1024)
    await toModelMessages([user([{ type: 'file', ...PIC }])], {
      resolveAttachment: async () => ({ kind: 'inline', bytes: new Uint8Array(10 * 1024 * 1024) }),
      inlineBudget: budget
    })
    const { parts, notes } = await attachmentParts([PIC], {
      resolveAttachment: async () => ({ kind: 'inline', bytes: new Uint8Array(10 * 1024 * 1024) }),
      budget,
      omitCounted: true
    })

    expect(parts).toHaveLength(0)
    expect(notes.join(' ')).toContain('重复附件')
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
