/**
 * 技能扫描（Agent Skills 约定：一个目录 + 目录里的 `SKILL.md`）。
 *
 * 只做「给定若干根目录 → 扫出技能清单」这件纯活，**不关心根目录从哪来、
 * 用户启用了哪些**：桌面端从 electron-store 拿设置、server 端从自己的 JSON 配置拿，
 * 两边共用这一份扫描（frontmatter 解析、junction 处理、去重都在这里，
 * 避免各写一份然后慢慢漂）。
 *
 * 类型刻意做成结构化的泛型（`S extends string`），不依赖 @fizz/contracts：
 * 这个包要保持「只依赖 ai / zod / node」的独立性（见 index.ts 的说明）。
 */
import { promises as fs } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

/** 技能清单文件名（Agent Skills 约定，大小写敏感） */
export const SKILL_FILE = 'SKILL.md'
/** SKILL.md 的读取上限（超出就当不是技能清单，避免把大文件读进内存） */
const MAX_SKILL_DOC_BYTES = 512 * 1024
/**
 * 描述截断长度（进提示词的东西要克制，正文才是给模型细读的）。
 *
 * 取 180：描述的作用只是让模型判断「这个技能跟当前任务相不相关」——
 * 一句话足够下这个判断，多的部分它也用不上（真相关时会去 skill 读全文）。
 * 技能多时这一段是纯固定开销：每条省 200 字符，20 个技能就是每轮省 4000 字符。
 */
const MAX_DESCRIPTION = 180
/** 单个来源下最多发现多少个技能（防御性上限） */
const MAX_SKILLS_PER_ROOT = 200

export interface SkillRoot<S extends string = string> {
  source: S
  dir: string
}

/** 扫出来的一个技能（字段与 @fizz/contracts 的 SkillInfo 对齐） */
export interface ScannedSkill<S extends string = string> {
  /** 技能 id：SKILL.md 的绝对路径（唯一、稳定；启停状态按它记） */
  id: string
  name: string
  description: string
  dir: string
  file: string
  source: S
  root: string
}

/** 一个根目录的扫描情况（UI 用来显示「扫了哪些地方」） */
export interface ScannedRoot<S extends string = string> {
  source: S
  dir: string
  exists: boolean
  count: number
}

/** 标准技能来源（与 @fizz/contracts 的 SkillSource 一致） */
export type StandardSkillSource = 'builtin' | 'workspace' | 'user' | 'agents' | 'custom'

/**
 * 标准技能根目录列表（桌面端与 server 端共用**同一份顺序**）：
 * 内置 > 工作区 > 用户级 > agents 共享目录 > 用户手动添加的目录。
 *
 * 刻意**不扫 `~/.claude/skills`**：那是 skills CLI 为 Claude Code 铺的软链目录（每个技能
 * 链到 `~/.agents/skills/<name>`），扫它等于把同一批技能列两遍；用户要指别处走 `extraDirs`。
 *
 * 顺序即优先级（同一个目录被多个来源覆盖时先到先得），所以内置那份排最前：随产品分发的
 * 技能不该被别处同名目录顶掉。
 *
 * 调用方自己提供 `home`（服务端可能跑在别的用户下），不在这里读 homedir；
 * `builtinDir` 同理 —— **本包不做路径探测**，由宿主决定内置根在哪（服务端见
 * `apps/server/src/server/builtin-dirs.ts`），不传 = 这个宿主机没有内置技能根。
 */
export function standardSkillRoots(opts: {
  /** 工作区目录（不传就只扫全局） */
  workspacePath?: string
  home: string
  /** 内置技能根（绝对路径；不传 = 没有内置技能） */
  builtinDir?: string
  extraDirs?: string[]
}): Array<SkillRoot<StandardSkillSource>> {
  const roots: Array<SkillRoot<StandardSkillSource>> = []
  if (opts.builtinDir) roots.push({ source: 'builtin', dir: opts.builtinDir })
  if (opts.workspacePath) {
    roots.push({ source: 'workspace', dir: join(opts.workspacePath, '.fizz', 'skills') })
  }
  roots.push({ source: 'user', dir: join(opts.home, '.fizz', 'skills') })
  // 跨智能体共享目录（skills CLI / codex / cursor / claude-code / opencode / trae…）
  roots.push({ source: 'agents', dir: join(opts.home, '.agents', 'skills') })
  for (const dir of opts.extraDirs ?? []) roots.push({ source: 'custom', dir })
  return roots
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

function stripQuotes(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim()
  }
  return v
}

/**
 * 解析 SKILL.md：`---` 包裹的 frontmatter（取 name / description）+ 正文。
 *
 * 只认单行 `key: value`（够用；多行 YAML 块交给模型读正文去理解）。
 * 没有 frontmatter 也不算错 —— 名称退回目录名，描述退回正文首段。
 */
export function parseSkillDoc(text: string): { name?: string; description?: string; body: string } {
  // BOM 会让开头的 `---` 匹配不上，先去掉
  const src = text.replace(/^\uFEFF/, '')
  const lines = src.split('\n')
  if (lines[0]?.trim() !== '---') return { body: src }

  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'))
  if (end === -1) return { body: src }

  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (m && m[1]) meta[m[1].toLowerCase()] = stripQuotes(m[2])
  }
  return {
    name: meta.name || undefined,
    description: meta.description || undefined,
    body: lines.slice(end + 1).join('\n').trim()
  }
}

/** 正文里第一段有意义的文字（拿它当没有 frontmatter 时的描述） */
function firstParagraph(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('```')) continue
    return line.replace(/^[-*+]\s+/, '').trim()
  }
  return ''
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** 路径规范化：统一分隔符 + Windows 下大小写不敏感（去重靠它） */
function normalizePath(path: string): string {
  const abs = resolve(path)
  return sep === '\\' ? abs.toLowerCase() : abs
}

/** 读取一个技能目录；目录里没有可用的 SKILL.md 时返回 null（当它不是技能） */
async function readSkillDir<S extends string>(
  dir: string,
  source: S,
  root: string
): Promise<ScannedSkill<S> | null> {
  const file = join(dir, SKILL_FILE)
  let text: string
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_SKILL_DOC_BYTES) return null
    text = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }

  const { name, description, body } = parseSkillDoc(text)
  const fallback = firstParagraph(body)
  return {
    id: normalizePath(file),
    name: (name || basename(dir)).trim(),
    description: truncate(description || fallback || '（该技能没有写描述）', MAX_DESCRIPTION),
    dir: resolve(dir),
    file: resolve(file),
    source,
    root: resolve(root)
  }
}

/**
 * 扫描一个技能根目录，把发现的技能推进 out。
 *
 * 支持两种摆放方式：根目录下每个子目录一个技能（常见形态），
 * 或者根目录本身就是某个技能（用户直接把某个技能目录加进来）。
 */
async function scanRoot<S extends string>(
  root: SkillRoot<S>,
  seen: Set<string>,
  out: Array<ScannedSkill<S>>
): Promise<void> {
  const push = (skill: ScannedSkill<S> | null): void => {
    if (!skill) return
    const key = normalizePath(skill.dir)
    if (seen.has(key)) return
    seen.add(key)
    out.push(skill)
  }

  // 根目录本身就可能是技能（把某个技能目录直接加了进来）。
  // 这里**不做前置判断**：readSkillDir 自己会 stat SKILL.md，没有就返回 null ——
  // 之前写成 `isDir(join(root, 'SKILL.md'))` 是永假的（SKILL.md 是文件不是目录），
  // 这条分支从来没生效过。
  push(await readSkillDir(root.dir, root.source, root.dir))

  const entries = await fs.readdir(root.dir, { withFileTypes: true }).catch(() => null as null)
  if (!entries) return
  const before = out.length
  for (const ent of entries) {
    if (out.length - before >= MAX_SKILLS_PER_ROOT) break
    // 隐藏目录不是技能（.git / .system 之类），点号开头的技能目录很少见，统一跳过
    if (ent.name.startsWith('.')) continue
    const dir = join(root.dir, ent.name)
    // ⚠️ 软链接与 Windows 目录联接（junction）的 `Dirent.isDirectory()` 恒为 false，
    // 而「别人用 skills CLI 装的技能」常常就是这么挂进来的（本机实测：`~/.agents/skills/superpowers`
    // 就是个 junction）。所以非目录时要补一次 stat（跟随链接；断链会抛错 → isDir 返回 false，跳过）。
    if (!ent.isDirectory() && !(await isDir(dir))) continue
    push(await readSkillDir(dir, root.source, root.dir))
  }
}

/**
 * 扫描全部根目录（顺序即优先级，同一个目录被多个来源覆盖时先到先得）。
 * 根目录不存在时不会创建，只在 `rootInfos` 里标记 `exists: false`。
 */
export async function scanSkillRoots<S extends string>(
  roots: Array<SkillRoot<S>>
): Promise<{ skills: Array<ScannedSkill<S>>; rootInfos: Array<ScannedRoot<S>> }> {
  const seen = new Set<string>()
  const skills: Array<ScannedSkill<S>> = []
  const rootInfos: Array<ScannedRoot<S>> = []
  for (const root of roots) {
    const exists = await isDir(root.dir)
    const before = skills.length
    if (exists) await scanRoot(root, seen, skills)
    rootInfos.push({ source: root.source, dir: root.dir, exists, count: skills.length - before })
  }
  return { skills, rootInfos }
}
