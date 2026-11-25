/**
 * ACP 协议版本选择：设置里存的 `AcpAgentConfig.protocolVersion` → 对应 adapter。
 *
 * 缺省走 v1（stable）：老数据没有 `protocolVersion` 字段，必须落到 v1 才不改变
 * 已保存 agent 的行为。
 */
import { v1Factory } from './v1'
import { v2Factory } from './v2'
import type { AcpConnectionFactory, AcpProtocolVersion } from './types'

export * from './types'

/** 缺省协议版本（老数据 / 未配置） */
export const DEFAULT_ACP_PROTOCOL_VERSION: AcpProtocolVersion = 'v1'

/** 把任意输入收窄成合法版本；不合法一律回落到 v1 */
export function normalizeAcpProtocolVersion(
  value: unknown,
): AcpProtocolVersion {
  return value === 'v2' ? 'v2' : DEFAULT_ACP_PROTOCOL_VERSION
}

/** 按版本取出连接工厂 */
export function resolveAcpFactory(version: unknown): AcpConnectionFactory {
  return normalizeAcpProtocolVersion(version) === 'v2' ? v2Factory : v1Factory
}
