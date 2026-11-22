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
 * `tool-output-delta` / `file-part` / `subagent-*` / `collab-*` 都不算（那是工具或子
 * agent 在产出，不是本轮主模型的速度），空串增量也不算。
 *
 * ## token 刻度
 *
 * 与 `agent/src/context.ts` 的 `estimateTokens` 同一把尺子：宽字符（CJK / 全角标点）
 * 按 1 token，其余按 4 字符 1 token。那边是服务端压缩判断用的，本包不能引 agent 运行时，
 * 所以这里保留一份等价实现（两边都有单测钉住）。
 *
 * ⚠️ 完整 `tool-call` 只在**没有收到过它的入参增量**时才估算一次入参 token：多数上游
 * 两者都会发，都算会让写文件这类大入参的工具轮虚高一倍。
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

export interface LiveTpsState {
  /** 已累计的生成窗口（毫秒），口径见文件头 */
  genMs: number
  /** 上一个输出增量的时刻（null = 本轮还没出过字） */
  lastAt: number | null
  /** 按字符估算的累计输出 token（含思考与工具入参） */
  outputTokens: number
  /** 对外显示的 tok/s（**整数**，每 `TPS_REFRESH_MS` 才重算一次） */
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

/**
 * 吃掉一帧流事件，返回新的实时统计。
 *
 * - 非输出事件 → 原样返回（保持引用不变，避免渲染层白重渲染）；
 * - `finish` / `error` → null（这一轮结束，圆环旁的实时数字收掉）；
 * - 输出增量 → 累计生成窗口 + 估算 token，重算 `tps`。
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
    tps: 0,
    tpsAt: 0,
    streamedToolCalls: []
  }

  // 与 `markTurnOutputDelta` 同一套：第一帧只记时刻（TTFT 不进分母），空窗整段丢弃
  let genMs = prev.genMs
  if (prev.lastAt !== null) {
    const gap = now - prev.lastAt
    if (gap > 0 && gap <= IDLE_GAP_MS) genMs += gap
  }

  let outputTokens = prev.outputTokens
  let streamedToolCalls = prev.streamedToolCalls
  switch (event.type) {
    case 'text-delta':
    case 'reasoning-delta':
      outputTokens += estimateTokens(event.delta)
      break
    case 'tool-call-delta':
      outputTokens += estimateTokens(event.inputTextDelta)
      if (!streamedToolCalls.includes(event.toolCallId)) {
        streamedToolCalls = [...streamedToolCalls, event.toolCallId]
      }
      break
    case 'tool-call':
      // 收到过入参增量的不再重复计（见文件头）
      if (!streamedToolCalls.includes(event.toolCallId)) {
        outputTokens += estimateTokens(inputText(event.input))
      }
      break
    default:
      break
  }

  // 显示值按 `TPS_REFRESH_MS` 节流（见常量注释）；整数，不保留小数
  let tps = prev.tps
  let tpsAt = prev.tpsAt
  if (genMs > 0 && now - prev.tpsAt >= TPS_REFRESH_MS) {
    tps = Math.round(outputTokens / (genMs / 1000))
    tpsAt = now
  }
  return { genMs, lastAt: now, outputTokens, tps, tpsAt, streamedToolCalls }
}
