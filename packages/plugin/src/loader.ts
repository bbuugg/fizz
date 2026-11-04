/**
 * 插件发现与加载（Cordis 风格：磁盘目录即插件，无需编译）。
 *
 * 与 `config.ts` 一样是 **Node-only 子路径**（`@fizz/plugin/loader`），
 * 刻意不从这里导出到核心 index —— 免得只想用 Core 的调用方（尤其前端）吃进 jiti / fs。
 *
 * 发现规则（镜像技能根的形态，根目录由 `standardPluginRoots` 给出）：
 * - 根目录下的每个**目录**是一个候选插件，必须有 `plugin.json` 指定入口；
 * - 根目录里散装的 `.ts` / `.js` 不认（单文件插件已不再支持）；
 * - 跳过点号开头的目录。
 *
 * 配置：每个根目录可选一份 `plugins.yml`（解析见 `config.ts`），按 **相对路径** 匹配，
 * 给对应插件补 `config` / 覆盖 `enabled`；未列入的默认启用。
 *
 * 加载：用 jiti **直接跑 TS/JS 源码**（`moduleCache:false`，缓存由本模块自己管），
 * 入口归一化成 Core 的 `Plugin`（默认导出：函数 / 类 / `{ apply }` 对象）。
 */
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { createJiti } from 'jiti'
import { readPluginsFile, type PluginEntry } from './config'
import { createAppContext } from './context'
import { HooksService } from './hooks'
import { PromptService } from './services/prompt'
import { ToolsService } from './services/tools'
import { UiService, type PluginUiDeclaration } from './services/ui'
import { UploadsService } from './services/uploads'
import { ModelsService } from './services/models'
import type {
  Plugin,
  PluginCandidate,
  PluginClientManifest,
  PluginDescriptor,
  PluginManifest,
  PluginObject,
  PluginRoot,
  PluginSettings,
  PluginStaticSurface,
  PluginUploadSourceInfo,
  StandardPluginSource
} from './types'

/** 插件入口文件的扩展名（与 Pi agent 一致：TS 源码直接跑） */
const ENTRY_EXT = new Set(['.ts', '.js'])

/** 插件目录里的描述文件（唯一接口判据） */
export const PLUGIN_MANIFEST_FILE = 'plugin.json'
/** 当前宿主只认这一版接口 */
export const PLUGIN_API_VERSION = 1

const MANIFEST_FIELDS = new Set([
  'id',
  'name',
  'version',
  'apiVersion',
  'entry',
  'icon',
  'description',
  'author',
  'client',
  'dependencies',
  'engines'
])
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
/** 前端 bundle 只认这两种扩展名（浏览器能直接吃） */
const CLIENT_EXT = new Set(['.js', '.mjs'])
/**
 * 由宿主别名提供、插件不许自带的包（唯一真源，`HOST_SHARED_PACKAGES` 从它派生）。
 * 两个处都要用：别名映射（加载期）+ dependencies 校验（发现期）。
 */
const HOST_ALIAS_PACKAGES = new Set(['zod', 'ai'])
/** npm 包名（含 scope）；故意比 npm 官方校验松一点，但挡掉 URL / `file:` / 路径 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
/**
 * 依赖版本号只允许 semver 区间的字符：`^` `~` `>` `<` `=` `*` `x` `||` ` - ` `1.2.3`。
 * 挡掉 `file:` / `link:` / `git+https:` / `npm:` —— 那几种能读本机任意路径、或绕过 registry，
 * 等于给插件一个「从任意来源拉代码并执行」的后门（依赖代码是照常在进程内跑的）。
 */
const SEMVER_RANGE_RE = /^[\s\d.xX*^~<>|=+-]{1,64}$/

/** 目录内相对路径校验（入口 / 前端 bundle 共用） */
function normalizeRelPath(raw: unknown, allowedExt: Set<string>): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().replace(/\\/g, '/')
  if (!value || value.startsWith('/') || value.includes('\0')) return null
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  if (!allowedExt.has(extname(value).toLowerCase())) return null
  if (value.toLowerCase().endsWith('.d.ts')) return null
  return parts.join('/')
}

/** 入口路径必须是目录内相对路径、是 .ts / .js、且不许跳出目录 */
function normalizeEntryPath(raw: unknown): string | null {
  return normalizeRelPath(raw, ENTRY_EXT)
}

/**
 * 清单里允许的面种类：**只有 `view`**。
 *
 * 早先允许 `activityBar` / `sider`（一个插件占一颗图标 + 一份侧栏），结果图标栏被插件数量
 * 撑满、每个插件还要用户自己记「哪颗图标是哪个插件」。现在入口统一是活动栏那颗「插件」：
 * 侧栏是插件列表，点插件在 `PanelView` 里开标签页 —— 所以清单里只能声明标签页。
 */
const SURFACE_KINDS = new Set(['view'])
const SURFACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 校验 `manifest.client`。
 *
 * 三条硬要求，都是为了「前端拿到的是**已经能跑的东西**」：
 * - `entry` 必须是 `.js` / `.mjs`：宿主不做运行时转译（见 types.ts 的说明）；
 * - `surfaces` 的 `kind` 只认宿主认识的那三种（`activityBar` / `sider` / `view`），
 *   写错一个字的后果是「插件装了但界面一片空白」，不如直接在发现阶段报出来；
 * - 声明了 `surfaces` 却没给 `entry` 的插件没有意义（谁都不会渲染它），一并拒。
 */
function parseClientManifest(raw: unknown): {
  client: PluginClientManifest
  clientEntry: string
} | null {
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('client 必须是一个对象（{ "entry": "client.js", "surfaces": [] }）')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'entry' && key !== 'surfaces') {
      throw new Error(`client 里有未知字段「${key}」`)
    }
  }
  const clientEntry = normalizeRelPath(record.entry, CLIENT_EXT)
  if (!clientEntry) throw new Error('client.entry 不合法：必须是目录内的 .js / .mjs 相对路径')
  const rawSurfaces = record.surfaces
  if (rawSurfaces !== undefined && !Array.isArray(rawSurfaces)) {
    throw new Error('client.surfaces 必须是数组')
  }
  const list = (rawSurfaces as unknown[] | undefined) ?? []
  if (list.length > 32) throw new Error('client.surfaces 最多 32 个')
  const surfaces: PluginStaticSurface[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('client.surfaces 的每一项必须是对象')
    }
    const surface = item as Record<string, unknown>
    for (const key of Object.keys(surface)) {
      if (key === 'opens') {
        throw new Error(
          'client.surfaces 不再有 opens：插件不占图标栏，点插件默认打开 order 最小的那个面'
        )
      }
      if (!['kind', 'id', 'title', 'icon', 'order'].includes(key)) {
        throw new Error(`client.surfaces 里有未知字段「${key}」`)
      }
    }
    const kind = typeof surface.kind === 'string' ? surface.kind.trim() : ''
    if (!SURFACE_KINDS.has(kind)) {
      throw new Error(
        `client.surfaces 的 kind 只能是 view（收到「${kind}」）：插件不再占图标栏、也没有自己的侧栏，` +
          '入口统一是活动栏那颗「插件」——点插件就在主区域开标签页'
      )
    }
    const surfaceId = typeof surface.id === 'string' ? surface.id.trim() : ''
    if (!SURFACE_ID_RE.test(surfaceId)) throw new Error('client.surfaces 的 id 不合法')
    // 同一种面里 id 必须唯一：bundle 用 id 认领渲染函数，重名等于后一个永远渲染不出来
    const dedupeKey = `${kind}:${surfaceId}`
    if (seen.has(dedupeKey)) throw new Error(`client.surfaces 里有重复的 ${kind}/${surfaceId}`)
    seen.add(dedupeKey)
    const title = typeof surface.title === 'string' ? surface.title.trim() : ''
    if (!title || title.length > 100) throw new Error(`client.surfaces「${surfaceId}」的 title 不合法`)
    const icon = typeof surface.icon === 'string' ? surface.icon.trim() : ''
    if (icon && icon.length > 100_000) throw new Error(`client.surfaces「${surfaceId}」的 icon 太大`)
    let order: number | undefined
    if (surface.order !== undefined) {
      if (typeof surface.order !== 'number' || !Number.isFinite(surface.order)) {
        throw new Error(`client.surfaces「${surfaceId}」的 order 必须是数字`)
      }
      order = Math.round(surface.order)
    }
    surfaces.push({
      kind: kind as PluginStaticSurface['kind'],
      id: surfaceId,
      title,
      ...(icon ? { icon } : {}),
      ...(order === undefined ? {} : { order })
    })
  }
  return { client: { entry: clientEntry, ...(surfaces.length ? { surfaces } : {}) }, clientEntry }
}

/**
 * 校验 `manifest.dependencies`。
 *
 * 拒绝 `@fizz/*` 是**必须的**，不是洁癖：宿主的 `ctx` 就是 `@fizz/plugin` 的实例，
 * 插件一旦自带另一份，`ctx instanceof Context` 为假、`ctx.set` 写进另一个世界，
 * 表现是「插件加载了但什么都不生效」——没有任何报错，最难查的一类。
 */
function parseDependencies(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dependencies 必须是 { "包名": "版本区间" } 对象')
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > 64) throw new Error('dependencies 最多 64 项')
  const out: Record<string, string> = {}
  for (const [name, range] of entries) {
    if (!PACKAGE_NAME_RE.test(name)) throw new Error(`dependencies 里的包名不合法：「${name}」`)
    if (name.startsWith('@fizz/')) {
      throw new Error(`dependencies 不能声明宿主的包「${name}」（它由宿主提供，自带一份会让 ctx 分裂）`)
    }
    // zod / ai 走宿主别名（见 HOST_SHARED_PACKAGES）：写进 dependencies 也不会生效，
    // 静默忽略比报错更难查 —— 「为什么我锁的版本没起作用」会查一整天。
    if (HOST_ALIAS_PACKAGES.has(name)) {
      throw new Error(`dependencies 不能声明「${name}」：它由宿主提供（别名指向宿主那份），写了也不会生效`)
    }
    if (typeof range !== 'string' || !SEMVER_RANGE_RE.test(range.trim())) {
      throw new Error(`dependencies「${name}」的版本区间不合法（只支持 semver 区间，不支持 file:/git/url）`)
    }
    out[name] = range.trim()
  }
  return Object.keys(out).length ? out : undefined
}

/** `engines.fizz`：作者声明「至少要这个版本的宿主」，不满足就整个不加载 */
function parseEngines(raw: unknown): { fizz?: string } | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('engines 必须是对象（{ "fizz": ">=1.2.0" }）')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'fizz') throw new Error(`engines 里有未知字段「${key}」`)
  }
  if (record.fizz === undefined) return undefined
  const fizz = typeof record.fizz === 'string' ? record.fizz.trim() : ''
  if (!fizz || !SEMVER_RANGE_RE.test(fizz)) throw new Error('engines.fizz 不合法（semver 区间，如 ">=1.2.0"）')
  return { fizz }
}

/**
 * 读一个插件目录的 `plugin.json` 并校验接口形状。
 *
 * 只要有一项不合格就抛错（调用方决定是跳过还是把原因报给安装者）——
 * **符合接口的目录才会被使用**，不做「缺字段也给默认值」的宽容解析。
 */
export async function readPluginManifest(dir: string): Promise<{
  manifest: PluginManifest
  file: string
  clientFile?: string
}> {
  const manifestPath = join(dir, PLUGIN_MANIFEST_FILE)
  let text: string
  try {
    text = await fs.readFile(manifestPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`缺少 ${PLUGIN_MANIFEST_FILE}（每个插件必须是一个带描述文件的目录）`)
    }
    throw err
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`${PLUGIN_MANIFEST_FILE} 不是合法 JSON`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${PLUGIN_MANIFEST_FILE} 必须是一个对象`)
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!MANIFEST_FIELDS.has(key)) throw new Error(`${PLUGIN_MANIFEST_FILE} 里有未知字段「${key}」`)
  }
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!PLUGIN_ID_RE.test(id)) {
    throw new Error('id 不合法：要匹配 [A-Za-z0-9][A-Za-z0-9._-]*（最长 64）')
  }
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name || name.length > 100) throw new Error('name 不合法：要是一个非空字符串（最长 100）')
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  if (!SEMVER_RE.test(version)) throw new Error('version 不合法：要写成 semver（如 1.0.0）')
  if (record.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`apiVersion 必须是 ${PLUGIN_API_VERSION}`)
  }
  const entry = normalizeEntryPath(record.entry)
  if (!entry) throw new Error('entry 不合法：必须是目录内的 .ts / .js 相对路径')
  /*
   * 插件图标：只收 `data:image/*` 的 data URI。
   * 和 `ctx.ui.icon` 同一条理由 —— 清单是服务端原样发给前端的，一个 `javascript:` 或
   * 远程 URL 就会变成「插件列表里那个 <img> 想加载什么就加载什么」。
   */
  const iconRaw = typeof record.icon === 'string' ? record.icon.trim() : ''
  if (iconRaw && !iconRaw.startsWith('data:image/')) {
    throw new Error('icon 必须是 data:image/* 的 data URI（如 data:image/svg+xml,...）')
  }
  if (iconRaw.length > 64_000) throw new Error('icon 太大：data URI 请控制在 64KB 以内')
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const author = typeof record.author === 'string' ? record.author.trim() : ''
  const dirAbs = resolve(dir)
  const file = resolve(dirAbs, entry)
  if (file !== dirAbs && !file.startsWith(dirAbs + sep)) {
    throw new Error('entry 跳出了插件目录')
  }
  const info = await fs.stat(file).catch(() => null)
  if (!info?.isFile()) throw new Error(`entry 指向的文件不存在：${entry}`)

  const clientParsed = parseClientManifest(record.client)
  let clientFile: string | undefined
  if (clientParsed) {
    const abs = resolve(dirAbs, clientParsed.clientEntry)
    if (abs !== dirAbs && !abs.startsWith(dirAbs + sep)) {
      throw new Error('client.entry 跳出了插件目录')
    }
    const clientInfo = await fs.stat(abs).catch(() => null)
    if (!clientInfo?.isFile()) throw new Error(`client.entry 指向的文件不存在：${clientParsed.clientEntry}`)
    clientFile = abs
  }
  const dependencies = parseDependencies(record.dependencies)
  const engines = parseEngines(record.engines)

  return {
    manifest: {
      id,
      name,
      version,
      apiVersion: PLUGIN_API_VERSION,
      entry,
      ...(iconRaw ? { icon: iconRaw } : {}),
      ...(description ? { description } : {}),
      ...(author ? { author } : {}),
      ...(clientParsed ? { client: clientParsed.client } : {}),
      ...(dependencies ? { dependencies } : {}),
      ...(engines ? { engines } : {})
    },
    file,
    ...(clientFile ? { clientFile } : {})
  }
}

/**
 * 一个插件目录的源码指纹：目录内所有文件的相对路径 + mtime + size。
 *
 * 目录式插件可以 `import './helper'`，只盯入口文件的 mtime 会让 helper 改了不生效。
 * 跳过隐藏文件与 `node_modules`（它们不是插件源码，也不该随插件分发）。
 */
export async function pluginSourceSignature(dir: string): Promise<string> {
  const root = resolve(dir)
  const files: string[] = []
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  await walk(root)
  const parts: string[] = []
  for (const file of files.sort()) {
    const info = await fs.stat(file).catch(() => null)
    parts.push(`${relative(root, file)}:${info?.mtimeMs ?? 0}:${info?.size ?? 0}`)
  }
  return parts.join('|')
}

/**
 * 标准插件根目录列表：
 * 内置（`builtinDir`，随产品分发）> 工作区 `.fizz/plugins` > 用户级 `~/.fizz/plugins`。
 *
 * 顺序确实有意义，不只是展示：`discoverPlugins` 按它**依次**产出描述符，宿主也按这个顺序
 * 挂载插件 —— 同名注册（比如两个插件抢同一个上传源 id）时**先挂的赢**，内置在最前
 * 就意味着「随产品分发的那份不会被后来者悄悄顶掉」（想关就在设置里关掉它）。
 *
 * `home` 由调用方提供（服务端可能跑在别的用户下），不在这里读 homedir；
 * `builtinDir` 同理 —— **本包不做路径探测**，由宿主（服务端 / 桌面端）决定内置根在哪，
 * 传 `undefined` = 这个宿主机没有内置插件根（测试、纯 CLI 场景都走这条）。
 */
export function standardPluginRoots(opts: {
  /** 工作区目录（不传就只扫全局） */
  workspacePath?: string
  home: string
  /** 内置插件根（绝对路径；不传 = 没有内置插件） */
  builtinDir?: string
}): Array<PluginRoot<StandardPluginSource>> {
  const roots: Array<PluginRoot<StandardPluginSource>> = []
  if (opts.builtinDir) roots.push({ source: 'builtin', dir: opts.builtinDir })
  if (opts.workspacePath) {
    roots.push({ source: 'workspace', dir: join(opts.workspacePath, '.fizz', 'plugins') })
  }
  roots.push({ source: 'user', dir: join(opts.home, '.fizz', 'plugins') })
  return roots
}

function candidate<S extends string>(
  root: PluginRoot<S>,
  manifest: PluginManifest,
  file: string,
  dir: string,
  clientFile?: string
): PluginCandidate<S> {
  return {
    id: manifest.id,
    name: manifest.name,
    manifest,
    file,
    dir,
    root: root.dir,
    source: root.source,
    ...(clientFile ? { clientFile } : {})
  }
}

/**
 * 扫一个根目录下的插件目录（目录不存在 = 没有插件，返回空数组，不报错）。
 *
 * **只认目录 + `plugin.json`**：根目录里的散装 `.ts` / `.js` 一律忽略（单文件插件不再支持）。
 * 目录不合格（缺 manifest / 字段非法 / entry 不存在）只打一条警告并跳过。
 */
export async function scanPluginRoot<S extends string>(
  root: PluginRoot<S>
): Promise<Array<PluginCandidate<S>>> {
  let entries
  try {
    entries = await fs.readdir(root.dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: Array<PluginCandidate<S>> = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory()) continue
    const dir = join(root.dir, entry.name)
    try {
      const { manifest, file, clientFile } = await readPluginManifest(dir)
      out.push(candidate(root, manifest, file, dir, clientFile))
    } catch (err) {
      console.warn(`[plugin] 跳过 ${dir}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // 稳定排序，免得 readdir 顺序不同导致 UI 列表抖动
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/** 在根目录的 plugins.yml 条目里找匹配这个候选的那条（按 module 相对路径解析） */
function matchEntry(entries: PluginEntry[], rootDir: string, item: PluginCandidate): PluginEntry | undefined {
  for (const entry of entries) {
    if (typeof entry.module !== 'string') continue
    const abs = resolve(rootDir, entry.module)
    if (abs === item.file || abs === item.dir) return entry
  }
  return undefined
}

/**
 * 发现全部插件：扫所有根目录 → 合并各根目录 `plugins.yml` 的配置 / enabled →
 * 叠加**对应作用域**的启停偏好。**只读盘，不加载模块**（列表接口用，快且无副作用）。
 *
 * ⚠️ 停用清单**按来源分开**（两个参数），不是一份打天下：
 * - `settings`（项目偏好）只作用于**工作区根** `<项目>/.fizz/plugins`；
 * - `globalSettings`（全局偏好）作用于**内置根**与**用户根** —— 这两类都对所有项目生效，
 *   开关自然也是全局的（设置 →「插件」）。
 *
 * 项目级插件由各项目自己管（侧栏项目「更多」→「插件」）。所以**一个项目不能单独停用某个
 * 内置 / 用户级插件** —— 那属于全局开关，混在一起会让「我在 A 项目关了它，B 项目也变了」
 * 变成必然。
 */
export async function discoverPlugins(opts: {
  workspacePath?: string
  home: string
  /** 内置插件根（绝对路径；不传 = 没有内置插件，见 standardPluginRoots） */
  builtinDir?: string
  /** 项目级启停偏好：**只作用于工作区根**（缺省 = 全部启用） */
  settings?: PluginSettings
  /** 全局启停偏好：作用于**内置根与用户根**（缺省 = 全部启用） */
  globalSettings?: PluginSettings
}): Promise<PluginDescriptor[]> {
  const out: PluginDescriptor[] = []
  // 稳定 id 是全局身份：同一个 id 先扫到的赢（内置 > 项目 > 用户），后面的跳过并告警
  const seen = new Set<string>()
  const roots = standardPluginRoots({
    workspacePath: opts.workspacePath,
    home: opts.home,
    builtinDir: opts.builtinDir
  })
  for (const root of roots) {
    // 每个根认**自己那一份**停用清单，见上面的说明
    const disabled = new Set(
      (root.source === 'workspace' ? opts.settings : opts.globalSettings)?.disabled ?? []
    )
    const [candidates, entries] = await Promise.all([
      scanPluginRoot(root),
      readPluginsFile(join(root.dir, 'plugins.yml'))
    ])
    for (const item of candidates) {
      if (seen.has(item.id)) {
        console.warn(`[plugin] 跳过重复 id「${item.id}」：${item.dir}（先扫到的 ${item.id} 已生效）`)
        continue
      }
      seen.add(item.id)
      const entry = matchEntry(entries, root.dir, item)
      const descriptor: PluginDescriptor = {
        ...item,
        enabled: (entry?.enabled ?? true) && !disabled.has(item.id)
      }
      if (entry && 'config' in entry) descriptor.config = entry.config
      out.push(descriptor)
    }
  }
  return out
}

/**
 * 宿主与插件共享的包：插件可以 `import { z } from 'zod'` / `import { tool } from 'ai'`，
 * **不管插件文件放在哪**。
 *
 * 为什么需要别名：插件常在 `~/.fizz/plugins` 这种「仓库树之外」的目录里，而 Node 的裸包名
 * 解析是从**插件文件所在目录**往上找 node_modules —— 那里没有它们，于是
 * `Cannot find module 'zod'`（实测）。没有 schema 就写不出带参数的工具（裸 JSON Schema
 * 会被 AI SDK 当函数调用，见 SKILL.md 的形态表），所以「用户级插件只能写无参工具」曾经是
 * 个硬限制。别名把这两个裸包名指到**宿主自己那份**（版本因此总与宿主一致，插件不必自带依赖）。
 *
 * 只映射这两个：它们是「写工具」的最小依赖面，再多了就等于把宿主的依赖树变成插件的公共 API。
 *
 * ⚠️ 别名是**强制**的：插件 `dependencies` 里写 `zod` / `ai` 会在发现阶段直接报错
 * （见 `parseDependencies`），因为写进去也不会生效。
 */
const HOST_SHARED_PACKAGES = [...HOST_ALIAS_PACKAGES]

/** 解析宿主自己那份共享包；解析不到（裁剪过的发行版）就不给别名，插件照常报「找不到模块」 */
function hostSharedAliases(): Record<string, string> {
  const req = createRequire(import.meta.url)
  const alias: Record<string, string> = {}
  for (const name of HOST_SHARED_PACKAGES) {
    try {
      alias[name] = req.resolve(name)
    } catch {
      /* 没装就没有别名 */
    }
  }
  return alias
}

/**
 * jiti 实例：`moduleCache:false` 让 jiti 自己不缓存（模块缓存在本模块的 Map 里管，
 * 这样「同一个插件文件只 apply 一次原对象」可预期）。jiti 也是进程级重物，懒建一次。
 */
let jiti: ReturnType<typeof createJiti> | null = null
function getJiti(): ReturnType<typeof createJiti> {
  if (!jiti) {
    jiti = createJiti(import.meta.url, {
      moduleCache: false,
      interopDefault: true,
      alias: hostSharedAliases()
    })
  }
  return jiti
}

/** 把模块导出归一化成 Core 的 `Plugin`（函数 / 类 / `{ apply }` 对象） */
function normalizeExport(mod: unknown, file: string): Plugin {
  const candidate =
    mod && typeof mod === 'object' && 'default' in mod ? (mod as { default: unknown }).default : mod
  if (typeof candidate === 'function') return candidate as Plugin
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof (candidate as PluginObject).apply === 'function'
  ) {
    return candidate as Plugin
  }
  throw new Error(`插件 ${file} 的导出不是有效插件（需要函数 / 类 / { apply } 对象）`)
}

/**
 * 已加载的插件模块缓存（key = 入口文件绝对路径）。
 *
 * 记下**整个目录**的源码指纹（见 `pluginSourceSignature`）是为了热重载：每轮对话都会
 * 重新加载插件，目录没变就复用缓存里的对象（同一入口只 import 一次、apply 的是同一个
 * 对象，顶层副作用不会反复跑）；目录里任一文件变了（编辑器存盘 / 改了 helper）就重新
 * import —— 改插件**不必重启服务端**，下一轮对话即是新代码。
 * 值存 Promise 而不是加载结果：晚到的调用能直接搭上还在飞的这次加载，不会各 import 一遍。
 */
interface CachedModule {
  signature: string
  loading: Promise<Plugin>
}
const moduleCache = new Map<string, CachedModule>()

/**
 * 加载一个插件入口文件并归一化成 `Plugin`。
 *
 * 目录指纹没变则复用缓存（并发调用也只 import 一次）；变了就重新 import —— jiti 那边
 * `moduleCache:false`，会重读源码。读盘失败（目录刚被删 / 正在写）时不写缓存，
 * 让下一次调用重新尝试，插件写一半、被挪走都能自愈。
 */
export async function loadPluginModule(file: string): Promise<Plugin> {
  const dir = dirname(file)
  const signature = await pluginSourceSignature(dir)
  const cached = moduleCache.get(file)
  if (signature && cached && cached.signature === signature) {
    return cached.loading
  }
  const loading = getJiti()
    .import(file)
    .then((mod) => normalizeExport(mod, file))
  if (signature) {
    moduleCache.set(file, { signature, loading })
    // 加载失败别把坏结果留在缓存里（否则插件写错一次就永远坏了）：下一轮会再试一次
    loading.catch(() => {
      if (moduleCache.get(file)?.loading === loading) moduleCache.delete(file)
    })
  }
  return loading
}

/**
 * 主动丢掉模块缓存（**安装 / 覆盖安装 / 卸载**时调）。
 *
 * 平时靠目录源码指纹（递归路径 + mtime + size）自动失效（改文件不必重启），但有一种
 * 情况它判不出来：**同一路径上重写了一份内容，而所有文件的 mtime 与大小恰好都没变**。
 * 装完调一下，新代码就必定生效，不用赌时间戳。
 *
 * 不传 file = 全清（插件被卸载时它的条目原本也会自然失效，但清一下更干净；现在目录内任一文件变化都会让缓存失效）。
 */
export function invalidatePluginModule(file?: string): void {
  if (file) moduleCache.delete(file)
  else moduleCache.clear()
}

/** 一个加载成功的插件（挂载所需的最小信息，结构上与 @fizz/agent 的 MountedPlugin 一致） */
export interface LoadedPlugin {
  id: string
  plugin: Plugin
  config?: unknown
}

/**
 * 批量加载（每项独立 try/catch：**一个插件坏了不该拖垮整轮对话**）。
 * 返回成功清单与错误清单，调用方自行决定是记日志还是提示用户。
 */
export async function loadPlugins(
  descriptors: PluginDescriptor[]
): Promise<{ loaded: LoadedPlugin[]; errors: string[] }> {
  const loaded: LoadedPlugin[] = []
  const errors: string[] = []
  for (const item of descriptors) {
    try {
      const plugin = await loadPluginModule(item.file)
      const entry: LoadedPlugin = { id: item.id, plugin }
      if ('config' in item) entry.config = item.config
      loaded.push(entry)
    } catch (err) {
      errors.push(`${item.name}（${item.file}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { loaded, errors }
}

/**
 * 收集插件声明的东西（`ctx.ui` 的 setting / panel + `ctx.uploads` 注册的上传源），按插件 id 归集。
 *
 * 为什么需要「跑一遍 apply」：这些声明表都是**命令式**的（插件在 apply 里逐个
 * `ctx.ui.setting(...)` / `ctx.uploads.register(...)`），不像 plugins.yml 那样在盘上可读
 * —— 想知道一个插件声明了什么，只能把它挂到一个临时 context 上跑一遍。**这可能有副作用**
 * （插件 apply 里能读写文件 / 起进程），属于「本地受信插件」的可接受代价：插件本来每轮对话
 * 都会被 apply 一次。
 *
 * 实现要点：
 * - **每个插件一个独立临时 context**：声明表因此天然按插件隔离，读到的就是它自己声明的
 *   那几项（共用一份的话得做 diff，且 id 相同的声明会互相覆盖）；
 * - **内建服务预先 `set` 齐**（tools / prompt / hooks / ui / uploads）：`inject` 声明了其中
 *   任何一个的插件才会立即挂载 —— 否则会被推迟，声明就收不到。声明了**自定义服务名**的
 *   插件仍会被推迟（我们无从提供），这类插件的声明收集不到，是已知取舍；
 * - `uploads` 尤其重要：上传源注册**只挂在长驻 context 上**（上传时没有回合），所以插件
 *   在这里 apply 一遍，设置页才看得到「它提供了哪些可选的上传源」，形状写错
 *   （比如 `urlPrefixes` 不是合法 https）也会当场变成 errors 里的一条红字；
 * - 读完后 `fork.dispose()` + `ctx.dispose()` 立即回收（含 `inject` 的挂起项），
 *   不留内存尾巴；
 * - **单个插件失败只记进 errors**，不影响其它插件（与 `loadPlugins` 同款）。
 */
export async function inspectPluginUi(descriptors: PluginDescriptor[]): Promise<{
  /** 插件 id → 它声明的 UI（两者都为空时不出现这个键） */
  ui: Record<string, PluginUiDeclaration>
  /** 插件 id → 它注册的上传源（没注册时不出现这个键）；只有纯数据，函数不外传 */
  uploads: Record<string, PluginUploadSourceInfo[]>
  errors: string[]
}> {
  const ui: Record<string, PluginUiDeclaration> = {}
  const uploads: Record<string, PluginUploadSourceInfo[]> = {}
  const errors: string[] = []
  for (const item of descriptors) {
    const ctx = createAppContext(`inspect:${item.id}`)
    ctx.set('tools', new ToolsService(ctx))
    ctx.set('prompt', new PromptService(ctx))
    ctx.set('hooks', new HooksService(ctx))
    const service = new UiService(ctx)
    ctx.set('ui', service)
    const uploadsService = new UploadsService(ctx)
    ctx.set('uploads', uploadsService)
    // 只声明不读取：给了它，顶层 `inject: ['models']` 的插件才不会被推迟挂载，
    // 它的设置项 / 界面声明才收得到（与 tools / uploads 同一取舍）。
    ctx.set('models', new ModelsService(ctx))
    try {
      const plugin = await loadPluginModule(item.file)
      const fork = ctx.plugin(plugin, 'config' in item ? item.config : undefined)
      const settings = service.settings()
      const panels = service.panels()
      const surfaces = service.surfaces()
      const icon = service.iconValue
      if (settings.length || panels.length || surfaces.length || icon) {
        ui[item.id] = { settings, panels, surfaces, ...(icon ? { icon } : {}) }
      }
      const sources = uploadsService.list().map((reg) => ({
        id: reg.id,
        title: reg.title,
        acceptMime: [...reg.accept.mime],
        maxBytes: reg.accept.maxBytes
      }))
      if (sources.length) uploads[item.id] = sources
      await fork.dispose()
    } catch (err) {
      errors.push(`${item.name}（${item.file}）：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await ctx.dispose()
    }
  }
  return { ui, uploads, errors }
}