/**
 * 工作区路径安全与忽略规则。
 *
 * 安全约束：Agent 的一切文件操作都必须落在工作区根目录之内 ——
 * resolveInside 统一做「解析 + 越界检查」，任何工具入口都从这里拿绝对路径。
 *
 * 忽略规则：默认跳过构建产物 / 依赖目录 / 编辑器配置等，另读取 .gitignore
 * 追加规则（支持 ! 取反、尾 / 目录限定、首 / 锚定、* 与 ** 通配）。
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

/** 列表 / 搜索默认跳过的目录名（任意层级命中即跳过整棵子树） */
export const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'dist',
  'out',
  'build',
  'release',
  '.trae',
  '.workbuddy-ai',
  '.codeartsdoer',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  'coverage',
  'venv',
  '.venv',
  '__pycache__',
  'target',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
  'vendor',
  // Fizz 的工作区配置目录（快捷功能等，见 src/shared/workspace-config.ts）：
  // 它属于本地环境数据、不是项目代码，列表 / 搜索 / 文件树都跳过
  '.fizz'
])

export interface IgnoreRule {
  negate: boolean
  dirOnly: boolean
  anchored: boolean
  segments: string[]
}

/** 把相对工作区的路径解析为绝对路径，越界（.. / 盘符绝对路径）直接抛错 */
export function resolveInside(root: string, p: string): string {
  const abs = resolve(root, p)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界（不允许访问工作区之外）：${p}`)
  }
  return abs
}

/** 解析 .gitignore 文本为规则列表（行级注释 / 空行忽略） */
export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split('\n')) {
    let line = raw.trimEnd()
    if (!line || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    let anchored = false
    if (line.startsWith('/')) {
      anchored = true
      line = line.slice(1)
    }
    line = line.trim()
    if (!line) continue
    rules.push({ negate, dirOnly, anchored, segments: line.split('/').filter(Boolean) })
  }
  return rules
}

/** 单个路径段与规则段的通配匹配（* 与 ?，不支持字符类） */
function segMatch(pattern: string, seg: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(seg)
}

/** 规则段从 path[start] 开始顺序匹配 */
function matchAt(rule: string[], path: string[], start: number): boolean {
  if (rule.length === 0) return start === path.length
  const r = rule[0]
  if (r === '**') {
    for (let i = start; i <= path.length; i++) {
      if (matchAt(rule.slice(1), path, i)) return true
    }
    return false
  }
  if (start >= path.length) return false
  if (segMatch(r, path[start])) return matchAt(rule.slice(1), path, start + 1)
  return false
}

/** 规则是否命中路径：锚定规则从头匹配，非锚定可在任意位置开始 */
function matchSegments(rule: string[], path: string[], anchored: boolean): boolean {
  if (anchored) return matchAt(rule, path, 0)
  for (let i = 0; i <= path.length; i++) {
    if (matchAt(rule, path, i)) return true
  }
  return false
}

/**
 * `.gitignore` 的进程内缓存：**按 mtime + 大小做失效判据**。
 *
 * 早先只缓存规则、永不失效，于是「用户把某条规则删掉 / 补上一条」之后，文件树与
 * `list_files` 仍旧拿旧规则过滤，看起来就像「文件莫名消失」，只能重启服务端才好
 * —— 这种"改了没反应"最难排查。现在每次判定前先 `stat` 一下（比读文件便宜得多），
 * 文件没动就直接吃缓存、动了（或第一次出现、或被删掉）才重新解析。
 */
const gitignoreCache = new Map<string, { stamp: string; rules: IgnoreRule[] }>()

/** 管理工作区的 .gitignore（进程内缓存，避免每次工具调用都读盘） */
export async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  const file = join(root, '.gitignore')
  let stamp = 'missing'
  try {
    const st = await fs.stat(file)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    // 没有 .gitignore：保持默认规则（stamp 恒为 'missing'，后来建出来会立刻被认出来）
  }
  const cached = gitignoreCache.get(root)
  if (cached && cached.stamp === stamp) return cached.rules
  let rules: IgnoreRule[] = []
  if (stamp !== 'missing') {
    try {
      rules = parseGitignore(await fs.readFile(file, 'utf8'))
    } catch {
      // 读不出来（权限 / 竞态删除）：退回默认规则，不缓存
      return rules
    }
  }
  gitignoreCache.set(root, { stamp, rules })
  return rules
}

/**
 * 创建忽略判定函数。relPath 用 '/' 分隔（相对工作区根）；
 * 判定时对路径的每个前缀逐段检查（目录命中即整棵子树被忽略），
 * 后匹配的规则胜出（支持 ! 重新纳入）。
 *
 * 与 `createIgnoreChecker` 分开：远端后端从 SFTP 读 `.gitignore` 后要复用同一套
 * 匹配语义，只是规则来源不同。
 */
export function createIgnoreMatcher(
  rules: IgnoreRule[]
): (rel: string, isDir: boolean) => boolean {
  return (rel, isDir) => {
    const segs = rel.split('/').filter(Boolean)
    if (segs.length === 0) return false
    let ignored = false
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const isDirPart = i < segs.length - 1 || isDir
      if (DEFAULT_IGNORE_DIRS.has(seg) && isDirPart) return true
      const prefix = segs.slice(0, i + 1)
      for (const rule of rules) {
        if (rule.dirOnly && !isDirPart) continue
        if (matchSegments(rule.segments, prefix, rule.anchored)) ignored = !rule.negate
      }
    }
    return ignored
  }
}

/** 创建忽略判定函数（本地：规则从 `<root>/.gitignore` 读） */
export async function createIgnoreChecker(
  root: string
): Promise<(rel: string, isDir: boolean) => boolean> {
  return createIgnoreMatcher(await loadIgnoreRules(root))
}

/** 规范化相对路径展示（统一 '/' 分隔） */
export function relPathOf(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

// ---------- 远端（POSIX）路径 ----------

/**
 * 远端工作区路径校验：必须是 POSIX 绝对路径、不含 NUL / 换行，且不允许 `..` 段。
 *
 * 拒绝 `..` 是刻意的：远端根由用户填写，`/srv/app/../etc` 这类写法无法只靠
 * 字符串判断最终是否仍在工作区内；直接拒绝比事后猜更安全。返回规范化后的路径。
 */
export function validateRemoteWorkspacePath(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('远端工作区路径不能为空')
  if (/[\0\r\n]/.test(raw)) throw new Error('远端工作区路径包含非法字符')
  if (!raw.startsWith('/')) throw new Error('远端工作区路径必须是绝对路径（以 / 开头）')
  if (raw.split('/').includes('..')) throw new Error('远端工作区路径不允许包含 ..')
  const normalized = posix.normalize(raw)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/** 把相对远端的路径解析为 POSIX 绝对路径，越界直接抛错 */
export function resolveInsidePosix(root: string, p: string): string {
  const base = posix.resolve(root)
  const abs = posix.resolve(base, p || '.')
  const rel = posix.relative(base, abs)
  if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) {
    throw new Error(`路径越界（不允许访问工作区之外）：${p}`)
  }
  return abs
}

/** 远端相对路径展示（统一 '/'，根目录为 ''） */
export function remoteRelPathOf(root: string, abs: string): string {
  return posix.relative(posix.resolve(root), posix.resolve(abs))
}

/**
 * 把 glob 编译成 RegExp：`**` 跨目录，`*` / `?` 不跨 `/`。
 * 不含 `/` 的 glob（如 `*.ts`）自动补 `**` + `/` 前缀，让它能匹配任意层级 —— 符合直觉。
 */
export function globToRegExp(glob: string): RegExp {
  const raw = glob.trim()
  const pat = raw.includes('/') ? raw : `**/${raw}`
  let re = ''
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        i++
        if (pat[i + 1] === '/') {
          // `**/` —— 连同分隔符一起可选，避免 `**/*.ts` 强制要求中间多一层目录
          i++
          re += '(?:.*/)?'
        } else {
          // 结尾的 `**`（如 `foo/**`）—— 退化成「跨目录任意串」，否则会强制要求尾随 /
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`)
}

// ---------- 工作区后端 ----------

export type WorkspaceEntryType = 'file' | 'dir' | 'symlink' | 'other'

export interface WorkspaceStat {
  type: WorkspaceEntryType
  size: number
  mtimeMs?: number
}

export interface WorkspaceDirEntry {
  name: string
  type: WorkspaceEntryType
  /** 文件大小（拿不到时缺省；目录不填） */
  size?: number
}

export type WorkspaceExecReason = 'exit' | 'timeout' | 'aborted' | 'error'

export interface WorkspaceExecOptions {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 单条输出流（stdout / stderr）各自的内存上限（字符） */
  maxBytes?: number
  /** 实时增量（已解码，未剥 ANSI 之外的清洗由调用方做） */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
}

export interface WorkspaceExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  reason: WorkspaceExecReason
  /** `reason === 'error'` 时的可读原因（启动失败 / 连接断开） */
  error?: string
  truncated: boolean
}

export interface WorkspaceSearchHit {
  line: number
  text: string
}

/** 一个文件的命中；`context` 仅供需要上下文的调用方使用 */
export interface WorkspaceSearchFile {
  file: string
  hits: WorkspaceSearchHit[]
  /** 命中行 ±context 合并后的连续区间；`line: 0` 表示区间之间的分隔（渲染成 `--`） */
  context?: Array<{ line: number; text: string; hit: boolean }>
}

export interface WorkspaceSearchOptions {
  pattern: string
  caseInsensitive: boolean
  /** 搜索起点（相对工作区根，'' = 根） */
  subPath: string
  /** 文件名正则（与本地同一套 JS RegExp 语义，由实现自行编译/后置过滤） */
  filePattern?: string
  /** 每条命中附带的前后行数（0–5） */
  context: number
  maxResults: number
  maxFileBytes: number
  ignore: (rel: string, isDir: boolean) => boolean
}

export interface WorkspaceFindOptions {
  /** 文件名 glob */
  pattern: string
  subPath: string
  maxResults: number
  ignore: (rel: string, isDir: boolean) => boolean
}

/**
 * 工作区文件 / 命令后端。
 *
 * 接口放 contracts（纯类型），本地实现在 `@fizz/tools`，远端实现在 `apps/server`
 * —— ssh2 绝不进 tools，保证容器运行时与浏览器产物不被拖进 SSH 依赖。
 *
 * `resolve` 与本地 `resolveInside` 同义：相对路径进、绝对路径出，越界抛错。
 */
export interface WorkspaceBackend {
  readonly kind: 'local' | 'remote'
  readonly root: string

  resolve(p: string): string
  rel(abs: string): string
  join(...parts: string[]): string
  dirname(p: string): string
  basename(p: string): string

  stat(p: string): Promise<WorkspaceStat | null>
  readDir(p: string): Promise<WorkspaceDirEntry[]>
  readFile(p: string, opts?: { maxBytes?: number }): Promise<Buffer>
  writeFile(
    p: string,
    data: Buffer | string,
    opts?: { atomic?: boolean; createParents?: boolean }
  ): Promise<void>
  mkdirp(p: string): Promise<void>
  remove(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>

  ignoreChecker(): Promise<(rel: string, isDir: boolean) => boolean>
  search(opts: WorkspaceSearchOptions): Promise<WorkspaceSearchFile[]>
  find(opts: WorkspaceFindOptions): Promise<string[]>

  exec(command: string, opts?: WorkspaceExecOptions): Promise<WorkspaceExecResult>

  dispose?(): Promise<void>
}
