/**
 * 项目管理工具组:列出 / 创建 / 打开 / 删除项目(工作区)与 worktree、给项目建会话、浏览磁盘目录。
 *
 * 与 `tools.ts` 的工作区工具是两码事:那组绑定单个工作区根目录;这组操作的是
 * **项目清单本身**(跨工作区),所以不持 root,服务能力全部经 `deps` 注入 ——
 * `packages/tools` 不 import 领域包 / 服务端模块,保持分层与可离线验证。
 *
 * 审批策略：**与内置工具的 `guardWrite` 同一套三档**（统一由输入框那颗权限 pill 控制）：
 * - `readonly` 档：变更类直接拒绝；
 * - `confirm` 档：需要确认的操作弹审批卡；没有确认回调时按拒绝处理 —— 绝不静默放行；
 * - `full` 档（「完全访问」）：直接执行，不弹卡。用户是**显式**选的这一档，与主会话里
 *   `bash` 在 `full` 下不问是同一口径；别在这里再偷偷加一层「无论如何都要问」，
 *   那会让同一颗 pill 对两组工具给出两种行为（2026-11 的反馈就是「部分工具不受 pill 控制」）。
 * - 默认根目录内的创建本来就是低风险免审批（`needsConfirm: false`），三档都不问。
 *
 * 哪些操作在 `confirm` 档下必弹（`needsConfirm: true`）：
 * - **整项目级操作**（根目录外的创建、删除、worktree 增删）；
 * - **定时任务的全部变更**（create / update / delete / setEnabled）与 `create_plugin` ——
 *   它们要么产出「以后会自动执行」的东西（到点无人值守跑 agent、插件下一轮起执行代码），
 *   要么能改掉 / 停掉已授权的自动执行，比建个目录危险得多（`list_task_triggers` 是只读，不拦）。
 *
 * `create_conversation` 是唯一的例外档位：**`confirm` 档也不弹**。它产出的是一个空会话
 * （不带消息、不动磁盘），用户看一眼侧栏就能删掉 —— 按「删除数据前要审批」的口径，
 * 它连「数据」都还没产生，够不上审批；但 `readonly` 仍然拒绝（它确实是变更）。
 */
import { join, resolve } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { repoNameFromUrl } from '@fizz/git'
import type { AgentConfirmInput, AgentWorkspace } from '@fizz/contracts/types'
import { tr } from '@fizz/i18n'

/** 项目创建入参(与 lib/server/projects.ts 的 CreateProjectInput 同形,这里定义为共享契约) */
export type ProjectCreateInput =
  | { mode: 'existing'; path: string; name?: string }
  | { mode: 'new'; parentPath: string; name: string }
  | { mode: 'git'; gitUrl: string; parentPath: string; name?: string }

/** 目录浏览结果(与 contracts 的 FsDirsResult 同形,收窄成工具侧需要的最小结构) */
export interface ProjectDirsResult {
  path: string
  parent: string | null
  roots: { name: string; path: string }[]
  entries: { name: string; path: string }[]
}

/**
 * 变更类工具的闸门依赖（项目工具 / 模型配置工具共用，见 `guardMutation`）。
 *
 * 拆出来是为了让 `model-tools.ts` / `mcp-tools.ts` / `acp-tools.ts` 复用同一个实现 ——
 * 这些工具的作用域都在单个工作区之外，审批口径必须与内置工具完全一致：
 * `readonly` 拒绝 / `confirm` 弹卡 / `full` 放行。
 */
export interface MutationGuardDeps {
  permissionMode: 'full' | 'confirm' | 'readonly'
  /**
   * 运行中实时读取权限档（优先于 `permissionMode`）。工具集一轮建一次，静态档会把权限
   * 快照死在整轮里；传 getter 则闸门每次调用现取 —— 用户在输入框把 pill 从「确认」切成
   * 「完全访问」后，下一次工具调用就不再弹卡（见 `guardMutation`）。
   */
  getPermissionMode?: () => 'full' | 'confirm' | 'readonly'
  requestConfirm?: (req: AgentConfirmInput) => Promise<boolean>
}

/**
 * 工具组依赖:服务端(lib/server/projects.ts + state.ts 的 domain)注入实现,
 * 验证脚本注入 mock。签名全部结构化,不引任何具体类。
 */
export interface ProjectToolsDeps extends MutationGuardDeps {
  projects: {
    createProject(input: ProjectCreateInput): Promise<AgentWorkspace>
    removeProject(id: string, input?: { deleteWorktree?: boolean }): Promise<AgentWorkspace[]>
    createWorktree(
      workspaceId: string,
      input: { identifier: string; name?: string; baseBranch?: string }
    ): Promise<AgentWorkspace>
    getDefaultProjectsRoot(): string
    isInsideProjectsRoot(path: string, root?: string): boolean
    listDirs(path?: string): Promise<ProjectDirsResult>
  }
  /** 给项目建会话:只建**内置 Agent(内置)**会话,模型由注入方决定(见调用方注释) */
  conversations: {
    createConversation(input: ConversationCreateInput): Promise<ConversationCreateResult>
  }
  /** 定时任务:创建 / 列出 / 改 / 删 / 启停(服务端实现见 lib/server/task-triggers.ts;模型绑定由注入方补) */
  triggers: {
    create(input: TaskTriggerCreateInput): Promise<TaskTriggerCreateResult>
    /** 列出定时任务摘要;给 workspaceId 只看某个项目的(服务端同步返回) */
    list(workspaceId?: string): TaskTriggerSummary[]
    update(input: TaskTriggerUpdateInput): Promise<TaskTriggerCreateResult>
    remove(id: string): void
    setEnabled(id: string, enabled: boolean): TaskTriggerSummary
  }
  /** 插件:把结构化参数套模板生成的插件目录写进项目(服务端实现见 lib/server/plugin-create.ts) */
  plugins: {
    create(input: PluginCreateInput): Promise<PluginCreateResult>
  }
  domainApi: {
    listWorkspaces(): AgentWorkspace[]
    getWorkspace(id: string): AgentWorkspace | undefined
  }
}

/** 「给某个项目建会话」的入参 / 出参(服务端实现见 lib/server/conversation-create.ts) */
export interface ConversationCreateInput {
  workspaceId: string
  title?: string
}

export interface ConversationCreateResult {
  id: string
  title: string
  workspaceId: string
}

/**
 * 「创建定时任务」入参:模型只决定**什么时候、干什么**,模型绑定由注入方补 ——
 * 触发会话要用的模型配置从当前这一轮继承(与 `create_conversation` 同法),不让模型自己挑。
 */
export interface TaskTriggerCreateInput {
  workspaceId: string
  name: string
  /** cron 表达式(5 段:分 时 日 月 周);与 `at` 二选一 */
  cron?: string
  /** 一次性触发时刻(毫秒时间戳,必须晚于现在);能用 cron 表达就别用它 */
  at?: number
  /** 触发时作为用户消息发给 agent 的需求原文 */
  prompt: string
}

/** 创建结果:带上服务端算好的人话(下次触发时间),免得模型自己解释错 */
export interface TaskTriggerCreateResult {
  id: string
  name: string
  /** 缺省 = 没绑工作区（每次触发自动建临时工作区） */
  workspaceId?: string
  cron?: string
  at?: number
  enabled: boolean
  /** 下一次触发的本地时间(服务端按 cron / at 算);没有 = 不启用或已过期 */
  nextRunAt?: string
}

/** 定时任务摘要(给模型看的清单项):只收模型核对 / 决策需要的字段。 */
export interface TaskTriggerSummary {
  id: string
  name: string
  /** 缺省 = 没绑工作区（每次触发自动建临时工作区） */
  workspaceId?: string
  /** 触发时作为用户消息发给 agent 的需求原文 */
  prompt: string
  cron?: string
  at?: number
  enabled: boolean
  /** 上次触发时刻(毫秒时间戳) */
  lastTriggeredAt?: number
  /** 上次触发起的会话 id */
  lastConversationId?: string
  /** 下一次触发的本地时间;没有 = 已停用 / 已过期 */
  nextRunAt?: string
}

/**
 * 「更新定时任务」入参:只给要改的字段,其余保持原样。
 * 给了 cron / at 之一 = 把触发方式换成那种(与另一种互斥);都不给则沿用原有排程。
 */
export interface TaskTriggerUpdateInput {
  id: string
  name?: string
  prompt?: string
  cron?: string
  at?: number
  enabled?: boolean
}

/**
 * 「创建插件」入参:**结构化参数**,不是整份源码 —— 由服务端套模板生成插件目录
 * (见 `buildPluginSource`)。这么设计是因为工具形状写错(比如把 `execute` 写成 `handler`)
 * 会让会话静默卡死,模板生成能保证形状永远合法。
 */
export interface PluginCreateInput {
  workspaceId: string
  /** 插件展示名(可中文),出现在「项目插件」列表里 */
  name: string
  /** 插件注册给 Agent 的工具名(ASCII,如 `weather_report`);文件名由它推导 */
  toolName: string
  /** 工具描述:模型据此决定何时调用,写清用途 */
  toolDescription: string
  /** `execute` 的函数体源码(不含外层壳),可用 `await`,**必须以 return 给出一段文字** */
  executeBody: string
  /** 可选:往系统提示词里补一段,说明什么时候该用这个工具 */
  hint?: string
  /** 这个工具会不会改动东西(缺省 false)。true 时在需要确认的会话里会走审批 */
  mutating?: boolean
}

export interface PluginCreateResult {
  id: string
  name: string
  /** 落盘后的绝对路径 */
  file: string
  toolName: string
  /** 生成并落盘的源码(回显给模型,便于它对照) */
  source: string
}

/** 本组的工具名清单(前端动作解释器据此识别 open_project / create_project / create_conversation) */
export const PROJECT_TOOLS = [
  'list_projects',
  'list_dirs',
  'create_project',
  'open_project',
  'create_conversation',
  'remove_project',
  'create_worktree',
  'remove_worktree',
  'create_task_trigger',
  'list_task_triggers',
  'update_task_trigger',
  'delete_task_trigger',
  'set_task_trigger_enabled',
  'create_plugin'
] as const

/** 插件工具名的合法形状:AI SDK 的工具名要 ASCII(中文名会被各家 API 拒),也不该带空格 */
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/** 由工具名推插件目录名(工具层写确认卡、服务端落盘都用它,免得两处各推一遍) */
export function pluginDirName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/_/g, '-')
}

/** 注释里不能出现结束注释的字符组合(会把块注释提前闭合),名字是模型给的,过一手 */
function safeComment(text: string): string {
  return text.replace(/\*\//g, '*\\/').replace(/[\r\n]+/g, ' ')
}

/** 逐行缩进(空行不留尾随空格) */
function indentBlock(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? pad + line : ''))
    .join('\n')
}

/**
 * 把结构化参数套成一份**形状一定合法**的插件源码(纯函数,可离线验证)。
 *
 * 刻意的取舍:生成的工具**无参数**。带参数就得有 `inputSchema`,而 zod / `ai` 的
 * `jsonSchema` 都要求 import —— 别人的项目目录里未必有 `node_modules`(实测 `D:\tmp\test`
 * 就没有),那种插件会加载失败。无参工具零 import,放哪都能跑。
 */
export function buildPluginSource(input: Omit<PluginCreateInput, 'workspaceId'>): string {
  const { name, toolName, toolDescription, executeBody, hint, mutating = false } = input
  const hintBlock = hint?.trim()
    ? `
  // 告诉模型什么时候该用这个工具(priority 越大越靠后)
  ctx.prompt.section(${JSON.stringify(`${toolName}-hint`)}, ${JSON.stringify(hint.trim())}, { priority: 10 })
`
    : ''
  return `/**
 * ${safeComment(name)}
 *
 * 由项目管理助手创建。放在 <项目>/.fizz/plugins/<目录>/index.ts 下就是**项目级**插件,
 * 只在该项目生效;同目录的 plugin.json 是它的身份描述。写好后到 侧栏项目「更多」→「插件」
 * 看一眼它有没有报错。改完保存后**下一轮对话**生效。
 */
export default (ctx) => {${hintBlock}
  ctx.tools.register(
    ${JSON.stringify(toolName)},
    {
      description: ${JSON.stringify(toolDescription)},
      execute: async () => {
${indentBlock(executeBody.trim(), 8)}
      }
    },
    { source: ${JSON.stringify(name)}, mutating: ${mutating} }
  )
}
`
}

/**
 * 变更类操作的统一闸门。返回 null = 放行;返回字符串 = 直接作为工具结果(回绝说明)。
 *
 * 项目 / 模型 / MCP / ACP 四组配置工具共用这一份，**三档语义与内置工具的 `guardWrite`
 * 完全一致**：`readonly` 拒绝、`confirm` 按 `needsConfirm` 弹卡、`full` 直接放行。
 * 档位每次现取（`getPermissionMode`），所以输入框那颗 pill 中途切换立刻生效。
 */
export async function guardMutation(
  deps: MutationGuardDeps,
  args: { needsConfirm: boolean; denied: string; command: string; toolCallId: string; toolName: string }
): Promise<string | null> {
  const mode = deps.getPermissionMode?.() ?? deps.permissionMode
  if (mode === 'readonly') {
    return `当前是只读模式:${args.denied}。请把这一点告诉用户(他可以在输入框左侧的权限选择里切换成「确认模式」或「完全访问」),不要反复尝试同类操作。`
  }
  // 「完全访问」= 用户在输入框显式选的那一档：与主会话的 bash 同一口径，不再二次确认。
  // 别在这里另加「危险操作无论如何都问」的例外——同一颗 pill 必须对两组工具给出同一种行为。
  if (mode === 'full') return null
  if (!args.needsConfirm) return null
  if (!deps.requestConfirm) {
    return `这个操作(${args.denied})需要用户确认,但当前环境没有可用的确认通道,已取消。请让用户改用界面操作,不要重试。`
  }
  const approved = await deps.requestConfirm({
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    command: args.command
  })
  return approved
    ? null
    : `用户拒绝了这次调用:${args.denied}。请询问用户接下来希望怎么做,不要擅自重试同一步。`
}

/** 服务层错误已经是人话(中文 + 原因),原样抛给工具层变成 tool error 即可 */
function rethrow(err: unknown): never {
  throw err instanceof Error ? err : new Error(String(err))
}

/** 构建项目管理工具集(普通会话经 extraTools 挂载;项目助手直接作为全部工具集) */
export function buildProjectTools(deps: ProjectToolsDeps): ToolSet {
  return {
    list_projects: tool({
      description: tr(
        '列出 Fizz 里已登记的全部项目(工作区),含 worktree 子项目的层级(parentWorkspaceId 指向父项目)。管理项目前先用它看现状。',
        'List every project (workspace) registered in Fizz, including the worktree hierarchy (parentWorkspaceId points to the parent). Call it to see the current state before managing projects.'
      ),
      inputSchema: z.object({}),
      execute: async () => {
        return JSON.stringify(deps.domainApi.listWorkspaces(), null, 2)
      }
    }),

    list_dirs: tool({
      description: tr(
        '浏览服务端磁盘目录(只列子目录),给「选择项目位置」用。path 缺省从用户主目录开始;roots 是 Windows 的盘符列表。返回绝对路径。',
        'Browse server-side disk directories (subdirectories only), for choosing a project location. path defaults to the user home directory; roots lists Windows drives. Returns absolute paths.'
      ),
      inputSchema: z.object({
        path: z.string().optional().describe(tr('要列出的目录绝对路径;缺省从用户主目录开始', 'Absolute path of the directory to list; defaults to the user home directory'))
      }),
      execute: async ({ path }) => {
        try {
          const r = await deps.projects.listDirs(path)
          return JSON.stringify(
            {
              当前目录: r.path,
              上级目录: r.parent,
              ...(r.roots.length ? { 盘符: r.roots.map((x) => x.path) } : {}),
              子目录: r.entries.map((e) => e.path)
            },
            null,
            2
          )
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    create_project: tool({
      description: tr(
        '创建 / 登记一个项目。mode=existing:登记一个磁盘上已有的目录;mode=new:新建目录并登记(需要 parentPath + name);mode=git:克隆远端仓库并登记(需要 gitUrl + parentPath,name 缺省从 URL 推导)。项目落点在默认项目根目录内时直接创建;根目录外会先征求用户确认。',
        'Create / register a project. mode=existing registers an existing directory; mode=new creates and registers one (needs parentPath + name); mode=git clones and registers a remote repository (needs gitUrl + parentPath; name defaults to the repo name from the URL). Locations inside the default projects root are created directly; outside it asks the user first.'
      ),
      inputSchema: z.object({
        mode: z.enum(['existing', 'new', 'git']).describe(tr('existing=登记已有目录;new=新建目录;git=克隆仓库', 'existing=register an existing directory; new=create a directory; git=clone a repository')),
        path: z.string().optional().describe(tr('mode=existing:项目目录的绝对路径', 'mode=existing: absolute path of the project directory')),
        parentPath: z.string().optional().describe(tr('mode=new/git:父目录绝对路径', 'mode=new/git: absolute path of the parent directory')),
        name: z.string().optional().describe(tr('mode=new 必填(目录名);mode=git 可选(目录名,缺省从 URL 推导);mode=existing 可选(展示名)', 'Required for mode=new (directory name); optional for mode=git (defaults from the URL); optional display name for mode=existing')),
        gitUrl: z.string().optional().describe(tr('mode=git:仓库地址(https / ssh)', 'mode=git: repository URL (https / ssh)'))
      }),
      execute: async ({ mode, path, parentPath, name, gitUrl }, options) => {
        try {
          let input: ProjectCreateInput
          if (mode === 'existing') {
            if (!path?.trim()) return '缺少 path(mode=existing 需要项目目录的绝对路径),请用 list_dirs 浏览或向用户确认。'
            input = { mode, path: path.trim(), ...(name?.trim() ? { name: name.trim() } : {}) }
          } else if (mode === 'new') {
            if (!parentPath?.trim() || !name?.trim())
              return '缺少 parentPath 或 name(mode=new 需要父目录绝对路径与目录名)。'
            input = { mode, parentPath: parentPath.trim(), name: name.trim() }
          } else {
            if (!gitUrl?.trim() || !parentPath?.trim()) return '缺少 gitUrl 或 parentPath(mode=git 需要)。'
            input = {
              mode,
              gitUrl: gitUrl.trim(),
              parentPath: parentPath.trim(),
              ...(name?.trim() ? { name: name.trim() } : {})
            }
          }
          // 目标目录:existing 用 path;new 用 parent/name;git 用 parent/目录名(同服务端推导规则)
          const target =
            mode === 'existing'
              ? resolve(path!.trim())
              : join(parentPath!.trim(), (name?.trim() || repoNameFromUrl(gitUrl?.trim() ?? '') || ''))
          const inRoot = deps.projects.isInsideProjectsRoot(target)
          const refused = await guardMutation(deps, {
            needsConfirm: !inRoot,
            denied: '项目未创建',
            command: `创建项目 ${target}${mode === 'git' ? `(克隆自 ${gitUrl!.trim()})` : ''}`,
            toolCallId: options.toolCallId,
            toolName: 'create_project'
          })
          if (refused) return refused
          const workspace = await deps.projects.createProject(input)
          return JSON.stringify({ ok: true, workspace })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    open_project: tool({
      description: tr(
        '请求界面打开(切换到)某个项目。只上报意图不改服务端状态:界面收到结果后会自动切换工作区。项目 id 来自 list_projects。',
        'Ask the UI to open (switch to) a project. This only reports intent and does not change server state; the UI switches the workspace after receiving the result. Project ids come from list_projects.'
      ),
      inputSchema: z.object({
        workspaceId: z.string().describe(tr('项目 id(list_projects 返回的 id)', 'Project id (as returned by list_projects)'))
      }),
      execute: async ({ workspaceId }) => {
        const workspace = deps.domainApi.getWorkspace(workspaceId)
        if (!workspace) throw new Error(`项目不存在:${workspaceId}(用 list_projects 先拿清单)`)
        return JSON.stringify({ ok: true, workspace, note: '界面将切换到该项目' })
      }
    }),

    create_conversation: tool({
      description: tr(
        '在某个项目下新建一个会话(不发送任何消息,界面会打开它等用户输入)。模型默认用当前对话正在用的那个;不要用它建 ACP 会话(那只能在界面的「新建会话」里选)。项目 id 来自 list_projects。',
        'Create a conversation under a project (sends no message; the UI opens it and waits for the user). The model defaults to the one used by the current conversation; do not use this for ACP conversations (those can only be chosen via “New conversation” in the UI). Project ids come from list_projects.'
      ),
      inputSchema: z.object({
        workspaceId: z.string().describe(tr('项目 id(list_projects 返回的 id)', 'Project id (as returned by list_projects)')),
        title: z.string().optional().describe(tr('会话标题;缺省「新会话」', 'Conversation title; defaults to “New conversation”')),
        prompt: z
          .string()
          .optional()
          .describe(tr('要预填到新会话输入框里的提示词(纯 UI 行为:界面会打开那个会话并把这段文字灌进输入框等用户确认)。你打算在这个会话里接着做的事写在这里;缺省就只打开空会话', 'Prompt text to prefill in the new conversation (pure UI behavior: the UI opens it and puts this text in the composer for the user to confirm). Put what you plan to do next in that conversation here; omit it to just open an empty conversation'))
      }),
      execute: async ({ workspaceId, title, prompt }, options) => {
        try {
          const workspace = deps.domainApi.getWorkspace(workspaceId)
          if (!workspace) throw new Error(`项目不存在:${workspaceId}(用 list_projects 先拿清单)`)
          // 建空会话免审批(见文件头);needsConfirm=false 时只可能被 readonly 档拦下
          const refused = await guardMutation(deps, {
            needsConfirm: false,
            denied: '会话未创建',
            command: `在项目「${workspace.name}」下新建会话`,
            toolCallId: options.toolCallId,
            toolName: 'create_conversation'
          })
          if (refused) return refused
          const conversation = await deps.conversations.createConversation({
            workspaceId,
            ...(title?.trim() ? { title: title.trim() } : {})
          })
          return JSON.stringify({
            ok: true,
            workspace: { id: workspace.id, name: workspace.name },
            conversation,
            // 提示词原样回传给前端动作解释器(lib/tool-actions.ts),只做输入框预填。
            // ⚠️ 它**不进** createConversation 的入参 —— 那是纯 UI 行为,不该落进会话存储。
            ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
            note: prompt?.trim() ? '界面将打开这个新会话并把提示词填进输入框' : '界面将打开这个新会话'
          })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    remove_project: tool({
      description: tr(
        '删除一个项目。缺省只移除登记(磁盘文件不动);deleteFiles=true 时连磁盘上的 worktree 目录一起删 —— 只对 worktree 项目生效,普通项目的磁盘目录不会被删除。删除前必须先向用户复述要删哪个,系统会弹确认卡。',
        'Delete a project. By default only unregisters it (disk files stay); deleteFiles=true also deletes the on-disk worktree directory — only effective for worktree projects; normal project directories are never deleted. Restate which project will be deleted to the user first; the system shows a confirmation card.'
      ),
      inputSchema: z.object({
        workspaceId: z.string().describe(tr('项目 id', 'Project id')),
        deleteFiles: z.boolean().optional().describe(tr('连磁盘 worktree 目录一起删(只对 worktree 项目生效);缺省 false', 'Also delete the on-disk worktree directory (worktree projects only); default false'))
      }),
      execute: async ({ workspaceId, deleteFiles = false }, options) => {
        try {
          const workspace = deps.domainApi.getWorkspace(workspaceId)
          if (!workspace) throw new Error(`项目不存在:${workspaceId}`)
          const refused = await guardMutation(deps, {
            needsConfirm: true,
            denied: '项目未删除',
            command: `删除项目「${workspace.name}」(${workspace.path})${deleteFiles ? ',并删除其磁盘 worktree 目录' : '(仅移除登记,不动磁盘文件)'}`,
            toolCallId: options.toolCallId,
            toolName: 'remove_project'
          })
          if (refused) return refused
          const workspaces = await deps.projects.removeProject(workspaceId, { deleteWorktree: deleteFiles })
          return JSON.stringify({ ok: true, removed: workspace.name, remaining: workspaces.length })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    create_worktree: tool({
      description: tr(
        '在一个项目下新建 git worktree(独立工作树,落点 <项目目录>/.worktree/<标识>,并新建分支 worktree/<标识>),登记成子项目。要求源项目是 git 仓库且至少有一次提交。创建前系统会弹确认卡。',
        'Create a git worktree under a project (an independent tree at <project>/.worktree/<id>, with a new branch worktree/<id>) and register it as a child project. The source project must be a git repo with at least one commit. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        workspaceId: z.string().describe(tr('源项目 id', 'Source project id')),
        identifier: z.string().describe(tr('worktree 标识:字母 / 数字开头,可含 - _ .;既是目录名也是分支名的一部分', 'Worktree identifier: starts with a letter / digit and may contain - _ .; used as directory name and part of the branch name')),
        name: z.string().optional().describe(tr('新项目展示名;缺省用 identifier', 'Display name for the new project; defaults to identifier')),
        baseBranch: z.string().optional().describe(tr('基线分支;缺省仓库当前分支', 'Base branch; defaults to the repository’s current branch'))
      }),
      execute: async ({ workspaceId, identifier, name, baseBranch }, options) => {
        try {
          const workspace = deps.domainApi.getWorkspace(workspaceId)
          if (!workspace) throw new Error(`项目不存在:${workspaceId}`)
          const refused = await guardMutation(deps, {
            needsConfirm: true,
            denied: 'worktree 未创建',
            command: `在项目「${workspace.name}」下创建 worktree ${identifier}${baseBranch?.trim() ? `(基线 ${baseBranch.trim()})` : ''}`,
            toolCallId: options.toolCallId,
            toolName: 'create_worktree'
          })
          if (refused) return refused
          const created = await deps.projects.createWorktree(workspaceId, {
            identifier: identifier.trim(),
            ...(name?.trim() ? { name: name.trim() } : {}),
            ...(baseBranch?.trim() ? { baseBranch: baseBranch.trim() } : {})
          })
          return JSON.stringify({ ok: true, workspace: created })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    remove_worktree: tool({
      description: tr(
        '删除一个 worktree 子项目(登记 + 磁盘目录一起删)。只能删 worktree 项目,普通项目请用 remove_project。删除前系统会弹确认卡。',
        'Delete a worktree child project (unregister and delete its disk directory together). Only worktree projects may be deleted this way; use remove_project for normal projects. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        workspaceId: z.string().describe(tr('worktree 子项目 id', 'Worktree child project id'))
      }),
      execute: async ({ workspaceId }, options) => {
        try {
          const workspace = deps.domainApi.getWorkspace(workspaceId)
          if (!workspace) throw new Error(`项目不存在:${workspaceId}`)
          if (!workspace.isWorktree) {
            return `「${workspace.name}」不是 worktree 项目;删除普通项目请用 remove_project。`
          }
          const refused = await guardMutation(deps, {
            needsConfirm: true,
            denied: 'worktree 未删除',
            command: `删除 worktree 项目「${workspace.name}」(${workspace.path}),含磁盘目录`,
            toolCallId: options.toolCallId,
            toolName: 'remove_worktree'
          })
          if (refused) return refused
          await deps.projects.removeProject(workspaceId, { deleteWorktree: true })
          return JSON.stringify({ ok: true, removed: workspace.name })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    list_task_triggers: tool({
      description: tr(
        '列出定时任务,含 id / 名称 / 归属项目 / 排程 / 启用态 / 下次触发时间。给 workspaceId 只看某个项目的,缺省列全部。改 / 删 / 启停定时任务前先用它拿到 id。',
        'List scheduled tasks with id / name / project / schedule / enabled state / next run time. Pass workspaceId to limit to one project; otherwise all are listed. Use it to get ids before editing / deleting / enabling tasks.'
      ),
      inputSchema: z.object({
        workspaceId: z.string().optional().describe(tr('项目 id;缺省列出全部项目的定时任务', 'Project id; omit to list scheduled tasks from all projects'))
      }),
      execute: async ({ workspaceId }) => {
        try {
          const list = deps.triggers.list(workspaceId?.trim() || undefined)
          return JSON.stringify(list, null, 2)
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    create_task_trigger: tool({
      description: tr(
        '给某个项目建一个**定时任务**:到点自动起一个会话,把 prompt 当作需求发给 agent 去做(无人值守、完全访问权限)。cron 是 5 段「分 时 日 月 周」(如 0 9 * * * = 每天 09:00,*/30 * * * * = 每 30 分钟);只跑一次的将来时刻用 at(毫秒时间戳,必须晚于现在)。创建前系统会弹确认卡。',
        'Create a **scheduled task** for a project: at the scheduled time it starts a conversation and sends prompt to the agent (unattended, full access). cron uses 5 fields “minute hour day month weekday” (e.g. 0 9 * * * = daily at 09:00; */30 * * * * = every 30 minutes); for a one-off future time use at (epoch milliseconds, must be in the future). A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        workspaceId: z.string().describe(tr('项目 id(list_projects 返回的 id)', 'Project id (as returned by list_projects)')),
        name: z.string().describe(tr('任务名,展示用,如「每日依赖巡检」', 'Task name for display, e.g. “Daily dependency check”')),
        prompt: z.string().describe(tr('触发时发给 agent 的需求原文,写清要它做什么、做完汇报什么', 'The exact request sent to the agent when triggered; state what it should do and what to report')),
        cron: z
          .string()
          .optional()
          .describe(tr('5 段 cron:分 时 日 月 周(如 0 9 * * *);与 at 二选一', '5-field cron: minute hour day month weekday (e.g. 0 9 * * *); choose either this or at')),
        at: z
          .number()
          .optional()
          .describe(tr('一次性触发时刻(毫秒级时间戳,必须晚于当前时间);能用 cron 表达就别用它', 'One-off trigger time (epoch milliseconds, must be in the future); prefer cron when it can express the schedule'))
      }),
      execute: async ({ workspaceId, name, prompt, cron, at }, options) => {
        try {
          const workspace = deps.domainApi.getWorkspace(workspaceId)
          if (!workspace) throw new Error(`项目不存在:${workspaceId}(用 list_projects 先拿清单)`)
          if (!name?.trim()) return '缺少 name(任务名)。'
          if (!prompt?.trim()) return '缺少 prompt(触发时要发给 agent 的需求原文)。'
          const expr = cron?.trim()
          if (!expr && at === undefined) {
            return '需要 cron(5 段定时表达式)或 at(一次性触发时刻)其中之一;没有触发时间就不会被调度。'
          }
          if (expr && at !== undefined) return 'cron 与 at 只能给一个:定时用 cron,只跑一次用 at。'
          const refused = await guardMutation(deps, {
            needsConfirm: true,
            denied: '定时任务未创建',
            command: `在项目「${workspace.name}」创建定时任务「${name.trim()}」:${
              expr ?? `一次性 ${new Date(at!).toISOString()}`
            } —— 到点会以完全访问权限无人值守地跑 agent`,
            toolCallId: options.toolCallId,
            toolName: 'create_task_trigger'
          })
          if (refused) return refused
          const created = await deps.triggers.create({
            workspaceId,
            name: name.trim(),
            prompt: prompt.trim(),
            ...(expr ? { cron: expr } : {}),
            ...(at !== undefined ? { at } : {})
          })
          return JSON.stringify({ ok: true, ...created })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    update_task_trigger: tool({
      description: tr(
        '修改一个定时任务:可改 name(任务名)、prompt(需求原文)、cron / at(触发时间)、enabled(启用态)。**只传要改的字段,其余保持原样**;给了 cron 或 at 之一 = 把触发方式换成那种(两者互斥)。id 来自 list_task_triggers。修改前系统会弹确认卡。',
        'Update a scheduled task: name, prompt, cron / at (schedule), enabled. **Pass only the fields to change; the rest stay as-is**; passing cron or at switches the trigger type (they are mutually exclusive). Ids come from list_task_triggers. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('定时任务 id(list_task_triggers 返回的 id)', 'Scheduled task id (as returned by list_task_triggers)')),
        name: z.string().optional().describe(tr('新的任务名', 'New task name')),
        prompt: z.string().optional().describe(tr('新的需求原文(触发时发给 agent 的话)', 'New request text (sent to the agent on trigger)')),
        cron: z
          .string()
          .optional()
          .describe(tr('新的 5 段 cron(分 时 日 月 周);与 at 互斥,给了就把触发方式换成 cron', 'New 5-field cron (minute hour day month weekday); mutually exclusive with at — supplying it switches the trigger type to cron')),
        at: z
          .number()
          .optional()
          .describe(tr('新的一次性触发时刻(毫秒时间戳,必须晚于现在);与 cron 互斥,给了就把触发方式换成 at', 'New one-off trigger time (epoch milliseconds, must be in the future); mutually exclusive with cron — supplying it switches the trigger type to at')),
        enabled: z.boolean().optional().describe(tr('顺带启用 / 停用(缺省保持原状)', 'Also enable / disable (left unchanged by default)'))
      }),
      execute: async ({ id, name, prompt, cron, at, enabled }, options) => {
        try {
          const trigger = deps.triggers.list().find((t) => t.id === id)
          if (!trigger) return `找不到定时任务 ${id}(用 list_task_triggers 拿最新清单)。`
          const changes: string[] = []
          if (name?.trim()) changes.push(`名称改为「${name.trim()}」`)
          if (prompt?.trim()) changes.push('更新需求原文')
          if (cron?.trim()) changes.push(`触发方式改为 cron ${cron.trim()}`)
          if (at !== undefined) changes.push(`触发方式改为一次性 ${new Date(at).toISOString()}`)
          if (enabled !== undefined) changes.push(enabled ? '启用' : '停用')
          if (!changes.length) return '没有给出要修改的字段(name / prompt / cron / at / enabled 至少给一个)。'
          const refused = await guardMutation(deps, {
            needsConfirm: true,
            denied: '定时任务未修改',
            command: `修改定时任务「${trigger.name}」:${changes.join('、')}`,
            toolCallId: options.toolCallId,
            toolName: 'update_task_trigger'
          })
          if (refused) return refused
          const saved = await deps.triggers.update({
            id,
            ...(name?.trim() ? { name: name.trim() } : {}),
            ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
            ...(cron?.trim() ? { cron: cron.trim() } : {}),
            ...(at !== undefined ? { at } : {}),
            ...(enabled !== undefined ? { enabled } : {})
          })
          return JSON.stringify({ ok: true, ...saved })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    delete_task_trigger: tool({
      description: tr(
        '删除一个定时任务(只删规则,不动它已经起出来的会话)。id 来自 list_task_triggers。删除前系统会弹确认卡。',
        'Delete a scheduled task (deletes only the rule, not conversations it already started). Ids come from list_task_triggers. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('定时任务 id(list_task_triggers 返回的 id)', 'Scheduled task id (as returned by list_task_triggers)'))
      }),
      execute: async ({ id }, options) => {
        try {
          const trigger = deps.triggers.list().find((t) => t.id === id)
          if (!trigger) return `找不到定时任务 ${id}(用 list_task_triggers 拿最新清单)。`
          const refused = await guardMutation(deps, {
            needsConfirm: true,
            denied: '定时任务未删除',
            command: `删除定时任务「${trigger.name}」`,
            toolCallId: options.toolCallId,
            toolName: 'delete_task_trigger'
          })
          if (refused) return refused
          deps.triggers.remove(id)
          return JSON.stringify({ ok: true, removed: trigger.name })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    set_task_trigger_enabled: tool({
      description: tr(
        '启用 / 停用一个定时任务。停用后不再触发;启用即恢复。id 来自 list_task_triggers。系统会弹确认卡。',
        'Enable / disable a scheduled task. Disabled tasks stop firing; enabling resumes them. Ids come from list_task_triggers. A confirmation card is shown.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('定时任务 id(list_task_triggers 返回的 id)', 'Scheduled task id (as returned by list_task_triggers)')),
        enabled: z.boolean().describe(tr('true = 启用,false = 停用', 'true = enable, false = disable'))
      }),
      execute: async ({ id, enabled }, options) => {
        try {
          const trigger = deps.triggers.list().find((t) => t.id === id)
          if (!trigger) return `找不到定时任务 ${id}(用 list_task_triggers 拿最新清单)。`
          const refused = await guardMutation(deps, {
            needsConfirm: true,
            denied: '定时任务未改动',
            command: `${enabled ? '启用' : '停用'}定时任务「${trigger.name}」`,
            toolCallId: options.toolCallId,
            toolName: 'set_task_trigger_enabled'
          })
          if (refused) return refused
          const saved = deps.triggers.setEnabled(id, enabled)
          return JSON.stringify({ ok: true, ...saved })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    create_plugin: tool({
      description: tr(
        '给某个项目写一个插件(落点 <项目>/.fizz/plugins/<工具名>.ts),插件给 Agent **新增一个无参数工具** —— 之后每轮对话模型都能调用它。你只需给工具名 / 描述 / 行为脚本(execute 的函数体),服务端套模板生成合法插件并在落盘前真加载一遍(有问题当场报错)。插件**下一轮对话**生效,之后可以在「项目插件」弹窗里停用。创建前系统会弹确认卡。',
        'Write a plugin for a project (at <project>/.fizz/plugins/<tool-name>.ts) that adds **one parameterless tool** to the agent, callable in later turns. Provide the tool name / description / behavior script (execute body); the server wraps it in a template, validates it by loading it before writing, and reports problems immediately. The plugin takes effect **next turn** and can be disabled later in the “Project plugins” dialog. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        workspaceId: z.string().describe(tr('项目 id(list_projects 返回的 id)', 'Project id (as returned by list_projects)')),
        name: z.string().describe(tr('插件展示名(可中文),如「每日站会纪要」', 'Plugin display name (may be Chinese), e.g. “Daily standup notes”')),
        toolName: z
          .string()
          .describe(tr('注册给 Agent 的工具名:ASCII 字母开头,可含数字 / _ / -(如 weather_report);文件名由它推导', 'Tool name registered with the agent: starts with an ASCII letter, may contain digits / _ / - (e.g. weather_report); the file name derives from it')),
        toolDescription: z
          .string()
          .describe(tr('工具描述,模型据此决定何时调用;写清这个工具做什么、返回什么', 'Tool description used by the model to decide when to call it; state what it does and what it returns')),
        executeBody: z
          .string()
          .describe(
            'execute 的函数体源码(不含外层壳,可用 await,能 require / import node 内置模块)。必须以 return 给出一段文字 —— 那是模型唯一能读到的东西'
          ),
        hint: z
          .string()
          .optional()
          .describe(tr('可选:往系统提示词里补一句,说明什么时候该用这个工具(缺省不加)', 'Optional: a sentence appended to the system prompt explaining when to use this tool (omitted by default)')),
        mutating: z
          .boolean()
          .optional()
          .describe(tr('这个工具会不会改动东西(缺省 false);true 时在需要确认的会话里会走审批', 'Whether this tool mutates anything (default false); when true it goes through approval in conversations that require confirmation'))
      }),
      execute: async ({ workspaceId, name, toolName, toolDescription, executeBody, hint, mutating }, options) => {
        try {
          const workspace = deps.domainApi.getWorkspace(workspaceId)
          if (!workspace) throw new Error(`项目不存在:${workspaceId}(用 list_projects 先拿清单)`)
          const pluginName = name?.trim()
          const tool = toolName?.trim()
          const body = executeBody?.trim()
          if (!pluginName) return '缺少 name(插件展示名)。'
          if (!TOOL_NAME_RE.test(tool ?? '')) {
            return `toolName 不合法:「${toolName ?? ''}」。要用 ASCII 字母开头、只含字母 / 数字 / _ / -(如 weather_report)。`
          }
          if (!toolDescription?.trim()) return '缺少 toolDescription(模型据此决定何时调用,不能省)。'
          if (!body) return '缺少 executeBody(工具的行为脚本)。'
          if (!/\breturn\b/.test(body)) {
            return 'executeBody 里没有 return:工具的返回值是模型唯一能读到的内容,必须 return 一段文字。'
          }
          // 由 toolName 推文件名(ASCII,不必再让模型起一个名字)
          const dirName = pluginDirName(tool!)
          const refused = await guardMutation(deps, {
            needsConfirm: true,
            denied: '插件未创建',
            command: `在项目「${workspace.name}」写一个插件 .fizz/plugins/${dirName}/(给 Agent 加工具 ${tool}),下一轮对话开始生效`,
            toolCallId: options.toolCallId,
            toolName: 'create_plugin'
          })
          if (refused) return refused
          const created = await deps.plugins.create({
            workspaceId,
            name: pluginName,
            toolName: tool!,
            toolDescription: toolDescription.trim(),
            executeBody: body,
            ...(hint?.trim() ? { hint: hint.trim() } : {}),
            ...(mutating !== undefined ? { mutating } : {})
          })
          return JSON.stringify({
            ok: true,
            ...created,
            note: '下一轮对话开始时这个工具会挂上;可在「项目插件」弹窗里查看 / 停用'
          })
        } catch (err) {
          rethrow(err)
        }
      }
    })
  }
}
