/**
 * 工作区后端的**远端实现**：Agent 的读写 / 搜索 / 查找 / 命令全部发到 SSH 主机上。
 *
 * 组成：
 * - 文件元信息与读写走 `SftpService`（分片池很成熟，不改它）；
 * - 搜索 / 查找 / 命令走 `RemoteExecService`（一条命令一个 channel），
 *   命令构造与输出解析在 `remote-search-parse.ts` / `remote-command.ts`；
 * - 忽略规则从远端 `<root>/.gitignore` 经 SFTP 读取，按 `mtime:size` 缓存，
 *   与本地 `createIgnoreChecker` 共用 `parseGitignore` + `createIgnoreMatcher`。
 *
 * 与本地后端的语义对齐点（模型看不到「本地 / 远端」的差异）：
 * - 路径一律相对工作区根，越界抛错（`resolveInsidePosix`）；
 * - 搜索的 `hits` / `context` 形状、单行 200 字符截断、`maxResults` 逐行计数；
 * - 查找返回相对 POSIX 路径，glob 用同一份 `globToRegExp`；
 * - `exec` 的 `stdout / stderr / exitCode / reason / truncated` 与 `localExec` 同形。
 *
 * 已知差异：SFTP 的 readdir 只回文件名，`readDir` 的类型来自逐条 lstat，拿不到
 * 「软链接」这一档 —— 软链接按文件展示（本地后端能区分出来）。这不影响读写。
 */
import { posix } from 'node:path'
import {
  createIgnoreMatcher,
  globToRegExp,
  parseGitignore,
  remoteRelPathOf,
  resolveInsidePosix,
  type IgnoreRule,
  type WorkspaceBackend,
  type WorkspaceDirEntry,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceFindOptions,
  type WorkspaceSearchFile,
  type WorkspaceSearchOptions,
  type WorkspaceStat
} from '@fizz/contracts/workspace'
import { MAX_LINE_CHARS, buildSearchContext } from '@fizz/tools'
import { sftpService } from './sftp'
import { remoteExecService } from './exec'
import {
  buildFindCommand,
  buildGrepCommand,
  buildRgCommand,
  isMissingRipgrep,
  parseFindNull,
  parseGrepZ,
  parseRgJson,
  type ParsedSearchLine,
  type SearchCommandOptions
} from './remote-search-parse'

/** `.gitignore` 的读取上限：正常项目远小于它，超出直接按「没有规则」处理 */
const MAX_GITIGNORE_BYTES = 1_048_576

interface CachedIgnore {
  stamp: string
  matcher: (rel: string, isDir: boolean) => boolean
}

/** `${hostId}:${root}` → 上次成功解析的忽略规则（按远端文件的 mtime:size 失效） */
const ignoreCache = new Map<string, CachedIgnore>()

/** 远端不存在 / 不是文件时抛一句人能读的话（与本地 readTextFile 的文案同一口径） */
function missingPath(subPath: string): Error {
  return new Error(`路径不存在：${subPath || '.'}（相对于工作区根）`)
}

function trimmedLine(text: string): string {
  return text.trimEnd().slice(0, MAX_LINE_CHARS)
}

/** 把搜索输出按文件分组，同时施加忽略 / 文件名正则 / 命中上限 */
function collectSearch(
  lines: ParsedSearchLine[],
  opts: WorkspaceSearchOptions,
  fileRe: RegExp | null,
  explicitFile: boolean
): WorkspaceSearchFile[] {
  const byFile = new Map<string, WorkspaceSearchFile>()
  let hits = 0
  for (const line of lines) {
    if (hits >= opts.maxResults) break
    const name = line.file.split('/').pop() ?? line.file
    if (fileRe && !fileRe.test(name)) continue
    if (!explicitFile && opts.ignore(line.file, false)) continue
    let entry = byFile.get(line.file)
    if (!entry) {
      entry = { file: line.file, hits: [] }
      byFile.set(line.file, entry)
    }
    if (line.hit) {
      entry.hits.push({ line: line.line, text: trimmedLine(line.text) })
      hits++
    }
  }
  return [...byFile.values()].filter((f) => f.hits.length > 0).sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * rg 的上下文行已经带行号与正文，这里按**已选中的命中**重建区间 —— 与本地
 * `buildSearchContext` 同一套合并规则，区间之间插 `line: 0` 分隔。
 *
 * 不用 rg 输出里所有行：命中数已到 `maxResults` 时，后面还有未选中的命中，
 * 直接铺开会让上下文里混进超额的 hit 行。
 */
function attachRgContext(
  files: WorkspaceSearchFile[],
  lines: ParsedSearchLine[],
  context: number
): void {
  const byFile = new Map<string, Map<number, ParsedSearchLine>>()
  for (const line of lines) {
    let rows = byFile.get(line.file)
    if (!rows) {
      rows = new Map()
      byFile.set(line.file, rows)
    }
    // 同一行不会重复出现；真重复了以第一条为准即可
    if (!rows.has(line.line)) rows.set(line.line, line)
  }
  for (const file of files) {
    const rows = byFile.get(file.file)
    if (!rows) continue
    const selected = new Set(file.hits.map((h) => h.line))
    const ranges: Array<[number, number]> = []
    for (const h of file.hits) {
      const s = Math.max(1, h.line - context)
      const e = h.line + context
      const last = ranges[ranges.length - 1]
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
      else ranges.push([s, e])
    }
    const out: NonNullable<WorkspaceSearchFile['context']> = []
    ranges.forEach(([s, e], idx) => {
      if (idx > 0) out.push({ line: 0, text: '--', hit: false })
      for (let n = s; n <= e; n++) {
        const row = rows.get(n)
        if (!row) continue
        out.push({ line: n, text: trimmedLine(row.text), hit: selected.has(n) })
      }
    })
    if (out.length > 0) file.context = out
  }
}

function requireExecOk(result: WorkspaceExecResult, what: string): void {
  if (result.reason === 'error') throw new Error(result.error ?? `${what}失败`)
  if (result.reason === 'timeout') throw new Error(`${what}超时（远端命令执行超过 120 秒）`)
  if (result.reason === 'aborted') throw new Error(`${what}已中止`)
  if (result.exitCode === 2) {
    throw new Error(`${what}失败：${result.stderr.trim() || '远端命令报错'}`)
  }
}

/**
 * 建一个绑定 `hostId` + 远端目录的 backend。每次 `runAgent` 现建一个，
 * 连接由两个 service 池化复用，backend 本身不持有 socket。
 */
export function createRemoteBackend(hostId: string, rawRoot: string): WorkspaceBackend {
  const base = posix.resolve(rawRoot)
  const cacheKey = `${hostId}:${base}`

  const relOf = (abs: string): string => remoteRelPathOf(base, abs)
  const startRel = (abs: string): string => {
    const rel = relOf(abs)
    return rel === '' ? '.' : rel
  }

  const exec = async (
    command: string,
    opts: WorkspaceExecOptions = {}
  ): Promise<WorkspaceExecResult> => {
    // 执行目录也必须落在工作区内：`resolveInsidePosix` 对绝对路径同样做越界检查
    const cwd = opts.cwd ? resolveInsidePosix(base, opts.cwd) : base
    return remoteExecService.exec(hostId, command, { ...opts, cwd })
  }

  const readGitignore = async (): Promise<(rel: string, isDir: boolean) => boolean> => {
    const file = posix.join(base, '.gitignore')
    const st = await sftpService.stat(hostId, file).catch(() => null)
    const stamp = st ? `${st.mtimeMs ?? 0}:${st.size}` : 'missing'
    const cached = ignoreCache.get(cacheKey)
    if (cached && cached.stamp === stamp) return cached.matcher
    let rules: IgnoreRule[] = []
    if (st) {
      try {
        const buf = await sftpService.readFile(hostId, file, { maxBytes: MAX_GITIGNORE_BYTES })
        rules = parseGitignore(buf.toString('utf8'))
      } catch {
        // 读不出来（权限 / 竞态删除）：退回默认规则，且不缓存这次结果
        return createIgnoreMatcher([])
      }
    }
    const matcher = createIgnoreMatcher(rules)
    ignoreCache.set(cacheKey, { stamp, matcher })
    return matcher
  }

  const searchRemote = async (opts: WorkspaceSearchOptions): Promise<WorkspaceSearchFile[]> => {
    const start = resolveInsidePosix(base, opts.subPath)
    const st = await sftpService.stat(hostId, start)
    if (!st) throw missingPath(opts.subPath)
    const explicitFile = st.type !== 'dir'
    const target = startRel(start)
    const commandOpts: SearchCommandOptions = {
      pattern: opts.pattern,
      caseInsensitive: opts.caseInsensitive,
      subPath: target,
      context: opts.context,
      maxFileBytes: opts.maxFileBytes
    }
    const fileRe = opts.filePattern
      ? new RegExp(opts.filePattern, opts.caseInsensitive ? 'i' : '')
      : null

    // ① 首选 rg --json：结构化输出，路径含空格 / 冒号也安全，自带上下文
    const rg = await exec(buildRgCommand(commandOpts))
    if (!isMissingRipgrep(rg.exitCode, rg.stderr)) {
      requireExecOk(rg, '搜索')
      const parsed = parseRgJson(rg.stdout)
      const files = collectSearch(parsed, opts, fileRe, explicitFile)
      if (opts.context > 0) attachRgContext(files, parsed, opts.context)
      return files
    }

    // ② 没有 rg：grep -rIZnE 兜底（只给命中行，上下文由 SFTP 读文件补齐）
    const grep = await exec(buildGrepCommand(commandOpts))
    requireExecOk(grep, '搜索')
    const parsed = parseGrepZ(grep.stdout)
    const files = collectSearch(parsed, opts, fileRe, explicitFile)
    if (opts.context === 0) return files

    for (const file of files) {
      const abs = resolveInsidePosix(base, file.file)
      const info = await sftpService.stat(hostId, abs).catch(() => null)
      // 与本地 scan 一致：超大文件整份跳过（它本来就不该出现在搜索结果里）
      if (!info || info.type === 'dir' || info.size > opts.maxFileBytes) continue
      const buf = await sftpService.readFile(hostId, abs, { maxBytes: opts.maxFileBytes })
      if (buf.includes(0)) continue
      const source = buf.toString('utf8').split('\n')
      file.context = buildSearchContext(file.hits, source, opts.context)
    }
    return files
  }

  const findRemote = async (opts: WorkspaceFindOptions): Promise<string[]> => {
    const start = resolveInsidePosix(base, opts.subPath)
    const st = await sftpService.stat(hostId, start)
    if (!st) throw missingPath(opts.subPath)
    const re = globToRegExp(opts.pattern)
    if (st.type !== 'dir') {
      // 显式点名文件 = 明确意图：不走忽略规则（与本地一致）
      const rel = relOf(start)
      return re.test(rel) ? [rel] : []
    }
    const run = await exec(buildFindCommand(startRel(start)), { timeoutMs: 120_000 })
    requireExecOk(run, '查找')
    const out: string[] = []
    for (const rel of parseFindNull(run.stdout)) {
      if (out.length >= opts.maxResults) break
      if (!re.test(rel)) continue
      if (opts.ignore(rel, false)) continue
      out.push(rel)
    }
    return out.sort((a, b) => a.localeCompare(b))
  }

  return {
    kind: 'remote',
    root: base,
    resolve: (p) => resolveInsidePosix(base, p),
    rel: relOf,
    join: (...parts) => posix.join(...parts),
    dirname: (p) => posix.dirname(p),
    basename: (p) => posix.basename(p),

    async stat(p) {
      const st = await sftpService.stat(hostId, p)
      if (!st) return null
      const type: WorkspaceStat['type'] = st.type
      return {
        type,
        size: st.size,
        ...(st.mtimeMs !== undefined ? { mtimeMs: st.mtimeMs } : {})
      }
    },

    async readDir(p) {
      const entries = await sftpService.list(hostId, p)
      return entries.map((ent): WorkspaceDirEntry => {
        if (ent.isDir) return { name: ent.name, type: 'dir' }
        // 链接按 lstat 报 symlink（文件树据此再 stat 一次跟随链接），其余当普通文件
        if (ent.isSymlink) return { name: ent.name, type: 'symlink' }
        const out: WorkspaceDirEntry = { name: ent.name, type: 'file' }
        out.size = ent.size
        return out
      })
    },

    readFile: (p, opts) => sftpService.readFile(hostId, p, opts),

    writeFile: (p, data, opts) => sftpService.writeBuffer(hostId, p, data, opts),

    mkdirp: (p) => sftpService.mkdirs(hostId, p),

    remove: (p, opts) => sftpService.removePath(hostId, p, opts),

    rename: (from, to) => sftpService.rename(hostId, from, to),

    ignoreChecker: readGitignore,

    search: searchRemote,

    find: findRemote,

    exec
  }
}