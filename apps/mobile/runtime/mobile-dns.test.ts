// 防止离线启动/切换 Wi-Fi 和移动网络后，Node 的 resolve 系列仍使用启动时的 DNS。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { setServers } from 'node:dns'
import { startRuntimeDnsSync } from './mobile-dns.mjs'

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))
vi.mock('node:dns', () => ({ setServers: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(readFileSync).mockReset().mockReturnValue('nameserver 192.0.2.1\n')
  vi.mocked(setServers).mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Android runtime DNS synchronization', () => {
  it('updates c-ares after the native network callback replaces resolv.conf', () => {
    startRuntimeDnsSync()
    expect(setServers).toHaveBeenLastCalledWith(['192.0.2.1'])
    vi.mocked(readFileSync).mockReturnValue('nameserver 198.51.100.1\nnameserver 2001:db8::53\n')
    vi.advanceTimersByTime(5000)
    expect(setServers).toHaveBeenLastCalledWith(['198.51.100.1', '2001:db8::53'])
    vi.advanceTimersByTime(10000)
    expect(setServers).toHaveBeenCalledTimes(2)
  })

  it('can start offline and apply DNS once a network becomes available', () => {
    vi.mocked(readFileSync).mockReturnValue('options timeout:2 attempts:2\n')
    startRuntimeDnsSync()
    expect(setServers).not.toHaveBeenCalled()
    vi.mocked(readFileSync).mockReturnValue('nameserver 192.0.2.1\n')
    vi.advanceTimersByTime(5000)
    expect(setServers).toHaveBeenCalledWith(['192.0.2.1'])
  })

  it('retries a temporarily rejected update without flooding the logs', () => {
    vi.mocked(setServers).mockImplementationOnce(() => { throw new Error('query in progress') })
    expect(() => startRuntimeDnsSync()).not.toThrow()
    vi.advanceTimersByTime(5000)
    expect(setServers).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it('can stop its unreferenced watcher', () => {
    const stop = startRuntimeDnsSync()
    stop()
    vi.mocked(readFileSync).mockReturnValue('nameserver 198.51.100.1\n')
    vi.advanceTimersByTime(5000)
    expect(setServers).toHaveBeenCalledTimes(1)
  })
})
