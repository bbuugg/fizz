/**
 * 对话 slice 的类型真源：每会话的「对话现场」（`ConvSlice`）、协作现场、草稿 ACP 档位，
 * 以及整块 `ConversationSlice`（store 上暴露的字段与方法签名）。纯类型，运行时零成本。
 */
import type {
  AgentBackend,
  AgentChatMessage,
  AgentConfirmRequest,
  AgentConversation,
  AiPermissionMode,
  AiReasoningEffort,
  AskFollowupRequest,
  ChatStreamFrame,
  UploadFileRef,
} from "@fizz/contracts/agent-api";
import type {
  AcpModesState,
  AcpPermissionMode,
  AcpThoughtLevelState,
  AgentMessagePart,
  AskFollowupAnswer,
  CollabSettings,
  CollabState,
  QueuedMessage,
} from "@fizz/contracts/types";
import { type BrowserSettings } from "@fizz/contracts";

export type { QueuedMessage };

/**
 * 一轮要用哪个模型 / 后端。`configId` = 内置模型配置 id 或 ACP agent id。
 *
 * 单独提出来是因为它有两个消费方：`ConversationSlice.chatTarget`（单份现场）与
 * `ScopedSettings`（按会话派生）。两处形状必须完全一致，否则 composer 的 pill
 * 在「焦点标签」与「非焦点标签」之间会显示成两种东西。
 */
export type ChatTarget = {
  backend: AgentBackend;
  configId?: string;
  /** 内置 下：这份配置里具体用哪个上游模型（`AiModelConfig.models` 的一项） */
  modelId?: string;
};

/**
 * 某个会话「自己的现场」：模型 / 思考强度 / MCP / 浏览器偏好。
 *
 * ⚠️ 它**不是 store 上的一块状态**，而是从会话清单里那条**当场派生**的视图
 * （`scopedSettingsOf`）：`persist*` 一律「先乐观改清单项、再发请求」，所以「刚改完
 * 还没发出去」的中间态本来就在清单里，派生出来就是最新的。
 *
 * 视图层一律走 `scopedSettingsOf(conversationId)`：分屏时两个标签各取各的，谁也不会
 * 因为「谁是焦点」看到对方的值。
 */
export interface ScopedSettings {
  chatTarget: ChatTarget | null;
  reasoningEffort: AiReasoningEffort | null;
  mcpServerIds: string[];
  /** 会话没设过时是 `null`（界面按常量默认 `DEFAULT_BROWSER_SETTINGS` 显示：关），与字段本身语义一致 */
  browserSettings: BrowserSettings | null;
}

// ---------------------------------------------------------------------------
// 每会话一份的「对话现场」（slice）
// ---------------------------------------------------------------------------

/**
 * 上下文交接文档的展示态。
 *
 * `streaming` 由 `context-compaction-start` / `-delta` 驱动；`done` 由
 * `context-compressed` 驱动，并用服务端终稿覆盖增量拼接结果（文件清单是流式结束后补的）。
 * 中途失败 / 中止不会有 `context-compressed`，`end` 帧会把仍在 streaming 的那份丢掉。
 */
export interface ContextCompactionState {
  status: "streaming" | "done";
  text: string;
  /** 正在生成哪一段（切回合时先是 checkpoint，再是 turn-prefix） */
  phase: "checkpoint" | "turn-prefix" | null;
  beforeTokens?: number;
  afterTokens?: number;
  summarizedTurns?: number;
  keptTurns?: number;
  /**
   * 把交接文档渲染成哪条助手消息里的一个折叠块（与思考 part 同形态）。
   * 缺省 = 找不到落点（理论上不会发生），此时不渲染。
   */
  messageId?: string;
  /** 插在该消息第几个 part 之后；0 = 消息最前面。 */
  afterPartIndex?: number;
  updatedAt: number;
}

/**
 * 一个会话的**全部本地对话现场**。
 *
 * 以前这些全是全局单份（消息列表 / streaming / 当前轮 / 审批卡 / 提问表 / 队列 /
 * 装载标记 / 加载代次），隐含「一个标签页同一时刻只盯一轮」的假设：切走会话时
 * 消息列表被清空，在途 SSE 帧写到找不到的占位消息上被**静默丢弃**，切回来既没有
 * 半截现场、也不重新接回 —— 看起来像「断开了」。现在每个会话各留一份：切走时
 * 帧继续落在它自己的 slice 上，切回来就是最新直播；A 后台跑、B 发消息互不打架，
 * 停止钮 / 审批卡 / 队列都各归各的会话。
 *
 * 内存有界：淘汰策略见 `pruneSlices`（保留在跑的 + 最近看过的几个，其余现场丢弃
 * —— 历史真源在服务端，重新打开走装载链路再拉一遍）。
 */
export interface ConvSlice {
  messages: AgentChatMessage[];
  /**
   * 最近一次上下文交接文档（流式生成中 / 已完成）。
   *
   * 只用于展示，不参与消息落盘；检查点仍以服务端 `contextSummary` / `autoSummary` 为准。
   * `status === 'streaming'` 时 `text` 是已生成的增量，`'done'` 时是服务端给的终稿。
   */
  compaction: ContextCompactionState | null;
  /** 这个会话正在流式（本地订着一轮，帧在往 `messages` 里追加） */
  streaming: boolean;
  /**
   * 正在**回放现场**：断线重连后，服务端从帧日志头部把这一轮重放一遍，客户端先把
   * 这一轮的 parts 清空再逐帧重建（见 `attachRun` 的重接循环）。
   *
   * 只在重连时短暂为真，`replay-end` 帧（服务端在回放末尾补的那条，见 contracts 的
   * `ChatStreamFrameType`）到达即撤。
   *
   * 它存在的唯一理由：回放期间内容高度**先塌后长**，而 `streaming` 为真时滚动跟随走
   * 的是库的 spring 平滑动画 —— 于是用户看到「消息列表像在重新加载，一直从顶部往下滚」
   * （实测反馈）。`MessageList` 用它把回放期间的跟随降级成瞬时贴底。
   */
  replaying: boolean;
  /**
   * 这一会话当前轮的 requestId / controller / 占位助手消息 id（停止钮用；null = 没有在跑的轮）。
   *
   * `assistantId` 是**断线重接**的关键：连接断了之后要接着往同一条占位消息上回放，
   * 没有它就分不清哪条是「这一轮的占位」，只能再 push 一条空的。
   */
  request: {
    id: string;
    controller: AbortController;
    assistantId: string;
  } | null;
  /** confirm 模式下等用户答复的审批（按到达顺序；同一时刻服务端只放一条） */
  pendingConfirms: AgentConfirmRequest[];
  /** 在等的 ask_followup_question 提问（按 toolCallId 索引，供工具卡片渲染提问表单） */
  followupRequests: Record<string, AskFollowupRequest>;
  /** 待发送队列：会话进行中用户继续发消息时先排这里，本轮结束依次执行 */
  queuedMessages: QueuedMessage[];
  /**
   * 已插入、还没生效的插话（steer）：POST 成功即入列，agent 在边界消费时随
   * `user-injected` 事件出列（转入会话流）。用户可在此撤回（DELETE steer）。
   * 只在**发送方**这个端有 —— 收件箱是 run 内存态，别的端要等消费事件才看得到。
   */
  pendingSteers: AgentChatMessage[];
  /**
   * 队列链为什么停了：上一轮**失败**时不自动发下一条（防坏配置把整个队列烧完），
   * 这里记 `'failed'`，队列头部据此显示「上轮失败，队列已暂停」+ 一键继续 / 清空。
   * 成功开轮、手动发队列、清空队列时复位为 null。null = 没有暂停。
   */
  queuePausedReason: "failed" | null;
  /** 历史装载中（打开会话后拉存档 / acp 回放的窗口）：消息区此时显示装载中而不是旧列表 */
  loading: boolean;
  /**
   * 正在删消息（「仅本条」/「本条及其后」/ 编辑重发里的那一步）。
   *
   * 消息区据此挂「正在删除…」的提示并暂时不收点击：删除要动服务端消息、随后整体回拉
   * 历史，中途再叠一次编辑 / 删除，两边的回拉会互相盖。用户报过「删的时候什么都没有、
   * 还能继续点别的消息」。
   */
  deleting: boolean;
  /** 历史装载失败（内置 拉存档 / acp session/load 回放）：由消息列表展示错误 + 重试 */
  error: string | null;
  /**
   * 模型请求正在重试：显示「第 N 次重试」的**单条**提示（每次重试自替换，屏幕上只留最新一条）。
   * null = 当前没在重试。属于「通知」不是消息 part（不落盘，见 handleFrame）。
   */
  retryNotice: {
    attempt: number;
    maxRetries: number | null;
    /** `true` = 断点续跑（已渲染的内容没被清空，只回滚了失败那一步） */
    resume?: boolean;
    /**
     * 这次尝试失败的**原因原文**（服务端 `retry.message`）。有它就一并显示在次数后面 ——
     * 「第 2 次重试 · AI_APICallError: concurrency reached…」比光一个次数信息量大得多：
     * 用户能立刻判断是被上游限流（该降并发）还是断网（等着就行）。
     * 缺省 = 服务端没给原因，提示里只显示次数。
     */
    message?: string;
  } | null;
  /**
   * 连接断了但服务端那轮还在跑：正在自动重接（第几次）。null = 连接正常 / 没在重接。
   * 属于「通知」不是消息 part（不落盘，见 `attachRun` 的断线重接循环）。
   */
  reconnectNotice: { attempt: number } | null;
  /**
   * 最近一次上下文压缩的通知（圆环上的展开详情 + 8 秒自动消失的提示条）。
   *
   * **每会话一份**：分屏时 A 标签这一轮压缩了上下文，B 标签不该跟着闪「上下文已压缩」。
   * 以前它是 store 上的全局字段（`CoreSlice.contextNotice`）—— 那是「焦点会话的现场」
   * 冒充全局的最后一处，与模型 pill 那个 bug 同一个根因。
   */
  contextNotice: ContextNotice | null;
  /** 手动压缩进行中（本会话）：输入框禁发、圆环转圈 */
  contextCompressing: boolean;
  /**
   * 有一轮在客户端看是「断线失败」的，但服务端很可能在断线期间把它跑完并落盘了
   * （run 的生命周期不挂在客户端连接上）。这里记下 `baseCount` = **这一轮开跑前**
   * 本地有多少条消息，作为对账基准：之后拉服务端权威历史，比它长且末位是助手消息
   * 就说明这一轮真落盘了，用权威历史盖掉本地那条「网络错误」。
   *
   * 场景：手机息屏 / 电脑休眠，SSE 在睡梦里断了，醒来时那一轮早就跑完 —— 服务端
   * 有完整回复，客户端却只能显示网络错误。以前必须刷新页面才看得到内容。
   * null = 没有待对账的断线轮次。
   */
  droppedRound: { baseCount: number } | null;
  /**
   * 消息加载的代次。`runRound` 开跑会 +1：作废在途的 `loadMessages`，防止
   * 「上一轮收流后的权威快照」把**下一轮刚开始的本地消息**盖掉。
   */
  loadGen: number;
  /**
   * 「切换会话 / 消息装载完成」的信号：自增时 ChatPanel 让消息区**同帧同步**落底
   * （见 ai-elements/conversation.tsx 的 resetKey）。流式追加、每轮结束后的历史
   * 刷新都不碰它，免得把正在翻历史的用户拽到底部。
   */
  scrollResetSeq: number;
  /** 最近一次被打开 / 触碰的时刻（淘汰排序用） */
  touchedAt: number;
  /** 协作运行态（仅 collab 会话；任务 / 消息 / 状态 + 实时增量） */
  collab: CollabClientState | null;
}

/** 协作会话在客户端的现场：服务端快照 + 尚未收敛的流式文本 */
export interface CollabClientState {
  state: CollabState;
  /** agentId → 正在流式输出的文本（收到任务结果后清空） */
  liveText: Record<string, string>;
  /**
   * agentId → 运行中的**过程记录**（正文 / 思考 / 工具调用，与 `CollabTask.parts` 同构）。
   *
   * 服务端的 `parts` 要等任务收口才写进快照；在那之前右侧对话区就靠这份现场，
   * 让工具卡边跑边出现（不然只有流式正文，跑完才「啪」地补出全部卡片）。
   * 任务到终态时清空，交给快照里的 `parts`。
   */
  liveParts: Record<string, AgentMessagePart[]>;
}

/**
 * 最近一次上下文压缩的通知（只有摘要一种 —— 清旧工具结果那一层已删除）。
 *
 * 形状与 SSE 帧 `context-compressed` 一一对应；住在 `ConvSlice`（每会话一份），
 * 视图层通过 `app.contextNotice` 读自己那条。
 */
export interface ContextNotice {
  /** 整段上下文的压前 / 压后 token */
  beforeTokens: number;
  afterTokens: number;
  at: number;
  /** 摘要了多少轮 / 保留了多少轮原文 */
  summarizedTurns?: number;
  keptTurns?: number;
}

/**
 * 「开始新对话」页选中的 ACP agent 的档位快照（还没建会话，见 `ConversationSlice.draftAcp`）。
 *
 * 生命周期：选中 agent → `probeDraftAcp` 拿候选档位 → 用户挑 → 发送时建会话 →
 * 把 `mode` / `thought` 下发给这个会话 → 清空。
 */
export interface DraftAcpState {
  agentId: string;
  /** 探针在跑（pill 上转圈） */
  loading: boolean;
  /** 探针失败的原因（agent 起不来 / 超时）；pill 退化成「默认档」 */
  error: string | null;
  /** agent 广告的 Session Modes；没广告则 null */
  modes: AcpModesState | null;
  /** agent 广告的思考档；没广告则 null */
  thoughtLevel: AcpThoughtLevelState | null;
  /** 用户选中的模式 id；null = 跟随 agent 默认 */
  mode: string | null;
  /** 用户选中的思考档；null = 跟随 agent 默认 */
  thought: string | null;
}

export interface ConversationSlice {
  // ---------- 状态 ----------
  slices: Record<string, ConvSlice>;
  activeWorkspaceId: string | null;
  activeConversationId: string | null;
  /**
   * 「开始新对话」页那一份**待定选择**（模型 / 思考强度 / MCP / 浏览器偏好）。
   *
   * 草稿页还没有会话，这四项只活在内存里；发出第一条消息时 `newConversation` 把它们
   * 随会话一起落库、并并进会话清单项，之后每次读取都从清单派生（见 `scopedSettingsOf`），
   * 这份草稿不再参与。
   *
   * ⚠️ 这**不是**「焦点会话的现场」。历史上这四项是 store 上的四个裸字段，语义就是
   * 「焦点会话的现场」—— `openConversation` 每开一个会话都按那个会话重写一遍。单标签
   * 时看不出问题（焦点即视图），分屏时就一起变：点一下标签，两个 composer 的模型 pill、
   * MCP、浏览器开关跟着同步（用户报过）。现在会话的现场只有一份真源（会话清单项），
   * 全局只留草稿页这一份 —— 读到它时请明确「这是草稿」。
   */
  draftSettings: ScopedSettings;
  /**
   * 「开始新对话」页选中的 ACP agent 的**档位快照**（还没有会话，所以不能挂在会话上）。
   *
   * 为什么需要：ACP 的模式 / 思考档是 agent 在 `session/new` 应答里广告的，平时存在
   * `conversation.acpModes` / `acpThoughtLevel` 上 —— 新任务页没有会话，那排 pill 就没数据。
   * 选中 agent 时先探一次（`probeAcpCapabilities`，一次性会话、问完收掉），候选档位与用户的
   * 选择临时放这里；会话建好后立刻把选中的档位下发（`setAcpAgentMode` / `setAcpThoughtLevel`），
   * 然后清空。`null` = 当前没选 ACP。
   */
  draftAcp: DraftAcpState | null;
  /** 正在跑一轮对话的会话 id 集合（侧栏转圈按会话跟踪；与当前打开哪个无关） */
  runningConversations: Record<string, true>;
  /**
   * 「用户明确要空态」的标记：`openConversation(null)`（点「新建会话」、删掉当前会话后
   * 落空态）置位，打开具体会话时清掉。
   *
   * 「恢复会话」的 effect 只看 `activeConversationId` 是不是空的 —— 跨工作区点
   * 「新建会话」时它正好是空的（刚清），effect 立刻按兜底逻辑把该工作区**最新一条会话**
   * 打开，表现出来就是「点新建会话却进了某个旧会话」。用它把「用户主动要空态」和
   * 「还没恢复过」区分开。
   */
  blankIntent: boolean;
  /** 切换命令执行权限（存本地；下一轮生效） */
  permissionMode: AiPermissionMode;
  /** confirm 审批超时（分钟；0 = 不超时）。随每轮请求带给服务端 */
  confirmTimeoutMin: number;
  /** 模型请求自动重试次数（0 = 不限制）。随每轮请求带给服务端 */
  maxRetries: number;
  /** 同一批工具调用的并发上限（1 = 串行）。随每轮请求带给服务端 */
  toolCallConcurrency: number;
  /** 一轮最多跑多少步（工具轮）。随每轮请求带给服务端 */
  maxSteps: number;
  /**
   * 工具卡是否显示「意图」：模型每次调工具填一句「这一步要干什么」，卡片拿它当标题。
   *
   * 同时管两件事 —— 注入（随每轮请求带给服务端，决定要不要往工具 schema 塞 `intent`）
   * 与渲染（关掉后历史里的卡片也回到工具名）。随每轮请求带给服务端。
   */
  toolIntent: boolean;

  // ---------- slice 读写 ----------
  readSlice: (conversationId: string | null) => ConvSlice;
  writeSlice: (
    conversationId: string,
    patch: (s: ConvSlice) => ConvSlice,
  ) => void;
  dropSlice: (conversationId: string) => void;
  /** 现场淘汰：在跑的必留，其余按 touchedAt 留最新的 SLICE_KEEP 个 */
  pruneSlices: (keepId: string | null) => void;
  /** 断开连接 / 登出时清一切本地现场（slice + 队列持久化） */
  clearAllLocalState: () => void;

  // ---------- 会话 ----------
  markRunning: (conversationId: string, running: boolean) => void;
  persistTarget: (
    conversationId: string,
    target: {
      backend: AgentBackend;
      configId?: string;
      modelId?: string;
    } | null,
  ) => void;
  /**
   * 取某个会话「自己的现场」（模型 / 思考强度 / MCP / 浏览器偏好）。
   *
   * - `null`（新对话页）→ `draftSettings`（还没有会话，那份待定选择只活在内存里）；
   * - 会话 → 从**会话清单项**派生（`persist*` 先乐观改清单，中间态因此也读得到）；
   *   清单里还没有它（刚建出来、清单没刷到）时退回 `draftSettings` —— 那正是建它用的选择。
   *
   * 分屏时视图层必须走这里。别指望有一份「当前会话的现场」可读：那样的字段已经不存在了。
   */
  scopedSettingsOf: (conversationId: string | null) => ScopedSettings;
  /**
   * 切换本轮的模型 / 后端。
   *
   * `scope`（第三个「作用域」参数全 store 统一）：
   * - 不传 = 旧行为，作用于 `activeConversationId`，没有会话就写草稿态；
   * - `null` = 明确「新对话页」，只写 `draftSettings`，不落任何会话；
   * - 会话 id = 作用于**那个会话**（乐观改写它的清单项 + 落盘）。
   *
   * 没有 `scope` 的话，分屏里在 B 标签选模型会把 A（焦点）会话的待发目标一起改掉。
   */
  setChatTarget: (target: ChatTarget | null, scope?: string | null) => void;
  /**
   * 改这个会话的思考强度（`null` = 跟随模型默认）；新任务页 = 待定选择。
   * `scope` 语义同 `setChatTarget`。
   */
  setReasoningEffort: (
    effort: AiReasoningEffort | null,
    scope?: string | null,
  ) => void;
  /**
   * 新任务页选中 ACP agent 时探一次它的档位（模式 / 思考档）。
   *
   * 幂等：同一个 agent 已经探过（成功或失败）就直接返回，别每次点下拉都起一个进程。
   * 探针失败只写 `error`，不抛 —— 页面上退化成「默认档」，不挡用户发送。
   */
  probeDraftAcp: (agentId: string) => Promise<void>;
  /** 新任务页选模式（null = 跟随 agent 默认）；没有 draftAcp 时忽略 */
  setDraftAcpMode: (modeId: string | null) => void;
  /** 新任务页选思考档（null = 跟随 agent 默认）；没有 draftAcp 时忽略 */
  setDraftAcpThought: (value: string | null) => void;
  /** 清掉草稿态（切回内置 agent / 建完会话后调） */
  clearDraftAcp: () => void;
  /**
   * 设置允许使用的 MCP server 清单（全量覆盖，空 = 全不选）。
   * 有会话立刻持久化；没有（新任务页）则写进 `draftSettings`，随会话创建落库。
   * `scope` 语义同 `setChatTarget`。
   */
  setMcpServerIds: (ids: string[], scope?: string | null) => void;
  /**
   * 设置**某个会话**的浏览器偏好（总开关 / 来源）。传入的是**部分字段**，与该会话
   * 当前值合并后整体落库（服务端的 target 契约是整体对象语义）。
   * 有会话立刻持久化；没有（新任务页）则写进 `draftSettings`，随会话创建落库。
   * `scope` 语义同 `setChatTarget`。
   */
  setBrowserSettings: (
    patch: Partial<BrowserSettings>,
    scope?: string | null,
  ) => void;
  setPermissionMode: (mode: AiPermissionMode, scope?: string | null) => void;
  /**
   * 设置**某条 ACP 会话**的权限答复策略（`confirm` = 逐次问；`allow` = 应用层自动放行）。
   * 按会话持久化到 `config.json`；没有会话时什么都不做（新任务页没有会话可绑）。
   * `scope` 语义同 `setChatTarget`。
   */
  setAcpPermissionMode: (mode: AcpPermissionMode, scope?: string | null) => void;
  setConfirmTimeoutMin: (minutes: number) => void;
  setMaxRetries: (value: number) => void;
  setToolCallConcurrency: (value: number) => void;
  setMaxSteps: (value: number) => void;
  /** 工具卡是否显示「意图」（同时决定要不要让模型填） */
  setToolIntent: (value: boolean) => void;
  loadMessages: (
    conversationId: string,
    opts?: { loadError?: boolean },
  ) => Promise<AgentConversation | null>;
  handleFrame: (
    conversationId: string,
    assistantId: string,
    frame: ChatStreamFrame,
  ) => void;
  /**
   * 记一条「这一轮的上下文被压过了」的提示（8 秒后自动消失，见 `actions/context.ts`）。
   * `scope` 语义同 `setChatTarget`：分屏时只落在触发压缩的那个标签上。
   */
  setContextNotice: (notice: ContextNotice | null, scope?: string | null) => void;
  /**
   * 手动压缩**某条会话**的上下文：服务端摘要落检查点（原始消息不动）。
   *
   * `scope` 语义同 `setChatTarget`；不传 = 活跃会话（旧行为）。
   * 成功后顺手更新本地会话的 contextSummary（WS 全量推送还没到，先自己改，体验即时）。
   * 返回给调用方（popover）决定 toast 什么。
   */
  compressContextNow: (
    scope?: string | null,
  ) => Promise<{ ok: boolean; reason?: string }>;
  /** 覆盖协作配置（增删改 Agent / 并行与单轮运行上限）；成功后就地更新会话清单里的那份 */
  saveCollabSettings: (
    settings: CollabSettings,
    scope?: string | null,
  ) => Promise<boolean>;
  /** 取消**某条协作会话**里某个正在跑的子任务 */
  cancelCollabTask: (
    taskId: string,
    scope?: string | null,
  ) => Promise<boolean>;
  attachRun: (conversationId: string) => Promise<boolean>;
  /**
   * 重接一条进行中的对话：用户点消息区「连接中断」条上的按钮、或页面从后台回来时调。
   * 内部就是 attachRun —— 查服务端有没有在跑的 run、复用现有占位消息、断线自动重接。
   */
  reconnectRun: (conversationId: string) => Promise<boolean>;
  /**
   * 对账一个「断线失败」的轮次：拉服务端权威历史，它确实存下了这一轮就用它替换本地
   * 那条网络错误（页面回前台 / 网络恢复时调）。返回 true = 换回来了。
   */
  reconcileDroppedRun: (conversationId: string) => Promise<boolean>;
  loadConversation: (conversationId: string) => Promise<void>;
  /**
   * 把「当前会话」切到这条（顺带补装载 / 后台刷历史 / 泵队列）。
   *
   * `opts.keepScroll`：**不要**复位消息区的滚动位置。给「切标签」用 —— 那条会话的面板
   * 从来没卸载过（后台标签只是 `hidden`），用户翻到哪儿就该留在哪儿；而「从侧栏 / 通知 /
   * 深链打开一条会话」是明确的「我要看最新的」，照旧复位落底。
   */
  openConversation: (
    conversationId: string | null,
    opts?: { keepScroll?: boolean },
  ) => void;
  retryLoadMessages: () => void;
  /**
   * 重新加载一条 ACP 会话：**当场**再走一次 `session/load`，用 agent 侧回放**整体重建**
   * 本地消息列表。
   *
   * 与「重启会话」（`restartAcpSession`）的分工：重启只杀 agent 进程、视图一动不动，
   * 重连发生在下一条消息里（用途是让 agent 侧启动期读的配置生效）；本项是**把视图拉回来
   * 对齐** —— agent 侧会话在别处被改过、打开时回放只回来半截、视图与 agent 侧对不上时用它。
   *
   * 服务端**不需要新路由**：直接复用 `GET /api/acp/agents/:id/transcript` —— 那条路由
   * 就是 `session/load` 回放（内部先 teardown 旧进程，保证从干净进程 load）。
   *
   * 成功 `true`；缺 agent 侧会话 / 找不到工作区目录 / 回放失败 `false`（原因进 `error`）。
   */
  reloadAcpSession: (conversationId: string) => Promise<boolean>;
  /**
   * **重新加载这一条会话**（等价于「刷新页面 → 点开它」，只作用于它）。
   *
   * 两个入口都用它：消息里那条「⚠️ …」错误块下面的「重新加载」按钮，以及主区域标签
   * 右键菜单的「刷新」（对话标签走这条路，工具标签才走 `tab-reload` 的卸载重挂）。
   *
   * 内置 走服务端权威历史覆盖、ACP 走 `session/load` 回放（与刷新页面后打开同源）；
   * **正在生成时直接返回 `false`**（不做事），避免把流式现场盖掉。
   * 成功 `true`；失败 `false`（原因进 `error`，界面自己显示）。
   */
  reloadConversation: (conversationId: string) => Promise<boolean>;
  /**
   * 选中项目。`null` = **不选项目**（输入框下方那颗「未指定工作区」）—— 那只是界面上的
   * 临时状态，发送时服务端会给会话建一个临时工作区并绑上去（见 `newConversation`）。
   */
  selectWorkspace: (workspaceId: string | null, openNewest?: boolean) => void;
  /**
   * 建一条会话，返回新会话 id（失败 `null`，原因进 `error`）。
   *
   * `done` 是调用方给的「这次创建已经收尾」回调：**成功、失败都会调一次**，参数是
   * 新会话 id（失败为 `null`）。异步建会话的入口（`runRound` 的「发送即建会话」）靠它
   * 收掉「正在创建」的转圈 —— 从按键到会话真正可用的那段空窗，ACP 要起外部 agent
   * 进程 + `session/new`，几百毫秒到几秒，比内置模型那次往返明显得多。
   *
   * ⚠️ 在 `runRound` 里不要用 `await` 包着这份 Promise 去收尾：那要等整条建会话链路
   * 走完，而转圈的作用是「告诉用户点了有用」，越早熄越好。
   */
  newConversation: (
    workspaceId?: string,
    title?: string,
    target?: {
      backend: AgentBackend;
      configId?: string;
      modelId?: string;
      acpSessionId?: string;
      mcpServerIds?: string[];
      /** 多智能体协作：创建时一并落配置 */
      kind?: "collab";
      collab?: CollabSettings;
    },
    done?: (conversationId: string | null) => void,
  ) => Promise<string | null>;
  /**
   * 建一条「多智能体协作」会话（侧栏「多智能体协作」入口）：**不弹窗、不选模型**。
   *
   * 默认班子取 `defaultCollabSettings()`；主模型优先沿用上次发送用的内置模型
   * （`preferredTarget`），没有就留空 —— 用户在建好的会话里选，与空白页同一条规矩
   * （不替用户挑一个没选过的模型）。建好后由调用方的 `openConversation` 打开标签。
   */
  newCollabConversation: (workspaceId?: string) => Promise<string | null>;
  deleteConversation: (
    id: string,
  ) => Promise<{ ok: boolean; nextId: string | null }>;
  clearConversation: (id: string) => Promise<void>;
  /** 只删某一条消息（后面的消息保留）。`scope` 语义同 `setChatTarget` */
  deleteMessage: (messageId: string, scope?: string | null) => Promise<void>;
  deleteMessagesFrom: (
    messageId: string,
    scope?: string | null,
  ) => Promise<void>;
  /** 编辑并重发：先删掉该条及其后的消息，再当新消息发出去（返回值同 `send`） */
  resendMessage: (
    messageId: string,
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
    scope?: string | null,
  ) => Promise<boolean>;

  // ---------- 发一轮 ----------
  /**
   * 塞进某会话的待发送队列。`scope` 语义同 `setChatTarget`（分屏下必须指明是哪个
   * 会话的 composer 在排队，否则会排到焦点会话上）。
   */
  enqueueMessage: (
    text: string,
    files?: UploadFileRef[],
    scope?: string | null,
  ) => void;
  removeQueuedMessage: (id: string, scope?: string | null) => void;
  updateQueuedMessage: (
    id: string,
    text: string,
    scope?: string | null,
  ) => void;
  /** 拖拽排序：把 `id` 这一条挪到 `beforeId` 前面（`beforeId` 为空 = 挪到最后） */
  moveQueuedMessage: (
    id: string,
    beforeId: string | null,
    scope?: string | null,
  ) => void;
  /** ↑↓ 按钮微调：`id` 这一条在队列里相对挪 `delta` 位（-1 = 更早发出） */
  moveQueuedMessageBy: (id: string, delta: number, scope?: string | null) => void;
  /**
   * 发送队列里的一条（行上的 ➤）：**本轮在跑 = 插话**（递服务端收件箱，下一个工具
   * 步骤边界停下当前步骤后生效，成功后才移出队列）；没在跑 = 直接开新一轮。
   *
   * 返 `true` = 已提交（入了收件箱或开了新一轮）；`false` = 被拦下（没连上 / 服务端
   * 不接受），条目留在队列里，行上的转圈随之收掉。
   */
  sendQueuedMessage: (id: string, scope?: string | null) => Promise<boolean>;
  /** 清空待发送队列（含解除失败暂停标记） */
  clearQueuedMessages: (scope?: string | null) => void;
  /**
   * 会话分叉：fork **`scope` 那条会话**（不传 = 活跃会话）到某条消息（含），刷新列表并
   * 切到新会话。分屏时从非焦点标签点「从此签出」必须带上它，否则分叉的是焦点会话。
   * `opts.worktreeIdentifier` 给了就先在会话所属项目下建 worktree（标识即目录名
   * `<项目>/.worktree/<标识>`，也是新分支名的一部分），再把分叉挂到新工作区上。
   */
  forkConversation: (
    upToMessageId: string,
    opts?: { worktreeIdentifier?: string; worktreeName?: string },
    scope?: string | null,
  ) => Promise<void>;
  /**
   * 把一条 ACP 会话的内容转成**内置 agent 会话**：现拉 agent 侧转录 → 洗成内置格式 →
   * 新建一条 内置会话（同工作区、带历史）→ 刷新列表并切过去。
   * 成功 `true`；拉不到转录 / 建会话失败 `false`（原因进 error）。
   *
   * `upToMessageId` 传了 = **「从某条消息起转为内置」**：历史只保留到该条（含）为止
   * （对应每条消息下方那颗按钮）；不传 = 整条会话全量转换（侧栏那一项）。
   *
   * `opts.worktreeIdentifier` 给了就先在**源会话所属**项目下建 worktree，再把新会话挂进
   * 那个新工作区（与 `forkConversation` 同款）；不给则与原会话同工作区。
   */
  convertAcpConversation: (
    conversationId: string,
    upToMessageId?: string,
    opts?: { worktreeIdentifier?: string; worktreeName?: string },
  ) => Promise<boolean>;
  /**
   * 队列泵：把**`scope` 那条会话**（不传 = 活跃会话）队列里的下一条顶上来开跑。
   * 分屏时非焦点标签上的「继续发送」必须带上它。
   */
  pump: (scope?: string | null) => void;
  /**
   * 真正发起一轮（`true` = 确实开跑了；`false` = 没连上 / 没选模型 / 建会话失败被拦下）。
   * `onStarted` 见 `send` 的说明 —— 由它一路透传进来。
   */
  runRound: (
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
    /** 发到哪条会话（`null` = 新对话页 → 建新会话）。语义同 `send` 的 `scope` */
    scope?: string | null,
  ) => Promise<boolean>;
  /**
   * 带附件时允许空正文（files 非空即可发）；流式中 → 入队，本轮结束由泵自动发出。
   *
   * 返回 `true` = 这一轮**真的开跑了**（或已入队），`false` = 被本地守卫拦下、什么都没发。
   * 调用方（输入框）据此把草稿放回去 —— 拦下时本来就弹了错误提示，再把用户写的内容
   * 吃掉就更没道理了。
   *
   * `onStarted` 在「确认要发」的那一刻（乐观消息已落本地）回调一次：**草稿区里那些
   * 一次性资源（附件、引用）应该在这里才清**，而不是在提交那一刻 —— 提交时就清等于
   * 赌这一轮一定发得出去，赌输了用户连附件都得重新传一遍。
   */
  send: (
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
    /**
     * 发到哪个会话。语义与 `setChatTarget` 的 `scope` 一致，但这里 `null` 表示
     * **明确没有会话**（新对话页的 composer → 建一个新会话），不会回落焦点会话。
     *
     * 分屏下这是必须的：两个标签同时可见，用户在非焦点标签里发消息不能发到焦点会话上。
     */
    scope?: string | null,
  ) => Promise<boolean>;
  /**
   * 运行中插话：活跃会话在跑 → 递服务端收件箱（agent 下一个工具步骤边界注入）；
   * 409 / 没在跑 → 回落普通发送。只有 内置会话支持（ACP 会话上服务端 400，
   * 这里把可用性判断留给命令面板的 `available`）。
   *
   * `files` 与 `text` 至少要有一个；附件随插话一起注入当前轮（回落普通发送时也带着）。
   */
  steer: (
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
    scope?: string | null,
  ) => Promise<boolean>;
  /** 撤回一条还没生效的插话（removed=false = 已消费；本地照移，等 user-injected 对账） */
  removeSteer: (messageId: string, scope?: string | null) => Promise<void>;
  /**
   * 重排插话（拖拽：把 `messageId` 挪到 `beforeId` 前面；`beforeId` 为空 = 挪到最后）。
   * 与队列的 `moveQueuedMessage` 同一套语义：本地立即生效（拖拽要跟手），
   * 服务端是**尽力而为**的补写。
   */
  moveSteer: (
    messageId: string,
    beforeId: string | null,
    scope?: string | null,
  ) => void;
  /** ↑↓ 按钮微调：`messageId` 这条相对挪 `delta` 位（-1 = 更早生效） */
  moveSteerBy: (
    messageId: string,
    delta: number,
    scope?: string | null,
  ) => void;
  /**
   * 立刻把一条还没发出去的插话发出去（行的 ➤）：与队列的 `sendQueuedMessage` 同款。
   *
   * 用户停止一轮（abort）后插话已经被服务端丢弃、这一轮也不在了，所以这里是
   * **以新一轮的普通消息发出去**（文本 + 附件一起）。会话进行中忽略（跑着时那颗钮禁用）。
   */
  sendSteer: (messageId: string, scope?: string | null) => void;
  /** 停当前会话这一轮（`scope` 语义同 `setChatTarget`；分屏时传本标签的会话） */
  stop: (scope?: string | null) => Promise<void>;
  /**
   * 停止**指定会话**当前正在跑的那一轮（必传 id，不依赖「谁是当前会话」）。
   *
   * 与 `stop` 的分工：`stop` 收 `scope`（不传 = 活跃会话），用于「当前会话」的停止按钮；
   * 而批量关标签这类场景关掉的多半**不是**活动标签，那里必须用这个 id 版把 id 明确写出来。
   * 关标签守卫（`ConversationTab`）就是拿它先停会话再放行关闭。
   */
  stopConversation: (conversationId: string) => Promise<void>;
  /**
   * 只停这一条 execute_command（工具卡头部那颗停止钮，命令在执行时命中它）。
   * 拿当前会话在跑那轮的 requestId + 该命令的 toolCallId 打
   * `POST /api/chat/command/stop`；服务端杀进程树，工具结果收尾成「（已中止）」，
   * Agent 同一回合继续。**不动整轮**（那叫 `stop`）。
   */
  stopCommand: (toolCallId: string, scope?: string | null) => Promise<void>;

  // ---------- 审批 / 提问 ----------
  /**
   * `scope` 只用于「把审批卡从哪个会话的现场撤掉」——分屏时在非焦点标签点审批，
   * 卡片必须从那个会话消失，而不是从焦点会话消失。
   */
  resolveConfirm: (
    id: string,
    approved: boolean,
    optionId?: string,
    scope?: string | null,
  ) => Promise<void>;
  resolveFollowup: (
    toolCallId: string,
    answer: AskFollowupAnswer | null,
    scope?: string | null,
  ) => Promise<void>;
}
