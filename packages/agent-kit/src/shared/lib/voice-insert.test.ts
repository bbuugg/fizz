/**
 * 防回归：语音输入必须插在**光标处**，不能追加到输入框末尾。
 *
 * 旧实现是 `onChange(value + separator + text)` —— 用户先语音输入一段、把光标移到
 * 中间、再按麦克风说一句，第二句就跑到全文末尾（2026-11 报的 bug）。
 */
import { describe, expect, it } from 'vitest'
import { insertTranscript } from './voice-insert'

describe('insertTranscript', () => {
  it('插在光标处而不是末尾', () => {
    // 「前面文字后面」，光标停在「文字」之后（下标 4）
    expect(insertTranscript('前面文字后面', '语音', 4, 4)).toEqual({
      value: '前面文字 语音后面',
      caret: 7
    })
  })

  it('光标在末尾时等价于原来的追加行为', () => {
    expect(insertTranscript('hello', 'world', 5, 5)).toEqual({
      value: 'hello world',
      caret: 11
    })
  })

  it('光标在开头时不再补前导空格', () => {
    expect(insertTranscript('hello', 'world', 0, 0)).toEqual({
      value: 'worldhello',
      caret: 5
    })
  })

  it('有选区时替换选区，左侧已是空白就不重复加空格', () => {
    expect(insertTranscript('hello world', 'there', 6, 11)).toEqual({
      value: 'hello there',
      caret: 11
    })
  })

  it('空识别结果不改变文本', () => {
    expect(insertTranscript('abc', '', 1, 1)).toEqual({ value: 'abc', caret: 1 })
  })

  it('光标越界时夹到文本两端', () => {
    expect(insertTranscript('abc', 'x', 99, 99)).toEqual({ value: 'abc x', caret: 5 })
    expect(insertTranscript('abc', 'x', -5, -5)).toEqual({ value: 'xabc', caret: 1 })
  })

  it('光标区间反向时按交换处理', () => {
    expect(insertTranscript('a bc', 'x', 3, 1)).toEqual({ value: 'a xc', caret: 3 })
  })
})
