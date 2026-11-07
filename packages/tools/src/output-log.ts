/**
 * 超长工具输出的落盘：**execute_command** / **web_fetch** 结果太长时，把全文写进工作区的
 * `.fizz/tool-output/`，只回「头 + 尾」正文，外加一组**行号坐标**让模型自己把剩下的读完。
 *
 * ## 为什么落进工作区，而不是数据目录
 *
 * 早先这一层把全文写到数据目录（`~/.fizz-server/tool-logs/`）并配一个专用 `read_log`
 * 工具（按字符区间读）。那套有两个绕不开的代价：
 *
 * 1. **只有专用工具能读**。数据目录在工作区之外，`read_file` 的 `resolveInside` 够不着；
 *    于是模型想精读中段，只能用 `read_log`（字符偏移，与它熟悉的按行翻页是两套心智），
 *    或者 `execute_command` 拼 `sed`/`grep` —— 而只读模式下 execute_command 被 guardWrite 拦死，
 *    那份数据**根本读不回来**。
 * 2. **多一个要维护的工具**：schema、系统提示词、只读子任务白名单里都得带着它。
 *
 * 现在落在工作区内（`.fizz/tool-output/`），两个问题一起消失：
 * - `read_file` 直接能读，**任何权限模式**都行（它是纯读工具，readonly 不拦）；
 * - `search_files` 还能直接对它做关键词检索（`pattern="error"`），这是读日志最常用的动作；
 * - 行号对行号，和 `read_file` 的 offset/limit 同一套坐标。
 *
 * ## 为什么不心疼「往用户仓库里写文件」
 *
 * `.fizz` 是 Fizz 自己的本地环境数据目录（见 contracts/workspace 的
 * `DEFAULT_IGNORE_DIRS`）：文件树、`list_files` / `search_files` 都跳过它；同名
 * `.gitignore`（内容 `*`）保证缓存不进版本库。落盘时会顺手把这份 `.gitignore` 补上。
 * 这不是「替用户改文件」，所以不走 guardWrite —— 而恰恰因为不走审批，只读会话也能落 + 也能读。
 *
 * ## 形状
 *
 * - 文件：`<工作区>/.fizz/tool-output/<工具>-<8 位 hex>.<ext>`（`.log` 命令输出 / `.md` 网页）；
 * - 返回给模型的：头 + 尾两段正文（都裁在整行边界上），加一个说明块 —— 相对路径、全文行数、
 *   本次返回哪几行、其余怎么读；
 * - 保留 30 份 / 24 小时，落盘时顺手清旧的（尽力而为，失败不影响使用）。
 */
import { randomBytes } from 'node:crypto'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'

/**
 * 单个工具结果回给模型的字符预算（也是命令输出落盘的触发阈值）。
 *
 * read_file / search_files 用它做行裁剪提示的分界，execute_command 用它决定是否落盘。
 */
export const MAX_TOOL_RESULT_CHARS = 4000

/** 摘要里留给「头 + 尾」正文的额度：剩下的 ~1600 字符给说明块，保证整体塞得进预算 */
const SUMMARY_BODY_CHARS = 2400

/**
 * 落盘目录（相对工作区根）。它同时是 `DEFAULT_IGNORE_DIRS` 的一员 —— 改这里的话
 * 记得 contracts/workspace 里那份忽略清单也要跟上，否则缓存会糊进用户文件树。
 */
export const TOOL_OUTPUT_DIR = '.fizz/tool-output'
/** 落盘文件保留上限与时长（磁盘不能被缓存撑爆） */
const MAX_OUTPUT_FILES = 30
const OUTPUT_TTL_MS = 24 * 60 * 60 * 1000

/** 全文行数（结尾换行不算多一行） */
export function countLines(text: string): number {
  if (!text) return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * 从 `approx` 起往后找最近的换行，返回它**之后**那个下标。
 *
 * 用来把「按字符数切的头 / 尾」退到整行边界上：坐标对模型说的都是行号，
 * 返回一段被劈成半行的正文会让行号与内容对不上（模型按行号 read_file 会读串行）。
 */
function lineAlignedStart(text: string, approx: number): number {
  if (approx <= 0) return 0
  const nl = text.indexOf('\n', approx)
  return nl === -1 ? text.length : nl + 1
}

/** 相对路径（给模型看，read_file 直接用）+ 绝对路径 + 行数 */
interface SpillResult {
  relPath: string
  absPath: string
  totalLines: number
}

/** 落盘目录（含 .gitignore 兜底）：任何失败都往上抛，由调用方决定降级 */
async function ensureDir(backend: WorkspaceBackend): Promise<string> {
  const dir = backend.join(backend.root, TOOL_OUTPUT_DIR)
  await backend.mkdirp(dir)
  // `.fizz/.gitignore`：缓存不进版本库。已存在的一律不动（用户可能自己往里加过东西）
  const gitignore = backend.join(backend.root, '.fizz', '.gitignore')
  const exists = await backend.stat(gitignore).catch(() => null)
  if (!exists) await backend.writeFile(gitignore, '*').catch(() => undefined)
  return dir
}

/** 尽力而为地清旧缓存：超期或超量的删掉。失败吞掉 —— 缓存不值得为它报错 */
async function sweepOldOutputs(backend: WorkspaceBackend, dir: string): Promise<void> {
  try {
    const entries = await backend.readDir(dir).catch(() => [])
    const alive: Array<{ path: string; mtime: number }> = []
    for (const ent of entries) {
      if (ent.type !== 'file' || !/\.(log|md)$/.test(ent.name)) continue
      const abs = backend.join(dir, ent.name)
      const stat = await backend.stat(abs).catch(() => null)
      if (!stat) continue
      // SFTP 拿不到 mtime 时按「还活着」处理：宁可少清，也不误删刚落盘的文件
      if (stat.mtimeMs !== undefined && Date.now() - stat.mtimeMs > OUTPUT_TTL_MS) {
        await backend.remove(abs, { force: true }).catch(() => undefined)
        continue
      }
      alive.push({ path: abs, mtime: stat.mtimeMs ?? 0 })
    }
    if (alive.length <= MAX_OUTPUT_FILES) return
    alive.sort((a, b) => a.mtime - b.mtime)
    for (const old of alive.slice(0, alive.length - MAX_OUTPUT_FILES)) {
      await backend.remove(old.path, { force: true }).catch(() => undefined)
    }
  } catch {
    // 忽略：清理失败不影响本次读写
  }
}

/**
 * 把过长内容落进工作区，返回「相对路径 + 行数」。
 *
 * `backend` 为 `null`（未绑定工作区）或落盘失败（只读文件系统、磁盘满…）时**不抛**：
 * 降级成 `null`，调用方退回到纯截断 —— 一次缓存写失败不该把整轮工具调用搞挂。
 */
export async function spillToWorkspace(
  backend: WorkspaceBackend | null,
  text: string,
  meta: { tool: string; detail?: string }
): Promise<SpillResult | null> {
  if (!backend?.root) return null
  try {
    const dir = await ensureDir(backend)
    const ext = meta.tool === 'web_fetch' ? 'md' : 'log'
    const name = `${meta.tool === 'web_fetch' ? 'web-fetch' : 'cmd'}-${randomBytes(4).toString('hex')}.${ext}`
    const relPath = `${TOOL_OUTPUT_DIR}/${name}`
    const absPath = backend.join(dir, name)
    await backend.writeFile(absPath, text)
    await sweepOldOutputs(backend, dir)
    return { relPath, absPath, totalLines: countLines(text) }
  } catch {
    return null
  }
}

/**
 * 把一段过长内容压成「头 + 尾 + 落盘说明」，短内容原样返回。
 *
 * 头尾都裁在整行边界上，说明块给的是**行号**：文件相对路径、全文行数、本次返回哪几行、
 * 其余用什么读 —— 模型拿这四样就能自己把全文翻完，不需要任何专用续读工具。
 */
export async function summarizeLongOutput(
  full: string,
  meta: {
    /** 工作区后端：全文落盘到它下面的 .fizz/tool-output/；null = 不落盘只截断 */
    backend: WorkspaceBackend | null
    tool: string
    detail?: string
    extra?: string
    headChars?: number
    tailChars?: number
  }
): Promise<string> {
  if (full.length <= MAX_TOOL_RESULT_CHARS) return full
  const headChars = meta.headChars ?? Math.floor(SUMMARY_BODY_CHARS / 2)
  const tailChars = meta.tailChars ?? Math.floor(SUMMARY_BODY_CHARS / 2)

  const spilled = await spillToWorkspace(meta.backend, full, {
    tool: meta.tool,
    ...(meta.detail ? { detail: meta.detail } : {})
  })
  // 未绑定工作区 / 落盘失败（只读文件系统 / 磁盘满）：降级成纯截断，不假装"东西还在"
  if (!spilled) {
    const clipped = clipToBudget(full, SUMMARY_BODY_CHARS)
    return `${clipped}\n…（输出过长且无法落盘，仅保留开头一段；请改用更精确的命令 / 参数缩小输出）`
  }

  const headEnd = lineAlignedStart(full, headChars)
  const head = full.slice(0, headEnd)
  const tailStart = lineAlignedStart(full, Math.max(0, full.length - tailChars))
  const tail = full.slice(tailStart)
  const headLines = countLines(head)
  const tailStartLine = countLines(full.slice(0, tailStart)) + 1
  // 唯一文件名主干（cmd-1a2b / web-fetch-1a2b）：给 search_files 的 filePattern 用
  const stem = (spilled.relPath.split('/').pop() ?? spilled.relPath).replace(/\.(log|md)$/, '')

  const notice = [
    '【输出过长，已完整落盘到工作区文件】',
    `- 文件：${spilled.relPath}（相对工作区根，全文都在里面，共 ${spilled.totalLines} 行）`,
    meta.detail ? `- 来源：${meta.tool} ${meta.detail}` : `- 来源：${meta.tool}`,
    `- 本次返回：第 1–${headLines} 行，以及第 ${tailStartLine}–${spilled.totalLines} 行；` +
      '其余行没有出现在这条结果里。',
    `- 读其余部分：用 read_file(path="${spilled.relPath}", offset=<起始行号>, limit=<行数>) 一段段往下翻` +
      `（例如 offset=${headLines + 1}, limit=200），直到读完 ${spilled.totalLines} 行；` +
      `也可以 search_files(pattern="<关键词>", filePattern="*${stem}*") 直接定位。`,
    ...(meta.extra ? [`- 补充：${meta.extra}`] : [])
  ].join('\n')

  return `${head}\n…（中段略去，见下方说明）…\n${tail}\n\n${notice}`
}

/** 按预算裁一段文本，尽量裁在换行处（read_file / search_files 用） */
export function clipToBudget(text: string, max = SUMMARY_BODY_CHARS): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf('\n', max)
  return `${text.slice(0, cut > max * 0.6 ? cut : max)}\n…（本段已按预算裁剪）`
}
