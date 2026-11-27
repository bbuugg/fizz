import type { AcpPermissionMode, AgentConfirmOption } from '@fizz/contracts/types'

/** 自动答复只允许本次；没有 allow_once 时由调用方弹确认卡，绝不升级为记住授权。 */
export function pickAcpAutoPermissionOption(
  mode: AcpPermissionMode | undefined,
  options: readonly AgentConfirmOption[] | undefined,
): AgentConfirmOption | undefined {
  return mode === 'allow' ? options?.find((option) => option.kind === 'allow_once') : undefined
}
