/**
 * `str_replace_editor`：Anthropic 风格的「一个工具四个子命令」。
 *
 * 存在的意义不是再抄一遍 `read` / `write` / `edit`，而是**兼容**：很多提示词、技能、
 * 从 Claude Code 搬来的工作流都会直接调这个名字。语义上它是一个独立面：
 * - `view`：带行号看文件（`     1  content`），或看目录（最多两层）；
 * - `create`：**只能新建**，目标已存在就报错（覆盖属于 `write`）；
 * - `str_replace`：`old_str` 必须**唯一命中**，`new_str` 省略 = 删掉；
 * - `insert`：在 `insert_line` 那行**之后**插入。
 *
 * 唯一一处刻意偏差：这个工具原本要求**绝对路径**，而 Fizz 的模型一直按
 * 「相对工作区根」工作 —— 所以这里相对路径按工作区解析，绝对路径只要落在工作区内
 * 也接受。错误文案保持原样。
 *
 * 读后写：`str_replace` / `insert` 与内置 `edit` 走同一张观察表（改之前必须读过），
 * 否则「唯一命中」这条硬要求会让模型在没看过文件时反复瞎猜。
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { Tool } from 'ai'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'

/** view 的默认输出上限 */
export const VIEW_MAX_OUTPUT_CHARS = 16_000

const TRUNCATED_MESSAGE =
  '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>'

const DEFAULT_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`
* A null placeholder for a parameter unused by the selected command is treated as omitted. Required parameters still need values; omit \`str_replace.new_str\` rather than setting it to null when deleting a match

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim()

function maybeTruncate(content: string, maxOutputChars: number): string {
  return content.length <= maxOutputChars
    ? content
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE
}

/** 文件内容 → `cat -n` 风格（6 位右对齐行号 + 两个空格） */
export function formatFileView(
  path: string,
  content: string,
  viewRange?: number[],
  maxOutputChars = VIEW_MAX_OUTPUT_CHARS
): string {
  const allLines = content.split('\n')
  let lines = allLines
  let initialLine = 1
  let finalLine: number | undefined
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`
  if (viewRange !== undefined) {
    const [requestedInitial, requestedFinal] = viewRange
    if (
      viewRange.length !== 2 ||
      requestedInitial === undefined ||
      requestedFinal === undefined ||
      !viewRange.every(Number.isInteger)
    ) {
      throw new Error('Invalid `view_range`. It should be a list of two integers.')
    }
    initialLine = requestedInitial
    finalLine = requestedFinal
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`
      )
    }
    if (finalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``
      )
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``
      )
    }
    lines = finalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, finalLine)
    prompt += ` with view_range=[${initialLine}, ${finalLine}]`
  }
  const numbered = lines
    .map((line, index) => `${String(initialLine + index).padStart(6, ' ')}  ${line}`)
    .join('\n')
  return maybeTruncate(`${prompt}:\n${numbered}\n`, maxOutputChars)
}

/** 唯一命中才替换；返回替换后的全文 */
export function replaceUnique(before: string, oldStr: string, newStr: string, path: string): string {
  const offset = before.indexOf(oldStr)
  if (offset < 0) {
    throw new Error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`)
  }
  const second = before.indexOf(oldStr, offset + oldStr.length)
  if (second >= 0) {
    const lines: number[] = []
    let scan = before.indexOf(oldStr)
    let line = 1
    let cursor = 0
    while (scan >= 0) {
      while (cursor < scan) {
        if (before[cursor] === '\n') line += 1
        cursor += 1
      }
      lines.push(line)
      scan = before.indexOf(oldStr, scan + oldStr.length)
    }
    throw new Error(
      `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines [${lines.join(', ')}]. Please ensure it is unique`
    )
  }
  return before.slice(0, offset) + newStr + before.slice(offset + oldStr.length)
}

/** 在第 `insertLine` 行**之后**插入（0 = 文件最前面） */
export function insertAfterLine(before: string, insertLine: number, newStr: string): string {
  const lines = before.split('\n')
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    throw new Error(
      `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`
    )
  }
  return [...lines.slice(0, insertLine), ...newStr.split('\n'), ...lines.slice(insertLine)].join('\n')
}

export interface StrReplaceEditorDeps {
  backend: WorkspaceBackend
  /** 改动类工具的统一审批闸（与 write / edit 同一道） */
  guardWrite: (
    denied: string,
    req: { toolCallId: string; toolName: string; command: string; intent?: string }
  ) => Promise<string | null>
  /** 读后写校验：返回非空字符串 = 拒绝原因 */
  checkObserved: (abs: string, display: string) => Promise<string | null>
  /** 记下「这个文件被看过 / 刚被改过」的版本 */
  recordObserved: (abs: string) => Promise<void>
  /** 子目录规则钩子（看文件 / 看目录后追加 AGENTS.md） */
  nestedDocs?: (abs: string, isDirectory: boolean) => Promise<string | null>
  maxOutputChars?: number
  description?: string
}

/** 组装 `str_replace_editor` 工具 */
export function buildStrReplaceEditorTool(deps: StrReplaceEditorDeps): Tool {
  const { backend } = deps
  const maxOutputChars = deps.maxOutputChars ?? VIEW_MAX_OUTPUT_CHARS

  /** 路径 → 绝对路径（相对工作区解析；越界由 backend.resolve 抛错） */
  const resolveTarget = (path: string): { abs: string; display: string } => {
    if (path.trim().length === 0) throw new Error('path must be a non-empty string')
    const abs = backend.resolve(path)
    return { abs, display: backend.rel(abs) }
  }

  /** 目录树：最多两层，跳过隐藏项 / node_modules / __pycache__ */
  const listDirectory = async (abs: string, display: string): Promise<string> => {
    const rows: string[] = [`d\t${display}`]
    const visit = async (dir: string, depth: number): Promise<void> => {
      const entries = [...(await backend.readDir(dir))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
        const child = backend.join(dir, entry.name)
        const type = entry.type === 'dir' ? 'd' : entry.type === 'file' ? 'f' : '?'
        rows.push(`${type}\t${backend.rel(child)}`)
        if (entry.type === 'dir' && depth < 1) await visit(child, depth + 1)
      }
    }
    await visit(abs, 0)
    const listing = maybeTruncate(`${rows.join('\n')}\n`, maxOutputChars)
    return `Here're the files and directories up to 2 levels deep in ${display}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`
  }

  return tool({
    description: deps.description ?? DEFAULT_DESCRIPTION,
    inputSchema: z.object({
      command: z
        .enum(['view', 'create', 'str_replace', 'insert'])
        .describe('The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.'),
      path: z
        .string()
        .describe(
          'Path to a file or directory, e.g. `src/app.ts` or `src`. Relative paths resolve against the workspace root; absolute paths inside the workspace are also accepted.'
        ),
      file_text: z
        .string()
        .nullish()
        .describe(
          'Required string parameter of `create` command, with the content of the file to be created. A null placeholder is treated as omitted by commands that do not use this parameter.'
        ),
      insert_line: z
        .number()
        .nullish()
        .describe(
          'Required integer parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`. A null placeholder is treated as omitted by commands that do not use this parameter.'
        ),
      new_str: z
        .string()
        .nullish()
        .describe(
          'Optional string parameter of `str_replace` command containing the new string (if omitted, no string will be added). Required string parameter of `insert` command containing the string to insert. A null placeholder is accepted only by commands that do not use this parameter.'
        ),
      old_str: z
        .string()
        .nullish()
        .describe(
          'Required string parameter of `str_replace` command containing the string in `path` to replace. A null placeholder is treated as omitted by commands that do not use this parameter.'
        ),
      view_range: z
        .array(z.number())
        .nullish()
        .describe(
          'Optional parameter of `view` command when `path` points to a file. If omitted or null, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.'
        )
    }),
    execute: async (input, options) => {
      const { command } = input
      const { abs, display } = resolveTarget(input.path)
      const stat = await backend.stat(abs)

      if (command === 'view') {
        if (!stat) throw new Error(`The path ${display} does not exist. Please provide a valid path.`)
        if (stat.type === 'dir') {
          if (input.view_range) {
            throw new Error('The `view_range` parameter is not allowed when `path` points to a directory.')
          }
          const listing = await listDirectory(abs, display)
          if (!deps.nestedDocs) return listing
          const extra = await deps.nestedDocs(abs, true).catch(() => null)
          return extra ? `${listing}\n${extra}` : listing
        }
        if (stat.type !== 'file') {
          throw new Error(`cannot view "${display}": not a regular file or directory`)
        }
        const text = await readText(backend, abs)
        await deps.recordObserved(abs)
        const out = formatFileView(display, text, input.view_range ?? undefined, maxOutputChars)
        if (!deps.nestedDocs) return out
        const extra = await deps.nestedDocs(abs, false).catch(() => null)
        return extra ? `${out}\n${extra}` : out
      }

      if (command === 'create') {
        if (input.file_text === undefined || input.file_text === null) {
          throw new Error('Parameter `file_text` is required for command: create')
        }
        if (stat) {
          throw new Error(`File already exists at: ${display}. Cannot overwrite files using command \`create\`.`)
        }
        const refused = await deps.guardWrite('文件未写入', {
          toolCallId: options.toolCallId,
          toolName: 'str_replace_editor',
          command: `新建文件 ${display}（${input.file_text.length} 字符）`
        })
        if (refused) return refused
        await backend.writeFile(abs, input.file_text, { createParents: true })
        await deps.recordObserved(abs)
        return `New file created successfully at: ${display}`
      }

      if (command === 'str_replace') {
        if (input.new_str === null) {
          throw new Error('Parameter `new_str` must be omitted or contain a string for command: str_replace')
        }
        const oldStr = input.old_str ?? undefined
        if (oldStr === undefined) throw new Error('Parameter `old_str` is required for command: str_replace')
        if (oldStr.length === 0) throw new Error('Parameter `old_str` is empty for command: str_replace')
        const refuse = await deps.checkObserved(abs, display)
        if (refuse) throw new Error(refuse)
        if (!stat || stat.type !== 'file') throw new Error(`cannot edit "${display}": not a regular file`)
        const before = await readText(backend, abs)
        const after = replaceUnique(before, oldStr, input.new_str ?? '', display)
        const refused = await deps.guardWrite('文件未被编辑', {
          toolCallId: options.toolCallId,
          toolName: 'str_replace_editor',
          command: `编辑文件 ${display}（1 处替换）`
        })
        if (refused) return refused
        await backend.writeFile(abs, after, { createParents: true })
        await deps.recordObserved(abs)
        return `The file ${display} has been edited successfully.`
      }

      // insert
      if (input.insert_line === undefined || input.insert_line === null) {
        throw new Error('Parameter `insert_line` is required for command: insert')
      }
      if (input.new_str === undefined || input.new_str === null) {
        throw new Error('Parameter `new_str` is required for command: insert')
      }
      const refuse = await deps.checkObserved(abs, display)
      if (refuse) throw new Error(refuse)
      if (!stat || stat.type !== 'file') throw new Error(`cannot insert into "${display}": not a regular file`)
      const before = await readText(backend, abs)
      const after = insertAfterLine(before, input.insert_line, input.new_str)
      const refused = await deps.guardWrite('文件未被编辑', {
        toolCallId: options.toolCallId,
        toolName: 'str_replace_editor',
        command: `编辑文件 ${display}（在第 ${input.insert_line} 行后插入）`
      })
      if (refused) return refused
      await backend.writeFile(abs, after, { createParents: true })
      await deps.recordObserved(abs)
      return `The file ${display} has been edited successfully.`
    }
  })
}

/** 读文本（二进制 / 超大直接报错，与 read 同一口径） */
async function readText(backend: WorkspaceBackend, abs: string): Promise<string> {
  const stat = await backend.stat(abs)
  const display = backend.rel(abs)
  if (!stat) throw new Error(`The path ${display} does not exist. Please provide a valid path.`)
  if (stat.type !== 'file') throw new Error(`cannot view "${display}": not a regular file or directory`)
  const buf = await backend.readFile(abs)
  if (buf.includes(0)) throw new Error(`cannot view "${display}": binary file`)
  return buf.toString('utf8')
}
