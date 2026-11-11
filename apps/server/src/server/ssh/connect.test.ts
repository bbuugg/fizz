/**
 * SSH 单跳连接配置（不连真实主机，只校验交给 ssh2 的参数）。
 *
 * 钉住「保活配 0 = 关闭」：0 在配置层是合法值（`normalizeKeepalive` 原样保留），
 * 连接层曾经把它当成「没配」换成 30 秒兜底 —— 用户在表单里关掉保活，
 * 实际仍会每 30 秒发一次心跳。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../state', () => ({ domain: { resolveSshHost: vi.fn() } }))

import { buildHopConfig } from './connect'
import type { ResolvedSshHost } from '@fizz/workspace'

function host(overrides: Partial<ResolvedSshHost> = {}): ResolvedSshHost {
  return {
    id: 'h1',
    name: '测试机',
    host: 'example.com',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'secret',
    charset: 'utf-8',
    keepaliveInterval: 30,
    ...overrides
  }
}

describe('buildHopConfig', () => {
  it('保活 0（关闭）原样传 0，不回落 30 秒', () => {
    expect(buildHopConfig(host({ keepaliveInterval: 0 })).keepaliveInterval).toBe(0)
  })

  it('配置是秒、ssh2 要毫秒', () => {
    expect(buildHopConfig(host({ keepaliveInterval: 45 })).keepaliveInterval).toBe(45_000)
  })
})
