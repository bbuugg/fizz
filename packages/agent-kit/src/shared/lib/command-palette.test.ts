/** 防止宿主登记的命令面板入口丢失或忽略指定的初始页面。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestCommandPalette, setCommandPaletteOpener } from './command-palette'

afterEach(() => setCommandPaletteOpener(null))

describe('command palette opener', () => {
  it('把指定页面传给宿主 opener', () => {
    const opener = vi.fn()
    setCommandPaletteOpener(opener)

    requestCommandPalette('new-workspace')

    expect(opener).toHaveBeenCalledWith('new-workspace')
  })

  it('未登记宿主时安全 no-op', () => {
    expect(() => requestCommandPalette('new-workspace')).not.toThrow()
  })
})
