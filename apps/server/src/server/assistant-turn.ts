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
 * ## 工具集按 `scope` 二选一（两组互斥）
 *
 * - `project`（缺省）：`buildProjectTools` + `buildModelTools` + `buildMcpTools`（经
 *   `setup` 覆盖装配 —— 不建文件工具，因为跨项目场景下文件工具的 root 语义不清晰）。
 *   模型 / MCP 配置工具也只在这一支里：它们改的是全局设置（网关 / key / 模型清单、
 *   MCP server 清单），不属于任何单个工作区；
 * - `terminal`：只挂客户端带上来的终端工具。
 *
 * 审批走共用的 `createConfirmGate`；run 挂进共享的 run 注册表（`chat-run.ts`），
 * 断线接回（POST /api/chat/stream?requestId=）与审批答复（POST /api/chat/confirm）复用现有端点。
 *
 * ⚠️ 这里刻意**只放内存**：run 随进程重启丢失，本来也没有历史需要保留。
 */
import type { AssistantSendInput } from '@fizz/contracts/agent-api'
import { isRemoteWorkspace, resolveContextWindow } from '@fizz/contracts/types'
import type { AgentChatMessage, AgentStreamEvent, AiPermissionMode, TurnUsage } from '@fizz/contracts/types'
import { defaultContextWindowFromEnv, runAgent, type RunAgentResult } from '@fizz/agent'
import { homedir } from 'node:os'
import {
  buildAcpTools,
  buildAgentTools,
  buildMcpTools,
  buildModelTools,
  buildProjectTools,
  buildWebFetchTool
} from '@fizz/tools'
import { probeAcpModels } from '@fizz/acp'
import { probeMcpServerTools } from '@fizz/mcp'
import { domain, markDirty } from './state'
import { probeModelsFromUpstream } from './model-probe'
import { refreshPluginModels } from './plugin-models'
import { createConfirmGate } from './confirm-gate'
import { agentPrefs } from './prefs'
import { buildClientToolset, createClientToolGate } from './client-tool-gate'
import { errorPart, foldEventIntoParts } from './agent-parts'
import { createProject, createWorktree, getDefaultProjectsRoot, isInsideProjectsRoot, listDirs, removeProject } from './projects'
import { createProjectConversation } from './conversation-create'
import {
  createTaskTriggerFromTool,
  deleteTaskTriggerFromTool,
  listTaskTriggersForTool,
  setTaskTriggerEnabledFromTool,
  updateTaskTriggerFromTool
} from './task-triggers'
import { createPluginFile } from './plugin-create'
import { detectAcpAgents } from './acp-detect'
import { createRun, emit, findActiveByConversation, finishRun, type ChatRun } from './chat-run'
import { describeError } from './lib/http'

export type StartAssistantTurnResult =
  | { ok: true; run: ChatRun }
  | { ok: false; status: 400 | 404 | 409 | 500; message: string }

/**
 * 助手里 `bash` 的默认工作目录：第一个已登记且有路径的项目，否则用户主目录。
 * 提示词与工具装配共用这一份 —— 两处各算一遍的话，模型以为的 cwd 和真正的 cwd 会不一致。
 */
function assistantBashRoot(): string {
  // 远端工作区的 path 是 SSH 主机上的 POSIX 路径，本地后端根本到不了；
  // dirMissing 的目录已经不在了，spawn 会直接 ENOENT。两者都跳过。
  return (
    domain
      .listWorkspaces()
      .find((w) => !!w.path && !isRemoteWorkspace(w) && !w.dirMissing)?.path || homedir()
  )
}

/**
 * 助手的系统提示词:**每轮现算**,把当前项目清单快照与默认根目录注进去 ——
 * 模型不用先查再动,「打开 xx」「删掉 yy」这类指令一步到位。
 */
export function buildAssistantInstructions(): string {
  const workspaces = domain.listWorkspaces()
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const lines = [
    '你是 Fizz 的项目管理助手,负责帮用户管理 Fizz 里的项目(工作区):查看清单、登记已有目录、新建目录、从 Git 克隆、打开项目、给项目建会话、创建 / 删除 worktree、删除项目、查看 / 创建 / 修改 / 删除 / 启停定时任务、给项目写插件,以及管理全局的模型配置(列 / 增 / 改 / 删网关与模型)、MCP 配置(列 / 增 / 改 / 删外部工具服务)与外部 Agent 配置(列 / 探测本机已装 / 增 / 改 / 删 ACP agent);也能用 bash 执行命令、web_fetch 查网页文档、todo_write 给多步骤任务列一份清单,bash 输出超长时用 read 续读。',
    `默认项目根目录:${getDefaultProjectsRoot()}。建议用户把项目放这里(根内创建免审批);用户明确要放别处时照做(根外创建会弹审批卡)。`,
    `当前时间:${now}(需要算 at 这一类一次性触发时刻时以它为准)。`,
    workspaces.length
      ? '当前已登记的项目(id / 名称 / 路径):'
      : '当前还没有登记任何项目。',
    ...workspaces.map(
      (w) =>
        `- [${w.id}] ${w.name} → ${w.path}${w.isWorktree && w.parentWorkspaceId ? `(worktree,父项目 ${w.parentWorkspaceId})` : ''}`
    ),
    '约定:',
    '- 信息不够时先用 list_projects / list_dirs 查,或直接问用户;不要猜路径;',
    '- open_project 只是通知界面切换项目;create_conversation 在项目下建一个空会话(不发言),界面随即打开它;',
    '- create_task_trigger 建定时任务:cron(5 段「分 时 日 月 周」,如 0 9 * * *)或 at(毫秒时间戳,必须晚于上面那个当前时间)二选一,prompt 是到点发给 agent 的需求原文;到点会以完全访问权限无人值守地跑 agent(会话用你当前这个模型);',
    '- list_task_triggers 查看已有定时任务(含 id / 排程 / 启用态 / 下次触发),按项目过滤;要改 / 删 / 启停某条前先用它拿 id;',
    '- update_task_trigger / delete_task_trigger / set_task_trigger_enabled 分别改内容、删除、启用停用:update 只传要改的字段(其余保持原样;给 cron 或 at 之一即把触发方式换成那种);',
    '- create_plugin 给项目写插件:你只给工具名 / 描述 / 行为脚本(execute 的函数体,必须以 return 给出一段文字),服务端套模板生成合法插件并当场加载一遍;插件下一轮对话生效,只给 Agent 加一个无参数工具;',
    '- 模型配置(每份 = 一个网关:服务商类型 + Base URL + API key)也能管:list_model_configs 看现状(拿 id);fetch_upstream_models 从上游拉可选模型 id;create_model_config / update_model_config / delete_model_config 管配置本身;add_model_entries / update_model_entry / remove_model_entry 管配置下的模型条目(增 / 改 / 删);',
    '- 拉模型优先给 fetch_upstream_models 传 id(复用已存配置的地址与密钥);只有本地网关(ollama / vllm)或用户在对话里刚给出 key 时才裸探;apiKey 只在用户明确提供时写进配置,不要编造、也不要在回复里回显;',
    '- 改模型配置等于改 agent 自己用的大脑:把 toolCall 关掉、把模型删光、把配置删掉都会让会话发不出去;动手前先一句话讲清影响,删配置 / 删模型 / 换 key 前先用 list_model_configs 确认目标是哪一个;所有改动下一轮对话生效(这一轮仍用原模型);',
    '- MCP(外部工具服务)配置也能管:list_mcp_servers 看现状(拿 id)、list_mcp_server_tools 连上它列一遍工具(用来验证配置对不对,连不上会把原因带回来)、create_mcp_server / update_mcp_server / delete_mcp_server 管配置本身(stdio 填命令 / 参数 / 环境变量,http·sse 填地址 / 请求头);',
    '- **MCP 配好不等于生效**:它是**按会话启用**的 —— 配完要让用户去会话输入框上方的扳手(MCP)里勾选,那个会话下一轮才会连接;你这一轮不会因此多出那些工具。别向用户承诺「已经能用了」,要明确说「已保存,去会话里勾选一下」;',
    '- MCP 的 stdio 命令是在**跑 Agent 的机器**上执行的,配错就是起不来:先问清用户要接哪个 server(本地命令还是远端地址),别自己编 npx 包名;环境变量 / 请求头里的 token 只在用户明确给出时写,回复里不要回显(工具结果也只给键名);',
    `- bash 能执行 shell 命令,默认工作目录是「第一个本机且存在的项目」(${assistantBashRoot()},没有可用项目时是用户主目录);命令里要读别的项目就用绝对路径或 cwd 参数,别猜相对路径。危险命令(rm -rf / git push --force 等)执行前先用一句话讲清影响:confirm 档会弹审批卡等用户点头,readonly 档直接拒绝。长输出会被落盘到工作区的 .fizz/tool-output/,结果里给出路径,用 read 加 offset / limit 续读。`,
    '- **只有 bash + read,没有写文件 / 编辑类工具**:助手是跨项目的,没有唯一工作区根目录,所以 write / edit / glob / grep / git_read 都不挂;要改某个项目里的文件,让用户去那个项目的会话里做。bash 的 run_in_background 在助手里没有后台通道,显式传 true 会被回绝;',
    '- web_fetch 抓网页(只认 http(s),超长正文会截断不落盘);查某个 CLI 的参数 / 排错时可以用它翻官方文档。todo_write 只在确实有三步以上时建清单,每次传完整清单;',
    '- 外部 Agent(ACP)配置也能管:list_acp_agents 看现状(拿 id)、detect_acp_agents 扫本机 PATH 上装了哪些(只读,不会装东西;用户说「我装了 Claude Code / Codex」但不确定命令时先用它)、probe_acp_models 连上某条列出它广告的模型(只读,但会起一次进程)、create_acp_agent / update_acp_agent / delete_acp_agent 管配置本身;',
    '- ACP 的启动命令在**跑 Agent 的机器**上 spawn 成子进程,args 必须是该 CLI 真实的 ACP 入口(gemini --acp / copilot --acp / opencode acp / codex-acp / claude-agent-acp 之类);不确定就别猜,先 detect 或问用户;Windows 上 npm 装的 CLI 常要 .cmd 后缀;',
    '- **ACP 配好也不等于用上**:它是**会话级**的后端选择 —— 要让用户**新建**一个会话、后端选「外部 Agent」、再挑这一条(已有会话的后端不能改)。「会话模型下拉里暴露哪几个模型」:先用 list_acp_agents 看该条现在暴露了哪些(models 字段),再用 probe_acp_models 拿候选(返回里 alreadyExposed 标了哪些已经配过,只把没配的传下去);**只是「再加一个」就用 update_acp_agent 的 addModels**(按 value 合并、不动已有),整份重设才用 models(会替换,空数组 = 一个都不列)。用户说「加」的时候绝不要传 models —— 那会把已配置的全换掉;',
    '- 定时任务的创建 / 修改 / 删除 / 启停与写插件都会弹审批卡,且产出或改动的是「以后会自动执行」的东西 —— 动手前先用一句话向用户讲清你要做什么;改 / 删定时任务前先 list 出来确认是哪一条;',
    '- 根目录外的创建、删除、worktree 变更都会弹审批卡等用户点头;',
    '- remove_project 缺省只移除登记、不删磁盘文件;deleteFiles=true 只对 worktree 项目生效;删之前必须向用户复述一次要删什么;',
    '- 操作完成或失败都要如实说明,失败时带上原因;用简洁的中文回复。'
  ]
  return lines.join('\n')
}

/**
 * 终端标签内嵌助手的系统提示词（`scope: 'terminal'`）。
 *
 * 与 `buildAssistantInstructions` 是**两套身份**：这里刻意不出现任何项目管理内容 ——
 * 那条会话绑定的是某一条终端，模型的任务是「看输出、跑命令」，不是管项目。
 * 项目能力在装配层就整组缺席了（见 `projectTools`），提示词只是把身份说清楚。
 */
export function buildTerminalAssistantInstructions(): string {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  return [
    '你是 Fizz 的终端助手，挂在一个终端标签上，服务的是**这个终端**。',
    `当前时间：${now}。`,
    '约定：',
    '- 你可以读取该终端的输出、执行命令、发送按键（工具清单见下），作用于用户眼前这一条终端；',
    '- 执行命令前先简要说明要做什么；优先使用安全、无破坏性的命令（先看状态再动手）；',
    '- 涉及删除文件、重启服务、修改配置等危险操作时，先说明影响再执行；',
    '- 命令是串行执行的：上一条跑完并读到输出后下一条才开始，不要并发下发；',
    '- 执行命令后终端原始输出即为事实依据；失败时结合输出排查原因再尝试，不要盲目重试同一条命令；',
    '- 交互式 / 前台程序（htop、top、vim、nano、less、man、watch、python、node 等）会占住终端不返回提示符：执行这类命令后不要继续输入新命令，先用发送按键退出（多数用 "q"，卡住用 "C-c"，个别用 "exit" / "C-d"），确认回到 shell 提示符后再继续；',
    '- 用简洁的中文回复。'
  ].join('\n')
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
  if (findActiveByConversation(input.sessionId)) {
    return { ok: false, status: 409, message: '这个助手会话正在回复中,等它收尾再发' }
  }

  // 插件注册的模型：解析前刷新（与 chat-turn 同一口径）
  await refreshPluginModels()

  // 模型:请求带了 configId 就严格解析(缺 modelId 用该配置第一个;悬空 / 不在清单给人话,
  // 不静默回退);没带 = 第一份带模型的配置的第一个模型(老客户端 / 未选时的缺省)。
  // 解析出的这一对(配置 id + 模型 id)同时是 `create_conversation` 的默认目标 ——
  // 助手给项目建会话时,把自己正在用的模型带下去,新会话开箱就能发消息。
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
    title: '项目助手',
    confirmTimeoutMs: prefs.confirmTimeoutMs
  })

  /**
   * 这一轮的作用域:**两组工具互斥**,由请求显式声明(见 `AssistantSendInput.scope`)。
   *
   * - `project`(缺省):项目管理助手 —— 只有项目工具;
   * - `terminal`:终端标签内嵌的助手 —— 只有客户端带上来的终端工具。
   *
   * 为什么互斥而不是「都挂上,用不到的模型自己不用」:工具就是模型的行动能力边界。
   * 全局面板挂着一堆 run_in_terminal,模型迟早会去试;而那条终端根本不是这个面板
   * 的语境(它属于某个终端标签)。反过来,一条绑定终端的会话里出现 create_project,
   * 用户看到的就是「让助手看下日志,它却在建目录」。边界交给装配层,不交给提示词。
   */
  const scope: 'project' | 'terminal' = input.scope === 'terminal' ? 'terminal' : 'project'

  /**
   * 这一轮的工具权限档(客户端在助手输入框左侧那颗 pill 上选的;没带 = `confirm`)。
   *
   * 两种作用域**同一套三档**,别按一个想:
   * - `terminal`(客户端工具):闸在 `buildClientToolset`,依据是客户端自己声明在
   *   `ClientToolSpec.mutating` 上的标记;
   * - `project`(项目 / 模型 / MCP / ACP 配置工具):闸在 `guardMutation`。
   * 两边都是 `readonly` 拒绝、`confirm` 弹卡、`full` 直接放行 —— 用户在输入框选的哪一档，
   * 对助手的所有工具生效（2026-11 反馈过「部分工具不受 pill 控制」，就是因为
   * `guardMutation` 从前只认 readonly）。档位用 getter 现取，中途切换立刻生效。
   */
  const permissionMode = (input.permissionMode ?? prefs.permissionMode) as AiPermissionMode
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
  // 之后 POST /api/chat/permission 改的也是它（见 buildClientToolset / buildProjectTools 的 getter）
  run.permissionMode = permissionMode

  /**
   * 客户端工具(终端操作):**只有 terminal 作用域**才装。
   * 服务端负责推帧、等客户端执行完回填;**审批闸在服务端**(`buildClientToolset` 按
   * `mutating` + `permissionMode` 套,帧走 confirm-gate → 助手面板的审批卡)。
   */
  const clientGate = createClientToolGate({ run })
  const clientTools =
    scope === 'terminal' && input.clientTools?.length
      ? buildClientToolset(input.clientTools, clientGate, {
          permissionMode,
          // 运行中活取：与主会话同一颗 pill，切档立刻生效（改档端点改的是同一个 run 字段）
          getPermissionMode: () => run.permissionMode,
          requestConfirm: gate.requestConfirm
        })
      : {}
  /** terminal 作用域:给模型一段「你能操作终端」的说明,并把可用工具名列出来 */
  const terminalHint =
    scope === 'terminal' && input.clientTools?.length
      ? [
          '',
          '你**绑定了一个终端**(用户当前正在看的那个)。你可以通过下面这些工具直接操作它 —— 执行命令、读取输出、发送按键:',
          ...input.clientTools.map((t) => `- ${t.name}:${t.description}`),
          '执行命令后终端输出即为事实依据;涉及删除 / 重启 / 改配置等危险操作前先说明影响。命令是串行执行的,不要并发下发。',
          '你不负责项目管理(建 / 删项目、worktree、定时任务),这类请求请让用户去项目面板或全局助手。'
        ].join('\n')
      : ''

  const assistantParts: AgentChatMessage['parts'] = []
  let turnUsage: TurnUsage | undefined

  /** 项目工具:**只有 project 作用域**才建(terminal 作用域下这套能力整组缺席) */
  const projectTools =
    scope === 'project'
      ? buildProjectTools({
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
          conversations: {
            createConversation: (input) =>
              Promise.resolve(createProjectConversation(input, effectiveTarget))
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
          // ⚠️ `guardMutation` 只认 `readonly`(其余档一律弹审批),所以这里透传档位不会
          // 放松任何项目操作的审批 —— 只是让「只读」这一档对项目工具也生效
          permissionMode,
          getPermissionMode: () => run.permissionMode,
          requestConfirm: gate.requestConfirm
        })
      : {}

  /**
   * 模型配置工具（列 / 增 / 改 / 删配置、拉上游模型、增改删配置下的模型）：
   * 与项目工具同批装配 —— 同样只挂 `project` 作用域，因为改的是**全局设置**，
   * 不是某个工作区里的文件。审批口径也同一份 `guardMutation`（`readonly` 拒绝、
   * 其余档弹卡），所以 `permissionMode` / `getPermissionMode` 直接透传。
   */
  const modelTools =
    scope === 'project'
      ? buildModelTools({
          models: {
            list: () => domain.listModels(),
            save: (input) => domain.saveModel(input),
            remove: (id) => domain.deleteModel(id),
            // 与设置页的探针路由同源：空 key 复用已存密钥，解密只在服务端
            probe: (input) => probeModelsFromUpstream(input)
          },
          permissionMode,
          getPermissionMode: () => run.permissionMode,
          requestConfirm: gate.requestConfirm
        })
      : {}

  /**
   * MCP 配置工具（server 的列 / 增 / 改 / 删 + 连上列工具）：
   * 与模型配置同一批 —— 只挂 `project` 作用域，因为写的是**全局设置**。
   *
   * ⚠️ 它**不负责**在当前这轮里用上 MCP 工具：MCP 是按会话启用的
   * （`AgentConversation.mcpServerIds`），这一轮的工具集在 `runAgent` 之前就装配完了。
   * 工具回话里已经写明「去会话工具条勾选」，别在这里做「顺手把新 server 塞进本轮」的
   * 尝试 —— 助手没有会话概念，塞进哪个会话都说不清。
   */
  const mcpTools =
    scope === 'project'
      ? buildMcpTools({
          mcp: {
            list: () => domain.listMcpServers(),
            save: (input) => domain.saveMcpServer(input),
            remove: (id) => domain.deleteMcpServer(id),
            // 与「设置 → MCP」那颗扳手按钮同源：连上、列完、立刻断开
            probe: (server) => probeMcpServerTools(server)
          },
          permissionMode,
          getPermissionMode: () => run.permissionMode,
          requestConfirm: gate.requestConfirm
        })
      : {}

  /**
   * 外部 Agent（ACP）配置工具：与模型 / MCP 配置同一批 —— 同样只挂 `project` 作用域，
   * 因为写的是**全局设置**（`agent-core.json` 的 `acpAgents`），不属于任何工作区。
   *
   * 注意它只管**配置**，不起 agent 进程：真正用它要新建一个后端为 ACP 的会话。
   */
  const acpTools =
    scope === 'project'
      ? buildAcpTools({
          acp: {
            list: () => domain.listAcpAgents(),
            save: (input) => domain.saveAcpAgent(input),
            remove: (id) => domain.deleteAcpAgent(id),
            // 与设置页「一键添加」同一份探测（见 ./acp-detect.ts）
            detect: detectAcpAgents,
            // 一次性起 agent 进程问模型清单（问完就收掉），与设置页的能力探针同源
            probeModels: async (id) => {
              const agent = domain.resolveAcpAgent(id)
              const workspacePath = domain.listWorkspaces()[0]?.path
              const result = await probeAcpModels({
                agent,
                ...(workspacePath ? { workspacePath } : {})
              })
              return result.options
            }
          },
          permissionMode,
          getPermissionMode: () => run.permissionMode,
          requestConfirm: gate.requestConfirm
        })
      : {}

  /**
   * 全局工具 + `bash`。
   *
   * ## 命令跑在哪个目录
   *
   * 助手是「跨项目」的，本身没有工作区。取**第一个已登记且有路径的项目**作为命令的
   * 默认 cwd（与 `probeAcpModels` 的口径一致）；一个都没登记就退回用户主目录。
   * `bash` 的 `cwd` 入参仍可覆盖，但那个目录必须存在。
   *
   * ## 为什么只挑这几个
   *
   * `includeTools` 是**白名单**（多一个 key 直接抛错，见 `filterToolSet`）：
   * - `bash`：执行命令（用户明确要求）；
   * - `read`：`bash` 输出超长会落盘到 `.fizz/tool-output/`，结果里让模型「用 read 接着读」，
   *   没有 read 就成死路；
   * - `todo_write`：多步任务清单（本轮内存状态，不碰磁盘）。
   *
   * `write` / `edit` / `str_replace_editor` / `delete_file` / `glob` / `grep` / `git_read`
   * 一律不挂 —— 助手没有唯一工作区，给它写文件的能力等于替用户猜「该动哪个项目」。
   * 只读的 `read` 仅作命令输出的续读口子，是这条约束里唯一的例外。
   *
   * 审批：`bash` 走 `guardWrite`，`confirm` 档 + `gate.requestConfirm` 会弹审批卡；
   * `readonly` 档直接拒；档位用 getter 现取（用户中途切档立刻生效）。
   * 单条停止接在 `run.commandStops` 上，实时输出走 `tool-output-delta` 发到助手面板。
   * 没接 `onBackgroundCommand` —— `run_in_background` 会如实回绝，别在提示词里承诺。
   *
   * `web_fetch` 的 root 传空串：超长正文只截断、不落盘（见 `spillToWorkspace`），
   * 与「未绑定工作区的任务会话」同一份口径。
   */
  const bashRoot = assistantBashRoot()
  const globalTools =
    scope === 'project'
      ? {
          ...buildWebFetchTool('', {}),
          ...buildAgentTools(bashRoot, {
            permissionMode,
            getPermissionMode: () => run.permissionMode,
            requestConfirm: gate.requestConfirm,
            skills: [],
            includeTools: ['bash', 'read', 'todo_write'],
            onCommandStart: (toolCallId, stop) => {
              run.commandStops.set(toolCallId, stop)
            },
            onCommandEnd: (toolCallId) => {
              run.commandStops.delete(toolCallId)
            },
            onCommandOutput: (toolCallId, stream, delta) => {
              emit(run, {
                type: 'event',
                requestId: run.requestId,
                event: { type: 'tool-output-delta', toolCallId, stream, delta }
              })
            }
          })
        }
      : {}

  const onEvent = (event: AgentStreamEvent): void => {
    if (event.type === 'finish' && event.usage) turnUsage = event.usage
    foldEventIntoParts(assistantParts, event)
    emit(run, { type: 'event', requestId: run.requestId, event })
  }


  const runner: Promise<RunAgentResult> = runAgent({
    // workspace 只在 setup 缺省时被装配使用;setup 已显式传入,这里给个占位即可
    // setup 已显式传入，workspace 只是类型占位（助手没有工作区）
    workspace: { id: input.sessionId, name: 'AI 助手', path: '', createdAt: Date.now(), updatedAt: Date.now() },
    // 自动摘要固化的缓存键（助手会话也会聊很久，同样需要复用摘要）
    conversationId: input.sessionId,
    history,
    model: modelConfig,
    skills: [],
    permissionMode,
    requestConfirm: gate.requestConfirm,
    setup: {
      // 两套身份各自配套:terminal 只有终端提示词 + 终端工具,project 只有项目提示词 + 项目工具
      instructions:
        scope === 'terminal'
          ? buildTerminalAssistantInstructions() + terminalHint
          : buildAssistantInstructions(),
      // 工具集**按作用域二选一**,不再合并 —— 两组能力互斥(见 scope 的说明)
      tools:
        scope === 'terminal'
          ? clientTools
          : { ...projectTools, ...modelTools, ...mcpTools, ...acpTools, ...globalTools }
    },
    contextWindow: resolveContextWindow(
      modelConfig.models,
      modelConfig.model,
      defaultContextWindowFromEnv()
    ),
    // 客户端偏好（设置页的「模型请求重试」）；不传 = 缺省 2 次
    ...(maxRetries !== undefined ? { maxRetries } : {}),
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
      clientGate.releaseAll()
      finishRun(run, finishReason ?? 'error')
      markDirty(['activeRuns'])
    })

  run.controller.signal.addEventListener('abort', () => {
    gate.releaseAll()
    clientGate.releaseAll()
  })

  return { ok: true, run }
}
