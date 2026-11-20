/** 防非枚举权限值穿过工具闸门并被当作放行。 */
import { describe, expect, it } from 'vitest'
import { isAiPermissionMode, resolvePermissionMode } from './permission-mode'

describe('permission mode validation', () => {
  it('只接受服务端支持的权限档，并为损坏的默认值安全回落', () => {
    expect(isAiPermissionMode('confirm')).toBe(true)
    expect(isAiPermissionMode('readonly')).toBe(true)
    expect(isAiPermissionMode('full')).toBe(true)
    expect(isAiPermissionMode('admin')).toBe(false)
    expect(resolvePermissionMode('admin', 'full')).toBe('full')
    expect(resolvePermissionMode(undefined, 'corrupt')).toBe('confirm')
  })
})
