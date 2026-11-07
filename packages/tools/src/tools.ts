/**
 * 工作区 Agent 工具集：文件读取 / 查找 / 写入 / 编辑 / 删除 / 执行命令。
 *
 * 所有工具都绑定一个工作区根目录（root），文件路径一律相对工作区，
 * 经 resolveInside 越界校验后落盘，防止 Agent 逃出工作区。
 *
 * 权限：**会改动东西的工具**（write_file / edit_file / delete_file / execute_command）
 * 统一走 `guardWrite` 一道闸 ——
 * - `readonly`：直接回绝（不落盘、不执行），并告诉模型让用户去切换模式；
 * - `confirm`：经 requestConfirm 弹卡片等用户点「允许」，被拒绝就当次调用放弃；
 *   没有可用的 requestConfirm 通道时**按拒绝处理**（fail-closed）；
 * - `full`：放行。
 *
 * 只读类工具（list/read/search/find/read_skill）在任何模式下都不拦。
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
import { applyTolerantEdit } from './edit-match'
import { stripAnsi } from './ansi'
import { createOutputDecoder } from './output-decoder'
import {
  createLocalBackend,
  killChild,
  MAX_SEARCH_FILE_SIZE,
  resolveShellSpawn
} from './backend'
import {
  clipToBudget,
  MAX_TOOL_RESULT_CHARS,
  summarizeLongOutput
} from './output-log'

export type AgentPermissionMode = 'full' | 'confirm' | 'readonly'

/**
 * 单个文件整体读入的上限（字节）：超过就不当文本处理。
 *
 * 超限只有「读不动」这一个理由（模型自己也读不动这么大一段），按行分段用
 * read_file 的 offset/limit 即可，不走 output-log（那里只留给 execute_command）。
 */
const MAX_FILE_BYTES = 8_000_000

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
   * `execute_command` 每次**启动命令前**调用：`stop` 由调用方持有，调用即杀
   * 这条命令的进程树（工具结果收尾成「（已中止）」）。整轮 abort 仍走
   * `options.abortSignal`（tools 内部把它联动到同一个 per-command controller）。
   * 不传 = 没有单条停止能力（行为与加这些回调之前逐字节一致）。
   */
  onCommandStart?: (toolCallId: string, stop: () => void) => void
  /** 命令收场（exit / 超时 / 中止 / 启动失败）时调用，只来一次 */
  onCommandEnd?: (toolCallId: string) => void
  /** 命令执行期间的 stdout / stderr 实时增量（纯转发，不缓存） */
  onCommandOutput?: (toolCallId: string, stream: 'stdout' | 'stderr', chunk: string) => void
  /**
   * `execute_command` 带 `runInBackground: true` 时调用：把它登记成一条**后台任务**，
   * 立刻返回任务 id（进程归调用方持有，不占本轮的取消表、不设超时）。
   *
   * 由服务端注入 —— 只有它知道任务登记表在哪、这条命令属于哪个会话。**不传 = 不提供
   * 后台执行**：工具会如实回绝并让模型别等输出，而不是假装命令起来了。
   */
  onBackgroundCommand?: (req: {
    command: string
    /** 已解析好的绝对路径（调用方不用再算一次 cwd） */
    cwd: string
    /** 一行标题：就是命令原文，任务列表里显示这一行 */
    title: string
  }) => Promise<{ id: string }>
  /** 可用技能（见 skills.ts）；有值时额外暴露 read_skill 工具，空值不暴露 */
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
   * **子目录规则**的按需加载钩子：`read_file` / `list_files` 每次调用后带上
   * 目标路径（绝对）与是否目录，返回非空文本就追加到工具结果后面。
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
 * 一次返回」—— 后者由 read_file 的 offset/limit 分段读解决。
 */
async function readTextFile(backend: WorkspaceBackend, abs: string): Promise<string> {
  const stat = await backend.stat(abs)
  if (!stat) throw new Error(`文件不存在：${backend.rel(abs)}`)
  if (stat.type === 'dir') throw new Error(`不是文件：${backend.basename(abs)}`)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `文件过大（${stat.size} 字节，超过 ${MAX_FILE_BYTES} 字节上限），无法整体按文本读取。` +
        '请先用 search_files 定位关键内容，再用 read_file 的 offset/limit 分段读取'
    )
  }
  const buf = await backend.readFile(abs, { maxBytes: MAX_FILE_BYTES })
  if (buf.includes(0)) throw new Error('二进制文件，无法以文本方式读取')
  return buf.toString('utf8')
}

// ---------- 文件系统遍历 ----------

async function listDir(
  backend: WorkspaceBackend,
  dir: string,
  depth: number,
  ignored: (rel: string, isDir: boolean) => boolean,
  lines: string[]
): Promise<void> {
  // 远端 SFTP 的 readdir 顺序不保证，统一在这里排序（目录在前、同类按名称）
  const entries = [...(await backend.readDir(dir))].sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1
    const bd = b.type === 'dir' ? 0 : 1
    return ad === bd ? a.name.localeCompare(b.name) : ad - bd
  })
  for (const ent of entries) {
    const abs = backend.join(dir, ent.name)
    const rel = backend.rel(abs)
    if (ignored(rel, ent.type === 'dir')) continue
    if (ent.type === 'dir') {
      lines.push(`${rel}/`)
      if (depth > 0) await listDir(backend, abs, depth - 1, ignored, lines)
    } else if (ent.type === 'file') {
      lines.push(`${rel}\t${ent.size ?? 0}B`)
    }
  }
}

/** 把内容命中格式化成模型友好的文本 */
function formatSearchHits(files: WorkspaceSearchFile[], context: number): string {
  if (!files.length) return '（未找到匹配）'
  const out: string[] = []
  if (context <= 0) {
    // 保持 ripgrep 的 `路径:行号: 内容` 风格 —— 模型对这种格式最熟
    for (const f of files) {
      for (const h of f.hits) out.push(`${f.file}:${h.line}: ${h.text}`)
    }
    return out.join('\n')
  }
  for (const f of files) {
    if (!f.context) continue
    out.push(`${f.file}:`)
    for (const c of f.context) {
      // line=0 是后端插入的分组分隔（见 contracts/workspace 的 WorkspaceSearchFile）
      if (c.line === 0) {
        out.push('--')
        continue
      }
      out.push(`${c.line}${c.hit ? ':' : '-'} ${c.text}`)
    }
  }
  return out.join('\n')
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
 * 把后端执行结果拼成 `execute_command` 的模型可见文本。
 *
 * 格式与改造前的 `runCommand` 逐字对齐：`$ 命令\n（收场说明）\nstdout\nstderr`；
 * 超预算交给 `summarizeLongOutput` 落盘（后端决定落本地还是远端工作区）。
 */
async function formatExecResult(
  backend: WorkspaceBackend,
  command: string,
  result: WorkspaceExecResult,
  timeoutMs: number
): Promise<string> {
  const info =
    result.reason === 'exit'
      ? `（退出码 ${result.exitCode}）`
      : result.reason === 'timeout'
        ? `（超时 ${timeoutMs}ms，已终止进程树）`
        : result.reason === 'aborted'
          ? '（已中止）'
          : `（命令启动失败：${result.error ?? '未知错误'}）`
  // 先剥 ANSI 再 trim：`npm run` 会给脚本注入 FORCE_COLOR，vite / tsc / jest 照样吐颜色
  const out = stripAnsi(result.stdout).trim()
  const err = stripAnsi(result.stderr).trim()
  const full = `$ ${command}\n${info}\n${out}${err ? `\n${err}` : ''}`
  return summarizeLongOutput(full, {
    backend,
    tool: 'execute_command',
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
   * 改动类工具的统一闸门。
   *
   * 返回 `null` = 放行；返回字符串 = 这个字符串就是**工具结果**（回绝说明），
   * 直接 return 回去即可 —— 不用抛错：回绝是「预期内的结果」，让模型看到原因后
   * 能向用户解释，而不是变成一个工具报错把整轮打断。
   *
   * `denied` 用来拼文案，写成「文件未写入」这类短句。
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

  /** 把按需加载的子目录规则附在工具结果后面（没有规则 / 钩子抛错就原样返回） */
  const withNestedDocs = async (text: string, abs: string, isDirectory: boolean): Promise<string> => {
    if (!opts.nestedDocs) return text
    const extra = await opts.nestedDocs(abs, isDirectory).catch(() => null)
    return extra ? `${text}\n\n${extra}` : text
  }

  const all = {
    list_files: tool({
      description:
        tr(
          '列出工作区目录内容（自动忽略 .git、node_modules、构建产物与 .gitignore 规则）。返回每个条目的相对路径，目录带 / 后缀，文件附大小。适合先了解项目结构。',
          'List workspace directory contents (ignores .git, node_modules, build outputs, and .gitignore rules). Returns relative paths; directories end with /, files include size. Useful for getting oriented in a project.'
        ),
      inputSchema: z.object({
        path: z.string().optional().describe(tr('相对工作区的目录路径，缺省为工作区根目录', 'Directory path relative to the workspace; defaults to the workspace root')),
        depth: z.number().optional().describe(tr('递归深度，默认 0（仅当前目录），最大 4', 'Recursion depth; default 0 (current directory only), max 4'))
      }),
      execute: async ({ path = '', depth = 0 }) => {
        const absDir = backend.resolve(path)
        const stat = await backend.stat(absDir)
        if (!stat) throw new Error(`路径不存在：${path || '.'}（相对于工作区根）`)
        if (stat.type !== 'dir') throw new Error(`不是目录：${path || '.'}（list_dir 的 path 必须是目录）`)
        const ignored = await backend.ignoreChecker()
        const lines: string[] = []
        await listDir(backend, absDir, clampInt(depth, 0, 4, 0), ignored, lines)
        return withNestedDocs(lines.length ? lines.join('\n') : '（空目录）', absDir, true)
      }
    }),

    read_file: tool({
      description:
        tr(
          '读取文件内容并附行号，用于理解源码 / 配置 / 文档。路径相对工作区根目录。' +
            '默认只读前 200 行（上限 2000）：大文件请用 offset/limit 按需分段读，不要一次拉全文。' +
            '超出预算时会按行裁剪并告诉你还有哪些行没显示。' +
            '⚠️ 行号只是给你定位用的（格式 `  42 | 代码`），**不要**把它复制进 edit_file 的 oldText。',
          'Read a file with line numbers for understanding source, config, or docs. Paths are relative to the workspace root. ' +
            'By default it reads the first 200 lines (max 2000): for large files use offset/limit instead of fetching everything at once. ' +
            'When over budget it trims by line and tells you which lines were omitted. ' +
            '⚠️ Line numbers are only for navigation (`  42 | code`); do NOT copy them into edit_file oldText.'
        ),
      inputSchema: z.object({
        path: z.string().describe(tr('相对工作区的文件路径', 'File path relative to the workspace')),
        offset: z.number().optional().describe(tr('起始行号（1 起），缺省 1', 'Starting line number (1-based); defaults to 1')),
        limit: z.number().optional().describe(tr('返回行数上限，默认 200，最大 2000', 'Maximum lines to return; default 200, max 2000'))
      }),
      execute: async ({ path, offset = 1, limit = 200 }) => {
        const abs = backend.resolve(path)
        const text = await readTextFile(backend, abs)
        const rel = backend.rel(abs)
        const lines = text.split('\n')
        const start = Math.max(0, offset - 1)
        const slice = lines.slice(start, start + clampInt(limit, 1, 2000, 200))
        const body = slice
          .map((l, i) => `${String(start + i + 1).padStart(5)} | ${l}`)
          .join('\n')
        const header = `${rel}（共 ${lines.length} 行 / ${text.length} 字符）`
        const endLine = start + slice.length

        // 小文件：一行给全，靠 offset/limit 翻页就够了
        if (text.length <= MAX_TOOL_RESULT_CHARS) {
          const more = endLine < lines.length ? `\n…（本段到第 ${endLine} 行，offset=${endLine + 1} 继续）` : ''
          return withNestedDocs(`${header}\n${body}${more}`, abs, false)
        }

        /*
          * 大文件：本次只回预算内的一段（按行窗口），并说清还剩哪些行没显示。
          *
          * 关键信息往往不在头几行（构建日志的第一条 error、文件末尾的导出表），所以提示
          * 里必须写清「这次给的是哪一段、下一段从哪行开始」，模型才能按行翻到位，而不是
          * 只看到一句「已截断」后反复从头读。文件本身不落盘（output-log 只留给
          * execute_command），用 offset/limit 翻即可。
         */
        return withNestedDocs(
          [
            header,
            clipToBudget(body),
            `…（本次返回第 ${start + 1}–${endLine} 行；文件还有第 ${endLine + 1}–${lines.length} 行没显示，用 offset=${endLine + 1} 继续）…`
          ].join('\n'),
          abs,
          false
        )
      }
    }),

    write_file: tool({
      description:
        tr(
          '创建或整体覆盖写入一个文件（自动创建父目录）。会覆盖已有内容，写入前请先 read_file 确认原文。路径相对工作区根目录。',
          'Create or fully overwrite a file (parent directories are created automatically). Existing content is replaced; use read_file first to confirm. Paths are relative to the workspace root.'
        ),
      inputSchema: z.object({
        path: z.string().describe(tr('相对工作区的文件路径', 'File path relative to the workspace')),
        content: z.string().describe(tr('完整文件内容', 'Full file contents'))
      }),
      execute: async (input, options) => {
        const { path, content } = input
        const refused = await guardWrite('文件未写入', {
          toolCallId: options.toolCallId,
          toolName: 'write_file',
          command: `写入文件 ${path}（${content.length} 字符）`,
          intent: intentOf(input)
        })
        if (refused) return refused
        const abs = backend.resolve(path)
        await backend.writeFile(abs, content)
        return `已写入 ${backend.rel(abs)}（${content.length} 字符）`
      }
    }),

    edit_file: tool({
      description:
        tr(
          '对文件做多处查找替换编辑（只改局部，不整体重写）。oldText 直接用 read_file 看到的原文内容：不要带输出里的「行号 | 」前缀，也不要自己加工转义符。' +
            '系统已容忍行尾（CRLF/LF）、缩进、行尾空白的细微差异，但替换范围以 oldText 为准，所以仍要带上足够上下文、避免误伤相似片段。' +
            '同一段文本出现多处时全部替换；一处都找不到则报错且不落盘（错误里会指出 oldText 首行在文件第几行出现过）。',
          'Apply multiple search/replace edits to a file (local changes only, no full rewrite). oldText must be the exact text seen in read_file: no “line | ” prefix and no escaping changes. ' +
            'Minor differences in line endings (CRLF/LF), indentation, and trailing whitespace are tolerated, but the replacement range follows oldText — include enough context to avoid hitting similar snippets. ' +
            'Every occurrence is replaced; if none is found the call errors and nothing is written (the error reports where oldText’s first line occurs).'
        ),
      inputSchema: z.object({
        path: z.string().describe(tr('相对工作区的文件路径', 'File path relative to the workspace')),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe(tr('要查找的原文片段（照抄 read_file 的内容，不含行号前缀）', 'Exact source text to find (copy read_file output without line-number prefixes)')),
              newText: z.string().describe(tr('替换后的文本', 'Replacement text'))
            })
          )
          .describe(tr('按顺序应用的替换列表', 'List of replacements applied in order'))
      }),
      execute: async (input, options) => {
        const { path, edits } = input
        if (edits.length === 0) throw new Error('edits 是空的：至少给一处 oldText/newText')
        const abs = backend.resolve(path)
        // 文件不存在给一句人话：模型常常拿一个猜的路径来 edit（原始 ENOENT 看不出该怎么办）
        if (!(await backend.stat(abs))) {
          throw new Error(`文件不存在：${path}（edit_file 只能改已存在的文件，新建请用 write_file）`)
        }
        let text = await readTextFile(backend, abs)

        /*
         * 先在**内存里**把替换全部跑通，再走审批闸门。
         * 顺序很重要：匹配失败是「这段 oldText 根本没对上」这种**注定失败**的调用，
         * 让用户在确认弹窗上点一次「允许」再去报错，纯属白打扰；反过来确认被拒
         * （只读模式 / 用户点拒绝）时我们一个字节都没落盘，也不会有副作用。
         */
        const applied: string[] = []
        for (const { oldText, newText } of edits) {
          const result = applyTolerantEdit(text, oldText, newText)
          text = result.text
          // 摘要取 oldText 的第一行有效内容（多行 oldText 直接 trim 会把换行也带进结果文案）
          const head = oldText
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length > 0) ?? ''
          const brief = `${head.slice(0, 40)}${head.length > 40 ? '…' : ''}`
          applied.push(`${brief}（${result.count} 处${result.note ? `，${result.note}` : ''}）`)
        }

        const refused = await guardWrite('文件未被编辑', {
          toolCallId: options.toolCallId,
          toolName: 'edit_file',
          command: `编辑文件 ${path}（${edits.length} 处替换）`,
          intent: intentOf(input)
        })
        if (refused) return refused

        await backend.writeFile(abs, text)
        return `已应用 ${applied.length} 处编辑（${backend.rel(abs)}）：${applied.join('；')}`
      }
    }),

    search_files: tool({
      description:
        tr(
          '在工作区中按正则搜索文件内容（自动跳过忽略目录、二进制与大文件）。返回命中文件的相对路径、行号与行内容。用于定位符号、关键配置与错误来源。结果很多时用 filesOnly 只拿「文件:命中数」省上下文；要看代码上下文用 context。',
          'Search file contents in the workspace by regex (skips ignored directories, binaries, and large files). Returns relative paths, line numbers, and matching lines. Use it to locate symbols, key config, and error sources. For many results use filesOnly to get “file:count” and save context; use context to see surrounding code.'
        ),
      inputSchema: z.object({
        pattern: z.string().describe(tr('正则表达式（默认区分大小写）', 'Regular expression (case-sensitive by default)')),
        path: z
          .string()
          .optional()
          .describe(tr('搜索起点（相对工作区的文件或目录）：给目录递归搜，给文件只搜这一个，缺省为根目录', 'Search root (file or directory relative to the workspace): directories are searched recursively, a file only itself; defaults to root')),
        filePattern: z.string().optional().describe(tr('限定文件名正则，如 "\\.(ts|tsx|json)$"', 'Optional file-name regex, e.g. "\\.(ts|tsx|json)$"')),
        caseInsensitive: z
          .boolean()
          .optional()
          .describe(tr('忽略大小写（同时作用于 pattern 与 filePattern），默认 false', 'Case-insensitive (applies to pattern and filePattern); default false')),
        filesOnly: z
          .boolean()
          .optional()
          .describe(tr('只返回命中的文件及其命中数（每行 `路径:命中数`），不返回行内容', 'Return only matching files and hit counts (`path:count` per line), not line contents')),
        context: z
          .number()
          .optional()
          .describe(tr('每条命中附带的前后上下文行数（0–5），默认 0。适合需要看清代码结构的场景', 'Context lines around each hit (0–5); default 0. Useful when code structure matters')),
        maxResults: z.number().optional().describe(tr('最大命中行数，默认 200，最大 1000', 'Maximum matching lines; default 200, max 1000'))
      }),
      execute: async ({
        pattern,
        path = '',
        filePattern,
        caseInsensitive = false,
        filesOnly = false,
        context = 0,
        maxResults = 200
      }) => {
        const flags = caseInsensitive ? 'i' : ''
        // 先在 JS 侧预检正则：远端 rg/grep 的方言差异会给出难读的报错，语法错在这里就说清
        try {
          new RegExp(pattern, flags)
        } catch (e) {
          throw new Error(`无效的正则：${(e as Error).message}`)
        }
        if (filePattern) {
          try {
            new RegExp(filePattern, flags)
          } catch (e) {
            throw new Error(`无效的文件名正则：${(e as Error).message}`)
          }
        }
        const absPath = backend.resolve(path)
        if (!(await backend.stat(absPath))) {
          throw new Error(`路径不存在：${path || '.'}（相对于工作区根）`)
        }
        const ctx = clampInt(context, 0, 5, 0)
        const max = clampInt(maxResults, 1, 1000, 200)
        // path 显式指向文件时由后端只搜这一个（不走忽略规则 —— 显式点名 = 明确意图）
        const files = await backend.search({
          pattern,
          caseInsensitive,
          subPath: path,
          ...(filePattern ? { filePattern } : {}),
          context: ctx,
          maxResults: max,
          maxFileBytes: MAX_SEARCH_FILE_SIZE,
          ignore: await backend.ignoreChecker()
        })
        if (!files.length) return '（未找到匹配）'
        const totalHits = files.reduce((n, f) => n + f.hits.length, 0)
        if (filesOnly) {
          const rows = files.map((f) => `${f.file}:${f.hits.length}`)
          return `${rows.join('\n')}\n（${files.length} 个文件，共 ${totalHits} 处匹配）`
        }
        const full = formatSearchHits(files, ctx)
        // 超预算就按预算裁剪，但必须说清「还有匹配没查完」与怎么把范围收窄，
        // 而不是让模型以为「只有这些命中」
        const tail =
          totalHits >= max
            ? `\n…（本轮已到 ${max} 行命中上限，还有匹配没查完：想看更多就提高 maxResults（上限 1000）、缩小 path / filePattern，或换更精确的 pattern）…`
            : ''
        return `${clipToBudget(full, MAX_TOOL_RESULT_CHARS)}${tail}`
      }
    }),

    find_files: tool({
      description:
        tr(
          '按文件名 / 通配符查找文件（如 "*.ts"、"**/*.test.tsx"、"src/**/index.*"）。只匹配文件名，不搜内容（搜内容用 search_files）。自动跳过忽略目录。用于「项目里有哪些 X 文件」这类问题。',
          'Find files by name or glob (e.g. "*.ts", "**/*.test.tsx", "src/**/index.*"). Matches file names only, not contents (use search_files for contents). Ignored directories are skipped. Useful for “which X files exist in this project?”.'
        ),
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(tr('文件名通配符：* 匹配单层任意字符，? 匹配单个字符，** 跨目录；不含 / 时匹配任意层级下的文件名', 'File-name glob: * matches any characters in one segment, ? one character, ** across directories; without / it matches file names at any depth')),
        path: z
          .string()
          .optional()
          .describe(tr('搜索起点（相对工作区的文件或目录）：给目录递归找，给文件只检查这一个，缺省为根目录', 'Search root (file or directory relative to the workspace): directories are searched recursively, a file only itself; defaults to root')),
        maxResults: z.number().optional().describe(tr('最大返回条数，默认 200，最大 1000', 'Maximum results; default 200, max 1000'))
      }),
      execute: async ({ pattern, path = '', maxResults = 200 }) => {
        const absPath = backend.resolve(path)
        if (!(await backend.stat(absPath))) {
          throw new Error(`路径不存在：${path || '.'}（相对于工作区根）`)
        }
        const max = clampInt(maxResults, 1, 1000, 200)
        // path 显式指向文件时由后端只检查这一个（借 ripgrep --files 的语义）
        const out = await backend.find({
          pattern,
          subPath: path,
          maxResults: max,
          ignore: await backend.ignoreChecker()
        })
        if (!out.length) return `（没有匹配 ${pattern} 的文件）`
        const more = out.length >= max ? `\n…（已达上限 ${max}，可能有更多）` : ''
        return `${out.length} 个文件：\n${out.join('\n')}${more}`
      }
    }),

    execute_command: tool({
      description:
        tr(
          '在工作区目录下执行 shell 命令并返回输出（stdout + stderr）。适用于运行构建 / 测试 / git 操作 / 安装依赖 / 启动服务等。命令默认超时 120 秒。' +
            '输出超过一个工具结果的预算时会被完整落盘到工作区的 .fizz/tool-output/ 下，结果里给出相对路径、全文行数与本次返回了哪几行；' +
            '其余部分用 read_file 传那个 path 加 offset / limit 按行接着读，也可以用 search_files 检索（常见于构建 / 测试的完整日志）。' +
            '注意这是真实执行环境，删除、覆盖、危险命令（rm -rf、git push --force 等）前先说明影响。' +
            '需要在**本轮结束后继续跑**的进程（dev server / watch / 长构建）把 runInBackground 设为 true：' +
            '调用会立刻返回一个后台任务 id，它不受本轮超时与停止影响，输出显示在输入框上方的任务面板里；' +
            '当前这一轮就要用它的输出时**不要**开这个开关。' +
            shellNote,
          'Run a shell command in the workspace and return stdout + stderr. Use it for builds, tests, git, installing dependencies, starting services, etc. Default timeout is 120 seconds. ' +
            'If output exceeds one tool result, the full text is saved under .fizz/tool-output/ and the result includes the relative path, total lines, and which lines were returned; ' +
            'read the rest with read_file offset/limit on that path, or search it with search_files (common for full build/test logs). ' +
            'This is a real execution environment: explain the impact before deleting, overwriting, or running dangerous commands (rm -rf, git push --force, etc.). ' +
            'Set runInBackground: true for processes that must keep running after this turn (dev servers, watchers, long builds): the call returns a background task id immediately, ' +
            'it is not affected by this turn\'s timeout or stop, and its output shows in the task panel above the input box; do NOT set it when the current turn needs the output.' +
            shellNoteEn
        ),
      inputSchema: z.object({
        command: z.string().describe(tr('要执行的命令', 'Command to run')),
        timeoutMs: z.number().optional().describe(tr('超时毫秒数，默认 120000，最大 300000', 'Timeout in milliseconds; default 120000, max 300000')),
        cwd: z.string().optional().describe(tr('执行目录（相对工作区），缺省为工作区根目录', 'Working directory (relative to the workspace); defaults to the workspace root')),
        runInBackground: z
          .boolean()
          .optional()
          .describe(
            tr(
              '设为 true 时把命令丢到后台：立刻返回任务 id，进程在本轮结束后继续跑（dev server / watch / 长构建）。本轮需要它的输出时不要开',
              'Set true to run the command in the background: returns a task id immediately and the process keeps running after this turn (dev servers, watchers, long builds). Do not set it when this turn needs the output'
            )
          )
      }),
      execute: async (input, options) => {
        const { command, timeoutMs, cwd = '', runInBackground } = input
        const refused = await guardWrite('命令未运行', {
          toolCallId: options.toolCallId,
          toolName: 'execute_command',
          command,
          intent: intentOf(input)
        })
        if (refused) return refused
        const execDir = backend.resolve(cwd)
        const stat = await backend.stat(execDir)
        if (!stat) throw new Error(`执行目录不存在：${cwd || '.'}（相对于工作区根）`)
        if (stat.type !== 'dir')
          throw new Error(`执行目录不是目录：${cwd || '.'}（cwd 必须是目录；要操作某个文件请把路径写进命令里）`)

        /**
         * 后台执行：**先过权限闸、再登记**，与前台同一条口径（后台不等于免审批）。
         *
         * 这里刻意不建 per-command controller、不设超时 —— 这条命令的生命周期归任务登记表，
         * 本轮的 abort / 超时都打不到它（那正是「dev server 活过这一轮」的实现方式）。
         */
        if (runInBackground) {
          // 后台进程归本地任务登记表持有；远端工作区没有对应的进程表（首期不支持）
          if (backend.kind === 'remote') {
            return '远端工作区首期不支持后台执行（runInBackground），命令**没有**启动。请改为普通执行（受本轮超时约束），或让用户在远端自己开一个终端。'
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

        const t = clampInt(timeoutMs, 1000, 300_000, 120_000)
        /**
         * per-command 停止器：单条停止（调用方持有的 `stop()`）与整轮停止
         * （`options.abortSignal`）都只 abort 这一个 controller —— 互不影响：
         * 单条停不动 run，整轮停照旧杀进程树（原来的 signal 分支就是它）。
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
          return await formatExecResult(backend, command, result, t)
        } finally {
          opts.onCommandEnd?.(toolCallId)
          options.abortSignal?.removeEventListener('abort', stop)
        }
      }
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

    /**
     * 删除文件。存在的意义不只是「省得拼 rm」—— 更重要的是把删除收敛成
     * 一个「单路径 + resolveInside 校验 + 同一道确认闸」的动作：
     * 让模型拼 `rm -rf xxx` 才删，误伤面比单文件大得多。
     */
    delete_file: tool({
      description:
        tr(
          '删除工作区内的文件。默认只删单个文件；path 是目录时必须显式传 recursive=true（会连同目录内所有内容一起删）。路径不存在会报错，不会静默成功。不可恢复操作，调用前请确认路径。',
          'Delete a file in the workspace. By default only a single file is deleted; if path is a directory you must pass recursive=true (deletes all contents too). Missing paths error instead of silently succeeding. This is irreversible — confirm the path before calling.'
        ),
      inputSchema: z.object({
        path: z.string().describe(tr('相对工作区的路径', 'Path relative to the workspace')),
        recursive: z
          .boolean()
          .optional()
          .describe(tr('path 是目录时必须显式传 true 才允许删除，默认 false（此时传目录会报错）', 'When path is a directory, explicitly pass true to allow deletion; default false (passing a directory then errors)'))
      }),
      execute: async (input, options) => {
        const { path, recursive = false } = input
        const abs = backend.resolve(path)
        // 先确认存在：删一个不存在的路径直接报错，避免「静默成功」让模型误以为已删除
        const stat = await backend.stat(abs)
        if (!stat) throw new Error(`路径不存在：${path}`)
        const isDir = stat.type === 'dir'
        if (isDir && !recursive) {
          throw new Error(
            `${path} 是目录。删除目录必须显式传 recursive: true（会连同目录内所有内容一起删除）。`
          )
        }
        // 破坏性操作：与 execute_command / write_file 同一道闸，不能绕
        const refused = await guardWrite('内容未被删除', {
          toolCallId: options.toolCallId,
          toolName: 'delete_file',
          command: isDir ? `删除目录（含全部内容）：${path}` : `删除文件：${path}`,
          intent: intentOf(input)
        })
        if (refused) return refused
        await backend.remove(abs, { recursive: isDir, force: true })
        return `已删除${isDir ? '目录' : '文件'} ${path}`
      }
    }),

    // 技能说明通常在**工作区之外**（用户级 / Claude 兼容目录），read_file 的
    // resolveInside 够不着，所以单独给一个只读工具（范围限制在已发现的技能目录内）。
    // 没有可用技能时干脆不暴露这个工具，免得模型拿着空清单乱试。
    ...(opts.skills?.length ? buildReadSkillTool(opts.skills) : {})
  }
  return filterToolSet(all as ToolSet, opts.includeTools)
}
