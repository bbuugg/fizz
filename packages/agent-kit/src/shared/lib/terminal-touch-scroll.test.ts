/**
 * 手机终端「长按划词」的坐标换算基线。
 *
 * 防的回归：xterm 的 `select()` 用的是**绝对 buffer 行**与「从起点开始的线性字符数」。
 * 把可见行当绝对行、或者长度少算一行，选出来的就是完全不相干的一段文本 ——
 * 而且不会报错，用户只看到「复制出来是乱码 / 别的行」。
 */
import { describe, expect, it } from 'vitest'
import { pointToCell, selectionRange } from './terminal-touch-scroll'

const RECT = { left: 100, top: 50, width: 800 }
const COLS = 80
const ROWS = 24
const ROW_H = 20

describe('pointToCell', () => {
  it('像素 → 列 / 可见行，且行号加上 viewportY 变成绝对行', () => {
    expect(pointToCell(RECT, COLS, ROWS, ROW_H, 0, 100, 50)).toEqual({ col: 0, row: 0 })
    // 每格 10px：x=125 → 第 2 列；y=90 → 第 2 行
    expect(pointToCell(RECT, COLS, ROWS, ROW_H, 0, 125, 90)).toEqual({ col: 2, row: 2 })
    expect(pointToCell(RECT, COLS, ROWS, ROW_H, 37, 125, 90)).toEqual({ col: 2, row: 39 })
  })

  it('越界坐标夹在可视区内（手指拖到终端外面不会算出负列 / 超行）', () => {
    expect(pointToCell(RECT, COLS, ROWS, ROW_H, 5, -500, -500)).toEqual({ col: 0, row: 5 })
    expect(pointToCell(RECT, COLS, ROWS, ROW_H, 5, 99999, 99999)).toEqual({
      col: COLS - 1,
      row: 5 + ROWS - 1
    })
  })
})

describe('selectionRange', () => {
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

  it('反方向拖（从下往上 / 从右往左）自动交换起终点', () => {
    expect(selectionRange(COLS, { col: 5, row: 12 }, { col: 70, row: 10 })).toEqual(
      selectionRange(COLS, { col: 70, row: 10 }, { col: 5, row: 12 })
    )
  })

  it('单点也至少选 1 个字符', () => {
    expect(selectionRange(COLS, { col: 4, row: 2 }, { col: 4, row: 2 }).length).toBe(1)
  })
})
