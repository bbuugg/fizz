/**
 * MCP 工具集构建（无 Electron）：按配置连接 MCP server（stdio / http / sse），
 * 把工具转成 AI SDK ToolSet。
 *
 * 设计上与桌面端 `services/ai/mcp.ts` 同构，但**不依赖 storage**——配置由调用方传入，
 * 这样 server / cli 都能用同一份逻辑，桌面端换成 server 后端后也无需再维护自己那份。
 * 连接是惰性的：只在「列工具 / 真正跑一轮」时按需拉起，不在配置时预连。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  normalizeMcpTransport,
  type McpServerConfig,
  type McpServerTarget,
  type McpToolInfo
} from './types'

interface McpServerState {
  config: McpServerConfig
  client: Client | null
  error?: string
}

const CONNECT_TIMEOUT_MS = 15000

/** 子进程 stderr 留多少字节：够看清 npx / npm 的报错尾巴，又不至于把整段安装日志塞进设置页 */
const STDERR_TAIL_BYTES = 4000

/** 造好的 transport + 取「子进程 stderr 尾巴」的口子（`http` / `sse` 恒为空串） */
interface BuiltTransport {
  transport: Transport
  stderrTail: () => string
}

/**
 * 打包后的 GUI 进程 PATH 里常常没有 node / npx —— 这是「dev 能连、装完就 -32000」的头号原因。
 *
 * 实测（Windows + mise）：终端里 `npx` 解析到 `%LOCALAPPDATA%\mise\shims\npx.exe`；而从
 * 开始菜单启动的打包应用 PATH 里没有它，子进程压根没起来。SDK 默认把子进程 stderr
 * `inherit` 掉，GUI 进程又没有控制台，最后用户只看到一句 `MCP error -32000: Connection closed`
 * （真正的 `'npx' 不是内部或外部命令` 被吞了）。
 *
 * 这里只补「装了就在这儿」的目录：**存在、且不在当前 PATH 里**才前置，不覆盖用户显式配的 env。
 */
function stdioExtraPathDirs(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? ''
    const appData = process.env.APPDATA ?? ''
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const userProfile = process.env.USERPROFILE ?? ''
    return [
      programFiles && join(programFiles, 'nodejs'),
      appData && join(appData, 'npm'),
      // 版本管理器（mise / scoop）把可执行文件挂在 shims 目录：只进终端 PATH，GUI 进程通常拿不到
      localAppData && join(localAppData, 'mise', 'shims'),
      userProfile && join(userProfile, '.local', 'share', 'mise', 'shims'),
      userProfile && join(userProfile, 'scoop', 'shims')
    ].filter((dir): dir is string => Boolean(dir) && existsSync(dir))
  }
  if (process.platform === 'darwin') {
    // 从 Dock / Finder 起的 GUI 进程 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin
    return ['/opt/homebrew/bin', '/usr/local/bin'].filter((dir) => existsSync(dir))
  }
  return []
}

/**
 * stdio 子进程的环境：**整份继承**父进程，再让用户配的 env 覆盖，最后补齐 PATH。
 *
 * 不能只把 `config.env` 交给 SDK：它只透传 12 个 Windows 变量（`APPDATA` / `PATH` /
 * `SYSTEMROOT` …），**连 `PATHEXT` 都没有**。而 mise / volta / nvm 的 shim 正是靠
 * `PATHEXT` 去找真实二进制，缺了会报一句极具误导性的
 * `mise ERROR No version is set for shim: npx`（实测：全量 env 正常工作，只摘掉
 * `PATHEXT` 就必现，补回 `.COM;.EXE;.BAT;.CMD` 立刻恢复；`MISE_NODE_VERSION` 之类没用）。
 * 同理被丢掉的还有 `HTTP(S)_PROXY` 与 `npm_config_*` —— npx 装包会因此静默失败。
 */
function stdioEnv(config: McpServerTarget): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, config.env ?? {})
  // 连父进程都没有 PATHEXT（GUI 进程偶尔如此）时也得给上，否则任何 .cmd 包装器都解析不到
  if (process.platform === 'win32' && !env.PATHEXT) env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const current = (env[key] ?? '').split(delimiter).filter(Boolean)
  const extra = stdioExtraPathDirs().filter((dir) => !current.includes(dir))
  if (extra.length) env[key] = [...extra, ...current].join(delimiter)
  return env
}

/**
 * 解子进程 stderr：Windows 上 `cmd.exe` 的报错是控制台代码页（GBK），node 写的才是 UTF-8。
 *
 * 先按 UTF-8 解，出现替换字符再按 GBK 重解 —— 否则 `'npx' 不是内部或外部命令` 会变成
 * 一串 `'npx' �����ڲ����ⲿ���`，比不显示还难查。
 */
function decodeStderr(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  if (process.platform !== 'win32' || !utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

/**
 * 按配置造 transport —— 三种方式的**唯一**分叉点（列工具 / 真正跑一轮都走这里，
 * 免得两处各写一遍、跑偏）。
 *
 * `http` / `sse` 走远端地址，没有子进程要关；`sse` 是协议里的旧版（服务端还在用时选它），
 * 新服务一律 `http`。headers 直接进 `requestInit`，让 `Authorization` 之类的鉴权能透传。
 *
 * `stdio` 那条额外做两件排障相关的事（见 `stdioExtraPathDirs` / `decodeStderr`）：
 * 补 PATH、把子进程 stderr 收下来，否则连不上时只剩 `-32000 Connection closed` 一句。
 */
function createTransport(config: McpServerTarget): BuiltTransport {
  const transport = normalizeMcpTransport(config.transport)
  if (transport === 'stdio') {
    if (!config.command?.trim()) throw new Error('缺少启动命令')
    const stdio = new StdioClientTransport({
      command: config.command.trim(),
      args: config.args ?? [],
      env: stdioEnv(config),
      // SDK 默认 `inherit`：dev 从终端跑能看见，打包后的 GUI 进程没有控制台，等于把原因丢掉
      stderr: 'pipe'
    })
    let tail = Buffer.alloc(0)
    stdio.stderr?.on('data', (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk])
      if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES)
    })
    return { transport: stdio, stderrTail: () => decodeStderr(tail).trim() }
  }
  if (!config.url?.trim()) throw new Error('缺少服务地址')
  const url = new URL(config.url.trim())
  const requestInit: RequestInit = config.headers ? { headers: config.headers } : {}
  return {
    transport:
      transport === 'sse'
        ? new SSEClientTransport(url, { requestInit })
        : new StreamableHTTPClientTransport(url, { requestInit }),
    stderrTail: () => ''
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    )
  ])
}

/**
 * 把「连不上」翻译成一句能查的话。
 *
 * `MCP error -32000: Connection closed` 只说明「子进程没了」，真正的原因（`'npx' 不是
 * 内部或外部命令`、npm 装包失败、版本管理器解析不到 node）全在子进程 stderr 里，所以
 * 一定带上；stderr 一个字节都没有时，才补一条「PATH 里可能没有 node / npx」的提示 ——
 * 那正是打包后最常见、也最容易被误当成「MCP 坏了」的情况。
 */
function describeFailure(config: McpServerTarget, err: unknown, stderr: string): string {
  const message = err instanceof Error ? err.message : String(err)
  const lines = [`MCP[${config.name}] ${message}`]
  if (stderr) {
    lines.push(`--- 子进程 stderr ---\n${stderr}`)
    // mise / volta 的 shim 找不到真实二进制时会谎称「没设版本」，值得点破一句
    if (/No version is set for shim/i.test(stderr)) {
      lines.push(
        '（这句是版本管理器的 shim 找不到真实 node，不是版本没装：把 command 换成真实 npx ' +
          '的绝对路径 —— 别指 shims 目录 —— 或在 env 里补 `PATHEXT=.COM;.EXE;.BAT;.CMD`）'
      )
    }
    return lines.join('\n')
  }
  if (/\bENOENT\b/.test(message) || /-32000|Connection closed/i.test(message)) {
    lines.push(
      '子进程没起来，或者起来就退了，且没有任何 stderr。打包后最常见的原因是 PATH 里没有 ' +
        'node / npx（终端里有、应用的 GUI 进程里没有）：把 command 写成绝对路径' +
        '（Windows 如 C:\\Program Files\\nodejs\\npx.cmd），或在 env 里补一条 PATH 再试。'
    )
  }
  return lines.join('\n')
}

export interface McpToolset {
  tools: ToolSet
  infos: McpToolInfo[]
  errors: string[]
}

/**
 * 构建合并后的 AI SDK ToolSet（工具名冲突时以 server 名为前缀）。
 * 同时返回工具信息与连接错误，供 MCP 设置页预览。
 *
 * ⚠️ **调用方负责筛选**：这里不做任何启用 / 白名单过滤，传进来的都会去连。
 * 会话链路传的是「这个会话选中的那批」（`AgentConversation.mcpServerIds`），
 * 预览端点传的才是全部 —— 见各自调用点。
 */
export async function buildMcpToolset(configs: McpServerConfig[]): Promise<McpToolset> {
  const tools: ToolSet = {}
  const infos: McpToolInfo[] = []
  const errors: string[] = []

  await Promise.all(
    configs.map(async (config) => {
      let state: McpServerState = { config, client: null }
      let built: BuiltTransport | null = null
      try {
        const client = new Client({ name: 'fizz', version: '0.1.0' })
        built = createTransport(config)
        await withTimeout(
          client.connect(built.transport),
          CONNECT_TIMEOUT_MS,
          `连接 ${config.name}`
        )
        state = { config, client }
      } catch (err) {
        // 超时的话 connect 还悬着、子进程也还活着：主动收一次，别留孤儿
        await built?.transport.close().catch(() => undefined)
        errors.push(describeFailure(config, err, built?.stderrTail() ?? ''))
        return
      }

      try {
        const result = await state.client!.listTools()
        for (const t of result.tools) {
          const dupe = result.tools.some((o) => o.name === t.name && o !== t)
          const name = dupe ? `${config.name}__${t.name}` : t.name
          tools[name] = dynamicTool({
            description: t.description ?? `MCP 工具 ${t.name}`,
            inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
            execute: async (input: unknown) => {
              /*
               * `intent` 是引擎给界面注入的字段（`@fizz/agent` 的 `withToolIntent`），
               * 不属于工具自己的入参：严格的 MCP server 会按 `inputSchema` 校验 arguments，
               * 多一个字段就回「Invalid arguments」。转发前摘掉。
               */
              const rawArgs =
                input && typeof input === 'object' && !Array.isArray(input)
                  ? (input as Record<string, unknown>)
                  : {}
              const { intent: _intent, ...args } = rawArgs
              try {
                const res = (await state.client!.callTool({
                  name: t.name,
                  arguments: args
                })) as CallToolResult
                const isError = res.isError === true
                const text = (res.content ?? [])
                  .map((c) =>
                    c.type === 'text' && 'text' in c ? c.text : JSON.stringify(c)
                  )
                  .join('\n')
                return isError ? `[MCP 工具错误] ${text}` : text
              } catch (err) {
                return `[MCP 工具调用失败] ${err instanceof Error ? err.message : String(err)}`
              }
            }
          })
          infos.push({ serverName: config.name, name, description: t.description })
        }
      } catch (err) {
        errors.push(
          `MCP[${config.name}] 列出工具失败: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    })
  )
  return { tools, infos, errors }
}

/**
 * 探**单个** MCP server 自己的工具清单：连上 → `listTools` → **立刻把连接收掉**。
 *
 * 与 `buildMcpToolset` 的分工：
 * - 那个返回的 ToolSet 需要连接一直活着（工具要能被真正调用），所以它**不能**关；
 * - 这个是「看一眼就走」，必须在 finally 里 close —— 否则用户每点一次「工具」，
 *   服务端就多留一个常驻连接（stdio 是子进程，http/sse 则是挂着的 SSE 流）。
 *
 * 工具名**不加 server 前缀**（`buildMcpToolset` 只在多个 server 撞名时才加）：
 * 这里回答的是「这个 server 自己提供了哪些工具」，就该是它自己报的名字。
 */
export async function probeMcpServerTools(
  config: McpServerTarget
): Promise<{ infos: McpToolInfo[]; errors: string[] }> {
  const infos: McpToolInfo[] = []
  const errors: string[] = []
  let client: Client | null = null
  let built: BuiltTransport | null = null
  try {
    client = new Client({ name: 'fizz', version: '0.1.0' })
    built = createTransport(config)
    await withTimeout(
      client.connect(built.transport),
      CONNECT_TIMEOUT_MS,
      `连接 ${config.name}`
    )
    const result = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      `列出 ${config.name} 的工具`
    )
    for (const t of result.tools) {
      infos.push({ serverName: config.name, name: t.name, description: t.description })
    }
  } catch (err) {
    errors.push(describeFailure(config, err, built?.stderrTail() ?? ''))
  } finally {
    // close() 对 stdio 会连子进程一起收掉、对 http/sse 会掐掉那条 SSE 流；
    // 失败无所谓（远端可能已经自己断了）。超时那条路也靠它收尾，别留孤儿进程
    await client?.close().catch(() => undefined)
  }
  return { infos, errors }
}