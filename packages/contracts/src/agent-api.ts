/**
 * Agent HTTP API 契约：server 实现它，web / cli 消费它 —— 三端唯一真源。
 *
 * 刻意**复用桌面端的领域类型**（`AgentWorkspace` / `AgentConversation` /
 * `AiModelConfig` / `AgentStreamEvent`）：同一份配置在三个端下必须是同样的形状，
 * 否则界面逻辑要写三遍、还会漂。
 *
 * 流式对话走 SSE：每条帧的 data 就是 `ChatStreamFrame`（内含桌面端同款
 * `AgentStreamEvent`）。不用 WebSocket 是因为对话是**单向流**，SSE 天然支持
 * 断线重连与事件 id，且能直接穿过反向代理。
 */
import type {
  AcpModesState,
  AcpPermissionMode,
  AcpThoughtLevelState,
  AgentChatMessage,
  AgentConfirmRequest,
  AgentConversation,
  AgentBackend,
  AgentFsEntry,
  AgentFsFile,
  AgentMessagePart,
  AgentStreamEvent,
  AgentWorkspace,
  CollabSettings,
  CollabState,
  ContainerProjectConfig,
  SubagentSettings,
  AiApiStyle,
  AiModelConfig,
  AiModelEntry,
  AiModelSettings,
  AiPermissionMode,
  AiProviderKind,
  AiReasoningEffort,
  AskFollowupRequest,
  ConversationContextSummary,
  FollowupAnswerItem,
  QueuedMessage,
  UploadFileRef,
} from "./types";
// 域类型已迁到各自的包（类型真源）；这里的 HTTP DTO 组合它们时用 type-only 引用，
// 编译期擦除，不会让 contracts 产生对这些包的运行时依赖。
import type {
  AcpAgentConfig,
  AcpAgentType,
  AcpAllowStrategy,
  AcpModelOption,
} from "@fizz/acp";
import type { McpToolInfo } from "@fizz/mcp";
import type { SkillListResult } from "@fizz/skills";
// 浏览器偏好是「前后端共用 + 浏览器安全」的契约，真源在 ./browser（渲染端面板也在用它）
import type { BrowserRuntime, BrowserSettings } from "./browser";

/** 所有接口都挂在这个前缀下（反代好配） */
export const API_PREFIX = "/api";

/** `POST /api/auth/password` 的请求体 */
export interface ChangePasswordInput {
  /** 当前密码；服务端还没设置过密码时可以为空 */
  currentPassword: string;
  /** 新密码（不能为空） */
  newPassword: string;
}

/** `POST /api/auth/password` 的成功应答 */
export interface ChangePasswordResult {
  ok: true;
}

export const API_ROUTES = {
  health: "/api/health",
  /**
   * 修改登录密码（单用户）：POST /api/auth/password，body `ChangePasswordInput`。
   * 需要已登录（桌面端进程内直连天然满足）；服务端校验旧密码后只保存新密码的哈希。
   */
  authPassword: "/api/auth/password",
  models: "/api/models",
  /**
   * 向模型上游要一份「可选模型清单」（设置页 →「从上游拉取」）：
   * POST /api/models/probe（body: `UpstreamModelsInput`）
   *
   * 为什么走服务端而不是浏览器直连：apiKey 不出服务端；而且部署在服务器上时，
   * 只有服务端能连到内网网关（Ollama / vLLM / one-api 这类）。
   * 各家的 /models 长什么样见 `@fizz/agent` 的 `probeUpstreamModels`。
   */
  modelsProbe: "/api/models/probe",
  workspaces: "/api/workspaces",
  /**
   * 从 Git 导入项目：POST /api/workspaces/clone（body: `WorkspaceCloneInput`）
   *
   * 服务端 `git clone` 远端仓库到 `parentDir/<目录名>` 并登记成工作区，返回新工作区。
   * 目标目录已存在时拒绝；克隆失败（网络 / 认证 / 仓库不存在）把 git 的原话带回。
   *
   * 这趟克隆同时登记成一条后台任务（id = `cloneId`），所以除了本请求，还能从
   * `backgroundTasks` 那一组接口里看进度 / 取消 / 转到后台。
   */
  workspaceClone: "/api/workspaces/clone",
  /**
   * 后台任务列表：`GET` 取列表、`DELETE` 清掉全部已结束的（body: `BackgroundTasksResult`）。
   *
   * 服务端进程内保存（`apps/server/src/server/background-tasks.ts`），刷新页面还在、
   * 重启服务即消失 —— 跑在进程里的活本来就活不过进程。
   */
  backgroundTasks: "/api/background-tasks",
  /**
   * 单条后台任务：
   * - `GET` → `BackgroundTaskDetail`（任务 + 保留的日志行；日志只在展开某一行时才拉）
   * - `DELETE` → 关掉一条已结束的任务（运行中的回 409）
   */
  backgroundTask: "/api/background-tasks/:id",
  /** 取消一条还在跑的后台任务（杀进程 + 清半成品），回包时清理已做完 */
  backgroundTaskCancel: "/api/background-tasks/:id/cancel",
  /**
   * 把一条还在跑的后台任务「转到后台」：只断开**等待方**（那条 HTTP 请求立刻回包），
   * 任务本身继续跑。与 cancel 的区别是「人不等了」vs「活别干了」。
   */
  backgroundTaskDetach: "/api/background-tasks/:id/detach",
  /**
   * 某个项目下的 worktree 集合：
   * - POST /api/workspaces/:id/worktree（body: `WorktreeInput`）＝ 新建一个
   * - GET  /api/workspaces/:id/worktree ＝ 扫描磁盘上既有的（`WorktreeScanEntry[]`）
   *
   * `:id` = 源项目（工作区）id；worktree 目录固定落在
   * `<源项目目录>/.worktree/<标识>`，分支从指定基线分支新建。
   */
  workspaceWorktree: "/api/workspaces/:id/worktree",
  /**
   * 把 `.worktree/` 下**已经存在**的目录登记成一个 worktree 项目：
   * POST /api/workspaces/:id/worktree/load（body: `WorktreeLoadInput`）
   */
  workspaceWorktreeLoad: "/api/workspaces/:id/worktree/load",
  /** 工作区目录配置（快捷功能）：GET/PUT /api/workspace-config/:workspaceId */
  workspaceConfig: "/api/workspace-config/:id",
  /**
   * 容器型项目（目录由系统分配、打开即起独立容器）。
   *
   * - `GET  /api/container-projects` —— 容器型项目快照（应答 `{ snapshot: ContainerProjectsSnapshot }`）；
   * - `POST /api/container-projects` —— 创建（body: `ContainerProjectCreateInput`，应答 201 + `AgentWorkspace`）。
   *
   * 快照里的 `available` 表示服务端是否具备该能力（docker 可用）——
   * `false` 时前端**整块不渲染**，桌面端因此天然拿到「服务端专属」。
   */
  containerProjects: "/api/container-projects",
  /** 改名 / 换镜像 / 公网访问开关：PATCH /api/container-projects/:id（body: `ContainerProjectUpdateInput`） */
  containerProjectUpdate: "/api/container-projects/:id",
  /** 确保容器在跑（幂等 + 合并并发）：POST /api/container-projects/:id/start */
  containerProjectStart: "/api/container-projects/:id/start",
  /** 停容器（不删，端口映射留着）：POST /api/container-projects/:id/stop */
  containerProjectStop: "/api/container-projects/:id/stop",
  /**
   * 强制重建容器（同镜像也重建）：停 → 删 → 起。
   * POST /api/container-projects/:id/rebuild
   *
   * 与「换镜像」的区别：换镜像走 PATCH，靠 `image` 变了触发重建；这个不依赖配置变化，
   * 用于「镜像重建后让项目真正用上新镜像」与「容器被弄脏了重置」。
   */
  containerProjectRebuild: "/api/container-projects/:id/rebuild",
  /**
   * 重新探测 docker 引擎并推一次容器项目快照：POST /api/container-projects/docker/retry
   *
   * 给「连不上 docker 引擎」那张卡片上的「重试」用：服务端会清掉探测缓存（含
   * `dockerVersion` 的成功缓存）后现问一次 daemon，用户把 Docker Desktop 起来之后
   * 立刻见效，不用等那 60s 的失败缓存过期。
   */
  containerProjectDockerRetry: "/api/container-projects/docker/retry",
  /**
   * 容器镜像状态（设置页「容器」）：
   * - `GET  /api/container-images` —— `ContainerImagesSnapshot`
   * - `POST /api/container-images/:env/build` —— 强制重建某个镜像（`:env` = 环境 id 或 `base`）
   *
   * 构建是长任务：POST **立即返回**当前快照（`building: true`），前端轮询 GET 拿进度与日志。
   */
  containerImages: "/api/container-images",
  containerImageBuild: "/api/container-images/:env/build",
  /** 浏览服务端目录（只列子目录）：GET /api/fs/dirs?path=绝对路径（空 = 从用户主目录起） */
  fsDirs: "/api/fs/dirs",
  /**
   * 在服务端某个目录下新建文件夹：POST /api/fs/mkdir（body: `FsMkdirInput`）
   *
   * 给 web 端「选服务端目录」弹窗用：浏览器只能「看见」服务端目录，想在工作区下开个新目录
   * 就得让 server 代劳 —— 否则用户得先登到那台机器上 mkdir 再回来选。
   */
  fsMkdir: "/api/fs/mkdir",
  /**
   * 笔记（登记任意目录，管理其中的 Markdown）。
   *
   * 请求 / 应答 DTO 见 `./types` 的「笔记」段（`NotesRoot` / `NotesDirResult` /
   * `NotesWriteInput` 等）—— 这组类型和实体定义放在一处，不在本文件重复一份。
   *
   * - `GET /api/notes/roots` —— 列已登记的根目录（应答 `NotesRoot[]`）；
   * - `POST /api/notes/roots` —— 登记一个目录（body: `NotesRootInput`）；
   * - `DELETE /api/notes/roots/:id` —— 移除登记（**只摘登记，不动磁盘**）；
   * - `GET /api/notes/files?rootId=&dir=` —— 列某一层（应答 `NotesDirResult`）；
   * - `GET /api/notes/file?rootId=&path=` —— 读一篇（应答 `NotesFileResult`）；
   * - `POST /api/notes/file` —— 写一篇（body: `NotesWriteInput`）；
   * - `POST /api/notes/file/new` —— 新建空笔记（body: `NotesCreateInput`）；
   * - `POST /api/notes/file/rename` —— 重命名（body: `NotesRenameInput`）；
   * - `DELETE /api/notes/file?rootId=&path=` —— 删除。
   *
   * ⚠️ 每个文件操作都只在**登记过的根**内部生效（`resolveInside`），且只放行
   * `.md` / `.markdown`。这**不是**一组通用文件读写接口 —— 别拿它去读工作区之外的东西。
   */
  notesRoots: "/api/notes/roots",
  notesRoot: "/api/notes/roots/:id",
  notesFiles: "/api/notes/files",
  notesFile: "/api/notes/file",
  notesFileNew: "/api/notes/file/new",
  notesFileRename: "/api/notes/file/rename",
  /**
   * AI 助手(跨项目的轻量对话,**不进会话树、服务端不落盘**):
   *
   * - POST /api/assistant(body: `AssistantSendInput`)＝ 发一句话,返回 SSE
   *   (帧协议与 /api/chat 完全一致);
   * - **没有会话清单 / 新建 / 删除端点** —— 助手不需要「多会话」这个概念:
   *   每次打开面板就是一个新会话,历史由客户端随请求带上(`history`),
   *   服务端只把它当成一次无状态的对话执行(见 `assistant-turn.ts`)。
   * - 审批复用 POST /api/chat/confirm(run 与审批注册表都是共享单例)。
   */
  assistantSend: "/api/assistant",
  conversations: "/api/conversations",
  /**
   * 搜会话（标题 + 消息正文）：GET /api/conversations/search?q=关键词&limit=N
   *
   * ⚠️ 路径必须放在 `/api/conversations/:id/...` **之前**匹配 —— Next 的路由按具体度
   * 排序，`search` 会先于 `[id]` 命中；若写成 `/api/conversations/:id/search` 则多一个段。
   */
  conversationSearch: "/api/conversations/search",
  /**
   * 用量汇总：GET /api/usage?days=30&limit=20
   *
   * 放在 `/api/usage` 而不是 `/api/conversations/usage` —— 它不只统计对话，
   * 形状上也更像一个「看板」接口（按天 + 按会话），将来接任务用量时不用改名。
   */
  usage: "/api/usage",
  /**
   * 服务器性能监控快照：GET /api/system（可选 `?detail=1` 展开磁盘）
   *
   * 数据由服务端一个常驻采样器用 **Node 内置 API**（`node:os` / `fs.statfs`）采集
   * （跨 Windows / Linux，无子进程，见 `lib/server/services/system-monitor.ts`）——
   * 这个接口本身不再直接采，免得和采样器的 CPU 基准抢节奏。返回当前快照 + 一小段历史（画曲线用）。
   */
  system: "/api/system",
  /**
   * 系统监控 + 任务管理器：GET /api/system/tasks → `SystemTaskList`（进程清单）。
   *
   * ⚠️ 与上面的 `/api/system` **不是一条采集通路**：那个是「常驻采样器 + 快照」，
   * 只用 `node:os`、零子进程，服务状态栏那颗徽标每 2s 读它；这一条是**按需**的，
   * 每请求现采一次进程表（`ps` / `tasklist`），只为「打开任务管理器标签页」这件事服务。
   * 两条互不影响：关掉监控条不会让任务管理器变空，反之亦然。
   */
  systemTasks: "/api/system/tasks",
  /**
   * 结束一个进程：POST `/api/system/tasks/kill`（body: `SystemTaskKillInput`）→
   * `SystemTaskKillResult`。
   *
   * **成功与失败都回 200**：`ok: false` 是业务失败（进程已退出 / 权限不足 / 不允许杀自己），
   * 界面把 `error` 原样弹出来即可 —— 给它配一个 4xx 只会让前端多写一层错误分支。
   */
  systemTaskKill: "/api/system/tasks/kill",
  /**
   * 服务器性能监控偏好（总开关）：GET / POST `/api/system/settings` →
   * `SystemMonitorSettings`（POST 不传 `enabled` = 保留原样）。
   *
   * ⚠️ 与上面的 `/api/system`（只读监控快照）是两个路径：这条读写偏好。关掉后
   * 服务端采样器**立即停**（省掉每 ~2s 一次的采集开销），状态栏也不再渲染监控条。
   */
  systemSettings: "/api/system/settings",
  /**
   * 界面语言（全局一份）：GET / POST `/api/system/language`。
   *
   * POST body: `{ language: AppLanguage }`，返回归一化后的 `{ language }`。
   * 服务端在构建工具描述 / 系统提示词前读同一份设置。
   */
  systemLanguage: "/api/system/language",
  /**
   * **客户端偏好的统一入口**（全局一份）：GET / POST `/api/prefs`。
   *
   * GET  → `PrefsResult`（服务端归一化后的**全量**一份，见 `./prefs` 的 `PREF_KEYS`）；
   * POST → body `{ prefs: PrefsPatch }`，**只提交改动的 key**（提交 1 个改 1 个、提交 10 个
   * 改 10 个，不为每个偏好单开接口）。缺的 key = 保留原值，非法值直接丢弃。
   *
   * 落盘后由 `state-ws` 的 `prefs` 域推给**所有**端，所以不只是「保存成功」，而是
   * 「任何地方打开都是同一份」。为什么不做成 WS 上行：写操作在本仓一律走 HTTP（鉴权、
   * 错误码、并发都现成），WS 只做下行推送，两条通道各管一半最省事。
   *
   * ⚠️ 设备形态相关的偏好（字号 / 快捷键 / 通知 / 亮屏 / 面板宽度）**不在**这里，
   * 理由见 `./prefs` 文件头。
   */
  prefs: "/api/prefs",
  /**
   * 容器型项目的公网访问域名：GET / POST `/api/system/container-public`。
   *
   * GET 应答 `{ domains, wildcards, target, enabled }`（`domains` = 设置页里填的清单，
   * 空数组 = 关闭；`enabled` = 服务端公网入口端口是否真在监听）；
   * POST body `{ domain }`（不传 = 保留）。落盘后**立刻生效、不用重启**。
   */
  containerPublicSettings: "/api/system/container-public",
  conversationsMessages: "/api/conversations/:id/messages",
  /** 重命名会话：PATCH /api/conversations/:id（body: { title }） */
  conversationRename: "/api/conversations/:id",
  /**
   * 设置 / 清除会话记住的模型：PATCH /api/conversations/:id/target
   * （body: { backend, configId }；显式 null = 清除，回到默认）。
   * 每个会话可以选不同的模型并持久化 —— 刷新 / 重开都还在，除非该模型被删除。
   */
  conversationTarget: "/api/conversations/:id/target",
  /**
   * 归档 / 取消归档会话：PATCH /api/conversations/:id/archive（body: { archived: boolean }）。
   * 归档不删数据，只把它从项目树收进侧栏的「已归档」区，随时可取回。
   */
  conversationArchive: "/api/conversations/:id/archive",
  /**
   * 清除**这一个会话**的网站数据：DELETE /api/conversations/:id/browser-data。
   *
   * 内置浏览器给每个会话一份持久化 profile（Cookie / 登录态 / localStorage / HTTP 缓存），
   * 这份就是「这个会话的浏览器」。删除 = 关掉它的浏览器进程 + 删目录，**会话与历史消息
   * 不受影响**，下次启动浏览器需要重新登录。返回 204（没有响应体）。
   *
   * 与 `browserData`（全局：所有会话）不是同一条路：用户想清的是「我这个会话登错号了」，
   * 全局那条只给设置页的兜底动作。
   */
  conversationBrowserData: "/api/conversations/:id/browser-data",
  /**
   * 把会话标记成「已看过」：POST /api/conversations/:id/seen（无 body）。
   *
   * 只有一个来源会用到：定时任务触发的会话（`AgentConversation.unseen`），用户点开即清。
   * 应答回整份会话清单，与归档 / 重命名同一个用法。
   */
  conversationSeen: "/api/conversations/:id/seen",
  /**
   * 待发送队列（会话进行中排队的消息）：GET 读、PATCH 全量覆盖（拖拽排序后整体写回）。
   * 队列持久化在服务端：刷新 / 换设备都能续上，排序也跨端一致。
   */
  conversationQueue: "/api/conversations/:id/queue",
  /**
   * 多智能体协作：GET 读运行态快照 / PATCH 全量覆盖协作配置
   * （body: `ConversationCollabInput`，见 `ConversationCollabInput` 注释）。
   */
  conversationCollab: "/api/conversations/:id/collab",
  /** 取消协作会话里某个正在跑的子任务：POST /api/chat/collab/cancel */
  collabCancel: "/api/chat/collab/cancel",
  /**
   * 会话分叉（「从此签出」）：POST /api/conversations/:id/fork
   *
   * body `ForkInput`。以 `upToMessageId`（含该条）为终点复制出一个新会话，
   * 原会话不动 —— 之后各自独立，类似 `git checkout -b`。返回 `ForkResult`
   * （新会话的 Summary，客户端随后自己 loadMessages）。会话运行中拒绝（409）；
   * ACP 会话不支持（历史在 agent 侧，客户端会把按钮置灰，服务端同样拦一道）。
   */
  conversationFork: "/api/conversations/:id/fork",
  /**
   * 某个外部 Agent（ACP）**自己**能选哪些模型：GET /api/acp/agents/:id/models
   *
   * ACP 没有独立的「列模型」方法：清单来自 agent 在 `session/new` 里广告的
   * `configOptions`（category=model）。所以这个 GET 会**拉起 agent 进程问一次**
   * （一次性探针会话，问完就把进程收掉），设置页用它列出候选，让用户挑几个
   * 放进会话下拉（存 `AcpAgentConfig.models`）。返回 `AcpModelChoices`。
   */
  acpAgentModels: "/api/acp/agents/:id/models",
  /**
   * 这个外部 Agent 的**完整能力快照**（模型清单 + 模式 / 思考档）：
   * GET /api/acp/agents/:id/capabilities
   *
   * 与 `/models` 是同一次探针（起一次进程、问一句、收掉），多带回来的那一半是档位。
   * 「开始新对话」页选中 ACP agent 时调它 —— 还没有会话，而模式 pill 的数据本来只存在
   * 会话配置里，所以必须建会话之前先问一次。返回 `AcpProbeResult`。
   */
  acpAgentCapabilities: "/api/acp/agents/:id/capabilities",
  /**
   * 拉这个 agent 侧的既有会话清单（「导入会话」用）：GET /api/acp/agents/:id/sessions?cwd=
   *
   * 走 ACP 的 session/list（可选能力）：agent 没广告 `sessionCapabilities.list` 时
   * 返回 `{ supported: false, sessions: [] }`，界面据此隐藏导入入口。
   */
  acpAgentSessions: "/api/acp/agents/:id/sessions",
  /**
   * acp 会话的权限档位（ACP Session Modes）：GET 查询（?conversationId=），
   * POST 切换（body: { conversationId, modeId }）。只对已激活的会话有效；
   * agent 没广告档位时 GET 返回 `{ supported: false }`，界面据此隐藏切换 pill。
   */
  acpAgentMode: "/api/acp/agents/:id/mode",
  /**
   * acp 会话的**思考档**（ACP configOptions 的 `thought_level`，`pi` 用它）：
   * POST /api/acp/agents/:id/thought-level（body: `{ conversationId, value }`）。
   * 与 `acpAgentMode` 同形：只操作已激活的会话，成功后把用户选的档持久化到会话配置。
   */
  acpAgentThoughtLevel: "/api/acp/agents/:id/thought-level",
  /**
   * 打开 acp 会话时的视图恢复：GET /api/acp/agents/:id/transcript?conversationId=&sessionId=&cwd=
   *
   * 服务端 session/load 该会话并把历史回放转成 AgentStreamEvent 一次性返回；
   * 客户端折进一条临时助手消息渲染（消息本体仍在 agent 侧）。
   */
  acpAgentTranscript: "/api/acp/agents/:id/transcript",
  /**
   * 重启 acp 会话：POST /api/acp/agents/:id/restart（body: `{ conversationId }`）→ `{ ok, error? }`。
   *
   * **只杀进程、保留 `acpSessionId`** —— 下一轮发消息时走 `session/load` 把原上下文接回来，
   * 所以是「重连」不是「新建」：agent 侧会话与本地历史都不动，上下文也不丢，只是 agent
   * 进程换了个新的。用途是让 agent 侧的变更生效（新装的 pi 权限扩展、改过的项目信任设置、
   * agent 自己升级过）—— 这些东西只在进程启动时读一次。
   * 会话本来就没在跑时是幂等空操作，照样返回 ok。
   */
  acpAgentRestart: "/api/acp/agents/:id/restart",
  /** 清空会话（删掉全部消息）：DELETE /api/conversations/:id/messages */
  conversationClear: "/api/conversations/:id/messages",
  /** 删除会话里单条消息：DELETE /api/conversations/:id/messages/:messageId */
  conversationMessage: "/api/conversations/:id/messages/:messageId",
  /** 列工作区目录：GET /api/workspaces/:id/files?dir=相对路径 */
  workspaceFiles: "/api/workspaces/:id/files",
  /** 读取工作区文件（文本，编辑器用）：GET /api/workspaces/:id/files/read?path=相对路径 */
  workspaceFileRead: "/api/workspaces/:id/files/read",
  /**
   * 上传文件到工作区目录：POST /api/workspaces/:id/files/upload body: FsUploadInput
   *
   * ⚠️ 与 `workspaceFileRead` 的 POST（写文件）**不是一回事**：那条路只收 UTF-8
   * 文本（服务端 `fs.writeFile(abs, content, 'utf8')`），图片 / 压缩包经它落盘会被
   * 编码破坏。上传走 JSON + base64，服务端解码成字节后**不带编码**落盘。
   */
  workspaceFileUpload: "/api/workspaces/:id/files/upload",
  /** 媒体流式预览（图片/视频/音频，支持 Range）：GET /api/workspaces/:id/media?path=相对路径 */
  workspaceMedia: "/api/workspaces/:id/media",
  /** 删除工作区里的文件或目录（递归）：DELETE /api/workspaces/:id/files/delete?path=相对路径 */
  workspaceFileDelete: "/api/workspaces/:id/files/delete",
  /**
   * 复制工作区里的文件或文件夹：POST /api/workspaces/:id/files/copy body: { path, dest }
   *
   * `dest` = 目标**父目录**（相对路径，空串 = 工作区根目录）。同名不覆盖：服务端
   * 自动加「副本」后缀（`a.txt` → `a 副本.txt`），所以**原地粘贴**也合法 ——
   * 「复制完当场粘一下」是最常用手势，不能为它报错。返回新条目的相对路径。
   */
  workspaceFileCopy: "/api/workspaces/:id/files/copy",
  /**
   * 移动 / 重命名工作区里的文件或文件夹：POST /api/workspaces/:id/files/move body: { path, dest }
   *
   * `dest` = 目标**父目录**（相对路径，空串 = 工作区根目录），目标名保持源名。
   * 与复制不同，移动**不自动改名**：目标已存在同名条目时服务端返回 409（移动是有损操作，
   * 静默覆盖会毁数据）。返回新条目的相对路径。
   */
  workspaceFileMove: "/api/workspaces/:id/files/move",
  /**
   * 脚手架：给工作区**新建一份模板文件**：POST /api/workspaces/:id/scaffold
   * body: `FsScaffoldInput` → `FsScaffoldResult`
   *
   * 斜线命令 `/create-skill` 已移除，目前**没有界面入口**；这条路由作为服务端能力
   * 保留（`/init` 也不走它 —— 那份文档由模型读项目后自己写）。
   * 之所以要有这条独立路由而不是复用 `writeWorkspaceFile`：那条路只 `fs.writeFile`、
   * **不 mkdir**，而技能要落在 `.fizz/skills/<名字>/SKILL.md`（中间两层目录可能不存在）。
   * 「已存在一律 409，绝不覆盖」也在这条路里兜住。
   */
  workspaceScaffold: "/api/workspaces/:id/scaffold",
  /* ---------- 源代码管理（git）----------
   * 全部按工作区定位仓库：服务端先 `rev-parse --show-toplevel` 拿仓库根，之后
   * 都以仓库根为 cwd 执行（工作区可能是仓库的子目录，见 `GitStatusResult.root`）。 */
  /** 仓库状态（分支 / ahead-behind / 暂存·未暂存·未跟踪）：GET → `GitStatusResult` */
  workspaceGitStatus: "/api/workspaces/:id/git/status",
  /** 单文件 diff（unified 文本）：GET ?path=&staged=1 → `GitDiffResult` */
  workspaceGitDiff: "/api/workspaces/:id/git/diff",
  /** 分支清单（本地 + 远端，检出用）：GET → `GitBranchesResult` */
  workspaceGitBranches: "/api/workspaces/:id/git/branches",
  /** 提交历史：GET ?limit= → `GitLogResult` */
  workspaceGitLog: "/api/workspaces/:id/git/log",
  /** 一次提交的元信息 + 文件清单 + unified 文本：GET ?hash= → `GitCommitDiffResult` */
  workspaceGitCommit: "/api/workspaces/:id/git/commit",
  /** 写操作（暂存 / 取消暂存 / 提交 / 检出 / 推送）：POST body: `GitActionInput` */
  workspaceGitAction: "/api/workspaces/:id/git/action",
  skills: "/api/skills",
  /**
   * 子任务（subagent）偏好：GET / POST /api/subagents，body
   * `{ enabled?: SubagentId[]; modelConfigId?: string | null; modelId?: string | null }`
   * （POST 缺字段 = 保留原样；模型两项传 `null` = 清空）。**默认全关**，见 `SubagentSettings`。
   */
  subagents: "/api/subagents",
  /**
   * 自带浏览器（Playwright headless shell）的安装状态：
   * - `GET` → `BrowserRuntimeResult`（状态 + 最近一次安装任务）
   * - `DELETE` → 卸载（先关掉所有浏览器会话再删目录）
   *
   * 这是「这台机器上到底有没有那套浏览器」的唯一数据源：`runtime.installed` 同时决定
   * 输入框上方显不显示那颗开关、`web_fetch` / `screenshot` 要不要直接回绝。
   *
   * 「Agent 用不用浏览器」是**会话级**偏好（`AgentConversation.browserSettings`，走
   * `conversationTarget`），默认关 —— 没有全局那份。
   *
   * ⚠️ 与 `/api/browser`（screencast 的 **WS** 端点）不是同一个东西：那条是画面通道，
   * 升级请求在走到 HTTP 路由之前就被拦下了，这里只是普通 JSON 接口。
   */
  browserRuntime: "/api/browser/runtime",
  /**
   * 安装自带浏览器：`POST` → 立刻返回 `BrowserRuntimeResult`（`task` 是刚登记的后台任务）。
   *
   * 下载约 150MB，必须登记成后台任务：关掉设置页不会中断，进度与日志从任务详情里取。
   */
  browserRuntimeInstall: "/api/browser/runtime/install",
  /**
   * 内置浏览器的**网站数据**（每个会话一份 profile：Cookie / 登录态 / localStorage / 缓存）：
   * - `GET`    → `BrowserProfileUsage`（几个目录、共占多少）
   * - `DELETE` → 清掉**所有会话**的网站数据（先关掉所有浏览器会话，再删目录），
   *              回清完之后的 `BrowserProfileUsage`
   *
   * 为什么不是「清缓存 / 清 Cookie」两颗按钮：内置浏览器没有全局池子，一个会话一份
   * 持久化 profile，而 profile 就是登录态本身 —— 拆开清只会让人以为「清了缓存但还登着」。
   * 日常场景（这个会话登错号了）走 `conversationBrowserData`，这条只做兜底。
   */
  browserData: "/api/browser/data",
  /**
   * 这台机器上可用的终端（shell）清单：GET /api/terminal/shells → `ShellDetectResult`
   *
   * 给终端面板的「选择终端」下拉用。web 端回答的是**服务端**机器上有哪些 shell，
   * 桌面端走的是同一份路由（进程内直连），回答的自然是本机 —— 与终端本身跑在哪一致。
   */
  terminalShells: "/api/terminal/shells",
  /**
   * SSH 主机配置 CRUD：
   * - GET    /api/ssh/hosts         → `SshHostConfig[]`（脱敏，不含明文凭据）
   * - POST   /api/ssh/hosts         body `SshHostInput`（带 id 更新 / 不带新建）→ 列表
   * - DELETE /api/ssh/hosts/:id     → 列表
   */
  sshHosts: "/api/ssh/hosts",
  /**
   * 主机分组（主机 / 终端共用的归类树，**多级**）：
   * - GET    /api/ssh/hosts/groups          → `HostGroup[]`
   * - POST   /api/ssh/hosts/groups          body `HostGroupInput`（带 id 更新）→ 分组树
   * - DELETE /api/ssh/hosts/groups/:id[?deleteHosts=1] → `HostGroupsAndHosts`
   *          （`deleteHosts` 勾上就连组内及子分组的主机一起删，否则只删分组、主机移回未分组）
   *
   * ⚠️ 路径是 `/api/ssh/hosts/groups`，与 `/api/ssh/hosts/:id` 同级：静态段优先于动态段
   * （见 `app/next-route.ts`），`groups` 不会被当成某个主机的 id。
   */
  hostGroups: "/api/ssh/hosts/groups",
  /** 单个主机分组：目前只有 DELETE（带 `deleteHosts` 查询参数） */
  hostGroup: "/api/ssh/hosts/groups/:id",
  /**
   * 主机树拖拽重排 / 移动到分组：POST `/api/ssh/hosts/arrange` body `HostArrangeInput`
   * → `HostGroupsAndHosts`。
   *
   * 一次请求同时提交「分组的新层级」与「每台主机的归属」：两者在拖拽里是一起变的，
   * 拆成两个接口会出现「分组挪了、主机还在旧分组」的中间态。
   */
  hostArrange: "/api/ssh/hosts/arrange",
  /**
   * 某一台 SSH 主机的性能监控快照：
   * - GET /api/ssh/hosts/:id/metrics[?interval=2000] → `HostMetrics`
   *
   * `interval` 是**这台主机**的采集间隔（毫秒，服务端收敛到 [100, 60000]）；不传沿用
   * 缺省 2s。它是「本次请求希望服务端按什么节奏采」而不是持久化设置 —— 服务端按
   * 「最近还有人在看」决定要不要继续采（空闲回收，见 `ssh/monitor.ts`），前端换挡
   * 只要换个参数轮询即可，不必再开一条写接口。
   */
  sshHostMetrics: "/api/ssh/hosts/:id/metrics",
  /**
   * SSH 隧道（本地转发 -L / 远程转发 -R / SOCKS5 动态代理 -D）的 CRUD 与启停：
   * - GET    /api/ssh/tunnels                → `SshTunnelsSnapshot`（配置 + 运行态）
   * - POST   /api/ssh/tunnels  body `SshTunnelInput`（带 id 更新 / 不带新建）→ 快照
   * - DELETE /api/ssh/tunnels/:id            → 快照
   * - POST   /api/ssh/tunnels/:id/start      → 快照
   * - POST   /api/ssh/tunnels/:id/stop       → 快照
   *
   * ⚠️ 监听端口绑在**跑 server 的那台机器**上（桌面端 = 你本机，VPS 部署 = VPS 自己），
   * 这就是 `ssh -L/-R/-D` 的标准语义 —— 理由见 `@fizz/contracts/types` 的 `SshTunnel`。
   *
   * 运行态（`runtimes`）也在同一份快照里：它只存在内存（连接数 / 起停时间会一直变），
   * 由 state-ws 的 `sshTunnels` 快照域持续推送，启停接口只是「立刻拿到结果」的同步返回。
   */
  sshTunnels: "/api/ssh/tunnels",
  /**
   * 某个项目的终端命令历史（`<项目>/.fizz/terminal-history.json`）：
   * - GET    /api/workspaces/:id/terminal-history            → `{ entries }`（最新在前）
   * - POST   /api/workspaces/:id/terminal-history  { cmd }   → 记录一条（去重置顶）
   * - DELETE /api/workspaces/:id/terminal-history[?cmd=...]  → 删单条（带 cmd）/ 清空（不带）
   *
   * 历史跟着项目走（随目录复制 / 备份），命令预测与终端面板的历史管理共用这一份。
   */
  terminalHistory: "/api/workspaces/:id/terminal-history",
  /**
   * SSH 主机终端的命令历史：**不挂任何项目**，全局一份，落服务端数据目录
   * （`<FIZZ_DATA_DIR>/ssh-terminal-history.json`）：
   * - GET    /api/terminal/ssh-history            → `{ entries }`（最新在前）
   * - POST   /api/terminal/ssh-history  { cmd }   → 记录一条（去重置顶）
   * - DELETE /api/terminal/ssh-history[?cmd=...]  → 删单条（带 cmd）/ 清空（不带）
   *
   * 为什么和项目历史分开：SSH 过去的是**另一台机器**，它的命令与本地项目不是一回事
   * （把本地项目历史套上去预测远程命令只会互相带偏）。它属于「主机终端」而不是某个
   * 项目，所以既不落项目 `.fizz/`、也不随项目复制 / 备份走 —— 只在服务端存一份，
   * 所有 SSH 终端共享。
   */
  terminalSshHistory: "/api/terminal/ssh-history",
  /**
   * **宿主本机终端**（「主机与终端」里配的那条）的命令历史：**不挂任何项目**，全局一份，
   * 落服务端数据目录（`<FIZZ_DATA_DIR>/local-terminal-history.json`）：
   * - GET    /api/terminal/local-history            → `{ entries }`（最新在前）
   * - POST   /api/terminal/local-history  { cmd }   → 记录一条（去重置顶）
   * - DELETE /api/terminal/local-history[?cmd=...]  → 删单条（带 cmd）/ 清空（不带）
   *
   * 为什么和项目历史分开：「主机与终端」是**独立功能**，它开出来的终端与当前是哪个项目
   * 无关（也可能压根没开项目）—— 把历史塞进某个项目的 `.fizz/` 等于给一条与项目无关的
   * 终端绑了个隐形归属，换个项目历史就没了。
   * 为什么和 SSH 那份也分开：一份是「连过去的那台机器」，一份是「本机 shell」，混在一起
   * 预测会互相带偏。
   */
  terminalLocalHistory: "/api/terminal/local-history",
  /**
   * 主机终端的 SFTP 分片传输（把本地文件拖进 SSH 终端、或文件面板上传 / 下载时走这里）。
   *
   * - POST /api/sftp/realpath       { hostId, path? } → `{ path }`
   *     解析远端绝对路径（`path` 缺省或 `.` = 远端家目录）。拖拽上传拿它当目标目录的初值：
   *     **shell 的当前工作目录拿不到**（默认不发 OSC 7、解析提示符不可靠），只能先给家目录，
   *     再让用户在确认条里改。
   * - POST /api/sftp/upload/chunk   { hostId, dir, name, index, dataBase64, transferId? }
   *                                 → `{ ok, canceled? }`
   *     把**一个分片**写到 `dir/name`：`index === 0` 以 `'w'` 打开（截断创建 + 逐层建目录），
   *     其余以 `'a'` 追加。同名文件直接覆盖（拖拽是用户显式动作，再弹一次「要不要覆盖」
   *     收益很低；要保留旧的请改名）—— 那个「覆盖」语义就落在 `index === 0` 的 `'w'` 上。
   *     ⚠️ 同一文件的分片请求**必须串行**：服务端是无状态的、校验不了顺序，并发写同一个
   *     追加流会**静默**损坏文件内容（不报错，只是文件坏了）。
   * - POST /api/sftp/download/chunk { hostId, path, offset, length } → `{ dataBase64, eof }`
   *     读 `[offset, offset + length)` 这一段。`eof` = 读到的字节数少于请求的 —— 调用方据此
   *     决定还拉不拉下一段。**下载不需要 transferId、也不需要 abort**：不拉了就是取消。
   * - POST /api/sftp/abort          { hostId, dir, name, transferId } → 204
   *     取消一笔进行中的上传：销毁在途写流**并删除已写入的半份文件**。分片之后，传了一半的
   *     文件是真实存在且内容完整的，只停流会留下一个「看起来成功」的坏文件。
   *
   * **为什么服务端不持有会话**（没有 begin/chunk/finish 三件套）：无状态 = 没有 TTL 回收、
   * 没有会话泄漏、重启与多实例都不影响在途传输。代价是拿不到断点续传。
   *
   * **为什么是 base64 + JSON 而不是 multipart**：desktop 的 IPC 桥 body 只支持字符串，
   * `FormData` 会被静默丢掉 —— 与 `/api/uploads`、`/api/workspaces/:id/files/upload`
   * 同一条协议（那两处的注释有更细的说明）。分片是把它切成多条，不是换协议。
   */
  sftpRealpath: "/api/sftp/realpath",
  sftpUploadChunk: "/api/sftp/upload/chunk",
  sftpAbort: "/api/sftp/abort",
  /**
   * SFTP 文件管理（主机右键 →「SFTP 文件管理」标签）：列目录 / 建目录 / 重命名 /
   * 删除 / 复制 / 移动 / 下载。上传复用上面的 `sftpUploadChunk` / `sftpAbort`。
   */
  sftpFileList: "/api/sftp/list",
  sftpFileMkdir: "/api/sftp/mkdir",
  sftpFileRename: "/api/sftp/rename",
  sftpFileRemove: "/api/sftp/remove",
  sftpFileCopy: "/api/sftp/copy",
  sftpFileMove: "/api/sftp/move",
  sftpFileDownloadChunk: "/api/sftp/download/chunk",
  /** 外部 ACP agent 配置（后端为 acp 的会话用它） */
  acpAgents: "/api/acp/agents",
  /** 设为默认 ACP agent：POST /api/acp/agents/:id/default */
  acpAgentsDefault: "/api/acp/agents/:id/default",
  /* 扫 PATH 上已装的 ACP agent（只读探测，给设置页「一键添加」用） */
  acpDetect: "/api/acp/detect",
  /** MCP server 配置 CRUD */
  mcpServers: "/api/mcp/servers",
  /** 构建 MCP 工具集并返回工具信息 / 连接错误（设置页预览用）：GET /api/mcp/tools */
  mcpTools: "/api/mcp/tools",
  /**
   * **某一个** MCP server 自己的工具清单：GET /api/mcp/servers/:id/tools
   *
   * 与 `mcpTools` 的区别：那个是把**全部启用项**合成一个工具集（工具名冲突还会加
   * server 名前缀），用来预览「Agent 到底拿到了什么」；这个是单个 server 的，
   * 用来回答「这个 server 到底提供了哪些工具」—— 连上、列完、立刻把进程收掉。
   */
  mcpServerTools: "/api/mcp/servers/:id/tools",
  /**
   * 上传对话附件（图片 / PDF）：POST /api/uploads
   *
   * body `UploadInput`（JSON + base64，**不是 multipart**——desktop 的 IPC 桥 body 只支持
   * 字符串，两端走同一条协议），响应 `UploadResult`。返回的 `url` 是对外可访问的地址
   * （local 适配器为相对 `/api/uploads/<uuid>.<ext>`，由 GET 路由公开服务——`<img>` 带
   * 不了鉴权头）。存储后端由 `FIZZ_UPLOAD_BACKEND` 选择的 UploadAdapter 决定。
   */
  upload: "/api/uploads",
  /**
   * 可用上传源清单：GET /api/uploads/providers?workspaceId=xxx。
   * ⚠️ 必须排在上面的 `upload` 之后读（前缀关系），但两者是不同路径 —— 静态段
   * `providers` 在 Hono 里优先于 `/api/uploads/:name`，不会被那个动态路由吞掉。
   */
  uploadProviders: "/api/uploads/providers",
  /** 发一轮对话，响应是 SSE 流 */
  chat: "/api/chat",
  /**
   * 中止一轮对话：POST /api/chat/abort
   *
   * body 传 `{ requestId }`（用户点「停止」）或 `{ conversationId }`（找到该会话
   * 正在跑的 run 就停，没有则 no-op）。两种都会等这一轮真正收尾（部分产出落盘、
   * 挂起的审批 / 提问解开）后才返回。
   */
  chatAbort: "/api/chat/abort",
  /**
   * 运行中插话（steer）：POST /api/chat/steer
   *
   * body `SteerInput`。把一句话递给该会话**正在跑的 run**，agent 在下一个工具步骤
   * 边界把它作为 user 消息注入当前轮（spike 结论：步骤边界回调 里
   * push `ctx.messages` + `continue: true`）。只有 内置会话支持（ACP 400）；
   * 没有活跃 run 时回 **409**，客户端据此回落普通发送 —— 插话在空闲时语义上等价于发送。
   */
  chatSteer: "/api/chat/steer",
  /**
   * 重新订阅一条进行中的对话（SSE）：GET /api/chat/stream?requestId=
   *
   * 刷新 / 重载 / 断线后恢复现场用：服务端先从帧日志**头部回放**（完整现场），
   * 再转直播。同一条 run 可以被多个标签页同时 attach。
   */
  chatStream: "/api/chat/stream",
  /** 查某会话有没有正在跑的对话：GET /api/chat/active?conversationId=（run: null = 没在跑） */
  chatActive: "/api/chat/active",
  /**
   * 答复一次命令执行审批（confirm 模式）。
   *
   * ⚠️ 这是**另开的一条 HTTP 请求**，不是 SSE 流的反向通道：SSE 只有下行，
   * 而审批要的是「服务端暂停等用户点一下」。所以流程是：
   * 服务端在流里推 `confirm` 帧 → 客户端 POST 到这里 → 服务端解开 await → 流继续。
   */
  chatConfirm: "/api/chat/confirm",
  /**
   * 单条命令停止（execute_command 执行期间）：POST /api/chat/command/stop
   *
   * body `CommandStopInput`（requestId + toolCallId）。与 confirm 同款「另开的
   * 一条 HTTP 请求」：SSE 只有下行，停一条在跑的命令要一条并行上行。命中就杀
   * 该命令的进程树（工具结果收尾成「（已中止）」），Agent 同一回合据此收场。
   * 命令已结束 / run 已结束 = 幂等空成功（`{ stopped: false }`）。
   */
  chatCommandStop: "/api/chat/command/stop",
  /**
   * 运行中切换权限档：POST /api/chat/permission
   *
   * body `PermissionSetInput`（requestId + permissionMode）。工具集是**一轮建一次**的，
   * 权限档会被快照死在整轮里 —— 用户在运行中用输入框那颗 pill 切档时，靠这条请求把
   * 该 run 的**活档**改掉，闸门在**下一次工具调用**立刻按新档裁决（不必等下一轮）。
   * 与 command/stop 同款「另开的一条 HTTP 请求」。只影响内置 Agent 那条路
   * （ACP 是另一套 `acpPermissionMode`）。run 不存在 / 已结束 = 幂等空成功
   * （`{ updated: false }`）。
   */
  chatPermission: "/api/chat/permission",
  /**
   * 答复一次 ask_followup_question 提问（同 confirm 的反向通道约定）。
   *
   * 服务端在流里推 `ask-followup` 帧 → 客户端 POST 到这里（带上答案）→
   * 服务端解开 await，把答案作为工具结果回给模型，**同一个回合继续往下跑**。
   */
  chatFollowup: "/api/chat/followup",
  /**
   * 客户端工具的执行结果回填（同 confirm / followup 的反向通道约定）。
   *
   * 客户端工具（`ChatRequest.clientTools` / `AssistantSendInput.clientTools`）的
   * **定义随请求携带、执行在客户端**：服务端在流里推 `client-tool-call` 帧 →
   * 客户端就地执行（如驱动本机终端）→ POST 到这里 → 服务端解开 await，
   * 把结果作为工具结果回给模型，**同一个回合继续往下跑**。
   */
  chatClientToolResult: "/api/chat/client-tool-result",
  /**
   * 上下文压缩的手动触发与预算查询。
   *
   * - POST /api/chat/compress：body `{ conversationId }`。把会话历史（从已有检查点
   *   之后算起）立即摘要成一段，落成新的摘要检查点 —— **不等超预算**，手动说了算。
   *   仅内置 agent（内置）会话可用。响应带压缩统计。
   * - GET /api/chat/context：返回 `{ budget }`（发往模型的历史 token 预算，前端
   *   圆环的分母；预算解析与「该瘦身了」提示线同一处：显式参数 > 环境变量 > 默认 80k）。
   */
  chatCompress: "/api/chat/compress",
  chatContext: "/api/chat/context",

  // ---------- 定时任务 ----------
  /** 定时任务 CRUD：GET（?workspaceId=）/ POST（带 id 即为更新）/api/task-triggers */
  taskTriggers: "/api/task-triggers",
  /** 单个定时任务：GET / PATCH（开关）/ DELETE /api/task-triggers/:id */
  taskTriggerDetail: "/api/task-triggers/:id",

  // ---------- 接口请求（api-client）----------
  //
  // Postman 式的 HTTP / WebSocket 调试。**请求由服务端执行**（绕开浏览器 CORS），
  // 集合 / 分组 / 历史落服务端数据目录，经 state-ws 全量快照推给渲染端。
  /** 保存的接口请求集合：GET（列表）/ POST（带 id 更新 / 不带新建，返回列表） */
  apiRequests: "/api/api-client/requests",
  /** 删除一条请求：DELETE /api/api-client/requests/:id → 列表 */
  apiRequest: "/api/api-client/requests/:id",
  /** 拖拽重排（分组树 + 请求归属）：POST /api/api-client/arrange */
  apiArrange: "/api/api-client/arrange",
  /** 请求分组 CRUD：GET / POST /api/api-client/groups */
  apiGroups: "/api/api-client/groups",
  /** 删除一个分组：DELETE /api/api-client/groups/:id → 列表 */
  apiGroup: "/api/api-client/groups/:id",
  /** 请求历史：GET（倒序）/ POST（覆盖整段）/ DELETE（清空）/api/api-client/history */
  apiHistory: "/api/api-client/history",
  /** 执行一次 HTTP 请求：POST /api/api-client/send（body `ApiSendInput`）→ `ApiHttpResponse` */
  apiSend: "/api/api-client/send",
  /** 取消进行中的请求：POST /api/api-client/send/abort（body `{ sendId }`） */
  apiSendAbort: "/api/api-client/send/abort",
  // ---------- 主机脚本（scripts）----------
  //
  // 可在主机上一键执行的命令文本。**全局一份**（不按项目），集合 / 分组落服务端
  // 数据目录，经 state-ws 全量快照推给渲染端（与接口请求同款管道）。
  /** 脚本集合：GET（列表）/ POST（带 id 更新 / 不带新建，返回列表） */
  scripts: "/api/scripts",
  /** 删除一条脚本：DELETE /api/scripts/:id → 列表 */
  script: "/api/scripts/:id",
  /** 拖拽重排（分组顺序 + 脚本归属）：POST /api/scripts/arrange */
  scriptArrange: "/api/scripts/arrange",
  /** 脚本分组 CRUD：GET / POST /api/scripts/groups */
  scriptGroups: "/api/scripts/groups",
  /** 删除一个分组：DELETE /api/scripts/groups/:id[?deleteScripts=1] → `ScriptsAndGroups` */
  scriptGroup: "/api/scripts/groups/:id",
  // ---------- 数据导入 / 导出（左下角菜单）----------
  //
  // 三类数据（接口请求 / 主机 / 脚本）打包带走或导回。**内容一律走 base64 JSON**，
  // 不是二进制流：desktop 的 IPC 桥 body 只支持字符串，`FormData` / 裸字节会被静默丢掉
  // （同 `uploadFile` 的理由），两端必须同一条协议。
  //
  // 分成三步而不是一步，是为了**先看摘要再写库**（dogi 的 pick → apply 两段式）：
  // 导入包内容留在客户端，服务端不缓存会话，所以 apply 时要把同一份内容再传一次。
  /** 导出：POST /api/transfer/export（body `{ kinds, format }`）→ `TransferExportResult` */
  transferExport: "/api/transfer/export",
  /** 解析导入包看摘要（不写库）：POST /api/transfer/inspect（body `{ dataBase64 }`）→ `TransferInspectResult` */
  transferInspect: "/api/transfer/inspect",
  /** 真正写库：POST /api/transfer/apply（body `{ dataBase64, kinds }`）→ `TransferImportResult` */
  transferApply: "/api/transfer/apply",
  // ---------- 应用日志（titleBar 入口 → 日志面板）----------
  //
  // 全 App 的业务事件日志，按「命名空间」分组（ssh / terminal / tunnel / plugin …）。
  // 命名空间由各功能模块运行时注册（`registerNamespace`），前端从应答里的 `namespaces`
  // 读 Tab 列表，**不写死**。数据源在 server（`@fizz/workspace` 的 `appLog`）——
  // 桌面端只是进程内直连同一个 server，所以 web 与 desktop 走同一份实现。
  /** 全量拉取：GET /api/app-log → `AppLogResult` */
  appLog: "/api/app-log",
  /** 清空（内存 + 落盘）：DELETE /api/app-log → `AppLogResult` */
  appLogClear: "/api/app-log/clear",
  /** 增量推送：GET /api/app-log/stream?since=<seq> → SSE `AppLogFrame` */
  appLogStream: "/api/app-log/stream",
} as const;

/**
 * 终端 WebSocket 端点：
 * `ws(s)://<host>/api/terminal?token=<token>&cwd=<工作区绝对路径>&cols=&rows=[&shell=<id>]`。
 *
 * 对话走 SSE（单向流就够），终端必须双向（输入要往回写），所以这里用 WS。
 * token 放查询参数是 WS 的现实约束：浏览器端 `WebSocket` 带不了自定义请求头。
 *
 * `shell` 是 `ShellProfile.id`（清单见 `/api/terminal/shells`）；不传 = 平台默认。
 * 服务端**认不出这个 id 时回落到默认**而不是拒连 —— 客户端存的选择可能对应一个
 * 已经卸载的 shell，那时开一条默认终端比弹「找不到 pwsh」有用。
 */
export const TERMINAL_WS_PATH = "/api/terminal";

/**
 * WebSocket 调试的**中继端点**：`/api/api-client/ws/:connId`。
 *
 * 渲染端一条调试连接 = 一条打到这里的浏览器 WS；服务端中继按首帧 `connect` 里的
 * `WsConnectOptions` 去连外部目标，并把目标帧转发成 JSON `WsEvent`（协议见
 * `@fizz/contracts/types` 的 `WsRelayClientMessage` / `WsEvent`）。
 *
 * `connId` 由渲染端**先生成再发起**（避免握手快于建连的竞态），路径里带上以便中继
 * 回推事件时携带它。`?token=` 同为查询参数（浏览器 `WebSocket` 带不了自定义请求头）。
 */
export const API_CLIENT_WS_PATH = "/api/api-client/ws";

/** 拼一条接口调试中继 WS 的路径（不含 token，由各宿主自行补） */
export function apiClientWsPath(connId: string): string {
  return `${API_CLIENT_WS_PATH}/${encodeURIComponent(connId)}`;
}

/**
 * SSH 终端 WebSocket 地址：`/api/ssh/terminal`。
 *
 * 协议与 `/api/terminal` **逐条相同**（客户端 → JSON 控制帧 input / resize / ping；
 * 服务端 → 二进制输出帧 + JSON `exit` / `pong`），只有定位方式不同：这里用
 * `?hostId=` 指定服务端存的一台 SSH 主机（凭据不回传渲染端，由服务端解密后连接），
 * 而不是 `?cwd=` 起一条本机 shell。
 *
 * `?token=` 同为查询参数（浏览器 `WebSocket` 带不了自定义请求头，见 `TERMINAL_WS_PATH`）。
 */
export const SSH_TERMINAL_WS_PATH = "/api/ssh/terminal";

/**
 * 拼一条 SSH 终端 WS 的路径 + 查询串（不含 token，由各宿主自行补）。
 * 路径拼装收在这里，web 兜底与 desktop 桥两处共用一份，免得写歪。
 */
export function sshTerminalWsPath(options: {
  hostId: string;
  cols: number;
  rows: number;
}): string {
  return (
    `${SSH_TERMINAL_WS_PATH}?hostId=${encodeURIComponent(options.hostId)}` +
    `&cols=${options.cols}&rows=${options.rows}`
  );
}

/**
 * 终端命令历史的一条记录：用户在终端里按回车提交的那一行。
 *
 * 只记「人敲的命令」—— 落盘分**三份**（三种终端互不相干）：
 * - 会话侧栏里的本机项目终端 → `<项目>/.fizz/terminal-history.json`（每项目一份，随项目走）；
 * - SSH 主机终端 → 数据目录 `ssh-terminal-history.json`（不挂项目，全局一份）；
 * - 「主机与终端」里配的**宿主本机终端** → 数据目录 `local-terminal-history.json`
 *   （不挂项目，全局一份；它是独立功能开出来的终端，与当前项目无关）。
 * 命令预测与终端面板的历史管理都读它。`ts` 是最后一次执行时间（重复执行刷新并置顶）。
 */
export interface CommandHistoryEntry {
  /** 提交的命令行（trim 过，超长截断） */
  cmd: string;
  /** 最后一次执行的时间戳（ms） */
  ts: number;
}

/** 终端命令历史的响应（`/api/workspaces/:id/terminal-history` 与 `/api/terminal/ssh-history` 共用） */
export interface TerminalHistoryData {
  entries: CommandHistoryEntry[];
}

/**
 * 终端 WS 上的 JSON 控制帧（客户端 → 服务端）。
 *
 * 输出**不走 JSON**：PTY 原始字节用 WS 二进制帧直传（保真 + 免 base64），
 * 客户端按 `typeof event.data === 'string'` 区分控制帧与输出。
 *
 * ⚠️ **上行也有二进制帧**：`Uint8Array` 直发（WS 二进制帧）表示「原始输入字节」，
 * 服务端按字节喂给会话 —— 只有 ZMODEM（rz/sz）走这条路（协议帧不能过 UTF-8 编码，
 * 塞进 JSON 还要 base64 膨胀 1/3）。控制帧与它的先后顺序由 WS 保证。
 */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  /** 心跳探活：客户端每 10s 发一次，服务端回 `pong`（应用层，撑过代理空闲超时） */
  | { type: "ping" }
  /**
   * 「停止」：收掉当前前台命令的**整棵进程树**，shell 保留（终端继续可用）。
   *
   * 为什么需要它：`input` 发 `\x03`（SIGINT）只是一个「请求」—— 程序可以不理
   * （`npx vite` 在有些 shell / 平台上就不退），也可以自己吞掉。用户点了停止却没停，
   * 就是这个原因（「我手动停止竟然都停不下来」）。这条帧是**兜底**：服务端定位前台
   * 进程组后 SIGTERM，1.5s 不到再 SIGKILL 整组；实在定位不到就连 shell 一起按树杀。
   *
   * 只对本机 PTY（`/api/terminal`）有意义；SSH 通道（`/api/ssh/terminal`）**直接忽略**
   * （远端进程组不在宿主视野里，能做的只有再发一次 `\x03`，那等于替用户又按一次 Ctrl+C）。
   */
  | { type: "stop" };

/**
 * SSH 建连阶段（客户端据此渲染「连接进度」浮层，参考 dogi 的 `SshConnectCard`）。
 *
 * 单跳序列：`resolving → handshake → authenticating → opening-shell → ready`；
 * 多跳（跳板链）时前四步逐跳重放，`SshConnectProgress.detail` 标注当前在第几跳。
 */
export type SshConnectStage =
  "resolving" | "handshake" | "authenticating" | "opening-shell" | "ready";

/** SSH 连接进度：WS 上以 JSON `progress` 帧下发（不进二进制通道） */
export interface SshConnectProgress {
  stage: SshConnectStage;
  /** 补充说明（跳板链时是「第 N/M 跳：user@host」） */
  detail?: string;
}

/** 终端 WS 上的 JSON 控制帧（服务端 → 客户端）；输出同样是裸二进制帧 */
export type TerminalServerMessage =
  | { type: "exit"; exitCode: number }
  /** 对客户端 `ping` 的应答（见 `TerminalClientMessage` 的 `ping`） */
  | { type: "pong" }
  /**
   * SSH 建连进度（仅 `/api/ssh/terminal` 会发；本机 PTY `/api/terminal` 不发）。
   * 渲染端把它转成 `SshConnectProgress` 回调，连上后浮层收起。
   */
  | ({ type: "progress" } & SshConnectProgress);

/** 统一的错误体（HTTP 状态码 + 这条消息） */
export interface ApiErrorBody {
  error: string;
}

export interface HealthInfo {
  name: string;
  version: string;
  /** 是否已配置任何模型（web/cli 用来提示「先配模型」） */
  hasModels: boolean;
  workspaceCount: number;
  conversationCount: number;
  /** 技能目录扫到几个（顺便当自检） */
  skillCount: number;
}

// ---------- 模型配置 ----------

/**
 * 创建 / 更新模型配置。`apiKey` 只在写入时传；读回来一律是掩码，
 * 只是想改别的字段时不要传它（服务端会保留原 key）。
 */
export interface ModelInput {
  id?: string;
  name: string;
  kind: AiProviderKind;
  /**
   * 该配置下的模型清单（**多个**）：同一网关 + 同一 key 的多个模型共用一个配置。
   * 每个条目带自己的 `contextWindow` / `settings`，整份替换语义（不传 = 清空）。
   *
   * **字段本身必传，但可以为空数组**：允许「先把网关 / key 建好、模型之后再补」，
   * 也允许把模型全删光。空清单的配置不能用于对话。
   */
  models: AiModelEntry[];
  baseURL?: string;
  apiStyle?: AiApiStyle;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  contextMessages?: number;
}

/** 返回给客户端的模型配置：**永远不含明文 apiKey** */
export type ModelView = Omit<AiModelConfig, "apiKey"> & {
  hasApiKey: boolean;
  /**
   * 插件注册的模型配置：
   * - `readOnly` = 设置页里不能编辑 / 删除 / 增删模型（真源在插件，改插件才会变）；
   * - `sourceName` = 插件显示名（设置页标「来自插件」）；
   * - `pluginId` = 插件入口文件路径（排障用，界面上不必显示）。
   */
  readOnly?: boolean;
  source?: "plugin";
  sourceName?: string;
  pluginId?: string;
};

/**
 * 「从上游拉模型」的入参：草稿配置，或带配置 id 的编辑草稿。
 *
 * `apiKey` 可空 —— 本地网关（Ollama / vLLM）大多不校验；真需要 key 的上游会回 401，
 * 那时如实把上游的状态码与消息透出来，别吞成「拉取失败」。
 */
export interface UpstreamModelsInput {
  /** 已保存的配置 id；apiKey 留空时由服务端读取原密钥，不返回给客户端 */
  id?: string;
  kind: AiProviderKind;
  baseURL?: string;
  apiKey?: string;
}

/** 上游模型清单（已排序去重）。拉不到就是抛错，不用空数组假装成功。 */
export interface UpstreamModelsResult {
  models: string[];
}

// ---------- 工作区 / 会话 ----------

export interface WorkspaceInput {
  id?: string;
  name?: string;
  /** 服务端可见的绝对路径（服务端只允许访问显式登记过的目录） */
  path: string;
  /** 工作区默认后端（会话未显式指定时使用）；桌面端桥接时透传 */
  backend?: AgentBackend;
  /** 标记为 worktree 项目（由创建 worktree 的流程置位，侧栏据此嵌套展示） */
  isWorktree?: boolean;
  /** worktree 项目的父项目（源工作区）id */
  parentWorkspaceId?: string;
  /**
   * 容器型项目配置（有这个字段就是容器型项目）。
   *
   * ⚠️ `addWorkspace` 是**逐字段重建整条记录**，重命名 / 重新登记都走它；
   * 那边必须把这个字段原样带过去，否则容器型项目会静默降级成普通项目。
   */
  container?: ContainerProjectConfig;
  /**
   * 临时工作区（无项目会话自动建的那个目录）。只有服务端懒创建时会置位，
   * 界面上「选目录 / 导入」这些入口都不会传它。
   */
  scratch?: boolean;
}

/** 重命名工作区（PATCH /api/workspaces/:id） */
export interface WorkspaceRenameInput {
  name: string;
}

/**
 * 移除工作区的入参（DELETE /api/workspaces/:id，可空 body）。
 *
 * 默认**只摘记录**：工作区及其全部会话从列表里清掉，磁盘上的目录一个字节都不动。
 * 对 worktree 项目可以额外勾选「同时删除 git worktree」——服务端会用
 * `git worktree remove --force` 连带删掉 `<项目>/.worktree/<标识>` 目录（分支保留，
 * 改动的提交还找得回来）。
 */
export interface WorkspaceDeleteInput {
  /** 连磁盘上的 worktree 目录一起删；只对 worktree 项目有效，别的项目忽略这个字段 */
  deleteWorktree?: boolean;
}

/**
 * 「从 Git 导入」项目：服务端把远端仓库克隆到指定目录并登记成工作区。
 *
 * 克隆是服务端行为（跑 Agent 那台机器上执行 `git clone`），目录名缺省从 URL 推导
 * （取最后一段、去 `.git`），目标已存在时拒绝。
 *
 * 这趟克隆在服务端**同时是一条后台任务**（见 `BackgroundTaskView`）：渲染端可以边等边看，
 * 也可以中途「转到后台」——任务照跑，进度落到状态栏的任务列表里。
 */
export interface WorkspaceCloneInput {
  /** 仓库地址（https / ssh / git@…；服务端拒绝以 `-` 开头或含换行的串） */
  url: string;
  /** 克隆到的**父目录**（服务端可见的绝对路径），仓库目录建在它下面 */
  parentDir: string;
  /** 目标目录名（也是项目展示名）；缺省从 URL 推导 */
  name?: string;
  /**
   * 后台任务的 id：渲染端生成（`crypto.randomUUID()`）后，这一个 id 就是三件事的句柄 ——
   * 取消（`POST /api/background-tasks/:id/cancel`）、转到后台
   * （`POST /api/background-tasks/:id/detach`）、以及状态栏里那一行。
   *
   * 为什么不靠断连接来取消：desktop 的 IPC 桥**不转发 `AbortSignal`**（只有 SSE 有），
   * 连接断开与「用户点了取消」不可区分。显式 id 是两端唯一可靠的通道。
   */
  cloneId?: string;
  /** 一开始就只登记成后台任务、立刻回包（不等克隆）。缺省 false = 请求方在这条请求上等结果 */
  background?: boolean;
}

/**
 * 「从 Git 导入」的结果。三种都是**正常结局**，服务端一律回 200 —— 调用方按形状分流，
 * 不必靠状态码猜（取消不该被当成错误弹红条）。
 */
export type WorkspaceCloneResult =
  | AgentWorkspace
  | { canceled: true }
  | { detached: true; taskId: string };

/** 后台任务状态：`running` 之外都算已结束，可以关闭 / 清空 */
export type BackgroundTaskStatus = "running" | "done" | "failed" | "canceled";

/** 日志级别：只有 error / warn 在界面上变色，其余按普通行渲染 */
export type BackgroundTaskLogLevel = "info" | "warn" | "error";

/**
 * 一条后台任务日志。
 *
 * 服务端按追加顺序保存（`at` 单调不减），**有行数上限**：超了从最老的丢 ——
 * 一个跑到一半的 `git clone` 能刷几千行进度，全留着既没意义也占内存。
 */
export interface BackgroundTaskLogLine {
  /** 毫秒时间戳（渲染端自己格式化，别让服务端传来回算） */
  at: number;
  level: BackgroundTaskLogLevel;
  text: string;
}

/**
 * 一条后台任务（服务端**进程内**登记，刷新页面不丢、重启服务即消失）。
 *
 * 目前只有 `git-clone` 一种，但字段是通用形状：以后把训练 / 批量导入 / 备份这类
 * 「耗时长、可以不等」的活儿登记进来，状态栏那一份 UI 不用改。
 */
export interface BackgroundTaskView {
  id: string;
  /**
   * 发起它的**会话** id（`Conversation.id`）。
   *
   * 有值时这条任务属于那个会话：会话里那块后台任务面板只显示自己的，删会话会连带停掉
   * 它们。没有值的任务（如 `git-clone`）不属于任何会话 —— 它由用户在项目页直接发起，
   * 只出现在状态栏那张全局清单里。
   *
   * 会话归属在登记那一刻**固定死**，之后切会话 / 改名 / 归档都不改。
   */
  sessionId?: string;
  /** 任务种类（决定图标与文案）：`git-clone` / `agent-command` */
  kind: string;
  /** 一行标题，如 `克隆 owner/repo` */
  title: string;
  /** 副标题：克隆目标路径这类定位信息 */
  detail?: string;
  status: BackgroundTaskStatus;
  /** 毫秒时间戳（渲染端自己算「已运行多久」，别让服务端每次重算） */
  startedAt: number;
  finishedAt?: number;
  /** 失败原因（服务端人话 / git 原话）；`canceled` 不带 */
  error?: string;
  /** 成功产物的定位信息：克隆成功时是新工作区的 id 与路径 */
  workspaceId?: string;
  path?: string;
  /** 只有「还在跑且支持取消」的任务是 true —— 界面据此决定要不要画取消按钮 */
  cancelable: boolean;
  /**
   * 最新一行日志（列表里当「实时进度行」用，如 `Receiving objects: 45%`）。
   * 完整日志走 `GET /api/background-tasks/:id` —— 列表每 2s 轮询一次，把每个任务的
   * 整份日志塞进列表等于白传大量数据，而绝大多数时候没人看。
   */
  lastLog?: string;
  /** 累计产生过多少行日志（含已被裁掉的老行）：界面据此决定要不要显示「查看日志」 */
  logCount: number;
}

/**
 * 单条任务的详情：`GET /api/background-tasks/:id` → 任务本体 + 保留的日志行。
 *
 * 日志**只在用户展开某一行时才拉**：那才是真有人要看的时候。
 */
export interface BackgroundTaskDetail {
  task: BackgroundTaskView;
  /** 保留的日志行（时间升序，最新的在最后） */
  logs: BackgroundTaskLogLine[];
}

/** 后台任务列表（每个后台任务接口都回这个形状，前端拿回来直接整体替换） */
export interface BackgroundTasksResult {
  tasks: BackgroundTaskView[];
}

/**
 * worktree 标识：单层目录名，首字符必须是字母或数字，其余允许 `-` `_` `.`。
 * **前后端共用同一份**（新建弹窗的即时校验与服务端兜底必须是同一个规则）。
 */
export const WORKTREE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 在某个项目下创建 worktree 的入参（POST /api/workspaces/:id/worktree）。
 *
 * 服务端据此在 `<源项目目录>/.worktree/<identifier>` 开一个 git worktree、
 * 从 `baseBranch` 新建分支，并把它登记成一个新的（worktree）项目。
 */
export interface WorktreeInput {
  /**
   * worktree 的英文标识：既是目录名（`.worktree/<identifier>`），也是新分支名的一部分。
   * 只允许字母 / 数字 / `-` `_` `.`，且不能是 `.` / `..`。
   */
  identifier: string;
  /** 新项目的展示名；留空 = 用 identifier */
  name?: string;
  /** 基线分支；留空 = 仓库当前分支 */
  baseBranch?: string;
}

/**
 * `.worktree/` 目录里扫出来的**候选 worktree**（GET /api/workspaces/:id/worktree）。
 *
 * 「管理工作区」弹窗据此列清单：用户挑一个还没登记过的，服务端把它补登记成
 * worktree 项目。已在列表里的（`workspaceId` 有值）会显示成「已加载」且不可再选。
 */
export interface WorktreeScanEntry {
  /** 目录名（= worktree 标识），也是 `<项目>/.worktree/<identifier>` 的最后一段 */
  identifier: string;
  /** worktree 目录的绝对路径 */
  path: string;
  /** 该 worktree 检出的分支名；不是合法 worktree / 读不到时为 null */
  branch: string | null;
  /** 这个目录是不是一个可以用的 git worktree（`.git` 指针存在） */
  isWorktree: boolean;
  /** 已经登记成工作区时是它的 id；未登记则没有这个字段 */
  workspaceId?: string;
}

/**
 * 加载（登记）一个已存在的 worktree 的入参
 * （POST /api/workspaces/:id/worktree/load）。
 *
 * 与 `WorktreeInput` 的区别：不建目录、不建分支，只是把磁盘上已有的目录
 * 收进工作区列表 —— 比如 worktree 是在别处手工 `git worktree add` 出来的。
 */
export interface WorktreeLoadInput {
  /** `.worktree/` 下的目录名（校验规则同 `WorktreeInput.identifier`） */
  identifier: string;
  /** 项目的展示名；留空 = 用 identifier */
  name?: string;
}

/**
 * 一个目录项（服务端目录浏览用；只列目录，不含文件）。
 * `path` 一律是服务端上的**绝对路径**。
 */
export interface FsDirEntry {
  name: string;
  path: string;
}

/**
 * `GET /api/fs/dirs` 应答：当前目录 + 上级 + 可跳转的根 + 子目录。
 *
 * 给 web 端「选一个服务端上的目录当工作区」用 —— 浏览器碰不到服务端的文件系统，
 * 只能让 server 列给我们看（见 `apps/server/src/routes/fs.ts`）。
 */
export interface FsDirsResult {
  /** 当前目录的绝对路径 */
  path: string;
  /** 上级目录；null = 已经在根（如 `C:\` 或 `/`） */
  parent: string | null;
  /** 可跳转的根：Windows 是各盘符，POSIX 是 `/` */
  roots: FsDirEntry[];
  /** 当前目录下的子目录 */
  entries: FsDirEntry[];
}

/**
 * `POST /api/fs/mkdir` 请求体：在 `parent` 下建一个名叫 `name` 的文件夹。
 *
 * `name` 只允许**单层目录名**（不含 `/` `\` `:` 与 NUL，不能是 `.` / `..`）——
 * 服务端会再校验一遍，别指望前端拦得住。
 */
export interface FsMkdirInput {
  /** 父目录绝对路径（就是 `FsDirsResult.path`） */
  parent: string;
  /** 新文件夹名字（单层，不带路径） */
  name: string;
}

/** `POST /api/fs/mkdir` 应答：新建出来的绝对路径（前端建完直接进去） */
export interface FsMkdirResult {
  path: string;
}

export interface ConversationInput {
  id?: string;
  workspaceId: string;
  title?: string;
  /** 会话形态（缺省 = 普通对话）；`collab` 仅支持内置 Agent 后端 */
  kind?: "chat" | "collab";
  /** 协作配置：创建 `kind: 'collab'` 时带上；缺省用 `DEFAULT_COLLAB_SETTINGS` */
  collab?: CollabSettings;
  backend?: "builtin" | "acp";
  configId?: string;
  /** `builtin` 后端下选中的上游模型（`AiModelConfig.models` 的一项） */
  modelId?: string;
  /** 内置 Agent 的思考强度（缺省 = 跟随模型）；ACP 会话忽略 */
  reasoningEffort?: AiReasoningEffort;
  /**
   * ACP 会话绑定：导入 agent 侧既有会话（`session/list` 里的一项）时带上它的
   * sessionId。创建后由服务端在 `session/new` 时回填，客户端不用管。
   */
  acpSessionId?: string;
  /**
   * 创建 ACP 会话时一并落下的运行态快照（服务端 `session/new` 的产物）。
   * 普通 web 创建不用传 —— 服务端会自己 `session/new` 后写入；导入既有会话时可带。
   */
  acpModes?: AcpModesState;
  acpThoughtLevel?: AcpThoughtLevelState;
  /** ACP 会话的权限答复策略（缺省 `confirm`）；见 `AcpPermissionMode` */
  acpPermissionMode?: AcpPermissionMode;
  /**
   * 创建时就定下这个会话允许使用哪些 MCP server（`McpServerConfig.id`）。
   * 缺省 / 空 = 全不选（存量会话天然落在这里）。之后由 `ConversationTargetInput` 改选。
   */
  mcpServerIds?: string[];
  /**
   * 创建时就定下这个会话的浏览器偏好（总开关 + 来源）。缺省 = 用全局默认
   * （新会话的默认值）。之后由 `ConversationTargetInput` 改选。
   */
  browserSettings?: BrowserSettings;
  /**
   * 一次性覆盖消息（桌面端桥接用「渲染端为真值」的整体保存）。
   * 不传 = 沿用已有消息；传了 = 整体替换。普通 web/cli 创建会话时不要传。
   * ⚠️ `backend: 'acp'` 的会话消息不落本地，传了也会被忽略。
   */
  messages?: AgentChatMessage[];
  /**
   * 「跑完了还没被点开」标记（见 `AgentConversation.unseen`）。
   *
   * 只有定时任务那条链路会传 `true`；**不传 = 沿用已有**（`saveConversation` 是整体重建
   * 对象，不带这个字段就会在「改标题 / 存消息」时把红点弄丢），清标记请走
   * `POST /api/conversations/:id/seen`，不要靠传 `false`。
   */
  unseen?: boolean;
}

/** 会话列表不带消息体（消息可能很大，列表只要元信息） */
export type ConversationSummary = Omit<AgentConversation, "messages"> & {
  messageCount: number;
};

/**
 * 一条会话搜索结果。
 *
 * 刻意只回**摘要 + 命中片段**，不回整条消息：会话是产品里最核心的资产，攒到几十上百条之后
 * 就彻底找不回来了；而搜索结果列表要能一眼看出「是不是我要的那条」，靠的就是那段上下文。
 */
export type ConversationSearchHit =
  | {
      conversationId: string;
      title: string;
      workspaceId: string;
      messageCount: number;
      updatedAt: number;
      /**
       * 是否已归档。**搜索照旧能搜到归档会话** —— 归档是「收起来」不是「消失」，
       * 而用户找回旧会话时最指望的就是搜索；UI 据此给结果打个标记。
       */
      archived?: boolean;
      /** 标题命中：没有具体的消息可定位 */
      where: "title";
    }
  | {
      conversationId: string;
      title: string;
      workspaceId: string;
      messageCount: number;
      updatedAt: number;
      archived?: boolean;
      where: "message";
      /** 命中的那条消息 id（跳过去并定位到它） */
      messageId: string;
      role: "user" | "assistant";
      /** 命中处的文本片段（已截断并居中到命中点） */
      snippet: string;
    };

export interface ConversationDetail extends AgentConversation {}

// ---------------------------------------------------------------------------
// 用量汇总
// ---------------------------------------------------------------------------

/** 一段用量（分组后的小计；字段与 `ConversationUsage` 同构，便于直接相加） */
export interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

/** 按天分组的一行：`day` 是本地日期 `YYYY-MM-DD` */
export interface UsageByDay extends UsageBucket {
  /** 本地日期 `YYYY-MM-DD`（不是 ISO/UTC —— 晚上跑的活不能算到第二天） */
  day: string;
  /** 这一天有产生用量的会话数 */
  conversations: number;
}

/** 按会话分组的一行 */
export interface UsageByConversation extends UsageBucket {
  conversationId: string;
  title: string;
  workspaceId: string;
  /** 该会话最后一次产生用量的时间（排序键） */
  updatedAt: number;
}

/**
 * 用量汇总结果。
 *
 * ## 为什么只有 token、没有金额
 *
 * 金额折算需要一张**按模型分档的单价表**，而模型配置里没有这个字段。凭模型名猜单价
 * 会得到一个会骗人的数字（用户看到的花费与实际账单对不上，比不显示更糟）。所以这里
 * 只汇总 token —— 它是模型自己上报的客观数字，不依赖任何外部假设。
 * 真要做金额，应该让用户在模型配置里显式填单价（甚至填每百万 token 的价格），
 * 由服务端负责算，而不是内置一张会过期的价目表。
 *
 * ## 数据来源
 *
 * 全部来自会话消息上的 `usage`（每轮结束随消息落盘），因此**只有跑完的轮次会被计入**：
 * 被中止的一轮、上游没上报 usage 的 ACP 会话都不在统计里。这是口径上的已知缺口，
 * 不是 bug —— 与会话头部那个累计条数保持一致才重要（两处数字对不上会让人怀疑）。
 */
export interface UsageSummary {
  /** 全部会话的合计 */
  total: UsageBucket;
  /** 按天（降序，新的在前）；受 `days` 限制 */
  byDay: UsageByDay[];
  /** token 最多的会话（降序）；受 `limit` 限制 */
  byConversation: UsageByConversation[];
  /** 覆盖到的会话总数（含没有任何用量的会话）——分母，用于算「多少会话真的在用」 */
  conversationCount: number;
}

// ---------------------------------------------------------------------------
// 服务器性能监控（只用 Node 内置 API 采集，跨 Windows / Linux）
// ---------------------------------------------------------------------------

/**
 * 一块磁盘分区的占用。
 *
 * Windows 上没有「挂载点」的概念，`mount` 就是盘符（`C:`）；Linux 是挂载点（`/`）。
 * `usedPercent` 由服务端算好（0–100），前端不必再除一遍。
 */
export interface SystemDiskUsage {
  /** 挂载点 / 盘符（Linux: `/`，Windows: `C:`） */
  mount: string;
  /** 文件系统类型，读不到为空串 */
  fsType: string;
  /** 总容量（字节） */
  size: number;
  /** 已用（字节） */
  used: number;
  /** 已用占比 0–100 */
  usedPercent: number;
}

/** 操作系统与机器信息（静态，进程启动时采一次） */
export interface SystemOsInfo {
  platform: string;
  /** 发行版（Linux: `Ubuntu 22.04`，Windows: `Microsoft Windows 11 Pro`） */
  distro: string;
  /** 内核 / 版本号 */
  release: string;
  arch: string;
  hostname: string;
}

/** 运行 fizz 的这个 Node 进程自身占用 */
export interface SystemNodeProcess {
  nodeVersion: string;
  /** 常驻内存 RSS（字节） */
  rss: number;
  /** V8 堆已用（字节） */
  heapUsed: number;
  /** V8 堆总量（字节） */
  heapTotal: number;
  /** 进程已运行秒数 */
  uptimeSeconds: number;
}

/**
 * 性能监控快照：当前时刻的全部指标。
 *
 * 采集策略（见 `apps/server/src/server/services/system-monitor.ts`）：
 * - **轻量字段**（CPU 负载 / 内存 / OS / fizz 自身进程）由常驻采样器每 ~2s 用
 *   `node:os` 算好，接口直接用；
 * - **磁盘**（`disks`）只在 `?detail=1` 时用 `fs.statfs` 现采，平时为空数组。
 *
 * 全部走 Node 内置 API：**无子进程、无 `systeminformation`、无 `ps`**。
 * 网络速率 / Top 进程 / CPU 温度 / swap **已移除** —— 它们要么需要子进程（`ps`、
 * PowerShell）、要么 Node 不暴露，与「轻量常驻监控」的目标冲突。
 */
export interface SystemSnapshot {
  /** 采样时间（Date.now()） */
  at: number;

  // ---- CPU ----
  /** CPU 总占用百分比 0–100（自上一采样窗口的平均） */
  cpuLoad: number;
  /** 每核占用百分比（数组序即核序；首帧无基准为空数组） */
  cpuLoadPerCore: number[];
  /** 当前主频（GHz），读不到为 null */
  cpuSpeedGHz: number | null;
  /** 逻辑核心数（静态） */
  cpuCores: number;
  /** CPU 型号（静态，启动时采一次） */
  cpuBrand: string;

  // ---- 内存 ----
  memTotal: number;
  memUsed: number;
  memAvailable: number;
  /** 内存已用百分比 0–100 */
  memUsedPercent: number;

  // ---- 磁盘（仅 detail=1 填充）----
  /** 各磁盘分区占用；非 detail 为空数组 */
  disks: SystemDiskUsage[];

  // ---- 系统 / 进程（静态或廉价）----
  os: SystemOsInfo;
  process: SystemNodeProcess;
}

/**
 * 历史曲线上的一个点：只留画 CPU / 内存**两条趋势线**用得着的字段。
 * 服务端在环形缓冲里保留最近约 6 分钟（180 个点 × 2s）。
 */
export interface SystemSample {
  at: number;
  cpuLoad: number;
  memUsedPercent: number;
}

/** `GET /api/system` 的应答体 */
export interface SystemMetrics {
  /** 当前快照 */
  snapshot: SystemSnapshot;
  /** 近期采样点（升序，旧的在前），用于画曲线 */
  history: SystemSample[];
  /** 采样间隔（毫秒），前端轮询与曲线 x 轴对齐用 */
  sampleIntervalMs: number;
}

// ---------------------------------------------------------------------------
// SSH 主机的性能监控（`GET /api/ssh/hosts/:id/metrics`）
//
// 与本机那份（`SystemMetrics`）**刻意分成两套类型**，不复用：
// - 采集方式不同：本机走 Node 内置 API（`node:os`，跨平台，Windows 也支持）；远端只有一条
//   SSH exec 通道，靠 `/proc` + `df`，**只支持 Linux**（见 `HostMonitorUnsupportedReason`）；
// - 字段不同：远端拿不到「运行 fizz 的 Node 进程自身占用」（`SystemNodeProcess` 是本地
//   概念）、也拿不到每核细分；反过来远端有 load average（本机那份没有）。
// 硬凑成一套的话，两边都会带着一堆恒为 null / 空数组的字段，读的人分不清「没采到」和
// 「这个概念在对面不存在」。
// ---------------------------------------------------------------------------

/** 远端一个挂载点的磁盘占用（`df -P -B1` 的一行） */
export interface HostDiskUsage {
  /** 挂载点（`/`、`/data`…） */
  mount: string;
  /** 已用（字节） */
  used: number;
  /** 总容量（字节）= 已用 + 可用 */
  total: number;
  /** 已用占比 0–100（取 `df` 自己的 Capacity 列） */
  percent: number;
}

/**
 * 远端主机的一次采样快照。
 *
 * 除 `at` 之外全部来自一条 SSH exec 命令的输出（见服务端 `ssh/host-metrics.ts` 的
 * `COLLECT_CMD`），**没有任何跨平台兜底**：读不到的字段就是 0 / null，不做假数据。
 */
export interface HostMetricsSnapshot {
  /** 采样时间（Date.now()，取的是**服务端**的钟） */
  at: number;
  /**
   * CPU 占用百分比 0–100。
   *
   * ⚠️ **首帧为 null**：占用是「两次采样之间的 CPU 时间差」算出来的，第一次采样没有
   * 基准。长间隔后重连（空闲回收 → 重新连上）同样回到 null，理由见服务端
   * `parseHostMetrics` 的 gap 说明。
   */
  cpuPercent: number | null;
  /** 逻辑核心数（由 `/proc/stat` 的 `cpuN` 行数得出） */
  cores: number;
  /** CPU 型号（`/proc/cpuinfo` 的 `model name`，读不到为空串） */
  cpuBrand: string;

  memTotal: number;
  memUsed: number;
  /** 内存已用百分比 0–100 */
  memPercent: number;
  swapTotal: number;
  swapUsed: number;
  swapPercent: number;

  /** 1 / 5 / 15 分钟平均负载（`/proc/loadavg`） */
  load1: number;
  load5: number;
  load15: number;

  /** 全部非回环网卡合计下行速率（字节/秒，自算） */
  netRxPerSec: number;
  /** 全部非回环网卡合计上行速率（字节/秒，自算） */
  netTxPerSec: number;

  /** 各挂载点占用（已滤掉 tmpfs / overlay 这类伪文件系统） */
  disk: HostDiskUsage[];
  /** 已运行秒数（`/proc/uptime`） */
  uptime: number;

  // ---- 静态（首次采样时随采集命令一起取回，之后不变）----
  hostname: string;
  /** 发行版名（`/etc/os-release` 的 `PRETTY_NAME`，读不到为空串） */
  distro: string;
  /** 内核版本（`uname -r`） */
  release: string;
  /** 架构（`uname -m`） */
  arch: string;
}

/** 远端历史曲线上的一个点（字段与 `SystemSample` 对齐，便于两边共用折线组件） */
export interface HostMetricsSample {
  at: number;
  /** 该帧的 CPU 占用（首帧为 0，因为当时算不出来） */
  cpuPercent: number;
  memPercent: number;
  netRxPerSec: number;
  netTxPerSec: number;
}

/**
 * 「这台主机不支持监控」的原因（终态：服务端已停止采集，不会再翻回来）。
 *
 * - `windows`：远端是 Windows（本地终端那边 `platform` 就是这么叫的）；
 * - `other`：远端平台识别出来了但不是 Linux（BSD / macOS…）；
 * - `unavailable`：平台未知且连续多轮采不到有效数据（没有 `/proc`，或 `/proc` 被裁剪）。
 *
 * ⚠️ 前端**不展示**这个原因：状态栏那颗主机监控徽标收到 `unsupported` 后整个撤掉
 * （见 `HostMonitorBadge` 的文件头），不在右下角留一句话。原因留在协议里是因为
 * 排查「这台机器为什么没有监控」时要看的就是它 —— 别以为没人用就删了。
 */
export type HostMonitorUnsupportedReason = "windows" | "other" | "unavailable";

/** `GET /api/ssh/hosts/:id/metrics` 的应答体 */
export interface HostMetrics {
  /**
   * 当前快照。**首帧为 null**（还没采到）—— 远端要现连 SSH + 跑一条命令，第一次轮询
   * 通常来不及，前端显示「读取中…」即可，不必让这个请求阻塞到连上为止。
   */
  snapshot: HostMetricsSnapshot | null;
  /** 近期采样点（升序，旧的在前），用于画曲线 */
  history: HostMetricsSample[];
  /** 采样间隔（毫秒），前端轮询与曲线 x 轴对齐用 */
  sampleIntervalMs: number;
  /** 非 null = 这台主机不支持监控（终态，采集已停） */
  unsupported: HostMonitorUnsupportedReason | null;
  /**
   * 最近一次采集失败的原因（**非终态**，下一帧会重试）。与 `unsupported` 互斥：
   * 有 `unsupported` 时这里是 null。
   */
  error: string | null;
}

// ---------------------------------------------------------------------------
// 模型请求的自动重试（客户端偏好 + 服务端执行，常量放契约里让两端共用一份）
// ---------------------------------------------------------------------------

/** 模型请求失败后的自动重试次数缺省值 */
export const DEFAULT_MAX_RETRIES = 2;

/** 「不限次数」的重试设置值：设置里填 0 = 一直重试 */
export const UNLIMITED_RETRIES = 0;

/**
 * 取生效的「模型请求重试次数上限」。
 *
 * `0 = 不限制`（返回 `Infinity`，一直重试）；其余按非负整数四舍五入。
 * 缺省 = `DEFAULT_MAX_RETRIES`。只对**可重试的请求错误**（网络中断 / 上游空响应）生效，见 @fizz/agent。
 */
export function resolveMaxRetries(override?: number): number {
  const n = override ?? DEFAULT_MAX_RETRIES;
  const rounded = Math.max(0, Math.round(n));
  return rounded === UNLIMITED_RETRIES ? Number.POSITIVE_INFINITY : rounded;
}

// ---------------------------------------------------------------------------
// 工具调用并发（客户端偏好 + 服务端执行，常量放契约里让两端共用一份）
// ---------------------------------------------------------------------------

/** 同一批 tool-call 最多同时执行几个的缺省值（也是设置页的初始值） */
export const DEFAULT_TOOL_CALL_CONCURRENCY = 3;
/** 下限：1 = 同一批工具调用完全串行 */
export const MIN_TOOL_CALL_CONCURRENCY = 1;
/** 上限：引擎自己的默认并发就是 10，再高没有收益、只会更容易压垮工具 */
export const MAX_TOOL_CALL_CONCURRENCY = 10;

/**
 * 收敛「工具调用并发数」：非数字 / 越界一律夹到 [1, 10]，缺省 = 3。
 *
 * 这是**每步**的上限，不是一轮对话的总工具数：模型一步返回 20 个 tool-call 时，
 * 服务端也只会同时跑这么多个，其余排队。
 */
export function resolveToolCallConcurrency(override?: number): number {
  const n =
    typeof override === "number" && Number.isFinite(override)
      ? Math.round(override)
      : DEFAULT_TOOL_CALL_CONCURRENCY;
  return Math.min(
    MAX_TOOL_CALL_CONCURRENCY,
    Math.max(MIN_TOOL_CALL_CONCURRENCY, n),
  );
}

// ---------------------------------------------------------------------------
// 工具步数上限（客户端偏好 + 服务端执行，常量放契约里让两端共用一份）
// ---------------------------------------------------------------------------

/**
 * 一轮对话里最多跑多少步的缺省值（1 步 = 一次模型请求 + 一轮工具执行）。
 *
 * 取 80：正常任务（读几个文件 → 改 → 验证）十几步就够，80 留了充足余量；
 * 而 500 是「几乎不设限」—— 一旦模型陷入反复重试，能在触发压缩之前就烧掉整个窗口
 * （每步都要重发全量上下文，第 N 步的成本是第 1 步的 N 倍）。
 *
 * 它是**缺省值**、不是硬上限：设置 → AI → 偏好里可以按自己的任务调（见 `resolveMaxSteps`）。
 * 常量放在契约里，是因为设置页（浏览器）与 agent 运行时（服务端）要读同一个数 ——
 * 客户端不能 import `@fizz/agent`（会把整个运行时拖进包里）。
 */
export const DEFAULT_MAX_STEPS = 80;
/** 下限：至少 1 步（0 步 = 这一轮什么都不做） */
export const MIN_MAX_STEPS = 1;
/** 上限：再高与「不设限」无异，只是把烧窗口的时间拖长 */
export const MAX_MAX_STEPS = 1000;

/**
 * 收敛「工具步数上限」：非数字 / 越界一律夹到 [1, 1000]，缺省 = `DEFAULT_MAX_STEPS`。
 *
 * ⚠️ 这是**一轮**的上限，不是整个会话：用户追问一句就是新的一轮、预算重新开始。
 */
export function resolveMaxSteps(override?: number): number {
  const n =
    typeof override === "number" && Number.isFinite(override)
      ? Math.round(override)
      : DEFAULT_MAX_STEPS;
  return Math.min(MAX_MAX_STEPS, Math.max(MIN_MAX_STEPS, n));
}

/** 追加一条用户消息并跑一轮（服务端负责落盘助手回复） */
export interface ChatRequest {
  conversationId: string;
  /** 用户这一轮说的话 */
  text: string;
  /**
   * 本轮携带的附件：先经 POST /api/uploads 上传拿到的 url。服务端把它们转成
   * file parts（排在 text part 之前）落盘并提交模型；url 必须是本服务上传接口
   * 发出的（归属校验不过 → 400，防任意 URL 注入历史）。
   */
  files?: UploadFileRef[];
  /**
   * 后端：acp = 外部 ACP agent 进程，内置 = 内置模型。会话必须显式绑定（创建 /
   * 选择时落库），服务端不再有任何「跟随工作区 / 跟随默认」的回退 —— 没带就 400。
   * ⚠️ configId 的语义随 backend 变：acp → ACP agent id；内置 → 模型配置 id。
   */
  backend?: AgentBackend;
  /** 会话显式绑定的配置 / agent id；缺失或悬空（被删了）一律 400，不再静默回退 */
  configId?: string;
  /**
   * `builtin` 下：这份模型配置里用**哪一个**上游模型（`AiModelConfig.models` 的一项）。
   * 缺失或不在清单里 → 400（不存在「配置默认模型」）。`acp` 下可省（省 = agent 自己的默认）。
   */
  modelId?: string;
  /**
   * 本轮思考强度覆盖（仅 `builtin`）。缺省 = 用会话记住的 `reasoningEffort`。
   * 请求里带一份是为了避免「刚点完 pill 立刻发送」时 PATCH 还没落盘、这一轮按旧档跑。
   */
  reasoningEffort?: AiReasoningEffort;
  /** 命令执行权限；服务端默认 confirm（网页端不该默认裸跑命令） */
  permissionMode?: AiPermissionMode;
  /**
   * confirm 模式下等用户答复审批的最长时间（毫秒）。**0 = 不超时**（一直等）；
   * 缺省 = 服务端默认 10 分钟。每一轮请求都带上（这个偏好存在客户端）。
   */
  confirmTimeoutMs?: number;
  /**
   * 模型请求失败后的自动重试次数。**0 = 不限制**（一直重试）；缺省 = `DEFAULT_MAX_RETRIES`。
   * 只对可重试的请求错误（网络中断 / 上游空响应）生效。已经跑完若干步的轮次走**断点续跑**
   * （从失败的那一步接着发，已完成的工具不重跑）；没有断点又已经执行过工具的轮次不重试，
   * 避免重复副作用。每一轮请求都带上（这个偏好存在客户端）。
   */
  maxRetries?: number;
  /**
   * 同一批 tool-call 最多同时执行几个（1 = 串行，缺省 = `DEFAULT_TOOL_CALL_CONCURRENCY`）。
   * 每一轮请求都带上（这个偏好存在客户端）；只影响内置 Agent 的工具执行。
   */
  toolCallConcurrency?: number;
  /**
   * 一轮对话里最多跑多少步（1 步 = 一次模型请求 + 一轮工具执行）。
   * 缺省 = `DEFAULT_MAX_STEPS`；每一轮请求都带上（这个偏好存在客户端）。
   * 只影响内置 Agent —— ACP 后端跑多久由外部 agent 自己决定。
   */
  maxSteps?: number;
  /**
   * 是否让模型为每次工具调用写一句「意图」（一句话说明这一步要干什么），
   * 渲染层拿它当工具卡标题。缺省 `true`；每一轮请求都带上（这个偏好存在客户端）。
   *
   * 关掉 = **不再往工具 schema 注入 `intent` 字段**（每个工具省一个字段的 tokens，
   * 提示词里那条约定也一起撤掉），工具卡标题退回工具名。
   * 只影响内置 Agent —— ACP 后端的工具卡标题由外部 agent 自己给。
   */
  toolIntent?: boolean;
  /**
   * 这一轮 user 消息的落盘 id（缺省 `u-<ts>` 自生成）。
   *
   * 两种用法：
   * - **普通发送**：客户端把它那条乐观消息的 id 递上来，服务端落盘**沿用同一个 id** ——
   *   收尾拉权威历史覆盖本地现场时消息 id 不变，React 按 id 作 key 就不会把刚跑完这一轮的
   *   子树整棵重挂载（观感是「消息列表跳一下 / 图片重走骨架」）。
   * - **插话收尾兜底**（见 `chat-turn.ts` 的 drainSteerInbox）：插话在边界没被消费、由兜底起
   *   新一轮时，服务端已经把这条消息广播给了客户端（`user-injected` 事件）—— 新一轮落盘用
   *   **同一个 id**，客户端按 id 去重才不会显示成两条。
   */
  userMessageId?: string;
  /**
   * 这一轮**助手消息**的落盘 id（缺省 `a-<ts>` 自生成），规则同 `userMessageId`：客户端
   * 生成、服务端沿用，收尾换权威历史时 id 不变 → 子树不重挂载。
   *
   * 插话把这一轮切成多段时，各段按 `assistantSliceId()` 派生（见下面那个函数）——
   * **两端必须用同一份推导**，否则插话轮次照样会重挂载。
   */
  assistantMessageId?: string;
  /**
   * 随本轮请求携带的**客户端工具**（定义在这里，执行在客户端）。
   *
   * 用途：让 AI 操作**客户端才够得着**的东西 —— 最典型的是渲染端正在看的终端
   * （xterm 缓冲 + 它自己那条 WS；服务端没有活会话注册表，够不着）。
   *
   * 执行路径与 confirm / followup 同一条反向通道：服务端把调用推成
   * `client-tool-call` 帧 → 客户端就地执行 → POST /api/chat/client-tool-result
   * 回填 → 服务端解开 await 继续同一个回合。
   *
   * ⚠️ **权限与确认全在客户端**：服务端不做任何闸，直接把调用广播回去；
   * 客户端按自己的权限设置决定直接执行 / 弹卡 / 拒绝（拒绝文案作为正常工具结果回传）。
   * ⚠️ 客户端工具与内置 / MCP 工具**同名时内置优先**（服务端跳过并告警），
   * 避免客户端偷偷顶掉一个受审批保护的内置工具。
   */
  clientTools?: ClientToolSpec[];
}

/**
 * 运行中插话把一轮助手回复切成多段时，**后继各段**的落盘 id。
 *
 * 以「那条插话 user 消息的 id」为键、而不是用序号，是刻意的：插话消息的 id 两端本来就
 * 共享 —— 服务端在 `POST /api/chat/steer` 里生成，客户端从响应体与随后的 `user-injected`
 * 事件里各拿到一次。用序号的话两端还得对「哪些边界产出了非空段」达成一致（服务端遇到
 * 空段会跳过不落盘），一次错位后面全错；用 id 作键则每段各算各的，天然对齐。
 *
 * ⚠️ **两端必须调同一个函数**（服务端落盘 = `chat-turn.ts` 的 persistAssistant，
 * 客户端建占位 = `conversation.ts` 的 `user-injected` 分支），否则插话轮次照样重挂载。
 */
export function assistantSliceId(
  baseId: string,
  steerMessageId: string,
): string {
  return `${baseId}-s@${steerMessageId}`;
}

/**
 * 一个客户端工具的**声明**（只有形状，没有实现 —— 实现在发起请求的那个客户端）。
 *
 * `inputSchema` 是 JSON Schema（不是 zod）：它要跨进程传输，服务端只把它转交给模型。
 * 缺省按空对象入参处理（模型仍能调用，只是没有参数）。
 */
export interface ClientToolSpec {
  name: string;
  description: string;
  /** JSON Schema（`{ type: 'object', properties: {...} }`）；缺省 = 无参数 */
  inputSchema?: Record<string, unknown>;
  /**
   * 这个工具会不会**改动外部状态**（终端里跑命令 / 发按键都算）。
   *
   * 声明方是客户端（工具是它自己实现、自己执行的），服务端据此在 `buildClientToolset`
   * 里套审批闸：`readonly` 直接拒、`confirm` 先问用户、`full` 放行。
   *
   * ⚠️ 缺省 = `false`（只读）。只读工具（读终端输出 / 列会话）不该被拦 —— 把「看一眼
   * 日志」也变成一次审批，用户会很快学会无脑点允许，那才是真的没有闸。
   */
  mutating?: boolean;
}

// ---------- 项目管理助手 ----------

/** 发一句话给项目助手(POST /api/assistant;会话 id 来自先 POST conversations 新建) */
export interface AssistantSendInput {
  /**
   * 这一次会话的 **id**（客户端生成，仅作 run 注册表的键）。
   *
   * ⚠️ 服务端**不落盘、不认识它** —— 助手没有「多会话」概念，每次打开面板就是一个新会话，
   * 历史由客户端随 `history` 带上。它唯一的作用是让这一轮的 run 在共享注册表里有个键
   * （断线重接 / 审批答复都按它找）。
   */
  sessionId: string;
  /** 用户这一轮说的话 */
  text: string;
  /**
   * 客户端手上的**本地历史**（不含本轮这条 `text`）。
   *
   * 助手的历史只暂存在客户端（内存），服务端不留 —— 所以每轮都要把它带上来，
   * 服务端拼上 `text` 后直接喂给模型。这也是「服务端不落盘」的代价与前提。
   */
  history?: AgentChatMessage[];
  /**
   * 这轮用的模型(只有内置 Agent agent,没有 ACP):配置 id + 配置下的模型 id。
   * 缺省 = 服务端取「第一份带模型的配置的第一个模型」;带了但悬空 / 不在清单 → 400 人话错误。
   */
  configId?: string;
  modelId?: string;
  /**
   * 这一轮助手的**作用域** —— 决定挂哪一组工具,两组**互斥**:
   *
   * - `'project'`(缺省):项目管理助手。挂 `buildProjectTools`(建 / 删项目、worktree、
   *   定时任务、插件、建会话),**不挂任何终端工具**;
   * - `'terminal'`:终端标签内嵌的助手。只挂客户端带上来的终端工具(执行命令 / 读输出 /
   *   发按键),**不挂项目管理工具** —— 它绑定的是某一条终端,「跨项目建目录 / 删项目」
   *   在这条会话里没有语境。
   *
   * 刻意做成**显式字段**而不是「有 clientTools 就当作 terminal」:两组工具的取舍是
   * 产品语义(面板挂在哪),不该由一个可缺省的数组长度隐式决定。
   */
  scope?: "project" | "terminal";
  /**
   * 随请求携带的客户端工具(见 `ClientToolSpec`)。
   *
   * **只有 `scope: 'terminal'` 时会装进这一轮** —— 客户端把那个终端的工具带上来,
   * 模型于是能直接操作用户眼前这台终端;`scope: 'project'` 时一律忽略。
   */
  clientTools?: ClientToolSpec[];
  /**
   * 这一轮助手的**工具权限档**（与主会话 `ChatRequest.permissionMode` 同一套语义）。
   *
   * 缺省 `confirm` —— 助手面板是「一句话就让 agent 动手」的入口，默认裸跑不合适。
   *
   * 落地范围**随 scope 不同**：
   * - `terminal`：闸在 `buildClientToolset`（按客户端工具的 `mutating` 声明）—— 三档全生效；
   * - `project`：只有 `readonly` 生效（拒绝全部改动），`confirm` / `full` 一律弹审批 ——
   *   项目工具的作用域在单个工作区之外，且「一次授权、长期自动执行」，见
   *   `packages/tools/src/project-tools.ts` 的 `guardMutation`，别按这里的档位去放松它。
   */
  permissionMode?: AiPermissionMode;
  /**
   * 模型请求失败后的自动重试次数。**0 = 不限制**（一直重试）；缺省 = `DEFAULT_MAX_RETRIES`。
   *
   * 与 `ChatRequest.maxRetries` **同一套语义、同一个客户端偏好**：助手面板也是「一轮对话」，
   * 用户把设置页调到 20 就该按 20 跑。这条字段曾经缺席，于是助手链路恒按缺省的 2 次重试
   * ——现象是「开头重试两次后，会话中途再失败就直接报错、不再重试」。
   * 只对可重试的请求错误生效（网络中断 / 上游空响应），判据全在 `@fizz/agent` 的外层循环里。
   */
  maxRetries?: number;
}

export interface ChatStartInfo {
  requestId: string;
  conversationId: string;
}

/**
 * 一条对话请求的摘要（`GET /api/chat/active` 用）。
 *
 * 客户端拿它判断「这个会话是不是有活在跑」：有就插一条空的助手消息占位、
 * 打开停止按钮，然后 attach 回放现场；没有就走「拉服务端落盘的权威历史」。
 */
export interface ChatRunSummary {
  requestId: string;
  conversationId: string;
  status: "running" | "finished";
  /** 这一轮开始的时刻（epoch ms） */
  startedAt: number;
  /** status === 'finished' 时的结束原因 */
  finishReason?: string;
  /**
   * 这一轮助手消息的落盘 id（发起那一轮的客户端在 `ChatRequest.assistantMessageId` 里给的那个）。
   *
   * 让「接手一条已经在跑的 run」的那个端（刷新页面后 / 另一个标签页）能用**同一个 id**
   * 建本地占位 —— 否则收尾换权威历史时 id 一变，刚回放出来的正文整棵重挂载。
   * 缺省（老客户端没传）时没有，接手方退回自生成。
   */
  assistantMessageId?: string;
}

/** `GET /api/chat/active?conversationId=` 的应答；`run: null` = 这个会话当前没在跑 */
export interface ChatActiveResult {
  run: ChatRunSummary | null;
}

/**
 * POST /api/chat/compress（手动压缩）的响应。
 *
 * `ok: true` 时带落库的检查点（含统计，前端横幅 / popover 直接展示）；
 * `ok: false` = 没压缩也没改动（如对话不足两轮），`reason` 说明原因，可以直接给用户看。
 * 摘要请求失败走流里的 `error` 帧（HTTP 已经切到 SSE，改不了状态码）。
 */
export interface ChatCompressResult {
  ok: boolean;
  reason?: string;
  summary?: ConversationContextSummary;
}

/**
 * POST /api/chat/compress（手动压缩）的 SSE 帧。
 *
 * 与自动压缩共用同一组 `context-compaction-*` / `context-compressed` 事件 —— 手动压缩
 * 也要把摘要过程实时显示成同一个折叠块，而不是只转圈等一个最终结果。
 *
 * - `event`：压缩过程事件（只会有上面那三种上下文压缩事件）
 * - `result`：压缩结束的最终结果（成功 / 没有可压缩的部分）
 * - `error`：摘要失败等运行时错误；客户端按失败处理，不落检查点
 */
export type ChatCompressFrame =
  | { type: "event"; event: AgentStreamEvent }
  | { type: "result"; result: ChatCompressResult }
  | { type: "error"; message: string };

/**
 * SSE 帧类型（`event:` 字段），data 统一是 `ChatStreamFrame`。
 * - `start`：服务端已接受请求，带上 requestId（客户端据此绑定后续事件与中止）
 * - `event`：一轮里的流事件，与桌面端的 `AgentStreamEvent` 完全一致
 * - `confirm`：confirm 模式下要执行破坏性操作，**等用户答复**（客户端 POST `/api/chat/confirm`）
 * - `confirm-resolved`：某次审批已有结果（本端答复、其它端答复、或超时），客户端据此撤卡片
 * - `ask-followup`：ai-sdk 后端调用 `ask_followup_question` 提问，**等用户答复**（POST `/api/chat/followup`）
 * - `ask-followup-resolved`：某次提问已有结论，客户端据此撤卡片
 * - `replay-end`：这条连接的帧日志**已回放完**（紧跟在回放之后、直播之前）。
 *   它不是这一轮的一部分，**不进程日志**，只在 attach 出来的那条流里出现一次 ——
 *   客户端据此知道「现场恢复完毕」（回放期间内容先塌后长，滚动跟随要按瞬时处理）
 * - `end`：这一轮结束（服务端已落盘），客户端可以收流了
 */
export type ChatStreamFrameType =
  | "start"
  | "event"
  | "confirm"
  | "confirm-resolved"
  | "ask-followup"
  | "ask-followup-resolved"
  | "client-tool-call"
  | "replay-end"
  | "end";

export interface ChatStreamFrame {
  type: ChatStreamFrameType;
  requestId: string;
  /** type === 'event' 时有值 */
  event?: AgentStreamEvent;
  /** type === 'confirm' 时有值：待批准的请求（形状与桌面端 `agent:confirm` 一致） */
  confirm?: AgentConfirmRequest;
  /** type === 'confirm-resolved' 时：哪一次审批（对应 AgentConfirmRequest.id） */
  confirmId?: string;
  /** type === 'confirm-resolved' 时：最终是否放行 */
  approved?: boolean;
  /** type === 'ask-followup' 时有值：待回答的提问表单（形状与桌面端 `followup:request` 一致） */
  followup?: AskFollowupRequest;
  /** type === 'ask-followup-resolved' 时：哪一次提问（对应 AskFollowupRequest.id） */
  followupId?: string;
  /** 发起提问的工具调用 id（渲染端据此把卡片定位到对话流的正确位置） */
  toolCallId?: string;
  /**
   * type === 'client-tool-call' 时：这次客户端工具调用的 id（回填时按它对上）。
   *
   * 与 confirm / followup 同构：SSE 只有下行，客户端执行完要另开一条 HTTP
   * 请求（POST /api/chat/client-tool-result）把结果送回来。
   */
  clientToolCallId?: string;
  /** type === 'client-tool-call' 时：要执行的客户端工具名 */
  clientToolName?: string;
  /** type === 'client-tool-call' 时：工具入参（原样透传，客户端自己解释） */
  clientToolInput?: unknown;
  /** type === 'end' 时的结束原因 */
  finishReason?: string;
}

export interface AbortInput {
  requestId: string;
}

/**
 * 审批答复体。
 *
 * 只认「审批 id」不认 requestId：一次对话里可能连续弹多次（每条破坏性命令都要问一次），
 * 而且答复可能来自另一个客户端（同一个人开了两个页面）。
 *
 * `optionId`：ACP 权限请求（confirm 帧带 `options`）时用户挑中的那个选项 id ——
 * 原样回给 agent；内置工具的审批没有它，只看 `approved`。
 */
export interface ConfirmReplyInput {
  id: string;
  approved: boolean;
  optionId?: string;
}

/**
 * 客户端工具的执行结果回填（POST /api/chat/client-tool-result）。
 *
 * ⚠️ **拒绝也是 `ok: true` + 一段说明文案**（当作正常工具结果回给模型，模型据此
 * 换个做法），不要用 `ok: false` 表达「用户拒绝」—— `ok: false` 是「客户端执行
 * 真的出错了」（通道断了 / 客户端崩了），会变成 tool error。
 */
export interface ClientToolResultInput {
  /** 对应 `ChatStreamFrame.clientToolCallId` */
  callId: string;
  ok: boolean;
  /** ok 时：工具结果（字符串最省事；对象会被 JSON 序列化后回给模型） */
  result?: unknown;
  /** !ok 时：失败原因（人话） */
  error?: string;
}

/** 回填是否命中一条挂起的调用（false = 已超时 / 已取消，幂等空成功） */
export interface ClientToolResult {
  resolved: boolean;
}

/**
 * 单条命令停止（POST /api/chat/command/stop）。
 *
 * `toolCallId` = 这次 execute_command 的 toolCallId（前端从工具卡 part 上拿）；
 * 它不是 ACP / 整轮的停止，命中就只杀那一条命令的进程树。
 */
export interface CommandStopInput {
  requestId: string;
  toolCallId: string;
}

/** 停止结果：`false` = 没命中（命令已结束 / run 已结束），幂等空成功 */
export interface CommandStopResult {
  stopped: boolean;
}

/**
 * 运行中切换权限档（POST /api/chat/permission）。
 *
 * 工具集一轮建一次，静态权限档会把档位快照死在整轮里；这条请求改的是该 run 的**活档**
 * （`ChatRun.permissionMode`），闸门每次工具调用现取，中途切换立刻生效。只认
 * `requestId`（这一轮正在跑的 run）；run 不存在 / 已结束 = 幂等空成功。
 */
export interface PermissionSetInput {
  requestId: string;
  permissionMode: AiPermissionMode;
}

/** 结果：`false` = 没命中（run 不存在 / 已结束），幂等空成功 */
export interface PermissionSetResult {
  updated: boolean;
}

/**
 * 答复一次 ask_followup_question 提问。
 *
 * `answer` 为空表示用户跳过（与桌面端「跳过」一致）：工具按「未作答」继续往下跑；
 * 非空则把 `FollowupAnswerItem[]` 作为工具结果回给模型。
 */
export interface FollowupReplyInput {
  /** 对应 AskFollowupRequest.id */
  id: string;
  /** 用户对整张表单的回答；null = 跳过 / 未作答 */
  answer: { answers: FollowupAnswerItem[] } | null;
}

/** 重命名会话（PATCH /api/conversations/:id） */
export interface ConversationRenameInput {
  title: string;
}

/**
 * 运行中插话（POST /api/chat/steer）。`text` 会被 trim；`text` 与 `files` **不能同时为空**
 * （只带附件的插话是合法的 —— 与普通发送 / 队列同一条口径）；
 * 该会话没有活跃 run 时服务端回 409（客户端回落普通发送）。
 */
export interface SteerInput {
  conversationId: string;
  text: string;
  /**
   * 随插话一起注入当前轮的附件（先经 POST /api/uploads 上传拿到的 url 引用，
   * 与 `ChatRequest.files` / `QueuedMessage.files` 同形）。
   *
   * 服务端把它们与 `text` 拼成**一条** user 消息（`buildUserParts`），agent 在下一个
   * 工具步骤边界把这整条 push 进模型上下文 —— 模型当场就能看到图。
   */
  files?: UploadFileRef[];
}

/** 插话已递进收件箱：`message` 是之后会随切片一起落盘的那条 user 消息（含 id） */
export interface SteerResult {
  ok: true;
  message: AgentChatMessage;
}

/** 移除一条还没生效的插话（DELETE /api/chat/steer）。removed=false = 已被 agent 消费 */
export interface SteerRemoveResult {
  ok: true;
  removed: boolean;
}

/**
 * 重排还没生效的插话（PATCH /api/chat/steer）。
 *
 * `ids` 是**新顺序**，语义与队列的 `PATCH /api/conversations/:id/queue` 一致：
 * **整份覆盖**，数组顺序就是生效顺序（收件箱里每条都是独立的 user 消息，
 * 谁先被边界消费谁先进入上下文）。
 *
 * 只传 id、不传消息体：消息是服务端构造的（见 `SteerResult.message`），客户端只能决定顺序。
 * 收件箱是活跃 run 的内存状态 —— 没有活跃 run 回 409（与 POST / DELETE 同一套约定）。
 */
export interface SteerReorderInput {
  conversationId: string;
  ids: string[];
}

/** 会话分叉（POST /api/conversations/:id/fork）：以该条消息（含）为终点签出新会话 */
export interface ForkInput {
  upToMessageId: string;
  /**
   * 分叉出的新会话挂在**哪个工作区**下；缺省 = 原会话的工作区。
   *
   * 给「签出 + 新建 worktree」用：客户端先 `POST /api/workspaces/:id/worktree`
   * 建好 worktree 项目，再把它的 id 带进来 —— 新会话从此在新工作树里干活，
   * 原工作区一行代码不动。
   */
  workspaceId?: string;
}

/** 分叉成功：返回新会话的 Summary（消息体客户端随后自己 loadMessages） */
export interface ForkResult {
  conversation: ConversationSummary;
}

/**
 * 归档 / 取消归档会话（PATCH /api/conversations/:id/archive）。
 *
 * `archived: true` 落一个 `archivedAt` 时间戳；`false` 清掉它（回到项目树）。
 */
export interface ConversationArchiveInput {
  archived: boolean;
}

/**
 * 设置 / 清除会话记住的目标（PATCH /api/conversations/:id/target）。
 * 字段显式传 `null` = 清除该项绑定（界面需要重新选择）；`undefined` = 不动该项。
 * 不存在「回到默认」—— 清除后就是未绑定，服务端会拒绝无绑定的对话轮。
 *
 * ⚠️ 只有 `mcpServerIds` 是**列表**语义：它是全量覆盖（传 `[]` = 一个都不用），
 * 不是「加一个 / 减一个」—— 前端拼好整个新清单再发。
 */
export interface ConversationTargetInput {
  backend?: AgentBackend | null;
  configId?: string | null;
  /** `ai-sdk` 下：这份配置里选中的上游模型（`AiModelConfig.models` 的一项） */
  modelId?: string | null;
  /**
   * 内置 Agent 的思考强度。`undefined` = 不动；`null` = 清除（跟随模型默认）。
   * ACP 会话忽略本字段。
   */
  reasoningEffort?: AiReasoningEffort | null;
  /**
   * ACP 会话的权限答复策略（`confirm` = 逐次问用户 / `allow` = 应用层自动放行）。
   * 传 `null` = 回到缺省 `confirm`。
   */
  acpPermissionMode?: AcpPermissionMode | null;
  /** 这个会话允许使用的 MCP server id 清单（全量覆盖；`[]` = 全不选） */
  mcpServerIds?: string[] | null;
  /**
   * 这个会话的浏览器偏好（总开关 + 来源）。传 `null` = 清除该项绑定（回落到全局默认）；
   * 注意它是**整体对象**语义（enabled / channel 一起给），不是逐字段 patch。
   */
  browserSettings?: BrowserSettings | null;
}

/**
 * 覆盖某个会话的待发送队列：PATCH /api/conversations/:id/queue
 *
 * `items` 是**全量覆盖**（不是「加一条 / 删一条」）：前端维护好整个新清单再发，
 * 数组顺序就是发送顺序 —— 拖拽排序后直接按新顺序写回即可。
 *
 * ⚠️ 队列发出去的只是消息正文：附件 / MCP / 模型都在真正发出那一轮才取会话的当前
 * 设置，入队时记下的上下文会被之后的选择污染。这是有意为之。
 */
export interface ConversationQueueInput {
  items: QueuedMessage[];
}

/**
 * 覆盖协作配置：PATCH /api/conversations/:id/collab
 *
 * 全量覆盖（画布拖拽 / 增删 Agent 都发整份配置）。服务端会 `normalizeCollabSettings`
 * 后落 `config.json`，并把任务 / 消息状态独立留在 `collab.json`。
 */
export interface ConversationCollabInput {
  collab: CollabSettings;
}

/** GET /api/conversations/:id/collab 应答：协作运行态快照 */
export interface CollabStateResult {
  collab: CollabState;
}

/** POST /api/chat/collab/cancel 请求体：取消当前轮里某个子任务 */
export interface CollabCancelInput {
  conversationId: string;
  taskId: string;
}

export interface CollabCancelResult {
  ok: boolean;
}

// ---------- 工作区文件树 / 媒体（桌面 Agent 文件面板在 web 上的对等能力） ----------

/** GET /api/workspaces/:id/files?dir=... 应答：目录项列表 */
export interface FsListResult {
  entries: AgentFsEntry[];
  /**
   * 单目录条目数超过服务端上限、只返回了前一批。
   *
   * **必须透给界面**：悄悄少列一半，用户只会以为「我的文件不见了」—— 这种缺失没有
   * 任何报错、也没法自证，只能靠这面旗子说一句「目录太大，没列全」。
   */
  truncated?: boolean;
}

/** GET /api/workspaces/:id/files/read?path=... 应答：文件内容 */
export interface FsReadResult extends AgentFsFile {}

/** 删除单条消息（DELETE /api/conversations/:id/messages/:messageId）后返回的会话 */
export type MessageDeleteResult = ConversationDetail;

// ---------- 源代码管理（git，类型已迁至 @fizz/git） ----------

export interface SkillToggleInput {
  /** 被停用的技能 id 列表（全量覆盖） */
  disabled: string[];
}

// ---------- ACP agent（外部 agent 进程，backend === 'acp' 时用） ----------

/** 新建 / 更新一个 ACP agent 配置（与桌面端 `AcpAgentConfig` 同一份类型） */
export type AcpAgentInput = {
  id?: string;
  name: string;
  /** 启动命令（会 spawn 成子进程，工作目录是会话所属工作区） */
  command: string;
  args?: string[];
  /** 风格（见 `AcpAgentType`）：决定模式 UI 的语义与位置；不传 = 沿用原有 */
  type?: AcpAgentType;
  /**
   * 「完全放行」时怎么答复权限请求（见 `AcpAllowStrategy`）；不传 = 沿用原有，
   * 新建缺省 `once`（只允许一次，下次仍会问）。
   */
  allowStrategy?: AcpAllowStrategy;
  /** 会话下拉里暴露哪几个模型（设置里挑的）；不传 = 沿用原有，空数组 = 一个都不列 */
  models?: AcpModelOption[];
};

/** 列表返回：与配置同形（历史上的 isDefault 已随「默认」概念移除） */
export type AcpAgentView = AcpAgentConfig;

/**
 * ACP agent 的身份判据：**命令 + 参数**。
 *
 * 名称只是给人看的，不参与判重（改个名还是同一个 agent）；命令或参数任一不同就是
 * 另一个 agent（比如同一个 CLI 带不同 `--profile`）。
 *
 * 服务端「不让重复添加」与设置页的「已添加」标记共用这一个函数 —— 两边各写一套
 * 迟早会跑偏（一边判重一边不认，用户看到的就是「点不动但也没提示」）。
 */
export function acpAgentKey(agent: {
  command: string;
  args?: string[];
}): string {
  return JSON.stringify([agent.command.trim(), ...(agent.args ?? [])]);
}

/**
 * PATH 上探测到的 ACP agent（只是候选，用户确认后才落库）。
 * 类型真源在 `@fizz/acp`（桌面端探测也在用），这里转出一份给 API 层用。
 */
export type { DetectedAcpAgent } from "@fizz/acp";

// ---------- MCP server ----------

/** 单个 MCP server 的工具清单（`mcpServerTools` 的返回；连不上时 `errors` 里是原因） */
export interface McpServerToolsResult {
  infos: McpToolInfo[];
  errors: string[];
}

/** 技能接口返回：与桌面端 `skills:list` 同构 */
export type SkillsResponse = SkillListResult;

/**
 * 子任务接口返回：只有「用户启用了哪几个」。
 *
 * 定义（有哪些子任务、各自的工具白名单 / 模型 / 步数）在 `packages/agent/src/subagents.ts`，
 * 刻意**不透给客户端** —— 前端只需要一份开关清单，知道白名单反而会引导它去猜实现。
 */
export type SubagentsResponse = SubagentSettingsResult;

export interface SubagentSettingsResult {
  subagents: SubagentSettings;
}

// ---------- 浏览器 ----------

/**
 * 浏览器运行时接口返回：安装状态 + 最近一次安装任务。
 *
 * `task` 为 null = 从没装过也没卸过（或者服务端重启过，后台任务清单不落盘）。
 * 判断「正在安装」看 `runtime.downloading`，不要看 `task`（agent 工具的首次使用
 * 也会触发同一次下载，那条路径没有任务）。
 */
export interface BrowserRuntimeResult {
  runtime: BrowserRuntime;
  task: BackgroundTaskView | null;
}

// ---------- 应用日志 ----------

/** 日志级别。刻意只有三档（与 dogi 一致）：业务事件不需要 debug 噪音 */
export type AppLogLevel = "info" | "warn" | "error";

/**
 * 日志命名空间标识（`ssh` / `terminal` / `plugin` …）。
 *
 * ⚠️ 是宽松的 `string` 而不是联合类型：命名空间由各功能模块**运行时注册**，
 * 契约层不该知道有几个 —— 加联合类型就等于每加一个功能要改一次契约。
 */
export type AppLogScope = string;

/** 一个命名空间的元数据（面板据此渲染 Tab）；来自 `registerNamespace` 的注册表 */
export interface AppLogNamespace {
  id: AppLogScope;
  /** 展示名（如 `SSH`） */
  label: string;
}

/** 一条应用日志 */
export interface AppLogEntry {
  /** 自增序号，跨重启从落盘最大值继续；渲染端 key（同 seq 重复出现 = 该条被更新） */
  seq: number;
  /** 时间戳（毫秒） */
  ts: number;
  scope: AppLogScope;
  level: AppLogLevel;
  /** 单行正文 */
  message: string;
  /** 多行补充，折叠展示 */
  detail?: string;
}

/** `GET /api/app-log` 的应答（全量语义：日志是环形缓冲，量有上限，不做分页） */
export interface AppLogResult {
  /** 日志条目（按 seq 升序） */
  entries: AppLogEntry[];
  /** 当前服务端持有的最大 seq —— 前端订阅增量时作为 `?since=` 起点 */
  maxSeq: number;
  /** 已注册的命名空间（面板 Tab 列表，按注册表的 order） */
  namespaces: AppLogNamespace[];
  /** 日志里出现过但没注册的命名空间（兜底 Tab，提示「漏注册」） */
  unregistered: AppLogScope[];
  /**
   * 落盘日志文件所在目录（**server 那台机器上的**绝对路径）。
   *
   * ⚠️ 桌面端 = 用户本机（server 跑在进程内），可以「打开目录」；web 部署在 VPS 上时
   * 这是 **VPS 上**的路径，浏览器碰不到 —— 面板只在桌面端给「打开目录」入口，
   * web 端把路径摆在悬停提示里，让用户自己上服务器看。
   * 未落盘（目录不可用 / 尚未 init）时为空串。
   */
  directory: string;
}

/**
 * 应用日志**流**（`/api/app-log/stream`）推给客户端的一帧。
 *
 * 约定：`append` 帧只带**增量**条目（`since` 之后的新日志），
 * 前端按 seq 覆盖（同 seq 重复 = 该条被就地更新）。
 */
export type AppLogFrame =
  /** 增量日志（可能一次多条） */
  | { type: "append"; entries: AppLogEntry[] }
  /** 清空事件：前端据此清空本地缓冲 */
  | { type: "clear" };

/** docker 与镜像的可用性（流程页顶部的状态条用） */
export interface DockerStatus {
  /** docker 守护进程可达 */
  available: boolean;
  /** 不可达时的原因（给用户看的一句话） */
  error?: string;
  /** docker 版本（探到才有） */
  version?: string;
  /** 使用的镜像名 */
  image: string;
  /** 镜像是否已构建好 */
  imageReady: boolean;
  /** 正在构建（避免重复触发构建） */
  building: boolean;
  /** 最近一次构建失败的原因 */
  buildError?: string;
}

export type {
  AgentBackend,
  AiApiStyle,
  AiModelConfig,
  AiModelEntry,
  AiModelSettings,
  AiPermissionMode,
  AiProviderKind,
  AiReasoningEffort,
  AgentChatMessage,
  AgentConfirmRequest,
  AgentConversation,
  AgentFsEntry,
  AgentFsFile,
  AgentMessagePart,
  AgentStreamEvent,
  AgentWorkspace,
  CollabSettings,
  AskFollowupRequest,
  FollowupAnswerItem,
  QueuedMessage,
  UploadFileRef,
};

// ---------------------------------------------------------------------------
// 附件上传（图片 / PDF）：客户端与共享的校验 / 拼装规则（服务端在 UploadAdapter 之
// 前也用同一份白名单与 parts 拼装——规则只有一份，两端才不会漂）
// ---------------------------------------------------------------------------

/** 单个附件的大小上限：10MB（base64 解码后按字节判） */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 允许上传的 MIME **精确集合**（不是 `image/*` 前缀）：刻意排除 `image/svg+xml` ——
 * SVG 可以内嵌 `<script>`，而 GET 路由在公开白名单里（`<img>` 带不了鉴权头），
 * 直出 SVG 等于自己开 XSS 面。
 */
export const UPLOAD_ALLOWED_MIME: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

export function isUploadAllowedMime(mediaType: string): boolean {
  return UPLOAD_ALLOWED_MIME.has(mediaType);
}

/** POST /api/uploads 的请求体：JSON + base64（desktop IPC 桥 body 只支持字符串） */
export interface UploadInput {
  /** 原始文件名（仅展示与推导扩展名用；不参与存储路径） */
  name: string;
  mediaType: string;
  /** 文件字节流的 base64 编码 */
  dataBase64: string;
  /**
   * 用哪个上传源；缺省 = 内置存储（`local`）。
   *
   * 上传源可以是插件注册的（见 `GET /api/uploads/providers`）：`ctx.uploads.register` 之后，
   * 字节由插件的 `put` 落到它自己的存储（图床 / S3 / 对象存储…），交回来的就是一条 URL。
   */
  provider?: string;
  /**
   * 这次上传属于哪个项目（可选）：带了，该项目的**项目级**插件也能提供上传源；
   * 不带就只有**全局（用户级）**插件那一份 —— 上传允许发生在还没选项目的场景。
   */
  workspaceId?: string;
}

/** POST /api/uploads 的响应体；`url` 直接填进消息的 files 引用 */
export interface UploadResult {
  url: string;
  name: string;
  mediaType: string;
  size: number;
  /** 实际使用的上传源 id（回填进附件引用，历史回显时能看到它是谁传的） */
  provider?: string;
}

/** GET /api/uploads/providers 里的一个上传源（前端选择器 + 本地预校验用） */
export interface UploadProviderView {
  id: string;
  /** 选择器里的显示名 */
  title: string;
  /** 该上传源接受的 MIME 精确集合（前端按所有可选源的并集放宽本地校验） */
  acceptMime: string[];
  maxBytes: number;
  /** false = 不出现在选择器里（插件只想被显式指定） */
  selectable: boolean;
  /** 缺省上传源（不传 `provider` 时用它） */
  isDefault: boolean;
  /** builtin = 内置存储；plugin = 插件注册的 */
  source: "builtin" | "plugin";
  /** 人可读来源（插件名 / 'builtin'） */
  sourceName: string;
}

/** GET /api/uploads/providers 的响应 */
export interface UploadProvidersResult {
  providers: UploadProviderView[];
}

// ---------- 插件界面（`ctx.ui` / 清单注册的面）----------
//
// 界面上只有一种位置：**主视图区的标签页**。插件不占图标栏、也没有自己的侧栏 ——
// 图标栏里一颗「插件」打开插件列表，点插件就在标签条里开它的标签页。
// `activityBar` / `sider` 两种 kind 还留在联合类型里只为兼容老插件（渲染成标签页）。

/**
 * 插件界面的内容单元。与 `@fizz/plugin` 的 `UiBlock` **同构，但只带数据** ——
 * 插件侧的声明里带着 `render` / `onAction` 函数，那些**绝不发往浏览器**。
 *
 * 前端按 `kind` 渲染成内置组件即可（不需要通用模板引擎，块类型是有限的几种）。
 */
export type PluginBlockTone =
  "normal" | "muted" | "success" | "warn" | "danger";

/**
 * 列表项行尾那排**图标按钮**用的图标名。
 *
 * 只认这一组名字（宿主自己映射到图标组件）：插件给的是**数据**，不能往界面塞组件 /
 * 类名 / 图标源码 —— 与「图标只收 data URI」是同一条规矩。要新图标就往这里加一个名字。
 */
export type PluginItemIcon =
  | "pencil"
  | "trash"
  | "copy"
  | "play"
  | "pause"
  | "plug"
  | "unplug"
  | "refresh"
  | "external"
  | "info"
  | "terminal"
  | "star"
  | "plus";

/** 列表项行尾的一个图标按钮（平时藏起来，鼠标移到这一行才浮现，与会话行同款） */
export interface PluginItemAction {
  actionId: string;
  icon: PluginItemIcon;
  /** 悬浮提示（同时是无障碍名 —— 图标按钮没有文字） */
  label: string;
  args?: Record<string, string | number | boolean>;
  /** 危险的（如删除）染成红色 */
  danger?: boolean;
}

export interface PluginListItem {
  id: string;
  label: string;
  detail?: string;
  badge?: string;
  tone?: PluginBlockTone;
  /** 点了这一项要触发的动作 */
  actionId?: string;
  /** 随动作一起带回去的参数（如「点了哪个 key」）—— 只有 actionId 没法区分点了哪一条 */
  args?: Record<string, string | number | boolean>;
  /** 行尾的图标按钮（编辑 / 删除这类小操作，与会话行同款交互） */
  actions?: PluginItemAction[];
}
export interface PluginButtonItem {
  actionId: string;
  label: string;
  args?: Record<string, string | number | boolean>;
}
/** 表单里的一个字段 */
export interface PluginFormField {
  /** 参数名（提交时值以 `args[<id>]` 带回去） */
  id: string;
  label?: string;
  placeholder?: string;
  value?: string;
  /** 口令型：界面上遮住（只影响显示，值照旧回传） */
  secret?: boolean;
  /** 多行：渲染成 textarea（编辑一整段文本 / JSON 时用） */
  multiline?: boolean;
}

export type PluginBlock =
  | { kind: "text"; text: string; tone?: PluginBlockTone; mono?: boolean }
  | {
      kind: "kv";
      label?: string;
      rows: { label: string; value: string; tone?: PluginBlockTone }[];
    }
  | { kind: "list"; label?: string; items: PluginListItem[] }
  | { kind: "buttons"; items: PluginButtonItem[] }
  | { kind: "note"; text: string; tone?: PluginBlockTone }
  | {
      kind: "input";
      id: string;
      label?: string;
      placeholder?: string;
      value?: string;
      actionId: string;
      submitLabel?: string;
    }
  /** 多字段表单 + 一个提交按钮：一次提交把所有字段的值一起给 `onAction` */
  | {
      kind: "form";
      label?: string;
      fields: PluginFormField[];
      actionId: string;
      submitLabel?: string;
    }
  /**
   * 一个输入框 + 提交按钮：提交时把值作为 `args[<id>]` 传给 `onAction`。
   *
   * 没有它，插件就只能「看」不能「筛 / 改」—— 浏览上千个 key 却没有过滤框、
   * 想改个值却只能删了重建，界面就废了一半。
   */
  | {
      kind: "input";
      /** 参数名（同时也是这一行的标识） */
      id: string;
      label?: string;
      placeholder?: string;
      /** 输入框初值 */
      value?: string;
      actionId: string;
      /** 提交按钮的文字；缺省「提交」 */
      submitLabel?: string;
    };

/** 插件注册的三个面之一（浏览器侧的形态） */
export interface PluginSurfaceView {
  /** 全局唯一的 key：`插件id:面id`。插件 id 是绝对路径，所以跨目录也不会撞 */
  key: string;
  /** 哪个插件（= 入口文件绝对路径） */
  pluginId: string;
  /** 插件显示名（标签页 / 侧栏里标一下归属） */
  pluginName: string;
  kind: "activityBar" | "sider" | "view";
  /** 面 id（插件内部唯一） */
  id: string;
  title: string;
  /** 这个**面**的图标：`data:image/*` 的 data URI（服务端只放行这个形状） */
  icon?: string;
  /**
   * **插件**的图标（`ctx.ui.icon(...)` 或清单 `icon`）—— 「插件」侧栏的列表行用它。
   *
   * 与 `icon` 分开：一个插件可能有多个面，面图标是给面用的（早先的图标栏那颗），
   * 列表行要的是「这个插件长什么样」。两个字段都由服务端算好带下来，前端不必再猜。
   */
  pluginIcon?: string;
  /**
   * **插件**的说明（清单 `description`）—— 「插件」侧栏的列表行用它。
   *
   * 与面自己的 `title` 不是一回事：`title` 是「这一面叫什么」，说明是「这个插件干什么」。
   * 清单里没写就是 undefined（不编默认文案，界面自己决定要不要留空）。
   */
  pluginDescription?: string;
  /** **插件**的版本（清单 `version` 原文，semver）—— 列表行标一下，便于排查「装的是哪版」 */
  pluginVersion?: string;
  /** 排序（小在前） */
  order: number;
  /**
   * 老插件的图标栏项点开谁（`sider:<id>` / `view:<id>`）。
   *
   * 图标栏里已经没有插件项了，前端只在「插件」列表里挑**默认面**时会参考它；
   * 新插件（清单里的 `client.surfaces`）不再有这个概念，默认面 = `order` 最小的那个。
   */
  opens?: string;
  /** 这个面有没有动作（按钮 / 列表项点了有反应才算） */
  hasAction: boolean;
  /**
   * 侧栏顶栏右侧那排图标按钮（刷新 / 新增…）。
   *
   * 顶栏是**常驻 chrome**，不随内容滚 —— 所以它由面声明（`UiSurfaceSpec.headerActions`）
   * 而不是写成一个块；宿主用 `SidebarTopBar` 的 `extra` 槽位渲染。
   */
  headerActions?: PluginItemAction[];
  /**
   * 谁来渲染这个面：
   * - `"server"`（缺省）：服务端 `render()` 产出 blocks，宿主按块画（老路，插件不碰前端代码）；
   * - `"client"`：插件自带前端 bundle，宿主加载它并在浏览器里直接渲染 React 组件。
   *
   * 缺省当 `"server"` 处理 —— 老插件与老前端都不必改。
   */
  renderMode?: "server" | "client";
  /**
   * 前端 bundle 的源码指纹（只有 `renderMode === "client"` 才有）。
   *
   * 用来失效缓存：插件改过 `client.js` 之后指纹变，前端据此重新拉取并执行。
   * 不带它的话用户必须重启应用才能看到插件的前端改动 —— 服务端半是热重载的，
   * 前端半不热重载会非常割裂。
   */
  clientRev?: string;
}

/** GET /api/plugins/surfaces 的响应 */
export interface PluginSurfacesResult {
  surfaces: PluginSurfaceView[];
}

/**
 * POST /api/plugins/rpc：调用插件注册的一个方法（`ctx.rpc.handle` 的另一头）。
 *
 * 为什么要有这条通道：插件的前端半拿不到任何后端能力（也不能自己开 HTTP 路由，
 * desktop 走 IPC 桥、根本没有端口）。RPC 是它取数据的唯一入口，三端同一条。
 */
export interface PluginRpcRequest {
  /** 插件 id（= 入口文件绝对路径） */
  pluginId: string;
  /** 方法名（插件里 `ctx.rpc.handle(name, fn)` 注册过） */
  method: string;
  /** 原样传给处理器的 JSON（体积上限由服务端限） */
  payload?: unknown;
  /** 当前项目根目录（项目级插件按它分流；全局调用时缺省） */
  workspacePath?: string;
}

/** POST /api/plugins/rpc 的响应 */
export interface PluginRpcResponse {
  ok: boolean;
  /** 处理器的返回值（必须可 JSON 序列化） */
  data?: unknown;
  /** 失败原因的人话（处理器抛错时是它抛的原话） */
  error?: string;
}

/** GET /api/plugins/surfaces?pluginId=&surfaceId= 的响应（渲染一面的结果） */
export interface PluginSurfaceContent {
  /** 面的 key（回显，前端缓存对得上号） */
  key: string;
  blocks: PluginBlock[];
  /** 渲染失败时给一句人话（界面上显示成一条提示，不是白屏） */
  error?: string;
  /** 这次渲染的时刻（ms） */
  renderedAt: number;
  /** 插件在 render 里 `toast(...)` 出来的提示（宿主用 sonner 弹） */
  toasts?: PluginToast[];
}

/** 面的参数（如「哪个连接」）：同一个面可以用不同参数开出**多个标签页** */
export type PluginSurfaceParams = Record<string, string | number | boolean>;

/** 插件要弹的一条提示（宿主用 sonner 弹） */
export interface PluginToast {
  message: string;
  /** 缺省 success */
  kind?: "success" | "error" | "info" | "warning";
}

/** 插件要弹的一条提示（宿主用 sonner 弹） */
export interface PluginToast {
  message: string;
  /** 缺省 success */
  kind?: "success" | "error" | "info" | "warning";
}

/** 服务端给前端的块（就是契约里的 `PluginBlock`，这里转出一份别名方便就近引用） */

/** POST /api/plugins/surfaces/action 的响应 */
export interface PluginSurfaceActionResult {
  /** 给了就**整面替换**成它；没给 = 前端自己重新拉一遍 */
  blocks?: PluginBlock[];
  /** 动作想说的一句话（如「已清空」） */
  message?: string;
  error?: string;
  /**
   * **请求宿主打开一个标签页**（例：侧栏列表里点「打开这个连接」）。
   *
   * 块里没有「按钮 = 开标签页」这种东西 —— 打开标签是**宿主的能力**，插件只能请求。
   * 所以做成动作结果里的一个字段：插件说「请打开某面的这个参数」，宿主照办。
   */
  openView?: {
    /** 要打开哪个面（插件内部 id） */
    surfaceId: string;
    params?: PluginSurfaceParams;
    /** 标签上的短名字 */
    label?: string;
    /** 标签的悬浮标题 */
    title?: string;
  };
  /**
   * **请求宿主弹一个对话框**（shadcn Dialog）。
   *
   * 「新增 / 编辑一条配置」这种事要做成弹窗，而块里没有「弹窗」这种语义 —— 和
   * `openView` 同理，插件只能**请求**，由宿主渲染。字段沿用 `form` 那一份
   * （`PluginFormField`），提交时把值作为 `args` 交给同一个 `onAction`。
   */
  openDialog?: {
    title: string;
    /** 标题下那句说明（可省） */
    description?: string;
    /**
     * 表单字段。**可以为空** —— 空 = 纯确认框（只有标题 + 说明 + 确认/取消），
     * 「删除这条连接」这类就是它。
     */
    fields?: PluginFormField[];
    actionId: string;
    submitLabel?: string;
    cancelLabel?: string;
  };
  /**
   * 插件在处理动作时 `toast(...)` 出来的提示（宿主用 sonner 弹）。
   *
   * `message` 是它的糖（= 一条 success）；要 error / info / warning 就用这个。
   */
  toasts?: PluginToast[];
}

/**
 * 单次上传到工作区的文件大小上限：20MB（base64 解码后按字节判）。
 *
 * 比对话附件的 10MB 宽：这里的用途是「把本机的文件搬进工作区」（截图 / 素材 / 压缩包），
 * 不是喂给模型。base64 会让请求体大 1/3，20MB → ~27MB JSON 体，一次性传输。
 */
export const FS_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 单次分片请求携带的字节数（上传一片、下载一段都是它）。
 *
 * ⚠️ 它是**分片粒度**，不是大小上限 —— 文件多大都能传。旧有的 `SFTP_UPLOAD_MAX_BYTES`
 * （100MB）已经删除：那条线是被「一条请求传整份 + JSON + base64」逼出来的，
 * 分片之后它就没有存在理由了。
 *
 * 4MB 的取法：base64 后约 5.3MB 的请求体，两端峰值内存各只多这一片的量级；
 * 再大则单请求的编解码停顿开始能被看见，再小则往返次数白涨。
 *
 * 服务端只按它校验**单片**上限（挡畸形请求），不限制总量。
 */
export const SFTP_CHUNK_BYTES = 4 * 1024 * 1024;

/** `POST /api/sftp/realpath` 的请求体：把远端路径解析成绝对路径 */
export interface SftpRealpathInput {
  /** 服务端存的一台 SSH 主机（凭据由服务端解密后建连，明文不下发渲染端） */
  hostId: string;
  /** 待解析的路径；缺省或 `.` = 远端默认工作目录（通常是家目录） */
  path?: string;
}

export interface SftpRealpathResult {
  /** 解析后的绝对路径 */
  path: string;
}

/** `POST /api/sftp/upload/chunk` 的请求体：写一个分片到远端目录 */
export interface SftpUploadChunkInput {
  hostId: string;
  /** 目标目录（绝对路径）；`index === 0` 时服务端逐层创建 */
  dir: string;
  /** 文件名（不含路径分隔符） */
  name: string;
  /**
   * 分片序号，从 0 起、连续递增。
   *
   * `0` = 以 `'w'` 打开（截断创建），其余 = 以 `'a'` 追加。
   * **「同名文件直接覆盖」这条语义就落在 `index === 0` 的 `'w'` 上** ——
   * 若所有分片都用 `'a'`，覆盖会退化成「新内容接在旧尾巴上」。
   *
   * ⚠️ 同一文件的分片请求**必须串行**（见 `API_ROUTES.sftpUploadChunk` 的说明）。
   */
  index: number;
  /**
   * 本片的字节 base64。
   *
   * `index > 0` 时不得为空；零字节文件靠 `index === 0` 的那一片空片把远端文件建出来。
   */
  dataBase64: string;
  /**
   * 本次传输的标识，供 `POST /api/sftp/abort` 取消。
   *
   * 由渲染端生成并随每片一起送，**不能靠「HTTP 请求断了」来推断取消** ——
   * desktop 那条 IPC 桥断开时不一定有信号传回来，而且一次拖入的多个文件要能各自取消。
   */
  transferId?: string;
}

/**
 * `POST /api/sftp/abort` 的请求体：取消一笔进行中的上传。
 *
 * 除 `transferId`（定位在途写流）外还要 `hostId` / `dir` / `name` —— 服务端据此
 * **删掉已写入的半份文件**。分片之后，传了一半的文件是真实存在且内容完整的，
 * 只停流会留下一个「看起来成功」的坏文件。
 */
export interface SftpAbortInput {
  hostId: string;
  dir: string;
  name: string;
  transferId: string;
}

/**
 * `POST /api/sftp/upload/chunk` 的应答。
 *
 * 成功与「被取消」都是 **200**，靠 `ok` / `canceled` 区分 —— 取消不是错误，
 * 用 4xx / 5xx 表达会让客户端得从状态码里反推语义（而且取消常常是客户端先 abort，
 * 服务端的应答它压根读不到，见 `SftpUploadChunkInput.transferId` 的说明）。
 */
export interface SftpUploadChunkResult {
  ok: boolean;
  canceled?: boolean;
}

/**
 * SFTP 文件管理（右击主机 →「SFTP 文件管理」）里的一条远端目录项。
 *
 * 与 dogi 的 `SftpEntry` 同名字段，直接从主进程那份移植过来 —— 渲染端的文件列表
 * 只认这几个字段，换一层运送方式（IPC → HTTP）不必改形状。
 */
export interface SftpEntry {
  /** 文件名（不含上级目录） */
  name: string;
  /** 远端绝对路径（父目录已归一化，可直接喂回 list / remove / rename） */
  path: string;
  isDir: boolean;
  /** 目录恒为 0；文件取 lstat 的字节数 */
  size: number;
  /** 最后修改时间（毫秒时间戳；取不到时为 0） */
  mtime: number;
}

/**
 * `POST /api/sftp/list` 的请求体：列一个远端目录。
 *
 * ⚠️ 与上传那条路（`SftpUploadChunkInput`）不同，这里**不带 transferId** ——
 * 列目录 / 建目录 / 重命名 / 删除都是「一问一答」的短操作，没有可取消的传输过程。
 * 复制 / 移动会传字节，但它们**不接取消**：这是刻意的收敛，
 * 见 `SftpCopyInput` 的说明。
 */
export interface SftpListInput {
  hostId: string;
  /** 目录绝对路径；服务端会归一化（`//data`、`/data/` 都认） */
  path: string;
}

export interface SftpListResult {
  /** 归一化后的目录路径（渲染端拿它回填路径栏） */
  path: string;
  /** 目录项：目录在前、各自按名排序（排序在服务端做，两端一致） */
  entries: SftpEntry[];
}

/** `POST /api/sftp/mkdir` 的请求体：新建一个目录（**不**递归建中间层） */
export interface SftpMkdirInput {
  hostId: string;
  /** 待创建的目录绝对路径 */
  path: string;
}

/**
 * `POST /api/sftp/rename` 的请求体：重命名 / 移动（同一操作，`to` 带目录就是移动）。
 *
 * `from` / `to` 都是远端绝对路径，服务端归一化后直通 SFTP 的 rename。
 * 跨文件系统的移动由**渲染端**决定先试 rename、失败再走「复制 + 删除」，
 * 不走这里 —— 服务端保持「rename 就是 rename」这一条纯粹的语义。
 */
export interface SftpRenameInput {
  hostId: string;
  from: string;
  to: string;
}

/** `POST /api/sftp/remove` 的请求体：删除文件或目录（目录递归，等价 `rm -rf`） */
export interface SftpRemoveInput {
  hostId: string;
  path: string;
}

/**
 * `POST /api/sftp/copy` 的请求体：远端复制（目录递归；ssh2 原生无 copy，服务端自读自写）。
 */
export interface SftpCopyInput {
  hostId: string;
  from: string;
  to: string;
}

/**
 * `POST /api/sftp/move` 的请求体：远端移动。
 *
 * 服务端优先用 SFTP 原生 rename（同一文件系统内瞬时完成），失败（跨文件系统）时
 * 回退为「复制 + 删除源」。移动**不支持中途取消**：它要么是一次瞬时的 rename，
 * 要么是一段没有用户可感知进度的复制 —— 为它再搭一套 transferId / abort 通道，
 * 复杂度远大于收益（上传那条路带取消，是因为大文件真的会卡在那里传很久）。
 */
export interface SftpMoveInput {
  hostId: string;
  from: string;
  to: string;
}

/** 上述四个「改远端」操作的统一应答：成功即 `{ ok: true }`，失败走 HTTP 错误体 */
export interface SftpMutationResult {
  ok: boolean;
}

/**
 * `POST /api/sftp/download/chunk` 的请求体：读一个远端文件的一段。
 *
 * 返回的是 **base64 字节**（`SftpDownloadChunkResult.dataBase64`），不是流 ——
 * 与上传同一条协议（JSON + base64），渲染端两端同一套代码。
 *
 * **不带 `transferId`、也不需要 abort**：下载是「客户端拉」，不拉了就是取消，
 * 服务端这边没有在途状态要收拾。这是无状态白拿的一处简化。
 *
 * ⚠️ 这里**没有**「下载到某个本地路径」的概念：服务端很可能跟浏览器不在同一台机器上
 * （web 部署形态），它看不见用户的本地磁盘。字节回到渲染端后由渲染端落盘
 * （见 `shared/lib/file-transfer/sink.ts`）。
 */
export interface SftpDownloadChunkInput {
  hostId: string;
  /** 远端文件绝对路径 */
  path: string;
  /** 起始偏移（从 0 起） */
  offset: number;
  /** 要读的字节数（正整数，不超过 `SFTP_CHUNK_BYTES`） */
  length: number;
}

export interface SftpDownloadChunkResult {
  /** 这一段的字节 base64 */
  dataBase64: string;
  /**
   * 是否已到文件末尾：**读到的字节数少于请求的 `length`**。
   *
   * 调用方据此决定还拉不拉下一段。⚠️ 别改成「`dataBase64` 为空」——
   * `offset` 恰好落在文件末尾时会读到 0 字节，那也是 eof；而「0 字节且非 eof」
   * 是异常（正常不会发生），调用方要按失败收场，否则会死循环。
   */
  eof: boolean;
}

/**
 * POST /api/workspaces/:id/files/upload 的请求体。
 *
 * 与写文件（`{ path, content }`）分开是必须的：content 是字符串、服务端按 utf8 落盘，
 * 二进制会坏掉；这里按 base64 收字节。协议与 `/api/uploads` 一致（JSON + base64，
 * 不用 multipart），前端两端同一套代码。
 */
/**
 * `POST /api/workspaces/:id/scaffold` 的请求体：**按 kind 造一份模板文件**。
 *
 * 与写文件的区别（都是刻意的，不是重复）：
 * - 写文件是「给已知路径写已知内容」，本接口是「按类型生成骨架」—— 内容由服务端出，
 *   前端不传正文（传了也会被忽略，避免两种真相）；
 * - 本接口会 `mkdir` 中间目录，且**已存在一律 409、绝不覆盖**（覆盖是破坏性的，
 *   那种操作应该由用户在编辑器里明确做，而不是敲个斜线命令就没了）。
 */
export interface FsScaffoldInput {
  kind: "skill" | "agents";
  /**
   * 技能名（`kind: 'skill'` 必填）：小写字母 / 数字 / `-` / `_`，同时是**目录名**。
   *
   * 校验在服务端（`skillDirName`）：目录名非法会让技能**扫不出来**（扫描按目录名推导
   * 名称），所以宁可在这里拒掉，也不要生成一个静默失效的技能。
   */
  name?: string;
  /** 一句话说明（`kind: 'skill'`）：写进 SKILL.md 的 `description`，模型据此决定要不要用它 */
  description?: string;
}

/** `POST /api/workspaces/:id/scaffold` 的应答 */
export interface FsScaffoldResult {
  /** 相对工作区根的落点（`.fizz/skills/x/SKILL.md` / `AGENTS.md`） */
  path: string;
  /** 绝对路径（提示语里要给用户看绝对路径，他要在文件系统里找） */
  abs: string;
  /** 人话提示：落成之后该知道什么（如「下一轮对话生效」） */
  note: string;
}

export interface FsUploadInput {
  /** 目标路径（相对工作区根，**含文件名**）：`docs/a.png`、`a.png` */
  path: string;
  /** 文件字节的 base64 */
  dataBase64: string;
  /**
   * 目标已存在时是否覆盖。缺省 false —— 服务端回 **409**，把「要不要覆盖」交给用户
   * 拍板（面板据此弹确认框），绝不静默盖掉同名文件。
   */
  overwrite?: boolean;
}

/**
 * 用户消息的 parts 拼装：**file parts 在前、text part 在后**（附件展示在文本上方，
 * 与 ainav 交互一致；模型 content 顺序同理）。客户端乐观消息与服务端落盘共用这一份，
 * `text` 为空串也照放 text part —— 落盘形状稳定（file-only 轮次不会凭空少一个 part）。
 */
export function buildUserParts(
  text: string,
  files?: UploadFileRef[],
): AgentMessagePart[] {
  return [
    // `provider` 一并落盘（缺省不写这个键，老数据的形状不变）——历史回显时能看出这条
    // 附件是内置存储还是某个插件上传源传的
    ...(files ?? []).map((f) => ({
      type: "file" as const,
      url: f.url,
      mediaType: f.mediaType,
      name: f.name,
      ...(f.provider ? { provider: f.provider } : {}),
    })),
    { type: "text" as const, text },
  ];
}

// ---------------------------------------------------------------------------
// 文件管理器（全盘浏览 / 管理）
// ---------------------------------------------------------------------------
//
// 与「工作区文件」（`AgentFsEntry`，相对路径、被局限在工作区里）是**两套东西**：
// 这里是「服务端那台机器的文件管理器」，路径一律**绝对路径**，能翻到主目录以外的任何
// 位置（用户明确要求照搬 linux_web 的整盘文件管理器）。所以：
// - 路径**不走** `resolveInside`（那是工作区语义），改由 `file-manager/paths.ts` 只做
//   归一化与「回收站自身不可删」这类底线校验；
// - 一次操作**一个路径**（复制 / 移动 / 删除 / 还原都是），批量是客户端循环发 ——
//   这样进度条能按「第几项 / 共几项」显示，也不用把一小时的批量拷贝挂在一个 HTTP 请求上。

/** 文件管理器的 HTTP 入口（路径常量集中在这里，避免前后端各拼一份） */
export const FILES_API = {
  /** GET `?path=<abs>` → `FmListResult`（`path` 缺省 = 主目录） */
  list: '/api/files/list',
  /** GET → `FmRootsResult`（主目录 / 盘符 / 常用位置） */
  roots: '/api/files/roots',
  /** GET `?path=` → `FmEntry`（单条属性，属性弹窗用） */
  stat: '/api/files/stat',
  /** GET `?path=` → `FmReadResult`（文本按 utf8，二进制给 base64） */
  read: '/api/files/read',
  /** GET `?path=` → 原始字节（图片 / 视频 / PDF 预览，支持 Range） */
  content: '/api/files/content',
  /** GET `?path=` → 附件下载（文件原样吐，目录现场打 zip） */
  download: '/api/files/download',
  /** POST `FmOpInput` → `FmOpResult`（所有**改动**动作的总线） */
  op: '/api/files/op',
  /** POST `FmUploadInput` → `FmOpResult`（**JSON + base64**，禁止 multipart，见 AGENTS.md） */
  upload: '/api/files/upload',
  /** GET → `FmTrashResult`（回收站清单） */
  trash: '/api/files/trash',
  /** GET `?path=` → `FmArchiveResult`（压缩包内的条目清单） */
  archive: '/api/files/archive',
} as const

/** 文件管理器里的一条目录项（**绝对路径**） */
export interface FmEntry {
  /** 文件名（不含上级目录） */
  name: string;
  /** 绝对路径（已归一化，可直接喂回 list / stat / op） */
  path: string;
  isDir: boolean;
  /** 符号链接 / Windows 目录联接（界面上加一个小箭头标记） */
  isLink: boolean;
  /** 目录恒为 0；文件取 lstat 的字节数 */
  size: number;
  /** 最后修改时间（毫秒时间戳；取不到时为 0） */
  mtime: number;
  /** 以 `.` 开头 —— 界面上「显示隐藏文件」关着时藏掉 */
  hidden: boolean;
}

/** `GET /api/files/list` 的应答 */
export interface FmListResult {
  /** 实际列出的目录（`~` 之类的输入已在服务端展开） */
  path: string;
  /** 上级目录；null = 已经在根（`/` 或 `C:/`） */
  parent: string | null;
  entries: FmEntry[];
  /**
   * 条目过多被截断（上限 5000 条）。
   *
   * 静默少列等于「文件不见了」，所以一定带上这个标记，界面要明说。
   */
  truncated?: boolean;
}

/** 一个可跳转的位置（盘符 / 常用目录） */
export interface FmPlace {
  /** 稳定 id（`home` / `drive:C` / `desktop` …），只用于 React key */
  id: string;
  /** 展示名（`本地磁盘 (C:)` / `下载` …） */
  label: string;
  /** 绝对路径 */
  path: string;
}

/** `GET /api/files/roots` 的应答 */
export interface FmRootsResult {
  /** 服务端用户的 home 目录（打开文件管理器时的默认位置） */
  home: string;
  /** `process.platform`：界面据此决定要不要显示「盘符」这一组 */
  platform: string;
  /** 根：Windows 是各盘符，POSIX 只有 `/` */
  drives: FmPlace[];
  /** 常用位置：桌面 / 文档 / 下载 / 图片 / 音乐 / 视频（不存在的不返回） */
  places: FmPlace[];
  /** 回收站根目录（只用于提示，界面上按「回收站」模式浏览，不直接列它） */
  trash: string;
}

/** `GET /api/files/read` 的应答 */
export interface FmReadResult {
  path: string;
  /** 文本内容；`encoding === 'base64'` 时是原始字节的 base64 */
  content: string;
  encoding: 'utf8' | 'base64';
  /** 字节数 */
  size: number;
  /** 超过读取上限被截断（只可能是 utf8 文本） */
  truncated: boolean;
}

/**
 * 改动动作的总线（`POST /api/files/op`）。
 *
 * 为什么合成一条而不是十几个路由：这些都是「改一下磁盘」的同族动作，错误语义、返回值
 * 形状（`FmOpResult`）完全一致；拆开只会让前端多十几个薄封装。**读**动作才单独开路由
 * （它们各有各的应答类型与 Range / 流式需求）。
 */
export type FmOpInput =
  /** 新建文件夹（`name` 单层，父目录必须存在） */
  | { op: 'mkdir'; parent: string; name: string }
  /** 新建空文件（已存在则报错，不静默覆盖） */
  | { op: 'create'; parent: string; name: string }
  /** 重命名（同目录内改名，`name` 单层） */
  | { op: 'rename'; path: string; name: string }
  /** 批量重命名：`base (1).ext`、`base (2).ext`…（保留各自的扩展名） */
  | { op: 'batchRename'; paths: string[]; base: string }
  /** 复制到目录 `to`（重名报错；跨盘走同一套递归实现） */
  | { op: 'copy'; path: string; to: string }
  /** 移动到目录 `to`（同盘 rename，跨盘回退成复制 + 删除） */
  | { op: 'move'; path: string; to: string }
  /** 移到回收站（可还原） */
  | { op: 'trash'; path: string }
  /** 彻底删除（不进回收站，弹窗里要二次确认） */
  | { op: 'delete'; path: string }
  /** 从回收站还原（`id` 是 `FmTrashItem.id`） */
  | { op: 'restore'; id: string }
  /** 把回收站里的**某一项**彻底删掉（回收站模式下删的就是它，与 `delete` 分开：那条的
   *  `path` 是用户文件路径，不允许指进回收站内部） */
  | { op: 'deleteTrash'; id: string }
  /** 清空回收站（彻底删掉里面所有东西） */
  | { op: 'emptyTrash' }
  /** 覆盖写一个文本文件（预览里就地编辑） */
  | { op: 'write'; path: string; content: string }
  /** 把选中的若干项打成一个 zip（`to` 是**目标压缩包的绝对路径**） */
  | { op: 'compress'; paths: string[]; to: string }
  /** 解压到目录 `to`（zip / tar / tar.gz / tgz / gz） */
  | { op: 'extract'; path: string; to: string };

/** 所有改动动作的应答 */
export interface FmOpResult {
  /** 受影响的绝对路径（新建出来的 / 改名后的 / 解压出来的目录），界面据此刷新并选中 */
  paths?: string[];
  /** 因过大 / 数量超限被跳过的条目数（压缩时会有） */
  skipped?: number;
  /** 人话补充（如「跨盘移动较慢」），没有就不带 */
  message?: string;
}

/** `POST /api/files/upload` 的请求体：一个文件一次（客户端按文件循环，进度才有意义） */
export interface FmUploadInput {
  /** 目标**目录**绝对路径 */
  dir: string;
  /** 文件名（单层；上传文件夹时由客户端先建好目录再逐个传） */
  name: string;
  /** 文件字节的 base64 */
  dataBase64: string;
  /**
   * 目标已存在时是否覆盖。缺省 false —— 服务端回 **409**，把「要不要覆盖」交给用户，
   * 绝不静默盖掉同名文件（与工作区上传同一条口径）。
   */
  overwrite?: boolean;
}

/** 回收站里的一项 */
export interface FmTrashItem {
  /** 回收站内的条目 id（还原 / 彻底删除都用它） */
  id: string;
  /** 原始文件名 */
  name: string;
  /** 删之前它在哪（还原回原位；同名的已存在时服务端会加后缀） */
  originalPath: string;
  /** 删除时间（毫秒时间戳） */
  deletedAt: number;
  isDir: boolean;
  /** 文件字节数；目录为 0 */
  size: number;
}

/** `GET /api/files/trash` 的应答 */
export interface FmTrashResult {
  items: FmTrashItem[];
}

/** 压缩包里的一个条目 */
export interface FmArchiveEntry {
  /** 归档内的相对路径（`a/b.txt`，目录以 `/` 结尾） */
  name: string;
  /** 解压后字节数（目录为 0） */
  size: number;
  isDir: boolean;
}

/** `GET /api/files/archive` 的应答 */
export interface FmArchiveResult {
  path: string;
  /** `zip` / `tar` / `tar.gz` / `gz` */
  format: string;
  entries: FmArchiveEntry[];
  /** 条目过多只列了前 N 条 */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// 系统监控 + 任务管理器（进程清单 / 结束进程）
// ---------------------------------------------------------------------------
//
// 与上面那套 `SystemSnapshot` **刻意分成两组类型**，理由和「本机 vs SSH 主机」那组一样：
// - 采集通路不同：`SystemSnapshot` 来自常驻采样器（`node:os`，零子进程，每 2s 一帧，
//   服务状态栏那颗徽标）；这里来自**按需**的进程表读取（POSIX 走一次 `ps`，Windows 走
//   一次 PowerShell + CIM 查询），只在任务管理器标签打开时才有请求；
// - 字段不同：进程表要 pid / ppid / 命令行 / 累计 CPU 时间这些「采样器不采也采不到」的
//   东西；而采样器那份的每核占用、磁盘、fizz 自身进程这里也不必再重复一份（面板自己去读
//   `/api/system`）。
// 硬凑成一套的话，两边都会拖着一堆恒为 null 的字段，读的人分不清「没采到」和「这个概念
// 在对面不存在」。

/**
 * 进程状态的**归一档**。
 *
 * 各平台的原始状态码完全不可移植（Linux `Ssl` / `R` / `D` / `Z`，Windows 的
 * `Running` / `Not Responding` / `Unknown`），所以服务端先压成这几档，界面只认这几档
 * 上色。原始码另给一份（`rawState`）放悬停提示 —— 想深究的人还能看到。
 */
export type SystemTaskState = 'running' | 'sleeping' | 'stopped' | 'zombie' | 'unknown'

/** 进程表里的一行 */
export interface SystemTaskProcess {
  pid: number;
  /**
   * 父进程 pid。
   *
   * Windows 从 `Win32_Process.ParentProcessId` 取，POSIX 从 `ps` 的 `ppid` 列取 —— 两边
   * 都是实的。唯一的例外是 Windows 的**降级模式**（PowerShell 起不来，退到 `tasklist`），
   * 那时恒为 0。
   */
  ppid: number;
  /** 进程名（POSIX 取命令行首段的 basename；Windows 是 `Win32_Process.Name`，带 `.exe`） */
  name: string;
  /** 完整命令行（Windows 走 CIM 时也有；降级模式下为空串） */
  cmdline: string;
  /**
   * 运行这个进程的用户名。
   *
   * ⚠️ **Windows 上恒为空串**：`Win32_Process` 没有这个属性，只能逐进程调
   * `GetOwner()`（几百次 WMI 来回，比整个采集慢一个量级），不值当。界面遇到空串显示 `—`。
   */
  user: string;
  /**
   * 瞬时 CPU 占用，**单核 100% 为满**（与 `top` / 任务管理器同口径）。
   *
   * 一个开满 8 线程的进程可以显示 700%+ —— 这是刻意的：归一成 0–100 会让「一个进程吃满
   * 所有核」和「8 个进程各吃满一个核」看起来一样。
   * 首帧没有基准时为 0（此时 `SystemTaskList.windowMs === 0`）。
   */
  cpuPercent: number;
  /** 常驻内存（字节） */
  rss: number;
  /** 占物理内存百分比 0–100 */
  memPercent: number;
  /** 累计 CPU 时间（秒，进程整个生命周期的和） */
  cpuSeconds: number;
  state: SystemTaskState;
  /** 平台原始状态码（悬停提示用） */
  rawState: string;
  /**
   * 是不是**承载界面的 fizz 自己这个进程**。
   *
   * 界面要标记它，并且**不允许**从这里结束它 —— 那等于把用户脚下的地板锯掉：界面立刻
   * 失联，得回命令行手动重启。服务端也会再挡一次。
   */
  self: boolean;
}

/** 网卡合计速率（只有 Linux 读得到，见 `SystemTaskList.net`） */
export interface SystemTaskNet {
  /** 下行字节/秒（自上次采样以来） */
  rxPerSec: number;
  /** 上行字节/秒 */
  txPerSec: number;
  /** 累计收到字节 */
  rxTotal: number;
  /** 累计发出字节 */
  txTotal: number;
}

/** `GET /api/system/tasks` 的应答 */
export interface SystemTaskList {
  /** 采样时间（Date.now()） */
  at: number;
  /**
   * 采集后端（诊断用）：`ps`（Linux / macOS）、`cim`（Windows，PowerShell + WMI）、
   * `tasklist`（Windows 降级：PowerShell 不可用时）。
   *
   * 放进应答而不是只写日志：不同后端能给的字段不一样（见各字段的 ⚠️），出了问题第一句话
   * 就是「你这台机器走的是哪条路」。
   */
  source: string;
  /**
   * 这次 `cpuPercent` 的统计窗口（毫秒）。**0 = 没有基准**（首次采样还没有第二帧），
   * 此时所有 `cpuPercent` 都是 0，界面该显示「—」而不是一片 0.0% 冒充真值。
   */
  windowMs: number;
  /** 物理内存总量（字节）——`memPercent` 的分母，界面也要显示 */
  memTotal: number;
  /** 逻辑核心数（`cpuPercent` 的上限 = `cores × 100`） */
  cores: number;
  /** 进程总数（可能大于 `processes.length`，见 `truncated`） */
  total: number;
  /** 条目太多只回了前 N 条（上限见服务端 `MAX_PROCESSES`） */
  truncated: boolean;
  /**
   * 进程清单，**已按 CPU 降序**（服务端排的）。
   *
   * 服务端排序是为了「就算前端只是原样渲染，最该看的也在最上面」；界面换排序方式
   * （内存 / pid / 名称）是在这上面**再排一次**，不回头问服务端 —— 一次几百条，重排是
   * 内存操作，没必要多一个请求。
   */
  processes: SystemTaskProcess[];
  /** 网卡合计速率；当前平台读不到为 null（非 Linux 一律 null，见服务端说明） */
  net: SystemTaskNet | null;
  /** 降级 / 平台限制说明（一句话，界面在工具栏旁灰字显示），无则省略 */
  note?: string;
}

/** `POST /api/system/tasks/kill` 的请求体 */
export interface SystemTaskKillInput {
  pid: number;
  /**
   * `term`（缺省）= 请它自己退（POSIX `SIGTERM`，Windows `taskkill` 不加 `/F`）；
   * `kill` = 强杀（`SIGKILL` / `taskkill /F`）。
   *
   * 默认走 `term`：给进程一个收尾（落盘、关连接）的机会。Windows 上的控制台程序往往
   * 不理 `taskkill` 的软请求，那时界面会提示「改成强制结束」。
   */
  mode?: 'term' | 'kill';
  /** 连子进程一起（POSIX 按 ppid 递归、由深到浅；Windows 交给 `taskkill /T`） */
  tree?: boolean;
}

/** `POST /api/system/tasks/kill` 的应答（**业务失败也是 200**，原因见 `error`） */
export interface SystemTaskKillResult {
  pid: number;
  /** 信号是否真的下出去了（进程已退出 / 没权限 / 被保护 = false） */
  ok: boolean;
  /** 实际下了信号的 pid 列表（`tree: true` 时是整棵子树，由深到浅） */
  killed: number[];
  /** 失败原因（人能读懂的一句话） */
  error?: string;
}
