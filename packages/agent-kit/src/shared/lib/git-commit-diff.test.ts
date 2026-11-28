/** 防回归：提交 diff 中含空格、引号或 Git 转义的路径必须仍能对应到文件清单。 */
import { describe, expect, it } from 'vitest'
import { splitDiffByFile } from './git-commit-diff'

describe('splitDiffByFile', () => {
  it('解析含空格的路径，并使用元信息中的完整路径', () => {
    const diff = [
      'diff --git a/dir b/name.txt b/dir b/name.txt',
      'index 1111111..2222222 100644',
      '--- a/dir b/name.txt\t',
      '+++ b/dir b/name.txt\t',
      '@@ -1 +1 @@',
      '-before',
      '+after'
    ].join('\n')

    expect(splitDiffByFile(diff)).toEqual([
      {
        path: 'dir b/name.txt',
        hunks: [
          {
            header: '@@ -1 +1 @@',
            lines: [
              { type: 'del', text: 'before' },
              { type: 'add', text: 'after' }
            ],
            oldStart: 1,
            newStart: 1
          }
        ]
      }
    ])
  })

  it('解码引号路径与八进制 UTF-8 转义', () => {
    const diff = [
      'diff --git "a/file \\"quoted\\".txt" "b/file \\"quoted\\".txt"',
      'index 1111111..2222222 100644',
      '--- "a/file \\"quoted\\".txt"\t',
      '+++ "b/file \\"quoted\\".txt"\t',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      'diff --git "a/\\346\\226\\207.txt" "b/\\346\\226\\207.txt"',
      'index 3333333..4444444 100644',
      '--- "a/\\346\\226\\207.txt"\t',
      '+++ "b/\\346\\226\\207.txt"\t',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n')

    expect(splitDiffByFile(diff).map((segment) => segment.path)).toEqual([
      'file "quoted".txt',
      '文.txt'
    ])
  })
})
