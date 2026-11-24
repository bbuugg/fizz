/**
 * Windows 受限令牌后端的 **argv 契约**（纯函数，不 spawn）。
 *
 * 这个文件只做一件事：把「一次命令 + 一份策略」翻译成 runner 认识的参数。
 * 真正的令牌创建 / DACL 授予在 runner 进程里（`packages/win-sandbox`，它自带
 * `manageDacls` 的独立模式：我们**不传** `--write-sid` / `--temp-write-sid`，
 * 由它自己在 `--temp` 下建私有临时目录、给工作区打 capability ACE、退出时收回临时那份）。
 *
 * 为什么这个契约要单独成文件并且一个字都不能自创：
 * - 参数拼错的表现是「所有命令都起不来」，或更糟 —— 跑起来了但没隔离。
 *   参数名与顺序必须与 `packages/win-sandbox/src/acl/runner.ts` 的 `parseArgs`
 *   一一对应（那份实现移植自 deepseek-harness，契约没动）；
 * - `--` 之后是**原样 argv**，这里不做任何 shell 拼接。
 *
 * 失败契约：runner 自己的任何失败都打印 `windows-acl-run: <detail>` 并退出 127；
 * 界面上的「被拒绝」是另一套（Access is denied / 拒绝访问），两者不能混。
 */
import type { SandboxPolicy } from '@fizz/contracts/workspace'
import type { RunnerFailureRule } from './types'

/** runner 侧失败时的专用退出码（与 harness 的 RUNNER_FAILURE_EXIT 一致） */
export const WINDOWS_ACL_FAILURE_EXIT = 127

/**
 * 拒绝方言：powershell/.NET 的 `Access to the path '...' is denied.`、
 * cmd 的 `Access is denied.`、Node 的 EACCES/EPERM。
 *
 * ⚠️ 只收**带错误码或 Windows 专有措辞**的串：`permission denied` / `operation not permitted`
 * 这种通用文本在普通失败里到处都是（文件被占用、git index.lock、工具自身权限错误），
 * 照单全收会把「命令自己失败」误报成「被沙箱拒绝」，模型就会去申请放宽沙箱。
 */
export const WINDOWS_ACL_DENIAL_SIGNATURES: readonly string[] = [
  'access is denied',
  '拒绝访问',
  'access to the path',
  'eacces: permission denied',
  'eperm: operation not permitted'
]

/** runner 自己坏了的证据：只认它自己的退出码 + 前缀，正常命令打印同样的字不算 */
export const WINDOWS_ACL_RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = [
  { allowedExitCodes: [WINDOWS_ACL_FAILURE_EXIT], fatalSignatures: ['windows-acl-run: '] }
]

/**
 * 拼出实际要 spawn 的 argv。
 * @param launcher - runner 的启动前缀（如 `[node, runner.js]` 或一个原生 exe）
 * @param policy - 本次的文件效果策略（`read-only` / `workspace-write`）
 * @param tempRoot - 已存在的临时根；runner 会在它下面建 per-call 私有目录
 * @param argv - 调用方的原始 argv（完整程序 + 参数，**不拼接**）
 */
export function windowsAclArgv(
  launcher: readonly string[],
  policy: SandboxPolicy,
  tempRoot: string,
  argv: readonly string[]
): string[] {
  return [
    ...launcher,
    '--workspace', policy.workspaceRoot,
    '--temp', tempRoot,
    '--mode', policy.mode,
    '--',
    ...argv
  ]
}

/**
 * 探针 argv：只读档跑 `cmd /c exit 0`。退出 0 才算 token 与 spawn 链路真的能用。
 * 只读档不碰 DACL，所以探针不会在用户工作区留下任何 ACE。
 */
export function windowsAclProbeArgv(launcher: readonly string[], tempRoot: string): string[] {
  return windowsAclArgv(
    launcher,
    { mode: 'read-only', workspaceRoot: tempRoot },
    tempRoot,
    ['cmd', '/c', 'exit', '0']
  )
}
