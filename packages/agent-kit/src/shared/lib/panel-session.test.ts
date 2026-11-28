/**
 * `resolvePanelWorkspace` 的回归用例。
 *
 * 这条测试在防「刷新后停在某个工作区，点终端打不开；切到别的工作区再切回来才行」：
 * 首帧里 `activeWorkspaceId` 已经从 localStorage 恢复，但 `workspaces` 列表还没拉回来，
 * 现场于是被建成 `cwd: null` 并缓存；列表到达后必须能用同一个解析函数把路径补上。
 *
 * 两个函数的第一个参数都是**标签指向的会话 id**（草稿标签传 `null`）—— 不是标签 key。
 */
import { describe, expect, it } from 'vitest'

import {
  aliveTabs,
  focusTab,
  isTabMounted,
  resolvePanelWorkspace,
  resolveTerminalCwd,
  retargetPanelWorkspace,
  withoutMounted,
  type PanelSession
} from './panel-session'

const workspaces = [
  { id: 'w-a', path: 'D:/a' },
  { id: 'w-b', path: 'D:/b' }
]
const conversations = [{ id: 'c-a', workspaceId: 'w-a' }]

/** `retargetPanelWorkspace`：换工作区只改归属，终端一个不落（PTY 不重开） */
describe('retargetPanelWorkspace', () => {
  it('换工作区后终端原样留着，只改 workspaceId / cwd', () => {
    const base = panel({
      terminals: [{ id: 'term-1', shellId: null, cwd: 'D:/a' }],
      tabOrder: ['terminal:term-1'],
      sideTab: 'terminal:term-1'
    })
    const next = retargetPanelWorkspace(base, 'w-b', 'D:/b')
    expect(next.workspaceId).toBe('w-b')
    expect(next.cwd).toBe('D:/b')
    // 终端自己的 cwd 不变（已经在旧目录里跑起来了，不能跟着换）
    expect(next.terminals).toEqual([{ id: 'term-1', shellId: null, cwd: 'D:/a' }])
    expect(next.sideTab).toBe('terminal:term-1')
  })

  it('归属没变时原样返回（不造无谓的新对象 / 不多渲染一轮）', () => {
    const base = panel({ workspaceId: 'w-a', cwd: 'D:/a' })
    expect(retargetPanelWorkspace(base, 'w-a', 'D:/a')).toBe(base)
  })
})

describe('resolvePanelWorkspace', () => {
  it('会话自己的工作区优先于现场已有 / 当前选中', () => {
    expect(resolvePanelWorkspace('c-a', 'w-b', conversations, workspaces, 'w-b')).toEqual({
      workspaceId: 'w-a',
      cwd: 'D:/a'
    })
  })

  it('没有对应会话（草稿标签）时用现场已有的工作区', () => {
    expect(resolvePanelWorkspace(null,'w-b', conversations, workspaces, 'w-a')).toEqual({
      workspaceId: 'w-b',
      cwd: 'D:/b'
    })
  })

  it('现场还没有工作区时回落到当前选中', () => {
    expect(resolvePanelWorkspace(null,'', conversations, workspaces, 'w-a')).toEqual({
      workspaceId: 'w-a',
      cwd: 'D:/a'
    })
  })

  it('工作区列表还没到达时 cwd 为 null（等列表到了再补算）', () => {
    expect(resolvePanelWorkspace(null,'w-a', conversations, [], 'w-a')).toEqual({
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
    expect(resolvePanelWorkspace(null,'w-deleted', conversations, workspaces, 'w-a')).toEqual({
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
    expect(resolvePanelWorkspace(null,'w-x', conversations, workspaces, 'w-y')).toEqual({
      workspaceId: 'w-x',
      cwd: null
    })
  })
})

/** Git 与文件模式共用一颗侧栏标签，切换时不替换 FilesPanel 实例。 */
describe('unified file and Git side panel', () => {
  it('mounting Git creates one files tab while retaining Git mode as the selected view', () => {
    const next = focusTab(panel({}), 'git')
    expect(next.filesMounted).toBe(true)
    expect(next.gitMounted).toBe(true)
    expect(next.sideTab).toBe('git')
    expect(aliveTabs(next)).toEqual(['files'])
    expect(isTabMounted(next, 'files')).toBe(true)
    expect(isTabMounted(next, 'git')).toBe(true)
  })

  it('closing the unified files panel clears both mode markers', () => {
    const mounted = focusTab(panel({}), 'git')
    const next = withoutMounted(mounted, 'files')
    expect(next.filesMounted).toBe(false)
    expect(next.gitMounted).toBe(false)
    expect(aliveTabs(next)).toEqual([])
  })

  it('将旧版独立 Git 标签归一到共享文件标签且不重复', () => {
    const legacy = panel({
      gitMounted: true,
      sideTab: 'git',
      lastSideTab: 'git',
      terminals: [{ id: 'term-1', shellId: null, cwd: 'D:/a' }],
      tabOrder: ['terminal:term-1', 'git']
    })
    const next = focusTab(legacy, 'files')
    expect(next.tabOrder).toEqual(['terminal:term-1', 'files'])
    expect(aliveTabs(next)).toEqual(['terminal:term-1', 'files'])
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
    expect(resolveTerminalCwd(null,'w-a', null, conversations, workspaces, 'w-a')).toEqual({
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
    expect(resolveTerminalCwd(null,'w-a', 'D:/mine', conversations, [], 'w-a')).toEqual({
      workspaceId: 'w-a',
      cwd: 'D:/mine'
    })
  })

  it('现场和列表都没有可用目录时返回 null（调用方必须当失败提示）', () => {
    expect(resolveTerminalCwd(null,'w-x', null, conversations, workspaces, 'w-y')).toBeNull()
  })
})

/** 一份空白现场，按需覆盖几个字段 */
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
