/**
 * `resolvePanelWorkspace` 的回归用例。
 *
 * 这条测试在防「刷新后停在某个工作区，点终端打不开；切到别的工作区再切回来才行」：
 * 首帧里 `activeWorkspaceId` 已经从 localStorage 恢复，但 `workspaces` 列表还没拉回来，
 * 现场于是被建成 `cwd: null` 并缓存；列表到达后必须能用同一个解析函数把路径补上。
 */
import { describe, expect, it } from 'vitest'

import { resolvePanelWorkspace } from './panel-session'

const workspaces = [
  { id: 'w-a', path: 'D:/a' },
  { id: 'w-b', path: 'D:/b' }
]
const conversations = [{ id: 'c-a', workspaceId: 'w-a' }]

describe('resolvePanelWorkspace', () => {
  it('会话自己的工作区优先于现场已有 / 当前选中', () => {
    expect(resolvePanelWorkspace('c-a', 'w-b', conversations, workspaces, 'w-b')).toEqual({
      workspaceId: 'w-a',
      cwd: 'D:/a'
    })
  })

  it('没有对应会话（草稿标签）时用现场已有的工作区', () => {
    expect(resolvePanelWorkspace('draft:w-b', 'w-b', conversations, workspaces, 'w-a')).toEqual({
      workspaceId: 'w-b',
      cwd: 'D:/b'
    })
  })

  it('现场还没有工作区时回落到当前选中', () => {
    expect(resolvePanelWorkspace('draft:w-a', '', conversations, workspaces, 'w-a')).toEqual({
      workspaceId: 'w-a',
      cwd: 'D:/a'
    })
  })

  it('工作区列表还没到达时 cwd 为 null（等列表到了再补算）', () => {
    expect(resolvePanelWorkspace('draft:w-a', 'w-a', conversations, [], 'w-a')).toEqual({
      workspaceId: 'w-a',
      cwd: null
    })
  })
})
