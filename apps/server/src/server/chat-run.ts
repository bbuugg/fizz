/**
 * 一轮对话的运行注册表：把「Agent 循环的生命周期」从「客户端那条 SSE 连接」上摘下来。
 *
 * 背景：以前一轮对话就活在 `POST /api/chat` 的那个 `streamSSE` 回调里 —— 客户端一断开
 * （刷新页面、Ctrl+R、切标签页）服务端就把整轮 abort 掉，助手回复也只在那条流结束时
 * 才落盘，于是「刷新 = 现场全丢」。
 *
 * 现在改成：run 由这里托管，`POST /api/chat` 只负责**启动**它并把自己订阅上去。
 * 连接断开只是退订（`sub.close()`），run 继续跑完并照常落盘 —— 已经产生的正文 / 思考
 * / 工具调用一点不少。客户端（刷新后 / 切回会话时）发现 run 还在跑而本地没人订着它，
 * 用 `GET /api/chat/active` 查到后经 `GET /api/chat/stream?requestId=` 重新 attach：
 * 先回放帧日志再转直播，现场就回来了。`POST /api/chat/abort` 仍可按 conversationId
 * 直接停掉一条 run（用户点「停止」，或 attach 不可用时的兜底）。
 *
 * ⚠️ 这里刻意**只放内存**：服务端进程重启后 run 全丢。
 * 退出时不会「丢一半」：`abortAllRuns()`（进程退出钩子调）会先中止所有 run，
 * 让 chat-turn 的收尾把已产生的部分正文落盘，再退出。
 */
import { randomUUID } from 'node:crypto'
import type { AgentChatMessage, AiPermissionMode } from '@fizz/contracts/types'
import type { ChatRunSummary, ChatStreamFrame } from '@fizz/contracts/agent-api'
import { abortAcpTurn } from '@fizz/acp'
import { chatRuns } from './state'

/** 一条连接在这条 run 上的订阅位：run 只管把帧塞进来，怎么写到网络由调用方决定 */
export interface ChatRunSubscriber {
  push: (frame: ChatStreamFrame) => void
  /** run 结束 / 订阅方主动退订：让写泵收场 */
  close: () => void
}

export interface ChatRun {
  requestId: string
  conversationId: string
  workspaceId: string
  backend: 'builtin' | 'acp'
  /** 用户点「停止」时 abort 它（runAgent / runAcpAgent 的 signal） */
  controller: AbortController
  /**
   * 正在执行的 execute_command 停止表（toolCallId → 只停它的 stop）。
   * 由 tools 层的 per-command AbortController 经 runAgent → buildAgentSetup 注册，
   * `POST /api/chat/command/stop` 命中它 = 杀那一条命令的进程树，与整轮停止
   * （`controller`）互不影响。收尾时清空（chat-turn 的 .then 链）。
   */
  commandStops: Map<string, () => void>
  /**
   * 这一轮的**活权限档**（内置 Agent 三档：full / confirm / readonly）。
   *
   * 工具集一轮建一次，静态档会把权限快照死在整轮里；`runAgent` 拿的是
   * `() => run.permissionMode` 这个 getter，闸门**每次工具调用现取** —— 用户在
   * 运行中用输入框那颗 pill 切档时，`POST /api/chat/permission` 改的就是这个字段，
   * 下一次工具调用立刻按新档裁决（不必等下一轮）。收尾不重置（run 结束后即被回收）。
   * ACP 会话另有一套 `acpPermissionMode`，这条字段对它们无意义。
   */
  permissionMode: AiPermissionMode
  /**
   * 运行中插话（steer）的收件箱：POST /api/chat/steer 把消息 push 进来，
   * agent 循环在下一个工具步骤边界经 `pollSteer` 消费（见 packages/agent 的
   * `onIterationComplete`）。abort / 收尾兜底后清空（见 chat-turn 的收尾链）。
   * 只有 内置后端的 run 会收（steer 路由对 acp 会话直接 400）。
   */
  steerInbox: AgentChatMessage[]
  /** ACP 轮次的中止要杀进程（只 abort signal 不够）：会话坐标 */
  acpTarget?: { agentId: string; conversationId: string }
  /**
   * 多智能体协作：取消当前轮里某个正在跑的子任务。由 `chat-turn` 在构建运行时挂上，
   * `POST /api/chat/collab/cancel` 找到会话在跑的 run 后调它（返回 false = 任务已不在跑）。
   */
  collabCancel?: (taskId: string) => boolean
  /**
   * 这一轮助手消息的落盘 id（发起那一轮的客户端给的，见 `ChatRequest.assistantMessageId`）。
   * 收尾落盘沿用它，`ChatRunSummary` 也把它给出去 —— 接手这条 run 的端才能用同一个 id 建占位。
   */
  assistantMessageId?: string
  /** 帧日志（含第 0 帧的 start）：新连接据此**回放**出完整现场 */
  frames: ChatStreamFrame[]
  subscribers: Set<ChatRunSubscriber>
  startedAt: number
  finishedAt?: number
  finishReason?: string
  /**
   * `finishRun` 时 resolve。「停止」端点用它等这一轮**真正收尾**（runner 结束、
   * 部分产出落盘、挂起的审批 / 提问解开）后再应答 —— 否则调用方拿「还没落盘」的
   * 状态去拉历史，会看不到已生成的部分。
   */
  done: Promise<void>
}

/**
 * ⚠️ run 注册表**不在本文件里**，而挂在 `state.ts` 的 globalThis 单例上（`chatRuns`）。
 *
 * 原因：`server/state-ws.ts`（tsx 加载）为了推 `activeRuns` 快照要读 run 表，而 run 是
 * **Route Handler（Turbopack 加载）** 建的 —— 两个加载器各有模块缓存，写成模块级
 * `Map` 会变成两份互不可见的实例，`listActiveRuns()` 永远返回空。详见 AGENTS.md 的
 * 「双加载器单例」。
 */
/** requestId → run */
const runs = chatRuns.runs
/** conversationId → requestId：abort 端点据此找「这个会话有没有在跑」 */
const activeByConversation = chatRuns.activeByConversation

/** 帧日志超过这个数就把相邻 delta 合并（回放等价、内存有界） */
const MAX_FRAMES = 4000
/** 跑完的 run 在表里多留一会儿：覆盖「刚好跑完时刷新」的竞态 */
const FINISHED_RETENTION_MS = 60_000

/**
 * 把相邻的 `text-delta` / `reasoning-delta` 合并成一条。
 *
 * 只合并**同类型且相邻**的：delta 是纯字符串拼接，合并后回放出来的 parts 完全一致；
 * 而 tool / confirm 帧天然稀疏，不会被合并也不会被打乱顺序。
 */
/** 帧日志压缩：合并相邻 delta / 同类增量。导出供测试直接验（合并等价性） */
export function compactFrames(frames: ChatStreamFrame[]): ChatStreamFrame[] {
  const out: ChatStreamFrame[] = []
  for (const frame of frames) {
    const prev = out[out.length - 1]
    const event = frame.event
    const prevEvent = prev?.event
    if (event?.type === 'text-delta' && prevEvent?.type === 'text-delta') {
      out[out.length - 1] = {
        ...(prev as ChatStreamFrame),
        event: { type: 'text-delta', delta: prevEvent.delta + event.delta }
      }
      continue
    }
    if (event?.type === 'reasoning-delta' && prevEvent?.type === 'reasoning-delta') {
      out[out.length - 1] = {
        ...(prev as ChatStreamFrame),
        event: { type: 'reasoning-delta', delta: prevEvent.delta + event.delta }
      }
      continue
    }
    // 工具入参增量：同一个 toolCallId 的相邻帧合并（拼接后回放出的文本完全一致）。
    // 写文件这类调用的增量帧是全场最密的（比正文还密），不合并会把帧日志撑爆。
    if (
      event?.type === 'tool-call-delta' &&
      prevEvent?.type === 'tool-call-delta' &&
      prevEvent.toolCallId === event.toolCallId
    ) {
      const toolName = prevEvent.toolName ?? event.toolName
      out[out.length - 1] = {
        ...(prev as ChatStreamFrame),
        event: {
          type: 'tool-call-delta',
          toolCallId: event.toolCallId,
          ...(toolName ? { toolName } : {}),
          inputTextDelta: prevEvent.inputTextDelta + event.inputTextDelta
        }
      }
      continue
    }
    // 工具输出增量（execute_command 实时输出）：同 toolCallId 同 stream 相邻合并。
    // 命令输出帧是全场最密的（stdout 每秒多帧），不合并把 4000 帧上限刷爆后
    // 回放会把更早的帧挤掉。合并后回放内容守恒（纯字符串拼接）。
    if (
      event?.type === 'tool-output-delta' &&
      prevEvent?.type === 'tool-output-delta' &&
      prevEvent.toolCallId === event.toolCallId &&
      prevEvent.stream === event.stream
    ) {
      out[out.length - 1] = {
        ...(prev as ChatStreamFrame),
        event: {
          type: 'tool-output-delta',
          toolCallId: event.toolCallId,
          stream: event.stream,
          delta: prevEvent.delta + event.delta
        }
      }
      continue
    }
    // 交接文档的流式增量：同 phase 且相邻时合并。摘要可能连续吐几千个 delta，
    // 不合并会把帧日志撑爆（4000 帧上限），回放时更早的事件就被挤掉。
    if (
      event?.type === 'context-compaction-delta' &&
      prevEvent?.type === 'context-compaction-delta' &&
      prevEvent.phase === event.phase
    ) {
      out[out.length - 1] = {
        ...(prev as ChatStreamFrame),
        event: {
          type: 'context-compaction-delta',
          phase: event.phase,
          delta: prevEvent.delta + event.delta
        }
      }
      continue
    }
    out.push(frame)
  }
  return out
}

/** 建一条 run 并登记：第 0 帧就是 `start`（客户端据此拿到 requestId） */
export function createRun(input: {
  conversationId: string
  workspaceId: string
  backend: 'builtin' | 'acp'
  acpTarget?: { agentId: string; conversationId: string }
  /** 这一轮助手消息的落盘 id（客户端给的；缺省收尾时自生成，见 ChatRun.assistantMessageId） */
  assistantMessageId?: string
  /** 起始的活权限档（缺省 confirm，与 chat-turn 的 `input.permissionMode ?? 'confirm'` 一致） */
  permissionMode?: AiPermissionMode
}): ChatRun {
  const requestId = randomUUID()
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const run: ChatRun = {
    requestId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    backend: input.backend,
    ...(input.acpTarget ? { acpTarget: input.acpTarget } : {}),
    ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
    controller: new AbortController(),
    steerInbox: [],
    commandStops: new Map(),
    permissionMode: input.permissionMode ?? 'confirm',
    frames: [{ type: 'start', requestId }],
    subscribers: new Set(),
    startedAt: Date.now(),
    done
  }
  runs.set(requestId, run)
  activeByConversation.set(input.conversationId, requestId)
  // 存 resolve 供 finishRun 用（挂在函数属性上，不进 ChatRun 公开形状）
  doneResolves.set(requestId, resolveDone)
  return run
}

/** requestId → finishRun 时要 resolve 的那个函数（见 createRun）—— 同样在全局单例里 */
const doneResolves = chatRuns.doneResolves

export function getRun(requestId: string): ChatRun | undefined {
  return runs.get(requestId)
}

/** 这个会话有没有正在跑的 run（已结束的不算） */
export function findActiveByConversation(conversationId: string): ChatRun | undefined {
  const requestId = activeByConversation.get(conversationId)
  if (!requestId) return undefined
  const run = runs.get(requestId)
  return run && run.finishedAt === undefined ? run : undefined
}

/**
 * 会话归档 / 删除前停掉正在跑的轮次，并等它**真正收尾**再返回。
 *
 * 为什么归档 / 删除也要停：run 只活在内存里，归档后可逆、删除则把落盘数据一起删掉；
 * 放着不管的话工具还在跑、命令进程还在占端口，收尾落盘又会因为「会话不存在」失败
 * （只留一行日志）。这里走与 `/api/chat/abort` 同一套收尾口径：ACP 先杀进程，
 * 再 abort signal 让已产生的半截正文落盘；超时兜底避免卡死的工具把请求吊住。
 *
 * @returns 停了一条返回 true；本来没在跑就是 no-op
 */
export async function stopConversationRun(
  conversationId: string,
  timeoutMs = 10_000
): Promise<boolean> {
  const run = findActiveByConversation(conversationId)
  if (!run) return false
  if (run.acpTarget) abortAcpTurn(run.acpTarget.agentId, run.acpTarget.conversationId)
  abortRun(run)
  await Promise.race([run.done, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
  return true
}

/**
 * 当前**所有**在跑的 run（摘要）。
 *
 * 用来给前端的运行态做对账：瞬时事件断线期间会丢（见 `@fizz/contracts/types` 的
 * `ServerEvent` 说明），这份清单是「权威现状」—— 状态 WS 的 `activeRuns` 快照就是它，
 * 客户端拿它把「谁在跑 / 谁跑完了」补齐。已结束的 run 不在其中。
 */
export function listActiveRuns(): ChatRunSummary[] {
  const out: ChatRunSummary[] = []
  for (const run of runs.values()) {
    if (run.finishedAt === undefined) out.push(summarize(run))
  }
  return out
}

/** 给「这个会话有没有活在跑」的查询端点用的摘要（`GET /api/chat/active`） */
export function summarize(run: ChatRun): ChatRunSummary {
  return {
    requestId: run.requestId,
    conversationId: run.conversationId,
    status: run.finishedAt === undefined ? 'running' : 'finished',
    startedAt: run.startedAt,
    ...(run.finishReason ? { finishReason: run.finishReason } : {}),
    ...(run.assistantMessageId ? { assistantMessageId: run.assistantMessageId } : {})
  }
}

/**
 * 订阅一条 run：**注册订阅者与取帧快照在同一个同步块里**完成。
 *
 * Node 是单线程，`emit` 插不进这两步之间，所以不会出现「快照里有、队列里也有」（重复渲染）
 * 或「两边都没有」（丢帧）。调用方拿到快照先回放，再消费 `sub.push` 推来的直播帧。
 *
 * 已经跑完的 run 直接 `close()` 订阅者：回放完就收场，不留一条永远等不到帧的流。
 */
export function attach(run: ChatRun, sub: ChatRunSubscriber): ChatStreamFrame[] {
  const snapshot = run.frames.slice()
  if (run.finishedAt !== undefined) {
    sub.close()
    return snapshot
  }
  run.subscribers.add(sub)
  return snapshot
}

/** 入帧日志 + 扇出给所有订阅者 */
export function emit(run: ChatRun, frame: ChatStreamFrame): void {
  if (run.finishedAt !== undefined) return
  run.frames.push(frame)
  if (run.frames.length > MAX_FRAMES) run.frames = compactFrames(run.frames)
  for (const sub of run.subscribers) sub.push(frame)
}

/** 收场：补一条 `end` 帧、广播、清订阅者、放行等待收尾的「停止」调用 */
export function finishRun(run: ChatRun, finishReason: string): void {
  if (run.finishedAt !== undefined) return
  // ⚠️ 必须走 `emit`（入日志 **且** 扇出）：只写 `run.frames` 再 `sub.close()` 的话，
  // 直播中的订阅者永远收不到 `end` —— 客户端会以为这条流是「断了」而不是「跑完了」，
  // 于是不落定终态、还留着一个转圈的输入框
  emit(run, { type: 'end', requestId: run.requestId, finishReason })
  run.finishReason = finishReason
  run.finishedAt = Date.now()
  if (activeByConversation.get(run.conversationId) === run.requestId) {
    activeByConversation.delete(run.conversationId)
  }
  for (const sub of [...run.subscribers]) sub.close()
  run.subscribers.clear()
  doneResolves.get(run.requestId)?.()
  doneResolves.delete(run.requestId)
  const timer = setTimeout(() => runs.delete(run.requestId), FINISHED_RETENTION_MS)
  // 别让这个定时器吊着进程（桌面端进程内直连时，退出会因为它在多活一分钟）
  ;(timer as { unref?: () => void }).unref?.()
}

/** 用户点「停止」：abort 这条 run 的 signal（挂起的审批 / 提问由路由侧解开） */
export function abortRun(run: ChatRun): void {
  /*
   * ⚠️ 先**主动**把每条在跑的命令停掉，再 abort。
   *
   * abort 走的是工具内部的 `abortSignal`，理论上会 `killChild`；但那条路依赖工具真的
   * 监听到信号（有的实现只在 `spawn` 前后检查一次），用户报过「整轮停止点了，`npx vite`
   * 还在跑、端口还占着」。`commandStops` 里存的是工具自己给的 stop（它会 kill 整棵进程树），
   * 直接调一遍最保险 —— 幂等，命令已经结束的会被工具自己忽略。
   */
  for (const stop of run.commandStops.values()) {
    try {
      stop()
    } catch {
      // 单条停止失败不该挡住整轮中止
    }
  }
  run.controller.abort()
}

/**
 * 进程退出前把**所有**还在跑的 run 中止掉。
 *
 * 为什么中止而不是放着不管：run 只在内存里，进程一死就全丢，而「这一轮已经产生的
 * 半截正文」是 chat-turn 挂在 `run.controller.signal` 上的 abort 监听器收尾时才落盘的
 * —— 不发 abort 就没有那次落盘，用户消息在、助手回复一个字都不在。
 *
 * 返回每条 run 的 `done`：调用方（退出钩子）等它们真正收尾完再 flush 存储、退出。
 * 卡住的 run 由调用方加超时兜底，别让退出无限期吊着。
 */
export function abortAllRuns(): Promise<void>[] {
  const pending: Promise<void>[] = []
  for (const run of runs.values()) {
    if (run.finishedAt !== undefined) continue
    abortRun(run)
    pending.push(run.done)
  }
  return pending
}
