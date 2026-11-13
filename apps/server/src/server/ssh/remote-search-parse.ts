/**
 * 远端搜索 / 查找的**命令构造与输出解析**（纯函数，不碰网络）。
 *
 * 三条路各对应一种远端能力：
 * - `rg --json`：首选。结构化输出对「路径里有空格 / 冒号 / 引号」天然安全，也能直接给上下文行；
 * - `grep -rIZnE`（`-Z` = 文件名后放 NUL）：没有 rg 时兜底，只取命中行；
 * - `find ... -print0`：按文件名查找，NUL 分隔。
 *
 * 路径都相对**工作区根**：调用方把 `cwd` 设成根，参数传 `.` 或相对子路径。
 */
import { DEFAULT_IGNORE_DIRS } from '@fizz/contracts/workspace'
import { shellQuote } from './remote-command'

/** rg / grep 的一行（`hit: false` 是上下文行） */
export interface ParsedSearchLine {
  file: string
  line: number
  text: string
  hit: boolean
}

/** `./src/a.ts` → `src/a.ts`；远端绝对路径不应出现，出现了也按相对处理 */
export function normalizeRemoteRel(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  return p.replace(/^\/+/, '')
}

export interface SearchCommandOptions {
  pattern: string
  caseInsensitive: boolean
  /** 搜索起点（相对工作区根，'' = 根） */
  subPath: string
  context: number
  maxFileBytes: number
  /** dsh 的 include：单个 glob，直接喂 `--glob`（不给 = 不限定文件名） */
  includeGlob?: string
}

/** rg 命令：`--no-config` 防止用户家目录的 rg 配置改变输出结构 */
export function buildRgCommand(opts: SearchCommandOptions): string {
  const args = [
    'rg',
    '--json',
    '--hidden',
    '--no-config',
    '--line-number',
    '--max-filesize',
    String(opts.maxFileBytes),
    '--max-columns',
    '500',
    '--max-columns-preview'
  ]
  if (opts.caseInsensitive) args.push('-i')
  if (opts.includeGlob) args.push('--glob', opts.includeGlob)
  if (opts.context > 0) args.push('--context', String(opts.context))
  for (const dir of DEFAULT_IGNORE_DIRS) args.push('--glob', `!**/${dir}/**`)
  args.push('--', opts.pattern, opts.subPath || '.')
  return `LC_ALL=C ${args.map(shellQuote).join(' ')}`
}

/** grep 兜底命令（没有上下文能力；上下文由调用方读文件补齐） */
export function buildGrepCommand(opts: SearchCommandOptions): string {
  const args = ['grep', '-rIZnE', '--binary-files=without-match']
  for (const dir of DEFAULT_IGNORE_DIRS) args.push('--exclude-dir', dir)
  if (opts.caseInsensitive) args.push('-i')
  args.push('--', opts.pattern, opts.subPath || '.')
  return `LC_ALL=C ${args.map(shellQuote).join(' ')}`
}

/**
 * find 命令：先把忽略目录剪掉（`-prune`），再输出文件。
 * 只做「列出候选」，glob 与二次忽略由调用方在 JS 侧判（与本地后端同一套语义）。
 */
export function buildFindCommand(subPath: string, includeIgnored = false): string {
  if (includeIgnored) {
    // dsh 的 glob 语义：连隐藏与被忽略的文件一起找，只交给 rg 那套 VCS 排除
    return `find ${shellQuote(subPath || '.')} -type f -print0`
  }
  const names = [...DEFAULT_IGNORE_DIRS]
  const start = subPath || '.'
  if (names.length === 0) return `find ${shellQuote(start)} -type f -print0`
  const prune = names.map((name) => `-name ${shellQuote(name)}`).join(' -o ')
  return (
    `find ${shellQuote(start)} \\( -type d \\( ${prune} \\) -prune \\) ` +
    '-o -type f -print0'
  )
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 解析 `rg --json`：match / context 两类事件；其余（begin / end / summary）忽略 */
export function parseRgJson(stdout: string): ParsedSearchLine[] {
  const out: ParsedSearchLine[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let event: {
      type?: string
      data?: {
        path?: { text?: string }
        line_number?: number
        lines?: { text?: string }
      }
    }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }
    if (event.type !== 'match' && event.type !== 'context') continue
    const file = normalizeRemoteRel(textOf(event.data?.path?.text))
    const lineNo = event.data?.line_number
    if (!file || typeof lineNo !== 'number' || lineNo < 1) continue
    out.push({
      file,
      line: lineNo,
      // rg 的 lines.text 带行尾换行；只去掉一个换行，保留行内空白语义
      text: textOf(event.data?.lines?.text).replace(/\r?\n$/, ''),
      hit: event.type === 'match'
    })
  }
  return out
}

/**
 * 解析 `grep -rIZnE` 输出。
 *
 * 形状是 `文件名\0行号:正文\n` 依次相接 —— NUL **只**在文件名后，所以不能整段
 * `split('\0')`（下一个文件名会粘在上一条正文的换行后面）。按「NUL 取文件名、换行取正文」
 * 一步步往前切。
 */
export function parseGrepZ(stdout: string): ParsedSearchLine[] {
  const out: ParsedSearchLine[] = []
  let rest = stdout
  for (;;) {
    const nul = rest.indexOf('\0')
    if (nul < 0) break
    const file = normalizeRemoteRel(rest.slice(0, nul))
    rest = rest.slice(nul + 1)
    const nl = rest.indexOf('\n')
    const entry = nl < 0 ? rest : rest.slice(0, nl)
    rest = nl < 0 ? '' : rest.slice(nl + 1)
    const m = /^(\d+):([\s\S]*)$/.exec(entry)
    if (!file || !m) continue
    out.push({ file, line: Number(m[1]), text: m[2], hit: true })
  }
  return out
}

/** 解析 `find -print0` 输出（路径里的空格 / 换行都不会被拆开） */
export function parseFindNull(stdout: string): string[] {
  return stdout
    .split('\0')
    .map(normalizeRemoteRel)
    .filter(Boolean)
}

/** rg 并不存在（或不可执行）时的判据：退出码 127 / 报「找不到命令」 */
export function isMissingRipgrep(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 127) return true
  return /(?:^|\n)(?:sh: |bash: )?(?:rg|ripgrep): (?:command )?not found/i.test(stderr)
}