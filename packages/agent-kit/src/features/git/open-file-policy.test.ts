/** 防回归：文件暂存后再从工作区删除，已暂存组也不能显示「打开文件」入口。 */
import { describe, expect, it } from 'vitest'
import type { GitChange } from '@fizz/git'
import { gitChangeOpenPath } from './open-file-policy'

describe('gitChangeOpenPath', () => {
  it.each(['M', 'A', 'R'])('暂存状态为 %s、工作区已删除时不提供打开路径', (index) => {
    const change: GitChange = { path: 'src/a.ts', index, worktree: 'D' }
    expect(gitChangeOpenPath(change, index, '/repo', '/repo')).toBeNull()
  })

  it('已暂存删除的文件不提供打开路径', () => {
    const change: GitChange = { path: 'src/a.ts', index: 'D', worktree: '.' }
    expect(gitChangeOpenPath(change, change.index, '/repo', '/repo')).toBeNull()
  })

  it('正常修改的文件仍返回工作区相对路径', () => {
    const change: GitChange = { path: 'app/src/a.ts', index: 'M', worktree: '.' }
    expect(gitChangeOpenPath(change, change.index, '/repo/app', '/repo')).toBe('src/a.ts')
  })

  it('工作区外的文件不提供打开路径', () => {
    const change: GitChange = { path: 'other/a.ts', index: 'M', worktree: '.' }
    expect(gitChangeOpenPath(change, change.index, '/repo/app', '/repo')).toBeNull()
  })
})
