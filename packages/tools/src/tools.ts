/**
 * 工作区 Agent 工具集：读 / 写 / 编辑 / 查文件（glob）/ 查内容（grep）/ 执行命令（bash）。
 *
 * 工具名、参数名、默认值、返回值信封与错误文案保持固定形状：同一段提示词、
 * 同一套模型习惯可以直接沿用。
 *
 * 几条刻意的约定：
 * - 路径用**相对工作区**的写法：Fizz 的模型一直按「路径相对工作区根」工作，
 *   改绝对路径会让它把服务器路径写进文件内容里；
 * - 读 / 查 / 执行结果后面还会追加一段「子目录 AGENTS.md 规则」（`nestedDocs`），
 *   这是 Fizz 的项目规则加载机制；
 * - 每个工具多一个 `intent` 字段（`@fizz/agent` 的 `withToolIntent` 注入，用于审批文案）。
 *
 * 所有工具都绑定一个工作区根目录（root），文件路径经 `resolveInside` 越界校验后落盘。
 *
 * 权限：**会改动东西的工具**（write / edit / bash）统一走 `guardWrite` 一道闸 ——
 * - `readonly`：直接回绝（不落盘、不执行），并告诉模型让用户去切换模式；
 * - `confirm`：经 requestConfirm 弹卡片等用户点「允许」，被拒绝就当次调用放弃；
 *   没有可用的 requestConfirm 通道时**按拒绝处理**（fail-closed）；
 * - `full`：放行。
 *
 * 只读类工具（read / glob / grep / read_skill）在任何模式下都不拦。
 */
import { spawn } from 'node:child_process'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { gitBashPath } from '@fizz/shells'
import { buildReadSkillTool, type AgentSkill } from '@fizz/skills'
import type {
  WorkspaceBackend,
  WorkspaceExecResult,
  WorkspaceSearchFile
} from '@fizz/contracts/workspace'
import { tr } from '@fizz/i18n'
import { stripAnsi } from './ansi'
import { createOutputDecoder } from './output-decoder'
import {
  createLocalBackend,
  killChild,
  MAX_SEARCH_FILE_SIZE,
  resolveShellSpawn
} from './backend'
import { summarizeLongOutput } from './output-log'
import { buildStrReplaceEditorTool } from './str-replace-editor'

export type AgentPermissionMode = 'full' | 'confirm' | 'readonly'

/**
 * 单个文件整体读入的上限（字节）：超过就不当文本处理。
 *
 * 超限只有「读不动」这一个理由（模型自己也读不动这么大一段），按行分段用
 * read 的 offset/limit 即可，不走 output-log（那里只留给 bash）。
 */
const MAX_FILE_BYTES = 8_000_000

/** 一次 read 的**默认且最大**行数（传更大的值是错误，不是夹取） */
const READ_LIMIT = 2000
/** 单行最长返回多少字符（超出截断并标注） */
const READ_MAX_LINE_LENGTH = 2000
/** 一次 read 最多返回多少字节（UTF-8，含行间的换行） */
const READ_MAX_BYTES = 50 * 1024

/** grep 一次最多保留多少条命中 */
const GREP_MAX_MATCHES = 250
/** grep 单行预览最多多少字符 */
const GREP_MAX_LINE_BYTES = 2000

/** glob 一次最多返回多少条路径 */
const GLOB_MAX_RESULTS = 100

/** 后端 stat 拼出的「版本」：文件变了这两个值一定有一个会动 */
function versionOf(stat: { size: number; mtimeMs?: number }): string {
  return `${stat.size}:${stat.mtimeMs ?? 0}`
}

export interface AgentToolOptions {
  /** 确认模式下 execute_command 执行前需用户批准（整轮固定的静态档） */
  permissionMode: AgentPermissionMode
  /**
   * **运行中实时读取权限档**（优先于上面的静态 `permissionMode`）。
   *
   * 工具集是**一轮建一次**的，静态值会把权限档快照死在整轮里 —— 用户在一轮中途把权限
   * 从「确认」切成「完全访问」（或反过来）时，下一轮才生效。传本 getter，闸门就会
   * **每次工具调用现取**，中途切换立刻生效。不传 = 退回静态快照（行为与从前一致）。
   */
  getPermissionMode?: () => AgentPermissionMode
  requestConfirm?: (req: {
    toolCallId: string
    toolName: string
    command: string
  }) => Promise<boolean>
  /**
   * `bash` 每次**启动命令前**调用：`stop` 由调用方持有，调用即杀
   * 这条命令的进程树（工具结果收尾成「已中止」）。整轮 abort 仍走
   * `options.abortSignal`（tools 内部把它联动到同一个 per-command controller）。
   * 不传 = 没有单条停止能力（行为与加这些回调之前逐字节一致）。
   */
  onCommandStart?: (toolCallId: string, stop: () => void) => void
  /** 命令收场（exit / 超时 / 中止 / 启动失败）时调用，只来一次 */
  onCommandEnd?: (toolCallId: string) => void
  /** 命令执行期间的 stdout / stderr 实时增量（纯转发，不缓存） */
  onCommandOutput?: (toolCallId: string, stream: 'stdout' | 'stderr', chunk: string) => void
  /**
   * `bash` 带 `run_in_background: true` 时调用：把它登记成一条**后台任务**。
   * 不传 = 没有后台执行能力（工具会如实回绝）。
   */
  onBackgroundCommand?: (req: { command: string; cwd: string; title: string }) => Promise<{
    id: string
  }>
  /** 可用技能：给了才挂 `read_skill`（否则模型拿着一份空清单乱试） */
  skills?: AgentSkill[]
  /**
   * 只暴露这些工具（按 key 白名单）；缺省 = 全给。
   *
   * 给 subagent 用：它只需要只读子集（explorer / reviewer），写操作留在父 agent。
   * ⚠️ 用**显式白名单**而不是「砍掉写工具」的黑名单 —— tools 每加一个，黑名单
   * 会自动漏放（静默多给能力），白名单则是显式失败（少一个 key 直接抛错）。
   */
  includeTools?: string[]
  /**
   * **子目录规则**的按需加载钩子：`read` 每次调用后带上目标路径（绝对）与是否目录，
   * 返回非空文本就追加到工具结果后面。
   *
   * 由 `@fizz/agent` 注入（读 `<目录>/AGENTS.md`，按会话去重）；不传 = 行为与从前一致。
   * 钩子抛错不影响工具结果本身（规则只是补充说明）。
   */
  nestedDocs?: (absPath: string, isDirectory: boolean) => Promise<string | null>
  /**
   * 工作区后端（本地 / 远端）。不传 = 用 `root` 现建本地后端（行为与从前一致）。
   *
   * 所有文件 / 搜索 / 命令工具都经它读写，`root` 在远端工作区里是该主机上的 POSIX
   * 绝对路径 —— 工具定义本身不再直接碰 `node:fs` / `spawn`。
   */
  backend?: WorkspaceBackend
}

/**
 * 按 `includeTools` 过滤工具集。缺省返回原对象。
 *
 * 白名单写错就抛错（调用方拼错 key / 工具改名了要立刻知道），**不静默过滤成空集** ——
 * 空集会让 subagent 感觉自己「没有工具可用」，模型侧表现为反复尝试调用一个不存在的工具。
 */
export function filterToolSet(tools: ToolSet, include?: string[]): ToolSet {
  if (!include) return tools
  const missing = include.filter((k) => !(k in tools))
  if (missing.length > 0) {
    throw new Error(`includeTools 里有不存在的工具：${missing.join(', ')}（现有：${Object.keys(tools).join(', ')}）`)
  }
  const out: ToolSet = {}
  for (const k of include) out[k] = tools[k]
  return out
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback
  return Math.max(min, Math.min(max, Math.trunc(v)))
}

/**
 * 读取文本文件：二进制（含 NUL）与超大文件直接报错。
 *
 * 超大文件报错的理由只剩「读不动」这一个（`MAX_FILE_BYTES`），不再是因为「太大不适合
 * 一次返回」—— 后者由 read 的 offset/limit 分段读解决。
 */
async function readTextFile(
  backend: WorkspaceBackend,
  abs: string,
  display: string
): Promise<string> {
  const stat = await backend.stat(abs)
  if (!stat) throw new Error(`cannot read "${display}": not found`)
  if (stat.type !== 'file') throw new Error(`cannot read "${display}": not a regular file`)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`cannot read "${display}": ${stat.size} bytes exceeds the ${MAX_FILE_BYTES}-byte limit`)
  }
  const buf = await backend.readFile(abs, { maxBytes: MAX_FILE_BYTES })
  if (buf.includes(0)) throw new Error(`cannot read "${display}": binary file`)
  return buf.toString('utf8')
}

// ---------- 结果信封（格式固定） ----------

/** read 的模型可见文本：`<path>/<type>/<content>` 信封 + `N: 行内容` + 分页脚注 */
function formatReadOutput(
  display: string,
  lines: Array<{ number: number; text: string }>,
  offset: number,
  totalLines: number,
  truncatedByBytes: boolean
): string {
  const endLine = lines.at(-1)?.number ?? Math.max(0, offset - 1)
  let footer: string
  if (truncatedByBytes) {
    footer = `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < totalLines) {
    footer = `(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${totalLines} lines)`
  }
  const body =
    lines.length > 0
      ? `${lines.map((line) => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
      : footer
  return `<path>${display}</path>
<type>file</type>
<content>
${body}
</content>`
}

/** write 的模型可见文本 */
function formatWriteOutput(display: string, created: boolean): string {
  return `<path>${display}</path>
<type>file</type>
<content>
${created ? 'Created file' : 'Updated file'}
</content>`
}

/** edit 的模型可见文本 */
function formatEditOutput(display: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${display} has been updated. All occurrences were successfully replaced.`
    : `The file ${display} has been updated successfully.`
}

// ---------- 编辑 ----------

/**
 * 字面量替换（精确匹配）。
 *
 * - 在 **LF 归一化**的文本上匹配，最后按原文的主流行尾还原（CRLF 文件改完还是 CRLF）；
 * - 默认**必须唯一命中**：0 处报「没找到」，多处要求 `replace_all`（模型自己决定）；
 * - 不存在「近似匹配」：行尾 / 缩进 / 行号前缀的差异都要模型自己抄对。
 */
export function applyLiteralEdit(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  display: string
): { text: string; count: number } {
  const crlf = (text.match(/\r\n/g)?.length ?? 0) > 0 && (text.match(/\r\n/g)?.length ?? 0) * 2 >= (text.match(/\n/g)?.length ?? 0)
  const lf = text.replace(/\r\n/g, '\n')
  const needle = oldString.replace(/\r\n/g, '\n')
  const replacement = newString.replace(/\r\n/g, '\n')
  if (needle.length === 0) throw new Error('old_string must be a non-empty string')

  const count = lf.split(needle).length - 1
  if (count === 0) throw new Error(`old_string was not found in "${display}"`)
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string matched ${count} times in "${display}"; provide a more specific old_string or set replace_all to true`
    )
  }

  const next = replaceAll ? lf.split(needle).join(replacement) : lf.replace(needle, replacement)
  return { text: crlf ? next.replace(/\n/g, '\r\n') : next, count }
}

// ---------- 命令执行 ----------

/** 后台命令的收场结果 */
export interface BackgroundShellExit {
  /** 退出码；`null` = 没拿到（被信号杀掉 / 启动就失败，看 `error`） */
  code: number | null
  /** 启动失败的原因（`spawn` 的 error 事件）；正常收场不带 */
  error?: string
  /** 是不是被 `kill()` / `signal` 停掉的（任务登记表据此判「已取消」而不是「失败」） */
  killed: boolean
}

export interface BackgroundShellHandle {
  /** 杀掉整棵进程树（幂等；已经退出的进程会被忽略） */
  kill: () => void
  /** 等它自己收场。**不会 reject** —— 启动失败也走 resolve，`error` 里带原因 */
  done: Promise<BackgroundShellExit>
}

/**
 * 起一条**脱离当前回合**的 shell 命令：不设超时、不挂 per-tool-call 取消，
 * 生命周期由调用方（后台任务登记表）持有。
 *
 * 与 `runCommand` 的差别只有三点：不缓存输出（调用方自己按环形缓冲留）、不设超时、
 * 不返回拼好的字符串。**shell 判定共用 `resolveShellSpawn`**，所以「直接跑」与
 * 「丢后台跑」对同一条命令的解释完全一致。
 *
 * 为什么这个函数在 tools 里而不是在服务端：shell 探测（Git Bash / pwsh / bash）是这一层
 * 的知识，服务端不该再抄一份 —— 抄出来的第二份迟早在 Windows 上和这一份对不上。
 */
export function spawnBackgroundShell(
  command: string,
  cwd: string,
  opts: {
    /** 逐块增量（不缓存、不截断 —— 缓存与上限归调用方） */
    onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
    /** 外部停止信号（任务被取消 / 应用退出） */
    signal?: AbortSignal
  } = {}
): BackgroundShellHandle {
  const { shellCmd, shellArgs, env, isWin } = resolveShellSpawn(command)
  let killed = false
  const child = spawn(shellCmd, shellArgs, {
    cwd,
    env,
    windowsHide: true,
    // POSIX 自成进程组：kill(-pid) 才能一次带走 `npm run` 派生出来的整棵树
    ...(isWin ? {} : { detached: true })
  })

  /**
   * 收树两次：立刻一记整树 kill，600ms 后再补一记。
   *
   * 补刀的理由与 `runCommand` 完全相同（Git Bash 的 `-lc`、`npm run` 的包装进程会在第一刀
   * 之后才 fork 出真正的命令），dev server 就是典型的孙子辈 —— 只打一记会漏掉它，
   * 用户看到「停不下来、端口还占着」。
   */
  const kill = (): void => {
    killed = true
    killChild(child, isWin)
    const straggler = setTimeout(() => killChild(child, isWin), 600)
    straggler.unref?.()
  }

  const onAbort = (): void => kill()
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  // 解码与 runCommand 同一套（UTF-8 优先、整行回退 GBK）：后台任务的日志同样会被
  // 命令里 powershell 的 GBK 输出污染，而它还要进面板日志、落盘给模型读
  const decodeStdout = createOutputDecoder()
  const decodeStderr = createOutputDecoder()
  child.stdout?.on('data', (d: Buffer) => {
    const chunk = decodeStdout.decode(d)
    if (chunk) opts.onOutput?.('stdout', chunk)
  })
  child.stderr?.on('data', (d: Buffer) => {
    const chunk = decodeStderr.decode(d)
    if (chunk) opts.onOutput?.('stderr', chunk)
  })

  const done = new Promise<BackgroundShellExit>((resolve) => {
    let settled = false
    const settle = (result: BackgroundShellExit): void => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    child.on('error', (err) => settle({ code: null, error: err.message, killed }))
    child.on('exit', (code) => {
      // 最后一行没有换行结尾时还压在解码器里，收口前吐出来（否则日志会缺最后一句报错）
      const tailOut = decodeStdout.flush()
      if (tailOut) opts.onOutput?.('stdout', tailOut)
      const tailErr = decodeStderr.flush()
      if (tailErr) opts.onOutput?.('stderr', tailErr)
      settle({ code: code ?? null, killed })
    })
  })

  return { kill, done }
}

// ---------- 工具集 ----------

/**
 * 引擎注入的「这一步的意图」（见 `@fizz/agent` 的 `withToolIntent`）。
 *
 * 它不在任何工具自己的 `inputSchema` 里（运行期统一注入），所以只能从入参对象上直接读，
 * 读不到就是空串。目前只有审批文案用得上：确认弹窗上写「修复类型错误（编辑文件）」
 * 比只写「编辑文件」有用得多。
 */
function intentOf(input: unknown): string {
  const value = (input as { intent?: unknown } | null | undefined)?.intent
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把后端执行结果拼成 `bash` 的模型可见文本：
 * stdout、`[stderr]` 段、`[exit code: N]` 标记；全空写 `(no output)`。
 *
 * 非 0 退出码**不是**工具错误（模型自己决定怎么办）；只有启动失败这种基础设施问题才抛错。
 */
async function formatBashOutput(
  backend: WorkspaceBackend,
  command: string,
  result: WorkspaceExecResult,
  timeoutMs: number
): Promise<string> {
  // 先剥 ANSI：`npm run` 会给脚本注入 FORCE_COLOR，vite / tsc / jest 照样吐颜色
  const out = stripAnsi(result.stdout)
  const err = stripAnsi(result.stderr)
  if (result.reason === 'error') {
    throw new Error(`command failed to start: ${result.error ?? 'unknown error'}`)
  }

  let body = out
  if (err.length > 0) {
    // stdout 通常自带结尾换行；没有的话补一个，别把两段粘成一行
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.trim().length === 0) body = '(no output)'

  const markers: string[] = []
  if (result.reason === 'timeout') markers.push(`[timed out after ${timeoutMs}ms]`)
  if (result.reason === 'aborted') markers.push('[stopped: cancelled]')
  if (result.reason === 'exit' && result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  const full = markers.length ? `${body.trimEnd()}\n${markers.join('\n')}` : body.trimEnd()
  return summarizeLongOutput(full, {
    backend,
    tool: 'bash',
    detail: command.slice(0, 200)
  })
}

/** 构建工作区 Agent 工具集（绑定 root 目录；改动类工具按权限模式拦一道） */
export function buildAgentTools(root: string, opts: AgentToolOptions): ToolSet {
  // 权限档**每次调用现取**：传了 getter 就以它为准（运行中切档立刻生效），否则退回静态快照
  const currentMode = (): AgentPermissionMode => opts.getPermissionMode?.() ?? opts.permissionMode
  // 文件 / 搜索 / 命令一律经后端：不传 = 本地（行为与从前一致），远端由服务端注入
  const backend = opts.backend ?? createLocalBackend(root)
  // 工具描述必须如实描述执行环境，模型才会放心用对应风格的命令
  const isWin = process.platform === 'win32'
  const bashPath = isWin ? gitBashPath() : null
  const shellNote =
    backend.kind === 'remote'
      ? '命令运行在远端 Linux 主机的 POSIX shell（bash/sh）中：可以用 ls / grep / sed / find / cat、管道与 Unix 语法；路径是远端主机上的绝对路径。'
      : isWin
        ? bashPath
          ? '命令运行在 Git Bash（POSIX）环境：可以用 ls / grep / sed / find / cat / 管道等 Unix 工具与语法；Windows 路径建议写成 C:/xxx 或 /c/xxx 形式。'
          : '命令运行在 PowerShell 环境（未检测到 Git Bash）。'
        : '命令运行在 bash 环境。'
  const shellNoteEn =
    backend.kind === 'remote'
      ? 'Commands run in a POSIX shell (bash/sh) on the remote Linux host: ls / grep / sed / find / cat, pipes, and Unix syntax are available; paths are absolute paths on that host.'
      : isWin
        ? bashPath
          ? 'Commands run in Git Bash (POSIX): you can use ls / grep / sed / find / cat, pipes, and Unix syntax. For Windows paths prefer C:/xxx or /c/xxx.'
          : 'Commands run in PowerShell (Git Bash not detected).'
        : 'Commands run in bash.'

  /**
   * 观察表：本次工具集生命周期内「模型读过哪些文件、读到的版本是什么」。
   *
   * 读后写保护：write / edit 只能改「读过且没被别人改过」的文件。
   * 工具集一轮建一次，所以这张表只活在**一轮**里（跨轮要重读）；
   * 校验是写前再 stat 一次，不是后端层的原子 CAS —— 中间被外部改掉的极小窗口仍存在。
   */
  const observed = new Map<string, string>()

  /**
   * 改动类工具的统一闸门。
   *
   * 返回 `null` = 放行；返回字符串 = 这个字符串就是**工具结果**（回绝说明），
   * 直接 return 回去即可 —— 不用抛错：回绝是「预期内的结果」，让模型看到原因后
   * 能向用户解释，而不是变成一个工具报错把整轮打断。
   */
  const guardWrite = async (
    denied: string,
    req: { toolCallId: string; toolName: string; command: string; intent?: string }
  ): Promise<string | null> => {
    // 每次调用现取：用户在一轮中途切了权限档时这里立刻按新档裁决
    const mode = currentMode()
    if (mode === 'readonly') {
      return `当前是只读模式：${denied}。请把这一点告诉用户（他可以在「设置 → 通用」里把权限切换成「确认模式」或「完全访问」），不要反复尝试同类操作。`
    }
    if (mode !== 'confirm') return null
    // 没有审批通道时**失败关闭**：与 `guardMutation` / `client-tool-gate` / ACP 同一条口径。
    // 曾经这里直接放行 —— 那等于「没人能点允许」的环境反而裸跑改动类工具，方向是反的。
    if (!opts.requestConfirm) {
      return `「${req.toolName}」需要用户确认，但当前环境没有可用的确认通道（无界面 / 未接入审批），已取消这次调用。请告诉用户这次没有执行，不要重试。`
    }
    const approved = await opts.requestConfirm(req)
    return approved
      ? null
      : `用户拒绝了这次调用：${denied}。请询问用户接下来希望怎么做，不要擅自重试同一步。`
  }

  /**
   * 读后写校验：没读过 → 明确让模型先读；读之后被外部改过 → 让它重读。
   * 返回 `null` = 放行。
   */
  const checkObserved = async (abs: string, display: string): Promise<string | null> => {
    const prior = observed.get(abs)
    const stat = await backend.stat(abs)
    if (!prior) {
      // 文件本来就不存在 = 新建，不需要「先读」
      if (!stat) return null
      return `cannot modify "${display}": file has not been read — read the file, then retry`
    }
    if (!stat) return `cannot write "${display}": file no longer exists — re-read the file, then retry`
    if (versionOf(stat) !== prior) {
      return `cannot write "${display}": file changed since it was read — re-read the file, then retry`
    }
    return null
  }

  /** 记下「这个文件现在是什么版本」（读成功 / 刚写完） */
  const recordObserved = async (abs: string): Promise<void> => {
    const stat = await backend.stat(abs)
    if (stat) observed.set(abs, versionOf(stat))
  }

  /** 把按需加载的子目录规则附在工具结果后面（没有规则 / 钩子抛错就原样返回） */
  const withNestedDocs = async (text: string, abs: string, isDirectory: boolean): Promise<string> => {
    if (!opts.nestedDocs) return text
    const extra = await opts.nestedDocs(abs, isDirectory).catch(() => null)
    return extra ? `${text}\n\n${extra}` : text
  }

  const all = {
    read: tool({
      description:
        'Read a UTF-8 text file and return line-numbered content.',
      inputSchema: z.object({
        file_path: z.string().describe('Path to read, resolved by the filesystem backend.'),
        offset: z.number().optional().describe('1-based first line to return. Defaults to 1.'),
        limit: z
          .number()
          .optional()
          .describe(`Maximum number of lines to return. Defaults to ${READ_LIMIT}.`)
      }),
      execute: async ({ file_path, offset, limit }) => {
        if (file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
        const startLine = offset === undefined ? 1 : Math.trunc(offset)
        if (!Number.isFinite(startLine) || startLine < 1) {
          throw new Error('offset must be a positive integer')
        }
        const maxLines = limit === undefined ? READ_LIMIT : Math.trunc(limit)
        if (!Number.isFinite(maxLines) || maxLines < 1) {
          throw new Error('limit must be a positive integer')
        }
        if (maxLines > READ_LIMIT) throw new Error(`limit must be less than or equal to ${READ_LIMIT}`)

        const abs = backend.resolve(file_path)
        const display = backend.rel(abs)
        const text = await readTextFile(backend, abs, display)
        const stat = await backend.stat(abs)
        // 读成功就记下版本：之后 write / edit 的依据
        if (stat) observed.set(abs, versionOf(stat))

        const all = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
        const totalLines = all.length
        if (startLine > totalLines && !(totalLines === 1 && all[0] === '')) {
          throw new Error(`offset ${startLine} is out of range for "${display}" (${totalLines} lines)`)
        }

        const rows: Array<{ number: number; text: string }> = []
        let bytes = 0
        let truncatedByBytes = false
        for (let i = startLine - 1; i < totalLines && rows.length < maxLines; i += 1) {
          const raw = all[i]
          const line =
            raw.length > READ_MAX_LINE_LENGTH
              ? `${raw.slice(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
              : raw
          const cost = Buffer.byteLength(line, 'utf8') + 1
          if (bytes + cost > READ_MAX_BYTES && rows.length > 0) {
            truncatedByBytes = true
            break
          }
          bytes += cost
          rows.push({ number: i + 1, text: line })
        }
        const out = formatReadOutput(display, rows, startLine, totalLines, truncatedByBytes)
        return withNestedDocs(out, abs, false)
      }
    }),

    write: tool({
      description:
        'Create or fully replace a UTF-8 text file.',
      inputSchema: z.object({
        file_path: z
          .string()
          .describe(
            'Path to write, resolved by the filesystem backend. Provide `file_path` before `content` in the arguments.'
          ),
        content: z.string().describe('Full UTF-8 text content to write.')
      }),
      execute: async (input, options) => {
        const { file_path, content } = input
        if (file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
        const abs = backend.resolve(file_path)
        const display = backend.rel(abs)
        const refuse = await checkObserved(abs, display)
        if (refuse) throw new Error(refuse)

        const refused = await guardWrite('文件未写入', {
          toolCallId: options.toolCallId,
          toolName: 'write',
          command: `写入文件 ${display}（${content.length} 字符）`,
          intent: intentOf(input)
        })
        if (refused) return refused

        const existed = (await backend.stat(abs)) !== null
        await backend.writeFile(abs, content, { createParents: true })
        const after = await backend.stat(abs)
        if (after) observed.set(abs, versionOf(after))
        return formatWriteOutput(display, !existed)
      }
    }),

    edit: tool({
      description:
        'Edit an existing UTF-8 text file by replacing literal text.',
      inputSchema: z.object({
        file_path: z
          .string()
          .describe(
            'Path to edit, resolved by the filesystem backend. Provide `file_path` before `old_string` and `new_string` in the arguments.'
          ),
        old_string: z.string().describe('Literal text to replace.'),
        new_string: z
          .string()
          .describe('Literal replacement text. Use an empty string to delete the match.'),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            'Replace all matches. Defaults to false; when false, old_string must appear exactly once.'
          )
      }),
      execute: async (input, options) => {
        const { file_path, old_string, new_string } = input
        const replaceAll = input.replace_all ?? false
        if (file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
        if (old_string.length === 0) throw new Error('old_string must be a non-empty string')
        if (old_string === new_string) throw new Error('old_string and new_string must differ')

        const abs = backend.resolve(file_path)
        const display = backend.rel(abs)
        const refuse = await checkObserved(abs, display)
        if (refuse) throw new Error(refuse)

        // 先在内存里算完再走审批：匹配失败是注定失败的调用，不该先打扰用户
        const before = await readTextFile(backend, abs, display)
        const { text, count } = applyLiteralEdit(before, old_string, new_string, replaceAll, display)

        const refused = await guardWrite('文件未被编辑', {
          toolCallId: options.toolCallId,
          toolName: 'edit',
          command: `编辑文件 ${display}（${count} 处替换）`,
          intent: intentOf(input)
        })
        if (refused) return refused

        await backend.writeFile(abs, text, { createParents: true })
        const after = await backend.stat(abs)
        if (after) observed.set(abs, versionOf(after))
        return formatEditOutput(display, replaceAll)
      }
    }),

    glob: tool({
      description:
        `Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. Returns up to ${GLOB_MAX_RESULTS} paths.`,
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.'
          ),
        path: z
          .string()
          .optional()
          .describe(
            'Directory to search in. Defaults to the session workspace; a relative path resolves against it.'
          )
      }),
      execute: async ({ pattern, path = '' }) => {
        if (pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
        if (path.length > 0 && path.trim().length === 0) {
          throw new Error('path must be a non-empty string when given')
        }
        const absPath = backend.resolve(path)
        if (!(await backend.stat(absPath))) {
          throw new Error(`cannot list "${path || '.'}": not found`)
        }
        /**
         * **包含**隐藏文件与被 .gitignore 忽略的文件，只排除版本库元数据目录。
         * 这条与 grep 相反（grep 遵守 .gitignore）。
         */
        const out = await backend.find({
          pattern,
          subPath: path,
          maxResults: GLOB_MAX_RESULTS,
          includeIgnored: true,
          ignore: (_rel, isDir) => {
            if (!isDir) return false
            const name = _rel.split('/').pop() ?? _rel
            return name === '.git' || name === '.svn' || name === '.hg' || name === '.bzr'
          }
        })
        if (!out.length) return 'No files found'
        const head = out.slice(0, GLOB_MAX_RESULTS)
        const more =
          out.length >= GLOB_MAX_RESULTS
            ? `\n\n(Showing ${head.length} paths. Narrow pattern or path to see more.)`
            : ''
        return `${head.join('\n')}${more}`
      }
    }),

    grep: tool({
      description:
        `Search file contents with a regular expression. Returns matching lines with line numbers, grouped by file. Returns up to ${GREP_MAX_MATCHES} matches.`,
      inputSchema: z.object({
        pattern: z.string().describe('Regular expression to search for.'),
        path: z
          .string()
          .optional()
          .describe(
            'File or directory to search. Defaults to the session workspace; a relative path resolves against it.'
          ),
        include: z
          .string()
          .optional()
          .describe(
            'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.'
          )
      }),
      execute: async ({ pattern, path = '', include }) => {
        if (pattern.length === 0) throw new Error('pattern must be a non-empty string')
        if (path.length > 0 && path.trim().length === 0) {
          throw new Error('path must be a non-empty string when given')
        }
        if (include !== undefined) {
          if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given')
          if (include.startsWith('!')) {
            throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
          }
        }
        // ripgrep 的内联不区分大小写写法在 JS RegExp 里不存在：拆出来当下面的 flag 用
        const insensitive = pattern.startsWith('(?i)')
        const source = insensitive ? pattern.slice(4) : pattern
        try {
          new RegExp(source, insensitive ? 'i' : '')
        } catch (e) {
          throw new Error(`invalid pattern: ${(e as Error).message}`)
        }
        const filePattern = include === undefined ? undefined : globToRegExpSource(include)
        if (filePattern) {
          try {
            new RegExp(filePattern, insensitive ? 'i' : '')
          } catch (e) {
            throw new Error(`invalid include glob: ${(e as Error).message}`)
          }
        }

        const absPath = backend.resolve(path)
        if (!(await backend.stat(absPath))) {
          throw new Error(`cannot search "${path || '.'}": not found`)
        }
        const files = await backend.search({
          pattern: source,
          caseInsensitive: insensitive,
          subPath: path,
          ...(filePattern ? { filePattern } : {}),
          ...(include !== undefined ? { includeGlob: include } : {}),
          context: 0,
          maxResults: GREP_MAX_MATCHES,
          maxFileBytes: MAX_SEARCH_FILE_SIZE,
          ignore: await backend.ignoreChecker()
        })
        const matches = files.flatMap((f) => f.hits.map((h) => ({ path: f.file, ...h })))
        if (!matches.length) return 'No matches found'
        return formatGrepOutput(files, matches.length)
      }
    }),

    bash: tool({
      description:
        tr(
          '在工作区目录下执行 shell 命令并返回输出（stdout + stderr）。适用于运行构建 / 测试 / git 操作 / 安装依赖 / 启动服务等。命令默认超时 120 秒。' +
            '输出超过一个工具结果的预算时会被完整落盘到工作区的 .fizz/tool-output/ 下，结果里给出相对路径、全文行数与本次返回了哪几行；' +
            '其余部分用 read 传那个 path 加 offset / limit 按行接着读，也可以用 grep 检索（常见于构建 / 测试的完整日志）。' +
            '注意这是真实执行环境，删除、覆盖、危险命令（rm -rf、git push --force 等）前先说明影响。' +
            '需要在**本轮结束后继续跑**的进程（dev server / watch / 长构建）把 run_in_background 设为 true：' +
            '调用会立刻返回一个后台任务 id，它不受本轮超时与停止影响，输出显示在输入框上方的任务面板里；' +
            '当前这一轮就要用它的输出时**不要**开这个开关。' +
            shellNote,
          'Run a shell command in the workspace and return stdout + stderr. Use it for builds, tests, git, installing dependencies, starting services, etc. Default timeout is 120 seconds. ' +
            'If output exceeds one tool result, the full text is saved under .fizz/tool-output/ and the result includes the relative path, total lines, and which lines were returned; ' +
            'read the rest with read offset/limit on that path, or search it with grep (common for full build/test logs). ' +
            'This is a real execution environment: explain the impact before deleting, overwriting, or running dangerous commands (rm -rf, git push --force, etc.). ' +
            'Set run_in_background: true for processes that must keep running after this turn (dev servers, watchers, long builds): the call returns a background task id immediately, ' +
            'it is not affected by this turn\'s timeout or stop, and its output shows in the task panel above the input box; do NOT set it when the current turn needs the output.' +
            shellNoteEn
        ),
      inputSchema: z.object({
        // 不设 description：「这一步做什么」统一由引擎注入的 `intent` 表达，
        // 两个字段并存时模型只会填一个，另一个必填就会把整次调用卡在校验阶段。
        command: z.string().describe('The command to execute.'),
        timeoutMs: z
          .number()
          .optional()
          .describe('Timeout in milliseconds; default 120000, max 300000.'),
        workdir: z
          .string()
          .optional()
          .describe(
            'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.'
          ),
        run_in_background: z
          .boolean()
          .optional()
          .describe(
            'Run in the background and return a job id immediately. No timeout applies. Do not set it when this turn needs the output.'
          )
      }),
      execute: async (input, options) => {
        const { command } = input
        if (command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
        const runInBackground = input.run_in_background ?? false
        const cwd = input.workdir ?? ''

        const refused = await guardWrite('命令未运行', {
          toolCallId: options.toolCallId,
          toolName: 'bash',
          command,
          intent: intentOf(input)
        })
        if (refused) return refused

        const execDir = backend.resolve(cwd)
        const stat = await backend.stat(execDir)
        if (!stat) throw new Error(`cannot run "${command}": working directory not found: ${cwd || '.'}`)
        if (stat.type !== 'dir') {
          throw new Error(`cannot run "${command}": workdir is not a directory: ${cwd || '.'}`)
        }

        /**
         * 后台执行：**先过权限闸、再登记**，与前台同一条口径（后台不等于免审批）。
         *
         * 这里刻意不建 per-command controller、不设超时 —— 这条命令的生命周期归任务登记表，
         * 本轮的 abort / 超时都打不到它（那正是「dev server 活过这一轮」的实现方式）。
         */
        if (runInBackground) {
          // 后台进程归本地任务登记表持有；远端工作区没有对应的进程表（首期不支持）
          if (backend.kind === 'remote') {
            return '远端工作区首期不支持后台执行（run_in_background），命令**没有**启动。请改为普通执行（受本轮超时约束），或让用户在远端自己开一个终端。'
          }
          if (!opts.onBackgroundCommand) {
            return '当前环境不支持后台执行（没有任务登记通道），命令**没有**启动。请改为普通执行，或让用户自己开一个终端。'
          }
          const started = await opts.onBackgroundCommand({
            command,
            cwd: execDir,
            title: command
          })
          return [
            `已在后台启动：${command}`,
            `任务 id：${started.id}`,
            '它不占本轮的超时与停止；输出显示在输入框上方的任务面板里（用户可随时停止）。',
            '本轮不要再等它的输出 —— 需要结果时用普通执行，或先做别的、稍后再看面板。'
          ].join('\n')
        }

        const t = clampInt(input.timeoutMs, 1000, 300_000, 120_000)
        /**
         * per-command 停止器：单条停止（调用方持有的 `stop()`）与整轮停止
         * （`options.abortSignal`）都只 abort 这一个 controller —— 互不影响。
         */
        const ctrl = new AbortController()
        const stop = () => ctrl.abort()
        if (options.abortSignal) {
          if (options.abortSignal.aborted) ctrl.abort()
          else options.abortSignal.addEventListener('abort', stop, { once: true })
        }
        const toolCallId = options.toolCallId
        opts.onCommandStart?.(toolCallId, stop)
        try {
          const result = await backend.exec(command, {
            cwd: execDir,
            timeoutMs: t,
            signal: ctrl.signal,
            onOutput: (stream, chunk) => opts.onCommandOutput?.(toolCallId, stream, chunk)
          })
          return await formatBashOutput(backend, command, result, t)
        } finally {
          opts.onCommandEnd?.(toolCallId)
          options.abortSignal?.removeEventListener('abort', stop)
        }
      }
    }),

    /**
     * Anthropic 风格的兼容编辑器（`view` / `create` / `str_replace` / `insert`）。
     *
     * 它与 `read` / `write` / `edit` 并存而不是替代：从 Claude Code 搬来的技能与提示词
     * 会直接点名它。语义细节见 `str-replace-editor.ts` 的文件头。
     */
    str_replace_editor: buildStrReplaceEditorTool({
      backend,
      guardWrite,
      checkObserved,
      recordObserved,
      ...(opts.nestedDocs ? { nestedDocs: opts.nestedDocs } : {})
    }),

    /**
     * 待办清单（todo list）：把一个**多步骤**任务拆成可勾选条目，边做边维护进度。
     *
     * 为什么是「每次整份重发」而不是 add / update / remove 三个粒度工具：
     * 动态重规划天然就是整份重写 —— 做到一半发现后面的安排不对 / 偏离目标 / 冒出新
     * 需求时，模型需要能自由改写任意条目（增、删、改、换序）。粒度工具反而逼它先算
     * 清「该动哪条」，把一件本来简单的事变成对账。（Claude Code 的 TodoWrite 同此取舍。）
     *
     * 不写盘、不改动任何东西 → 不走 guardWrite（只读模式下也允许）。清单本身随工具
     * 结果进消息历史（见 model-messages 的 toToolOutput），刷新 / 切会话后由渲染端从
     * part 里重建 —— 不需要另立一份服务端存储。
     */
    todo_write: tool({
      description:
        tr(
          '创建 / 更新本次任务的**待办清单**（todo list）。把多步骤任务拆成「一句话一个动作」的' +
            '条目，边做边维护：完成一项就把它的 status 改成 completed、把下一项改成 in_progress。\n' +
            '用法要点：\n' +
            '- 每次调用都要传**当前完整的清单**（整份重发，不是增量 / 不是补丁）；顺序即执行顺序。\n' +
            '- **规划是动态的**：做到某一步发现后面的安排不对、偏离目标、或冒出新需求时，直接改写' +
            '后续条目（增 / 删 / 改 / 换序都行），让清单始终反映真实的下一步，而不是被最初的计划绑死。\n' +
            '- 同一时刻最多保留一条 in_progress（手上正在做的那件）。\n' +
            '- 单步骤 / 琐碎任务不要用这个工具；只在确实有三步以上、值得跟踪时才建清单。\n' +
            '- 任务全部结束后，可以再调用一次传空数组把清单清掉（或全部标 completed 留作记录）。',
          'Create/update the **todo list** for this task. Break a multi-step task into one-action items and maintain progress as you go: mark finished items completed and the next one in_progress.\n' +
            'Usage:\n' +
            '- Every call must send the **current complete list** (full replacement, not a patch); order is execution order.\n' +
            '- **Planning is dynamic**: when later steps no longer fit, the goal shifts, or new requirements appear, rewrite the remaining items (add/remove/edit/reorder) so the list always reflects the real next steps instead of being locked to the original plan.\n' +
            '- Keep at most one in_progress item at a time.\n' +
            '- Do not use this for single-step or trivial tasks; create a list only when there are genuinely 3+ steps worth tracking.\n' +
            '- When everything is done, call once more with an empty array to clear it (or mark all completed to keep a record).'
        ),
      inputSchema: z.object({
        todos: z
          .array(
            z.object({
              content: z.string().describe(tr('这一项要做的事：一句话、具体、可执行（顺序即执行顺序）', 'What to do for this item: one concrete, actionable sentence (order is execution order)')),
              status: z
                .enum(['pending', 'in_progress', 'completed'])
                .describe(tr('pending 待办 / in_progress 进行中 / completed 已完成', 'pending / in_progress / completed'))
            })
          )
          .describe(tr('当前**完整**的任务清单（每次整份重发；空数组 = 清空清单）', 'Current **complete** todo list (resend the whole list each time; empty array clears it)'))
      }),
      execute: async ({ todos }) => {
        // 收口：去掉纯空白条目（模型偶尔会留一条空的占位），其余原样
        const clean = todos
          .map((t) => ({ content: t.content.trim(), status: t.status }))
          .filter((t) => t.content)
        const counts = {
          total: clean.length,
          completed: clean.filter((t) => t.status === 'completed').length,
          inProgress: clean.filter((t) => t.status === 'in_progress').length,
          pending: clean.filter((t) => t.status === 'pending').length
        }
        // 结构化结果：渲染端据此画勾选清单，模型读到的则是紧凑 JSON
        return { ok: true, kind: 'todo', todos: clean, counts }
      }
    }),

    // 技能说明通常在**工作区之外**（用户级 / Claude 兼容目录），read 的
    // resolveInside 够不着，所以单独给一个只读工具（范围限制在已发现的技能目录内）。
    // 没有可用技能时干脆不暴露这个工具，免得模型拿着空清单乱试。
    ...(opts.skills?.length ? buildReadSkillTool(opts.skills) : {})
  }
  return filterToolSet(all as ToolSet, opts.includeTools)
}

/**
 * grep 结果（格式固定）：
 *
 * ```
 * Found 3 matches
 *
 * a.ts
 * Line 3: const x = 1
 * ```
 */
function formatGrepOutput(files: WorkspaceSearchFile[], total: number): string {
  const header =
    total > GREP_MAX_MATCHES ? `Found ${GREP_MAX_MATCHES} of ${total} matches` : `Found ${total} match(es)`
  const groups = files.map((f) => {
    const lines = f.hits.map((h) => {
      const text =
        h.text.length > GREP_MAX_LINE_BYTES
          ? `${h.text.slice(0, GREP_MAX_LINE_BYTES)} (line truncated)`
          : h.text
      return `Line ${h.line}: ${text}`
    })
    return `${f.file}\n${lines.join('\n')}`
  })
  return `${header}\n\n${groups.join('\n\n')}`
}

/**
 * `include` 是 glob（`*.ts`、`*.{js,jsx}`），而 Fizz 的本地搜索后端
 * 收的是**文件名正则**。这里做一层最小转换：`**` → `.*`、`*` → `[^/]*`、`?` → `.`、
 * `{a,b}` → `(a|b)`。远端后端本来就把 filePattern 当正则用，两边一致。
 *
 * ⚠️ P4 换成随包 ripgrep 之后，这段可以删掉（rg 直接吃 glob）。
 */
export function globToRegExpSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i += 1
        if (glob[i + 1] === '/') i += 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '.'
      continue
    }
    if (ch === '{') {
      const end = glob.indexOf('}', i)
      if (end > i) {
        const options = glob.slice(i + 1, end).split(',')
        out += `(${options.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
        i = end
        continue
      }
    }
    out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
  }
  return `^${out}$`
}

/** 供 UI / 其他层复用的常量 */
export const TOOL_LIMITS = {
  readLimit: READ_LIMIT,
  readMaxLineLength: READ_MAX_LINE_LENGTH,
  readMaxBytes: READ_MAX_BYTES,
  grepMaxMatches: GREP_MAX_MATCHES,
  globMaxResults: GLOB_MAX_RESULTS
} as const
