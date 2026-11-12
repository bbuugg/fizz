/**
 * 附件投递判据：什么时候该用 URL、什么时候必须内联、什么时候干脆不发。
 *
 * 这一层的错判只有两种后果，都很隐蔽：
 *
 * 1. **该内联却给了 URL** → 桌面端 / 局域网用户的图在云端 provider 那边拉不到，
 *    图片静默丢失（原来的 bug，也是这次改动的起因）。
 * 2. **该给 URL 却内联** → 配了反代 / 隧道的部署白传一遍 base64，请求体 ×4/3。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAttachmentResolver, isPubliclyFetchable } from './attachments'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isPubliclyFetchable —— 基址公网能不能拉到', () => {
  it('本地 / 私网一律不可拉', () => {
    for (const base of [
      '',
      'http://localhost:7801',
      'http://127.0.0.1:7801',
      'http://0.0.0.0:7801',
      'http://10.1.2.3:7801',
      'http://192.168.31.7:7801',
      'http://172.16.0.9',
      'http://172.31.255.1',
      'http://169.254.1.1',
      'http://[::1]:7801',
      'http://[fe80::1]:7801',
      'http://[fd00::1]:7801',
      'http://macbook.local:7801',
      'http://fizz.internal',
      'http://host.docker.internal:7801'
    ]) {
      expect(isPubliclyFetchable(base), base).toBe(false)
    }
  })

  it('公网域名 / 公有 IP 可拉', () => {
    for (const base of [
      'https://fizz.example.com',
      'https://abc-def.trycloudflare.com',
      'http://172.32.0.1:7801',
      'http://8.8.8.8'
    ]) {
      expect(isPubliclyFetchable(base), base).toBe(true)
    }
  })

  it('不是 URL 就当不可拉', () => {
    expect(isPubliclyFetchable('127.0.0.1:7801')).toBe(false)
  })
})

describe('createAttachmentResolver', () => {
  const file = { url: '/api/uploads/00000000-0000-4000-8000-000000000000.png', mediaType: 'image/png', name: 'a.png' }

  it('没有公网地址 → 不再返回 URL（读不到文件时降级成说明，而不是拼 127.0.0.1）', async () => {
    vi.stubEnv('FIZZ_PUBLIC_BASE_URL', '')
    const resolve = createAttachmentResolver('http://127.0.0.1:7801')
    const result = await resolve(file)
    expect(result?.kind).toBe('omit')
    expect(String((result as { note?: string }).note)).toContain('a.png')
  })

  it('配了公网基址 → 直接用 URL，不读盘', async () => {
    vi.stubEnv('FIZZ_PUBLIC_BASE_URL', 'https://fizz.example.com')
    const resolve = createAttachmentResolver('http://127.0.0.1:7801')
    const result = await resolve(file)
    expect(result).toEqual({
      kind: 'url',
      url: 'https://fizz.example.com/api/uploads/00000000-0000-4000-8000-000000000000.png'
    })
  })

  it('FIZZ_ATTACHMENT_DELIVERY=url 强制直传（配了公网基址也一样）', async () => {
    vi.stubEnv('FIZZ_PUBLIC_BASE_URL', 'https://fizz.example.com')
    vi.stubEnv('FIZZ_ATTACHMENT_DELIVERY', 'url')
    const resolve = createAttachmentResolver('http://127.0.0.1:7801')
    expect((await resolve(file))?.kind).toBe('url')
  })

  it('FIZZ_ATTACHMENT_DELIVERY=inline 即便有公网基址也内联', async () => {
    vi.stubEnv('FIZZ_PUBLIC_BASE_URL', 'https://fizz.example.com')
    vi.stubEnv('FIZZ_ATTACHMENT_DELIVERY', 'inline')
    const resolve = createAttachmentResolver('https://fizz.example.com')
    // 文件不存在 → 走 omit（说明的是「读不到」而不是「不归我管」），证明它没有返回 URL
    expect((await resolve(file))?.kind).toBe('omit')
  })

  it('插件 / 第三方地址不归这一层管（undefined = 交给 resolveFileUrl 原样返回）', async () => {
    const resolve = createAttachmentResolver('http://127.0.0.1:7801')
    expect(await resolve({ url: 'https://cdn.example.com/x.png', mediaType: 'image/png', name: 'x.png' })).toBeUndefined()
  })
})
