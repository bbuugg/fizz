/**
 * 项目约束文档（`AGENTS.md`）与分层规则。
 *
 * 文档来源分两类，每轮对话开始时现读、合并后整段注入系统提示词：
 *
 * 1. **全局规则**：`<配置目录>/AGENTS.md`（缺省 `~/.config/fizz/AGENTS.md`，
 *    `CLAUDE.md` 作兼容回落）。跨项目通用的个人偏好放这里；
 * 2. **项目规则**：工作区根目录的 `AGENTS.md` / `CLAUDE.md`。
 *
 * **子目录规则**不整段注入，而是在模型 `read_file` / `list_files` 碰到该目录时按需追加
 * （见 `readNestedProjectDocs`）—— 规则要作用于某目录的代码时才需要它，提前把所有
 * `AGENTS.md` 收进来只会稀释上下文。
 *
 * 两类来源都支持行内 `@相对路径` 导入（递归、循环保护、限制在工作区 / 配置目录内）。
 *
 * 为什么根文档**全文注入**，而不是「给个路径让模型自己 read_file」：
 * 约束要在模型**动手之前**就生效。等它想起来去读时，第一版改动往往已经写歪了。
 * 渐进式披露（先给清单、正文按需加载）适合「技能」这种按任务触发的东西，
 * 不适合「全程适用的规则」—— 规则必须一直在场。
 *
 * 为什么根文档只读**工作区根目录**、不向上找父目录：
 * 工作区就是用户在 Fizz 里选定的项目根，语义明确；向上递归会在 monorepo 里
 * 把无关的父级文档一起吸进来，反而稀释了真正的项目约束。
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getLanguage } from '@fizz/i18n'

/** 依次尝试的文件名：AGENTS.md 为主，CLAUDE.md 作兼容回落 */
export const PROJECT_DOC_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/**
 * 注入提示词的字符上限（超出按章节边界截断）。
 *
 * 取 16K（≈4~6k token）：这个量级能装下正常的 AGENTS.md（多为几千到一两万字符），
 * 又不会让「每轮固定开销」失控 —— 上限越大，长会话越早被顶到压缩线，被压掉的
 * 反而是真正有价值的对话内容。
 *
 * 早先取 64K 是过于宽松的：本项目自己那份已经 13K，而按 64K 算还能再涨 5 倍；
 * 提示词里每多 1 万字符，就是每一轮请求都多付一次。超出部分由截断提示引导模型
 * 按需 `read_file` 补全 —— 成本从「每轮都付」变成「真用到才付」。
 */
const MAX_PROJECT_DOC_CHARS = 16 * 1024

/** 子目录规则单条上限：按需加载的文档不该再吃掉半个上下文 */
const MAX_NESTED_DOC_CHARS = 8 * 1024

/** 超过这个大小就不读了：防的是被误命名成 AGENTS.md 的巨型文件（正常文档不会有这么大） */
const MAX_READ_BYTES = 4 * 1024 * 1024

/** `@import` 递归深度上限（防手写链式导入把每轮成本拉满） */
const MAX_IMPORT_DEPTH = 5
/** 一次最多展开多少个导入文件（同一层与递归合计） */
const MAX_IMPORTED_FILES = 40
/** 单次工具调用最多附带几份子目录规则（通常只命中 1 份） */
const MAX_NESTED_PER_CALL = 3

/** 子目录规则向上收集时跳过的目录（与工作区文件树同一套常识性黑名单） */
const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.fizz',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.cache'
])

/** 合并后的来源（提示词里要列给模型看，截断时也靠它指路） */
export interface ProjectDocSource {
  /** 绝对路径 */
  file: string
  /** 人读的标签：全局规则 / 项目规则 */
  label: string
}

/** 工作区根目录里的一份项目约束文档（可能是多个来源合并后的结果） */
export interface ProjectDoc {
  /** 主来源绝对路径（项目根文档优先；截断提示里要告诉模型去哪读全文） */
  file: string
  /** 文件名（AGENTS.md / CLAUDE.md） */
  name: string
  /** 正文，可能已截断 */
  text: string
  /** 是否被截断 */
  truncated: boolean
  /** 截断处的章节标题（按 `## ` 边界截断时能拿到） */
  section?: string
  /** 合并前的总字符数（截断提示里说明「给了多少」） */
  totalChars: number
  /** 合并进来的所有来源（顺序 = 注入顺序） */
  sources: ProjectDocSource[]
}

/**
 * 全局规则目录：`FIZZ_CONFIG_DIR` > `$XDG_CONFIG_HOME/fizz` > `~/.config/fizz`。
 *
 * Windows 上刻意仍用 `~/.config/fizz`（而不是 `%APPDATA%`）：用户手写的路径、文档、
 * 跨机器同步都按这个约定走；需要换位置时设 `FIZZ_CONFIG_DIR` 即可。
 */
export function resolveGlobalConfigDir(): string {
  const explicit = process.env.FIZZ_CONFIG_DIR?.trim()
  if (explicit) return resolve(explicit)
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  if (xdg) return join(xdg, 'fizz')
  return join(homedir(), '.config', 'fizz')
}

/**
 * 按「二级标题」边界截断：宁可少给一条完整规则，也不要把一条规则切成半句话
 * （半句话比没有更糟 —— 模型会拿它当完整规则执行）。
 *
 * 最后一个 `## ` 位置太靠前（不足上限一半）说明这份文档不是按二级标题分节的，
 * 那就硬截 —— 否则可能只注入一个标题就结束了。
 */
function truncateAtSection(text: string, max: number): { text: string; section?: string } {
  if (text.length <= max) return { text }
  const head = text.slice(0, max)
  const cut = head.lastIndexOf('\n## ')
  if (cut < max / 2) return { text: head }
  const line = head.slice(cut + 1).split('\n', 1)[0] ?? ''
  const section = line.replace(/^#+\s*/, '').trim()
  return { text: head.slice(0, cut), ...(section ? { section } : {}) }
}

/** 绝对路径是否在 root 内（含 root 本身）；用 path.relative 判，跨盘符也安全 */
function isInside(root: string, abs: string): boolean {
  const rel = relative(resolve(root), resolve(abs))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 统一成 `/` 分隔（提示词 / glob 都按 POSIX 口径），相对工作区根 */
function toPosixRelative(root: string, abs: string): string {
  return relative(resolve(root), resolve(abs)).split(sep).join('/')
}

async function readDocFile(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(/* turbopackIgnore: true */ file)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_READ_BYTES) return null
    const raw = await fs.readFile(/* turbopackIgnore: true */ file, 'utf8')
    // BOM 会让模型把开头的 `#` 也当成内容读进去
    const text = raw.replace(/^\uFEFF/, '').trim()
    return text || null
  } catch {
    return null
  }
}

/**
 * 展开文档里的 `@相对路径` 导入（整行一条，与 Claude Code 的约定一致）。
 *
 * - 相对路径按**当前文档所在目录**解析；也接受绝对路径；
 * - 目标必须落在 `boundary`（项目文档 = 工作区根，全局文档 = 配置目录）内，
 *   否则只留一句跳过说明 —— 不让一份项目文档把 `/etc/passwd` 吸进提示词；
 * - 循环导入直接丢弃；文件数 / 深度都有上限。
 */
async function expandImports(
  text: string,
  file: string,
  opts: { boundary: string; seen: Set<string>; depth: number; count: { value: number } }
): Promise<string> {
  if (opts.depth >= MAX_IMPORT_DEPTH) return text
  const out: string[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*@(\S+)\s*$/.exec(line)
    if (!match || match[1].includes('://')) {
      out.push(line)
      continue
    }
    const target = match[1].replace(/^['"]|['"]$/g, '')
    const abs = isAbsolute(target) ? resolve(target) : resolve(dirname(file), target)
    if (!isInside(opts.boundary, abs)) {
      out.push(`<!-- 已跳过工作区外的导入：@${target} -->`)
      continue
    }
    if (opts.seen.has(abs)) continue
    if (opts.count.value >= MAX_IMPORTED_FILES) {
      out.push(line)
      continue
    }
    const imported = await readDocFile(abs)
    // 读不到就原样保留：文档里单独一行 `@scope/pkg` 之类的普通文本不该被当成坏导入
    if (!imported) {
      out.push(line)
      continue
    }
    opts.seen.add(abs)
    opts.count.value += 1
    out.push(
      await expandImports(imported, abs, { ...opts, depth: opts.depth + 1 })
    )
  }
  return out.join('\n')
}

interface LoadedDoc {
  file: string
  name: string
  text: string
}

/** 在某个目录里按 `AGENTS.md` → `CLAUDE.md` 顺序取第一份可读文档，并展开导入 */
async function loadDocInDir(
  dir: string,
  opts: { boundary: string; seen: Set<string>; count: { value: number } }
): Promise<LoadedDoc | null> {
  for (const name of PROJECT_DOC_NAMES) {
    // 路径来自用户的工作区（运行时才知道），不是构建期输入：显式让 Turbopack 别跟踪，
    // 否则「动态文件系统访问」会把整个项目（含 public/）都打进服务端产物
    const file = join(/* turbopackIgnore: true */ dir, name)
    if (opts.seen.has(file)) continue
    const raw = await readDocFile(file)
    if (!raw) continue
    opts.seen.add(file)
    const text = await expandImports(raw, file, { ...opts, depth: 0 })
    return { file, name, text }
  }
  return null
}

/**
 * 读根文档（全局 + 项目）；一份都没读到返回 null。
 *
 * 每轮对话现读一次（与技能扫描同样的做法）：用户改完 AGENTS.md，
 * **下一轮就生效**，不需要重启也不需要缓存失效逻辑。几十 KB 的读盘代价可以忽略。
 */
export async function readProjectDoc(workspacePath: string): Promise<ProjectDoc | null> {
  if (!workspacePath) return null
  const seen = new Set<string>()
  const count = { value: 0 }
  const pieces: Array<{ label: string; doc: LoadedDoc }> = []

  const globalDir = resolveGlobalConfigDir()
  const global = await loadDocInDir(globalDir, { boundary: globalDir, seen, count })
  if (global) pieces.push({ label: '全局规则', doc: global })

  const project = await loadDocInDir(workspacePath, { boundary: workspacePath, seen, count })
  if (project) pieces.push({ label: '项目规则', doc: project })

  if (pieces.length === 0) return null

  // 单来源保持原样（不额外加标题，老行为逐字节不变）；多来源才加分层标签
  const merged =
    pieces.length === 1
      ? pieces[0].doc.text
      : pieces
          .map(
            ({ label, doc }) =>
              `### ${label}（${doc.file}）\n\n${doc.text}`
          )
          .join('\n\n')
  const primary = project ?? global ?? pieces[0].doc
  const { text: body, section } = truncateAtSection(merged, MAX_PROJECT_DOC_CHARS)
  return {
    file: primary.file,
    name: primary.name,
    text: body,
    truncated: body.length < merged.length,
    ...(section ? { section } : {}),
    totalChars: merged.length,
    sources: pieces.map(({ label, doc }) => ({ file: doc.file, label }))
  }
}

/** 从历史消息里恢复「已经注入过哪些子目录规则」（marker 里的相对路径） */
export function extractNestedDocPaths(history: unknown): Set<string> {
  const loaded = new Set<string>()
  let serialized: string
  try {
    serialized = JSON.stringify(history ?? [])
  } catch {
    return loaded
  }
  const re = /<nested-project-doc path="([^"]+)"/g
  for (const match of serialized.matchAll(re)) loaded.add(match[1])
  return loaded
}

/**
 * 读一份**子目录规则**（按需加载）：从目标路径所在目录向上找到工作区根，
 * 把还没注入过的 `AGENTS.md` / `CLAUDE.md` 依次收集（根目录的文档已整段注入，跳过）。
 *
 * 返回 null = 没有新规则；返回文本会附在 `read_file` / `list_files` 的结果后面。
 * `loaded` 由调用方持有（按会话恢复），同一个 marker 不会重复注入。
 */
export async function readNestedProjectDocs(
  workspacePath: string,
  targetPath: string,
  loaded: Set<string>,
  isDirectory: boolean
): Promise<string | null> {
  if (!workspacePath) return null
  const root = resolve(workspacePath)
  const target = resolve(targetPath)
  if (!isInside(root, target)) return null
  // 正在读的就是规则文档本身：内容已经在工具结果里了，别再追加一份
  if (!isDirectory && (PROJECT_DOC_NAMES as readonly string[]).includes(basename(target))) return null

  let dir = isDirectory ? target : dirname(target)
  const chain: string[] = []
  while (dir !== root && isInside(root, dir)) {
    if (!SKIP_DIR_NAMES.has(basename(dir))) chain.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 从最外层到最内层：通用规则在前，越具体的越靠后
  chain.reverse()

  const blocks: string[] = []
  for (const current of chain) {
    if (blocks.length >= MAX_NESTED_PER_CALL) break
    for (const name of PROJECT_DOC_NAMES) {
      const file = join(current, name)
      const rel = toPosixRelative(root, file)
      if (loaded.has(rel)) continue
      // 先占位再读：同一批并行的 read / glob 不该各注入一份同样的规则
      loaded.add(rel)
      const raw = await readDocFile(file)
      if (!raw) {
        loaded.delete(rel)
        continue
      }
      const expanded = await expandImports(raw, file, {
        boundary: root,
        seen: new Set(loaded),
        count: { value: 0 },
        depth: 0
      })
      const { text, section } = truncateAtSection(expanded, MAX_NESTED_DOC_CHARS)
      const dirLabel = toPosixRelative(root, current) || '.'
      const truncNote =
        text.length < expanded.length
          ? `\n\n（该文档过长，以上为前 ${Math.round((text.length / expanded.length) * 100)}%` +
            (section ? `（截至「${section}」）` : '') +
            `；需要时用 read 读 ${rel} 补全。）`
          : ''
      blocks.push(
        `<nested-project-doc path="${rel}" dir="${dirLabel}">\n` +
          `这是 ${dirLabel} 目录的规则，只作用于该目录及其子目录；与上层规则冲突时以更具体的这份为准。\n\n` +
          `${text}${truncNote}\n` +
          `</nested-project-doc>`
      )
      break
    }
  }
  return blocks.length ? blocks.join('\n\n') : null
}

/**
 * 项目约束文档的提示词段落。
 *
 * 措辞上刻意做三件事：① 说明**优先级高于本文其它约定**（否则模型会把它当参考资料，
 * 遇到冲突仍按通用习惯走）；② 要求**动手前先读完**（而不是「需要时参考」）；
 * ③ 声明**不要擅自修改**（它是项目维护者的文档，不是 agent 的产出物）。
 */
export function buildProjectDocSection(doc: ProjectDoc): string {
  const en = getLanguage() === 'en'
  const sourceLine = en
    ? doc.sources.length > 1
      ? `Merged this time: ${doc.sources.map((s) => `${s.label} (${s.file})`).join(', ')}`
      : `Source: ${doc.file}`
    : doc.sources.length > 1
      ? `本次合并了：${doc.sources.map((s) => `${s.label}（${s.file}）`).join('、')}`
      : `来源：${doc.file}`
  const lines = en
    ? [
        `Project constraint document: \`${doc.name}\` (${doc.file})`,
        sourceLine,
        'These are **rules the project maintainers/users wrote for the AI** (build and verification steps, code conventions, forbidden actions, past pitfalls).',
        'They take priority over every other general convention in this prompt — when they conflict, follow the document; read it fully before acting.',
        'When topics conflict, priority is: subdirectory rules > project rules > global rules.',
        'Do not modify these files unless the user explicitly asks.',
        '',
        '<project-doc>',
        doc.text,
        '</project-doc>'
      ]
    : [
        `项目约束文档：\`${doc.name}\`（${doc.file}）`,
        sourceLine,
        '这是**项目维护者 / 用户写给 AI 的规则**（构建与验证方式、代码约定、禁止事项、踩过的坑）。',
        '它的优先级高于本提示词里其它一切通用约定 —— 与之冲突时以它为准；动手前先完整读一遍。',
        '同一主题出现冲突时，优先顺序：子目录规则 > 项目规则 > 全局规则。',
        '除非用户明确要求，不要修改这些文件。',
        '',
        '<project-doc>',
        doc.text,
        '</project-doc>'
      ]
  if (doc.truncated) {
    const percent = Math.round((doc.text.length / doc.totalChars) * 100)
    lines.push(
      en
        ? `⚠️ This document is too long (${doc.totalChars} chars); the text above is only the first ${percent}%` +
            (doc.section ? ` (up to “${doc.section}”)` : '') +
            `. If this task may touch later sections, read ${doc.file} with read first — do not guess.`
        : `⚠️ 该文档过长（共 ${doc.totalChars} 字符），以上只是前 ${percent}%` +
            (doc.section ? `（截至「${doc.section}」）` : '') +
            `。若这次任务可能涉及后面的章节，先用 read 读 ${doc.file} 补全，别凭猜测动手。`
    )
  }
  return lines.join('\n')
}
