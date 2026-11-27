// 防止容器拿到宿主 localhost / 外部附件 URL，或把 base64 请求副本写回原始历史。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatMessage } from '@fizz/contracts/types'
import { toModelMessages } from '@fizz/agent'
import { inlineAttachments } from './attachments'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../upload/adapters', () => ({
  adapterFor: (url: string) => url.startsWith('/api/uploads/') ? { get: mocks.get } : null
}))

function message(id: string, url = `/api/uploads/${id}.png`): AgentChatMessage {
  return {
    id,
    role: 'user',
    createdAt: 1,
    parts: [{ type: 'file', url, name: `${id}.png`, mediaType: 'image/png' }]
  }
}

beforeEach(() => mocks.get.mockReset())

describe('容器附件内联', () => {
  it('文档在宿主提取为文本，容器不用解析 DOCX，落盘历史仍保留文件引用', async () => {
    mocks.get.mockResolvedValue({ mediaType: 'text/plain', bytes: Buffer.from('文档内容') })
    const history = [message('document')]
    history[0].parts[0] = { type: 'file', url: '/api/uploads/document.txt', name: 'document.txt', mediaType: 'text/plain' }
    const original = structuredClone(history)
    const inline = await inlineAttachments(history)
    expect(history).toEqual(original)
    expect(inline[0].parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('文档内容') })
    expect(JSON.stringify(inline)).not.toContain('/api/uploads/')
    const model = await toModelMessages(inline)
    expect(model[0].content).toContain('文档内容')
  })
  it('保持原始历史，容器无需 resolver 也能将 base64 还原为图片字节', async () => {
    mocks.get.mockResolvedValue({ mediaType: 'image/png', bytes: new Uint8Array([0, 128, 255]) })
    const history = [message('image')]
    const original = structuredClone(history)
    const inline = await inlineAttachments(history)
    expect(history).toEqual(original)
    expect(inline[0]!.parts[0]).toMatchObject({ url: 'data:image/png;base64,AID/' })
    const messages = await toModelMessages(inline)
    expect(messages[0]!.content).toEqual([
      { type: 'image', mediaType: 'image/png', image: new Uint8Array([0, 128, 255]) }
    ])
  })

  it('读取失败和历史外部地址改成说明，正文与工具过程保持原样', async () => {
    mocks.get.mockResolvedValue(null)
    const history = [message('missing'), message('external', 'https://cdn.example/a.png')]
    history[0]!.parts.push({ type: 'text', text: '请看附件' })
    const assistant: AgentChatMessage = {
      id: 'assistant', role: 'assistant', createdAt: 2,
      parts: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: {}, output: 'ok' }]
    }
    const inline = await inlineAttachments([...history, assistant])
    expect(inline.slice(0, 2).every((item) => item.parts[0]?.type === 'text')).toBe(true)
    expect(inline[0]!.parts[1]).toEqual({ type: 'text', text: '请看附件' })
    expect(inline[2]).toEqual(assistant)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(inline)).not.toContain('https://cdn.example')
  })

  it('复用 15MB 整轮预算，优先保留最新附件', async () => {
    mocks.get.mockResolvedValue({ mediaType: 'image/png', bytes: new Uint8Array(5 * 1024 * 1024) })
    const inline = await inlineAttachments(['old', 'second', 'third', 'new'].map((id) => message(id)))
    expect(inline[0]!.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('本轮附件体积上限') })
    expect(inline.slice(1).every((item) => item.parts[0]?.type === 'file')).toBe(true)
  })
})
