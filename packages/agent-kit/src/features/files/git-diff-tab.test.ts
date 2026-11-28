/**
 * Git diff 标签后台刷新的两条判据。
 *
 * 防的回归：面板每 5 秒轮询一次打开的 diff，每次都先置 `loading` → 右侧换成
 * 「读取 diff…」占位再换回来，用户看到的就是「每几秒闪一下、滚动位置回顶」。
 */
import { describe, expect, it } from 'vitest'
import { diffRefreshIsNoop, showsDiffPlaceholder, type DiffTabRefreshView } from './git-diff-tab'

const loaded: DiffTabRefreshView = {
  hunks: [{ header: '@@ -1 +1 @@' }],
  diffText: '@@ -1 +1 @@\n-a\n+b',
  deleted: false,
  loading: false,
  error: null,
}

describe('showsDiffPlaceholder', () => {
  it('首次打开（还没有内容）显示占位', () => {
    expect(showsDiffPlaceholder(undefined)).toBe(true)
    expect(showsDiffPlaceholder({ ...loaded, hunks: null, diffText: null })).toBe(true)
  })

  it('已有内容的刷新不再显示占位（否则就是每几秒闪一下）', () => {
    expect(showsDiffPlaceholder(loaded)).toBe(false)
  })
})

describe('diffRefreshIsNoop', () => {
  it('原文与删除态都没变 → 不动 state', () => {
    expect(diffRefreshIsNoop(loaded, loaded.diffText!, false)).toBe(true)
  })

  it('原文变了 → 必须更新', () => {
    expect(diffRefreshIsNoop(loaded, '@@ -1 +1 @@\n-a\n+c', false)).toBe(false)
  })

  it('文件被删了 → 必须更新（换「已删除」提示）', () => {
    expect(diffRefreshIsNoop(loaded, loaded.diffText!, true)).toBe(false)
  })

  it('还在加载 / 有错误态 → 不能当无事可做（要把 loading / error 清掉）', () => {
    expect(diffRefreshIsNoop({ ...loaded, loading: true }, loaded.diffText!, false)).toBe(false)
    expect(diffRefreshIsNoop({ ...loaded, error: 'boom' }, loaded.diffText!, false)).toBe(false)
  })
})
