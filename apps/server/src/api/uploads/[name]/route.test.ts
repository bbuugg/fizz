/** 防止新文档无法下载、返回错误 MIME，或以同源 HTML 方式打开用户上传的文本。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, HEAD } from './route'
import { UPLOAD_EXT_BY_MIME } from '@fizz/contracts/agent-api'

const mocks = vi.hoisted(() => ({ stat: vi.fn(), mediaResponse: vi.fn() }))
vi.mock('node:fs', () => ({ promises: { stat: mocks.stat } }))
vi.mock('@fizz/workspace', () => ({ resolveDataDir: () => '/test-data' }))
vi.mock('@/app/api/_lib/auth', () => ({ jsonError: (status: number, error: string) => Response.json({ error }, { status }) }))
vi.mock('@/lib/server/lib/media', () => ({ mediaResponse: mocks.mediaResponse }))

beforeEach(() => {
  mocks.stat.mockReset().mockResolvedValue({ isFile: () => true, size: 123 })
  mocks.mediaResponse.mockReset().mockImplementation((_abs, mime, _size, _range, method) =>
    new Response(method === 'HEAD' ? null : 'file', { headers: { 'content-type': mime, 'content-disposition': 'inline' } }))
})

const prefix = '00000000-0000-4000-8000-000000000000'
describe('附件下载', () => {
  it.each(Object.entries(UPLOAD_EXT_BY_MIME))('%s 能以正确类型取回，文本类文档强制下载', async (mime, ext) => {
    const response = await GET(new Request(`http://localhost/api/uploads/${prefix}.${ext}`), { params: Promise.resolve({ name: `${prefix}.${ext}` }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(mime)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toContain(mime.startsWith('image/') || mime === 'application/pdf' ? 'inline' : 'attachment')
  })

  it.each([`${prefix}.html`, `${prefix}.svg`, `${prefix}.constructor`, '../secret.txt'])('拒绝未支持的文件名 %s', async (name) => {
    const response = await GET(new Request('http://localhost/api/uploads/file'), { params: Promise.resolve({ name }) })
    expect(response.status).toBe(400)
    expect(mocks.stat).not.toHaveBeenCalled()
  })

  it('HEAD 保留下载响应头和方法，不读正文', async () => {
    const response = await HEAD(new Request('http://localhost/file', { method: 'HEAD' }), { params: Promise.resolve({ name: `${prefix}.docx` }) })
    expect(await response.text()).toBe('')
    expect(mocks.mediaResponse.mock.calls[0][4]).toBe('HEAD')
    expect(response.headers.get('content-disposition')).toContain('attachment')
  })
})
