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
    const thumb = html.match(/<[^>]+role="slider"[^>]*>/)?.[0]
    expect(thumb).toBeDefined()
    expect(thumb).toContain('aria-label="思考强度"')
    expect(thumb).toContain('aria-valuetext="深入"')
    expect(thumb).toContain('aria-valuemax="2"')
  })
})
