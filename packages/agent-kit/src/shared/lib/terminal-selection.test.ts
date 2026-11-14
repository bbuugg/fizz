/**
 * 手机终端「方向键选区」的几何基线。
 *
 * 防的回归：这些坐标会被直接喂给 `term.select()`（绝对行 + 线性格数），算错不会报错，
 * 用户只会看到「选中的是别的行 / 少选一个字 / 中文被劈成半个」。重点覆盖：
 * 行首行尾跨行、折成多屏的逻辑行、中文宽字符的前导格/续格、短行夹列后的列记忆。
 */
import { describe, expect, it } from 'vitest'
import {
  cellFromExclusiveEnd,
  logicalEndRow,
  logicalStartRow,
  moveCaret,
  selectionRange,
  trimmedCellEnd,
  type BufferLineView,
  type CaretContext,
  type CaretPosition
} from './terminal-selection'

/** 常见宽字符区间（测试里只用来铺格宽，不追求 Unicode 全量） */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

/** 把每行文本铺成字符格宽度：[宽字符, 续格] = [2, 0]，普通字符 [1] */
function makeCtx(
  rows: string[],
  options: { wrapped?: boolean[]; maxRow?: number; pageSize?: number; cols?: number } = {}
): CaretContext {
  const cols = options.cols ?? 40
  const widths = rows.map((text) => {
    const cells: number[] = []
    for (const char of text) {
      if (WIDE.test(char)) cells.push(2, 0)
      else cells.push(1)
    }
    return cells
  })
  return {
    cols,
    maxRow: options.maxRow ?? rows.length - 1,
    pageSize: options.pageSize ?? 3,
    isWrapped: (row) => Boolean(options.wrapped?.[row]),
    lineEnd: (row) => widths[row]?.length ?? 0,
    cellWidth: (row, col) => widths[row]?.[col] ?? 1
  }
}

function lineOf(cells: string[], widths?: number[]): BufferLineView {
  return {
    length: cells.length,
    getCell: (x) => {
      const chars = cells[x]
      if (chars === undefined) return undefined
      return {
        getChars: () => chars,
        getWidth: () => widths?.[x] ?? (chars === '' ? 0 : 1)
      }
    }
  }
}

const at = (col: number, row: number): CaretPosition => ({ col, row })

describe('moveCaret：行内与跨行', () => {
  it('行内左右按格移动，最后一行的行尾不再越过', () => {
    const ctx = makeCtx(['abcd'])
    expect(moveCaret(at(0, 0), 'right', ctx).caret).toEqual(at(1, 0))
    expect(moveCaret(at(3, 0), 'right', ctx).caret).toEqual(at(3, 0))
    expect(moveCaret(at(3, 0), 'left', ctx).caret).toEqual(at(2, 0))
    expect(moveCaret(at(0, 0), 'left', ctx).caret).toEqual(at(0, 0))
  })

  it('→ 越过行尾到下一行 0 列；← 在行首到上一行最后一个内容格', () => {
    const ctx = makeCtx(['ab', 'cd'])
    expect(moveCaret(at(1, 0), 'right', ctx).caret).toEqual(at(0, 1))
    expect(moveCaret(at(0, 1), 'left', ctx).caret).toEqual(at(1, 0))
  })

  it('空行：逐行跨过，停在空行 0 列而不是行尾空格', () => {
    const ctx = makeCtx(['ab', '', 'cd'])
    expect(moveCaret(at(1, 0), 'right', ctx).caret).toEqual(at(0, 1))
    expect(moveCaret(at(0, 1), 'right', ctx).caret).toEqual(at(0, 2))
    expect(moveCaret(at(0, 2), 'left', ctx).caret).toEqual(at(0, 1))
    expect(moveCaret(at(0, 1), 'left', ctx).caret).toEqual(at(1, 0))
  })
})

describe('moveCaret：上下移动的列记忆', () => {
  it('短行把列夹住，回到长行恢复原列', () => {
    const ctx = makeCtx(['abcdef', 'ab', 'abcdef'])
    const down = moveCaret(at(4, 0), 'down', ctx)
    expect(down.caret).toEqual(at(1, 1))
    expect(down.desiredCol).toBe(4)
    expect(moveCaret(down.caret, 'down', ctx, down.desiredCol).caret).toEqual(at(4, 2))
  })

  it('上下移动不会越过 maxRow / 0 行', () => {
    const ctx = makeCtx(['ab', 'cd'])
    expect(moveCaret(at(1, 1), 'down', ctx).caret).toEqual(at(1, 1))
    expect(moveCaret(at(1, 0), 'up', ctx).caret).toEqual(at(1, 0))
  })

  it('PgUp / PgDn 夹在 [0, maxRow]', () => {
    const ctx = makeCtx(Array.from({ length: 10 }, () => 'abcdef'), { pageSize: 3 })
    expect(moveCaret(at(2, 5), 'pageDown', ctx).caret).toEqual(at(2, 8))
    expect(moveCaret(at(2, 8), 'pageDown', ctx).caret).toEqual(at(2, 9))
    expect(moveCaret(at(2, 1), 'pageUp', ctx).caret).toEqual(at(2, 0))
  })
})

describe('moveCaret：Home / End 按逻辑行', () => {
  const ctx = makeCtx(['abcdef', 'gh', 'ijkl'], { wrapped: [false, true, true] })

  it('Home 跳到折行段的第一行 0 列', () => {
    expect(moveCaret(at(3, 1), 'home', ctx).caret).toEqual(at(0, 0))
  })

  it('End 跳到折行段的最后一行末字符', () => {
    expect(moveCaret(at(3, 1), 'end', ctx).caret).toEqual(at(3, 2))
  })

  it('logicalStartRow / logicalEndRow 只吃 isWrapped 关系', () => {
    expect(logicalStartRow(2, ctx.isWrapped)).toBe(0)
    expect(logicalEndRow(1, ctx.isWrapped, ctx.maxRow)).toBe(2)
    expect(logicalStartRow(1, (row) => row === 1)).toBe(0)
  })
})

describe('moveCaret：中文宽字符', () => {
  it('右移一次跨过整个宽字符，不落在续格上', () => {
    const ctx = makeCtx(['中a'])
    expect(moveCaret(at(0, 0), 'right', ctx).caret).toEqual(at(2, 0))
    // 'a' 是最后一行最后一个字符，再右移不动
    expect(moveCaret(at(2, 0), 'right', ctx).caret).toEqual(at(2, 0))
  })

  it('左移从续格吸回宽字符前导格', () => {
    const ctx = makeCtx(['中a'])
    expect(moveCaret(at(2, 0), 'left', ctx).caret).toEqual(at(0, 0))
  })

  it('上下移动的目标列落在续格时也吸回前导格', () => {
    const ctx = makeCtx(['a中b', 'xxxxx'])
    expect(moveCaret(at(2, 1), 'up', ctx).caret).toEqual(at(1, 0))
  })

  it('End 落在宽字符上时选到前导格（整字被包含）', () => {
    const ctx = makeCtx(['a中'])
    expect(moveCaret(at(0, 0), 'end', ctx).caret).toEqual(at(1, 0))
  })
})

describe('trimmedCellEnd', () => {
  it('行尾空格 / 空 cell 都被裁掉', () => {
    expect(trimmedCellEnd(lineOf(['a', 'b', ' ', ' ', '']), 5)).toBe(2)
  })

  it('空行返回 0', () => {
    expect(trimmedCellEnd(lineOf([' ', '', ' ']), 3)).toBe(0)
    expect(trimmedCellEnd(undefined, 10)).toBe(0)
  })

  it('结尾是宽字符时按 2 格算', () => {
    expect(trimmedCellEnd(lineOf(['中', ''], [2, 0]), 2)).toBe(2)
    expect(trimmedCellEnd(lineOf(['a', '中', ''], [1, 2, 0]), 3)).toBe(3)
  })

  it('length 超过 cols（resize 后未裁剪）时按 cols 截断', () => {
    expect(trimmedCellEnd(lineOf(['a', 'b', 'c', 'd']), 2)).toBe(2)
  })
})

describe('cellFromExclusiveEnd：排他终点 → 最后一个包含的格', () => {
  it('同一行内退一格', () => {
    const ctx = makeCtx(['abcd'])
    expect(cellFromExclusiveEnd({ x: 4, y: 0 }, ctx)).toEqual(at(3, 0))
  })

  it('x === 0 表示终点在行首 → 取上一行末格', () => {
    const ctx = makeCtx(['abcd', 'ef'])
    expect(cellFromExclusiveEnd({ x: 0, y: 1 }, ctx)).toEqual(at(3, 0))
  })

  it('结尾是宽字符时吸回前导格', () => {
    const ctx = makeCtx(['中a'])
    expect(cellFromExclusiveEnd({ x: 2, y: 0 }, ctx)).toEqual(at(0, 0))
  })

  it('空行 / 开头不会算出负列', () => {
    const ctx = makeCtx(['', 'ab'])
    expect(cellFromExclusiveEnd({ x: 0, y: 0 }, ctx)).toEqual(at(0, 0))
    expect(cellFromExclusiveEnd({ x: 0, y: 1 }, ctx)).toEqual(at(0, 0))
    expect(cellFromExclusiveEnd({ x: 1, y: 1 }, ctx)).toEqual(at(0, 1))
  })
})

describe('selectionRange：两端字符格 → term.select() 的线性长度', () => {
  const COLS = 80

  it('同一行从左到右：长度 = 列差 + 1', () => {
    expect(selectionRange(COLS, { col: 3, row: 10 }, { col: 7, row: 10 })).toEqual({
      start: { col: 3, row: 10 },
      length: 5
    })
  })

  it('跨行：长度按 行数 × cols 展开', () => {
    expect(selectionRange(COLS, { col: 70, row: 10 }, { col: 5, row: 12 })).toEqual({
      start: { col: 70, row: 10 },
      length: 2 * COLS + (5 - 70) + 1
    })
  })

  it('反方向选（从下往上 / 从右往左）自动交换起终点', () => {
    expect(selectionRange(COLS, { col: 5, row: 12 }, { col: 70, row: 10 })).toEqual(
      selectionRange(COLS, { col: 70, row: 10 }, { col: 5, row: 12 })
    )
  })

  it('单点也至少选 1 个字符', () => {
    expect(selectionRange(COLS, { col: 4, row: 2 }, { col: 4, row: 2 }).length).toBe(1)
  })
})
