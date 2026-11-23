/**
 * `resolvePanelWorkspace` 的回归用例。
 *
 * 这条测试在防「刷新后停在某个工作区，点终端打不开；切到别的工作区再切回来才行」：
 * 首帧里 `activeWorkspaceId` 已经从 localStorage 恢复，但 `workspaces` 列表还没拉回来，
 * 现场于是被建成 `cwd: null` 并缓存；列表到达后必须能用同一个解析函数把路径补上。
 */
import { describe, expect, it } from 'vitest'

import {
  mergeDraftPanel,
  resolvePanelWorkspace,
  resolveTerminalCwd,
  type PanelSession
} from './panel-session'

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

  /**
   * 刷新后仍打不开终端的另一半原因：现场 / 持久化的 `activeWorkspaceId` 指向**已被删掉**
   * 的工作区（旧临时工作区被丢弃、项目被删）。优先级最高的候选不在清单里时，必须退到
   * 下一个仍在清单里的候选，否则补算永远得不到路径。
   */
  it('现场里的工作区已被删除时退到当前选中（拿得到目录）', () => {
    expect(resolvePanelWorkspace('draft:w-a', 'w-deleted', conversations, workspaces, 'w-a')).toEqual({
      workspaceId: 'w-a',
      cwd: 'D:/a'
    })
  })

  it('会话工作区已被删除时同样退到下一个仍在清单里的候选', () => {
    const staleConversations = [{ id: 'c-x', workspaceId: 'w-deleted' }]
    expect(resolvePanelWorkspace('c-x', '', staleConversations, workspaces, 'w-b')).toEqual({
      workspaceId: 'w-b',
      cwd: 'D:/b'
    })
  })

  it('候选全都不在清单里时保留最高优先级的 id，cwd 为空', () => {
    expect(resolvePanelWorkspace('draft:w-x', 'w-x', conversations, workspaces, 'w-y')).toEqual({
      workspaceId: 'w-x',
      cwd: null
    })
  })
})

/**
 * `resolveTerminalCwd` 的回归用例。
 *
 * 这条测试在防「刷新后点终端打不开 / 快捷命令 5 秒超时」：现场里缓存了 `cwd: null`
 * （首屏工作区列表还没到就建了现场）时，**点终端那一刻必须按最新数据重算**，不能拿
 * 这个空值把点击吞掉；真没有可用目录时必须返回 `null`，让调用方明确报错而不是静默。
 */
describe('resolveTerminalCwd', () => {
  it('现场 cwd 为空、列表已到：用最新数据解析出目录（刷新后点终端的主力场景）', () => {
    expect(resolveTerminalCwd('draft:w-a', 'w-a', null, conversations, workspaces, 'w-a')).toEqual({
      workspaceId: 'w-a',
      cwd: 'D:/a'
    })
  })

  it('会话自己的工作区优先于现场 / 当前选中', () => {
    expect(resolveTerminalCwd('c-a', 'w-b', 'D:/b', conversations, workspaces, 'w-b')).toEqual({
      workspaceId: 'w-a',
      cwd: 'D:/a'
    })
  })

  it('解析不到新路径时退回现场里已有的 cwd（保留现场归属）', () => {
    expect(resolveTerminalCwd('draft:w-a', 'w-a', 'D:/mine', conversations, [], 'w-a')).toEqual({
      workspaceId: 'w-a',
      cwd: 'D:/mine'
    })
  })

  it('现场和列表都没有可用目录时返回 null（调用方必须当失败提示）', () => {
    expect(resolveTerminalCwd('draft:w-x', 'w-x', null, conversations, workspaces, 'w-y')).toBeNull()
  })
})

/**
 * `mergeDraftPanel` 的回归用例。
 *
 * 在防「刷新后点终端，终端闪一下就没了 / 点快捷命令一直等到 5 秒超时」的另一半：
 * 草稿标签被就地替换成会话标签时，目标会话可能已经被后台 patch（git 状态）建出一个
 * 空壳现场；旧实现看到目标已有现场就整份放弃迁移，草稿里刚开出来的终端（PTY）随后
 * 被回收 effect 连现场一起清掉。
 */
function panel(overrides: Partial<PanelSession>): PanelSession {
  return {
    id: 'panel-x',
    workspaceId: 'w-a',
    cwd: 'D:/a',
    sideTab: null,
    lastSideTab: null,
    tabOrder: [],
    terminals: [],
    filesMounted: false,
    gitMounted: false,
    browserMounted: false,
    previewMounted: false,
    gitChanges: null,
    gitBranch: null,
    ...overrides
  }
}

describe('mergeDraftPanel', () => {
  it('目标是没有终端的空壳：草稿里的终端与正看的标签要保住', () => {
    const draft = panel({
      terminals: [{ id: 'term-1', shellId: null, cwd: 'D:/a' }],
      tabOrder: ['terminal:term-1'],
      sideTab: 'terminal:term-1',
      lastSideTab: 'terminal:term-1'
    })
    const shell = panel({ gitChanges: { count: 2, truncated: false }, gitBranch: 'main' })
    const merged = mergeDraftPanel(shell, draft)
    expect(merged.terminals.map((t) => t.id)).toEqual(['term-1'])
    expect(merged.sideTab).toBe('terminal:term-1')
    expect(merged.tabOrder).toEqual(['terminal:term-1'])
    // 目标的 git 状态不能丢
    expect(merged.gitChanges).toEqual({ count: 2, truncated: false })
    expect(merged.gitBranch).toBe('main')
  })

  it('两边都有终端：按 id 去重拼接，挂出标记取并集', () => {
    const existing = panel({
      terminals: [{ id: 'term-1', shellId: null, cwd: 'D:/a' }],
      filesMounted: true
    })
    const draft = panel({
      terminals: [
        { id: 'term-1', shellId: null, cwd: 'D:/a' },
        { id: 'term-2', shellId: null, cwd: 'D:/a' }
      ],
      gitMounted: true
    })
    const merged = mergeDraftPanel(existing, draft)
    expect(merged.terminals.map((t) => t.id)).toEqual(['term-1', 'term-2'])
    expect(merged.filesMounted).toBe(true)
    expect(merged.gitMounted).toBe(true)
  })

  it('目标没有目录时用草稿的目录（草稿里的终端说明那条目录能用）', () => {
    const merged = mergeDraftPanel(
      panel({ workspaceId: 'w-x', cwd: null }),
      panel({ workspaceId: 'w-a', cwd: 'D:/a' })
    )
    expect(merged.workspaceId).toBe('w-a')
    expect(merged.cwd).toBe('D:/a')
  })
})
