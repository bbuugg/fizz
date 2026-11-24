/**
 * 沙箱提权的词汇与校验（`sandbox_permissions` + `justification`）。
 *
 * 为什么需要这一层：沙箱挡住的写入有时候是**必须做**的（改 ~/.npmrc、写系统临时目录）。
 * 没有提权通道，模型只能反复撞同一面墙，或者干脆放弃任务。有了它，模型可以带着理由
 * 向用户申请**一次**放宽，批准后只对这一次调用生效。
 *
 * 三条硬规矩：
 * - 两个参数必须**成对**出现：没有理由的提权弹窗，用户无从判断；有理由却没有目标，
 *   说明模型说错了参数 —— 两种都当非法输入，不弹卡；
 * - 只能**严格更宽**：`workspace-write → danger-full-access` 可以，
 *   反过来或者原地打转没有意义（原地等于「当前档」，直接按当前档执行，不弹卡）；
 * - 沙箱关着的时候没有提权可谈：申请同一档（完全访问）按无操作处理（本来就没限制），
 *   申请别的档直接报错纠正模型 —— 两种情况都不该弹一张「要不要放宽」的卡。
 */
import type { SandboxMode } from '@fizz/contracts/workspace'

/** 严格更宽阶梯：当前档 → 允许申请的目标档 */
export const WIDER_SANDBOX_MODES: Record<SandboxMode, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': []
}

/** 一次已通过参数校验的提权申请 */
export interface SandboxEscalation {
  mode: SandboxMode
  justification: string
}

/**
 * 校验参数配对与非空理由（schema 表达不了的约束）。
 * @throws 参数不合法时抛错（调用方把消息原样交给模型）
 */
export function validateEscalationArgs(
  sandboxPermissions: string | undefined,
  justification: string | undefined
): void {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

/**
 * 把模型的参数解析成一次提权申请；不需要提权时返回 undefined。
 *
 * @param sandboxPermissions - 模型给的 `sandbox_permissions`
 * @param justification - 模型给的理由
 * @param effective - 这次调用**实际**会用的沙箱档（沙箱关着就是 `danger-full-access`）
 */
export function resolveSandboxEscalation(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
  effective: SandboxMode
): SandboxEscalation | undefined {
  validateEscalationArgs(sandboxPermissions, justification)
  if (sandboxPermissions === undefined) return undefined
  if (justification === undefined) return undefined

  if (sandboxPermissions !== 'workspace-write' && sandboxPermissions !== 'danger-full-access') {
    throw new Error(
      'invalid sandbox_permissions: expected "workspace-write" or "danger-full-access"'
    )
  }
  // 目标与当前档一致：没有要批准的变更，按当前档直接执行
  if (sandboxPermissions === effective) return undefined
  if (effective === 'danger-full-access') {
    throw new Error(
      'sandbox_permissions is not available: the command sandbox is off, commands already run unrestricted'
    )
  }
  if (!WIDER_SANDBOX_MODES[effective].includes(sandboxPermissions)) {
    throw new Error(
      `invalid sandbox_permissions: "${sandboxPermissions}" is not wider than the current mode "${effective}"`
    )
  }
  return { mode: sandboxPermissions, justification }
}
