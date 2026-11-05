/**
 * MCP 配置工具组：列 / 增 / 改 / 删 MCP server（外部工具服务），外加「连上它、列出它
 * 自己提供哪些工具」的自检。
 *
 * ## 挂在哪
 * 与 `model-tools.ts` 同一批：**只挂给全局 AI 助手**
 * （`apps/server/src/server/assistant-turn.ts` 的 `scope: 'project'`）。普通项目会话不挂 ——
 * 它改的是全局设置（配好之后所有会话都能选），与 `project-tools` 同一条理由。
 *
 * ## 这组工具**不负责**让助手用上 MCP 工具
 * MCP 的启用是**会话级**的（`AgentConversation.mcpServerIds` + 输入框上方那颗扳手 pill）。
 * 助手这一轮的工具集在 `runAgent` 之前就定死了，在这儿新建一个 server 本轮也拿不到它的
 * 工具。所以回话里必须说清「配好了，去会话工具条里勾选」，别让用户以为配完自动生效。
 *
 * ## 审批口径（与 project-tools / model-tools 完全一致）
 * - `readonly` 档：所有变更直接拒绝；
 * - 其余档：变更**一律弹审批卡** —— stdio 配置的是「以后会被拉起来的命令」（等于往 agent
 *   的能力面里塞一个任意子进程），http/sse 的 headers 里常常是长期 token，动手前要让用户
 *   看一眼；
 * - `list_mcp_servers` / `list_mcp_server_tools` 不拦：前者只读配置，后者是「连一下、
 *   列工具、立刻断开」，与设置页那颗扳手按钮同源。
 *
 * ## 三条容易写错的地方
 * 1. **`domain.saveMcpServer` 是整份重建**：`args` 缺省写 `[]`，`env` / `headers` 不给就
 *    从结果里消失。所以「只改个名字」也必须把现有字段合并回来再整份写回 —— 直接用 patch
 *    调用会把参数、环境变量、请求头一起抹掉（`mergeMcpServerInput` 就是干这个的）。
 * 2. **`env` / `headers` 的值是凭据**：给模型看的视图只报键名（`envKeys` / `headerKeys`），
 *    值一律不写进对话上下文（与模型配置 `apiKey` 只报 `hasApiKey` 同一条口径）。
 * 3. **传输方式换了，另一组字段不清空**（domain 层故意的：切回去还在）。所以更新时不要
 *    「顺手把不用的那组删掉」—— 那不是本组的决定权。
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { tr } from '@fizz/i18n'
import type {
  McpServerConfig,
  McpServerInput,
  McpToolInfo,
  McpTransport
} from '@fizz/mcp/types'
import { normalizeMcpTransport } from '@fizz/mcp/types'
import { guardMutation, type MutationGuardDeps } from './project-tools'

/**
 * 工具组依赖：服务端注入 `domain.listMcpServers / saveMcpServer / deleteMcpServer` 与
 * `probeMcpServerTools`。签名全部结构化 —— `packages/tools` 不 import 服务端模块，
 * 也不在运行期 import `@fizz/mcp` 根入口（那边会把 MCP SDK 拖进来，只有服务端该付）。
 */
export interface McpToolsDeps extends MutationGuardDeps {
  mcp: {
    list(): McpServerConfig[]
    /** 整份 upsert（带 id = 更新，领域层不接受「只改一个字段」） */
    save(input: McpServerInput): McpServerConfig
    remove(id: string): McpServerConfig[]
    /** 连上 → listTools → 断开；与设置页「看工具」同一份实现 */
    probe(server: McpServerConfig): Promise<{ infos: McpToolInfo[]; errors: string[] }>
  }
}

/** 本组的工具名清单（与其它工具组同一风格，便于集中核对） */
export const MCP_TOOLS = [
  'list_mcp_servers',
  'list_mcp_server_tools',
  'create_mcp_server',
  'update_mcp_server',
  'delete_mcp_server'
] as const

/** 传输方式（zod 要具体字面量，与 `McpTransport` 一一对应） */
const TRANSPORT = z.enum(['stdio', 'http', 'sse'])

/** 键值对（环境变量 / 请求头）：值可能是 token，只进配置、不回显 */
const KV = z.record(z.string(), z.string())

/**
 * 更新时的补丁：**缺省 = 保持原样**，`null` = 显式清空。
 *
 * 为什么 `env` / `headers` 要三态：它们可能装着凭据，「不动它」和「把它清空」是两件事，
 * 靠「传空对象」区分不了（空对象也可能是用户手滑）。
 */
export interface McpServerPatch {
  name?: string
  transport?: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string> | null
  url?: string
  headers?: Record<string, string> | null
}

/** 比较两个键值对是否一致（不比值以外的顺序：键集 + 逐键值） */
function sameRecord(a?: Record<string, string>, b?: Record<string, string>): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => left[key] === right[key])
}

/**
 * 把补丁并进现有配置，产出**可以直接交给 `saveMcpServer` 的整份入参**。
 *
 * 关键在「缺省保持原样」：`saveMcpServer` 收到什么就写什么，漏一个字段等于清空它。
 */
export function mergeMcpServerInput(current: McpServerConfig, patch: McpServerPatch): McpServerInput {
  const transport = patch.transport ?? normalizeMcpTransport(current.transport)
  const command = patch.command === undefined ? (current.command ?? '') : patch.command.trim()
  const url = patch.url === undefined ? (current.url ?? '') : patch.url.trim()
  const args = patch.args ?? current.args ?? []
  // 三态：缺省 = 沿用现值，null = 清空（不带这个键），对象 = 整份替换
  const env = patch.env === null ? undefined : (patch.env ?? current.env)
  const headers = patch.headers === null ? undefined : (patch.headers ?? current.headers)
  const rawName = patch.name === undefined ? current.name : patch.name.trim()
  return {
    // 名字留空就拿「命令 / 地址」顶上：与设置页同一条兜底，总得有个能认出来的标题
    name: rawName || (transport === 'stdio' ? command : url) || current.name,
    transport,
    ...(command ? { command } : {}),
    args,
    ...(env && Object.keys(env).length ? { env } : {}),
    ...(url ? { url } : {}),
    ...(headers && Object.keys(headers).length ? { headers } : {})
  }
}

/** 给模型看的视图：**只有键名，没有值**（env / headers 里常是 token） */
export function summarizeMcpServer(server: McpServerConfig): Record<string, unknown> {
  const transport = normalizeMcpTransport(server.transport)
  const envKeys = Object.keys(server.env ?? {})
  const headerKeys = Object.keys(server.headers ?? {})
  return {
    id: server.id,
    name: server.name,
    transport,
    ...(transport === 'stdio'
      ? {
          command: server.command ?? '',
          args: server.args ?? [],
          ...(envKeys.length ? { envKeys } : {})
        }
      : {
          url: server.url ?? '',
          ...(headerKeys.length ? { headerKeys } : {})
        })
  }
}

/** 一行摘要（与设置页列表同一份文案来源，但配置里的值不出现在这里） */
function summaryOf(server: McpServerConfig): string {
  const transport = normalizeMcpTransport(server.transport)
  if (transport !== 'stdio') return server.url ?? ''
  return [server.command ?? '', ...(server.args ?? [])].join(' ').trim()
}

/** 变更摘要（审批卡的正文）：逐项列出「改成了什么」，而不是笼统一句「更新配置」 */
export function describeMcpChanges(current: McpServerConfig, next: McpServerInput): string[] {
  const changes: string[] = []
  if (next.name !== current.name) changes.push(`名称改为「${next.name}」`)

  const prevTransport = normalizeMcpTransport(current.transport)
  const nextTransport = normalizeMcpTransport(next.transport)
  if (nextTransport !== prevTransport) changes.push(`传输方式改为 ${nextTransport}`)

  if ((next.command ?? '') !== (current.command ?? '')) {
    changes.push(next.command ? `启动命令改为 ${next.command}` : '清除启动命令')
  }
  const prevArgs = (current.args ?? []).join(' ')
  const nextArgs = (next.args ?? []).join(' ')
  if (prevArgs !== nextArgs) changes.push(`启动参数改为 ${nextArgs || '（空）'}`)
  if ((next.url ?? '') !== (current.url ?? '')) {
    changes.push(next.url ? `服务地址改为 ${next.url}` : '清除服务地址')
  }
  if (!sameRecord(current.env, next.env)) {
    const keys = Object.keys(next.env ?? {})
    changes.push(keys.length ? `环境变量改为 ${keys.join(' / ')}` : '清空环境变量')
  }
  if (!sameRecord(current.headers, next.headers)) {
    const keys = Object.keys(next.headers ?? {})
    changes.push(keys.length ? `请求头改为 ${keys.join(' / ')}` : '清空请求头')
  }
  return changes
}

/** 取一份配置；返回字符串 = 直接回给模型的说明（找不到） */
function findServer(deps: McpToolsDeps, id: string): McpServerConfig | string {
  const found = deps.mcp.list().find((item) => item.id === id)
  if (!found) return `找不到 MCP server ${id}（用 list_mcp_servers 拿最新清单）。`
  return found
}

/** 配置好后要用户去哪勾选 —— 每一条变更类回话都带上，避免「配完以为就能用」 */
const ENABLE_HINT =
  '配置已保存。MCP 是**按会话启用**的：去会话输入框上方那颗扳手（MCP）里勾选它，下一轮对话才会连接并使用它的工具；助手自己这一轮不会因此多出这些工具。'

export function buildMcpTools(deps: McpToolsDeps): ToolSet {
  return {
    list_mcp_servers: tool({
      description: tr(
        '列出已保存的 MCP server（外部工具服务）：id / 名称 / 传输方式（stdio 的命令与参数、http·sse 的地址）。环境变量与请求头只给键名，值拿不到（可能装着 token）。改 / 删之前先用它拿 id。注意：配好 ≠ 生效，还要在会话里勾选。',
        'List saved MCP servers (external tool services): id, name, transport, plus the stdio command/args or the http/sse URL. Env vars and headers are reported by key only — their values may be tokens and are not exposed. Use it to get ids before editing or deleting. Note: configured is not enabled — a conversation must select it.'
      ),
      inputSchema: z.object({}),
      execute: async () => {
        const list = deps.mcp.list().map(summarizeMcpServer)
        if (!list.length) {
          return '还没有配置任何 MCP server。要加一个用 create_mcp_server（先问用户是本地命令（stdio）还是远端地址（http / sse））。'
        }
        return JSON.stringify(list, null, 2)
      }
    }),

    list_mcp_server_tools: tool({
      description: tr(
        '连上某个 MCP server，列出它自己提供哪些工具（列完立刻断开，不会留下常驻连接）。用来验证配置是否正确 —— 连不上 / 报错会原样带回原因（stdio 多半是命令写错或依赖没装，http 多半是地址或鉴权不对）。只读，不弹审批。',
        'Connect to one MCP server and list the tools it provides (then disconnect immediately — no lingering connection). Use it to verify a configuration: failures come back verbatim (stdio is usually a wrong command or missing dependency; http is usually a wrong URL or auth). Read-only, no approval.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('MCP server id（list_mcp_servers 返回的 id）', 'MCP server id (as returned by list_mcp_servers)'))
      }),
      execute: async ({ id }) => {
        const server = findServer(deps, id)
        if (typeof server === 'string') return server
        try {
          const { infos, errors } = await deps.mcp.probe(server)
          return JSON.stringify(
            {
              ok: errors.length === 0,
              server: { id: server.id, name: server.name },
              count: infos.length,
              tools: infos.map((info) => ({
                name: info.name,
                ...(info.description ? { description: info.description.slice(0, 300) } : {})
              })),
              errors,
              ...(errors.length
                ? { hint: '连不上时先核对命令 / 地址与鉴权，改完用 update_mcp_server 保存再试；不要反复重试同一次调用。' }
                : {})
            },
            null,
            2
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return `探测失败：${message}\n（命令 / 地址可能不对；改完用 update_mcp_server 保存再试。）`
        }
      }
    }),

    create_mcp_server: tool({
      description: tr(
        '新增一个 MCP server。**stdio**（本地子进程）填 command + args + env，命令在**跑 Agent 的那台机器**上执行（npx / uvx / 绝对路径都行）；**http / sse**（远端服务）填 url + headers，需要鉴权的把 token 放 headers。名称可留空（自动用命令 / 地址顶上）。保存后只是「可以被选中」，还要在会话工具条里勾选才生效。创建前会弹审批卡。',
        'Add an MCP server. **stdio** (local subprocess) takes command + args + env, executed on the machine running the agent (npx / uvx / absolute paths all work); **http / sse** (remote) takes url + headers, with auth tokens in headers. The name may be omitted (falls back to the command/URL). Saving only makes it selectable — a conversation still has to enable it. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        name: z.string().optional().describe(tr('展示名（可中文）；缺省用命令 / 地址', 'Display name; defaults to the command/URL')),
        transport: TRANSPORT.optional().describe(tr('传输方式；缺省 stdio', 'Transport; defaults to stdio')),
        command: z.string().optional().describe(tr('stdio：启动命令，如 npx', 'stdio: launch command, e.g. npx')),
        args: z.array(z.string()).optional().describe(tr('stdio：启动参数，如 ["-y", "@modelcontextprotocol/server-filesystem", "D:/data"]', 'stdio: launch args, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "D:/data"]')),
        env: KV.optional().describe(tr('stdio：环境变量（值可以是 token，不会回显）', 'stdio: env vars (values may be tokens and are never echoed)')),
        url: z.string().optional().describe(tr('http / sse：服务地址，如 https://example.com/mcp', 'http / sse: service URL, e.g. https://example.com/mcp')),
        headers: KV.optional().describe(tr('http / sse：请求头，如 Authorization=Bearer …（不会回显）', 'http / sse: headers, e.g. Authorization=Bearer … (never echoed)'))
      }),
      execute: async ({ name, transport, command, args, env, url, headers }, options) => {
        const kind: McpTransport = transport ?? 'stdio'
        const stdio = kind === 'stdio'
        const trimmedCommand = command?.trim() ?? ''
        const trimmedUrl = url?.trim() ?? ''
        if (stdio && !trimmedCommand) {
          return 'stdio 需要 command（如 npx、uvx 或可执行文件的绝对路径）。'
        }
        if (!stdio && !trimmedUrl) {
          return `${kind} 需要 url（远端 MCP 的服务地址）。`
        }
        const label = name?.trim() || (stdio ? trimmedCommand : trimmedUrl)
        const detail = stdio
          ? [trimmedCommand, ...(args ?? [])].join(' ')
          : trimmedUrl
        const envKeys = Object.keys(env ?? {})
        const headerKeys = Object.keys(headers ?? {})
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: 'MCP server 未创建',
          command: `新建 MCP server「${label}」（${kind}：${detail}${
            envKeys.length ? `，环境变量 ${envKeys.join(' / ')}` : ''
          }${headerKeys.length ? `，请求头 ${headerKeys.join(' / ')}` : ''}）`,
          toolCallId: options.toolCallId,
          toolName: 'create_mcp_server'
        })
        if (refused) return refused
        try {
          const saved = deps.mcp.save({
            name: label,
            transport: kind,
            ...(stdio
              ? {
                  ...(trimmedCommand ? { command: trimmedCommand } : {}),
                  args: args ?? [],
                  ...(envKeys.length ? { env } : {})
                }
              : {
                  ...(trimmedUrl ? { url: trimmedUrl } : {}),
                  ...(headerKeys.length ? { headers } : {})
                })
          })
          return JSON.stringify({ ok: true, server: summarizeMcpServer(saved), note: ENABLE_HINT }, null, 2)
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err))
        }
      }
    }),

    update_mcp_server: tool({
      description: tr(
        '修改一个已保存的 MCP server。**只传要改的字段，其余保持原样**（名字 / 传输方式 / 命令 / 参数 / 环境变量 / 地址 / 请求头任选）。env 或 headers 传 null = 清空，传对象 = 整份替换，缺省 = 不动。切换传输方式时另一组字段会保留（切回去还在），不会被顺手删掉。改完要让用户重新勾选吗？不用 —— 勾选关系按 id 保留。修改前会弹审批卡。',
        'Update a saved MCP server. **Pass only the fields to change; the rest stay as-is** (name / transport / command / args / env / URL / headers). Pass null for env or headers to clear them, an object to replace them wholesale, or omit to keep them. Switching transport keeps the other group (so switching back still works) instead of deleting it. Selection is keyed by id, so it survives edits. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('MCP server id（list_mcp_servers 返回的 id）', 'MCP server id (as returned by list_mcp_servers)')),
        name: z.string().optional().describe(tr('新的展示名', 'New display name')),
        transport: TRANSPORT.optional().describe(tr('新的传输方式', 'New transport')),
        command: z.string().optional().describe(tr('stdio：新的启动命令', 'stdio: new launch command')),
        args: z.array(z.string()).optional().describe(tr('stdio：新的启动参数（整份替换，传 [] 清空）', 'stdio: new launch args (replaces wholesale; [] clears)')),
        env: KV.nullable().optional().describe(tr('stdio：环境变量（null = 清空，缺省 = 保持）', 'stdio: env vars (null clears, omitted keeps)')),
        url: z.string().optional().describe(tr('http / sse：新的服务地址', 'http / sse: new service URL')),
        headers: KV.nullable().optional().describe(tr('http / sse：请求头（null = 清空，缺省 = 保持）', 'http / sse: headers (null clears, omitted keeps)'))
      }),
      execute: async ({ id, ...patch }, options) => {
        const current = findServer(deps, id)
        if (typeof current === 'string') return current
        const next = mergeMcpServerInput(current, patch)
        const changes = describeMcpChanges(current, next)
        if (!changes.length) {
          return '没有给出要修改的字段（name / transport / command / args / env / url / headers 至少给一个，且值要和现在不同）。'
        }
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: 'MCP server 未修改',
          command: `修改 MCP server「${current.name}」：${changes.join('、')}`,
          toolCallId: options.toolCallId,
          toolName: 'update_mcp_server'
        })
        if (refused) return refused
        try {
          const saved = deps.mcp.save({ ...next, id: current.id })
          return JSON.stringify({ ok: true, server: summarizeMcpServer(saved), changes }, null, 2)
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err))
        }
      }
    }),

    delete_mcp_server: tool({
      description: tr(
        '删除一个 MCP server 配置。删掉就得重新添加；勾选过它的会话下一轮不再连接它（工具随之消失，模型会少掉那批能力）。删之前先用 list_mcp_servers 确认是哪一条，并向用户复述它的名称与命令 / 地址。删除前会弹审批卡。',
        'Delete an MCP server configuration. Re-adding means re-entering everything; conversations that selected it stop connecting next turn (its tools disappear). Confirm the target with list_mcp_servers and restate its name and command/URL before deleting. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('MCP server id（list_mcp_servers 返回的 id）', 'MCP server id (as returned by list_mcp_servers)'))
      }),
      execute: async ({ id }, options) => {
        const current = findServer(deps, id)
        if (typeof current === 'string') return current
        const transport = normalizeMcpTransport(current.transport)
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: 'MCP server 未删除',
          command: `删除 MCP server「${current.name}」（${transport}：${summaryOf(current)}），已勾选它的会话下一轮不再连接`,
          toolCallId: options.toolCallId,
          toolName: 'delete_mcp_server'
        })
        if (refused) return refused
        try {
          deps.mcp.remove(current.id)
          return JSON.stringify({ ok: true, removed: current.name, note: '已从配置里移除。' }, null, 2)
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err))
        }
      }
    })
  }
}
