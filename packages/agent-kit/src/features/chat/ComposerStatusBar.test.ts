/**
 * 回归：分屏 composer 的分支、改动数、本地远端归属与状态回写必须属于本标签。
 * 使用服务端渲染与捕获的 effect，不启动浏览器、不访问真实 Git 或用户目录。
 *
 * 标签 key 是不透明的身份（`chat:<n>`），不是会话 id：这里特意让两者不同，钉住
 * 「状态横条只认宿主传下来的 `panelKey`」—— 从 `app.activeConversationId` 反推会改到
 * 别的标签的面板上。
 * 同一工作区首次加载后，轮末刷新不能把分支与改动数重新替换成骨架屏。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { PanelSession } from '@fizz/agent-kit/shared/lib/panel-session'
import { ComposerStatusBar } from './ComposerStatusBar'

const TAB = 'chat:7'

const mocks = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  effects: [] as Array<() => void | (() => void)>,
  captureHooks: false,
  hookIndex: 0,
  hooks: [] as unknown[]
}))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
    useState: (initial: unknown) => {
      if (!mocks.captureHooks) return react.useState(initial)
      const index = mocks.hookIndex++
      if (index >= mocks.hooks.length) mocks.hooks[index] = initial
      return [mocks.hooks[index], (value: unknown) => {
        mocks.hooks[index] = typeof value === 'function' ? value(mocks.hooks[index]) : value
      }]
    },
    useRef: (initial: unknown) => {
      if (!mocks.captureHooks) return react.useRef(initial)
      const index = mocks.hookIndex++
      if (index >= mocks.hooks.length) mocks.hooks[index] = { current: initial }
      return mocks.hooks[index]
    }
  }
})
vi.mock('@fizz/agent-kit/shared/hooks/use-app-context', () => ({
  useAppContext: () => mocks.context
}))
vi.mock('@fizz/agent-kit/shared/lib/language', () => ({ useT: () => (text: string) => text }))
vi.mock('@fizz/agent-kit/features/chat/ContextRing', () => ({ ContextRing: () => null }))
vi.mock('@fizz/agent-kit/features/chat/AcpPermissionPill', () => ({ AcpPermissionPill: () => null }))
vi.mock('@fizz/agent-kit/features/chat/composer', () => ({ PermissionPill: () => null }))
vi.mock('@fizz/agent-kit/features/chat/session-backend', () => ({ turnIsAcp: () => false }))

function setup() {
  const remote = { id: 'remote', path: '/srv/project', remote: { hostId: 'ssh-b' } }
  const panel = { gitBranch: 'feature-b', gitChanges: { count: 3, truncated: true } }
  const panelOf = vi.fn(() => panel)
  const patchPanelOf = vi.fn()
  const status = {
    isRepo: true, branch: 'updated-b', detached: false,
    changes: [{ path: 'file.ts' }], truncated: false
  }
  const gitStatus = vi.fn().mockResolvedValue(status)
  mocks.context = {
    panelOf, patchPanelOf, toggleSideTabOf: vi.fn(),
    // 焦点 A 的旧入口故意留着，误读时断言应失败。
    activePanel: { gitBranch: 'main-a' }, gitBadge: '99',
    patchActivePanel: vi.fn(), toggleSideTab: vi.fn()
  }
  const app = {
    activeConversationId: 'conv-b', activeWorkspaceId: remote.id,
    activeWorkspace: remote, workspaces: [remote],
    sshHosts: [{ id: 'ssh-b', name: 'remote-b' }],
    gitStatus, streaming: false
  } as unknown as AgentApp
  return { app, panelOf, patchPanelOf, gitStatus }
}

beforeEach(() => {
  mocks.effects = []
  mocks.captureHooks = false
  mocks.hookIndex = 0
  mocks.hooks = []
})

/** 保留本组件的 state / ref，再用 SSR 检查真实 JSX；不引入浏览器或 DOM 测试依赖。 */
function trackRenders(app: AgentApp) {
  mocks.captureHooks = true
  return () => {
    mocks.effects = []
    mocks.hookIndex = 0
    return renderToStaticMarkup(createElement(ComposerStatusBar, { app, panelKey: TAB, running: false }))
  }
}

describe('ComposerStatusBar：本标签的工作区与面板现场', () => {
  it('显示自己的分支 / 改动数 / 远端主机，不随其他标签的焦点现场变动', () => {
    const { app, panelOf } = setup()
    const render = () =>
      renderToStaticMarkup(createElement(ComposerStatusBar, { app, panelKey: TAB, running: false }))
    const html = render()
    expect(panelOf).toHaveBeenCalledWith(TAB)
    expect(panelOf).not.toHaveBeenCalledWith('conv-b')
    expect(html).toContain('feature-b')
    expect(html).toContain('3+')
    expect(html).toContain('remote-b')
    expect(html).not.toContain('main-a')
    mocks.context.activePanel = { gitBranch: 'another-focus' }
    expect(render()).toBe(html)
  })

  it('异步 Git 状态只写回发起请求的标签，包含分支与改动数', async () => {
    const { app, patchPanelOf, gitStatus } = setup()
    renderToStaticMarkup(createElement(ComposerStatusBar, { app, panelKey: TAB, running: false }))
    mocks.effects[0]()
    mocks.context.activePanel = { gitBranch: 'focus-changed' }
    await vi.waitFor(() => expect(patchPanelOf).toHaveBeenCalled())
    expect(gitStatus).toHaveBeenCalledWith('remote')
    const [key, update] = patchPanelOf.mock.calls[0]
    expect(key).toBe(TAB)
    expect(update({ id: 'panel-b' } as PanelSession)).toMatchObject({
      id: 'panel-b', gitBranch: 'updated-b', gitChanges: { count: 1, truncated: false }
    })
    expect(mocks.context.patchActivePanel).not.toHaveBeenCalled()
  })

  it('新对话页的面板同样按标签 key 找，不依赖会话 id', () => {
    const { app, panelOf } = setup()
    renderToStaticMarkup(createElement(ComposerStatusBar, {
      app: { ...app, activeConversationId: null }, panelKey: 'chat:2', running: false
    }))
    expect(panelOf).toHaveBeenCalledWith('chat:2')
  })

  it('标签卸载或切换工作区后，迟到的 Git 请求不再回写', async () => {
    const { app, patchPanelOf } = setup()
    let resolve!: (status: Awaited<ReturnType<AgentApp['gitStatus']>>) => void
    app.gitStatus = vi.fn(() => new Promise<Awaited<ReturnType<AgentApp['gitStatus']>>>((done) => {
      resolve = done
    }))
    renderToStaticMarkup(createElement(ComposerStatusBar, { app, panelKey: TAB, running: false }))
    const cleanup = mocks.effects[0]()
    if (cleanup) cleanup()
    resolve({
      isRepo: true, root: '/old', branch: 'stale', detached: false,
      upstream: null, ahead: 0, behind: 0, changes: [], truncated: false,
      remotes: [], stashes: []
    })
    await Promise.resolve()
    expect(patchPanelOf).not.toHaveBeenCalled()
  })

  it('首次加载显示骨架屏，轮末后台刷新保留已有分支和改动数', async () => {
    const { app, gitStatus } = setup()
    const render = trackRenders(app)
    render()
    mocks.effects[0]()
    expect(render()).toContain('data-slot="skeleton"')
    await vi.waitFor(() => expect(render()).not.toContain('data-slot="skeleton"'))

    app.streaming = true
    render()
    mocks.effects[0]()
    gitStatus.mockImplementationOnce(() => new Promise(() => {}))
    app.streaming = false
    render()
    mocks.effects[0]()

    const html = render()
    expect(gitStatus).toHaveBeenCalledTimes(2)
    expect(html).not.toContain('data-slot="skeleton"')
    expect(html).toContain('feature-b')
    expect(html).toContain('3+')
  })

  it('切换工作区时，新仓库首次加载仍显示骨架屏', async () => {
    const { app, gitStatus } = setup()
    const render = trackRenders(app)
    render()
    mocks.effects[0]()
    await vi.waitFor(() => expect(render()).not.toContain('data-slot="skeleton"'))

    app.activeWorkspaceId = 'another-workspace'
    gitStatus.mockImplementationOnce(() => new Promise(() => {}))
    render()
    mocks.effects[0]()
    expect(render()).toContain('data-slot="skeleton"')
    expect(gitStatus).toHaveBeenLastCalledWith('another-workspace')
  })
})
