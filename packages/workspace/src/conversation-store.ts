/**
 * 会话的**目录式**存储：每个会话在项目的 `<项目>/.fizz/conversation/<会话 id>/` 下
 * 落两份文件。
 *
 * - `config.json` —— 这个会话「用哪个模型 / 哪个外部 Agent」的配置
 *   （`backend` / `configId` / `modelId` / `mcpServerIds`）；用某个模型发消息、
 *   或在下拉里改选，都会更新它；
 * - `conversation.json` —— 会话数据（标题 / 消息 / 时间 / 用量 / 摘要 / 队列 / 归档时间）。
 *
 * 为什么从 `agent-core.json` 里搬出来：会话是**跟着项目走**的资产，放在项目目录里可以
 * 随项目一起复制 / 备份 / 迁移；`agent-core.json` 只留「这台机器上有哪些工作区、模型、
 * Agent 配置」这类全局设置。项目里的 `.fizz/` 自带 `.gitignore`（内容 `*`），
 * 不会进版本库。
 *
 * **兜底**：工作区没有可用目录（`path` 为空 / 目录已被删）时退到
 * `<数据目录>/conversations/<会话 id>/`。项目目录不存在时**绝不**递归创建它
 * （那会在磁盘上凭空长出一个空项目目录），只写兜底位置。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  AcpContextUsage,
  AcpModesState,
  AcpPermissionMode,
  AcpThoughtLevelState,
  AgentBackend,
  AgentChatMessage,
  AgentConversation,
  AgentWorkspace,
  CollabSettings,
  CollabState,
  ConversationAutoSummary,
  ConversationContextSummary,
  ConversationUsage,
  QueuedMessage
} from '@fizz/contracts/types'
import { normalizeCollabSettings, normalizeCollabState } from '@fizz/contracts/types'

/** 项目内的隐藏数据目录（与工作区配置 `<项目>/.fizz/workspace.json` 同一处） */
export const FIZZ_DIR = '.fizz'
/** 会话目录（`.fizz/conversation/`），其下按会话 id 建子目录 */
export const CONVERSATION_DIR = 'conversation'
/** 会话的模型配置文件名 */
export const CONVERSATION_CONFIG_FILE = 'config.json'
/** 会话的数据文件名 */
export const CONVERSATION_DATA_FILE = 'conversation.json'
/** 协作会话的运行态文件名（任务 / 消息 / 状态；只存在于 `kind: 'collab'`） */
export const CONVERSATION_COLLAB_FILE = 'collab.json'
/** 两份文件的结构版本（将来结构变更时用于迁移） */
export const CONVERSATION_FILES_VERSION = 1

/** 隐藏目录自带一份 .gitignore：会话属于本地数据，不该被提交 */
const GITIGNORE_CONTENT = '# Fizz 本地数据（工作区配置 / 会话记录，不入版本库）\n*\n'

/** `config.json` 的形状：模型 / Agent 目标 + 会话可用的 MCP + ACP 运行态 */
interface ConversationConfigFile {
  version: number
  kind?: 'chat' | 'collab'
  collab?: CollabSettings
  backend?: AgentBackend
  configId?: string
  modelId?: string
  mcpServerIds?: string[]
  /** ACP 会话的 Session Modes 快照（见 AgentConversation.acpModes） */
  acpModes?: AcpModesState
  /** ACP 会话的思考档快照（见 AgentConversation.acpThoughtLevel） */
  acpThoughtLevel?: AcpThoughtLevelState
  /** ACP 会话的权限答复策略（见 AgentConversation.acpPermissionMode） */
  acpPermissionMode?: AcpPermissionMode
  /** ACP agent 上报的上下文占用（见 AgentConversation.acpContextUsage） */
  acpContextUsage?: AcpContextUsage
}

/** `conversation.json` 的形状：除模型配置以外的会话数据 */
interface ConversationDataFile {
  version: number
  id: string
  workspaceId: string
  title: string
  messages: AgentChatMessage[]
  createdAt: number
  updatedAt: number
  acpSessionId?: string
  contextSummary?: ConversationContextSummary
  /** 自动压缩的固化点（见 `ConversationAutoSummary`）：重启后复用摘要，不重新调模型 */
  autoSummary?: ConversationAutoSummary
  queuedMessages?: QueuedMessage[]
  archivedAt?: number
  /**
   * 「定时任务起的会话，用户还没点开过」（见 `AgentConversation.unseen`）。
   *
   * ⚠️ 这一份是**白名单**：`splitConversation` / `mergeConversation` 都得认它，
   * 漏一处就会「重启后红点全没了」（写盘丢 / 读盘丢各是一种）。
   */
  unseen?: boolean
  totalUsage?: ConversationUsage
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** 兜底会话根目录（工作区不可用时用它，保证数据不丢） */
export function fallbackConversationRoot(dataDir: string): string {
  return join(dataDir, 'conversations')
}

/** 远端工作区的会话根放在数据目录下（`conversations/remote/<工作区 id>`） */
export const REMOTE_CONVERSATION_DIR = 'remote'

/**
 * 远端工作区的会话根：**固定在本机数据目录**，不写远端 `.fizz/conversation`。
 *
 * 理由：每条消息都要经 SFTP 落盘会把一次聊天变成几十次网络往返；主机断线后历史
 * 也还得看得见。历史是这台服务端的资产，跟着数据目录一起备份 / 迁移。
 */
export function remoteConversationRoot(dataDir: string, workspaceId: string): string {
  return join(fallbackConversationRoot(dataDir), REMOTE_CONVERSATION_DIR, workspaceId)
}

/**
 * 按工作区记录解析会话根（本地 / 远端两条分支的唯一入口）。
 *
 * 远端恒返回 `fallback: true`：目录不在工作区里，调用方据此跳过「扫项目目录」那类
 * 逻辑；`remote` 标记供需要区分的调用方使用。
 */
export async function conversationRootFor(
  workspace: Pick<AgentWorkspace, 'id' | 'path' | 'remote'> | null | undefined,
  dataDir: string,
  opts?: { create?: boolean }
): Promise<{ root: string; fallback: boolean; remote: boolean }> {
  if (workspace?.remote?.hostId) {
    const root = remoteConversationRoot(dataDir, workspace.id)
    if (opts?.create) await fs.mkdir(root, { recursive: true })
    return { root, fallback: true, remote: true }
  }
  const resolved = await resolveConversationRoot(workspace?.path, dataDir, opts)
  return { ...resolved, remote: false }
}

/** 扫描 `conversations/remote/*` 下的全部会话（启动装配用；不需要连远端） */
export async function listRemoteConversations(dataDir: string): Promise<AgentConversation[]> {
  const base = join(fallbackConversationRoot(dataDir), REMOTE_CONVERSATION_DIR)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out: AgentConversation[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    out.push(...(await listConversationsIn(join(base, entry.name))))
  }
  return out
}

/**
 * 解析一个工作区的会话根目录。
 *
 * - 工作区目录真实存在 → `<工作区>/.fizz/conversation`；
 * - 否则 → `<数据目录>/conversations`（兜底）。
 *
 * `create` 为 true 时顺带补齐目录（含 `.fizz/.gitignore`）；为 false 时
 * **只解析、不创建任何东西**（读盘 / 扫描用）。
 */
export async function resolveConversationRoot(
  workspacePath: string | null | undefined,
  dataDir: string,
  opts?: { create?: boolean }
): Promise<{ root: string; fallback: boolean }> {
  const wsPath = workspacePath?.trim()
  if (wsPath && (await isDirectory(wsPath))) {
    const fizzDir = join(wsPath, FIZZ_DIR)
    const root = join(fizzDir, CONVERSATION_DIR)
    if (opts?.create) {
      await fs.mkdir(root, { recursive: true })
      const gitignore = join(fizzDir, '.gitignore')
      if (!(await fileExists(gitignore))) {
        await fs.writeFile(gitignore, GITIGNORE_CONTENT, 'utf8')
      }
    }
    return { root, fallback: false }
  }
  const root = fallbackConversationRoot(dataDir)
  if (opts?.create) await fs.mkdir(root, { recursive: true })
  return { root, fallback: true }
}

/** 一个会话目录下的两条路径 */
function conversationPaths(root: string, id: string): {
  dir: string
  configPath: string
  dataPath: string
  collabPath: string
} {
  const dir = join(root, id)
  return {
    dir,
    configPath: join(dir, CONVERSATION_CONFIG_FILE),
    dataPath: join(dir, CONVERSATION_DATA_FILE),
    collabPath: join(dir, CONVERSATION_COLLAB_FILE)
  }
}

/** 拆成两份文件的内容：模型配置单独一份（`config.json`），其余进 `conversation.json` */
function splitConversation(conversation: AgentConversation): {
  config: ConversationConfigFile
  data: ConversationDataFile
} {
  const config: ConversationConfigFile = {
    version: CONVERSATION_FILES_VERSION,
    ...(conversation.kind === 'collab' ? { kind: 'collab' as const } : {}),
    ...(conversation.kind === 'collab' && conversation.collab
      ? { collab: normalizeCollabSettings(conversation.collab) }
      : {}),
    ...(conversation.backend ? { backend: conversation.backend } : {}),
    ...(conversation.configId ? { configId: conversation.configId } : {}),
    ...(conversation.modelId ? { modelId: conversation.modelId } : {}),
    // 空数组与「没选」语义一致（都不接任何 MCP），不写空数组
    ...(conversation.mcpServerIds?.length ? { mcpServerIds: conversation.mcpServerIds } : {}),
    // ACP 运行态快照：缺省不写（存量会话 / 非 acp 会话天然没有）
    ...(conversation.acpModes ? { acpModes: conversation.acpModes } : {}),
    ...(conversation.acpThoughtLevel ? { acpThoughtLevel: conversation.acpThoughtLevel } : {}),
    ...(conversation.acpPermissionMode ? { acpPermissionMode: conversation.acpPermissionMode } : {}),
    ...(conversation.acpContextUsage ? { acpContextUsage: conversation.acpContextUsage } : {})
  }
  const data: ConversationDataFile = {
    version: CONVERSATION_FILES_VERSION,
    id: conversation.id,
    workspaceId: conversation.workspaceId,
    title: conversation.title,
    messages: Array.isArray(conversation.messages) ? conversation.messages : [],
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(conversation.acpSessionId ? { acpSessionId: conversation.acpSessionId } : {}),
    ...(conversation.contextSummary ? { contextSummary: conversation.contextSummary } : {}),
    ...(conversation.autoSummary ? { autoSummary: conversation.autoSummary } : {}),
    ...(conversation.queuedMessages?.length ? { queuedMessages: conversation.queuedMessages } : {}),
    ...(conversation.archivedAt ? { archivedAt: conversation.archivedAt } : {}),
    // 「还没被点开」的红点标记：false / 缺省都不写（见 ConversationDataFile.unseen）
    ...(conversation.unseen ? { unseen: true } : {}),
    ...(conversation.totalUsage ? { totalUsage: conversation.totalUsage } : {})
  }
  return { config, data }
}

/**
 * 收敛自动摘要的固化点：读盘是**不可信输入**。
 *
 * 形状不对（缺字段 / 空串）就整体丢弃，退回「没有固化点」—— 下一轮重新摘要一次，
 * 不因为一份坏数据把会话弄起不来。`keepFromMessageId` 指向已删消息的情形不在这里处理：
 * 那由 `compactHistory` 按「找不到就重摘要」兜底（历史是活的，这里判不了）。
 */
function normalizeAutoSummary(raw: unknown): ConversationAutoSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Partial<ConversationAutoSummary>
  if (typeof v.keepFromMessageId !== 'string' || !v.keepFromMessageId) return undefined
  if (typeof v.text !== 'string' || !v.text) return undefined
  return {
    keepFromMessageId: v.keepFromMessageId,
    text: v.text,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now()
  }
}

/**
 * 把两份文件合成一个会话。任一文件缺字段都当「不可信输入」兜底：
 * 读盘坏掉不该让整个会话列表起不来。
 */
function mergeConversation(configRaw: unknown, dataRaw: unknown): AgentConversation | null {
  if (!dataRaw || typeof dataRaw !== 'object') return null
  const data = dataRaw as Partial<ConversationDataFile>
  if (typeof data.id !== 'string' || !data.id) return null
  const config = (configRaw && typeof configRaw === 'object' ? configRaw : {}) as Partial<ConversationConfigFile>
  /**
   * 后端：只认 `'acp'`，其余非空取值一律按内置后端读。
   * 这样老会话文件里存着的历史字符串也能正常打开（不会被读成「未指定」）。
   */
  const backend: AgentBackend | undefined = config.backend
    ? config.backend === 'acp'
      ? 'acp'
      : 'builtin'
    : undefined
  const autoSummary = normalizeAutoSummary(data.autoSummary)
  const kind: 'chat' | 'collab' = config.kind === 'collab' ? 'collab' : 'chat'
  return {
    id: data.id,
    workspaceId: typeof data.workspaceId === 'string' ? data.workspaceId : '',
    title: typeof data.title === 'string' && data.title ? data.title : '新会话',
    ...(kind === 'collab'
      ? { kind: 'collab' as const, collab: normalizeCollabSettings(config.collab) }
      : {}),
    messages: Array.isArray(data.messages) ? data.messages : [],
    ...(backend ? { backend } : {}),
    ...(typeof config.configId === 'string' && config.configId ? { configId: config.configId } : {}),
    ...(typeof config.modelId === 'string' && config.modelId ? { modelId: config.modelId } : {}),
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
    ...(typeof data.acpSessionId === 'string' && data.acpSessionId
      ? { acpSessionId: data.acpSessionId }
      : {}),
    ...(data.contextSummary ? { contextSummary: data.contextSummary } : {}),
    ...(autoSummary ? { autoSummary } : {}),
    ...(Array.isArray(config.mcpServerIds) && config.mcpServerIds.length
      ? { mcpServerIds: config.mcpServerIds }
      : {}),
    // ACP 运行态：读盘是「不可信输入」，只做形状存在性判断（更深校验留给 upsert 侧）
    ...(config.acpModes ? { acpModes: config.acpModes } : {}),
    ...(config.acpThoughtLevel ? { acpThoughtLevel: config.acpThoughtLevel } : {}),
    ...(config.acpPermissionMode === 'allow' || config.acpPermissionMode === 'confirm'
      ? { acpPermissionMode: config.acpPermissionMode }
      : {}),
    ...(config.acpContextUsage ? { acpContextUsage: config.acpContextUsage } : {}),
    ...(Array.isArray(data.queuedMessages) && data.queuedMessages.length
      ? { queuedMessages: data.queuedMessages }
      : {}),
    ...(typeof data.archivedAt === 'number' ? { archivedAt: data.archivedAt } : {}),
    // 只认严格的 `true`：读盘是不可信输入，`"false"` / `1` 之类一律当没这个标记
    ...(data.unseen === true ? { unseen: true } : {}),
    ...(data.totalUsage ? { totalUsage: data.totalUsage } : {})
  }
}

/** 原子写一个 JSON 文件：先写 `.tmp` 再 rename（同 JsonStore 的手法） */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, filePath)
}

/** 把一个会话写进它所属根目录下的会话目录（目录会就地补齐） */
export async function writeConversation(root: string, conversation: AgentConversation): Promise<void> {
  const { dir, configPath, dataPath } = conversationPaths(root, conversation.id)
  await fs.mkdir(dir, { recursive: true })
  const { config, data } = splitConversation(conversation)
  await writeJsonAtomic(configPath, config)
  await writeJsonAtomic(dataPath, data)
}

/** 读一个会话目录；目录不存在 / 数据文件不可用时返回 null */
export async function readConversationDir(dir: string): Promise<AgentConversation | null> {
  try {
    const raw = await fs.readFile(join(dir, CONVERSATION_DATA_FILE), 'utf8')
    const data = JSON.parse(raw) as unknown
    let config: unknown = null
    try {
      config = JSON.parse(await fs.readFile(join(dir, CONVERSATION_CONFIG_FILE), 'utf8')) as unknown
    } catch {
      // config.json 缺失 / 损坏：模型目标为空（界面显示「选择模型」），会话数据照常可用
      config = null
    }
    return mergeConversation(config, data)
  } catch {
    return null
  }
}

/** 删掉一个会话目录（整个目录，含两份文件）；不存在时静默通过 */
export async function removeConversationDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

/** 扫描一个会话根目录下的全部会话（目录不存在 = 空） */
export async function listConversationsIn(root: string): Promise<AgentConversation[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: AgentConversation[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const conversation = await readConversationDir(join(root, entry.name))
    if (conversation) out.push(conversation)
  }
  return out
}

/** 会话目录 / 文件在磁盘上的位置（诊断 / 需要告诉用户「存哪」时用） */
export function conversationFilePaths(
  root: string,
  id: string
): { dir: string; configPath: string; dataPath: string; collabPath: string } {
  return conversationPaths(root, id)
}

/** 读协作运行态；不存在 / 损坏 = 空快照（老会话 / 普通会话天然没有） */
export async function readCollabStateDir(dir: string): Promise<CollabState | null> {
  try {
    const raw = await fs.readFile(join(dir, CONVERSATION_COLLAB_FILE), 'utf8')
    return normalizeCollabState(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/** 把一个协作会话的运行态写进它自己的目录（沿用 config/data 的原子写） */
export async function writeCollabState(
  root: string,
  id: string,
  state: CollabState
): Promise<void> {
  const { dir, collabPath } = conversationPaths(root, id)
  await fs.mkdir(dir, { recursive: true })
  await writeJsonAtomic(collabPath, normalizeCollabState(state))
}
