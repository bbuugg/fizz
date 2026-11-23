/** 防止取消中的内置附件上传留下半文件，或把临时文件作为已完成附件返回。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined)
}))
vi.mock('@fizz/workspace', () => ({ resolveDataDir: () => '/test-data' }))

import { join } from 'node:path'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { LocalUploadAdapter } from './local'

describe('LocalUploadAdapter.put cancellation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('commits the temp file atomically when upload completes', async () => {
    const result = await new LocalUploadAdapter().put({
      name: 'image.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([1, 2, 3])
    })

    // 同上：`path.join` 在 Windows 下是反斜杠
    expect(mkdir).toHaveBeenCalledWith(join('/test-data', 'uploads'), { recursive: true })
    expect(writeFile).toHaveBeenCalledOnce()
    expect(rename).toHaveBeenCalledOnce()
    expect(result.url).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}\.png$/)
  })

  it('aborts an in-progress temp write and removes its partial file', async () => {
    let startWrite!: () => void
    const started = new Promise<void>((resolve) => { startWrite = resolve })
    vi.mocked(writeFile).mockImplementation((_path, _data, options) => new Promise<void>((_resolve, reject) => {
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      startWrite()
    }))
    const controller = new AbortController()
    const upload = new LocalUploadAdapter().put({
      name: 'image.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      signal: controller.signal
    })
    await started
    controller.abort()

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' })
    expect(rename).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), { force: true })
  })
})

/** 取消恰好落在提交之后：注册表会拿这条 URL 来删掉已落盘的文件（防孤儿对象）。 */
describe('LocalUploadAdapter.remove', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes the committed file for a URL it owns', async () => {
    await new LocalUploadAdapter().remove(
      '/api/uploads/00000000-0000-0000-0000-000000000000.png'
    )
    // 实现走 `path.join`，Windows 下分隔符是 `\`：期望值也用它拼，别写死 POSIX 路径
    expect(rm).toHaveBeenCalledWith(
      join('/test-data', 'uploads', '00000000-0000-0000-0000-000000000000.png'),
      { force: true }
    )
  })

  it('ignores URLs outside its own namespace', async () => {
    await new LocalUploadAdapter().remove('https://cdn.example.com/other.png')
    expect(rm).not.toHaveBeenCalled()
  })
})
