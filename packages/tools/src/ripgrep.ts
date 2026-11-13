/**
 * 随包 ripgrep：给本地工作区的 `grep` / `glob` 用。
 *
 * 为什么不用系统 `rg`：Windows / macOS 用户机器上通常没有；而 Node 侧自己遍历
 * （`backend.ts` 里那套）在大仓库上慢一个数量级，且正则方言与 rg 有出入。
 *
 * 二进制从哪来（按顺序试，全失败就返回 null，调用方退回 JS 遍历）：
 * 1. `FIZZ_RG_PATH` 环境变量（排障用）；
 * 2. `@vscode/ripgrep` 的 `rgPath`（server / dev / 装了依赖的容器）；
 * 3. `PATH` 里的 `rg`（容器镜像用 apt 装了 ripgrep，见 runtime.Dockerfile）。
 *
 * ⚠️ Electron 打包后模块路径在 `app.asar` 里，而可执行文件必须解包
 *    （`app.asar.unpacked`，见 apps/desktop/package.json 的 asarUnpack）。
 *    这里做一次路径改写，否则 spawn 报 ENOTDIR。
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join, sep } from 'node:path'
import { DEFAULT_IGNORE_DIRS } from '@fizz/contracts/workspace'

let cached: string | null | undefined

/** asar 内的路径 → 解包后的真实路径 */
function unwrapAsar(p: string): string {
  const marker = `${sep}app.asar${sep}`
  return p.includes(marker) ? p.replace(marker, `${sep}app.asar.unpacked${sep}`) : p
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** 解析 rg 可执行文件；返回 null = 这台机器上没有可用的 ripgrep */
export async function resolveRgPath(): Promise<string | null> {
  if (cached !== undefined) return cached
  const fromEnv = process.env.FIZZ_RG_PATH
  if (fromEnv && existsSync(fromEnv)) {
    cached = fromEnv
    return cached
  }
  try {
    // 动态 import：容器 / 未装依赖的部署里这个包不存在，不能让整个模块加载失败
    const mod = (await import('@vscode/ripgrep')) as { rgPath?: unknown }
    if (typeof mod.rgPath === 'string') {
      const real = unwrapAsar(mod.rgPath)
      if (existsSync(real)) {
        cached = real
        return cached
      }
    }
  } catch {
    // 没装（容器镜像有 apt 的 rg，走下面 PATH 那条）
  }
  cached = findOnPath(process.platform === 'win32' ? 'rg.exe' : 'rg')
  return cached
}

/** 测试用：清掉缓存（不改变生产行为） */
export function resetRgPathCache(): void {
  cached = undefined
}

interface RipgrepRun {
  stdout: string
  stderr: string
  code: number
}

/** 跑一次 rg；`--json` 的 stdout 可能很大，这里只按需要收集（调用方给上限） */
function runRg(bin: string, args: string[], cwd: string, signal?: AbortSignal): Promise<RipgrepRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true, ...(signal ? { signal } : {}) })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => {
      // 只留最后一段：rg 的报错通常只有几行，前面是无关告警
      err = (err + d.toString('utf8')).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: err, code: code ?? 0 })
    })
  })
}

/** 默认忽略目录 → rg 的 `--glob=!…`（rg 自己还会遵守 .gitignore） */
function ignoreGlobs(): string[] {
  return [...DEFAULT_IGNORE_DIRS]
    .filter((name) => name !== '.git')
    .map((name) => `--glob=!**/${name}/**`)
}

export interface RipgrepSearchOptions {
  pattern: string
  caseInsensitive: boolean
  /** 工作区根（绝对路径）：命中路径按它换算成相对路径 */
  root: string
  /** 搜索起点（绝对路径，可以是文件或目录） */
  start: string
  /** 搜索的 glob：单个模式（`*.ts` / `*.{js,jsx}`） */
  includeGlob?: string
  maxResults: number
  maxFileBytes: number
  signal?: AbortSignal
}

export interface RipgrepMatchFile {
  file: string
  hits: Array<{ line: number; text: string }>
}

/**
 * 用 rg 搜内容。返回 `null` = 没有可用的 rg（调用方退回 JS 实现）。
 *
 * 搜索规则：遵守 `.gitignore`、不搜隐藏文件、跳过二进制；
 * 额外附上 Fizz 的默认忽略目录（`dist` / `node_modules` 等没写进 .gitignore 的也算）。
 */
export function buildSearchArgs(opts: RipgrepSearchOptions): string[] {
  return [
    '--json',
    '--max-filesize',
    String(opts.maxFileBytes),
    ...(opts.caseInsensitive ? ['--ignore-case'] : []),
    ...(opts.includeGlob ? [`--glob=${opts.includeGlob}`] : []),
    ...ignoreGlobs(),
    `--regexp=${opts.pattern}`,
    '--',
    opts.start
  ]
}

export async function ripgrepSearch(
  opts: RipgrepSearchOptions
): Promise<RipgrepMatchFile[] | null> {
  const bin = await resolveRgPath()
  if (!bin) return null
  const args = buildSearchArgs(opts)
  const run = await runRg(bin, args, opts.start, opts.signal)
  // rg: 0 = 有命中，1 = 无命中，2 = 出错（无效正则 / 路径不存在等）
  if (run.code === 1) return []
  if (run.code !== 0) throw new Error(`ripgrep failed: ${run.stderr.trim() || `exit ${run.code}`}`)

  const byFile = new Map<string, RipgrepMatchFile>()
  let total = 0
  for (const line of run.stdout.split('\n')) {
    if (!line) continue
    let event: {
      type?: string
      data?: {
        path?: { text?: string }
        lines?: { text?: string }
        line_number?: number
      }
    }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'match') continue
    const abs = event.data?.path?.text
    const text = event.data?.lines?.text
    const lineNo = event.data?.line_number
    if (!abs || typeof text !== 'string' || typeof lineNo !== 'number') continue
    const rel = toRelative(abs, opts.root)
    if (rel === null) continue
    let entry = byFile.get(rel)
    if (!entry) {
      entry = { file: rel, hits: [] }
      byFile.set(rel, entry)
    }
    entry.hits.push({ line: lineNo, text: text.replace(/\r?\n$/, '') })
    total += 1
    if (total >= opts.maxResults) break
  }
  return [...byFile.values()]
}

export interface RipgrepFindOptions {
  pattern: string
  /** 工作区根（绝对路径） */
  root: string
  /** 搜索起点（绝对路径） */
  start: string
  includeIgnored: boolean
  maxResults: number
  signal?: AbortSignal
}

/** 用 rg 找文件。返回 `null` = 没有可用的 rg。 */
export function buildFindArgs(opts: RipgrepFindOptions): string[] {
  return [
    '--files',
    `--glob=${opts.pattern}`,
    // glob **包含**隐藏与被忽略的文件，只排除版本库元数据
    ...(opts.includeIgnored ? ['--no-ignore', '--hidden'] : []),
    '--glob=!**/.git/**',
    '--glob=!**/.svn/**',
    '--glob=!**/.hg/**',
    '--glob=!**/.bzr/**',
    '--glob=!**/.jj/**',
    '--',
    opts.start
  ]
}

export async function ripgrepFind(opts: RipgrepFindOptions): Promise<string[] | null> {
  const bin = await resolveRgPath()
  if (!bin) return null
  const args = buildFindArgs(opts)
  const run = await runRg(bin, args, opts.start, opts.signal)
  if (run.code === 1) return []
  if (run.code !== 0) throw new Error(`ripgrep failed: ${run.stderr.trim() || `exit ${run.code}`}`)
  const out: string[] = []
  for (const line of run.stdout.split('\n')) {
    if (!line) continue
    const rel = toRelative(line, opts.root)
    if (rel === null) continue
    out.push(rel)
    if (out.length >= opts.maxResults) break
  }
  return out
}

/** rg 打印的是「绝对路径」（我们给的就是绝对起点），换算成相对工作区根 */
function toRelative(path: string, root: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === base) return ''
  if (!normalized.startsWith(`${base}/`)) return null
  return normalized.slice(base.length + 1)
}
