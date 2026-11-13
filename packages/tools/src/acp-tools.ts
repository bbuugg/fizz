/**
 * ACP（外部 agent）配置工具组：列出 / 探测本机已装 / 新建 / 修改 / 删除。
 *
 * 只挂给**项目助手**（`scope === 'project'`），与 `mcp-tools` / `model-tools` 同一条
 * 理由：这些配置改的是**全局设置**（跟具体工作区无关），普通会话不该有能力改它。
 *
 * ## 类型为什么不 import `@fizz/acp`
 *
 * 那边是 ACP 领域类型的真源（`AcpAgentConfig` / `AcpAgentType` / `AcpAllowStrategy`），
 * 但包的运行期入口会把 `@agentclientprotocol/sdk` 拖进来 —— `packages/tools` 不该为
 * 一个配置读写工具付这份依赖。这里只声明用得到的结构（字段名与那边逐字一致），
 * 由服务端注入的实现负责对齐。**改字段时两边一起改**。
 *
 * ## 与设置页的关系
 *
 * 同一份数据（`agent-core.json` 的 `acpAgents`），同一套校验（domain 的 `saveAcpAgent`
 * 负责判重 / 缺字段沿用）。工具只做「翻译意图 + 审批」，不自己拼落盘结构。
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { tr } from '@fizz/i18n'
import { guardMutation, type MutationGuardDeps } from './project-tools'

/** 外部 agent 的启动配置（结构对齐 `@fizz/acp` 的 `AcpAgentConfig`） */
export interface AcpAgentSummary {
  id: string
  name: string
  command: string
  args: string[]
  type?: string
  allowStrategy?: string
  /** 会话模型下拉里暴露哪几个（只报数量，避免把十几条模型灌进上下文） */
  models?: Array<{ value: string; name: string }>
}

/** 保存入参（结构对齐 `AcpAgentInput`）：带 id = 更新，缺字段 = 沿用旧值 */
export interface AcpAgentInputLike {
  id?: string
  name: string
  command: string
  args?: string[]
  /** 与 `@fizz/acp` 的 `AcpAgentType` 同集合；窄写是为了不用在服务端做类型断言 */
  type?: 'opencode' | 'pi' | 'generic'
  /** 与 `@fizz/acp` 的 `AcpAllowStrategy` 同集合 */
  allowStrategy?: 'once' | 'always'
  /** 会话模型下拉里暴露哪几个；空数组 = 一个都不列，缺省 = 沿用 */
  models?: Array<{ value: string; name: string; description?: string }>
}

/** PATH 上探测到的候选 */
export interface DetectedAcpAgentSummary {
  name: string
  command: string
  args: string[]
  path: string
}

export interface AcpToolsDeps extends MutationGuardDeps {
  acp: {
    list(): AcpAgentSummary[]
    /** 整份 upsert（带 id = 更新；领域层负责判重与「缺字段沿用」） */
    save(input: AcpAgentInputLike): AcpAgentSummary
    remove(id: string): AcpAgentSummary[]
    /** 扫 PATH 上已装的已知 agent（只读；与设置页「一键添加」同一份实现） */
    detect(): Promise<DetectedAcpAgentSummary[]>
    /**
     * 起一次这个 agent 的进程，问它「你有哪些模型」（问完就收掉，不留常驻连接）。
     * 返回 `probe_acp_models` 给模型看的清单；连不上 / 不支持会把原因带回来。
     */
    probeModels(id: string): Promise<Array<{ value: string; name: string; description?: string }>>
  }
}

/** 本组的工具名清单（与其它工具组同一风格，便于集中核对） */
export const ACP_TOOLS = [
  'list_acp_agents',
  'detect_acp_agents',
  'probe_acp_models',
  'create_acp_agent',
  'update_acp_agent',
  'delete_acp_agent'
] as const

/** 风格：决定会话输入区里模式 UI 的语义与位置（见 `@fizz/acp` 的 `AcpAgentType`） */
const AGENT_TYPE = z.enum(['opencode', 'pi', 'generic'])
/** 「完全放行」时怎么答复权限请求（`once` 才会继续问，缺省就是它） */
const ALLOW_STRATEGY = z.enum(['once', 'always'])

/** 判重口径与领域层一致：命令 + 参数相同就是同一条（名称不参与） */
function agentKey(agent: { command: string; args: string[] }): string {
  return `${agent.command}\u0000${agent.args.join('\u0000')}`
}

function summarize(agent: AcpAgentSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    ...(agent.args.length ? { args: agent.args } : {}),
    ...(agent.type ? { type: agent.type } : {}),
    ...(agent.allowStrategy ? { allowStrategy: agent.allowStrategy } : {}),
    ...(agent.models?.length ? { exposedModels: agent.models.length } : {})
  }
  return out
}

function findAgent(deps: AcpToolsDeps, id: string): AcpAgentSummary | string {
  const agent = deps.acp.list().find((a) => a.id === id)
  if (agent) return agent
  const known = deps.acp.list().map((a) => a.id)
  return known.length
    ? `没有 id 为 ${id} 的 ACP agent。现有：${known.join(' / ')}`
    : '还没有配置任何 ACP agent（先用 list_acp_agents 或 detect_acp_agents 看看）。'
}

const ENABLE_HINT =
  '保存只是「可以被选」：真正用它要在新建会话时把后端切成「外部 Agent」并选中这一条（已有会话的后端不能改）。'

/** 组装 ACP 配置工具组（只给项目助手） */
export function buildAcpTools(deps: AcpToolsDeps): ToolSet {
  return {
    list_acp_agents: tool({
      description: tr(
        '列出已保存的外部 Agent（ACP）配置：id / 名称 / 启动命令与参数 / 风格 / 放行策略 / 暴露的模型数。改、删之前先用它拿 id。注意：配好 ≠ 用上，新建会话时还要把后端切成「外部 Agent」并选中它。',
        'List saved external agents (ACP): id, name, launch command and args, style, allow strategy, and how many models are exposed. Use it to get ids before editing or deleting. Note: configured is not the same as used — a new conversation must switch its backend to "external agent" and pick this entry.'
      ),
      inputSchema: z.object({}),
      execute: async () => {
        const list = deps.acp.list()
        if (!list.length) {
          return '还没有配置任何外部 Agent。先用 detect_acp_agents 看本机装了什么（Claude Agent / Codex / Gemini / opencode / Copilot / Pi），再用 create_acp_agent 添加。'
        }
        return JSON.stringify(list.map(summarize), null, 2)
      }
    }),

    detect_acp_agents: tool({
      description: tr(
        '扫描运行 Agent 的这台机器上「PATH 里已经装了」的已知 ACP agent（只读，不会装任何东西）。返回可直接用于 create_acp_agent 的命令与参数，并标明哪几条已经添加过。用户说「我装了 xxx」但不确定命令时用它。',
        'Scan the machine running the agent for known ACP agents already on PATH (read-only; installs nothing). Returns commands and args ready for create_acp_agent and marks the ones already added. Use it when the user says they installed something but is unsure of the command.'
      ),
      inputSchema: z.object({}),
      execute: async () => {
        const detected = await deps.acp.detect()
        const existing = new Set(deps.acp.list().map(agentKey))
        if (!detected.length) {
          return 'PATH 上没有发现已知的 ACP agent。用户需要先自行安装（例如 npm i -g 对应的 CLI），或者直接告诉我可执行文件的绝对路径，用 create_acp_agent 手工添加。'
        }
        return JSON.stringify(
          detected.map((agent) => ({
            name: agent.name,
            command: agent.command,
            ...(agent.args.length ? { args: agent.args } : {}),
            path: agent.path,
            alreadyAdded: existing.has(agentKey(agent))
          })),
          null,
          2
        )
      }
    }),

    probe_acp_models: tool({
      description: tr(
        '连上某个外部 Agent，列出它自己广告的模型（一次性会话，问完立刻收掉进程，不会留下常驻连接）。**只读、不弹审批**，但会真的起一次那个 CLI，可能要几秒。用来给用户挑「会话模型下拉里暴露哪几个」——挑好后把清单交给 update_acp_agent 的 models 字段。agent 没装 / 命令写错 / 不支持选模型时会把原因带回来。',
        'Connect to an external agent and list the models it advertises (a one-shot session; the process is torn down immediately, nothing stays running). **Read-only, no approval**, but it does launch the CLI once and may take a few seconds. Use it to pick which models appear in the conversation dropdown, then pass that list to update_acp_agent as models. Failures (missing CLI, wrong command, no model support) come back verbatim.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('ACP agent id', 'ACP agent id'))
      }),
      execute: async ({ id }) => {
        const current = findAgent(deps, id)
        if (typeof current === 'string') return current
        try {
          const models = await deps.acp.probeModels(id)
          if (!models.length) {
            return JSON.stringify({
              ok: true,
              agent: { id: current.id, name: current.name },
              models: [],
              note: '这个 agent 没有广告可选模型（或这一版 CLI 不支持）；会话里只能用它的默认模型，models 传 [] 即可。'
            }, null, 2)
          }
          return JSON.stringify({
            ok: true,
            agent: { id: current.id, name: current.name },
            count: models.length,
            models: models.map((m) => ({ value: m.value, name: m.name, ...(m.description ? { description: m.description } : {}) }))
          }, null, 2)
        } catch (err) {
          return `探测模型失败：${err instanceof Error ? err.message : String(err)}\n（多半是命令写错 / CLI 没装 / 这一版不支持 ACP；改完用 update_acp_agent 保存再试，不要反复重试同一次调用。）`
        }
      }
    }),

    create_acp_agent: tool({
      description: tr(
        '添加一个外部 Agent（ACP），比如 Claude Agent、codex-acp、gemini --acp、opencode acp。命令在**跑 Agent 的那台机器**上 spawn 成子进程，工作目录是会话所属工作区。args 必须是该 CLI 真实的 ACP 入口参数 —— 不确定就先用 detect_acp_agents。同名同参数不能重复添加。创建前会弹审批卡。',
        'Add an external agent (ACP) such as Claude Agent, codex-acp, gemini --acp, or opencode acp. The command is spawned as a subprocess on the machine running the agent, with the conversation workspace as cwd. args must be the CLI\'s real ACP entry arguments — use detect_acp_agents if unsure. Duplicate command+args pairs are rejected. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        name: z.string().describe(tr('展示名，如「Codex CLI」', 'Display name, e.g. "Codex CLI"')),
        command: z
          .string()
          .describe(tr('可执行文件（PATH 里的名字或绝对路径；Windows 上 npm 装的 CLI 常需要 .cmd）', 'Executable (a name on PATH or an absolute path; on Windows npm-installed CLIs often need .cmd)')),
        args: z.array(z.string()).optional().describe(tr('启动参数，如 ["--acp"]', 'Launch args, e.g. ["--acp"]')),
        type: AGENT_TYPE.optional().describe(tr('风格：opencode / pi / generic（缺省 generic，不显示模式 UI）', 'Style: opencode / pi / generic (default generic, no mode UI)')),
        allowStrategy: ALLOW_STRATEGY.optional().describe(tr('「完全放行」时怎么答复权限请求：once（每次问，缺省）/ always（由 agent 永久记住）', 'How to answer permission requests under full access: once (ask every time, default) / always (the agent remembers)'))
      }),
      execute: async ({ name, command, args, type, allowStrategy }, options) => {
        const trimmedName = name.trim()
        const trimmedCommand = command.trim()
        if (!trimmedName) return '需要 name（展示名）。'
        if (!trimmedCommand) return '需要 command（启动命令，如 claude-agent-acp 或绝对路径）。'
        const detail = [trimmedCommand, ...(args ?? [])].join(' ')
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: 'ACP agent 未创建',
          command: `添加外部 Agent「${trimmedName}」（${detail}${type ? `，风格 ${type}` : ''}）`,
          toolCallId: options.toolCallId,
          toolName: 'create_acp_agent'
        })
        if (refused) return refused
        try {
          const saved = deps.acp.save({
            name: trimmedName,
            command: trimmedCommand,
            ...(args ? { args } : {}),
            ...(type ? { type } : {}),
            ...(allowStrategy ? { allowStrategy } : {})
          })
          return JSON.stringify({ ok: true, agent: summarize(saved), note: ENABLE_HINT }, null, 2)
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err))
        }
      }
    }),

    update_acp_agent: tool({
      description: tr(
        '修改一个已保存的外部 Agent。**只传要改的字段，其余保持原样**（名称 / 命令 / 参数 / 风格 / 放行策略 / 暴露的模型任选；args 传 [] 清空）。命令行写错、换绝对路径、改风格都走它。要挑「会话模型下拉里暴露哪几个模型」：先 probe_acp_models 拿到候选，再把选中的几条作为 models 传进来（空数组 = 一个都不列）。修改前会弹审批卡。',
        'Update a saved external agent. **Pass only the fields to change; the rest stay as-is** (name / command / args / style / allow strategy / exposed models; args: [] clears). Use it to fix a wrong command line, switch to an absolute path, or change the style. To choose which models appear in the conversation dropdown: call probe_acp_models for candidates, then pass the selected few as models (an empty array lists none). A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('ACP agent id（list_acp_agents 返回的 id）', 'ACP agent id (as returned by list_acp_agents)')),
        name: z.string().optional().describe(tr('新的展示名', 'New display name')),
        command: z.string().optional().describe(tr('新的启动命令', 'New launch command')),
        args: z.array(z.string()).optional().describe(tr('新的启动参数（整份替换，传 [] 清空）', 'New launch args (replaces wholesale; [] clears)')),
        type: AGENT_TYPE.optional().describe(tr('新的风格', 'New style')),
        allowStrategy: ALLOW_STRATEGY.optional().describe(tr('新的放行策略', 'New allow strategy')),
        models: z
          .array(z.object({ value: z.string(), name: z.string(), description: z.string().optional() }))
          .optional()
          .describe(tr('会话模型下拉里暴露哪些模型（整份替换；传 [] 一个都不列）。先用 probe_acp_models 拿到候选', 'Which models appear in the conversation dropdown (replaces wholesale; [] lists none). Get candidates with probe_acp_models first'))
      }),
      execute: async ({ id, name, command, args, type, allowStrategy, models }, options) => {
        const current = findAgent(deps, id)
        if (typeof current === 'string') return current
        const nextName = name?.trim() ?? current.name
        const nextCommand = command?.trim() ?? current.command
        if (!nextName) return 'name 不能是空字符串。'
        if (!nextCommand) return 'command 不能是空字符串（要清空请直接删除这条配置）。'
        const detail = [nextCommand, ...(args ?? current.args)].join(' ')
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: 'ACP agent 未修改',
          command: `修改外部 Agent「${nextName}」（${detail}）`,
          toolCallId: options.toolCallId,
          toolName: 'update_acp_agent'
        })
        if (refused) return refused
        try {
          const saved = deps.acp.save({
            id,
            name: nextName,
            command: nextCommand,
            ...(args ? { args } : {}),
            ...(type ? { type } : {}),
            ...(allowStrategy ? { allowStrategy } : {}),
            ...(models ? { models } : {})
          })
          return JSON.stringify({ ok: true, agent: summarize(saved) }, null, 2)
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err))
        }
      }
    }),

    delete_acp_agent: tool({
      description: tr(
        '删除一个外部 Agent 配置（只删配置，不动任何已经装好的 CLI）。⚠️ 绑在它上面的会话之后打不开 —— 那些会话的后端固定在 ACP 且记着这个 id。删之前先跟用户确认没有在用的会话。删除前会弹审批卡。',
        'Delete an external agent configuration (only the config; installed CLIs are untouched). ⚠️ Conversations bound to it will no longer open — their backend is pinned to ACP and remembers this id. Confirm no one is using it before deleting. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('ACP agent id', 'ACP agent id'))
      }),
      execute: async ({ id }, options) => {
        const current = findAgent(deps, id)
        if (typeof current === 'string') return current
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: 'ACP agent 未删除',
          command: `删除外部 Agent「${current.name}」（${current.command}）`,
          toolCallId: options.toolCallId,
          toolName: 'delete_acp_agent'
        })
        if (refused) return refused
        try {
          const rest = deps.acp.remove(id)
          return JSON.stringify(
            {
              ok: true,
              deleted: { id: current.id, name: current.name },
              remaining: rest.map((a) => ({ id: a.id, name: a.name }))
            },
            null,
            2
          )
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err))
        }
      }
    })
  }
}
