import type { AiPermissionMode } from '@fizz/contracts/types'

const PERMISSION_MODES = new Set<unknown>(['full', 'confirm', 'readonly'])

export function isAiPermissionMode(value: unknown): value is AiPermissionMode {
  return PERMISSION_MODES.has(value)
}

/** 非法请求值或损坏的持久化值都不能落进写操作的放行分支。 */
export function resolvePermissionMode(
  value: unknown,
  fallback: unknown = 'confirm'
): AiPermissionMode {
  if (isAiPermissionMode(value)) return value
  return isAiPermissionMode(fallback) ? fallback : 'confirm'
}
