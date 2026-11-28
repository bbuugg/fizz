import { describe, expect, it } from 'vitest'
import {
  backgroundOf,
  buildStyle,
  clampThemeNumber,
  createCustomTheme,
  DEFAULT_THEME_BACKGROUND,
  normalizeStore,
  sanitizeFontStack,
  THEME_VAR_NAMES,
  videoStillUsed,
  withThemeBackground,
  type ColorThemeStore,
  type ThemeBackground
} from './useColorTheme'

const bg = (key: string | null = null, image: string | null = null): ThemeBackground => ({
  image,
  video: key ? { key, mime: 'video/mp4', name: 'a.mp4' } : null,
  fit: 'cover',
  mask: 0.72,
  blur: 0
})

const customTheme = (extra: Record<string, unknown> = {}) => ({
  id: 'custom-1',
  name: '自定义 1',
  radius: 0.875,
  texture: 'none' as const,
  vars: { light: {} as Record<string, string>, dark: {} as Record<string, string> },
  background: DEFAULT_THEME_BACKGROUND,
  ...extra
})

const theme = (vars: Record<string, Record<string, string>>, extra: Record<string, unknown> = {}) => ({
  custom: [customTheme({ vars: { light: {}, dark: {}, ...vars }, ...extra })]
})

describe('normalizeStore', () => {
  it('老主题只有颜色键时不补新键（缺的继承 :root 默认）', () => {
    const store = normalizeStore(theme({ light: { '--background': '#ffffff' } }))
    expect(store.custom[0].vars.light).toEqual({ '--background': '#ffffff' })
  })

  it('数字越界被夹到声明范围', () => {
    const store = normalizeStore(theme({ light: { '--fizz-text-scale': '9', '--fizz-density': '0' } }))
    expect(store.custom[0].vars.light['--fizz-text-scale']).toBe('1.1')
    expect(store.custom[0].vars.light['--fizz-density']).toBe('0.92')
  })

  it('非法颜色被丢弃，合法 8 位 hex 保留', () => {
    const store = normalizeStore(theme({ light: { '--border': 'red;body{display:none}', '--input': '#11223344' } }))
    expect(store.custom[0].vars.light['--border']).toBeUndefined()
    expect(store.custom[0].vars.light['--input']).toBe('#11223344')
  })

  it('老数据没有 texture 时归 none', () => {
    const store = normalizeStore(theme({ light: {} }))
    expect(store.custom[0].texture).toBe('none')
  })
})

describe('背景覆盖层', () => {
  it('新格式 overrides 原样保留', () => {
    const store = normalizeStore({
      overrides: {
        ocean: {
          vars: { light: { '--primary': '#123456' }, dark: {} },
          radius: 0.5,
          texture: 'dots',
          background: bg()
        }
      }
    })
    expect(store.overrides.ocean.vars?.light['--primary']).toBe('#123456')
    expect(store.overrides.ocean.radius).toBe(0.5)
    expect(store.overrides.ocean.texture).toBe('dots')
  })
})

describe('backgroundOf', () => {
  const store = (): ColorThemeStore => ({
    active: 'custom-1',
    custom: [customTheme({ background: bg(null, 'data:image/png;base64,CC') })],
    overrides: { ocean: { background: bg('v9') } }
  })

  it('自定义主题读自己的字段', () => {
    expect(backgroundOf(store(), 'custom-1').image).toBe('data:image/png;base64,CC')
  })

  it('内置主题读覆盖层', () => {
    expect(backgroundOf(store(), 'ocean').video?.key).toBe('v9')
  })

  it('都没有时给默认值', () => {
    expect(backgroundOf(store(), 'forest')).toEqual(DEFAULT_THEME_BACKGROUND)
  })
})

describe('sanitizeFontStack', () => {
  it('剥掉能打断 <style> 规则的字符与函数', () => {
    expect(sanitizeFontStack('Arial; } body{display:none')).not.toMatch(/[;{}]/)
    expect(sanitizeFontStack('url(https://x) Arial')).not.toContain('url(')
  })
  it('正常字体栈原样保留（含引号与逗号）', () => {
    expect(sanitizeFontStack("'Cascadia Code', Consolas, monospace")).toBe(
      "'Cascadia Code', Consolas, monospace"
    )
  })
})

describe('clampThemeNumber', () => {
  it('非数字落回默认并夹紧', () => {
    expect(clampThemeNumber('abc', 0.9, 1.1, 1)).toBe('1')
    expect(clampThemeNumber(2, 0.9, 1.1, 1)).toBe('1.1')
  })
})

describe('buildStyle', () => {
  const base = (): ColorThemeStore => ({
    active: 'custom-1',
    custom: [customTheme({ texture: 'dots' as const })],
    overrides: {}
  })

  it('输出新变量、纹理与圆角', () => {
    const css = buildStyle(base(), false)
    expect(css).toContain('--fizz-theme-texture:radial-gradient')
    expect(css).toContain('--radius:0.875rem')
  })

  it('没有媒体/纹理时不改写 --background', () => {
    expect(buildStyle(base(), false)).not.toContain('--background:rgb(')
  })

  /**
   * 回归：`decls()` 曾经把 surface 写成 `veil(bg, USER_SURFACE_MASK)`（**乘** 0.14），
   * 不透明底被算成 0.14 —— 微调出一套主题（一个字都没改）就让手机设置页（`bg-surface-1`）
   * 变成 86% 透明，能看见后面的界面。
   */
  it('没有媒体时 surface 与画布同色，且不比画布更透', () => {
    const surfaceAlpha = (css: string, token: string): number => {
      const match = css.match(new RegExp(`${token}:rgb\\([^)]*\\/ ([0-9.]+)\\)`))
      return match ? Number(match[1]) : Number.NaN
    }

    const store = base()
    store.custom[0].vars.light['--background'] = '#ffffff'
    const opaque = buildStyle(store, false)
    expect(surfaceAlpha(opaque, '--surface-1')).toBe(1)
    expect(surfaceAlpha(opaque, '--surface-2')).toBe(1)

    // 用户把底色调成半透明（玻璃感）时，面板要比画布实一档，但不能被乘成「几乎全透」
    store.custom[0].vars.light['--background'] = '#ffffff80'
    const glass = buildStyle(store, false)
    expect(surfaceAlpha(glass, '--surface-1')).toBeGreaterThan(0.5)
    expect(surfaceAlpha(glass, '--surface-1')).toBeLessThan(1)
  })

  it('有媒体时纹理让位（媒体优先）', () => {
    const store = base()
    store.custom[0] = { ...store.custom[0], background: bg(null, 'data:image/png;base64,AA') }
    const css = buildStyle(store, true)
    expect(css).toContain('--fizz-bg-image:url("data:image/png;base64,AA")')
    expect(css).toContain('--fizz-theme-texture:none')
    expect(css).toContain('--fizz-texture-size:auto')
  })

  it('字体栈里的注入字符到不了 CSS', () => {
    const store = base()
    store.custom[0].vars.light['--fizz-font-sans'] = "'Arial'; } body{display:none"
    const css = buildStyle(store, false)
    expect(css).not.toContain('body{display:none')
  })

  it('内置主题的覆盖层生成同名选择器规则', () => {
    const store: ColorThemeStore = {
      active: 'ocean',
      custom: [],
      overrides: {
        ocean: {
          vars: { light: { '--primary': '#123456' }, dark: { '--primary': '#654321' } },
          radius: 0.5,
          texture: 'none',
          background: DEFAULT_THEME_BACKGROUND
        }
      }
    }
    const css = buildStyle(store, false)
    expect(css).toContain('[data-theme="ocean"], html[data-theme="ocean"]{')
    expect(css).toContain('--primary:#123456')
    expect(css).toContain('.dark[data-theme="ocean"], html.dark[data-theme="ocean"]{')
    expect(css).toContain('--radius:0.5rem')
  })

  it('只有背景的覆盖层不生成变量规则', () => {
    const store: ColorThemeStore = {
      active: 'ocean',
      custom: [],
      overrides: { ocean: { background: bg(null, 'data:image/png;base64,AA') } }
    }
    expect(buildStyle(store, false)).not.toContain('[data-theme="ocean"]')
  })
})

describe('强调色属于主题', () => {
  const base = (): ColorThemeStore => ({
    active: 'custom-1',
    custom: [customTheme()],
    overrides: {}
  })

  it('颜色页签能微调 --primary 与它上面的文字色', () => {
    expect(THEME_VAR_NAMES).toContain('--primary')
    expect(THEME_VAR_NAMES).toContain('--primary-foreground')
  })

  it('自定义主题把 --primary 写进注入的样式', () => {
    const store = base()
    store.custom[0].vars.light['--primary'] = '#7b3fa0'
    store.custom[0].vars.dark['--primary'] = '#d8b4fe'
    const css = buildStyle(store, false)
    expect(css).toContain('--primary:#7b3fa0')
    expect(css).toContain('--primary:#d8b4fe')
  })

  it('合法的强调色能存下来', () => {
    const store = normalizeStore(theme({ light: { '--primary': '#7b3fa0' } }))
    expect(store.custom[0].vars.light['--primary']).toBe('#7b3fa0')
  })
})

describe('派生主题继承背景', () => {
  it('把种子主题的背景复制给新主题（不是共享同一个对象）', () => {
    const store: ColorThemeStore = {
      active: 'custom-1',
      custom: [customTheme({ background: bg('v1') })],
      overrides: {}
    }
    const { store: next, id } = createCustomTheme(store, 'custom-1')
    const created = next.custom.find((item) => item.id === id)
    expect(created?.background).toEqual(bg('v1'))
    expect(created?.background).not.toBe(store.custom[0].background)
  })

  it('种子没有背景时落到默认值', () => {
    const store: ColorThemeStore = { active: 'custom-1', custom: [customTheme()], overrides: {} }
    const { store: next, id } = createCustomTheme(store, 'custom-1')
    expect(next.custom.find((item) => item.id === id)?.background).toEqual(DEFAULT_THEME_BACKGROUND)
  })
})

describe('withThemeBackground', () => {
  it('自定义主题写进自己的 background', () => {
    const store: ColorThemeStore = { active: 'custom-1', custom: [customTheme()], overrides: {} }
    const next = withThemeBackground(store, 'custom-1', bg('v1'))
    expect(next.custom[0].background).toEqual(bg('v1'))
    expect(next.overrides).toEqual({})
  })

  it('内置主题写进覆盖层，不动已有自定义主题', () => {
    const store: ColorThemeStore = { active: 'ocean', custom: [customTheme()], overrides: {} }
    const next = withThemeBackground(store, 'ocean', bg(null, 'data:image/png;base64,AA'))
    expect(next.overrides.ocean.background.image).toBe('data:image/png;base64,AA')
    expect(next.custom[0].background).toEqual(DEFAULT_THEME_BACKGROUND)
  })

  it('清空内置主题的背景时整条覆盖删掉（= 恢复出厂）', () => {
    const store: ColorThemeStore = {
      active: 'ocean',
      custom: [],
      overrides: { ocean: { background: bg('v1') } }
    }
    const next = withThemeBackground(store, 'ocean', { ...DEFAULT_THEME_BACKGROUND })
    expect(next.overrides).toEqual({})
  })

  it('覆盖层还有变量改动时保留，只清背景', () => {
    const store: ColorThemeStore = {
      active: 'ocean',
      custom: [],
      overrides: {
        ocean: {
          vars: { light: { '--primary': '#123456' }, dark: {} },
          radius: 0.5,
          texture: 'none',
          background: bg('v1')
        }
      }
    }
    const next = withThemeBackground(store, 'ocean', { ...DEFAULT_THEME_BACKGROUND })
    expect(next.overrides.ocean.vars?.light['--primary']).toBe('#123456')
    expect(next.overrides.ocean.background.video).toBeNull()
  })

  it('不认识的 id 原样返回（别写出永远清不掉的野配置）', () => {
    const store: ColorThemeStore = { active: 'ocean', custom: [], overrides: {} }
    expect(withThemeBackground(store, 'ghost', bg('v1'))).toBe(store)
  })
})

describe('videoStillUsed', () => {
  it('别的主题（自定义或内置覆盖）还引用同一个 key 时返回 true', () => {
    expect(
      videoStillUsed(
        { custom: [customTheme({ background: bg('v1') })], overrides: { ocean: { background: bg('v1') } } },
        'v1'
      )
    ).toBe(true)
  })

  it('没有人引用时返回 false', () => {
    expect(
      videoStillUsed(
        { custom: [customTheme({ background: bg('v2') })], overrides: { ocean: { background: bg(null) } } },
        'v1'
      )
    ).toBe(false)
  })
})
