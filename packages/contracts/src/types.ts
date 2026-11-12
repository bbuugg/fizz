// 共享类型定义：主进程 / preload / 渲染进程共用

/**
 * 域类型已经分发到各自的包（类型真源）：
 * - ACP → `@fizz/acp`（AcpAgentConfig / AcpModelOption / AcpToolCallContent …）
 * - MCP → `@fizz/mcp`（McpServerConfig / McpToolInfo）
 * - 技能 → `@fizz/skills`（SkillInfo / SkillSettings / SkillListResult …）
 * - git → `@fizz/git`（GitStatusResult / GitActionInput …）
 * 这里只保留**跨包共享的运行时契约**（对话流 / 工作区 / 会话 / 确认 / 任务），
 * 需要域类型时按上表 `import type` —— 类型引用会被编译期擦除，不产生运行时依赖。
 */
import type { AcpToolCallContent } from '@fizz/acp'
import type { BrowserSettings } from './browser'

export type ThemeMode = 'system' | 'light' | 'dark'

// ---------- WebSocket 调试 ----------
//
// 与 HTTP 不同：WS 是长连接，且浏览器原生 `WebSocket` **不允许设自定义握手头**、
// 也不能跳过 wss 自签证书校验。所以连接由**服务端中继**建立
// （`/api/api-client/ws/:connId`），渲染端一条调试连接 = 一条打到中继的浏览器 WS，
// 双方用下面的 JSON 帧通信。

/** WebSocket 连接参数（渲染端 → 服务端中继，`connect` 消息携带） */
export interface WsConnectOptions {
  url: string
  /** 附加握手请求头（如 Authorization / Cookie / Origin） */
  headers?: Record<string, string>
  /** 子协议（Sec-WebSocket-Protocol） */
  protocols?: string[]
  /**
   * 跳过 TLS 证书校验（wss 自签证书）。
   * 取值方向与字段名相反（沿用 undici 的 `connect.rejectUnauthorized`）：**`false` = 不校验**。
   */
  rejectUnauthorized?: boolean
}

/** 连接状态（比 `WebSocket.readyState` 的数字更好读，渲染端直接用这个） */
export type WsReadyState = 'connecting' | 'open' | 'closing' | 'closed'

/** 待发送的一帧 */
export interface WsSendPayload {
  data: string
  encoding: 'text' | 'base64'
}

/**
 * 中继 → 渲染端的连接事件。
 *
 * 每条事件都带 `connId`（中继从路径里取到并回填）—— 渲染端可能同时开着多条调试
 * 连接，虽然每条连接各有自己的中继 socket，带上 connId 便于日志归属排查。
 */
export type WsEvent =
  | {
      connId: string
      type: 'open'
      protocol: string
      /** 连上了但降级了（如服务端缺 undici，自定义请求头被忽略）；正常时缺省 */
      warning?: string
    }
  | {
      connId: string
      type: 'message'
      /** 文本帧给原文；二进制帧给 base64（由 `encoding` 区分） */
      data: string
      encoding: 'text' | 'base64'
      /** 原始字节数（文本帧是 utf8 字节数，用于界面显示体积） */
      bytes: number
      at: number
    }
  | { connId: string; type: 'close'; code: number; reason: string; at: number }
  | { connId: string; type: 'error'; message: string }

/**
 * 渲染端 → 中继 的控制帧（JSON 文本）。
 *
 * `connect` 必须是**第一条**消息：中继收到它才去连外部目标，握手结果随后以
 * `WsEvent.open` / `WsEvent.error` 回推。不把连接参数放 URL 查询串，是为了让
 * 握手请求头（可能含 Authorization）不进访问日志。
 */
export type WsRelayClientMessage =
  | { type: 'connect'; options: WsConnectOptions }
  | ({ type: 'send' } & WsSendPayload)
  | { type: 'close'; code?: number; reason?: string }

export type AiProviderKind =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'google'
  | 'openai-compatible'

/**
 * OpenAI 系接口风格：
 * - chat-completions：/v1/chat/completions，第三方兼容网关（Ollama/vLLM/中转）普遍支持
 * - responses：/v1/responses，OpenAI 官方新接口
 * 省略时按 kind 取默认：openai → responses，openai-compatible → chat-completions
 */
export type AiApiStyle = 'chat-completions' | 'responses'

/**
 * 单个模型的进阶设置（`AiModelEntry.settings`）。
 *
 * 为什么按**模型**而不是按配置：能力与上限是模型自己的属性 —— 同一个网关下
 * 128k 的便宜模型与 400k 的旗舰、支持视觉与不支持视觉的，可以并存。
 *
 * **所有字段都可缺省**，缺省语义见 `resolveModelSettings`（工具 / 图片 / 思考都开、
 * 输出不限、协议跟随配置）。
 */
export interface AiModelSettings {
  /**
   * 单次回复的最大输出 token（OpenAI 的 `max_output_tokens` / `max_completion_tokens`）。
   *
   * ⚠️ 不等于「上下文窗口」：OpenAI 协议里没有单独的 `max_input_tokens`，输入可用空间
   * = 窗口 − 输出。这里只钉输出上限；输入侧由同一个模型的 `contextWindow` 管。
   */
  maxOutputTokens?: number
  /** 是否允许向这个模型下发工具（缺省 true）。关掉 = 请求里一个工具都不带。 */
  toolCall?: boolean
  /** 是否接受图片输入（缺省 true）。关掉 = 发送时拒绝图片附件，历史里的图片被过滤。 */
  imageInput?: boolean
  /** 是否透传思考内容（缺省 true）。关掉 = `reasoning-delta` 不再下发，也就不进历史。 */
  reasoning?: boolean
  /** 这个模型的接口风格覆盖（仅 openai / openai-compatible 有意义）；缺省跟随配置 */
  apiStyle?: AiApiStyle
}

/**
 * 一份模型配置里的**一个模型**：id + 它自己的窗口与进阶设置。
 *
 * 之前这些是三个平行结构（`models: string[]` + `contextWindows` / `modelSettings` 两张
 * 按 id 索引的表），改 id 要同时搬三处，而且结构上允许 key 不在清单里。现在合成一个数组：
 * 顺序即展示顺序，删除 / 改名天然是整条搬走。
 */
export interface AiModelEntry {
  /** 上游模型 id（如 `gpt-4o`） */
  id: string
  /**
   * 上下文窗口（token）。缺省 = `DEFAULT_CONTEXT_WINDOW` 兜底。
   *
   * 前端圆环的分母与服务端自动压缩的触发阈值共用这一份真源。
   * ACP 会话不读它（上下文在 agent 侧管理）。
   */
  contextWindow?: number
  /** 进阶设置（工具 / 图片 / 思考 / 输出上限 / 协议覆盖）；缺省全部走默认值 */
  settings?: AiModelSettings
}

export interface AiModelConfig {
  id: string
  name: string
  kind: AiProviderKind
  apiKey?: string
  /** 是否已保存 apiKey（脱敏展示用） */
  hasApiKey?: boolean
  baseURL?: string
  /**
   * 这份配置下**可选的模型清单**（同一网关 + 同一 key 下的多个模型共用一个配置，
   * 不必为每个模型抄一份 baseURL / apiKey）。顺序即展示顺序。
   *
   * **可以为空**：先把网关 / key 建好、模型之后再补，或者把模型全删光。
   * 空的配置不能用于对话（`resolveModelConfig` 会给出明确报错）。
   */
  models: AiModelEntry[]
  /**
   * 实现细节：provider 构造需要的 model 字段，保存时取清单第一项；清单为空时是空字符串。
   * **无「默认」语义** —— 对话用哪个模型由会话显式绑定（见
   * `AgentDomain.resolveModelConfig(id, modelId)`：解析时把它覆盖成「这一轮选中的那个」），
   * 下游构造 provider 的地方（`resolveModel(config)`、agent 构造）只读 `model` 一个字段，
   * 不必层层透传 modelId。
   */
  model: string
  /** 仅 openai / openai-compatible 有效；缺省按 kind 取默认 */
  apiStyle?: AiApiStyle
  temperature?: number
  maxTokens?: number
  /** 携带的历史消息条数 */
  contextMessages?: number
  createdAt: number
  updatedAt: number
}

/** 模型进阶设置缺省值（未配置的模型都按它走） */
export const DEFAULT_MODEL_SETTINGS = {
  toolCall: true,
  imageInput: true,
  reasoning: true
} as const

/** 解析后的模型进阶设置：布尔项一定有值，其余缺省不出现 */
export interface ResolvedModelSettings {
  maxOutputTokens?: number
  toolCall: boolean
  imageInput: boolean
  reasoning: boolean
  apiStyle?: AiApiStyle
}

/** 按模型 id 找清单里的那一条（找不到返回 undefined，不回退到第一个） */
export function findModelEntry(
  models: readonly AiModelEntry[] | undefined,
  modelId: string | undefined
): AiModelEntry | undefined {
  if (!modelId) return undefined
  return models?.find((entry) => entry.id === modelId)
}

/**
 * 解析某个模型的进阶设置：显式配置 > 缺省值。
 *
 * 非正数 / 非有限数的 `maxOutputTokens` 当「没配」（手改坏的 JSON 不该把输出钉成 0）；
 * 布尔项只有**显式 false** 才算关（缺省 / 坏值一律按开）。
 */
export function resolveModelSettings(
  models: readonly AiModelEntry[] | undefined,
  modelId: string | undefined
): ResolvedModelSettings {
  const raw = findModelEntry(models, modelId)?.settings
  const tokens = raw?.maxOutputTokens
  const maxOutputTokens =
    typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : undefined
  return {
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    toolCall: raw?.toolCall !== false,
    imageInput: raw?.imageInput !== false,
    reasoning: raw?.reasoning !== false,
    ...(raw?.apiStyle === 'chat-completions' || raw?.apiStyle === 'responses'
      ? { apiStyle: raw.apiStyle }
      : {})
  }
}

/**
 * 把「按模型的协议覆盖」应用到整份配置上（`resolveModel` 只读 `model` 与 `apiStyle`）。
 *
 * 只处理 `apiStyle`：其余设置是**调用时**的参数（maxOutputTokens / 工具集 / 思考过滤），
 * 不能塞进配置对象。
 */
export function withModelApiStyle(config: AiModelConfig): AiModelConfig {
  const { apiStyle } = resolveModelSettings(config.models, config.model)
  if (!apiStyle || apiStyle === config.apiStyle) return config
  return { ...config, apiStyle }
}

/**
 * 模型没配上下文窗口时的兜底（token）。
 * 只在「这个模型没有单独配置」时生效；服务端的兜底值可用 `FIZZ_CONTEXT_BUDGET` 覆盖。
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** 压缩预留（pi 的 `reserveTokens` 默认值）：给系统提示词与模型回复留的空间 */
export const COMPACTION_RESERVE_TOKENS = 16384
/** 压缩后保留的近期上下文（pi 的 `keepRecentTokens` 默认值） */
export const COMPACTION_KEEP_RECENT_TOKENS = 20000

/**
 * 这个窗口下的压缩预留量。
 *
 * pi 固定 16384，但 fizz 支持的窗口从 8k 到 1M 都有 —— 固定值在 32k 模型上会吃掉一半，
 * 所以按窗口 25% 封顶（**唯一的机械适配，判据本身不变**）。
 */
export function compactionReserveTokens(contextWindow: number): number {
  return Math.min(
    COMPACTION_RESERVE_TOKENS,
    Math.max(1024, Math.floor(contextWindow * 0.25))
  )
}

/** 这个窗口下「什么时候开始压缩」：`窗口 - 预留`（与 pi 的 `shouldCompact` 一致） */
export function compactionTriggerTokens(contextWindow: number): number {
  return Math.max(1, contextWindow - compactionReserveTokens(contextWindow))
}

/**
 * 保留区的下限：再怎么给「压缩动不了的那部分」让位，也要留这么多原文
 * —— 否则模型连「刚才在干什么」都不知道。与服务端 `MIN_KEEP_TOKENS` 同一个数。
 */
export const COMPACTION_MIN_KEEP_TOKENS = 1024

/**
 * 压缩后要保留多少 token 的原文（保留区大小）—— 与服务端 `resolveCompactionSettings`
 * **同一公式**，供界面判断「手动压缩现在压不压得动」。
 *
 * ⚠️ 它和 `compactionTriggerTokens` 是**两条不同的线**，别混用：
 * - `compactionTriggerTokens` = 窗口 − 预留（≈92%），是**自动**压缩的触发线；
 * - 这一条是「切点之外还剩多少原文」，**手动**压缩（`force: true`）只看它 ——
 *   历史上用触发线当手动压缩按钮的闸，结果上下文不到 92% 时按钮永远灰着。
 *
 * @param fixedTokens 消息之外、压缩动不了的那部分（系统提示词 + 工具 schema + 已有摘要）
 * @param overrides   服务端 `CompactionSettings` 的覆盖（测试 / 特殊场景用；缺省即 pi 默认值）
 */
export function compactionKeepRecentTokens(
  contextWindow: number,
  fixedTokens = 0,
  overrides?: { reserveTokens?: number; keepRecentTokens?: number }
): number {
  const reserve = Math.min(
    overrides?.reserveTokens ?? COMPACTION_RESERVE_TOKENS,
    compactionReserveTokens(contextWindow)
  )
  const budget = contextWindow - reserve - Math.max(0, fixedTokens)
  return Math.min(
    overrides?.keepRecentTokens ?? COMPACTION_KEEP_RECENT_TOKENS,
    Math.max(COMPACTION_MIN_KEEP_TOKENS, Math.floor(budget * 0.8))
  )
}

/*
 * 压缩参数（`reserveTokens = 16384` / `keepRecentTokens = 20000`）在
 * `packages/agent/src/context.ts` 的 `DEFAULT_COMPACTION_SETTINGS` 里，与 pi 一致。
 *
 * ⚠️ 这里曾经有 `COMPRESS_TRIGGER_RATIO = 0.8` 与 `MICROCOMPACT_*` 一组常量，已全部删除：
 * 「按比例提前压」和「清旧工具结果」都会改动请求前缀，而上游前缀缓存一断就按全价重读整段
 * 历史 —— 省下的只是一点命中价，清一次要十几轮才回本。压缩只在真正装不下时做，
 * 其余时候**前缀必须逐字节稳定**。
 */

/**
 * 解析某个模型的上下文窗口：显式配置 > 兜底值。
 *
 * 非正数 / 非有限数一律当「没配」—— 手改坏的 JSON 不该让阈值变成 0 或 NaN
 * （那会让每一轮都触发压缩）。
 */
export function resolveContextWindow(
  models: readonly AiModelEntry[] | undefined,
  modelId: string | undefined,
  fallback: number = DEFAULT_CONTEXT_WINDOW
): number {
  const raw = findModelEntry(models, modelId)?.contextWindow
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0
    ? Math.floor(fallback)
    : DEFAULT_CONTEXT_WINDOW
}

// ---------- 技能（类型已迁至 @fizz/skills） ----------

/**
 * Agent 工具权限模式（在设置 →「通用」里切换，随每轮请求上送服务端）：
 *
 * - `full`     完全访问：读写文件、执行命令都不问（默认之外最省事，也最危险）；
 * - `confirm`  确认模式：**所有会改动东西的操作**（写文件 / 编辑文件 / 删除 / 执行命令）
 *              都先弹卡片等用户点「允许」，被拒绝时模型不会重试；
 * - `readonly` 只读模式：只允许看（列目录 / 读文件 / 搜索 / 读技能），
 *              任何写入与执行都被直接拒绝（工具回一条说明，让模型转告用户）。
 *
 * 默认是 `confirm`：宁可多问一句，也不要让 Agent 静默改盘。
 */
export type AiPermissionMode = 'full' | 'confirm' | 'readonly'

/**
 * AI Agent 后端：
 * - 内置：内置 Agent 驱动（复用模型配置），工具由应用自己提供
 * - acp：连接外部 ACP agent（如 opencode），应用作为 ACP 客户端
 *
 * ⚠️ 历史数据兼容：早期这个值叫 `'ai-sdk'`，已存的旧会话里还是旧字符串；
 * 运行时判断一律是 `=== 'acp'`（else 即内置 Agent），旧值不受影响。
 */
export type AgentBackend = 'builtin' | 'acp'

/**
 * 一轮内置 Agent 的思考强度（AI SDK `CallSettings.reasoning` 的取值）。
 *
 * 缺省 / `undefined` = 不传，交给模型自己决定（不是 `provider-default`，语义相同但
 * 少发一个字段）。AI SDK 没有公开的模型能力查询，不支持的档位由 provider 降级 / 丢弃；
 * UI 滑块覆盖「默认 / 无 / 最小 / 低 / 中 / 高 / 极高 / 最高」八档。
 *
 * ACP 会话不使用这个字段：外部 Agent 的思考档走 `acpThoughtLevel`。
 */
export type AiReasoningEffort =
  | 'provider-default'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** 全部合法档位（配置 / HTTP 入参归一化用；UI 滑块展示默认与 none→max 共八档） */
export const AI_REASONING_EFFORTS = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const satisfies readonly AiReasoningEffort[]

/** 把任意输入归一成合法档位；非法 / 缺省 = `undefined`（跟随模型默认） */
export function normalizeReasoningEffort(value: unknown): AiReasoningEffort | undefined {
  return typeof value === 'string' && (AI_REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as AiReasoningEffort)
    : undefined
}

// ---------- ask_followup_question：AI 向用户提结构化选择题 ----------

/** 一个选项的展示形态：纯文本，或带说明的对象 */
export interface FollowupOption {
  label: string
  description?: string
}

/**
 * 一道题：由主进程归一化后发给渲染端。
 *
 * `id` 由主进程补齐（模型没给就按 `q1`/`q2`... 生成），渲染端/工具结果都靠它对齐。
 * `multiSelect` 区分单选 / 多选；`options` 已是纯 `label`+`description` 形态。
 */
export interface FollowupQuestion {
  id: string
  question: string
  /** 极短标签（≤12 字），作为卡片上的小标签 */
  header: string
  options: FollowupOption[]
  multiSelect: boolean
}

/**
 * AI 通过 `ask_followup_question` 工具向用户发起的提问表单。
 *
 * 主进程发起 → 渲染端在对话流里渲染成一张可回答的卡片（一题一区，底部统一提交）→
 * 用户作答 → IPC 回填 → 工具 resolve，**同一个 streamText 回合继续往下跑**（机制同确认卡）。
 */
export interface AskFollowupRequest {
  /** 提问表单 id，回答时原样带回 */
  id: string
  /** 所属对话请求 id（中止 / 流结束时按「跳过」清理） */
  requestId: string
  /** 发起这次提问的工具调用 id —— 渲染端据此把卡片插到对话流的正确位置 */
  toolCallId: string
  /** 可选表单标题 */
  title?: string
  questions: FollowupQuestion[]
  /** 归属的终端会话（终端 AI 助手才有）：卡片被折叠挡住时用它把面板撑开 */
  sessionId?: string
}

/** 单题答案：选中项的 label 列表。
 *  `other` = 用户选了「其他」并自行输入的内容（非是/否题才有；此时 `selected` 可能为空）。 */
export interface FollowupAnswerItem {
  id: string
  question: string
  selected: string[]
  /** 用户通过「其他」自由填写的内容 */
  other?: string
}

/**
 * 用户对整张表单的回答，作为工具结果回给模型。
 */
export interface AskFollowupAnswer {
  answers: FollowupAnswerItem[]
}

// ---------- 容器型项目（目录由系统分配、打开即起独立容器） ----------

/**
 * 可选运行环境（镜像）id。`CONTAINER_ENV_IMAGES` 里的键。
 *
 * ⚠️ **一律不带连字符**：镜像 tag 可被 `FIZZ_CONTAINER_IMAGE_<ENV大写>` 覆盖（见
 * `apps/server/src/server/container-projects/image.ts` 的 `tagOf`），连字符在 shell 里
 * `export A-B=1` 是非法的，用户根本没法覆盖。所以 `vite` 而不是 `node-vite`。
 */
export type ContainerEnvId = 'node' | 'php' | 'golang' | 'vite' | 'nextjs'

/** 预置镜像的一项：只暴露 id / 展示名 / 镜像 tag / 建议预览端口。 */
export interface ContainerEnvImage {
  id: ContainerEnvId
  /** 界面上显示的运行环境名 */
  label: string
  /** docker 镜像 tag */
  image: string
  /**
   * 这个环境默认监听的预览端口：创建项目时**服务端直接采用**（用户不填、也看不到），
   * 同时用它做 `docker run -p` 的容器侧端口与系统提示词里的「监听这个端口」。
   */
  suggestedPreviewPort?: number
  /**
   * 镜像自带的自动启动命令（容器里 `npm run <这个>`）：工作区**没有**
   * `.fizz/container/start.mjs` 时，容器启动会自动铺内置模板并把它跑起来。
   *
   * ⚠️ 必须与镜像里的 `ENV FIZZ_CONTAINER_AUTOSTART` 一致（真正干活的是镜像里的
   * `autostart.mjs`，这里只用于系统提示词告诉模型「不用再写启动脚本」）。
   * 缺省 = 不自动启动（node / php / golang 三个镜像的行为完全不变）。
   */
  autoStart?: string
}

/**
 * 预置镜像清单：用户建项目时从这里**手选**（不做 AI 自动匹配）。
 *
 * ⚠️ 项目记录里只存 `id`（`ContainerEnvId`），**不存 tag** —— tag 会随重建漂移。
 * ⚠️ 换镜像 = 改 `ContainerProjectConfig.image` 并**销毁旧容器按新镜像重建**。
 */
export const CONTAINER_ENV_IMAGES: readonly ContainerEnvImage[] = [
  { id: 'node', label: 'Node.js 24', image: 'fizz/agent-node:latest', suggestedPreviewPort: 3000 },
  { id: 'php', label: 'PHP 8.5', image: 'fizz/agent-php:latest', suggestedPreviewPort: 8000 },
  { id: 'golang', label: 'Go 1.27', image: 'fizz/agent-golang:latest', suggestedPreviewPort: 8081 },
  /*
   * Web 栈（Vite）：Node 24 + Vite / React / Tailwind（`docker/container-project/vite.Dockerfile`）。
   *
   * 与 `node` 的区别不是语言版本，而是**开箱即用**：镜像里烘了一份 Vite + React + TS +
   * Tailwind v4 模板（`docker/container-project/starter`），并且要求容器启动时自动把它铺进
   * 空的 `/workspace`、装好依赖、`npm run dev` 起在预览端口上（镜像里 `FIZZ_CONTAINER_AUTOSTART`）。
   * 所以新建一个这类项目、什么都不填，打开就有页面。
   *
   * 端口与 `node` 同为 3000：映射是**按项目**分配的（`-p 127.0.0.1:<随机>:3000`），两个
   * 镜像各自的项目互不影响，不必为了错开而故意换一个没人习惯的端口。
   */
  {
    id: 'vite',
    label: 'Node 24 + Vite / React / Tailwind',
    image: 'fizz/agent-vite:latest',
    suggestedPreviewPort: 3000,
    autoStart: 'dev'
  },
  /*
   * Web 栈（Next.js）：Node 24 + Next.js / React / Tailwind / lucide-react
   * （`docker/container-project/nextjs.Dockerfile`，模板 `docker/container-project/starter-nextjs`）。
   *
   * 与 `vite` 同一档「开箱即用」，差别只在框架：App Router + 服务端组件 + `next dev`。
   * 启动参数不走 Vite 那套（`next dev` 认 `-H/--hostname`、且没有 `--strictPort`），
   * 由镜像的 `FIZZ_AUTOSTART_ARGS` 交给 `autostart.mjs` 拼。
   *
   * 端口同为 3000：映射按项目分配，与 `vite` 的项目互不影响。
   */
  {
    id: 'nextjs',
    label: 'Node 24 + Next.js / Tailwind',
    image: 'fizz/agent-nextjs:latest',
    suggestedPreviewPort: 3000,
    autoStart: 'dev'
  }
]

/**
 * 容器资源限额的合法区间：**前端即时校验与服务端最终校验共用这一份**。
 *
 * 内存下限取 64 MB —— docker 本身允许更低，但低于这个数镜像里的运行时基本起不来，
 * 早点拦住比让人对着「容器没起来」猜更清楚；上限只是防手滑多按几个 0，不是物理上限。
 */
export const CONTAINER_MEMORY_LIMIT_MIN_MB = 64
export const CONTAINER_MEMORY_LIMIT_MAX_MB = 1024 * 1024
export const CONTAINER_CPUS_MAX = 1024

/**
 * 预览 key 的 query 参数名：应用内 iframe 拼地址、公网入口校验都认这一个。
 *
 * 之所以是 query 而不只是 cookie：iframe 首次导航必须自带 key（浏览器此时还没有 cookie），
 * 服务端校验通过后把它写成 cookie，页面里的子资源请求才能自动带上（见 `public-gateway.ts`）。
 */
export const PREVIEW_KEY_QUERY = 'fizz_key'

/** 预览 key 的形状：8-64 位 `[A-Za-z0-9_-]`（URL / cookie 里都不用再转义） */
export const PREVIEW_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

/**
 * 容器型项目的配置：**有这个字段就是容器型项目**，缺省 = 普通（登记目录）项目。
 *
 * 它是 `AgentWorkspace` 的**可选**子字段，老数据没有它 → 按普通项目走、行为与现在逐字一致，
 * 所以**不需要** `DATA_VERSION` 迁移（没有改任何已有字段的默认值）。
 */
export interface ContainerProjectConfig {
  /** 目录名 / 容器名后缀 / 公网子域标签：创建时随机生成，之后不变 */
  slug: string
  /** 镜像环境 id（`CONTAINER_ENV_IMAGES` 里的键），换镜像 = 改这个 + 重建容器 */
  image: ContainerEnvId
  /**
   * 容器内预览服务端口（**不能是 8080**）：**由系统按镜像自动定**（node 3000 / php 8000 /
   * golang 8081），用户不填也不可见 —— 用户只拿到 `https://<slug>.<域名>`。
   *
   * 它只影响两件事：`docker run -p 127.0.0.1:<随机>:<这个端口>` 与提示词里告诉模型
   * 「监听这个端口」。宿主侧的端口每次启动重新分配（`allocateHostPort`），而域名始终按
   * slug 现查当前映射（见 `public-gateway.ts`）—— 所以宿主端口漂移对用户不可见。
   */
  previewPort?: number
  /** 是否对外发布（公网子域可访问）：**新建默认开**，可关掉退回本机回环预览 */
  exposed?: boolean
  /**
   * 预览 key：**未对外发布时**访问预览页要带上它（`?fizz_key=<key>` 或 cookie）。
   * 对外发布（`exposed === true`）后不再校验 —— 拿到域名的人都能看。
   *
   * 创建时自动生成；可在「容器设置」里重新生成。应用内预览会自动把它拼进公网地址，
   * 所以本机用户永远不用手输；把链接发给别人 = 把 key 一起给出去了（私密分享）。
   *
   * 老数据没有这个字段 → 未发布时公网入口一律 401（没有可用的 key），
   * 去「容器设置」点一次「重新生成」即可。
   */
  previewKey?: string
  /**
   * 容器内存上限（MB）。**缺省 / `0` = 不限制**（留给 docker 默认，即宿主机全部内存）。
   *
   * 只在 `docker run` 时生效（`--memory <n>m`）—— 容器是「run 那一刻的形状」，改了不会
   * 影响已经在跑的容器：要么走「保存并重启」，要么等下一次启动时由运行参数指纹自动重建
   * （见 `apps/server/.../container-projects/lifecycle.ts` 的 `specOf`）。
   */
  memoryLimitMb?: number
  /**
   * 容器 CPU 上限（核，允许小数如 `1.5`）。**缺省 / `0` = 不限制**（`--cpus`）。
   *
   * 与 `memoryLimitMb` 同一套「改了要重建才生效」的语义。
   */
  cpus?: number
  createdAt: number
}

/** 容器型项目在宿主机上的**瞬时运行态**（不落盘，由 `docker inspect` 现读）。 */
export interface ContainerProjectState {
  workspaceId: string
  slug: string
  image: ContainerEnvId
  /**
   * 运行态。
   *
   * `stopping` 是**用户点了停止、`docker stop` 还没返回**的那几秒（它有 5s 优雅退出窗口，
   * 容器里那个服务不理会 SIGTERM 时会走满）。这一段容器其实还在跑（`docker ps` 仍列着它），
   * 但「还能不能干活」已经是否定的 —— 所以它**必须和 `running` 分开**：主区域的门据此
   * 收起对话面板（否则用户点了停止，界面还停在对话里，看着像没停成），侧栏据它显示
   * 「停止中」。别把它并回 `running`，也别并回 `stopped`（那时容器还没退干净）。
   */
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  /**
   * 启动阶段：`prepare` | `image` | `run` | `health`。
   *
   * `prepare` 是用户点了启动之后的第一段（探 docker / 读现有容器 / 比对容器形状），
   * 慢在 dockerd 时可能持续数秒 —— 界面靠它证明「确实在动」，而不是停在「没在运行」。
   */
  phase?: string
  /** `docker build` 的流式日志（启动态界面可展开） */
  buildLog?: string
  /** 宿主分配给容器内 agent 控制面（`:8080`）的回环端口 */
  agentPort?: number
  /** 宿主分配给容器内预览服务的回环端口 */
  previewPort?: number
  /**
   * 落盘配置与**当前容器形状**不一致（改了内存 / CPU / 镜像但还没重启）。
   *
   * 只用于界面提示「有改动待生效」—— 下一次启动（`doStart`）会按运行参数指纹自动删容器
   * 重建，不需要用户做任何事；想立刻生效走「重启容器」。
   */
  pendingRestart?: boolean
  error?: string
}

/** 容器型项目的整体快照（state ws 的一个域）。 */
export interface ContainerProjectsSnapshot {
  /** 服务端是否具备该能力（docker 可用）；`false` 时前端整块不渲染 */
  available: boolean
  /** `available === false` 时的人话原因 */
  reason?: string
  /**
   * 公网域名清单（**只来自设置页**，可多个）。
   *
   * **只在「现在真的能用」时才给**：没配域名、或配了但公网入口端口没在监听
   * （`FIZZ_PUBLIC_HTTP_PORT` 没配）都缺省 —— 界面据此把「公网」那一段置灰，
   * 而不是给一个打不开的地址。判据见 server 的 `publicGatewayEnabled()`。
   *
   * 前端预览取**第一个**域名拼 `<slug>.<域名>`（多个域名等价，任一个都能打开）。
   */
  domains?: string[]
  projects: ContainerProjectState[]
}

/**
 * 一个容器镜像的状态（设置页「容器」用）。
 *
 * `env === 'base'` 是所有环境镜像的父层（`fizz/agent-runtime:latest`）—— 它单独列出来，
 * 因为 base 缺失时单独构建环境镜像会在 `FROM` 那行直接失败，界面必须让人先看见它。
 */
export interface ContainerImageInfo {
  env: ContainerEnvId | 'base'
  /** 展示名（`CONTAINER_ENV_IMAGES` 的 label / 基础层的人话名） */
  label: string
  /** 实际使用的镜像 tag（可能被 `FIZZ_CONTAINER_IMAGE_<ENV>` 覆盖） */
  tag: string
  exists: boolean
  /** `docker build` 正在跑（前端据此轮询） */
  building: boolean
  /** 最近一次构建失败的错因；成功后清空 */
  error?: string
  /** 镜像大小（字节）；不存在时缺省 */
  sizeBytes?: number
  /** 镜像构建时间（毫秒）；不存在时缺省 */
  createdAt?: number
  /** tag 由环境变量接管：只检测存在性，**不提供构建**（镜像由用户自己管） */
  overridden: boolean
  /** 构建日志尾部（构建中 / 失败时给界面看） */
  log: string[]
}

/** 容器镜像快照（`GET /api/container-images`，设置页「容器」的数据源）。 */
export interface ContainerImagesSnapshot {
  /** 服务端是否具备该能力（docker daemon 可用） */
  available: boolean
  /** `available === false` 时的人话原因 */
  reason?: string
  /** docker daemon 版本（`available === false` 时缺省） */
  version?: string
  base: ContainerImageInfo
  envs: ContainerImageInfo[]
}

/**
 * 容器内 agent 允许使用的工具白名单（**宿主与容器共用一份**）。
 *
 * 只留纯文件读写 / 命令执行 / 网络 / 追问 / 内部清单：显式排除 `browser_*`、任何
 * `mcp__*`、以及 `project-tools.ts` 的全部工具（它们的作业面在宿主、不在容器里）。
 */
export const CONTAINER_AGENT_TOOL_KEYS: readonly string[] = [
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'find_files',
  'execute_command',
  'delete_file',
  'todo_write',
  'read_skill',
  'web_fetch',
  'ask_followup_question'
]

/**
 * 容器内运行时协议的版本号。
 *
 * 宿主（`apps/server/.../container-projects/turn.ts`）与容器（`docker/container-project/runtime/agent-host.mjs`）
 * 各持**同一份字面值**（容器那份是独立 mjs、没法 import 本包，只能也是字面值），
 * 宿主握手时比对 `/health` 的 `protocolVersion`：不一致直接报「镜像版本与 server 不匹配，
 * 请重建容器」，而不是让帧静默对不上。**改容器内 `/runs` 的请求体或帧形状就把它 +1。**
 */
export const CONTAINER_PROTOCOL_VERSION = 1

/**
 * 创建容器型项目的入参。
 *
 * ⚠️ **没有 `previewPort`**：预览端口是「框架监听哪个端口」的内部细节，用户拿到的是域名。
 * 服务端按镜像（`CONTAINER_ENV_IMAGES[].suggestedPreviewPort`）自动定，见
 * `apps/server/.../container-projects/create.ts`。
 */
export interface ContainerProjectCreateInput {
  /** 展示名（可空，默认取 slug 目录名）；**不进目录名** */
  name?: string
  image: ContainerEnvId
  /** 可选：创建后立刻从这个地址 clone */
  gitUrl?: string
  /** 内存上限（MB）；缺省 / `0` = 不限制（见 `ContainerProjectConfig.memoryLimitMb`） */
  memoryLimitMb?: number
  /** CPU 上限（核）；缺省 / `0` = 不限制（见 `ContainerProjectConfig.cpus`） */
  cpus?: number
}

/** 修改容器型项目的入参（都缺省 = 不改）。 */
export interface ContainerProjectUpdateInput {
  name?: string
  image?: ContainerEnvId
  /** 公网访问开关（新建默认开）；关掉后只保留本机回环预览 */
  exposed?: boolean
  /**
   * 预览 key。`undefined` = 不改；传新值 = 换掉（前端「重新生成」时传新值）。
   * 形状校验见 `PREVIEW_KEY_PATTERN`（8-64 位 `[A-Za-z0-9_-]`）。
   */
  previewKey?: string
  /**
   * 内存上限（MB）。`undefined` = 不改；**`0` = 取消限制**（不能靠 `undefined` 表达，
   * 否则「清空输入框」永远改不掉旧值）。
   */
  memoryLimitMb?: number
  /** CPU 上限（核）。`undefined` = 不改；**`0` = 取消限制** */
  cpus?: number
}

// ---------- AI Agent（工作区编程/运维助手） ----------

/**
 * 远端工作区引用：目录在某个 SSH 主机上。
 *
 * 只存主机 id，不冗余主机名 / 用户名 —— 展示时从主机清单现查；凭据也只在
 * SSH 主机存储里（`SecretBox`），绝不下发到客户端。
 */
export interface RemoteWorkspaceRef {
  hostId: string
}

/** Agent 工作区：绑定的目录，工具只能在工作区内读写与执行命令 */
export interface AgentWorkspace {
  id: string
  /** 展示名（默认取目录名，可改） */
  name: string
  /**
   * 绝对路径。
   *
   * - 没有 `remote` 时是本机绝对路径；
   * - 有 `remote` 时是该 SSH 主机上的 **POSIX 绝对路径**（如 `/srv/app`）。
   */
  path: string
  /**
   * 是不是**worktree 项目**：从某个项目按分支拉出来的独立工作树，目录落在
   * `<项目目录>/.worktree/<标识>`。侧栏把它嵌在父项目下（不再是平级项目）。
   */
  isWorktree?: boolean
  /**
   * worktree 项目所属的**父项目**（源工作区）id：侧栏据层级嵌套。
   *
   * 老数据可能没有这个字段（加字段前创建的 worktree），侧栏会按目录约定
   * `<父目录>/.worktree/<标识>` 回退推断，所以不影响展示。
   */
  parentWorkspaceId?: string
  /**
   * 登记时的目录**现在不在了**（被删 / 被移走 / 被换成文件）。
   *
   * 由服务端的巡检置位与清除（`apps/server/src/server/workspace-health.ts`，30s 一轮），
   * 客户端**不用自己去查** —— 工作区清单本来就经 state ws 推快照，字段一变界面就跟着变。
   * 侧栏据此把图标标成 error 色并禁掉「往这个目录里放东西」的动作（新建会话等）。
   *
   * `path` 为空的虚拟工作区（「任务」/「项目助手」）没有目录概念，**恒不置位**。
   */
  dirMissing?: boolean
  /**
   * 有这个字段就是**容器型项目**：目录由系统分配（用户不可选）、打开即起独立容器。
   * 缺省 = 普通（登记目录）项目，行为与加这个字段之前逐字一致。
   *
   * ⚠️ 重命名 / 重新登记都走 `addWorkspace`（逐字段重建整条记录），那边**必须保留**它，
   * 否则容器型项目会静默降级成普通项目（症状：打开它不再起容器）。
   */
  container?: ContainerProjectConfig
  /**
   * **临时工作区**：用户在输入框下方没选项目就发消息时，服务端为这条会话自动建的目录
   * （`<数据目录>/conversations/<会话 id>`）。
   *
   * 它与普通项目的区别只有一处 —— 侧栏不把它当项目列出来（否则每开一条无项目会话就
   * 多一个 uuid 项目行），它的会话归到「临时会话」那一组。除此之外一切照旧：有真实
   * 目录，文件工具 / 终端 / 技能都能用，会话文件落在它自己的 `.fizz/conversation/` 下。
   */
  scratch?: boolean
  /**
   * 有值 = **远端工作区**：目录在 `remote.hostId` 这台 SSH 主机上，`path` 是远端
   * POSIX 绝对路径。缺省 = 本机目录，行为与加这个字段之前逐字一致。
   *
   * ⚠️ 重命名 / 重新登记都走 `addWorkspace`（逐字段重建整条记录），必须原样保留；
   * 漏了会把远端工作区静默降级成本地工作区（症状：工具开始操作本机同名路径）。
   */
  remote?: RemoteWorkspaceRef
  createdAt: number
  updatedAt: number
}

/** 判一个工作区是不是远端（缺省字段 = 老数据 = 本地） */
export function isRemoteWorkspace(
  workspace: Pick<AgentWorkspace, 'remote'> | null | undefined
): boolean {
  return !!workspace?.remote?.hostId
}

// ---------- 笔记（登记任意目录，管理其中的 Markdown） ----------

/**
 * 一篇笔记的**根目录**：用户登记进来的任意文件夹，服务端只在这里面读写 `.md`。
 *
 * 为什么要有这层登记、而不是像工作区那样直接把路径传给文件接口：所有笔记文件接口
 * 都先 `resolveInside(root.path, rel)`，**没登记过的目录一律 403**。少了这层，
 * 那组接口就等于「读写服务端任意路径」的通用口子（见 `apps/server/src/server/notes.ts`）。
 */
export interface NotesRoot {
  id: string
  /** 绝对路径 */
  path: string
  /** 展示名（默认取目录名，可改） */
  name: string
  createdAt: number
}

/** 笔记树里的一项：子目录，或一篇 `.md` */
export interface NotesEntry {
  /** 相对所属根目录的路径，**一律 `/` 分隔**（跨平台统一，别用 path.join 的产物） */
  path: string
  /** 名字（文件含扩展名） */
  name: string
  type: 'dir' | 'file'
  /** 修改时间（毫秒） */
  mtime: number
  /** 字节数（目录恒为 0） */
  size: number
}

/**
 * `GET /api/notes/files` 应答：某个目录**一层**的内容。
 *
 * 刻意只列一层（前端懒加载）：笔记根是用户挑的任意目录，可能很大；展开某个子目录时
 * 客户端再单独请求那一层（`dir` 传子目录的相对路径）。
 */
export interface NotesDirResult {
  /** 这一层相对根目录的路径（根目录是 `''`） */
  dir: string
  /** 子目录 + `.md` 文件（目录在前，各自按名字排序） */
  entries: NotesEntry[]
}

/** `GET /api/notes/file` 应答：一篇笔记的正文 */
export interface NotesFileResult {
  /** 相对所属根目录的路径（`/` 分隔） */
  path: string
  content: string
}

/** `POST /api/notes/roots` 请求体：登记一个目录 */
export interface NotesRootInput {
  /** 绝对路径 */
  path: string
  /** 展示名；不给就取目录名 */
  name?: string
}

/** `POST /api/notes/file` 请求体：把一篇笔记整体覆盖写成 `content` */
export interface NotesWriteInput {
  rootId: string
  /** 相对根目录的路径（`/` 分隔）；文件不存在则创建 */
  path: string
  content: string
}

/** `POST /api/notes/file/new` 请求体：在 `dir` 下新建一篇空笔记 */
export interface NotesCreateInput {
  rootId: string
  /** 相对根目录的目录路径（`''` = 根目录） */
  dir: string
}

/** `POST /api/notes/file/new` 应答：新笔记的相对路径（客户端据此开标签） */
export interface NotesCreateResult {
  path: string
}

/** `POST /api/notes/file/rename` 请求体：只换文件名，不换目录 */
export interface NotesRenameInput {
  rootId: string
  /** 原相对路径（`/` 分隔） */
  path: string
  /** 新文件名（单层；带不带 `.md` 都行，服务端会补） */
  name: string
}

/** `POST /api/notes/file/rename` 应答 */
export interface NotesRenameResult {
  path: string
}

/**
 * 一轮对话的用量与耗时统计。
 *
 * 每轮结束后展示在助手消息下方，并**随消息一起落盘**（刷新后仍在）。字段由服务端从
 * AI SDK 的 usage 采集；`tps` 也在服务端算好（= outputTokens ÷ 生成窗口秒数），
 * 免得各端各算一遍、口径还不一致。
 */
export interface TurnUsage {
  /** 输入（提示）tokens */
  inputTokens: number
  /** 输出（生成）tokens */
  outputTokens: number
  /** 总 tokens */
  totalTokens: number
  /** 其中「思考」tokens（不少模型把这部分算进 output 里） */
  reasoningTokens?: number
  /** 命中缓存的输入 tokens */
  cachedInputTokens?: number
  /**
   * 本轮**最后一次请求**的上下文大小（pi 的 `calculateContextTokens`）。
   *
   * 为什么要跟 `inputTokens` 分开：
   * - `inputTokens` 是上游上报的**整轮累计** —— 多步工具循环里每个 step 都把上下文重发一遍，
   *   累加起来能有真实上下文的好几倍，拿它当「上下文大小」会虚高得离谱；
   * - `contextTokens` 取的是**最后一次请求**的 `input + output`（上游真实上报，含系统提示词、
   *   工具 schema 与缓存命中部分），就是输入框圆环显示的数。与 pi 的
   *   `estimateContextTokens` 同义：后者 = 最后一条带 usage 的助手消息的 usage + 其后消息的估算。
   *
   * 拿不到上游 usage（一个 finish chunk 都没收到）时才退回本地估算（±20%）。
   */
  contextTokens?: number
  /** 整轮耗时（毫秒）：从发起到结束 */
  durationMs: number
  /** 输出速度（tokens/秒）：outputTokens ÷ 生成窗口（首字 → 结束） */
  tps: number
  /**
   * 本轮**子任务（subagent）**的用量拆分，按 subagent id 索引。
   *
   * 为什么单独一份而不是并进上面的字段：父 run 的 usage 是主模型自己上报的，
   * 把子 agent 的 token 混进去会让「主 agent 花了多少」这个数变得不可信（也解释不清
   * 为什么一轮什么都没说就烧了几万 token）。所以父的数字保持父亲报告的样子，
   * 子任务的账单放这里，界面需要合计时自己加。
   *
   * 只有真的派过活才有；没启用子任务 / 一次都没派 = `undefined`。
   */
  subagents?: Record<string, SubagentTurnUsage>
}

/** 单个子任务（subagent）在本轮的累计用量 */
export interface SubagentTurnUsage {
  /** 派活次数（一次派活 = 主模型调用一次 `agent-<id>` 工具） */
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
}

/**
 * 整个会话的累计用量（各轮 `TurnUsage` 的合计）。
 *
 * 与 `TurnUsage` 的差别：**没有耗时 / TPS** —— 那两个是单轮指标，
 * 跨轮累计没有意义（总耗时 ≠ 各轮耗时之和，各轮之间还有排队 / 等审批的间隙）。
 * 这里只累计 token 数，供侧栏 / 会话头部展示「这个会话一共烧了多少 token」。
 *
 * `subagents` 是子任务（subagent）的拆分累计，与 `TurnUsage.subagents` 同口径 ——
 * 父的字段仍然是父自己上报的数，不吞子任务的账单（见那边的注释）。
 */
export interface ConversationUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cachedInputTokens?: number
  /** 按子任务（subagent）拆分的累计用量；从没派过活就没有这个字段 */
  subagents?: Record<string, SubagentTurnUsage>
}

/**
 * 会话的上下文摘要检查点（**手动压缩**的产物）。
 *
 * 语义：检查点之前的消息在**发给模型的历史里**被 `text` 摘要替代（合成一条 user 消息），
 * 之后的消息保持原文。存储与界面里的原始消息**一条不动** —— 压缩只发生在请求侧。
 * 自动压缩（超预算才触发）叠加在它上面工作：先按检查点切片，再对切片结果按预算压缩。
 */
export interface ConversationContextSummary {
  /** 摘要正文（模型生成） */
  text: string
  /** 检查点截止的**最后一条**消息 id（这之后的消息保持原文） */
  upToMessageId: string
  /**
   * 同上的创建时间兜底：upToMessageId 因编辑重发 / 删除而不存在时，按时间切片
   * （早于它的全部算作已摘要）。两者一起存，切片时优先 id、兜底时间。
   */
  upToCreatedAt: number
  /** 摘要生成时间 */
  createdAt: number
  /** 这次压缩的统计（popover / 横幅展示用） */
  stats: { beforeTokens: number; afterTokens: number; summarizedTurns: number; keptTurns: number }
}

/**
 * **自动压缩**的固化点（跨进程重启复用摘要）。
 *
 * 语义：从 `keepFromMessageId` 这条消息起保持原文，之前的由 `text` 摘要替代 ——
 * 与 `ConversationContextSummary` 一样只影响「发往模型的历史」，原始消息一条不动。
 *
 * 为什么不复用 `contextSummary`：
 * - 那个是用户点「压缩」的检查点，界面会显示「已开启摘要压缩」；
 * - 自动压缩是后台行为，不该出现在那个位置，也不该被那个按钮一并清掉
 *   （清了就退回每轮重算摘要）。
 */
export interface ConversationAutoSummary {
  /** 保留起点的消息 id（那一轮的第一条）。找不到 = 历史被改过，重新摘要 */
  keepFromMessageId: string
  /** 完整的摘要消息正文（已含「以下为先前 N 轮…」前缀）。原样复用，请求前缀才稳定 */
  text: string
  createdAt: number
}

/** 待办条目的状态（Agent 的 todo 清单用，见 @fizz/tools 的 todo_write） */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * 待办清单里的一条（Agent 自己维护、边做边更新的任务项）。
 *
 * 它是**工具结果的形状**、会随消息历史一起落盘（渲染端据此画勾选清单），
 * 不是独立存储 —— 见 `todo_write` 与 `PartView` 的 todo 分支。
 */
export interface TodoItem {
  /** 要做的事（一句话、可执行；顺序即执行顺序） */
  content: string
  status: TodoStatus
}

/**
 * 这一轮**为什么停** —— 只回答「是不是被预算截断的」，其余原因仍看 `finishReason`
 * （`done` / `error` / `aborted`）。
 *
 * 为什么单独一个字段、而不是把 `finishReason` 分叉出一个值：`finishReason` 是
 * 「这一轮怎么结束的」的总开关，前端渲染、系统通知、队列 worker、`conversation:finished`
 * 全都在按那三档判 —— 改它的取值域会牵连一整片，而这里要补的只是「被截断」这一条附加信息。
 *
 * 目前只有 `'max-steps'`（单轮工具步数用满）。以后若有「时间上限 / token 上限」这类，
 * 往这个联合里加，别动 `finishReason`。
 */
export type AgentStopReason = 'max-steps'

/** Agent 聊天消息（与 AiChatMessage 同构，part 形状一致） */
export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AgentMessagePart[]
  createdAt: number
  /** 这一轮的用量统计（只有助手消息、且一轮跑完后才有） */
  usage?: TurnUsage
  /**
   * 这一轮的耗时（毫秒）—— **只在没有 `usage` 时单独给**。
   *
   * 两种来路：
   * - **ACP**：它的 finish 帧从不带 token 用量（agent 协议里没有这层），每轮都只能给这个数；
   * - **内置后端被中断 / 出错**：中止的那一轮常常一个 usage chunk 都没收到（用户点停止时
   *   模型可能正卡在思考或工具执行里），`usage` 做不出来，但「已经工作了多久」仍然要看。
   *
   * 「这一轮用了多久」是 UI 真需要的一个数 —— 折叠条抬头拿它显示「已工作 1 分 12 秒」，
   * 缺了就只剩「思考 ×3 · 工具调用 ×5」的计数摘要（看着像这一轮没结束）。
   *
   * 因此耗时单独一个字段，`usage` 保持「有 token 才算有」（用量统计 / 消息底部那行
   * 不会被 0 token 污染）。渲染端读 `usage.durationMs ?? durationMs`。
   *
   * ⚠️ 落盘口径：内置后端会随助手消息落盘（`chat-turn.ts` 的 `persistAssistantMessage`），
   * 刷新后仍在；ACP 的消息本来就不落本地（真源在 agent 侧），这个字段只活在服务端的
   * 进程内快照里 —— 重启后靠 `session/load` 重建的视图没有它，抬头退回计数摘要。
   */
  durationMs?: number
  /**
   * 这一轮是**被截断**的（目前只有「撞上 `maxSteps` 工具步数上限」）：有值就说明模型
   * 是被闸停下的，不是自己说完的。
   *
   * 为什么挂在消息上而不是做成一个 part：part 会被 `toModelMessages` 回传进模型上下文，
   * 等于每轮白付一句「你上次被截断了」；这个字段只给渲染层，**不进模型上下文**
   * （与 `durationMs` 同一口径），落盘后刷新仍在，用户不会过一会儿又不知道为什么停的。
   *
   * 缺省 = 正常结束（老数据也都没有这个字段，渲染完全不变）。
   */
  stopReason?: AgentStopReason
  /** 这一轮实际跑了多少步（只有 `stopReason` 存在时给：撞上限时用户要看「用满了多少」） */
  steps?: number
  /**
   * 协作会话里这条回复是哪个 Agent 说的（只有 `kind: 'collab'` 的助手消息有）。
   * 渲染端据此在消息上方标出 Agent 名；普通会话的消息不带这两个字段。
   */
  agentId?: string
  agentName?: string
  /**
   * 上下文占用快照（见流事件的 `context-usage`）。
   *
   * 与 `usage` 分开：`usage` 是一轮跑完才有的完整统计；这个字段是「当前上下文用了
   * 多少 / 窗口多大」，**流式期间就会更新**，给上下文圆环当分子 / 分母用。
   *
   * 两条来源都写这里（同名同形，渲染端不分叉）：
   * - **ACP**：agent 侧通过 `usage_update` 上报，仅 ACP 会话会有；只在**本次会话进程内**
   *   有效（刷新就没了），跨刷新保留的是会话配置里的 `AgentConversation.acpContextUsage`；
   * - **内置**：`runAgent` 在每个工具步骤边界（`onIterationComplete`）估算后推来
   *   （口径同 `TurnUsage.contextTokens`），圆环因此在一轮之内也持续刷新。
   */
  contextUsage?: AcpContextUsage
}

/** 工作区目录项（文件树用；`path` 相对工作区根、统一 '/' 分隔） */
export interface AgentFsEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  /**
   * 命中忽略规则的条目（默认黑名单 / 工作区 `.gitignore`）。
   *
   * 平时列表**根本不会返回**它们；只有显式要求「连被忽略的也列出来」（文件树的
   * 「显示被忽略」开关）时才会带上这个标记 —— 树里据此把它压暗，用户一眼能看出
   * 「这东西平时是被藏起来的」，而不是以为它本来就该在这儿。
   */
  ignored?: boolean
}

/** 读到的文件内容（编辑器用；二进制与超大文件在主进程就被挡掉） */
export interface AgentFsFile {
  path: string
  content: string
  /** 字节数 */
  size: number
}

/**
 * 附件引用：先经 POST /api/uploads 上传拿到的 url，再随消息提交 / 入队 / 落历史。
 * 三处共用同一形状（ChatRequest.files / QueuedMessage.files / file part），改一处三处同步。
 */
export interface UploadFileRef {
  /** 原始文件名（仅展示用；存储名是服务端生成的 uuid） */
  name: string
  mediaType: string
  url: string
  /**
   * 哪个上传源产出的这条引用：`local`（缺省）= 内置存储，其余 = 插件注册的上传源
   * （见 `POST /api/uploads` 的 `provider` 与 `UploadProviderView`）。
   *
   * 只作**展示与回显**用 —— 服务端的归属校验认的是「已签发 URL 记录」而不是这个字段
   * （客户端能改它，不能当依据）。
   */
  provider?: string
}

/**
 * 待发送队列里的一条消息：会话进行中用户继续发的内容先排在这里，本轮结束依次发出。
 *
 * 与 `AgentChatMessage` 的区别：它**还没发给模型**，因此不落消息历史（否则刷新后
 * 会看到两遍）。队列整体持久化在会话上（`AgentConversation.queuedMessages`），
 * 换设备 / 刷新都能续上，拖拽排序（见 `ConversationQueueInput`）也一并落服务端。
 */
export interface QueuedMessage {
  /** 前端生成的稳定 id（本地 `nextLocalId('q')`），删除 / 排序 / 编辑都认它 */
  id: string
  /** 消息正文（trim 后非空才入队；带附件时允许为空串） */
  text: string
  /** 入队时间（毫秒；只用于展示与排序稳定性，不参与业务） */
  createdAt: number
  /** 附件（先上传拿到 url 的那份引用），随消息一起入队与发出 */
  files?: UploadFileRef[]
}

/**
 * Agent 会话：一个工作区下可以有多个独立会话。
 *
 * 消息随会话一起持久化 —— 会话列表的意义就是能随时切回去接着聊，
 * 而 ACP 后端的 agent 上下文按会话隔离（见 services/ai/acp-agent.ts）。
 */

/** ACP agent 上报的上下文占用快照（`session/update` 的 `usage_update`：used / size） */
export interface AcpContextUsage {
  /** 当前躺在上下文里的 tokens */
  used: number
  /** 该 agent 的上下文窗口大小 */
  size: number
  /**
   * `used` 里**压缩动不了的那部分**：系统提示词 + 工具 schema 的估算。
   *
   * 只有内置 agent（内置）会带 —— 外部 ACP agent 的提示词在我们这儿算不出来。
   * 界面用它回答「圆环为什么红了却压不动」：历史已经压到保留区，剩下的全是这块。
   */
  base?: number
}

/** ACP Session Modes 里的一个档位（agent 在 session/new·load 里广告，名字 / 语义全由 agent 自定义） */
export interface AcpModeOption {
  id: string
  name?: string
  description?: string
}

/**
 * ACP 会话的「模式」快照（落会话配置，见 `AgentConversation.acpModes`）。
 *
 * - `opencode` 用它表达**模式 / 权限档**（会话里摆在权限 pill 的位置，可切换）；
 * - 数据有两个来源，由 `configId` 区分（见下）；
 * - `current` 记的是**用户意图**（用户选的档）而非 agent 的运行时状态 —— 每轮发送前按它下发。
 */
export interface AcpModesState {
  available: AcpModeOption[]
  /** 当前档；null = agent 没给 / 未知 */
  current: string | null
  /**
   * 承载这个模式的通道（决定切换走哪条方法）：
   *
   * - **没有这个字段** = 规范的 **Session Modes**（`session/new` / `session/load` 应答里的
   *   `modes.availableModes`）→ 切换走 `session/set_mode`；
   * - **有这个字段** = configOptions 里的 `category: 'mode'` 选项（**opencode 就是这么给的**：
   *   `{ id: 'mode', name: 'Session Mode', currentValue: 'build' }`）→ 切换走
   *   `session/set_config_option`，这里的值就是那个选项的 id。
   */
  configId?: string
}

/** ACP configOptions 里的一个下拉项（thought_level 的候选用） */
export interface AcpSelectOption {
  value: string
  name: string
  description?: string
}

/**
 * ACP 会话的思考档（`thought_level` configOption）快照。
 *
 * 与 `AcpModesState` 分开：`pi` 这类 agent 用 configOptions 而不是 Session Modes 表达思考档，
 * 下发走 `session/set_config_option`。`current` 同样是**用户意图**。
 */
export interface AcpThoughtLevelState {
  /** 承载它的 config 选项 id（下发时回传） */
  configId: string
  current: string | null
  options: AcpSelectOption[]
}

/**
 * ACP 会话的**权限答复策略**（会话级设置，与内置 agent 的三档 `AiPermissionMode` 分开）。
 *
 * - `confirm`（缺省）：agent 每次发 `session/request_permission` 都转给用户挑（确认卡）；
 * - `allow`：**应用层直接替用户答复「允许」**，不再弹卡 —— 等于把 agent 侧的 `ask` 变成放行。
 *
 * ⚠️ 只在 agent 真的发问时生效：agent 自己的策略若是 `deny`，它根本不发这个请求，
 * 应用层无从放宽。
 */
export type AcpPermissionMode = 'confirm' | 'allow'

// ---------------------------------------------------------------------------
// 多智能体协作（collab）
// ---------------------------------------------------------------------------
//
// 一个 collab 会话 = 一条共享会话 + 若干平级的内置 Agent。
// 用户点名（@）谁就由谁处理；没有点名则广播给全部 Agent，各自判断是否接手；
// Agent 之间需要协同用 `SendMessage` 投递消息。
//
// ⚠️ 这里只放**跨端契约**（渲染端要名单 / 服务端要持久化 / agent 要编排）。运行时
// 编排器在 `@fizz/agent/src/collab.ts`，不要把这些类型反向塞进 agent 包。

export type CollabAgentStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'error'
  | 'cancelled'

export type CollabTaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export type CollabMessageKind = 'delegate' | 'result' | 'note' | 'ask' | 'answer' | 'system'

/** 一个可配置的协作 Agent。 */
export interface CollabAgentConfig {
  id: string
  name: string
  /** 一句话职责（写进该 Agent 的系统提示词，也用作 @ 候选的说明） */
  role: string
  /** 系统提示词（追加在 Fizz 基础提示词之后） */
  instructions: string
  /** 模型配置 id（`AiModelConfig.id`）；缺省 = 沿用会话主模型 */
  configId?: string
  /** 上游模型 id（`AiModelConfig.models` 的一项） */
  modelId?: string
  /** 权限档；默认 `readonly`（子 Agent 不默认获得写权限） */
  permissionMode: AiPermissionMode
  /**
   * 允许使用的工具 key 白名单；缺省 = 只读基础集。
   * key 与 `@fizz/tools` 的 `buildAgentTools` 输出一致（如 `read_file` / `write_file`）。
   */
  tools: string[]
  /** 单个任务最多跑多少步（工具轮）；缺省 12，服务端收敛到 1~40 */
  maxSteps?: number
}

/** 一个协作会话的配置（落会话目录的 `config.json`） */
export interface CollabSettings {
  /** 参与共享会话的 Agent 名单（平级；没有「主智能体」） */
  agents: CollabAgentConfig[]
  /** 同一时刻最多并行跑几个 Agent */
  maxParallel: number
  /** 单轮用户消息最多触发多少次 Agent 运行（含 SendMessage 唤醒），防止无限协同烧钱 */
  maxTasksPerTurn: number
}

export function createCollabAgent(overrides: Partial<CollabAgentConfig> = {}): CollabAgentConfig {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 10)}`,
    name: '新智能体',
    role: '通用协作助手',
    instructions: '',
    permissionMode: 'readonly',
    tools: [...COLLAB_DEFAULT_TOOLS],
    ...overrides
  }
}

export const DEFAULT_COLLAB_SETTINGS: CollabSettings = {
  agents: [],
  maxParallel: 3,
  maxTasksPerTurn: 16
}

const COLLAB_DEFAULT_TOOLS = ['read_file', 'list_files', 'search_files', 'find_files', 'web_fetch']

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/** 收敛手改坏 / 老数据的协作配置：绝不抛错，并且保证 agent id 唯一 */
export function normalizeCollabSettings(value: unknown): CollabSettings {
  const input = (value ?? {}) as Partial<CollabSettings>
  const seen = new Set<string>()
  const agents: CollabAgentConfig[] = []
  for (const raw of Array.isArray(input.agents) ? input.agents : []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<CollabAgentConfig>
    let id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || seen.has(id)) id = createCollabAgent().id
    seen.add(id)
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '未命名智能体'
    const role = typeof item.role === 'string' ? item.role.trim() : ''
    const instructions = typeof item.instructions === 'string' ? item.instructions : ''
    const tools = Array.isArray(item.tools)
      ? [...new Set(item.tools.filter((t): t is string => typeof t === 'string' && !!t.trim()))]
      : [...COLLAB_DEFAULT_TOOLS]
    const permissionMode: AiPermissionMode =
      item.permissionMode === 'full' || item.permissionMode === 'confirm'
        ? item.permissionMode
        : 'readonly'
    const configId =
      typeof item.configId === 'string' && item.configId.trim() ? item.configId.trim() : undefined
    const modelId =
      typeof item.modelId === 'string' && item.modelId.trim() ? item.modelId.trim() : undefined
    agents.push({
      id,
      name,
      role,
      instructions,
      permissionMode,
      tools,
      ...(configId && modelId ? { configId, modelId } : {}),
      ...(item.maxSteps !== undefined
        ? { maxSteps: clampInt(item.maxSteps, 12, 1, 40) }
        : {})
    })
  }
  return {
    agents,
    maxParallel: clampInt(input.maxParallel, DEFAULT_COLLAB_SETTINGS.maxParallel, 1, 8),
    maxTasksPerTurn: clampInt(
      input.maxTasksPerTurn,
      DEFAULT_COLLAB_SETTINGS.maxTasksPerTurn,
      1,
      64
    )
  }
}

/** 一次 Agent 运行（用户点名 / 广播 / SendMessage 唤醒） */
export interface CollabTask {
  id: string
  agentId: string
  agentName: string
  /** 发起方：`user` 或某个 agent id */
  from: string
  /** 上层任务 id（SendMessage 唤醒时指向投递方那次运行；用户发起为 undefined） */
  parentTaskId?: string
  prompt: string
  /** 主智能体补充的上下文（可选；会拼在 prompt 前） */
  context?: string
  status: CollabTaskStatus
  output?: string
  error?: string
  /**
   * 这一轮的**过程记录**（思考 / 正文 / 工具调用 + 结果），形状与主消息的 `parts` 完全同构。
   *
   * 存在的理由：子 Agent 没有会话记录，任务原先只存 `prompt` + 最终 `output`，右侧面板
   * 里就只有「一问一答两段纯文本」—— 主对话每轮都有的思考折叠条、工具调用行通通没有，
   * 观感差得很远。有它之后 `CollabAgentChatPanel` 直接把 `parts` 交给同一个 `MessageList`，
   * 折叠条 / 工具卡 / 代码块都是同一套渲染。与内置子任务的 `SubagentDelegation.parts`
   * 同一口径。
   *
   * 缺省 = 老任务（加这个字段之前跑的）或没跑到任何事件：渲染端退回 `output` 纯文本。
   * 落盘前会按字符预算裁剪（见 `@fizz/agent` 的 `collab-parts.ts`），所以这里**不是**
   * 完整过程，只是最近若干步。
   */
  parts?: AgentMessagePart[]
  /** 本任务用量（只统计子 Agent 自己） */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

/** Agent 之间的一条可见消息（SendMessage 投递记录） */
export interface CollabMessage {
  id: string
  from: string
  to: string
  kind: CollabMessageKind
  text: string
  taskId?: string
  createdAt: number
}

/** 单个 Agent 的实时运行态（内存态；刷新后从 collab.json 恢复为最近一次快照） */
export interface CollabAgentRuntime {
  status: CollabAgentStatus
  taskId?: string
  toolName?: string
  step?: number
  startedAt?: number
  updatedAt: number
  /** 正在流式输出的文本（只用于名单实时展示，不落盘） */
  liveText?: string
  error?: string
}

/** 协作会话的持久化状态（独立文件 `collab.json`，避免会话列表被任务/消息撑大） */
export interface CollabState {
  version: 1
  tasks: CollabTask[]
  messages: CollabMessage[]
  statuses: Record<string, CollabAgentRuntime>
  updatedAt: number
}

/**
 * 流式增量并入 parts：接进**本步内最近的一条同类型 part**，不一个字一个 part。
 *
 * 「本步」的边界是工具调用：往回找的路上撞到 `tool-call` / `tool-result` 就另起一段 ——
 * 那是被切开的另一段过程，正文不该跨过工具卡继续长。错误块（`⚠️ ` 前缀）同样是边界，
 * 否则一段正常回答会被并进错误提示里，跟着一起渲染成错误。
 *
 * 为什么不是「只接最后一条」（2026-11 修）：ACP 侧（以及部分网关）会把思考与正文
 * **交替**流出来 —— `[思考两字][正文三字][思考两字]…`。只认最后一条时每一小段各自成
 * 一条 part，而渲染端按「连续的同类 part 成组」画：
 * - 流式中每段思考都被单独包成一个「思考过程」分组，一段话被拆成十几个 markdown 段落；
 * - 整轮结束后除最后一小段正文，其余全被收进折叠条 —— 正文等于被藏了。
 * 往回找同类那条接着写，两种流交替回来就是「一条思考 + 一条正文」。
 *
 * 前后端共用这一份：服务端收口消息 / `CollabTask.parts`、前端拼运行中的实时预览，
 * 两处的合并口径必须一致，否则「跑的时候」和「跑完之后」的卡片会跳一下。
 */
export function appendPartDelta(
  parts: AgentMessagePart[],
  type: 'text' | 'reasoning',
  delta: string
): void {
  if (!delta) return
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (!part) continue
    // file 也是「位置性」内容：跨过它把后文并进它前面那段，图片在时间线上的位置
    // 就整体往前挪了（表现为「先说完话，图又跑到开头」）。遇到就收手，另起一段。
    if (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'file') break
    // 错误块不接增量（见上面注释）；判据与渲染端的 `isErrorText` 同一口径
    if (part.type === 'text' && part.text.trimStart().startsWith(ERROR_TEXT_PREFIX)) break
    if (part.type !== type) continue
    // 复制替换而不是原地改：调用方（前端 store）每帧做的是浅拷贝数组，
    // 共享的 part 对象被原地改会「追溯」污染上一帧的快照。
    parts[index] = { ...part, text: part.text + delta }
    return
  }
  parts.push({ type, text: delta })
}

/** 工具调用开始：先落一条 part，结果回来时用 `foldToolResult` 回填 */
export function appendToolCallPart(
  parts: AgentMessagePart[],
  call: { toolCallId: string; toolName: string; input: unknown }
): void {
  parts.push({
    type: 'tool-call',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input
  })
}

/**
 * 工具结果回填到对应的 `tool-call` 上。
 *
 * 不另起一条 `tool-result`：主对话落盘的就是「结果挂在调用上」，渲染端也只认这一种。
 * 找不到对应调用（事件乱序 / 已被裁剪掉）就静默丢弃 —— 结果单独飘着没有意义。
 */
export function foldToolResult(
  parts: AgentMessagePart[],
  result: { toolCallId: string; output: unknown; isError?: boolean }
): void {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (!part || part.type !== 'tool-call' || part.toolCallId !== result.toolCallId) continue
    // 同样用复制替换（理由见 `appendPartDelta`）；`isError` 一旦置上不再摘掉
    parts[index] = {
      ...part,
      output: result.output,
      ...(result.isError ? { isError: true } : {})
    }
    return
  }
}

/**
 * 过程记录的形状收敛。
 *
 * `collab.json` 是本地文件，用户可能手改坏；渲染端会按 `type` 直接分支，所以这里
 * 只留认得的分支，字段不全的整条丢掉。
 *
 * `tool-result` 不收：结果在写盘前已经折叠到对应 `tool-call.output` 上（与主对话
 * 落盘口径一致），单独一条飘着渲染出来也是一张空卡。
 */
function normalizeCollabParts(value: unknown): AgentMessagePart[] {
  const out: AgentMessagePart[] = []
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object') continue
    const part = raw as Record<string, unknown>
    if (part.type === 'text' || part.type === 'reasoning') {
      if (typeof part.text !== 'string') continue
      out.push({ type: part.type, text: part.text })
      continue
    }
    if (part.type === 'tool-call') {
      if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') continue
      out.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input ?? null,
        ...(part.output === undefined ? {} : { output: part.output }),
        ...(part.isError === true ? { isError: true } : {})
      })
    }
  }
  return out
}

export function normalizeCollabState(value: unknown): CollabState {
  const input = (value ?? {}) as Partial<CollabState>
  const tasks: CollabTask[] = []
  for (const raw of Array.isArray(input.tasks) ? input.tasks : []) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as Partial<CollabTask>
    if (!t.id || !t.agentId) continue
    tasks.push({
      id: String(t.id),
      agentId: String(t.agentId),
      agentName: typeof t.agentName === 'string' ? t.agentName : String(t.agentId),
      from: typeof t.from === 'string' ? t.from : 'main',
      ...(typeof t.parentTaskId === 'string' ? { parentTaskId: t.parentTaskId } : {}),
      prompt: typeof t.prompt === 'string' ? t.prompt : '',
      ...(typeof t.context === 'string' ? { context: t.context } : {}),
      status:
        t.status === 'running' ||
        t.status === 'done' ||
        t.status === 'error' ||
        t.status === 'cancelled'
          ? t.status
          : 'queued',
      ...(typeof t.output === 'string' ? { output: t.output } : {}),
      ...(typeof t.error === 'string' ? { error: t.error } : {}),
      ...(() => {
        // 过程记录：空数组不必写进文件（老任务没有这个字段）
        const parts = normalizeCollabParts(t.parts)
        return parts.length ? { parts } : {}
      })(),
      ...(t.usage && typeof t.usage === 'object'
        ? {
            usage: {
              inputTokens: Number(t.usage.inputTokens) || 0,
              outputTokens: Number(t.usage.outputTokens) || 0,
              totalTokens: Number(t.usage.totalTokens) || 0
            }
          }
        : {}),
      createdAt: Number(t.createdAt) || Date.now(),
      ...(typeof t.startedAt === 'number' ? { startedAt: t.startedAt } : {}),
      ...(typeof t.finishedAt === 'number' ? { finishedAt: t.finishedAt } : {})
    })
  }
  const messages: CollabMessage[] = []
  for (const raw of Array.isArray(input.messages) ? input.messages : []) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Partial<CollabMessage>
    if (!m.id || !m.from || !m.to) continue
    messages.push({
      id: String(m.id),
      from: String(m.from),
      to: String(m.to),
      kind:
        m.kind === 'delegate' ||
        m.kind === 'result' ||
        m.kind === 'note' ||
        m.kind === 'ask' ||
        m.kind === 'answer' ||
        m.kind === 'system'
          ? m.kind
          : 'note',
      text: typeof m.text === 'string' ? m.text : '',
      ...(typeof m.taskId === 'string' ? { taskId: m.taskId } : {}),
      createdAt: Number(m.createdAt) || Date.now()
    })
  }
  const statuses: Record<string, CollabAgentRuntime> = {}
  const rawStatuses = (input.statuses ?? {}) as Record<string, Partial<CollabAgentRuntime>>
  for (const [id, raw] of Object.entries(rawStatuses)) {
    if (!raw || typeof raw !== 'object') continue
    const status: CollabAgentStatus =
      raw.status === 'queued' ||
      raw.status === 'running' ||
      raw.status === 'waiting' ||
      raw.status === 'done' ||
      raw.status === 'error' ||
      raw.status === 'cancelled'
        ? raw.status
        : 'idle'
    statuses[id] = {
      status: status === 'running' || status === 'queued' || status === 'waiting' ? 'idle' : status,
      ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
      ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName } : {}),
      ...(typeof raw.step === 'number' ? { step: raw.step } : {}),
      ...(typeof raw.startedAt === 'number' ? { startedAt: raw.startedAt } : {}),
      updatedAt: Number(raw.updatedAt) || Date.now(),
      ...(typeof raw.error === 'string' ? { error: raw.error } : {})
    }
  }
  return {
    version: 1,
    tasks: tasks.slice(-200),
    messages: messages.slice(-500),
    statuses,
    updatedAt: Number(input.updatedAt) || Date.now()
  }
}

export interface AgentConversation {
  id: string
  /** 所属工作区 id */
  workspaceId: string
  /** 标题（默认由首条用户消息截断生成，可重命名） */
  title: string
  /**
   * 会话形态：
   * - 缺省 / `'chat'` = 普通对话（内置 Agent 或 ACP，由 `backend` 决定）；
   * - `'collab'` = 多智能体协作（主智能体 + 可配置子 Agent，仅内置 Agent）。
   */
  kind?: 'chat' | 'collab'
  /** 协作配置（仅 `kind: 'collab'`；运行态见独立的 `collab.json`） */
  collab?: CollabSettings
  /** 该会话的完整消息历史 */
  messages: AgentChatMessage[]
  /**
   * 该会话使用的后端与选中项 —— **按会话独立**，创建 / 选择时显式落库；
   * 不存在「跟随工作区 / 跟随默认」的回退（未绑定的会话发不了对话轮，服务端 400）。
   * `configId` 的含义由 `backend` 决定：`builtin` 下是 `AiModelConfig.id`，
   * `acp` 下是 `AcpAgentConfig.id`（创建后锁定，不可换 agent）。
   */
  backend?: AgentBackend
  configId?: string
  /**
   * 进一步记住**用哪个上游模型**：
   * - `builtin` 下是 `AiModelConfig.models` 的一项（必选，不存在「配置默认模型」）；
   * - `acp` 下是**外部 agent 自己广告的模型值**（`AcpModelChoices.options[].value`，
   *   每轮对话前用 `session/set_config_option` 下发）；未设置 = 用 agent 自己的默认
   *   （那是 agent 侧的缺省，不是 Fizz 的设置）。
   */
  modelId?: string
  /**
   * 内置 Agent 这一轮用多强的思考（缺省 = 跟随模型，见 `AiReasoningEffort`）。
   * 按会话记住，切换模型不丢；ACP 会话不读这个字段（那边用 `acpThoughtLevel`）。
   */
  reasoningEffort?: AiReasoningEffort
  createdAt: number
  updatedAt: number
  /**
   * ACP 会话绑定（`backend: 'acp'` 时有意义）：这个会话在 agent 侧的 session id。
   *
   * - **创建时确定类型**：`backend` 与 `configId`（acp 下 = agent id）建好后不可换，
   *   能换的只有 `modelId`（agent 自己广告的模型，经 `session/set_config_option` 下发）；
   * - **消息不落本地**：acp 会话的交互记录保存在 agent 侧（opencode 们自己管），
   *   本地 `messages` 恒为空 —— 跨重启用 `session/load` 接回（后续接入）；
   * - 内置会话没有这个字段，消息照旧全量落盘。
   */
  acpSessionId?: string
  /**
   * ACP 会话的 Session Modes 快照（`opencode` 的权限档；见 `AcpModesState`）。
   * 在 `session/new`（新建会话）与 `session/load`（打开会话）时写入，用户切换时更新 `current`。
   * 非 acp 会话 / agent 没广告档位时缺省不写。
   */
  acpModes?: AcpModesState
  /**
   * ACP 会话的思考档快照（`pi` 的 `thought_level`；见 `AcpThoughtLevelState`）。
   * 写入时机同上。非 acp 会话 / agent 没广告该选项时缺省不写。
   */
  acpThoughtLevel?: AcpThoughtLevelState
  /**
   * ACP 会话的权限答复策略（见 `AcpPermissionMode`）：缺省 `confirm`（逐次问用户），
   * `allow` = 应用层自动放行（不再弹确认卡）。按会话记住，存在 `config.json` 里。
   */
  acpPermissionMode?: AcpPermissionMode
  /**
   * ACP agent 上报的**上下文占用**（`usage_update` 的快照）。
   *
   * 落进会话配置是为了**刷新后圆环还能显示** —— acp 会话的消息在 agent 侧，刷新时的
   * `session/load` 回放里不一定带 `usage_update`，只靠消息上的 `contextUsage` 一刷新就没了。
   */
  acpContextUsage?: AcpContextUsage
  /**
   * 这个会话**允许使用的 MCP server**（`McpServerConfig.id` 的清单，可多选）。
   *
   * - 缺省 / 空数组 = **一个都不用**（存量会话天然落在这里，无需数据迁移）；
   * - 只有列在这里的 server 才会被接进这一轮的工具集（见 `app/api/chat/route.ts`）；
   * - 会话内改选立刻持久化（`setConversationTarget`），刷新 / 重进都在。
   *
   * 注意：MCP 的「启停」已上移到**会话级**，配置项本身没有总开关了
   * （见 McpTab：配了就是可被选，全局不再有 enabled 概念）。
   */
  mcpServerIds?: string[]
  /**
   * 这个会话的浏览器偏好（总开关）：**按会话独立**，缺省 = 关
   * （`DEFAULT_BROWSER_SETTINGS`，没有「全局默认」那一层了）。
   *
   * 开关关掉 = 这一轮不挂内置 `browser_*` 工具、也不追加提示词里的浏览器说明；
   * 会话挂了 `playwright-mcp` 这类**同名**工具时，内置那一侧的 `browser_*` 会自动让位
   * （见 `apps/server/src/server/chat-turn.ts`），不需要用户手动二选一。
   */
  browserSettings?: BrowserSettings
  /**
   * 上下文摘要检查点（手动压缩的产物，见 `ConversationContextSummary`）。
   * 存在时，组装发往模型的历史 = 摘要消息 + 检查点之后的原文 + 本轮输入。
   * 仅内置 agent（内置）会话会有；ACP 会话的上下文在 agent 侧，与本地无关。
   */
  contextSummary?: ConversationContextSummary
  /**
   * 自动压缩的固化点（见 `ConversationAutoSummary`）：进程重启后第一次请求直接复用它，
   * 不必重新摘要。只由服务端写（`setAutoSummary`），**前端不需要读** —— 它纯属内部状态。
   * 手动压缩生效时会被清掉（避免两层摘要叠加）。
   */
  autoSummary?: ConversationAutoSummary
  /**
   * 待发送队列：会话进行中用户继续发的消息排在这里，本轮正常结束由泵**依次自动发出**。
   *
   * - 顺序即发送顺序（拖拽排序后整体覆盖，见 `PATCH /api/conversations/:id/queue`）；
   * - 每条都在前端生成 id（删除 / 编辑 / 排序都认它），服务端不解释、只原样存；
   * - 缺省 / 空数组 = 没有排队消息（存量会话天然落在这里，无需数据迁移）。
   *
   * ⚠️ 队列发的只是**正文**：附件、MCP、模型等都在真正发出一轮时才取会话的当前设置 ——
 *   排队时记下的东西会被之后的选择污染。这是有意为之（入队时刻的上下文对用户没有意义）。
   */
  queuedMessages?: QueuedMessage[]
  /**
   * 「**自己冒出来的**、用户还没点开过」（缺省 = 已看过 / 与用户无关）。
   *
   * 只有一种会话会被打上它：**定时任务触发出来的那一轮** —— 它是自己到点冒出来的，
   * 用户不会正盯着它（手动新建的会话不用标，因为那是用户自己点的）。
   * 侧栏据此在会话行、以及它所属的工作区名上点一颗红点；用户点开这个会话时清掉
   * （`openConversation` → `POST /api/conversations/:id/seen`）。
   *
   * 用布尔而不是「已读时间戳」：既不需要按时间排序，也不需要显示「何时读过」。
   * 存量会话没有这个字段 = 已看过，**无需数据迁移**。
   */
  unseen?: boolean
  /**
   * 归档时间（毫秒；**缺省 = 未归档**）。
   *
   * 归档 = 「从项目树里收进已归档区」，不是删除：会话与消息原封不动，随时能取回
   * （`setConversationArchived` 取消归档即清掉这个字段）。用时间戳而不是布尔，
   * 是因为归档区按它倒序排（先归档的会话通常更旧），且悬停能显示归档于何时。
   *
   * 存量会话天然没有这个字段 = 全部未归档，**无需数据迁移**。
   */
  archivedAt?: number
  totalUsage?: ConversationUsage
  /**
   * 分叉来源（「从此签出」的产物，见 `forkConversation`）。
   *
   * 侧栏据此显示「分支自 xxx」；分叉本身只是一次带截取历史的复制（历史到
   * `upToMessageId` 含该条为止），原会话一字不动 —— 之后两个会话各自独立，
   * 类似 `git checkout -b`。内置会话才有意义（ACP 的上下文在 agent 侧，签不了）。
   */
  forkedFrom?: { conversationId: string; upToMessageId: string; createdAt: number }
}

/**
 * 一条「错误」在 parts 里的**文本前缀**。
 *
 * 错误**不是**独立 part 类型，而是走消息流落成一条 `text` part（服务端
 * `server/agent-parts.ts` 的 `errorPart` 与前端 `shared/lib/parts.ts` 的 `applyEvent`
 * 两处都这么写），历史里存的也就是这段纯文本 —— 所以加新字段也救不了老数据。
 *
 * 两端共用这个常量、渲染层靠它认出「这一段是错误」（`isErrorText`）：
 * 认出来才能挂「重新加载」按钮，否则用户只能刷新整页 / 重启 App。
 * **改前缀 = 老消息上的按钮会消失**，别随手动。
 */
export const ERROR_TEXT_PREFIX = '⚠️ '

export type AgentMessagePart =
  | { type: 'text'; text: string }
  | {
      /** 附件（图片 / PDF）：`url` 是上传接口（POST /api/uploads）返回的地址，随历史落盘 */
      type: 'file'
      url: string
      mediaType: string
      /** 原始文件名（仅展示用；存储名是服务端生成的 uuid） */
      name: string
      /**
       * 这条附件由哪个上传源产出（`local` = 内置存储，其余 = 插件注册的上传源）。
       * 缺省 = 老数据（加这个字段之前上传的），一律按内置存储处理。
       */
      provider?: string
    }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
      /**
       * **流式期**的原始入参文本（累积的模型输出，通常是**截断的** JSON）。
       *
       * 只喂渲染（写文件时能看到内容一点点变长）；完整 `tool-call` 到达时会被丢掉
       * （见 `lib/parts.ts` 的 applyEvent），所以它**不会进落盘的历史** ——
       * 刷新 / 切会话后卡片回到「只有完整 input」的状态，这是预期行为。
       */
      inputText?: string
      /**
       * 子任务（subagent）的**实时输出文本**（流式期间累积）。
       *
       * 与 `inputText` 分开的原因：那个装的是「截断的 JSON 入参」，喂给 JSON 预览
       * 逻辑；子 agent 的输出是自然语言，塞进去会被当成坏 JSON 高亮。两者都是
       * 只喂渲染、不进落盘历史的临时字段。
       */
      subagentText?: string
      /**
       * 子任务**最近一次**工具调用（只给工具名，不铺开结果）。
       *
       * 与 `subagentText` 一样只喂渲染、不进落盘历史。子 agent 在长时间翻代码、
       * 还没吐出正文时，卡片靠它显示「正在 read_file」，避免看起来像卡死。
       */
      subagentTool?: string
      /** 子任务已经发起过多少次工具调用（只增不减） */
      subagentToolCount?: number
      /**
       * 上一条 `subagentTool` 对应的子侧 toolCallId：同一调用重复上报时不再计数。
       * 只喂渲染，不进落盘历史。
       */
      subagentToolId?: string
      /**
       * 子任务的**完整过程记录**（子 agent 自己的思考 / 工具调用 / 正文）。
       *
       * 与上面几个 `subagent*` 字段的本质区别：那些是「派活卡上的一行进度」，只喂渲染；
       * 这一份**随消息落盘**，让用户能 attach 进去看整段过程（折叠条 / 工具卡与主任务
       * 完全同一套渲染），也让人能回答「这次派活到底为什么没给结论」。
       *
       * 形状刻意与主消息的 `parts` 同构：`SubagentDelegation.parts` 就是
       * `AgentMessagePart[]`，渲染端直接复用 `MessageParts`（见 `SubagentPanel`）。
       * 子 agent 没有派活工具，所以这份 parts 里不会再有 `delegation`（不会递归）。
       */
      delegation?: SubagentDelegation
      /**
       * **流式期**的命令实时输出（stdout / stderr 分开累积）。
       *
       * 与 `inputText` / `subagentText` 同性质：只喂渲染、不进落盘历史；
       * 收口时机是 `tool-result` 回填（见 `lib/parts.ts` 的 applyEvent）——
       * 卡片随之换成结果直显。超 `MAX_LIVE_OUTPUT`（64_000 字符）只保留尾部，
       * 防 `yes` / `find /` 之类把前端内存吃光。
       */
      liveOutput?: { stdout: string; stderr: string }
      /**
       * ACP 工具种类（session/update 的 toolCall.kind：read / edit / execute …）。
       * 内置工具没有 —— 前端据此对 ACP 工具做「内容直显」。
       */
      acpKind?: string
      /**
       * ACP 工具的展示内容（toolCall.content 原样收窄，见 AcpToolCallContent）。
       * 有它就不走「输入 / 输出 JSON」的折叠卡，直接渲染 diff / 文本等。
       */
      acpContent?: AcpToolCallContent[]
      /**
       * ACP agent 给的展示标题（session/update 的 toolCall.title，例如
       * `Bash: npm test`）。**它不是工具名** —— 不少 agent 压根不给 name，
       * 标题里塞的是具体命令 / 脚本文本，拿它当工具名会把卡片标题撑成一长串命令。
       * 只悬停提示 / 兜底展示用，头部标题请看 `toolCardTitle`。
       */
      title?: string
      /**
       * 工具结果 —— **落盘形状就是「回填到对应的 tool-call 上」**，不另起一个
       * `tool-result` part（见 `apps/server/src/server/agent-parts.ts` 的
       * `foldEventIntoParts` 与前端 `lib/parts.ts` 的 `applyEvent`，两端同构）。
       *
       * 缺省 = 这次调用没有结果（用户中止 / 工具没跑完）：渲染端据此判「运行中」，
       * 历史转换据此补占位结果。
       *
       * ⚠️ 字段名必须与 `tool-result` part 的 `output` 完全一致，且
       * `packages/agent/src/model-messages.ts` 必须同时认这两种形状 —— 写岔了
       * 不会报错，表现是「下一轮模型以为所有历史工具调用都被中止、输出为空」。
       */
      output?: unknown
      /** 工具执行失败（`output` 是错误文本） */
      isError?: boolean
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }

/**
 * 子任务的运行状态。
 *
 * - `running`：还在跑（只有落到 part 上的记录会出现，事件流里没有这个值）；
 * - `done`：正常给了结论；
 * - `empty`：跑完了但一个字都没吐（步数耗尽 / 模型空转）—— 父上下文拿到的是
 *   「子任务没有产出可用结论」那句兜底文案；
 * - `failed`：抛了异常（详情只进服务端日志，**绝不进父上下文**，见 `subagents.ts`）；
 * - `aborted`：父轮被停止 / 应用退出，子 run 跟着停（两者 signal 取或）。
 *
 * 分这么细是因为用户要能回答「这次派活为什么没结论」：`empty` 和 `failed` 的排查方向
 * 完全不同（前者看步数与提示词，后者看日志）。
 */
export type SubagentRunStatus = 'running' | 'done' | 'empty' | 'failed' | 'aborted'

/**
 * 一次子任务（派活）的完整过程记录，挂在派活卡（`tool-call.delegation`）上、随消息落盘。
 *
 * `parts` 与主消息完全同构 —— 这是「attach 到子任务看它像主任务」的全部实现基础：
 * 渲染端把 `{ role: 'assistant', parts }` 交给 `MessageParts` 就得到同一套折叠条、
 * 思考条、工具卡，不需要为子任务再写一套 UI。
 */
export interface SubagentDelegation {
  /** 子任务类型（`explorer` / `reviewer` …） */
  subagentId: SubagentId
  /** 派出去的任务原文（父模型写的 task） */
  task: string
  /** 子 agent 的完整过程（思考 / 工具调用 / 正文） */
  parts: AgentMessagePart[]
  status: SubagentRunStatus
  startedAt: number
  /** 结束时间；`status === 'running'` 时没有 */
  endedAt?: number
}

/**
 * 子任务内部的流事件（`subagent-event.event` 的形状）。
 *
 * 刻意只取 `AgentStreamEvent` 里的这四个分支：它们正是「一条助手消息」的全部内容
 * （正文 / 思考 / 工具调用 / 结果），足够让子任务和主任务长得一样，又不会让子任务
 * 的帧里再套一层派活 / 压缩 / finish 之类的父级语义。
 */
export type DelegationStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown; isError?: boolean }

/** Agent 流事件（形状与 AiStreamEvent 一致；reasoning-delta 为思考内容增量） */
export type AgentStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  /**
   * 多模态输出：**agent 回传的图片**（外部 agent 截图 / 生成图这类）。
   *
   * 与「用户发的附件」是同一个落点 —— 折叠成 `file` part，渲染端复用同一个 `FilePartView`
   * （缩略图 + 点开大图 + 下载），不必为助手侧再造一套图片展示。
   *
   * `url` 走 `data:` URL：图片是 agent 在协议里 base64 内联回来的，我们**不为它落盘**
   * ——ACP 的消息真源在 agent 侧、本地快照只在内存（见 `acp-transcripts.ts`），
   * 落盘反而会留下「用户删了会话、图还躺在数据目录」的垃圾，且回放一次写一份。
   * `loadMediaObjectUrl` 对 `data:` 是直通，不需要走 fetch。
   */
  | { type: 'file-part'; url: string; mediaType: string; name: string }
  /**
   * 子任务（subagent）**开跑**：父侧派活卡（`toolCallId` = 那次 `agent-<id>` 调用）
   * 从这一刻有了完整过程记录。
   *
   * 为什么不让服务端从 tool-call 的 `toolName` / `input.task` 自己推：那要解析 `agent-`
   * 前缀再拆 input，等于在两处维护同一份约定；派活方本来就知道 `subagentId` 和 task，
   * 直接说一声最省事、也不会因为父侧 input 还没收口而丢字段。
   */
  | { type: 'subagent-start'; toolCallId: string; subagentId: SubagentId; task: string }
  /**
   * 子任务**过程事件**：子 run 的原始流事件（思考 / 正文 / 工具调用 / 工具结果）原样转发。
   *
   * 折叠进派活卡 `delegation.parts`（与主消息同一套 part 形状），所以子任务能在面板里
   * 一整段铺开、跟主任务长得一模一样。从前只转正文与工具名（怕变成二级卡片树），
   * 结果是「派活卡里除了一段结论什么都没有」—— 过程不留在本地，事后也没得查。
   */
  | { type: 'subagent-event'; toolCallId: string; event: DelegationStreamEvent }
  /**
   * 子任务**结束**：带上终态，用来区分「正常给结论」和「跑完但没吐字」。
   *
   * 没有这一帧时只能靠父侧 `tool-result` 的文案猜（`RESULT_TEXT_EMPTY` 那句话就是给
   * 模型看的，不该被界面反解析）—— 状态由派活方自己报最准。
   */
  | {
      type: 'subagent-end'
      toolCallId: string
      /** 终态（不会是 `running`） */
      status: Exclude<SubagentRunStatus, 'running'>
      /** 子 run 自己跑了多久（毫秒；拿不到就不带） */
      durationMs?: number
    }
  // -------------------------------------------------------------------------
  // 多智能体协作（collab）：**全部是运行态的旁路事件**，不参与主消息落盘
  // -------------------------------------------------------------------------
  | {
      /** 任务新增 / 状态变化（queued → running → done/error/cancelled） */
      type: 'collab-task'
      task: CollabTask
    }
  | {
      /** Agent 之间的一条可见消息（派活 / 结果 / 追问 / 备注） */
      type: 'collab-message'
      message: CollabMessage
    }
  | {
      /** 单个 Agent 的运行状态（空闲 / 排队 / 运行 / 等回答 / 出错） */
      type: 'collab-agent'
      agentId: string
      agentName: string
      status: CollabAgentStatus
      taskId?: string
      toolName?: string
      step?: number
      error?: string
      updatedAt: number
    }
  | {
      /** 子 Agent 的正文 / 思考增量（名单卡片实时预览；收敛以任务 output 为准） */
      type: 'collab-delta'
      agentId: string
      taskId?: string
      channel: 'text' | 'reasoning'
      delta: string
    }
  | {
      /** 子 Agent 的工具开始 / 结束（名单卡片上显示当前在干什么） */
      type: 'collab-tool'
      agentId: string
      taskId?: string
      toolCallId: string
      toolName: string
      phase: 'start' | 'end'
      ok?: boolean
      /** 工具入参 / 结果的短摘要（服务端截断，仅展示） */
      label?: string
      /**
       * 入参（`start`）/ 结果（`end`）的全文，服务端截断到 600 字符。
       *
       * `label` 只有一行摘要，够名单角标用；共享对话区要把它拼成**工具卡**，卡片上得能
       * 看出「读的是哪个文件、跑出来什么」—— 摘要到不了那个粒度。
       */
      input?: string
      output?: string
    }
  | {
      /**
       * 工具**入参的流式增量**：上游一边生成入参一边发（引擎的 `tool-call-delta`
       * / `argsTextDelta`）。与 `tool-call` 的关系同 `text-delta` 之于 text part ——
       * 增量只喂渲染（卡片上能看到要写入的内容在长），收敛以完整 `tool-call` 为准。
       *
       * ⚠️ 不是所有上游都发：不发时行为与从前完全一致（只有一条完整 `tool-call`），
       * 前端不能假设「调工具必然先来一串 delta」。
       */
      type: 'tool-call-delta'
      toolCallId: string
      /** 增量帧可能不带工具名（有的上游只在完整 tool-call 里给）：给了就补上 */
      toolName?: string
      /**
       * 入参文本的增量（JSON 片段，按 toolCallId 依次拼接）。
       * **可以为空串**：上游「入参开始流式生成」的那一帧（引擎的
       * `tool-call-input-streaming-start`）只有 id + 工具名、还没有内容，
       * 用它先把卡片建出来（标题立刻是「写入文件」而不是「工具调用」）。
       */
      inputTextDelta: string
    }
  | {
      /**
       * 工具**输出的流式增量**：命令执行期间 stdout / stderr 实时上来
       * （execute_command 的实时输出）。与 `tool-call-delta` 的关系同 `text-delta`
       * 之于 text part —— 增量只喂渲染，收敛以完整 `tool-result` 为准。
       *
       * 服务端 `foldEventIntoParts` 刻意不认它（不进落盘历史）：跑完 `tool-result`
       * 已带完整输出；运行中刷新 attach 回放帧日志时它才可见（见 compactFrames 合并）。
       */
      type: 'tool-output-delta'
      toolCallId: string
      stream: 'stdout' | 'stderr'
      delta: string
    }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
      /** ACP 工具种类（toolCall.kind），见 AgentMessagePart 的 tool-call */
      acpKind?: string
      /** ACP 工具展示内容（toolCall.content 收窄），见 AgentMessagePart 的 tool-call */
      acpContent?: AcpToolCallContent[]
      /** ACP 展示标题（toolCall.title），见 AgentMessagePart 的 tool-call */
      title?: string
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }
  | {
      /**
       * 运行中插话（steer）在某个工具步骤边界被 agent 消费时发出。
       *
       * `message` 就是这条插话（user 角色，id 形如 `u-<ts>`）：**它是会落盘的真实消息**
       * —— 服务端在 turn 收尾按注入边界把 assistant 消息切片后与它一起原子落盘，
       * 顺序即真实时序（`[assistant(前段), user, assistant(后段)]`）。前端据此把
       * live 助手消息拆成两段、把这条 user 消息插进中间，后续增量写进新段。
       * 只有 内置后端会产生这个事件（ACP 是外部 agent，协议给不了插话）。
       */
      type: 'user-injected'
      message: AgentChatMessage
    }
  /**
   * 一轮结束。
   *
   * `usage` 只有内置后端给（它从上游 finish 帧拿到 token 数）；**ACP 从不带** —— 那种轮次
   * 只给 `durationMs`（见 `AgentChatMessage.durationMs`），前端据此仍能报「已工作 N 秒」。
   * 两个字段互不替代：有 `usage` 时它自带 `durationMs`，别再重复给 `durationMs`。
   *
   * 内置后端**没有 `usage` 时也带 `durationMs`**：中止 / 出错的那一轮往往一个 usage chunk
   * 都没收到（`agent.ts` 的 `finishTiming`），耗时仍然要给 —— 否则折叠条抬头只能退回
   * 「思考 ×N · 工具调用 ×N」的计数摘要。
   */
  | {
      type: 'finish'
      finishReason: string
      usage?: TurnUsage
      durationMs?: number
      /**
       * 被预算截断时给（见 `AgentStopReason`）。**与 `finishReason` 并存**：撞上限的那一轮
       * `finishReason` 仍是 `'done'`（它不是错误、也不是用户停的），只是多了这一位。
       */
      stopReason?: AgentStopReason
      /** 这一轮实际跑了多少步（只有 `stopReason` 存在时给） */
      steps?: number
    }
  | { type: 'error'; message: string }
  | {
      /**
       * 模型请求因可重试的请求错误（网络中断 / 上游空响应）失败，正在重试（第 `attempt` 次）。
       *
       * 是「通知」不是内容增量：**不落盘**、也不代表本轮结束 —— 前端据此渲染成一条
       * 自替换的重试提示（屏幕上只留最新一次），并把这一次尝试已渲染的部分输出丢掉
       * （从头再来，避免正文重复）。`maxRetries` = 生效的重试上限；`null` = 不限制
       * （设置里 0 = 不限制，用 `null` 表示是因为 `Infinity` 无法 JSON 序列化）。
       */
      type: 'retry'
      attempt: number
      maxRetries: number | null
      /**
       * 这一次尝试失败的**原因原文**（`describeError(err)`，如
       * `AI_APICallError: concurrency reached, current: 11, limit: 10`）。
       *
       * 有了它，前端那条「第 N 次重试」才能把「为什么在重试」一并说清 —— 否则用户只看到
       * 次数在涨、不知道是被限流还是断网，也就无从判断该等还是该改配置。
       * 缺省（undefined）= 拿不到原因（老服务端 / 合成错误），前端只显示次数。
       */
      message?: string
      /**
       * `true` = **断点续跑**：上一次尝试已经跑完若干步（工具调用与原样结果都在），
       * 这次不是从头再来，而是接着失败的那一步重新发请求。
       *
       * 前端**不能**清空已渲染的输出（那些内容模型是看得见的，清掉就与上下文不一致）；
       * 只回滚到最后一个**已落定**的工具结果——它之后的部分属于失败的那一步，模型会
       * 重新生成，留着就会和新的增量重复。缺省（undefined）= 整轮重来，清空重跑。
       */
      resume?: boolean
    }
  | {
      /**
       * 上下文压缩**开始**：这一轮发出去之前，旧历史已经切好，马上要调模型生成
       * 「交接文档」（结构化摘要）。
       *
       * 只在真的需要重算摘要时发（复用检查点 / 未超预算都不发）。与
       * `context-compaction-delta` 成对出现；生成失败 / 中止时不会补 `context-compressed`，
       * 前端按下一轮 / `end` 帧清掉进行中状态。
       */
      type: 'context-compaction-start'
      beforeTokens: number
      summarizedTurns: number
      keptTurns: number
    }
  | {
      /**
       * 「交接文档」的流式增量。`phase` = 两段摘要中的哪一段（切点落在回合中间时，
       * 会先摘要历史、再补一段 turn-prefix）；前端把两段拼成同一份文档。
       */
      type: 'context-compaction-delta'
      delta: string
      phase: 'checkpoint' | 'turn-prefix'
    }
  | {
      /**
       * 上下文压缩：这一轮发出去之前，服务端把旧轮摘要掉了。
       *
       * 不是每轮都发 —— 只有真超预算才发；不超预算时这一帧不会出现，
       * 前端按「有这一帧」来判断，不要把它当成常规事件轮询。
       *
       * `summary` 是完整交接文档（含框架补的文件清单）。流式过程中已经通过
       * `context-compaction-delta` 发过增量，这里是**权威终稿**：前端用它覆盖拼接结果，
       * 避免增量与最终正文有细微出入（文件清单是流式结束后才补的）。
       *
       * ⚠️ 只有一种压缩（摘要）。曾经的 `kind: 'micro'`（清旧工具结果）已删除：
       * 它每轮都可能改动请求前缀，反而让上游前缀缓存反复失效。
       */
      type: 'context-compressed'
      beforeTokens: number
      afterTokens: number
      summarizedTurns: number
      keptTurns: number
      /** 完整摘要正文；流式增量拼出来的那份以这里为准 */
      summary?: string
    }
  | {
      /**
       * ACP agent 上报的**上下文占用**（`session/update` 的 `usage_update`），
       * **也复用于内置 agent（内置）每个工具步骤边界的实时估算**。
       *
       * `used` = 当前躺在上下文里的 tokens；`size` = 该 agent 的上下文窗口大小。
       *
       * 两条来源、同一形状（前端圆环不必分叉）：
       * - **ACP**：agent 侧实测上报。与 `finish.usage.contextTokens` **不同源**，
       *   它是**快照**不是整轮统计（ACP 拿不到输入 / 输出 / 速度），只喂上下文圆环；
       *   只作展示，不参与本地压缩判断（ACP 的上下文在 agent 侧管理，本地压不了）。
       *   ACP 里 `usage_update` 标着 UNSTABLE，并非所有 agent 都实现：不发的 agent
       *   这一帧永远不出现，前端按「有这一帧」判断即可。
       * - **内置**：`runAgent` 在每个 `onIterationComplete`（= 一次 LLM 调用 + 其工具
       *   执行完成，即工具步骤边界）用 `baseTokens + estimateMessagesTokens(ctx.messages)`
       *   估一次当前上下文，发本帧 —— 圆环因此在**一轮之内**也跟着走，而不是只在 finish
       *   时跳一下。`size` 用的是该模型的窗口（与压缩触发同源）。
       *   ⚠️ 这一帧是**估算**（pi 的兜底分支）：那一步的 usage 拿不到，猜先后顺序会推旧值。
       *   finish 会用上游真实 usage（`calculateContextTokens`）覆盖 `usage.contextTokens`，
       *   所以轮末数字会有一次小跳变 —— pi 也是「流式中估、结束后按真实用量」。
       *
       * ⚠️ 与 `context-compressed` 的分工：那个是「压缩发生了」的一次性通知（带压前压后），
       * 这个是「现在占多少」的持续快照。
       */
      type: 'context-usage'
      used: number
      size: number
      /**
       * `used` 里**压缩动不了的那部分**（系统提示词 + 工具 schema 的估算）。
       *
       * 只在内置 agent 的帧里带。它解释了「压缩之后圆环为什么还是红的」：历史已经被
       * 压到保留区，剩下的大头是提示词与工具定义，压缩机制管不到 —— 要降只能精简
       * 项目文档 / 关掉不用的 MCP 工具。
       */
      base?: number
    }

/**
 * ACP 权限选项的性质（`session/request_permission` 里 agent 给的 kind，标准四种）。
 * 客户端不做任何语义映射，用户点了哪个就把哪个 `optionId` 原样回给 agent。
 */
export type AgentPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'

/** ACP 权限选项：agent 给什么就透传什么（optionId 回传时原样带回） */
export interface AgentConfirmOption {
  optionId: string
  /** 用户可见名（agent 自己给的文案） */
  name: string
  kind: AgentPermissionOptionKind
}

/** Agent 确认模式下 execute_command 执行前的主进程请示 */
export interface AgentConfirmRequest {
  /** 确认请求 id，回复时原样带回 */
  id: string
  /** 所属 Agent 对话请求 id */
  requestId: string
  toolCallId: string
  toolName: string
  /** 待执行的命令 */
  command: string
  /**
   * 模型对这一步的意图（一句话）。有值时审批卡把它放在标题位，
   * 用户点「允许」前先知道**为什么**要跑这条命令。
   */
  intent?: string
  workspaceId?: string
  workspaceName?: string
  /** 多智能体协作：发起这次审批的子 Agent（主智能体 / 普通会话不填） */
  agentId?: string
  agentName?: string
  /**
   * ACP 的权限选项（agent 在 `session/request_permission` 里广告的原样透传）。
   * 给了它，界面就渲染这组选项让用户挑（答复带 optionId）；不给则是内置的「允许 / 拒绝」。
   */
  options?: AgentConfirmOption[]
}

/**
 * Agent 确认模式下执行破坏性操作前的请示（运行方内部形状，与 `AgentConfirmRequest`
 * 的区别：不带 SSE 通道的路由字段）。
 */
export interface AgentConfirmInput {
  toolCallId: string
  toolName: string
  /** 待执行的命令 / 删除动作的描述 */
  command: string
  /** 模型对这一步的意图（一句话，引擎注入的 `intent` 字段）；没有就不传 */
  intent?: string
  /** 多智能体协作：发起这次审批的子 Agent（主智能体 / 普通会话不填） */
  agentId?: string
  agentName?: string
  /**
   * ACP 的权限选项（`session/request_permission` 里 agent 广告的原样透传）。
   * 内置工具的审批不给它 —— 界面渲染通用的「允许 / 拒绝」两颗按钮。
   */
  options?: AgentConfirmOption[]
}

/** 一轮 agent 运行的结果（ai-sdk 与 ACP 两个后端共用同一形状） */
export interface RunAgentResult {
  finishReason: 'done' | 'error' | 'aborted'
  error?: string
  /** 这一轮的用量统计（模型没上报 usage 时为 undefined） */
  usage?: TurnUsage
  /** 被单轮步数上限截断时给（见 `AgentStopReason`）；服务端据此落盘并在界面提示 */
  stopReason?: AgentStopReason
  /** 这一轮实际跑了多少步（只有 `stopReason` 存在时给） */
  steps?: number
}

// ============================================================================
// 服务端主动事件（`/api/state` WebSocket 的 `event` 帧）
// ============================================================================
//
// 与快照（`snapshot` 帧）是**两种东西**，不能互相替代：
// - 快照 = 「某个域现在的样子」。前端按 key 覆盖整份数据，连上时的 `init` 全量能自愈，
//   错过几帧无所谓（下一次推送就补上）。
// - 事件 = 「刚刚发生了什么」。**一次性**，错过就错过 —— 所以凡是「持续状态」
//   （谁在跑、有没有待办）除了走事件，还会在 `activeRuns` 快照里再落一遍（见
//   `lib/conversation-activity.ts`：事件管「立刻反应」，快照管「最终对得上」）。
//
// 走这条通道的是**对话生命周期**。原因：对话正文走 SSE，而 SSE 只发给**发起这一轮的那条
// 连接** —— 用户切到别的会话、换个标签页，就再没有人知道「有个会话在等我点头」。
// 事件是广播给所有连接的，于是任何一端都能实时更新会话状态（侧栏转圈 / 待办角标）、
// 在页面不可见时发系统通知。
//
// ⚠️ 这里**刻意不带流式正文**：一轮对话每秒几十帧文本，广播给所有连接纯属浪费带宽。
// 要看正文仍然走 SSE（`GET /api/chat/stream?requestId=` 接回现场，见 `chat-run.ts`）。

/** 每条对话事件都带的坐标：哪个会话、哪一轮、会话标题 */
interface ConversationEventBase {
  conversationId: string
  requestId: string
  /**
   * 会话标题：通知标题直接用它。
   *
   * 为什么不由前端去会话清单里查：事件到达时会话清单快照可能还没同步过来（新建的会话
   * 尤其如此），查不到就只能发一条没有标题的通知。
   */
  title: string
}

/** 一轮对话开跑（`POST /api/chat` 接受请求、建好 run 之后） */
export interface ConversationStartedEvent extends ConversationEventBase {
  type: 'conversation:started'
  startedAt: number
}

/** 一轮对话收尾（跑完 / 出错 / 被停）。服务端**落盘之后**才发，客户端收到即可去拉历史 */
export interface ConversationFinishedEvent extends ConversationEventBase {
  type: 'conversation:finished'
  finishReason: string
  /** 助手正文的第一段（服务端已截断），给通知当摘要；没有正文就没有这个字段 */
  excerpt?: string
  /** finishReason 是 error 时的原因 */
  error?: string
  /**
   * 被单轮步数上限截断（见 `AgentStopReason`）。通知文案据此换成「已用满 N 步上限」，
   * 否则用户只会收到一条像是正常跑完的摘要。
   */
  stopReason?: AgentStopReason
  /** 这一轮实际跑了多少步（只有 `stopReason` 存在时给） */
  steps?: number
  finishedAt: number
}

/** 一个工具调用在等用户点头（内置工具审批与 ACP 权限共用） */
export interface ConversationConfirmEvent extends ConversationEventBase {
  type: 'conversation:confirm'
  confirm: AgentConfirmRequest
}

/** 审批有了答复（用户点的、别的标签页点的、超时自动拒的……都算） */
export interface ConversationConfirmResolvedEvent extends ConversationEventBase {
  type: 'conversation:confirm-resolved'
  confirmId: string
  approved: boolean
}

/** agent 在等用户回答一个问题（ask_followup_question） */
export interface ConversationFollowupEvent extends ConversationEventBase {
  type: 'conversation:followup'
  followup: AskFollowupRequest
}

/** 提问有了答复（答复体走 HTTP 回服务端，这里只告诉各端「不用再等了」） */
export interface ConversationFollowupResolvedEvent extends ConversationEventBase {
  type: 'conversation:followup-resolved'
  followupId: string
  toolCallId: string
}

/**
 * 容器型项目里 agent 改了文件（`write_file` / `edit_file` / `delete_file` 成功）。
 *
 * 只带 workspaceId：前端只需要知道「这个项目的文件变了、该刷预览了」，具体路径不参与
 * 决策（一次改多个文件也只刷一次）。容器内 Vite 镜像有 HMR，这个事件是给**没有 HMR 的
 * 项目**兜底的，前端按镜像的 `autoStart` 决定要不要理会。
 */
export interface ContainerFilesChangedEvent {
  type: 'container:files-changed'
  workspaceId: string
}

/**
 * 后台任务清单变了（起了 / 收场了 / 被取消了）。
 *
 * 只是一个**失效信号**：不带任务本体，收到就重新 `GET /api/background-tasks`。
 * 为什么不带：任务输出是高频的（一条 dev server 每秒几十行），把内容塞进事件等于把
 * 全局状态 WS 变成日志传输通道；而清单本身小，重拉一次比维护增量便宜得多。
 *
 * 生产方是登记表本身（`startBackgroundTask` 的启动与收场两处），所以不管是哪条路
 * 起的任务（会话里的 agent 命令、项目页的克隆），各端都能第一时间看到。
 */
export interface BackgroundTasksChangedEvent {
  type: 'backgroundTasks:changed'
}

/** 全局状态 WS 上广播的瞬时事件（生产方：`lib/server/state.ts` 的 `emitServerEvent`） */
export type ServerEvent =
  | ConversationStartedEvent
  | ConversationFinishedEvent
  | ConversationConfirmEvent
  | ConversationConfirmResolvedEvent
  | ConversationFollowupEvent
  | ConversationFollowupResolvedEvent
  | ContainerFilesChangedEvent
  | BackgroundTasksChangedEvent

// ============================================================================
// 定时任务
// ============================================================================
//
// 定时任务与「工作区 + 会话」**并列**但**不共用**：它只是一条「什么时候该起一个会话」的
// 规则，落盘在 `CoreData.taskTriggers`，派发时仍然是普通会话（agent 跑在宿主机上）。

/**
 * 一条「什么时候起这个会话」的规则 —— 定时任务。
 *
 * 为什么要有它：会话原本**只能由人发起**，人一离开浏览器，agent 就只会等、不会动。
 * 定时任务补上的是「自己会跑起来」的那一半。
 *
 * 到点后由服务端的调度器（`apps/server/src/server/scheduler.ts`，进程内 cron）
 * 调度：cron 轮询到点 / at 定时器到点。派发后**不起容器任务**，而是建一个真实聊天会话
 * 跑一轮 —— 会话留在侧栏里可回看。
 *
 * 只有 `cron` 与 `at` 两种来源；`manual` / `webhook` 已退场，老记录里的残留字段
 * （如 `slug`）不再写入也不再读取。
 */
export interface TaskTrigger {
  id: string
  /**
   * 绑定的工作区（`AgentWorkspace.id`）。
   *
   * **可选**：和「新建会话时不选工作区」同一套语义 —— 缺省 = 每次触发都新开一个临时
   * 工作区（目录 `<数据目录>/conversations/<会话 id>`，带 `scratch` 标记、不进项目列表），
   * 让这条任务在空目录里从头干。用户想让它去改某个仓库时才绑一个。
   *
   * 老记录一定带这个字段（那时是必填）；它指向的工作区被删掉时按「没绑」处理
   * （触发时自动建临时工作区，不报错），免得删个项目就把定时任务悄悄弄死。
   */
  workspaceId?: string
  /** 展示名 */
  name: string
  /** 定时表达式：分 时 日 月 周（5 段，空格分隔）。由调度器按 cron 轮询调度 */
  cron?: string
  /** 一次性触发时刻（毫秒时间戳）；过了就禁用。与 `cron` 二选一 */
  at?: number
  /** 触发时交给 agent 的模板（需求原文 + 可选的模型绑定） */
  template: TaskTriggerTemplate
  /** 是否启用；关掉后调度器不再触发它，但记录保留 */
  enabled: boolean
  createdAt: number
  /** 上一次实际触发的时刻；null = 还没触发过（界面据此显示「等待首次触发」） */
  lastTriggeredAt?: number
  /** 上一次触发起出来的**会话** id，便于回看这一轮跑成什么样 */
  lastConversationId?: string
  /**
   * **每一轮**触发起出来的会话 id（最新在前，去重，不截断）。
   *
   * 与 `lastConversationId` 的区别：那个只留最后一条，是「上次跑成什么样」的快捷入口；
   * 这个要回答「它一共跑过几次、每次跑出来什么」—— 定时任务管理页据此列出全部历史会话，
   * 点一条直接打开。
   *
   * 保留**全部**（不设上限）：这是用户能回看自己任务的唯一索引，砍掉就永久找不回来了。
   * 会话本身被删掉时这里不清理（删会话是另一端的事），界面按现存会话过滤，
   * 找不到的显示「已被删除」。
   *
   * 存量任务没有这个字段 = 没记录过历史（只有 `lastConversationId` 那一条可看）。
   */
  conversationIds?: string[]
  /**
   * ⚠️ 旧字段残留：定时任务曾经起的是容器任务，这里存任务 id。现在触发走会话，
   * 新数据一律写 `lastConversationId`，这个字段不再写入 —— 只为老记录保留读取。
   */
  lastTaskId?: string
}

/**
 * 定时任务的「交给 agent 什么」模板。
 *
 * 历史上这里曾有 `permission` / `agentConfigId` / `baseBranch`（容器任务时代），已停用：
 * 老记录里的残留字段会被忽略。
 */
export interface TaskTriggerTemplate {
  /** 需求原文 —— 触发时作为用户消息发给 agent */
  prompt?: string
  /**
   * 触发会话的工具权限档（缺省 = `full`）。
   *
   * ⚠️ 无人值守语义：`confirm` 档要靠用户点「允许」才放行写操作，而定时任务跑的时候
   * 旁边通常没人 —— `guardWrite` 等不到答复就会**按拒绝处理**，任务会「什么都没干、
   * 也没报错」地结束。所以表单里选 `confirm` 会给出警告，调度器**不会**替用户改档。
   * `readonly` 适合「只看一眼、汇报状态」的任务。
   *
   * ⚠️ `acp` 后端没有「只读档」这套工具级语义，它的等价物是会话上的
   * `acpPermissionMode`：调度器按**这一档**推出来 —— `full` → `allow`（自动放行 agent
   * 发来的权限请求），其余 → `confirm`（等不到人答复，按 fail-closed 拒绝）。
   */
  permissionMode?: AiPermissionMode

  /**
   * 触发会话用哪个后端：`builtin`（内置模型，缺省）或 `acp`（外部 Agent）。
   *
   * 与手动新建会话同义 —— 选模型时选的就是「哪个后端 + 哪个配置」，所以它和下面那对
   * `configId` / `modelId` 是**一起**决定「拿什么跑这一轮」的。存量记录没有这个字段 =
   * `builtin`（那时只支持内置模型）。
   */
  backend?: AgentBackend

  /**
   * 触发会话用哪份配置，语义随 `backend` 变：
   * - `builtin`：`AiModelConfig.id`，且**必须**与 `modelId` 一起给出（选模型时就是
   *   「配置 · 模型」一对）：缺了就是没选，调度器会拒跑并报一句人话，
   *   **不存在**「回退到清单第一份可用配置」的隐式兜底；
   * - `acp`：`AcpAgentConfig.id`（外部 agent）。会话建好后**锁定**，与手动会话一样
   *   不能换 agent（要换就改这条定时任务、让它下次触发新建会话）。
   */
  configId?: string
  /**
   * 进一步记住用哪个上游模型：
   * - `builtin`：该配置下选中的模型（`AiModelConfig.models` 的一项，必选）；
   * - `acp`：agent 自己广告的模型值（`AcpAgentConfig.models[].value`，可省 ——
   *   省 = 用 agent 自己的默认，与手动会话的「跟随 agent 默认」同一套语义）。
   *   这个值在 agent 升级后可能失效：调度器发现它不在 agent 当前广告的清单里时
   *   **只打一行警告并按 agent 默认跑**，不拒跑（模型是可选绑定，不是用户配置被删）。
   */
  modelId?: string
  /**
   * 触发时会话挂上哪些 MCP server（`McpServerConfig.id` 的列表）。
   *
   * 与会话级 `AgentConversation.mcpServerIds` 同义 —— 触发跑的就是普通会话，这里只是
   * 把「选哪几个 MCP」预先记在定时任务上。空 / 缺省 = 一个都不挂。已被删除的 id 由
   * 运行链路（chat-turn）按现存配置剔掉，不会连不存在的 server。
   */
  mcpServerIds?: string[]
  /**
   * 触发会话的浏览器工具偏好（开关），**缺省 = 关**（`DEFAULT_BROWSER_SETTINGS`）。
   *
   * 为什么定时任务也需要它：`browser_*` 工具跑在**服务端**（用服务端那台机器的
   * 内置 headless shell），不依赖用户面前的窗口 —— 无人值守的任务照样能开网页、
   * 抓数据。触发时原样落到会话的 `AgentConversation.browserSettings` 上，
   * 之后走的是与手动会话完全相同的那条装配路径（`chat-turn.ts`）。
   */
  browserSettings?: BrowserSettings
}

/**
 * 新建 / 更新定时任务的入参（`POST /api/task-triggers`）。
 *
 * 与存储形状 `TaskTrigger` 分开，是因为 `id` / `createdAt` 由服务端给，
 * `lastTriggeredAt` / `lastTaskId` 是调度器写的回执 —— 客户端都不该带。
 */
export interface TaskTriggerInput {
  /** 带 id = 更新那条；不带 = 新建 */
  id?: string
  /** 不传 = 每次触发自动建临时工作区（见 `TaskTrigger.workspaceId`）；更新时传空即解绑 */
  workspaceId?: string
  name: string
  cron?: string
  at?: number
  template?: TaskTriggerTemplate
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// SSH 终端主机
// ---------------------------------------------------------------------------

/** SSH 认证方式：密码 / 私钥（私钥可再带 passphrase） */
export type SshAuthType = 'password' | 'privateKey'

/**
 * 主机清单里一条目的类型：远端 `ssh` / 本机 `local`。
 *
 * 两种条目共用同一份清单（`/api/ssh/hosts`）与同一套 UI 入口，只在「怎么开标签」上分叉：
 * - `ssh`：连远端主机（`resolveSshHost` 解密凭据、跳板串联）；
 * - `local`：本机 shell（只记 shell / 启动参数 / 启动后自动执行的命令，无凭据）。
 *
 * ⚠️ 历史条目没有 `kind` 字段（早于本类型），一律按 `'ssh'` 解释。
 */
export type HostKind = 'ssh' | 'local'

/**
 * SSH 会话的终端字符集。中文 Windows 服务器（控制台代码页 936）上老程序输出 GBK、
 * 终端显示乱码时切到 `gbk`；缺省 `utf-8`（Linux 主机的标准情况）。
 */
export type SshCharset = 'utf-8' | 'gbk'

/**
 * 一台 SSH 主机的配置（存在服务端 `agent-core.json`）。
 *
 * ⚠️ 密码 / 私钥 / passphrase **不在这里回传**：读取列表时只带 `has*` 脱敏标记，
 * 明文只在服务端内部连接时解密使用（见 `@fizz/workspace` 的 `resolveSshHost`）。
 */
export interface SshHostConfig {
  id: string
  /** 条目类型；缺失 / `'ssh'` = 远端 SSH 主机 */
  kind?: 'ssh'
  /** 展示名（留空时服务端用 `user@host:port` 顶） */
  name: string
  /**
   * 所属分组（`HostGroup.id`）；undefined = 未分组。
   *
   * ⚠️ 只由 `arrangeHosts`（拖拽重排 / 移动到分组）改动 —— 普通的保存 / 编辑不要碰它，
   * 否则改个端口就会把主机从分组里踢出去（同 `ScriptEntry.groupId`）。
   */
  groupId?: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  /** 是否已保存密码（脱敏展示用） */
  hasPassword?: boolean
  hasPrivateKey?: boolean
  hasPassphrase?: boolean
  /**
   * 跳板机（另一台 ssh 主机的 id）。连接时先连跳板，再经它 forwardOut 到目标；
   * 支持多级串联，循环由运行时检测并拒绝。
   */
  jumpHostId?: string
  /** 终端字符集；缺省 utf-8 */
  charset?: SshCharset
  /** SSH 保活间隔（秒）；缺省 30 */
  keepaliveInterval?: number
  createdAt: number
  updatedAt: number
}

/**
 * 一条**本机终端**配置（存在服务端清单里，与 SSH 主机同列）。
 *
 * 没有任何凭据：只是把「常用的本机终端」存下来，点一下就能按固定 shell / 参数开标签。
 */
export interface LocalHostConfig {
  id: string
  kind: 'local'
  /** 展示名（必填：本机终端没有 `user@host` 可顶） */
  name: string
  /** 所属分组（`HostGroup.id`）；undefined = 未分组。语义见 `SshHostConfig.groupId` */
  groupId?: string
  /** 用哪个 shell（`ShellProfile.id`）；不传 = 平台默认，认不出来回落默认 */
  shellId?: string
  /** 冗余存的 shell 展示名（清单里即便拿不到 shell 列表也能显示） */
  shellName?: string
  /** 追加到 shell 自身 args 之后的**额外启动参数** */
  args?: string[]
  /**
   * 打开时的工作目录（**主机自己的配置**，与任何项目 / 会话无关）。
   *
   * 缺省 = 主目录：本机终端是「主机与终端」这个独立功能的一部分，默认不该被当前项目
   * 牵着走（见 `LocalHostInput.cwd`）。要固定从某个目录起就在这里填绝对路径。
   */
  cwd?: string
  /** 启动后自动执行的一条命令（shell 起来后写进 PTY） */
  autoCommand?: string
  createdAt: number
  updatedAt: number
}

/** 主机清单里的一条：SSH 主机或本机终端。用 `kind === 'local'` 收窄 */
export type HostConfig = SshHostConfig | LocalHostConfig

/**
 * 保存 SSH 主机的入参（POST `/api/ssh/hosts`）：带 `id` 即更新、不带即新建。
 *
 * 明文凭据字段（`password` / `privateKey` / `passphrase`）只在**本次请求**里传一次，
 * 服务端加密落盘后不再回传。留空 / 不传 = 保留原值（改主机名这类编辑不该把密码抹掉），
 * 要清空得显式传空串。
 */
export interface SshHostInput {
  id?: string
  /** 条目类型；缺失 / `'ssh'` = 远端 SSH 主机 */
  kind?: 'ssh'
  name?: string
  host: string
  port?: number
  username: string
  authType?: SshAuthType
  password?: string
  privateKey?: string
  passphrase?: string
  jumpHostId?: string
  charset?: SshCharset
  keepaliveInterval?: number
  /**
   * 归属分组（`HostGroup.id`）。**只用于新建时指定**（分组行的「+」按钮）；
   * 更新时不传 = 保留原归属，改归属请走 `arrangeHosts`。
   */
  groupId?: string
}

/**
 * 保存**本机终端**配置的入参（POST `/api/ssh/hosts`）：带 `id` 即更新、不带即新建。
 */
export interface LocalHostInput {
  id?: string
  kind: 'local'
  name?: string
  /** 归属分组；语义同 `SshHostInput.groupId` */
  groupId?: string
  shellId?: string
  shellName?: string
  args?: string[]
  /**
   * 打开终端时的工作目录（绝对路径）。
   *
   * **空串 / 不传 = 主目录**（且会清掉原来的值）—— 这条终端属于「主机与终端」这个独立
   * 功能，默认不与任何项目绑定；要固定目录就由用户在这条配置里显式写。
   */
  cwd?: string
  autoCommand?: string
}

/** 保存一条主机清单条目的入参：SSH 主机或本机终端（按 `kind` 区分） */
export type HostInput = SshHostInput | LocalHostInput

// ---------- 主机分组（主机 / 终端的归类树）----------
//
// 与接口请求分组同款：**多级树**（`parentId` 自引用）、只承担「归类 + 排序」。
// SSH 主机与本机终端**共用同一套分组** —— 它们本来就同列在侧栏，分两套只会让
// 「本机终端放不进任何分组」。

/**
 * 主机分组：侧栏里的分组节点，可任意层级嵌套。
 * 不设颜色 —— 主机分组只承担「归类 + 排序」。
 */
export interface HostGroup {
  id: string
  name: string
  /** 父分组 id；缺省 = 顶级分组 */
  parentId?: string
  createdAt: number
}

/** 新建 / 更新主机分组的入参：不传 id = 新增；`parentId` 缺省 = 顶级分组 */
export interface HostGroupInput {
  id?: string
  name: string
  parentId?: string
}

/**
 * 主机树的重排入参（拖拽落点算出来的目标顺序）。
 * - `groups`：全部分组按目标顺序列出（DFS 前序），`id` + 目标 `parentId`；
 * - `hosts`：主机 / 终端按目标顺序列出，`groupId` 为最终归属（undefined = 未分组）。
 */
export interface HostArrangeInput {
  groups: Array<{ id: string; parentId?: string }>
  hosts: Array<{ id: string; groupId?: string }>
}

/** 分组与主机同时变更时的返回（重排 / 删分组都会动两份数据） */
export interface HostGroupsAndHosts {
  groups: HostGroup[]
  hosts: HostConfig[]
}

// ---------- SSH 隧道（本地转发 -L / 远程转发 -R / SOCKS5 动态代理 -D） ----------

/** 隧道类型：`local` 本地转发（-L）；`remote` 远程转发（-R）；`dynamic` 动态 SOCKS5 代理（-D） */
export type SshTunnelType = 'local' | 'remote' | 'dynamic'

/**
 * 一条隧道配置（存在服务端 `agent-core.json`）。
 *
 * ⚠️ **监听端口绑在「跑 server 的那台机器」上**，不是浏览器那台：这就是 `ssh -L/-R/-D`
 * 的标准语义（监听端永远在 SSH 客户端侧），而本仓库里 SSH 客户端只有 server 一个 ——
 * 桌面端是把同一份 server 装进进程内跑，所以「服务端所在机器」正好是你本机；
 * VPS 上部署的 web 则是 VPS 自己。UI 文案一律写「服务端所在机器的端口」，
 * **不要写「本机端口」**（两种形态下含义不同）。
 */
export interface SshTunnel {
  id: string
  /** 承载连接的 SSH 主机（`SshHostConfig.id`）；凭据仍存在主机配置里，这里只存引用 */
  hostId: string
  type: SshTunnelType
  /** 监听侧地址：local / dynamic 在**服务端**监听（默认 `127.0.0.1`）；remote 在**远端主机**上监听 */
  bindHost: string
  /** 监听侧端口 */
  bindPort: number
  /** 目标侧地址：local 为远端可达的目标；remote 为**服务端可达**的目标（dynamic 不用） */
  targetHost?: string
  /** 目标侧端口（仅 local / remote） */
  targetPort?: number
  /** 备注（列表展示用） */
  label?: string
  /** 服务启动后自动拉起 */
  autoStart?: boolean
  createdAt: number
  updatedAt: number
}

export type SshTunnelStatus = 'stopped' | 'starting' | 'running' | 'error'

/** 隧道运行时状态（服务端推送；渲染端只读展示） */
export interface SshTunnelRuntime {
  id: string
  status: SshTunnelStatus
  /** 仅 error：最近一次失败的描述 */
  error?: string
  /** 当前活跃的转发连接数 */
  conns?: number
  startedAt?: number
}

/**
 * `GET /api/ssh/tunnels` 的响应，也是 state-ws 的 `sshTunnels` 快照域形状。
 *
 * 配置（`tunnels`）与运行态（`runtimes`）一起下发：前者落 store、后者只在内存，
 * 但渲染端总是同时要用（列表要显示状态徽标与连接数），分成两条通道反而要自己对齐。
 */
export interface SshTunnelsSnapshot {
  tunnels: SshTunnel[]
  runtimes: SshTunnelRuntime[]
}

/** 保存隧道的入参（POST `/api/ssh/tunnels`）：带 `id` 即更新、不带即新建 */
export interface SshTunnelInput {
  id?: string
  hostId: string
  type: SshTunnelType
  bindHost?: string
  bindPort: number
  targetHost?: string
  targetPort?: number
  label?: string
  autoStart?: boolean
}

// ---------------------------------------------------------------------------
// 子任务（subagent）偏好
// ---------------------------------------------------------------------------

/**
 * 可派活的子任务 id（新增是显式动作：改这个联合类型 + `packages/agent` 的
 * `SUBAGENT_SPECS` 一条）。
 *
 * ⚠️ 刻意放在 `contracts`：这个字符串联合被渲染端（展示清单 / 开关）与主进程
 * （建 subagent）共用，而 `contracts` 必须保持**零引擎依赖**——从 `@fizz/agent`
 * import 会把整条 provider 依赖链带进浏览器产物（同 `resolve-model` 不进根入口的原因）。
 */
export type SubagentId = 'explorer' | 'reviewer'

/** 合法 id 清单（归一化用；从 `SubagentId` 派生，别手抄） */
export const SUBAGENT_IDS: readonly SubagentId[] = ['explorer', 'reviewer']

/**
 * 子任务步数上限的可设范围。
 *
 * 下限 1 是「至少能查一次」；上限 128 是防手滑：步数直接换算成 provider 调用次数，
 * 填 1000 就是在设置里埋一个烧钱的开关。默认值（80）必须落在范围内，
 * 所以这里不能压到 64 以下。真需要更大时改这个常量，而不是放开输入。
 */
export const SUBAGENT_MIN_STEPS = 1
export const SUBAGENT_MAX_STEPS = 128

/**
 * 子任务偏好：**默认关闭**。
 *
 * 为什么默认关：这改变的是**模型的行为**（父 agent 会多几个 `agent-*` 工具，
 * 并学会把活派出去），不是修 bug、不是补能力。默认打开等于我们替用户决定他
 * 的模型怎么干活，所以必须是 opt-in。
 *
 * 与 `SkillSettings` 同款定位：技能内容在磁盘上，这里只记用户选了什么。
 */
export interface SubagentSettings {
  /** 启用的子任务 id；空 = 一个都不派（缺省） */
  enabled: SubagentId[]
  /**
   * 子任务专用模型（可选）：某个模型配置下的某个模型。
   *
   * `null` / 缺省 = 沿用父会话模型。两个字段必须同时存在才生效；配置被删 / 模型被移除时
   * 服务端**退回父模型**并记一条日志（不因为子任务的偏好不可用而拖垮整轮）。
   */
  modelConfigId?: string | null
  /** 见 `modelConfigId`；两者成对使用 */
  modelId?: string | null
  /**
   * 每个子任务自己的步数上限（搜索 / 读文件 / 每次工具调用各算一步）。
   *
   * 缺省 = 用 `SUBAGENT_META[id].defaultMaxSteps`。这是**按 id 分开**的，因为侦察和审查
   * 的步数需求不一样（审查要「读改动 + 读被调用方」两遍）。
   *
   * 为什么给用户调：步数是「能想多深」与「花多少钱」之间唯一的旋钮 —— 步数不够会在
   * 中途停下（那时只能交回半成品结论），太多则可能对着一个死胡同反复试。
   */
  maxSteps?: Partial<Record<SubagentId, number>>
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = { enabled: [] }

/**
 * 给 UI 用的展示元数据（名称 + 一句话说明）。
 *
 * ⚠️ 刻意**放在 contracts** 而不是 `packages/agent`：渲染端（web / desktop 共用
 * `@fizz/agent-kit`）不能依赖 `@fizz/agent` —— 那会 引擎 + 整条 provider
 * 依赖链进浏览器产物。agent 侧的真源是 `SUBAGENT_SPECS`，两边新增时同步改。
 */
export const SUBAGENT_META: Record<
  SubagentId,
  {
    name: string
    hint: string
    /**
     * 默认步数上限。**这里是真源**：`packages/agent` 的 `SUBAGENT_SPECS` 直接引用它，
     * 设置页拿它当输入框的占位符（用户没改过时看到的就是「默认 80」）。
     */
    defaultMaxSteps: number
  }
> = {
  explorer: {
    name: '侦察',
    hint: '只读：定位符号、查找用法并汇总。',
    // 80 步 = 十来次搜索 + 二三十次读文件还留着收尾余量：大仓库里定位、跨文件核对、
    // 发现方向不对再换一条路，这些都很吃步数。用不完会提前收尾，不额外花钱。
    defaultMaxSteps: 80
  },
  reviewer: {
    name: '审查',
    hint: '只读：检查改动并列出问题。',
    // 审查要「读改动 + 读被调用方」两遍，还要顺着调用链看几层；与小步数不同，
    // 审查的价值恰恰在于看完，宁可多给。
    defaultMaxSteps: 80
  }
}

/**
 * 步数收敛：只留合法 id + `[SUBAGENT_MIN_STEPS, SUBAGENT_MAX_STEPS]` 内的整数。
 *
 * 越界的整条**丢掉**（回到默认值），而不是夹到最近边界 —— 用户填 500 想要的是「更多」，
 * 悄悄给 64 会让他以为设置生效了却依旧中途停下。
 */
function normalizeMaxSteps(value: unknown): Partial<Record<SubagentId, number>> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const out: Partial<Record<SubagentId, number>> = {}
  for (const id of SUBAGENT_IDS) {
    const raw = input[id]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const steps = Math.trunc(raw)
    if (steps < SUBAGENT_MIN_STEPS || steps > SUBAGENT_MAX_STEPS) continue
    out[id] = steps
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 收敛：手改坏的数据文件 / 老版本缺字段都不该让读接口抛错 */
export function normalizeSubagentSettings(value: unknown): SubagentSettings {
  const input = (value ?? {}) as SubagentSettings
  const raw = input.enabled
  const modelConfigId =
    typeof input.modelConfigId === 'string' && input.modelConfigId.trim()
      ? input.modelConfigId.trim()
      : null
  const modelId =
    typeof input.modelId === 'string' && input.modelId.trim() ? input.modelId.trim() : null
  const maxSteps = normalizeMaxSteps(input.maxSteps)
  return {
    enabled: Array.isArray(raw) ? raw.filter((id) => SUBAGENT_IDS.includes(id)) : [],
    // 成对才生效：只有一半时服务端会退回父模型，这里也直接收敛成「没配」
    ...(modelConfigId && modelId ? { modelConfigId, modelId } : {}),
    ...(maxSteps ? { maxSteps } : {})
  }
}

// ---------------------------------------------------------------------------
// 接口请求（api-client）：Postman 式的 HTTP / WebSocket 调试
// ---------------------------------------------------------------------------
//
// 迁移自 dogi 的「接口请求」功能。与 dogi 的差别只有两处：
// 1. 请求由**服务端**执行（绕开浏览器 CORS，可达内网与自签证书服务），不再经
//    Electron 主进程 IPC —— 故 `ApiHttpRequest` 去掉主进程专用的 `proxy` 字段；
// 2. `form-data` 的文件字段由渲染端 `<input type=file>` 读成 base64 随 JSON 上送，
//    因此不再有「本地绝对路径」的概念（见 `ApiFormField` 的 `fileName` / `dataBase64`）。

/**
 * 一条请求头：以「键值对数组」而非对象保存，保留空行以便在界面上继续编辑。
 *
 * `enabled` 是**表里的开关**，不是请求头本身的东西：停用（`false`）的行照旧留在表里
 * 接着编辑，只是不参与发送（不进请求头对象）。缺省 / 历史数据一律按「启用」处理，
 * 所以只有真的要停用时才写这个字段。
 */
export interface ApiHeaderPair {
  key: string
  value: string
  /** 该行是否随请求发出（缺省 = 启用） */
  enabled?: boolean
}

/**
 * 请求体类型（接口调试页「请求体」分段的三选一 + none）：
 * - `none`：**不携带请求体**，发送时不带 body（Content-Type 也原样不动）；
 * - `raw`（**缺省**，兼容历史数据）：一段自由文本，高亮语言由 Content-Type 推导；
 * - `x-www-form-urlencoded`：键值对表单，发送时序列化成 `a=1&b=2`；
 * - `form-data`：`multipart/form-data`，字段可标成「文件」并选本地文件上传。
 */
export type ApiBodyType = 'none' | 'raw' | 'x-www-form-urlencoded' | 'form-data'

/**
 * 表单字段（`x-www-form-urlencoded` 与 `form-data` 共用同一行结构）。
 * 两种模式**各存一份列表**：来回切换时不会把另一种模式填的内容冲掉。
 *
 * ⚠️ 文件字段（`isFile`）的两处与 dogi 不同：
 * - 落盘只留 `fileName`（不落 base64，避免集合膨胀）；
 * - 运行时文件内容在渲染端标签内存里，发送时放进 `dataBase64` 随载荷上送。
 *   所以重开一个已保存的请求，文件内容会丢失，发送时提示重新选文件。
 */
export interface ApiFormField {
  key: string
  value: string
  /** **仅 `form-data` 生效**：该字段是文件 */
  isFile?: boolean
  /** 该行是否随请求发出（缺省 = 启用）；停用的行留在表里但不进请求体 */
  enabled?: boolean
  /** 文件字段：所选文件名（落盘只留这个；发送时当 multipart 的 filename） */
  fileName?: string
  /** 文件字段：运行时文件内容（base64，不含 `data:` 前缀）；仅发送载荷携带，不落盘 */
  dataBase64?: string
}

/**
 * 接口请求分组：侧边栏里的分组节点。
 * 不设颜色 —— 接口请求的分组只承担「归类 + 排序」。
 */
export interface ApiGroup {
  id: string
  name: string
  /** 父分组 id；缺省 = 顶级分组，支持任意层级嵌套 */
  parentId?: string
  createdAt: number
}

/**
 * 接口调试的协议类型。
 * - `http`：一次性请求/响应（缺省值，历史数据里没有该字段的都按 http 处理）
 * - `ws`：长连接，由 `WsPage` 调试，连接与收发消息见 `WsEvent`
 */
export type ApiProtocol = 'http' | 'ws'

/**
 * 保存的接口请求：侧边栏列表项，同时是主区域「接口请求」标签的打开对象。
 * 一个请求 = 一个标签，所以这里不带「未保存草稿」的概念（新建即落盘）。
 *
 * WebSocket 复用了这张表：`protocol: 'ws'` 时 `method`/`body` 不参与语义
 * （连接靠 `url` + `headers` + `subprotocols`），这样分组、拖拽、搜索那一整套
 * 都不用再造一份。
 */
export interface ApiRequestEntry {
  id: string
  /** 展示名，缺省由「方法 + 地址」推导（见渲染端 apiNameOf） */
  name: string
  method: string
  url: string
  headers: ApiHeaderPair[]
  body: string
  /** 请求体类型；undefined 视为 'raw'（兼容历史数据） */
  bodyType?: ApiBodyType
  /** `x-www-form-urlencoded` 的键值对（`bodyType` 不是它时只是留着，不参与发送） */
  bodyUrlencoded?: ApiHeaderPair[]
  /** `form-data` 的字段（`bodyType` 不是它时只是留着，不参与发送） */
  bodyFormFields?: ApiFormField[]
  /** 协议类型；undefined 视为 'http'（兼容历史数据） */
  protocol?: ApiProtocol
  /** 仅 WebSocket：子协议（Sec-WebSocket-Protocol），如 ['graphql-ws'] */
  subprotocols?: string[]
  /**
   * 仅 WebSocket：跳过 TLS 证书校验（wss 自签证书），缺省关闭。
   *
   * 注意取值方向与字段名相反（沿用 undici 的 `connect.rejectUnauthorized`）：
   * **`false` 才是「不校验」**，`true` / 缺省都是正常校验。
   */
  rejectUnauthorized?: boolean
  /**
   * 所属分组；undefined = 未分组。
   * 只由 `arrange`（拖拽重排）改动 —— 普通的保存/新建不要碰它，
   * 否则按 Ctrl/Cmd+S 会把请求从分组里踢出去。
   */
  groupId?: string
  createdAt: number
  updatedAt: number
}

/** 请求历史：每次发送后自动记录，按时间倒序保留最近若干条 */
export interface ApiHistoryEntry {
  id: string
  method: string
  url: string
  headers: ApiHeaderPair[]
  body: string
  /** 请求体类型；undefined 视为 'raw'（见 ApiRequestEntry.bodyType） */
  bodyType?: ApiBodyType
  /** `x-www-form-urlencoded` 的键值对 */
  bodyUrlencoded?: ApiHeaderPair[]
  /** `form-data` 的字段（文件字段只留文件名，载入后内容可能已失效） */
  bodyFormFields?: ApiFormField[]
  /** 失败时为 0 */
  status: number
  statusText: string
  timeMs: number
  at: number
}

/** 服务端执行 HTTP 请求的入参 */
export interface ApiHttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  /** `raw` 模式的正文（bodyType 缺省 / 'raw' 时使用） */
  body?: string
  /** 请求体类型；缺省视为 'raw' */
  bodyType?: ApiBodyType
  /** `x-www-form-urlencoded` 的键值对（bodyType 为它时使用） */
  urlencoded?: ApiHeaderPair[]
  /** `form-data` 的字段（bodyType 为它时使用；文件字段用 `dataBase64` 携带内容） */
  formFields?: ApiFormField[]
  /** 超时（毫秒） */
  timeoutMs?: number
  /** 跳过 TLS 证书校验（自签证书） */
  rejectUnauthorized?: boolean
}

/** 发一次 HTTP 的载荷：请求参数 + 用于取消的 id */
export interface ApiSendInput {
  /** 调用方生成的 id；`POST /api/api-client/send/abort` 用它取消这次请求 */
  sendId: string
  request: ApiHttpRequest
}

/**
 * 请求结果：网络层失败（DNS/超时/证书）不抛异常，而是返回 status=0 + error，
 * 这样界面可以照常展示耗时与错误，无需区分「异常」和「非 2xx」两条路径。
 */
export interface ApiHttpResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  /** 耗时（毫秒） */
  timeMs: number
  /** 失败时的错误信息 */
  error?: string
}

/** 新建 / 更新分组的入参：不传 id = 新增；parentId 缺省 = 顶级分组 */
export interface ApiGroupInput {
  id?: string
  name: string
  parentId?: string
}

/**
 * 拖拽重排：数组顺序即显示顺序（DFS 前序）。
 * - `groups`：全部分组按目标顺序列出，`id` + 目标 `parentId`（undefined = 顶级）；
 * - `requests`：请求按目标顺序列出，`groupId` 为最终归属（undefined = 未分组）。
 */
export interface ApiArrangeInput {
  groups: Array<{ id: string; parentId?: string }>
  requests: Array<{ id: string; groupId?: string }>
}

/** 分组与请求同时变更时的返回（重排 / 删分组都会动两份数据） */
export interface ApiGroupsAndRequests {
  groups: ApiGroup[]
  requests: ApiRequestEntry[]
}

// ---------- 主机脚本（scripts）----------
//
// 一段可以「一键在某台主机上执行」的命令文本（照搬 dogi 的 scripts 功能）。
// 与接口请求同款：**全局一份**（不按项目），集合 + 分组落服务端数据目录，
// 经 state-ws 全量快照推给渲染端。
//
// 与接口请求的差别：脚本分组只有**一层**且不可嵌套（未分组恒在首位）——
// dogi 的脚本分组只承担「归类 + 排序」，不需要多级树。

/**
 * 一条保存的脚本。
 *
 * 执行方式：把 `content` 逐行写进目标主机的终端（转换见渲染端 `scriptToTerminalInput`），
 * 所以这里存的是**裸命令文本**，不掺任何转义。
 */
export interface ScriptEntry {
  id: string
  name: string
  /** 脚本正文（写进主机终端时按行回车） */
  content: string
  /** 可选说明（列表副标题 / 运行确认时展示） */
  description?: string
  /**
   * 所属分组；undefined = 未分组。
   * 只由 `arrangeScripts`（拖拽重排）改动 —— 普通的保存 / 编辑不要碰它，
   * 否则保存时会把脚本从分组里踢出去。
   */
  groupId?: string
  createdAt: number
  updatedAt: number
}

/** 脚本分组（**单层**，不可嵌套；只承担归类 + 排序） */
export interface ScriptGroup {
  id: string
  name: string
  createdAt: number
}

/** 新建 / 更新脚本的入参：不传 id = 新增；未带字段继承旧记录 */
export interface ScriptInput {
  id?: string
  name?: string
  content?: string
  description?: string
  groupId?: string
}

/** 新建 / 更新分组的入参：不传 id = 新增 */
export interface ScriptGroupInput {
  id?: string
  name: string
}

/**
 * 拖拽重排：数组顺序即显示顺序。
 * - `groupIds`：全部分组按目标顺序列出（数组顺序即分组显示顺序）；
 * - `scripts`：脚本按目标顺序列出，`groupId` 为最终归属（undefined = 未分组）。
 */
export interface ScriptArrangeInput {
  groupIds: string[]
  scripts: Array<{ id: string; groupId?: string }>
}

/** 分组与脚本同时变更时的返回（重排 / 删分组都会动两份数据） */
export interface ScriptsAndGroups {
  groups: ScriptGroup[]
  scripts: ScriptEntry[]
}

// ---------- 数据导入 / 导出（左下角菜单：接口请求 / 主机 / 脚本）----------
//
// 照搬 dogi 的 `TransferPayload`（`src/shared/types.ts`）：**一套外壳、三类数据共用**，
// 靠 `kind` 区分，分组与条目分开存。格式与 dogi 逐字段一致，所以
// **dogi 导出的 `api.json` / `hosts.json` 能直接导进来**，反向也能被 dogi 读回去。

/**
 * 可导入 / 导出的数据类型（一种类型 = 一个 JSON 文件 / zip 里的一个条目）。
 *
 * 与 dogi 的差别只有一处：dogi 是 `hosts | notes | api`，fizz 没有笔记，
 * 多了「主机脚本」。`hosts` / `api` 这两个 kind 名与 dogi **保持一致**，
 * 否则 dogi 导出的文件会被判成「内容类型与文件名不符」而拒收。
 */
export type TransferKind = 'hosts' | 'api' | 'scripts'

/** 导出的文件形态：`zip` = 一个压缩包（可含多类）；`json` = 单类一份纯 JSON */
export type TransferFormat = 'zip' | 'json'

/**
 * 单个 JSON 文件的结构（zip 里的一个条目，或 `format: 'json'` 时的整个文件）。
 *
 * `groups` / `items` 刻意是 `unknown[]`：三类数据的条目形状各不相同，这里只做
 * 「是不是数组」这一层校验，具体字段由 `@fizz/workspace` 的 transfer 模块逐类收敛。
 */
export interface TransferPayload {
  /** 数据格式版本（不兼容时拒绝导入） */
  version: 1
  kind: TransferKind
  exportedAt: number
  /** 分组（接口请求分组 / 主机无分组 / 脚本分组） */
  groups: unknown[]
  /** 条目：接口请求 / 主机配置 / 脚本 */
  items: unknown[]
}

/** 解析出的一个「可导入项」：对应 zip 里的一个文件（或单文件 JSON 的那一份） */
export interface TransferEntry {
  kind: TransferKind
  /** zip 内的文件名，如 `api.json`；单文件 JSON 时是用户选的文件名 */
  file: string
  /** 条目数（不含分组） */
  itemCount: number
  /** 分组数 */
  groupCount: number
}

/** 导出结果：文件内容以 **base64** 回传（desktop 的 IPC 桥 body 只支持字符串，见 `ApiSendInput`） */
export interface TransferExportResult {
  /** 建议的文件名（含扩展名） */
  fileName: string
  /** 该文件的 MIME（`application/zip` / `application/json`） */
  mime: string
  /** 文件内容，base64（不含 `data:` 前缀） */
  dataBase64: string
  /** 各类型实际导出的条目数（分组不计入） */
  counts: Partial<Record<TransferKind, number>>
}

/** 解析导入包的结果：先给摘要让用户挑，再调 apply 真正写库 */
export interface TransferInspectResult {
  /** 识别出的容器形态 */
  format: 'zip' | 'json'
  /** 包里有哪些可导入项 */
  entries: TransferEntry[]
}

/** 执行导入的结果：按类型分别报「新增 / 覆盖更新 / 跳过」的条数（分组不计入） */
export interface TransferImportResult {
  /** 各类型新增的条目数 */
  added: Partial<Record<TransferKind, number>>
  /** 各类型覆盖更新（id 已存在）的条目数 */
  updated: Partial<Record<TransferKind, number>>
  /** 各类型因结构不合法而跳过的条目数（不中断整批） */
  skipped: Partial<Record<TransferKind, number>>
}

/* ────────────────────────────── 登录验证码（滑块） ────────────────────────────── */

/** 验证码种类。目前只有滑块；留着判别字段是为了将来能并存点选 / 算术。 */
export type CaptchaKind = 'slider'

/**
 * 服务端签发的公开挑战数据（`GET /api/auth/captcha` 的 `challenge`）。
 *
 * ⚠️ 刻意**不含答案**：`targetX` 只在服务端内存里，前端能拿到的只有图片像素。答案永不
 * 下发 —— 用 SVG 下发时缺口坐标会以数字形式躺在响应文本里，三行正则就能抠出来。
 */
export interface CaptchaChallenge {
  kind: CaptchaKind
  /** 挑战标识，提交校验时原样回传 */
  id: string
  /** 背景图（PNG data URL） */
  background: string
  /** 拼图块图（PNG data URL，透明底） */
  piece: string
  /** 背景逻辑宽高（px） */
  width: number
  height: number
  /** 拼图块（含右侧凸起）逻辑宽高（px） */
  pieceWidth: number
  pieceHeight: number
  /** 拼图块顶边 y（px），拖动时固定不变 */
  pieceY: number
  /** 拼图块左边可拖动的最大值（px）：答案 x ∈ [0, maxX] */
  maxX: number
}

/** 一次拖动轨迹采样。 */
export interface CaptchaTrackPoint {
  /** 当时的位置（逻辑 px） */
  x: number
  /** 相对第一次按下时刻的毫秒数 */
  t: number
}

/** 用户提交的答案（滑块）。 */
export interface CaptchaAnswer {
  /** 拼图块最终左边 x（逻辑 px） */
  x: number
  /** 从按下到松开的耗时（ms）。服务端以 track 末点的 t 为准，此字段仅作冗余 */
  elapsedMs?: number
  /** 拖动轨迹采样。服务端强制校验，不带轨迹一律拒绝 */
  track: CaptchaTrackPoint[]
}

/**
 * `GET /api/auth/captcha` 的响应。
 *
 * `enabled: false` = 服务端当前不要求验证码（鉴权未启用或显式关了），前端直接跳过弹窗。
 */
export interface CaptchaIssueResponse {
  enabled: boolean
  /** 仅在 `enabled: true` 时存在 */
  challenge?: CaptchaChallenge
}

/** `POST /api/auth/captcha/verify` 的响应：通过时带一次性票据，登录时原样回传。 */
export interface CaptchaVerifyResponse {
  ok: boolean
  /** 通过时签发的一次性票据（短时效、用一次即作废） */
  passToken?: string
  /** 失败时可直接展示的文案 */
  error?: string
}
