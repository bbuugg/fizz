/**
 * Agent 客户端的应用状态与动作 —— 现在是一个**兼容壳**，由一个纯投影函数 + 两个 hook 组成。
 *
 * 真正的状态与逻辑住在 `lib/stores/`（zustand，分片见 agent-store.ts 的注释）。
 *
 * - `agentAppFrom(store, conversationId)`：**纯函数**，把 store 快照投影成 `AgentApp`
 *   （几十个组件在用的那个形状）。指定 `conversationId` 就能拿到「那条会话的现场」。
 * - `useAgentApp()`：绑定活跃会话 + 承担全部全局副作用（WS 订阅 / 对账 / 401 / 断线补接 /
 *   自动恢复会话）。唯一调用方 `use-app-context` 用它，形状与拆分前逐字节一致。
 * - `useAgentAppView(id)`：绑定指定会话，**不挂副作用** —— 主区域每个对话标签一份，
 *   这样多个标签能各自显示自己那条会话的消息与流式状态（见 `agentAppFrom` 的说明）。
 *
 * 订阅方式是**整店订阅**（`useAgentStore()` 无 selector）：hook 本身随任何状态变化重渲，
 * 但 `useAgentApp()` 的返回值在「只有切片变化」时保持旧引用（流式期间不再把整个应用
 * 树按帧拖下水，见它末尾的投影缓存）；`useAgentAppView(id)` 不缓存，始终是最新现场。
 * 只需要其中一两个字段的组件仍可改用 selector（如 `useAgentStore(s => s.activeWorkspaceId)`）。
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { setUnauthorizedHandler } from "@fizz/agent-client/api";
import {
  initConversationActivity,
  useConversationActivity,
} from "@fizz/agent-kit/shared/lib/conversation-activity";
import {
  useAgentStore,
  type AgentStore,
} from "@fizz/agent-kit/shared/lib/stores/agent-store";
import {
  NO_CONFIRMS,
  NO_FOLLOWUPS,
  NO_MESSAGES,
  NO_QUEUE,
  NO_STEERS,
  loadActiveConversationId,
  loadBlankIntent,
} from "@fizz/agent-kit/shared/lib/stores/slices/conversation";
import type {
  QueuedMessage,
  ChatTarget,
} from "@fizz/agent-kit/shared/lib/stores/slices/conversation";
import type {
  AcpPermissionMode,
  AiPermissionMode,
  AiReasoningEffort,
  AskFollowupAnswer,
  BrowserSettings,
  CollabSettings,
  UploadFileRef,
} from "@fizz/contracts";
import { DEFAULT_BROWSER_SETTINGS } from "@fizz/contracts";
export type { QueuedMessage };

/**
 * 把 store 快照投影成界面要的 `AgentApp` 形状 —— **纯函数，零 hook、零副作用**。
 *
 * ## 为什么要能指定 `conversationId`（多标签对话的关键）
 *
 * 数据层是按会话分片的（`slices: Record<conversationId, ConvSlice>`），但这个投影壳
 * 一开始只认**唯一活跃会话**（`s.activeConversationId`）。主区域的标签组要能同时显示
 * 两个对话（并排 / 上下分屏），每个标签就得看到**自己那条会话**的消息、流式状态、
 * 待发队列、审批卡与追问表 —— 否则两个标签会一起显示同一个会话。
 *
 * 所以把投影拆成纯函数，`conversationId` 由调用方给：
 * - `useAgentApp()` 传 `s.activeConversationId`（行为与拆分前逐字节一致）；
 * - `useAgentAppView(id)` 传标签自己那条会话的 id。
 *
 * `ChatPanel` 一个字都不用改：它读的全是 `app.<字段>`，而字段名与语义都没动。
 *
 * ## 传进来的 id 也会成为 `activeConversationId`
 *
 * 视图里的 `activeConversationId` 就是**这个视图所属的会话**。这样 ChatPanel 里那些
 * 「我是不是当前会话」的判断（附件回调的归属校验、编辑重发的归属、待填草稿的键）
 * 在各自的标签里都成立。
 *
 * ## 写库动作也按**视图的**会话走（`scope`）
 *
 * 曾经的理由是「聚焦标签会同步 `openConversation(id)`，所以两者恒等」。分屏把这句推翻
 * 了：两个标签同时可见、都能操作，而 `activeConversationId` 只有一份 —— 在非焦点标签
 * 里发送，消息会插到焦点会话上；读模型 / 思考强度 / MCP / 浏览器偏好也会读到焦点会话
 * 的（用户报的「点一下标签两个 composer 的模型 pill 一起变」）。
 *
 * 所以这里统一把会话 id 作为**作用域**传给写动作与现场字段：
 * - 现场字段走 `scopedSettingsOf(conversationId)`（从会话清单项派生，焦点标签也不例外）；
 * - 写动作（send / steer / stop / 4 个 setter / 审批 / 追问）都把 `conversationId` 传下去。
 *
 * 现在**所有**会话级动作都收 `scope?: string | null`（`undefined` = 活跃会话，`null` =
 * 没有会话，有值 = 那条），这里逐个把 `conversationId` 传下去：`send` / `steer` / `stop` /
 * `stopCommand` / 队列与插话的全部增删改 / 队列泵 `pump` / 消息的删除与编辑重发 /
 * 审批与追问的答复 / 会话分叉 `forkConversation` / 权限档 / 上下文压缩 / 协作配置 /
 * 四个现场 setter。`scripts/check-conversation-scope.mjs` 保证 store 里不再出现
 * 「读焦点当默认目标」的写法（新增动作漏传 scope 会在那里红）。
 *
 * 少数几个本来就收 `id` 参数的（`clearConversation` / `reloadConversation` /
 * `convertAcpConversation` / `deleteConversation`），作用域由调用方传的 id 决定，
 * 这里原样透传 —— 传 `app.activeConversationId` 就是本标签那条。
 */
export function agentAppFrom(s: AgentStore, conversationId: string | null) {
  const api = s.getApi();
  const activeSlice = conversationId ? s.slices[conversationId] : undefined;
  /**
   * 这个视图所属会话的「现场」：模型 / 思考强度 / MCP / 浏览器偏好。
   *
   * 从**会话清单项**派生（`null` = 新对话页读草稿）。store 上没有「当前会话的现场」
   * 那份共享状态可读 —— 有它的时候，分屏两个标签就会互相污染。
   */
  const scoped = s.scopedSettingsOf(conversationId);

  return {
    // 状态
    connection: s.connection,
    connected: !!s.connection && !!s.health,
    /**
     * 底层 API 客户端（已按当前连接与宿主 fetch 组装好）。
     *
     * 暴露它是为了给**定时任务**那套用：定时任务的接口与对话完全独立，没必要把它们的
     * 状态塞进这个 store —— `useTriggers` 拿它自己管一份。
     */
    api,
    health: s.health,
    models: s.models,
    acpAgents: s.acpAgents,
    mcpServers: s.mcpServers,
    /** SSH 主机清单（设置 →「SSH 主机」与命令面板主机入口的数据源） */
    sshHosts: s.sshHosts,
    /**
     * 主机分组：SSH 主机与本机终端**共用**的多级归类树。
     *
     * 侧栏按它渲染分组节点（`features/hosts` 的树），条目靠自己的 `groupId` 指过来。
     */
    hostGroups: s.hostGroups,
    /**
     * 主机清单是否已成功拉过至少一遍（空 ≠ 没加载）。
     *
     * 主机侧栏靠它决定摆骨架还是摆「还没有主机或终端」—— 加载中 `sshHosts` /
     * `hostGroups` 都是空数组，只看长度就是先空态后内容的一次闪屏。
     */
    hostsLoaded: s.hostsLoaded,
    /**
     * SSH 隧道配置（本地转发 -L / 远程转发 -R / SOCKS5 动态代理 -D）。
     *
     * ⚠️ 监听端口绑在**跑 server 的那台机器**上（桌面端 = 你本机，VPS 部署 = VPS 自己），
     * 这是 `ssh -L/-R/-D` 的标准语义。面板文案写「服务端所在机器的端口」。
     */
    sshTunnels: s.sshTunnels,
    /** 隧道运行态（起停 / 连接数 / 错误）；由服务端内存快照推送，不落盘 */
    tunnelRuntimes: s.tunnelRuntimes,
    /** 接口请求清单（HTTP / WS 共用一张表，靠 `protocol` 区分） */
    apiRequests: s.apiRequests,
    /** 接口请求分组树（侧栏归类 + 排序） */
    apiGroups: s.apiGroups,
    /** 接口请求历史（发送后自动记录，最新在前） */
    apiHistory: s.apiHistory,
    /** 主机脚本清单（可在主机上一键执行的命令文本） */
    scripts: s.scripts,
    /** 脚本分组（**单层**；侧栏归类 + 排序） */
    scriptGroups: s.scriptGroups,
    /** 已登记的笔记根目录（侧栏「笔记」功能区的顶层；走快照域推送） */
    notesRoots: s.notesRoots,
    /**
     * 本轮后端（null = 跟随默认）。**这个视图所属会话**的那份 —— 分屏时非焦点标签
     * 读的是它自己会话上的配置（见 `scopedSettingsOf`），不是焦点会话的。
     */
    chatTarget: scoped.chatTarget,
    /** 这个视图的会话的思考强度（内置 Agent；null = 跟随模型默认） */
    reasoningEffort: scoped.reasoningEffort,
    /** 改这个视图的会话的思考强度（新任务页 = 待定选择） */
    setReasoningEffort: (effort: AiReasoningEffort | null) =>
      s.setReasoningEffort(effort, conversationId),
    /**
     * 新任务页选中的 ACP agent 的档位快照（模式 / 思考档）—— 那时还没有会话，
     * 这排 pill 的数据只能来自探测（见 `probeDraftAcp`）。`null` = 没选 ACP。
     */
    draftAcp: s.draftAcp,
    /** 这个视图的会话允许使用的 MCP server id 清单（持久化在会话上；空 = 全不选） */
    mcpServerIds: scoped.mcpServerIds,
    /** 改选这个视图的会话可用的 MCP（全量覆盖） */
    setMcpServerIds: (ids: string[]) =>
      s.setMcpServerIds(ids, conversationId),
    workspaces: s.workspaces,
    conversations: s.conversations,
    /** 会话清单是否已成功拉过至少一遍（空 ≠ 没加载，见字段注释） */
    conversationsLoaded: s.conversationsLoaded,
    skills: s.skills,
    /** 子任务（subagent）偏好：设置页「子任务」开关的状态源 */
    subagentSettings: s.subagentSettings,
    /**
     * 浏览器偏好（总开关）：**这个视图的会话**那一份，未设过时用常量默认（关）。
     * 输入框上方 ComposerToolbar 的状态源（会话级 —— 分屏时两个标签各一份）。
     *
     * 没有「全局默认」那一层了：新建会话 / 新建定时任务要预填的一律是
     * `DEFAULT_BROWSER_SETTINGS`，别拿当前会话这份去预填。
     */
    browserSettings:
      (scoped.browserSettings ?? DEFAULT_BROWSER_SETTINGS),
    /** 内置浏览器装好了没有（没装时工具条不渲染那颗开关） */
    browserInstalled: s.browserInstalled,
    /**
     * 系统监控偏好（总开关）：设置页「系统监控」开关的状态源，也是状态栏是否渲染
     * 监控条的依据（见 `app-shell.tsx`）。`null` = 还没拉过 → 按「开」处理，免得首帧闪。
     */
    systemMonitorSettings: s.systemMonitorSettings,
    /** 界面语言（全局一份；设置页语言切换的当前值） */
    language: s.language,
    /** 保存界面语言（同时切本机 i18n 单例） */
    saveLanguage: s.saveLanguage,
    activeWorkspace:
      s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null,
    activeWorkspaceId: s.activeWorkspaceId,
    /** 这个视图所属的会话（见 agentAppFrom 的说明：标签视图里就是标签自己那条） */
    activeConversationId: conversationId,
    // ---- 活跃会话那份现场（字段名与旧的全局单份一致，渲染层无感） ----
    messages: activeSlice?.messages ?? NO_MESSAGES,
    /** 最近一次上下文交接文档（流式生成中 / 已完成）；null = 没有可展示的 */
    compaction: activeSlice?.compaction ?? null,
    /** 协作会话的运行态（任务 / 消息 / Agent 状态 + 实时文本）；普通会话 = null */
    collab: activeSlice?.collab ?? null,
    /** 覆盖协作配置（增删改 Agent / 并行与单轮运行上限） */
    saveCollabSettings: (settings: CollabSettings) =>
      s.saveCollabSettings(settings, conversationId),
    /** 取消协作会话里某个正在跑的子任务 */
    cancelCollabTask: (taskId: string) =>
      s.cancelCollabTask(taskId, conversationId),
    /**
     * 会话切换后历史还没拉回来的装载中标记（消息区此时显示装载中而不是旧列表）。
     *
     * 还有一种「本屏绑了会话、但本地现场还没建」的窗口，也必须是 true：**刷新页面后**
     * 主区域的对话标签会先拿自己那条会话 id 渲染（`useAgentAppView(id)`），而 `slices`
     * 里还没有它 —— 真正的装载（`openConversation`）要等会话清单落地，由 `PanelView`
     * 把「当前会话」对齐到焦点标签时才触发。这段窗口若报 false，消息区就按「一条消息
     * 都没有」渲染空态（「在「工作区」里说点什么」），清单 + 历史一回来又被消息顶掉：
     * 就是那个「刷新闪一下空态」。ACP 会话尤其明显，它比内置会话多一次 `session/load`
     * 回放往返。
     *
     * 判据里带上 `conversations.some(...)`：指向**已删除**的会话（标签还挂着个野 id）
     * 时保持 false —— 那种视图永远不会装载，别让它卡在骨架上。
     */
    messagesLoading:
      activeSlice?.loading ??
      (!!conversationId &&
        (!s.conversationsLoaded ||
          s.conversations.some((c) => c.id === conversationId))),
    /**
     * 正在删消息（「仅本条」/「本条及其后」/ 编辑重发里的那一步）：消息区挂「正在删除…」
     * 并暂时不收点击 —— 删除完成后要整体回拉历史，中途再点只会让两边互相盖。
     */
    messagesDeleting: activeSlice?.deleting ?? false,
    /** 会话历史加载失败（消息列表里展示错误 + 重试），null = 正常 */
    messagesError: activeSlice?.error ?? null,
    /** 模型请求正在重试时的单条提示（第 N 次重试）；null = 没在重试 */
    retryNotice: activeSlice?.retryNotice ?? null,
    /**
     * 连接断了但服务端那轮还在跑：正在自动重接（第几次）；null = 没在重接。
     * ChatPanel 据此在消息区顶部挂一条带「立即重连」的提示。
     */
    reconnectNotice: activeSlice?.reconnectNotice ?? null,
    /** 当前打开的会话是否正在流式（后台会话在跑不影响这里；侧栏转圈看 runningConversations） */
    streaming: activeSlice?.streaming ?? false,
    /**
     * 正在「回放现场」（断线重连后服务端从帧日志头部重放这一轮）。
     * 只影响滚动跟随：回放期间改成瞬时贴底，免得内容先塌后长时被弹簧带着
     * 从顶部一路滚下来（见 store 的 `ConvSlice.replaying`）。
     */
    replaying: activeSlice?.replaying ?? false,
    busy: s.busy,
    /**
     * 最近一次上下文压缩的通知（带自动消失）。上下文圆环的详情里展示；
     * 为 null 时显示「最近没有发生过上下文压缩」。
     *
     * **本标签那条会话的**：分屏时 A 压缩了上下文，B 不该跟着弹。
     */
    contextNotice: activeSlice?.contextNotice ?? null,
    /** 兜底上下文窗口（模型没单独配窗口时的圆环分母）；null = 还没拉到 */
    defaultContextWindow: s.defaultContextWindow,
    /** 拉一次兜底窗口（已缓存时是 no-op；圆环挂载时调） */
    loadDefaultContextWindow: s.loadDefaultContextWindow,
    /** 手动压缩进行中（本标签这条会话）：输入框禁发，圆环转圈 */
    contextCompressing: activeSlice?.contextCompressing ?? false,
    /** 「发送即建会话」正在创建：输入框的发送钮转圈（见 store 的同名字段） */
    creatingConversation: s.creatingConversation,
    /** 手动压缩本标签的会话（落摘要检查点；返回给调用方决定 toast） */
    compressContextNow: () => s.compressContextNow(conversationId),
    error: s.error,
    /** 全局错误条：未知斜线命令这类「一次性的提示」也走这里（与 store 其他错误同路） */
    setError: s.setError,
    /** 正在跑一轮对话的会话 id 集合（侧栏转圈按会话跟踪；与当前打开哪个无关） */
    runningConversations: s.runningConversations,
    /** 滚动复位信号：切换会话 / 消息装载时自增（ChatPanel 传给 Conversation 的 resetKey） */
    scrollResetSeq: activeSlice?.scrollResetSeq ?? 0,
    /** confirm 模式下等用户答复的审批（渲染成卡片；活跃会话那一份） */
    pendingConfirms: activeSlice?.pendingConfirms ?? NO_CONFIRMS,
    /** ask_followup_question 在等的提问（按工具调用 id 索引；用于渲染提问卡） */
    followupRequests: activeSlice?.followupRequests ?? NO_FOLLOWUPS,
    /** 待发送队列：会话进行中用户发的消息先排在这里，本轮结束依次执行（活跃会话那一份） */
    queuedMessages: activeSlice?.queuedMessages ?? NO_QUEUE,
    /** 队列里删一条（分屏时只动本标签那条会话的队列） */
    removeQueuedMessage: (id: string) =>
      s.removeQueuedMessage(id, conversationId),
    /** 队列里改一条的文本 */
    updateQueuedMessage: (id: string, text: string) =>
      s.updateQueuedMessage(id, text, conversationId),
    /** 队列拖拽排序：把一条挪到另一条前面（顺序即发送顺序；一并落服务端） */
    moveQueuedMessage: (id: string, beforeId: string | null) =>
      s.moveQueuedMessage(id, beforeId, conversationId),
    /** 队列 ↑↓ 按钮微调（触屏用）：-1 = 上移更早发出，1 = 下移；越界不动 */
    moveQueuedMessageBy: (id: string, delta: number) =>
      s.moveQueuedMessageBy(id, delta, conversationId),
    /** 发送队列里的一条：本轮在跑 = 插话（到下一个边界生效）；没在跑 = 立刻开新一轮 */
    sendQueuedMessage: (id: string) =>
      s.sendQueuedMessage(id, conversationId),
    /** 清空待发送队列（失败暂停后的一键清空） */
    clearQueuedMessages: () => s.clearQueuedMessages(conversationId),
    /** 会话分叉（从此签出）：fork 本标签的会话到某条消息（含）并切到新会话 */
    forkConversation: (
      upToMessageId: string,
      opts?: { worktreeIdentifier?: string; worktreeName?: string },
    ) => s.forkConversation(upToMessageId, opts, conversationId),
    /** 队列链为什么停了：'failed' = 上轮失败已暂停（头部提示 + 一键继续/清空） */
    queuePausedReason: activeSlice?.queuePausedReason ?? null,
    /** 队列泵：没在跑时把下一条顶上来（失败暂停后「继续发下一条」也走它） */
    pump: () => s.pump(conversationId),
    permissionMode: s.permissionMode,
    // 动作
    connect: s.connect,
    disconnect: s.disconnect,
    refresh: s.refresh,
    /** 切工作区（会顺手选中它最近的会话） */
    selectWorkspace: s.selectWorkspace,
    /** 打开某个会话（会拉完整消息）；传 null 回到空态 */
    openConversation: s.openConversation,
    /** 会话历史加载失败后的重试（重跑 loadConversation） */
    retryLoadMessages: s.retryLoadMessages,
    /** 重接一条进行中的对话（连接中断后把现场接回来；页面从后台回来时也会自动调） */
    reconnectRun: s.reconnectRun,
    newConversation: s.newConversation,
    newCollabConversation: s.newCollabConversation,
    deleteConversation: s.deleteConversation,
    /**
     * 发送一轮。带上本视图的会话：分屏时两个标签同时可见，不能靠「谁是活跃会话」
     * 决定发到哪（那会把非焦点标签的消息插到焦点会话里）。
     */
    send: (
      text: string,
      files?: UploadFileRef[],
      onStarted?: () => void,
    ) => s.send(text, files, onStarted, conversationId),
    /** 运行中插话（steer）：下一个工具步骤边界注入当前轮；空闲时回落普通发送 */
    steer: (
      text: string,
      files?: UploadFileRef[],
      onStarted?: () => void,
    ) => s.steer(text, files, onStarted, conversationId),
    /** 撤回一条还没生效的插话（「插入中」列表的 ✕） */
    removeSteer: (messageId: string) =>
      s.removeSteer(messageId, conversationId),
    /** 插话拖拽排序：把一条挪到另一条前面（顺序即生效顺序；一并同步服务端收件箱） */
    moveSteer: (messageId: string, beforeId: string | null) =>
      s.moveSteer(messageId, beforeId, conversationId),
    /** 插话 ↑↓ 按钮微调（触屏用）：-1 = 上移更早生效，1 = 下移；越界不动 */
    moveSteerBy: (messageId: string, delta: number) =>
      s.moveSteerBy(messageId, delta, conversationId),
    /** 立刻发送一条还没发出去的插话（行上的 ➤）：本轮不在跑时按新一轮的普通消息发出 */
    sendSteer: (messageId: string) =>
      s.sendSteer(messageId, conversationId),
    /** 已插入、还没生效的插话（活跃会话那一份；agent 消费后经 user-injected 转正出列） */
    pendingSteers: activeSlice?.pendingSteers ?? NO_STEERS,
    /** 停这个视图的会话这一轮（分屏时别去停焦点会话） */
    stop: () => s.stop(conversationId),
    /** 停止**指定会话**的一轮（不依赖谁是当前会话）—— 关标签守卫用它先停会话再放行 */
    stopConversation: s.stopConversation,
    /** 答复一次命令执行审批（卡片可能在非焦点标签上，撤卡要撤对会话） */
    resolveConfirm: (id: string, approved: boolean, optionId?: string) =>
      s.resolveConfirm(id, approved, optionId, conversationId),
    /** 答复一次 ask_followup_question 提问（null = 跳过） */
    resolveFollowup: (
      toolCallId: string,
      answer: AskFollowupAnswer | null,
    ) => s.resolveFollowup(toolCallId, answer, conversationId),
    /** 重命名会话 */
    renameConversation: s.renameConversation,
    /** 归档 / 取消归档会话（不删数据；侧栏据此收进 / 放出「已归档」区） */
    archiveConversation: s.archiveConversation,
    /** 重启 acp 会话：杀 agent 进程、保留 sessionId（下一条消息 session/load 接回原上下文） */
    restartAcpSession: s.restartAcpSession,
    /** 重新加载 acp 会话：当场再走一次 session/load，用 agent 侧回放整体重建消息列表 */
    reloadAcpSession: s.reloadAcpSession,
    /**
     * 重新加载**这一条**会话（等价于「刷新页面 → 点开它」）：内置 拉权威历史、
     * acp 走 session/load 回放。错误块那颗「重新加载」按钮与标签右键的「刷新」都走它。
     */
    reloadConversation: s.reloadConversation,
    /** ACP 会话 → 内置 Agent 会话：拉 agent 侧转录、洗成内置格式、新建一条会话并切过去 */
    convertAcpConversation: s.convertAcpConversation,
    /** 清空会话（保留会话本身） */
    clearConversation: s.clearConversation,
    /** 删除单条消息（后面的消息保留）。分屏时删的是本标签会话里的那条 */
    deleteMessage: (messageId: string) =>
      s.deleteMessage(messageId, conversationId),
    /** 删除某条消息及其之后的全部消息（「从这里重新开始」） */
    deleteMessagesFrom: (messageId: string) =>
      s.deleteMessagesFrom(messageId, conversationId),
    /** 编辑后重发：把某条消息改为新文本并重新走一轮（截断 + 重发都在本标签的会话上） */
    resendMessage: (
      messageId: string,
      text: string,
      files?: UploadFileRef[],
      onStarted?: () => void,
    ) => s.resendMessage(messageId, text, files, onStarted, conversationId),
    /** 列工作区某目录（'' = 根） */
    listWorkspaceFiles: s.listWorkspaceFiles,
    listAcpAgentSessions: s.listAcpAgentSessions,
    listAcpAgentModes: s.listAcpAgentModes,
    setAcpAgentMode: s.setAcpAgentMode,
    /** 切换 acp 会话的思考档（configOptions 的 thought_level，pi 用它） */
    setAcpThoughtLevel: s.setAcpThoughtLevel,
    deleteAcpAgentSession: s.deleteAcpAgentSession,
    /** 读一个工作区文本文件（二进制/过大返回 null） */
    readWorkspaceFile: s.readWorkspaceFile,
    /** 写工作区文件：返回 null = 成功，字符串 = 错误原因 */
    writeWorkspaceFile: s.writeWorkspaceFile,
    /**
     * 脚手架：新建一份模板文件（技能 SKILL.md / AGENTS.md 空骨架）。斜线命令
     * `/create-skill` 已移除，目前没有界面入口；`/init` 也不走这里（由模型生成）。
     * 成功返回落点 + 提示语，失败返回人话错误（调用方直接显示）。
     */
    scaffoldWorkspaceFile: s.scaffoldWorkspaceFile,
    /** git 状态（分支 / ahead-behind / 暂存·未暂存·未跟踪）；出错抛错 */
    gitStatus: s.gitStatus,
    /** git 分支清单（本地 + 远端） */
    gitBranches: s.gitBranches,
    /** git 提交历史（默认 30 条） */
    gitLog: s.gitLog,
    /** 一次提交的元信息 + 文件清单 + unified 文本（历史面板就地展开用） */
    gitCommit: s.gitCommit,
    /** 单文件 diff 的原始 unified 文本（staged = 看暂存区 vs HEAD） */
    gitDiff: s.gitDiff,
    /** git 写操作（暂存 / 取消暂存 / 提交 / 检出 / 推送），返回 git 的输出 */
    gitAction: s.gitAction,
    /** 把媒体文件拉成 object URL（图 / 视频 / 音频预览用） */
    fetchWorkspaceMedia: s.fetchWorkspaceMedia,
    /** 把工作区文件下载到本机（另存为）；返回错误文本，null = 已触发 */
    downloadWorkspaceFile: s.downloadWorkspaceFile,
    /** 删除工作区里的文件或目录（递归）；返回是否成功 */
    deleteWorkspaceFile: s.deleteWorkspaceFile,
    /** 复制工作区里的文件或目录；返回新路径，失败 null */
    copyWorkspaceFile: s.copyWorkspaceFile,
    /** 移动 / 重命名工作区里的文件或目录；成功返回新路径 */
    moveWorkspaceFile: s.moveWorkspaceFile,
    /** 工作区相对路径的新建文件夹（远端也能用）；与 `createServerDir`（宿主机绝对路径）不是一回事 */
    createWorkspaceDir: s.createWorkspaceDir,
    /** 切换权限模式（confirm = 破坏性操作先问一句）；活档改的是本标签那条会话的轮 */
    setPermissionMode: (mode: AiPermissionMode) =>
      s.setPermissionMode(mode, conversationId),
    /** 本标签 ACP 会话的权限答复策略（confirm = 逐次问；allow = 应用层自动放行） */
    setAcpPermissionMode: (mode: AcpPermissionMode) =>
      s.setAcpPermissionMode(mode, conversationId),
    /** confirm 审批超时（分钟；0 = 不超时）与设置动作 */
    confirmTimeoutMin: s.confirmTimeoutMin,
    setConfirmTimeoutMin: s.setConfirmTimeoutMin,
    /** 模型请求自动重试次数（0 = 不限制）与设置动作 */
    maxRetries: s.maxRetries,
    setMaxRetries: s.setMaxRetries,
    /** 同一批工具调用的并发上限（1 = 串行）与设置动作 */
    toolCallConcurrency: s.toolCallConcurrency,
    setToolCallConcurrency: s.setToolCallConcurrency,
    /** 一轮最多跑多少步（工具轮）与设置动作 */
    maxSteps: s.maxSteps,
    setMaxSteps: s.setMaxSteps,
    /** 工具卡是否显示「意图」（模型每次调工具填的一句话）与设置动作 */
    toolIntent: s.toolIntent,
    setToolIntent: s.setToolIntent,
    /**
     * 选本轮后端：`{backend:'acp', configId:<agent id>}` 或 `{backend:'builtin', configId:<model id>}`。
     * 选的是**这个视图的会话**那一份 —— 分屏时在非焦点标签换模型，不该改焦点会话的待发目标。
     */
    setChatTarget: (target: ChatTarget | null) =>
      s.setChatTarget(target, conversationId),
    /**
     * 新任务页选中 ACP agent 时探一次它的档位（模式 / 思考档）。
     * 幂等、不抛；失败只写 `draftAcp.error`，pill 退化成「默认档」。
     */
    probeDraftAcp: s.probeDraftAcp,
    /** 新任务页选模式（null = 跟随 agent 默认）；会话建好时下发 */
    setDraftAcpMode: s.setDraftAcpMode,
    /** 新任务页选思考档（null = 跟随 agent 默认）；会话建好时下发 */
    setDraftAcpThought: s.setDraftAcpThought,
    /** 清掉 ACP 草稿档位（切回内置 agent 时） */
    clearDraftAcp: s.clearDraftAcp,
    clearError: s.clearError,
    /** 新建 / 更新一个 ACP agent：带 `id` 走更新、不带走新建（更新时刻意不传 models） */
    saveAcpAgent: s.saveAcpAgent,
    deleteAcpAgent: s.deleteAcpAgent,
    /**
     * 保存「这个 ACP agent 的模型里，哪几个放进会话下拉」（设置页挑的）。
     * 一个 agent 往往能选十几二十个模型，全列进会话下拉太吵，这里做一层白名单。
     */
    saveAcpAgentModels: s.saveAcpAgentModels,
    /**
     * 探针：问这个 ACP agent **自己**有哪些模型可选（设置页列候选用；起一次它的进程，
     * 问完就收掉）。失败（命令不存在 / 不是 ACP agent）时抛错，由调用方提示。
     */
    probeAcpModels: s.probeAcpModels,
    detectAcpAgents: s.detectAcpAgents,
    saveMcpServer: s.saveMcpServer,
    deleteMcpServer: s.deleteMcpServer,
    saveSshHost: s.saveSshHost,
    deleteSshHost: s.deleteSshHost,
    saveHostGroup: s.saveHostGroup,
    deleteHostGroup: s.deleteHostGroup,
    arrangeHosts: s.arrangeHosts,
    saveSshTunnel: s.saveSshTunnel,
    deleteSshTunnel: s.deleteSshTunnel,
    startSshTunnel: s.startSshTunnel,
    stopSshTunnel: s.stopSshTunnel,
    saveApiRequest: s.saveApiRequest,
    deleteApiRequest: s.deleteApiRequest,
    /** 批量新建请求（OpenAPI / Swagger 导入）；返回这一批新建出来的请求 */
    importApiRequests: s.importApiRequests,
    arrangeApi: s.arrangeApi,
    saveApiGroup: s.saveApiGroup,
    deleteApiGroup: s.deleteApiGroup,
    /** 覆盖写入整段请求历史（渲染端裁剪后的窗口） */
    saveApiHistory: s.saveApiHistory,
    clearApiHistory: s.clearApiHistory,
    /** 执行一次 HTTP 请求（服务端发出）；结果原样返回给编辑页展示 */
    sendApiRequest: s.sendApiRequest,
    /** 取消进行中的请求（幂等） */
    abortApiRequest: s.abortApiRequest,
    /**
     * 解析远端路径（缺省 = 家目录）：主机终端拖拽上传时拿它当**目标目录初值**。
     *
     * 未连接时抛错 —— 调用方要把它显示在确认条的「连接失败」态里（静默返回空串会让人
     * 以为「目录就是空的」）。
     */
    sftpRealpath: s.sftpRealpath,
    /**
     * SFTP 文件管理（右击主机 →「SFTP 文件管理」标签）的读写动作。
     *
     * 都是**一问一答**的短操作，没有进度 / 取消，未连接时抛错（由面板显示成错误态）。
     *
     * ⚠️ **上传 / 下载不在这里** —— 它们带进度与取消、要活得比发起它们的组件长，走模块级的
     * `shared/lib/file-transfer/engine.ts`（`runUpload` / `runDownload` / `cancelTransfer`）。
     */
    sftpList: s.sftpList,
    sftpMkdir: s.sftpMkdir,
    sftpRename: s.sftpRename,
    sftpRemove: s.sftpRemove,
    sftpCopy: s.sftpCopy,
    sftpMove: s.sftpMove,
    saveScript: s.saveScript,
    deleteScript: s.deleteScript,
    /** 拖拽重排（分组顺序 + 脚本归属） */
    arrangeScripts: s.arrangeScripts,
    saveScriptGroup: s.saveScriptGroup,
    deleteScriptGroup: s.deleteScriptGroup,
    /** 导出数据（左下角菜单）：返回文件内容 + 建议文件名；失败返回 null */
    exportTransferData: s.exportTransferData,
    /** 解析导入包看摘要（不写库）；失败返回 null */
    inspectTransferData: s.inspectTransferData,
    /** 执行导入：成功刷全量列表，返回「新增 / 覆盖 / 跳过」统计；失败返回 null */
    applyTransferData: s.applyTransferData,
    /** 构建 MCP 工具集并返回工具信息 / 连接错误（设置页预览） */
    listMcpTools: s.listMcpTools,
    /** 列某一个 MCP server 自己的工具（服务端连上、列完、把进程收掉） */
    probeMcpServerTools: s.probeMcpServerTools,
    /**
     * 向模型上游要一份可选模型清单（设置页「从上游拉取」）。
     *
     * 刻意**不套 withRefresh**：这是只读探测，拉完清单还要让用户在里面挑，
     * 刷新整个 app 状态只会把面板重挂一遍，白白丢掉刚拉到的结果。
     */
    probeUpstreamModels: s.probeUpstreamModels,
    addWorkspace: s.addWorkspace,
    /** 从 Git 导入项目：服务端克隆 + 登记；成功返回新项目（列表已刷新），失败 null（原因进 error） */
    cloneWorkspace: s.cloneWorkspace,
    /** 取消一条后台任务（克隆就是其中一种，幂等、不报错）：服务端杀进程 + 清半成品，回包即可重试 */
    cancelBackgroundTask: s.cancelBackgroundTask,
    /** 转到后台：只断开等待那条请求，任务继续在状态栏的任务列表里跑 */
    detachBackgroundTask: s.detachBackgroundTask,
    /** 新建容器型项目（目录由服务端固定生成）：成功返回新项目（列表已刷新），失败 null */
    createContainerProject: s.createContainerProject,
    /** 改容器型项目（改名 / 换镜像 / 预览端口 / 发布开关）；成功后刷新列表 */
    updateContainerProject: s.updateContainerProject,
    /** 重命名项目（只改展示名） */
    renameWorkspace: s.renameWorkspace,
    /**
     * 在某个项目下创建 worktree（= 一个新的 worktree 项目）。
     * 成功时刷新列表并**返回新项目**（调用方据此选中它、跳到它的对话页）；失败返回 null。
     */
    createWorktree: s.createWorktree,
    /**
     * 扫描项目 `.worktree/` 下磁盘上既有的 worktree（「管理工作区」弹窗的清单）。
     * 只读探测：不刷新 app 状态，错误照常抛给弹窗自己显示（拉不到清单不该是全局错误）。
     */
    scanWorktrees: s.scanWorktrees,
    /**
     * 把一个**已经存在**的 worktree 目录加载（登记）成项目 —— 不建目录、不建分支。
     * 与 createWorktree 同构：成功后刷新列表并返回新项目，失败返回 null（原因进 app.error）。
     */
    loadWorktree: s.loadWorktree,
    deleteWorkspace: s.deleteWorkspace,
    /** 列服务端目录（只列子目录）：web 端「选服务端目录」弹窗用 */
    listServerDirs: s.listServerDirs,
    /** 登记一个目录为笔记根（成功返回记录并刷新清单，失败 null） */
    addNotesRoot: s.addNotesRoot,
    /** 移除笔记根登记（只摘登记，不碰磁盘） */
    removeNotesRoot: s.removeNotesRoot,
    /**
     * 笔记文件操作（一问一答，出错抛 `ApiError`）。
     *
     * 树是**懒加载**的：`listNoteFiles` 一次只列一层，展开子目录时再调一次。
     */
    listNoteFiles: s.listNoteFiles,
    readNoteFile: s.readNoteFile,
    writeNoteFile: s.writeNoteFile,
    createNoteFile: s.createNoteFile,
    renameNoteFile: s.renameNoteFile,
    deleteNoteFile: s.deleteNoteFile,
    /**
     * 在服务端某个目录下新建文件夹（同上，web 端专用），返回新目录的绝对路径。
     *
     * 刻意**不套 withRefresh**：建完只是那个目录多了一项，由弹窗自己重列即可；
     * 刷新整个 app 状态会把弹窗重挂一遍，用户当前浏览到哪儿就丢了。
     */
    createServerDir: s.createServerDir,
    saveModel: s.saveModel,
    deleteModel: s.deleteModel,
    toggleSkill: s.toggleSkill,
    /** 保存技能页「额外发现目录」（全量清单；技能页的添加 / 移除目录走这里） */
    setSkillDirs: s.setSkillDirs,
    /**
     * 启 / 停一个子任务（subagent）。内置两个的定义在服务端代码里，自定义的随设置落盘
     * （`subagentSettings.definitions`）—— 见 `AiPreferencesTab` 的「子任务」区。
     */
    toggleSubagent: s.toggleSubagent,
    /** 设置子任务专用模型（`null` = 沿用父会话模型） */
    setSubagentModel: s.setSubagentModel,
    /** 设置某个子任务的步数上限（`null` = 回到规格默认值） */
    setSubagentMaxSteps: s.setSubagentMaxSteps,
    /** 保存自定义子智能体的整份清单（新建 / 编辑 / 删除都走它） */
    saveSubagentDefinitions: s.saveSubagentDefinitions,
    /**
     * 保存**这个视图的会话**的浏览器偏好（总开关 / 来源）。只传要改的字段，与当前值合并后
     * 整体落库到会话（下一轮生效）。每个会话各记一份 —— 分屏时两个标签互不覆盖。
     *
     * 与外部 playwright-mcp 的同名冲突**不用手动处理**：装配时内置会自动让位。
     */
    saveBrowserSettings: (patch: Partial<BrowserSettings>) =>
      s.setBrowserSettings(patch, conversationId),
    /**
     * 保存系统监控偏好（总开关）。关掉后服务端**停止采样**、状态栏也不再渲染监控条 ——
     * 只传要改的字段（服务端「缺字段 = 保留」）。见设置页「系统监控」小节。
     */
    saveSystemMonitorSettings: s.saveSystemMonitorSettings,
    /**
     * 重新扫一遍技能（不整表刷新）：技能是**磁盘上的目录**，用户可能在外部新装了一个，
     * 列表不会自己变 —— 设置页的「刷新」按钮走这里。GET 每次都在服务端重扫。
     */
    reloadSkills: s.reloadSkills,
    /**
     * 这台机器上有哪些 shell（终端面板「选择终端」下拉用）。
     *
     * ⚠️ 未连接（api 为 null）时返回**被拒绝的 Promise**，不能同步抛 ——
     * 调用方是 `void listTerminalShells().catch(...)`，同步抛出它接不住，应用会直接崩。
     */
    listTerminalShells: s.listTerminalShells,
  };
}

export type AgentApp = ReturnType<typeof agentAppFrom>;

/**
 * 登录失效的「收口窗口」（毫秒）。
 *
 * ## 为什么需要一个窗口，而不是清一次就完
 *
 * 401 钩子在**响应到达的那一刻**同步跑；而同一批并发请求的 reject 是**之后**才陆续落到各自的
 * `catch` 里的 —— 连接后的 `refresh()` 一次并发二十来个 GET，加上各面板自己的首屏加载，
 * 每一个失败的分支都会弹一条自己的话（「刷新失败：未授权：请重新登录」「读取文件失败：…」）。
 * 它们分散在后续好几拍微任务 / 宏任务里，**清一次必然被下一拍重新填满**（实测反馈：被踢回
 * 登录页时头顶挂着一整屏 toast，而那一屏已经没有任何上下文解释它们）。
 *
 * 所以在窗口内每一拍都 `dismiss()` 清场，只在**最后一拍**落我们自己那一条。400ms 足够盖住
 * 那一批请求的尾随 catch，又短到用户不会觉得「卡了一下才提示」。
 */
const SESSION_EXPIRED_SWEEP_MS = [0, 60, 180, 400] as const;

/** 固定 id：窗口内再来几条 401 也只是把同一条顶到最新，不会叠成一摞 */
const SESSION_EXPIRED_TOAST_ID = "fizz-session-expired";

/** 当前窗口的定时器：新一批 401 到达时要先撤掉旧的，否则两条时间线会互相抢着 dismiss */
let sessionExpiredTimers: number[] = [];

/** 撤掉正在跑的收口窗口（重开一个之前 / 组件卸载时都要调） */
function clearSessionExpiredWindow(): void {
  for (const timer of sessionExpiredTimers) window.clearTimeout(timer);
  sessionExpiredTimers = [];
}

/**
 * 清场 + 只留一条「登录已过期」。
 *
 * 只由 401 钩子调用。重复调用是安全的：撤掉上一轮窗口、重新开一个（`disconnect()` 本身幂等）。
 */
function announceSessionExpired(): void {
  clearSessionExpiredWindow();
  toast.dismiss();
  const lastIndex = SESSION_EXPIRED_SWEEP_MS.length - 1;
  SESSION_EXPIRED_SWEEP_MS.forEach((delay, index) => {
    sessionExpiredTimers.push(
      window.setTimeout(() => {
        // 这一拍里各调用方自己的 catch 可能刚弹完，一起收掉
        toast.dismiss();
        if (index !== lastIndex) return;
        sessionExpiredTimers = [];
        toast.error("登录已过期，请重新登录", {
          id: SESSION_EXPIRED_TOAST_ID,
          // 自动消失：登录页上不该留一条要用户手动关的提示
          duration: 6000,
        });
      }, delay),
    );
  });
}

/**
 * 应用级视图：绑定**当前活跃会话**，并承担全部全局副作用。
 *
 * 这是唯一的「副作用宿主」—— 状态 WS 订阅、连接后全量对账、401 收场、从后台回来
 * 补接断线、自动恢复上次会话，都只在这里挂一次。`useAgentAppView` 刻意不碰它们：
 * 每个对话标签各挂一份全局副作用会重复订阅、重复对账。
 *
 * 整店订阅（`useAgentStore()` 无 selector）：本 hook 仍会随任何状态变化重渲染，
 * 但**返回值在「只有切片变化」时保持旧引用**（见函数末尾的投影缓存）。外壳 / 侧栏 /
 * 面板骨架读的都是非切片状态，冻结它换来的是「流式期间整个应用不再每帧重渲」；
 * 会话正文那一路走 `useAgentAppView(id)`，始终是最新现场。
 */
export function useAgentApp(): AgentApp {
  const s = useAgentStore();

  // 全局状态 WS：服务端改了就推，前端不再轮询（绑定一次；退订随卸载）
  useEffect(() => useAgentStore.getState().bindStateWs(), []);

  // 连接建立后拉一遍全量清单：WS 的 `init` 快照为主，这里兜底对一次账。
  // 一条连接只拉一遍 —— 不轮询；后续变更全靠 WS 推送（push 只推变化的域）。
  const { connection, refresh } = s;
  useEffect(() => {
    if (!connection) return;
    void refresh();
  }, [connection, refresh]);

  // 任意 API 拿到 401（token 失效 / 服务端重启换了密钥）→ 清本地数据并退回登录页。
  // 这里只负责「清场」，连接门禁由 `AppGate`（`app/App.tsx`）在 `connection` 变 null 时渲染。
  useEffect(() => {
    setUnauthorizedHandler(() => {
      /**
       * ⚠️ 这里**不加**「已经断开了就早退」那种守卫：同一批并发请求里，`refresh()` 的 catch
       * 也会自己调 `disconnect()`，谁先跑不确定 —— 早退会让后到的那几条 401 不再收口，
       * 它们弹的报错就留在了屏幕上。重复调用是幂等的（dismiss 全清、disconnect 清空），
       * 宁可多跑几遍。
       */
      useAgentStore.getState().disconnect();
      /**
       * 收口交给 `announceSessionExpired()`（见它上面的注释）：单个 `dismiss()` 只能清掉
       * **此刻**已经弹出来的那些，而同一批请求的尾随 catch 会在后面几拍继续弹 —— 所以那边
       * 用一个 400ms 的窗口反复清，最后只留一条。
       */
      announceSessionExpired();
    });
    return () => {
      setUnauthorizedHandler(null);
      // 卸载（换会话 / 换宿主）时把在跑的窗口撤掉，别让定时器在已经没界面的地方弹 toast
      clearSessionExpiredWindow();
    };
  }, []);

  /**
   * 页面从后台回来（标签页切回 / 电脑唤醒 / 网络恢复）：把「已知断线」的会话立刻接回去。
   *
   * 为什么还需要这一下：后台 tab 的定时器会被浏览器拖慢（极端情况直接冻结），
   * `attachRun` 里断线重接的退避睡眠可能还没醒；而人已经回到页面前，发现消息停住了。
   * 这里的判断是 `reconnectNotice`（真断过一次、且服务端那轮还在跑）与 `droppedRound`
   * （真断过一次、服务端那轮多半已经跑完落盘，只差把权威历史换回来）—— 连接正常时
   * 什么都不做（`reconnectRun` 内部对「已经在接」的会话也会自行去重）。
   */
  useEffect(() => {
    const resumeDropped = () => {
      const store = useAgentStore.getState();
      for (const [id, slice] of Object.entries(store.slices)) {
        if (slice.reconnectNotice) void store.reconnectRun(id);
        // 手机息屏 / 电脑休眠期间那一轮跑完了：醒来时把它落盘的回复换回来（不换就得刷新）
        else if (slice.droppedRound) void store.reconcileDroppedRun(id);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") resumeDropped();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", resumeDropped);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", resumeDropped);
    };
  }, []);

  /**
   * 从**别的窗口**回来时对齐一次服务端配置。
   *
   * desktop 的「设置」是**独立窗口**（另一个渲染进程、各自一份 store），web 也可能同时开着
   * 两个标签页；而模型配置 / 权限档 / MCP / 技能 / 插件 / 系统监控这些**都存在服务端**，
   * 本窗口只在自己启动或自己改配置时 `refresh()` —— 不补这一下，在设置窗口改了默认模型，
   * 回到主窗口还是旧的，得重启才认。
   *
   * 判据是「**离开过 ≥1s**」而不是单纯 `focus`：窗口失焦一下又回来（点菜单、切输入法、
   * 拖到另一块屏）不值当拉十几个接口。localStorage 那类偏好（主题 / 强调色 / 面板宽度…）
   * 各自有 `storage` 监听，不归这里管。
   *
   * ⚠️ 这里拉的是**服务端清单**（不碰会话流）—— `refresh()` 只读十几个 GET，
   * 不会打断正在跑的一轮对话。
   */
  useEffect(() => {
    let leftAt = 0;
    const onBlur = (): void => {
      leftAt = Date.now();
    };
    const onFocus = (): void => {
      const left = leftAt;
      leftAt = 0;
      if (!left || Date.now() - left < 1000) return;
      void useAgentStore.getState().refresh();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // 刷新 / 下次启动（首次进入 / 删了工作区）：恢复上次打开的会话；
  // 那个会话没了（被删 / 换了工作区）就退到该工作区最新的会话。
  // ⚠️ 隐藏的「任务」虚拟工作区（path 为空）**不自动开会话**：侧栏不显示它，
  // 把它的旧会话摆出来只会让人困惑（实测「项目里没有会话却有消息」就是它）。
  const {
    activeWorkspaceId,
    conversations,
    workspaces,
    activeConversationId,
    openConversation,
  } = s;
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (activeConversationId) return;
    if (useAgentStore.getState().blankIntent) return;
    /*
     * ⚠️ 上面那句 `blankIntent` 只管**当前这一次会话**，刷新就没了。而用户关掉所有会话之后
     * 紧接着刷新页面是很自然的动作 —— 那一刻必须靠**落盘的**那份意图挡住，否则会把用户
     * 刚亲手关掉的会话又拉回来（实测：关光 → 刷新 → 会话「自己回来了」）。
     */
    if (loadBlankIntent()) return;
    if (!workspaces.some((w) => w.id === activeWorkspaceId && w.path)) return;
    // 只从**未归档**的会话里挑：自动恢复是「回到上次干活的地方」，把归档的
    // 会话拉回来等于归档了个寂寞
    const list = conversations.filter(
      (c) => c.workspaceId === activeWorkspaceId && !c.archivedAt,
    );
    if (list.length === 0) return;
    const saved = loadActiveConversationId();
    const target = list.find((c) => c.id === saved) ?? list[0];
    openConversation(target.id);
  }, [
    activeWorkspaceId,
    activeConversationId,
    conversations,
    workspaces,
    openConversation,
  ]);

  /**
   * shell 投影缓存：`slices` **以外**的根字段引用不变时，沿用上一份 `app`。
   *
   * ## 为什么必须冻结
   *
   * 流式期间每一批帧都会 `writeSlice()`（消息正文在变），store 根对象随之换引用，
   * 本 hook 每帧重渲。而 `agentAppFrom` 每次调用都返回**新对象**，这个 `app` 挂在
   * `AppContext` 上 → 所有 `useAppContext()` 消费者（外壳、侧栏、每个面板）跟着
   * 每帧重渲。加上 `AppProvider` 里 `value` 字面量也是每帧新建、`useTriggers` 的
   * 返回值同样如此，整棵应用树在会话跑着时被按帧全量重渲 —— 用户观感就是
   * 「整个软件都卡卡的」（连 ViewPanel 标签条滚动都受影响）。
   *
   * 外壳层实际读的全是**清单类**状态（连接 / 工作区 / 会话清单 / 模型 / 终端…），
   * 没有一个读正在流式的正文；正文那一路由每个对话标签自己的 `useAgentAppView(id)`
   * 提供，它不缓存、每帧都是最新现场。
   *
   * ## 新增字段时的约束
   *
   * 若将来有**外壳层**组件要读某个切片字段（`app.streaming` / `app.messages` …），
   * 不能直接信这里返回的旧值：要么改用 `useAgentStore` 选择器按需订阅（见
   * `app-provider.tsx` 里 `chatStreaming` 的写法），要么把该字段加进 `shellKeys`。
   */
  const shellCacheRef = useRef<{ keys: readonly unknown[]; app: AgentApp } | null>(
    null
  );
  const shellKeys: unknown[] = [];
  for (const [key, value] of Object.entries(s)) {
    // 流式正文在 slices 里，其余根字段（连接 / 清单 / 动作）都是外壳关心的
    if (key !== "slices") shellKeys.push(value);
  }
  const shellCache = shellCacheRef.current;
  if (
    shellCache &&
    shellCache.keys.length === shellKeys.length &&
    shellCache.keys.every((prev, i) => Object.is(prev, shellKeys[i]))
  ) {
    return shellCache.app;
  }
  const shellApp = agentAppFrom(s, s.activeConversationId);
  shellCacheRef.current = { keys: shellKeys, app: shellApp };
  return shellApp;
}

/**
 * 单会话视图：绑定**指定会话**，**不挂任何全局副作用**（那些只在 `useAgentApp` 里挂一次）。
 *
 * 主区域每个对话标签一份。见 `agentAppFrom` 的文件头说明。
 */
export function useAgentAppView(conversationId: string | null): AgentApp {
  const s = useAgentStore();
  return agentAppFrom(s, conversationId);
}

/**
 * 接上**别的端**在这个会话上发起的一轮。
 *
 * ## 为什么需要它
 *
 * 两条链路是分开的：
 * - **会话清单 / 运行态**走 `state-ws` 广播，哪一端看到的都是同一份 —— 所以远程 web
 *   建了会话、开了新的一轮，桌面端的侧栏立刻会变；
 * - **消息正文与流式输出**是一条**按会话订阅**的 SSE（`attachRun`），只有**发起那一轮的
 *   那个连接**订着它。别的端发起时，本地既没有这条流的帧、也不知道自己没接上 ——
 *   于是侧栏转圈在动，消息区却一直停在旧内容，也没有流式输出（用户实测反馈过）。
 *
 * `attachRun` 本来就是为「接一条已经在跑的 run」写的（刷新 / 断线重连 / 换端回来，
 * 见它的注释），缺的只是**触发点**：以前只有两条路会调它 —— 「打开会话」
 * （`loadConversation` 末尾）与「本连接自己断过」（`reconnectNotice` / `droppedRound`）。
 * 这里补第三条：**服务端说这条会话在跑，而本地没有它的流 → 接上去回放现场继续看直播**。
 *
 * ## 边界
 *
 * - 只对**打开着的会话**做（`ConversationTab` 在挂的那几条）。没打开的会话等用户点开时
 *   `loadConversation` 自己会接 —— 不必替它开一条流，那是白占服务端连接。
 * - 判据用本地 `runningConversations`（「本连接有没有订着这条流」），不是 `activity`：
 *   `activity` 是服务端口径，本端自己发起的那一轮两边都亮，得靠本地那份区分。
 */
export function useAttachRemoteRun(conversationId: string | null): void {
  const activity = useConversationActivity(conversationId);
  const { running, requestId } = activity;
  useEffect(() => {
    if (!conversationId || !running) return;
    // 运行态与通知读的是同一条事件流，绑定本身幂等（本 hook 可能比通知监听先挂上）
    initConversationActivity();
    const store = useAgentStore.getState();
    // 本地自己订着这条流（本轮由本端发起 / 已经接上了）：不重复接
    if (store.runningConversations[conversationId]) return;
    const backend = store.conversations.find(
      (c) => c.id === conversationId,
    )?.backend;
    void (async () => {
      /**
       * 先拉一次权威历史再接手：这一轮的 **user 消息不在帧日志里**（帧只有助手的 parts
       * 与插话的 `user-injected`），只在服务端落盘的历史里 —— 不先拉，接手后会出现
       * 「只有回答、没有提问」。
       *
       * acp 例外（与 `settleRound` 同一条约定）：服务端历史恒为空，拉一次会把本地
       * 回放出来的现场擦掉，而回放那条路要求「本地为空 + 是当前会话」，后台标签拿不到。
       * 它的正文只能靠重开会话时的 `session/load` 重建，这里只接流。
       */
      if (backend !== "acp") await store.loadMessages(conversationId);
      // 拉这一趟里用户可能已经在这个会话里自己发了一轮：让位给本端那一轮，别抢
      const now = useAgentStore.getState();
      if (now.runningConversations[conversationId]) return;
      await now.attachRun(conversationId);
    })();
    // requestId 进依赖：同一条会话连着跑两轮时，第二轮同样要接（running 一直是 true）
  }, [conversationId, running, requestId]);
}
