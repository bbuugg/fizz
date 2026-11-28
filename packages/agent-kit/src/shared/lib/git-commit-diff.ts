/**
 * 「一次提交」diff 的客户端解析（**纯函数，零依赖** —— 单测直接 jiti 跑，不拉起 React）。
 *
 * ⚠️ 这个文件跑在浏览器里，**别从 `@fizz/git` 运行时导入任何东西**（`import type` 没事）：
 * 那个包的 index 会带出 git-panel.ts —— 它 import simple-git、模块顶层还写 process.env，
 * 进了浏览器 bundle 就是一声 `ReferenceError: process is not defined`（130655c 踩过）。
 * 服务端/浏览器两边都要用的纯函数，放这里或 contracts，服务端从自己那边引。
 *
 * 独立成 `lib/` 而不是塞在 `GitHistory.tsx` 里：那个文件引 react / lucide，
 * 单测要陪它加载整棵 UI 树。而这里两个函数值得被单测钉住：
 * 多文件切分错了，用户看到的 diff 就是「后一个文件的行接在前一个文件后面」。
 */
import type { DiffHunk } from '@fizz/agent-kit/shared/lib/diff'

/** unified diff 里切分文件的边界行（`diff --git a/x b/x`） */
const FILE_HEADER = /^diff --git (.+)$/

const GIT_PATH_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  '\\': 0x5c
}

type GitPathToken = { value: string; end: number }

type ParsedDiffFile = {
  path: string
  oldPath?: string | null
  newPath?: string | null
  hunks: DiffHunk[]
}

/**
 * 读 Git 的 C 风格带引号路径。
 *
 * `core.quotePath=false` 只会让普通非 ASCII 字符保持原样；路径里的引号、控制字符等
 * 仍会被 Git 转义（例如 `"a/file \\"quoted\\".txt"`）。这里不能用 `JSON.parse`：Git
 * 还会使用 `\\303\\244` 这样的八进制 UTF-8 字节转义。
 */
function readQuotedGitPath(text: string, start: number): GitPathToken | null {
  if (text[start] !== '"') return null
  const bytes: number[] = []
  const encoder = new TextEncoder()

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') {
      return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 }
    }
    if (ch !== '\\') {
      bytes.push(...encoder.encode(ch))
      continue
    }

    const escaped = text[++i]
    if (escaped === undefined) return null
    if (escaped >= '0' && escaped <= '7') {
      let octal = escaped
      while (
        octal.length < 3 &&
        text[i + 1] !== undefined &&
        text[i + 1]! >= '0' &&
        text[i + 1]! <= '7'
      ) {
        octal += text[++i]!
      }
      bytes.push(Number.parseInt(octal, 8))
      continue
    }
    bytes.push(GIT_PATH_ESCAPES[escaped] ?? escaped.charCodeAt(0))
  }
  return null
}

function stripGitPathPrefix(path: string, prefix: 'a/' | 'b/'): string | null {
  if (path === '/dev/null') return null
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

/** 从 `---` / `+++` 元信息行中取路径；元信息比 `diff --git` 头更可靠，因为路径可含空格。 */
function patchMetadataPath(line: string, prefix: 'a/' | 'b/'): string | null | undefined {
  const raw = line.slice(4).endsWith('\t') ? line.slice(4, -1) : line.slice(4)
  if (raw.startsWith('"')) {
    const token = readQuotedGitPath(raw, 0)
    return token ? stripGitPathPrefix(token.value, prefix) : undefined
  }
  return stripGitPathPrefix(raw, prefix)
}

/**
 * `diff --git` 的非引号路径可能含空格，不能按空白切 token。这里先取一个尽力而为的
 * 结果；有文本 hunk 的文件随后会用 `+++` / `---` 元信息覆盖它。
 */
function headerPath(line: string): string {
  const body = line.slice('diff --git '.length)
  if (body.startsWith('"')) {
    const first = readQuotedGitPath(body, 0)
    if (!first) return ''
    let secondStart = first.end
    while (body[secondStart] === ' ') secondStart++
    const second = readQuotedGitPath(body, secondStart)
    return second ? (stripGitPathPrefix(second.value, 'b/') ?? '') : ''
  }
  const separator = body.lastIndexOf(' b/')
  return separator >= 0 ? body.slice(separator + 3) : ''
}

/** hunk 头（`@@ -1,5 +1,7 @@`）—— 与 `parseUnifiedDiff` 的正则逐字一致，别只改一边 */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * 把一段（可能是**多个文件**的）unified diff 按文件切开。
 *
 * ⚠️ 不能直接 `parseUnifiedDiff(整段)`：它只认 `@@` 行，多文件的 hunk 会被**扁平成
 * 一个数组**，行与行的文件归属全丢 —— 而 commit 的 diff 几乎总是多文件的。
 *
 * 返回顺序按 diff 里出现的次序（与 `--numstat` 的文件顺序无关），调用方逐段喂给
 * `FileDiffView`：它自带文件头和增删计数，正好一段一个。
 *
 * ⚠️ `let current` 要能跨循环体赋值：写成「初始化为 null + 闭包 helper 里赋值」的
 * 话，TS 的控制流分析解除不了 null 窄化，每个 `current.hunks` 都会报 `never`。
 */
export function splitDiffByFile(diff: string): { path: string; hunks: DiffHunk[] }[] {
  const out: ParsedDiffFile[] = []
  let current: ParsedDiffFile | undefined
  for (const line of diff.split('\n')) {
    const header = FILE_HEADER.exec(line)
    if (header) {
      current = { path: headerPath(line), hunks: [] }
      out.push(current)
      continue
    }
    if (!current) continue
    // `diff --git` 头对含空格路径并不总是可无歧义解析；对真正有文本 diff 的文件，
    // `+++` / `---` 行给出了完整路径，而且引号与转义规则也更容易独立处理。
    if (current.hunks.length === 0 && line.startsWith('--- ')) {
      current.oldPath = patchMetadataPath(line, 'a/')
    } else if (current.hunks.length === 0 && line.startsWith('+++ ')) {
      current.newPath = patchMetadataPath(line, 'b/')
      current.path = current.newPath ?? current.oldPath ?? current.path
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEADER.exec(line)
      current.hunks.push({
        header: line,
        lines: [],
        oldStart: m ? Number(m[1]) : undefined,
        newStart: m ? Number(m[2]) : undefined
      })
      continue
    }
    const last = current.hunks[current.hunks.length - 1]
    if (!last) continue
    if (line.startsWith('+')) last.lines.push({ type: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) last.lines.push({ type: 'del', text: line.slice(1) })
    else if (line.startsWith(' ')) last.lines.push({ type: 'context', text: line.slice(1) })
    // `\ No newline at end of file` 等元信息忽略（parseUnifiedDiff 同样忽略）
  }
  // 一个 hunk 都没有的段（纯 mode 变更 / 空文件）不留：渲染出来是个空壳文件头
  return out
    .filter((seg) => seg.hunks.length > 0)
    .map(({ path, oldPath, newPath, hunks }) => ({
      path: newPath ?? oldPath ?? path,
      hunks
    }))
}
