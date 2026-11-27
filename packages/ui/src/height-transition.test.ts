/**
 * 防回归：Portal 在外层 layout effect 之后才挂载时，首次从 Agent 页切到模型页也必须有高度动画。
 * 在 Node 中捕获 ref / effect 回调，用尺寸假件重放挂载时序，不引入 DOM 测试环境。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHeightTransition } from './height-transition'

const hooks = vi.hoisted(() => ({
  index: 0,
  refs: [] as Array<{ current: unknown }>,
  layout: null as (() => void) | null,
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (initial: unknown) => {
    const index = hooks.index++
    return hooks.refs[index] ??= { current: initial }
  },
  useCallback: (callback: unknown) => callback,
  useLayoutEffect: (effect: () => void) => { hooks.layout = effect },
  useEffect: () => {},
}))

function panel(initialHeight: number) {
  let naturalHeight = initialHeight
  let height = ''
  const writes: string[] = []
  const style = {
    get height() { return height },
    set height(value: string) { height = value; writes.push(value) },
    transition: '',
  }
  const node = {
    style,
    get offsetHeight() { return height ? Number.parseFloat(height) : naturalHeight },
    getBoundingClientRect: () => ({ height: height ? Number.parseFloat(height) : naturalHeight }),
  } as unknown as HTMLDivElement
  return { node, style, writes, resize: (value: number) => { naturalHeight = value } }
}

function owner() {
  const ref = { current: null as HTMLDivElement | null }
  function useHeightTransitionHarness() {
    hooks.index = 0
    const attach = useHeightTransition(ref)
    return {
      attach,
      commit: () => hooks.layout!(),
    }
  }
  return { render: useHeightTransitionHarness }
}

let reducedMotion = false
beforeEach(() => {
  hooks.index = 0
  hooks.refs = []
  hooks.layout = null
  reducedMotion = false
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    matchMedia: () => ({ matches: reducedMotion }),
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('浮层高度过渡', () => {
  it('Portal 晚于外层 effect 挂载，第一次切页仍从一级高度过渡到二级高度', () => {
    const host = owner()
    const first = host.render()
    first.commit() // 外层已提交，但 Portal 的节点还没挂载。
    const element = panel(120)
    first.attach(element.node) // Portal 自己更新，外层不重新渲染。
    expect(element.style.height).toBe('')
    expect(element.style.transition).toBe('')

    element.resize(320)
    host.render().commit()

    expect(element.writes.slice(-2)).toEqual(['120px', '320px'])
    expect(element.style.transition).toContain('height 160ms')
    vi.runAllTimers()
    expect(element.style.height).toBe('')
    expect(element.style.transition).toBe('')
  })

  it('同步挂载也不播放入场高度动画，后续内容变化才过渡', () => {
    const host = owner()
    const first = host.render()
    const element = panel(120)
    first.attach(element.node)
    first.commit()
    expect(element.style.height).toBe('')
    expect(element.style.transition).toBe('')

    element.resize(240)
    host.render().commit()
    expect(element.writes.slice(-2)).toEqual(['120px', '240px'])
  })

  it('关闭后重新打开重置基准，首次切页不沿用上一次面板的高度', () => {
    const host = owner()
    const first = host.render()
    first.commit()
    const previous = panel(120)
    first.attach(previous.node)
    previous.resize(320)
    host.render().commit()
    expect(vi.getTimerCount()).toBe(1)
    first.attach(null)
    expect(vi.getTimerCount()).toBe(0)

    const reopened = panel(100)
    first.attach(reopened.node)
    expect(reopened.style.height).toBe('')
    reopened.resize(220)
    host.render().commit()
    expect(reopened.writes.slice(-2)).toEqual(['100px', '220px'])
  })

  it('用户开启减少动态效果时直接落定', () => {
    reducedMotion = true
    const host = owner()
    const first = host.render()
    first.commit()
    const element = panel(120)
    first.attach(element.node)
    element.resize(320)
    host.render().commit()
    expect(element.style.height).toBe('')
    expect(element.style.transition).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })
})
