/**
 * 远端工作区的 git 执行器：把 `@fizz/git` 的 `GitExec` 实现成「在 SSH 主机上跑 git」。
 *
 * 命令仍然是普通的 `git <args>` —— 与 localGitExec 完全同一批参数，差异只有四处：
 * - 每条参数逐段单引号转义（远端 exec 收的是整条命令字符串，不转义等于开了注入口）；
 * - 前置 `-c core.quotePath=false`（中文等非 ASCII 路径不转义成八进制），
 *   与本地 simple-git 的 `config` 同口径；
 * - 前置 `-c safe.directory=*`：远端目录常由别的账号（root / 部署用户）创建，面板用
 *   SSH 账号跑 git 会撞上 `detected dubious ownership`，连 `rev-parse` 都失败。
 *   逐条命令放行，而不是让用户去远端执行 `git config --global --add safe.directory`
 *   ——那是主机级状态，且每登记一个新目录都得再加一次，初始化完照样"不能用"；
 * - `GIT_TERMINAL_PROMPT=0`：面板没有 TTY，凭据提示会把请求挂死（本地是进程级兜底，
 *   远端进程不继承本机环境，必须每次显式带上）。
 *
 * 输出上限 16MB：status / diff 在超大仓库里可能很长，远端 exec 只保留**最后** maxBytes
 * 字符；面板本来就会对 diff（400k）与改动列表（2000 条）做截断，这里只防内存爆掉。
 * 超时沿用面板口径（300 秒），`pruneRemoteRefs` 这类列表路径会显式传更短的超时。
 */
import type { GitExec, GitRun } from '@fizz/git'
import { remoteExecService } from './exec'
import { shellQuote } from './remote-command'

/** 与 packages/git 的 GIT_TIMEOUT_MS 对齐（面板命令都允许这么久） */
const GIT_TIMEOUT_MS = 300_000

/** 单条输出流的缓存上限 */
const GIT_MAX_BYTES = 16_000_000

/**
 * 拼出远端要执行的命令：环境变量 + 转义后的 argv。
 *
 * `args` 里的每一项都可能来自用户（分支名 / 路径 / 提交信息），**必须逐项引号转义**；
 * 校验（`isSafeRev` / 分支名 / 相对路径）仍留在路由层，这里只负责不让参数跑出 argv。
 */
export function buildGitCommand(args: string[]): string {
  return [
    'GIT_TERMINAL_PROMPT=0',
    'git',
    '-c',
    shellQuote('core.quotePath=false'),
    // 引号不能省：裸 `*` 会被远端 shell 按 glob 展开成当前目录的文件名
    '-c',
    shellQuote('safe.directory=*'),
    ...args.map(shellQuote)
  ].join(' ')
}

/** 绑一台主机的 git 执行器；每次路由请求现建一个，连接由 RemoteExecService 池化 */
export function createRemoteGitExec(hostId: string): GitExec {
  return async (cwd, args, opts) => {
    const res = await remoteExecService.exec(hostId, buildGitCommand(args), {
      cwd,
      timeoutMs: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBytes: GIT_MAX_BYTES
    })
    if (res.reason !== 'exit') {
      const reason =
        res.reason === 'timeout'
          ? `git 命令超时（${Math.round((opts?.timeoutMs ?? GIT_TIMEOUT_MS) / 1000)} 秒）`
          : res.reason === 'aborted'
            ? 'git 命令已中止'
            : `连不上远端主机：${res.error ?? '连接已断开'}`
      return { ok: false, stdout: res.stdout, stderr: reason } satisfies GitRun
    }
    return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr }
  }
}
