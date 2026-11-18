/**
 * 钩子（hook）：插件**改写** Agent 行为的地方 —— 与 `ctx.events` 的「只通知、不干预」互补。
 *
 * 两种形态：
 * - **waterfall（拦截改写）**：监听器签名 `(...args, next)`。范式是
 *   `const out = next(); return 改写(out)`（around 中间件：先放行、拿下游结果再加工），
 *   也可以不调 `next()` 直接返回一个值**中断链路**（后面的监听器与兜底都不再跑）。
 *   ⚠️ 框架的 `next(新值)` **不会**把新值传给下一个监听器（`waterfall` 恒以**原始 args**
 *   调用链上的下一个），所以「按入参把新值往后推」这条陆走不通 —— 想串联改写一律用
 *   around 范式。见 Context.waterfall 的实现注释。
 * - **emit（只通知）**：`turn:start` / `turn:finish` 这类生命周期事件，参数是一个对象。
 *
 * 归属（与 `ctx.tools` 完全同款，是本模块存在的理由）：`hooks` 服务由 `runAgent`
 * 建在 **turn context** 上，插件 `ctx.hooks.on(...)` 注册的监听器因此落在 turn context、
 * 能被同一轮的 `waterfall` / `emit` 看见；而 disposer 经 `bindEffect` 记在**插件 fiber** 上，
 * 插件卸载 / 下一轮重建时自动摘掉。
 * （对比：`ctx.events` 的实体是 **fiber-local** 的，在插件 fiber 上注册的监听器父层看不见。）
 *
 * ## 会话状态钩子（`conversation:*`）挂在**长驻宿主**上
 *
 * `turn:*` 是单轮内部的钩子，ACP / 容器型会话甚至没有这个 turn context；而「一轮开始 /
 * 结束 / 在等审批 / 在等回答」是**产品层面的会话状态**，必须跨后端、跨轮次存在。
 *
 * 所以服务端另建一份按工作区长驻的 hooks 宿主（`apps/server/src/server/conversation-hooks.ts`），
 * 从全局瞬时事件总线桥接这六个 hook。插件要接它们，用
 * `ctx.inject(['hooks'], (c) => c.hooks.on('conversation:finished', ...))` —— 不要写进
 * 顶层 `inject`（设置页的 inspect context 没有 hooks，写顶层会让整个插件被推迟挂载）。
 *
 * 监听器里**不要 await 网络请求**：这条总线是同步的，通知类插件应当 fire-and-forget
 * 并在自己的 Promise 上 catch。
 */
import { EventsService } from './services/events'

/** 钩子名（用常量，避免各处手写字符串拼错） */
export const HOOKS = {
  /** 工具调用前：参数 `(toolName, input)`，可改写成新的 input */
  toolCall: 'tool:call',
  /** 工具返回后：参数 `(toolName, output)`，可改写成新的 output */
  toolResult: 'tool:result',
  /** 系统提示词渲染完成后：参数 `(text)`，可改写成新的正文 */
  promptRender: 'prompt:render',
  /** 一轮开始（emit，参数 `TurnStartPayload`） */
  turnStart: 'turn:start',
  /** 一轮收尾（emit，参数 `TurnFinishPayload`） */
  turnFinish: 'turn:finish',
  /** 会话一轮开跑（emit，参数 `ConversationStartedPayload`） */
  conversationStarted: 'conversation:started',
  /** 会话一轮收尾（落盘之后；emit，参数 `ConversationFinishedPayload`） */
  conversationFinished: 'conversation:finished',
  /** 工具调用在等用户审批（emit，参数 `ConversationConfirmPayload`） */
  conversationConfirm: 'conversation:confirm',
  /** 审批有了答复（emit，参数 `ConversationConfirmResolvedPayload`） */
  conversationConfirmResolved: 'conversation:confirm-resolved',
  /** Agent 在等用户回答提问（emit，参数 `ConversationFollowupPayload`） */
  conversationFollowup: 'conversation:followup',
  /** 提问有了答复（emit，参数 `ConversationFollowupResolvedPayload`） */
  conversationFollowupResolved: 'conversation:followup-resolved'
} as const

export type HookName = (typeof HOOKS)[keyof typeof HOOKS]

/**
 * `waterfall` 的兜底：取出「被改写的主体」。约定 —— 钩子带两个及以上参数时，
 * **第 2 个**是主体（第 1 个是名字之类的标识）；只有一个参数时它就是主体。
 * 这样兜底既接得住 `fallback(name, payload)`，也接得住监听器 `next(payload)` 的单参形态。
 */
export function hookValue(...args: unknown[]): unknown {
  return args.length >= 2 ? args[1] : args[0]
}

/** `tool:call` 监听器：`next()` 拿到下游决定的入参 */
export type ToolCallListener = (toolName: string, input: unknown, next: () => unknown) => unknown
/** `tool:result` 监听器：`next()` 拿到下游决定的返回 */
export type ToolResultListener = (toolName: string, output: unknown, next: () => unknown) => unknown
/** `prompt:render` 监听器：`next()` 拿到下游决定的正文 */
export type PromptRenderListener = (text: string, next: () => unknown) => unknown

export interface TurnStartPayload {
  turnId: string
  workspaceId: string
  workspaceName: string
}

export interface TurnFinishPayload {
  turnId: string
  finishReason: string
  usage?: unknown
}

export type TurnStartListener = (payload: TurnStartPayload) => void
export type TurnFinishListener = (payload: TurnFinishPayload) => void

/**
 * 会话状态钩子的公共坐标。
 *
 * 这是**稳定的插件 API**，刻意不直接复用 contracts 的 SSE 事件类型：传输层以后加字段
 * （或者改名）不该悄悄改变插件看到的数据形状。
 */
export interface ConversationHookTarget {
  conversationId: string
  requestId: string
  title: string
  /** 会话绑定的工作区；虚拟 / 已删工作区的会话没有这两项 */
  workspaceId?: string
  workspaceName?: string
}

export interface ConversationStartedPayload extends ConversationHookTarget {
  startedAt: number
}

export interface ConversationFinishedPayload extends ConversationHookTarget {
  finishReason: string
  excerpt?: string
  error?: string
  /** 撞上单轮步数上限时是 `'max-steps'`（与界面的「已用满 N 步」同义） */
  stopReason?: string
  steps?: number
  finishedAt: number
}

export interface ConversationConfirmPayload extends ConversationHookTarget {
  confirm: {
    id: string
    toolCallId: string
    toolName: string
    command: string
    intent?: string
    agentId?: string
    agentName?: string
    options?: Array<{ optionId: string; name: string; kind: string }>
  }
}

export interface ConversationConfirmResolvedPayload extends ConversationHookTarget {
  confirmId: string
  approved: boolean
}

export interface ConversationFollowupPayload extends ConversationHookTarget {
  followup: {
    id: string
    toolCallId: string
    title?: string
    questions: Array<{
      id: string
      question: string
      header: string
      multiSelect: boolean
      options: Array<{ label: string; description?: string }>
    }>
  }
}

export interface ConversationFollowupResolvedPayload extends ConversationHookTarget {
  followupId: string
  toolCallId: string
}

export type ConversationHookPayload =
  | ConversationStartedPayload
  | ConversationFinishedPayload
  | ConversationConfirmPayload
  | ConversationConfirmResolvedPayload
  | ConversationFollowupPayload
  | ConversationFollowupResolvedPayload

export type ConversationStartedListener = (payload: ConversationStartedPayload) => void
export type ConversationFinishedListener = (payload: ConversationFinishedPayload) => void
export type ConversationConfirmListener = (payload: ConversationConfirmPayload) => void
export type ConversationConfirmResolvedListener = (
  payload: ConversationConfirmResolvedPayload
) => void
export type ConversationFollowupListener = (payload: ConversationFollowupPayload) => void
export type ConversationFollowupResolvedListener = (
  payload: ConversationFollowupResolvedPayload
) => void

/**
 * 钩子总线：`ctx.hooks` 的实体。行为完全委托给所属 Context（与 `EventsService` 同），
 * 只是服务名不同 —— 让插件能 `inject: ['hooks']` 声明依赖，也便于测试给替身。
 */
export class HooksService extends EventsService {
  get name(): string {
    return 'hooks'
  }
}