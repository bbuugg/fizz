/**
 * slice 的基础状态：稳定空值（渲染层共享的空数组/空对象，避免每次渲染换身份）、切片淘汰上限，
 * 以及「这一轮里哪条才是 live 助手消息」这个纯判定。不碰 store，也不碰网络。
 */
import type {
  AgentChatMessage,
  AgentConfirmRequest,
  AskFollowupRequest,
} from "@fizz/contracts/agent-api";
import type { QueuedMessage } from "@fizz/contracts/types";
import type { ConvSlice, ScopedSettings } from "./types";

/**
 * 这一轮的 live 助手消息：原占位本身，或运行中插话拆分出的后继
 * （`assistantSliceId(assistantId, 插话消息 id)`，形状见 contracts）。数组顺序即插入顺序，
 * **倒序找第一条**就是 live —— 插话之后到达的增量要写进后继那条（正文才不会跑到插话上面去）。
 */
export function isSteerAssistant(m: AgentChatMessage, assistantId: string): boolean {
  return (
    m.role === "assistant" &&
    (m.id === assistantId || m.id.startsWith(`${assistantId}-s`))
  );
}

export const emptySlice = (): ConvSlice => ({
  messages: [],
  compaction: null,
  streaming: false,
  replaying: false,
  request: null,
  pendingConfirms: [],
  followupRequests: {},
  queuedMessages: [],
  loading: false,
  deleting: false,
  error: null,
  queuePausedReason: null,
  // 新 slice 一律「未暂停」；真正打开会话时由 loadConversation 从 localStorage 覆盖
  queuePaused: false,
  pendingSteers: [],
  retryNotice: null,
  reconnectNotice: null,
  contextNotice: null,
  contextCompressing: false,
  droppedRound: null,
  loadGen: 0,
  scrollResetSeq: 0,
  liveTps: null,
  touchedAt: Date.now(),
  collab: null,
});

/**
 * 草稿页（「开始新对话」）的空白现场：还没选模型 / 没选 MCP / 没设浏览器偏好。
 *
 * 只在两处用：store 的初值、`clearAllLocalState`（登出 / 断线清一切本地现场）。
 * 打开草稿页时由 `openConversation(null)` 按「上次用过的模型」重新铺一遍。
 */
export const emptyDraftSettings = (): ScopedSettings => ({
  chatTarget: null,
  reasoningEffort: null,
  mcpServerIds: [],
  browserSettings: null,
});

/** slice 淘汰上限：在跑的必留，其余按 touchedAt 留最新的这几个 */
export const SLICE_KEEP = 8;

// 渲染层的稳定空值：slice 不存在时派生字段返回它们，避免每次渲染新数组身份
export const NO_MESSAGES: AgentChatMessage[] = [];
export const NO_CONFIRMS: AgentConfirmRequest[] = [];
export const NO_QUEUE: QueuedMessage[] = [];
export const NO_STEERS: AgentChatMessage[] = [];
export const NO_FOLLOWUPS: Record<string, AskFollowupRequest> = {};
