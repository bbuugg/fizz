/**
 * git 路由（status / diff / branches / log / action）共用的 git 访问层。
 * 本地工作区走 simple-git；远端工作区由 `apps/server` 注入走 SSH exec 的 `GitExec`
 * （见 `GitExec` 的注释），所以这里的每个 helper 都接受可选的 `exec`。
 * 「面板」指这层命令最终服务的源代码管理面板（非交互、无 TTY 的服务端环境）。
 *
 * 之前这里是手写的 execFile('git', ...) 包装（原本内嵌在 status route 里），换 simple-git
 * 的原因是让子进程管理（env / 超时 / 参数校验 / 流式缓冲）交给库，自己不再维护 spawn 细节。
 *
 * ⚠️ 换库时踩过的几个点，别绕过它们：
 *
 * 1. **stderr 的用户可见输出要靠 outputHandler 抓回来**。`git checkout -b` / `git init` /
 *    `git push` 成功时把「Switched to a new branch」「Initialized empty ...」打在 stderr 上，
 *    而 simple-git 的 raw()/各 typed API 只回 stdout —— 面板的 `output` 字段会变成空串。
 *    所以 `git()` 里用 outputHandler 把 stderr 流拼接进 GitRun，行为与 execFile 时代一致。
 *
 * 2. **simple-git 4.x 默认剥离所有 `GIT_*` 环境变量**（防 env 注入的安全守卫），且
 *    `.env()` 是显式供给：受控键（EDITOR / PAGER / GIT_* 等）只要出现在显式 env 里
 *    就直接抛错 —— 而哪些键存在取决于部署机器，逐个白名单不可靠。所以这里**不动
 *    `.env()`**（子进程继承完整 process.env，守卫只做静默剥离），需要的变量在
 *    进程级兜底 + `allowEnvironment` 放行。代价是其余 `GIT_*`（GIT_DIR / GIT_ASKPASS
 *    等）不再透传 —— 对面板的非交互命令这是更安全的选择，需要它们的场景应该配 git config。
 *
 * 3. **`GIT_TERMINAL_PROMPT=0` 在模块加载时兜底写进 process.env**：面板没有 TTY，
 *    Linux 上 git 的凭据提示会直接读 /dev/tty 把 HTTP 请求挂死，必须禁掉。只在未设置时
 *    兜底（尊重部署方的显式配置）；副作用是同进程的内置终端里的 git 也禁用终端提示 ——
 *    Windows 上凭据走 GCM 弹窗不受影响，纯终端提示的场景本来也该配 credential helper。
 *
 * 4. **status 仍用 `--porcelain=v2` + 自有解析器**（见 status route 的 parseStatus），
 *    没换成 simple-git 的 `status()`：它的解析器走 porcelain v1，对「刚 init 还没有
 *    任何提交」的 unborn 分支，`## No commits yet on master` 会被它的正则解析出
 *    分支名 "No" —— 而 init-commit 恰恰是面板的核心流程。v2 输出没有这个坑。
 *
 * 5. **4.x 移除了 maxBuffer**（改流式收集，没有上限）。大仓库的超大 status / diff 不会再
 *    像 execFile 时代那样直接把进程杀掉，diff 的 400k 字符截断仍由 route 自己负责。
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import type { GitCommitDiffResult, GitCommitFileStat, GitLogResult } from './types'

// 见头注释第 3 条：进程级兜底禁用 git 的终端凭据提示
if (process.env.GIT_TERMINAL_PROMPT === undefined) {
  process.env.GIT_TERMINAL_PROMPT = '0'
}

/** 单条 git 命令的空闲超时（stdout/stderr 有输出就重置）：防凭据 / ssh 提示把请求挂死 */
const GIT_TIMEOUT_MS = 300_000

export interface GitRun {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * 一条 git 命令的执行方式。
 *
 * 本地工作区用 `localGitExec`（simple-git）；远端工作区由 `apps/server` 注入一个
 * 走 SSH exec 的实现（见 `server/ssh/git-exec.ts`）。这一层只认「在哪个目录、跑什么
 * 参数、拿回 stdout/stderr」，不关心命令最终在哪台机器上执行 —— 因此本包**不引入 ssh2**。
 */
export type GitExec = (
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<GitRun>

/**
 * 造一个面向某目录的 simple-git 客户端。每次调用新建一个实例：
 * outputHandler 里抓 stderr 的闭包是按调用隔离的，共享实例会把不同命令的 stderr 串在一起。
 */
export function gitPanel(cwd: string, timeoutMs: number = GIT_TIMEOUT_MS): SimpleGit {
  // ⚠️ simple-git 在 baseDir 不存在时会**同步抛错**（"Cannot use simple-git on a directory
  // that does not exist"），而这个 throw 发生在命令执行 / try-catch 之外 —— `git()` 的
  // try/catch 抓不到它，`repoRoot` / 各 git 路由就会直接崩成 500（用户删掉某个工作区 / 会话
  // 目录后最容易撞上）。
  // 这里把「目录不存在」收敛成「肯定不是 git 仓库」：兜底到系统临时目录（一定存在、且不是
  // 仓库），让后续的 git 命令自然以非 0 退出码失败，调用方照旧拿到 ok:false / null，
  // 而不是一记未捕获异常。正常仓库路径不受影响（baseDir 仍是真实目录）。
  const baseDir = existsSync(cwd) ? cwd : tmpdir()
  const client = simpleGit({
    baseDir,
    // 每条命令前置 `-c core.quotePath=false`：中文等非 ASCII 路径不转义成带引号的八进制
    config: ['core.quotePath=false'],
    // 进程级已兜底 GIT_TERMINAL_PROMPT（见头注释第 2/3 条），这里放行让它穿透守卫
    allowEnvironment: ['GIT_TERMINAL_PROMPT'],
    timeout: { block: timeoutMs },
    // simple-git 默认只在「退出码≠0 且 stderr 非空」时报错 —— 而 show-ref --quiet /
    // ls-files --error-unmatch 这类判断型命令失败时 stderr 是空的，会被误判成成功。
    // 这里恢复 execFile 的语义：退出码≠0 一律按失败抛。
    errors: (error, result) => {
      if (result.exitCode) {
        const text = Buffer.concat([...result.stdErr, ...result.stdOut]).toString('utf8').trim()
        return new Error(text || `git 以退出码 ${result.exitCode} 结束`)
      }
      return error
    }
  })
  return client
}

/**
 * 本机执行：跑一条 git 命令（simple-git 的 raw 通道）。**不抛异常**：失败也把 stderr
 * 原样带回，调用方自己判断 —— 与 execFile 时代的签名一致，route 里的错误分支不用动。
 *
 * 成功时 stderr 也要（checkout / init 的信息在 stderr 上），靠 outputHandler 抓。
 */
export const localGitExec: GitExec = async (cwd, args, opts) => {
  const client = gitPanel(cwd, opts?.timeoutMs)
  let stderrText = ''
  client.outputHandler((_command, _stdout, stderr) => {
    stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8')
    })
  })
  try {
    const stdout = await client.raw(args)
    return { ok: true, stdout, stderr: stderrText }
  } catch (err) {
    // 失败时 simple-git 抛 GitError，message 里带 git 的 stderr（"fatal: ..."）；
    // spawn 本身失败（没装 git 等）则是一段 node 的报错，兜底给出去够定位就行
    const text =
      stderrText.trim() || (err instanceof Error ? err.message : String(err)) || 'git 执行失败'
    return { ok: false, stdout: '', stderr: text }
  }
}

/** 跑一条 git 命令；`exec` 缺省是本机（simple-git），远端由调用方注入 */
export async function git(
  cwd: string,
  args: string[],
  exec: GitExec = localGitExec
): Promise<GitRun> {
  return exec(cwd, args)
}

/**
 * 尽力而为地修剪陈旧的远端跟踪分支（`git fetch --prune --quiet --all`）。
 *
 * 场景：分支在GitHub 界面 / 别的客户端被删了，本地 refs/remotes/<remote>/<branch> 还留着，
 * 面板的分支列表就一直显示它；用户点「删除远端分支」时 git 报remote ref does not exist。
 *
 * 只读远端、不动本地分支与提交，所以失败（离线 / 无凭据 / 超时）无所谓 —— 调用方只当没发生，
 * 继续用上一次fetch 留下的列表。超时给得比 GIT_TIMEOUT_MS 短，因为这是列表接口的同步路径，
 * 不能为了一个可有可无的修剪把请求挂住。
 */
export async function pruneRemoteRefs(
  cwd: string,
  timeoutMs = 15_000,
  exec: GitExec = localGitExec
): Promise<boolean> {
  const res = await exec(cwd, ['fetch', '--prune', '--quiet', '--all'], { timeoutMs })
  return res.ok
}

/** 解析仓库根目录（绝对路径）；不是仓库（或没装 git）返回 null */
export async function repoRoot(
  dir: string,
  exec: GitExec = localGitExec
): Promise<string | null> {
  const res = await git(dir, ['rev-parse', '--show-toplevel'], exec)
  const root = unquotePath(res.stdout.trim())
  return res.ok && root ? root : null
}

/**
 * 解析 `git remote -v`：
 * ```
 * origin\thttps://example.com/a.git (fetch)
 * origin\thttps://example.com/a.git (push)
 * ```
 * 每个远端取 **fetch** 地址（与 simple-git `getRemotes(true).refs.fetch` 同口径）；
 * 只有 push 行（少见）时退回 push 地址。同名远端多行只保留一条。
 */
export function parseRemoteV(stdout: string): { name: string; url: string }[] {
  const byName = new Map<string, { url: string; fetch: boolean }>()
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\t(.+?)\s+\((fetch|push)\)$/.exec(line)
    if (!m) continue
    const [, name = '', url = '', kind = ''] = m
    if (!name || !url) continue
    const prev = byName.get(name)
    // fetch 行优先；同一类重复时以第一条为准（git 不会对同名远端输出两行 fetch）
    if (!prev || (kind === 'fetch' && !prev.fetch)) byName.set(name, { url, fetch: kind === 'fetch' })
  }
  return [...byName].map(([name, { url }]) => ({ name, url }))
}

/** 已配置的远端（fetch 地址）；拿不到（没装 git / 不是仓库）返回空列表 */
export async function gitRemotes(
  cwd: string,
  exec: GitExec = localGitExec
): Promise<{ name: string; url: string }[]> {
  const res = await git(cwd, ['remote', '-v'], exec)
  return res.ok ? parseRemoteV(res.stdout) : []
}

/**
 * 两个路径是不是**同一个目录**（归一化后比较）。
 *
 * 归一三件事：相对路径按 cwd 解析（`cwd` 是进程级常量，不会变）、分隔符统一成 `/`、
 * 去掉末尾斜杠；Windows 额外做大小写折叠（NTFS 不敏感），其它平台保持敏感
 * （`/home/A` 与 `/home/a` 确实是两个目录）。
 *
 * ⚠️ 别改成 `startsWith` —— `/home/a` 会把 `/home/ab` 判成子目录。要用「相对路径是否为空」
 * 之类的语义就另写函数，这里只回答「同不同一个目录」。
 *
 * 用在 status 路由判断 `repoRoot()` 返回的根**是不是工作区自己**（见该路由注释）。
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const x = norm(a)
  const y = norm(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** 工作区相对仓库根的前缀（工作区指向仓库子目录时用来过滤改动列表） */
export async function workspacePrefix(
  workspacePath: string,
  exec: GitExec = localGitExec
): Promise<string> {
  const res = await git(workspacePath, ['rev-parse', '--show-prefix'], exec)
  return res.ok ? res.stdout.trim() : ''
}

/**
 * 还原 git 的 C 风格引号路径（`"a\b" / \346\226\207` 这类）。
 *
 * `core.quotePath=false` 已经让中文路径裸输出，这里只为带 `"` / 控制字符等
 * 仍会被引用的路径兜底；逻辑与 git 的 quote 转义规则一致。
 */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const body = raw.slice(1, -1)
  const out: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch !== '\\') {
      out.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = body[++i]
    if (next === undefined) break
    if (next >= '0' && next <= '7') {
      let oct = next
      while (oct.length < 3 && body[i + 1] !== undefined && body[i + 1]! >= '0' && body[i + 1]! <= '7') {
        oct += body[++i]!
      }
      out.push(Number.parseInt(oct, 8))
      continue
    }
    const escapes: Record<string, number> = {
      a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92
    }
    out.push(escapes[next] ?? next.charCodeAt(0))
  }
  return Buffer.from(out).toString('utf8')
}


/** `git log` / `git show` 自定义 format 的字段分隔符（unit separator，路径与提交信息里不会出现） */
const FIELD_SEP = '\u001f'

/**
 * 一个 rev（commit hash / `HEAD~3` / `refs/...`）能不能安全拼进命令行。
 *
 * 只放行这些形状：**裸 hash**（history 面板点开一次提交时传的就是它）、
 * `HEAD` 及其 `^~` / `{}` 后缀（`HEAD~2`、`HEAD^`、`stash@{1}`）、以及带命名空间的
 * ref 路径（`refs/heads/main`、`remotes/origin/dev`、`feature/x.y`）。
 *
 * ⚠️ 这道校验是**必须**的：rev 是拼进 argv 的一个元素，形如 `--upload-pack=<cmd>`
 * 的串会被 git 当成选项解析（`--output=/path` 直接写文件、或借 `--upload-pack` 执行命令）。
 * 判据用白名单而非黑名单 —— 黑名单要逐次补漏，白名单漏一个只是拒绝一个合法输入。
 */
export function isSafeRev(rev: string): boolean {
  if (!rev || rev.length > 200) return false
  if (rev.startsWith('-')) return false
  // hash / HEAD / ref 路径：只收这些字符，注意**不含空格与引号**（空格会把一个 rev 裂成两个参数）
  return /^[0-9A-Za-z._][0-9A-Za-z._/@^~{}-]*$/.test(rev)
}

/**
 * 解析 `git show --numstat` 的一行：`<ins>\t<del>\t<path>`。
 *
 * ⚠️ **二进制文件**的 numstat 是 `-\t-\t<path>`：直接 `Number('-')` 会得到 NaN，
 * 界面上就变成「+NaN −NaN」。所以先判 `-`，`binary` 置位、两个计数给 0。
 *
 * ⚠️ **重命名是合并列**（`-M` 下）：`{dir1 => dir2}/file.md`、或 `{old.md => new.md}`。
 * 这不是真实路径，直接拿去跟 `--name-status` 的新路径 join 会**一条都匹配不上**
 * （界面表现：文件清单里所有重命名项的状态退化、目录名变成 `{a => b}` 这种怪东西）。
 * 所以这里把花括号形式还原成**新路径**（旧路径由 name-status 那条负责）。
 */
export function parseNumstatLine(
  line: string
): { path: string; insertions: number; deletions: number; binary: boolean } | null {
  if (!line) return null
  const [ins, del, rawPath] = line.split('\t')
  if (ins === undefined || del === undefined || rawPath === undefined) return null
  const binary = ins === '-' || del === '-'
  // `{a => b}` / `{dir1 => dir2}` 两种形态：花括号只包住「变化的那一段」，前后缀不变
  const brace = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(rawPath)
  const realPath = brace ? `${brace[1]}${brace[3]}${brace[4]}` : rawPath
  return {
    path: unquotePath(realPath),
    insertions: binary ? 0 : Number(ins),
    deletions: binary ? 0 : Number(del),
    binary
  }
}

/**
 * 解析 `git show --name-status` 的一行：`<status>\t<path>`。
 *
 * **重命名 / 复制是两列**：`R100\t<old>\t<new>`（`C75` 同理）—— 这时 `path` 取**新**名、
 * `oldPath` 取旧名。⚠️ 顺序别写反：`parts[1]` 是旧路径，把它当成 path 会让
 * 重命名提交在界面上显示成一个假的新文件。
 *
 * 与 `parseNumstatLine` 同行序对应（两条命令都不带 `--no-renames`）：
 * numstat 那侧一行是 `<ins>\t<del>\t<old> => <new>` 的**合并列**，这里归一成同样一条。
 */
export function parseNameStatusLine(
  line: string
): { path: string; status: string; oldPath?: string } | null {
  if (!line) return null
  const parts = line.split('\t')
  if (parts.length < 2) return null
  // 第一列形如 `M` / `A` / `D` / `R100` / `C75`：只取字母（相似度数字对 UI 没用）
  const status = (parts[0] ?? '').replace(/\d+$/, '')
  if ((status === 'R' || status === 'C') && parts.length >= 3) {
    const oldPath = unquotePath(parts[1] ?? '')
    const path = unquotePath(parts[2] ?? '')
    if (!oldPath || !path) return null
    return { path, status, oldPath }
  }
  const path = unquotePath(parts[1] ?? '')
  if (!path) return null
  return { path, status }
}

/** 解析 `git show -s --format=%H<US>%h<US>%an<US>%aI<US>%s` 的第一行 */
function parseCommitMeta(line: string): Omit<GitCommitDiffResult, 'files' | 'diff'> {
  const [hash = '', short = '', author = '', date = '', subject = ''] = line.split(FIELD_SEP)
  return { hash, short, author, date, subject }
}

/**
 * 解析 `git log --format=%H<US>%h<US>%an<US>%aI<US>%s` 的每一行（单测覆盖）。
 * 提交说明按整行取 `%s`，其中不会出现 `\x1f`，所以直接按分隔符切是安全的。
 */
export function parseLogOutput(stdout: string): GitLogResult['commits'] {
  const out: GitLogResult['commits'] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [hash = '', short = '', author = '', date = '', subject = ''] = line.split(FIELD_SEP)
    if (!hash) continue
    out.push({ hash, short, author, date, subject })
  }
  return out
}

/**
 * 提交历史（`git log -n <limit>`）；空仓库（unborn HEAD）上 git 会失败，按空列表返回
 * —— 与面板旧行为一致，不把「还没有提交」当错误。
 */
export async function gitLog(
  cwd: string,
  limit: number,
  exec: GitExec = localGitExec
): Promise<GitLogResult['commits']> {
  const res = await git(
    cwd,
    ['log', '-n', String(limit), `--format=%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s`],
    exec
  )
  return res.ok ? parseLogOutput(res.stdout) : []
}

/**
 * 取**一次提交**的元信息 + 文件清单 + 原始 unified diff。
 *
 * 这是 `GET .../git/commit` 的唯一数据源（历史面板点开某次提交要看的东西）。
 *
 * **四条只读命令并行发** —— `git show` 一个字都不写，`Promise.all` 没有竞态：
 * 1. `-s --format=…`：元信息（`-s` = suppress diff，只出提交头）；
 * 2. `--name-status --format=`：每个文件的状态字母；
 * 3. `--numstat --format=`：每个文件的增删行数（⚠️ **二进制是 `- -`**）；
 * 4. `-p --format=`：纯净 diff 正文（空 format 把 `commit …` 那一坨去掉）。
 *
 * 为什么不合并成一条：git 不允许 `--numstat` 与 `--name-status` 同时用，而两者信息互补
 * （一个给规模、一个给动作类型）。名字上的重复解析成本远小于把 UI 该知道的事藏起来 ——
 * 四条命令加起来通常十几毫秒，且都发生在用户点开那一下。
 *
 * `isSafeRev` 之外**不自己校验** rev 是否存在：git 会报 `unknown revision`，
 * 把原话带给用户比我们猜「是不是不存在」更准（也可能是浅克隆、孤儿 ref 这类边界）。
 */
export async function commitShow(
  cwd: string,
  rev: string,
  exec: GitExec = localGitExec
): Promise<GitCommitDiffResult> {
  const [meta, nameStatus, numstat, diff] = await Promise.all([
    git(cwd, ['show', '-s', `--format=%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s`, rev], exec),
    git(cwd, ['show', '--name-status', '--format=', '-M', rev], exec),
    git(cwd, ['show', '--numstat', '--format=', '-M', rev], exec),
    git(cwd, ['show', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--format=', '-M', rev], exec)
  ])
  // 元信息取不到 = 这个 rev 不存在 / 不是提交。把 git 的原话抛出去，route 转成 4xx
  if (!meta.ok) throw new Error(meta.stderr || `git show ${rev} 失败`)

  /** 新路径 → 状态（rename 时连旧路径一起带上）。两条命令都开了 `-M`，行序一一对应 */
  const statusByPath = new Map<string, { status: string; oldPath?: string }>()
  for (const line of nameStatus.stdout.split('\n')) {
    const parsed = parseNameStatusLine(line)
    if (!parsed) continue
    statusByPath.set(parsed.path, parsed.oldPath ? { status: parsed.status, oldPath: parsed.oldPath } : { status: parsed.status })
  }

  const files: GitCommitFileStat[] = []
  for (const line of numstat.stdout.split('\n')) {
    const stat = parseNumstatLine(line)
    if (!stat) continue
    const hit = statusByPath.get(stat.path)
    // 兜底 `M`：正常情况一一对应，但 rename 归一化万一有偏差也别让界面崩
    files.push({
      path: stat.path,
      status: hit?.status ?? 'M',
      insertions: stat.insertions,
      deletions: stat.deletions,
      binary: stat.binary,
      ...(hit?.oldPath ? { oldPath: hit.oldPath } : {})
    })
  }
  return { ...parseCommitMeta(meta.stdout.split('\n')[0] ?? ''), files, diff: diff.ok ? diff.stdout : '' }
}
