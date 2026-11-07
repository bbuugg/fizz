/**
 * 远端命令的**纯字符串构造**（不碰网络，可单测）。
 *
 * 远端工作区的文件 / 搜索命令都经由登录 shell 执行，用户输入（路径、正则、命令原文）
 * 必须逐段单引号转义 —— 这里的每个入口都只收已经决定好的参数，不做「聪明」的拼接。
 */
import { posix } from 'node:path'

/** POSIX shell 单引号转义（含单引号的串也能安全落地） */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 命令使用的 pid 文件（每次执行一个，收尾即删） */
export function pidFileFor(id: string): string {
  return `/tmp/fizz-exec-${id}.pid`
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
export function buildExecScript(command: string, opts: { pidFile: string; cwd?: string }): string {
  const cd = opts.cwd ? `cd ${shellQuote(opts.cwd)} || exit 127; ` : ''
  // `$$` 必须留给远端 sh 展开，这里只拼字面量
  const inner = `echo $$ > ${shellQuote(opts.pidFile)} 2>/dev/null; ${cd}exec sh -c ${shellQuote(command)}`
  return (
    'if command -v setsid >/dev/null 2>&1; then ' +
    `setsid sh -c ${shellQuote(inner)}; else sh -c ${shellQuote(inner)}; fi`
  )
}

/**
 * 终止脚本：优先按进程组（负 pid），失败退回单杀；`KILL` 档再补一刀直接子进程。
 * pid 文件里是内层 sh 的 `$$`，`exec` 之后它仍是命令本身的 pid。
 */
export function buildKillScript(pidFile: string, signal: 'TERM' | 'KILL'): string {
  const extra =
    signal === 'KILL' ? `; pkill -KILL -P "$p" 2>/dev/null` : ''
  return (
    `p=$(cat ${shellQuote(pidFile)} 2>/dev/null); ` +
    `if [ -n "$p" ]; then ` +
    `kill -${signal} -"$p" 2>/dev/null || kill -${signal} "$p" 2>/dev/null${extra}; fi`
  )
}

/** 收尾：删掉 pid 文件（命令已结束时调用，幂等） */
export function buildCleanupScript(pidFile: string): string {
  return `rm -f ${shellQuote(pidFile)}`
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