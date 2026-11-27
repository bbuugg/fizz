/** 防止公网部署、旧环境变量或历史插件附件让模型重新收到远程 URL；所有文件只以内联字节投递。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAttachmentResolver } from './attachments'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  adapterFor: vi.fn()
}))
vi.mock('./adapters', () => ({ adapterFor: mocks.adapterFor }))

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue({ mediaType: 'image/png', bytes: new Uint8Array([0, 128, 255]) })
  mocks.adapterFor.mockReset().mockReturnValue({ get: mocks.get, resolveModelUrl: () => 'https://public.example/image.png' })
})
afterEach(() => vi.unstubAllEnvs())

describe('createAttachmentResolver：仅内联附件', () => {
  const file = { url: '/api/uploads/00000000-0000-4000-8000-000000000000.png', mediaType: 'image/png', name: 'a.png' }

  it('文本文档转成具名文本，不能把文件字节作为原生 file 发给模型', async () => {
    mocks.get.mockResolvedValue({ mediaType: 'text/markdown', bytes: Buffer.from('# 文档\n内容') })
    expect(await createAttachmentResolver()({ ...file, name: 'notes.md', mediaType: 'text/markdown' }))
      .toMatchObject({ kind: 'text', text: expect.stringContaining('# 文档\n内容') })
  })

  it('无法解析的文档给出说明，不终止整轮、不回退到二进制', async () => {
    mocks.get.mockResolvedValue({ mediaType: 'text/plain', bytes: new Uint8Array([0, 128, 255]) })
    expect(await createAttachmentResolver()({ ...file, name: 'bad.txt', mediaType: 'text/plain' }))
      .toMatchObject({ kind: 'omit', note: expect.stringContaining('UTF-8') })
  })

  it('公网部署和旧 URL 模式配置也必须读回字节', async () => {
    vi.stubEnv('FIZZ_PUBLIC_BASE_URL', 'https://fizz.example.com')
    vi.stubEnv('FIZZ_ATTACHMENT_DELIVERY', 'url')
    expect(await createAttachmentResolver()(file)).toEqual({ kind: 'inline', bytes: new Uint8Array([0, 128, 255]) })
    expect(mocks.get).toHaveBeenCalledWith(file.url)
  })

  it('PDF 同样内联', async () => {
    expect((await createAttachmentResolver()({ ...file, mediaType: 'application/pdf', name: 'a.pdf' }))?.kind).toBe('inline')
  })

  it.each(['missing', 'error', 'empty', 'oversized'])('读取失败（%s）时给出说明，不退回 URL', async (failure) => {
    if (failure === 'missing') mocks.get.mockResolvedValue(null)
    if (failure === 'error') mocks.get.mockRejectedValue(new Error('read failed'))
    if (failure === 'empty') mocks.get.mockResolvedValue({ bytes: new Uint8Array() })
    if (failure === 'oversized') mocks.get.mockResolvedValue({ bytes: new Uint8Array(5 * 1024 * 1024 + 1) })
    const result = await createAttachmentResolver()(file)
    expect(result).toMatchObject({ kind: 'omit', note: expect.stringContaining(file.name) })
  })

  it('历史插件 / 第三方地址不再透传给模型', async () => {
    mocks.adapterFor.mockReturnValue(null)
    expect(await createAttachmentResolver()({ ...file, url: 'https://cdn.example.com/x.png' })).toMatchObject({ kind: 'omit' })
    expect(mocks.get).not.toHaveBeenCalled()
  })
})
