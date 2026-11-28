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
 * 技能 / 系统提示词 / 模型配置 / ask 都不参与；
 * 权限也不映射 —— agent 发 `session/request_permission` 时把它给的选项
 * （optionId / name / kind）原样转给用户挑，挑中的 optionId 原样回传。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import {
  resolveAcpFactory,
  type AcpAuthMethod,
  type AcpConnection,
  type AcpElicitationReply,
  type AcpElicitationRequest,
  type AcpMcpServer,
  type AcpPermissionReply,
  type AcpPermissionRequest,
  type AcpSessionInfo,
  type AcpTurnSource,
} from "./protocol";

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

/**
 * 把「附件说明 + 图片 + 正文」组装成 `session/prompt` 的内容块。
 *
 * 顺序：说明 → 图片 → 正文。与内置会话的 `buildUserParts`（附件在前、文本在后）同序，
 * 也让「哪张图没带上」的那句提示成为 agent 读到的第一句。
 *
 * 这里**不校验** agent 收不收图：能力判定在调用方（`getAcpImageSupport`），
 * 传进来就发 —— agent 若真不收，`session/prompt` 会以 JSON-RPC error 收场并照常上抛。
 */
export function buildPromptBlocks(
  opts: Pick<RunAcpAgentOptions, "attachments" | "attachmentNote">,
  text: string,
): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = [];
  const note = opts.attachmentNote?.trim();
  if (note) blocks.push({ type: "text", text: note });
  for (const file of opts.attachments ?? []) {
    blocks.push({
      type: "image",
      mimeType: file.mediaType,
      data: Buffer.from(file.data).toString("base64"),
    });
  }
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
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
      /**
       * 工具结果里的图片（读图 / 截图这类工具回的是 `ContentBlock::Image`）。
       *
       * ⚠️ 上限比正文图片更严：工具调用**每次 update 都重发全量 content**，同一个
       * base64 会在整轮执行里被反复推给所有客户端（SSE 帧 × N）。超限就换成一句说明，
       * 否则一张 6MB 的图能把界面卡住。正文那路的 `acpImageEvent` 只到一次，可以放宽。
       */
      if (block?.type === "image") {
        const mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
        const data = typeof block.data === "string" ? block.data : "";
        if (!mimeType.startsWith("image/") || !data) continue;
        out.push({
          type: "content",
          content:
            data.length > MAX_TOOL_IMAGE_CHARS
              ? {
                  type: "text",
                  text: `（工具回传了一张 ${mimeType} 图片，超过内联上限，已省略）`,
                }
              : { type: "image", mimeType, data },
        });
        continue;
      }
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
 * 一部分（opencode 的 shell 就只给了 `cwd`），完整参数在后面 `tool_call_update` 里补。
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
 * agent 回传图片的体积上限（按 **base64 字符数**算，约 6MB 原图）。
 *
 * 为什么这里和「用户发的图」用两套口径：用户那张是**已经落盘的文件 + 一个小 URL**，
 * 而这张要经 SSE 一帧推给所有打开的客户端、还要常驻服务端快照（内存）。再大就只能
 * 让 agent 把文件写进工作区、由它自己用文件工具读。
 */
const MAX_INLINE_IMAGE_CHARS = 8 * 1024 * 1024;

/**
 * 工具结果图片的内联上限（base64 字符数，约 3MB 原图）——比正文那路更严。
 *
 * 原因在 `normalizeAcpContent` 的注释里：工具调用每次 update 都重发**全量 content**，
 * 同一张图的 base64 会在整轮执行里被反复推给所有客户端。
 */
const MAX_TOOL_IMAGE_CHARS = 4 * 1024 * 1024;

/** `image/jpeg` → `jpg`；认不出来的一律 png（只用于下载时的文件名） */
const imageExt = (mimeType: string): string =>
  mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length) || "png";

/**
 * `ContentBlock::Image` → 一条 `file-part` 事件（agent 回传的多模态输出）。
 *
 * 图片在协议里是**整块**到达的（不像文本那样分片），所以一条 block 就是一张图，
 * 折叠成一条 `file` part 正好与用户附件同形 —— 渲染端一个 `FilePartView` 通吃。
 *
 * 认不出的形态（没有 mimeType / data 不是字符串 / 不是 image/*）一律丢弃：
 * 硬塞一条坏图只会让消息流里出现一块「图片加载失败」。
 */
function acpImageEvent(content: {
  type?: string;
  data?: unknown;
  mimeType?: unknown;
}): AgentStreamEvent | undefined {
  if (content.type !== "image") return undefined;
  const mimeType = typeof content.mimeType === "string" ? content.mimeType : "";
  const data = typeof content.data === "string" ? content.data : "";
  if (!mimeType.startsWith("image/") || !data) return undefined;
  if (data.length > MAX_INLINE_IMAGE_CHARS) {
    // 说清楚「少看到了什么」，别让它无声消失（与附件超限同一条口径）
    return {
      type: "text-delta",
      delta: `\n\n（agent 回传了一张 ${mimeType} 图片，超过内联上限，已省略）\n\n`,
    };
  }
  // 少数 agent 会把 `data:` 前缀一起塞进 data（协议只要求裸 base64），两种都认
  const url = data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
  return {
    type: "file-part",
    url,
    mediaType: mimeType,
    name: `image.${imageExt(mimeType)}`,
  };
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
        | { type?: string; text?: string; data?: unknown; mimeType?: unknown }
        | undefined;
      if (content?.type === "text" && typeof content.text === "string") {
        return [{ type: "text-delta", delta: content.text }];
      }
      // 多模态输出：agent 在正文流里回传的图片（截图工具 / 生成图）。丢弃它就是
      // 「agent 说『图在下面』但下面什么都没有」，这是用户报的那条。
      if (content?.type === "image") {
        const image = acpImageEvent(content);
        return image ? [image] : [];
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
  /**
   * spawn 失败原因（命令不存在 / cwd 不存在）。`getOrCreateEntry` 一建好进程就挂
   * `'error'` 监听并记在这里，`connectAdapter` 建连前先查 —— 两者之间隔着轮次排队，
   * 不记下来的话错误事件早于监听器到达，又会变成未捕获异常。
   */
  spawnError: Error | null;
  /**
   * agent 进程的 cwd（会话所属工作区；探针场景给主目录）。
   * 留着是为了 spawn 失败时能说清「是命令的问题还是目录的问题」——见 `describeSpawnError`。
   */
  cwd: string;
  /** 协议版本无关的连接（v1 / v2 由 adapter 决定；初始化 / 切配置都走它） */
  connection: AcpConnection | null;
  /**
   * 本轮的交互来源（`session/new` 建出来的 ActiveSession，或 `session/load` /
   * `session/resume` 恢复出来的手写队列）。新建 / 恢复二选一，轮次循环不区分。
   */
  source: AcpTurnSource | null;
  /** 上次成功 new/load 时的 MCP 配置摘要；不保存或打印明文凭据。 */
  mcpConfigHash: string | null;
  /**
   * Agent 广告的模式（旧 ACP Session Modes，可选能力）与当前值。
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
  /** null / 未收到与完整配置中明确缺少某项必须分开处理。 */
  configOptionsKnown: boolean;
  /** 服务端订阅这条常驻会话的配置变化，空闲时也同步到会话清单。 */
  onConfigOptionsChanged?: () => void;
  /**
   * agent 广告的「模式选择器」（configOptions 的 `category: 'mode'`，**opencode 用它**）。
   *
   * 与老式的 `availableModes`（`session/new.modes` 字段）是**两种并存**的通道；快照
   * 优先取老式那个（`snapshotOf`），取不到才用这里。null = agent 不走 configOptions 通道。
   */
  modeOptionSelector: AcpModeOptionSelector | null;
  /**
   * agent 在 `initialize` 里广告的**输入形态能力**（`promptCapabilities`）。
   *
   * `image: true` 才代表它收 `ContentBlock::Image`；缺省 / 未广告 = **不保证**收，
   * 所以界面上的回形针按「不广告就不显示」处理（见 `getAcpImageSupport`）。
   * null = 这条连接还没 initialize 完。
   */
  promptCapabilities: acp.PromptCapabilities | null;
  /** initialize 里广告的登录方式（空 = 不需要认证） */
  authMethods: AcpAuthMethod[];
  /** 建立 / 最近一次活动时间：空闲回收与诊断用 */
  createdAt: number;
  lastActiveAt: number;
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
    /** agent 发起结构化追问（elicitation）；缺省 = 一律 decline */
    requestElicitation?: (
      req: AcpElicitationRequest,
    ) => Promise<AcpElicitationReply>;
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

/** server / 键值项顺序不影响配置，stdio 参数顺序则必须保留。 */
function mcpConfigHash(servers: AcpMcpServer[] = []): string {
  const pairs = (items: { name: string; value: string }[]) =>
    items.map(({ name, value }) => JSON.stringify([name, value])).sort();
  const normalized = servers.map((server) => JSON.stringify(
    server.type === "stdio"
      ? [server.type, server.name, server.command, server.args, pairs(server.env)]
      : [server.type, server.name, server.url, pairs(server.headers)],
  )).sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * ACP agent 进程空闲多久后回收。
 *
 * 常驻进程是「下一轮复用」的前提，但开过的会话没人关就会一直挂着 —— 一轮结束后
 * 不主动拆。这里兜住「开过就忘」的那批：超过 10 分钟没有任何活动、且当前没有轮次，
 * 就 teardown；下一轮再按 `session/load` 重建（上下文不丢）。
 */
const ACP_IDLE_TIMEOUT_MS = 10 * 60_000;
const ACP_IDLE_SWEEP_MS = 60_000;
let acpIdleTimer: NodeJS.Timeout | null = null;

/**
 * agentId → 是否收 `ContentBlock::Image`（`initialize` 里探测，**不过期**）。
 *
 * 单独一份而不是从 `sessions` 里翻：会话会被 teardown（停止 / 进程崩溃 / 空闲回收），
 * 但「这个 agent 吃不吃图」是**工艺参数**，不该跟着某条会话的生死反复探测。
 * 未探测过的 agent 没有条目（`getAcpImageSupport` 返回 undefined）。
 */
const imageSupportByAgent = new Map<string, boolean>();

/**
 * 某个 ACP agent 是否收图片输入：`true` / `false` = agent 明确广告过，
 * `undefined` = 还没连过（或连接没走完 initialize）。
 *
 * 调用方（服务端列表 / 发送校验）按三态处理：**未知 ≠ 不支持** —— 界面可以乐观显示，
 * 发送时再按 agent 的真实回应收场。
 */
export function getAcpImageSupport(agentId: string): boolean | undefined {
  return imageSupportByAgent.get(agentId);
}

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
 * 从 `configOptions` 按能力挑出思考档（OpenCode、pi 等均可提供）。
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
function updateConfigOptions(entry: AcpSessionEntry, raw: unknown[] | null | undefined): boolean {
  if (!Array.isArray(raw)) return false;
  const before = JSON.stringify([entry.configOptionsKnown, entry.modelSelector, entry.thoughtLevelSelector, entry.modeOptionSelector]);
  const options = raw as acp.SessionConfigOption[];
  entry.configOptionsKnown = true;
  entry.modelSelector = pickModelSelector(options);
  entry.thoughtLevelSelector = pickThoughtLevelSelector(options);
  entry.modeOptionSelector = pickModeOptionSelector(options);
  if (before !== JSON.stringify([true, entry.modelSelector, entry.thoughtLevelSelector, entry.modeOptionSelector])) {
    entry.onConfigOptionsChanged?.();
  }
  return true;
}

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

/**
 * 探针的 cwd：给过来的路径**不是现存目录**就退回主目录。
 *
 * 为什么必须判：`/api/acp/agents/:id/models`、`/capabilities` 两个接口把「登记表里第一个
 * 工作区」当 cwd 传进来，而登记表里常年躺着已经被删掉的「临时会话」（scratch，目录在
 * `<数据目录>/conversations/<年月日>/<会话 id>`，会话一删目录就没了）。目录不存在时 `spawn` 报的是
 * **`spawn codebuddy ENOENT`** —— libuv 在 chdir 失败时也回 ENOENT，而报错里只有命令名，
 * 看着像「命令没装 / 系统坏了」。用户侧的表现是：**设置页里所有 ACP agent 都拉不到模型，
 * 换一台数据目录干净的机器（比如服务器）又全好**。
 *
 * 探针不需要真实项目，退回主目录即可（与 `ensureSession` 里「任务会话没有工作区」一致）。
 */
export function resolveProbeCwd(path?: string): string {
  const given = path?.trim();
  if (given) {
    try {
      if (statSync(given).isDirectory()) return given;
    } catch {
      // 目录没了（工作区被删 / 路径是远端主机的 POSIX 路径），落到主目录
    }
  }
  return homedir();
}

/**
 * ACP 启动失败：`message` 只放一行结论，完整命令 / 工作目录留在 `detail`。
 *
 * 模型选择器位置窄，把路径塞进 message 会变成「加载失败 + 启动失败 + 路径」三截；
 * 设置页检测 / 排查时再把 detail 展开。
 */
export class AcpSpawnError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = "AcpSpawnError";
    this.detail = detail;
  }
}

/**
 * spawn 失败时把「命令 + 工作目录」补进报错里。
 *
 * Node 对 `spawn(xxx)` 只给一句 `spawn xxx ENOENT`，而 ENOENT 有两种完全不同的原因：
 * 命令不在 PATH 上，**或者 cwd 不存在**（见 `resolveProbeCwd` 的注释）。不补这一句，
 * 排查方向会被「命令名」带偏（去查 PATH、重装 CLI、怀疑系统）。
 */
export function describeSpawnError(
  err: Error,
  command: string,
  cwd: string,
): Error {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") return err;
  let cwdExists = false;
  try {
    cwdExists = statSync(cwd).isDirectory();
  } catch {
    cwdExists = false;
  }
  return new AcpSpawnError(
    cwdExists
      ? `启动 ${command} 失败：命令不存在或无法执行`
      : `启动 ${command} 失败：工作目录不存在`,
    `命令：${command}\n工作目录：${cwd}`,
  );
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
  entry.connection?.close();
  killProcessTree(entry.proc);
}

/** 服务端退出前清理：不留孤儿 agent 进程 */
export function disposeAcpSessions(): void {
  if (acpIdleTimer) {
    clearInterval(acpIdleTimer);
    acpIdleTimer = null;
  }
  for (const key of [...sessions.keys()]) teardown(key);
}

/** 当前常驻的 ACP 进程快照（诊断 / `GET /api/acp/sessions` 用） */
export interface AcpProcessInfo {
  agentId: string;
  conversationId: string;
  pid: number | null;
  /** agent 侧会话 id；还没建立会话时为 null */
  sessionId: string | null;
  /** 有一轮正在跑（空闲回收会跳过它） */
  running: boolean;
  /** 进程还活着（没退出 / 没被 kill） */
  alive: boolean;
  /** 距最近一次活动过了多久（毫秒） */
  idleMs: number;
  /** 这个进程从建立到现在多久（毫秒） */
  uptimeMs: number;
}

/**
 * 列出所有常驻 ACP 进程。
 *
 * 只读快照，不触发任何清理；面板 / curl 用它确认「开过的会话是不是都还挂着」。
 * 空闲回收的计时器只在第一条会话建立时启动，避免模块加载即起定时器。
 */
export function listAcpProcesses(): AcpProcessInfo[] {
  const now = Date.now();
  return [...sessions.values()].map((entry) => ({
    agentId: entry.agentId,
    conversationId: entry.conversationId,
    pid: entry.proc.pid ?? null,
    sessionId: sessionIdOf(entry),
    running: entry.turn !== null,
    alive: entry.proc.exitCode === null && !entry.proc.killed,
    idleMs: Math.max(0, now - entry.lastActiveAt),
    uptimeMs: Math.max(0, now - entry.createdAt),
  }));
}

/** 启动空闲回收（幂等；第一条 ACP 会话建立时调用） */
function ensureAcpIdleTimer(): void {
  if (acpIdleTimer) return;
  acpIdleTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of sessions) {
      // 有轮次在跑 / 正在等审批时绝不回收：`turn` 非空代表这条会话仍被占用
      if (entry.turn) continue;
      if (now - entry.lastActiveAt < ACP_IDLE_TIMEOUT_MS) continue;
      teardown(key);
    }
  }, ACP_IDLE_SWEEP_MS);
  // 别让这个定时器把服务端进程吊住（CLI / 测试进程尤其需要）
  acpIdleTimer.unref?.();
}

/**
 * 建立到 agent 进程的协议连接（v1 / v2 由 `agent.protocolVersion` 决定），并完成
 * initialize。连接生命周期 = 会话生命周期，挂到 entry 上直到 teardown。
 *
 * session/new（ensureSession）与恢复会话（loadTurnSource）共用这一段。
 */
async function connectAdapter(
  entry: AcpSessionEntry,
  agent: AcpAgentConfig,
): Promise<AcpConnection> {
  if (entry.spawnError) throw entry.spawnError;
  const proc = entry.proc;
  const toAgent = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
  const fromAgent = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  proc.stderr?.on("data", (chunk) => {
    console.error(`[acp:${agent.name}] ${String(chunk).trimEnd()}`);
  });

  const factory = resolveAcpFactory(agent.protocolVersion);
  const key = `${entry.agentId}::${entry.conversationId}`;
  /**
   * spawn 失败（命令不存在 / 没有执行权限）只会以 `'error'` 事件抛出：ChildProcess 上
   * 没人监听它 = 未捕获异常，会把整个 server 进程带走。
   *
   * ⚠️ 监听器**不能在建连成功后摘掉**：`factory.connect()` 只是把流包起来，会在同一
   * 微任务里就 resolve，而 spawn 的 `'error'` 是下一轮事件循环才来 —— 之前用
   * `proc.off('error')` 正好把唯一的监听器摘掉了，于是 `spawn codebuddy ENOENT`
   * 直接把 server 打崩。监听器跟着进程走，进程死了才失效。
   */
  let spawnError: Error | null = null;
  let rejectSpawn!: (err: Error) => void;
  const spawnFailed = new Promise<never>((_, reject) => {
    rejectSpawn = reject;
  });
  // 建连 / initialize 都结束后 error 仍可能来；先挂个 catch，免得变成 unhandledRejection
  spawnFailed.catch(() => undefined);
  const onError = (err: Error): void => {
    spawnError = describeSpawnError(err, agent.command, entry.cwd);
    if (sessions.get(key) === entry) sessions.delete(key);
    entry.source?.fail?.(spawnError);
    rejectSpawn(spawnError);
  };
  proc.on("error", onError);
  const connection = await Promise.race([
    new Promise<AcpConnection>((resolve, reject) => {
      void factory
        .connect({
          toAgent,
          fromAgent,
          handlers: {
            onConfigOptions: (sessionId, options) => {
              if (sessions.get(key) === entry && entry.source?.sessionId === sessionId) {
                updateConfigOptions(entry, options);
              }
            },
            onPermission: (req) => handlePermission(entry, req),
            onElicitation: (req) =>
              entry.turn?.requestElicitation?.(req) ??
              Promise.resolve<AcpElicitationReply>({ action: "decline" }),
            onElicitationComplete: (id) => {
              console.log(`[acp:${agent.name}] elicitation ${id} 已完成`);
            },
          },
        })
        .then(resolve)
        .catch((err: unknown) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
    }),
    spawnFailed,
  ]);
  entry.connection = connection;
  // initialize 也要和 spawn 错误赛跑：进程起不来时请求可能永远等不到回包
  const init = await Promise.race([connection.initialize(), spawnFailed]);
  if (spawnError) throw spawnError;
  entry.authMethods = init.authMethods;
  entry.promptCapabilities =
    init.promptImage === null
      ? null
      : ({ image: init.promptImage } as acp.PromptCapabilities);
  if (typeof init.promptImage === "boolean") {
    imageSupportByAgent.set(entry.agentId, init.promptImage);
  }
  return connection;
}

async function ensureSession(
  entry: AcpSessionEntry,
  /** agent 进程的 cwd（会话所属工作区；探针场景给主目录） */
  workspacePath: string,
  agent: AcpAgentConfig,
  onSessionCreated?: (info: AcpSessionReadyInfo) => void,
  mcpServers: AcpMcpServer[] = [],
): Promise<AcpTurnSource> {
  if (entry.source) return entry.source;
  // 复用可能已经建立的连接（恢复会话失败后连接仍活着），避免在同一进程上重复建连
  const connection =
    entry.connection ?? (await connectAdapter(entry, agent));
  // 「任务」会话没有工作区目录：ACP agent 仍要一个合法 cwd，落到主目录
  const result = await connection.newSession(workspacePath || homedir(), mcpServers);
  entry.source = result.source;
  entry.mcpConfigHash = mcpConfigHash(mcpServers);
  const configOptions = (result.configOptions as acp.SessionConfigOption[] | null) ?? null;
  updateConfigOptions(entry, configOptions);
  // 旧 Session Modes（可选能力）：只记录，切换走 setAcpSessionMode
  entry.availableModes = (result.modes?.availableModes ?? []) as acp.SessionMode[];
  entry.currentModeId = result.modes?.currentModeId ?? null;
  if (entry.availableModes.length) {
    console.log(
      `[acp:${agent.name}] 可用档位：${entry.availableModes.map((m) => `${m.id}(${m.name})`).join(", ")}；当前 ${entry.currentModeId}`,
    );
  }
  // 可选模型（可选能力）：agent 在 configOptions 里广告，切换见 applyAcpModel
  entry.modelSelector = pickModelSelector(configOptions as acp.SessionConfigOption[] | null);
  if (entry.modelSelector) {
    console.log(
      `[acp:${agent.name}] 可选模型：${entry.modelSelector.options.map((o) => `${o.value}(${o.name})`).join(", ")}；当前 ${entry.modelSelector.current}`,
    );
  }
  // 可选思考档（`pi` 用它）：同一份 configOptions 里 category='thought_level'
  entry.thoughtLevelSelector = pickThoughtLevelSelector(configOptions as acp.SessionConfigOption[] | null);
  if (entry.thoughtLevelSelector) {
    console.log(
      `[acp:${agent.name}] 思考档：${entry.thoughtLevelSelector.options.map((o) => `${o.value}(${o.name})`).join(", ")}；当前 ${entry.thoughtLevelSelector.current}`,
    );
  }
  // 可选「模式」（configOptions 的 `category: 'mode'`，**opencode 用它**）
  entry.modeOptionSelector = pickModeOptionSelector(configOptions as acp.SessionConfigOption[] | null);
  if (entry.modeOptionSelector) {
    console.log(
      `[acp:${agent.name}] 模式（configOptions）：${entry.modeOptionSelector.options.map((o) => `${o.value}(${o.name})`).join(", ")}；当前 ${entry.modeOptionSelector.current}`,
    );
  }
  // 会话就绪回调放在最后：此刻档位 / 模型 / 思考档 / 模式都已记录
  onSessionCreated?.({ sessionId: result.source.sessionId, ...snapshotOf(entry) });
  return result.source;
}

/**
 * 用 `session/load`（v1）/ `session/resume`（v2）恢复一个**绑定的既有会话**：agent 侧按
 * sessionId 找回自己的上下文，历史以 session/update 回放进队列。加载完顺手把响应里的
 * configOptions / modes 补进各选择器（与 session/new 对齐）。
 */
async function loadTurnSource(
  entry: AcpSessionEntry,
  agent: AcpAgentConfig,
  workspacePath: string,
  sessionId: string,
  mcpServers: AcpMcpServer[] = [],
): Promise<AcpTurnSource> {
  let connection: AcpConnection;
  try {
    connection = entry.connection ?? (await connectAdapter(entry, agent));
  } catch (err) {
    throw new Error(`Agent 启动或连接失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const result = await connection.resumeSession(sessionId, workspacePath || homedir(), mcpServers)
    .catch((err: unknown) => {
      throw new Error(`原会话历史加载失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    });
  entry.source = result.source;
  entry.mcpConfigHash = mcpConfigHash(mcpServers);
  const configOptions = (result.configOptions as acp.SessionConfigOption[] | null) ?? null;
  updateConfigOptions(entry, configOptions);
  // 恢复响应里同样可能带旧 Session Modes：没有记录过就补上
  if (result.modes?.availableModes?.length && entry.availableModes.length === 0) {
    entry.availableModes = result.modes.availableModes as acp.SessionMode[];
    entry.currentModeId = result.modes.currentModeId ?? null;
  }
  return result.source;
}

/**
 * 查某个 ACP 会话的模式（优先 configOptions，兼容旧 Session Modes）。
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
  const modes = snapshotOf(entry).modes;
  return {
    supported: !!modes?.available.length,
    modes: modes?.available ?? [],
    currentModeId: modes?.current ?? null,
  };
}

/** 从 entry 组装界面用的运行态快照（modes / thoughtLevel）；两者都可能为 null */
function snapshotOf(entry: AcpSessionEntry): {
  modes: AcpModesState | null;
  thoughtLevel: AcpThoughtLevelState | null;
} {
  const modeOption = entry.modeOptionSelector;
  const modes: AcpModesState | null = modeOption
    ? {
        available: modeOption.options.map((o) => ({
          id: o.value,
          name: o.name,
          ...(o.description ? { description: o.description } : {}),
        })),
        current: modeOption.current,
        configId: modeOption.configId,
      }
    : entry.availableModes.length
      ? {
          available: entry.availableModes.map((m) => ({
            id: m.id,
            ...(m.name ? { name: m.name } : {}),
            ...(m.description ? { description: m.description } : {}),
          })),
          current: entry.currentModeId,
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
  configOptionsKnown: boolean;
} | null {
  const entry = sessions.get(`${agentId}::${conversationId}`);
  return entry ? { ...snapshotOf(entry), configOptionsKnown: entry.configOptionsKnown } : null;
}

/** 每条常驻会话只保留一个持久化监听器；刷新时替换，不累积订阅。 */
export function setAcpSessionConfigListener(agentId: string, conversationId: string, listener: () => void): void {
  const entry = sessions.get(`${agentId}::${conversationId}`);
  if (entry) entry.onConfigOptionsChanged = listener;
}

/**
 * 「未激活就切档」时自动激活所需的信息（mode / thought-level 路由从会话与工作区记录拼出）。
 */
export interface AcpActivateInfo {
  agent: AcpAgentConfig;
  workspacePath: string;
  mcpServers?: AcpMcpServer[];
  /** 恢复后先应用会话选中的模型，再验证它当前支持的模式或思考档。 */
  modelId?: string;
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
      // 活会话不能重复 load，尤其不能在生成期因切档请求重放它。
      if (entry.source) return;
      try {
        if (info.loadSessionId) {
          try {
            await loadTurnSource(
              entry,
              info.agent,
              info.workspacePath,
              info.loadSessionId,
              info.mcpServers,
            );
          } catch (err) {
            // agent 不支持 load / 会话已失效：退回 session/new（与轮次路径同一套兜底）
            console.warn(
              `[acp:${info.agent.name}] 自动激活的 session/load 失败，退回 session/new：${describeError(err)}`,
            );
            entry.source = null;
            await ensureSession(entry, info.workspacePath, info.agent, undefined, info.mcpServers);
          }
        } else {
          await ensureSession(entry, info.workspacePath, info.agent, undefined, info.mcpServers);
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
  if (!entry || !entry.connection) {
    return "自动激活会话失败（进程没能建立）";
  }
  return null;
}

/**
 * 切换 ACP 会话模式，优先 configOptions，缺少它时兼容旧 Session Modes：
 * - configOptions 的 `category: 'mode'` → `session/set_config_option`；
 * - 没有以上能力时才兼容旧 Session Modes（`session/new.modes`）→ `session/set_mode`。
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
  if (!entry || !entry.connection) {
    return {
      ok: false,
      error: "会话未激活（先在会话里发一条消息，或重新打开会话）",
    };
  }
  // 恢复出来的会话（load / resume）source 的 sessionId 就是绑定的那个
  const sessionId = entry.source?.sessionId ?? activate?.loadSessionId;
  if (!sessionId) {
    return {
      ok: false,
      error: "会话未激活（先在会话里发一条消息，或重新打开会话）",
    };
  }
  const connection = entry.connection;
  const change = async (): Promise<{ ok: boolean; error?: string }> => {
    if (sessions.get(key) !== entry) return { ok: false, error: "会话状态已变化，请稍后重试" };
    // 空闲时先恢复所选模型，并与模型 / 思考档共用串行链；生成中保留即时切模式能力。
    if (!entry.turn) await applyAcpModel(entry, activate?.modelId);
    const modeOption = entry.modeOptionSelector;
    const inSessionModes = !modeOption && entry.availableModes.some((m) => m.id === modeId);
    if (!inSessionModes && !modeOption?.options.some((o) => o.value === modeId)) {
      return { ok: false, error: "这个 agent 没有这个模式" };
    }
    try {
      if (inSessionModes) {
        await connection.setMode(sessionId, modeId);
        entry.currentModeId = modeId;
      } else if (modeOption) {
        const configOptions = await connection.setConfigOption(sessionId, modeOption.configId, modeId);
        if (!updateConfigOptions(entry, configOptions)) {
          entry.modeOptionSelector = { ...(entry.modeOptionSelector ?? modeOption), current: modeId };
          entry.onConfigOptionsChanged?.();
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  };
  if (entry.turn) return change();
  const queued = entry.chain.then(change, change);
  entry.chain = queued.catch(() => undefined);
  return queued;
}

/**
 * 按 agent 广告的能力切换思考档；运行中拒绝，空闲配置与 prompt 共用串行链。
 * 与 `setAcpSessionMode` 同形：会话未激活时给 `activate` 则自动激活；agent 拒绝 / 值不存在时返回 ok: false。
 */
export async function setAcpSessionThoughtLevel(
  agentId: string,
  conversationId: string,
  value: string,
  activate?: AcpActivateInfo,
): Promise<{ ok: boolean; error?: string }> {
  const key = `${agentId}::${conversationId}`;
  if (sessions.get(key)?.turn) return { ok: false, error: "当前轮次正在生成，请结束后再切换思考档" };
  if (activate) {
    const err = await ensureActivated(agentId, conversationId, activate);
    if (err) return { ok: false, error: err };
  }
  const entry = sessions.get(key);
  if (entry?.turn) return { ok: false, error: "当前轮次正在生成，请结束后再切换思考档" };
  if (!entry || !entry.connection) {
    return {
      ok: false,
      error: "会话未激活（先在会话里发一条消息，或重新打开会话）",
    };
  }
  const sessionId = entry.source?.sessionId ?? activate?.loadSessionId;
  if (!sessionId) {
    return {
      ok: false,
      error: "会话未激活（先在会话里发一条消息，或重新打开会话）",
    };
  }
  const connection = entry.connection;
  const change = async (): Promise<{ ok: boolean; error?: string }> => {
    if (sessions.get(key) !== entry || entry.turn) return { ok: false, error: "会话状态已变化，请稍后重试" };
    await applyAcpModel(entry, activate?.modelId);
    const selector = entry.thoughtLevelSelector;
    if (!selector) return { ok: false, error: "这个 agent 不支持思考档" };
    if (!selector.options.some((option) => option.value === value)) return { ok: false, error: "当前模型不支持这个思考档" };
    try {
      const configOptions = await connection.setConfigOption(sessionId, selector.configId, value);
      if (!updateConfigOptions(entry, configOptions)) {
        entry.thoughtLevelSelector = { ...(entry.thoughtLevelSelector ?? selector), current: value };
        entry.onConfigOptionsChanged?.();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  };
  const queued = entry.chain.then(change, change);
  entry.chain = queued.catch(() => undefined);
  return queued;
}

/** 空闲会话立即换模型并刷新关联能力；生成中的选择留到下一轮统一应用。 */
export async function setAcpSessionModel(
  agentId: string,
  conversationId: string,
  modelId: string,
  activate?: AcpActivateInfo,
): Promise<{ ok: boolean; deferred?: boolean; error?: string }> {
  const key = `${agentId}::${conversationId}`;
  if (sessions.get(key)?.turn) return { ok: true, deferred: true };
  if (activate) {
    const error = await ensureActivated(agentId, conversationId, activate);
    if (error) return { ok: false, error };
  }
  const entry = sessions.get(key);
  if (!entry?.connection) return { ok: false, error: "会话未激活" };
  const change = async (): Promise<{ ok: boolean; deferred?: boolean; error?: string }> => {
    if (sessions.get(key) !== entry || entry.turn) return { ok: true, deferred: true };
    if (!entry.modelSelector?.options.some((option) => option.value === modelId)) {
      return { ok: false, error: "这个 agent 不支持所选模型" };
    }
    await applyAcpModel(entry, modelId);
    return entry.modelSelector?.current === modelId
      ? { ok: true }
      : { ok: false, error: "切换模型失败" };
  };
  const queued = entry.chain.then(change, change);
  entry.chain = queued.catch(() => undefined);
  return queued;
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
  const connection = entry.connection;
  const sessionId = sessionIdOf(entry);
  if (!connection || !sessionId) return;
  try {
    const configOptions = await connection.setConfigOption(
      sessionId,
      selector.configId,
      modelId,
    );
    // 响应带回完整的 configOptions（改一项可能影响别的项），以它为准
    if (!updateConfigOptions(entry, configOptions)) {
      entry.modelSelector = { ...(entry.modelSelector ?? selector), current: modelId };
      entry.onConfigOptionsChanged?.();
    }
    console.log(`[acp] 模型已切到 ${modelId}`);
  } catch (err) {
    // agent 不支持 / 拒绝：只记日志，别把整轮打断
    console.warn(`[acp] 切换模型失败（${modelId}）：`, err);
  }
}

/**
 * 把会话记住的模式按实际能力通道下发给 Agent，不按类型猜测。
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
  const inSessionModes = !modeOption && entry.availableModes.some((m) => m.id === modeId);
  const inModeOption = !!modeOption?.options.some((o) => o.value === modeId);
  if (!inSessionModes && !inModeOption) return;
  // 幂等：已经是这个档就不发请求
  if (
    inSessionModes
      ? entry.currentModeId === modeId
      : modeOption?.current === modeId
  )
    return;
  const connection = entry.connection;
  const sessionId = sessionIdOf(entry);
  if (!connection || !sessionId) return;
  try {
    if (inSessionModes) {
      // 规范通道：session/new 的 modes 字段
      await connection.setMode(sessionId, modeId);
      entry.currentModeId = modeId;
    } else if (modeOption) {
      // configOptions 通道（opencode 的 category='mode'）
      const configOptions = await connection.setConfigOption(
        sessionId,
        modeOption.configId,
        modeId,
      );
      if (!updateConfigOptions(entry, configOptions)) {
        entry.modeOptionSelector = { ...(entry.modeOptionSelector ?? modeOption), current: modeId };
        entry.onConfigOptionsChanged?.();
      }
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
  const connection = entry.connection;
  const sessionId = sessionIdOf(entry);
  if (!connection || !sessionId) return;
  try {
    const configOptions = await connection.setConfigOption(
      sessionId,
      selector.configId,
      value,
    );
    if (!updateConfigOptions(entry, configOptions)) {
      entry.thoughtLevelSelector = { ...(entry.thoughtLevelSelector ?? selector), current: value };
      entry.onConfigOptionsChanged?.();
    }
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
  await ensureSession(entry, opts.workspacePath, opts.agent);
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
      workspacePath: resolveProbeCwd(opts.workspacePath),
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
  /** agent 广告的登录方式（空 = 不需要认证） */
  authMethods: AcpAuthMethod[];
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
  modelId?: string;
}): Promise<AcpProbeResult> {
  const conversationId = `probe::${opts.agent.id}::${randomUUID()}`;
  const key = `${opts.agent.id}::${conversationId}`;
  const workspacePath = resolveProbeCwd(opts.workspacePath);
  try {
    const entry = getOrCreateEntry({
      agent: opts.agent,
      conversationId,
      workspacePath,
    });
    await ensureSession(entry, workspacePath, opts.agent);
    await applyAcpModel(entry, opts.modelId);
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
      authMethods: entry.authMethods,
    };
  } finally {
    teardown(key);
  }
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
/**
 * 拉起一个一次性探针连接（list / delete 用）：spawn + adapter.connect + initialize。
 * 调用方负责 finally 里 `connection.close()` + `killProcessTree(proc)`。
 */
async function openProbeConnection(
  agent: AcpAgentConfig,
): Promise<{ connection: AcpConnection; proc: ChildProcess }> {
  // 探针进程的 cwd 用主目录：列 / 删会话不需要真实项目
  const proc = spawnCommand(agent.command, agent.args ?? [], homedir());
  const toAgent = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
  const fromAgent = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const factory = resolveAcpFactory(agent.protocolVersion);
  /**
   * 与 connectAdapter 同样的理由：监听器必须跟进程活到底。`connect()` 会比 spawn 的
   * `'error'` 先 resolve，`once` 一旦在别处被摘掉（或未来有人加 off）就又会崩 server。
   */
  let rejectSpawn!: (err: Error) => void;
  const spawnFailed = new Promise<never>((_, reject) => {
    rejectSpawn = reject;
  });
  spawnFailed.catch(() => undefined);
  proc.on("error", (err: Error) => {
    rejectSpawn(describeSpawnError(err, agent.command, homedir()));
  });
  try {
    const connection = await Promise.race([
      new Promise<AcpConnection>((resolve, reject) => {
        void factory
          .connect({
            toAgent,
            fromAgent,
            // 探针不跑对话，理论上不会有权限请求；万一来了就按拒绝答，别挂住
            handlers: { onPermission: async () => ({ approved: false }) },
          })
          .then(resolve)
          .catch((err: unknown) =>
            reject(err instanceof Error ? err : new Error(String(err))),
          );
      }),
      spawnFailed,
    ]);
    return { connection, proc };
  } catch (err) {
    // 建连失败时调用方拿不到 proc（返回值没出去），必须在这里收掉，别留孤儿进程
    killProcessTree(proc);
    throw err;
  }
}

export async function listAcpSessions(opts: {
  agent: AcpAgentConfig;
  /** 按会话工作目录过滤；不给 = 拉全部 */
  cwd?: string;
}): Promise<{ supported: boolean; sessions: AcpSessionInfo[] }> {
  let probe: { connection: AcpConnection; proc: ChildProcess } | null = null;
  try {
    probe = await openProbeConnection(opts.agent);
    const init = await probe.connection.initialize();
    if (!init.canList) return { supported: false, sessions: [] };
    const sessions = await probe.connection.listSessions(opts.cwd);
    return { supported: true, sessions };
  } finally {
    probe?.connection.close();
    if (probe) killProcessTree(probe.proc);
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
  let probe: { connection: AcpConnection; proc: ChildProcess } | null = null;
  try {
    probe = await openProbeConnection(opts.agent);
    const init = await probe.connection.initialize();
    if (!init.canDelete) return { ok: false, supported: false };
    await probe.connection.deleteSession(opts.sessionId);
    return { ok: true, supported: true };
  } finally {
    probe?.connection.close();
    if (probe) killProcessTree(probe.proc);
    // 本地这条会话若还挂着常驻 entry（进程 / 恢复通道绑着同一个 sessionId），
    // agent 侧会话已删，entry 里留着的上下文已失效 —— 一并收掉，免得下一轮拿着
    // 已删除的 sessionId 去续。
    for (const key of [...sessions.keys()]) {
      const entry = sessions.get(key);
      if (entry && sessionIdOf(entry) === opts.sessionId) teardown(key);
    }
  }
}

/** 会话交互来源的 sessionId（新建或恢复出来的通道） */
function sessionIdOf(entry: AcpSessionEntry): string | null {
  return entry.source?.sessionId ?? null;
}

/**
 * 分叉一个 agent 侧会话（`session/fork`）：返回值是**新会话 id**，调用方拿它建一条本地
 * 会话（`acpSessionId` 绑上去）即可，后续轮次照常走 resume / load。
 *
 * 用一次性探针进程：分叉动作本身不需要常驻，分叉出来的会话留在 agent 侧。
 */
export async function forkAcpSession(opts: {
  agent: AcpAgentConfig;
  /** 要分叉的 agent 侧会话 id */
  sessionId: string;
  /** 新会话的工作目录（一般是原会话所属工作区） */
  workspacePath?: string;
}): Promise<{ sessionId: string }> {
  let probe: { connection: AcpConnection; proc: ChildProcess } | null = null;
  try {
    probe = await openProbeConnection(opts.agent);
    const init = await probe.connection.initialize();
    if (!init.canFork) throw new Error("这个 agent 不支持 session/fork");
    const result = await probe.connection.forkSession(
      opts.sessionId,
      resolveProbeCwd(opts.workspacePath),
    );
    return { sessionId: result.source.sessionId };
  } finally {
    probe?.connection.close();
    if (probe) killProcessTree(probe.proc);
  }
}

/**
 * 关闭一个 agent 侧会话（`session/close`）：让 agent 释放它，但不删除落盘数据。
 *
 * 与 `deleteAcpSession` 区分：close 是「先放手」，之后还能 resume；delete 是抹掉。
 */
export async function closeAcpSession(opts: {
  agent: AcpAgentConfig;
  sessionId: string;
}): Promise<{ ok: boolean; supported: boolean }> {
  let probe: { connection: AcpConnection; proc: ChildProcess } | null = null;
  try {
    probe = await openProbeConnection(opts.agent);
    const init = await probe.connection.initialize();
    if (!init.canClose) return { ok: false, supported: false };
    await probe.connection.closeSession(opts.sessionId);
    return { ok: true, supported: true };
  } finally {
    probe?.connection.close();
    if (probe) killProcessTree(probe.proc);
    for (const key of [...sessions.keys()]) {
      const entry = sessions.get(key);
      if (entry && sessionIdOf(entry) === opts.sessionId) teardown(key);
    }
  }
}

/**
 * 用 agent 广告的某种方式登录（v1 `authenticate` / v2 `auth/login`）。
 *
 * 只支持 `type: 'agent'` 的方法：`terminal` 方式要求客户端起一个交互式 TUI 进程，
 * 本仓库没有 PTY 通道，直接拒绝并让用户去终端里手动登录。
 */
export async function authenticateAcpAgent(opts: {
  agent: AcpAgentConfig;
  methodId: string;
}): Promise<void> {
  let probe: { connection: AcpConnection; proc: ChildProcess } | null = null;
  try {
    probe = await openProbeConnection(opts.agent);
    const init = await probe.connection.initialize();
    const method = init.authMethods.find((m) => m.id === opts.methodId);
    if (!method) throw new Error("这个 agent 没有这种方法");
    if (method.type === "terminal") {
      throw new Error("这一步需要在终端里完成（Fizz 暂不支持终端登录）");
    }
    await probe.connection.login(opts.methodId);
  } finally {
    probe?.connection.close();
    if (probe) killProcessTree(probe.proc);
  }
}

/** 退出登录（仅 v2 有 `auth/logout`；v1 会抛错） */
export async function logoutAcpAgent(opts: {
  agent: AcpAgentConfig;
}): Promise<void> {
  let probe: { connection: AcpConnection; proc: ChildProcess } | null = null;
  try {
    probe = await openProbeConnection(opts.agent);
    await probe.connection.initialize();
    await probe.connection.logout();
  } finally {
    probe?.connection.close();
    if (probe) killProcessTree(probe.proc);
  }
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
  req: AcpPermissionRequest,
): Promise<AcpPermissionReply> {
  const options: AgentConfirmOption[] = req.options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: option.kind as AgentConfirmOption["kind"],
  }));
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
    const rejectId = pickReject();
    return rejectId ? { approved: false, optionId: rejectId } : { approved: false };
  }

  // 增量更新：缺的字段回查本轮 tool_call 的记忆（CodeBuddy 只给 toolCallId）
  const toolCallId = req.toolCallId;
  const known = toolCallId ? turn.toolCalls.get(toolCallId) : undefined;
  // 协议：本次没带的字段视为「没变化」，取回查到的上一份
  const title = acpTitle(req.title) ?? known?.title ?? "";
  const kind = req.kind || known?.kind;
  // 工具名优先用 agent 的程序化名（`ToolCall.name`），没有才退回 `kind`
  const name = req.name ?? known?.name;
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

  if (reply.optionId) return { approved: true, optionId: reply.optionId };
  if (reply.approved) {
    const optionId = pickAllow();
    return optionId ? { approved: true, optionId } : { approved: true };
  }
  const rejectId = pickReject();
  return rejectId ? { approved: false, optionId: rejectId } : { approved: false };
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
  mcpServers?: AcpMcpServer[];
  modelId?: string;
}): Promise<AcpSessionReadyInfo> {
  const entry = getOrCreateEntry({
    agent: opts.agent,
    conversationId: opts.conversationId,
    workspacePath: opts.workspacePath,
  });
  const session = await ensureSession(entry, opts.workspacePath, opts.agent, undefined, opts.mcpServers);
  await applyAcpModel(entry, opts.modelId);
  return { sessionId: session.sessionId, ...snapshotOf(entry) };
}

/**
 * 随这一轮一起发的图片（客户端已读成字节）。
 *
 * 只支持图片而不是「任意文件」：ACP 里非文本内容有三种块，只有 `image` 是各家
 * agent 普遍实现的（PDF / 文档要靠 `resource` + `embeddedContext`，得 agent 明说支持，
 * 见 `PromptCapabilities`）。其余类型让 agent 用工作区里的文件工具自己读。
 */
export interface AcpPromptAttachment {
  /** MIME（`image/png` / `image/jpeg` …） */
  mediaType: string;
  /** 原始字节；base64 在本包内编，调用方不用碰协议细节 */
  data: Uint8Array;
  /** 原始文件名（只进日志 / 说明，协议里不强制） */
  name?: string;
}

export interface RunAcpAgentOptions {
  workspace: AgentWorkspace;
  history: AgentChatMessage[];
  agent: AcpAgentConfig;
  conversationId: string;
  requestId: string;
  /** 每轮检查实际配置；变化后先重启并恢复会话，不依赖外部 agent 热更新。 */
  mcpServers?: AcpMcpServer[];
  /**
   * 本轮附带的图片（用户随消息发的）。缺省 = 纯文本，行为与之前逐字节一致。
   *
   * 是否允许发由调用方按 `getAcpImageSupport(agent.id)` 判：这里**不拦** ——
   * 传进来就发，agent 若不收会自己报错，错误照常走事件流上去。
   */
  attachments?: AcpPromptAttachment[];
  /**
   * 附件说明（例如「某张图超过上限未发送」）：作为**最前面的文本块**发给 agent，
   * 让它知道自己少看到了什么，而不是静默少一张图。
   */
  attachmentNote?: string;
  /** 审批超时（毫秒）；0 = 不超时。缺省 10 分钟 */
  confirmTimeoutMs?: number;
  /** 会话记住的模型（agent 广告的 configOptions 里的一项值）；空 = 用它的默认 */
  modelId?: string;
  /** 会话记住的模式（按实际 configOptions / Session Modes 能力）；空 = 用它的默认 */
  modeId?: string;
  /** 会话记住的思考档（thought_level configOption）；空 = 用它的默认 */
  thoughtLevel?: string;
  onEvent?: (event: AgentStreamEvent) => void;
  /**
   * ACP 权限请求的审批通道：agent 给的选项原样上送界面，用户挑中的 optionId 原样回传。
   * 不传 = 无人值守，权限请求一律按拒绝收场（挑第一个 reject 类选项；没有则 cancelled）。
   */
  requestPermission?: (req: AgentConfirmInput) => Promise<AgentPermissionReply>;
  /**
   * 结构化追问（elicitation）通道：agent 在运行中要用户补结构化输入时走它。
   * 不传 = 一律 `decline`（无人值守时别把 agent 挂住）。
   */
  requestElicitation?: (
    req: AcpElicitationRequest,
  ) => Promise<AcpElicitationReply>;
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
  if (entry) {
    entry.lastActiveAt = Date.now();
    return entry;
  }
  // 「任务」会话没有工作区目录：agent 进程的 cwd 兜底到主目录
  const cwd = opts.workspacePath || homedir();
  const proc = spawnCommand(opts.agent.command, opts.agent.args ?? [], cwd);
  entry = {
    agentId: opts.agent.id,
    conversationId: opts.conversationId,
    proc,
    spawnError: null,
    cwd,
    connection: null,
    source: null,
    mcpConfigHash: null,
    availableModes: [],
    currentModeId: null,
    modelSelector: null,
    thoughtLevelSelector: null,
    configOptionsKnown: false,
    modeOptionSelector: null,
    promptCapabilities: null,
    authMethods: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    chain: Promise.resolve(),
    turn: null,
  };
  sessions.set(key, entry);
  ensureAcpIdleTimer();
  /**
   * 必须**在 spawn 的同一轮**挂上：`runAcpAgent` 会先建 entry、再排队 / 拼 prompt，
   * 等走到 `connectAdapter` 时 `'error'` 可能已经发过了。ChildProcess 上没人监听
   * `'error'` = 未捕获异常，`spawn codebuddy ENOENT` 会直接把 server 进程带走。
   * 这里只负责「接住 + 记账」，真正的报错由 `connectAdapter` 在查 `spawnError` 时抛出。
   */
  proc.on("error", (err: Error) => {
    const failure = describeSpawnError(err, opts.agent.command, cwd);
    entry.spawnError = failure;
    if (sessions.get(key) === entry) sessions.delete(key);
    entry.source?.fail?.(failure);
  });
  proc.on("exit", (code, signal) => {
    // 进程自己退了（崩溃 / 命令不存在）：会话不可复用，下一轮重建
    if (sessions.get(key) === entry) sessions.delete(key);
    /**
     * 半路死掉的进程也要**把错误交给正在等消息的轮次**：`ManualTurnSource`（resume/load）
     * 的 `nextUpdate()` 是我们自己实现的，进程退出不会让 SDK 拒掉挂起的等待 —— 不喊一声，
     * 界面就一直停在「思考中」，直到用户手动停止。
     * （`session/new` 那条路走 SDK 的队列 + 中止时的 `abortGate`，这里只管手写队列。）
     */
    entry.source?.fail?.(
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
  const queueEntry = getOrCreateEntry({
    agent: opts.agent,
    conversationId: opts.conversationId,
    workspacePath: opts.workspace.path,
  });
  const text = lastUserText(opts.history);
  const prompt = buildPromptBlocks(opts, text);
  // ⚠️ 判「空」要连图片一起算：只发一张截图、不写字的场景是合法的（内置会话早支持，
  // 这里只认 text 会把它拦成「没有要发送的内容」）。
  if (prompt.length === 0) {
    emit({ type: "error", message: "没有要发送的内容" });
    emit({ type: "finish", finishReason: "error" });
    return { finishReason: "error", error: "没有要发送的内容" };
  }

  const run = async (): Promise<RunAgentResult> => {
    await activating.get(key);
    // 前面排队的轮次可能已重启进程，不能闭包复用旧 entry。
    const resident = sessions.get(key);
    let current = getOrCreateEntry({
      agent: opts.agent,
      conversationId: opts.conversationId,
      workspacePath: opts.workspace.path,
    });
    if (current !== resident) current.chain = queueEntry.chain;
    /**
     * 本轮耗时的起点 —— 记在 `run` 内部而不是函数入口：上面那段 `current.chain` 排队
     * 是在等**上一轮**结束，用户点完发送后排队等着不算「在工作」。
     *
     * 只有 finish 帧会带它（`durationMs`）：ACP 没有 token 用量，做不出 `TurnUsage`，
     * 前端靠这个数在折叠条抬头报「已工作 N 秒」（见 `AgentChatMessage.durationMs`）。
     */
    const turnStartedAt = Date.now();
    // 有轮次在跑就不能被空闲回收：turn 也会在下面置上，这里先把活动时间顶到今天
    current.lastActiveAt = turnStartedAt;
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
      ...(opts.requestElicitation
        ? { requestElicitation: opts.requestElicitation }
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
     *   1. 先发 `session/cancel` 请 agent 自己停（给它 400ms 收尾）；仍不结束时
     *      `teardown()` 杀掉进程（不杀就是留一个再也管不住的孤儿进程）；
     *   2. 用一个 gate 把 `nextUpdate()` race 掉 —— 不去赌「进程被杀后 SDK 会不会把挂起的
     *      nextUpdate 拒掉」，自己保证一定跳得出来。
     */
    let releaseAbortGate: (() => void) | null = null;
    const abortGate = new Promise<null>((resolve) => {
      releaseAbortGate = () => resolve(null);
    });
    const onAbort = (): void => {
      const sessionId = current.source?.sessionId;
      const connection = current.connection;
      if (sessionId && connection) {
        void connection.cancelTurn(sessionId).catch(() => undefined);
        setTimeout(() => {
          if (sessions.get(key) === current) teardown(key);
          releaseAbortGate?.();
        }, 400);
        return;
      }
      if (sessions.get(key) === current) teardown(key);
      releaseAbortGate?.();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      if (opts.signal?.aborted) {
        emit({ type: "finish", finishReason: "aborted", durationMs: elapsedMs() });
        return { finishReason: "aborted" };
      }
      let loadSessionId = opts.loadSessionId;
      if (current.source && current.mcpConfigHash !== mcpConfigHash(opts.mcpServers)) {
        // 已等上一轮收场，此刻才重启。保留 sessionId 恢复上下文，同时移交串行链和审批上下文。
        loadSessionId = current.source.sessionId;
        const previous = current;
        teardown(key);
        current = getOrCreateEntry({
          agent: opts.agent,
          conversationId: opts.conversationId,
          workspacePath: opts.workspace.path,
        });
        current.chain = previous.chain;
        current.turn = previous.turn;
        previous.turn = null;
        console.log(`[acp:${opts.agent.name}] MCP 配置已变化，重启进程并恢复会话`);
      }
      // 会话来源三选一（prompt / nextUpdate 同形，轮次循环不区分）：
      // 1. 已加载的（打开会话时 load 过）→ 直接复用；
      // 2. 进程 / 会话还活着 → 直接复用活会话（**不做 load**：load 会在同一进程上二次建连）；
      // 3. 绑定了 sessionId 但进程 / 会话已没 → session/load 恢复上下文（停止 / 重启后不失忆）；
      //    load 回放的历史在轮次前 drain 掉 —— 视图由打开会话时的 transcript 端点负责；
      //    load 失败（agent 不支持 / 会话已失效）→ 退回 session/new。
      let source: AcpTurnSource;
      const liveSource = current.source;
      if (liveSource) {
        source = liveSource;
      } else if (loadSessionId) {
        try {
          source = await loadTurnSource(
            current,
            opts.agent,
            opts.workspace.path,
            loadSessionId,
            opts.mcpServers,
          );
          source.drainAll();
          // 档位也可能在 load 回包里被刷新（甚至被 agent 重置）：回写会话，界面据此更新
          opts.onSessionCreated?.({
            sessionId: source.sessionId,
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
            opts.mcpServers,
          );
        }
      } else {
        source = await ensureSession(
          current,
          opts.workspace.path,
          opts.agent,
          opts.onSessionCreated,
          opts.mcpServers,
        );
      }
      // 会话记住的模型 / 模式 / 思考档在 prompt 前依次下发（没选 / 不支持则静默跳过）。
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
       * 而 `session/load` / `session/resume` 那条手写通道靠 `ManualTurnSource.fail`（进程退出时调）。
       * 少了它，下面那句 `await ... nextUpdate()` 会永远挂着 —— 界面一直「思考中」。
       */
      void source.prompt(prompt).catch(() => undefined);
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
      // 轮次刚结束不算空闲：从现在开始重新计时
      current.lastActiveAt = Date.now();
      if (opts.signal?.aborted) teardown(key);
    }
  };

  // 同会话串行：排队等上一轮结束（两个客户端同时提问也不会并发踩同一条会话）
  const queued = queueEntry.chain.then(run, run);
  queueEntry.chain = queued.catch(() => undefined);
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
    // file 也是位置性内容：跨过它合并把后文塞进前面的段落，图片位置会整体前移
    if (
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "file"
    ) {
      break;
    }
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
  // agent 回传的图片（见 `acpImageEvent`）：整块追加，不参与文本合并
  if (event.type === "file-part") {
    return [
      ...parts,
      {
        type: "file",
        name: event.name,
        mediaType: event.mediaType,
        url: event.url,
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
  mcpServers?: AcpMcpServer[];
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
  mcpServers?: AcpMcpServer[];
}): Promise<AgentChatMessage[]> {
  teardown(`${opts.agent.id}::${opts.conversationId}`);
  const entry = getOrCreateEntry({
    agent: opts.agent,
    conversationId: opts.conversationId,
    workspacePath: opts.workspacePath,
  });
  entry.lastActiveAt = Date.now();
  let source: AcpTurnSource;
  try {
    source = await loadTurnSource(
      entry,
      opts.agent,
      opts.workspacePath,
      opts.sessionId,
      opts.mcpServers,
    );
  } catch (err) {
    // 失败的恢复不留下半活进程；只清理本次 entry，避免误伤后来建立的新连接。
    const key = `${opts.agent.id}::${opts.conversationId}`;
    if (sessions.get(key) === entry) teardown(key);
    throw err;
  }
  entry.lastActiveAt = Date.now();
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
        | { type?: string; text?: string; data?: unknown; mimeType?: unknown }
        | undefined;
      /**
       * 用户消息里也认图片：本地那条带 `/api/uploads/...` 的记录会被这份回放**整体替换**，
       * 只接文本的话，纯图片的那条用户消息直接消失、图文混合的只剩文字。
       * 折成 `file` 后 URL 是 data URL（回放里拿不到原始上传地址），仅仅用于显示 ——
       * 编辑重发那条路径会把 data URL 排除掉（`fileRefsOfParts`）。
       */
      let part: AgentMessagePart | null = null;
      if (content?.type === "image") {
        const image = acpImageEvent(content);
        if (image?.type === "file-part") {
          part = {
            type: "file",
            name: image.name,
            mediaType: image.mediaType,
            url: image.url,
          };
        }
      } else if (content?.type === "text" && typeof content.text === "string") {
        part = { type: "text", text: content.text };
      }
      if (!part) continue;
      const last = messages[messages.length - 1];
      const sameGroup =
        last?.role === "user" &&
        (mid === null ? userMid === null : userMid === mid);
      if (sameGroup) {
        const tail = last.parts[last.parts.length - 1];
        // 相邻文本合并（历史里别把一句话拆成十几段）；图片整块 push，不参与合并
        if (part.type === "text" && tail?.type === "text") {
          last.parts[last.parts.length - 1] = {
            type: "text",
            text: tail.text + part.text,
          };
        } else {
          last.parts.push(part);
        }
      } else {
        messages.push({
          id: `u-replay-${++seq}`,
          role: "user",
          parts: [part],
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
