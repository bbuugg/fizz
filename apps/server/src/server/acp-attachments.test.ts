/**
 * ACP 会话的附件读取（`acpPromptAttachments`）。
 *
 * 这条测试在防的回归：
 * 1. **读不到就当没发**：非图片 / 插件源（只回 URL，本机没有字节）/ 读取失败 / 超限，
 *    必须落成一句说明交给 agent，而不是静默消失 —— 用户会以为图发出去了；
 * 2. 上限形同虚设：单张 5MB、整轮 10MB，超了就跳过并说明；
 * 3. 拿假媒体类型往上顶：以 adapter 回的 mimeType 为准（存储层才知道真实类型）。
 *
 * `adapterFor` 一律 mock：不碰真实数据目录（本仓测试边界）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UploadFileRef } from '@fizz/contracts/types'
import { acpPromptAttachments } from './acp-attachments'

const get = vi.fn()

vi.mock('./upload/adapters', () => ({
  // 内置存储：给 get；插件源（url 带 `plugin`）：没有 get，只有 URL
  adapterFor: (url: string) => (url.includes('plugin') ? {} : { get }),
}))

const file = (over: Partial<UploadFileRef> = {}): UploadFileRef => ({
  name: 'a.png',
  mediaType: 'image/png',
  url: '/api/uploads/a.png',
  ...over,
})

const bytes = (size: number): Uint8Array => new Uint8Array(size)

beforeEach(() => {
  get.mockReset()
})

describe('acpPromptAttachments', () => {
  it('图片读成字节，mimeType 以存储层回的为准', async () => {
    get.mockResolvedValue({ mediaType: 'image/jpeg', bytes: bytes(1024) })
    const out = await acpPromptAttachments([file()])
    expect(out.attachments).toHaveLength(1)
    expect(out.attachments[0]).toMatchObject({
      mediaType: 'image/jpeg',
      name: 'a.png',
    })
    expect(out.attachments[0].data.byteLength).toBe(1024)
    expect(out.note).toBeUndefined()
  })

  it('非图片不发送，但要有说明', async () => {
    const out = await acpPromptAttachments([file({ name: 'doc.pdf', mediaType: 'application/pdf' })])
    expect(out.attachments).toEqual([])
    expect(out.note).toContain('doc.pdf')
    expect(out.note).toContain('不是图片')
    expect(get).not.toHaveBeenCalled()
  })

  it('插件源保存的附件取不到字节 → 说明里点名', async () => {
    const out = await acpPromptAttachments([file({ url: 'https://plugin.example/x.png' })])
    expect(out.attachments).toEqual([])
    expect(out.note).toContain('插件源')
  })

  it('读取抛错也不炸这一轮', async () => {
    get.mockRejectedValue(new Error('EIO'))
    const out = await acpPromptAttachments([file()])
    expect(out.attachments).toEqual([])
    expect(out.note).toContain('读取失败')
  })

  it('单张超过 5MB 跳过', async () => {
    get.mockResolvedValue({ mediaType: 'image/png', bytes: bytes(5 * 1024 * 1024 + 1) })
    const out = await acpPromptAttachments([file()])
    expect(out.attachments).toEqual([])
    expect(out.note).toContain('超过 5MB')
  })

  it('整轮超过 10MB：前面的照发，后面的跳过并说明', async () => {
    get.mockResolvedValue({ mediaType: 'image/png', bytes: bytes(5 * 1024 * 1024) })
    const out = await acpPromptAttachments([
      file({ name: '1.png' }),
      file({ name: '2.png' }),
      file({ name: '3.png' }),
    ])
    expect(out.attachments.map((a) => a.name)).toEqual(['1.png', '2.png'])
    expect(out.note).toContain('3.png')
    expect(out.note).toContain('总量上限')
  })
})
