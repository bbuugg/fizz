/**
 * Agent 内核的持久化：一个 JSON 文件 + 原子写盘，密钥字段单独加密。
 *
 * 为什么不用 electron-store：那是桌面端的东西（依赖 app.getPath）。server / cli
 * 需要一个**与 Electron 无关**的同构存储，所以这里自己写最小的那份：
 * - 数据目录：`FIZZ_DATA_DIR`，缺省 `~/.fizz-server`；
 * - 写盘：先写 `.tmp` 再 `rename`（POSIX / Windows 上 rename 都是原子的），
 *   避免进程被杀在写一半时把配置写坏；
 * - API key：AES-256-GCM 加密后存（`enc:v1:` 前缀）。主密钥取 `FIZZ_SECRET_KEY`，
 *   没有就生成一份 `secret.key`（0600）——**绝不落明文密钥**，
 *   因为这个服务是准备暴露端口给人连的。
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentConversation,
  AgentWorkspace,
  CollabState,
  AiModelConfig,
  ApiGroup,
  ApiHistoryEntry,
  ApiRequestEntry,
  ScriptEntry,
  ScriptGroup,
  SshAuthType,
  SshCharset,
  SshTunnel,
  HostGroup,
  NotesRoot,
  TaskTrigger
} from '@fizz/contracts/types'
import type { AcpAgentConfig } from '@fizz/acp'
import type { McpServerConfig } from '@fizz/mcp'
import type { SkillSettings } from '@fizz/skills'
import type { PluginSettings } from '@fizz/plugin'
import {
  normalizeSubagentSettings,
  type SubagentSettings
} from '@fizz/contracts/types'
// 读盘归一化模型清单用（写盘那条路在 domain.ts 里，共用同一个函数，别另写一份）
import { normalizeModelEntries } from './domain'
// ⚠️ 走**根入口**而不是 `@fizz/contracts/browser` 子路径：各端的 vite config 只为
// 「列出来的」子路径写了 alias（前缀匹配下未列出的子路径会被拼成 index.ts/browser），
// 而根入口四处都登记过。browser.ts 本身就是浏览器安全的，从根入口引不会带进 Node 代码。
import {
  normalizeSystemMonitorSettings,
  DEFAULT_SYSTEM_MONITOR_SETTINGS,
  type SystemMonitorSettings,
  detectLanguageFromLocale,
  type AppLanguage,
  normalizeContainerPublicSettings,
  type ContainerPublicSettings,
  normalizePrefs,
  DEFAULT_PREFS,
  type PrefsSnapshot
} from '@fizz/contracts'
import {
  fallbackConversationRoot,
  listConversationsIn,
  readCollabStateDir,
  removeConversationDir,
  resolveConversationRoot,
  writeCollabState as writeCollabStateToRoot,
  writeConversation as writeConversationToRoot
} from './conversation-store'

/**
 * 落盘形状的 SSH 主机：= 客户端可见的 `SshHostConfig`，但把凭据换成**密文**。
 *
 * 与 `AiModelConfig.apiKey` 同款「只进不出」：领域层读列表时先抹成 `has*` 脱敏标记
 * （`toSshView`），密文本身绝不进 HTTP 应答；明文只在服务端建连时解密用。
 */
export interface StoredSshHost {
  id: string
  kind?: 'ssh'
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  /** 加密后的密码（`enc:v1:`）；无 = 没设过 */
  password?: string
  /** 加密后的私钥正文 */
  privateKey?: string
  /** 加密后的私钥口令 */
  passphrase?: string
  /** 跳板机（另一台 SSH 主机的 id） */
  jumpHostId?: string
  /** 终端字符集；缺省 utf-8 */
  charset?: SshCharset
  /** 保活间隔（秒）；缺省 30，0 = 关闭 */
  keepaliveInterval?: number
  /** 所属主机分组（`HostGroup.id`）；无 = 未分组 */
  groupId?: string
  createdAt: number
  updatedAt: number
}

/**
 * 落盘形状的**本机终端**配置：= 客户端可见的 `LocalHostConfig`，无凭据，字段一一对应。
 *
 * 与 `StoredSshHost` 同列存在 `sshHosts` 里，靠 `kind: 'local'` 区分。
 */
export interface StoredLocalHost {
  id: string
  kind: 'local'
  name: string
  shellId?: string
  shellName?: string
  args?: string[]
  /** 打开时的工作目录（绝对路径）；缺省 = 主目录。**主机自己的配置**，与项目无关 */
  cwd?: string
  autoCommand?: string
  /** 所属主机分组（`HostGroup.id`）；无 = 未分组。与 SSH 主机共用同一套分组 */
  groupId?: string
  createdAt: number
  updatedAt: number
}

/** 落盘的主机清单条目：SSH 主机或本机终端 */
export type StoredHost = StoredSshHost | StoredLocalHost

/**
 * 数据文件版本，只服务于**一次性迁移**（见 `load()` 里 `migrate*` 那几个）。
 *
 * 规矩：**改了某个字段的默认值、或改了字段语义，就要 +1**，并在 `load()` 里补一条
 * `version < N` 的迁移 —— 老数据文件里存着的是**旧默认值**，不迁的话新默认值对已有安装
 * 根本不生效（`normalizeXxx` 只会补「缺字段」，不会改「已写着的值」）。
 */
const DATA_VERSION = 3

/** 落盘的数据形状（和桌面端的 electron-store 不同：这里是**服务端自己的**一份） */
export interface CoreData {
  version: number
  models: AiModelConfig[]
  /** 外部 ACP agent 配置（backend === 'acp' 的会话用） */
  acpAgents: AcpAgentConfig[]
  /** MCP server 配置（惰性连接，不进会话） */
  mcpServers: McpServerConfig[]
  /**
   * 主机清单（设置 →「主机」里管）：SSH 主机 + 本机终端，靠 `kind` 区分。
   *
   * SSH 条目的密码 / 私钥 / passphrase 都**加密**存这里（`enc:v1:`），读取列表时由领域层
   * 脱敏成 `has*` 标记回给前端；明文只在服务端建连时解密（见 `AgentDomain.resolveSshHost`）。
   * 本机终端条目无凭据，原样存取。
   */
  sshHosts: StoredHost[]
  /**
   * 主机分组：SSH 主机与本机终端**共用**的归类树（多级，`parentId` 自引用）。
   *
   * 与 `apiGroups` 同款：只承担「归类 + 排序」，条目靠自己的 `groupId` 指过来；
   * 删分组时条目默认移回未分组（`deleteHostGroup` 可勾选连条目一起删）。
   */
  hostGroups: HostGroup[]
  /**
   * SSH 隧道（本地转发 -L / 远程转发 -R / SOCKS5 动态代理 -D）。
   *
   * 只存 `hostId`（主机配置的 id）：凭据仍留在 `sshHosts` 里，由 `resolveSshHost`
   * 解密后建连 —— 隧道配置本身**不含任何明文凭据**，也就能原样回传前端。
   *
   * 运行态（连接数 / 起停时间 / 错误）**不落盘**：它是内存里的瞬时状态，
   * 见 `apps/server` 的 `ssh/tunnels.ts`。
   */
  sshTunnels: SshTunnel[]
  workspaces: AgentWorkspace[]
  /**
   * 会话的**内存索引**，不写进 `agent-core.json`。
   *
   * 会话真源在磁盘上：`<项目>/.fizz/conversation/<会话 id>/{config.json,conversation.json}`
   * （见 `conversation-store.ts`）。启动时扫盘装配进这里，供同步的读接口
   * （列表 / 搜索 / 用量）使用；每次改动由领域层显式写回对应会话目录。
   */
  conversations: AgentConversation[]
  skillSettings: SkillSettings
  /** 子任务（subagent）偏好；默认全关，见 contracts 的 SubagentSettings */
  subagentSettings: SubagentSettings
  /**
   * 服务器性能监控偏好（总开关）：默认开，与「状态栏监控一直采着」的老行为一致。
   *
   * 全局一份而不是按项目：它决定的是**server 所在机器**的采样开销（采集器
   * `apps/server/src/server/services/system-monitor.ts` 每 ~2s 采一帧），与项目无关。
   */
  systemMonitorSettings: SystemMonitorSettings
  /**
   * 界面语言（全局一份）：前端据此选字典，服务端据此构建工具描述与系统提示词。
   * **首次运行跟随系统 locale**（中文环境 zh，其它 en，见 `detectDefaultLanguage`）；
   * 一旦用户在设置页改过就落盘，后续以文件里的值为准。老数据文件里已写着的
   * `zh` / `en` 原样保留（可能是显式选择，无从区分）。
   */
  language: AppLanguage
  /**
   * **客户端偏好的服务端权威副本**（全局一份）：`PREF_KEYS` 里那些要跨端一致的 key。
   *
   * 为什么放在服务端：其中 `maxRetries` / `maxSteps` / `toolCallConcurrency` / `toolIntent`
   * 是 **agent 循环真正读取的值**，而定时任务（`scheduler.ts`）不经过任何渲染端 ——
   * 存在浏览器里的话，无人值守的任务永远只能拿到 `runAgent` 的缺省值。
   *
   * 形状与 localStorage 完全同形（`Record<key, string>`），前端 `writePref` 原样上行、
   * 下行原样写回，不引入第二套序列化。归一化在 `normalizePrefs` 里做一次。
   * 老数据文件没有这个字段 → 补成默认值（与加这个字段之前的前端行为一致）。
   */
  prefs: PrefsSnapshot
  /**
   * 容器型项目的**公网访问域名清单**（`<slug>.<domain>`，可多个）。
   *
   * 域名只有一个出处（这里）。以前只有 `FIZZ_CONTAINER_DOMAIN` 环境变量，桌面端用户没有
   * `.env` 可改、也就永远用不上公网预览；现在落在这里，设置页「容器」一处可填多个
   * （`FIZZ_CONTAINER_DOMAIN` 兜底**已移除**）。
   *
   * 全局一份：域名是整台服务端一件事，与具体项目无关（每个项目只贡献自己那一截 slug）。
   * 老数据是单个 `domain: string` → 归一化时包成一项（见 `normalizeContainerPublicSettings`）。
   */
  containerPublicSettings: ContainerPublicSettings
  /**
   * **项目级**插件（`<项目>/.fizz/plugins`）的启停偏好，按项目归集（key = workspaceId）；
   * 缺省 = 该项目全启用。形状见 @fizz/plugin 的 PluginSettings。
   *
   * ⚠️ 只作用于**工作区根**。用户级插件（`~/.fizz/plugins`）不在这里 —— 那份是全局的，
   * 见下面的 `globalPluginSettings`。两份刻意不共用：用户的说法是「插件在设置里管，
   * 项目插件各项目自己管」，混成一份就会重新长出「A 项目关了、B 项目也变了」。
   */
  pluginSettings: Record<string, PluginSettings>
  /**
   * **全局（用户级）**插件（`~/.fizz/plugins`）的启停偏好，服务端全局一份、与项目无关。
   *
   * 用户级插件对所有项目都生效，所以它的开关也该是全局的 —— 在设置 →「插件」页统一管，
   * 侧栏项目的「插件」弹窗只管项目自己那份。形状同 PluginSettings。
   */
  globalPluginSettings: PluginSettings
  /**
   * 插件**设置项的取值**（非密钥项，原文）：`{ <插件 id>: { <设置项 id>: value } }`。
   *
   * key 用插件 id（= 入口文件绝对路径）：项目级插件在不同项目里就是不同的文件，天然分开，
   * 不需要再按 workspaceId 分一层。密钥项不在这里（见 `pluginSecrets`）。
   */
  pluginValues: Record<string, Record<string, string | number | boolean>>
  /**
   * 插件**密钥项**的取值：`{ <插件 id>: { <设置项 id>: <SecretBox 密文> } }`。
   *
   * 与模型 apiKey 同一套：落盘加密、明文只在进程内存里，**发往浏览器的一律只给
   * `hasValue`**（见 @fizz/plugin 的 PluginSettingView）。
   */
  pluginSecrets: Record<string, Record<string, string>>
  // ---------- 定时任务：与上面几项完全并列，互不影响 ----------
  /** 「什么时候自动起一个会话」的规则（cron / 一次性） */
  taskTriggers: TaskTrigger[]
  // ---------- 接口请求（api-client）：与上面几项并列，全局一份 ----------
  /** 保存的接口请求集合（HTTP + WebSocket 共用一张表，靠 `protocol` 区分） */
  apiRequests: ApiRequestEntry[]
  /** 请求分组（侧边栏树；只承担归类 + 排序） */
  apiGroups: ApiGroup[]
  /** 请求历史（每次发送后自动记录，最新在前） */
  apiHistory: ApiHistoryEntry[]
  // ---------- 主机脚本（scripts）：与上面几项并列，全局一份 ----------
  /** 保存的主机脚本集合（可在某台主机上一键执行的命令文本） */
  scripts: ScriptEntry[]
  /** 脚本分组（**单层**；只承担归类 + 排序） */
  scriptGroups: ScriptGroup[]
  // ---------- 笔记（notes）：用户登记进来的任意目录 ----------
  /**
   * 笔记根目录清单。
   *
   * 只存「登记过哪些目录」—— 笔记正文是磁盘上的真实文件，服务端不复制一份（见
   * `apps/server/src/server/notes.ts`）。这层登记的作用是给文件接口划边界：
   * 没登记过的目录一律拒绝。
   */
  notesRoots: NotesRoot[]
}

/**
 * 首次运行（数据文件里还没有 `language`）的默认语言。
 *
 * 优先读桌面 / Linux 会话的环境变量（AppImage 下 `LANG` / `LC_ALL` 就是系统语言），
 * 没有再用 Node 的 ICU 默认 locale。中文环境之外一律英文 —— AppImage 目录要求
 * 应用在非中文环境下默认显示英文界面。
 */
function detectDefaultLanguage(): AppLanguage {
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
  const locale = env || Intl.DateTimeFormat().resolvedOptions().locale
  return detectLanguageFromLocale(locale)
}

function emptyData(): CoreData {
  return {
    version: DATA_VERSION,
    models: [],
    acpAgents: [],
    mcpServers: [],
    sshHosts: [],
    hostGroups: [],
    sshTunnels: [],
    workspaces: [],
    conversations: [],
    skillSettings: { disabled: [], extraDirs: [] },
    subagentSettings: { enabled: [] },
    systemMonitorSettings: { ...DEFAULT_SYSTEM_MONITOR_SETTINGS },
    language: detectDefaultLanguage(),
    prefs: { ...DEFAULT_PREFS },
    containerPublicSettings: normalizeContainerPublicSettings(undefined),
    pluginSettings: {},
    globalPluginSettings: { disabled: [] },
    pluginValues: {},
    pluginSecrets: {},
    taskTriggers: [],
    apiRequests: [],
    apiGroups: [],
    apiHistory: [],
    scripts: [],
    scriptGroups: [],
    notesRoots: []
  }
}

/**
 * 读盘时把某个字段收敛成数组：不是数组（缺字段 / 手改坏了）就给空数组。
 *
 * 数据文件是给人看过、也可能被人手改的，所以每个字段都当「不可信输入」处理 ——
 * 一个字段类型不对不该让整个 store 起不来。
 */
function arrayOr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * 收敛「按项目的插件启停偏好」：只保留 `{ <workspaceId>: { disabled: string[] } }`
 * 这种形状，坏值一律丢弃。
 *
 * 老数据文件里是**全局一份** `{ disabled: string[] }`（没有 workspaceId 的那层），
 * 这里认不出就整体返回 `{}` —— 每个项目都退回「全启用」，不会让 store 起不来。
 */
function normalizePluginSettings(value: unknown): Record<string, PluginSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, PluginSettings> = {}
  for (const [workspaceId, settings] of Object.entries(value as Record<string, unknown>)) {
    const disabled = (settings as PluginSettings | undefined)?.disabled
    if (Array.isArray(disabled)) {
      out[workspaceId] = { disabled: disabled.filter((x): x is string => typeof x === 'string') }
    }
  }
  return out
}

/**
 * 收敛插件设置项取值：`{ <插件 id>: { <项 id>: 值 } }`，只保留「两层映射 + 基本类型」，
 * 坏值一律丢弃（与其余字段同款「不可信输入」待遇，数据文件是给人看也给人改的）。
 *
 * 密钥那份（密文）同款处理，只是值要求是字符串。
 */
function normalizePluginValues(value: unknown): Record<string, Record<string, string | number | boolean>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, Record<string, string | number | boolean>> = {}
  for (const [pluginId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const items: Record<string, string | number | boolean> = {}
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        items[key] = val
      }
    }
    if (Object.keys(items).length) out[pluginId] = items
  }
  return out
}

function normalizePluginSecrets(value: unknown): Record<string, Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, Record<string, string>> = {}
  for (const [pluginId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const items: Record<string, string> = {}
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof val === 'string' && val) items[key] = val
    }
    if (Object.keys(items).length) out[pluginId] = items
  }
  return out
}

/**
 * 收敛**一份**插件启停偏好（全局那份用）。形状不对（缺字段 / 手改坏了 / 还是老代码的
 * 数组形状）一律回「全启用」—— 与其余字段同款「不可信输入」待遇，不让 store 起不来。
 */
function normalizeOnePluginSettings(value: unknown): PluginSettings {
  const disabled = (value as PluginSettings | undefined)?.disabled
  return {
    disabled: Array.isArray(disabled) ? disabled.filter((x): x is string => typeof x === 'string') : []
  }
}

/** 数据目录：`FIZZ_DATA_DIR` > `~/.fizz-server` */
export function resolveDataDir(): string {
  return process.env.FIZZ_DATA_DIR?.trim() || join(homedir(), '.fizz-server')
}

// ---------- 密钥加解密 ----------

const ENC_PREFIX = 'enc:v1:'

/** 主密钥：环境变量优先（部署时用），否则数据目录里的 secret.key */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static async create(dataDir: string): Promise<SecretBox> {
    const fromEnv = process.env.FIZZ_SECRET_KEY?.trim()
    if (fromEnv) {
      const buf = Buffer.from(fromEnv, 'base64')
      if (buf.length !== 32) {
        throw new Error('FIZZ_SECRET_KEY 必须是 32 字节的 base64（用 openssl rand -base64 32 生成）')
      }
      return new SecretBox(buf)
    }
    const keyFile = join(dataDir, 'secret.key')
    try {
      return new SecretBox(Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'base64'))
    } catch {
      const key = randomBytes(32)
      await fs.mkdir(dataDir, { recursive: true })
      await fs.writeFile(keyFile, key.toString('base64'), { mode: 0o600 })
      // Windows 不认 mode，能设就设（best effort）
      await fs.chmod(keyFile, 0o600).catch(() => undefined)
      return new SecretBox(key)
    }
  }

  /** 加密（已经是密文 / 空值则原样返回） */
  encrypt(plain: string | undefined): string | undefined {
    if (!plain) return undefined
    if (plain.startsWith(ENC_PREFIX)) return plain
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
  }

  /** 解密；不是密文就原样返回（兼容手工填的明文配置） */
  decrypt(value: string | undefined): string | undefined {
    if (!value || !value.startsWith(ENC_PREFIX)) return value
    try {
      const [ivB64, tagB64, ctB64] = value.slice(ENC_PREFIX.length).split(':')
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
    } catch (err) {
      throw new Error(
        `密钥解密失败（主密钥变了？删除 FIZZ_SECRET_KEY / secret.key 后重新填一次 API key）：${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

/** 要写进 JSON 的模型配置：apiKey 加密 */
function sealModel(box: SecretBox, model: AiModelConfig): AiModelConfig {
  return { ...model, apiKey: box.encrypt(model.apiKey) }
}

/**
 * JSON 存储。同步读写内存态 + 原子落盘（配置量小，不值得引入数据库）。
 */
export class JsonStore {
  private data: CoreData = emptyData()
  readonly dataDir: string
  readonly filePath: string
  private loaded = false

  constructor(private readonly box: SecretBox, dataDir = resolveDataDir()) {
    this.dataDir = dataDir
    this.filePath = join(dataDir, 'agent-core.json')
  }

  static async open(dataDir = resolveDataDir()): Promise<JsonStore> {
    const box = await SecretBox.create(dataDir)
    const store = new JsonStore(box, dataDir)
    await store.load()
    return store
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    /** 老数据文件里残留的会话（迁移用）：新布局下它们不在 agent-core.json 里 */
    let legacyConversations: AgentConversation[] = []
    /** 文件里写的版本（缺 = v1）：迁移判定用，也用来决定要不要把新版本号写回去 */
    let fileVersion = DATA_VERSION
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<CoreData>
      legacyConversations = Array.isArray(raw.conversations) ? raw.conversations : []
      /** 老数据文件的版本（缺 = v1）；下面按它决定要不要跑一次性迁移 */
      fileVersion = typeof raw.version === 'number' ? raw.version : 1
      this.data = {
        version: DATA_VERSION,
        /**
         * 模型配置：读盘时**就把清单归一化一遍**（`AiModelEntry[]`）。
         *
         * ⚠️ 以前这里是 `Array.isArray(raw.models) ? raw.models : []` 原样收下，于是数据
         * 文件里任何形状的条目都会活到 `AgentDomain.listModels()` 里 —— 那里假定
         * `models` 是字符串数组（旧结构），一个坏条目就让 `GET /api/models` 抛
         * `m?.trim is not a function`，而它正是 `GET /api/health` 汇总时要调的一路，
         * 于是整个 health 500、服务端看起来「挂了」。
         *
         * 归一化的语义与写盘时**同一条**（`normalizeModelEntries`：丢空 id / 重复 id /
         * 坏窗口），所以它对正常数据是幂等的，不需要配 DATA_VERSION 迁移。
         * 注意仍要补 `model`：数据文件里那份是派生字段，清单被归一化后可能对不上。
         */
        models: Array.isArray(raw.models)
          ? (raw.models as AiModelConfig[]).map((m) => {
              const models = normalizeModelEntries((m as { models?: unknown }).models)
              return { ...m, models, model: models[0]?.id ?? '' }
            })
          : [],
        // 旧数据文件没有 ACP 字段：读进来时补齐（否则新功能在旧数据上直接崩）
        acpAgents: Array.isArray(raw.acpAgents) ? raw.acpAgents : [],
        mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
        // SSH 主机：旧数据文件没这个字段，缺了 / 手改坏了都当归空
        sshHosts: arrayOr(raw.sshHosts),
        // 主机分组：同 SSH 主机，旧数据文件没有这个字段（老主机全部落进「未分组」）
        hostGroups: arrayOr(raw.hostGroups),
        // SSH 隧道：同 SSH 主机，旧数据文件没有这个字段
        sshTunnels: arrayOr(raw.sshTunnels),
        workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [],
        // 子任务偏好：老数据没有这个字段 / 手改坏了都归一化成「全关」
        subagentSettings: normalizeSubagentSettings(raw.subagentSettings),
        // 系统监控偏好：老数据没有这个字段 → 归一化成默认值（开），
        // 也就是「和加这个开关之前的行为完全一致」，升级后监控照常。
        systemMonitorSettings: normalizeSystemMonitorSettings(raw.systemMonitorSettings),
        // 界面语言：旧数据文件没有这个字段时按系统 locale 推断（见 detectDefaultLanguage），
        // 已写着的合法值原样保留
        language:
          raw.language === 'en' || raw.language === 'zh'
            ? raw.language
            : detectDefaultLanguage(),
        // 客户端偏好：新字段，旧数据文件没有 —— 按 `DEFAULT_PREFS` 补齐（与升级前的前端
        // 行为一致）；已写着的值只有非法时才回落默认，合法值原样保留
        prefs: normalizePrefs(raw.prefs),
        // 插件偏好：按项目归集（见 CoreData.pluginSettings）。老数据是**全局一份**
        // `{ disabled: [] }`，无从知道该落到哪个项目 —— 直接丢弃，相当于每个项目都
        // 回到「全启用」默认值（用户按需重新勾一遍即可）。
        pluginSettings: normalizePluginSettings(raw.pluginSettings),
        // 全局（用户级）插件偏好：老数据没有这个字段 → 回「全启用」，也就是
        // 「和加这个开关之前的行为完全一致」（用户级插件默认都挂上）
        globalPluginSettings: normalizeOnePluginSettings(raw.globalPluginSettings),
        // 插件设置项取值：老数据没有这两个字段 → 空（插件回落到自己的 default / env）
        pluginValues: normalizePluginValues(raw.pluginValues),
        pluginSecrets: normalizePluginSecrets(raw.pluginSecrets),
        // 会话不从这里读：真源在磁盘上的会话目录（下面 loadConversationsFromDisk 装配）
        conversations: [],
        skillSettings: {
          disabled: Array.isArray(raw.skillSettings?.disabled) ? raw.skillSettings!.disabled : [],
          extraDirs: Array.isArray(raw.skillSettings?.extraDirs) ? raw.skillSettings!.extraDirs : []
        },
        // 定时任务：同样是「旧数据文件没这个字段」，缺了就当空数组。
        // 这里刻意不用 `?? []` 而是 `Array.isArray` 判一下 —— 手改坏了（比如写成 `{}`）
        // 也不会让整个 store 起来就炸，跟上面几项一个待遇。
        taskTriggers: arrayOr(raw.taskTriggers),
        // 接口请求：同样是「旧数据文件没这几个字段」，缺了 / 手改坏了都当归空数组
        apiRequests: arrayOr(raw.apiRequests),
        apiGroups: arrayOr(raw.apiGroups),
        apiHistory: arrayOr(raw.apiHistory),
        // 主机脚本：同上，缺了 / 手改坏了都当归空数组
        scripts: arrayOr(raw.scripts),
        scriptGroups: arrayOr(raw.scriptGroups),
        // 笔记根目录：全新字段，旧数据文件里根本没有 —— 补空数组即可
        // （**不需要** DATA_VERSION 迁移：迁移是给「已写着的旧默认值」用的，
        //  这里老文件里压根没这个键，补默认值就够了）
        notesRoots: arrayOr(raw.notesRoots),
        // 容器型项目的公网域名：**形状从单个 `domain: string` 改成了 `domains: string[]`**
        // （v2 → v3）。`normalizeContainerPublicSettings` 认得出老字段并包成一项，所以
        // 老用户配的那个域名升级后照常生效；`fileVersion < DATA_VERSION` 会让这次装载
        // 顺手落一次盘，把盘上形状改写成新的 `domains`。
        containerPublicSettings: normalizeContainerPublicSettings(raw.containerPublicSettings)
      }
    } catch {
      // 首次运行 / 文件损坏：从空数据开始（写盘后即为新文件，旧文件被覆盖）
      this.data = emptyData()
    }
    // 扫盘装配会话索引，并把老数据文件里还在的会话迁移到会话目录
    await this.loadConversationsFromDisk(legacyConversations)
    this.loaded = true
    /**
     * 跑过一次性迁移（文件版本比当前低）：立刻落一次盘，把**新版本号 + 迁移结果**写回去。
     *
     * 不写的话每次启动都会重跑迁移 —— 迁移是「压掉已写着的旧默认值」，重跑就等于
     * 用户之后手改的那个字段永远被压掉。写回之后 `version` 到位，迁移只生效一次。
     */
    if (fileVersion < DATA_VERSION) this.schedulePersist()
  }

  /**
   * 从磁盘装配会话索引：
   *
   * 1. 扫每个工作区的 `<工作区>/.fizz/conversation/`（以及兜底目录
   *    `<数据目录>/conversations/`）读回全部会话；
   * 2. 老数据文件里还在、磁盘上没有的会话就地迁移写出去（保证不丢），
   *    并让 agent-core.json 再写一遍把 `conversations` 字段摘掉。
   */
  private async loadConversationsFromDisk(legacy: AgentConversation[]): Promise<void> {
    const merged = new Map<string, AgentConversation>()
    // 兜底目录先装，工作区目录后装（同一 id 以工作区那份为准）
    for (const c of await listConversationsIn(fallbackConversationRoot(this.dataDir))) {
      merged.set(c.id, c)
    }
    for (const workspace of this.data.workspaces) {
      const { root, fallback } = await resolveConversationRoot(workspace.path, this.dataDir)
      if (fallback) continue
      for (const c of await listConversationsIn(root)) merged.set(c.id, c)
    }
    let migrated = false
    for (const c of legacy) {
      if (!c?.id || merged.has(c.id)) continue
      merged.set(c.id, c)
      await this.writeConversationNow(c).catch((err) =>
        console.error('[conversation] 迁移写盘失败：', err)
      )
      migrated = true
    }
    this.data.conversations = [...merged.values()]
    // 老文件里有会话记录：让下一次落盘把 agent-core.json 里的 conversations 字段摘掉
    if (legacy.length) this.schedulePersist()
    if (migrated) {
      console.log(`[conversation] 已把 ${legacy.length} 条老会话迁移到会话目录`)
    }
  }

  /** 读一份快照（调用方别直接改它，用 mutate） */
  snapshot(): CoreData {
    if (!this.loaded) throw new Error('JsonStore 尚未初始化')
    return this.data
  }

  /** 改数据并落盘（同步语义，避免并发写互相覆盖） */
  mutate(fn: (data: CoreData) => void): CoreData {
    fn(this.data)
    this.schedulePersist()
    return this.data
  }

  /**
   * 把写盘排成一条串行队列。
   *
   * ⚠️ 别改回「每次 mutate 直接 `void this.persist()`」：所有写共用一个固定的
   * `.tmp` 路径，并发的 writeFile + rename 会互相把对方的 tmp 搬走，rename 抛 ENOENT
   * 被 catch 吞掉 —— 结果是**静默丢一次写盘**，而且日志上只留一行 写盘失败。
   * 串行之后每次写都等上一次 rename 完再写 tmp，同时也天然保证「后写的快照是新的」。
   */
  private writing: Promise<void> = Promise.resolve()

  private schedulePersist(): void {
    this.writing = this.writing.then(() => this.persist())
  }

  /**
   * 会话文件的写盘队列（与 `writing` 同构、分开串行）。
   *
   * 会话一个一条目录、文件互不相干，但共用同一条队列足够（写入量小），也避免
   * 同一会话的两个文件（config.json / conversation.json）被并发写坏。
   */
  private convWriting: Promise<void> = Promise.resolve()

  /**
   * 等**全部**在途写盘落地（agent-core.json + 所有会话目录）—— 退出钩子专用。
   *
   * mutate / writeConversation 是 fire-and-forget，进程在 writeFile 没落完时被杀，
   * 那一次修改就没了；退出流程里 await 一下这个，最后一次修改才写得进磁盘。
   * while 循环而不是一次 await：flush 期间可能又来了一次写（退出钩子自己就会），
   * 队列变了就得再等一轮，直到队列不再增长。
   */
  async flush(): Promise<void> {
    for (;;) {
      const core = this.writing
      const conversations = this.convWriting
      await Promise.all([core, conversations])
      if (core === this.writing && conversations === this.convWriting) return
    }
  }

  private persist(): Promise<void> {
    const tmp = `${this.filePath}.tmp`
    // 会话不写进 agent-core.json：真源在各自的会话目录（见 conversation-store.ts）
    const { conversations: _conversations, ...rest } = this.data
    return fs
      .writeFile(tmp, `${JSON.stringify(rest, null, 2)}\n`, 'utf8')
      .then(() => fs.rename(tmp, this.filePath))
      .catch((err) => console.error('[agent-core] 写盘失败：', err))
  }

  // ---------- 会话目录（真源） ----------

  /**
   * 把一个会话写回它的会话目录（fire-and-forget，串行队列）。
   *
   * 领域层改完内存里的 `conversations` 后调它；失败只记日志 —— 读仍然以内存索引
   * 为准，下一次改动会再写一遍。
   */
  writeConversation(conversation: AgentConversation): void {
    this.convWriting = this.convWriting
      .then(() => this.writeConversationNow(conversation))
      .catch((err) => console.error('[conversation] 写盘失败：', err))
  }

  /** 立即写一个会话（等待落盘；装载期迁移用） */
  private async writeConversationNow(conversation: AgentConversation): Promise<void> {
    const workspace = this.data.workspaces.find((w) => w.id === conversation.workspaceId)
    const { root } = await resolveConversationRoot(workspace?.path, this.dataDir, { create: true })
    await writeConversationToRoot(root, conversation)
  }

  /** 读一个协作会话的运行态（任务 / 消息 / 最近状态）；普通会话 / 未写过 = null */
  async readCollabState(conversationId: string): Promise<CollabState | null> {
    const conversation = this.data.conversations.find((c) => c.id === conversationId)
    if (!conversation || conversation.kind !== 'collab') return null
    const workspace = this.data.workspaces.find((w) => w.id === conversation.workspaceId)
    const { root } = await resolveConversationRoot(workspace?.path, this.dataDir, { create: false })
    const state = await readCollabStateDir(join(root, conversationId))
    if (state) return state
    const fallback = await readCollabStateDir(
      join(fallbackConversationRoot(this.dataDir), conversationId)
    )
    return fallback
  }

  /** 写协作运行态（fire-and-forget，与会话文件共用串行队列） */
  writeCollabState(conversationId: string, state: CollabState): void {
    const conversation = this.data.conversations.find((c) => c.id === conversationId)
    if (!conversation) return
    const workspacePath = this.data.workspaces.find(
      (w) => w.id === conversation.workspaceId
    )?.path
    const dataDir = this.dataDir
    this.convWriting = this.convWriting
      .then(async () => {
        const { root } = await resolveConversationRoot(workspacePath, dataDir, { create: true })
        await writeCollabStateToRoot(root, conversationId, state)
      })
      .catch((err) => console.error('[collab] 写盘失败：', err))
  }

  /**
   * 删掉一个会话的目录（工作区目录与兜底目录都试，谁在删谁）。
   *
   * ⚠️ 工作区路径在这里**同步取好**再入队：删工作区是「先删会话目录、再删工作区记录」，
   * 若等到队列跑起来才查 `workspaces`，记录已经没了，会算不出会话在项目里的位置。
   */
  deleteConversationFiles(conversation: AgentConversation): void {
    const workspacePath = this.data.workspaces.find((w) => w.id === conversation.workspaceId)?.path
    const dataDir = this.dataDir
    this.convWriting = this.convWriting
      .then(async () => {
        const { root, fallback } = await resolveConversationRoot(workspacePath, dataDir)
        if (!fallback) await removeConversationDir(join(root, conversation.id))
        await removeConversationDir(join(fallbackConversationRoot(dataDir), conversation.id))
      })
      .catch((err) => console.error('[conversation] 删除目录失败：', err))
  }

  /** 确保某个工作区的会话目录就绪（新增工作区时调一次，让 `.fizz/conversation/` 立即可见） */
  async ensureConversationDir(workspacePath: string): Promise<void> {
    await resolveConversationRoot(workspacePath, this.dataDir, { create: true })
  }

  // ---------- 密钥 ----------

  encryptSecret(plain: string | undefined): string | undefined {
    return this.box.encrypt(plain)
  }

  decryptSecret(value: string | undefined): string | undefined {
    return this.box.decrypt(value)
  }

  /** 存模型时把 apiKey 加密（其余字段原样） */
  sealModel(model: AiModelConfig): AiModelConfig {
    return sealModel(this.box, model)
  }
}

export function newId(): string {
  return randomUUID()
}
