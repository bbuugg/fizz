/** 防回归：动态档位的名称和值文本必须出现在实际 role=slider 的节点上，而非仅在装饰外壳。 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Slider } from './slider'

describe('Slider 拇指语义', () => {
  it('把调用方提供的名称和档位文本传给真正的滑块拇指', () => {
    const html = renderToStaticMarkup(createElement(Slider, {
      min: 0, max: 2, value: [1],
      thumbProps: { 'aria-label': '思考强度', 'aria-valuetext': '深入' },
    }))
    // Base UI 的拇指是 `<div>` 包一个隐藏的 `<input type="range">`，无障碍属性落在
    // 那个 input 上（原生 range 的隐式 role 就是 slider），所以断言要认 input。
    const input = html.match(/<input[^>]*type="range"[^>]*>/)?.[0]
    expect(input).toBeDefined()
    expect(input).toContain('aria-label="思考强度"')
    expect(input).toContain('aria-valuetext="深入"')
    expect(input).toContain('max="2"')
  })
})
