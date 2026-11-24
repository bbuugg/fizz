/**
 * 沙箱结果的**归因**：把一次失败分成「被沙箱挡了」和「沙箱自己坏了」。
 *
 * 两者都表现为非零退出码 + 一段 stderr，但含义完全不同：
 *
 * - 拒绝（denial）＝ 隔离生效了，命令本来该被拦 → 告诉模型「换个做法，或者申请提权」；
 * - runner 失败 ＝ 命令根本没执行 → 告诉用户「沙箱没起来」，不能当成任务失败重试。
 *
 * 判定只看**所选后端自己的方言**（`ConfinedArgv.denialSignatures`）。取跨后端并集会把
 * 「这个后端根本产生不了的错」也算成拒绝 —— 用户会看到「被沙箱挡了」，实际是权限、
 * 路径或命令本身的问题。
 */
import type { RunnerFailureRule } from './types'

function linesOf(stderr: string): string[] {
  return stderr.split(/\r?\n/)
}

/**
 * 退出码非零且 stderr 某行包含任一签名 → 视为被策略拒绝。
 *
 * 退出码为 0 时一律不算：命令自己把 `permission denied` 打印到 stderr 是常事
 * （`grep: ... permission denied` 之后仍然 exit 0），不能误报。
 */
export function matchesSignature(
  exitCode: number | null,
  stderr: string,
  signatures: readonly string[]
): boolean {
  if (exitCode === null || exitCode === 0) return false
  if (signatures.length === 0) return false
  const haystack = linesOf(stderr).map((line) => line.toLowerCase())
  return signatures.some((signature) => {
    const needle = signature.toLowerCase()
    return haystack.some((line) => line.includes(needle))
  })
}

/**
 * 命中 runner 失败规则时返回**命中的那一行**（作为错误详情），否则 undefined。
 *
 * 顺序与文档一致：先按 `allowedExitCodes` 门控，再按整行精确匹配剔除
 * `informationalLines`，最后才在剩余行里找致命签名。
 */
export function classifyRunnerFailure(
  exitCode: number | null,
  stderr: string,
  rules: readonly RunnerFailureRule[]
): { detail: string } | undefined {
  if (exitCode === null || exitCode === 0) return undefined
  const lines = linesOf(stderr)
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informational = new Set((rule.informationalLines ?? []).map((line) => line.trim().toLowerCase()))
    const fatal = rule.fatalSignatures.map((signature) => signature.toLowerCase())
    for (const line of lines) {
      const normalized = line.trim().toLowerCase()
      if (normalized.length === 0) continue
      if (informational.has(normalized)) continue
      if (fatal.some((signature) => normalized.includes(signature))) return { detail: line.trim() }
    }
  }
  return undefined
}

/** 一次受限运行的归因结果（本地与远端共用同一份判定顺序） */
export interface ConfinedRunOutcome {
  /** 被策略拒绝（沙箱正常工作、挡住了这次写入） */
  denied: boolean
  /** runner 自己失败：命令根本没跑 */
  runnerFailed?: string
}

/**
 * 归因顺序：**runner 失败优先于拒绝**。
 *
 * 两者都可能带非零退出码与相似的 stderr，但含义相反：runner 失败代表命令从未执行
 * （重试同一条命令没有意义），拒绝代表命令跑了但被内核挡住（可以换做法或申请提权）。
 */
export function classifyConfinedRun(
  exitCode: number | null,
  stderr: string,
  denialSignatures: readonly string[],
  runnerFailureRules: readonly RunnerFailureRule[]
): ConfinedRunOutcome {
  const runnerFailure = classifyRunnerFailure(exitCode, stderr, runnerFailureRules)
  if (runnerFailure !== undefined) return { denied: false, runnerFailed: runnerFailure.detail }
  return { denied: matchesSignature(exitCode, stderr, denialSignatures) }
}
