// 防止 Android 打包时自动解开 .gz 资源并剥掉后缀，导致手机校验阶段找不到清单中的归档。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('node:fs', () => ({ createReadStream: vi.fn() }))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(), readFile: vi.fn(), rm: vi.fn(), stat: vi.fn(), writeFile: vi.fn()
}))

const originalArgv = process.argv
const unpacked = Buffer.from('runtime archive fixture')
const compressed = gzipSync(unpacked)

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  process.argv = originalArgv.slice(0, 2)
  vi.stubEnv('FIZZ_ANDROID_ABI', 'arm64-v8a')
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  vi.mocked(createReadStream).mockImplementation(() => Readable.from([compressed]) as ReturnType<typeof createReadStream>)
  vi.mocked(readFile).mockResolvedValue('{"version":"0.0.35"}')
  vi.mocked(stat).mockResolvedValue({ size: compressed.length } as Awaited<ReturnType<typeof stat>>)
  vi.mocked(mkdir).mockResolvedValue(undefined)
  vi.mocked(rm).mockResolvedValue(undefined)
  vi.mocked(writeFile).mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Android runtime bundle manifest', () => {
  it('keeps gzip archives under packaging-safe names with matching compressed checksums', async () => {
    await import('./build-runtime.mjs')

    expect(writeFile).toHaveBeenCalledOnce()
    const manifest = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]))
    for (const part of ['system', 'engine']) {
      expect(manifest[part]).toEqual({
        file: `${part}.tgz`,
        sha256: createHash('sha256').update(compressed).digest('hex'),
        bytes: compressed.length,
        unpackedBytes: unpacked.length
      })
      expect(createReadStream).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${part}\\.tgz$`)))
    }
  })

  it('removes legacy archives before exporting into a reused output directory', async () => {
    await import('./build-runtime.mjs')

    for (const file of ['system.tar.gz', 'engine.tar.gz']) {
      const index = vi.mocked(rm).mock.calls.findIndex(([path]) => String(path).endsWith(file))
      expect(index).toBeGreaterThanOrEqual(0)
      expect(vi.mocked(rm).mock.calls[index]![1]).toEqual({ force: true })
      expect(vi.mocked(rm).mock.invocationCallOrder[index]).toBeLessThan(vi.mocked(spawnSync).mock.invocationCallOrder[0]!)
    }
  })
})
