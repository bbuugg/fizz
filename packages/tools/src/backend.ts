/**
 * 工作区后端的**本地实现**：把原先直接散在 `tools.ts` 里的 fs / 搜索 / 进程执行
 * 收进一个对象。
 *
 * 为什么单独成文件：远端实现要复用同一套工具定义，而 `tools.ts` 又要在未传后端时
 * 回落到这里 —— 实现留在 `tools.ts` 会形成循环 import。ssh2 只在 `apps/server`，
 * 这里只用 Node 内置能力。
 *
 * 行为与改造前逐项对齐：同一套忽略规则、同样的词法排序、同样的进程组终止与输出解码。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { commandShellPath, gitBashPath } from '@fizz/shells'
import {
  createIgnoreChecker,
  globToRegExp,
  relPathOf,
  resolveInside,
  type WorkspaceBackend,
  type WorkspaceDirEntry,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceFindOptions,
  type WorkspaceSearchFile,
  type WorkspaceSearchOptions,
  type WorkspaceStat
} from '@fizz/contracts/workspace'
import { createAnsiStripper } from './ansi'
import { createOutputDecoder } from './output-decoder'

/** 搜索文件的大小上限（1MB，跳过大文件避免卡死） */
export const MAX_SEARCH_FILE_SIZE = 1_048_576
/** 搜索命中的单行截断长度 */
export const MAX_LINE_CHARS = 200
/** 单条输出流的默认缓存上限（字符），防 `yes` / `find /` 把内存吃光 */
export const MAX_CMD_CAPTURE = 4_000_000

function entryTypeOf(stat: import('node:fs').Stats): WorkspaceStat['type'] {
  if (stat.isDirectory()) return 'dir'
  if (stat.isFile()) return 'file'
  if (stat.isSymbolicLink()) return 'symlink'
  return 'other'
}

/**
 * 杀掉整棵进程树（超时 / 中止 / 单条停止都走它）。
 *
 * ⚠️ **不再看 `child.killed`**：那个标志只表示「我们向**它自己**发过信号」，与「树还在不在」
 * 无关。以前的 `if (child.exitCode !== null || child.killed) return` 会让第二次调用直接
 * 什么都不做 —— 用户报「AI 跑了 `npx vite`，我点停止停不下来」，多半就是第一刀（某个
 * 只杀 shell 的路径或 SIGINT）已经把 `killed` 置上，后面这道保险丝全被跳过了。
 * 现在无条件再打一记整树 kill：幂等（进程没了 taskkill / kill 都是空转）。
 */
export function killChild(child: ReturnType<typeof spawn>, isWin: boolean): void {
  const pid = child.pid
  if (!pid) return
  if (isWin) {
    /**
     * ⚠️ `taskkill` 是**异步**的：`spawn` 自己不抛错，ENOENT / 权限不足 / 「进程已退出」
     * 全都只走 `'error'` 事件或非 0 退出码 —— 以前的 `try { spawn(...) } catch {}` 一个都
     * 接不住，失败了就是**静默空转**（命令继续跑、端口继续占着）。这里两条路都补上：
     * 打整树，同时在任何失败信号上退回直接 kill shell。
     */
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    const fallback = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
    }
    killer.on('error', fallback)
    // 非 0 = 树已经不在 / 拿不到（权限、pid 已被回收）：退回单杀，能杀多少算多少
    killer.on('exit', (code) => {
      if (code !== 0) fallback()
    })
    return
  }
  // detached 起的（见 runCommand 的 spawn 选项）自成进程组：先杀整组，退不回再单杀
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    // 组已经没了 / 不是组首：退回单杀
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // 已退出
  }
}

/**
 * 把一条命令翻译成「起哪个 shell、带什么参数、什么环境」。
 *
 * 前台（`runCommand`）与后台（`spawnBackgroundShell`）**必须用同一份判定**：两条路要是
 * 各挑一次 shell，同一条命令「直接跑」和「丢后台跑」的行为就会不一样 —— 最典型的是
 * Windows 上前台走 Git Bash、后台掉进 PowerShell，管道 / `&&` / 单引号整个不认。
 */
export function resolveShellSpawn(command: string): {
  shellCmd: string
  shellArgs: string[]
  env: NodeJS.ProcessEnv
  isWin: boolean
} {
  const isWin = process.platform === 'win32'
  const bashPath = isWin ? gitBashPath() : null
  const useBash = !isWin || Boolean(bashPath)
  const shellCmd = isWin ? (bashPath ?? commandShellPath()) : '/bin/bash'
  const shellArgs = isWin
    ? useBash
      ? ['-lc', command]
      : [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;${command}`
        ]
    : ['-lc', command]
  const env =
    isWin && useBash
      ? {
          ...process.env,
          PATH: `${join(dirname(bashPath!), '..', 'usr', 'bin')};${process.env.PATH ?? ''}`
        }
      : process.env
  return { shellCmd, shellArgs, env, isWin }
}

/** 本地执行：与改造前的 `runCommand` 同一套进程树终止 / 解码 / 截断语义，只返回原始结果 */
function localExec(command: string, cwd: string, opts: WorkspaceExecOptions): Promise<WorkspaceExecResult> {
  const { shellCmd, shellArgs, env, isWin } = resolveShellSpawn(command)
  const timeoutMs = opts.timeoutMs ?? 120_000
  const maxBytes = opts.maxBytes ?? MAX_CMD_CAPTURE
  const child = spawn(shellCmd, shellArgs, {
    cwd,
    env,
    windowsHide: true,
    ...(isWin ? {} : { detached: true })
  })
  let stdout = ''
  let stderr = ''
  let truncated = false
  // 实时转发的清洗器（每条流各一份：chunk 边界会把转义序列劈开，见 ansi.ts）
  const cleanStdout = createAnsiStripper()
  const cleanStderr = createAnsiStripper()
  // 输出解码（每条流各一份）：Windows 上同一批命令可能吐 UTF-8（Git Bash 的 coreutils）
  // 也可能是 GBK（命令里显式调的 powershell 5.1），见 output-decoder.ts 的头注释
  const decodeStdout = createOutputDecoder()
  const decodeStderr = createOutputDecoder()

  return new Promise<WorkspaceExecResult>((resolve) => {
    let settled = false
    const finish = (reason: WorkspaceExecResult['reason'], exitCode?: number | null, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      stdout += decodeStdout.flush()
      stderr += decodeStderr.flush()
      resolve({ stdout, stderr, exitCode: exitCode ?? null, reason, error, truncated })
    }
    const reap = (): void => {
      killChild(child, isWin)
      const straggler = setTimeout(() => killChild(child, isWin), 600)
      straggler.unref?.()
    }
    const onAbort = (): void => {
      reap()
      finish('aborted')
    }
    const timer = setTimeout(() => {
      reap()
      finish('timeout')
    }, timeoutMs)
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (d: Buffer) => {
      const chunk = decodeStdout.decode(d)
      if (!chunk) return
      stdout += chunk
      if (stdout.length > maxBytes) {
        stdout = stdout.slice(-maxBytes)
        truncated = true
      }
      opts.onOutput?.('stdout', cleanStdout(chunk))
    })
    child.stderr.on('data', (d: Buffer) => {
      const chunk = decodeStderr.decode(d)
      if (!chunk) return
      stderr += chunk
      if (stderr.length > maxBytes) {
        stderr = stderr.slice(-maxBytes)
        truncated = true
      }
      opts.onOutput?.('stderr', cleanStderr(chunk))
    })
    child.on('error', (err) => finish('error', null, err.message))
    child.on('exit', (code) => finish('exit', code))
  })
}

/** 目录项排序：目录在前、同类按名称（与改造前 list_files 一致） */
function sortEntries(entries: WorkspaceDirEntry[]): WorkspaceDirEntry[] {
  return entries.sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1
    const bd = b.type === 'dir' ? 0 : 1
    return ad === bd ? a.name.localeCompare(b.name) : ad - bd
  })
}

/** 本地后端 */
export function createLocalBackend(root: string): WorkspaceBackend {
  const base = root
  return {
    kind: 'local',
    root: base,
    resolve: (p) => resolveInside(base, p),
    rel: (abs) => relPathOf(base, abs),
    join: (...parts) => join(...parts),
    dirname: (p) => dirname(p),
    basename: (p) => basename(p),

    async stat(p) {
      const st = await fs.stat(p).catch(() => null)
      if (!st) return null
      return { type: entryTypeOf(st), size: st.size, mtimeMs: st.mtimeMs }
    },

    async readDir(p) {
      const entries = await fs.readdir(p, { withFileTypes: true })
      const out: WorkspaceDirEntry[] = []
      for (const ent of entries) {
        const type: WorkspaceDirEntry['type'] = ent.isDirectory()
          ? 'dir'
          : ent.isFile()
            ? 'file'
            : ent.isSymbolicLink()
              ? 'symlink'
              : 'other'
        let size: number | undefined
        if (type === 'file') {
          size = await fs.stat(join(p, ent.name)).then((s) => s.size).catch(() => undefined)
        }
        out.push({ name: ent.name, type, size })
      }
      return sortEntries(out)
    },

    async readFile(p, opts) {
      if (opts?.maxBytes) {
        const st = await fs.stat(p)
        if (st.size > opts.maxBytes) {
          throw new Error(`文件过大（${st.size} 字节，超过 ${opts.maxBytes} 字节上限）`)
        }
      }
      return fs.readFile(p)
    },

    async writeFile(p, data, opts) {
      if (opts?.createParents !== false) await fs.mkdir(dirname(p), { recursive: true })
      if (!opts?.atomic) {
        await fs.writeFile(p, data)
        return
      }
      // 同目录临时文件 + rename：断线 / 崩溃时不会留下半份内容
      const tmp = join(dirname(p), `.fizz-tmp-${process.pid}-${Date.now()}`)
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, p).catch(async (err) => {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
        throw err
      })
    },

    async mkdirp(p) {
      await fs.mkdir(p, { recursive: true })
    },

    async remove(p, opts) {
      await fs.rm(p, { recursive: opts?.recursive ?? false, force: opts?.force ?? false })
    },

    async rename(from, to) {
      await fs.rename(from, to)
    },

    ignoreChecker: () => createIgnoreChecker(base),

    async search(opts: WorkspaceSearchOptions): Promise<WorkspaceSearchFile[]> {
      const re = new RegExp(opts.pattern, opts.caseInsensitive ? 'i' : '')
      const fileRe = opts.filePattern
        ? new RegExp(opts.filePattern, opts.caseInsensitive ? 'i' : '')
        : null
      const start = resolveInside(base, opts.subPath)
      const st = await fs.stat(start).catch(() => null)
      if (!st) throw new Error(`路径不存在：${opts.subPath || '.'}（相对于工作区根）`)
      const acc: WorkspaceSearchFile[] = []
      let hits = 0
      const pushFile = (file: string, fileHits: WorkspaceSearchFile['hits'], source?: string[]): void => {
        if (!fileHits.length) return
        const entry: WorkspaceSearchFile = { file, hits: fileHits }
        if (opts.context > 0 && source) entry.context = buildSearchContext(fileHits, source, opts.context)
        acc.push(entry)
      }
      const scan = async (abs: string, rel: string): Promise<void> => {
        if (hits >= opts.maxResults) return
        if (fileRe && !fileRe.test(rel.split('/').pop() ?? rel)) return
        const stat = await fs.stat(abs)
        if (stat.size > opts.maxFileBytes) return
        const buf = await fs.readFile(abs)
        if (buf.includes(0)) return
        const source = buf.toString('utf8').split('\n')
        const fileHits: WorkspaceSearchFile['hits'] = []
        for (let i = 0; i < source.length && hits < opts.maxResults; i++) {
          re.lastIndex = 0
          if (re.test(source[i])) {
            fileHits.push({ line: i + 1, text: source[i].trimEnd().slice(0, MAX_LINE_CHARS) })
            hits++
          }
        }
        pushFile(rel, fileHits, opts.context > 0 ? source : undefined)
      }
      const walk = async (dir: string): Promise<void> => {
        if (hits >= opts.maxResults) return
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const ent of entries) {
          if (hits >= opts.maxResults) return
          const abs = join(dir, ent.name)
          const rel = relPathOf(base, abs)
          if (opts.ignore(rel, ent.isDirectory())) continue
          if (ent.isDirectory()) {
            await walk(abs)
            continue
          }
          if (ent.isFile()) await scan(abs, rel)
        }
      }
      if (st.isFile()) {
        // 显式点名文件 = 明确意图：不走忽略规则（与改造前一致）
        await scan(start, relPathOf(base, start))
      } else {
        await walk(start)
      }
      return acc
    },

    async find(opts: WorkspaceFindOptions): Promise<string[]> {
      const re = globToRegExp(opts.pattern)
      const start = resolveInside(base, opts.subPath)
      const st = await fs.stat(start).catch(() => null)
      if (!st) throw new Error(`路径不存在：${opts.subPath || '.'}（相对于工作区根）`)
      const out: string[] = []
      const walk = async (dir: string): Promise<void> => {
        if (out.length >= opts.maxResults) return
        const entries = await fs.readdir(dir, { withFileTypes: true })
        entries.sort((a, b) => a.name.localeCompare(b.name))
        for (const ent of entries) {
          if (out.length >= opts.maxResults) return
          const abs = join(dir, ent.name)
          const rel = relPathOf(base, abs)
          if (opts.ignore(rel, ent.isDirectory())) continue
          if (ent.isDirectory()) await walk(abs)
          else if (ent.isFile() && re.test(rel)) out.push(rel)
        }
      }
      if (st.isFile()) {
        const rel = relPathOf(base, start)
        if (re.test(rel)) out.push(rel)
      } else {
        await walk(start)
      }
      return out
    },

    exec: (command, opts = {}) => localExec(command, opts.cwd ?? base, opts)
  }
}

/** 把命中行 ±context 合并成连续区间（与改造前的 formatter 同一套区间合并规则；远端 backend 也复用它） */
export function buildSearchContext(
  hits: WorkspaceSearchFile['hits'],
  source: string[],
  context: number
): Array<{ line: number; text: string; hit: boolean }> {
  const ranges: Array<[number, number]> = []
  for (const h of hits) {
    const s = Math.max(1, h.line - context)
    const e = Math.min(source.length, h.line + context)
    const last = ranges[ranges.length - 1]
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
    else ranges.push([s, e])
  }
  const hitLines = new Set(hits.map((h) => h.line))
  const out: Array<{ line: number; text: string; hit: boolean }> = []
  ranges.forEach(([s, e], idx) => {
    if (idx > 0) out.push({ line: 0, text: '--', hit: false })
    for (let n = s; n <= e; n++) {
      out.push({
        line: n,
        text: source[n - 1].trimEnd().slice(0, MAX_LINE_CHARS),
        hit: hitLines.has(n)
      })
    }
  })
  return out
}