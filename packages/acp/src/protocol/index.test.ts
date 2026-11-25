/**
 * 防回归：老数据 / 未配置的 ACP agent 没有 `protocolVersion` 字段，必须落到 v1（stable）。
 *
 * 一旦缺省值漂到 v2，所有已保存的 agent 会在下次发消息时按 draft 协议握手，
 * 表现为「昨天还好好的，今天 initialize 失败」。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACP_PROTOCOL_VERSION,
  normalizeAcpProtocolVersion,
  resolveAcpFactory,
} from './index'

describe('normalizeAcpProtocolVersion', () => {
  it('缺省 / 非法值一律回落 v1', () => {
    expect(DEFAULT_ACP_PROTOCOL_VERSION).toBe('v1')
    expect(normalizeAcpProtocolVersion(undefined)).toBe('v1')
    expect(normalizeAcpProtocolVersion(null)).toBe('v1')
    expect(normalizeAcpProtocolVersion('')).toBe('v1')
    expect(normalizeAcpProtocolVersion('v3')).toBe('v1')
  })

  it('显式 v2 才走 draft', () => {
    expect(normalizeAcpProtocolVersion('v2')).toBe('v2')
  })
})

describe('resolveAcpFactory', () => {
  it('按版本取出对应工厂，缺省是 v1', () => {
    expect(resolveAcpFactory(undefined).version).toBe('v1')
    expect(resolveAcpFactory('v1').version).toBe('v1')
    expect(resolveAcpFactory('v2').version).toBe('v2')
  })
})
