/**
 * 手机终端「方向键选择」的纯几何逻辑。
 *
 * 选区用**闭区间字符格**模型（`{ col, row }` 是绝对 buffer 行上的一个字符格），
 * 所以这个文件只回答「光标往哪走」，不碰 xterm / DOM —— 折行、中文宽字符、空行
 * 这些最容易错位的地方都在这里用纯函数测干净。
 *
 * 坐标口径（与 xterm 一致）：
 * - `row` 是**绝对 buffer 行**（`viewportY + 可见行` / `baseY + cursorY`），
 *   `term.select()` 与 `getSelectionPosition()` 用的都是它；
 * - `col` 是字符格列号，宽字符的后半格宽度为 0，光标应始终停在宽字符的**前导格**上；
 * - 行尾空白不算内容（`lineEnd` 给的是有效内容格数），所以 → 走到最后一个可见
 *   字符就会换到下一行，而不是先穿过一片空格。
 */
export interface CaretPosition {
  col: number
  row: number
}

/**
 * 选区两端（闭区间字符格）→ `term.select(col,row,length)` 要的参数。
 *
 * xterm 的 `select()` 只认「从起点开始的线性字符数」，所以先把两点按前后排好
 * （反向选也能选），再按 `行数 × cols + 列差 + 1` 展开成长度。
 */
export function selectionRange(
  cols: number,
  a: CaretPosition,
  b: CaretPosition
): { start: CaretPosition; length: number } {
  let start = a
  let end = b
  if (end.row < start.row || (end.row === start.row && end.col < start.col)) {
    ;[start, end] = [end, start]
  }
  const length = (end.row - start.row) * cols + (end.col - start.col) + 1
  return { start, length: Math.max(1, length) }
}

export type CaretDirection =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown'

/** 光标移动需要知道的终端事实；由 TerminalPanel 现读 xterm 缓冲提供（保持本模块可单测）。 */
export interface CaretContext {
  /** 终端列数 */
  cols: number
  /** 光标可到达的最底行（绝对行号，含）—— 再往下就是没有任何内容的空白屏 */
  maxRow: number
  /** PgUp / PgDn 一次跨多少行 */
  pageSize: number
  /** 该行是否由上一行折行而来（xterm 的 `BufferLine.isWrapped`） */
  isWrapped: (row: number) => boolean
  /** 该行有效内容格数（行尾空白不算）；空行返回 0，列号可用范围是 `[0, lineEnd - 1]` */
  lineEnd: (row: number) => number
  /** 该格宽度：宽字符 2、宽字符后半格 0、普通格 1 */
  cellWidth: (row: number, col: number) => number
}

/** 结构类型：xterm 的 `IBufferLine` 天然满足，测试里喂假行即可。 */
export interface BufferLineView {
  readonly length: number
  getCell: (x: number) => { getWidth: () => number; getChars: () => string } | undefined
}

/**
 * 一行里「有效内容」有多少格。
 *
 * 为什么不直接 `line.length`：xterm 的 `BufferLine.length` 建行时就是 `cols`，
 * 行尾空白的宽高都还在；公开 API 又没导出内部那个 `getTrimmedLength()`。
 * 从右往左扫到第一个有字符的格，再把它的宽度算进去（宽字符 2 格）。
 */
export function trimmedCellEnd(line: BufferLineView | undefined, cols: number): number {
  if (!line) return 0
  for (let i = Math.min(cols, line.length) - 1; i >= 0; i--) {
    const cell = line.getCell(i)
    if (!cell) continue
    const chars = cell.getChars()
    // xterm 的空格是 ' '，空 cell 是 ''；宽字符后半格的 chars 同样是 ''
    if (chars !== '' && chars !== ' ') {
      return Math.min(cols, i + Math.max(1, cell.getWidth()))
    }
  }
  return 0
}

/** 落在宽字符后半格上时吸回前导格，并把列夹进该行内容范围。 */
function snapCol(row: number, col: number, ctx: CaretContext): number {
  const end = ctx.lineEnd(row)
  if (end <= 0) return 0
  let c = Math.max(0, Math.min(col, end - 1))
  while (c > 0 && ctx.cellWidth(row, c) === 0) c -= 1
  return c
}

function clampRow(row: number, ctx: CaretContext): number {
  return Math.max(0, Math.min(row, ctx.maxRow))
}

/** 逻辑行行首：一路往上跳过折行（长命令在手机上经常折成好几屏） */
export function logicalStartRow(row: number, isWrapped: (row: number) => boolean): number {
  let start = row
  while (start > 0 && isWrapped(start)) start -= 1
  return start
}

/** 逻辑行行尾：一路往下跳过「由本行折出来的」那些行 */
export function logicalEndRow(
  row: number,
  isWrapped: (row: number) => boolean,
  maxRow: number
): number {
  let end = row
  while (end < maxRow && isWrapped(end + 1)) end += 1
  return end
}

function stepLeft(caret: CaretPosition, ctx: CaretContext): CaretPosition {
  if (caret.col > 0) {
    return { row: caret.row, col: snapCol(caret.row, caret.col - 1, ctx) }
  }
  if (caret.row > 0) {
    const row = caret.row - 1
    const end = ctx.lineEnd(row)
    return { row, col: end > 0 ? snapCol(row, end - 1, ctx) : 0 }
  }
  return caret
}

function stepRight(caret: CaretPosition, ctx: CaretContext): CaretPosition {
  const end = ctx.lineEnd(caret.row)
  const next = caret.col + Math.max(1, ctx.cellWidth(caret.row, caret.col))
  if (next < end) {
    return { row: caret.row, col: snapCol(caret.row, next, ctx) }
  }
  if (caret.row < ctx.maxRow) {
    return { row: caret.row + 1, col: 0 }
  }
  // 最后一行：停在最后一个内容格（整行空就停在 0 列）
  return { row: caret.row, col: snapCol(caret.row, Math.max(0, end - 1), ctx) }
}

function stepVertical(
  caret: CaretPosition,
  row: number,
  desiredCol: number,
  ctx: CaretContext
): CaretPosition {
  const target = clampRow(row, ctx)
  const end = ctx.lineEnd(target)
  const col = end > 0 ? Math.min(desiredCol, end - 1) : 0
  return { row: target, col: snapCol(target, col, ctx) }
}

/**
 * 移动选区端点（闭区间字符格）。返回新的 caret 与「本列」记忆：
 * 上下移动时列号被短行夹住，但记忆保留，回到长行会恢复原列。
 */
export function moveCaret(
  caret: CaretPosition,
  dir: CaretDirection,
  ctx: CaretContext,
  desiredCol?: number
): { caret: CaretPosition; desiredCol: number } {
  switch (dir) {
    case 'left': {
      const next = stepLeft(caret, ctx)
      return { caret: next, desiredCol: next.col }
    }
    case 'right': {
      const next = stepRight(caret, ctx)
      return { caret: next, desiredCol: next.col }
    }
    case 'up': {
      const desired = desiredCol ?? caret.col
      return { caret: stepVertical(caret, caret.row - 1, desired, ctx), desiredCol: desired }
    }
    case 'down': {
      const desired = desiredCol ?? caret.col
      return { caret: stepVertical(caret, caret.row + 1, desired, ctx), desiredCol: desired }
    }
    case 'pageUp': {
      const desired = desiredCol ?? caret.col
      const page = Math.max(1, ctx.pageSize)
      return { caret: stepVertical(caret, caret.row - page, desired, ctx), desiredCol: desired }
    }
    case 'pageDown': {
      const desired = desiredCol ?? caret.col
      const page = Math.max(1, ctx.pageSize)
      return { caret: stepVertical(caret, caret.row + page, desired, ctx), desiredCol: desired }
    }
    case 'home': {
      const row = logicalStartRow(caret.row, ctx.isWrapped)
      const col = snapCol(row, 0, ctx)
      return { caret: { row, col }, desiredCol: col }
    }
    case 'end': {
      const row = logicalEndRow(caret.row, ctx.isWrapped, ctx.maxRow)
      const col = snapCol(row, Math.max(0, ctx.lineEnd(row) - 1), ctx)
      return { caret: { row, col }, desiredCol: col }
    }
  }
}

/**
 * 把 xterm `getSelectionPosition().end`（**排他**边界）换成「最后一个被包含的格」。
 *
 * `end.x === 0` 表示排他终点在行首 —— 最后一个格在**上一行**的行尾；
 * 若上一行是空的，就退到它的 0 列（选择里多一个空行不影响复制文本，xterm 会裁掉）。
 */
export function cellFromExclusiveEnd(
  end: { x: number; y: number },
  ctx: CaretContext
): CaretPosition {
  const row = clampRow(end.y, ctx)
  if (end.x > 0) {
    const last = Math.min(end.x - 1, Math.max(0, ctx.lineEnd(row) - 1))
    return { row, col: snapCol(row, last, ctx) }
  }
  const prev = Math.max(0, row - 1)
  const endCol = ctx.lineEnd(prev)
  return { row: prev, col: endCol > 0 ? snapCol(prev, endCol - 1, ctx) : 0 }
}
