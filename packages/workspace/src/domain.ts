/**
 * Agent 领域逻辑（模型配置 / 工作区 / 会话）：纯 Node，不依赖 Electron。
 *
 * 与桌面端的差别只有两处，都是**刻意的**：
 * 1. 密钥用本包的 SecretBox（服务端不可能用 Electron 的 safeStorage）；
 * 2. 工作区路径必须**显式登记且真实存在**——服务端是给外部连的，
 *    工作区列表就是权限边界（桌面端由本机用户自己选目录，无所谓）。
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  AcpContextUsage,
  AcpModesState,
  AcpPermissionMode,
  AcpThoughtLevelState,
  AgentConversation,
  AgentChatMessage,
  AgentWorkspace,
  CollabSettings,
  CollabState,
  ApiGroup,
  ApiGroupInput,
  ApiGroupsAndRequests,
  ApiHistoryEntry,
  ApiRequestEntry,
  ApiArrangeInput,
  ScriptEntry,
  ScriptGroup,
  ScriptInput,
  ScriptGroupInput,
  ScriptArrangeInput,
  ScriptsAndGroups,
  ConversationAutoSummary,
  ConversationContextSummary,
  ConversationUsage,
  AiModelConfig,
  AiModelEntry,
  AiModelSettings,
  QueuedMessage,
  SshAuthType,
  SshCharset,
  SshHostConfig,
  SshHostInput,
  SshTunnel,
  SshTunnelInput,
  HostConfig,
  HostArrangeInput,
  HostGroup,
  HostGroupInput,
  HostGroupsAndHosts,
  HostInput,
  LocalHostConfig,
  LocalHostInput,
  NotesRoot,
  NotesRootInput,
  RemoteWorkspaceRef,
  SubagentTurnUsage,
  TransferImportResult,
  TransferKind,
  TransferPayload,
  TurnUsage
} from '@fizz/contracts/types'
import {
  normalizeCollabSettings,
  normalizeCollabState,
  normalizeReasoningEffort
} from '@fizz/contracts/types'
import type { AcpAgentConfig } from '@fizz/acp'
import { normalizeMcpTransport, type McpServerConfig, type McpServerInput } from '@fizz/mcp'
import type { SkillSettings } from '@fizz/skills'
import { normalizeSubagentSettings, type SubagentSettings } from '@fizz/contracts/types'
// 走根入口：子路径 alias 只在各端列出来的那几个里有效（见 store.ts 同处注释）
import {
  normalizeBrowserSettings,
  type BrowserSettings,
  normalizeSystemMonitorSettings,
  type SystemMonitorSettings,
  normalizeLanguage,
  type AppLanguage,
  normalizeContainerPublicSettings,
  type ContainerPublicSettings,
  normalizePrefs,
  normalizePrefsPatch,
  type PrefsSnapshot,
  type PrefsPatch
} from '@fizz/contracts'
import type { PluginSettings } from '@fizz/plugin'
import type {
  AcpAgentInput,
  AcpAgentView,
  ConversationInput,
  ConversationSearchHit,
  ConversationSummary,
  ModelInput,
  ModelView,
  UsageBucket,
  UsageByConversation,
  UsageByDay,
  UsageSummary,
  WorkspaceInput
} from '@fizz/contracts/agent-api'
import {
  newId,
  JsonStore,
  resolveDataDir,
  type StoredHost,
  type StoredLocalHost,
  type StoredSshHost
} from './store'
import { validateRemoteWorkspacePath } from '@fizz/contracts/workspace'
import { pickContainer } from './container-carry'
import { acpAgentKey } from '@fizz/contracts/agent-api'
import { applyTransferPayload, buildTransferPayload, type TransferSnapshot } from './transfer'

/**
 * 归一化模型清单：每个条目只保留 `{ id, contextWindow?, settings? }`。
 *
 * 丢空 id / 重复 id（保留首次出现）、非正窗口、坏字段 —— 手改坏了一个值不该让整份
 * 配置存不下去 / 读不出来。旧格式（`models: string[]` + 两张 map）**不再兼容**。
 */
export function normalizeModelEntries(raw: unknown): AiModelEntry[] {
  if (!Array.isArray(raw)) return []
  const out: AiModelEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const value = item as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const entry: AiModelEntry = { id }
    const window = value.contextWindow
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
      entry.contextWindow = Math.floor(window)
    }
    const settings = normalizeModelSettings(value.settings)
    if (settings) entry.settings = settings
    out.push(entry)
  }
  return out
}

/**
 * 归一化单个模型的进阶设置：布尔项只保留**显式 false**（缺省 true 不落盘，数据文件
 * 保持精简）；坏值 / 空对象归一成「没有」。
 */
function normalizeModelSettings(raw: unknown): AiModelSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const entry: AiModelSettings = {}
  const tokens = value.maxOutputTokens
  if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
    entry.maxOutputTokens = Math.floor(tokens)
  }
  if (value.toolCall === false) entry.toolCall = false
  if (value.imageInput === false) entry.imageInput = false
  if (value.reasoning === false) entry.reasoning = false
  if (value.apiStyle === 'chat-completions' || value.apiStyle === 'responses') {
    entry.apiStyle = value.apiStyle
  }
  return Object.keys(entry).length ? entry : undefined
}

/** 客户端可见的模型视图：抹掉明文密钥 */
function toView(model: AiModelConfig): ModelView {
  // 旧格式的旁路字段不再兼容：读旧数据文件时别把它们原样透给客户端
  const {
    apiKey: _secret,
    models: rawModels,
    contextWindows: _legacyWindows,
    modelSettings: _legacySettings,
    ...rest
  } = model as AiModelConfig & { contextWindows?: unknown; modelSettings?: unknown }
  const models = normalizeModelEntries(rawModels)
  return {
    ...rest,
    models,
    // 派生字段：清单第一项（对话用哪个由 resolveModelConfig 覆盖成选中项）
    model: models[0]?.id ?? '',
    hasApiKey: !!_secret
  }
}

/**
 * 归一化一份待发送队列（服务端落盘前统一走它）。
 *
 * 队列内容由前端生成（本地 id），服务端不解释、只兜底 —— 把明显不能用的条目剔掉：
 * - 空正文 / 非字符串正文：发给模型也是一轮空转，不如当场丢掉；
 * - 重复 id：会让「删一条」变成删两条，按首次出现保留；
 * - 超长正文 / 超多条目：防一次写把落盘文件撑爆（削尾 / 截断，都不报错）。
 *
 * 不做 HTML 转义之类的清洗：正文最终是发给模型的纯文本，转义只会污染内容。
 */
const QUEUE_LIMIT = 100
const QUEUE_TEXT_LIMIT = 32_000
function sanitizeQueue(items: unknown): QueuedMessage[] {
  if (!Array.isArray(items)) return []
  const out: QueuedMessage[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    if (out.length >= QUEUE_LIMIT) break
    const item = raw as Partial<QueuedMessage> | null
    if (!item || typeof item.id !== 'string' || !item.id) continue
    if (seen.has(item.id)) continue
    const text = typeof item.text === 'string' ? item.text.slice(0, QUEUE_TEXT_LIMIT) : ''
    if (!text.trim()) continue
    seen.add(item.id)
    out.push({
      id: item.id,
      text,
      createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : Date.now()
    })
  }
  return out
}

/**
 * 摘要检查点还成立吗：**锚点消息必须仍在 `messages` 里**，否则返回 `undefined`（= 丢掉）。
 *
 * `ConversationContextSummary.upToMessageId` 记的是「已摘要的最后一条」，它同时是下一轮
 * 组装历史时的切点（`historyForTurn` 从它之后取原文）。锚点一旦被删掉，那份摘要描述的就是
 * **已经不存在的历史**，而 `historyForTurn` 会退化成按 `createdAt` 过滤、照样把摘要置顶 ——
 * 用户刚删掉的内容又通过摘要被喂回模型（模型会「记得」用户以为删干净了的事）。
 *
 * 所以「动 messages 的删除类路径」都要过这一道：锚点不在了就把检查点一起丢，让下一轮
 * 重新按需压缩。宁可多压一次，也别把删掉的东西带回来。
 *
 * 与 `forkConversation` 同一判据（那里是「锚点没落在截取范围内就不复制摘要」）。
 * ⚠️ 与 `saveConversation` 刻意不同：那条路是「改标题 / 换模型 / 桌面端覆盖消息」，
 * 消息通常没被裁剪，摘要该原样带走（见那里 1085 行起的注释）。
 */
function liveContextSummary(
  summary: ConversationContextSummary | undefined,
  messages: AgentChatMessage[]
): ConversationContextSummary | undefined {
  if (!summary) return undefined
  return messages.some((m) => m.id === summary.upToMessageId) ? summary : undefined
}

/**
 * 两份用量相加（任一为 undefined 视为 0）。
 *
 * 单轮 TurnUsage 是模型返回的本轮 token 数；ConversationUsage 是整个会话的累计。
 * 这里只做纯累加 -- 不涉及估算 / 上限 / 压缩，调用方（appendMessages）在每轮结束时调一次。
 */
function addUsage(
  base: ConversationUsage | undefined,
  turn: TurnUsage | undefined
): ConversationUsage | undefined {
  if (!turn) return base
  const prev = base ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const next: ConversationUsage = {
    inputTokens: prev.inputTokens + turn.inputTokens,
    outputTokens: prev.outputTokens + turn.outputTokens,
    totalTokens: prev.totalTokens + turn.totalTokens
  }
  if (turn.reasoningTokens || prev.reasoningTokens) {
    next.reasoningTokens = (prev.reasoningTokens ?? 0) + (turn.reasoningTokens ?? 0)
  }
  if (turn.cachedInputTokens || prev.cachedInputTokens) {
    next.cachedInputTokens = (prev.cachedInputTokens ?? 0) + (turn.cachedInputTokens ?? 0)
  }
  // 子任务（subagent）用量单独累计，不并进上面的父口径（理由见 TurnUsage.subagents）
  if (turn.subagents || prev.subagents) {
    const merged: Record<string, SubagentTurnUsage> = { ...(prev.subagents ?? {}) }
    for (const [id, s] of Object.entries(turn.subagents ?? {})) {
      const p = merged[id]
      merged[id] = p
        ? {
            calls: p.calls + s.calls,
            inputTokens: p.inputTokens + s.inputTokens,
            outputTokens: p.outputTokens + s.outputTokens,
            totalTokens: p.totalTokens + s.totalTokens,
            ...(p.reasoningTokens || s.reasoningTokens
              ? { reasoningTokens: (p.reasoningTokens ?? 0) + (s.reasoningTokens ?? 0) }
              : {})
          }
        : s
    }
    next.subagents = merged
  }
  return next
}

/** 客户端可见的 ACP agent 视图（与配置同形；历史上的 isDefault 已随「默认」概念移除） */
function toAcpView(agent: AcpAgentConfig): AcpAgentView {
  return { ...agent }
}

// ---------- SSH 主机（视图 / 归一化 / 凭据加密） ----------

/** 判一条落盘主机是不是本机终端（`kind === 'local'`；老数据没有 kind = SSH 主机） */
function isStoredLocal(host: StoredHost): host is StoredLocalHost {
  return host.kind === 'local'
}

/** 客户端可见的主机视图：SSH 走脱敏（抹掉密文，只留 `has*`），本机终端原样 */
function toHostView(host: StoredHost): HostConfig {
  return isStoredLocal(host) ? { ...host } : toSshView(host)
}

/** 客户端可见的 SSH 主机视图：抹掉密文，只留 `has*` 脱敏标记 */
function toSshView(host: StoredSshHost): SshHostConfig {
  const { password, privateKey, passphrase, ...rest } = host
  return {
    ...rest,
    authType: rest.authType ?? 'password',
    charset: rest.charset ?? 'utf-8',
    ...(password ? { hasPassword: true } : {}),
    ...(privateKey ? { hasPrivateKey: true } : {}),
    ...(passphrase ? { hasPassphrase: true } : {})
  }
}

/**
 * 凭据字段的写入语义：`undefined` = 保留原值；`''` = 清空；其余 = 加密后覆盖。
 *
 * 这样「只改主机名 / 端口」的编辑不会把密码抹掉；真要清空得显式传空串。
 */
function sealOrKeep(
  store: JsonStore,
  incoming: string | undefined,
  existing: string | undefined
): string | undefined {
  if (incoming === undefined) return existing
  if (incoming === '') return undefined
  return store.encryptSecret(incoming)
}

/** SSH 端口归一：1..65535 的整数，坏值 / 未填回 22 */
function normalizeSshPort(raw: number | undefined): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 22
}

/** 保活间隔归一：正数取整；0 = 关闭；坏值 / 未填回默认 30 秒 */
function normalizeKeepalive(raw: number | undefined): number {
  if (raw === 0) return 0
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30
}

/**
 * 归属分组归一：分组已不存在（界面刚把它删了 / 数据被手改坏）时当作未分组。
 *
 * 不归一的话主机会带着一个悬空 `groupId`：分组树里查不到这个组，条目就从列表上
 * **凭空消失**（`buildGroupTree` 只认已存在的分组），而数据里又确实还在。
 */
function normalizeHostGroupId(id: string | undefined, groups: HostGroup[]): string | undefined {
  const trimmed = id?.trim()
  if (!trimmed) return undefined
  return groups.some((g) => g.id === trimmed) ? trimmed : undefined
}

/** 某个分组 + 它全部子孙分组的 id（DFS；起点不在列表里时返回空集） */
function hostGroupSubtreeIds(groups: HostGroup[], id: string): Set<string> {
  const found = new Set<string>()
  const collect = (gid: string): void => {
    if (found.has(gid)) return
    found.add(gid)
    for (const g of groups) if (g.parentId === gid) collect(g.id)
  }
  if (groups.some((g) => g.id === id)) collect(id)
  return found
}

/**
 * 保存时拒绝「跳板成环」：顺着 `jumpHostId` 往上走，若回到自己就是环。
 *
 * 环会让建连时无限递归，必须在入口挡掉。数据里已经存在的历史环（手改坏的）不在
 * 本次保存里添乱 —— 走到重复节点就退出去，把问题留给运行时检测。
 */
function assertNoJumpCycle(hosts: StoredHost[], id: string, jumpHostId: string): void {
  const byId = new Map(
    hosts.filter((h): h is StoredSshHost => !isStoredLocal(h)).map((h) => [h.id, h])
  )
  const seen = new Set<string>()
  let cursor: string | undefined = jumpHostId
  while (cursor) {
    if (cursor === id) throw new Error('跳板机设置成了环（A → B → A），请重新选择')
    if (seen.has(cursor)) return
    seen.add(cursor)
    cursor = byId.get(cursor)?.jumpHostId
  }
}

/**
 * 服务端建连用的 SSH 主机：凭据已解密。
 *
 * ⚠️ **只在本进程内使用**，绝不经 HTTP 回传渲染端（对外一律 `SshHostConfig` 脱敏视图）。
 * 跳板链由调用方按 `jumpHostId` 递归 `resolveSshHost` 自行解析。
 */
export interface ResolvedSshHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  password?: string
  privateKey?: string
  passphrase?: string
  jumpHostId?: string
  charset: SshCharset
  /** 保活间隔（秒），已带默认 30；0 = 关闭 */
  keepaliveInterval: number
}

/**
 * 插件注册的模型配置：**不落盘**、只读，由服务端在插件刷新时通过
 * `AgentDomain.setExternalModels()` 灌进来。
 *
 * `pluginId` / `sourceName` 只用于设置页展示来源；`apiKey` 是插件随注册交来的明文
 * （插件设置项由宿主解密后交给它），所以**不要**再走 `decryptSecret`。
 */
export interface PluginModelEntry extends AiModelConfig {
  pluginId: string
  sourceName: string
}

/**
 * 远端标记在「重新登记 / 重命名」时的存活判据（与 `pickContainer` 同款）。
 *
 * `addWorkspace` 是逐字段重建整条记录：重命名只传 `name` + 原路径，漏了这里就会把
 * 远端工作区**静默降级**成本地工作区 —— 下一次工具调用开始操作本机同名路径。
 */
export function pickRemote(
  input?: RemoteWorkspaceRef,
  prev?: RemoteWorkspaceRef,
  byPath?: RemoteWorkspaceRef
): RemoteWorkspaceRef | undefined {
  return input ?? prev ?? byPath
}

export class AgentDomain {
  /** 插件注册的模型配置（内存态，随插件刷新整体替换） */
  private externalModels: PluginModelEntry[] = []

  // 以前这里会 `ensureTasksWorkspace()` 补建内置「任务」工作区（不绑目录的「仅对话」模式）。
  // 该模式已移除 —— 会话必须挂在真实目录上，所以不再有需要自动补建的东西。
  constructor(private readonly store: JsonStore) {}

  /**
   * 会话的统一写入口：改内存索引（同步，读接口立刻可见）+ 写回会话目录（异步）。
   *
   * 会话真源在 `<项目>/.fizz/conversation/<id>/`（见 conversation-store.ts）；
   * 内存里的 `CoreData.conversations` 只是索引，供同步的列表 / 搜索 / 用量读。
   * 所有会话改动都必须走这里，否则磁盘上会留下旧数据。
   */
  private commitConversation(next: AgentConversation): AgentConversation {
    this.store.mutate((d) => {
      const exists = d.conversations.some((c) => c.id === next.id)
      d.conversations = exists
        ? d.conversations.map((c) => (c.id === next.id ? next : c))
        : [...d.conversations, next]
    })
    this.store.writeConversation(next)
    return next
  }

  // ---------- 模型配置 ----------

  /**
   * 插件模型配置（服务端插件刷新后调）：整份替换，不做增量合并。
   *
   * 插件 id 与用户手建的配置理论上可能撞（手改数据文件）；这里**保留用户的**、丢掉
   * 插件那条，避免设置页出现两个同 id 的卡片和「删一个另一个也不见」的怪状态。
   */
  setExternalModels(models: PluginModelEntry[]): void {
    const owned = new Set(this.store.snapshot().models.map((m) => m.id))
    this.externalModels = models.filter((m) => !owned.has(m.id))
  }

  /** 当前插件注册的配置（服务端刷新逻辑读它做 diff 用，不参与持久化） */
  listExternalModels(): PluginModelEntry[] {
    return this.externalModels
  }

  listModels(): ModelView[] {
    const stored = this.store.snapshot().models.map((m) => toView(m))
    const external = this.externalModels.map((m) => ({
      ...toView(m),
      readOnly: true,
      source: 'plugin' as const,
      sourceName: m.sourceName,
      pluginId: m.pluginId
    }))
    return [...stored, ...external]
  }

  /**
   * 取「跑这一轮该用哪个模型」：配置与模型都必须是**显式选择**的（会话绑定 /
   * 请求带上），不存在「清单第一份 / 配置默认」的隐式回退 —— 回退会掩盖
   * 「用户选的东西已经没了」，直接给一句人话报错让重新选。
   *
   * 返回的配置里 `model` **就是这一轮要用的那个**（清单里的某项），
   * `apiKey` 已解密（仅内存中使用，绝不出网）—— 下游构造 provider 只读 `model` 即可。
   */
  resolveModelConfig(id: string, modelId: string): AiModelConfig {
    const data = this.store.snapshot()
    const stored = data.models.find((m) => m.id === id)
    // 插件注册的配置不落盘，但和用户建的一样参与会话解析（apiKey 已是明文，别再解密）
    const target: AiModelConfig | undefined =
      stored ?? this.externalModels.find((m) => m.id === id)
    if (!target) throw new Error('所选模型配置不存在或已被删除，请在输入框上方重新选择模型')
    const apiKey = stored ? this.store.decryptSecret(target.apiKey) : target.apiKey
    const models = normalizeModelEntries(target.models)
    /**
     * 配置允许暂时没有模型（见 `saveModel`），但这一轮就跑不起来了。
     * 必须**在这里**给一句人话：否则空 model id 会一路走到 provider 里，
     * 报一个「model 不能为空 / 404」之类的错，用户根本不知道要回去补模型。
     */
    if (!models.length) {
      throw new Error(`模型配置「${target.name}」还没有模型：请到设置 →「模型」里给它加一个模型 id`)
    }
    if (!models.some((entry) => entry.id === modelId)) {
      throw new Error(`模型配置「${target.name}」下没有「${modelId}」这个模型（可能已被删），请重新选择`)
    }
    // 上游 resolveModel 需要明文 key 才能构造 provider
    const {
      contextWindows: _legacyWindows,
      modelSettings: _legacySettings,
      ...rest
    } = target as AiModelConfig & { contextWindows?: unknown; modelSettings?: unknown }
    return { ...rest, models, model: modelId, apiKey }
  }

  saveModel(input: ModelInput): ModelView {
    const now = Date.now()
    const data = this.store.snapshot()
    if (input.id && this.externalModels.some((m) => m.id === input.id)) {
      throw new Error('这份模型配置由插件注册，只能在插件里修改（设置页里是只读的）')
    }
    const prev = input.id ? data.models.find((m) => m.id === input.id) : undefined
    if (input.id && !prev) throw new Error('模型配置不存在')

    /**
     * 模型清单：每个条目整份替换（id + 窗口 + 进阶设置一起），去空 / 去重 / 保序。
     *
     * ⚠️ **允许清单为空**：先把网关 / key 建好、模型之后再补，或者把模型一个个删光
     * （设置页的模型标签可以直接删，删到 0 个也不该顺手把整份配置带走）。
     * 空的配置不能用于对话 —— 那一步的错误由 `resolveModelConfig` 明确给出。
     */
    const models = normalizeModelEntries(input.models)

    const model: AiModelConfig = {
      id: prev?.id ?? newId(),
      // 名字：用户填的 > 第一个模型 id > 原来的名字 > 兜底（空清单时不能让 name 变成 undefined）
      name: (input.name ?? '').trim() || models[0]?.id || prev?.name || '未命名模型',
      kind: input.kind,
      models,
      // 实现细节：provider 构造需要 model 字段，取清单第一项；无「默认」语义
      //（对话用哪个模型由会话显式绑定，见 resolveModelConfig）
      model: models[0]?.id ?? '',
      apiKey: input.apiKey ? this.store.encryptSecret(input.apiKey)! : prev?.apiKey,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      ...(input.baseURL ? { baseURL: input.baseURL } : {}),
      ...(input.apiStyle ? { apiStyle: input.apiStyle } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.contextMessages !== undefined ? { contextMessages: input.contextMessages } : {})
    }

    this.store.mutate((d) => {
      d.models = prev ? d.models.map((m) => (m.id === model.id ? model : m)) : [...d.models, model]
    })
    return toView(model)
  }

  deleteModel(id: string): void {
    if (this.externalModels.some((m) => m.id === id)) {
      throw new Error('这份模型配置由插件注册，不能从这里删除（停用 / 卸载插件即可）')
    }
    this.store.mutate((d) => {
      d.models = d.models.filter((m) => m.id !== id)
    })
  }

  // ---------- 工作区（= 服务端的路径白名单） ----------

  listWorkspaces(): AgentWorkspace[] {
    return this.store.snapshot().workspaces
  }

  getWorkspace(id: string): AgentWorkspace | undefined {
    return this.store.snapshot().workspaces.find((w) => w.id === id)
  }

  /**
   * 工作区目录还在不在（`path` 非空时才问；`stat` 失败 / 不是目录都算不在）。
   *
   * 巡检（`apps/server/src/server/workspace-health.ts`）与「新建会话」那道服务端校验
   * **共用这一份** —— 两处各写一遍 stat，判据迟早会漂。
   *
   * 容器 / worktree 工作区的 `path` 同样是宿主上的真实目录，所以一套判据就够，
   * 不需要按类型特例。
   */
  async isWorkspaceDirAvailable(path: string): Promise<boolean> {
    if (!path) return false
    const stat = await fs.stat(path).catch(() => null)
    return !!stat?.isDirectory()
  }

  /**
   * 写「目录不在了」这个标记（巡检发现变化时调）。返回**是否真的变了** ——
   * 没变就别 mutate：每次 mutate 都会落盘一次，并让所有客户端重收一遍工作区快照。
   *
   * 刻意**不动 `updatedAt`**：这不是用户的改动，侧栏若按它排序会让项目跳位。
   * 重新登记（`addWorkspace` —— 重命名、换个目录都走它）会重建整条记录，
   * 天然把这个标记清掉，所以「目录回来 / 重新选目录」都不需要额外收尾。
   */
  markWorkspaceDirMissing(id: string, missing: boolean): boolean {
    const prev = this.getWorkspace(id)
    if (!prev) return false
    if (!!prev.dirMissing === missing) return false
    this.store.mutate((d) => {
      d.workspaces = d.workspaces.map((w) =>
        w.id === id ? { ...w, dirMissing: missing || undefined } : w
      )
    })
    return true
  }

  async addWorkspace(input: WorkspaceInput): Promise<AgentWorkspace> {
    const data = this.store.snapshot()
    const prev = input.id ? data.workspaces.find((w) => w.id === input.id) : undefined
    if (input.id && !prev) throw new Error('工作区不存在')

    // 先定「是不是远端」，再决定路径用哪套规范化：远端是 POSIX，本机是宿主绝对路径
    if (input.remote && prev && !prev.remote) {
      throw new Error('已登记的本机工作区不能直接改成远端工作区，请新建一个远端工作区')
    }
    const requestedRemote = input.remote ?? prev?.remote
    let path: string
    if (requestedRemote) {
      path = validateRemoteWorkspacePath(input.path)
    } else {
      const raw = input.path.trim()
      if (!isAbsolute(raw)) throw new Error('工作区路径必须是绝对路径')
      path = resolve(raw)
    }

    // 去重键是 `(hostId, path)`：同名目录可能同时存在于本机与远端，不能撞成一条
    const key = requestedRemote?.hostId ?? 'local'
    const byPath = data.workspaces.find(
      (w) => w.path === path && (w.remote?.hostId ?? 'local') === key
    )
    const remote = pickRemote(input.remote, prev?.remote, byPath?.remote)

    if (remote) {
      const hostId = remote.hostId?.trim() ?? ''
      if (!hostId) throw new Error('缺少 SSH 主机')
      const host = data.sshHosts.find((h) => h.id === hostId)
      if (!host) throw new Error('所选 SSH 主机不存在或已被删除')
      if (isStoredLocal(host)) throw new Error('本机终端配置不能作为远端工作区的主机')
      // 远端首期不支持 worktree / 容器 / 临时工作区：这些流程都假定目录在本机
      if (input.isWorktree ?? prev?.isWorktree ?? byPath?.isWorktree) {
        throw new Error('远端工作区不支持 worktree')
      }
      if (input.parentWorkspaceId ?? byPath?.parentWorkspaceId ?? prev?.parentWorkspaceId) {
        throw new Error('远端工作区不能挂在其他项目下面')
      }
      if (input.container ?? prev?.container ?? byPath?.container) {
        throw new Error('远端工作区不支持容器')
      }
      if (input.scratch ?? prev?.scratch ?? byPath?.scratch) {
        throw new Error('远端工作区不支持临时工作区标记')
      }
    } else {
      // 本机路径仍要当场 stat：工作区清单就是服务端的路径白名单。
      // 远端只做字符串校验 —— 存在性由 API 层用 SFTP 探测（领域层不碰网络）。
      const stat = await fs.stat(path).catch(() => null)
      if (!stat?.isDirectory()) throw new Error(`目录不存在或不是目录：${path}`)
    }

    const now = Date.now()
    // 父项目 id：新建时由调用方传入；更新既有 worktree 时保留原值（避免被抹掉）
    const parentWorkspaceId =
      input.parentWorkspaceId ?? byPath?.parentWorkspaceId ?? prev?.parentWorkspaceId
    // 容器型项目配置：重命名 / 换目录都走这里，必须**原样带过去**，否则静默降级成普通项目
    const carried = pickContainer(input.container, prev?.container, byPath?.container)
    const workspace: AgentWorkspace = {
      id: byPath?.id ?? prev?.id ?? newId(),
      name: input.name?.trim() || (path.split(/[\\/]/).filter(Boolean).pop() ?? path),
      path,
      // isWorktree 是布尔标记：只在 true 时写入（既有项目不受影响）；
      // 已有 worktree 项目走更新（重命名）时保留原值
      ...(input.isWorktree ?? prev?.isWorktree ? { isWorktree: true } : {}),
      ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
      ...(remote && remote.hostId ? { remote } : {}),
      ...(carried ? { container: carried } : {}),
      // 临时工作区标记：只有服务端懒创建时带；重命名 / 重新登记要原样保留，
      // 否则它会突然出现在侧栏的项目列表里
      ...((input.scratch ?? prev?.scratch ?? byPath?.scratch) ? { scratch: true } : {}),
      createdAt: byPath?.createdAt ?? prev?.createdAt ?? now,
      updatedAt: now
    }
    this.store.mutate((d) => {
      const exists = d.workspaces.some((w) => w.id === workspace.id)
      d.workspaces = exists
        ? d.workspaces.map((w) => (w.id === workspace.id ? workspace : w))
        : [...d.workspaces, workspace]
    })
    // 本地项目在 `.fizz/conversation/` 建目录；远端落本机 `conversations/remote/<id>/`
    await this.store.ensureConversationDir(workspace)
    return workspace
  }

  /**
   * 给「没选项目」的会话建一个**临时工作区**：目录 `<数据目录>/conversations/<会话 id>`。
   *
   * 为什么不提前建：用户只是没选项目，可能下一秒就选了 —— 在界面上建会在数据目录里
   * 攒一堆空目录。真正的时机是**发送**：服务端 `POST /api/conversations` 收到空
   * `workspaceId` 时，先用这条会话的 id 建目录、登记成临时工作区，再把会话绑上去。
   * 一条会话一个目录，名字与 id 对得上，出问题好找。
   *
   * 目录先建再登记：`addWorkspace` 要求目录真实存在（工作区清单就是服务端的权限边界）。
   * 登记出来的工作区带 `scratch` 标记，侧栏不把它当项目列出来。
   */
  async ensureScratchWorkspace(conversationId: string): Promise<AgentWorkspace> {
    const path = join(resolveDataDir(), 'conversations', conversationId)
    await fs.mkdir(path, { recursive: true })
    return this.addWorkspace({ path, name: '临时会话', scratch: true })
  }

  /**
   * 一棵工作区子树（自身 + 全部按 `parentWorkspaceId` 挂下来的后代 worktree 项目）。
   *
   * 用循环而不是递归：`parentWorkspaceId` 是纯数据（人可手改 `agent-core.json`），
   * 出现环时递归会直接爆栈，这里靠「本轮有没有长出新 id」收尾。
   */
  workspaceSubtree(id: string): AgentWorkspace[] {
    const all = this.store.snapshot().workspaces
    const ids = new Set<string>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const w of all) {
        if (w.parentWorkspaceId && ids.has(w.parentWorkspaceId) && !ids.has(w.id)) {
          ids.add(w.id)
          grew = true
        }
      }
    }
    return all.filter((w) => ids.has(w.id))
  }

  /**
   * 删工作区 —— **级联**删掉整棵子树，以及挂在它们下面的会话 / 定时任务。
   *
   * 为什么必须级联：worktree 项目是按 `parentWorkspaceId` 挂在父项目下的，只删一条就会在
   * `.worktree/` 里留一堆「已登记但父没了」的条目（侧栏的父推断会让它们浮到顶层）。
   * 会话 / 定时任务只存 `workspaceId`，工作区没了它们就成永远看不到的孤儿数据。
   *
   * 注意这里只动**数据**；磁盘目录、git worktree、容器留给调用方（流程删除要跑
   * git / docker，领域层不碰），调用方必须在删记录**之前**把那些做完。
   */
  deleteWorkspace(id: string): void {
    const ids = new Set(this.workspaceSubtree(id).map((w) => w.id))
    // 会话目录先删（趁工作区记录还在，store 才算出会话在项目里的位置）
    const doomed = this.store.snapshot().conversations.filter((c) => ids.has(c.workspaceId))
    for (const conversation of doomed) this.store.deleteConversationFiles(conversation)
    this.store.mutate((d) => {
      d.workspaces = d.workspaces.filter((w) => !ids.has(w.id))
      // 工作区没了，它的会话也一并清掉（避免留下永远看不到的孤儿数据）
      d.conversations = d.conversations.filter((c) => !ids.has(c.workspaceId))
      // 定时任务只清「绑在这个工作区上」的那些；**没绑工作区的别动** —— 它们本来就不属于
      // 任何项目（每次触发自建临时工作区），`ids.has(undefined)` 会永远是 false，但这里
      // 显式判一下，免得将来有人把 `ids` 换成别的形状时把它们一起扫掉
      d.taskTriggers = d.taskTriggers.filter(
        (t) => !t.workspaceId || !ids.has(t.workspaceId)
      )
      // 插件偏好按 workspaceId 归集，项目没了它也就没意义了
      d.pluginSettings = Object.fromEntries(
        Object.entries(d.pluginSettings).filter(([wid]) => !ids.has(wid))
      )
    })
  }

  /** 目录是否在已登记的工作区之内（服务端所有文件访问的边界） */
  findWorkspaceContaining(path: string): AgentWorkspace | undefined {
    const target = resolve(path)
    return this.store
      .snapshot()
      .workspaces.find((w) => target === w.path || target.startsWith(`${w.path}\\`) || target.startsWith(`${w.path}/`))
  }

  // ---------- 笔记根目录（= 笔记文件接口的路径白名单） ----------

  listNotesRoots(): NotesRoot[] {
    return this.store.snapshot().notesRoots
  }

  getNotesRoot(id: string): NotesRoot | undefined {
    return this.store.snapshot().notesRoots.find((r) => r.id === id)
  }

  /**
   * 登记一个目录当笔记根。
   *
   * 校验与 `addWorkspace` 同源：必须是**绝对路径**、必须**存在且是目录** ——
   * 否则界面上会多出一个点开就报错的空行。
   *
   * 同一个目录重复登记**直接返回既有那条**（幂等）：用户在弹窗里手滑点两下、
   * 或者两个端各加一次，都不该在侧栏里长出两行一模一样的。
   */
  async addNotesRoot(input: NotesRootInput): Promise<NotesRoot> {
    const raw = input.path.trim()
    if (!isAbsolute(raw)) throw new Error('笔记目录必须是绝对路径')
    const path = resolve(raw)
    const stat = await fs.stat(path).catch(() => null)
    if (!stat?.isDirectory()) throw new Error(`目录不存在或不是目录：${path}`)

    const existing = this.store.snapshot().notesRoots.find((r) => r.path === path)
    if (existing) return existing

    const root: NotesRoot = {
      id: newId(),
      path,
      // 默认展示名 = 目录名（与工作区同一条规则，用户可在侧栏看到它是哪个目录）
      name: input.name?.trim() || (path.split(/[\\/]/).filter(Boolean).pop() ?? path),
      createdAt: Date.now()
    }
    this.store.mutate((d) => {
      d.notesRoots = [...d.notesRoots, root]
    })
    return root
  }

  /**
   * 移除一个笔记根：**只摘登记，不碰磁盘**。
   *
   * 刻意与 `deleteWorkspace` 不同（那个会把会话 / 任务 / 插件偏好一并清掉）——
   * 笔记目录是用户自己的资料，我们只是「借来看」，移除登记绝不该让它少一个文件。
   * 返回是否真的删掉了（没这条记录时返回 false，调用方据此决定要不要报 404）。
   */
  deleteNotesRoot(id: string): boolean {
    if (!this.store.snapshot().notesRoots.some((r) => r.id === id)) return false
    this.store.mutate((d) => {
      d.notesRoots = d.notesRoots.filter((r) => r.id !== id)
    })
    return true
  }

  // ---------- 会话 ----------

  /**
   * 一条消息的可搜文本：只取 `text` 类的 part。
   *
   * 刻意**不搜 reasoning 与工具调用**：思考过程动辄上万字且对用户无意义，
   * 工具调用的参数是 JSON（搜「src/foo.ts」会命中一堆噪声）。
   * 只搜用户真正看到过的文字，搜出来的结果才符合直觉。
   */
  private messageText(message: AgentChatMessage): string {
    return message.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }

  /**
   * 截一段以命中点为中心的上下文。
   *
   * 命中点前后各留一点，否则用户搜一个词、只看到一个孤零零的词，没法判断是不是要找的那条。
   * 边界处补省略号，让「这里被截过」是可见的。
   */
  private makeSnippet(text: string, index: number, queryLength: number): string {
    const CONTEXT = 40
    const MAX = 160
    // 折叠空白：消息里常有换行与缩进，原样拼进单行片段会很难读
    const flat = text.replace(/\s+/g, ' ').trim()
    // ⚠️ 折叠后位置会变，所以不能直接用原 index；重新在扁平文本里找一次
    const flatIndex = flat.toLowerCase().indexOf(text.slice(index, index + queryLength).toLowerCase())
    const at = flatIndex >= 0 ? flatIndex : 0

    const start = Math.max(0, at - CONTEXT)
    const end = Math.min(flat.length, at + queryLength + CONTEXT)
    let snippet = flat.slice(start, end)
    if (end - start > MAX) snippet = `${snippet.slice(0, MAX)}…`
    return `${start > 0 ? '…' : ''}${snippet}${end < flat.length ? '…' : ''}`
  }

  listConversations(): ConversationSummary[] {
    return this.store
      .snapshot()
      .conversations.map(({ messages, ...rest }) => ({ ...rest, messageCount: messages.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 会话全集（**含完整消息体**）——桌面端引导加载时用。列表该不该带消息由调用端决定 */
  listConversationsFull(): AgentConversation[] {
    return [...this.store.snapshot().conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getConversation(id: string): AgentConversation | undefined {
    return this.store.snapshot().conversations.find((c) => c.id === id)
  }

  /**
   * 搜会话：标题 + 消息正文。
   *
   * ## 为什么需要
   *
   * 会话是这个产品最核心的资产。攒到几十条之后就只能靠滚动去找，等于没有历史。
   *
   * ## 语义
   *
   * - **不区分大小写**的子串匹配；关键词前后空白忽略（用户会随手打空格）。
   * - 标题命中的会话排前面；同一会话内按 `updatedAt` 新的靠前。
   * - 每个会话**最多出 1 条结果**（取该会话里最靠后、也就是最新的那条命中）——
   *   同一个会话刷出十条片段没有意义，用户要找的是「哪个会话」。
   *
   * 数据量级：会话都在内存里（JsonStore 一份全表），几百条会话 × 几千条消息
   * 仍是一次线性扫描，完全不需要倒排索引；真到扛不住的量级再上索引。
   */
  searchConversations(
    keyword: string,
    limit = 20
  ): ConversationSearchHit[] {
    const query = keyword.trim().toLowerCase()
    if (!query) return []

    const titleHits: ConversationSearchHit[] = []
    const messageHits: ConversationSearchHit[] = []

    for (const conversation of this.store.snapshot().conversations) {
      const titleMatched = conversation.title.toLowerCase().includes(query)
      if (titleMatched) {
        titleHits.push({
          conversationId: conversation.id,
          title: conversation.title,
          workspaceId: conversation.workspaceId,
          messageCount: conversation.messages.length,
          updatedAt: conversation.updatedAt,
          ...(conversation.archivedAt ? { archived: true } : {}),
          where: 'title'
        })
        // 标题已经命中就不再报正文结果（否则一个会话出两条）
        continue
      }

      /**
       * 从**后往前**找第一条命中的消息：消息数组按时间升序，末尾就是最新的，
       * 「最新命中的那条」最可能是用户此刻在找的。
       */
      for (let i = conversation.messages.length - 1; i >= 0; i--) {
        const message = conversation.messages[i]!
        const text = this.messageText(message)
        const index = text.toLowerCase().indexOf(query)
        if (index < 0) continue
        messageHits.push({
          conversationId: conversation.id,
          title: conversation.title,
          workspaceId: conversation.workspaceId,
          messageCount: conversation.messages.length,
          updatedAt: conversation.updatedAt,
          ...(conversation.archivedAt ? { archived: true } : {}),
          messageId: message.id,
          role: message.role,
          snippet: this.makeSnippet(text, index, query.length),
          where: 'message'
        })
        break
      }
    }

    const byRecency = (a: ConversationSearchHit, b: ConversationSearchHit): number =>
      b.updatedAt - a.updatedAt
    return [...titleHits.sort(byRecency), ...messageHits.sort(byRecency)].slice(0, limit)
  }

  // ---------- 用量汇总 ----------

  /**
   * 汇总全部会话的 token 用量（按天 + 按会话）。
   *
   * ## 数据源：逐条消息而不是 `conversation.totalUsage`
   *
   * 会话上已经有一个累计值（`totalUsage`，`appendMessages` 每轮累加一次），汇总本可以直接
   * 加它 —— 但那样**按天分不出来**：那个数只知道会话一共烧了多少，不知道是哪天烧的。
   * 消息上的 `usage` 带 `createdAt`，是唯一能按时间切分的粒度。
   *
   * 代价是要扫全部消息。数据量级：JsonStore 本来就把全部会话装在内存里（一次 snapshot），
   * 再多一遍线性遍历聊天的消息不改变量级。真到扛不住（几万条消息）再考虑落一份日聚合表。
   *
   * ## 为什么按「会话最后活跃日」而不是「每条消息各自的日子」
   *
   * 一个跨夜的长会话，用「最后活跃日」会把前几天的用量全记到最后一天。按消息逐日累加更
   * 准确，但一个会话会散在多行里、界面还得把它折叠回去。当前选前者：趋势图看的是
   * 「哪天最费」，跨夜会话的归并误差可接受；真要精确得再改成逐条累加。
   */
  aggregateUsage(days = 30, limit = 20): UsageSummary {
    const now = Date.now()
    const dayCount = Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 1), 365) : 30
    // 保留的会话条数：只给「最费的那几个」，够用户认出烧钱的大户就行
    const topCount = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 20

    // 按天分桶的下界：`days - 1` 天前的本地零点。再早的归入「更早」会被 dayCutoff 截掉
    const dayCutoff = new Date(now)
    dayCutoff.setHours(0, 0, 0, 0)
    dayCutoff.setDate(dayCutoff.getDate() - (dayCount - 1))

    /**
     * 把一份用量加进桶；可选字段逐个判存在。
     *
     * 入参用 `UsageBucket` 而不是 `TurnUsage`：汇总时要累加**两种东西** —— 单轮用量
     * （逐条消息加进去）与已聚合的桶（把整个会话并进它归属的那一天）。若声明成
     * `TurnUsage`，就得把桶硬转成 TurnUsage，那是假的（凭空编一个 durationMs 出来）。
     * 两者的字段交集就是 UsageBucket，用交集才是真话。
     */
    function accumulate(bucket: UsageBucket, usage: UsageBucket): void {
      bucket.inputTokens += usage.inputTokens
      bucket.outputTokens += usage.outputTokens
      bucket.totalTokens += usage.totalTokens
      if (usage.reasoningTokens !== undefined) {
        bucket.reasoningTokens = (bucket.reasoningTokens ?? 0) + usage.reasoningTokens
      }
      if (usage.cachedInputTokens !== undefined) {
        bucket.cachedInputTokens = (bucket.cachedInputTokens ?? 0) + usage.cachedInputTokens
      }
    }

    const total: UsageBucket = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    const dayBuckets = new Map<string, UsageByDay>()
    const conversations: UsageByConversation[] = []
    let conversationCount = 0

    for (const conversation of this.store.snapshot().conversations) {
      conversationCount += 1
      const bucket: UsageByConversation = {
        conversationId: conversation.id,
        title: conversation.title,
        workspaceId: conversation.workspaceId,
        updatedAt: conversation.updatedAt,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
      // 取这个会话**最后一次有 usage 的时间**作为归属日：一个会话只落一行，
      // 而不是每条消息各自落一行（理由见上方注释）
      let lastUsedAt = 0

      for (const message of conversation.messages) {
        const usage = message.usage
        // 只看助手消息：用户消息没有 usage，且把一轮的用量记在助手侧才与模型的口径一致
        if (!usage || message.role !== 'assistant') continue
        accumulate(bucket, usage)
        accumulate(total, usage)
        if (message.createdAt > lastUsedAt) lastUsedAt = message.createdAt
      }

      if (bucket.totalTokens <= 0) continue
      conversations.push(bucket)

      if (lastUsedAt < dayCutoff.getTime()) continue
      // 本地日期（不是 toISOString —— 那是 UTC，会把晚上跑的活算到第二天）
      const day = new Date(lastUsedAt)
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      let dayBucket = dayBuckets.get(key)
      if (!dayBucket) {
        dayBucket = { day: key, inputTokens: 0, outputTokens: 0, totalTokens: 0, conversations: 0 }
        dayBuckets.set(key, dayBucket)
      }
      accumulate(dayBucket, bucket)
      dayBucket.conversations += 1
    }

    // 补上 days 范围内的空缺天：趋势图上「那天 0」是一条真实信息（没跑就没烧），
    // 漏掉会让曲线骗人。没有 usage 的天补零即可。
    const byDay: UsageByDay[] = []
    for (let i = 0; i < dayCount; i++) {
      const cursor = new Date(dayCutoff)
      cursor.setDate(cursor.getDate() + i)
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
      byDay.push(
        dayBuckets.get(key) ?? {
          day: key,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          conversations: 0
        }
      )
    }

    return {
      total,
      byDay,
      byConversation: conversations.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, topCount),
      conversationCount
    }
  }

  saveConversation(input: ConversationInput): AgentConversation {
    const data = this.store.snapshot()
    const prev = input.id ? data.conversations.find((c) => c.id === input.id) : undefined
    // 带显式 id 的「首次保存」也算数（桌面端桥接渲染端为真值时，会把客户端生成
    // 的会话 id 原样带过来），因此 id 存在但未登记 → 视为新建而非报错。
    /**
     * 工作区校验：**每条会话都必须绑一个登记过的工作区**。
     *
     * 「不选项目」不是一种归属 —— 那只是输入框上的临时状态，发送时服务端会先建一个
     * 临时工作区（`ensureScratchWorkspace`，目录在数据目录的 `conversations/<会话 id>`）
     * 再建会话。所以这里不需要放行任何哨兵值：走到这儿还没有工作区就是调用方漏了那一步。
     */
    const knownWorkspace = Boolean(this.getWorkspace(input.workspaceId))
    if (input.id && !prev) {
      if (!input.workspaceId || !knownWorkspace) {
        throw new Error('工作区不存在，请先创建工作区')
      }
    } else if (!knownWorkspace && !prev) {
      throw new Error('工作区不存在，请先创建工作区')
    }

    const now = Date.now()
    // acp 会话的消息保存在 agent 侧、本地恒为空：整体覆盖消息对它无意义，直接忽略
    const isAcp = (input.backend ?? prev?.backend) === 'acp'
    /**
     * 查重兜底：同一个 ACP agent 的同一个会话只能绑到**一个**本地会话上。
     * 走到导入弹窗的查重之外还拦一道（别的客户端 / 并发导入），错误信息给人话。
     * 正常聊天流程绑的是 `session/new` 刚生成的 id，天然唯一，不受影响。
     */
    if (input.acpSessionId && !prev) {
      const dup = data.conversations.find(
        (c) =>
          c.backend === 'acp' &&
          c.configId === input.configId &&
          c.acpSessionId === input.acpSessionId
      )
      if (dup) {
        throw new Error('该 ACP 会话已导入过：同一个 agent 会话只能绑定一个本地会话')
      }
    }
    const kind: 'chat' | 'collab' = input.kind ?? prev?.kind ?? 'chat'
    // 思考强度按会话存：不传 = 沿用已有（改选请走 setConversationTarget）
    const nextReasoningEffort =
      input.reasoningEffort !== undefined
        ? normalizeReasoningEffort(input.reasoningEffort)
        : prev?.reasoningEffort
    const conversation: AgentConversation = {
      id: input.id ?? prev?.id ?? newId(),
      workspaceId: input.workspaceId,
      title: input.title?.trim() || prev?.title || '新会话',
      ...(kind === 'collab'
        ? {
            kind: 'collab' as const,
            collab: normalizeCollabSettings(input.collab ?? prev?.collab)
          }
        : {}),
      // 显式给 messages 就整体覆盖（桌面端保存本地真值用）；否则沿用已有
      messages: isAcp ? [] : Array.isArray(input.messages) ? input.messages : (prev?.messages ?? []),
      backend: input.backend ?? prev?.backend,
      configId: input.configId ?? prev?.configId,
      modelId: input.modelId ?? prev?.modelId,
      ...(nextReasoningEffort ? { reasoningEffort: nextReasoningEffort } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      // MCP 选择按会话存：不传 = 沿用已有（改选请走 setConversationTarget）
      ...((input.mcpServerIds ?? prev?.mcpServerIds)
        ? { mcpServerIds: input.mcpServerIds ?? prev?.mcpServerIds }
        : {}),
      // 浏览器偏好按会话存：不传 = 沿用已有（改选请走 setConversationTarget）
      ...((input.browserSettings ?? prev?.browserSettings)
        ? {
            browserSettings: normalizeBrowserSettings(
              input.browserSettings ?? prev?.browserSettings
            )
          }
        : {}),
      /**
       * 压缩相关状态必须原样带走：这个对象是**从头构造**的（不 spread `prev`），
       * 漏掉就会在「改标题 / 换模型 / 桌面端覆盖消息」时把摘要检查点弄丢。
       * `upToMessageId` / `keepFromMessageId` 指向的消息被覆盖掉了也没关系 ——
       * `historyForTurn` 与 `compactHistory` 找不到时分别按时间 / 重摘要兜底。
       */
      ...(prev?.contextSummary ? { contextSummary: prev.contextSummary } : {}),
      ...(prev?.autoSummary ? { autoSummary: prev.autoSummary } : {}),
      // 「还没被用户看过」的红点标记：不传 = 沿用（见 ConversationInput.unseen）
      ...((input.unseen ?? prev?.unseen) ? { unseen: true } : {}),
      // ACP 运行态：创建时由服务端 session/new 的产物带进来；不传 = 沿用已有
      ...(isAcp
        ? {
            acpSessionId: input.acpSessionId ?? prev?.acpSessionId,
            ...((input.acpModes ?? prev?.acpModes)
              ? { acpModes: input.acpModes ?? prev?.acpModes }
              : {}),
            ...((input.acpThoughtLevel ?? prev?.acpThoughtLevel)
              ? { acpThoughtLevel: input.acpThoughtLevel ?? prev?.acpThoughtLevel }
              : {}),
            ...((input.acpPermissionMode ?? prev?.acpPermissionMode)
              ? { acpPermissionMode: input.acpPermissionMode ?? prev?.acpPermissionMode }
              : {})
          }
        : {})
    }
    return this.commitConversation(conversation)
  }

  /** 覆盖协作配置（全量；增删改 Agent / 并行与单轮上限都走这里） */
  setConversationCollab(id: string, collab: CollabSettings): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    if (existing.kind !== 'collab') throw new Error('这不是多智能体协作会话')
    return this.commitConversation({
      ...existing,
      collab: normalizeCollabSettings(collab),
      updatedAt: Date.now()
    })
  }

  /** 读协作运行态（服务端 `store.readCollabState` 的领域封装） */
  async getCollabState(id: string): Promise<CollabState | null> {
    const existing = this.getConversation(id)
    if (!existing || existing.kind !== 'collab') return null
    return this.store.readCollabState(id)
  }

  /** 写协作运行态（任务 / 消息 / 最近状态；fire-and-forget 串行写盘） */
  saveCollabState(id: string, state: CollabState): void {
    const existing = this.getConversation(id)
    if (!existing || existing.kind !== 'collab') return
    this.store.writeCollabState(id, normalizeCollabState(state))
  }

  /**
   * 追加消息并落盘（服务端每一轮结束时调用一次，别每个 token 都写）。
   *
   * usage 是本轮助手消息的 token 数（模型返回的 finish 事件带）。传进来就累加到
   * 会话级 totalUsage 上随消息一起落盘 -- 下次拉历史 / 侧栏刷新直接能读到，
   * 不用再从消息体里重新逐条加（也免得漏掉工具调用失败那类没有 finish 事件的轮次）。
   * 不传 = 本轮没拿到用量（比如 ACP 会话、或上游根本没返回），不改动累计值。
   */
  appendMessages(
    id: string,
    messages: AgentChatMessage[],
    title?: string,
    usage?: TurnUsage
  ): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    const totalUsage = addUsage(existing.totalUsage, usage)
    const next: AgentConversation = {
      ...existing,
      title: title ?? existing.title,
      messages: [...existing.messages, ...messages],
      ...(totalUsage ? { totalUsage } : {}),
      updatedAt: Date.now()
    }
    return this.commitConversation(next)
  }

  /** 删会话：内存索引与磁盘上的会话目录一起删 */
  deleteConversation(id: string): void {
    const existing = this.getConversation(id)
    this.store.mutate((d) => {
      d.conversations = d.conversations.filter((c) => c.id !== id)
    })
    if (existing) this.store.deleteConversationFiles(existing)
  }

  /** 重命名会话（web / 桌面 Agent 文件树里改标题用） */
  renameConversation(id: string, title: string): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    const clean = title.trim()
    if (!clean) throw new Error('标题不能为空')
    const next: AgentConversation = { ...existing, title: clean, updatedAt: Date.now() }
    return this.commitConversation(next)
  }

  /**
   * 会话分叉（「从此签出」）：以 `upToMessageId`（**含该条**）为终点复制出一个新会话，
   * 原会话一字不动 —— 之后两边各自独立，类似 `git checkout -b`。
   *
   * - 复制 workspaceId / backend / configId / modelId / mcpServerIds / totalUsage；
   * - 新 id、标题 = `原标题（分支）`；**不复制** queuedMessages（新分支从空队列开始）；
   * - `contextSummary`（压缩检查点）仅当它指向的消息落在截取范围内才保留 ——
   *   检查点指向的历史被截掉的话，摘要就名不副实（下一轮会拿它当上下文，把已不存在的
   *   轮次喂给模型）；
   * - 记 `forkedFrom` 元数据，侧栏据此显示「分支自 xxx」。
   *
   * ACP 会话不支持（历史在外部 agent 进程里，协议上克隆不了上下文）；运行中的会话
   * 由路由层拦（domain 不持有 run 注册表）。
   */
  forkConversation(
    id: string,
    upToMessageId: string,
    /** 分叉出的新会话所在工作区；缺省 = 原会话的工作区（「签出 + 新建 worktree」时传 worktree 项目的 id） */
    targetWorkspaceId?: string
  ): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    if (existing.backend === 'acp') {
      throw new Error('ACP 会话不支持签出（上下文在外部 agent 进程里）')
    }
    const workspaceId = targetWorkspaceId ?? existing.workspaceId
    if (!this.getWorkspace(workspaceId)) throw new Error('工作区不存在')
    const cut = existing.messages.findIndex((m) => m.id === upToMessageId)
    if (cut < 0) throw new Error('消息不存在')
    const now = Date.now()
    const checkpoint = existing.contextSummary
    const keepSummary =
      checkpoint &&
      existing.messages
        .slice(0, cut + 1)
        .some((m) => m.id === checkpoint.upToMessageId)
        ? checkpoint
        : undefined
    // 先按普通创建落盘（messages 整体传入），再把分叉专属的字段补上 —— 组合两个
    // 既有原语，不给 ConversationInput 契约加分叉专用字段
    const created = this.saveConversation({
      workspaceId,
      title: `${existing.title}（分支）`,
      backend: existing.backend,
      configId: existing.configId,
      modelId: existing.modelId,
      messages: existing.messages.slice(0, cut + 1),
      // 思考强度跟着分叉走：分支是「接着这个方向干」，不是一个全新的会话
      reasoningEffort: existing.reasoningEffort,
      mcpServerIds: existing.mcpServerIds,
      // 浏览器偏好跟着分叉走：分支多半是「换个方向接着干」，浏览器配置照旧
      browserSettings: existing.browserSettings
    })
    return this.commitConversation({
      ...created,
      ...(keepSummary ? { contextSummary: keepSummary } : {}),
      ...(existing.totalUsage ? { totalUsage: existing.totalUsage } : {}),
      forkedFrom: { conversationId: id, upToMessageId, createdAt: now }
    })
  }

  /**
   * 归档 / 取消归档会话。
   *
   * 归档**不是删除**：只写一个 `archivedAt` 时间戳，会话与消息一字不动，随时能取回。
   * 侧栏据此把它从项目树收进「已归档」区（见 Sidebar），而搜索仍然搜得到。
   *
   * 刻意**不动 `updatedAt`**：归档是「收纳」动作，不是一次对话；动了会让
   * 取消归档的会话突然掉到列表很下面（列表按 `updatedAt` 倒序），像是很久没被用过。
   */
  setConversationArchived(id: string, archived: boolean): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    if (!!existing.archivedAt === archived) return existing
    const next: AgentConversation = {
      ...existing,
      // `undefined` 会在 JSON 落盘时被丢弃 = 清除（与 contextSummary 同一手法）
      archivedAt: archived ? Date.now() : undefined
    }
    return this.commitConversation(next)
  }

  /**
   * 把会话标记成「用户已经看过了」：清掉 `unseen`（定时任务触发的红点）。
   *
   * 幂等且**不动 `updatedAt`**：点开一个会话会让列表按最近更新重排的话，用户只是
   * 「看一眼就跑完的任务」，那个会话就莫名跳到项目最上面。已经清过就直接返回，不写盘。
   */
  markConversationSeen(id: string): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    if (!existing.unseen) return existing
    // 解构丢弃 `unseen`（`undefined` 落盘时字段消失 = 清除，与其他可选字段同一手法）
    const { unseen: _cleared, ...rest } = existing
    return this.commitConversation(rest)
  }

  /**
   * 设置上下文摘要检查点（**手动压缩**的落库口，见 `ConversationContextSummary`）。
   * 只改这一个字段，消息原封不动 —— 压缩只发生在「组装发往模型的历史」那一步。
   *
   * 手动压缩生效时顺手清掉 `autoSummary`：历史已经被检查点切过一遍，再叠一层自动摘要
   * 既是冗余，两套锚点也会打架（自动摘要的起点可能落在被切掉的那段里）。
   */
  setContextSummary(id: string, summary: ConversationContextSummary): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    const next: AgentConversation = {
      ...existing,
      contextSummary: summary,
      // 手动压缩已经把持久化历史切好，旧的自动固化点作废（避免两层摘要叠加）
      autoSummary: undefined,
      updatedAt: Date.now()
    }
    return this.commitConversation(next)
  }

  /**
   * 设置 / 清除**自动压缩**的固化点（见 `ConversationAutoSummary`）。
   *
   * 与 `setContextSummary` 的两点不同：
   * 1. **不动 `updatedAt`** —— 自动压缩不是一次对话，改了会让会话在侧栏跳到顶部；
   * 2. 幂等：内容没变就不写盘（`runAgent` 的 retry 会重复回调，别每次都刷会话文件）。
   */
  setAutoSummary(id: string, entry: ConversationAutoSummary | null): void {
    const existing = this.getConversation(id)
    if (!existing) return
    const prev = existing.autoSummary
    if (!entry && !prev) return
    if (
      entry &&
      prev &&
      prev.keepFromMessageId === entry.keepFromMessageId &&
      prev.text === entry.text
    ) {
      return
    }
    this.commitConversation({ ...existing, autoSummary: entry ?? undefined })
  }

  /**
   * 设置 / 清除会话记住的目标（模型 + 允许使用的 MCP server）。
   * 标量字段显式传 `null` = 清除（回到「默认」）；`undefined` = 不动该项。
   *
   * `mcpServerIds` 是**全量覆盖**语义（传 `[]` = 一个都不用），并做两件事：
   * - 去重 + 剔除空串，避免前端重复点选把清单写脏；
   * - 剔除**已不存在的** server id（设置里被删掉的）：留着也不会被接上，纯垃圾数据。
   *
   * ⚠️ acp 会话的 `configId`（= agent）在创建时就锁定了：这里拒绝换 agent，
   * 只允许换 `modelId`（agent 自己广告的模型，经 session/set_config_option 下发）。
   */
  setConversationTarget(
    id: string,
    target: {
      backend?: AgentConversation['backend'] | null
      configId?: string | null
      modelId?: string | null
      reasoningEffort?: AgentConversation['reasoningEffort'] | null
      mcpServerIds?: string[] | null
      acpPermissionMode?: AcpPermissionMode | null
      /** 浏览器偏好（整体对象语义）：`undefined` = 不动；`null` = 清除（回落全局默认） */
      browserSettings?: BrowserSettings | null
    }
  ): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    if (
      existing.backend === 'acp' &&
      target.configId !== undefined &&
      target.configId !== null &&
      target.configId !== existing.configId
    ) {
      throw new Error('ACP 会话已绑定 agent，不支持切换；要换 agent 请新建会话')
    }
    // 只保留真实存在的 MCP server（顺带去重 / 去空）。三态与其它字段一致：
    // `undefined` = 不动；`null` = 清除（等价于 `[]`）；数组 = 全量覆盖。
    const knownMcpIds = new Set(this.listMcpServers().map((s) => s.id))
    const nextMcpServerIds =
      target.mcpServerIds === undefined
        ? existing.mcpServerIds
        : [
            ...new Set(
              (target.mcpServerIds ?? []).filter((x) => x && knownMcpIds.has(x))
            )
          ]
    const next: AgentConversation = {
      ...existing,
      backend: target.backend === undefined ? existing.backend : (target.backend ?? undefined),
      configId: target.configId === undefined ? existing.configId : (target.configId ?? undefined),
      modelId: target.modelId === undefined ? existing.modelId : (target.modelId ?? undefined),
      // 思考强度：`undefined` = 不动；`null` = 清除（跟随模型默认）。非法值一律当清除。
      ...(target.reasoningEffort !== undefined
        ? { reasoningEffort: normalizeReasoningEffort(target.reasoningEffort) }
        : {}),
      ...(nextMcpServerIds ? { mcpServerIds: nextMcpServerIds } : {}),
      // ACP 权限答复策略：`undefined` = 不动；`null` = 回到缺省（confirm，就不写字段）。
      // 只在 `allow` 时落库，免得每条会话配置都多一行没意义的 "confirm"。
      ...(target.acpPermissionMode !== undefined
        ? { acpPermissionMode: target.acpPermissionMode === 'allow' ? 'allow' : undefined }
        : {}),
      // 浏览器偏好：`undefined` = 不动；`null` = 清除（回落全局默认）；对象 = 整体覆盖。
      // 落盘前归一化，挡掉 HTTP 传进来的非法 channel。
      ...(target.browserSettings !== undefined
        ? {
            browserSettings: target.browserSettings
              ? normalizeBrowserSettings(target.browserSettings)
              : undefined
          }
        : {}),
      updatedAt: Date.now()
    }
    return this.commitConversation(next)
  }

  /**
   * 覆盖写入 acp 会话的**运行态快照**（Session Modes / 思考档）。
   *
   * 只对 `backend === 'acp'` 的会话生效；非 acp 静默返回原会话。两个字段都是**部分覆盖**：
   * 只更新传进来的那一个（`undefined` = 不动）。
   *
   * ⚠️ `acpModes.current` / `acpThoughtLevel.current` 记的是**用户意图**，不是 agent 的
   * 运行时状态 —— 刷新 agent 广告的清单时必须按「保留用户意图」合并
   * （见 `lib/server/acp-session-state.ts`），别把 agent 的默认档当成用户选的档写进来。
   */
  setAcpSessionState(
    id: string,
    patch: { acpModes?: AcpModesState; acpThoughtLevel?: AcpThoughtLevelState }
  ): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    if (existing.backend !== 'acp') return existing
    const next: AgentConversation = {
      ...existing,
      ...(patch.acpModes !== undefined ? { acpModes: patch.acpModes } : {}),
      ...(patch.acpThoughtLevel !== undefined ? { acpThoughtLevel: patch.acpThoughtLevel } : {}),
      updatedAt: Date.now()
    }
    return this.commitConversation(next)
  }

  /**
   * 记住 ACP agent 上报的**上下文占用**（`usage_update`）。
   *
   * 只对 `backend === 'acp'` 生效。**值没变就直接返回**（不写盘、不标脏）—— 这个事件在轮中
   * 可能反复到达，多数时候值是一样的。刻意**不动 `updatedAt`**：它是 agent 侧遥测，不是用户
   * 活动，不该让会话在侧栏里来回跳位。
   */
  setAcpContextUsage(id: string, usage: AcpContextUsage): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    if (existing.backend !== 'acp') return existing
    const prev = existing.acpContextUsage
    if (prev && prev.used === usage.used && prev.size === usage.size) return existing
    return this.commitConversation({ ...existing, acpContextUsage: usage })
  }

  /**
   * 把 agent 侧的 session id 绑到 acp 会话上（`session/new` 成功后由聊天路由回填；
   * 导入既有会话时创建时就带着）。只对 acp 会话有意义，其它后端静默忽略。
   */
  bindAcpSession(id: string, acpSessionId: string): void {
    const existing = this.getConversation(id)
    if (!existing || existing.backend !== 'acp') return
    if (existing.acpSessionId === acpSessionId) return
    this.commitConversation({ ...existing, acpSessionId, updatedAt: Date.now() })
  }

  /**
   * 覆盖待发送队列（**全量覆盖**；拖拽排序后前端把整个新清单发来）。
   *
   * 数组顺序就是发送顺序 —— 泵（前端）只按顺序取，服务端不参与调度，只管存。
   * 空数组 = 清空（字段写回 undefined，不留空数组）。
   */
  setConversationQueue(id: string, items: QueuedMessage[]): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    const nextQueue = sanitizeQueue(items)
    const next: AgentConversation = {
      ...existing,
      ...(nextQueue.length ? { queuedMessages: nextQueue } : { queuedMessages: undefined }),
      updatedAt: Date.now()
    }
    return this.commitConversation(next)
  }

  /** 读待发送队列（缺字段 / 脏数据一律归一成空数组） */
  getConversationQueue(id: string): QueuedMessage[] {
    const existing = this.getConversation(id)
    return existing ? sanitizeQueue(existing.queuedMessages) : []
  }

  /** 清空会话（保留会话本身，删掉全部消息；保留标题与后端配置） */
  clearConversation(id: string): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    // acp 会话的消息在 agent 侧：本地没有可清的东西，「清空」= 语义不成立
    if (existing.backend === 'acp') {
      throw new Error('ACP 会话的消息保存在 agent 侧，本地不支持清空；要重新开始请新建会话')
    }
    const next: AgentConversation = {
      ...existing,
      messages: [],
      totalUsage: undefined,
      // 清空 = 从零开始：两个摘要锚点指向的正是刚被删掉的那批消息，留着会让下一轮
      // 把旧摘要（甚至整段被删的上下文）当成「这个会话的前情」喂给模型
      contextSummary: undefined,
      autoSummary: undefined,
      updatedAt: Date.now()
    }
    return this.commitConversation(next)
  }

  /**
   * 删除会话里的单条消息（web / 桌面端 MessageDeleteButton 的后台实现）。
   *
   * ⚠️ **硬删除，没有回收站**：`messages` 裁掉之后 `commitConversation` 整份重写
   * `conversation.json`（`writeJsonAtomic` = 写 `.tmp` 再 rename），旧内容当场没了 ——
   * 没有 `deletedAt` / tombstone / `.bak`，撤销不了。三条删除路径（本条、`deleteMessagesFrom`
   * 的截断、`clearConversation` 的清空）都是这个口径。
   *
   * 要加「可撤销」得先选形态：破坏性操作前落整份快照（读路径零改动，回滚 = 回到操作前）、
   * 还是给消息加 `deletedAt` 标记（真·逐条软删，但渲染 / 搜索 / 导出 / token 估算 / 压缩 /
   * fork / collab 所有读 `messages` 的地方都要认这个字段，漏一处就是已删消息回流进上下文）。
   * 别在没定形态前零散加半个标记。
   */
  deleteMessage(id: string, messageId: string): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    // acp 会话的消息在 agent 侧，本地没有可删的对象
    if (existing.backend === 'acp') {
      throw new Error('ACP 会话的消息保存在 agent 侧，本地不支持删除单条消息')
    }
    if (!existing.messages.some((m) => m.id === messageId)) throw new Error('消息不存在')
    const kept = existing.messages.filter((m) => m.id !== messageId)
    const next: AgentConversation = {
      ...existing,
      messages: kept,
      // 删掉的正好是摘要锚点：那份摘要描述的是已不存在的历史，一并丢掉（见 liveContextSummary）
      contextSummary: liveContextSummary(existing.contextSummary, kept),
      updatedAt: Date.now()
    }
    return this.commitConversation(next)
  }

  /**
   * 删掉某条消息**及其之后**的全部消息（「从这里重新开始」/ 编辑重发）。
   *
   * ⚠️ 必须可以**一次删完**：客户端早先是逐条 `deleteMessage` 循环，N 条消息 = N 次往返
   * + N 次整份会话落盘，长历史下要好几秒，而界面上没有任何进度（用户报过「很慢、
   * 还能继续点别的消息」）。这里一次裁剪 + 一次 commit。
   */
  deleteMessagesFrom(id: string, messageId: string): AgentConversation {
    const existing = this.getConversation(id)
    if (!existing) throw new Error('会话不存在')
    if (existing.backend === 'acp') {
      throw new Error('ACP 会话的消息保存在 agent 侧，本地不支持删除单条消息')
    }
    const index = existing.messages.findIndex((m) => m.id === messageId)
    if (index < 0) throw new Error('消息不存在')
    // 编辑重发 / 「从这里重新开始」：锚点很可能就落在被截掉的那一段里
    const kept = existing.messages.slice(0, index)
    const next: AgentConversation = {
      ...existing,
      messages: kept,
      contextSummary: liveContextSummary(existing.contextSummary, kept),
      updatedAt: Date.now()
    }
    return this.commitConversation(next)
  }

  // ---------- ACP agent（外部 agent 进程） ----------

  listAcpAgents(): AcpAgentView[] {
    return this.store.snapshot().acpAgents.map((agent) => toAcpView(agent))
  }

  /**
   * 解析要用的 ACP agent：必须是**显式选择**的（会话绑定 / 请求带上）。
   * 悬空 id（agent 被删了）直接报错 —— 不再静默回退第一个，那会掩盖「选的已经没了」。
   */
  resolveAcpAgent(id: string): AcpAgentConfig {
    const agent = this.store.snapshot().acpAgents.find((a) => a.id === id)
    if (!agent) throw new Error('所选 ACP agent 不存在或已被删除，请重新选择')
    return agent
  }

  saveAcpAgent(input: AcpAgentInput): AcpAgentView {
    const name = input.name?.trim()
    if (!name) throw new Error('缺少 ACP agent 名称')
    if (!input.command?.trim()) throw new Error('缺少启动命令')
    // 更新时按 id 找回旧的：`models`（会话下拉里暴露哪几个模型）不传就沿用，
    // 免得「只改一下命令」把用户在设置里挑好的模型清单抹掉
    const existing = input.id
      ? this.store.snapshot().acpAgents.find((a) => a.id === input.id)
      : undefined
    const models = input.models ?? existing?.models
    // 风格（opencode / pi / generic）：不传沿用旧值，免得「只改命令」把它清掉
    const type = input.type ?? existing?.type
    // 「完全放行」的答复策略：同上，不传沿用旧值
    const allowStrategy = input.allowStrategy ?? existing?.allowStrategy
    const command = input.command.trim()
    const args = input.args ?? existing?.args ?? []
    // 同一个 agent 只留一条：命令 + 参数完全相同就算同一条（名称不参与判重）。
    // **只在新建时判** —— 带 id 的保存一律放行：否则历史数据里已经躺着重复条目时，
    // 连「挑模型」这种带 id 的保存都会被另一条挡下来，等于把人锁死。
    if (!input.id) {
      const dup = this.store
        .snapshot()
        .acpAgents.find((a) => acpAgentKey(a) === acpAgentKey({ command, args }))
      if (dup) throw new Error(`已经添加过同样的 ACP agent（${dup.name}），不用再加一遍`)
    }
    const agent: AcpAgentConfig = {
      id: input.id ?? newId(),
      name,
      command,
      args,
      ...(type ? { type } : {}),
      ...(allowStrategy ? { allowStrategy } : {}),
      ...(models ? { models } : {})
    }
    this.store.mutate((d) => {
      const exists = d.acpAgents.some((a) => a.id === agent.id)
      d.acpAgents = exists
        ? d.acpAgents.map((a) => (a.id === agent.id ? agent : a))
        : [...d.acpAgents, agent]
    })
    return toAcpView(agent)
  }

  deleteAcpAgent(id: string): AcpAgentView[] {
    this.store.mutate((d) => {
      d.acpAgents = d.acpAgents.filter((a) => a.id !== id)
    })
    return this.listAcpAgents()
  }

  // ---------- MCP server 配置 ----------

  listMcpServers(): McpServerConfig[] {
    return this.store.snapshot().mcpServers
  }

  saveMcpServer(input: McpServerInput): McpServerConfig {
    const data = this.store.snapshot()
    const prev = input.id ? data.mcpServers.find((s) => s.id === input.id) : undefined
    if (input.id && !prev) throw new Error('MCP server 不存在')
    if (!input.name?.trim()) throw new Error('缺少 MCP server 名称')

    // 传输方式决定「哪组字段才算填全」：stdio 看命令，http/sse 看地址。
    // 不清空另一组 —— 用户切回上一种方式时原来的命令 / 地址还在，存量配置也不会丢字段。
    const transport = normalizeMcpTransport(input.transport)
    if (transport === 'stdio') {
      if (!input.command?.trim()) throw new Error('缺少启动命令')
    } else if (!input.url?.trim()) {
      throw new Error('缺少服务地址')
    }

    const server: McpServerConfig = {
      id: prev?.id ?? newId(),
      name: input.name.trim(),
      transport,
      ...(input.command ? { command: input.command.trim() } : {}),
      args: input.args ?? [],
      ...(input.env ? { env: input.env } : {}),
      ...(input.url ? { url: input.url.trim() } : {}),
      ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {})
    }
    this.store.mutate((d) => {
      d.mcpServers = prev
        ? d.mcpServers.map((s) => (s.id === server.id ? server : s))
        : [...d.mcpServers, server]
    })
    return server
  }

  deleteMcpServer(id: string): McpServerConfig[] {
    this.store.mutate((d) => {
      d.mcpServers = d.mcpServers.filter((s) => s.id !== id)
    })
    return this.listMcpServers()
  }

  // ---------- 主机清单（SSH 主机 + 本机终端） ----------

  /** 列出全部主机条目（SSH 脱敏：只有 `has*` 标记，不含明文 / 密文凭据；本机终端无凭据） */
  listSshHosts(): HostConfig[] {
    return this.store.snapshot().sshHosts.map((h) => toHostView(h))
  }

  /**
   * 建连用：解出**明文**凭据（只在本进程内用，绝不出网）。
   *
   * 跳板链不在这里递归 —— 调用方（服务端 SSH 连接器）按 `jumpHostId` 自己逐级
   * `resolveSshHost`，这样「哪一级连不上」的错误能带上具体是哪一跳。
   *
   * ⚠️ 本机终端条目（`kind: 'local'`）不是 SSH 主机，调用方不该拿它来建连 —— 直接报错。
   */
  resolveSshHost(id: string): ResolvedSshHost {
    const host = this.store.snapshot().sshHosts.find((h) => h.id === id)
    if (!host) throw new Error('SSH 主机不存在或已被删除')
    if (isStoredLocal(host)) throw new Error('这是一条本机终端配置，不是 SSH 主机')
    return {
      id: host.id,
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      authType: host.authType ?? 'password',
      password: this.store.decryptSecret(host.password),
      privateKey: this.store.decryptSecret(host.privateKey),
      passphrase: this.store.decryptSecret(host.passphrase),
      jumpHostId: host.jumpHostId,
      charset: host.charset ?? 'utf-8',
      keepaliveInterval: normalizeKeepalive(host.keepaliveInterval)
    }
  }

  /**
   * 新建 / 更新一条主机清单条目（带 `id` 即更新）。返回脱敏视图。
   *
   * 按 `kind` 分派：`local` 走本机终端（无凭据），其余走 SSH 主机（凭据独立保存）。
   */
  saveSshHost(input: HostInput): HostConfig {
    return input.kind === 'local' ? this.saveLocalHost(input) : this.saveSshHostEntry(input)
  }

  /**
   * 新建 / 更新一台 SSH 主机（带 `id` 即更新）。返回脱敏视图。
   *
   * 凭据（password / privateKey / passphrase）三套各自独立保存 —— 切换 authType 时
   * 旧的留着，切回来不用重填；写入语义见 `sealOrKeep`。
   */
  private saveSshHostEntry(input: SshHostInput): SshHostConfig {
    const now = Date.now()
    const data = this.store.snapshot()
    const found = input.id ? data.sshHosts.find((h) => h.id === input.id) : undefined
    if (input.id && !found) throw new Error('SSH 主机不存在或已被删除')
    if (found && isStoredLocal(found)) throw new Error('该 id 指向一条本机终端配置')
    const prev: StoredSshHost | undefined = found as StoredSshHost | undefined

    const host = input.host?.trim()
    const username = input.username?.trim()
    if (!host) throw new Error('缺少主机地址')
    if (!username) throw new Error('缺少登录用户名')

    const id = prev?.id ?? newId()
    const port = normalizeSshPort(input.port ?? prev?.port)
    const authType: SshAuthType = input.authType ?? prev?.authType ?? 'password'
    const charset: SshCharset = input.charset ?? prev?.charset ?? 'utf-8'
    const keepaliveInterval = normalizeKeepalive(input.keepaliveInterval ?? prev?.keepaliveInterval)
    // 归属分组：不传 = 保留原归属（改端口 / 换密码不该把主机从分组里踢出去）
    const groupId = normalizeHostGroupId(input.groupId ?? prev?.groupId, data.hostGroups)

    // 跳板：必须存在（且是 SSH 主机，本机终端不能当跳板）、不能指自己、不能成环
    const jumpHostId = input.jumpHostId?.trim() || undefined
    if (jumpHostId) {
      if (jumpHostId === id) throw new Error('跳板机不能指向自己')
      const jump = data.sshHosts.find((h) => h.id === jumpHostId)
      if (!jump || isStoredLocal(jump)) throw new Error('所选的跳板机不存在')
      assertNoJumpCycle(data.sshHosts, id, jumpHostId)
    }

    // 凭据密文：undefined = 保留原值，'' = 清空，其余 = 加密覆盖（见 sealOrKeep）
    const password = sealOrKeep(this.store, input.password, prev?.password)
    const privateKey = sealOrKeep(this.store, input.privateKey, prev?.privateKey)
    const passphrase = sealOrKeep(this.store, input.passphrase, prev?.passphrase)

    const next: StoredSshHost = {
      id,
      // 名字：用户填的 > 原来的名字 > `user@host:port` 兜底
      name: (input.name ?? '').trim() || prev?.name || `${username}@${host}:${port}`,
      host,
      port,
      username,
      authType,
      ...(password ? { password } : {}),
      ...(privateKey ? { privateKey } : {}),
      ...(passphrase ? { passphrase } : {}),
      ...(jumpHostId ? { jumpHostId } : {}),
      charset,
      keepaliveInterval,
      ...(groupId ? { groupId } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    this.store.mutate((d) => {
      d.sshHosts = prev ? d.sshHosts.map((h) => (h.id === next.id ? next : h)) : [...d.sshHosts, next]
    })
    return toSshView(next)
  }

  /** 新建 / 更新一条本机终端配置（带 `id` 即更新）。返回视图。 */
  private saveLocalHost(input: LocalHostInput): LocalHostConfig {
    const now = Date.now()
    const data = this.store.snapshot()
    const found = input.id ? data.sshHosts.find((h) => h.id === input.id) : undefined
    if (input.id && !found) throw new Error('主机条目不存在或已被删除')
    if (found && !isStoredLocal(found)) throw new Error('该 id 指向一台 SSH 主机')
    const prev: StoredLocalHost | undefined = found as StoredLocalHost | undefined

    const name = (input.name ?? '').trim() || prev?.name
    if (!name) throw new Error('缺少名称')

    const id = prev?.id ?? newId()
    const shellName = (input.shellName ?? '').trim() || undefined
    const args = Array.isArray(input.args)
      ? input.args.map((a) => a).filter((a) => a.length > 0)
      : prev?.args
    /**
     * 打开时的工作目录：**空串 = 清掉（回落主目录）**。
     *
     * 与 `args` 同一条取舍：显式传空串就是「我要清掉原来的值」。不传（undefined）=
     * 保留原值，那是别的调用方（如只改名字）的语义。
     */
    const cwd = input.cwd === undefined ? prev?.cwd : input.cwd.trim() || undefined
    const autoCommand = input.autoCommand?.trim() || undefined
    // 归属分组：语义同 saveSshHostEntry —— 不传 = 保留原归属
    const groupId = normalizeHostGroupId(input.groupId ?? prev?.groupId, data.hostGroups)

    const next: StoredLocalHost = {
      id,
      kind: 'local',
      name,
      ...(input.shellId?.trim() ? { shellId: input.shellId.trim() } : {}),
      ...(shellName ? { shellName } : {}),
      ...(args && args.length ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(autoCommand ? { autoCommand } : {}),
      ...(groupId ? { groupId } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    this.store.mutate((d) => {
      d.sshHosts = prev ? d.sshHosts.map((h) => (h.id === next.id ? next : h)) : [...d.sshHosts, next]
    })
    return { ...next }
  }

  /**
   * 删除一条主机条目；SSH 条目被别处指向的跳板引用一并摘掉（不留悬空跳板），
   * 挂在它上面的隧道配置也一并删掉（不留悬空隧道）。
   */
  deleteSshHost(id: string): HostConfig[] {
    this.store.mutate((d) => {
      d.sshHosts = d.sshHosts
        .filter((h) => h.id !== id)
        .map((h) => (isStoredLocal(h) ? h : h.jumpHostId === id ? { ...h, jumpHostId: undefined } : h))
      d.sshTunnels = d.sshTunnels.filter((t) => t.hostId !== id)
    })
    return this.listSshHosts()
  }

  // ---------- 主机分组（主机 / 终端共用的归类树） ----------
  //
  // 与接口请求分组同款（`apiGroups` 那一段）：**多级树**，只承担「归类 + 排序」；
  // 条目靠自己的 `groupId` 指过来，所以「删分组」默认不碰主机（移回未分组）。
  // SSH 主机与本机终端共用同一套 —— 它们同列在侧栏，分两套只会让本机终端进不了分组。

  listHostGroups(): HostGroup[] {
    return this.store.snapshot().hostGroups
  }

  /**
   * 某分组（含子孙分组）下的主机 id。
   *
   * 给「连主机一起删」那条路用：调用方要**在删除之前**拿到这份名单，才能把它们的
   * 采集连接与隧道一起收掉（删完再查已经查不到了）。
   */
  hostIdsInGroupSubtree(groupId: string): string[] {
    const doomed = hostGroupSubtreeIds(this.store.snapshot().hostGroups, groupId)
    if (!doomed.size) return []
    return this.store
      .snapshot()
      .sshHosts.filter((h) => h.groupId && doomed.has(h.groupId))
      .map((h) => h.id)
  }

  /** 保存分组（upsert）：不传 id 视为新增；parentId 缺省 = 顶级分组 */
  saveHostGroup(input: HostGroupInput): HostGroup[] {
    const groups = this.store.snapshot().hostGroups
    const prev = input.id ? groups.find((g) => g.id === input.id) : undefined
    if (input.id && !prev) throw new Error('分组不存在或已被删除')
    const name = input.name.trim()
    if (!name) throw new Error('分组名不能为空')
    // 父分组必须存在，且不能挂到自己 / 自己的子孙下（成环后整棵子树会从界面上消失）
    const parentId = input.id ? input.parentId ?? prev?.parentId : input.parentId
    if (parentId) {
      if (parentId === input.id) throw new Error('分组不能挂到自己下面')
      if (!groups.some((g) => g.id === parentId)) throw new Error('父分组不存在或已被删除')
      if (input.id && hostGroupSubtreeIds(groups, input.id).has(parentId)) {
        throw new Error('分组不能挂到自己的子分组下面')
      }
    }

    const group: HostGroup = {
      id: prev?.id ?? newId(),
      name,
      ...(parentId ? { parentId } : {}),
      createdAt: prev?.createdAt ?? Date.now()
    }
    this.store.mutate((d) => {
      d.hostGroups = prev
        ? d.hostGroups.map((g) => (g.id === group.id ? group : g))
        : [...d.hostGroups, group]
    })
    return this.listHostGroups()
  }

  /**
   * 删除分组（含多级）：删除的是**整棵子树** —— 被删分组的子孙分组整体上移一级，
   * 挂到被删分组的父分组下（顶级被删则升为顶级）；组内主机跟着上移一级。
   * `deleteHosts` 为 true 时连同子树内所有主机一起删除。
   *
   * 两份数据一起返回 —— 渲染端无论如何都要同时更新它们（与 `deleteApiGroup` 同款）。
   */
  deleteHostGroup(id: string, deleteHosts = false): HostGroupsAndHosts {
    const groups = this.store.snapshot().hostGroups
    const doomed = hostGroupSubtreeIds(groups, id)
    if (!doomed.size) throw new Error('分组不存在或已被删除')
    const promoteTo = groups.find((g) => g.id === id)?.parentId
    const nextGroups = groups
      .filter((g) => !doomed.has(g.id))
      .map((g) => (g.parentId && doomed.has(g.parentId) ? { ...g, parentId: promoteTo } : g))

    const hosts = this.store.snapshot().sshHosts
    const inDoomed = (h: StoredHost): boolean => Boolean(h.groupId && doomed.has(h.groupId))
    const nextHosts = deleteHosts
      ? hosts.filter((h) => !inDoomed(h))
      : hosts.map((h) => (inDoomed(h) ? { ...h, groupId: promoteTo } : h))

    this.store.mutate((d) => {
      d.hostGroups = nextGroups
      d.sshHosts = nextHosts
      // 主机真被删掉时，挂它上面的隧道也得跟着走（与 deleteSshHost 一致，不留悬空隧道）
      if (deleteHosts) {
        const alive = new Set(nextHosts.map((h) => h.id))
        d.sshTunnels = d.sshTunnels.filter((t) => alive.has(t.hostId))
      }
    })
    return { groups: nextGroups, hosts: nextHosts.map((h) => toHostView(h)) }
  }

  /**
   * 拖拽排序 / 换组 / 移动层级后的整体重排：数组顺序即显示顺序（DFS 前序）。
   *
   * 与 `arrangeApi` 同一套保底规则：`groups` 里没出现的分组按原相对顺序附在其后；
   * `parentId` 会成环时静默丢弃该 parentId（保底不破坏树形）。主机只改 `groupId`
   * 与顺序，不碰内容、不刷新 `updatedAt`（列表显示的是「最近编辑」时间）。
   */
  arrangeHosts(payload: HostArrangeInput): HostGroupsAndHosts {
    const groups = this.store.snapshot().hostGroups
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const parentOf = new Map(payload.groups.map((x) => [x.id, x.parentId || undefined]))
    const wouldCycle = (fromId: string, stopId: string): boolean => {
      let cur: string | undefined = fromId
      const seen = new Set<string>()
      while (cur && cur !== stopId) {
        if (seen.has(cur)) return true
        seen.add(cur)
        cur = parentOf.get(cur)
      }
      return cur === stopId
    }
    const ordered: HostGroup[] = []
    const placed = new Set<string>()
    for (const item of payload.groups) {
      const g = groupById.get(item.id)
      if (!g || placed.has(g.id)) continue
      placed.add(g.id)
      const parentId = item.parentId || undefined
      const safe = parentId && parentId !== g.id && !wouldCycle(parentId, g.id)
      ordered.push(safe ? { ...g, parentId } : g)
    }
    for (const g of groups) {
      if (!placed.has(g.id)) ordered.push(g)
    }

    // 归属只认**这次真的存在**的分组：界面上刚删掉的分组不会把主机吸进悬空 id 里
    const aliveGroups = new Set(ordered.map((g) => g.id))
    const hosts = this.store.snapshot().sshHosts
    const hostById = new Map(hosts.map((h) => [h.id, h]))
    const next: StoredHost[] = []
    for (const item of payload.hosts) {
      const h = hostById.get(item.id)
      if (!h) continue
      const groupId = item.groupId && aliveGroups.has(item.groupId) ? item.groupId : undefined
      next.push(h.groupId === groupId ? h : { ...h, groupId })
    }
    for (const h of hosts) {
      if (!next.some((x) => x.id === h.id)) next.push(h)
    }

    this.store.mutate((d) => {
      d.hostGroups = ordered
      d.sshHosts = next
    })
    return { groups: ordered, hosts: next.map((h) => toHostView(h)) }
  }

  // ---------- SSH 隧道（本地转发 -L / 远程转发 -R / SOCKS5 动态代理 -D） ----------
  //
  // 只存配置；「起没起、连了几条」是内存里的运行态（`apps/server` 的 `ssh/tunnels.ts`），
  // 不落盘 —— 进程重启后隧道不会自己活着，落一份「running」只会是假的。
  // 想开机自动拉起的用 `autoStart`（服务启动时由隧道管理器读它）。

  /** 全部隧道配置（按登记顺序） */
  listSshTunnels(): SshTunnel[] {
    return this.store.snapshot().sshTunnels
  }

  /**
   * 保存一条隧道（upsert）：不传 id 视为新增。
   *
   * 校验都放在这里而不是路由：`type` / 端口范围 / 目标地址是**配置本身的合法性**，
   * 无论从界面还是从别的调用方进来都必须成立。
   *
   * ⚠️ `bindPort` 允许 0 只在 `remote`（-R）下有意义 —— 那是「让远端 sshd 自己挑一个
   * 空闲端口」，返回值在运行态的 `remoteBind` 里（见隧道管理器的 `startRemote`）。
   */
  saveSshTunnel(input: SshTunnelInput): SshTunnel {
    const tunnels = this.store.snapshot().sshTunnels
    const now = Date.now()
    const prev = input.id ? tunnels.find((t) => t.id === input.id) : undefined

    const hostId = input.hostId?.trim() || prev?.hostId
    if (!hostId) throw new Error('缺少主机')
    // 目标主机必须真的存在、且是 SSH 条目（本机终端没有可复用的 SSH 连接）
    const host = this.store.snapshot().sshHosts.find((h) => h.id === hostId)
    if (!host) throw new Error('主机不存在（可能已被删除）')
    if (isStoredLocal(host)) throw new Error('本机终端不能承载隧道，请选择一台 SSH 主机')

    const type = input.type ?? prev?.type
    if (type !== 'local' && type !== 'remote' && type !== 'dynamic') {
      throw new Error('隧道类型不合法')
    }

    const bindHost = (input.bindHost ?? prev?.bindHost ?? '127.0.0.1').trim() || '127.0.0.1'
    const bindPort = input.bindPort ?? prev?.bindPort
    if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
      throw new Error('监听端口必须在 0 - 65535 之间')
    }
    if (bindPort === 0 && type !== 'remote') {
      throw new Error('只有远程转发（-R）可以让远端自动分配端口')
    }

    const targetHost = input.targetHost?.trim() || undefined
    const targetPort = input.targetPort ?? undefined
    if (type !== 'dynamic') {
      if (!targetHost) {
        throw new Error(type === 'remote' ? '缺少目标地址（服务端可达）' : '缺少目标地址（远端可达）')
      }
      if (!Number.isInteger(targetPort) || (targetPort as number) < 1 || (targetPort as number) > 65535) {
        throw new Error('目标端口必须在 1 - 65535 之间')
      }
    }

    const label = input.label?.trim() || undefined
    const autoStart = input.autoStart ?? prev?.autoStart ?? false

    const next: SshTunnel = {
      id: prev?.id ?? newId(),
      hostId,
      type,
      bindHost,
      bindPort,
      ...(type === 'dynamic' ? {} : { targetHost, targetPort }),
      ...(label ? { label } : {}),
      ...(autoStart ? { autoStart: true } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    this.store.mutate((d) => {
      d.sshTunnels = prev
        ? d.sshTunnels.map((t) => (t.id === next.id ? next : t))
        : [...d.sshTunnels, next]
    })
    return { ...next }
  }

  /** 删除一条隧道配置（运行中的由调用方先停：`tunnelManager.stop(id)`） */
  deleteSshTunnel(id: string): void {
    this.store.mutate((d) => {
      d.sshTunnels = d.sshTunnels.filter((t) => t.id !== id)
    })
  }

  // ---------- 接口请求（api-client）----------
  //
  // 与 dogi 的 storage 同款语义，只是换成 `snapshot()` / `mutate()`：请求集合 / 分组 /
  // 历史**全局一份**（不按项目），无凭据语义故不加密。

  listApiRequests(): ApiRequestEntry[] {
    return this.store.snapshot().apiRequests
  }

  /**
   * 保存接口请求（upsert）：不传 id 视为新增。
   *
   * 旧记录兜底：编辑页保存只带草稿字段，`groupId` 等未带字段继承旧记录
   * （否则按 Ctrl+S 会把请求从分组里踢出去）。
   */
  saveApiRequest(input: ApiRequestEntry): ApiRequestEntry[] {
    const requests = this.store.snapshot().apiRequests
    const now = Date.now()
    const prev = input.id ? requests.find((r) => r.id === input.id) : undefined
    const entry: ApiRequestEntry = {
      ...prev,
      ...input,
      id: input.id || newId(),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    this.store.mutate((d) => {
      d.apiRequests = prev
        ? d.apiRequests.map((r) => (r.id === entry.id ? entry : r))
        : [...d.apiRequests, entry]
    })
    return this.listApiRequests()
  }

  deleteApiRequest(id: string): ApiRequestEntry[] {
    this.store.mutate((d) => {
      d.apiRequests = d.apiRequests.filter((r) => r.id !== id)
    })
    return this.listApiRequests()
  }

  /**
   * 拖拽排序 / 换组 / 移动层级后的整体重排：数组顺序即显示顺序（DFS 前序）。
   * - `groups` 里没出现的分组按原相对顺序附在其后；`parentId` 会造成环（挂到自己或自己的
   *   子孙）时静默丢弃该 parentId（保底不破坏树形）；
   * - `requests` 只改 `groupId` 与顺序，不碰内容、不刷新 `updatedAt`
   *   （列表显示的是「最近编辑」时间，拖一下顺序就跳成「刚刚」会很误导）。
   */
  arrangeApi(payload: ApiArrangeInput): ApiGroupsAndRequests {
    const groups = this.store.snapshot().apiGroups
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const parentOf = new Map(payload.groups.map((x) => [x.id, x.parentId || undefined]))
    // 从 fromId 沿目标 parent 链往上走，能走到 stopId 就是环（不能挂）
    const wouldCycle = (fromId: string, stopId: string): boolean => {
      let cur: string | undefined = fromId
      const seen = new Set<string>()
      while (cur && cur !== stopId) {
        if (seen.has(cur)) return true
        seen.add(cur)
        cur = parentOf.get(cur)
      }
      return cur === stopId
    }
    const ordered: ApiGroup[] = []
    const placed = new Set<string>()
    for (const item of payload.groups) {
      const g = groupById.get(item.id)
      if (!g || placed.has(g.id)) continue
      placed.add(g.id)
      const parentId = item.parentId || undefined
      const safe = parentId && parentId !== g.id && !wouldCycle(parentId, g.id)
      ordered.push(safe ? { ...g, parentId } : g)
    }
    for (const g of groups) {
      if (!placed.has(g.id)) ordered.push(g)
    }

    const requests = this.store.snapshot().apiRequests
    const requestById = new Map(requests.map((r) => [r.id, r]))
    const next: ApiRequestEntry[] = []
    for (const item of payload.requests) {
      const r = requestById.get(item.id)
      if (!r) continue
      next.push(r.groupId === item.groupId ? r : { ...r, groupId: item.groupId })
    }
    for (const r of requests) {
      if (!next.some((x) => x.id === r.id)) next.push(r)
    }

    this.store.mutate((d) => {
      d.apiGroups = ordered
      d.apiRequests = next
    })
    return { groups: this.listApiGroups(), requests: this.listApiRequests() }
  }

  listApiGroups(): ApiGroup[] {
    return this.store.snapshot().apiGroups
  }

  /** 保存分组（upsert）：不传 id 视为新增；parentId 缺省 = 顶级分组 */
  saveApiGroup(input: ApiGroupInput): ApiGroup[] {
    const groups = this.store.snapshot().apiGroups
    const prev = input.id ? groups.find((g) => g.id === input.id) : undefined
    const group: ApiGroup = {
      id: input.id || newId(),
      name: input.name.trim(),
      // 更新（重命名）且没传 parentId 时保留原父分组，不会被误「踢回顶级」
      parentId: input.id ? input.parentId ?? prev?.parentId : input.parentId,
      createdAt: prev?.createdAt ?? Date.now()
    }
    this.store.mutate((d) => {
      d.apiGroups = prev
        ? d.apiGroups.map((g) => (g.id === group.id ? group : g))
        : [...d.apiGroups, group]
    })
    return this.listApiGroups()
  }

  /**
   * 删除分组（含多级）：删除的是**整棵子树** —— 被删分组的子孙分组整体上移一级，
   * 挂到被删分组的父分组下（顶级被删则升为顶级）；组内请求跟着上移一级。
   * `deleteRequests` 为 true 时连同子树内所有请求一起删除。
   * 两份数据一起返回 —— 渲染端无论如何都要同时更新它们。
   */
  deleteApiGroup(id: string, deleteRequests = false): ApiGroupsAndRequests {
    const groups = this.store.snapshot().apiGroups
    // 收集整棵子树（被删分组 + 所有子孙分组）
    const doomed = new Set<string>()
    const collect = (gid: string): void => {
      if (doomed.has(gid)) return
      doomed.add(gid)
      for (const g of groups) if (g.parentId === gid) collect(g.id)
    }
    collect(id)
    const deleted = groups.find((g) => g.id === id)
    const promoteTo = deleted?.parentId
    const nextGroups = groups
      .filter((g) => !doomed.has(g.id))
      .map((g) => (g.parentId && doomed.has(g.parentId) ? { ...g, parentId: promoteTo } : g))
    const requests = this.store.snapshot().apiRequests
    const inDoomed = (r: ApiRequestEntry): boolean => Boolean(r.groupId && doomed.has(r.groupId))
    const nextRequests = deleteRequests
      ? requests.filter((r) => !inDoomed(r))
      : requests.map((r) => (inDoomed(r) ? { ...r, groupId: promoteTo } : r))
    this.store.mutate((d) => {
      d.apiGroups = nextGroups
      d.apiRequests = nextRequests
    })
    return { groups: nextGroups, requests: nextRequests }
  }

  listApiHistory(): ApiHistoryEntry[] {
    return this.store.snapshot().apiHistory
  }

  /**
   * 覆盖写入整段历史（渲染端每次发送后把裁剪过的数组传回来）。
   * 历史是「最近 N 条」的滑动窗口，逐条增删反而更容易和界面状态不一致。
   */
  saveApiHistory(entries: ApiHistoryEntry[]): ApiHistoryEntry[] {
    this.store.mutate((d) => {
      d.apiHistory = entries
    })
    return this.listApiHistory()
  }

  clearApiHistory(): ApiHistoryEntry[] {
    this.store.mutate((d) => {
      d.apiHistory = []
    })
    return []
  }

  // ---------- 主机脚本（scripts）----------
  //
  // 与接口请求同款语义（换成 `snapshot()` / `mutate()`）：脚本集合 / 分组**全局一份**
  // （不按项目），无凭据语义故不加密。分组只有**一层**，未分组脚本由渲染端恒排在最前。

  listScripts(): ScriptEntry[] {
    return this.store.snapshot().scripts
  }

  /**
   * 保存脚本（upsert）：不传 id 视为新增。
   *
   * 旧记录兜底：编辑页保存只带自己关心的字段（name / content / description），
   * `groupId` 等未带字段继承旧记录 —— 否则按 Ctrl/Cmd+S 会把脚本从分组里踢出去。
   */
  saveScript(input: ScriptInput): ScriptEntry[] {
    const scripts = this.store.snapshot().scripts
    const now = Date.now()
    const prev = input.id ? scripts.find((s) => s.id === input.id) : undefined
    const name = (input.name ?? prev?.name ?? '').trim()
    const entry: ScriptEntry = {
      ...prev,
      ...input,
      id: input.id || newId(),
      name: name || prev?.name || '未命名脚本',
      content: input.content ?? prev?.content ?? '',
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    this.store.mutate((d) => {
      d.scripts = prev
        ? d.scripts.map((s) => (s.id === entry.id ? entry : s))
        : [...d.scripts, entry]
    })
    return this.listScripts()
  }

  deleteScript(id: string): ScriptEntry[] {
    this.store.mutate((d) => {
      d.scripts = d.scripts.filter((s) => s.id !== id)
    })
    return this.listScripts()
  }

  /**
   * 拖拽重排：数组顺序即显示顺序。
   * - `groupIds` 里没出现的分组按原相对顺序附在其后；
   * - `scripts` 只改 `groupId` 与顺序，不碰内容、不刷新 `updatedAt`
   *   （列表显示的是「最近编辑」时间，拖一下顺序就跳成「刚刚」会很误导）；
   * - `groupId` 指向不存在的分组时静默归到未分组（保底不产生悬空归属）。
   */
  arrangeScripts(payload: ScriptArrangeInput): ScriptsAndGroups {
    const groups = this.store.snapshot().scriptGroups
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const validGroupIds = new Set(groupById.keys())
    const ordered: ScriptGroup[] = []
    const placed = new Set<string>()
    for (const gid of payload.groupIds) {
      const g = groupById.get(gid)
      if (!g || placed.has(gid)) continue
      placed.add(gid)
      ordered.push(g)
    }
    for (const g of groups) {
      if (!placed.has(g.id)) ordered.push(g)
    }

    const scripts = this.store.snapshot().scripts
    const scriptById = new Map(scripts.map((s) => [s.id, s]))
    const next: ScriptEntry[] = []
    for (const item of payload.scripts) {
      const s = scriptById.get(item.id)
      if (!s) continue
      const groupId = item.groupId && validGroupIds.has(item.groupId) ? item.groupId : undefined
      next.push(s.groupId === groupId ? s : { ...s, groupId })
    }
    for (const s of scripts) {
      if (!next.some((x) => x.id === s.id)) next.push(s)
    }

    this.store.mutate((d) => {
      d.scriptGroups = ordered
      d.scripts = next
    })
    return { groups: ordered, scripts: next }
  }

  listScriptGroups(): ScriptGroup[] {
    return this.store.snapshot().scriptGroups
  }

  /** 保存脚本分组（upsert）：不传 id 视为新增 */
  saveScriptGroup(input: ScriptGroupInput): ScriptGroup[] {
    const groups = this.store.snapshot().scriptGroups
    const prev = input.id ? groups.find((g) => g.id === input.id) : undefined
    const group: ScriptGroup = {
      id: input.id || newId(),
      name: input.name.trim(),
      createdAt: prev?.createdAt ?? Date.now()
    }
    this.store.mutate((d) => {
      d.scriptGroups = prev
        ? d.scriptGroups.map((g) => (g.id === group.id ? group : g))
        : [...d.scriptGroups, group]
    })
    return this.listScriptGroups()
  }

  /**
   * 删除脚本分组：`deleteScripts` 为 true 时连同组内脚本一起删除，
   * 否则组内脚本归到「未分组」。两份数据一起返回 —— 渲染端无论如何都要同时更新它们。
   */
  deleteScriptGroup(id: string, deleteScripts = false): ScriptsAndGroups {
    const scripts = this.store.snapshot().scripts
    const nextGroups = this.store.snapshot().scriptGroups.filter((g) => g.id !== id)
    const nextScripts = deleteScripts
      ? scripts.filter((s) => s.groupId !== id)
      : scripts.map((s) => (s.groupId === id ? { ...s, groupId: undefined } : s))
    this.store.mutate((d) => {
      d.scriptGroups = nextGroups
      d.scripts = nextScripts
    })
    return { groups: nextGroups, scripts: nextScripts }
  }

  // ---------- 数据导入 / 导出（左下角菜单）----------
  //
  // 三类数据（接口请求 / 主机 / 脚本）打包带走或导回。真正的规则在 `transfer.ts`
  // （纯函数，能脱开 Electron / 文件系统单验），这里只负责**取快照**与**一次落盘**。

  /**
   * 导出：按类型组装可移植的 payload。
   *
   * 快照走本类已有的 `list*` 方法 —— 主机那两条顺手做了脱敏，所以导出天然不带凭据
   * （理由见 `transfer.ts` 顶部注释），不用在这里再列一遍「哪些字段不能出去」。
   */
  exportTransfer(kinds: TransferKind[]): {
    payloads: TransferPayload[]
    counts: Partial<Record<TransferKind, number>>
  } {
    const snap: TransferSnapshot = {
      hosts: this.listSshHosts(),
      hostGroups: this.listHostGroups(),
      apiRequests: this.listApiRequests(),
      apiGroups: this.listApiGroups(),
      scripts: this.listScripts(),
      scriptGroups: this.listScriptGroups()
    }
    const payloads: TransferPayload[] = []
    const counts: Partial<Record<TransferKind, number>> = {}
    for (const kind of kinds) {
      const { payload, itemCount } = buildTransferPayload(kind, snap)
      payloads.push(payload)
      counts[kind] = itemCount
    }
    return { payloads, counts }
  }

  /**
   * 导入：按 id upsert（**先分组后条目**，条目里的 `groupId` 才指得到东西）。
   *
   * 三类数据的补丁**合并成一次 `mutate`**：一次导入常常同时动了分组与条目两张表，
   * 分开落盘既多写几遍盘，也让「导入到一半失败」留下半截状态。
   * 不认识的 kind / 不在 `kinds` 里的 payload 直接跳过（界面勾掉了就不动它）。
   */
  importTransfer(payloads: TransferPayload[], kinds: TransferKind[]): TransferImportResult {
    const wanted = new Set(kinds)
    const data = this.store.snapshot()
    const patch: Partial<typeof data> = {}
    const result: TransferImportResult = { added: {}, updated: {}, skipped: {} }

    for (const payload of payloads) {
      const kind = payload?.kind as TransferKind | undefined
      if (!kind || !wanted.has(kind)) continue
      /*
       * 逐份**接着上一份的结果**算（`working` 叠了已算出的补丁）：同一个 kind 出现两次时，
       * 后一份才看得见前一份导进来的分组 —— 否则第二份里的 `groupId` 会被当成悬挂引用摘掉。
       */
      const working = { ...data, ...patch } as typeof data
      const applied = applyTransferPayload(kind, payload, working)
      Object.assign(patch, applied.patch)
      result.added[kind] = (result.added[kind] ?? 0) + applied.added
      result.updated[kind] = (result.updated[kind] ?? 0) + applied.updated
      result.skipped[kind] = (result.skipped[kind] ?? 0) + applied.skipped
    }

    if (Object.keys(patch).length > 0) this.store.mutate((d) => Object.assign(d, patch))
    return result
  }

  // ---------- 技能设置 ----------

  getSkillSettings(): SkillSettings {
    return this.store.snapshot().skillSettings
  }

  saveSkillSettings(patch: Partial<SkillSettings>): SkillSettings {
    this.store.mutate((d) => {
      d.skillSettings = {
        disabled: [...new Set(patch.disabled ?? d.skillSettings.disabled)],
        extraDirs: [...new Set(patch.extraDirs ?? d.skillSettings.extraDirs)]
      }
    })
    return this.store.snapshot().skillSettings
  }

  // ---------- 子任务（subagent）偏好 ----------

  /** 读子任务偏好；老数据 / 手改坏的都在 store.load 时归一化成「全关」 */
  getSubagentSettings(): SubagentSettings {
    return this.store.snapshot().subagentSettings
  }

  /**
   * 存子任务偏好。
   *
   * ⚠️ `undefined` = **保留**（与 `saveSkillSettings` 同款）：前端可能只改其中一项，
   * 不能把没传的那项清空。要真的清空 `enabled` 得显式传 `[]`，清空模型要显式传 `null`，
   * 步数要回到默认值得显式传 `{}`。
   */
  saveSubagentSettings(patch: Partial<SubagentSettings>): SubagentSettings {
    this.store.mutate((d) => {
      const prev = d.subagentSettings
      d.subagentSettings = normalizeSubagentSettings({
        enabled: [...new Set(patch.enabled ?? prev.enabled)],
        modelConfigId: patch.modelConfigId !== undefined ? patch.modelConfigId : prev.modelConfigId,
        modelId: patch.modelId !== undefined ? patch.modelId : prev.modelId,
        // 步数整体替换：调用方（设置页）先合并好要留的 id 再传，缺 id = 该子任务回默认
        maxSteps: patch.maxSteps !== undefined ? patch.maxSteps : prev.maxSteps
      })
    })
    return this.store.snapshot().subagentSettings
  }

  // ---------- 系统监控偏好（总开关） ----------

  /** 读系统监控偏好；老数据 / 手改坏的都在 store.load 时归一化成默认值（开） */
  getSystemMonitorSettings(): SystemMonitorSettings {
    return this.store.snapshot().systemMonitorSettings
  }

  /**
   * 存系统监控偏好。`patch` 里缺的字段 = **保留**；归一化在落盘前再走一遍。
   *
   * ⚠️ 采样器的启停由**调用方**（`/api/system/settings` 的 POST）随后显式同步 ——
   * 这里只负责落盘，别在领域层去 import server 的采样器（那是另一层的职责）。
   */
  saveSystemMonitorSettings(patch: Partial<SystemMonitorSettings>): SystemMonitorSettings {
    this.store.mutate((d) => {
      d.systemMonitorSettings = normalizeSystemMonitorSettings({
        ...d.systemMonitorSettings,
        ...patch
      })
    })
    return this.store.snapshot().systemMonitorSettings
  }

  // ---------- 界面语言 ----------

  /** 读界面语言（全局一份；老数据 / 手改坏的都在 store.load 时归一化成中文） */
  getLanguage(): AppLanguage {
    return this.store.snapshot().language
  }

  /** 存界面语言；归一化兜底，非法值一律回中文 */
  saveLanguage(language: AppLanguage): AppLanguage {
    this.store.mutate((d) => {
      d.language = normalizeLanguage(language)
    })
    return this.store.snapshot().language
  }

  // ---------- 客户端偏好（跨端一致的全局一份） ----------

  /** 读客户端偏好：老数据 / 手改坏的都在 store.load 时归一化过 */
  getPrefs(): PrefsSnapshot {
    return this.store.snapshot().prefs
  }

  /**
   * 存客户端偏好：`patch` 里缺的 key = **保留**（前端只提交改过的 key）。
   *
   * 归一化走两遍：`normalizePrefsPatch` 先把「不认识的 key / 非法值」丢掉（不让手滑传的
   * `NaN` 把用户原来的 5 冲成默认 2），再 `normalizePrefs` 补全成完整一份落盘。
   */
  savePrefs(patch: unknown): PrefsSnapshot {
    const clean: PrefsPatch = normalizePrefsPatch(patch)
    this.store.mutate((d) => {
      d.prefs = normalizePrefs({ ...d.prefs, ...clean })
    })
    return this.store.snapshot().prefs
  }

  // ---------- 容器型项目：公网访问域名 ----------

  /**
   * 读公网访问域名配置（设置页填的那份）。
   *
   * ⚠️ 域名**只有这一个出处**（盘上的设置）；`FIZZ_CONTAINER_DOMAIN` 环境变量兜底已移除，
   * 设置页读什么就是什么，不再有「读回来是 env 的、写一次就变成了盘上的」这种自相矛盾。
   */
  getContainerPublicSettings(): ContainerPublicSettings {
    return this.store.snapshot().containerPublicSettings
  }

  /**
   * 存公网访问域名清单。`patch` 里缺的字段 = **保留**；归一化在落盘前再走一遍
   * （逐个去空白 / 去 `*.` / 去协议端口路径 / 转小写 / 去重；不合法项丢弃）。
   */
  saveContainerPublicSettings(patch: Partial<ContainerPublicSettings>): ContainerPublicSettings {
    this.store.mutate((d) => {
      d.containerPublicSettings = normalizeContainerPublicSettings({
        ...d.containerPublicSettings,
        ...patch
      })
    })
    return this.store.snapshot().containerPublicSettings
  }

  // ---------- 插件启停偏好 ----------

  /** 读**某个项目**的插件偏好（只作用于该项目自己的插件）；没存过 = 全启用 */
  getPluginSettings(workspaceId: string): PluginSettings {
    return this.store.snapshot().pluginSettings[workspaceId] ?? { disabled: [] }
  }

  /**
   * 存**某个项目**的插件偏好。`disabled` 是完整清单（与 `saveSkillSettings` 同款全量语义），
   * 传 `[]` 就是全启用。
   */
  savePluginSettings(workspaceId: string, patch: Partial<PluginSettings>): PluginSettings {
    this.store.mutate((d) => {
      const prev = d.pluginSettings[workspaceId] ?? { disabled: [] }
      d.pluginSettings[workspaceId] = {
        disabled: [...new Set(patch.disabled ?? prev.disabled)]
      }
    })
    return this.store.snapshot().pluginSettings[workspaceId] ?? { disabled: [] }
  }

  /**
   * 读**全局（用户级）**插件偏好（`~/.fizz/plugins`，与项目无关）。
   *
   * 用户级插件对所有项目生效，所以它**没有**「按项目分开开关」这一说 —— 开关就该是全局的，
   * 在设置 →「插件」页里管（见 `apps/server/src/api/plugins/route.ts` 的 `scope=global`）。
   */
  getGlobalPluginSettings(): PluginSettings {
    return this.store.snapshot().globalPluginSettings ?? { disabled: [] }
  }

  /** 存全局（用户级）插件偏好；`disabled` 是完整清单，传 `[]` 就是全启用 */
  saveGlobalPluginSettings(patch: Partial<PluginSettings>): PluginSettings {
    this.store.mutate((d) => {
      const prev = d.globalPluginSettings ?? { disabled: [] }
      d.globalPluginSettings = {
        disabled: [...new Set(patch.disabled ?? prev.disabled)]
      }
    })
    return this.store.snapshot().globalPluginSettings ?? { disabled: [] }
  }

  // ---------- 插件设置项的值（插件用 `ctx.ui.setting` 声明、设置页里填） ----------

  /**
   * 插件运行时配置里的设置项取值（**密钥已解密**）—— 只给「挂载插件」用，绝不出网
   * （同 `resolveModelConfig` 的 apiKey）。
   *
   * 没填过的项不在结果里：插件自己回落到 `default` / 环境变量。解密失败的项当没配
   * （主密钥换了 / 数据被改坏）—— 记一行日志即可，不该让整轮对话或整次上传挂掉。
   */
  resolvePluginConfigValues(pluginId: string): Record<string, string | number | boolean> {
    const data = this.store.snapshot()
    const out: Record<string, string | number | boolean> = { ...(data.pluginValues?.[pluginId] ?? {}) }
    for (const [key, cipher] of Object.entries(data.pluginSecrets?.[pluginId] ?? {})) {
      try {
        const plain = this.store.decryptSecret(cipher)
        if (plain) out[key] = plain
      } catch (err) {
        console.warn(
          `[plugin] 设置项「${key}」解密失败（按未配置处理，插件会回落到 env / 默认值）：`,
          err instanceof Error ? err.message : err
        )
      }
    }
    return out
  }

  /**
   * 给设置页的**可见视图**：非密钥项原文 + 已填的密钥项 id 清单。
   * 密钥的**值本身不出网**（前端只显示「已设置」，与模型配置的 hasApiKey 同款）。
   */
  pluginSettingStates(pluginId: string): {
    values: Record<string, string | number | boolean>
    secretIds: string[]
  } {
    const data = this.store.snapshot()
    return {
      values: { ...(data.pluginValues?.[pluginId] ?? {}) },
      secretIds: Object.keys(data.pluginSecrets?.[pluginId] ?? {})
    }
  }

  /**
   * 增量保存插件设置项：**只写 `patch` 里出现的项**，`null` / 空串 = 清空该项。
   *
   * `secretIds` 由调用方给（它手里有插件声明的 schema）：这些项加密落盘，并从「非密钥」
   * 那份里移除 —— 一个值只可能住在其中一份里，不会出现「改成密钥项后旧明文还留着」。
   *
   * ⚠️ 密钥项的空串由**调用方**先过滤掉（界面留空 = 保持原值）：明文不在浏览器手里，
   * 没法回传，所以「空」不能当清空用（要清空走 `null`）。
   */
  savePluginValues(
    pluginId: string,
    patch: Record<string, string | number | boolean | null>,
    secretIds: readonly string[]
  ): void {
    const secretKeys = new Set(secretIds)
    this.store.mutate((d) => {
      const values: Record<string, string | number | boolean> = { ...(d.pluginValues?.[pluginId] ?? {}) }
      const secrets: Record<string, string> = { ...(d.pluginSecrets?.[pluginId] ?? {}) }
      for (const [key, raw] of Object.entries(patch)) {
        if (raw === null || raw === '') {
          delete values[key]
          delete secrets[key]
          continue
        }
        if (secretKeys.has(key)) {
          const cipher = this.store.encryptSecret(String(raw))
          if (cipher) secrets[key] = cipher
          delete values[key]
        } else {
          values[key] = raw
          delete secrets[key]
        }
      }
      if (Object.keys(values).length) d.pluginValues[pluginId] = values
      else delete d.pluginValues[pluginId]
      if (Object.keys(secrets).length) d.pluginSecrets[pluginId] = secrets
      else delete d.pluginSecrets[pluginId]
    })
  }

  /**
   * **卸载**一个插件时清掉它留下的设置值（含密钥密文）。
   *
   * 为什么必须清：插件 id 是**入口文件的绝对路径**，所以「同名文件重新装回来」会挂到
   * 同一条记录上 —— 不清的话，新插件一上来就读到上一次填的 token，既莫名其妙也不安全。
   * 留着还会在 store 里攒孤儿（`pluginValues` / `pluginSecrets` 只增不减）。
   */
  deletePluginValues(pluginId: string): void {
    this.store.mutate((d) => {
      delete d.pluginValues[pluginId]
      delete d.pluginSecrets[pluginId]
    })
  }

  /**
   * 插件设置项的**指纹**（含密钥密文、不含明文）—— 给「配置变没变，要不要重建缓存」用：
   * 上传源目录按它 + 插件文件 mtime 决定是否重新 mount（否则在设置页填完 token 也得等
   * 重启才生效）。
   */
  pluginValuesFingerprint(pluginId: string): string {
    const data = this.store.snapshot()
    return JSON.stringify([
      data.pluginValues?.[pluginId] ?? {},
      data.pluginSecrets?.[pluginId] ?? {}
    ])
  }
}
