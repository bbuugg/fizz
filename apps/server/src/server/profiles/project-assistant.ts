/**
 * 项目管理助手的 profile：**跨项目**身份 + 纯项目 / 全局配置工具。
 *
 * 与主会话（工作区 Agent）共用同一个运行时，差别只有两处：
 * - `instructions` 是助手自己的身份说明（当前项目清单快照每轮现算）；
 * - `plugins` 里只有项目 / 模型 / MCP / ACP 配置工具 + `web_fetch`，
 *   **一个文件 / 命令类工具都不挂**（助手没有唯一工作区根）。
 *
 * 装配产物交给 `runAgent` 的 `mountAssembly`，审批壳 / 钩子 / 提示词渲染与主会话
 * 走同一条管线 —— 这里不自己建 context，也不绕过 `guardMutation`。
 */
import {
  rawToolsPlugin,
  type AgentAssembly,
  type AgentConfirmInput
} from '@fizz/agent'
import type { AiPermissionMode } from '@fizz/contracts/types'
import {
  buildAcpTools,
  buildMcpTools,
  buildModelTools,
  buildProjectTools,
  buildWebFetchTool
} from '@fizz/tools'

type ProjectToolsDeps = Parameters<typeof buildProjectTools>[0]
type ModelToolsDeps = Parameters<typeof buildModelTools>[0]
type McpToolsDeps = Parameters<typeof buildMcpTools>[0]
type AcpToolsDeps = Parameters<typeof buildAcpTools>[0]

/** 注进提示词的项目清单条目（只读快照） */
export interface AssistantWorkspaceBrief {
  id: string
  name: string
  path: string
  isWorktree?: boolean
  parentWorkspaceId?: string
}

/**
 * 助手能用的服务。全部由调用方注入（服务端把 `domain` / 项目操作 / 探针接上）——
 * 本文件不直接读全局状态，方便单测替换。
 */
export interface ProjectAssistantServices {
  projects: ProjectToolsDeps['projects']
  domainApi: ProjectToolsDeps['domainApi']
  triggers: ProjectToolsDeps['triggers']
  plugins: ProjectToolsDeps['plugins']
  models: ModelToolsDeps['models']
  mcp: McpToolsDeps['mcp']
  acp: AcpToolsDeps['acp']
  /** 工作区清单快照（每轮现读，注进提示词） */
  listWorkspaces: () => AssistantWorkspaceBrief[]
  defaultProjectsRoot: string
  permissionMode: AiPermissionMode
  getPermissionMode: () => AiPermissionMode
  requestConfirm: (req: AgentConfirmInput) => Promise<boolean>
}

/**
 * 助手的系统提示词：**每轮现算**，把当前项目清单快照与默认根目录注进去 ——
 * 模型不用先查再动，「打开 xx」「删掉 yy」这类指令一步到位。
 */
export function buildAssistantInstructions(
  workspaces: AssistantWorkspaceBrief[],
  defaultProjectsRoot: string
): string {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const lines = [
    '你是 Fizz 的项目管理助手,负责帮用户管理 Fizz 里的项目(工作区):查看清单、登记已有目录、新建目录、从 Git 克隆、打开项目、创建 / 删除 worktree、删除项目、查看 / 创建 / 修改 / 删除 / 启停定时任务、给项目写插件,以及管理全局的模型配置(列 / 增 / 改 / 删网关与模型)、MCP 配置(列 / 增 / 改 / 删外部工具服务)与外部 Agent 配置(列 / 探测本机已装 / 增 / 改 / 删 ACP agent);也能用 web_fetch 查网页文档。',
    `默认项目根目录:${defaultProjectsRoot}。建议用户把项目放这里(根内创建免审批);用户明确要放别处时照做(根外创建会弹审批卡)。`,
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
    '- open_project 只是通知界面切换项目(新建会话请让用户在界面里操作,助手没有这个工具);',
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
    '- **没有任何文件 / 命令类工具**:助手是跨项目的,没有唯一工作区根目录,所以 read / write / edit / glob / grep / git_read / bash 都不挂,也不挂 todo;要读文件、跑命令或改某个项目里的东西,让用户去那个项目的会话里做 —— 不要声称自己已经看过文件或跑过命令;',
    '- web_fetch 抓网页(只认 http(s),超长正文会截断不落盘);查某个 CLI 的参数 / 排错时可以用它翻官方文档;',
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

/** 项目管理助手的一轮装配（提示词 + 工具插件） */
export function buildProjectAssistantAssembly(
  services: ProjectAssistantServices
): AgentAssembly {
  const guard = {
    permissionMode: services.permissionMode,
    getPermissionMode: services.getPermissionMode,
    requestConfirm: services.requestConfirm
  }
  return {
    instructions: buildAssistantInstructions(
      services.listWorkspaces(),
      services.defaultProjectsRoot
    ),
    plugins: [
      {
        plugin: rawToolsPlugin(
          'assistant:project',
          {
            ...buildProjectTools({
              projects: services.projects,
              domainApi: services.domainApi,
              triggers: services.triggers,
              plugins: services.plugins,
              ...guard
            }),
            ...buildModelTools({ models: services.models, ...guard }),
            ...buildMcpTools({ mcp: services.mcp, ...guard }),
            ...buildAcpTools({ acp: services.acp, ...guard }),
            // root 传空串：超长正文只截断、不落盘（助手没有工作区）
            ...buildWebFetchTool('', {})
          },
          { origin: 'builtin', source: 'assistant' }
        )
      }
    ]
  }
}
