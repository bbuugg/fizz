/**
 * 轮中「实时 TPS」的**客户端估算**。
 *
 * ## 为什么需要自己算
 *
 * 真值 `TurnUsage.tps` 要等一轮结束才由服务端算好（随 `finish` 帧下发）。流式期间 SSE
 * 只给 `text-delta` / `reasoning-delta` / `tool-call-delta` 这些**文本增量**，上游并不
 * 逐个增量上报 token 数。所以这里的分子是**按字符估算**的 token —— 只能看个大概，
 * 轮次结束后由消息上的 `usage.tps` 校正。
 *
 * ## 口径与服务端严格对齐
 *
 * 分母沿用 `agent/src/agent.ts` 的 `TurnGenClock`：只累计「有输出增量」的时间片，
 * 相邻增量间隔 > 1s 的那一段整段丢弃（工具执行 / 等审批 / 网络空窗）。否则多步工具轮
 * 会把几十秒空窗算进分母，实时数字直接掉到个位数，与结束后的真值差一个量级。
 *
 * 「哪些事件算模型在吐字」也与服务端的 `isOutputDelta` 逐条对齐：`tool-result` /
 * `tool-output-delta` / `file-part` / `subagent-*` 都不算（那是工具或子
 * agent 在产出，不是本轮主模型的速度），空串增量也不算。
 *
 * ## 分子只算「落在窗口里的那部分」（别再把一次性 burst 当速度）
 *
 * 分母是「帧与帧之间累加出来的时间片」，所以**只有后一帧的 token 属于刚采到的那个时间片**：
 * 一段连续输出的第一帧（`lastAt` 为空、或刚从 1s 空窗里接上）的内容是**在窗口开始之前**
 * 就生成好的，它没有对应的时长，算进分子就是凭空加分。
 *
 * 这条不是洁癖：帧是**合批**到达的（`frame-batch` 攒一个动画帧；上游 / 代理也可能一次
 * 吐一大段）。旧实现拿「全部估算 token ÷ 只累计帧间隔的分母」，一次 burst 就能把数字顶到
 * 每分钟几万 tok/s（用户看到 4000+），而且它挂在累计量上 —— 那一轮剩下的时间都在虚高。
 * 完整 `tool-call`（没收到过入参增量）的大入参正是这种 burst：写一个几千字符的文件就是
 * 上千 token 落在**一帧**里，一律不计入分子（只进 `outputTokens` 的展示量）。
 *
 * 另外两道闸：窗口不足 `MIN_WINDOW_MS` 不报数（否则头两个 16ms 的帧就能推出个天文数字），
 * 显示值按 `TPS_REFRESH_MS` 节流。
 *
 * ## token 刻度
 *
 * 与 `agent/src/context.ts` 的 `estimateTokens` 同一把尺子：宽字符（CJK / 全角标点）
 * 按 1 token，其余按 4 字符 1 token。那边是服务端压缩判断用的，本包不能引 agent 运行时，
 * 所以这里保留一份等价实现（两边都有单测钉住）。
 *
 * ⚠️ 完整 `tool-call` 只在**没有收到过它的入参增量**时才估算一次入参 token：多数上游
 * 两者都会发，都算会让写文件这类大入参的工具轮虚高一倍（这条约束的只是 `outputTokens`
 * 这个展示量，速度的分子见上一节，那种没流过的入参根本不参与算速度）。
 */
import type { AgentStreamEvent } from '@fizz/contracts/types'

/** 与服务端 `TPS_IDLE_GAP_MS` 一致：超过这个间隔就当模型没在吐字 */
const IDLE_GAP_MS = 1000

/**
 * 对外显示的 `tps` 最短刷新间隔（毫秒）。
 *
 * 生成窗口与 token 数每来一帧都在变，但**显示值**没必要跟着每帧跳：一秒钟几十次改数字
 * 只会晃眼。这里攒够 500ms 才重算一次（2 次/秒），中间各帧只累计内部量。
 */
const TPS_REFRESH_MS = 500

/**
 * 报数门槛：**采到的生成窗口至少这么长**才允许出一个 tok/s。
 *
 * 帧是合批到达的（一帧 ≈ 16ms 的内容），窗口太短时「一帧的 token ÷ 几毫秒」没有意义 ——
 * 哪怕分子已经按上一节剔掉了窗口外的部分，剩下那一两帧也能算出上千 tok/s。攒够半秒
 * （约 30 帧）之后再报，噪声就摊平了，与 `TPS_REFRESH_MS` 同量级。
 */
const MIN_WINDOW_MS = 500

export interface LiveTpsState {
  /** 已累计的生成窗口（毫秒），口径见文件头 */
  genMs: number
  /** 上一个输出增量的时刻（null = 本轮还没出过字） */
  lastAt: number | null
  /**
   * 按字符估算的累计输出 token（含思考与工具入参）—— 用于「≈ 输出 tokens」的展示，
   * **不是**速度的分子（那个是 `windowTokens`）
   */
  outputTokens: number
  /** 落在 `genMs` 这些时间片里的估算 token（速度的分子，见文件头「分子只算…」） */
  windowTokens: number
  /** 对外显示的 tok/s（**整数**，`genMs` 够长且每 `TPS_REFRESH_MS` 才重算一次） */
  tps: number
  /** 上一次重算 `tps` 的时刻（0 = 还没算过） */
  tpsAt: number
  /** 已经按增量计过入参的 toolCallId（完整 `tool-call` 到达时不再重复计） */
  streamedToolCalls: string[]
}

/** 宽字符计数：与 `packages/agent/src/context.ts` 的 `countWideChars` 逐条一致 */
function countWideChars(text: string): number {
  let wide = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c < 0x2e80) continue
    if (
      c <= 0x9fff || // CJK 部首、假名、CJK 统一表意文字
      (c >= 0xac00 && c <= 0xd7af) || // 谚文音节
      (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容表意文字
      (c >= 0xfe30 && c <= 0xfe4f) || // CJK 兼容形式
      (c >= 0xff01 && c <= 0xff60) || // 全角 ASCII（，。：；！？等）
      (c >= 0xffe0 && c <= 0xffe6) // 全角符号（￥ ￡ 等）
    ) {
      wide += 1
    }
  }
  return wide
}

/** 与 agent 的 `estimateTokens` 同刻度：宽字符 1 token，其余 4 字符 1 token */
function estimateTokens(text: string): number {
  if (!text) return 0
  const wide = countWideChars(text)
  return wide + Math.ceil((text.length - wide) / 4)
}

/** 工具入参（unknown）→ 用于估算的文本 */
function inputText(input: unknown): string {
  if (typeof input === 'string') return input
  if (input === undefined) return ''
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return ''
  }
}

/**
 * 这一帧算不算「模型在吐字」—— 与服务端 `isOutputDelta` 同一条判据。
 * 完整 `tool-call` 也算（有的上游不发增量，那时它是模型吐过字的唯一证据）。
 */
function isOutputFrame(event: AgentStreamEvent): boolean {
  switch (event.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return event.delta.trim() !== ''
    case 'tool-call-delta':
      return event.inputTextDelta !== ''
    case 'tool-call':
      return true
    default:
      return false
  }
}

/** 这一帧估算出的输出 token（只进展示量） */
function frameTokens(event: AgentStreamEvent, streamedToolCalls: string[]): number {
  switch (event.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return estimateTokens(event.delta)
    case 'tool-call-delta':
      return estimateTokens(event.inputTextDelta)
    case 'tool-call':
      // 收到过入参增量的不再重复计（见文件头）
      return streamedToolCalls.includes(event.toolCallId) ? 0 : estimateTokens(inputText(event.input))
    default:
      return 0
  }
}

/**
 * 吃掉一帧流事件，返回新的实时统计。
 *
 * - 非输出事件 → 原样返回（保持引用不变，避免渲染层白重渲染）；
 * - `finish` / `error` → null（这一轮结束，圆环旁的实时数字收掉）；
 * - 输出增量 → 累计生成窗口 + 估算 token，够长就重算 `tps`。
 *
 * `now` 只在测试里显式传，运行时用 `Date.now()`。
 */
export function advanceLiveTps(
  state: LiveTpsState | null,
  event: AgentStreamEvent,
  now: number = Date.now()
): LiveTpsState | null {
  if (event.type === 'finish' || event.type === 'error') return null
  if (!isOutputFrame(event)) return state

  const prev: LiveTpsState = state ?? {
    genMs: 0,
    lastAt: null,
    outputTokens: 0,
    windowTokens: 0,
    tps: 0,
    tpsAt: 0,
    streamedToolCalls: []
  }

  /**
   * 与 `markTurnOutputDelta` 同一套：第一帧只记时刻（TTFT 不进分母），空窗整段丢弃。
   *
   * `timed` = 这一帧的内容落在刚采到的那个时间片里（见文件头「分子只算…」）：
   * `gap <= 0`（同一毫秒的合批帧 / 时钟回拨）没有时长可摊，同样只进展示量。
   *
   * 完整 `tool-call`（没收到入参增量的那种）**一律不计入分子**：它的入参是模型在
   * **我们看不见增量的那段时间**里写完的，落在这里只是一帧，摊到的时长可能只有几十
   * 毫秒 —— 写一个几千字符的文件就能算出几千 tok/s（用户报的 4000+ 就是这个形状）。
   */
  let genMs = prev.genMs
  /** 这一帧是否接在一个有效的时间片后面（第一帧 / 空窗后的第一帧 = false） */
  let inWindow = false
  if (prev.lastAt !== null) {
    const gap = now - prev.lastAt
    if (gap > 0 && gap <= IDLE_GAP_MS) {
      genMs += gap
      inWindow = true
    }
  }
  /** 这一帧的 token 算不算进速度的分子：完整 `tool-call` 永远不算（见上） */
  const timed = inWindow && event.type !== 'tool-call'

  let streamedToolCalls = prev.streamedToolCalls
  if (event.type === 'tool-call-delta' && !streamedToolCalls.includes(event.toolCallId)) {
    streamedToolCalls = [...streamedToolCalls, event.toolCallId]
  }
  const tokens = frameTokens(event, prev.streamedToolCalls)

  // 显示值：窗口够长（见 `MIN_WINDOW_MS`）且到了刷新点才重算；整数，不保留小数
  let tps = prev.tps
  let tpsAt = prev.tpsAt
  if (genMs >= MIN_WINDOW_MS && now - prev.tpsAt >= TPS_REFRESH_MS) {
    tps = Math.round((prev.windowTokens + (timed ? tokens : 0)) / (genMs / 1000))
    tpsAt = now
  }
  return {
    genMs,
    lastAt: now,
    outputTokens: prev.outputTokens + tokens,
    windowTokens: prev.windowTokens + (timed ? tokens : 0),
    tps,
    tpsAt,
    streamedToolCalls
  }
}
