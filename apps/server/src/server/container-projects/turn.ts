/**
 * 容器型项目的一轮对话（**宿主侧**）。
 *
 * 与本地一轮（`chat-turn.ts` 的 `startTurn`）的关系：**帧的形状、落盘、收尾完全一致**，
 * 差别只在「谁在跑 Agent」—— 容器型项目的工作区在容器里（宿主碰不到那些文件），所以
 * 宿主把这一轮交给容器内的 `agent-host.mjs`，自己只当**帧的中继**：
 *
 * - 宿主 → 容器：`POST /runs`（请求体带模型配置 / 历史 / 系统提示词 / 技能清单，响应是 SSE）；
 * - 容器 → 宿主：SSE 帧（事件帧 / 审批请求 / 追问请求 / 结束帧）逐帧**原样**交给
 *   `chat-turn` 那套 `emit`，进还是那条 `ChatStreamFrame` 通道 —— 前端一条链路都不用改；
 * - 宿主 → 容器：审批 / 追问的答复走 `POST /runs/:id/answer`，中止走 `POST /runs/:id/abort`。
 *
 * 因此这一条链路里**刻意没有**：ACP（容器里就是我们的 引擎 运行时）、浏览器工具、MCP、
 * 项目工具、客户端工具、子任务、运行中插话的**注入**（收件箱里的插话走收尾兜底起新一轮，
 * 见收尾链 —— 那与本地一轮的行为一致，不是特例）。
 *
 * ⚠️ 明文模型 `apiKey` 只经这条 `127.0.0.1` 回环请求进容器、只活在容器进程的内存里：
 * 不写进容器环境变量、不落容器磁盘、不进镜像（容器内不持久化任何密钥）。
 */
import { buildAgentSystemPrompt, readProjectDoc, type RunAgentResult } from '@fizz/agent'
import { CONTAINER_ENV_IMAGES, CONTAINER_PROTOCOL_VERSION } from '@fizz/contracts/types'
import type {
  AgentChatMessage,
  AgentConfirmInput,
  AgentStreamEvent,
  AiModelConfig,
  AiPermissionMode,
  AskFollowupAnswer,
  AskFollowupRequest,
  TurnUsage
} from '@fizz/contracts/types'
import type { ChatRequest } from '@fizz/contracts/agent-api'
import { domain, emitServerEvent, markDirty } from '../state'
import { createConfirmGate, DEFAULT_CONFIRM_TIMEOUT_MS } from '../confirm-gate'
import { createFollowupGate } from '../followup-gate'
import { createRun, emit, finishRun, type ChatRun } from '../chat-run'
import { errorPart, excerptOf, foldEventIntoParts } from '../agent-parts'
import {
  beginTurnUserMessage,
  drainSteerInbox,
  historyForTurn,
  persistAssistantMessage,
  type StartTurnResult
} from '../chat-turn'
import { describeError } from '../lib/http'
import { resolveUploadModelUrl } from '../upload/index'
import { ensureContainerAgentReady } from './lifecycle'
import { containerSkillList, type ContainerSkill } from './skills'

/** 工作区在容器里的挂载点（`docker run -v <项目目录>:/workspace`，不作环境变量传递） */
const CONTAINER_WORKSPACE_PATH = '/workspace'

// ---------- 宿主 ↔ 容器 的线上形状 ----------

/** `POST /runs` 的请求体（宿主 → 容器） */
interface ContainerRunBody {
  /** 运行时版本核对用（容器内 `CONTAINER_PROTOCOL_VERSION`，与宿主同一份常量） */
  protocolVersion: number
  /** 这一轮的 run id：答复 / 中止都按它寻址（盒子内同一时刻只认它） */
  runId: string
  /**
   * 会话 id —— 压缩检查点的复用键（`compactHistory` 按它记「摘要到哪条」）。
   *
   * 必须传：容器里 `runAgent` 跑的是同一套压缩，没有这个键就**每轮重新摘要一次**
   * （多一次模型调用，且摘要文本每轮都变 → 前缀缓存全废）。不能用 `runId` 顶替：
   * 它每轮都不一样。
   */
  conversationId: string
  model: AiModelConfig
  history: AgentChatMessage[]
  /** 宿主组装好的系统提示词（容器不重新拼：提示词是「服务端口径」，只有一份） */
  systemPrompt: string
  /** 容器视角的技能清单（`path` 已是容器内路径，容器据此建 `read_skill`） */
  skills: ContainerSkill[]
  permissionMode: AiPermissionMode
  /**
   * 上一轮在容器里落下的**压缩检查点**（宿主持久化过的那份），本轮带回去复用。
   *
   * 不传的代价：容器进程一重启（换镜像 / `docker restart`），容器内存里的
   * `autoSummaryCache` 就没了，这一轮会把**整段历史重新摘要一次** —— 多一次模型调用，
   * 摘要文本还会变（请求前缀跟着变，上游缓存全废）。
   *
   * `keepFromMessageId` 指向的 id 来自宿主上一轮发过去的 `history`（宿主原样带 id，
   * 不会重编），所以跨轮、跨进程都认得出是哪条消息。
   */
  autoSummarySeed?: { keepFromMessageId: string; text: string }
}

/** 容器内的一帧（容器 → 宿主，SSE 的 `data:` 行） */
type ContainerFrame =
  | { type: 'event'; event: AgentStreamEvent }
  | { type: 'confirm-request'; confirm: AgentConfirmInput & { id: string } }
  | { type: 'followup-request'; id: string; request: Omit<AskFollowupRequest, 'id'> }
  /**
   * 容器里刚落下了一份压缩检查点（`compactHistory` 的 `onAutoSummary`）。
   *
   * 容器碰不到宿主的存储，所以只能把它交回来 —— 宿主落盘后，下一轮再当
   * `autoSummarySeed` 送回去。没有这条，容器重启一次检查点就丢，整段历史重新摘要。
   */
  | { type: 'auto-summary'; entry: { keepFromMessageId: string; text: string } }
  | { type: 'done'; result: RunAgentResult }

/** 宿主回给容器的答复（`POST /runs/:id/answer`） */
type ContainerAnswer =
  | { kind: 'confirm'; id: string; approved: boolean }
  | { kind: 'followup'; id: string; answer: AskFollowupAnswer | null }

/** `/health` 的响应（版本核对就在这里：镜像与宿主的 `CONTAINER_PROTOCOL_VERSION` 必须相等） */
interface ContainerHealth {
  ok?: boolean
  protocolVersion?: number
  envId?: string
}

// ---------- 与容器 HTTP 打交道的三个动作 ----------

async function containerHealth(port: number): Promise<ContainerHealth | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return undefined
    return (await res.json()) as ContainerHealth
  } catch {
    return undefined
  }
}

/** 把一条答复送回容器（失败只记日志：容器可能已经停了，这一轮由流的中断收场） */
async function postAnswer(port: number, runId: string, body: ContainerAnswer): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/runs/${encodeURIComponent(runId)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    })
  } catch (err) {
    console.warn('[server] 容器内 Agent 的答复没送到（这一轮可能已经结束）：', err)
  }
}

/**
 * 中止容器里那一轮。
 *
 * ⚠️ 必须**主动打这个端点**，不能只靠「宿主这边不读流了」：容器里的 `runAgent` 正
 * `await` 在那次请求上，没有外部事件它不会自己醒（与 ACP 的中止同一个坑）。
 */
async function abortContainerRun(port: number, runId: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/runs/${encodeURIComponent(runId)}/abort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000)
    })
  } catch (err) {
    console.warn('[server] 中止容器内 Agent 的请求没送到：', err)
  }
}

/**
 * 停掉容器里正在跑的那条命令（工具卡上的停止钮）。
 *
 * 容器型的 `execute_command` 在容器里跑，宿主的 `run.commandStops` 杀不到它的进程 ——
 * 必须转发给容器的 `/runs/:id/command-stop`。旧镜像没有这个端点，会 404：只记日志，
 * 不影响这一轮（用户还可以用整轮停止兜底）。
 */
async function stopContainerCommand(port: number, runId: string, toolCallId: string): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/runs/${encodeURIComponent(runId)}/command-stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId }),
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) {
      console.warn(`[server] 容器内命令停止没生效（HTTP ${res.status}）：镜像可能还是旧版`)
    }
  } catch (err) {
    console.warn('[server] 停容器内命令的请求没送到：', err)
  }
}

// ---------- 读流 ----------

interface ContainerPumpContext {
  port: number
  runId: string
  run: ChatRun
  body: ContainerRunBody
  onEvent: (event: AgentStreamEvent) => void
  /** 容器发来的审批请求：宿主弹卡并答复（返回是否允许） */
  confirm: (req: AgentConfirmInput) => Promise<boolean>
  /** 容器发来的追问请求：宿主弹卡并答复（跳过 = `null`） */
  followup: (req: Omit<AskFollowupRequest, 'id'>) => Promise<AskFollowupAnswer | null>
}

/**
 * 起容器里那一轮并**读到结束**：返回 `RunAgentResult`（形状与本地一轮完全相同，
 * 收尾链因此可以逐句对齐 `chat-turn.ts`）。
 *
 * 三种收场都要能收住：
 * - 正常结束：收到 `done` 帧（其中的 `finishReason` 就是答案）；
 * - 用户点了停止：容器被 `/runs/:id/abort` 打断后同样会发 `done`（`aborted`）；
 * - 容器半路没了（被停 / 被换镜像 / 崩了）：流直接断，这里**抛错**让收尾链落成
 *   「这一轮失败」—— 绝不能静默挂住（那样一轮永远不会结束，界面一直转圈）。
 */
async function pumpContainerRun(ctx: ContainerPumpContext): Promise<RunAgentResult> {
  const { port, runId, run } = ctx
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ctx.body)
    })
  } catch (err) {
    throw new Error(`连不上容器内的 Agent（127.0.0.1:${port}）：${describeError(err).message}`)
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `容器内的 Agent 拒绝了这次请求（HTTP ${response.status}）${text ? `：${text.slice(0, 300)}` : ''}`
    )
  }

  let finished: RunAgentResult | undefined
  /**
   * 分派一帧。
   *
   * ⚠️ 审批 / 追问**不 await**：它们要等用户点，await 就把读流也停了；而挂起期间
   * 容器可能仍在发事件（模型一批并行工具调用）。答复晚一步送回容器完全没问题 ——
   * 容器那侧本来就是挂起等答复的。
   */
  const dispatch = (frame: ContainerFrame): void => {
    if (frame.type === 'event') {
      /**
       * 单条工具的「停止」入口：容器里的 `execute_command` / `web_fetch` 在容器内跑，
       * 宿主够不到它的进程 / 连接 —— 收到 `tool-call` 就在 `run.commandStops` 挂一个**转发器**，让
       * `POST /api/chat/command/stop` 与本地一轮走同一张表、同一个路由（不必新增契约）。
       * `tool-result` 到了就摘掉（命令已经结束，再点停止没有意义）。
       */
      if (
        frame.event.type === 'tool-call' &&
        (frame.event.toolName === 'bash' || frame.event.toolName === 'web_fetch')
      ) {
        const toolCallId = frame.event.toolCallId
        run.commandStops.set(toolCallId, () => {
          run.commandStops.delete(toolCallId)
          void stopContainerCommand(port, runId, toolCallId)
        })
      } else if (frame.event.type === 'tool-result') {
        run.commandStops.delete(frame.event.toolCallId)
      }
      ctx.onEvent(frame.event)
      return
    }
    if (frame.type === 'done') {
      finished = frame.result
      return
    }
    if (frame.type === 'auto-summary') {
      /**
       * 容器里刚落了检查点：立刻持久化到宿主（与本地一轮的 `onAutoSummary` 同一口径）。
       *
       * 顺带撤掉「下一轮强制补压」：固化点已经推进到模型实际看到的位置了。
       * 这里**不 await、不阻塞读流** —— 它只是记账，落盘失败也不该把这一轮带崩
       * （`setAutoSummary` 内部会 commit，异常往上抛的话流就读不下去了）。
       */
      try {
        domain.setAutoSummary(ctx.body.conversationId, { ...frame.entry, createdAt: Date.now() })
      } catch (err) {
        console.warn('[server] 容器里的压缩检查点落盘失败：', err)
      }
      return
    }
    if (frame.type === 'confirm-request') {
      void ctx
        .confirm(frame.confirm)
        .then((approved) => postAnswer(port, runId, { kind: 'confirm', id: frame.confirm.id, approved }))
      return
    }
    if (frame.type === 'followup-request') {
      void ctx
        .followup(frame.request)
        .then((answer) => postAnswer(port, runId, { kind: 'followup', id: frame.id, answer }))
      return
    }
    /**
     * 认不出来的帧：**必须显式落到这里**，不能靠「最后一条 else 就是追问」。
     * 新镜像 + 旧宿主时，新帧会落进下面这个分支；按追问处理会把
     * `frame.request` 当参数传进 followup 闸（undefined），轻则一条脏日志，重则把这一轮卡住。
     */
    console.warn('[server] 容器发来不认识的帧（已忽略）：', (frame as { type?: string }).type)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      // SSE 帧以空行分隔；容器侧一律写 `\n\n`，这里把 `\r\n` 收敛掉以免切错
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const chunk = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'))
        if (dataLine) {
          try {
            dispatch(JSON.parse(dataLine.slice(5).trim()) as ContainerFrame)
          } catch (err) {
            // 单帧解析失败只跳过：别让一帧脏数据把整轮对话带崩（同 listProjectContainers 的处理）
            console.warn('[server] 容器内的帧解析失败（已跳过）：', err)
          }
        }
        cut = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (finished) return finished
  if (run.controller.signal.aborted) return { finishReason: 'aborted' }
  throw new Error('容器内 Agent 的连接中断了（容器可能已停止或换了镜像），这一轮没有跑完')
}

// ---------- 组装这一轮发给容器的请求体 ----------

/**
 * 附件 URL 绝对化 —— 与本地一轮同一件事（`chat-turn` 把它交给 `runAgent` 的
 * `resolveFileUrl`），但这里必须**在发请求前就做完**：模型调用发生在容器里，
 * 容器拿到的 URL 得能直接取到（容器里没有 `resolveFileUrl` 这一层）。
 *
 * ⚠️ 已知边界：`FIZZ_PUBLIC_BASE_URL` 没配时拼出来的是宿主的 `origin`（一般是
 * `127.0.0.1:<port>`），而容器里的 `127.0.0.1` 指向容器自己 —— 那种配置下带图对话
 * 的图片取不到（不是静默丢图：模型会拿到一个取不到的地址）。配了公网地址就没问题。
 */
function absolutizeAttachments(history: AgentChatMessage[], origin: string): AgentChatMessage[] {
  return history.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'file' && part.url ? { ...part, url: resolveUploadModelUrl(part.url, origin) } : part
    )
  }))
}

// ---------- 一轮的入口 ----------

/**
 * 起一轮容器型项目的对话。
 *
 * 与 `startTurn` **同形状同签名**（`{ ok: true, run }` / `{ ok: false, status, message }`），
 * 调用方（`chat-turn.ts` 的分派点、插话收尾兜底的兜底轮）什么都不用区分。
 *
 * 分派点在 `startTurn` 的**用户消息落盘之前**，所以这里自己落（同一份
 * `beginTurnUserMessage`）—— 两边都落一遍就会重复追加一条用户消息。
 */
export async function startContainerTurn(
  input: ChatRequest,
  opts?: { origin?: string }
): Promise<StartTurnResult> {
  const conversation = domain.getConversation(input.conversationId)
  if (!conversation) return { ok: false, status: 404, message: '会话不存在' }

  /**
   * 顺序刻意与 `chat-turn` 一致：**先落用户消息、再给错误**。
   *
   * 错误（没选模型 / 容器起不来 / 版本不匹配）都落成**这一轮那条助手消息**，
   * 用户消息在它上面 —— 顺序反了的话界面上会出现「助手的报错跑在用户提问前面」。
   */
  const { userMessage, conversationTitle } = beginTurnUserMessage(input, conversation)
  const rejectTurn = (status: 400 | 404 | 500, message: string): StartTurnResult => {
    persistAssistantMessage(conversation.id, [errorPart(message)], undefined, input.assistantMessageId)
    return { ok: false, status, message }
  }

  const workspace = domain.getWorkspace(conversation.workspaceId)
  if (!workspace) return rejectTurn(404, '会话所属工作区不存在')
  if (!workspace.container) return rejectTurn(404, '这个会话的工作区不是容器型项目')

  /**
   * 容器里跑的是我们的 引擎 运行时，**没有 ACP 客户端** —— 会话却可能是在普通项目里
   * 建好、绑了 ACP agent 再切过来的。这种组合说清楚比默默按容器链路跑强。
   */
  const backend = input.backend ?? conversation.backend
  if (backend !== 'builtin') {
    return rejectTurn(
      400,
      backend === 'acp'
        ? '容器型项目只支持模型对话（不支持 ACP Agent），请在输入框上方选择模型'
        : '会话还没有选择模型，请在输入框上方选择后重新发送'
    )
  }

  // 严格解析（与本地一轮同口径）：配置 / 模型悬空直接报错让重选，不做静默回退
  const requestedConfigId = input.configId ?? conversation.configId
  const requestedModelId = input.modelId ?? conversation.modelId
  if (!requestedConfigId || !requestedModelId) {
    return rejectTurn(400, '会话还没有选择模型，请重新选择')
  }
  let modelConfig: AiModelConfig
  try {
    modelConfig = domain.resolveModelConfig(requestedConfigId, requestedModelId)
  } catch (err) {
    return rejectTurn(400, describeError(err).message)
  }

  const permissionMode = (input.permissionMode ?? 'confirm') as AiPermissionMode
  const confirmTimeoutMs =
    typeof input.confirmTimeoutMs === 'number' &&
    Number.isFinite(input.confirmTimeoutMs) &&
    input.confirmTimeoutMs >= 0
      ? input.confirmTimeoutMs
      : DEFAULT_CONFIRM_TIMEOUT_MS

  /**
   * 先建 run、再准备 —— 顺序与本地一轮相反，**故意的**。
   *
   * 准备阶段要跑 docker 探测 / 起容器 / 健康检查，慢的时候好几秒。若等准备完才建 run，
   * 这段时间前端拿不到 `requestId`（`start` 帧还没发出去），用户点「停止」只会断开本地
   * 连接 —— 服务端不知道有人要走，照样把这一轮跑完并落盘，用户过一会就看到消息
   * 「又冒出来」。先建 run 并**立刻返回**，`start` 帧马上回放给前端，停止才打得到
   * `/api/chat/abort`；准备阶段每个 await 之后也会问一句「用户还在吗」。
   */
  const run = createRun({
    conversationId: conversation.id,
    workspaceId: workspace.id,
    backend,
    // 起始活权限档：宿主侧的中继按它修正容器发来的审批（见下面 confirmFromContainer）
    permissionMode,
    ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {})
  })
  const requestId = run.requestId

  markDirty(['activeRuns'])
  emitServerEvent({
    type: 'conversation:started',
    conversationId: conversation.id,
    requestId,
    title: conversationTitle,
    startedAt: run.startedAt
  })

  /** 审批：容器里的闸按起跑时的档位裁决，宿主这里补一层「中途切档」（同 confirm-gate 的现取口径） */
  const gate = createConfirmGate({
    run,
    ownerKey: conversation.id,
    title: conversationTitle,
    confirmTimeoutMs,
    workspace: { id: workspace.id, name: workspace.name },
    ...(workspace.path ? { approvedCommandsPath: workspace.path } : {}),
    broadcast: (event) => emitServerEvent(event)
  })
  const confirmFromContainer = async (req: AgentConfirmInput): Promise<boolean> => {
    /**
     * 权限档**现取**：`POST /api/chat/permission` 在运行中改的就是 `run.permissionMode`。
     * 切到「完全访问」就不必再拿一张卡去烦用户；切到「只读」当场拒绝（容器那侧的快照
     * 可能还是宽的那一档，这一层是唯一能把它收窄的地方）。
     */
    const mode = run.permissionMode
    if (mode === 'full') return true
    if (mode === 'readonly') return false
    return gate.requestConfirm({
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      command: req.command
    })
  }

  const followupGate = createFollowupGate({
    run,
    conversationId: conversation.id,
    title: conversationTitle
  })

  const assistantParts: AgentChatMessage['parts'] = []
  let turnUsage: TurnUsage | undefined
  /** 没有 `usage` 时 finish 帧单独给的耗时（中止 / 出错的轮次）—— 见 onEvent */
  let turnDurationMs: number | undefined
  /** 收尾事件的 `error` 字段：准备阶段抛出来的、或容器自报的 */
  let runError: string | undefined
  /** 是否已经收过场：中止与跑流可能同时触发收尾，必须幂等 */
  let settled = false
  /** 容器那一轮是否已经起跑：之前的中止只需让准备阶段的检查点退出 */
  let pumpStarted = false

  /**
   * agent 改了文件 → 广播一次「该刷预览了」（前端 `PreviewPane` 订阅）。
   *
   * 为什么在服务端做：容器里的 agent 写的是 `/workspace`（bind mount），宿主侧能不能收到
   * 文件系统事件取决于 docker 的实现（Docker Desktop 上经常收不到），而工具结果是**必然**
   * 经过这条通道的 —— 拿它当信号最可靠。
   *
   * 合并同一轮里的连续写文件：一次改 5 个文件只刷一次（500ms 窗口）；轮次收尾时 flush，
   * 免得最后一批改动要等窗口结束才通知。
   */
  const FILE_WRITE_TOOLS = new Set(['write', 'edit'])
  let filesChangedTimer: ReturnType<typeof setTimeout> | undefined
  const flushFilesChanged = (): void => {
    if (!filesChangedTimer) return
    clearTimeout(filesChangedTimer)
    filesChangedTimer = undefined
    emitServerEvent({ type: 'container:files-changed', workspaceId: workspace.id })
  }
  const notifyFilesChanged = (): void => {
    if (filesChangedTimer) return
    filesChangedTimer = setTimeout(flushFilesChanged, 500)
  }

  const onEvent = (event: AgentStreamEvent): void => {
    if (event.type === 'finish' && event.usage) turnUsage = event.usage
    // 中止 / 出错的轮次常常一个 usage chunk 都没收到，耗时只有 finish 帧单独给的这一份
    // （有 usage 时它自带 `durationMs`，别重复）。缺了它折叠条抬头只能报「思考 ×N」计数
    if (event.type === 'finish' && !event.usage && event.durationMs != null) {
      turnDurationMs = event.durationMs
    }
    if (event.type === 'tool-result' && !event.isError && FILE_WRITE_TOOLS.has(event.toolName)) {
      notifyFilesChanged()
    }
    // 内容折叠与本地一轮同一个函数（聊天 / 助手 / 容器共用一份）：容器发来的事件形状
    // 就是 `AgentStreamEvent`，所以这边一行都不用转
    foldEventIntoParts(assistantParts, event)
    emit(run, { type: 'event', requestId, event })
  }

  /**
   * 收尾（准备阶段与跑流阶段共用，**幂等**）。
   *
   * 逐句对齐 `chat-turn.ts` 的本地一轮（帧的先后顺序是被用户看见过的行为：插话兜底的
   * 广播必须在 `finishRun` 之前、`conversation:finished` 必须在 `finishRun` 之后）。
   * 改这里时请把两边一起看。
   */
  const settleTurn = (finishReason: string): void => {
    if (settled) return
    settled = true
    // 收尾时把还没到点的「文件变了」立刻发出去（用户不该为了最后一次改动再等 500ms）
    flushFilesChanged()
    gate.releaseAll()
    followupGate.releaseAll()
    run.commandStops.clear()
    if (!run.controller.signal.aborted && run.steerInbox.length) {
      if (finishReason === 'error') {
        // 与本地一轮同语义：失败后不自动跑，逐条落成普通 user 消息并广播，用户可编辑重发
        while (run.steerInbox.length) {
          const msg = run.steerInbox.shift()
          if (!msg) break
          try {
            domain.appendMessages(conversation.id, [msg])
          } catch (err) {
            console.error('[server] 插话兜底落盘失败：', err)
          }
          emit(run, { type: 'event', requestId, event: { type: 'user-injected', message: msg } })
        }
      } else {
        for (const msg of run.steerInbox) {
          emit(run, { type: 'event', requestId, event: { type: 'user-injected', message: msg } })
        }
      }
    }
    finishRun(run, finishReason)
    markDirty(['activeRuns'])
    const excerpt = excerptOf(assistantParts)
    emitServerEvent({
      type: 'conversation:finished',
      conversationId: conversation.id,
      requestId,
      title: conversationTitle,
      finishReason,
      ...(runError ? { error: runError } : {}),
      ...(excerpt ? { excerpt } : {}),
      finishedAt: Date.now()
    })
    if (finishReason !== 'error' && finishReason !== 'aborted') {
      drainSteerInbox(run, conversation, permissionMode).catch((err: unknown) =>
        console.error('[server] 插话兜底异常：', err)
      )
    }
  }

  /**
   * 中止：
   * - 容器已经起跑 → **主动打容器的 abort 端点**（不能只靠不读流，见 `abortContainerRun` 的说明）；
   * - 还在准备阶段 → 直接收场，用户不该盯着一个已经没意义的转圈等 docker 探测跑完。
   */
  let abortContainer: (() => void) | undefined
  run.controller.signal.addEventListener('abort', () => {
    abortContainer?.()
    gate.releaseAll()
    followupGate.releaseAll()
    // 用户点了停止：意图是终止 —— 剩余插话一律丢弃（收尾链的兜底也会因 aborted 跳过）
    run.steerInbox.length = 0
    if (!pumpStarted) settleTurn('aborted')
  })

  /** 准备阶段每一步之后都问一句「用户还在吗」：点了停止就别再起容器 / 别再发请求 */
  const stopped = (): boolean => run.controller.signal.aborted

  void (async () => {
    try {
      /**
       * 容器必须真的在跑：起它（幂等）并**现读** agent 控制面的宿主端口。
       *
       * ⚠️ 放在技能清单**之前**：这个容器到底挂了哪些技能目录（`skillMounts`）只有这一趟
       * 知道 —— 清单要按它裁剪，否则会把 `/fizz-skills/...` 发给一个根本没挂那些目录的老
       * 容器，模型照着路径读只会拿到 ENOENT。
       */
      const ready = await ensureContainerAgentReady(workspace.id)
      /**
       * 起容器这一步本身取消不了（docker 命令跑完才返回），但**跑完立刻收场**：
       * 容器起来不是坏事（下一轮还要用），只是这一轮不该再往下走。
       */
      if (stopped()) return settleTurn('aborted')
      if ('reason' in ready) throw new Error(`容器型项目没能启动：${ready.reason}`)
      /**
       * `/health` 已经由 `doStart` 的 `waitHealth` 探过（同一个响应体把 `protocolVersion`
       * 带回来了）：容器在跑的快路上不再多发一次往返 —— 只有拿不到时才补一次。
       */
      const health = ready.health ?? (await containerHealth(ready.port))
      if (!health) {
        throw new Error(
          '容器里的 Agent 没有响应 /health（可能还在启动，也可能镜像不对），稍后再试'
        )
      }
      if (health.protocolVersion !== CONTAINER_PROTOCOL_VERSION) {
        throw new Error(
          `容器内运行时版本不匹配（容器 ${health.protocolVersion ?? '未知'} / 宿主 ${CONTAINER_PROTOCOL_VERSION}）：请在项目里换一次镜像重建容器`
        )
      }
      if (stopped()) return settleTurn('aborted')

      /**
       * 技能清单**只含容器里真读得到的来源**（镜像内置 / 项目内 / 已挂载的用户级与
       * `~/.agents/skills`），路径已改写成容器内路径；混进别的来源会在 `containerSkillList`
       * 里当场抛错 —— 这里接住并当成这一轮的失败：宁可不跑这一轮，也不能让容器里的模型
       * 拿到一条「读不到文件」的清单。
       */
      const skills: ContainerSkill[] = await containerSkillList(workspace.id, ready.skillMounts)
      if (stopped()) return settleTurn('aborted')

      // 提示词由**宿主**组装（服务端只有这一份口径）：容器里跑的就是它，不再另拼一份。
      // `browser: false` —— 容器内工具白名单里刻意没有 browser_*，提示词也不该提。
      const projectDoc = await readProjectDoc(workspace.path)
      if (stopped()) return settleTurn('aborted')
      const systemPrompt = buildAgentSystemPrompt(
        CONTAINER_WORKSPACE_PATH,
        workspace.name,
        skills.map((skill) => ({
          id: skill.path,
          name: skill.name,
          description: skill.description,
          dir: skill.path.slice(0, skill.path.lastIndexOf('/')),
          file: skill.path
        })),
        projectDoc,
        false,
        // 容器内预览端口：**只有这里能把「该监听哪个端口、该绑哪个地址」告诉容器里的模型**
        // （宿主端口是动态分配的、进不了容器）。不传的话模型只会自己挑一个顺眼的端口，
        // 用户填的预览端口就废了、页面空白且不报错 —— 见 `buildPreviewPortSection`。
        workspace.container?.previewPort,
        // 容器型项目才有「启动脚本」入口（`.fizz/container/start.mjs`）：不告诉模型这个约定，
        // 它只会去改 package.json 或让用户手动起服务 —— 见 `buildContainerStartSection`
        true,
        // 镜像自带自动启动（目前只有 Web 栈镜像）：要明确告诉模型「别写启动脚本」，否则它会
        // 好心写一个，反而把镜像的自动启动顶掉（bootstrap 里两者互斥）
        CONTAINER_ENV_IMAGES.find((image) => image.id === workspace.container?.image)?.autoStart
      )

      // 容器确定在跑：从现在起「停止」要主动打容器的 abort 端点
      abortContainer = () => void abortContainerRun(ready.port, requestId)

      pumpStarted = true
      const result = await pumpContainerRun({
        port: ready.port,
        runId: requestId,
        run,
        body: {
          protocolVersion: CONTAINER_PROTOCOL_VERSION,
          runId: requestId,
          conversationId: conversation.id,
          model: modelConfig,
          history: absolutizeAttachments(
            historyForTurn(conversation, userMessage),
            opts?.origin ?? ''
          ),
          systemPrompt,
          skills,
          permissionMode,
          /**
           * 上一轮容器落下的检查点：带回去复用，容器重启后不必整段重摘要
           * （`compactHistory` 的 `seed`，与本地一轮的 `autoSummarySeed` 同一个东西）。
           */
          ...(conversation.autoSummary
            ? {
                autoSummarySeed: {
                  keepFromMessageId: conversation.autoSummary.keepFromMessageId,
                  text: conversation.autoSummary.text
                }
              }
            : {})
        },
        onEvent,
        confirm: confirmFromContainer,
        followup: followupGate.requestFollowup
      })

      persistAssistantMessage(
        conversation.id,
        assistantParts,
        turnUsage,
        input.assistantMessageId,
        turnDurationMs
      )
      if (result.finishReason === 'error' && result.error) {
        console.error('[server] 容器里这一轮出错：', result.error)
      }
      runError = result.error
      settleTurn(result.finishReason)
    } catch (err: unknown) {
      // 用户在准备阶段点了停止：这不是失败，别再往会话里塞一条错误消息
      if (stopped()) return settleTurn('aborted')
      const message = describeError(err).message
      console.error('[server] 容器里这一轮失败：', err)
      persistAssistantMessage(conversation.id, [errorPart(message)], undefined, input.assistantMessageId)
      emit(run, { type: 'event', requestId, event: { type: 'error', message } })
      runError = message
      settleTurn('error')
    }
  })()

  return { ok: true, run }
}
