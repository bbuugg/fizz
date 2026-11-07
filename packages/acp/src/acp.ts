/**
 * ACP（Agent Client Protocol）后端：把外部 agent 进程接成与 `runAgent` 同款的事件流。
 *
 * 照桌面端 `src/main/services/ai/acp-agent.ts` 的形状搬过来（事件映射、审批、中止语义一致），
 * 差异只在「零 Electron、跑在服务器上」：
 * - 进程 cwd = **会话所属工作区**（服务器上的目录，不是客户端的）；
 * - 审批走 server 的 confirm 通道（confirm 帧 → POST /api/chat/confirm），由调用方注入回调；
 * - 会话按 `agentId::conversationId` 缓存常驻连接（ACP agent 自己保留多轮上下文），
 *   同一会话的轮次**串行**（两个客户端同时操作同一会话也不会互相踩）。
 *
 * ⚠️ 与 ai-sdk 后端的能力差异（外部 agent 自己管，我们不再注入）：
 * 技能 / 系统提示词 / 模型配置 / ask_followup_question 都不参与；
 * 权限也不映射 —— agent 发 `session/request_permission` 时把它给的选项
 * （optionId / name / kind）原样转给用户挑，挑中的 optionId 原样回传。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AcpModesState,
  AcpSelectOption,
  AcpThoughtLevelState,
  AgentChatMessage,
  AgentConfirmInput,
  AgentConfirmOption,
  AgentConfirmRequest,
  AgentMessagePart,
  AgentStreamEvent,
  AgentWorkspace,
  RunAgentResult,
} from "@fizz/contracts/types";
import type {
  AcpAgentConfig,
  AcpModelChoices,
  AcpModelOption,
  AcpToolCallContent,
} from "./types";

/** 没人答复审批时的缺省兜底（与桌面端一致；0 = 不超时，随请求可配） */
const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 历史里最后一条用户文本：ACP 侧自己保留上下文，只发这一句（同桌面端） */
function lastUserText(history: AgentChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role !== "user") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

/** 同一个 toolCallId 上累积起来的展示信息（跨多次 update 合并 / 变更检测） */
export interface AcpToolCallMemory {
  input: Record<string, unknown>;
  kind?: string;
  /**
   * agent 给的**程序化工具名**（`tool_call` / `tool_call_update` 的 `name`）。
   *
   * 必须记下来：`session/request_permission` 里的 `toolCall` 是「增量更新」，
   * 只带变化字段 —— CodeBuddy 这类 agent 在权限请求里只给 `toolCallId`，
   * 名字 / 标题 / 参数全在**前面那条** tool_call 里。不在权限请求时回查，审批卡上
   * 就只剩「工具调用」四个字（用户报过「看不到申请的是什么工具、什么参数」）。
   */
  name?: string;
  /** agent 给的展示标题（同上，权限请求里常常不带） */
  title?: string;
  content?: AcpToolCallContent[];
}
export type AcpInputMemory = Map<string, AcpToolCallMemory>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 把 toolCall.content（未知形状）收窄成 AcpToolCallContent[]：只保留能识别的三种类型，
 * 其余丢弃 —— 前端对未识别类型本来也没有更好的渲染方式。
 */
function normalizeAcpContent(value: unknown): AcpToolCallContent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AcpToolCallContent[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.type !== "string") continue;
    if (raw.type === "content") {
      const block = isRecord(raw.content) ? raw.content : undefined;
      out.push({
        type: "content",
        ...(block && typeof block.type === "string"
          ? { content: block as { type?: string; text?: string } }
          : {}),
      });
    } else if (raw.type === "diff") {
      out.push({
        type: "diff",
        ...(typeof raw.path === "string" ? { path: raw.path } : {}),
        ...(typeof raw.oldText === "string" ? { oldText: raw.oldText } : {}),
        ...(typeof raw.newText === "string" ? { newText: raw.newText } : {}),
      });
    } else if (raw.type === "terminal") {
      out.push({
        type: "terminal",
        ...(typeof raw.terminalId === "string"
          ? { terminalId: raw.terminalId }
          : {}),
      });
    }
  }
  return out;
}

/** 这些字段只说明「在哪跑」，不说明「干了什么」—— 用来判断参数是不是「聊胜于无」 */
const THIN_INPUT_KEYS = new Set(["cwd"]);

/**
 * ACP agent 不给 `name` 时的占位工具名。
 *
 * 各处「同一个 toolCallId 的多次事件怎么合并」都拿它当「还没有真名」的哨兵
 * （如 `lib/parts.ts` 的 `applyEvent`），改了它要一起改。
 */
const ACP_UNNAMED_TOOL = "tool";

/**
 * ACP 的工具名。
 *
 * ⚠️ **不能拿 `title` 顶替**：title 是给人看的自然语言描述（`Bash: npm test`，
 * claude-code 这类直接把整段脚本 / 命令塞进去），拿它当工具名会让消息列表里的
 * 卡片标题变成一长串命令。没有 name 就给占位名，标题另走 `title` 字段
 * （悬停提示 / 兜底展示），中文名由 `acpKind` 翻出来（见前端的 toolCardTitle）。
 */
const acpToolName = (name: unknown): string =>
  typeof name === "string" && name ? name : ACP_UNNAMED_TOOL;

/** 展示用标题：空串 / 缺失时不给，免得卡片上多一行空标题 */
const acpTitle = (title: unknown): string | undefined =>
  typeof title === "string" && title ? title : undefined;

/** 程序化工具名（`name`）：与 `acpToolName` 的区别是**不给占位名** —— 没有就返回空 */
const acpName = (name: unknown): string | undefined =>
  typeof name === "string" && name ? name : undefined;

/**
 * 把这次 update 带的入参并进记忆里（后到的覆盖先到的）。
 *
 * 为什么需要累积：**不少 ACP agent 的入参是分几次给的** —— 第一条 `tool_call` 只带
 * 一部分（opencode 的 bash 就只给了 `cwd`），完整参数在后面 `tool_call_update` 里补。
 * 只在第一条上取 `rawInput`，卡片上就会是「只有 cwd、看不到命令」。
 *
 * 兜底：参数始终是空的 / 只有 cwd 这种「聊胜于无」的字段时，把 agent 给的展示用
 * `title` 一并带上 —— 否则参数区要么一片空白（`{}`），要么只有个 cwd，
 * 用户根本看不出这次工具在干什么。
 */
function mergeAcpInput(
  memory: AcpInputMemory | undefined,
  toolCallId: string,
  rawInput: unknown,
  title: unknown,
): Record<string, unknown> {
  const merged = {
    ...(memory?.get(toolCallId)?.input ?? {}),
    ...(isRecord(rawInput) ? rawInput : {}),
  };
  const thin = Object.keys(merged).every((key) => THIN_INPUT_KEYS.has(key));
  if (thin && typeof title === "string" && title && merged.title !== title)
    merged.title = title;
  const entry = memory?.get(toolCallId);
  if (entry) entry.input = merged;
  return merged;
}

/**
 * ACP 的 session/update → AgentStreamEvent**列表**（一条 update 可能产出多条事件：
 * 例如「补全入参」+「工具结果」要分两条发，前者按 toolCallId 合并进已有工具卡）。
 *
 * 与桌面端同一套取舍：映射文本 / 思考 / 工具调用 / 工具结果（结果只在
 * completed·failed 时出）+ **上下文占用**（`usage_update` → `context-usage`，喂圆环）；
 * plan / mode / config_option 等仍一律丢弃。
 */
export function toAcpStreamEvent(
  update: { sessionUpdate: string; [key: string]: unknown },
  memory?: AcpInputMemory,
): AgentStreamEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content as
        { type?: string; text?: string } | undefined;
      if (content?.type === "text" && typeof content.text === "string") {
        return [{ type: "text-delta", delta: content.text }];
      }
      return [];
    }
    case "agent_thought_chunk": {
      const content = update.content as
        { type?: string; text?: string } | undefined;
      if (content?.type === "text" && typeof content.text === "string") {
        return [{ type: "reasoning-delta", delta: content.text }];
      }
      return [];
    }
    case "tool_call": {
      const toolCallId = String(update.toolCallId ?? "");
      const kind = typeof update.kind === "string" ? update.kind : undefined;
      const content = normalizeAcpContent(update.content);
      const input = mergeAcpInput(
        memory,
        toolCallId,
        update.rawInput,
        update.title,
      );
      const name = acpName(update.name);
      const title = acpTitle(update.title);
      if (memory && toolCallId) {
        memory.set(toolCallId, {
          input,
          ...(kind ? { kind } : {}),
          ...(name ? { name } : {}),
          ...(title ? { title } : {}),
          ...(content ? { content } : {}),
        });
      }
      return [
        {
          type: "tool-call",
          toolCallId,
          toolName: acpToolName(update.name),
          input,
          ...(kind ? { acpKind: kind } : {}),
          ...(content ? { acpContent: content } : {}),
          ...(acpTitle(update.title) ? { title: acpTitle(update.title) } : {}),
        },
      ];
    }
    case "tool_call_update": {
      const toolCallId = String(update.toolCallId ?? "");
      const events: AgentStreamEvent[] = [];
      // 入参 / 展示内容补全：变了才发（同 id 的 tool-call 会被各处按 id 合并进已有卡片）
      // ⚠️ 先快照 before 的 JSON 再调 mergeAcpInput —— 它会把 entry.input **原地**改写成
      // merged，之后 before.input 与 merged 是同一个引用，「自己比自己」恒等，补全事件
      // 就永远发不出去（表现为：agent 后补的命令 / 参数在卡片上看不到）。
      const before = memory?.get(toolCallId);
      const beforeInputJson = before ? JSON.stringify(before.input) : null;
      const beforeContentJson = before?.content
        ? JSON.stringify(before.content)
        : null;
      const merged = mergeAcpInput(
        memory,
        toolCallId,
        update.rawInput,
        update.title,
      );
      const kind = typeof update.kind === "string" ? update.kind : undefined;
      const content = normalizeAcpContent(update.content);
      const name = acpName(update.name);
      const title = acpTitle(update.title);
      const inputChanged =
        beforeInputJson === null || beforeInputJson !== JSON.stringify(merged);
      const contentChanged =
        (!!content && beforeContentJson !== JSON.stringify(content)) ||
        (!!kind && before?.kind !== kind);
      // 名字 / 标题只补记忆（权限请求要回查），不再单独推事件：
      // 它们不是「卡片内容变了」，多发一帧只会让前端白白合并一次。
      const identityChanged =
        (!!name && before?.name !== name) ||
        (!!title && before?.title !== title);
      if (memory && (inputChanged || contentChanged || identityChanged)) {
        memory.set(toolCallId, {
          input: merged,
          ...(kind || before?.kind ? { kind: kind ?? before?.kind } : {}),
          ...(name || before?.name ? { name: name ?? before?.name } : {}),
          ...(title || before?.title ? { title: title ?? before?.title } : {}),
          ...(content || before?.content
            ? { content: content ?? before?.content }
            : {}),
        });
      }
      if (inputChanged || contentChanged) {
        events.push({
          type: "tool-call",
          toolCallId,
          toolName: acpToolName(update.name),
          input: merged,
          ...(kind || before?.kind ? { acpKind: kind ?? before?.kind } : {}),
          ...(content || before?.content
            ? { acpContent: content ?? before?.content }
            : {}),
          ...(acpTitle(update.title) ? { title: acpTitle(update.title) } : {}),
        });
      }
      // 结果只在终态出：中间态（pending/in_progress）出了会让结果重复
      const status = String(update.status ?? "");
      if (status === "completed" || status === "failed") {
        events.push({
          type: "tool-result",
          toolCallId,
          toolName: acpToolName(update.name),
          output: update.rawOutput ?? {},
          isError: status === "failed",
        });
      }
      return events;
    }
    case "usage_update": {
      /**
       * 上下文占用（`{ used, size }`，可选带 `cost`）：`used` = 当前上下文 tokens、
       * `size` = agent 的上下文窗口。原样转成一帧 `context-usage`，前端拿它画圆环。
       *
       * 协议里这个字段标着 UNSTABLE，有的 agent 根本不发；数值缺 / 非数字 / 负数时
       * 直接不发（宁可圆环保持空，也别画个 NaN 出来）。`cost` 目前不用，丢弃。
       */
      const used = Number(update.used);
      const size = Number(update.size);
      if (
        !Number.isFinite(used) ||
        !Number.isFinite(size) ||
        used < 0 ||
        size <= 0
      )
        return [];
      return [{ type: "context-usage", used, size }];
    }
    default:
      return [];
  }
}

// ---------- 会话管理 ----------

interface AcpSessionEntry {
  agentId: string;
  conversationId: string;
  proc: ChildProcess;
  session: acp.ActiveSession | null;
  /** 建立会话时的 client 上下文（模型下发的 `session/set_config_option` 用它） */
  cx: acp.ClientContext | null;
  /**
   * agent 广告的权限档位（ACP Session Modes，可选能力）与当前档。
   * 只做**记录与切换**（`session/set_mode`），不做任何语义映射 —— 问不问、怎么问，
   * 策略完全在 agent 侧；档位的名字 / 描述原样给到界面。
   */
  availableModes: acp.SessionMode[];
  currentModeId: string | null;
  /**
   * agent 广告的「模型选择器」（可选能力）。
   *
   * ACP 没有独立的「列模型」方法：stable 协议把它放在 `session/new` 的
   * `configOptions` 里，用 `category: 'model'` 标出语义（见 pickModelSelector），
   * 切换走 `session/set_config_option`。null = 这个 agent 不支持选模型。
   */
  modelSelector: AcpModelSelector | null;
  /**
   * agent 广告的「思考档选择器」（configOptions 的 `category: 'thought_level'`，`pi` 用它）。
   * 与 `modelSelector` 并列、各自独立；null = 这个 agent 不支持思考档。
   */
  thoughtLevelSelector: AcpThoughtLevelSelector | null;
  /**
   * agent 广告的「模式选择器」（configOptions 的 `category: 'mode'`，**opencode 用它**）。
   *
   * 与老式的 `availableModes`（`session/new.modes` 字段）是**两种并存**的通道；快照
   * 优先取老式那个（`snapshotOf`），取不到才用这里。null = agent 不走 configOptions 通道。
   */
  modeOptionSelector: AcpModeOptionSelector | null;
  closeConnection: (() => void) | null;
  /**
   * `session/load` 恢复出来的会话通道（与 `session` 二选一作为本轮的交互来源）。
   * 打开会话 / 轮次前恢复上下文都走它；teardown 时随 entry 一起消失。
   */
  loadedSource: LoadedTurnSource | null;
  /** 同一会话的轮次串行链 */
  chain: Promise<unknown>;
  /** 当前轮次的审批上下文（requestPermission 时要用） */
  turn: {
    requestId: string;
    /**
     * 本轮已见的 tool-call 明细（名字 / 标题 / 入参 / 种类）。
     *
     * `session/request_permission` 的 `toolCall` 是**增量**：CodeBuddy 这类 agent 只发
     * `toolCallId`，真正的工具名和参数在上一条 `tool_call` 里。审批卡要靠这里回查，
     * 否则只剩「工具调用」+ 空白，用户看不到自己在授权什么。
     */
    toolCalls: AcpInputMemory;
    /** 审批超时（毫秒）；0 = 不超时。缺省走 DEFAULT_CONFIRM_TIMEOUT_MS */
    confirmTimeoutMs?: number;
    requestPermission?: (
      req: AgentConfirmInput,
    ) => Promise<AgentPermissionReply>;
    onEvent: (event: AgentStreamEvent) => void;
  } | null;
}

/** 用户对一次 ACP 权限请求的答复：挑中的选项（或超时 / 无通道时的拒绝） */
interface AgentPermissionReply {
  approved: boolean;
  optionId?: string;
}

/** agentId::conversationId → 常驻会话 */
const sessions = new Map<string, AcpSessionEntry>();

/** 某个会话上「可选的模型 + 当前值」（内部形态：configId 一定存在） */
interface AcpModelSelector {
  /** 承载模型的那个 config 选项 id（切模型时回传给 agent） */
  configId: string;
  /** 当前生效的模型值 */
  current: string;
  options: AcpModelOption[];
}

/**
 * 从 `session/new` 的 `configOptions` 里挑出「模型选择器」。
 *
 * stable ACP 用 `category` 标语义（`model` = 模型选择器，另有 `mode` / `thought_level`
 * / `model_config`）。老 agent 可能不给 category，所以退回看 id / name 里有没有 model 字样。
 * 只认 `type: 'select'`（`boolean` 是开关，不是选模型）。
 */
function pickModelSelector(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): AcpModelSelector | null {
  for (const option of configOptions ?? []) {
    if (option.type !== "select") continue;
    const semantic =
      option.category === "model" ||
      (!option.category && /model/i.test(`${option.id} ${option.name}`));
    if (!semantic) continue;
    // 选项可以是不分组的一层，也可以按组包一层（SessionConfigSelectGroup）
    const flat: { value?: unknown; name?: unknown; description?: unknown }[] =
      [];
    for (const entry of option.options ?? []) {
      if (Array.isArray((entry as { options?: unknown[] }).options)) {
        flat.push(...((entry as { options: typeof flat }).options ?? []));
      } else {
        flat.push(entry);
      }
    }
    const options = flat
      .filter((o) => typeof o.value === "string" && o.value)
      .map((o) => ({
        value: String(o.value),
        name: typeof o.name === "string" && o.name ? o.name : String(o.value),
        ...(typeof o.description === "string" && o.description
          ? { description: o.description }
          : {}),
      }));
    if (!options.length) continue;
    return {
      configId: option.id,
      current:
        typeof option.currentValue === "string"
          ? option.currentValue
          : options[0]!.value,
      options,
    };
  }
  return null;
}

/** 某个会话上「思考档 + 当前值」（内部形态：configId 一定存在） */
interface AcpThoughtLevelSelector {
  /** 承载思考档的那个 config 选项 id（下发时回传） */
  configId: string;
  current: string | null;
  options: AcpSelectOption[];
}

/**
 * 从 `session/new` / `session/load` 的 `configOptions` 里挑出**思考档**（`pi` 用它）。
 *
 * 与 `pickModelSelector` 同构：只认 `type: 'select'` 且 `category: 'thought_level'`
 * （规范里 `thought_level` 是保留的语义分类，见 SDK schema 的 SessionConfigOptionCategory）。
 * 与模型选择器分开存放（`entry.thoughtLevelSelector`）——一个 agent 两者可以同时广告。
 */
function pickThoughtLevelSelector(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): AcpThoughtLevelSelector | null {
  for (const option of configOptions ?? []) {
    if (option.type !== "select") continue;
    if (option.category !== "thought_level") continue;
    // 选项可以是不分组的一层，也可以按组包一层（SessionConfigSelectGroup）
    const flat: { value?: unknown; name?: unknown; description?: unknown }[] =
      [];
    for (const entry of option.options ?? []) {
      if (Array.isArray((entry as { options?: unknown[] }).options)) {
        flat.push(...((entry as { options: typeof flat }).options ?? []));
      } else {
        flat.push(entry);
      }
    }
    const options = flat
      .filter((o) => typeof o.value === "string" && o.value)
      .map((o) => ({
        value: String(o.value),
        name: typeof o.name === "string" && o.name ? o.name : String(o.value),
        ...(typeof o.description === "string" && o.description
          ? { description: o.description }
          : {}),
      }));
    if (!options.length) continue;
    return {
      configId: option.id,
      current:
        typeof option.currentValue === "string" ? option.currentValue : null,
      options,
    };
  }
  return null;
}

/** 某个会话上「模式选择器（configOptions 通道）」+ 当前值（内部形态：configId 一定存在） */
interface AcpModeOptionSelector {
  configId: string;
  current: string | null;
  options: AcpSelectOption[];
}

/**
 * 从 `configOptions` 里挑出 **`category: 'mode'` 的模式选择器**。
 *
 * stable ACP 把「模式」也规范成 configOptions 的一种语义分类，与老式的 `session/new.modes`
 * 字段**并存**：agent 用哪个都行 —— **opencode 走这里**（`{ id: 'mode', name: 'Session Mode',
 * currentValue: 'build', options: [build, plan] }`，它的 `modes` 字段是 null），pi 走 `modes`。
 * 切换方式也不同：这里走 `session/set_config_option`，不是 `session/set_mode`。
 */
function pickModeOptionSelector(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): AcpModeOptionSelector | null {
  for (const option of configOptions ?? []) {
    if (option.type !== "select") continue;
    if (option.category !== "mode") continue;
    const flat: { value?: unknown; name?: unknown; description?: unknown }[] =
      [];
    for (const entry of option.options ?? []) {
      if (Array.isArray((entry as { options?: unknown[] }).options)) {
        flat.push(...((entry as { options: typeof flat }).options ?? []));
      } else {
        flat.push(entry);
      }
    }
    const options = flat
      .filter((o) => typeof o.value === "string" && o.value)
      .map((o) => ({
        value: String(o.value),
        name: typeof o.name === "string" && o.name ? o.name : String(o.value),
        ...(typeof o.description === "string" && o.description
          ? { description: o.description }
          : {}),
      }));
    if (!options.length) continue;
    return {
      configId: option.id,
      current:
        typeof option.currentValue === "string" ? option.currentValue : null,
      options,
    };
  }
  return null;
}

/**
 * Windows 上判断这条命令能不能直接 spawn；不能就交给 `cmd.exe /c`。
 *
 * 必须包 cmd 的两种情况：
 * - 命令本身以 `.cmd` / `.bat` 结尾（CreateProcess 不能直接执行脚本）；
 * - **无扩展名的命令，而在 PATH 上命中的真身是 `xxx.CMD`**：npm / pnpm 全局安装的 CLI
 *   （npm、pnpm、pi-acp、codex-acp…）在 bin 目录里是三件套 —— `xxx`（POSIX sh 脚本，
 *   给 Git Bash 用）、`xxx.CMD`、`xxx.ps1`。**libuv 不按 PATHEXT 解析**，直接
 *   `spawn('xxx')` 抓不到那个 sh 脚本（CreateProcess 执行不了它），结果是 **ENOENT**：
 *   实测 `spawn('pi-acp')` 即如此，用户侧表现为设置页「读取失败：spawn pi-acp ENOENT」。
 *
 * `.exe` / `.com` 保持直连 —— 少一层 cmd 包装，参数也不会被 cmd 二次解析。
 */
function resolveWindowsCommand(command: string): {
  command: string;
  viaCmd: boolean;
} {
  if (process.platform !== "win32") return { command, viaCmd: false };
  if (/\.(cmd|bat)$/i.test(command)) return { command, viaCmd: true };
  if (/\.(exe|com)$/i.test(command)) return { command, viaCmd: false };
  // 带路径分隔符的：当它是确定文件，且不是 .exe/.com → 一定是脚本
  if (/[\\/]/.test(command)) return { command, viaCmd: true };
  // 裸命令名：按 PATH × PATHEXT 找出真身，看它是不是脚本
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      let isFile = false;
      try {
        isFile = statSync(join(dir, command + ext)).isFile();
      } catch {
        isFile = false;
      }
      if (isFile) return { command, viaCmd: /\.(cmd|bat)$/i.test(ext) };
    }
  }
  // PATH 上找不到：仍走 cmd 兜底，报错信息与原来一致
  return { command, viaCmd: true };
}

/** Windows 的 .cmd/.bat（含无扩展名的全局 CLI 别名）不能直接 spawn，要包一层 cmd.exe */
function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
): ChildProcess {
  const resolved = resolveWindowsCommand(command);
  if (resolved.viaCmd) {
    return spawn("cmd.exe", ["/c", resolved.command, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn(resolved.command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** 杀掉整棵进程树（Windows 用 taskkill /T，避免 cmd.exe 包装层残留） */
function killProcessTree(proc: ChildProcess): void {
  try {
    if (process.platform === "win32" && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    proc.kill("SIGKILL");
  } catch {
    proc.kill();
  }
}

/** 关掉并丢弃一条会话（进程退出 / 主动中止 / 切换 agent 时调用） */
function teardown(key: string): void {
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  entry.closeConnection?.();
  killProcessTree(entry.proc);
}

/** 服务端退出前清理：不留孤儿 agent 进程 */
export function disposeAcpSessions(): void {
  for (const key of [...sessions.keys()]) teardown(key);
}

/** 轮次里流动的一条消息：agent 的增量通知，或整轮的 stop */
type TurnMessage =
  | { kind: "session_update"; update: acp.SessionUpdate }
  | { kind: "stop"; stopReason: string };

/**
 * `session/load` 恢复出来的会话交互通道。
 *
 * SDK 的 `ActiveSession` 只能附着在 `session/new` 上（`attachSession` 是私有的），
 * 而 `session/load` 之后 agent 的 `session/update` 通知不会自动进任何队列 —— 这里用
 * `ClientApp.onNotification` 按 sessionId 自己路由，提供与 ActiveSession 同形的
 * `prompt` / `nextUpdate`，让 runAcpAgent 的轮次循环对两种来源完全通用。
 *
 * ⚠️ 「同形」包括**失败也要走队列**：`ActiveSession.prompt` 失败时 SDK 会
 * `updates.reject(error)`，让挂着的 `nextUpdate()` 抛出来（见 `dist/acp.js`）。
 * 这条通道是手写的，少了这一步就会出现「agent 报错、界面永远思考中」（见 `fail`）。
 */
class LoadedTurnSource {
  private queue: Array<TurnMessage> = [];
  /** 等消息的 `nextUpdate()`：**两个回调都留着** —— 出错时要能把它们拒掉（见 `fail`） */
  private waiters: Array<{
    resolve: (message: TurnMessage) => void;
    reject: (err: unknown) => void;
  }> = [];
  /**
   * 还没有等待者的错误（agent 回了 JSON-RPC error，而轮次循环此刻还没走到 `nextUpdate`）。
   * 与 SDK 的 `updates.reject` 同语义：**错误也走这条队列**，否则轮次永远等不到 stop。
   */
  private failure: unknown = null;

  constructor(
    readonly sessionId: string,
    private readonly cx: acp.ClientContext,
  ) {}

  /** session/update 通知入口（connectEntry 里的 onNotification 按 sessionId 分发到这里） */
  handleNotification(params: acp.SessionNotification): void {
    if (params.sessionId !== this.sessionId) return;
    this.push({ kind: "session_update", update: params.update });
  }

  private push(message: TurnMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(message);
    else this.queue.push(message);
  }

  /**
   * 把一轮的错误交给等在这里的 `nextUpdate()`（没有等待者就先存着，下次调用立刻抛）。
   *
   * ⚠️ 少了这一步就是**真卡死**：`runAcpAgent` 里 `void source.prompt(text).catch(() => undefined)`
   * **吞掉了** prompt 的 rejection，而轮次循环只等 `nextUpdate()`。agent 以 JSON-RPC error
   * 结束一轮时（凭据无效 / 上游 5xx / 重试耗尽），错误只停在那个被吞掉的 rejection 上，
   * 循环**永远等不到 stop** —— 界面一直「思考中」，只能手动点停止。
   * （`session/new` 那条路不会这样：SDK 的 `ActiveSession.prompt` 失败时会自己 reject 队列。）
   */
  fail(err: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.reject(err);
    else this.failure = err;
  }

  /**
   * 取走队列里攒着的全部消息（不阻塞）：`session/load` 的回放历史就躺在这里。
   * 轮次前调用可以把回放丢掉（视图由打开会话时的 transcript 端点负责）；
   * 打开会话时则把它们转成流事件交给界面。
   */
  drainAll(): TurnMessage[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** 让 agent 恢复这个会话（历史会以 session/update 回放进队列） */
  async load(
    cwd: string,
  ): Promise<{ configOptions?: acp.SessionConfigOption[] | null }> {
    // load 的应答类型在 SDK 里被标成 void（agent 侧可返回 void），实际带 configOptions。
    // ⚠️ mcpServers 是 load 请求的必填字段（与 session/new 不同，这里没有 builder 兜底），
    // 漏了会被 agent 的 schema 校验直接拒成 Invalid params
    const response = (await this.cx.request(acp.methods.agent.session.load, {
      sessionId: this.sessionId,
      cwd,
      mcpServers: [],
    })) as { configOptions?: acp.SessionConfigOption[] | null } | void;
    return response ?? {};
  }

  /** 与 ActiveSession.prompt 同语义：整轮结束才 resolve；stop 消息由这里入队 */
  async prompt(text: string): Promise<void> {
    // 新一轮开始：丢掉上一轮残留的错误（同 ActiveSession.prompt 的 clearErrors）
    this.failure = null;
    try {
      const response = await this.cx.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.push({ kind: "stop", stopReason: response.stopReason });
    } catch (err) {
      // 错误推进队列，**照旧往上抛**：调用方那个 `.catch` 兜住它，谁也不依赖 rejection
      this.fail(err);
      throw err;
    }
  }

  async nextUpdate(): Promise<TurnMessage> {
    const queued = this.queue.shift();
    // 队列优先：stop 已经入队、进程紧接着才退的场合，先把这一轮的结局交出去
    if (queued) return queued;
    if (this.failure !== null) {
      const err = this.failure;
      this.failure = null;
      throw err;
    }
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }
}

/**
 * 建立到 agent 进程的连接：initialize + 权限 / 通知处理器挂好，返回可用的
 * ClientContext，然后**挂住**直到 teardown（连接生命周期 = 会话生命周期）。
 * session/new（ensureSession）与 session/load（loadTurnSource）共用这一段。
 */
async function connectEntry(
  entry: AcpSessionEntry,
  agent: AcpAgentConfig,
  workspacePath: string,
): Promise<acp.ClientContext> {
  const proc = entry.proc;
  const input = Writable.toWeb(proc.stdin!) as WritableStream;
  const output = Readable.toWeb(proc.stdout!) as ReadableStream;
  proc.stderr?.on("data", (chunk) => {
    console.error(`[acp:${agent.name}] ${String(chunk).trimEnd()}`);
  });

  return new Promise<acp.ClientContext>((resolveCx, rejectCx) => {
    // spawn 失败（命令不存在 / 没有执行权限）只会以 `'error'` 事件抛出：ChildProcess 上
    // 没人监听它 = 未捕获异常，会把整个进程带走（进程内直连时就是**桌面崩掉**），
    // 所以必须接住，并把它转成这条会话的错误。
    proc.once("error", (err: Error) => {
      if (sessions.get(`${entry.agentId}::${entry.conversationId}`) === entry) {
        sessions.delete(`${entry.agentId}::${entry.conversationId}`);
      }
      rejectCx(err);
    });
    void acp
      .client({ name: "Fizz Server" })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) =>
        handlePermission(entry, ctx.params as acp.RequestPermissionRequest),
      )
      .onNotification(acp.methods.client.session.update, (ctx) => {
        // 加载出来的会话没有 ActiveSession 帮忙路由，这里按 sessionId 分发
        entry.loadedSource?.handleNotification(ctx.params);
      })
      .connectWith(
        acp.ndJsonStream(input, output),
        async (ctx: acp.ClientContext) => {
          try {
            await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              // session.configOptions：声明我们支持会话配置项（模型选择器就挂在它上面）。
              // 协议里「不声明」= 不支持任何配置项扩展，有的 agent 会因此干脆不广告模型清单。
              clientCapabilities: { session: { configOptions: {} } },
              clientInfo: { name: "Fizz Server", version: "0.1.0" },
            });
            resolveCx(ctx);
          } catch (err) {
            rejectCx(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          // 挂在这里直到 teardown（连接生命周期 = 会话生命周期）
          await new Promise<void>((resolveClose) => {
            entry.closeConnection = resolveClose;
          });
        },
      )
      .catch((err: unknown) =>
        rejectCx(err instanceof Error ? err : new Error(String(err))),
      );
  });
}

async function ensureSession(
  entry: AcpSessionEntry,
  /** agent 进程的 cwd（会话所属工作区；探针场景给主目录） */
  workspacePath: string,
  agent: AcpAgentConfig,
  onSessionCreated?: (info: AcpSessionReadyInfo) => void,
): Promise<acp.ActiveSession> {
  if (entry.session) return entry.session;
  // 复用可能已经建立的连接（session/load 失败后连接仍活着），避免在同一进程上重复建连
  const cx = entry.cx ?? (await connectEntry(entry, agent, workspacePath));
  entry.cx = cx;
  // session/load 失败会残留一个不可用的加载通道：清掉，免得后续轮次误用
  entry.loadedSource = null;
  // 「任务」会话没有工作区目录：ACP agent 仍要一个合法 cwd，落到主目录
  const session = await cx.buildSession(workspacePath || homedir()).start();
  entry.session = session;
  // 权限档位（ACP Session Modes，可选能力）：只记录，切换走 setAcpSessionMode（session/set_mode）
  const modeState = session.modes ?? null;
  entry.availableModes = modeState?.availableModes ?? [];
  entry.currentModeId = modeState?.currentModeId ?? null;
  if (entry.availableModes.length) {
    console.log(
      `[acp:${agent.name}] 可用档位：${entry.availableModes.map((m) => `${m.id}(${m.name})`).join(", ")}；当前 ${entry.currentModeId}`,
    );
  }
  // 可选模型（可选能力）：agent 在 configOptions 里广告，切换见 applyAcpModel
  entry.modelSelector = pickModelSelector(
    session.newSessionResponse?.configOptions,
  );
  if (entry.modelSelector) {
    console.log(
      `[acp:${agent.name}] 可选模型：${entry.modelSelector.options.map((o) => `${o.value}(${o.name})`).join(", ")}；当前 ${entry.modelSelector.current}`,
    );
  }
  // 可选思考档（`pi` 用它，可选能力）：同一份 configOptions 里 category='thought_level'，切换见 applyAcpThoughtLevel
  entry.thoughtLevelSelector = pickThoughtLevelSelector(
    session.newSessionResponse?.configOptions,
  );
  if (entry.thoughtLevelSelector) {
    console.log(
      `[acp:${agent.name}] 思考档：${entry.thoughtLevelSelector.options.map((o) => `${o.value}(${o.name})`).join(", ")}；当前 ${entry.thoughtLevelSelector.current}`,
    );
  }
  // 可选「模式」（configOptions 的 `category: 'mode'`，**opencode 用它**）：与老式 `modes` 字段并存
  entry.modeOptionSelector = pickModeOptionSelector(
    session.newSessionResponse?.configOptions,
  );
  if (entry.modeOptionSelector) {
    console.log(
      `[acp:${agent.name}] 模式（configOptions）：${entry.modeOptionSelector.options.map((o) => `${o.value}(${o.name})`).join(", ")}；当前 ${entry.modeOptionSelector.current}`,
    );
  }
  // 会话就绪回调放在最后：此刻档位 / 模型 / 思考档 / 模式都已记录，回调能拿到完整快照
  onSessionCreated?.({ sessionId: session.sessionId, ...snapshotOf(entry) });
  return session;
}

/**
 * 用 `session/load` 恢复一个**绑定的既有会话**：agent 侧按 sessionId 找回自己的
 * 上下文，历史以 session/update 回放进队列。加载完顺手把 load 响应里的
 * configOptions 也补进模型选择器（与 session/new 对齐）。
 */
async function loadTurnSource(
  entry: AcpSessionEntry,
  agent: AcpAgentConfig,
  workspacePath: string,
  sessionId: string,
): Promise<LoadedTurnSource> {
  const cx = await connectEntry(entry, agent, workspacePath);
  entry.cx = cx;
  const source = new LoadedTurnSource(sessionId, cx);
  entry.loadedSource = source;
  const response = await source.load(workspacePath || homedir());
  entry.modelSelector =
    entry.modelSelector ?? pickModelSelector(response.configOptions ?? null);
  // load 响应里同样可能带权限档位：没有记录过就补上（与 session/new 对齐）
  const loadModes = (
    response as {
      modes?: {
        availableModes?: acp.SessionMode[];
        currentModeId?: string | null;
      } | null;
    }
  ).modes;
  if (loadModes?.availableModes?.length && entry.availableModes.length === 0) {
    entry.availableModes = loadModes.availableModes;
    entry.currentModeId = loadModes.currentModeId ?? null;
  }
  // load 响应里同样可能带思考档（与 session/new 对齐）；没记录过才补
  entry.thoughtLevelSelector =
    entry.thoughtLevelSelector ??
    pickThoughtLevelSelector(response.configOptions ?? null);
  // 同理补 configOptions 通道的「模式」（opencode）
  entry.modeOptionSelector =
    entry.modeOptionSelector ??
    pickModeOptionSelector(response.configOptions ?? null);
  return source;
}

/**
 * 查某个 acp 会话的权限档位（ACP Session Modes）。
 * 只读已激活会话的记录 —— **不起进程**：agent 没在跑 / 没广告档位时返回
 * `supported: false`，界面据此隐藏档位切换 pill。
 */
export function getAcpSessionModes(
  agentId: string,
  conversationId: string,
): {
  supported: boolean;
  modes: Array<{ id: string; name?: string; description?: string }>;
  currentModeId: string | null;
} {
  const entry = sessions.get(`${agentId}::${conversationId}`);
  if (!entry) return { supported: false, modes: [], currentModeId: null };
  return {
    supported: entry.availableModes.length > 0,
    modes: entry.availableModes.map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.description ? { description: m.description } : {}),
    })),
    currentModeId: entry.currentModeId,
  };
}

/** 从 entry 组装界面用的运行态快照（modes / thoughtLevel）；两者都可能为 null */
function snapshotOf(entry: AcpSessionEntry): {
  modes: AcpModesState | null;
  thoughtLevel: AcpThoughtLevelState | null;
} {
  const modeOption = entry.modeOptionSelector;
  const modes: AcpModesState | null = entry.availableModes.length
    ? {
        available: entry.availableModes.map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          ...(m.description ? { description: m.description } : {}),
        })),
        current: entry.currentModeId,
      }
    : modeOption
      ? {
          available: modeOption.options.map((o) => ({
            id: o.value,
            name: o.name,
            ...(o.description ? { description: o.description } : {}),
          })),
          current: modeOption.current,
          configId: modeOption.configId,
        }
      : null;
  const selector = entry.thoughtLevelSelector;
  const thoughtLevel: AcpThoughtLevelState | null = selector
    ? {
        configId: selector.configId,
        current: selector.current,
        options: selector.options,
      }
    : null;
  return { modes, thoughtLevel };
}

/**
 * 读某个 acp 会话的运行态快照（Session Modes + 思考档），供「打开会话 / 建会话后刷新会话配置」用。
 * 只读已激活会话的记录、**不起进程**；没有 entry 返回 null（与 `getAcpSessionModes` 同一风格）。
 */
export function getAcpSessionSnapshot(
  agentId: string,
  conversationId: string,
): {
  modes: AcpModesState | null;
  thoughtLevel: AcpThoughtLevelState | null;
} | null {
  const entry = sessions.get(`${agentId}::${conversationId}`);
  return entry ? snapshotOf(entry) : null;
}

/**
 * 「未激活就切档」时自动激活所需的信息（mode / thought-level 路由从会话与工作区记录拼出）。
 */
export interface AcpActivateInfo {
  agent: AcpAgentConfig;
  workspacePath: string;
  /** 会话记录里绑定的 agent 侧 session id：有则 session/load 恢复上下文，无则 session/new */
  loadSessionId?: string;
}

/** 按 key 去重的激活在途表：连续切两次档只拉起一次进程 */
const activating = new Map<string, Promise<void>>();

/**
 * 确保会话 entry 已激活（进程 + load/new 都就绪），供「未激活就切档」的 setter 用。
 * 与「打开会话」（replayAcpSession）同一条激活路径：有绑定 sessionId 走 load 恢复
 * 上下文（agent 不支持 / 已失效则退回 session/new，与轮次路径同一套兜底）。
 * 返回 null = 已就绪；否则返回给用户看的错误文案。
 */
async function ensureActivated(
  agentId: string,
  conversationId: string,
  info: AcpActivateInfo,
): Promise<string | null> {
  const key = `${agentId}::${conversationId}`;
  const inflight = activating.get(key);
  if (inflight) await inflight;
  else {
    const task = (async (): Promise<void> => {
      // 打开会话的回放正在重建 entry：等它收场，别让两条路互相 teardown
      await replaying.get(key)?.catch(() => undefined);
      const entry = getOrCreateEntry({
        agent: info.agent,
        conversationId,
        workspacePath: info.workspacePath,
      });
      try {
        if (info.loadSessionId) {
          try {
            await loadTurnSource(
              entry,
              info.agent,
              info.workspacePath,
              info.loadSessionId,
            );
          } catch (err) {
            // agent 不支持 load / 会话已失效：退回 session/new（与轮次路径同一套兜底）
            console.warn(
              `[acp:${info.agent.name}] 自动激活的 session/load 失败，退回 session/new：${describeError(err)}`,
            );
            entry.loadedSource = null;
            await ensureSession(entry, info.workspacePath, info.agent);
          }
        } else {
          await ensureSession(entry, info.workspacePath, info.agent);
        }
      } catch (err) {
        // 彻底失败：拆掉半活的 entry，下次尝试从干净状态开始
        teardown(key);
        throw err;
      }
    })();
    activating.set(key, task);
    try {
      await task;
    } catch (err) {
      return `自动激活会话失败：${describeError(err)}`;
    } finally {
      activating.delete(key);
    }
  }
  const entry = sessions.get(key);
  if (!entry || (!entry.cx && !entry.session && !entry.loadedSource)) {
    return "自动激活会话失败（进程没能建立）";
  }
  return null;
}

/**
 * 切换 acp 会话的**模式 / 权限档**，两条通道自动选：
 * - 规范 Session Modes（`session/new.modes`）→ `session/set_mode`；
 * - configOptions 的 `category: 'mode'`（**opencode 走这条**）→ `session/set_config_option`。
 *
 * 会话未激活时若给了 `activate` 信息则**自动激活**（与「重新打开会话」同一条路径：
 * spawn agent 进程 + session/load 恢复上下文），激活后立即切换——用户切档不再被
 * 「先发条消息」挡住。agent 拒绝 / 档位不存在时返回 ok: false。不做任何语义映射。
 */
export async function setAcpSessionMode(
  agentId: string,
  conversationId: string,
  modeId: string,
  activate?: AcpActivateInfo,
): Promise<{ ok: boolean; error?: string }> {
  const key = `${agentId}::${conversationId}`;
  if (activate) {
    const err = await ensureActivated(agentId, conversationId, activate);
    if (err) return { ok: false, error: err };
  }
  const entry = sessions.get(key);
  if (!entry || !entry.cx) {
    return {
      ok: false,
      error: "会话未激活（先在会话里发一条消息，或重新打开会话）",
    };
  }
  // load 恢复的会话没有 ActiveSession（只有 loadedSource），sessionId 用绑定的那个
  const sessionId = entry.session?.sessionId ?? activate?.loadSessionId;
  if (!sessionId) {
    return {
      ok: false,
      error: "会话未激活（先在会话里发一条消息，或重新打开会话）",
    };
  }
  const inSessionModes = entry.availableModes.some((m) => m.id === modeId);
  const modeOption = entry.modeOptionSelector;
  if (!inSessionModes && !modeOption?.options.some((o) => o.value === modeId)) {
    return { ok: false, error: "这个 agent 没有这个模式" };
  }
  try {
    if (inSessionModes) {
      await entry.cx.request(acp.methods.agent.session.setMode, {
        sessionId,
        modeId,
      });
      entry.currentModeId = modeId;
    } else if (modeOption) {
      const response = await entry.cx.request(
        acp.methods.agent.session.setConfigOption,
        {
          sessionId,
          configId: modeOption.configId,
          value: modeId,
        },
      );
      entry.modeOptionSelector = pickModeOptionSelector(
        response?.configOptions,
      ) ?? { ...modeOption, current: modeId };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * 切换 acp 会话的**思考档**（`session/set_config_option`，`pi` 用它）。
 * 与 `setAcpSessionMode` 同形：会话未激活时给 `activate` 则自动激活；agent 拒绝 / 值不存在时返回 ok: false。
 */
export async function setAcpSessionThoughtLevel(
  agentId: string,
  conversationId: string,
  value: string,
  activate?: AcpActivateInfo,
): Promise<{ ok: boolean; error?: string }> {
  const key = `${agentId}::${conversationId}`;
  if (activate) {
    const err = await ensureActivated(agentId, conversationId, activate);
    if (err) return { ok: false, error: err };
  }
  const entry = sessions.get(key);
  if (!entry || !entry.cx) {
    return {
      ok: false,
      error: "会话未激活（先在会话里发一条消息，或重新打开会话）",
    };
  }
  const sessionId = entry.session?.sessionId ?? activate?.loadSessionId;
  if (!sessionId) {
    return {
      ok: false,
      error: "会话未激活（先在会话里发一条消息，或重新打开会话）",
    };
  }
  const selector = entry.thoughtLevelSelector;
  if (!selector) return { ok: false, error: "这个 agent 不支持思考档" };
  try {
    const response = await entry.cx.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId,
        configId: selector.configId,
        value,
      },
    );
    entry.thoughtLevelSelector = pickThoughtLevelSelector(
      response?.configOptions,
    ) ?? { ...selector, current: value };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * 把会话记住的模型下发给 agent（`session/set_config_option`）。
 *
 * 静默跳过的情况（都不是错误）：
 * - 没选（`modelId` 为空）→ 用 agent 自己的默认，别乱动；
 * - agent 没广告模型选择器 → 它不支持选模型；
 * - 选的值不在它广告的清单里（例如换了 agent / agent 更新过）→ 宁可不切，
 *   也别把 agent 弄成报错状态；界面那边也会回落到「默认」。
 */
async function applyAcpModel(
  entry: AcpSessionEntry,
  modelId: string | null | undefined,
): Promise<void> {
  if (!modelId) return;
  const selector = entry.modelSelector;
  if (!selector || selector.current === modelId) return;
  if (!selector.options.some((option) => option.value === modelId)) return;
  const cx = entry.cx;
  const sessionId = sessionIdOf(entry);
  if (!cx || !sessionId) return;
  try {
    const response = await cx.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId,
        configId: selector.configId,
        value: modelId,
      },
    );
    // 响应带回完整的 configOptions（改一项可能影响别的项），以它为准
    entry.modelSelector = pickModelSelector(response?.configOptions) ?? {
      ...selector,
      current: modelId,
    };
    console.log(`[acp] 模型已切到 ${modelId}`);
  } catch (err) {
    // agent 不支持 / 拒绝：只记日志，别把整轮打断
    console.warn(`[acp] 切换模型失败（${modelId}）：`, err);
  }
}

/**
 * 把会话记住的**权限档**下发给 agent（`session/set_mode`，opencode 用它）。
 *
 * 幂等：与 entry 当前档一致就直接返回 —— load 之后 agent 恰好已恢复用户选的档时，
 * 不会多发一次请求；被 agent 重置了则这一轮开始前自动补回。
 * 静默跳过：没选 / agent 没广告档位 / 选的值不在清单里。失败只记日志，不打断整轮。
 */
async function applyAcpMode(
  entry: AcpSessionEntry,
  modeId: string | null | undefined,
): Promise<void> {
  if (!modeId) return;
  const modeOption = entry.modeOptionSelector;
  const inSessionModes = entry.availableModes.some((m) => m.id === modeId);
  const inModeOption = !!modeOption?.options.some((o) => o.value === modeId);
  if (!inSessionModes && !inModeOption) return;
  // 幂等：已经是这个档就不发请求
  if (
    inSessionModes
      ? entry.currentModeId === modeId
      : modeOption?.current === modeId
  )
    return;
  const cx = entry.cx;
  const sessionId = sessionIdOf(entry);
  if (!cx || !sessionId) return;
  try {
    if (inSessionModes) {
      // 规范通道：session/new 的 modes 字段
      await cx.request(acp.methods.agent.session.setMode, {
        sessionId,
        modeId,
      });
      entry.currentModeId = modeId;
    } else if (modeOption) {
      // configOptions 通道（opencode 的 category='mode'）
      const response = await cx.request(
        acp.methods.agent.session.setConfigOption,
        {
          sessionId,
          configId: modeOption.configId,
          value: modeId,
        },
      );
      entry.modeOptionSelector = pickModeOptionSelector(
        response?.configOptions,
      ) ?? { ...modeOption, current: modeId };
    }
    console.log(`[acp] 模式已切到 ${modeId}`);
  } catch (err) {
    console.warn(`[acp] 切换模式失败（${modeId}）：`, err);
  }
}

/**
 * 把会话记住的**思考档**下发给 agent（`session/set_config_option`，`pi` 用它）。
 * 幂等 / 静默跳过语义同 `applyAcpMode`。
 */
async function applyAcpThoughtLevel(
  entry: AcpSessionEntry,
  value: string | null | undefined,
): Promise<void> {
  if (!value) return;
  const selector = entry.thoughtLevelSelector;
  if (!selector || selector.current === value) return;
  if (!selector.options.some((o) => o.value === value)) return;
  const cx = entry.cx;
  const sessionId = sessionIdOf(entry);
  if (!cx || !sessionId) return;
  try {
    const response = await cx.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId,
        configId: selector.configId,
        value,
      },
    );
    entry.thoughtLevelSelector = pickThoughtLevelSelector(
      response?.configOptions,
    ) ?? { ...selector, current: value };
    console.log(`[acp] 思考档已切到 ${value}`);
  } catch (err) {
    console.warn(`[acp] 切换思考档失败（${value}）：`, err);
  }
}

/**
 * 读某个会话上外部 agent 能选的模型。
 *
 * 会**建立会话**（spawn 出 agent 进程）—— 代价与发一条消息相同。
 */
export async function listAcpModels(opts: {
  agent: AcpAgentConfig;
  conversationId: string;
  workspacePath: string;
}): Promise<AcpModelChoices> {
  const entry = getOrCreateEntry(opts);
  const session = await ensureSession(entry, opts.workspacePath, opts.agent);
  entry.modelSelector =
    entry.modelSelector ??
    pickModelSelector(session.newSessionResponse?.configOptions);
  const selector = entry.modelSelector;
  return selector
    ? {
        configId: selector.configId,
        current: selector.current,
        options: selector.options,
      }
    : { configId: null, current: null, options: [] };
}

/**
 * 探针：只问一次「这个 agent 能选哪些模型」，**问完就把进程收掉**。
 *
 * 设置页用它列候选（用户挑几个放进会话下拉）。用一次性会话而不是常驻，是因为
 * 设置页的探测与任何具体会话无关 —— 让一个 agent 进程为了「看一眼清单」常驻着不值当。
 * 失败（命令不存在 / 不是 ACP agent）时抛错，由调用方决定怎么呈现。
 */
export async function probeAcpModels(opts: {
  agent: AcpAgentConfig;
  /** agent 进程的 cwd；不给就用主目录（探测不需要真实项目） */
  workspacePath?: string;
}): Promise<AcpModelChoices> {
  const conversationId = `probe::${opts.agent.id}`;
  const key = `${opts.agent.id}::${conversationId}`;
  try {
    return await listAcpModels({
      agent: opts.agent,
      conversationId,
      workspacePath: opts.workspacePath?.trim() || homedir(),
    });
  } finally {
    teardown(key);
  }
}

/**
 * 探针的完整结果：模型清单 + agent 广告的档位（模式 / 思考档）。
 *
 * 「开始新对话」页在**建会话之前**选中 ACP agent 时要的就是这份 —— 输入框上方那排 pill
 * 的数据本来只存在会话配置里（`conversation.acpModes` / `acpThoughtLevel`），没有会话就
 * 什么都画不出来。所以先问一次，用户选好的档位等真正建会话之后再下发（见 `applyAcpMode`）。
 */
export interface AcpProbeResult {
  models: AcpModelChoices;
  /** agent 广告的 Session Modes 快照；没广告则 null */
  modes: AcpModesState | null;
  /** agent 广告的思考档快照；没广告则 null */
  thoughtLevel: AcpThoughtLevelState | null;
}

/**
 * 探针：这个 agent 的**完整能力**（模型 + 模式 / 思考档），问完把进程收掉。
 *
 * 与 `probeAcpModels` 是同一次会话、同一份 `session/new` 应答 —— 只是多返回了
 * `snapshotOf(entry)` 那一半（档位），别为它再起一次进程。
 */
export async function probeAcpCapabilities(opts: {
  agent: AcpAgentConfig;
  /** agent 进程的 cwd；不给就用主目录（探测不需要真实项目） */
  workspacePath?: string;
}): Promise<AcpProbeResult> {
  const conversationId = `probe::${opts.agent.id}`;
  const key = `${opts.agent.id}::${conversationId}`;
  const workspacePath = opts.workspacePath?.trim() || homedir();
  try {
    const entry = getOrCreateEntry({
      agent: opts.agent,
      conversationId,
      workspacePath,
    });
    const session = await ensureSession(entry, workspacePath, opts.agent);
    entry.modelSelector =
      entry.modelSelector ??
      pickModelSelector(session.newSessionResponse?.configOptions);
    const selector = entry.modelSelector;
    return {
      models: selector
        ? {
            configId: selector.configId,
            current: selector.current,
            options: selector.options,
          }
        : { configId: null, current: null, options: [] },
      ...snapshotOf(entry),
    };
  } finally {
    teardown(key);
  }
}

/** agent 侧既有会话的展示信息（session/list 的一行，只留界面需要的字段） */
export interface AcpSessionInfo {
  sessionId: string;
  /** 会话的工作目录（导入时按它对上 Fizz 的项目） */
  cwd: string;
  title?: string;
  /** ISO 8601 的最近活动时间 */
  updatedAt?: string;
}

/**
 * 拉 agent 侧的既有会话清单（`session/list`），**问完就把进程收掉**。
 *
 * 能力感知：协议里 session/list 是可选能力 —— 只有 agent 在 initialize 时广告了
 * `sessionCapabilities.list` 才可用，没广告返回 `supported: false`（界面据此隐藏导入）。
 * `cwd` 是 agent 侧按会话工作目录过滤；opencode 等按项目组织会话的 agent 正好用它
 * 实现「这个项目下有哪些会话」。
 *
 * 分页（nextCursor）暂不处理：会话清单量级用不上，后续要接分页再加。
 */
export async function listAcpSessions(opts: {
  agent: AcpAgentConfig;
  /** 按会话工作目录过滤；不给 = 拉全部 */
  cwd?: string;
}): Promise<{ supported: boolean; sessions: AcpSessionInfo[] }> {
  // 探针进程的 cwd 用主目录：列出会话不需要真实项目，过滤交给 session/list 的 cwd 参数
  const proc = spawnCommand(
    opts.agent.command,
    opts.agent.args ?? [],
    homedir(),
  );
  try {
    const input = Writable.toWeb(proc.stdin!) as WritableStream;
    const output = Readable.toWeb(proc.stdout!) as ReadableStream;
    return await new Promise<{
      supported: boolean;
      sessions: AcpSessionInfo[];
    }>((resolve, reject) => {
      proc.once("error", (err: Error) => reject(err));
      void acp
        .client({ name: "Fizz Server" })
        .onRequest(acp.methods.client.session.requestPermission, async () => {
          // 清单探测不跑对话，理论上不会有权限请求；万一来了就按取消答，别挂住
          throw new Error("list 探针不支持权限请求");
        })
        .connectWith(acp.ndJsonStream(input, output), async (ctx) => {
          try {
            const init = await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: { session: { configOptions: {} } },
              clientInfo: { name: "Fizz Server", version: "0.1.0" },
            });
            if (!init.agentCapabilities?.sessionCapabilities?.list) {
              resolve({ supported: false, sessions: [] });
              return;
            }
            const response = await ctx.request(
              acp.methods.agent.session.list,
              opts.cwd ? { cwd: opts.cwd } : {},
            );
            resolve({
              supported: true,
              sessions: response.sessions.map((s) => ({
                sessionId: s.sessionId,
                cwd: s.cwd,
                ...(s.title ? { title: s.title } : {}),
                ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
              })),
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        })
        .catch((err: unknown) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
    });
  } finally {
    killProcessTree(proc);
  }
}

/**
 * 删掉 agent 侧的既有会话（`session/delete`），**问完就把进程收掉**。
 *
 * 能力感知：与 session/list 一样是可选能力 —— 只有 agent 在 initialize 时广告了
 * `sessionCapabilities.delete` 才可用，没广告返回 `{ ok: false, supported: false }`
 * （界面据此提示「只删了本地」）。调用方（删除会话弹窗）勾了「同时删除 agent 侧会话」
 * 才会走到这里；agent 侧删除失败时本地会话照删（不把用户卡死在删不掉的会话上）。
 */
export async function deleteAcpSession(opts: {
  agent: AcpAgentConfig;
  sessionId: string;
}): Promise<{ ok: boolean; supported: boolean }> {
  // 探针进程的 cwd 用主目录：删除会话不需要真实项目目录
  const proc = spawnCommand(
    opts.agent.command,
    opts.agent.args ?? [],
    homedir(),
  );
  try {
    const input = Writable.toWeb(proc.stdin!) as WritableStream;
    const output = Readable.toWeb(proc.stdout!) as ReadableStream;
    return await new Promise<{ ok: boolean; supported: boolean }>(
      (resolve, reject) => {
        proc.once("error", (err: Error) => reject(err));
        void acp
          .client({ name: "Fizz Server" })
          .onRequest(acp.methods.client.session.requestPermission, async () => {
            // 删除探针不跑对话，理论上不会有权限请求；万一来了就按取消答，别挂住
            throw new Error("delete 探针不支持权限请求");
          })
          .connectWith(acp.ndJsonStream(input, output), async (ctx) => {
            try {
              const init = await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: { session: { configOptions: {} } },
                clientInfo: { name: "Fizz Server", version: "0.1.0" },
              });
              if (!init.agentCapabilities?.sessionCapabilities?.delete) {
                resolve({ ok: false, supported: false });
                return;
              }
              await ctx.request(acp.methods.agent.session.delete, {
                sessionId: opts.sessionId,
              });
              resolve({ ok: true, supported: true });
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })
          .catch((err: unknown) =>
            reject(err instanceof Error ? err : new Error(String(err))),
          );
      },
    );
  } finally {
    killProcessTree(proc);
    // 本地这条会话若还挂着常驻 entry（进程 / load 通道绑着同一个 sessionId），
    // agent 侧会话已删，entry 里留着的上下文已失效 —— 一并收掉，免得下一轮拿着
    // 已删除的 sessionId 去续。
    for (const key of [...sessions.keys()]) {
      const entry = sessions.get(key);
      if (entry && sessionIdOf(entry) === opts.sessionId) teardown(key);
    }
  }
}

/** 会话交互来源的 sessionId（ActiveSession 或 load 恢复的通道，二选一） */
function sessionIdOf(entry: AcpSessionEntry): string | null {
  return entry.loadedSource?.sessionId ?? entry.session?.sessionId ?? null;
}

/**
 * ACP 的权限请求 → 原样转给用户挑。
 *
 * **选项不做任何映射**：agent 在 `session/request_permission` 里给什么选项
 * （optionId / name / kind 四种标准值），界面就渲染什么；用户点了哪个，
 * 哪个 optionId 原样回给 agent。问不问、怎么问，策略完全在 agent 侧。
 *
 * 正文同样只认协议里的展示字段：
 * - `title`（`ToolCall.title` / `ToolCallUpdate.title`）—— 规范定义的
 *   「Human-readable title describing what the tool is doing」，就是给用户看的；
 * - `name` → 工具名（规范里的「programmatic name」，没有才退回 `kind`）。
 *
 * **不读 `rawInput` 拼 JSON**：规范里它是「原始入参」，没有任何面向用户的形态约定，
 * 各家 agent 的键名与嵌套完全不同（`{command, description}` / `{cmd}` / `{argv[]}`），
 * 猜字段只会猜错；展示文案的责任在 agent 的 `title` 上。
 *
 * ⚠️ 唯一必须自己补的是**增量合并**：`requestPermission.toolCall` 是 `ToolCallUpdate`，
 * 协议明说「除 `toolCallId` 外全部可选，只带变化的字段」。CodeBuddy 就只给
 * `toolCallId`，名字 / 标题全在前面那条 `tool_call` 里 —— 不回查 `turn.toolCalls`
 * 的话卡片上只剩「工具调用」四个字。
 */
async function handlePermission(
  entry: AcpSessionEntry,
  params: acp.RequestPermissionRequest,
): Promise<acp.RequestPermissionResponse> {
  const options: AgentConfirmOption[] = (params.options ?? []).map(
    (option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }),
  );
  const cancelled: acp.RequestPermissionResponse = {
    outcome: { outcome: "cancelled" },
  };
  const selected = (
    optionId: string | undefined,
  ): acp.RequestPermissionResponse =>
    optionId ? { outcome: { outcome: "selected", optionId } } : cancelled;
  /** 拒绝类（reject_once / reject_always）里挑一个：给「按拒绝收场」的场合用 */
  const pickReject = (): string | undefined =>
    options.find(
      (option) =>
        option.kind === "reject_once" || option.kind === "reject_always",
    )?.optionId;

  const turn = entry.turn;
  const requestPermission = turn?.requestPermission;
  if (!requestPermission) {
    // 没有审批通道（例如无人值守的 API 调用）→ 按拒绝收场，而不是放行
    return selected(pickReject());
  }

  // 这里是增量更新：缺的字段回查本轮 tool_call 的记忆（CodeBuddy 只给 toolCallId）
  const toolCall = params.toolCall;
  const toolCallId = toolCall.toolCallId ?? "";
  const known = toolCallId ? turn.toolCalls.get(toolCallId) : undefined;
  // 协议：本次没带的字段视为「没变化」，取回查到的上一份
  const title = acpTitle(toolCall.title) ?? known?.title ?? "";
  const kind = (typeof toolCall.kind === "string" && toolCall.kind) || known?.kind;
  // 工具名优先用 agent 的程序化名（`ToolCall.name`），没有才退回 `kind`
  const name = acpName(toolCall.name) ?? known?.name;
  // 选项原样透传：界面渲染的就是 agent 给的这组（名字 / 性质都不动）
  const confirm: Omit<AgentConfirmRequest, "id" | "requestId"> = {
    toolCallId,
    toolName: acpToolName(name ?? kind),
    // 正文就是规范里的展示标题；缺失时留空串，前端据此不渲染空 `<pre>`
    command: title,
    workspaceId: entry.agentId,
    workspaceName: undefined,
    ...(options.length ? { options } : {}),
  };

  const timeoutMs = turn.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const reply =
    timeoutMs > 0
      ? await Promise.race([
          requestPermission(confirm),
          new Promise<AgentPermissionReply>((resolve) =>
            setTimeout(() => resolve({ approved: false }), timeoutMs),
          ),
        ])
      : await requestPermission(confirm);

  // 用户点了 agent 给的某个选项：原样回传；只答了布尔 approved：允许 → 挑第一个
  // 允许类选项（没有明确允许类就选第一项），拒绝 / 超时 → 挑第一个拒绝类选项。
  // ⚠️ 只认 optionId 会把「approved: true 但没点具体选项」的答复（内置审批卡、
  // CLI、端到端脚本都这么发）错杀成拒绝。
  const pickAllow = (): string | undefined =>
    options.find(
      (option) =>
        option.kind === "allow_once" || option.kind === "allow_always",
    )?.optionId ?? options[0]?.optionId;

  if (reply.optionId) return selected(reply.optionId);
  if (reply.approved) return selected(pickAllow());
  return selected(pickReject());
}

/** 会话就绪时回传给调用方的信息（`session/new` 建成 或 `session/load` 恢复后） */
export interface AcpSessionReadyInfo {
  /** agent 侧的 session id */
  sessionId: string;
  /** agent 广告的 Session Modes 快照；没广告则 null */
  modes: AcpModesState | null;
  /** agent 广告的思考档快照；没广告则 null */
  thoughtLevel: AcpThoughtLevelState | null;
}

/**
 * 提前为某个会话建立 agent 侧会话（`session/new`）并返回运行态快照。
 *
 * 新建会话时由服务端调用：**先建会话、拿到 sessionId 与档位，再落库** —— session/new
 * 可能失败（命令不存在 / 不是 ACP agent），失败要能让整个「新建会话」不留下半成品。
 * 失败时抛错，调用方负责 `abortAcpTurn(agent.id, conversationId)` 清理已 spawn 的进程。
 */
export async function createAcpSession(opts: {
  agent: AcpAgentConfig;
  conversationId: string;
  workspacePath: string;
}): Promise<AcpSessionReadyInfo> {
  const entry = getOrCreateEntry({
    agent: opts.agent,
    conversationId: opts.conversationId,
    workspacePath: opts.workspacePath,
  });
  const session = await ensureSession(entry, opts.workspacePath, opts.agent);
  return { sessionId: session.sessionId, ...snapshotOf(entry) };
}

export interface RunAcpAgentOptions {
  workspace: AgentWorkspace;
  history: AgentChatMessage[];
  agent: AcpAgentConfig;
  conversationId: string;
  requestId: string;
  /** 审批超时（毫秒）；0 = 不超时。缺省 10 分钟 */
  confirmTimeoutMs?: number;
  /** 会话记住的模型（agent 广告的 configOptions 里的一项值）；空 = 用它的默认 */
  modelId?: string;
  /** 会话记住的权限档（opencode 的 Session Modes）；空 = 用它的默认 */
  modeId?: string;
  /** 会话记住的思考档（pi 的 thought_level configOption）；空 = 用它的默认 */
  thoughtLevel?: string;
  onEvent?: (event: AgentStreamEvent) => void;
  /**
   * ACP 权限请求的审批通道：agent 给的选项原样上送界面，用户挑中的 optionId 原样回传。
   * 不传 = 无人值守，权限请求一律按拒绝收场（挑第一个 reject 类选项；没有则 cancelled）。
   */
  requestPermission?: (req: AgentConfirmInput) => Promise<AgentPermissionReply>;
  signal?: AbortSignal;
  /**
   * 绑定的 agent 侧 session id（会话记录里的 acpSessionId）。给了它且进程/会话
   * 还没活起来时，用 `session/load` 恢复上下文而不是 `session/new` —— 停止 / 重启
   * 之后对话不再失忆。没有（或 agent 不支持 load）就退回 session/new。
   */
  loadSessionId?: string;
  /**
   * **会话就绪**时回传信息（`session/new` 建成，或 `session/load` 恢复之后）——
   * 聊天路由用它把 acp 会话与 agent 侧 session 绑定、并把广告的档位写回会话配置。
   *
   * - `session/new` 建成 → 触发（带刚广告的 modes / thought）；
   * - `session/load` 恢复 → 也触发（档位可能被 agent 重置成默认，界面据此刷新）；
   * - 进程 / 会话复用（都还活着）→ 不触发（运行态没变）。
   */
  onSessionCreated?: (info: AcpSessionReadyInfo) => void;
}

/**
 * 取得（必要时建立）某条会话的常驻 entry：进程 + 会话状态都挂在这上面。
 *
 * 两个入口共用：跑一轮（runAcpAgent）与只读地问一次「有哪些模型可选」（listAcpModels）——
 * 后者也需要真会话（模型清单是 agent 在 `session/new` 里给的）。
 */
function getOrCreateEntry(opts: {
  agent: AcpAgentConfig;
  conversationId: string;
  workspacePath: string;
}): AcpSessionEntry {
  const key = `${opts.agent.id}::${opts.conversationId}`;
  let entry = sessions.get(key);
  if (
    entry &&
    (entry.proc.exitCode !== null || entry.proc.signalCode !== null)
  ) {
    teardown(key);
    entry = undefined;
  }
  if (entry) return entry;
  // 「任务」会话没有工作区目录：agent 进程的 cwd 兜底到主目录
  const proc = spawnCommand(
    opts.agent.command,
    opts.agent.args ?? [],
    opts.workspacePath || homedir(),
  );
  entry = {
    agentId: opts.agent.id,
    conversationId: opts.conversationId,
    proc,
    session: null,
    cx: null,
    availableModes: [],
    currentModeId: null,
    modelSelector: null,
    thoughtLevelSelector: null,
    modeOptionSelector: null,
    closeConnection: null,
    loadedSource: null,
    chain: Promise.resolve(),
    turn: null,
  };
  sessions.set(key, entry);
  proc.on("exit", (code, signal) => {
    // 进程自己退了（崩溃 / 命令不存在）：会话不可复用，下一轮重建
    if (sessions.get(key) === entry) sessions.delete(key);
    /**
     * 半路死掉的进程也要**把错误交给正在等消息的轮次**：`LoadedTurnSource` 那条路的
     * `nextUpdate()` 是我们自己实现的，进程退出不会让 SDK 拒掉挂起的等待 —— 不喊一声，
     * 界面就一直停在「思考中」，直到用户手动停止。
     * （`session/new` 那条路走 SDK 的队列 + 中止时的 `abortGate`，这里只管 load 通道。）
     */
    entry.loadedSource?.fail(
      new Error(
        `agent 进程已退出（${signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`}）`,
      ),
    );
  });
  return entry;
}

/**
 * 跑一轮 ACP 对话（与 `runAgent` 同签名语义：事件回调 + 终态返回）。
 *
 * ⚠️ 中止 = **杀掉 agent 进程**（ACP 的 session/cancel 在桌面端也没用）：
 * 代价是这一条会话的多轮上下文会丢（下次提问重建会话），与桌面端一致。
 */
export async function runAcpAgent(
  opts: RunAcpAgentOptions,
): Promise<RunAgentResult> {
  const emit = (event: AgentStreamEvent): void => opts.onEvent?.(event);
  /** 会话键（与 `getOrCreateEntry` 里的算法一致）：中止时要用它 teardown */
  const key = `${opts.agent.id}::${opts.conversationId}`;
  // 打开会话的回放还在跑时先等它收场：回放会 teardown + 重建 entry，这期间发出去的一轮
  // 若插在中间，会拿到一个正在被拆掉的进程 / 二次 `session/load`（两个窗口同时打开同一
  // 会话时最容易撞上）。回放失败也照常往下走 —— 下面会按干净状态重建。
  await replaying.get(key)?.catch(() => undefined);
  const current = getOrCreateEntry({
    agent: opts.agent,
    conversationId: opts.conversationId,
    workspacePath: opts.workspace.path,
  });
  const text = lastUserText(opts.history);
  if (!text) {
    emit({ type: "error", message: "没有要发送的内容" });
    emit({ type: "finish", finishReason: "error" });
    return { finishReason: "error", error: "没有要发送的内容" };
  }

  const run = async (): Promise<RunAgentResult> => {
    /**
     * 本轮耗时的起点 —— 记在 `run` 内部而不是函数入口：上面那段 `current.chain` 排队
     * 是在等**上一轮**结束，用户点完发送后排队等着不算「在工作」。
     *
     * 只有 finish 帧会带它（`durationMs`）：ACP 没有 token 用量，做不出 `TurnUsage`，
     * 前端靠这个数在折叠条抬头报「已工作 N 秒」（见 `AgentChatMessage.durationMs`）。
     */
    const turnStartedAt = Date.now();
    const elapsedMs = (): number => Math.max(0, Date.now() - turnStartedAt);
    /**
     * 本轮内按 toolCallId 攒入参：agent 可能先发一半、后面 update 里再补全（见 mergeAcpInput）。
     * 挂在 turn 上而不是只做局部变量：`session/request_permission` 只带 toolCallId，
     * 审批卡要按它回查名字 / 参数（见 handlePermission）。
     */
    const inputMemory: AcpInputMemory = new Map();
    current.turn = {
      requestId: opts.requestId,
      toolCalls: inputMemory,
      ...(opts.confirmTimeoutMs !== undefined
        ? { confirmTimeoutMs: opts.confirmTimeoutMs }
        : {}),
      ...(opts.requestPermission
        ? { requestPermission: opts.requestPermission }
        : {}),
      onEvent: emit,
    };
    /**
     * ⚠️ 中止必须能**打断 `await`**，不能只在两条消息之间检查。
     *
     * 原来只有循环顶部那句 `if (opts.signal?.aborted) break` —— agent 卡住时
     * （网络不通 / 等登录 / 死循环）`session.nextUpdate()` 永远不返回，循环再也回不到
     * 那行判断，**超时与中止全都形同虚设**。
     *
     * 实测：给了超时，75s 后 agent 仍在跑、这一轮永远不结束，只能手动杀进程。
     * 桌面端「停止」按钮同理：服务端 `chatAbort` 里那句「只发 signal 不够
     * （agent 进程还在跑），要连会话一起拆掉」就是在绕这个坑。
     *
     * 所以两件事一起做：
     *   1. `teardown()` 杀掉 agent 进程（不杀就是留一个再也管不住的孤儿进程）；
     *   2. 用一个 gate 把 `nextUpdate()` race 掉 —— 不去赌「进程被杀后 SDK 会不会把挂起的
     *      nextUpdate 拒掉」，自己保证一定跳得出来。
     */
    let releaseAbortGate: (() => void) | null = null;
    const abortGate = new Promise<null>((resolve) => {
      releaseAbortGate = () => resolve(null);
    });
    const onAbort = (): void => {
      if (sessions.get(key) === current) teardown(key);
      releaseAbortGate?.();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      // 会话来源三选一（prompt / nextUpdate 同形，轮次循环不区分）：
      // 1. 已加载的（打开会话时 load 过）→ 直接复用；
      // 2. 进程 / 会话还活着 → 直接复用活会话（**不做 load**：load 会在同一进程上二次建连）；
      // 3. 绑定了 sessionId 但进程 / 会话已没 → session/load 恢复上下文（停止 / 重启后不失忆）；
      //    load 回放的历史在轮次前 drain 掉 —— 视图由打开会话时的 transcript 端点负责；
      //    load 失败（agent 不支持 / 会话已失效）→ 退回 session/new。
      let source: acp.ActiveSession | LoadedTurnSource;
      const liveSource = current.loadedSource ?? current.session;
      if (liveSource) {
        source = liveSource;
      } else if (opts.loadSessionId) {
        try {
          source = await loadTurnSource(
            current,
            opts.agent,
            opts.workspace.path,
            opts.loadSessionId,
          );
          source.drainAll();
          // 档位也可能在 load 回包里被刷新（甚至被 agent 重置）：回写会话，界面据此更新
          opts.onSessionCreated?.({
            sessionId: opts.loadSessionId,
            ...snapshotOf(current),
          });
        } catch (err) {
          // agent 不支持 `session/load`（或该会话在 agent 侧已不存在）：退回 session/new，
          // 否则整轮会直接报错。ensureSession 会复用此刻已建立的连接，不再二次建连。
          console.warn(
            `[acp:${opts.agent.name}] session/load 失败，退回 session/new：${describeError(err)}`,
          );
          source = await ensureSession(
            current,
            opts.workspace.path,
            opts.agent,
            opts.onSessionCreated,
          );
        }
      } else {
        source = await ensureSession(
          current,
          opts.workspace.path,
          opts.agent,
          opts.onSessionCreated,
        );
      }
      // 会话记住的模型 / 权限档 / 思考档在 prompt 前依次下发（没选 / 不支持则静默跳过）。
      // 这一步同时覆盖 `session/load` 之后的场景：agent 可能把档位重置成默认，
      // 这里按会话配置（用户意图）幂等补回；权限请求本身仍由 agent 的策略决定。
      await applyAcpModel(current, opts.modelId);
      await applyAcpMode(current, opts.modeId);
      await applyAcpThoughtLevel(current, opts.thoughtLevel);
      /**
       * 不 await prompt：它在整轮结束才 resolve，内容是靠 nextUpdate() 逐条取的。
       *
       * ⚠️ 这个 `.catch` 会**吞掉** prompt 的 rejection —— 所以「这一轮失败」必须由 source
       * 自己推进 `nextUpdate()` 的队列：SDK 的 `ActiveSession` 失败时内部会 `updates.reject`，
       * 而 `session/load` 那条手写通道靠 `LoadedTurnSource.fail`（prompt 的 catch 里调）。
       * 少了它，下面那句 `await ... nextUpdate()` 会永远挂着 —— 界面一直「思考中」。
       */
      void source.prompt(text).catch(() => undefined);
      for (;;) {
        if (opts.signal?.aborted) break;
        const message = await Promise.race([source.nextUpdate(), abortGate]);
        // null = 被中止（abortGate 先落地）
        if (!message) break;
        if (message.kind === "stop") {
          const cancelled = message.stopReason === "cancelled";
          emit({
            type: "finish",
            finishReason: cancelled ? "aborted" : "done",
            durationMs: elapsedMs(),
          });
          return { finishReason: cancelled ? "aborted" : "done" };
        }
        const events = toAcpStreamEvent(
          message.update as unknown as {
            sessionUpdate: string;
            [key: string]: unknown;
          },
          inputMemory,
        );
        for (const event of events) emit(event);
      }
      emit({ type: "finish", finishReason: "aborted", durationMs: elapsedMs() });
      return { finishReason: "aborted" };
    } catch (err) {
      const message = describeError(err);
      if (opts.signal?.aborted) {
        emit({ type: "finish", finishReason: "aborted", durationMs: elapsedMs() });
        return { finishReason: "aborted" };
      }
      emit({ type: "error", message });
      emit({ type: "finish", finishReason: "error", durationMs: elapsedMs() });
      return { finishReason: "error", error: message };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      current.turn = null;
      if (opts.signal?.aborted) teardown(key);
    }
  };

  // 同会话串行：排队等上一轮结束（两个客户端同时提问也不会并发踩同一条会话）
  const queued = current.chain.then(run, run);
  current.chain = queued.catch(() => undefined);
  return queued;
}

/** 中止某个会话正在跑的轮次（杀进程 + 关连接） */
export function abortAcpTurn(agentId: string, conversationId: string): void {
  teardown(`${agentId}::${conversationId}`);
}

/**
 * 增量接进**本步内最近的一条同类型 part**（工具调用是边界）。
 *
 * 与 `@fizz/contracts/types` 的 `appendPartDelta` 同一口径，这里不能 import 它：
 * ACP 是外部协议层，`check:boundaries` 不许它反向依赖 contracts（只能 `import type`）。
 *
 * 为什么不能只接「最后一条」：agent 会把思考与正文**交替**流出来（`[思考两字][正文三字]…`），
 * 只认最后一条时那一轮就落成十几条几字长的 part —— 渲染端按「连续同类 part 成组」画，
 * 于是每段思考各成一个「思考过程」分组、一段话被拆成十几段，整轮结束后除最后一小段正文，
 * 其余全被收进折叠条。
 */
function appendDeltaPart(
  parts: AgentMessagePart[],
  type: "text" | "reasoning",
  delta: string,
): AgentMessagePart[] {
  if (!delta) return parts;
  const next = [...parts];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const part = next[index];
    if (!part) continue;
    if (part.type === "tool-call" || part.type === "tool-result") break;
    if (part.type !== type) continue;
    next[index] = { type, text: part.text + delta };
    return next;
  }
  next.push({ type, text: delta });
  return next;
}

/**
 * 一帧流事件折进 parts（与 app/api/chat 里 onEvent 的折叠同一套语义）。
 * 回放专用：把 toAcpStreamEvent 的输出攒成可渲染的消息。
 */
function foldReplayPart(
  parts: AgentMessagePart[],
  event: AgentStreamEvent,
): AgentMessagePart[] {
  if (event.type === "text-delta" || event.type === "reasoning-delta") {
    return appendDeltaPart(
      parts,
      event.type === "text-delta" ? "text" : "reasoning",
      event.delta,
    );
  }
  if (event.type === "tool-call") {
    const index = parts.findIndex(
      (p) => p.type === "tool-call" && p.toolCallId === event.toolCallId,
    );
    if (index >= 0) {
      const call = parts[index] as Extract<
        AgentMessagePart,
        { type: "tool-call" }
      >;
      const next = [...parts];
      next[index] = {
        ...call,
        toolName:
          call.toolName && call.toolName !== ACP_UNNAMED_TOOL
            ? call.toolName
            : event.toolName,
        input: { ...(call.input ?? {}), ...(event.input ?? {}) },
        ...(event.acpKind || call.acpKind
          ? { acpKind: event.acpKind ?? call.acpKind }
          : {}),
        ...(event.acpContent || call.acpContent
          ? { acpContent: event.acpContent ?? call.acpContent }
          : {}),
        ...(event.title || call.title
          ? { title: event.title ?? call.title }
          : {}),
      };
      return next;
    }
    return [
      ...parts,
      {
        type: "tool-call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        ...(event.acpKind ? { acpKind: event.acpKind } : {}),
        ...(event.acpContent ? { acpContent: event.acpContent } : {}),
        ...(event.title ? { title: event.title } : {}),
      },
    ];
  }
  if (event.type === "tool-result") {
    const index = parts.findIndex(
      (p) => p.type === "tool-call" && p.toolCallId === event.toolCallId,
    );
    if (index >= 0) {
      const next = [...parts];
      next[index] = {
        ...next[index],
        output: event.output,
        ...(event.isError ? { isError: true } : {}),
      } as AgentMessagePart;
      return next;
    }
    return [
      ...parts,
      {
        type: "tool-result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
        ...(event.isError ? { isError: true } : {}),
      },
    ];
  }
  return parts;
}

/**
 * 打开会话时的视图恢复：`session/load` 的回放 → **结构化消息**（含用户消息，
 * 界面直接 setMessages 渲染）。
 *
 * 先拆掉该会话可能还活着的 entry（刷新前 / 别的标签页留下的）：回放必须从干净的
 * 进程 + `session/load` 开始 —— ActiveSession 不回放历史，没有它的进程收不到回放。
 * 代价是每次打开都会重拉一次 agent 进程（加载完它就常驻，后续轮次复用）。
 *
 * ⚠️ 用户消息要自己接：`toAcpStreamEvent` 只认 agent_message_chunk / 工具那几种
 * （实时轮次里用户消息由本地负责，转换函数里被忽略），但 load 回放会带上
 * `user_message_chunk` —— 不接的话重建出来的视图缺用户那一半，观感像坏了。
 * 上下文占用（`context-usage`）也在这里挂到助手消息上（`contextUsage`），
 * 回放里带 `usage_update` 的 agent 刷新后圆环才恢复。
 *
 * load 失败（agent 没广告 loadSession 能力 / 会话已失效）会抛错：半活的 entry 一并
 * 清掉，下一轮能干净地重建。
 */
export async function replayAcpSession(opts: {
  agent: AcpAgentConfig;
  conversationId: string;
  workspacePath: string;
  sessionId: string;
}): Promise<AgentChatMessage[]> {
  // **同一个会话的回放必须合流**：两个窗口（桌面端「在新窗口打开」/ 两个标签页）同时
  // 打开同一会话时，两边都会拉 transcript，而 `replayAcpSessionOnce` 第一件事是
  // `teardown(key)` —— 先到的进程刚起来就被后到的拆掉，先到的 `connectEntry` 拿到一个
  // 已死的子进程，用户侧看到的就是「ACP 连接失败」。
  // 合流后两边拿同一份回放结果；`teardown` 只发生一次。
  const key = `${opts.agent.id}::${opts.conversationId}`;
  const inflight = replaying.get(key);
  if (inflight) return inflight;
  const task = replayAcpSessionOnce(opts);
  replaying.set(key, task);
  // 单独挂一个 catch：`task` 本身会被调用方 await；这里只为避免 finally 派生出的
  // rejected promise 变成 unhandled rejection。
  void task
    .catch(() => undefined)
    .finally(() => {
      if (replaying.get(key) === task) replaying.delete(key);
    });
  return task;
}

/**
 * 回放的在途表（key = `agentId::conversationId`，与 `sessions` 同口径）。
 *
 * ⚠️ 不能只靠 `activating` 那张表：它只管「切档自动激活」，打开会话走的是
 * `replayAcpSession`，两条路各拉各的进程会互相 `teardown`。并发发消息同理，见
 * `runAcpAgent` 开头那句 await。
 */
const replaying = new Map<string, Promise<AgentChatMessage[]>>();

async function replayAcpSessionOnce(opts: {
  agent: AcpAgentConfig;
  conversationId: string;
  workspacePath: string;
  sessionId: string;
}): Promise<AgentChatMessage[]> {
  teardown(`${opts.agent.id}::${opts.conversationId}`);
  const entry = getOrCreateEntry({
    agent: opts.agent,
    conversationId: opts.conversationId,
    workspacePath: opts.workspacePath,
  });
  const source = await loadTurnSource(
    entry,
    opts.agent,
    opts.workspacePath,
    opts.sessionId,
  );
  const inputMemory: AcpInputMemory = new Map();
  const messages: AgentChatMessage[] = [];
  const now = Date.now();
  let seq = 0;
  /**
   * 用户消息按 ACP 的 `messageId` 分组（协议：同一条消息的所有 chunk 共享同一 id，
   * id 变化 = 新消息开始）。实测 opencode 会带它，且「两条连续的用户消息」id 不同 ——
   * 只按「上一条是不是 user」合并会把它们粘成一条。缺 messageId 的 agent 退回
   * 保守合并（连续同角色 chunk 视为同一条）。工具类 update 没有 messageId。
   *
   * 助手消息**刻意不按 messageId 拆条**（见下面循环里的注释）：一轮 = 一条助手消息。
   */
  let userMid: string | null = null;

  const drained = source.drainAll();

  for (const message of drained) {
    if (message.kind !== "session_update") continue;
    const raw = message.update as unknown as {
      sessionUpdate: string;
      [key: string]: unknown;
    };
    const mid = typeof raw.messageId === "string" ? raw.messageId : null;
    if (raw.sessionUpdate === "user_message_chunk") {
      const content = raw.content as
        { type?: string; text?: string } | undefined;
      if (content?.type !== "text" || typeof content.text !== "string")
        continue;
      const last = messages[messages.length - 1];
      const sameGroup =
        last?.role === "user" &&
        (mid === null ? userMid === null : userMid === mid);
      if (sameGroup) {
        const part = last.parts[last.parts.length - 1];
        if (part?.type === "text") part.text += content.text;
        else last.parts.push({ type: "text", text: content.text });
      } else {
        messages.push({
          id: `u-replay-${++seq}`,
          role: "user",
          parts: [{ type: "text", text: content.text }],
          createdAt: now,
        });
        userMid = mid;
      }
      continue;
    }
    const events = toAcpStreamEvent(raw, inputMemory);
    if (!events.length) continue;
    // 助手侧不按 messageId 拆条：一轮 = 一条助手消息（与流式时的本地占位消息同构）。
    // agent 一轮里会产出多段文本（动手前的说明 / 中途小结 / 最终结论），每段的
    // messageId 都不同 —— 按 id 拆会把同一轮拆成多条助手消息，前端按消息收
    // 「过程折叠条」时一轮就冒出多个折叠条，中途文本还裸露在折叠条外面。
    // 两条用户消息之间的所有 assistant update 都归入同一条助手消息。
    const last = messages[messages.length - 1];
    let target = last?.role === "assistant" ? last : undefined;
    for (const event of events) {
      // 上下文占用不是消息内容：挂到当前助手消息的 `contextUsage` 上（回放里带它，
      // 刷新后圆环才能恢复）。还没有助手消息就先不挂 —— 不为它单独造一条空消息。
      if (event.type === "context-usage") {
        if (target)
          target.contextUsage = { used: event.used, size: event.size };
        continue;
      }
      if (!target) {
        target = {
          id: `a-replay-${++seq}`,
          role: "assistant",
          parts: [],
          createdAt: now,
        };
        messages.push(target);
      }
      target.parts = foldReplayPart(target.parts, event);
    }
  }
  return messages;
}
