/**
 * 本地可用 shell 的探测与解析（**Node 专用**，零运行时依赖）。
 *
 * 历史位置说明：这份代码原先在 contracts（当时「桌面主进程不能静态 import 内核」的
 * 折中），包化后独立成 `@fizz/shells`——终端（app 侧 `lib/server/terminal/`）与
 * agent 工具集（`@fizz/tools`）共用同一份判定，谁也不欠谁。
 *
 * 只做**只读探测**：按平台在固定安装位置与 PATH 上找可执行文件，绝不启动任何进程 ——
 * 终端面板一挂载就要这份清单，`wsl -l -q` 这类要起进程的探测会让列表卡几百毫秒。
 * 代价是 WSL 只列「默认发行版」一项，不逐个发行版展开。
 */
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** 检测到的本地可用 shell */
export interface ShellProfile {
  /** 唯一标识，如 powershell / pwsh / cmd / gitbash / wsl / bash / zsh / fish */
  id: string
  /** 展示名，如 PowerShell / CMD / Git Bash */
  name: string
  /** 可执行文件（绝对路径或 PATH 可解析名） */
  command: string
  /** 启动参数（如 Git Bash 的 --login -i） */
  args?: string[]
}

/** 本地 shell 检测结果 */
export interface ShellDetectResult {
  shells: ShellProfile[]
  /** 平台默认 shell 的 id（用户存 `'default'` 时使用） */
  defaultId: string
}

/** 解析好的「可 spawn 的命令 + 参数」 */
export interface ResolvedShell {
  command: string
  args: string[]
}

/**
 * 平台默认登录 shell：Windows 跟 COMSPEC（cmd.exe），POSIX 跟 $SHELL（兜底 bash）。
 *
 * 这是**改造前** `pty.ts` 的判定，原样保留 —— 探测不出来（或用户没选）时走它，
 * 保证「默认终端」的行为与加这个功能之前完全一致。
 */
export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe'
  return process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash'
}

/**
 * 是不是一个真实存在的**文件**（目录同名的要排除掉，spawn 它只会报错）。
 *
 * ⚠️ Store 版应用（如商店装的 pwsh.exe / winget.exe）的「应用执行别名」是
 * `APPEXECLINK` reparse point：`statSync` 直接抛 EACCES/EPERM（打不开别名文件本体），
 * `lstatSync` 能读到但报 isSymbolicLink、isFile 为 false —— 但它**能被直接 spawn**。
 * 所以对 `.exe` 遇到这两种错时退回 lstat 兜底，把别名当成存在；
 * 否则商店版 PowerShell 7 永远探测不到（选「商店安装照样检测不到」的根因）。
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if ((code === 'EACCES' || code === 'EPERM') && path.toLowerCase().endsWith('.exe')) {
      try {
        const stats = lstatSync(path)
        return stats.isFile() || stats.isSymbolicLink()
      } catch {
        return false
      }
    }
    return false
  }
}

/** 按顺序挑第一个存在的文件 */
function firstExisting(paths: Array<string | null | undefined>): string | null {
  for (const path of paths) {
    if (path && isFile(path)) return path
  }
  return null
}

/**
 * 在 PATH 里找一个可执行文件。
 *
 * POSIX 直接按名字找；Windows 按 PATHEXT 逐个试扩展名 —— 但**名字里已经带扩展名时不再拼**。
 *
 * ⚠️ 这里原来无条件拼扩展名，于是 `findInPath('pwsh.exe')` 去找的是 `pwsh.exe.exe`：
 * 所有 Windows 调用方传的都是带 `.exe` 的名字，**整条 PATH 分支从来没命中过**，
 * 一直是上面那串固定路径在兜。表现就是「从 Scoop / Chocolatey / dotnet tool 装的 pwsh
 * 明明在 PATH 上，终端选择器里却看不到」。
 *
 * 现在传 `pwsh` 或 `pwsh.exe` 都对。
 */
function findInPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.platform !== 'win32') {
    for (const dir of dirs) {
      const candidate = join(dir, name)
      if (isFile(candidate)) return candidate
    }
    return null
  }
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  const lower = name.toLowerCase()
  // 已经带扩展名 → 只按原名找；否则把 PATHEXT 每个后缀都试一遍
  const suffixes = exts.some((ext) => lower.endsWith(ext.toLowerCase()))
    ? ['']
    : exts.map((ext) => ext.toLowerCase())
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * PowerShell 7+（`pwsh`）的可执行文件路径；没装返回 null。
 *
 * 抽成函数是因为两个地方都要它：终端选择器的清单（`detectWindows`）与
 * `commandShellPath()`（给 agent 的一次性命令执行挑 shell）—— 两处必须**同一份判定**，
 * 否则会出现「选择器里有 pwsh、agent 跑命令却用了 5.1」这种自相矛盾。
 *
 * 固定位置覆盖官方安装器（`Program Files\PowerShell\7`，含 7-preview 与 32 位安装）、
 * Store 版（`WindowsApps` 下的执行别名，spawn 能直接拉起）与 WinGet 的链接目录；
 * Scoop / Chocolatey / dotnet tool 装的那些靠 PATH（它们都会把 shim 挂进 PATH）。
 */
function findPwsh(): string | null {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return (
    firstExisting([
      join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
      join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
      join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      join(localAppData, 'Microsoft', 'WinGet', 'Links', 'pwsh.exe')
    ]) ?? findInPath('pwsh')
  )
}

/**
 * Windows：只认「官方安装器会落到的固定位置 + PATH」。
 *
 * 顺序 = 展示顺序：PowerShell 7 在最前（现在最常用），cmd 排第三但它是**默认**
 * （`defaultId` 另算，不靠数组下标）。
 */
function detectWindows(): ShellDetectResult {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const shells: ShellProfile[] = []

  // PowerShell 7+：位置清单与「装了没装」的判定见 findPwsh()
  const pwsh = findPwsh()
  if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', command: pwsh })

  // Windows PowerShell 5.1：系统自带，路径固定（SystemRoot 可能被装到非 C 盘）
  const powershell =
    firstExisting([join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) ??
    findInPath('powershell.exe')
  if (powershell) shells.push({ id: 'powershell', name: 'PowerShell', command: powershell })

  // cmd：优先 COMSPEC（= 当前进程正在用的那个），它才是「平台默认」的真身
  const comspec = process.env.COMSPEC
  const cmd =
    (comspec && isFile(comspec) ? comspec : null) ??
    firstExisting([join(systemRoot, 'System32', 'cmd.exe')]) ??
    findInPath('cmd.exe')
  if (cmd) shells.push({ id: 'cmd', name: 'CMD', command: cmd })

  // WSL：wsl.exe 是系统自带的转发器，不带参数就进默认发行版
  const wsl = firstExisting([join(systemRoot, 'System32', 'wsl.exe')]) ?? findInPath('wsl.exe')
  if (wsl) shells.push({ id: 'wsl', name: 'WSL', command: wsl })

  // Git Bash：Git for Windows 的 bash.exe。`--login -i` 不能省 —— 不带的那个不会读
  // /etc/profile，PATH 与提示符都不是用户熟悉的 Git Bash 样子
  const gitBash = gitBashPath()
  if (gitBash) shells.push({ id: 'gitbash', name: 'Git Bash', command: gitBash, args: ['--login', '-i'] })

  // 装了才出现的（Nushell / Cygwin 的 mintty 不列：它不是 shell，是终端模拟器）
  const nu = findInPath('nu.exe')
  if (nu) shells.push({ id: 'nu', name: 'Nushell', command: nu })

  // 默认固定是 cmd（= 改造前的 COMSPEC 行为），探测不到才退到第一项
  const defaultId = shells.some((s) => s.id === 'cmd') ? 'cmd' : (shells[0]?.id ?? 'cmd')
  return { shells, defaultId }
}

/** shell 名的展示形态（POSIX 下就是可执行文件名，只把大小写规范化） */
const POSIX_NAMES: Record<string, string> = {
  bash: 'Bash',
  zsh: 'Zsh',
  fish: 'Fish',
  sh: 'sh',
  dash: 'dash',
  ksh: 'KornShell',
  tcsh: 'tcsh',
  csh: 'csh'
}

/** POSIX：$SHELL 优先，再读 /etc/shells 补全，最后用 PATH 兜底 */
function detectPosix(): ShellDetectResult {
  const shells: ShellProfile[] = []
  const seen = new Set<string>()

  const push = (command: string): void => {
    const base = command.split('/').pop() ?? command
    if (!base || seen.has(base)) return
    seen.add(base)
    shells.push({ id: base, name: POSIX_NAMES[base] ?? base, command })
  }

  // $SHELL 排第一：那是用户自己 chsh 选的登录 shell
  const envShell = process.env.SHELL
  if (envShell && isFile(envShell)) push(envShell)

  // /etc/shells 是系统登记的合法登录 shell（chsh 只认它），拿来补全其它可用项
  try {
    for (const raw of readFileSync('/etc/shells', 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      if (isFile(line)) push(line)
    }
  } catch {
    // 精简镜像里可能没有 /etc/shells：下面的 PATH 兜底
  }

  for (const name of ['bash', 'zsh', 'fish', 'sh']) {
    const found = findInPath(name)
    if (found) push(found)
  }

  // 默认沿用「平台默认登录 shell」的判定：$SHELL 有就用它，否则 bash
  const preferred = envShell ? (envShell.split('/').pop() ?? '') : ''
  const defaultId =
    (preferred && seen.has(preferred) ? preferred : null) ??
    (seen.has('bash') ? 'bash' : (shells[0]?.id ?? 'bash'))
  return { shells, defaultId }
}

/**
 * 列出这台机器上可用的 shell。
 *
 * 一个都没探到（极端精简的环境）时，把平台默认塞回去当唯一一项 ——
 * 宁可列表里有个「默认」也不能是空的，否则终端面板的选择器无从渲染。
 */
export function detectShells(): ShellDetectResult {
  const result = process.platform === 'win32' ? detectWindows() : detectPosix()
  if (result.shells.length > 0) return result

  const command = defaultShell()
  const base = command.split(/[\\/]/).pop() ?? command
  return { shells: [{ id: 'default', name: base, command }], defaultId: 'default' }
}

/**
 * 把 `ShellProfile.id` 解析成可 spawn 的「命令 + 参数」。
 *
 * 传 `undefined` / `'default'` = 跟随平台默认。**id 认不出来时回落到默认**而不是报错：
 * 用户存下的选择可能指向一个已经卸掉的 shell（比如把 PowerShell 7 删了），
 * 那时开一条「默认终端」远比弹一句「找不到 pwsh」有用。
 */
export function resolveShell(id?: string): ResolvedShell {
  const { shells, defaultId } = detectShells()
  const byId = (target: string): ShellProfile | undefined => shells.find((s) => s.id === target)
  const chosen = (id && id !== 'default' ? byId(id) : undefined) ?? byId(defaultId) ?? shells[0]
  const fallback = defaultShell()
  return chosen
    ? { command: chosen.command, args: withLoginArgs(chosen.command, chosen.args ?? []) }
    : { command: fallback, args: withLoginArgs(fallback, []) }
}

/**
 * POSIX 交互式终端统一按**登录 shell** 启动（补 `-l`）。
 *
 * 为什么必须登录：服务端进程由 panel / systemd / pm2 拉起，它的 `process.env.PATH`
 * 只有系统最小集合；而用户额外装的工具（pnpm / node…）PATH 往往写在 `/etc/profile`
 * 或 `~/.profile`，**只有登录 shell 才会读**。表现就是「web 终端里 `pnpm: command not found`，
 * 但 ssh 进来（登录 shell）一切正常」—— 实测 BT 面板把 node 路径写在 `/etc/profile`
 * 的 `BT-NODE-ENV` 段。加 `-l` 后 web 终端与 ssh 登录环境一致。
 *
 * 只给已知支持 `-l` 的 Bourne 系 shell 补；csh 这类不认 `-l` 的保持原样。已有参数
 * （如 Git Bash 的 `--login -i`）不覆盖。
 */
function withLoginArgs(command: string, args: string[]): string[] {
  if (process.platform === 'win32' || args.length) return args
  const base = command.split(/[\\/]/).pop() ?? ''
  return ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'].includes(base) ? ['-l'] : args
}

/**
 * Agent 的 `shell` 工具这类**一次性命令执行**该用哪个 shell（只返回可执行文件路径，参数由调用方拼）。
 *
 * Windows 上优先 PowerShell 7（`pwsh`）：同一套语法但启动更快、UTF-8 默认行为更少坑；
 * 没装才退回系统自带的 `powershell.exe`（5.1）。POSIX 恒为 `/bin/bash`。
 *
 * ⚠️ 与 `resolveShell()` 的关键区别：**这里不做「认不出来就回落默认」**。调用方用的是
 * PowerShell 的参数形状（`-NoLogo -NoProfile -NonInteractive -Command`）加一段 UTF-8 前置语句，
 * 回落成 `cmd.exe` 会直接跑不起来；而 `powershell.exe` 是系统自带、一定存在的。
 * 也**不看用户选的终端 shell** —— 那是交互式终端的选择，与 agent 跑命令用什么是两件事。
 */
/**
 * Git for Windows 的 `bash.exe` 绝对路径；没装返回 null。
 *
 * Agent 的 `shell` 在 Windows 上优先用它能拿到 POSIX 工具链（ls / grep / sed /
 * 管道），与主流编码代理一致；没有 Git Bash 时回退 PowerShell（见 `commandShellPath()`）。
 *
 * 探测覆盖官方安装器（Program Files 下 32/64 位）、Git for Windows 便携版
 * （`%LOCALAPPDATA%\Programs\Git`）以及 PATH 上 Scoop / Chocolatey 装的那个。
 */
export function gitBashPath(): string | null {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return (
    firstExisting([
      join(programFiles, 'Git', 'bin', 'bash.exe'),
      join(programFilesX86, 'Git', 'bin', 'bash.exe'),
      join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe')
    ]) ?? findInPath('bash.exe')
  )
}

/**
 * Agent 的 `shell` 工具这类**一次性命令执行**该用哪个 shell（只返回可执行文件路径，参数由调用方拼）。
 *
 * Windows 上**优先 Git Bash**（拿到 POSIX 工具链，与主流编码代理一致）；没有 Git Bash 才退回
 * PowerShell 7（`pwsh`，启动更快、UTF-8 默认行为更少坑），再没装就退到系统自带的 5.1。
 * 传 `{ noMsys: true }`（命令要进沙箱时）则跳过 Git Bash —— MSYS2 在限制性令牌下起不来。
 * POSIX 恒为 `/bin/bash`。
 *
 * ⚠️ 与 `resolveShell()` 的关键区别：**这里不做「认不出来就回落默认」**；调用方用的是
 * 对应 shell 的参数形状（`-lc` 或 PowerShell 的 `-Command`），回落成 `cmd.exe` 会直接跑不起来，
 * 而 `powershell.exe` 与 `bash.exe`（随 Git 安装）都一定存在。**也不看用户选的终端 shell** ——
 * 那是交互式终端的选择，与 agent 跑命令用什么是两件事。
 */
export function commandShellPath(options: CommandShellOptions = {}): string {
  if (process.platform !== 'win32') return '/bin/bash'
  if (options.noMsys !== true) {
    const bash = gitBashPath()
    if (bash !== null) return bash
  }
  return findPwsh() ?? 'powershell.exe'
}

export interface CommandShellOptions {
  /**
   * 禁用 MSYS2（Git Bash），直接选 PowerShell。
   *
   * Windows 的限制性令牌沙箱里 MSYS2 运行时**必然**启动失败：cygheap 初始化要改自己
   * 令牌的 DefaultDacl（`NtSetInformationToken` → 0xC0000022），随后建 signal pipe
   * 又被拒（`couldn't create signal pipe, Win32 error 5`）。不是权限配错，无解 ——
   * 所以命令一旦要进沙箱，就只能在 PowerShell 里跑。
   */
  noMsys?: boolean
}
