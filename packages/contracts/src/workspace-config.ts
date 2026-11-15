/**
 * 工作区目录配置（`<工作区>/.fizz/workspace.json`）。
 *
 * 与 electron-store 里的那份配置（`agentWorkspaces`）刻意分开：那份只记「这台机器上
 * 有哪些工作区」，这份**跟着项目目录走** —— 目录复制到别处 / 换台机器，工作区的
 * 快捷功能仍然在。所以它由一个隐藏目录承载：
 *
 * - 目录名以 `.` 开头，并自带一份 `.gitignore`（内容 `*`），不会进版本库；
 * - 已注册进本包 `workspace.ts` 的 `DEFAULT_IGNORE_DIRS`，工作区文件树与 Agent 的
 *   glob / grep 都会跳过它（配置是给人用的，不该混进代码里）。
 *
 * 主进程负责落盘（services/ai/workspace-config.ts），渲染端只经 IPC 读写；
 * 两侧都过一遍 `normalizeWorkspaceConfig`，手改过的文件也不会把 UI 打崩。
 */

/** 工作区内的隐藏配置目录名 */
export const WORKSPACE_CONFIG_DIR = '.fizz'
/** 配置文件（相对配置目录） */
export const WORKSPACE_CONFIG_FILE = 'workspace.json'
/** 当前配置结构版本（将来结构变更时用于迁移） */
export const WORKSPACE_CONFIG_VERSION = 1
/** 单个工作区最多允许多少个快捷功能（防御性上限） */
export const MAX_QUICK_ACTIONS = 50
/** 「免确认命令」清单的条数上限（记满了丢最旧的） */
export const MAX_APPROVED_COMMANDS = 200
/**
 * 单条「免确认命令」的长度上限：审批卡上的命令 / 操作描述超过这个长度就不进清单
 * （超长串本身几乎不可能二次精确命中，落盘只会撑坏这份给人手改的文件）。
 */
export const MAX_APPROVED_COMMAND_LENGTH = 400

/**
 * 快捷功能类型：
 * - `link`    打开外部链接（系统浏览器）
 * - `command` 在工作区目录的内嵌终端里执行一条命令
 * - `path`    用系统默认程序打开一个本地路径（相对工作区解析）
 */
export type QuickActionKind = 'link' | 'command' | 'path'

export const QUICK_ACTION_KINDS: QuickActionKind[] = ['link', 'command', 'path']

/** 快捷功能：工作区页顶部一键执行的小按钮 */
export interface QuickAction {
  id: string
  kind: QuickActionKind
  /** 按钮上的文字 */
  label: string
  /** 目标：link=URL；command=命令行；path=绝对路径或相对工作区的路径 */
  target: string
  /** 可选说明（hover 提示；缺省时提示 target） */
  description?: string
}

export interface WorkspaceConfig {
  version: number
  /**
   * 旧版的「工作区默认终端」（shell 的 id，如 `pwsh` / `gitbash`）：**已废弃**。
   * 工作区设置里不再提供入口，打开终端时也不再读它；保留字段只为读写旧文件时不丢数据。
   */
  defaultTerminal: string | null
  quickActions: QuickAction[]
  /**
   * confirm 模式下点过「始终允许」的**免确认命令**清单。
   *
   * - 匹配是**精确的**：键就是审批卡上显示的那行命令 / 操作描述，换一个参数、
   *   改一个字都会重新询问 —— 曾经按「工具名」记，点一次「始终允许」等于放行该
   *   工具的一切调用，且没有任何入口能收回。
   * - 这份文件就是白名单的**唯一真源**：手改它（删掉某条）下一次调用立刻恢复
   *   询问（服务端每次审批前现读盘，见 `confirm-gate.ts`）。
   * - 「始终拒绝」**刻意不落盘**：拒绝记忆留在服务端内存、重启清零（安全侧失效）。
   */
  approvedCommands: string[]
}

/** 读取 / 保存工作区配置的返回体：附带落盘位置（UI 上要告诉用户配置存在哪） */
export interface WorkspaceConfigSnapshot {
  /** 配置目录绝对路径 */
  dir: string
  /** 配置文件绝对路径 */
  filePath: string
  config: WorkspaceConfig
  /**
   * 读盘时的告警（当前只有「JSON 损坏」一种）：有值时 UI 提示用户去修，
   * 但仍返回一份可用的默认配置 —— 加载不出来就把整个工作区页打废是不划算的。
   */
  error?: string
}

/** 新建一个空配置（每次返回新对象，别共享同一份引用） */
export function createEmptyWorkspaceConfig(): WorkspaceConfig {
  return {
    version: WORKSPACE_CONFIG_VERSION,
    defaultTerminal: null,
    quickActions: [],
    approvedCommands: []
  }
}

/** 生成快捷功能 id（主进程与渲染端共用；无 crypto.randomUUID 时退回时间戳） */
export function newQuickActionId(): string {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') return `qa-${uuid.call(globalThis.crypto)}`
  return `qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 规整单条快捷功能；结构不可用（没有合法类型或目标）时返回 null，由调用方丢弃 */
export function normalizeQuickAction(raw: unknown): QuickAction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = QUICK_ACTION_KINDS.find((k) => k === r.kind)
  if (!kind) return null
  const target = asString(r.target)
  if (!target) return null
  const description = asString(r.description)
  return {
    id: asString(r.id) || newQuickActionId(),
    kind,
    // 名称留空就用目标顶替：列表里总得有个能点的字
    label: asString(r.label) || target,
    target,
    ...(description ? { description } : {})
  }
}

/** 把任意来源的数据规整成合法配置（读盘 / IPC 入参都过一遍） */
export function normalizeWorkspaceConfig(raw: unknown): WorkspaceConfig {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const list = Array.isArray(src.quickActions) ? src.quickActions : []
  const quickActions: QuickAction[] = []
  for (const item of list) {
    const action = normalizeQuickAction(item)
    if (action) quickActions.push(action)
    if (quickActions.length >= MAX_QUICK_ACTIONS) break
  }
  const version =
    typeof src.version === 'number' && Number.isFinite(src.version)
      ? src.version
      : WORKSPACE_CONFIG_VERSION
  // 工作区默认终端：只认字符串；空 / 非法类型归一成 null（= 跟随系统默认）
  const defaultTerminal = asString(src.defaultTerminal) || null
  // 免确认命令：trim、丢空串与超长项、去重、封顶条数（老文件没有这个字段 = 空清单）
  const rawApproved = Array.isArray(src.approvedCommands) ? src.approvedCommands : []
  const approvedCommands: string[] = []
  for (const item of rawApproved) {
    const cmd = asString(item)
    if (!cmd || cmd.length > MAX_APPROVED_COMMAND_LENGTH) continue
    if (!approvedCommands.includes(cmd)) approvedCommands.push(cmd)
    if (approvedCommands.length >= MAX_APPROVED_COMMANDS) break
  }
  return { version, defaultTerminal, quickActions, approvedCommands }
}

/**
 * 校验一条快捷功能能否保存；返回错误文案，null 表示通过。
 *
 * `link` 只放行 http(s) 与 mailto —— 主进程 openExternalSafe 的协议白名单是同一套，
 * 这里提前拦一道，用户才不会点了没反应。
 */
export function validateQuickAction(action: QuickAction): string | null {
  if (!action.label.trim()) return '请填写名称'
  const target = action.target.trim()
  if (!target) return '请填写目标'
  if (action.kind === 'link' && !/^(https?:\/\/|mailto:)/i.test(target)) {
    return '链接需要以 http:// 或 https:// 开头'
  }
  return null
}
