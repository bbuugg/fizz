/**
 * 一轮对话的启动服务：把「Agent 循环的生命周期」从「客户端那条 SSE 连接」上摘下来。
 *
 * 背景：以前一轮对话就活在 `POST /api/chat` 的那个 `streamSSE` 回调里 —— 客户端一断开
 * （刷新页面、Ctrl+R、切标签页）服务端就把整轮 abort 掉，助手回复也只在那条流结束时
 * 才落盘，于是「刷新 = 现场全丢」。
 *
 * 现在改成：run 由 `chat-run.ts` 的注册表托管，这里的 `startTurn` 只负责**启动**它。
 * 连接断开只是退订（`sub.close()`），run 继续跑完并照常落盘 —— 已经产生的正文 / 思考
 * / 工具调用一点不少。客户端（刷新后 / 切回会话时）发现 run 还在跑而本地没人订着它，
 * 用 `GET /api/chat/active` 查到后经 `GET /api/chat/stream?requestId=` 重新 attach：
 * 先回放帧日志再转直播，现场就回来了。`POST /api/chat/abort` 仍可按 conversationId
 * 直接停掉一条 run（用户点「停止」，或 attach 不可用时的兜底）。
 *
 * **为什么独立成服务**：除了聊天路由，定时任务的调度器（`lib/server/scheduler.ts`）也要
 * 起「没有人发消息」的会话 —— 两者必须走完全相同的机制（帧日志 / 落盘 / 审批 / 事件广播），
 * 否则触发的会话在界面上就是二等公民。所以整段逻辑抽到这里，路由与调度器各自调用。
 *
 * ⚠️ 这里刻意**只放内存**：服务端进程重启后 run 全丢（半截正文不再恢复，用户消息仍在）。
 */
import { loadPlugins } from '@fizz/plugin/loader'
import { assistantSliceId, buildUserParts, resolveMaxSteps, resolveToolCallConcurrency, type ChatRequest, type UploadFileRef } from '@fizz/contracts/agent-api'
import { CollabRuntime, defaultContextWindowFromEnv, rawToolsPlugin, readProjectDoc, runAgent, type AgentConfirmInput, type CollabTurnResult, type MountedPlugin, type RunAgentResult } from '@fizz/agent'
import {
  isRemoteWorkspace,
  normalizeReasoningEffort,
  resolveContextWindow,
  resolveModelSettings,
  type AgentStopReason
} from '@fizz/contracts/types'
import { DEFAULT_BROWSER_SETTINGS } from '@fizz/contracts'
import { buildMcpToolset } from '@fizz/mcp'
import {
  browserRuntimeInfo,
  buildAskFollowupTool,
  buildBrowserToolSet,
  resolveBrowserChannel,
  spawnBackgroundShell
} from '@fizz/tools'
import { getAcpImageSupport, runAcpAgent } from '@fizz/acp'
import { discoverServerPlugins, withRuntimeConfig } from './plugin-roots'
import { refreshPluginModels } from './plugin-models'
import { serverSkillsForAgent } from './skill-roots'
import { createAttachmentResolver, resolveUploadModelUrl, validateUploadFiles } from './upload/index'
import { acpPromptAttachments } from './acp-attachments'
import type {
  AgentChatMessage,
  AgentConversation,
  AgentStreamEvent,
  AiModelConfig,
  AiPermissionMode,
  TurnUsage
} from '@fizz/contracts/types'
import type { AcpAgentConfig } from '@fizz/acp'
import { domain, emitServerEvent, markDirty } from './state'
import { createConfirmGate, releaseConfirmsFor } from './confirm-gate'
import { agentPrefs } from './prefs'
import { createFollowupGate, releaseFollowupsFor } from './followup-gate'
import { startContainerTurn } from './container-projects/turn'
import { buildClientToolset, createClientToolGate } from './client-tool-gate'
import { errorPart, excerptOf, foldEventIntoParts } from './agent-parts'
import { createRun, emit, finishRun, type ChatRun } from './chat-run'
import { startBackgroundTask } from './background-tasks'
import { refreshAcpSessionState } from './acp-session-state'
import { appendAcpTranscript } from './acp-transcripts'
import { describeError } from './lib/http'
import { buildAssistantMessage } from './assistant-message'
import { createRemoteBackend } from './ssh/workspace-backend'

/** confirm 模式审批的缺省超时与等待体工厂迁到了 `./confirm-gate`(聊天 / 助手共用) */

/**
 * 确认等待体与四 kind 选项迁到了 `./confirm-gate`；提问（followup）的挂起逻辑迁到了
 * `./followup-gate`（聊天与容器型项目共用一个工厂，释放按 requestId 走）。
 */

/**
 * 无人值守场景的兜底（定时任务起的会话没有人在看）：把这条 run 挂着的审批 / 提问
 * 全部按「拒绝 / 跳过」放行，别让一轮对话永远停在等答复上。worker 在起跑后挂个
 * 定时器调它；正常跑完的场景 `finishRun` 前的收尾已经清过，这里再调是幂等空转。
 */
export function releaseUnattendedWaits(requestId: string): void {
  releaseConfirmsFor(requestId, false)
  releaseFollowupsFor(requestId)
}

/**
 * 组装这一轮发往模型的历史：有**摘要检查点**（手动压缩的产物，`contextSummary`）时
 * = 摘要消息 + 检查点之后的原文，否则全量。切片优先按 id、兜底按时间（id 因编辑重发 /
 * 删除消失时用时间近似，见 `ConversationContextSummary` 的字段注释）。
 * 原始消息不动 —— 压缩只发生在请求侧；自动压缩叠加在这份切片结果上照常工作。
 *
 * 容器型项目也走这一份（`container-projects/turn.ts`）：容器里跑的是同一个 引擎 运行时，
 * 它拿到的必须是同一份切片，压缩过的会话在容器里才不会整段重发。
 */
export function historyForTurn(
  conversation: AgentConversation,
  userMessage: AgentChatMessage
): AgentChatMessage[] {
  const checkpoint = conversation.contextSummary
  if (!checkpoint) return [...conversation.messages, userMessage]
  const cut = conversation.messages.findIndex((m) => m.id === checkpoint.upToMessageId)
  const recent =
    cut >= 0
      ? conversation.messages.slice(cut + 1)
      : conversation.messages.filter((m) => m.createdAt > checkpoint.upToCreatedAt)
  const summaryMessage: AgentChatMessage = {
    id: `ctx-${checkpoint.createdAt}`,
    role: 'user',
    parts: [
      { type: 'text', text: `（以下是对先前对话的摘要，替代原始历史）\n\n${checkpoint.text}` }
    ],
    createdAt: checkpoint.createdAt
  }
  return [summaryMessage, ...recent, userMessage]
}

/**
 * 服务端取而不是让前端从帧里自己摘：只有把 `conversation:finished` 的内容放在**事件**里，
 * 才能在别的标签页 / 别的会话（那些地方没有这轮的帧日志）也弹出带摘要的通知。
 * 实现迁到了 `./agent-parts`(聊天 / 助手共用)。
 */

export function persistAssistantMessage(
  conversationId: string,
  parts: AgentChatMessage['parts'],
  usage?: TurnUsage,
  /**
   * 落盘用的 id。客户端给了就用它（见 `ChatRequest.assistantMessageId`）—— 收尾时客户端
   * 拿服务端权威历史覆盖本地现场，id 不变才不会把刚跑完这一轮的子树整棵重挂载。
   * 缺省（老客户端 / 插话兜底起的新一轮）才自生成。
   */
  id?: string,
  /**
   * 这一轮的耗时 —— **只在没有 `usage` 时才需要**（`usage` 自带 `durationMs`，两个都写
   * 会打架）。
   *
   * 内置后端被中止的那一轮常常一个 usage chunk 都没收到（用户点停止时模型可能正卡在
   * 思考或工具执行里），这时耗时只能由 finish 帧单独给（见 `agent.ts` 的 `finishTiming`）。
   * 折叠条抬头读 `usage?.durationMs ?? message.durationMs`（`message-parts.tsx`），
   * 少了它整轮就退回「思考 ×5 · 工具调用 ×5」的计数摘要 —— 用户看到的是「这一轮
   * 好像没结束」。
   */
  durationMs?: number,
  /**
   * 被单轮步数上限截断时给（见 `AgentStopReason`）：落盘后刷新仍在，用户不会过一会儿
   * 又不知道为什么停的。与 `durationMs` 不互斥（一个说「为什么停」、一个说「花了多久」）。
   */
  stop?: { stopReason: AgentStopReason; steps: number }
): void {
  try {
    domain.appendMessages(
      conversationId,
      [buildAssistantMessage({ parts, usage, id, durationMs, ...(stop ?? {}) })],
      // 标题：助手回复不改标题（由这一轮的用户消息决定）
      undefined,
      // 会话级用量统计：没有 `usage`（中止的轮次）就不累计
      usage
    )
  } catch (err) {
    console.error('[server] 助手回复落盘失败：', err)
  }
}

/**
 * 「一轮开始时的用户消息落盘 + 首轮自动标题」—— 本地一轮（`startTurn`）与容器型项目
 * （`container-projects/turn.ts`）**共用这一份**。两边各写一遍必然漂，而这里定下的正是
 * 「标题取什么」「acp 会话不落消息、只改标题」这类会被反复调整的口径。
 *
 * 返回的 `conversationTitle` 是**广播用**的标题（首轮自动标题已算进去）：不能直接用
 * `conversation.title`（那是读会话时的快照），否则「新建会话的第一轮」推出去的通知
 * 标题永远是「新会话」。
 */
export function beginTurnUserMessage(
  input: ChatRequest,
  conversation: AgentConversation
): { userMessage: AgentChatMessage; title?: string; conversationTitle: string } {
  const text = input.text?.trim()
  const files = input.files ?? []
  const now = Date.now()
  const userMessage: AgentChatMessage = {
    // 插话收尾兜底会传入被广播过的那条消息 id（见 drainSteerInbox）：客户端按 id
    // 去重，起新一轮时不产生重复显示。普通轮缺省自生成。
    id: input.userMessageId ?? `u-${now}`,
    role: 'user',
    // files 在前、text 在后（附件展示在文本上方；客户端乐观消息用同一份 buildUserParts）
    parts: buildUserParts(text, files),
    createdAt: now
  }
  const title =
    conversation.messages.length === 0
      ? (text || files[0]?.name || '').replace(/\s+/g, ' ').slice(0, 30)
      : undefined
  if (conversation.backend === 'acp') {
    // acp 的 messages 恒为空，每轮都是「空历史」—— 标题只在该还是默认名时补一次
    if (title && conversation.title === '新会话') {
      try {
        domain.renameConversation(conversation.id, title)
      } catch {
        // 标题设置失败不影响对话
      }
    }
    // 本地不落盘，但要留在进程内视图里：跑动中刷新只能靠它恢复用户这一半，
    // 不能去 session/load（那会 teardown 正在跑的进程）。
    appendAcpTranscript(conversation.id, [userMessage])
  } else {
    domain.appendMessages(conversation.id, [userMessage], title)
  }
  return { userMessage, ...(title ? { title } : {}), conversationTitle: title ?? conversation.title }
}

export type StartTurnResult =
  | { ok: true; run: ChatRun }
  | { ok: false; status: 400 | 404 | 500; message: string }

/**
 * 插话收尾兜底（spec §1.4/§1.5）：插话进了收件箱但没被任何边界消费（撞 maxSteps
 * 预算 / 收尾竞态）。成功收尾 → 循环 shift 交给 `startTurn` 起新一轮（它自己落
 * user 消息，这里**绝不预落盘**，防双重追加；`userMessageId` 传广播过的那条 id，
 * 客户端按 id 去重）。起不了新一轮（绑定悬空等）就把消息落成普通 user 消息收场，
 * 消息不能丢。仅成功收尾会走到这里（error / aborted 由收尾链内联处理）。
 *
 * 拉到模块级是因为**容器型项目也走这一份**（`container-projects/turn.ts` 的收尾链接它）：
 * 落在 `startTurn` 内部当闭包的话容器那侧就得抄一份，而这段正是「最容易漂」的地方
 * （附件回传 / id 去重 / 失败不自动跑）—— 两边共用一份才只有一个口径。
 */
export async function drainSteerInbox(
  run: ChatRun,
  conversation: AgentConversation,
  permissionMode: AiPermissionMode
): Promise<void> {
  while (run.steerInbox.length) {
    const next = run.steerInbox.shift()
    if (!next) break
    const text = next.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim()
    /**
     * ⚠️ 附件必须一起回传给 `startTurn`：兜底轮是**重新起一轮**（不是注入当前轮），
     * 只把 text 递过去的话，带附件的插话会在这里**悄悄丢图**（用户看不到任何报错，
     * 模型只是没收到图）。`userMessageId` 传的是被广播过的那条 id，客户端按 id 去重。
     */
    const files: UploadFileRef[] = next.parts.flatMap((p) =>
      p.type === 'file' ? [{ name: p.name, mediaType: p.mediaType, url: p.url }] : []
    )
    if (!text && files.length === 0) continue
    try {
      const started = await startTurn({
        conversationId: conversation.id,
        text,
        ...(files.length > 0 ? { files } : {}),
        ...(next.id ? { userMessageId: next.id } : {}),
        // 兜底轮沿用被打断那一轮的权限档（交互语境一致；无人看管的确认会等超时按拒绝）
        ...(permissionMode ? { permissionMode } : {})
      })
      if (!started.ok) {
        try {
          domain.appendMessages(conversation.id, [next])
        } catch (err) {
          console.error('[server] 插话兜底落盘失败：', err)
        }
        break
      }
    } catch (err) {
      console.error('[server] 插话兜底起新一轮失败：', err)
      break
    }
  }
}

/**
 * 启动一轮对话并立刻返回：run 已登记、runner 已在后台跑。
 * 调用方拿 `run` 想接到 SSE 上（聊天路由 → `pipeRun`），还是只想等它跑完
 * （队列 worker → `await run.done`），都行 —— 这正是抽成服务的原因。
 * 失败不抛：返回 `{ ok: false }` 让调用方决定回 400 还是记任务失败。
 */
export async function startTurn(input: ChatRequest, opts?: { origin?: string }): Promise<StartTurnResult> {
  const text = input.text?.trim()
  const files = input.files ?? []
  if (!input.conversationId || (!text && files.length === 0)) {
    return { ok: false, status: 400, message: '缺少 conversationId 或 text' }
  }

  // 附件校验**前置到会话查找之前**：坏引用（类型 / 归属不过）第一时间拒绝，
  // 不给「会话不存在 / 后端没选」之类更早的报错机会盖掉它，也防任意 URL 注进历史
  // （判据与插话 steer 路由共用一份：upload 的 validateUploadFiles）
  const invalidFile = validateUploadFiles(files)
  if (invalidFile) return { ok: false, status: 400, message: invalidFile }

  const conversation = domain.getConversation(input.conversationId)
  if (!conversation) return { ok: false, status: 404, message: '会话不存在' }

  /**
   * 容器型项目：这一轮**不在宿主进程里跑**，宿主只当「帧的中继」（见
   * `container-projects/turn.ts`）。分派点刻意放在**用户消息落盘之前** —— 那边自己落
   * （同一份 `beginTurnUserMessage`），这边再落一遍就是重复追加一条用户消息。
   */
  if (domain.getWorkspace(conversation.workspaceId)?.container) return startContainerTurn(input, opts)

  // 用户消息落盘：内置会话全量落；acp 会话的消息保存在 agent 侧（session/load 接回），
  // 本地只留会话元数据 —— 首轮顺手把自动标题补上（与容器型项目共用同一份口径）
  const { userMessage, conversationTitle } = beginTurnUserMessage(input, conversation)
  const isAcpConversation = conversation.backend === 'acp'

  const rejectTurn = (status: 400 | 404 | 500, message: string): StartTurnResult => {
    // 错误也落成**这一轮那条助手消息**（沿用客户端给的 id）：客户端收尾拉权威历史时
    // 把它换成本地已渲染的那条错误，id 一致就不会重挂载
    if (!isAcpConversation) {
      persistAssistantMessage(conversation.id, [errorPart(message)], undefined, input.assistantMessageId)
    }
    return { ok: false, status, message }
  }

  /**
   * 会话的工作区**必须真实存在**：会话创建时就绑死了归属（没选项目的那条路会先建一个
   * 临时工作区再建会话，见 `POST /api/conversations`），所以走到这里找不到就是脏数据
   * （项目被删、手改坏了数据文件）—— 明说 404，别静默降级成「没有目录的会话」。
   */
  const workspace = domain.getWorkspace(conversation.workspaceId)
  if (!workspace) return rejectTurn(404, '会话所属工作区不存在')

  /**
   * 远端工作区：Agent 的文件 / 命令工具经 SSH 走远端，引擎、会话、审批仍在本进程。
   * backend 本身不建连接（两个 service 懒建 + 池化），这里每轮现建一个即可。
   */
  const remoteWorkspace = isRemoteWorkspace(workspace)
  const workspaceBackend = remoteWorkspace && workspace.remote
    ? createRemoteBackend(workspace.remote.hostId, workspace.path)
    : undefined

  // 会话必须显式绑定后端（创建/选择时落库）—— 不存在任何「跟随工作区 / 跟随默认」的回退
  const backend = input.backend ?? conversation.backend
  if (!backend) {
    return rejectTurn(400, '会话还没有选择模型 / Agent，请在输入框上方选择后重新发送')
  }

  /**
   * 外部 Agent（ACP）在本进程起子进程，只能跑本地目录；多智能体协作的子 Agent 也按
   * 本地工作区装配工具。远端工作区首期两条都不支持 —— 直接说清，别让它们拿远端
   * POSIX 路径当本地 cwd 去执行。
   */
  if (remoteWorkspace) {
    if (backend === 'acp') {
      return rejectTurn(400, '远端工作区首期不支持外部 Agent（ACP），请改用内置模型')
    }
    if (conversation.kind === 'collab') {
      return rejectTurn(400, '远端工作区首期不支持多智能体协作会话')
    }
  }

  // 插件注册的模型：解析前刷新一次（指纹没变时只是几次 stat），否则插件加 / 改的配置
  // 要等重启或打开设置页才看得到。
  await refreshPluginModels()

  // acp 会话在创建时就锁定了 agent（configId = agent id）：换 agent 一律拒绝，模型可换
  if (
    backend === 'acp' &&
    conversation.configId &&
    input.configId &&
    input.configId !== conversation.configId
  ) {
    return { ok: false, status: 400, message: 'ACP 会话已绑定 agent，不支持切换；要换 agent 请新建会话' }
  }

  let modelConfig: AiModelConfig | undefined
  let acpAgent: AcpAgentConfig | undefined
  const requestedConfigId = input.configId ?? conversation.configId
  const requestedModelId = input.modelId ?? conversation.modelId
  /**
   * 思考强度：请求里带了的优先（避免刚点完 pill 立刻发送、PATCH 还没回来的竞态），
   * 否则用会话记住的那份。ACP 外部 agent 不读它（那边走 acpThoughtLevel）。
   */
  const reasoningEffort =
    input.reasoningEffort !== undefined
      ? normalizeReasoningEffort(input.reasoningEffort)
      : conversation.reasoningEffort
  if (!requestedConfigId) {
    return rejectTurn(
      400,
      backend === 'acp' ? '会话还没有绑定 ACP agent，请重新选择' : '会话还没有选择模型，请重新选择'
    )
  }
  try {
    // 严格解析：配置 / agent 悬空（被删了）直接报错让重新选，不做任何静默回退
    if (backend === 'acp') {
      // 外部 agent 要一个真实 cwd 才能起进程：`path` 为空的虚拟工作区明确拒绝
      if (!workspace.path) {
        return rejectTurn(400, '这个会话没有可用的项目目录，不能用外部 Agent（ACP 需要目录）')
      }
      acpAgent = domain.resolveAcpAgent(requestedConfigId)
    } else {
      if (!requestedModelId) return rejectTurn(400, '会话还没有选择模型，请重新选择')
      modelConfig = domain.resolveModelConfig(requestedConfigId, requestedModelId)
    }
  } catch (err) {
    const { message } = describeError(err)
    return rejectTurn(400, message)
  }

  /**
   * 图片输入开关：关着的模型**在发送时明确拒绝**，不悄悄把图丢掉 ——
   * 附件仍留在历史里而模型看不见，用户会以为「它看了图但答错了」。
   *
   * 历史里已有的图片由 `toModelMessages` 过滤成一行说明（换过模型的老会话仍能继续跑），
   * 所以这里只拦「这一条新消息带的图片」。
   */
  if (modelConfig) {
    const target = resolveModelSettings(modelConfig.models, modelConfig.model)
    if (!target.imageInput && files.some((f) => f.mediaType?.startsWith('image/'))) {
      return rejectTurn(
        400,
        `模型「${modelConfig.name}」没有开启图片输入：请移除图片附件，或到 设置 →「模型」里打开「图片输入」`
      )
    }
  }

  // `path` 空的虚拟工作区（「任务」/「项目助手」）：技能目录与项目文档都在项目里，
  // 没有就跳过 —— 不能让空串落进 `readProjectDoc` 的路径解析（那会相对进程 cwd 去找 AGENTS.md）
  //
  // 远端工作区首期不注入项目级技能 / AGENTS.md（它们要经 SFTP 读，且插件与项目工具
  // 的路径语义都按本地写死）；技能清单与项目文档一律为空，模型只能靠远端文件本身。
  const skills = !remoteWorkspace && workspace.path ? await serverSkillsForAgent(workspace.path) : []
  const projectDoc =
    !remoteWorkspace && workspace.path ? await readProjectDoc(workspace.path) : null

  /**
   * 服务端权威的一份偏好（`CoreData.prefs`）：请求体给了就用请求体（会话级覆盖 / 旧客户端），
   * 没给就落到这里。关键是**定时任务**也走同一条 `startTurn`，而它没有任何渲染端可问 ——
   * 以前这些值只能吃 `runAgent` 的缺省，设置页填的数字对无人值守的任务完全不生效。
   */
  const prefs = agentPrefs()
  const permissionMode = (input.permissionMode ?? prefs.permissionMode) as AiPermissionMode
  const confirmTimeoutMs =
    typeof input.confirmTimeoutMs === 'number' && Number.isFinite(input.confirmTimeoutMs) && input.confirmTimeoutMs >= 0
      ? input.confirmTimeoutMs
      : prefs.confirmTimeoutMs
  // 模型请求自动重试次数（0 = 不限制）；非法值回落服务端偏好
  const maxRetries =
    typeof input.maxRetries === 'number' && Number.isFinite(input.maxRetries) && input.maxRetries >= 0
      ? Math.round(input.maxRetries)
      : prefs.maxRetries
  // 同一批 tool-call 的并发上限（设置页里的偏好）；非法值回落服务端偏好
  const toolCallConcurrency =
    typeof input.toolCallConcurrency === 'number' && Number.isFinite(input.toolCallConcurrency)
      ? resolveToolCallConcurrency(input.toolCallConcurrency)
      : prefs.toolCallConcurrency
  // 一轮最多跑多少步（设置页里的偏好）；非法值回落服务端偏好
  const maxSteps =
    typeof input.maxSteps === 'number' && Number.isFinite(input.maxSteps)
      ? resolveMaxSteps(input.maxSteps)
      : prefs.maxSteps
  // 工具卡「意图」开关（设置页里的偏好）；非布尔值回落服务端偏好
  const toolIntent = typeof input.toolIntent === 'boolean' ? input.toolIntent : prefs.toolIntent

  const run = createRun({
    conversationId: conversation.id,
    workspaceId: workspace.id,
    backend,
    // 起始活权限档：`runAgent` 拿 `() => run.permissionMode` 现取，POST /api/chat/permission 改它
    permissionMode,
    ...(backend === 'acp' && acpAgent
      ? { acpTarget: { agentId: acpAgent.id, conversationId: conversation.id } }
      : {}),
    // 给 run 也记一份：接手这条 run 的端（刷新后 / 另一个标签页）从 ChatRunSummary 拿它建占位
    ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {})
  })
  const requestId = run.requestId

  // 「这一轮开跑了」广播给所有连接（侧栏转圈 / 系统通知都靠它）；运行态的权威清单走
  // `activeRuns` 快照（对话结束时同样会 markDirty），两者互补，见 contracts 的 ServerEvent。
  markDirty(['activeRuns'])
  emitServerEvent({
    type: 'conversation:started',
    conversationId: conversation.id,
    requestId,
    title: conversationTitle,
    startedAt: run.startedAt
  })

  /**
   * 审批等待体(聊天 / 助手共用的工厂,见 `confirm-gate.ts`):confirm 帧、挂起、
   * 瞬时事件广播与「始终」记忆都在里面;这里只传入会话坐标与广播出口。
   * `approvedCommandsPath` 把「始终允许此命令」落进项目自己的
   * `.fizz/workspace.json`(虚拟工作区没有 path,不传 = 内存记忆、重启清零)。
   */
  const gate = createConfirmGate({
    run,
    ownerKey: conversation.id,
    title: conversationTitle,
    confirmTimeoutMs,
    workspace: { id: workspace.id, name: workspace.name },
    ...(workspace.path && !remoteWorkspace ? { approvedCommandsPath: workspace.path } : {}),
    broadcast: (event) => emitServerEvent(event)
  })
  const waitForConfirmReply = gate.waitForConfirmReply
  const requestConfirm = gate.requestConfirm

  /**
   * 客户端工具（请求携带、客户端执行）：与 confirm / followup 同一条反向通道。
   * 主要用于「AI 操作用户眼前那个终端」—— 服务端没有活会话注册表，够不着。
   * 权限全在客户端；服务端只推帧、等回填（见 client-tool-gate.ts）。
   */
  const clientGate = createClientToolGate({ run })

  /**
   * ACP 的权限请求答复。
   *
   * - 会话档 `confirm`（缺省）：答复体带用户挑中的 optionId，原样回给 agent（弹确认卡）；
   * - 会话档 `allow`：应用层直接放行，请求不变成卡。**缺省只回 `allow_once`**（见下）。
   *
   * ⚠️ `allow` **默认绝不能回 `allow_always`**：那会被 agent 自己**永久记住**，之后把会话
   * 切回「确认」也要不回询问了（实测踩过）。回哪个由 agent 配置的 `allowStrategy` 决定
   * （缺省 `once` = 只允许一次，下次仍会问）。
   * ⚠️ 拿不到想要的选项时**退回弹卡**，不替用户答一个更宽的 —— 宁可见到卡片，
   * 也别悄悄把「还会问我」这件事送掉。
   * ⚠️ 只在 agent 真的发问时生效：agent 自己配成 `deny` 时它根本不发这个请求。
   *
   * ⚠️ 每次都**现取会话当前的 `acpPermissionMode`**，不要读本轮开头捕获的 `conversation`
   * 快照：`AcpPermissionPill` 中途切档走的是 `PATCH /api/conversations/:id/target`，
   * 它同步更新 `domain` 里的会话，但不会改这个局部快照 —— 读快照会让中途切的档要等到
   * 下一轮才生效（用户在本轮里切了「完全放行」，后面的权限请求却照样弹卡）。
   * 现取之后：切档只影响**之后到达**的权限请求；已经挂起在等答复的那一张仍按旧路径
   * 等用户处理（不会自动替用户结算）。
   */
  const requestPermission = (req: AgentConfirmInput) => {
    const acpMode = domain.getConversation(conversation.id)?.acpPermissionMode
    if (acpMode === 'allow') {
      const options = req.options ?? []
      const once = options.find((option) => option.kind === 'allow_once')
      const always = options.find((option) => option.kind === 'allow_always')
      // 缺省 once；显式配了 always 才回 allow_always（没有 always 就退回落 once）
      const picked = (acpAgent?.allowStrategy ?? 'once') === 'always' ? (always ?? once) : once
      if (picked) return Promise.resolve({ approved: true, optionId: picked.optionId })
    }
    return waitForConfirmReply(req)
  }

  /**
   * 提问（`ask_followup_question`）的推帧 / 挂起 / 答复：聊天与容器型项目共用同一个工厂
   * （见 `followup-gate.ts`），这里只传入会话坐标与广播出口。
   */
  const followupGate = createFollowupGate({
    run,
    conversationId: conversation.id,
    title: conversationTitle
  })
  const requestFollowup = followupGate.requestFollowup

  const assistantParts: AgentChatMessage['parts'] = []
  let turnUsage: TurnUsage | undefined
  /** 协作会话本轮的结果：多条 Agent 回复 + 跳过 / 失败统计，收尾时按 Agent 归属落盘 */
  let collabTurnResult: CollabTurnResult | undefined
  /** 协作会话的收尾摘要（`conversation:finished` 的通知文案用；普通会话走 `excerptOf`） */
  let collabExcerpt: string | undefined
  /**
   * 这一轮的耗时（finish 帧的 `durationMs`）。收尾时挂到助手消息上，折叠条抬头才报得出
   * 「已工作 N 秒」（见 `AgentChatMessage.durationMs`）。
   *
   * 两个来源：
   * - **ACP**：它没有 token 用量，每轮都只能给这个数；
   * - **内置**：只在**没有 `usage`** 时给 —— 中止 / 出错的那一轮常常一个 usage chunk 都
   *   没收到（用户点停止时模型可能正卡在思考或工具执行里），正常完成则有
   *   `usage.durationMs`，不该重复。
   */
  let turnDurationMs: number | undefined
  /**
   * 这一轮**被预算截断**了（撞上 `maxSteps`）。从 finish 帧取，收尾时落进助手消息
   * （`AgentChatMessage.stopReason`），界面据此在消息底部补一行「已用满 N 步」。
   */
  let turnStop: { stopReason: AgentStopReason; steps: number } | undefined
  /**
   * 运行中插话的注入记录：`index` = user-injected 事件到达时 assistantParts 的长度
   * （= 该条插话之前已产出的部分），`message` = 那条 user 消息（含 id）。
   * 收尾时按这些边界把 assistantParts 切成多段，与插话交错落盘（真实时序）。
   */
  const steerBoundaries: { index: number; message: AgentChatMessage }[] = []
  /** 收尾事件的 `error` 字段：`.then` 里是 runner 自报的错误，`.catch` 里是抛出来的 */
  let runError: string | undefined

  const onEvent = (event: AgentStreamEvent): void => {
    if (event.type === 'context-usage' && isAcpConversation) {
      // ACP 上报的上下文占用：一并写进会话配置，刷新页面后圆环还能显示。
      // 值没变时 `setAcpContextUsage` 内部直接返回（不写盘、不标脏）；也刻意不动 updatedAt。
      domain.setAcpContextUsage(conversation.id, { used: event.used, size: event.size })
    }
    if (event.type === 'user-injected') {
      // 先记边界再 fold：fold 对这个类型是 no-op（agent-parts 的 if/else 链自然穿透），
      // 但边界必须取「这条插话之前」的 parts 长度。
      steerBoundaries.push({ index: assistantParts.length, message: event.message })
    }
    if (event.type === 'finish') {
      // 两个来源互斥：有 `usage` 时耗时在它里面（内置后端正常跑完），没有时才是单独的
      // `durationMs`（ACP 全程如此；内置被中止 / 出错时也常常一个 usage chunk 都没收到）
      if (event.usage) turnUsage = event.usage
      if (event.durationMs != null) turnDurationMs = event.durationMs
      // 撞步数上限：**不是错误**（finishReason 仍是 done），只是多了这一位
      if (event.stopReason) {
        turnStop = { stopReason: event.stopReason, steps: event.steps ?? 0 }
      }
    }
    // 内容折叠(聊天 / 助手共用,见 `agent-parts.ts`):tool-call-delta 不落盘、retry 按
    // 整轮重来 / 断点续跑分别「全清」与「回滚到最后一次工具结果」,其余按形状归位;
    // 帧本身照旧下发(前端要的就是它)。
    foldEventIntoParts(assistantParts, event)
    emit(run, { type: 'event', requestId, event })
  }

  const runAiSdkTurn = async (): Promise<RunAgentResult> => {
    /**
     * 这一轮额外挂的能力，全部走**插件**通道（`RunAgentOptions.plugins`）。
     *
     * 与从前的差别只在**形式上**：以前是手工 `Object.assign(extraTools, …)` 拼一个大对象，
     * 现在是「一项能力 = 一个插件」，由 `buildAgentSetup` 的 turn context 依序挂进工具注册表。
     * 挂载顺序：MCP → 提问 → 浏览器（项目管理工具组不在此列，见下面那段）。
     * 走插件通道的好处是后续可以按插件粒度做覆盖 / 卸载 / 冲突体检（见 @fizz/plugin）。
     */
    const plugins: MountedPlugin[] = []
    /**
     * 客户端工具（请求携带、客户端执行）排在最前：MCP 与内置工具都能盖过它 ——
     * 客户端不该顶掉一个受审批保护的内置能力（与 assistant-turn 同一条口径）。
     */
    if (input.clientTools?.length) {
      const clientTools = buildClientToolset(input.clientTools, clientGate, {
        // 与内置工具同一档、同一个审批通道：客户端工具是模型直接调的，闸不能留在客户端
        permissionMode,
        // 运行中活取：切档立刻生效（与内置工具的 getPermissionMode 同源）
        getPermissionMode: () => run.permissionMode,
        requestConfirm
      })
      plugins.push({
        plugin: rawToolsPlugin('server:client', clientTools, { origin: 'plugin', source: 'client' })
      })
    }
    /**
     * ⚠️ 项目管理工具组（`project-tools`）**刻意不在这里挂**。
     *
     * 它操作的是「项目清单」本身（跨工作区）：登记 / 新建 / 删除项目、增删 worktree、
     * 建定时任务、写插件、给项目建会话 —— 这些作用域都在**单个工作区之外**，与普通会话
     * 「在一个工作区里干活」的定位冲突。挂上以后普通会话的 agent 就能越界建目录、删项目、
     * 装一个下一轮自动以完全访问权限执行的自定义工具，把工作区边界（`resolveInside`）
     * 从侧门绕过去。
     *
     * 唯一该持有它的通道是**项目管理助手**（`assistant-turn.ts`，经 `setup.tools` 装配）——
     * 那里才是「跨项目管理」的正当场景。别把它搬回来。
     */
    /**
     * 浏览器偏好：**按会话**（输入框上方工具条那颗「浏览器」开关，落在会话自己身上）。
     * 总开关关掉时**既不挂 browser_* 工具，也不追加系统提示词里那段浏览器说明**。
     *
     * 与外部 playwright-mcp 的同名冲突由下面的「让位」逻辑自动处理（MCP 有同名工具时
     * 内置对应的 browser_* 直接不挂），不需要用户手动二选一。
     */
    // 会话没单独设过 → 用常量默认（关 + bundled）。已经没有「全局默认」那一层了：
    // 浏览器是「用到才开」的能力，没有「新会话默认开」这个东西。
    const browserSettings = conversation.browserSettings ?? DEFAULT_BROWSER_SETTINGS
    /**
     * 内置浏览器工具集：先建（关掉时为空对象）。构建本身是廉价的
     * （`ensureSession` 在 execute 里才拉起浏览器）。
     *
     * ⚠️ 运行时**没装**（headless shell 没下载）时也在这里就不挂：开关点开了也白点 ——
     * 引擎的 `ensureChromiumReady` 会在 execute 里静默触发 150MB 下载，而界面上没有任何
     * 进度，看起来就是「一轮对话卡住不动」。升级上来的老会话里 `enabled: true` 是常态，
     * 因此这条判断不是多余的。装 / 卸在「设置 → 浏览器」，装好后下一轮自然挂上
     * （这里每次装配都现读状态，不用重启）。
     *
     * 下面接 MCP 时要用它做「让位」判定：外部 playwright-mcp 的浏览器工具与内置**同名**，
     * 而工具注册表对「同名并列最高 priority」直接抛错 —— 所以 MCP 有同名工具时，就从这里
     * **剔掉**同名的键（内置让位），不让两者同时进注册表。
     */
    const browserTools: Record<string, unknown> =
      !remoteWorkspace && browserSettings.enabled && browserRuntimeInfo().installed
        ? buildBrowserToolSet({
            channel: resolveBrowserChannel,
            conversationId: conversation.id,
            workspacePath: workspace.path
          })
        : {}

    // 只接**这个会话选中**的 MCP server（未选 = 一个都不接，MCP 工具缺席是预期行为，不是故障）。
    // 选了但已被删掉的 id 在 setConversationTarget 时就剔过了，这里再按现存配置过一遍，
    // 避免「设置里刚删掉、本轮仍在跑」的窗口期把已消失的配置也去连。
    const allServers = domain.listMcpServers()
    const chosen = new Set(conversation.mcpServerIds ?? [])
    const selectedServers = chosen.size
      ? allServers.filter((s) => chosen.has(s.id))
      : []
    if (selectedServers.length) {
      try {
        const { tools } = await buildMcpToolset(selectedServers)
        /**
         * 撞名让位：外部 MCP（playwright-mcp）的浏览器工具与内置 `browser_*`**完全同名**，
         * 而工具注册表对「同名并列最高 priority」**直接抛错**（见 @fizz/plugin 的
         * ToolsService）。所以有同名工具时**内置那一侧自动让位** —— 从内置集合里剔掉这些键，
         * MCP 工具原样全挂，用户不用手动二选一。
         *
         * 为什么不抬 MCP 的 priority 让注册表去裁决：那样「谁胜出」就藏进了注册表的排序
         * 规则里，而这套让位是**产品语义**（外部 MCP 接管浏览器能力）；显式剔除更好查，
         * 哪几个内置工具让位了、日志里一目了然。
         */
        const yielded: string[] = []
        for (const name of Object.keys(tools)) {
          if (name in browserTools) {
            delete browserTools[name]
            yielded.push(name)
          }
        }
        if (yielded.length) {
          console.warn(
            `[server] 内置浏览器工具已让位给外部 MCP 的同名工具：${yielded.join(', ')}` +
              '（浏览器能力由这套 MCP 工具接管）'
          )
        }
        // MCP 工具来自外部 server，按「插件」来源登记（不被当作内置能力）
        plugins.push({
          plugin: rawToolsPlugin('server:mcp', tools, { origin: 'plugin', source: 'mcp' })
        })
      } catch (err) {
        console.warn('[server] MCP 工具集构建失败（继续跑本地工具）：', err)
      }
    }
    plugins.push({
      plugin: rawToolsPlugin(
        'server:ask-followup',
        buildAskFollowupTool(
          // `interrupted` 一起传：工具靠它区分「用户点了跳过」与「这一轮被中止」
          { ask: requestFollowup, interrupted: followupGate.interrupted },
          requestId
        ),
        { origin: 'builtin', source: 'server:ask-followup' }
      )
    })
    /**
     * 浏览器工具：一个会话一份浏览器（sessionId = `agent-browser:<conversationId>`），
     * 与渲染端面板共用同一份会话，Agent 操作浏览器时面板能实时看到画面。
     * 按本轮 conversationId 构建（闭包捕获），这样工具内部能推导出正确的 sessionId。
     *
     * 关掉总开关、或工具全被外部 MCP 顶掉时**整条不挂**：工具、提示词说明、以及
     * `runAgent` 的 `browser` 标记三处一起撤（漏一处就会出现「提示词说有浏览器工具、
     * 实际一个都没有」）。
     */
    const browserToolNames = Object.keys(browserTools)
    if (browserToolNames.length > 0) {
      plugins.push({
        plugin: rawToolsPlugin('server:browser', browserTools, {
          origin: 'builtin',
          source: 'server:browser'
        })
      })
    }
    /**
     * 磁盘上的插件：**内置**（随产品分发）、项目级（`<工作区>/.fizz/plugins`）、
     * 用户级（`~/.fizz/plugins`）。每轮现发现、现加载，**只挂启用过的**；加载失败的插件
     * 只记一行日志（`loadPlugins` 内部逐项 try/catch），绝不因为一个坏插件拖垮整轮对话。
     *
     * 停用清单按来源分开（内置 / 用户级认全局偏好，项目级认项目偏好），组装规则只有一份：
     * `discoverServerPlugins`（见 `plugin-roots.ts`）—— 这里、插件路由、上传源目录共用它，
     * 免得某处漏扫了内置插件。
     */
    // 远端工作区首期不加载项目级 / 用户级插件：它们的工具与配置都按本地路径装配
    // （工作区级插件要读 `<工作区>/.fizz`），远端下只会拿 POSIX 路径当本地路径用。
    if (!remoteWorkspace) {
      try {
        const descriptors = await discoverServerPlugins({
          workspaceId: workspace.id,
          workspacePath: workspace.path
        })
        // 运行时配置（plugins.yml + 设置页里填的值）在挂载前合上：插件读 `config.xxx`
        const { loaded, errors } = await loadPlugins(withRuntimeConfig(descriptors.filter((d) => d.enabled)))
        for (const err of errors) console.warn('[server] 插件加载失败（已跳过）：', err)
        for (const item of loaded) {
          plugins.push({ plugin: item.plugin, config: item.config })
        }
      } catch (err) {
        console.warn('[server] 插件发现失败（继续跑内置能力）：', err)
      }
    }

    /**
     * 子任务偏好：启停 + 可选专用模型。
     *
     * 模型配置被删 / 模型被移除时**退回父模型**（不能因为一个可选偏好让整轮打不开）；
     * `resolveModelConfig` 自带人话错误，这里只接住并记日志，不往用户界面抛。
     */
    const subagentSettings = domain.getSubagentSettings()
    const isCollab = backend === 'builtin' && conversation.kind === 'collab'
    let subagentModel: AiModelConfig | undefined
    if (
      !isCollab &&
      backend === 'builtin' &&
      subagentSettings.enabled.length > 0 &&
      subagentSettings.modelConfigId &&
      subagentSettings.modelId
    ) {
      try {
        subagentModel = domain.resolveModelConfig(
          subagentSettings.modelConfigId,
          subagentSettings.modelId
        )
      } catch (err) {
        console.warn('[subagent] 子任务模型不可用，沿用父会话模型：', err)
      }
    }

    /**
     * 用户自建的子智能体：定义随设置落盘，这里只做两件事 —— 决定要不要下传、
     * 把它们各自的专用模型解析成完整配置（解析失败退回全局 → 父模型，同上一个模型的降级口径）。
     */
    const subagentDefinitions =
      backend === 'builtin' && !isCollab ? (subagentSettings.definitions ?? []) : []
    const subagentDefinitionModels: Record<string, AiModelConfig> = {}
    for (const def of subagentDefinitions) {
      if (!def.modelConfigId || !def.modelId) continue
      try {
        subagentDefinitionModels[def.id] = domain.resolveModelConfig(def.modelConfigId, def.modelId)
      } catch (err) {
        console.warn(`[subagent] 子智能体「${def.name}」的模型不可用，沿用父会话模型：`, err)
      }
    }

    /**
     * 多智能体协作：运行时编排器（@ 点名 / 广播判定 / SendMessage 投递）。
     *
     * 任务 / 消息状态独立写 `collab.json`（`onState` 内部节流）；回复以带 `agentId/agentName`
     * 的助手消息落进主对话，取消挂到 run 上供 `POST /api/chat/collab/cancel` 命中。
     */
    let collabRuntime: CollabRuntime | undefined
    if (isCollab) {
      const initialState = await domain.getCollabState(conversation.id)
      collabRuntime = new CollabRuntime({
        conversation,
        workspace,
        skills,
        projectDoc,
        mainModel: modelConfig!,
        resolveModel: (configId, modelId) => {
          if (!configId || !modelId) return null
          try {
            return domain.resolveModelConfig(configId, modelId)
          } catch (err) {
            console.warn('[collab] 子 Agent 模型不可用，回退主模型：', err)
            return null
          }
        },
        initialState,
        getPermissionMode: () => run.permissionMode,
        requestConfirm,
        commandStops: run.commandStops,
        signal: run.controller.signal,
        emit: (event) => emit(run, { type: 'event', requestId, event }),
        onState: (state) => domain.saveCollabState(conversation.id, state)
      })
      run.collabCancel = (taskId) => collabRuntime?.cancelTask(taskId) ?? false
    }

    /**
     * 协作会话**不跑主智能体**：用户 @ 谁就由谁处理，没 @ 就全体广播判定；
     * 每个 Agent 的回复由 `persistCollabTurn` 落成带 `agentId/agentName` 的助手消息。
     * 这里复用 `runAgent` 的单 Agent 运行能力，但编排在 `CollabRuntime.runTurn`。
     */
    if (isCollab && collabRuntime) {
      try {
        const result = await collabRuntime.runTurn({
          history: historyForTurn(conversation, userMessage),
          text: input.text ?? ''
        })
        collabTurnResult = result
        if (result.usage) turnUsage = result.usage
        collabExcerpt = result.replies
          .map((reply) => reply.text)
          .join('\n')
          .trim()
          .slice(0, 120)
        if (run.controller.signal.aborted) return { finishReason: 'aborted' }
        if (!result.replies.length && result.errors.length) {
          return {
            finishReason: 'error',
            error: result.errors
              .map((item) => `${item.agentName}：${item.error}`)
              .join('；')
          }
        }
        return { finishReason: 'done' }
      } catch (err) {
        const message = describeError(err).message
        console.error('[server] 协作轮执行失败：', err)
        // 让收尾仍走协作落盘路径：否则 `assistantParts` 是空的，用户只会看到一条空白回复
        collabTurnResult = {
          replies: [],
          skipped: 0,
          errors: [{ agentId: 'runtime', agentName: '协作运行时', error: message }]
        }
        return { finishReason: 'error', error: message }
      } finally {
        collabRuntime.close()
        delete run.collabCancel
      }
    }

    try {
      return await runAgent({
        workspace,
      // 远端工作区的文件 / 命令走 SSH；不传 = 本地（行为与改造前一致）
      ...(workspaceBackend ? { workspaceBackend } : {}),
      // 自动摘要固化的缓存键：必须是**会话** id，不是 workspace.id（一个工作区下多个会话）
      conversationId: conversation.id,
      // 重启后内存缓存是空的：用会话里落盘的固化点接上，摘要重算后再写回
      ...(conversation.autoSummary
        ? {
            autoSummarySeed: {
              keepFromMessageId: conversation.autoSummary.keepFromMessageId,
              text: conversation.autoSummary.text
            }
          }
        : {}),
      onAutoSummary: (entry) =>
        domain.setAutoSummary(conversation.id, { ...entry, createdAt: Date.now() }),
      history: historyForTurn(conversation, userMessage),
      model: modelConfig!,
      skills,
      projectDoc,
      permissionMode,
      ...(backend === 'builtin' && reasoningEffort ? { reasoningEffort } : {}),
      // 运行中活取权限档：用户在整轮中途切档时闸门立刻按新档裁决（改档端点改的就是 run 上这个字段）
      getPermissionMode: () => run.permissionMode,
      requestConfirm,
      // 附件 URL 绝对化 / 可取得化：内置存储拼绝对地址（FIZZ_PUBLIC_BASE_URL 优先，
      // 否则按请求 origin），插件上传源一般不实现（它交回来的就是公网绝对地址）→ 原样返回
      resolveFileUrl: (url) => resolveUploadModelUrl(url, opts?.origin ?? ''),
      /**
       * 附件投递：没有公网地址（桌面端 / 局域网 / 本地开发）时把文件读回来内联发送，
       * 云端 provider 不再回连 `127.0.0.1`。判据与环境变量见 `upload/attachments.ts`。
       */
      resolveAttachment: createAttachmentResolver(opts?.origin ?? ''),
      // 单条命令停止表（POST /api/chat/command/stop 命中它；run 级，收尾时清空）
      commandStops: run.commandStops,
      /**
       * 后台命令（`execute_command` 的 `runInBackground`）：登记成一条**属于本会话**的
       * 后台任务，进程归登记表持有 —— 本轮的 abort 与超时都打不到它，这正是「dev server
       * 活过这一轮」的实现方式。
       *
       * 进程用 `spawnBackgroundShell` 起（与前台共用同一份 shell 判定，别在服务端抄第二份），
       * 输出按行写进任务日志：用户在输入框上方那一行展开，看到的就是这条进程的真实输出。
       *
       * 远端工作区不传：后台进程表在本机，远端命令没有对应的进程表（工具侧也会按
       * `backend.kind === 'remote'` 明确回绝）。
       */
      ...(remoteWorkspace
        ? {}
        : {
            onBackgroundCommand: async ({ command, cwd, title }: { command: string; cwd: string; title: string }) => {
              const handle = startBackgroundTask({
                sessionId: conversation.id,
                kind: 'agent-command',
                title,
                detail: cwd,
                run: async (signal, log) => {
                  log(`$ ${command}`)
                  // 块边界不等于行边界：两条流各留一个「半行」缓冲，收场时把剩下的吐出来
                  const pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
                  const write = (stream: 'stdout' | 'stderr', chunk: string): void => {
                    const parts = (pending[stream] + chunk).split('\n')
                    pending[stream] = parts.pop() ?? ''
                    for (const line of parts) log(line)
                  }
                  const shell = spawnBackgroundShell(command, cwd, {
                    signal,
                    onOutput: (stream, chunk) => write(stream, chunk)
                  })
                  const exit = await shell.done
                  for (const stream of ['stdout', 'stderr'] as const) {
                    if (pending[stream].trim()) log(pending[stream])
                  }
                  // 三种收场都要让登记表知道为什么结束（它据此判 done / failed / canceled）
                  if (exit.error) throw new Error(`启动失败：${exit.error}`)
                  if (exit.killed) throw new Error('已停止')
                  if (exit.code !== 0) throw new Error(`退出码 ${exit.code}`)
                }
              })
              return { id: handle.id }
            }
          }),
      plugins,
      /**
       * 浏览器工具（browser_*）：**内置这套真的挂上了**才追加系统提示词里那段浏览器说明。
       * 会话开关关掉、或被外部 MCP 的同名工具全顶掉时都是 false
       * （见上面 browserTools 的让位逻辑）。
       */
      browser: browserToolNames.length > 0,
      /**
       * 子任务（subagent）：只在 内置后端生效，且**要用户在设置里打开过**。
       * 缺省 / 空数组 = 不挂 `agents`，与没有这个能力时逐字节一致（runAgent 与
       * `newAgent` 都不传这个字段，引擎的派活工具压根不会生成）。
       * ACP 会话走下面的 runAcpAgent：外部 agent 自己管编排，不该被我们塞子任务。
       */
      subagents: backend === 'builtin' && !isCollab ? subagentSettings.enabled : [],
      ...(subagentDefinitions.length > 0 ? { subagentDefs: subagentDefinitions } : {}),
      ...(Object.keys(subagentDefinitionModels).length > 0 ? { subagentDefinitionModels } : {}),
      ...(backend === 'builtin' && subagentModel ? { subagentModel } : {}),
      // 步数上限同理只在真会派活时下传：没启用子任务时这两个字段都是垃圾
      ...(backend === 'builtin' && !isCollab && subagentSettings.maxSteps
        ? { subagentMaxSteps: subagentSettings.maxSteps }
        : {}),
      /**
       * 上下文窗口按「这一轮真正选中的模型」解析：`resolveModelConfig` 已经把
       * `model` 覆盖成选中那个 id，所以直接用 `modelConfig.model` 查表即可。
       * 模型没单独配窗口时退回环境变量兜底 / 默认 200k（见 defaultContextWindowFromEnv）。
       */
      contextWindow: resolveContextWindow(
        modelConfig!.models,
        modelConfig!.model,
        defaultContextWindowFromEnv()
      ),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(toolCallConcurrency !== undefined ? { toolCallConcurrency } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(toolIntent !== undefined ? { toolIntent } : {}),
      signal: run.controller.signal,
      onEvent,
      // 运行中插话：每个工具步骤边界从 run 的收件箱消费一条（agent 侧注入并强制续跑）
      pollSteer: async () => run.steerInbox.shift() ?? null,
      // 上下文压缩：开始 / 增量 / 结束各推一帧。流式只用于展示，检查点仍由
      // compactHistory 在完整摘要校验通过后落盘（中途失败 / 中止不会写半份）。
      onContextCompactionStart: (info) =>
        emit(run, {
          type: 'event',
          requestId,
          event: { type: 'context-compaction-start', ...info }
        }),
      onContextCompactionDelta: (info) =>
        emit(run, {
          type: 'event',
          requestId,
          event: { type: 'context-compaction-delta', ...info }
        }),
      // 只有一种压缩（摘要），没有「清旧工具结果」那层 —— 那一层会改动请求前缀。
      onContextCompressed: (info) =>
        emit(run, {
          type: 'event',
          requestId,
          event: { type: 'context-compressed', ...info }
        })
      })
    } finally {
      // 主轮结束（成功 / 失败 / 中止）都收掉子任务并落一次快照
      collabRuntime?.close()
      delete run.collabCancel
    }
  }

  /**
   * ACP 的附件：`session/prompt` 收的是 `ContentBlock[]`，图片只能**内联 base64**
   * （agent 是同机子进程，协议里没有「给我个 URL」这条路，`resource_link` 又要 agent 支持
   * `embeddedContext`）。所以在这里就把字节读出来 —— 读的动作在 `acpPromptAttachments`。
   *
   * 能力闸：agent 明说 `promptCapabilities.image === false` 就当场拒。放它到协议层再报
   * 一个 JSON-RPC invalid params，用户只会看到一句听不懂的话，也不知道是自己带了图。
   * `undefined`（还没连过 / 老版本不广告）放行 —— 首次使用按「能发就发」处理。
   */
  let acpTurnAttachments: Awaited<ReturnType<typeof acpPromptAttachments>> | undefined
  if (backend === 'acp' && acpAgent && files.length > 0) {
    if (
      getAcpImageSupport(acpAgent.id) === false &&
      files.some((file) => file.mediaType.startsWith('image/'))
    ) {
      return rejectTurn(
        400,
        `「${acpAgent.name}」不支持图片输入，请改用文字描述，或把文件放进工作区让我用工具读`,
      )
    }
    acpTurnAttachments = await acpPromptAttachments(files)
  }

  const runner: Promise<RunAgentResult> =
    backend === 'acp' && acpAgent
      ? runAcpAgent({
          workspace,
          history: [...conversation.messages, userMessage],
          agent: acpAgent,
          conversationId: conversation.id,
          requestId,
          confirmTimeoutMs,
          ...(requestedModelId ? { modelId: requestedModelId } : {}),
          // 会话记住的权限档 / 思考档：每轮发送前幂等下发（load 之后 agent 重置了也会补回）
          ...(conversation.acpModes?.current ? { modeId: conversation.acpModes.current } : {}),
          ...(conversation.acpThoughtLevel?.current
            ? { thoughtLevel: conversation.acpThoughtLevel.current }
            : {}),
          requestPermission,
          onEvent,
          signal: run.controller.signal,
          // 会话绑定了 agent 侧 session（轮次被停过 / 服务重启过）→ 用 session/load
          // 恢复上下文，而不是 session/new —— acp 对话不再失忆
          ...(conversation.acpSessionId ? { loadSessionId: conversation.acpSessionId } : {}),
          // 本轮随消息发的图片（缺省 = 纯文本，行为与之前一致）
          ...(acpTurnAttachments?.attachments.length
            ? { attachments: acpTurnAttachments.attachments }
            : {}),
          // 有附件没带上时给 agent 一句说明，别让它以为用户只发了文字
          ...(acpTurnAttachments?.note ? { attachmentNote: acpTurnAttachments.note } : {}),
          // 会话就绪（session/new 建成 或 session/load 恢复）：绑定 sessionId + 回写广告的档位
          onSessionCreated: (info) => {
            domain.bindAcpSession(conversation.id, info.sessionId)
            refreshAcpSessionState(conversation.id, acpAgent.id)
            // initialize 顺带探测到了「这个 agent 收不收图」→ 让 Agent 列表那份快照跟着更新，
            // 前端的回形针闸门就靠它（见 ACP 列表 provider）
            markDirty(['acpAgents'])
          }
        })
      : runAiSdkTurn()

  const persistAssistant = (parts: AgentChatMessage['parts']): void => {
    // 协作会话没有「主智能体的一条回复」：把它已产出的每个 Agent 回复分别落盘。
    // 运行时连结果都没来得及给出（抛错）时走下面的普通错误落盘路径。
    if (collabTurnResult) {
      persistCollabTurn()
      return
    }
    // acp 会话的消息在 agent 侧，本地不落盘；但收尾要补进进程内视图，
    // 这样「刚跑完就刷新」不会因为会话已 idle 而只能等下一次 session/load。
    if (isAcpConversation) {
      appendAcpTranscript(conversation.id, [
        {
          id: input.assistantMessageId ?? `a-${Date.now()}`,
          role: 'assistant',
          parts,
          createdAt: Date.now(),
          ...(turnUsage ? { usage: turnUsage } : {}),
          // ACP 没有 token 用量，耗时单独挂（前端折叠条抬头报「已工作 N 秒」靠它）
          ...(turnDurationMs != null ? { durationMs: turnDurationMs } : {})
        }
      ])
      return
    }
    /** 客户端给的这一轮助手消息 id（缺省自生成 —— 见 persistAssistantMessage） */
    const baseId = input.assistantMessageId
    if (steerBoundaries.length === 0) {
      persistAssistantMessage(
        conversation.id,
        parts,
        turnUsage,
        baseId,
        turnDurationMs,
        turnStop
      )
      return
    }
    /**
     * 有运行中插话：按注入边界把 parts 切成多段，与插话 user 消息交错、**一次**原子
     * 落盘 —— 顺序即真实时序（`[assistant(前段), user, assistant(后段)]`），下一轮的
     * 模型上下文才自洽（模型看到的是「自己先做了 A，被插话纠正后做了 B」）。
     * usage 是整轮统计，挂最后一段 assistant 上。
     *
     * 各段 id 必须与客户端用**同一份推导**（contracts 的 `assistantSliceId`）：客户端把
     * 第 n 条插话之后的增量写进 `assistantSliceId(base, 那条插话的 id)`，这里落盘用同一个，
     * 收尾换权威历史时才不会把刚跑完的子树整棵重挂载。
     *
     * ⚠️ `segIndex` 数的是**段序**（第 0 段 = 第一条插话之前的部分，尾段紧随其后），
     * 与「哪些段非空」无关 —— 所以下面跳过空段也不会让它后面的段错位。客户端那边按
     * 插话消息 id 建占位，同样不依赖段序，两边才对得上。
     */
    const segmentId = (segIndex: number): string | undefined => {
      if (!baseId) return undefined
      if (segIndex === 0) return baseId
      return assistantSliceId(baseId, steerBoundaries[segIndex - 1].message.id)
    }
    const messages: AgentChatMessage[] = []
    let cursor = 0
    let segIndex = 0
    for (const boundary of steerBoundaries) {
      const segment = parts.slice(cursor, boundary.index)
      if (segment.length) {
        messages.push({
          id: segmentId(segIndex) ?? `a-${Date.now()}-${messages.length}`,
          role: 'assistant',
          parts: segment,
          createdAt: Date.now()
        })
      }
      messages.push(boundary.message)
      cursor = boundary.index
      segIndex += 1
    }
    const tail = parts.slice(cursor)
    if (tail.length || messages.length === 0) {
      messages.push({
        id: segmentId(segIndex) ?? `a-${Date.now()}-${messages.length}`,
        role: 'assistant',
        parts: tail,
        createdAt: Date.now(),
        // 整轮耗时与 `usage` 同口径：挂在尾段（有 usage 时它自带耗时，这里不重复）
        ...(turnUsage || turnDurationMs == null ? {} : { durationMs: turnDurationMs }),
        // 撞上限的标记同样挂尾段：它描述的是「这一轮怎么结束的」，不是某一段的事
        ...(turnStop ?? {})
      })
    }
    try {
      domain.appendMessages(conversation.id, messages, undefined, turnUsage)
    } catch (err) {
      console.error('[server] 助手回复落盘失败：', err)
    }
  }

  /**
   * 协作轮的落盘：每个 Agent 的回复是一条带 `agentId/agentName` 的助手消息。
   *
   * 一条也没有时（全体静默跳过 / 没有 Agent）补一条提示，避免用户只看到自己那条
   * 消息、以为「什么都没发生」。中止且没有产出时不补提示。
   */
  const persistCollabTurn = (): void => {
    const result = collabTurnResult
    if (!result) return
    if (result.replies.length > 0) {
      const messages: AgentChatMessage[] = result.replies.map((reply, index) => ({
        id: `collab-a-${Date.now()}-${index}-${reply.agentId}`,
        role: 'assistant',
        parts:
          reply.parts.length > 0
            ? reply.parts
            : [{ type: 'text', text: reply.text }],
        createdAt: reply.createdAt,
        ...(reply.usage ? { usage: reply.usage } : {}),
        agentId: reply.agentId,
        agentName: reply.agentName
      }))
      domain.appendMessages(conversation.id, messages, undefined, turnUsage)
      return
    }
    if (run.controller.signal.aborted) return
    const text = result.errors.length
      ? `（本轮没有 Agent 完成：${result.errors
          .map((item) => `${item.agentName}：${item.error}`)
          .join('；')}）`
      : '（这条消息没有 Agent 接手）'
    persistAssistantMessage(
      conversation.id,
      [{ type: 'text', text }],
      undefined,
      input.assistantMessageId,
      turnDurationMs,
      undefined
    )
  }

  void runner
    .then((result) => {
      persistAssistant(assistantParts)
      if (result.finishReason === 'error' && result.error) {
        console.error('[server] 这一轮出错：', result.error)
      }
      runError = result.error
      return result.finishReason
    })
    .catch((err: unknown) => {
      const message = describeError(err).message
      console.error('[server] 对话执行失败：', err)
      persistAssistant([errorPart(message)])
      emit(run, { type: 'event', requestId, event: { type: 'error', message } })
      runError = message
      return 'error'
    })
    .then((finishReason) => {
      gate.releaseAll()
      clientGate.releaseAll()
      followupGate.releaseAll()
      // 单条命令停止表收场：run 结束后没有「在跑的命令」可停（留着只是延迟释放）
      run.commandStops.clear()
      // 插话收尾兜底的**广播段**（spec §1.4/§1.5）：剩余插话还没被任何边界消费。
      // ⚠️ 必须在 finishRun 之前发 —— `emit` 对已结束的 run 是 no-op（chat-run.ts），
      // finish 之后就再也送不到客户端了。
      if (!run.controller.signal.aborted && run.steerInbox.length) {
        if (finishReason === 'error') {
          // 与队列「失败停链」同语义：失败后不自动跑。逐条落成普通 user 消息并广播，
          // 用户可编辑重发。
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
          // 即将由兜底起新一轮：先广播让客户端立刻渲染（落盘用同一条 id，见 drainSteerInbox）
          for (const msg of run.steerInbox) {
            emit(run, { type: 'event', requestId, event: { type: 'user-injected', message: msg } })
          }
        }
      }
      finishRun(run, finishReason)
      // 运行态清单与「跑完了」都在 finishRun 之后发：此刻正文已落盘，客户端收到就能直接
      // 去拉权威历史（发早了会拉到半截）
      markDirty(['activeRuns'])
      const excerpt = collabExcerpt ?? excerptOf(assistantParts)
      emitServerEvent({
        type: 'conversation:finished',
        conversationId: conversation.id,
        requestId,
        title: conversationTitle,
        finishReason,
        ...(runError ? { error: runError } : {}),
        // 撞步数上限：通知文案据此换成「已用满 N 步」，别让用户以为这一轮是正常答完的
        ...(turnStop ?? {}),
        ...(excerpt ? { excerpt } : {}),
        finishedAt: Date.now()
      })
      // 广播完才起新一轮：兜底轮是独立的 run（自己的帧日志），这里不 await ——
      // 客户端通过 activeRuns 快照看到它，点开会话即可接上（与定时任务起的会话同一形态）
      if (finishReason !== 'error' && finishReason !== 'aborted') {
        drainSteerInbox(run, conversation, permissionMode).catch((err: unknown) =>
          console.error('[server] 插话兜底异常：', err)
        )
      }
    })

  run.controller.signal.addEventListener('abort', () => {
    gate.releaseAll()
    clientGate.releaseAll()
    followupGate.releaseAll()
    // 用户点了停止：意图是终止 —— 剩余插话一律丢弃（收尾链的兜底也会因 aborted 跳过）
    run.steerInbox.length = 0
  })

  return { ok: true, run }
}
