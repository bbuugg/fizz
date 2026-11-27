// 防止上传接口退回 URL / 插件投递，或在非法 base64、超限与取消时残留附件文件。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UPLOAD_MAX_BYTES } from '@fizz/contracts/agent-api'
import { POST } from './route'
import { createZip } from '../../server/lib/zip'

const mocks = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/server/upload/index', () => ({ resolveUploadAdapter: () => mocks }))
vi.mock('@/lib/server/upload/documents', () => import('../../server/upload/documents'))
vi.mock('@/app/api/_lib/auth', () => ({
  jsonError: (status: number, error: string) => Response.json({ error }, { status })
}))

const payload = { name: 'image.png', mediaType: 'image/png', dataBase64: 'AID/' }

function request(body: unknown = payload, signal?: AbortSignal): Request {
  return new Request('http://localhost/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.put.mockResolvedValue({ url: '/api/uploads/image.png' })
  mocks.remove.mockResolvedValue(undefined)
})

describe('JSON + base64 附件上传', () => {
  it.each([
    ['notes.md', '', 'text/markdown'],
    ['table.csv', 'application/vnd.ms-excel', 'text/csv'],
    ['data.json', 'application/json', 'application/json']
  ])('上传文档 %s 时返回归一化 MIME 并保留原始字节', async (name, mediaType, expected) => {
    const bytes = Buffer.from('你好, world')
    const response = await POST(request({ name, mediaType, dataBase64: bytes.toString('base64') }))
    expect(response.status).toBe(200)
    expect(mocks.put.mock.calls[0][0]).toMatchObject({ name, mediaType: expected, bytes: new Uint8Array(bytes) })
    expect(await response.json()).toMatchObject({ mediaType: expected, size: bytes.length })
  })

  it('DOCX 仍保存原始文件，同时返回仅提取文字的提示', async () => {
    const bytes = createZip([{ name: 'word/document.xml', data: Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>') }])
    const response = await POST(request({ name: 'report.docx', mediaType: 'application/zip', dataBase64: bytes.toString('base64') }))
    expect(response.status).toBe(200)
    expect(mocks.put.mock.calls[0][0].bytes).toEqual(new Uint8Array(bytes))
    expect(await response.json()).toMatchObject({ warnings: [expect.stringContaining('不含图片')] })
  })

  it('长文档上传成功时明确提示截断，而不是在发送时悄悄丢掉后半段', async () => {
    const response = await POST(request({ name: 'long.txt', mediaType: 'text/plain', dataBase64: Buffer.from('a'.repeat(32_001)).toString('base64') }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ warnings: [expect.stringContaining('已截断')] })
  })

  it.each([
    ['broken.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'not a zip'],
    ['empty.txt', 'text/plain', ' \n '],
    ['binary.txt', 'text/plain', '\0binary']
  ])('非法文档 %s 在落盘前拒绝', async (name, mediaType, text) => {
    const response = await POST(request({ name, mediaType, dataBase64: Buffer.from(text).toString('base64') }))
    expect(response.status).toBe(400)
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it('将原始二进制交给内置存储，返回本地引用且不暴露上传源', async () => {
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(mocks.put.mock.calls[0]![0]).toMatchObject({
      name: 'image.png', mediaType: 'image/png', bytes: new Uint8Array([0, 128, 255])
    })
    expect(await res.json()).toEqual({ url: '/api/uploads/image.png', name: 'image.png', mediaType: 'image/png', size: 3 })
  })

  it.each([
    null,
    { ...payload, name: '../image.png' },
    { ...payload, mediaType: 'image/svg+xml' },
    { name: 'image.png', mediaType: 'image/png', url: 'https://cdn.example/image.png' },
    { ...payload, dataBase64: 'data:image/png;base64,AID/' },
    { ...payload, dataBase64: 'AB==' },
    { ...payload, dataBase64: '' }
  ])('拒绝非法请求且不落盘：%j', async (body) => {
    expect((await POST(request(body))).status).toBe(400)
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it('在解码前拒绝超过上传上限的 base64', async () => {
    const dataBase64 = 'A'.repeat(Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 4)
    expect((await POST(request({ ...payload, dataBase64 }))).status).toBe(400)
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it('拒绝 multipart 和损坏的 JSON', async () => {
    const multipart = new Request('http://localhost/api/uploads', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data' }, body: 'content'
    })
    expect((await POST(multipart)).status).toBe(400)
    const invalid = new Request('http://localhost/api/uploads', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{'
    })
    expect((await POST(invalid)).status).toBe(400)
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it('取消发生在写入完成后时，等文件清理完才返回', async () => {
    const controller = new AbortController()
    mocks.put.mockImplementation(async () => {
      controller.abort()
      return { url: '/api/uploads/cancelled.png' }
    })
    const res = await POST(request(payload, controller.signal))
    expect(res.status).toBe(499)
    expect(mocks.remove).toHaveBeenCalledWith('/api/uploads/cancelled.png')
  })
})
