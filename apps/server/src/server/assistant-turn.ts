/**
 * AI 助手的一轮对话启动服务：与 `chat-turn.ts` 同构，但**完全无状态**。
 *
 * ## 助手没有「多会话」概念
 *
 * - **服务端不落盘**：没有会话清单、没有历史存储。历史只暂存在**客户端内存**里，
 *   每轮随 `history` 带上来，服务端拼上本轮 `text` 直接喂模型（见 `AssistantSendInput`）；
 * - **每次打开面板就是一个新会话**：客户端换一个 `sessionId` 即可，服务端不关心它是什么、
 *   也不认识它 —— 它只是这一轮 run 在共享注册表里的键（断线重接 / 审批答复按它找）；
 * - 助手是**跨项目**的：不挂 workspace、不落会话树、不发 `conversation:*` 广播。
 *
 * ## 工具集按 `scope` 二选一（两组互斥，profile 在 `profiles/`）
 *
 * - `project`（缺省）：`profiles/project-assistant.ts` —— 项目 / 模型 / MCP / ACP 配置工具
 *   加 `web_fetch`。**一个文件 / 命令类工具都不挂**：助手是跨项目的，没有唯一工作区根，
 *   `read` / `write` / `edit` / `glob` / `grep` / `git_read` / `shell` / `todo` 全部缺席。
 *   全局配置工具也只在这一支里（它们改的是网关 / key / 模型清单、MCP server 清单、
 *   ACP agent 清单，不属于任何单个工作区）；
 * - `terminal`：`profiles/terminal-assistant.ts` —— 绑定远端主机的文件工具与独立 SSH exec。
 *
 * 两套 profile 的产物都交给 `runAgent` 的同一条装配管线（审批壳 / 钩子 / 提示词渲染），
 * 与主会话没有第二条链路。
 *
 * 审批走共用的 `createConfirmGate`；run 挂进共享的 run 注册表（`chat-run.ts`），
 * 断线接回（POST /api/chat/stream?requestId=）与审批答复（POST /api/chat/confirm）复用现有端点。
 *
 * ⚠️ 这里刻意**只放内存**：run 随进程重启丢失，本来也没有历史需要保留。
 */
import type { AssistantSendInput } from '@fizz/contracts/agent-api'
import { resolveContextWindow } from '@fizz/contracts/types'
import type { AgentChatMessage, AgentStreamEvent, TurnUsage } from '@fizz/contracts/types'
import { defaultContextWindowFromEnv, runAgent, type RunAgentResult } from '@fizz/agent'
import { probeAcpModels } from '@fizz/acp'
import { probeMcpServerTools } from '@fizz/mcp'
import {
  buildAssistantInstructions as buildProjectAssistantInstructions,
  buildProjectAssistantAssembly
} from './profiles/project-assistant'
import { buildTerminalAssistantAssembly } from './profiles/terminal-assistant'
import { domain, markDirty } from './state'
import { probeModelsFromUpstream } from './model-probe'
import { refreshPluginModels } from './plugin-models'
import { createConfirmGate } from './confirm-gate'
import { agentPrefs } from './prefs'
import { createAssistantBackend, startAssistantCommand, waitAssistantCommand } from './ssh/assistant-backend'
import { sftpService } from './ssh/sftp'
import { errorPart, foldEventIntoParts } from './agent-parts'
import { createProject, createWorktree, getDefaultProjectsRoot, isInsideProjectsRoot, listDirs, removeProject } from './projects'
import {
  createTaskTriggerFromTool,
  deleteTaskTriggerFromTool,
  listTaskTriggersForTool,
  setTaskTriggerEnabledFromTool,
  updateTaskTriggerFromTool
} from './task-triggers'
import { createPluginFile } from './plugin-create'
import { detectAcpAgents } from './acp-detect'
import { acpProbeCwd } from './acp-probe'
import {
  createRun,
  emit,
  finishRun,
  releaseConversationRunStart,
  reserveConversationRunStart,
  type ChatRun
} from './chat-run'
import { describeError } from './lib/http'
import { isAiPermissionMode, resolvePermissionMode } from './permission-mode'

export type StartAssistantTurnResult =
  | { ok: true; run: ChatRun }
  | { ok: false; status: 400 | 404 | 409 | 500; message: string }

/**
 * 项目管理助手的系统提示词（兼容入口）。
 *
 * 正文在 `profiles/project-assistant.ts`（那里不读全局状态，便于单测注入）；
 * 这里保留无参签名，给「用当前 domain 快照拼一份」的调用方与测试用。
 */
export function buildAssistantInstructions(): string {
  return buildProjectAssistantInstructions(domain.listWorkspaces(), getDefaultProjectsRoot())
}

/**
 * 启动一轮助手对话并立刻返回:run 已登记、runner 已在后台跑。
 * 调用方(POST /api/assistant)拿 `run` 接到 SSE 上(`pipeRun`)。
 */
export async function startAssistantTurn(input: AssistantSendInput): Promise<StartAssistantTurnResult> {
  const text = input.text?.trim()
  if (!input.sessionId || !text) {
    return { ok: false, status: 400, message: '缺少 sessionId 或 text' }
  }
  if (input.permissionMode !== undefined && !isAiPermissionMode(input.permissionMode)) {
    return { ok: false, status: 400, message: 'permissionMode 非法' }
  }
  if (input.scope !== undefined && input.scope !== 'project' && input.scope !== 'terminal') {
    return { ok: false, status: 400, message: 'scope 非法' }
  }
  if (!reserveConversationRunStart(input.sessionId)) {
    return { ok: false, status: 409, message: '这个助手会话正在启动或回复中，请等待当前轮结束' }
  }
  try {
    return await startAssistantTurnReserved(input, text)
  } finally {
    releaseConversationRunStart(input.sessionId)
  }
}

async function startAssistantTurnReserved(
  input: AssistantSendInput,
  text: string
): Promise<StartAssistantTurnResult> {
  const scope = input.scope ?? 'project'
  // 在创建 run 前完成目标校验，失败时不遗留占着 sessionId 的活跃 run。
  let remote: { backend: ReturnType<typeof createAssistantBackend>; hostLabel: string } | undefined
  if (scope === 'terminal') {
    const target = input.remoteTarget
    if (!target || typeof target.hostId !== 'string' || !target.hostId.trim()) {
      return { ok: false, status: 400, message: '终端助手需要绑定 SSH 主机，请先选择执行目标' }
    }
    const host = domain.listSshHosts().find((h) => h.id === target.hostId)
    if (!host || host.kind === 'local') {
      return { ok: false, status: 404, message: 'SSH 主机不存在或已被删除，请重新选择执行目标' }
    }
    if (target.cwd !== undefined && (typeof target.cwd !== 'string' ||
      (target.cwd !== '' && !target.cwd.startsWith('/')) || /[\0\r\n]/.test(target.cwd))) {
      return { ok: false, status: 400, message: '工作目录必须是远端 POSIX 绝对路径' }
    }
    try {
      const cwd = await sftpService.realpath(host.id, target.cwd)
      const stat = await sftpService.stat(host.id, cwd)
      if (stat?.type !== 'dir') {
        return { ok: false, status: 400, message: '远端工作目录不存在或不是目录' }
      }
      remote = {
        backend: createAssistantBackend(host.id, cwd),
        hostLabel: `${host.name} (${host.username}@${host.host}:${host.port})`
      }
    } catch (err) {
      return { ok: false, status: 400, message: describeError(err).message }
    }
  }

  // 插件注册的模型：解析前刷新（与 chat-turn 同一口径）
  await refreshPluginModels()

  // 模型:请求带了 configId 就严格解析(缺 modelId 用该配置第一个;悬空 / 不在清单给人话,
  // 不静默回退);没带 = 第一份带模型的配置的第一个模型(老客户端 / 未选时的缺省)。
  // 解析出的这一对(配置 id + 模型 id)也是 `create_task_trigger` 的默认目标 ——
  // 到点无人值守跑的那一轮,继承助手自己正在用的模型(新会话开箱就能发消息)。
  let effectiveTarget: { configId: string; modelId: string } | undefined
  let modelConfig
  if (input.configId?.trim()) {
    const view = domain.listModels().find((m) => m.id === input.configId!.trim())
    if (!view) {
      return { ok: false, status: 400, message: '所选模型配置不存在或已被删除,请在助手面板重新选择模型' }
    }
    const modelId = input.modelId?.trim() || view.models[0]?.id
    if (!modelId || !view.models.some((m) => m.id === modelId)) {
      return {
        ok: false,
        status: 400,
        message: `模型配置「${view.name}」下没有「${input.modelId ?? ''}」这个模型,请重新选择`
      }
    }
    try {
      modelConfig = domain.resolveModelConfig(view.id, modelId)
    } catch (err) {
      const { message } = describeError(err)
      return { ok: false, status: 400, message }
    }
    effectiveTarget = { configId: view.id, modelId }
  } else {
    const configView = domain.listModels().find((m) => m.models.length > 0)
    if (!configView) {
      return { ok: false, status: 400, message: '没有可用模型,请先在「设置 → 模型」里添加' }
    }
    try {
      modelConfig = domain.resolveModelConfig(configView.id, configView.models[0]!.id)
    } catch (err) {
      const { message } = describeError(err)
      return { ok: false, status: 400, message }
    }
    effectiveTarget = { configId: configView.id, modelId: configView.models[0]!.id }
  }

  const userMessage: AgentChatMessage = {
    id: `u-${Date.now()}`,
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: Date.now()
  }
  /**
   * 历史来自**客户端**（本地内存），服务端不留 —— 这就是「消息只暂存在本地」的实现。
   * 拼上本轮这条 user 消息后直接喂模型。
   */
  const history = [...(input.history ?? []), userMessage]

  const run = createRun({ conversationId: input.sessionId, workspaceId: '', backend: 'builtin' })
  markDirty(['activeRuns'])

  /**
   * 服务端权威的一份偏好（`CoreData.prefs`）：请求体给了就用请求体（见下面的
   * `permissionMode` / `maxRetries`），没给就落到这里 —— 与 `chat-turn.ts` 同一口径。
   */
  const prefs = agentPrefs()

  // 审批:与聊天同一套四 kind 选项与超时;不发 conversation:* 广播(助手没有跨页场景)
  const gate = createConfirmGate({
    run,
    ownerKey: input.sessionId,
    title: remote ? `SSH 助手 · ${remote.hostLabel}` : '项目助手',
    confirmTimeoutMs: prefs.confirmTimeoutMs
  })

  /**
   * 这一轮的作用域:**两组工具互斥**,由请求显式声明(见 `AssistantSendInput.scope`)。
   *
   * - `project`(缺省):项目管理助手 —— 只有项目工具;
   * - `terminal`:终端标签内嵌的助手 —— 只有远端文件与命令工具。
   *
   * 为什么互斥而不是「都挂上,用不到的模型自己不用」:工具就是模型的行动能力边界。
   * 全局助手挂着一堆远端文件与命令工具,模型迟早会去试;而那条终端根本不是这个面板
   * 的语境(它属于某个终端标签)。反过来,一条绑定终端的会话里出现 create_project,
   * 用户看到的就是「让助手看下日志,它却在建目录」。边界交给装配层,不交给提示词。
   */

  /**
   * 这一轮的工具权限档(客户端在助手输入框左侧那颗 pill 上选的;没带 = `confirm`)。
   *
   * 两种作用域**同一套三档**,别按一个想:
   * - `terminal`(远端文件与命令):写文件与执行命令走 `guardWrite`；
   * - `project`(项目 / 模型 / MCP / ACP 配置工具):闸在 `guardMutation`。
   * 两边都是 `readonly` 拒绝、`confirm` 弹卡、`full` 直接放行 —— 用户在输入框选的哪一档，
   * 对助手的所有工具生效（2026-11 反馈过「部分工具不受 pill 控制」，就是因为
   * `guardMutation` 从前只认 readonly）。档位用 getter 现取，中途切换立刻生效。
   */
  const permissionMode = resolvePermissionMode(input.permissionMode, prefs.permissionMode)
  /**
   * 模型请求自动重试次数（0 = 不限制）；非法值 = 不传，交给 runAgent 用缺省。
   *
   * **必须从请求里取**。这条链路早先漏了这个字段，于是助手恒按 `DEFAULT_MAX_RETRIES`（2）
   * 重试 —— 用户在设置页填 20 也没用：开头两次用完，会话中途再失败就直接报错。与主会话
   * `chat-turn.ts` 的口径保持一致（那里同样做了一遍非负整数校验）。
   */
  const maxRetries =
    typeof input.maxRetries === 'number' && Number.isFinite(input.maxRetries) && input.maxRetries >= 0
      ? Math.round(input.maxRetries)
      : prefs.maxRetries
  // 起始活权限档写回 run：上面 createRun 缺省是 confirm，这里用请求里的档位对齐，
  // 之后 POST /api/chat/permission 改的也是它（工具闸每次经 getter 现取）
  run.permissionMode = permissionMode

  const assistantParts: AgentChatMessage['parts'] = []
  let turnUsage: TurnUsage | undefined

  /**
   * 两套身份的装配都在 `profiles/` 里（提示词 + 工具集），这里只把服务接上：
   * - `terminal`：绑定这轮固定目标的 SSH 文件与命令工具；
   * - `project`：项目 / 模型 / MCP / ACP 配置工具 + `web_fetch`，
   *   **一个文件 / 命令类工具都不挂**（助手是跨项目的，没有唯一工作区根）。
   */
  const assemble =
    remote
      ? () =>
          buildTerminalAssistantAssembly({
            hostLabel: remote.hostLabel,
            backend: {
              ...remote.backend,
              exec: (command, options = {}) => waitAssistantCommand({
                backend: remote.backend,
                sessionId: input.sessionId,
                hostLabel: remote.hostLabel,
                command,
                options
              })
            },
            options: {
              permissionMode,
              getPermissionMode: () => run.permissionMode,
              requestConfirm: (req) => gate.requestConfirm({
                ...req,
                intent: `SSH ${remote.hostLabel} · ${remote.backend.root}${req.intent ? ` · ${req.intent}` : ''}`
              }),
              onCommandStart: (id, stop) => run.commandStops.set(id, stop),
              onCommandEnd: (id) => { run.commandStops.delete(id) },
              onCommandOutput: (id, stream, delta) => onEvent({
                type: 'tool-output-delta', toolCallId: id, stream, delta
              }),
              onBackgroundCommand: async ({ command, cwd }) => {
                const task = startAssistantCommand({
                  backend: remote.backend, sessionId: input.sessionId,
                  hostLabel: remote.hostLabel, command, options: { cwd, timeoutMs: 0 }
                })
                return { id: task.id }
              }
            }
          })
      : () =>
          buildProjectAssistantAssembly({
            projects: {
              createProject,
              removeProject,
              createWorktree,
              getDefaultProjectsRoot,
              isInsideProjectsRoot,
              listDirs
            },
            domainApi: {
              listWorkspaces: () => domain.listWorkspaces(),
              getWorkspace: (id) => domain.getWorkspace(id)
            },
            // 定时任务:创建时模型绑定继承助手本轮正在用的模型(触发会话无人值守,用不了界面选择);
            // 改 / 删 / 启停复用同一份服务端逻辑(与 HTTP 路由同源)
            triggers: {
              create: (input) => Promise.resolve(createTaskTriggerFromTool(input, effectiveTarget)),
              list: (workspaceId) => listTaskTriggersForTool(workspaceId),
              update: (input) => Promise.resolve(updateTaskTriggerFromTool(input)),
              remove: (id) => deleteTaskTriggerFromTool(id),
              setEnabled: (id, enabled) => setTaskTriggerEnabledFromTool(id, enabled)
            },
            plugins: { create: createPluginFile },
            models: {
              list: () => domain.listModels(),
              save: (input) => domain.saveModel(input),
              remove: (id) => domain.deleteModel(id),
              // 与设置页的探针路由同源：空 key 复用已存密钥，解密只在服务端
              probe: (input) => probeModelsFromUpstream(input)
            },
            mcp: {
              list: () => domain.listMcpServers(),
              save: (input) => domain.saveMcpServer(input),
              remove: (id) => domain.deleteMcpServer(id),
              // 与「设置 → MCP」那颗扳手按钮同源：连上、列完、立刻断开
              probe: (server) => probeMcpServerTools(server)
            },
            acp: {
              list: () => domain.listAcpAgents(),
              save: (input) => domain.saveAcpAgent(input),
              remove: (id) => domain.deleteAcpAgent(id),
              // 与设置页「一键添加」同一份探测（见 ./acp-detect.ts）
              detect: detectAcpAgents,
              // 一次性起 agent 进程问模型清单（问完就收掉），与设置页的能力探针同源
              probeModels: async (id) => {
                const agent = domain.resolveAcpAgent(id)
                const workspacePath = acpProbeCwd()
                const result = await probeAcpModels({
                  agent,
                  ...(workspacePath ? { workspacePath } : {})
                })
                return result.options
              }
            },
            listWorkspaces: () => domain.listWorkspaces(),
            defaultProjectsRoot: getDefaultProjectsRoot(),
            permissionMode,
            getPermissionMode: () => run.permissionMode,
            requestConfirm: gate.requestConfirm
          })

  const onEvent = (event: AgentStreamEvent): void => {
    if (event.type === 'finish' && event.usage) turnUsage = event.usage
    foldEventIntoParts(assistantParts, event)
    emit(run, { type: 'event', requestId: run.requestId, event })
  }


  const runner: Promise<RunAgentResult> = runAgent({
    // 助手是跨项目的全局会话：没有工作区根，也不该为了复用运行时伪造一个
    scope: { kind: 'global', id: input.sessionId, name: 'AI 助手' },
    // 自动摘要固化的缓存键（助手会话也会聊很久，同样需要复用摘要）
    conversationId: input.sessionId,
    history,
    model: modelConfig,
    skills: [],
    permissionMode,
    requestConfirm: gate.requestConfirm,
    commandStops: run.commandStops,
    /**
     * 两套身份各自配套：terminal 只有终端提示词 + 终端工具，project 只有项目提示词 + 项目工具。
     * 装配产物统一走 `mountAssembly`（审批壳 / 钩子 / 提示词渲染与主会话同一条管线）。
     */
    assemble,
    contextWindow: resolveContextWindow(
      modelConfig.models,
      modelConfig.model,
      defaultContextWindowFromEnv()
    ),
    // 客户端偏好（设置页的「模型请求重试」）；不传 = 缺省 2 次
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    /**
     * 设置里的「工具意图」是**全局**偏好（设置 → AI → 偏好）。不传这个字段
     * `runAgent` 会按缺省开启处理 —— 助手这条链原来就是漏传，于是设置里关掉后
     * `intent` 仍然被注入进每个工具的 schema。与 `chat-turn` 同一口径。
     */
    ...(prefs.toolIntent !== undefined ? { toolIntent: prefs.toolIntent } : {}),
    signal: run.controller.signal,
    onEvent
  })

  void runner
    .then((result) => {
      if (result.finishReason === 'error' && result.error) {
        console.error('[assistant] 这一轮出错:', result.error)
      }
      return result.finishReason
    })
    .catch((err: unknown) => {
      const message = describeError(err).message
      console.error('[assistant] 对话执行失败:', err)
      assistantParts.push(errorPart(message))
      emit(run, { type: 'event', requestId: run.requestId, event: { type: 'error', message } })
      return 'error'
    })
    .then((finishReason) => {
      gate.releaseAll()
      run.commandStops.clear()
      finishRun(run, finishReason ?? 'error')
      markDirty(['activeRuns'])
    })

  run.controller.signal.addEventListener('abort', () => {
    gate.releaseAll()
  })

  return { ok: true, run }
}
