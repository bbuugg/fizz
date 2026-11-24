/**
 * 对话相关的本地持久化：当前工作区 / 当前会话、审批超时、重试次数、并发度、步数上限，以及
 * 待发送队列的 localStorage 缓存。只做读写，不持有 store。
 *
 * 队列缓存不是「老实现遗留」：打开会话时要先拿它渲染（否则列表先闪一下空），服务端 / 网络
 * 不可用时也照旧能用，只是不跨端。
 */
import type { CommandSandboxMode, QueuedMessage } from "@fizz/contracts/types";
import {
  readPref,
  removePref,
  subscribePrefs,
  writePref,
} from "@fizz/agent-kit/shared/lib/prefs-sync";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_STEPS,
  DEFAULT_TOOL_CALL_CONCURRENCY,
  resolveMaxSteps,
  resolveToolCallConcurrency,
} from "@fizz/contracts/agent-api";

// ---------------------------------------------------------------------------
// 客户端偏好：直接落 localStorage（key 沿用旧 web-host 的，已存的设置不丢）
// ---------------------------------------------------------------------------

/** 上次打开的工作区 / 会话（启动恢复现场，会话自己记着选的模型） */
const ACTIVE_WORKSPACE_KEY = "fizz.web.activeWorkspaceId";
const ACTIVE_CONVERSATION_KEY = "fizz.web.activeConversationId";
/** confirm 审批超时（分钟）：默认 10，0 = 不超时 */
const CONFIRM_TIMEOUT_KEY = "fizz.web.confirmTimeout";

/**
 * SSR 上没有 localStorage：各 loader 返回兜底值（客户端行为不变）。
 *
 * 读写统一走 `prefs-sync`：写盘即广播（浏览器给**别的窗口**发 `storage` 事件），
 * 读侧只订阅一次就能覆盖所有偏好，不用每个 key 自己 `addEventListener`。
 */
function lsGet(key: string): string | null {
  return readPref(key);
}
export function lsSet(key: string, value: string): void {
  writePref(key, value);
}

export function loadActiveWorkspaceId(): string | null {
  return lsGet(ACTIVE_WORKSPACE_KEY) || null;
}
export function saveActiveWorkspaceId(id: string | null): void {
  lsSet(ACTIVE_WORKSPACE_KEY, id ?? "");
}
export function loadActiveConversationId(): string | null {
  return lsGet(ACTIVE_CONVERSATION_KEY) || null;
}
export function saveActiveConversationId(id: string | null): void {
  lsSet(ACTIVE_CONVERSATION_KEY, id ?? "");
}
/**
 * 抹掉这份记录（**连键一起移除**，不是写空串）。
 *
 * 与 `saveActiveConversationId(null)` 的区别正是 `loadBlankIntent()` 判的那条线：
 * 「从没选过」与「明确要空态」是两种不同的状态，登出清场要的是**前者**（下次登录照旧
 * 兜底到最新一条会话），所以这里不能只写空串。
 */
export function clearActiveConversationId(): void {
  removePref(ACTIVE_CONVERSATION_KEY);
}
/**
 * 「用户明确要空态」是否**已落盘**（键在、但为空串）。
 *
 * `saveActiveConversationId(null)` 写的是空串，而 `loadActiveConversationId()` 把空串也读成
 * `null` —— 于是「关掉了所有会话」与「从没选过」在它眼里一模一样。启动恢复必须分清这两者：
 * 前者**不能**再把会话拉回来（用户刚亲手把它们关掉），后者才该兜底到该工作区最新一条。
 * 所以这里直接看**键在不在**：键在且为空 = 明确要空态。
 *
 * 为什么不能只靠 store 里的 `blankIntent`：那个是内存态，刷新即丢，而用户关掉所有会话之后
 * 往往紧接着就是刷新页面 —— 正是它护不住的那一刻。
 */
export function loadBlankIntent(): boolean {
  return lsGet(ACTIVE_CONVERSATION_KEY) === "";
}

/** 审批超时（分钟）：默认 10，0 = 不超时；存坏了回落默认 */
export function loadConfirmTimeout(): number {
  const raw = lsGet(CONFIRM_TIMEOUT_KEY);
  if (raw === null) return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 10;
}
export function saveConfirmTimeout(minutes: number): void {
  lsSet(CONFIRM_TIMEOUT_KEY, String(minutes));
}

/** 模型请求自动重试次数（0 = 不限制）：默认 2；存坏了 / 非法回落默认 */
const MAX_RETRIES_KEY = "fizz.web.maxRetries";
export function loadMaxRetries(): number {
  const raw = lsGet(MAX_RETRIES_KEY);
  if (raw === null) return DEFAULT_MAX_RETRIES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_MAX_RETRIES;
}
export function saveMaxRetries(value: number): void {
  lsSet(MAX_RETRIES_KEY, String(value));
}

/** 一轮最多跑多少步（工具轮）：默认 `DEFAULT_MAX_STEPS`；存坏了 / 越界夹回合法区间 */
const MAX_STEPS_KEY = "fizz.web.maxSteps";
export function loadMaxSteps(): number {
  const raw = lsGet(MAX_STEPS_KEY);
  if (raw === null) return DEFAULT_MAX_STEPS;
  const n = Number(raw);
  return Number.isFinite(n) ? resolveMaxSteps(n) : DEFAULT_MAX_STEPS;
}
export function saveMaxSteps(value: number): void {
  lsSet(MAX_STEPS_KEY, String(resolveMaxSteps(value)));
}

/** 同一批工具调用的并发上限（1 = 串行）：默认 3；存坏了 / 越界夹回合法区间 */
const TOOL_CONCURRENCY_KEY = "fizz.web.toolCallConcurrency";
export function loadToolCallConcurrency(): number {
  const raw = lsGet(TOOL_CONCURRENCY_KEY);
  if (raw === null) return DEFAULT_TOOL_CALL_CONCURRENCY;
  const n = Number(raw);
  return Number.isFinite(n)
    ? resolveToolCallConcurrency(n)
    : DEFAULT_TOOL_CALL_CONCURRENCY;
}
export function saveToolCallConcurrency(value: number): void {
  lsSet(TOOL_CONCURRENCY_KEY, String(resolveToolCallConcurrency(value)));
}

/**
 * 工具调用是否带「意图」：模型每次调工具填一句「这一步要干什么」，显示为工具卡标题。
 *
 * 默认**开启**（只存关掉的标记）：老用户没有这个 key 时也该看到新行为，
 * 而「关掉」是明确的用户决定，必须记住。
 */
const TOOL_INTENT_KEY = "fizz.web.toolIntent";
export function loadToolIntent(): boolean {
  return lsGet(TOOL_INTENT_KEY) !== "0";
}
export function saveToolIntent(value: boolean): void {
  lsSet(TOOL_INTENT_KEY, value ? "1" : "0");
}

/**
 * 命令沙箱开关：默认 **off**（与加这个开关之前完全一致）。
 *
 * 显式开启才隔离 —— 没有可用后端的平台（Windows / 缺 bwrap 的容器）开着会让
 * bash 直接失败，所以不能替用户默认打开。
 */
const SANDBOX_MODE_KEY = "fizz.web.sandboxMode";
export function loadSandboxMode(): CommandSandboxMode {
  return lsGet(SANDBOX_MODE_KEY) === "workspace-write" ? "workspace-write" : "off";
}
export function saveSandboxMode(value: CommandSandboxMode): void {
  lsSet(SANDBOX_MODE_KEY, value);
}

/**
 * 「设置 → AI → 通用」里那批**每轮请求都会带**的偏好（重试次数 / 并发 / 步数 / 意图 /
 * 审批超时 / 命令沙箱），一次读齐 —— 专给跨窗口同步用（见 `watchConversationPrefs`）。
 */
export interface ConversationPrefs {
  /** confirm 审批超时（分钟；0 = 不超时） */
  confirmTimeoutMin: number;
  /** 模型请求重试次数（0 = 不限制） */
  maxRetries: number;
  /** 一轮最多跑多少步（工具轮） */
  maxSteps: number;
  /** 同一批工具调用的并发上限 */
  toolCallConcurrency: number;
  /** 工具卡是否带「意图」 */
  toolIntent: boolean;
  /** 命令沙箱开关（off / workspace-write） */
  sandboxMode: CommandSandboxMode;
}

export function loadConversationPrefs(): ConversationPrefs {
  return {
    confirmTimeoutMin: loadConfirmTimeout(),
    maxRetries: loadMaxRetries(),
    maxSteps: loadMaxSteps(),
    toolCallConcurrency: loadToolCallConcurrency(),
    toolIntent: loadToolIntent(),
    sandboxMode: loadSandboxMode(),
  };
}

const PREF_KEYS = new Set([
  CONFIRM_TIMEOUT_KEY,
  MAX_RETRIES_KEY,
  MAX_STEPS_KEY,
  TOOL_CONCURRENCY_KEY,
  TOOL_INTENT_KEY,
  SANDBOX_MODE_KEY,
]);

/**
 * 订阅「**别的窗口**改了这批偏好」—— desktop 的设置页是独立窗口（另一个渲染进程 =
 * 另一份 `useAgentStore` 单例），在那边改完只写了 localStorage，本窗口不重读就一直是
 * 旧值（「改完设置必须重启 app」）。总线与跨窗口机制见 `prefs-sync`。
 *
 * 只覆盖跨窗口那一半：同窗口写盘不会触发 `storage` 事件，那半由 `setMaxRetries` 等
 * 动作自己 `set({...})`（见 actions/settings.ts）。两半合起来才完整。
 */
export function watchConversationPrefs(
  onChange: (prefs: ConversationPrefs) => void,
): () => void {
  return subscribePrefs([...PREF_KEYS], () => onChange(loadConversationPrefs()));
}

/**
 * 待发送队列：**服务端权威** + localStorage 缓存。
 *
 * 缓存不是「老实现遗留」，它在两处仍是必需的：
 * 1. 打开会话时先拿缓存渲染，服务端那份回来后**无感替换**（否则列表先闪一下空）；
 * 2. 服务端 / 网络不可用（未连接 / 离线 / 写失败）时队列照旧能用，只是不跨端。
 */
const QUEUE_KEY_PREFIX = "fizz.web.queue.";
export function loadQueue(conversationId: string): QueuedMessage[] {
  try {
    const raw = lsGet(QUEUE_KEY_PREFIX + conversationId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (m): m is QueuedMessage =>
            !!m && typeof m.id === "string" && typeof m.text === "string",
        )
      : [];
  } catch {
    return [];
  }
}
export function saveQueue(
  conversationId: string | null,
  items: QueuedMessage[],
): void {
  if (!conversationId) return;
  try {
    if (items.length === 0) lsRemove(QUEUE_KEY_PREFIX + conversationId);
    else lsSet(QUEUE_KEY_PREFIX + conversationId, JSON.stringify(items));
  } catch {
    // localStorage 不可用（隐私模式 / 超额）：队列退回纯内存，不阻塞发送
  }
}
export function lsRemove(key: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(key);
}

/**
 * 队列自动发送的暂停开关（会话级）。
 *
 * 与队列同一条理由必须落盘：用户按下暂停后刷新页面 / 重启应用，如果开关跟着内存
 * 一起丢，下一次一轮收场就会把攒着的需求静默发出去 —— 那正是他暂停要防的事。
 * 只存 `true`（未暂停 = 没有这个 key），省得每个会话都留一条 false。
 */
const QUEUE_PAUSED_KEY_PREFIX = "fizz.web.queue-paused.";
export function loadQueuePaused(conversationId: string): boolean {
  try {
    return lsGet(QUEUE_PAUSED_KEY_PREFIX + conversationId) === "1";
  } catch {
    return false;
  }
}
export function saveQueuePaused(
  conversationId: string | null,
  paused: boolean,
): void {
  if (!conversationId) return;
  try {
    if (paused) lsSet(QUEUE_PAUSED_KEY_PREFIX + conversationId, "1");
    else lsRemove(QUEUE_PAUSED_KEY_PREFIX + conversationId);
  } catch {
    // localStorage 不可用：暂停退回内存态（slice 里那份仍然生效），不阻塞发送
  }
}

/** 清掉所有按会话隔离的待发送队列（登出 / 401 失效时别残留到下次登录） */
export function clearAllQueues(): void {
  try {
    if (typeof window === "undefined") return;
    for (const key of Object.keys(window.localStorage)) {
      if (
        key.startsWith(QUEUE_KEY_PREFIX) ||
        key.startsWith(QUEUE_PAUSED_KEY_PREFIX)
      ) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // localStorage 不可用：队列本来就只是内存态，跳过
  }
}
