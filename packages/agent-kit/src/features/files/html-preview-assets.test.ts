/**
 * 这几条用例防的是 HTML 预览的老问题：相对资源被按**宿主** base URL 解析
 * （desktop 下是 `file:///…/app.asar/out/renderer/`，Electron 直接拦掉）。
 * 内联前的路径解析与 CSS / srcset 改写全靠这里，所以单独钉住。
 */
import { describe, expect, it } from 'vitest'
import {
  collectCssRefs,
  collectSrcsetRefs,
  isLocalAssetRef,
  mapCssRefs,
  mapSrcset,
  resolveAssetPath
} from './html-preview-assets'

describe('resolveAssetPath', () => {
  it('相对引用按所在目录解析', () => {
    expect(resolveAssetPath('demo', 'vendor/three.min.js')).toBe('demo/vendor/three.min.js')
    expect(resolveAssetPath('', 'index.js')).toBe('index.js')
  })

  it('根目录与 ./ ../ 规范化', () => {
    expect(resolveAssetPath('demo/sub', '/assets/a.css')).toBe('assets/a.css')
    expect(resolveAssetPath('demo/sub', '../a.css')).toBe('demo/a.css')
    expect(resolveAssetPath('', '../../a.css')).toBe('a.css')
    expect(resolveAssetPath('demo', './x.js?v=1#f')).toBe('demo/x.js')
  })

  it('中文目录按 URL 编码往返', () => {
    expect(resolveAssetPath('我的 项目', '图片/a b.png')).toBe('我的 项目/图片/a b.png')
  })

  it('外部 / data / 锚点不内联', () => {
    expect(resolveAssetPath('demo', 'https://cdn.x/a.js')).toBeNull()
    expect(resolveAssetPath('demo', 'data:text/javascript,1')).toBeNull()
    expect(resolveAssetPath('demo', '#top')).toBeNull()
    expect(resolveAssetPath('demo', '//cdn.x/a.js')).toBeNull()
  })
})

describe('isLocalAssetRef', () => {
  it('只认本地相对引用', () => {
    expect(isLocalAssetRef('a.js')).toBe(true)
    expect(isLocalAssetRef('blob:http://x/1')).toBe(false)
    expect(isLocalAssetRef('mailto:a@b.c')).toBe(false)
    expect(isLocalAssetRef('')).toBe(false)
  })
})

describe('CSS 引用', () => {
  const css = `
    @import "theme.css";
    @import url(./print.css);
    .a { background: url( "../img/a b.png" ); }
    .b { background: url(data:image/png;base64,AAA); }
    .c { mask: url(#mask); }
    .d { background: url(https://cdn.x/a.png); }
  `

  it('收集本地引用（去重、排除外部与 data）', () => {
    expect(collectCssRefs(css).sort()).toEqual(['../img/a b.png', './print.css', 'theme.css'])
  })

  it('只改写提供映射的引用', () => {
    const out = mapCssRefs(css, (ref) => (ref === 'theme.css' ? 'data:text/css;base64,QQ==' : null))
    expect(out).toContain('@import url("data:text/css;base64,QQ==")')
    expect(out).toContain('url( "../img/a b.png" )')
    expect(out).toContain('url(data:image/png;base64,AAA)')
    expect(out).toContain('url(https://cdn.x/a.png)')
  })
})

describe('srcset', () => {
  it('收集并改写本地候选', () => {
    const value = 'a.png 1x, ../b.png 2x, https://cdn.x/c.png 3x'
    expect(collectSrcsetRefs(value).sort()).toEqual(['../b.png', 'a.png'])
    const out = mapSrcset(value, (ref) => (ref === 'a.png' ? 'data:image/png;base64,QQ==' : null))
    expect(out).toBe('data:image/png;base64,QQ== 1x, ../b.png 2x, https://cdn.x/c.png 3x')
  })

  it('含 data: 时整条不动（逗号会把 data URI 拆坏）', () => {
    const value = 'data:image/png;base64,AA,BB 1x, a.png 2x'
    expect(mapSrcset(value, () => 'X')).toBe(value)
    expect(collectSrcsetRefs(value)).toEqual([])
  })
})
