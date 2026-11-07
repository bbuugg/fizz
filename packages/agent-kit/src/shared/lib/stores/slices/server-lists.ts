/**
 * 服务端列表 slice：各域清单的本地镜像（health / 模型 / ACP agent / MCP / 工作区 /
 * 会话 / 技能）+ 全量刷新 + 全局状态 WS 订阅，以及一大类**无状态的 API 门面动作**
 * （文件 / git / ACP / MCP / worktree / 模型 / 技能的读写）—— 这些动作不持有状态，
 * 只是「拿 api 调一下 + 出错写 error / 成功刷列表」，住在 store 里纯粹是为了让
 * 组件有一个统一的取用面。
 */
import { initStateClient, subscribe, getSnapshot } from '@fizz/agent-kit/shared/lib/state-ws'
import { ApiError } from '@fizz/agent-client/api'
import type { AgentApi } from '@fizz/agent-client/api'
import type {
  AcpAgentInput,
  AcpAgentView,
  AgentFsEntry,
  AgentFsFile,
  AgentWorkspace,
  ConversationSummary,
  FsListResult,
  FsScaffoldInput,
  FsScaffoldResult,
  HealthInfo,
  McpServerToolsResult,
  ModelInput,
  ModelView,
  SftpListResult,
  UpstreamModelsInput,
  WorkspaceCloneInput
} from '@fizz/contracts/agent-api'
import type { McpServerConfig, McpServerInput } from '@fizz/mcp'
import type { SkillListResult } from '@fizz/skills'
import type {
  SubagentId,
  SubagentSettings,
  HostConfig,
  HostArrangeInput,
  HostGroup,
  HostGroupInput,
  HostGroupsAndHosts,
  HostInput,
  NotesCreateResult,
  NotesDirResult,
  NotesFileResult,
  NotesRenameResult,
  NotesRoot,
  NotesRootInput,
  SshTunnel,
  SshTunnelInput,
  SshTunnelRuntime,
  SshTunnelsSnapshot,
  ApiArrangeInput,
  ApiGroup,
  ApiGroupInput,
  ApiHistoryEntry,
  ApiHttpResponse,
  ApiRequestEntry,
  ApiSendInput,
  ScriptArrangeInput,
  ScriptEntry,
  ScriptGroup,
  ScriptGroupInput,
  ScriptInput,
  TransferExportResult,
  TransferFormat,
  TransferImportResult,
  TransferInspectResult,
  TransferKind
} from '@fizz/contracts/types'
import type {
  AppLanguage,
  ContainerProjectCreateInput,
  ContainerProjectUpdateInput,
  SystemMonitorSettings
} from '@fizz/contracts'
import { getLanguage, setLanguage } from '@fizz/i18n'
import { persistLanguage } from '@fizz/agent-kit/shared/lib/language'

import type {
  GitActionInput,
  GitBranchesResult,
  GitCommit,
  GitCommitDiffResult,
  GitDiffResult,
  GitStatusResult
} from '@fizz/git'
import type { AcpModelOption } from '@fizz/acp'
import type { ShellDetectResult } from '@fizz/shells'
import type { StateCreator } from 'zustand'
import { errorMessage } from '@fizz/agent-kit/shared/lib/stores/shared'
import type { AgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'

/**
 * 文件树写操作（删除 / 复制）的结果。
 *
 * `ok` 之外把服务端**原话**带上 —— 面板 toast 要讲具体原因：409 同名、路径越界、
 * 受保护目录，只有一句「失败了」是没法排障的。与 `writeWorkspaceFile` 的
 * 「返回错误文本」是同一思路，只是这里还要把成功后的新路径带回来。
 */
export type WorkspaceWriteResult =
  | { ok: true; path?: string }
  | { ok: false; error: string }

/**
 * 批量新建请求的一条：`group` 是**分组名**（空串 = 未分组）。
 *
 * 用「名字」而不是分组 id：建组由 store 负责（同名复用已有分组），调用方不需要先
 * 自己去查一遍分组清单 —— 它拿到的只是一份解析结果，根本不知道哪些组已经存在。
 */
export interface ApiImportEntry {
  group: string
  /** 请求种子（id / 时间戳 / groupId 由服务端与 store 定） */
  entry: Omit<ApiRequestEntry, 'id' | 'createdAt' | 'updatedAt' | 'groupId'>
}

/** 批量新建请求的载荷（OpenAPI / Swagger 导入用）：先按名字建组，再逐条建请求 */
export interface ApiImportBatch {
  /** 需要建的分组名（按出现顺序；同名复用已有分组） */
  groups: string[]
  entries: ApiImportEntry[]
}

export interface ServerListsSlice {
  health: HealthInfo | null
  models: ModelView[]
  acpAgents: AcpAgentView[]
  mcpServers: McpServerConfig[]
  /** 主机清单（SSH 主机 + 本机终端；SSH 脱敏：只有 `has*` 标记，不含明文凭据） */
  sshHosts: HostConfig[]
  /**
   * 主机分组：SSH 主机与本机终端**共用**的归类树（多级，`parentId` 自引用）。
   *
   * 与 `apiGroups` 同款 —— 只承担「归类 + 排序」，条目靠自己的 `groupId` 指过来。
   * 删分组默认不碰主机（移回未分组）；想连主机一起删要显式传 `deleteHosts`。
   */
  hostGroups: HostGroup[]
  /**
   * 主机清单（`sshHosts` + `hostGroups`）是否已成功拉过至少一遍。
   *
   * 与 `conversationsLoaded` 在同一次 `refresh()` 里置位（两者一起写入，不存在
   * 「会话到了主机没到」的中间态）。侧栏靠它区分「真的没有主机」与「还没拉回来」——
   * 后者的 `hosts` / `groups` 也是空数组，只看长度就会先闪一句「还没有主机或终端」。
   */
  hostsLoaded: boolean
  /**
   * SSH 隧道配置（本地转发 -L / 远程转发 -R / SOCKS5 动态代理 -D）。
   *
   * ⚠️ 监听端口绑在**跑 server 的那台机器**上，不是浏览器那台（`ssh -L/-R/-D` 的标准语义：
   * 监听端在 SSH 客户端侧，而本仓库里 SSH 客户端只有 server 一个）。界面文案写
   * 「服务端所在机器的端口」。
   */
  sshTunnels: SshTunnel[]
  /** 隧道运行态（起停 / 连接数 / 错误）；与配置同属一个快照域，只存在服务端内存 */
  tunnelRuntimes: SshTunnelRuntime[]
  /** 接口请求集合（HTTP + WebSocket 共用一张表，靠 `protocol` 区分） */
  apiRequests: ApiRequestEntry[]
  /** 请求分组（侧边栏树；只承担归类 + 排序） */
  apiGroups: ApiGroup[]
  /** 请求历史（每次发送后自动记录，最新在前） */
  apiHistory: ApiHistoryEntry[]
  /** 主机脚本集合（可在主机上一键执行的命令文本） */
  scripts: ScriptEntry[]
  /** 脚本分组（**单层**；只承担归类 + 排序） */
  scriptGroups: ScriptGroup[]
  workspaces: AgentWorkspace[]
  conversations: ConversationSummary[]
  /** 会话清单是否已成功拉过至少一遍（空 ≠ 没加载，见 refresh 注释） */
  conversationsLoaded: boolean
  skills: SkillListResult | null
  /** 子任务（subagent）偏好；默认全关，见 GeneralTab 的「子任务」开关 */
  subagentSettings: SubagentSettings | null
  /**
   * 内置浏览器（Playwright headless shell）装好了没有 —— 读 `/api/browser/runtime` 的
   * `runtime.installed`，与真正 launch 时的判据同源。
   *
   * 唯一的用途：没装就**不渲染**输入框上方那颗浏览器开关（点了必报
   * `Executable doesn't exist` 的开关不如不显示）。装 / 卸完成后要 `refresh()` 一次，
   * 否则这颗按钮要等下次全量刷新才出现。
   *
   * 每个会话自己的浏览器偏好在会话对象上（`AgentConversation.browserSettings`，默认关）。
   */
  browserInstalled: boolean
  /**
   * 系统监控偏好（总开关）；`null` = 还没拉过。
   * 设置页「系统监控」小节的开关、以及状态栏是否渲染监控条都读它（见 `app-shell.tsx`）。
   */
  systemMonitorSettings: SystemMonitorSettings | null
  /**
   * 界面语言（全局一份，服务端为权威值）。
   * 首帧先用 localStorage 里的值，连接后由 `refresh()` 对账覆盖。
   */
  language: AppLanguage
  /**
   * 已登记的**笔记根目录**（侧栏「笔记」功能区的顶层）。
   *
   * 走 state-ws 的 `notesRoots` 快照域：任意一端登记 / 移除都会推给所有端。
   * 树本身**不进 store** —— 笔记根是用户挑的任意目录、可能很大，展开某层时才现拉
   * （懒加载，见 `NotesSidebar`）。
   */
  notesRoots: NotesRoot[]

  /** 保存界面语言（同时更新本机 i18n 单例与 localStorage） */
  saveLanguage: (language: AppLanguage) => Promise<boolean>

  /** 拉一遍所有列表（连接后 / 任何写操作后调用） */
  refresh: () => Promise<void>
  /** 订阅全局状态 WS（服务端改了就推，前端不轮询）。返回退订函数 */
  bindStateWs: () => () => void

  // ---------- 会话清单 ----------
  renameConversation: (id: string, title: string) => Promise<void>
  /** 归档 / 取消归档（不删数据；侧栏据此把会话收进 / 放出「已归档」区） */
  archiveConversation: (id: string, archived: boolean) => Promise<void>
  /**
   * 重启 acp 会话：杀掉 agent 进程、**保留 sessionId**（下一轮 `session/load` 把原上下文接回来）。
   * 不新建 agent 侧会话、不动本地历史，真正的重连发生在下一条消息里 ——
   * 所以这个动作**不改任何本地状态**，成功返回 true（失败原因进 error）。
   * 用于让 agent 侧的变更生效（新装的 pi 权限扩展、改过的项目信任设置…）。
   */
  restartAcpSession: (agentId: string, conversationId: string) => Promise<boolean>

  // ---------- 配置类动作（写成功刷一遍全量列表，失败写 error） ----------
  saveAcpAgent: (input: AcpAgentInput) => Promise<boolean>
  deleteAcpAgent: (id: string) => Promise<boolean>
  /** 保存「这个 ACP agent 的模型白名单」（设置页挑的哪几个进会话下拉） */
  saveAcpAgentModels: (agentId: string, models: AcpModelOption[]) => Promise<boolean>
  saveMcpServer: (input: McpServerInput) => Promise<boolean>
  deleteMcpServer: (id: string) => Promise<boolean>
  saveSshHost: (input: HostInput) => Promise<boolean>
  deleteSshHost: (id: string) => Promise<boolean>
  /**
   * 隧道动作。**不刷全量列表**（与 `saveSshHost` 那批不同）：服务端每个动作都回一份
   * 「配置 + 运行态」快照，直接写回 store 即可 —— 起停隧道很频繁，为它跑一遍
   * `refresh()`（十几个接口）既慢又没必要。
   */
  saveSshTunnel: (input: SshTunnelInput) => Promise<boolean>
  deleteSshTunnel: (id: string) => Promise<boolean>
  startSshTunnel: (id: string) => Promise<boolean>
  stopSshTunnel: (id: string) => Promise<boolean>
  // ---------- 主机分组（主机 / 终端共用的多级归类树） ----------
  /** 新建 / 更新一个分组（带 id 更新，可改 parentId 换层级）→ 只写回分组树 */
  saveHostGroup: (input: HostGroupInput) => Promise<boolean>
  /** 删除分组（含多级子树）；`deleteHosts` = 连同子树内主机一起删 */
  deleteHostGroup: (id: string, deleteHosts?: boolean) => Promise<boolean>
  /** 拖拽重排 / 移动到分组（分组层级 + 主机归属一次提交）→ 写回分组树 + 主机清单 */
  arrangeHosts: (input: HostArrangeInput) => Promise<boolean>
  // ---------- 接口请求（api-client） ----------
  /** 新建 / 更新一条请求（带 id 更新）；成功刷列表，失败写 error */
  saveApiRequest: (input: ApiRequestEntry) => Promise<boolean>
  deleteApiRequest: (id: string) => Promise<boolean>
  /**
   * 批量新建请求（OpenAPI / Swagger 导入）。先按名字建组（同名复用），再逐条建请求。
   * 成功返回**这一批新建出来的请求**（界面据此打开第一条），失败写 error 并返回空数组。
   */
  importApiRequests: (batch: ApiImportBatch) => Promise<ApiRequestEntry[]>
  /** 拖拽重排（分组树 + 请求归属）；成功刷列表，失败写 error */
  arrangeApi: (input: ApiArrangeInput) => Promise<boolean>
  saveApiGroup: (input: ApiGroupInput) => Promise<boolean>
  /** 删除分组（含多级子树）；`deleteRequests` = 连同子树内请求一起删 */
  deleteApiGroup: (id: string, deleteRequests?: boolean) => Promise<boolean>
  /** 覆盖写入整段历史（渲染端裁剪后的窗口）；**失败只写 error，不刷列表**（历史是滑动窗口，界面自己已乐观更新） */
  saveApiHistory: (entries: ApiHistoryEntry[]) => Promise<boolean>
  clearApiHistory: () => Promise<boolean>
  // ---------- 主机脚本（scripts） ----------
  /** 新建 / 更新一条脚本（带 id 更新）；成功刷列表，失败写 error */
  saveScript: (input: ScriptInput) => Promise<boolean>
  deleteScript: (id: string) => Promise<boolean>
  /** 拖拽重排（分组顺序 + 脚本归属）；成功刷列表，失败写 error */
  arrangeScripts: (input: ScriptArrangeInput) => Promise<boolean>
  saveScriptGroup: (input: ScriptGroupInput) => Promise<boolean>
  /** 删除脚本分组；`deleteScripts` = 连同组内脚本一起删 */
  deleteScriptGroup: (id: string, deleteScripts?: boolean) => Promise<boolean>
  // ---------- 数据导入 / 导出（左下角菜单） ----------
  /**
   * 导出数据 → 文件内容（base64）+ 建议文件名。**不刷列表**（没动任何数据），
   * 失败写 error 并返回 null。`format: 'json'` 只允许勾一类（服务端会拒）。
   */
  exportTransferData: (input: {
    kinds: TransferKind[]
    format: TransferFormat
  }) => Promise<TransferExportResult | null>
  /**
   * 解析导入包看摘要（**不写库**）。失败写 error 并返回 null ——
   * 界面据此提示「这个文件为什么导不进来」，而不是弹一句「未知错误」。
   */
  inspectTransferData: (input: {
    dataBase64: string
    fileName?: string
  }) => Promise<TransferInspectResult | null>
  /**
   * 执行导入：**成功刷全量列表**（一次可能同时动了三类数据，逐项写回容易漏），
   * 失败写 error 并返回 null。返回的统计给界面报「新增 / 覆盖 / 跳过」。
   */
  applyTransferData: (input: {
    dataBase64: string
    fileName?: string
    kinds: TransferKind[]
  }) => Promise<TransferImportResult | null>
  /**
   * 执行一次 HTTP 请求（服务端发出）。**不刷列表、成功不写 error** ——
   * 返回的原样结果由调用方（接口调试页）展示状态码 / 耗时 / 响应体；
   * 网络层失败也在结果里（`status: 0 + error`），只有「拿不到结果」才写 error。
   */
  sendApiRequest: (input: ApiSendInput) => Promise<ApiHttpResponse>
  /** 取消进行中的请求；幂等，失败静默（取消本身不该再弹错） */
  abortApiRequest: (sendId: string) => Promise<void>
  /**
   * 主机终端拖拽上传（SFTP）用：解析远端路径（缺省 = 家目录）。
   * 未连接时抛错 —— 调用方（终端面板）要把它显示在确认条的「连接失败」态里，
   * 静默返回空串会让人以为「目录是空的」。
   */
  sftpRealpath: (hostId: string, path?: string) => Promise<string>
  /**
   * SFTP 文件管理（右击主机 →「SFTP 文件管理」标签）的读写动作。
   *
   * 都是**一问一答**的短操作，没有进度、不可取消，所以直接返回结果 / 抛错，不做任何
   * 取消归一化。
   *
   * ⚠️ **上传 / 下载不在这里** —— 它们带进度与取消、要活得比发起它们的组件长，由模块级的
   * `shared/lib/file-transfer/engine.ts` 编排（`runUpload` / `runDownload` /
   * `cancelTransfer`）。别在这里再长一层包装：引擎走的是 `useAgentStore.getState().getApi()`
   * （与 `features/logs/logs-store.ts` 同一套），自己判「未连接」并提示，包装层只会变成死代码。
   */
  /** 列一个远端目录；返回归一化路径与排好序的目录项 */
  sftpList: (hostId: string, path: string) => Promise<SftpListResult>
  /** 新建远端目录（不递归） */
  sftpMkdir: (hostId: string, path: string) => Promise<void>
  /** 重命名 / 同盘移动 */
  sftpRename: (hostId: string, from: string, to: string) => Promise<void>
  /** 删除文件 / 目录（目录递归，不可逆） */
  sftpRemove: (hostId: string, path: string) => Promise<void>
  /** 远端复制（目录递归） */
  sftpCopy: (hostId: string, from: string, to: string) => Promise<void>
  /** 远端移动（服务端优先 rename，跨盘自动回退） */
  sftpMove: (hostId: string, from: string, to: string) => Promise<void>
  saveModel: (input: ModelInput) => Promise<boolean>
  deleteModel: (id: string) => Promise<boolean>
  toggleSkill: (id: string, enabled: boolean) => Promise<boolean>
  /**
   * 全量保存「额外技能发现目录」（绝对路径清单）。技能页「添加 / 移除目录」走这里 ——
   * 这些目录下的 `<名字>/SKILL.md` 也会被扫到（服务端按每次 GET 重扫）。
   */
  setSkillDirs: (dirs: string[]) => Promise<boolean>
  /**
   * 启 / 停一个子任务。enabled 是**全量清单**（GET 回来的是完整状态），
   * 所以这里是「读当前 → 加/减一个 → 全量写回」，与 toggleSkill 同款思路。
   */
  toggleSubagent: (id: SubagentId, enabled: boolean) => Promise<boolean>
  /**
   * 保存子任务专用模型（`null` = 沿用父会话模型）。
   *
   * 只传模型两项；服务端「缺 `enabled` = 保留」，所以不会把启停状态改掉。
   */
  setSubagentModel: (model: { configId: string; modelId: string } | null) => Promise<boolean>
  /**
   * 保存某个子任务的步数上限（`null` = 回到规格默认值）。
   *
   * 与 `toggleSubagent` 同款：先读当前这份 → 改一个 id → 整体写回（服务端是全量替换）。
   * 只传 `maxSteps`，服务端「缺字段 = 保留」，所以不会把启停与模型改掉。
   */
  setSubagentMaxSteps: (id: SubagentId, steps: number | null) => Promise<boolean>
  /**
   * 保存系统监控偏好（只传要改的字段）。关掉后服务端停采、状态栏也不再渲染监控条；
   * 走 `withRefresh`，保存成功后靠全量刷新把 store 里的 `systemMonitorSettings` 写回。
   */
  saveSystemMonitorSettings: (patch: Partial<SystemMonitorSettings>) => Promise<boolean>
  /**
   * 登记一个本地目录为项目。成功返回新工作区（列表已刷新），失败返回 null（原因进 error）。
   *
   * 回对象而不是布尔：调用方紧接着就要**选中它**（初始页 / 侧栏「添加项目」的落点），
   * 有了 id 可以直接选，不必再「等列表刷新 → 按路径找回来」两跳（那要一个 effect + 一次多余渲染）。
   */
  addWorkspace: (input: {
    name?: string
    path: string
    remote?: { hostId: string }
  }) => Promise<AgentWorkspace | null>
  /**
   * 从 Git 导入项目：服务端克隆远端仓库到 `parentDir/<目录名>` 并登记。
   * 克隆可能跑几分钟（大仓库慢网），调用方自己显示 busy。
   * 成功返回新项目（列表已刷新），失败返回 null（原因进 error）。
   *
   * **取消 / 转到后台都不算失败**：服务端把它们当正常结局回 200
   * （`{ canceled }` / `{ detached }`），这里直接回 null，不往 `error` 里写东西。
   * 转到后台之后，那趟克隆会继续在 `listBackgroundTasks()` 里跑（状态栏可见）。
   */
  cloneWorkspace: (input: WorkspaceCloneInput) => Promise<AgentWorkspace | null>
  /**
   * 取消一条后台任务（克隆就是其中一种）：服务端杀掉进程、清掉半成品，**回包即清理完毕**，
   * 所以可以立刻重试。幂等，任务已结束时什么都不做，也不会报错。
   */
  cancelBackgroundTask: (id: string) => Promise<void>
  /**
   * 转到后台：只断开等待那条请求（`cloneWorkspace` 立刻回 null），任务继续跑。
   * 幂等；任务已结束 / 不存在都不报错。
   */
  detachBackgroundTask: (id: string) => Promise<void>
  /**
   * 新建**容器型**项目：目录名由服务端随机生成、**用户不可选**（这是这类项目的定义之一），
   * 用户只填名称 / 选镜像 / 可选 clone 地址；**预览端口由服务端按镜像分配**（用户只拿到域名）。
   * 成功返回新工作区（列表已刷新），失败返回 null（原因进 error）—— 与 `addWorkspace` 同形。
   */
  createContainerProject: (
    input: ContainerProjectCreateInput
  ) => Promise<AgentWorkspace | null>
  /**
   * 改容器型项目（改名 / 换镜像 / 公网访问开关 / 内存与 CPU 上限）。
   *
   * ⚠️ 换镜像会**销毁旧容器**（下次启动按新配置 `docker run` 重建，预览端口跟着新镜像走）——
   * 服务端负责这件事，这里只是转发。成功后刷新列表。
   *
   * ⚠️ 内存 / CPU 只落盘、不打断正在跑的容器：要立刻生效，调用方接着调
   * `rebuildContainerProject`（「容器设置」弹窗的「保存并重启」就是这么做的）。
   */
  updateContainerProject: (
    id: string,
    input: ContainerProjectUpdateInput
  ) => Promise<boolean>
  renameWorkspace: (id: string, name: string) => Promise<boolean>
  deleteWorkspace: (
    id: string,
    options?: Parameters<AgentApi['deleteWorkspace']>[1]
  ) => Promise<boolean>

  // ---------- 只读探测 / 无状态动作（不刷列表，错误语义见实现注释） ----------
  probeAcpModels: (agentId: string) => ReturnType<AgentApi['probeAcpModels']>
  detectAcpAgents: () => ReturnType<AgentApi['detectAcpAgents']>
  listMcpTools: () => ReturnType<AgentApi['listMcpTools']>
  probeMcpServerTools: (id: string) => Promise<McpServerToolsResult>
  probeUpstreamModels: (input: UpstreamModelsInput) => Promise<string[]>
  reloadSkills: () => Promise<void>
  listAcpAgentSessions: (
    agentId: string,
    cwd?: string
  ) => Promise<{ supported: boolean; sessions: Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }> }>
  listAcpAgentModes: (
    agentId: string,
    conversationId: string
  ) => Promise<{ supported: boolean; modes: Array<{ id: string; name?: string; description?: string }>; currentModeId: string | null }>
  setAcpAgentMode: (
    agentId: string,
    conversationId: string,
    modeId: string
  ) => Promise<{ ok: boolean; error?: string }>
  /** 切换 acp 会话的思考档（configOptions 的 thought_level，pi 用它） */
  setAcpThoughtLevel: (
    agentId: string,
    conversationId: string,
    value: string
  ) => Promise<{ ok: boolean; error?: string }>
  deleteAcpAgentSession: (
    agentId: string,
    sessionId: string
  ) => Promise<{ ok: boolean; supported: boolean; error?: string }>
  /**
   * 列工作区某目录（'' = 根）。
   *
   * `includeIgnored` = 连命中忽略规则（默认黑名单 + 工作区 `.gitignore`）的条目也一起列，
   * 那些条目会带 `ignored: true`；返回值里的 `truncated` 表示目录太大、服务端没列全。
   * 两者原本都没有出口，导致「看不见的文件」既无法解释也无法自查。
   */
  listWorkspaceFiles: (
    workspaceId: string,
    dir?: string,
    includeIgnored?: boolean
  ) => Promise<FsListResult>
  readWorkspaceFile: (workspaceId: string, path: string) => Promise<AgentFsFile | null>
  writeWorkspaceFile: (workspaceId: string, path: string, content: string) => Promise<string | null>
  /**
   * 脚手架：新建一份模板文件（技能 SKILL.md / AGENTS.md 空骨架）。斜线命令
   * `/create-skill` 已移除，目前没有界面入口；`/init` 不走 —— 那份文档得由模型
   * 读项目后写（见 `slash-commands.ts`）。
   *
   * 成功返回服务端的应答（落点 + 提示语），失败返回**人话错误**（调用方直接 toast）。
   * 刻意**不套 withRefresh**：建一个文件不会让任何清单变样，刷新整个 app 状态只会把
   * 面板重挂一遍、用户当前浏览到哪儿就丢了（与 `createServerDir` 同一理由）。
   */
  scaffoldWorkspaceFile: (
    workspaceId: string,
    input: FsScaffoldInput
  ) => Promise<FsScaffoldResult | string>
  fetchWorkspaceMedia: (workspaceId: string, path: string) => Promise<string | null>
  /** 把工作区里的文件 / 文件夹下载到本机（另存为）；`isDir` 时由服务端打包成 zip。返回错误文本，null = 已触发下载 */
  downloadWorkspaceFile: (
    workspaceId: string,
    path: string,
    fileName: string,
    isDir?: boolean
  ) => Promise<string | null>
  /** 删除工作区里的文件或目录（递归）；失败时 `error` 是服务端原话（面板直接 toast） */
  deleteWorkspaceFile: (workspaceId: string, path: string) => Promise<WorkspaceWriteResult>
  /** 复制工作区里的文件或目录到指定父目录；成功时 `path` 是新条目相对路径 */
  copyWorkspaceFile: (
    workspaceId: string,
    path: string,
    dest: string
  ) => Promise<WorkspaceWriteResult>
  /** 移动 / 重命名工作区里的文件或目录到指定父目录；成功时 `path` 是新条目相对路径。传 `name` = 重命名 */
  moveWorkspaceFile: (
    workspaceId: string,
    path: string,
    dest: string,
    name?: string
  ) => Promise<WorkspaceWriteResult>
  /** git 只读（出错**抛**）：面板要把 git 的原话直接讲给用户，吞掉就没法排查 */
  gitStatus: (workspaceId: string) => Promise<GitStatusResult>
  /** `prune` = 顺带 `git fetch --prune --all`（要联网，只在用户手动刷新时开） */
  gitBranches: (workspaceId: string, prune?: boolean) => Promise<GitBranchesResult>
  gitLog: (workspaceId: string, limit?: number) => Promise<GitCommit[]>
  /** 一次提交的元信息 + 文件清单 + unified 文本（历史面板点开某次提交时取） */
  gitCommit: (workspaceId: string, hash: string) => Promise<GitCommitDiffResult>
  gitDiff: (workspaceId: string, path: string, staged: boolean) => Promise<GitDiffResult>
  gitAction: (workspaceId: string, input: GitActionInput) => Promise<string>
  /** 在项目下创建 worktree（= 新的 worktree 项目），成功刷新列表并返回新项目 */
  createWorktree: (workspaceId: string, input: Parameters<AgentApi['createWorktree']>[1]) => Promise<AgentWorkspace | null>
  /** 扫描项目 `.worktree/` 下既有的 worktree（只读探测；错误抛给弹窗自己显示） */
  scanWorktrees: (workspaceId: string) => ReturnType<AgentApi['scanWorktrees']>
  /** 把已存在的 worktree 目录登记成项目，成功刷新列表并返回新项目 */
  loadWorktree: (workspaceId: string, input: Parameters<AgentApi['loadWorktree']>[1]) => Promise<AgentWorkspace | null>
  listServerDirs: (path: string) => ReturnType<AgentApi['listServerDirs']>
  createServerDir: (parent: string, name: string) => Promise<string>
  listTerminalShells: () => ReturnType<AgentApi['listTerminalShells']>

  // ---------- 笔记（登记目录 + 管理其中的 Markdown） ----------
  //
  // 根目录清单是**快照域**（`notesRoots`），登记 / 移除后靠 WS 推送 + 一次全量刷新兜底；
  // 文件操作是**一问一答**、没有缓存（磁盘才是真源），出错一律抛给调用方 ——
  // 树要能显示「这一层为什么列不出来」，静默返回空列表会让人以为目录是空的。
  /** 登记一个目录为笔记根；成功返回那条记录（已刷新列表），失败返回 null（原因进 error） */
  addNotesRoot: (input: NotesRootInput) => Promise<NotesRoot | null>
  /** 移除登记（**只摘登记，不碰磁盘**） */
  removeNotesRoot: (id: string) => Promise<boolean>
  /** 列某一层（`dir` 留空 = 根目录）；出错抛 ApiError（含 403 越界 / 404 根不存在） */
  listNoteFiles: (rootId: string, dir?: string) => Promise<NotesDirResult>
  /** 读一篇笔记 */
  readNoteFile: (rootId: string, path: string) => Promise<NotesFileResult>
  /** 覆盖保存一篇笔记（不存在则创建） */
  writeNoteFile: (rootId: string, path: string, content: string) => ReturnType<AgentApi['writeNoteFile']>
  /** 在 `dir` 下新建一篇空笔记，返回它的相对路径 */
  createNoteFile: (rootId: string, dir?: string) => Promise<NotesCreateResult>
  /** 重命名（只换文件名），返回新的相对路径 */
  renameNoteFile: (rootId: string, path: string, name: string) => Promise<NotesRenameResult>
  /** 删除一篇笔记（真删，无回收站） */
  deleteNoteFile: (rootId: string, path: string) => ReturnType<AgentApi['deleteNoteFile']>
}

export const createServerListsSlice: StateCreator<AgentStore, [], [], ServerListsSlice> = (
  set,
  get
) => {
  /** 配置类动作的统一壳：写成功 → 全量刷新；失败 → error。返回是否成功 */
  const withRefresh = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      await get().refresh()
      return true
    } catch (err) {
      get().setError(errorMessage(err))
      return false
    }
  }

  const requireApi = () => {
    const api = get().getApi()
    if (!api) throw new Error('未连接服务端')
    return api
  }

  /**
   * 隧道动作的统一壳：服务端每个动作都回一份「配置 + 运行态」快照，直接写回 store。
   *
   * **不刷全量列表**（与 `withRefresh` 那批不同）：起停隧道很频繁，为它跑一遍
   * `refresh()`（十几个接口）既慢又没必要；而隧道的运行态本来就是服务端推的
   * （`sshTunnels` 快照域），这里的返回只是「这次操作立刻可见」。
   */
  const withTunnelSnapshot = async (
    fn: () => Promise<SshTunnelsSnapshot>
  ): Promise<boolean> => {
    try {
      const snap = await fn()
      set({ sshTunnels: snap.tunnels, tunnelRuntimes: snap.runtimes })
      return true
    } catch (err) {
      get().setError(errorMessage(err))
      return false
    }
  }

  /**
   * 主机分组动作的统一壳：删除分组 / 拖拽重排都会**同时**动分组树与主机清单
   * （组内主机上移一级、或换组），服务端把两份数据一起回给我们，一次写回。
   *
   * **不刷全量列表**：理由同 `withTunnelSnapshot` —— 拖拽是高频动作，松手后要立刻
   * 看到结果，不能等十几个接口跑完。
   */
  const withHostTree = async (fn: () => Promise<HostGroupsAndHosts>): Promise<boolean> => {
    try {
      const next = await fn()
      set({ hostGroups: next.groups, sshHosts: next.hosts })
      return true
    } catch (err) {
      get().setError(errorMessage(err))
      return false
    }
  }

  return {
    health: null,
    models: [],
    acpAgents: [],
    mcpServers: [],
    sshHosts: [],
    hostGroups: [],
    sshTunnels: [],
    tunnelRuntimes: [],
    apiRequests: [],
    apiGroups: [],
    apiHistory: [],
    scripts: [],
    scriptGroups: [],
    workspaces: [],
    conversations: [],
    conversationsLoaded: false,
    hostsLoaded: false,
    skills: null,
    subagentSettings: null,
    browserInstalled: false,
    systemMonitorSettings: null,
    language: getLanguage(),
    notesRoots: [],

    refresh: async (): Promise<void> => {
      const api = get().getApi()
      if (!api) return
      get().setBusy(true)
      try {
        const [
          nextHealth,
          nextModels,
          nextAcpAgents,
          nextMcpServers,
          nextSshHosts,
          nextHostGroups,
          nextSshTunnels,
          nextApiRequests,
          nextApiGroups,
          nextApiHistory,
          nextScripts,
          nextScriptGroups,
          nextWorkspaces,
          nextConversations,
          nextSkills,
          nextSubagents,
          nextBrowserRuntime,
          nextSystemMonitor,
          nextLanguage,
          nextNotesRoots
        ] = await Promise.all([
          api.health(),
          api.listModels(),
          api.listAcpAgents(),
          api.listMcpServers(),
          api.listSshHosts(),
          api.listHostGroups(),
          api.listSshTunnels(),
          api.listApiRequests(),
          api.listApiGroups(),
          api.listApiHistory(),
          api.listScripts(),
          api.listScriptGroups(),
          api.listWorkspaces(),
          api.listConversations(),
          api.listSkills(),
          // ⚠️ 少了这一条，子任务开关保存成功也会显示未选中（用户报的 bug）：
          // `withRefresh` 的所有动作都靠**这一趟全量刷新**写回 store，漏刷新哪一项，
          // 那一项的 UI 就一直停在初始值（这里 subagentSettings 恒为 null → enabled 恒 []）。
          api.listSubagents(),
          // 内置浏览器装没装：决定工具条那颗开关显不显示（`runtime.installed`）
          api.getBrowserRuntime(),
          // 系统监控偏好同理：`saveSystemMonitorSettings` 也走 withRefresh，
          // 漏了这一条，关掉监控后状态栏的监控条不会消失（开关也会弹回去）。
          api.getSystemMonitorSettings(),
          // 界面语言：服务端是权威值（工具 / 提示词都按它生成）
          api.getLanguage(),
          // 笔记根目录清单：主路径是 WS 快照域推送，这里兜底对一次账（连接后 / 登记移除后）
          api.listNotesRoots()
        ])
        set({
          health: nextHealth,
          models: nextModels,
          acpAgents: nextAcpAgents,
          mcpServers: nextMcpServers,
          sshHosts: nextSshHosts,
          hostGroups: nextHostGroups,
          sshTunnels: nextSshTunnels.tunnels,
          tunnelRuntimes: nextSshTunnels.runtimes,
          apiRequests: nextApiRequests,
          apiGroups: nextApiGroups,
          apiHistory: nextApiHistory,
          scripts: nextScripts,
          scriptGroups: nextScriptGroups,
          workspaces: nextWorkspaces,
          conversations: nextConversations,
          conversationsLoaded: true,
          // 与主机清单同一次请求回来：置位后侧栏才允许把「空」读成空态
          hostsLoaded: true,
          skills: nextSkills,
          subagentSettings: nextSubagents.subagents,
          browserInstalled: nextBrowserRuntime.runtime.installed,
          systemMonitorSettings: nextSystemMonitor,
          language: nextLanguage.language,
          notesRoots: nextNotesRoots,
          error: null
        })
        // 服务端语言同步进本机 i18n 单例（工具 / 提示词已按它生成）
        setLanguage(nextLanguage.language)
        persistLanguage(nextLanguage.language)
        // 当前工作区被删 / 目录没了：退到第一个工作区。
        // ⚠️ 优先落**带目录**的：path 为空的内置「任务」虚拟工作区在侧栏里不显示，
        // 落到它上面的话，恢复逻辑会把它的旧会话偷偷打开 —— 用户看到的就是
        // 「项目里没有会话，消息却显示出来了」（实测）。
        //
        // `current === null`（用户没选项目）**保留**：那是一个真实意图（下一条消息会建
        // 临时工作区），替他落到某个项目上等于把「不指定项目」这个选择吃掉。
        const current = get().activeWorkspaceId
        if (current && !nextWorkspaces.some((w) => w.id === current && w.path)) {
          set({
            // 落到**真项目**上：临时工作区（scratch）是某条会话的私有目录，
            // 拿它当「当前项目」会让人接着往里建第二条会话
            activeWorkspaceId: nextWorkspaces.find((w) => w.path && !w.scratch)?.id ?? null
          })
        }
      } catch (err) {
        /**
         * token 失效（服务端重启换了密钥 / 在别处登出）：**走完整的 `disconnect()`**，
         * 不是只把 `connection` 置 null。
         *
         * 只置 null 会留下半截现场：`error` 还挂着这一轮的报错（登录页会把它当常驻 toast
         * 弹出来）、会话现场 / 队列 / 列表也都还在，下次连上别的服务端会去恢复不存在的 id。
         * `disconnect()` 里那套清场就是为这件事写的，这里别再造一份简化版。
         */
        if (err instanceof ApiError && err.status === 401) {
          get().disconnect()
          return
        }
        get().setError(errorMessage(err))
      } finally {
        get().setBusy(false)
      }
    },

    // 全局状态 WS：服务端改了就推，前端不再轮询。连上先收 `init` 全量快照，之后各域
    // 有变更只推对应 `snapshot`（新增 / 删除会话、改模型、工作区变化都实时反映）。
    bindStateWs: (): (() => void) => {
      initStateClient()
      const bindings: Array<[string, (v: unknown) => void]> = [
        ['health', (v) => set({ health: (v as HealthInfo | null) ?? null })],
        ['models', (v) => set({ models: (v as ModelView[]) ?? [] })],
        ['acpAgents', (v) => set({ acpAgents: (v as AcpAgentView[]) ?? [] })],
        ['mcpServers', (v) => set({ mcpServers: (v as McpServerConfig[]) ?? [] })],
        ['sshHosts', (v) => set({ sshHosts: (v as HostConfig[]) ?? [] })],
        ['hostGroups', (v) => set({ hostGroups: (v as HostGroup[]) ?? [] })],
        [
          'sshTunnels',
          (v) => {
            const snap = v as SshTunnelsSnapshot | null
            set({ sshTunnels: snap?.tunnels ?? [], tunnelRuntimes: snap?.runtimes ?? [] })
          }
        ],
        ['apiRequests', (v) => set({ apiRequests: (v as ApiRequestEntry[]) ?? [] })],
        ['apiGroups', (v) => set({ apiGroups: (v as ApiGroup[]) ?? [] })],
        ['apiHistory', (v) => set({ apiHistory: (v as ApiHistoryEntry[]) ?? [] })],
        ['scripts', (v) => set({ scripts: (v as ScriptEntry[]) ?? [] })],
        ['scriptGroups', (v) => set({ scriptGroups: (v as ScriptGroup[]) ?? [] })],
        ['workspaces', (v) => set({ workspaces: (v as AgentWorkspace[]) ?? [] })],
        ['conversations', (v) => set({ conversations: (v as ConversationSummary[]) ?? [] })],
        ['skills', (v) => set({ skills: (v as SkillListResult | null) ?? null })],
        // 笔记根目录：任意一端登记 / 移除都推给所有端（快照域，见 state-ws）
        ['notesRoots', (v) => set({ notesRoots: (v as NotesRoot[]) ?? [] })]
      ]
      const offs = bindings.map(([key, setter]) => {
        const apply = () => setter(getSnapshot(key))
        apply()
        return subscribe(key, apply)
      })
      return () => offs.forEach((off) => off())
    },

    // ---------- 会话清单 ----------
    renameConversation: async (id, title) => {
      const api = get().getApi()
      if (!api || !title.trim()) return
      try {
        set({ conversations: await api.renameConversation(id, title.trim()) })
      } catch (err) {
        get().setError(errorMessage(err))
      }
    },

    archiveConversation: async (id, archived) => {
      const api = get().getApi()
      if (!api) return
      try {
        set({ conversations: await api.archiveConversation(id, archived) })
      } catch (err) {
        get().setError(errorMessage(err))
      }
    },

    /**
     * 重启 acp 会话：只调服务端杀进程，**本地什么都不用改** ——
     * `acpSessionId` 与服务端会话配置都没变，消息也没变，重连发生在下一条消息里
     * （那时 entry 已不在，`runAcpAgent` 自然走 `session/load`）。
     */
    restartAcpSession: async (agentId, conversationId) => {
      const api = get().getApi()
      if (!api) return false
      try {
        const res = await api.restartAcpAgentSession(agentId, conversationId)
        if (!res.ok) {
          get().setError(res.error ?? '重启会话失败')
          return false
        }
        return true
      } catch (err) {
        get().setError(errorMessage(err))
        return false
      }
    },

    // ---------- 配置类动作 ----------
    saveAcpAgent: (input) => withRefresh(() => requireApi().saveAcpAgent(input)),
    deleteAcpAgent: (id) => withRefresh(() => requireApi().deleteAcpAgent(id)),
    saveAcpAgentModels: (agentId, models) => {
      const agent = get().acpAgents.find((a) => a.id === agentId)
      if (!agent) return Promise.resolve(false)
      return withRefresh(() =>
        requireApi().saveAcpAgent({
          id: agent.id,
          name: agent.name,
          command: agent.command,
          args: agent.args,
          models
        })
      )
    },
    saveMcpServer: (input) => withRefresh(() => requireApi().saveMcpServer(input)),
    deleteMcpServer: (id) => withRefresh(() => requireApi().deleteMcpServer(id)),
    saveSshHost: (input) => withRefresh(() => requireApi().saveSshHost(input)),
    deleteSshHost: (id) => withRefresh(() => requireApi().deleteSshHost(id)),
    // ---------- 主机分组（主机 / 终端共用的多级归类树） ----------
    //
    // **不刷全量列表**（与上面那批 `withRefresh` 不同）：这几个接口回的就是受影响的那
    // 两份数据（分组树 / 主机清单），直接写回 store 即可。拖拽重排是高频动作，为它跑
    // 一遍 `refresh()`（十几个接口）会让松手后的界面卡一下才跟上。
    saveHostGroup: async (input) => {
      try {
        set({ hostGroups: await requireApi().saveHostGroup(input) })
        return true
      } catch (err) {
        get().setError(errorMessage(err))
        return false
      }
    },
    deleteHostGroup: (id, deleteHosts) =>
      withHostTree(() => requireApi().deleteHostGroup(id, deleteHosts)),
    arrangeHosts: (input) => withHostTree(() => requireApi().arrangeHosts(input)),
    // 隧道：只写回快照（理由见 withTunnelSnapshot）
    saveSshTunnel: (input) => withTunnelSnapshot(() => requireApi().saveSshTunnel(input)),
    deleteSshTunnel: (id) => withTunnelSnapshot(() => requireApi().deleteSshTunnel(id)),
    startSshTunnel: (id) => withTunnelSnapshot(() => requireApi().startSshTunnel(id)),
    stopSshTunnel: (id) => withTunnelSnapshot(() => requireApi().stopSshTunnel(id)),
    // ---------- 接口请求（api-client） ----------
    saveApiRequest: (input) => withRefresh(() => requireApi().saveApiRequest(input)),
    deleteApiRequest: (id) => withRefresh(() => requireApi().deleteApiRequest(id)),
    /**
     * 批量新建（OpenAPI / Swagger 导入）。
     *
     * ⚠️ **刻意不用 `withRefresh` / `withApiTree` 这类壳**：一次导入可能几百条，
     * 而服务端每个写接口回的**就是最新的那两份清单**（`saveApiRequest` → 请求列表、
     * `saveApiGroup` → 分组列表），逐条 `refresh()` 等于 N × 十几个接口，几百条能跑几分钟，
     * 中途界面还被刷得乱跳。这里只在最后把两份清单写回 store 一次 —— 状态 WS 也会推，
     * 但那是异步的，写回是为了让「导入完成」这一刻列表就已经是对的。
     *
     * 请求**逐条串行**：每个应答都是「追加这条之后的全量列表」，并发跑会互相覆盖
     * （后到的旧列表会把前面的条目抹掉）。
     */
    importApiRequests: async (batch) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return []
      }
      try {
        // 1) 建分组：同名复用（重复导入同一份规格时不该长出第二棵同样的树）
        const groupIdByName = new Map<string, string>()
        let groups = get().apiGroups
        for (const name of batch.groups) {
          const existed = groups.find((g) => g.name === name)
          if (existed) {
            groupIdByName.set(name, existed.id)
            continue
          }
          groups = await api.saveApiGroup({ name })
          const created = groups.find((g) => g.name === name)
          if (created) groupIdByName.set(name, created.id)
        }
        set({ apiGroups: groups })

        // 2) 建请求：认领这批新增的（用来回给界面「打开第一条」）
        const prevIds = new Set(get().apiRequests.map((r) => r.id))
        let requests = get().apiRequests
        for (const item of batch.entries) {
          requests = await api.saveApiRequest({
            // id 空 = 新建（时间戳由服务端盖）；`item.entry` 里没有这三个字段，不会互相覆盖
            id: '',
            createdAt: 0,
            updatedAt: 0,
            ...item.entry,
            // 分组名 → 真实 id；解析不出来（理论上不会）就留未分组，别把请求丢掉
            groupId: item.group ? groupIdByName.get(item.group) : undefined
          })
        }
        set({ apiRequests: requests })
        return requests.filter((r) => !prevIds.has(r.id))
      } catch (err) {
        get().setError(errorMessage(err))
        return []
      }
    },
    arrangeApi: (input) => withRefresh(() => requireApi().arrangeApi(input)),
    saveApiGroup: (input) => withRefresh(() => requireApi().saveApiGroup(input)),
    deleteApiGroup: (id, deleteRequests) =>
      withRefresh(() => requireApi().deleteApiGroup(id, deleteRequests)),
    /**
     * 覆盖写入整段历史。**不刷列表** —— 历史是滑动窗口，界面在发送成功时已乐观更新，
     * 这里只负责落盘；失败写 error 即可，把列表刷回旧值反而会让用户刚看到的那条记录消失。
     */
    saveApiHistory: async (entries) => {
      const api = get().getApi()
      if (!api) return false
      try {
        await api.saveApiHistory(entries)
        return true
      } catch (err) {
        get().setError(errorMessage(err))
        return false
      }
    },
    clearApiHistory: () => withRefresh(() => requireApi().clearApiHistory()),
    // ---------- 主机脚本（scripts） ----------
    saveScript: (input) => withRefresh(() => requireApi().saveScript(input)),
    deleteScript: (id) => withRefresh(() => requireApi().deleteScript(id)),
    arrangeScripts: (input) => withRefresh(() => requireApi().arrangeScripts(input)),
    saveScriptGroup: (input) => withRefresh(() => requireApi().saveScriptGroup(input)),
    deleteScriptGroup: (id, deleteScripts) =>
      withRefresh(() => requireApi().deleteScriptGroup(id, deleteScripts)),
    // ---------- 数据导入 / 导出（左下角菜单） ----------
    /**
     * 导出：**不刷列表** —— 只是把库里的数据读出来打包，一个字段都没动。
     * 失败写 error 并返回 null（界面据此提示，不用去猜 error 文案）。
     */
    exportTransferData: async (input) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return null
      }
      try {
        return await api.exportTransfer(input)
      } catch (err) {
        get().setError(errorMessage(err))
        return null
      }
    },
    /** 解析导入包看摘要：同样**不刷列表**（服务端一个字都没写） */
    inspectTransferData: async (input) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return null
      }
      try {
        return await api.inspectTransfer(input)
      } catch (err) {
        get().setError(errorMessage(err))
        return null
      }
    },
    /**
     * 执行导入：**成功刷全量列表**（一次可能同时动了接口请求 / 主机 / 脚本三份数据，
     * 逐项写回容易漏一项、界面就一直停在旧值 —— 同 `withRefresh` 那段注释的教训）。
     * 但这里不能直接用 `withRefresh`：它的返回值被压成了 `boolean`，而界面要的是统计数字。
     */
    applyTransferData: async (input) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return null
      }
      try {
        const result = await api.applyTransfer(input)
        await get().refresh()
        return result
      } catch (err) {
        get().setError(errorMessage(err))
        return null
      }
    },
    /**
     * 执行一次请求：拿回完整结果（状态码 / 耗时 / 响应体）交给调用方展示。
     * 网络层失败也在结果里（`status: 0 + error`），只有抛异常（如未连接）才兜底成
     * 同形状的空结果，让调用方永远只处理一条「拿到结果」的路径。
     */
    sendApiRequest: async (input) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return { ok: false, status: 0, statusText: '', headers: {}, body: '', timeMs: 0 }
      }
      try {
        return await api.sendApiRequest(input)
      } catch (err) {
        get().setError(errorMessage(err))
        return { ok: false, status: 0, statusText: '', headers: {}, body: '', timeMs: 0, error: errorMessage(err) }
      }
    },
    abortApiRequest: async (sendId) => {
      const api = get().getApi()
      if (!api) return
      // 取消本身不该再弹错（用户主动中止 / 请求已结束都属正常）
      try {
        await api.abortApiRequest(sendId)
      } catch {
        /* 静默 */
      }
    },
    /**
     * 解析远端路径。未连接时抛错：调用方要把它显示在拖拽上传确认条的「连接失败」态里
     * （静默返回空串会让人以为「目录就是空的」）。
     */
    sftpRealpath: async (hostId, path) => {
      const api = get().getApi()
      if (!api) throw new Error('未连接服务端')
      return await api.sftpRealpath(hostId, path)
    },
    /**
     * SFTP 文件管理的读写动作：统一「没连上服务端就抛错」这一档，调用方不必各自判一遍
     * `api` 是不是 null。未连接抛错而不是静默返回空 —— 面板要把它显示成错误态，
     * 静默返回空列表会让人以为「目录是空的」。
     */
    sftpList: async (hostId, path) => requireApi().sftpList(hostId, path),
    sftpMkdir: async (hostId, path) => requireApi().sftpMkdir(hostId, path),
    sftpRename: async (hostId, from, to) => requireApi().sftpRename(hostId, from, to),
    sftpRemove: async (hostId, path) => requireApi().sftpRemove(hostId, path),
    sftpCopy: async (hostId, from, to) => requireApi().sftpCopy(hostId, from, to),
    sftpMove: async (hostId, from, to) => requireApi().sftpMove(hostId, from, to),
    saveModel: (input) => withRefresh(() => requireApi().saveModel(input)),
    deleteModel: (id) => withRefresh(() => requireApi().deleteModel(id)),
    toggleSkill: (id, enabled) => {
      const s = get().skills?.settings ?? { disabled: [], extraDirs: [] }
      const next = enabled ? s.disabled.filter((x) => x !== id) : [...new Set([...s.disabled, id])]
      // extraDirs 也要一起带上：服务端按**全量**语义写，漏传会被清空
      return withRefresh(() => requireApi().saveSkills(next, s.extraDirs))
    },
    /**
     * 全量保存「额外技能发现目录」。`dirs` 是完整清单（与 toggleSkill 同款全量语义），
     * 增 / 删都由调用方算好新清单 —— 加目录会改变扫到的技能，所以要整表刷新。
     */
    setSkillDirs: (dirs) => {
      const disabled = get().skills?.settings.disabled ?? []
      return withRefresh(() => requireApi().saveSkills(disabled, dirs))
    },
    toggleSubagent: (id, enabled) => {
      const enabledIds = get().subagentSettings?.enabled ?? []
      const next = enabled ? [...new Set([...enabledIds, id])] : enabledIds.filter((x) => x !== id)
      return withRefresh(() => requireApi().saveSubagents({ enabled: next }))
    },
    setSubagentModel: (model) =>
      withRefresh(() =>
        requireApi().saveSubagents(
          model
            ? { modelConfigId: model.configId, modelId: model.modelId }
            : { modelConfigId: null, modelId: null }
        )
      ),
    setSubagentMaxSteps: (id, steps) => {
      const next = { ...(get().subagentSettings?.maxSteps ?? {}) }
      // null = 恢复默认：**删掉这个 key** 而不是写 null（服务端只认数字）
      if (steps === null) delete next[id]
      else next[id] = steps
      return withRefresh(() => requireApi().saveSubagents({ maxSteps: next }))
    },
    /**
     * 系统监控偏好：与浏览器偏好同款 —— 原样透传要改的字段（服务端「缺字段 = 保留」），
     * 保存成功后服务端会同步采样器启停，`withRefresh` 再把新的 `systemMonitorSettings`
     * 写回 store（app-shell 据此决定要不要渲染监控条）。
     */
    /**
     * 保存界面语言：先让本机界面立刻切过去（乐观更新），再写服务端。
     * 服务端成功返回归一化后的值，以它为准；失败则把错误写进全局 error，但本机选择保留。
     */
    saveLanguage: async (language) => {
      setLanguage(language)
      persistLanguage(language)
      set({ language })
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return false
      }
      try {
        const saved = await api.saveLanguage(language)
        setLanguage(saved.language)
        persistLanguage(saved.language)
        set({ language: saved.language, error: null })
        return true
      } catch (err) {
        get().setError(errorMessage(err))
        return false
      }
    },
    saveSystemMonitorSettings: (patch) =>
      withRefresh(() => requireApi().saveSystemMonitorSettings(patch)),
    addWorkspace: async (input) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return null
      }
      try {
        const workspace = await api.addWorkspace(input)
        await get().refresh()
        return workspace
      } catch (err) {
        get().setError(errorMessage(err))
        return null
      }
    },
    cloneWorkspace: async (input) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return null
      }
      try {
        const result = await api.cloneWorkspace(input)
        // 取消 / 转到后台：都是正常结局，不刷列表、不写 error
        if ('canceled' in result || 'detached' in result) return null
        await get().refresh()
        return result
      } catch (err) {
        get().setError(errorMessage(err))
        return null
      }
    },
    /**
     * 取消后台任务。刻意**吞掉错误**：取消是用户的正常操作，服务端也做成幂等，
     * 这里再抛一个「取消失败」只会让用户点完取消又看到一个报错。
     */
    cancelBackgroundTask: async (id) => {
      const api = get().getApi()
      if (!api) return
      try {
        await api.cancelBackgroundTask(id)
      } catch {
        // 见上：克隆那边收场时会自己更新状态，不必打扰用户
      }
    },
    /** 转到后台：同样吞错（失败时任务仍在跑，最多是等待方没立刻收包） */
    detachBackgroundTask: async (id) => {
      const api = get().getApi()
      if (!api) return
      try {
        await api.detachBackgroundTask(id)
      } catch {
        // 见上
      }
    },
    /**
     * 新建容器型项目。
     *
     * 与 `cloneWorkspace` 逐字同款（服务端可能还要 clone，也可能是几秒的登记动作）：
     * 成功刷新列表并回工作区，失败把服务端的人话原因落进 `app.error` 并回 null。
     */
    createContainerProject: async (input) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return null
      }
      try {
        const workspace = await api.createContainerProject(input)
        await get().refresh()
        return workspace
      } catch (err) {
        get().setError(errorMessage(err))
        return null
      }
    },
    /** 改容器型项目（改名 / 换镜像 / 预览端口 / 发布开关）—— 成功后刷新列表 */
    updateContainerProject: async (id, input) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return false
      }
      try {
        await api.updateContainerProject(id, input)
        await get().refresh()
        return true
      } catch (err) {
        get().setError(errorMessage(err))
        return false
      }
    },
    renameWorkspace: (id, name) => withRefresh(() => requireApi().renameWorkspace(id, name)),
    deleteWorkspace: (id, options) =>
      withRefresh(() => requireApi().deleteWorkspace(id, options)),

    // ---------- 只读探测 / 无状态动作 ----------
    probeAcpModels: (agentId) => requireApi().probeAcpModels(agentId),
    detectAcpAgents: () => requireApi().detectAcpAgents(),
    listMcpTools: () => requireApi().listMcpTools(),
    probeMcpServerTools: (id) => requireApi().probeMcpServerTools(id),
    probeUpstreamModels: async (input) => {
      const res = await requireApi().probeUpstreamModels(input)
      return res.models
    },
    reloadSkills: async () => {
      const api = get().getApi()
      if (!api) return
      try {
        set({ skills: await api.listSkills() })
      } catch (err) {
        get().setError(errorMessage(err))
      }
    },
    listAcpAgentSessions: (agentId, cwd) => {
      const api = get().getApi()
      if (!api) return Promise.resolve({ supported: false, sessions: [] } as Awaited<ReturnType<AgentApi['listAcpAgentSessions']>>)
      return api.listAcpAgentSessions(agentId, cwd).catch(() => ({ supported: false, sessions: [] } as Awaited<ReturnType<AgentApi['listAcpAgentSessions']>>))
    },
    listAcpAgentModes: (agentId, conversationId) => {
      const api = get().getApi()
      if (!api) return Promise.resolve({ supported: false, modes: [], currentModeId: null } as Awaited<ReturnType<AgentApi['listAcpAgentModes']>>)
      return api.listAcpAgentModes(agentId, conversationId).catch(() => ({ supported: false, modes: [], currentModeId: null } as Awaited<ReturnType<AgentApi['listAcpAgentModes']>>))
    },
    setAcpAgentMode: async (agentId, conversationId, modeId) => {
      const api = get().getApi()
      if (!api) return { ok: false, error: '未连接服务端' }
      // 乐观更新：先把会话里记的当前档切过去（界面立刻反映），失败回滚。
      // 服务端会持久化并标脏，WS 推来的权威快照随后覆盖这里。
      const prev = get().conversations.find((c) => c.id === conversationId)?.acpModes
      if (prev) {
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, acpModes: { ...prev, current: modeId } } : c
          )
        }))
      }
      const res = await api
        .setAcpAgentMode(agentId, conversationId, modeId)
        .catch((err) => ({ ok: false, error: errorMessage(err) }))
      if (!res.ok && prev) {
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, acpModes: prev } : c
          )
        }))
      }
      return res
    },
    setAcpThoughtLevel: async (agentId, conversationId, value) => {
      const api = get().getApi()
      if (!api) return { ok: false, error: '未连接服务端' }
      const prev = get().conversations.find((c) => c.id === conversationId)?.acpThoughtLevel
      if (prev) {
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, acpThoughtLevel: { ...prev, current: value } } : c
          )
        }))
      }
      const res = await api
        .setAcpAgentThoughtLevel(agentId, conversationId, value)
        .catch((err) => ({ ok: false, error: errorMessage(err) }))
      if (!res.ok && prev) {
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, acpThoughtLevel: prev } : c
          )
        }))
      }
      return res
    },
    deleteAcpAgentSession: (agentId, sessionId) => {
      const api = get().getApi()
      if (!api) return Promise.resolve({ ok: false, supported: true, error: '未连接服务端' } as Awaited<ReturnType<AgentApi['deleteAcpAgentSession']>>)
      return api.deleteAcpAgentSession(agentId, sessionId).catch((err) => ({ ok: false, supported: true, error: errorMessage(err) } as Awaited<ReturnType<AgentApi['deleteAcpAgentSession']>>))
    },
    listWorkspaceFiles: async (workspaceId, dir = '', includeIgnored = false) => {
      const api = get().getApi()
      if (!api || !workspaceId) return { entries: [] }
      try {
        return await api.listWorkspaceFiles(workspaceId, dir, includeIgnored)
      } catch {
        return { entries: [] }
      }
    },
    readWorkspaceFile: async (workspaceId, path) => {
      const api = get().getApi()
      if (!api || !workspaceId) return null
      try {
        return await api.readWorkspaceFile(workspaceId, path)
      } catch {
        return null
      }
    },
    writeWorkspaceFile: async (workspaceId, path, content) => {
      const api = get().getApi()
      if (!api || !workspaceId) return '未连接'
      try {
        await api.writeWorkspaceFile(workspaceId, path, content)
        return null
      } catch (err) {
        return errorMessage(err)
      }
    },
    scaffoldWorkspaceFile: async (workspaceId, input) => {
      const api = get().getApi()
      if (!api || !workspaceId) return '未连接'
      try {
        return await api.scaffoldWorkspaceFile(workspaceId, input)
      } catch (err) {
        return errorMessage(err)
      }
    },
    fetchWorkspaceMedia: async (workspaceId, path) => {
      const api = get().getApi()
      if (!api || !workspaceId) return null
      try {
        return await api.fetchWorkspaceMedia(workspaceId, path)
      } catch {
        return null
      }
    },
    downloadWorkspaceFile: async (workspaceId, path, fileName, isDir) => {
      const api = get().getApi()
      if (!api || !workspaceId) return '未连接'
      try {
        return await api.downloadWorkspaceFile(workspaceId, path, fileName, isDir)
      } catch (err) {
        return errorMessage(err)
      }
    },
    /**
     * 删除工作区里的文件或目录（递归）。
     *
     * 文件树不进 store（按需拉），所以这里**不必**刷列表 —— 面板自己 `refresh()`。
     * 出错时把服务端原话写进 error（顶栏横幅），同时返回给调用方 toast。
     */
    deleteWorkspaceFile: async (workspaceId, path): Promise<WorkspaceWriteResult> => {
      const api = get().getApi()
      if (!api || !workspaceId) {
        get().setError('未连接服务端')
        return { ok: false, error: '未连接服务端' }
      }
      try {
        await api.deleteWorkspaceFile(workspaceId, path)
        return { ok: true }
      } catch (err) {
        const message = errorMessage(err)
        get().setError(message)
        return { ok: false, error: message }
      }
    },
    /**
     * 复制工作区里的文件或目录到指定父目录。
     * 成功带新条目相对路径；目标存在同名时服务端 409，原样带回来。
     */
    copyWorkspaceFile: async (workspaceId, path, dest): Promise<WorkspaceWriteResult> => {
      const api = get().getApi()
      if (!api || !workspaceId) {
        get().setError('未连接服务端')
        return { ok: false, error: '未连接服务端' }
      }
      try {
        const res = await api.copyWorkspaceFile(workspaceId, path, dest)
        return { ok: true, path: res.path }
      } catch (err) {
        const message = errorMessage(err)
        get().setError(message)
        return { ok: false, error: message }
      }
    },
    /**
     * 移动 / 重命名工作区里的文件或目录到指定父目录。
     * 成功带新条目相对路径；目标存在同名时服务端 409，原样带回来。
     * 传 `name` = 重命名（只换最后一段）。
     */
    moveWorkspaceFile: async (workspaceId, path, dest, name): Promise<WorkspaceWriteResult> => {
      const api = get().getApi()
      if (!api || !workspaceId) {
        get().setError('未连接服务端')
        return { ok: false, error: '未连接服务端' }
      }
      try {
        const res = await api.moveWorkspaceFile(workspaceId, path, dest, name)
        return { ok: true, path: res.path }
      } catch (err) {
        const message = errorMessage(err)
        get().setError(message)
        return { ok: false, error: message }
      }
    },
    gitStatus: (workspaceId) => requireApi().gitStatus(workspaceId),
    gitBranches: (workspaceId, prune) => requireApi().gitBranches(workspaceId, prune),
    gitLog: (workspaceId, limit = 30) =>
      requireApi()
        .gitLog(workspaceId, limit)
        .then((r) => r.commits),
    gitDiff: (workspaceId, path, staged) => requireApi().gitDiff(workspaceId, path, staged),
    gitCommit: (workspaceId, hash) => requireApi().gitCommit(workspaceId, hash),
    gitAction: (workspaceId, input) =>
      requireApi()
        .gitAction(workspaceId, input)
        .then((r) => r.output),
    createWorktree: async (workspaceId, input) => {
      const api = get().getApi()
      if (!api) return null
      try {
        const created = await api.createWorktree(workspaceId, input)
        await get().refresh()
        return created
      } catch (err) {
        get().setError(errorMessage(err))
        return null
      }
    },
    scanWorktrees: (workspaceId) => requireApi().scanWorktrees(workspaceId),
    loadWorktree: async (workspaceId, input) => {
      const api = get().getApi()
      if (!api) return null
      try {
        const created = await api.loadWorktree(workspaceId, input)
        await get().refresh()
        return created
      } catch (err) {
        get().setError(errorMessage(err))
        return null
      }
    },
    listServerDirs: (path) => requireApi().listServerDirs(path),
    createServerDir: (parent, name) =>
      requireApi()
        .createServerDir({ parent, name })
        .then((res) => res.path),
    /**
     * 这台机器上有哪些 shell（终端面板「选择终端」下拉用）。
     *
     * ⚠️ 未连接时必须返回**被拒绝的 Promise**，不能同步抛 ——
     * 调用方是 `void listTerminalShells().catch(...)`，同步抛出它接不住，应用会直接崩。
     */
    listTerminalShells: () => {
      const api = get().getApi()
      return api ? api.listTerminalShells() : Promise.reject(new Error('未连接服务端'))
    },

    // ---------- 笔记（登记目录 + 管理其中的 Markdown） ----------
    /**
     * 登记一个目录为笔记根。成功**刷一遍全量列表**（与其他配置类动作一致）——
     * 清单是快照域，WS 也会推，但那是异步的，刷一次能让「刚加的那条」立刻在侧栏出现。
     */
    addNotesRoot: async (input) => {
      const api = get().getApi()
      if (!api) {
        get().setError('未连接服务端')
        return null
      }
      try {
        const root = await api.addNotesRoot(input)
        await get().refresh()
        return root
      } catch (err) {
        get().setError(errorMessage(err))
        return null
      }
    },
    removeNotesRoot: (id) => withRefresh(() => requireApi().removeNotesRoot(id)),
    // 文件操作是**一问一答**：原样透传 api 的 Promise（错误抛给调用方 —— 树 / 编辑器
    // 要显示「为什么没读出来」，在这里吞掉就只剩一句「加载失败」）。
    listNoteFiles: (rootId, dir = '') => requireApi().listNoteFiles(rootId, dir),
    readNoteFile: (rootId, path) => requireApi().readNoteFile(rootId, path),
    writeNoteFile: (rootId, path, content) => requireApi().writeNoteFile(rootId, path, content),
    createNoteFile: (rootId, dir = '') => requireApi().createNoteFile(rootId, dir),
    renameNoteFile: (rootId, path, name) => requireApi().renameNoteFile(rootId, path, name),
    deleteNoteFile: (rootId, path) => requireApi().deleteNoteFile(rootId, path)
  }
}
