/** 防回归：切换展开文件、收起上方长 diff 时，刚点击的文件行不能滚出视口。 */
import { describe, expect, it } from 'vitest'
import { captureFileRowScroll, restoreFileRowScroll } from './file-row-scroll'

/** 只模拟布局和浏览器的 scrollTop 边界，不依赖 DOM 环境。 */
function createLayout(scrollTop = 1200, rowTop = 1500) {
  const state = {
    scrollTop,
    rowTop,
    containerTop: 80,
    maxScrollTop: 5000,
    connected: true,
    contained: true,
    writes: 0
  }
  const container = {
    get scrollTop() { return state.scrollTop },
    set scrollTop(value: number) {
      state.scrollTop = Math.max(0, Math.min(state.maxScrollTop, value))
      state.writes++
    },
    getBoundingClientRect: () => ({ top: state.containerTop }),
    contains: (element: HTMLElement) => state.contained && element === row
  } as unknown as HTMLElement
  const row = {
    get isConnected() { return state.connected },
    closest: () => container,
    getBoundingClientRect: () => ({ top: state.containerTop + state.rowTop - state.scrollTop })
  } as unknown as HTMLElement
  return { state, container, row }
}

describe('file row scroll anchor', () => {
  it('收起上方长 diff 后，刚点击的文件行保持原来的可见位置', () => {
    const { state, row } = createLayout()
    const anchor = captureFileRowScroll(row)
    state.rowTop -= 900

    restoreFileRowScroll(anchor)

    expect(state.scrollTop).toBe(300)
    expect(state.rowTop - state.scrollTop).toBe(300)
  })

  it('列表缩短导致浏览器先夹取 scrollTop 时，仍按文件行位置补偿', () => {
    const { state, container, row } = createLayout(1200, 1400)
    const anchor = captureFileRowScroll(row)
    state.rowTop -= 900
    state.maxScrollTop = 400
    container.scrollTop = container.scrollTop

    restoreFileRowScroll(anchor)

    expect(state.scrollTop).toBe(300)
    expect(state.rowTop - state.scrollTop).toBe(200)
  })

  it('diff 在文件行下方加载、行位置不变时不滚动', () => {
    const { state, row } = createLayout()
    const anchor = captureFileRowScroll(row)
    state.maxScrollTop += 2000

    restoreFileRowScroll(anchor)

    expect(state.scrollTop).toBe(1200)
    expect(state.writes).toBe(0)
  })

  it('面板整体移动时，不把视口坐标变化误当成列表内容位移', () => {
    const { state, row } = createLayout()
    const anchor = captureFileRowScroll(row)
    state.containerTop += 100

    restoreFileRowScroll(anchor)

    expect(state.scrollTop).toBe(1200)
    expect(state.writes).toBe(0)
  })

  it('剩余内容不足以保持原位置时，夹取到列表顶部，文件行仍可见', () => {
    const { state, row } = createLayout()
    const anchor = captureFileRowScroll(row)
    state.rowTop = 100

    restoreFileRowScroll(anchor)

    expect(state.scrollTop).toBe(0)
    expect(state.rowTop - state.scrollTop).toBe(100)
  })

  it.each(['connected', 'contained'] as const)('文件行不再 %s 时不操作旧列表', (key) => {
    const { state, row } = createLayout()
    const anchor = captureFileRowScroll(row)
    state[key] = false
    state.rowTop -= 900

    restoreFileRowScroll(anchor)

    expect(state.writes).toBe(0)
  })

  it('不在 Git 滚动容器中时不干预滚动', () => {
    const row = { closest: () => null } as unknown as HTMLElement
    expect(captureFileRowScroll(row)).toBeNull()
    expect(() => restoreFileRowScroll(null)).not.toThrow()
  })
})
