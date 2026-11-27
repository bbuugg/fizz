/**
 * 标签「刷新代号」的三条不变量。
 *
 * ## 这条测试在防什么回归
 *
 * 内容宿主的 React key 是 `标签 key # 代号`（见 `PanelContentLayer`）。标签 key 是终生不变的
 * 身份（`panel-tabs.ts`），所以代号只需要按 key 存：
 *
 * 1. 没刷过的标签代号是 0，**不能凭空变出来** —— 变了内容宿主就重挂，终端 PTY 被 kill；
 * 2. 关掉的标签代号要回收 —— 同一个 key 再开（`local:1` 这类会复用）是一次全新挂载，
 *    不能继承上一次的刷新状态；
 * 3. 守卫拦下时**不动代号**（「刷新按钮静默杀掉终端」就是这么来的）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const guard = vi.hoisted(() => vi.fn(async (_key: string) => true))

vi.mock('@fizz/agent-kit/shared/lib/tab-close', () => ({
  askTabReloadGuard: guard
}))

const { pruneTabReloads, reloadTabContent, requestReloadTab, tabReloadGen } = await import(
  './tab-reload'
)

afterEach(() => {
  // 代号是模块级 map，用例之间必须清干净（否则“没刷过”那条会被上一条污染）
  pruneTabReloads([])
  guard.mockReset()
  guard.mockResolvedValue(true)
})

describe('tab-reload 代号', () => {
  it('没刷过的标签代号是 0', () => {
    expect(tabReloadGen('chat:1')).toBe(0)
  })

  it('刷新一次代号 +1，按标签 key 各记各的', () => {
    reloadTabContent('chat:1')
    reloadTabContent('chat:1')
    reloadTabContent('local:1')

    expect(tabReloadGen('chat:1')).toBe(2)
    expect(tabReloadGen('local:1')).toBe(1)
    expect(tabReloadGen('chat:2')).toBe(0)
  })

  it('标签关掉后代号回收：同一个 key 再开是全新挂载', () => {
    reloadTabContent('local:1')
    pruneTabReloads(['chat:1'])

    expect(tabReloadGen('local:1')).toBe(0)
  })

  it('还在面板里的标签，回收时不动它的代号', () => {
    reloadTabContent('chat:1')
    pruneTabReloads(['chat:1', 'local:1'])

    expect(tabReloadGen('chat:1')).toBe(1)
  })

  it('守卫放行才重挂', async () => {
    await requestReloadTab('chat:1')

    expect(guard).toHaveBeenCalledWith('chat:1')
    expect(tabReloadGen('chat:1')).toBe(1)
  })

  it('守卫拦下时不动代号', async () => {
    guard.mockResolvedValue(false)

    await requestReloadTab('chat:1')

    expect(tabReloadGen('chat:1')).toBe(0)
  })
})
