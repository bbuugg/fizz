/**
 * 极简行级 diff（LCS），用来在工具卡里渲染「修改前 → 修改后」的 git 风格对比。
 *
 * 为什么自己写一个而不是引库：
 * - 项目里没有 `diff` 依赖，为这么一个工具卡加一个依赖不划算；
 * - 我们只在工具卡里用，输入是「edit 的 old_string/new_string 片段」或「write 的整文件」，
 *   规模小、对性能不敏感，一个 O(n·m) 的 LCS 足够（见 `MIN_LCS_COST` 兜底）。
 *
 * 产出的是扁平的「行类型 + 文本」列表，由视图层负责拼成带 `@@` 头与配色的 unified diff。
 */

export type DiffLineType = 'context' | 'del' | 'add'

export interface DiffLine {
  type: DiffLineType
  text: string
}

/**
 * 一个 diff 片段。
 *
 * `header` 是 `@@ -a,b +c,d @@` 那一行（视图里灰底显示）；
 * `oldStart` / `newStart` 是这一段的起始行号 —— `git diff` 的多个 hunk 各有各的起点，
 * 缺省（工具卡那种片段对比）则沿用「整段从 1 连续累加」的老行为。
 */
export interface DiffHunk {
  header?: string
  lines: DiffLine[]
  oldStart?: number
  newStart?: number
}

/**
 * 把 `git diff` 的 unified 文本解析成 hunks。
 *
 * 只认 `@@ -a,b +c,d @@` 头与紧随其后的 ` `/`+`/`-` 行；`diff --git` / `index` /
 * `---` / `+++` / `\ No newline at end of file` 这些元信息行丢掉（视图用不上）。
 * 二进制文件的 diff 里没有 hunk，会解析成空数组，由视图提示「没有可展示的文本差异」。
 */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      current = {
        header: line,
        lines: [],
        oldStart: m ? Number(m[1]) : undefined,
        newStart: m ? Number(m[2]) : undefined
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('+')) current.lines.push({ type: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) current.lines.push({ type: 'del', text: line.slice(1) })
    else if (line.startsWith(' ')) current.lines.push({ type: 'context', text: line.slice(1) })
    // `\` / 结尾空行等元信息一律忽略
  }
  return hunks
}

/**
 * 超过这个格子数对就放弃逐行对齐，直接「原样全删 / 新样全加」。
 * 正常代码改动远到不了（一个 2000 行的片段也就 4M 次比较），只防极端大输入卡住 UI。
 */
const MIN_LCS_COST = 2_000_000

/**
 * 统计一组 hunk 的增删行数（`+N / −M`）。
 *
 * 两处用：对比视图顶部的计数（`FileDiffView`）与工具卡头部的计数（`PartView` 传给
 * `ToolHeader` 的 `detailExtra`）——**必须是同一个口径**，否则同一处改动在两个地方显示
 * 不同的数字。只数 `add` / `del`，`context` 行两边都不算。
 */
export function diffStat(hunks: DiffHunk[]): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') adds++
      else if (l.type === 'del') dels++
    }
  }
  return { adds, dels }
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')

  if (a.length * b.length > MIN_LCS_COST) {
    const lines: DiffLine[] = []
    for (const t of a) lines.push({ type: 'del', text: t })
    for (const t of b) lines.push({ type: 'add', text: t })
    return lines
  }

  // 后缀对齐的 LCS 表：dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: 'context', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: a[i] })
      i++
    } else {
      lines.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) lines.push({ type: 'del', text: a[i++] })
  while (j < m) lines.push({ type: 'add', text: b[j++] })
  return lines
}
