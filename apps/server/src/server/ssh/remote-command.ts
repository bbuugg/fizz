/**
 * 远端命令的**纯字符串构造**（不碰网络，可单测）。
 *
 * 远端工作区的文件 / 搜索命令都经由登录 shell 执行，用户输入（路径、正则、命令原文）
 * 必须逐段单引号转义 —— 这里的每个入口都只收已经决定好的参数，不做「聪明」的拼接。
 */
import { posix } from 'node:path'
import type { SandboxPolicy } from '@fizz/contracts/workspace'
import { bwrapProfileArgs } from '@fizz/tools'

/** POSIX shell 单引号转义（含单引号的串也能安全落地） */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 把一段 argv 拼成 `bwrap <profile> -- <argv>` 的单行脚本。
 *
 * 远端只能传**字符串**（SSH 的 exec 请求没有 argv 语义），所以这里必须自己转义：
 * 每个 token 单独单引号 —— 包括 profile 里的路径（工作区路径可能带空格）。
 * `--` 之后才是命令，顺序与本地 `sandbox.confine` 完全一致。
 */
function buildBwrapInvocation(policy: SandboxPolicy, argv: readonly string[]): string {
  return `bwrap ${[...bwrapProfileArgs(policy), '--', ...argv].map(shellQuote).join(' ')}`
}

/**
 * 远端 bwrap 探针：只读档跑 `true`，退出 0 才算这台主机真的能用（bwrap 已安装且
 * user namespace / mount 权限可用）。只读档不绑定工作区，不会碰用户的任何文件。
 */
export function buildSandboxProbeScript(): string {
  return buildBwrapInvocation({ mode: 'read-only', workspaceRoot: '/' }, ['true'])
}

/**
 * 把一条命令包进远端 bwrap。
 *
 * 内层用 `sh -c` 承接用户命令原文 —— 与本地 `bwrap ... -- bash -lc <command>` 同义，
 * 但远端登录 shell 已经在 `buildExecScript` 里切好目录，这里只负责「限制写范围」。
 */
export function buildConfinedScript(policy: SandboxPolicy, command: string): string {
  return buildBwrapInvocation(policy, ['sh', '-c', command])
}

/**
 * 远端 pid 文件所在目录的**运行时解析片段**（`$d` 由它给出）。
 *
 * 不能写死 `/tmp`：Termux / Android 上 `/tmp` 只对 root 可写（甚至不存在），AI 执行命令时
 * 命令尾部会冒出 `sh: 1: cannot create /tmp/fizz-exec-….pid: Permission denied`。
 * 优先 `/tmp`（普通 Linux / macOS 保持原行为），不可写就落到 `$HOME/.fizz/tmp` ——
 * SSH 会话一定带 `HOME`，且登录用户对家目录可写。
 *
 * ⚠️ exec / kill / cleanup **必须共用这一段**：它们是三次独立的 SSH exec，目录算得不一样
 * 就会「杀不掉、也删不掉」上一轮留下的 pid 文件与进程。
 */
const PID_DIR_SETUP = `d=/tmp; [ -w "$d" ] || { d="$HOME/.fizz/tmp"; mkdir -p "$d" 2>/dev/null; }`

/** pid 文件在脚本里的路径表达式（`$d` 由 `PID_DIR_SETUP` 给出；id 是 uuid，无需转义） */
function pidPathExpr(id: string): string {
  return `"$d/fizz-exec-${id}.pid"`
}

/**
 * 把用户命令包成「可整组终止」的形式。
 *
 * 有 `setsid` 时内层 `sh` 是会话首进程：`$$` 同时是 pid 与 pgid，终止按负号打整棵树
 * （`bun dev` / `npm run` 这类会再 fork 一层）。没有 `setsid`（busybox 精简系统）就
 * 退回普通 `sh`，终止时由 `buildKillScript` 用 `pkill -P` 兜一层再单杀。
 *
 * `cwd` 在写 pid 之后、exec 之前切：`cd` 失败退出码 127，与「sh 找不到命令」同一类，
 * 调用方本来就会把 stderr 原样带给模型。
 */
export function buildExecScript(command: string, opts: { pidId: string; cwd?: string }): string {
  const cd = opts.cwd ? `cd ${shellQuote(opts.cwd)} || exit 127; ` : ''
  // `$$` 必须留给远端 sh 展开，这里只拼字面量。
  // `2>/dev/null` 要写在 `>` **前面**：重定向从左到右生效，先接上 stderr 才能把
  // 「pid 文件写不了」这类错误一起吞掉（顺序反了时失败提示仍会打进命令输出）。
  const inner =
    `${PID_DIR_SETUP}; echo $$ 2>/dev/null > ${pidPathExpr(opts.pidId)}; ` +
    `${cd}exec sh -c ${shellQuote(command)}`
  return (
    'if command -v setsid >/dev/null 2>&1; then ' +
    `setsid sh -c ${shellQuote(inner)}; else sh -c ${shellQuote(inner)}; fi`
  )
}

/**
 * 终止脚本：优先按进程组（负 pid），失败退回单杀；`KILL` 档再补一刀直接子进程。
 * pid 文件里是内层 sh 的 `$$`，`exec` 之后它仍是命令本身的 pid。
 */
export function buildKillScript(pidId: string, signal: 'TERM' | 'KILL'): string {
  const extra =
    signal === 'KILL' ? `; pkill -KILL -P "$p" 2>/dev/null` : ''
  return (
    `${PID_DIR_SETUP}; ` +
    `p=$(cat ${pidPathExpr(pidId)} 2>/dev/null); ` +
    `if [ -n "$p" ]; then ` +
    `kill -${signal} -"$p" 2>/dev/null || kill -${signal} "$p" 2>/dev/null${extra}; fi`
  )
}

/** 收尾：删掉 pid 文件（命令已结束时调用，幂等） */
export function buildCleanupScript(pidId: string): string {
  return `${PID_DIR_SETUP}; rm -f ${pidPathExpr(pidId)}`
}

/**
 * 解析终端入参里的 `cwd`：只接受远端 POSIX 绝对路径，其余一律当作「没传」。
 *
 * 这是用户自己终端里的 `cd`，不是安全边界；拒绝控制字符是为了不把换行 / NUL
 * 混进终端输入（那等于替用户多敲几行命令）。
 */
export function parseTerminalCwd(raw: string | null | undefined): string | undefined {
  if (!raw || !raw.startsWith('/')) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return undefined
  return posix.normalize(raw)
}

/** shell 就绪后切目录的那一行：终端输入必须用裸回车（LF 在 PowerShell 里会插到上方） */
export function buildCdLine(cwd: string): string {
  return `cd -- ${shellQuote(cwd)}\r`
}