/**
 * 多智能体协作（collab）的运行时编排器。
 *
 * 模型与旧的「画布 + 主智能体派活」完全不同：
 * - **没有画布、没有主智能体**：所有 Agent 平级挂在同一条共享会话上；
 * - **用户点名**：消息里 `@某 Agent` 时只跑被点名的；`@` 多个就跑多个；
 * - **广播**：没有 `@` 时全体 Agent 各跑一次，自己判断是否接手（无关则调用
 *   `skip_turn` 静默跳过），只有接下的人才会在会话时间线里留下回复；
 * - **协同**：Agent 之间用 `SendMessage` 投递消息（不等待），接收方在本轮空闲时
 *   继续跑一次并把自己的回复写回共享时间线；
 * - **同进程、同工作区**：每个 Agent 都是 `runAgent({ setup })`，共享工作区 / 审批通道 /
 *   命令停止表；回复由调用方按 `agentId` / `agentName` 落进 `conversation.json`。
 *
 * 状态旁路：任务 / 消息 / 实时状态仍通过 `collab-*` 流事件推给前端（名单面板用），
 * 但不写进主消息。
 */
import { randomUUID } from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'
import type {
  AgentChatMessage,
  AgentConfirmInput,
  AgentConversation,
  AgentMessagePart,
  AgentStreamEvent,
  AgentWorkspace,
  AiModelConfig,
  AiPermissionMode,
  CollabAgentConfig,
  CollabAgentRuntime,
  CollabAgentStatus,
  CollabMessage,
  CollabSettings,
  CollabState,
  CollabTask,
  TurnUsage
} from '@fizz/contracts/types'
import { DEFAULT_COLLAB_SETTINGS, normalizeCollabSettings } from '@fizz/contracts/types'
import type { SkillInfo } from '@fizz/skills'
import { buildAgentSetup, runAgent, type RunAgentResult } from './agent'
import { resolveCollabMentions } from './collab-mentions'
import { appendPartDelta, appendToolCall, foldToolResult, trimCollabParts } from './collab-parts'
import { pickCollabTools } from './collab-tools'
import type { ProjectDoc } from './project-doc'

export interface CollabRuntimeOptions {
  conversation: AgentConversation
  workspace: AgentWorkspace
  skills: SkillInfo[]
  projectDoc?: ProjectDoc | null
  /** 会话模型（Agent 没单独配模型时回退到它） */
  mainModel: AiModelConfig
  /** 按配置解析 Agent 的模型；解析失败 / 配置已删 = null（回退会话模型） */
  resolveModel: (configId?: string, modelId?: string) => AiModelConfig | null
  /** 历史运行态（`collab.json`）；刷新 / 重启后用来恢复名单状态 */
  initialState?: CollabState | null
  getPermissionMode?: () => AiPermissionMode
  requestConfirm?: (req: AgentConfirmInput) => Promise<boolean>
  commandStops?: Map<string, () => void>
  /** 主 run 的中止信号：触发后所有 Agent 一起停 */
  signal?: AbortSignal
  /** 流事件出口（服务端 SSE） */
  emit: (event: AgentStreamEvent) => void
  /** 运行态变化（服务端节流写 `collab.json`） */
  onState?: (state: CollabState) => void
}

/** 一个 Agent 在本次用户轮里产出的回复（由 chat-turn 落进会话时间线） */
export interface CollabReply {
  agentId: string
  agentName: string
  parts: AgentMessagePart[]
  text: string
  createdAt: number
  usage?: TurnUsage
}

export interface CollabTurnResult {
  replies: CollabReply[]
  /** 广播里静默跳过 / 没有产出的人数 */
  skipped: number
  errors: Array<{ agentId: string; agentName: string; error: string }>
  usage?: TurnUsage
}

const TASK_OUTPUT_LIMIT = 24_000

function textOf(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const safe = text || ''
  return safe.length > limit ? `${safe.slice(0, limit)}\n…（已截断）` : safe
}

function statusIsActive(status: CollabAgentStatus): boolean {
  return status === 'running' || status === 'queued' || status === 'waiting'
}

/** Agent 空闲看门狗：多久没有任何事件就取消该次运行（0 = 关闭） */
function idleTimeoutMs(): number {
  const raw = process.env.FIZZ_COLLAB_AGENT_IDLE_TIMEOUT_MS?.trim()
  const parsed = raw ? Number(raw) : NaN
  if (Number.isFinite(parsed) && parsed >= 0) return parsed
  return 120_000
}

interface TaskRun {
  task: CollabTask
  controller: AbortController
}

/** 收件箱里的一条待投递消息（`SendMessage` 产生） */
interface InboxItem {
  from: string
  text: string
}

function textOfParts(parts: readonly AgentMessagePart[]): string {
  return parts
    .filter((part): part is Extract<AgentMessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/**
 * 把**共享会话历史**转换成某个 Agent 看到的模型历史。
 *
 * 其他 Agent 的回复对当前 Agent 只保留正文（`【名字】` 前缀），不传它们的工具调用 /
 * 工具结果 —— 那些 part 引用的工具可能不在当前 Agent 的工具集里，原样塞进去会让
 * `toModelMessages` 生成悬空的 tool 消息。自己的历史保留原样，方便它接着上一轮做事。
 */
function historyForAgent(history: readonly AgentChatMessage[], selfId: string): AgentChatMessage[] {
  const out: AgentChatMessage[] = []
  for (const message of history) {
    if (message.role === 'user') {
      out.push(message)
      continue
    }
    if (message.role !== 'assistant') continue
    if (message.agentId === selfId) {
      if (message.parts.length > 0) out.push(message)
      continue
    }
    const text = textOfParts(message.parts).trim()
    if (!text) continue
    const name = message.agentName?.trim() || '其他 Agent'
    out.push({
      id: message.id,
      role: 'assistant',
      parts: [{ type: 'text', text: `【${name}】\n${text}` }],
      createdAt: message.createdAt
    })
  }
  return out
}

export class CollabRuntime {
  readonly settings: CollabSettings
  private readonly opts: CollabRuntimeOptions
  private readonly tasks = new Map<string, CollabTask>()
  private readonly messages: CollabMessage[] = []
  private readonly statuses: Record<string, CollabAgentRuntime> = {}
  private readonly active = new Map<string, TaskRun>()
  private readonly runningByAgent = new Map<string, string>()
  private readonly queued: Array<() => void> = []
  private readonly inbox = new Map<string, InboxItem[]>()
  private turnHistory: AgentChatMessage[] = []
  private replies: CollabReply[] = []
  private errors: CollabTurnResult['errors'] = []
  private skipped = 0
  private tasksThisTurn = 0
  private turnStartedAt = 0
  private closed = false
  private persistTimer: NodeJS.Timeout | null = null

  constructor(opts: CollabRuntimeOptions) {
    this.opts = opts
    this.settings = normalizeCollabSettings(opts.conversation.collab ?? DEFAULT_COLLAB_SETTINGS)
    const initial = opts.initialState
    if (initial) {
      for (const task of initial.tasks) this.tasks.set(task.id, task)
      this.messages.push(...initial.messages)
      Object.assign(this.statuses, initial.statuses)
    }
    for (const agent of this.settings.agents) {
      if (!this.statuses[agent.id]) {
        this.statuses[agent.id] = { status: 'idle', updatedAt: Date.now() }
      } else if (statusIsActive(this.statuses[agent.id]!.status)) {
        this.statuses[agent.id] = { status: 'idle', updatedAt: Date.now() }
      }
    }
    if (opts.signal) {
      if (opts.signal.aborted) this.close()
      else opts.signal.addEventListener('abort', () => this.close(), { once: true })
    }
  }

  /** 当前快照（写盘 / GET 用；不含 liveText，避免把流式半截写进磁盘） */
  snapshot(): CollabState {
    const statuses: Record<string, CollabAgentRuntime> = {}
    for (const [id, status] of Object.entries(this.statuses)) {
      const { liveText: _liveText, ...rest } = status
      statuses[id] = rest
    }
    return {
      version: 1,
      tasks: [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200),
      messages: this.messages.slice(-500),
      statuses,
      updatedAt: Date.now()
    }
  }

  /** 取消单个任务（前端 / 工具共用） */
  cancelTask(taskId: string): boolean {
    const run = this.active.get(taskId)
    if (!run) return false
    run.controller.abort()
    this.finishTask(run.task, 'cancelled', undefined, '已取消')
    return true
  }

  /** 主轮结束 / 外部中止：停掉全部 Agent 并落一次快照 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const run of this.active.values()) run.controller.abort()
    for (const wake of this.queued.splice(0)) wake()
    for (const agent of this.settings.agents) {
      this.statuses[agent.id] = { status: 'idle', updatedAt: Date.now() }
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.opts.onState?.(this.snapshot())
  }

  /**
   * 跑一轮用户消息。
   *
   * `history` 必须已经包含这条用户消息（与主对话构建模型历史的规则一致）。
   * 返回的回复由调用方落盘，本类不直接写 `conversation.json`。
   */
  async runTurn(input: { history: AgentChatMessage[]; text: string }): Promise<CollabTurnResult> {
    this.turnHistory = [...input.history]
    this.replies = []
    this.errors = []
    this.skipped = 0
    this.tasksThisTurn = 0
    this.inbox.clear()
    this.turnStartedAt = Date.now()

    if (this.closed) return this.collectResult()
    const agents = this.settings.agents
    if (agents.length === 0) return this.collectResult()

    const mentioned = resolveCollabMentions(input.text, agents)
    const broadcast = mentioned.length === 0
    const participants = broadcast ? agents : mentioned

    await Promise.all(participants.map((agent) => this.startTask(agent, input.text, 'user', broadcast)))

    // SendMessage 是「投递不等待」：一轮初始运行结束后再把收件箱里的消息交给接收方
    // 继续跑；接收方也可能再发消息，循环到队列空或达到本轮预算。
    let guard = 0
    while (!this.closed && this.inbox.size > 0 && guard < 8) {
      guard += 1
      const batch = this.drainInbox()
      const tasks: Array<Promise<CollabTask>> = []
      for (const item of batch) {
        const target = item.agent
        const text = item.messages
          .map((msg) => {
            const sender = this.agentName(msg.from)
            return `【来自「${sender}」的消息】\n${msg.text}`
          })
          .join('\n\n')
        this.turnHistory.push({
          id: `collab-message-${randomUUID().slice(0, 8)}`,
          role: 'user',
          parts: [{ type: 'text', text }],
          createdAt: Date.now()
        })
        tasks.push(this.startTask(target, text, item.messages[0]?.from ?? 'user', false))
      }
      await Promise.all(tasks)
    }

    return this.collectResult()
  }

  private collectResult(): CollabTurnResult {
    const usage = this.replies.reduce(
      (total, reply) => {
        if (!reply.usage) return total
        return {
          inputTokens: total.inputTokens + reply.usage.inputTokens,
          outputTokens: total.outputTokens + reply.usage.outputTokens,
          totalTokens: total.totalTokens + reply.usage.totalTokens
        }
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    )
    const hasUsage = this.replies.some((reply) => reply.usage)
    const durationMs = Math.max(0, Date.now() - this.turnStartedAt)
    return {
      replies: [...this.replies].sort((a, b) => a.createdAt - b.createdAt),
      skipped: this.skipped,
      errors: [...this.errors],
      ...(hasUsage
        ? {
            usage: {
              ...usage,
              durationMs,
              tps: durationMs > 0 ? usage.outputTokens / (durationMs / 1000) : 0
            }
          }
        : {})
    }
  }

  private startTask(
    agent: CollabAgentConfig,
    prompt: string,
    from: string,
    broadcast: boolean
  ): Promise<CollabTask> {
    if (this.closed) {
      return Promise.resolve(this.finishTask(this.makeTask(agent, prompt, from), 'cancelled', undefined, '已取消'))
    }
    if (this.tasksThisTurn >= this.settings.maxTasksPerTurn) {
      this.addMessage({
        from,
        to: agent.id,
        kind: 'system',
        text: `本轮协作运行次数已达上限 ${this.settings.maxTasksPerTurn}，这条消息没有交给「${agent.name}」。`
      })
      const task = this.makeTask(agent, prompt, from)
      return Promise.resolve(this.finishTask(task, 'cancelled', undefined, '本轮协作次数已达上限'))
    }
    this.tasksThisTurn += 1
    const task = this.makeTask(agent, prompt, from)
    this.tasks.set(task.id, task)
    const controller = new AbortController()
    this.active.set(task.id, { task, controller })
    this.emitTask(task)
    this.addMessage({
      from,
      to: agent.id,
      kind: from === 'user' ? 'delegate' : 'ask',
      text: textOf(prompt, 4000),
      taskId: task.id
    })
    return this.runExclusive(agent.id, task.id, () =>
      this.runTask(agent, task, controller, broadcast)
    )
  }

  private makeTask(agent: CollabAgentConfig, prompt: string, from: string): CollabTask {
    return {
      id: `task-${randomUUID().slice(0, 8)}`,
      agentId: agent.id,
      agentName: agent.name,
      from,
      prompt,
      status: 'queued',
      createdAt: Date.now()
    }
  }

  private async runExclusive(
    agentId: string,
    taskId: string,
    run: () => Promise<CollabTask>
  ): Promise<CollabTask> {
    if (this.closed) {
      const task = this.active.get(taskId)?.task
      if (task) return this.finishTask(task, 'cancelled', undefined, '已取消')
    }
    // 并行上限：按「正在跑的任务数」而不是排队数限流
    while (this.activeRunning() >= this.settings.maxParallel && !this.closed) {
      await new Promise<void>((resolve) => this.queued.push(resolve))
    }
    if (this.closed) {
      const task = this.active.get(taskId)?.task
      if (task) return this.finishTask(task, 'cancelled', undefined, '已取消')
    }
    this.runningByAgent.set(agentId, 'running')
    try {
      return await run()
    } finally {
      this.runningByAgent.delete(agentId)
      const next = this.queued.shift()
      if (next) next()
    }
  }

  private activeRunning(): number {
    return [...this.tasks.values()].filter((t) => t.status === 'running').length
  }

  private async runTask(
    agent: CollabAgentConfig,
    task: CollabTask,
    controller: AbortController,
    broadcast: boolean
  ): Promise<CollabTask> {
    if (this.closed || controller.signal.aborted) {
      return this.finishTask(task, 'cancelled', undefined, '已取消')
    }
    task.status = 'running'
    task.startedAt = Date.now()
    this.emitTask(task)
    this.setStatus(agent.id, { status: 'running', taskId: task.id, startedAt: Date.now() })

    let text = ''
    let reasoning = ''
    let error: string | undefined
    let usage: CollabReply['usage']
    let lastEventAt = Date.now()
    let steps = 0
    let skipped = false
    const maxSteps = agent.maxSteps ?? 12
    const parts: AgentMessagePart[] = []

    const settle = (current: CollabTask): CollabTask =>
      parts.length ? { ...current, parts: trimCollabParts(parts) } : current

    const onEvent = (event: AgentStreamEvent): void => {
      lastEventAt = Date.now()
      switch (event.type) {
        case 'text-delta':
          text += event.delta
          appendPartDelta(parts, 'text', event.delta)
          this.opts.emit({
            type: 'collab-delta',
            agentId: agent.id,
            taskId: task.id,
            channel: 'text',
            delta: event.delta
          })
          break
        case 'reasoning-delta':
          reasoning += event.delta
          appendPartDelta(parts, 'reasoning', event.delta)
          this.opts.emit({
            type: 'collab-delta',
            agentId: agent.id,
            taskId: task.id,
            channel: 'reasoning',
            delta: event.delta
          })
          break
        case 'tool-call':
          steps += 1
          appendToolCall(parts, event)
          this.setStatus(agent.id, {
            status: 'running',
            taskId: task.id,
            toolName: event.toolName,
            step: steps
          })
          this.opts.emit({
            type: 'collab-tool',
            agentId: agent.id,
            taskId: task.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: 'start',
            label: textOf(event.input, 300),
            input: textOf(event.input, 600)
          })
          break
        case 'tool-result':
          foldToolResult(parts, event)
          this.setStatus(agent.id, { status: 'running', taskId: task.id, step: steps })
          this.opts.emit({
            type: 'collab-tool',
            agentId: agent.id,
            taskId: task.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: 'end',
            ok: !event.isError,
            label: textOf(event.output, 300),
            output: textOf(event.output, 600)
          })
          break
        case 'error':
          error = event.message
          break
        case 'finish':
          if (event.usage) usage = event.usage
          break
        default:
          break
      }
    }

    const model = this.modelFor(agent)
    if (!model) {
      const failed = this.finishTask(task, 'error', undefined, '没有可用的模型配置')
      this.errors.push({ agentId: agent.id, agentName: agent.name, error: '没有可用的模型配置' })
      return failed
    }

    const partners = this.settings.agents
      .filter((a) => a.id !== agent.id)
      .map((a) => `- ${a.name}（id: ${a.id}）：${a.role || '通用协作助手'}`)
      .join('\n')

    const extraTools: Record<string, unknown> = {
      SendMessage: tool({
        description:
          '给另一位 Agent 投递一条消息（不等待回复）。对方会在本轮空闲时处理，并把结果写回共享会话；' +
          '需要跨 Agent 协作、交接上下文或请对方补充判断时使用。',
        inputSchema: z.object({
          to: z.string().describe('接收方：Agent 名字或 id（可先看系统提示词里的伙伴名单）'),
          message: z.string().describe('要投递的内容：目标、需要对方做什么、相关上下文')
        }),
        execute: async ({ to, message }) => {
          const target = this.resolveAgent(to)
          if (!target) {
            const names = this.settings.agents.map((a) => a.name).join('、')
            return `没有找到 Agent「${to}」。可用：${names || '（当前还没有配置 Agent）'}`
          }
          if (target.id === agent.id) return '不能给自己发消息。'
          if (this.closed) return '本轮协作已结束，消息没有投递。'
          if (this.tasksThisTurn >= this.settings.maxTasksPerTurn) {
            return `本轮协作运行次数已达上限 ${this.settings.maxTasksPerTurn}，消息没有投递。`
          }
          const queue = this.inbox.get(target.id) ?? []
          queue.push({ from: agent.id, text: message })
          this.inbox.set(target.id, queue)
          this.addMessage({ from: agent.id, to: target.id, kind: 'ask', text: textOf(message, 4000) })
          return `已投递给「${target.name}」；它会在本轮空闲时处理。`
        }
      })
    }
    if (broadcast) {
      extraTools.skip_turn = tool({
        description:
          '这条用户消息是广播给全体 Agent 的。判断它与你无关时调用本工具并立即结束，' +
          '不要输出解释或寒暄；只有确实需要你处理时才正常回复。',
        inputSchema: z.object({}),
        execute: async () => {
          skipped = true
          return '已跳过这条消息，无需再输出。'
        }
      })
    }

    const requestConfirm = this.opts.requestConfirm
      ? async (req: AgentConfirmInput) => {
          this.setStatus(agent.id, { status: 'waiting', taskId: task.id })
          try {
            return await this.opts.requestConfirm!({
              ...req,
              agentId: agent.id,
              agentName: agent.name
            })
          } finally {
            this.setStatus(agent.id, { status: 'running', taskId: task.id })
          }
        }
      : undefined

    const setup = buildAgentSetup({
      workspace: this.opts.workspace,
      skills: this.opts.skills,
      projectDoc: this.opts.projectDoc ?? null,
      permissionMode: agent.permissionMode,
      ...(requestConfirm ? { requestConfirm } : {}),
      ...(this.opts.commandStops ? { commandStops: this.opts.commandStops } : {}),
      onEvent,
      extraTools
    })

    const mode = broadcast
      ? '用户没有 @ 任何 Agent，这条消息被广播给全体 Agent。先判断它是否与你的职责相关：' +
        '无关就立即调用 `skip_turn` 并结束，不要输出解释；相关就直接处理。'
      : '用户点名了你（可能同时点名了其他 Agent）。只处理与你职责相关的部分；' +
        '需要别人配合时用 `SendMessage` 给对方投递消息。'
    setup.instructions = [
      setup.instructions,
      '## 你的角色（多智能体协作）',
      `你是「${agent.name}」。${agent.role ? `职责：${agent.role}。` : ''}`,
      agent.instructions || '只做与当前消息相关的工作，不要擅自扩大范围。',
      mode,
      '',
      '你们共同挂在同一条会话时间线里：其他 Agent 的发言会以「【名字】」开头出现在历史里。',
      '你的回复会直接显示给用户，请给出结论、证据与必要的文件 / 行号引用；不要寒暄，不要复述任务。',
      partners ? `\n可协作的伙伴：\n${partners}` : '\n当前没有其他可协作的 Agent。'
    ].join('\n')
    setup.tools = pickCollabTools(setup.tools, [...agent.tools, ...Object.keys(extraTools)])

    const history = historyForAgent(this.turnHistory, agent.id)

    const idle = idleTimeoutMs()
    let watchdog: NodeJS.Timeout | null = null
    if (idle > 0) {
      watchdog = setInterval(() => {
        if (Date.now() - lastEventAt > idle && !controller.signal.aborted) {
          error = `Agent 超过 ${Math.round(idle / 1000)} 秒没有任何输出，已中止`
          controller.abort()
        }
      }, Math.min(5000, Math.max(1000, Math.floor(idle / 4))))
    }

    let result: RunAgentResult | undefined
    try {
      result = await runAgent({
        workspace: this.opts.workspace,
        history,
        model,
        skills: this.opts.skills,
        projectDoc: this.opts.projectDoc ?? null,
        permissionMode: agent.permissionMode,
        ...(requestConfirm ? { requestConfirm } : {}),
        ...(this.opts.commandStops ? { commandStops: this.opts.commandStops } : {}),
        setup,
        onEvent,
        signal: controller.signal,
        maxSteps
      })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      if (watchdog) clearInterval(watchdog)
      setup.ctx?.dispose()
    }

    if (this.closed) return this.finishTask(settle(task), 'cancelled', undefined, '已取消')
    if (result?.finishReason === 'aborted') {
      return this.finishTask(settle(task), 'cancelled', text, '已取消')
    }
    if (result?.finishReason === 'error' || error || result?.error) {
      const message = error ?? result?.error ?? 'Agent 运行失败'
      this.errors.push({ agentId: agent.id, agentName: agent.name, error: message })
      return this.finishTask(settle(task), 'error', text, message)
    }
    if (skipped) {
      this.skipped += 1
      return this.finishTask(settle(task), 'done', '（与本 Agent 无关，已跳过）')
    }
    if (!text.trim() && reasoning.trim()) text = reasoning
    if (!text.trim()) {
      this.skipped += 1
      return this.finishTask(settle(task), 'done', '（没有产出内容）')
    }

    const output = text.trim()
    const reply: CollabReply = {
      agentId: agent.id,
      agentName: agent.name,
      parts: trimCollabParts(parts),
      text: output.slice(0, TASK_OUTPUT_LIMIT),
      createdAt: task.startedAt ?? Date.now(),
      ...(usage ? { usage } : {})
    }
    this.replies.push(reply)
    this.turnHistory.push({
      id: `collab-reply-${task.id}`,
      role: 'assistant',
      parts: reply.parts.length > 0 ? reply.parts : [{ type: 'text', text: reply.text }],
      createdAt: reply.createdAt,
      agentId: agent.id,
      agentName: agent.name
    })
    this.addMessage({
      from: agent.id,
      to: task.from,
      kind: 'result',
      text: textOf(reply.text, 4000),
      taskId: task.id
    })
    return this.finishTask(
      settle({ ...task, ...(usage ? { usage } : {}) }),
      'done',
      output.slice(0, TASK_OUTPUT_LIMIT)
    )
  }

  private drainInbox(): Array<{
    agent: CollabAgentConfig
    messages: InboxItem[]
  }> {
    const batch: Array<{ agent: CollabAgentConfig; messages: InboxItem[] }> = []
    for (const [agentId, messages] of this.inbox) {
      const agent = this.settings.agents.find((a) => a.id === agentId)
      if (agent && messages.length > 0) batch.push({ agent, messages })
    }
    this.inbox.clear()
    return batch
  }

  private resolveAgent(ref: string): CollabAgentConfig | undefined {
    const value = ref.trim()
    return this.settings.agents.find((agent) => agent.id === value || agent.name === value)
  }

  private agentName(id: string): string {
    if (id === 'user') return '用户'
    return this.settings.agents.find((agent) => agent.id === id)?.name ?? id
  }

  private modelFor(agent: CollabAgentConfig): AiModelConfig | null {
    if (agent.configId && agent.modelId) {
      return this.opts.resolveModel(agent.configId, agent.modelId) ?? this.opts.mainModel
    }
    return this.opts.mainModel
  }

  private finishTask(
    task: CollabTask,
    status: CollabTask['status'],
    output?: string,
    error?: string
  ): CollabTask {
    const next: CollabTask = {
      ...task,
      status,
      ...(output !== undefined ? { output } : {}),
      ...(error ? { error } : {}),
      finishedAt: Date.now()
    }
    this.tasks.set(next.id, next)
    this.active.delete(next.id)
    if (status === 'done') {
      this.setStatus(next.agentId, { status: 'done', taskId: next.id })
    } else if (status === 'cancelled') {
      this.setStatus(next.agentId, { status: 'cancelled', taskId: next.id })
    } else {
      this.setStatus(next.agentId, {
        status: 'error',
        taskId: next.id,
        ...(error ? { error } : {})
      })
    }
    this.emitTask(next)
    this.schedulePersist()
    return next
  }

  private addMessage(input: Omit<CollabMessage, 'id' | 'createdAt'>): void {
    const message: CollabMessage = {
      ...input,
      id: `msg-${randomUUID().slice(0, 8)}`,
      createdAt: Date.now()
    }
    this.messages.push(message)
    if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500)
    this.opts.emit({ type: 'collab-message', message })
    this.schedulePersist()
  }

  private emitTask(task: CollabTask): void {
    this.opts.emit({ type: 'collab-task', task })
    this.schedulePersist()
  }

  private setStatus(
    agentId: string,
    patch: Partial<CollabAgentRuntime> & { status: CollabAgentStatus }
  ): void {
    const agent = this.settings.agents.find((a) => a.id === agentId)
    const next: CollabAgentRuntime = {
      ...(this.statuses[agentId] ?? { status: 'idle', updatedAt: Date.now() }),
      ...patch,
      updatedAt: Date.now()
    }
    this.statuses[agentId] = next
    this.opts.emit({
      type: 'collab-agent',
      agentId,
      agentName: agent?.name ?? agentId,
      status: next.status,
      ...(next.taskId ? { taskId: next.taskId } : {}),
      ...(next.toolName ? { toolName: next.toolName } : {}),
      ...(next.step !== undefined ? { step: next.step } : {}),
      ...(next.error ? { error: next.error } : {}),
      updatedAt: next.updatedAt
    })
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (!this.opts.onState) return
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.opts.onState?.(this.snapshot())
    }, 1000)
  }
}
