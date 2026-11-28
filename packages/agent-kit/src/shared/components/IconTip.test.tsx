/**
 * `IconTip` 与「自带状态属性的控件」的相容性。
 *
 * ## 这条测试在防什么
 *
 * Radix 时代有个真实的坑（用户报的「定时任务详情里那颗启停开关看不见，只有悬停才冒
 * tooltip」）：`TooltipTrigger asChild` 会往子元素注 `data-state="closed"`，而 Radix 的
 * `Switch` 恰恰靠 `data-state="checked"` 决定轨道颜色，且它把外部 props 排在自带的
 * `data-state` **之后** —— tooltip 那个值把 checked 盖掉，`data-checked:` 规则全失效。
 * 当时的结论是「必须包一层 `<span>` 当触发器」。
 *
 * 迁到 Base UI 之后这个坑消失了：`TooltipTrigger` 用 `render` 合并 props，只额外注
 * `data-slot="tooltip-trigger"` / `data-base-ui-tooltip-trigger`，**不再写 `data-state`**；
 * `Switch` 的状态是 presence 属性 `data-checked`，两者互不覆盖。
 *
 * 所以现在钉住三件事：
 * 1. 裸开关的根节点带 `data-checked`（基准）；
 * 2. **直接套 IconTip 也安全**（不需要再包 span）；
 * 3. 包一层 span 仍然安全（老写法不做废）。
 *
 * 用 `react-dom/server` 的静态渲染就够 —— 要验的是属性合并的结果，不需要 DOM 环境
 * （本仓没有 jsdom，见 AGENTS.md 的测试一节）。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { Switch } from '@fizz/ui/switch'
import { TooltipProvider } from '@fizz/ui/tooltip'
import { IconTip } from './IconTip'

const noop = (): void => {}

/** Tooltip 必须在 Provider 里（应用里由外壳挂），测试里自己包一层 */
const render = (node: ReactNode): string =>
  renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)

/**
 * 取「开关根节点」那个标签的原文。
 *
 * ⚠️ 不能直接对整段 HTML 找 `data-checked`：拇指（`switch-thumb`）**永远**带着它，
 * 那样断言会永远为真、测不出问题。
 */
function rootTag(html: string): string {
  const match = html.match(/<[a-z]+[^>]*role="switch"[^>]*>/)
  expect(match).not.toBeNull()
  return match![0]
}

describe('IconTip 与自带状态属性的控件', () => {
  it('裸 Switch 的根节点是 checked（基准）', () => {
    const root = rootTag(render(<Switch checked onCheckedChange={noop} />))
    expect(root).toContain('data-checked')
    expect(root).toContain('data-checked:bg-primary')
  })

  it('直接套在 IconTip 上，开关的 checked 不会被 tooltip 抢走', () => {
    const html = render(
      <IconTip label="停用">
        <Switch checked onCheckedChange={noop} />
      </IconTip>
    )
    const root = rootTag(html)
    // 合并生效：触发器标记与状态属性同时存在，且没有 Radix 那个 `data-state`
    expect(root).toContain('data-slot="tooltip-trigger"')
    expect(root).toContain('data-checked')
    expect(root).not.toContain('data-state=')
  })

  it('包一层 span 当触发器时，Switch 根节点也保住 checked', () => {
    const html = render(
      <IconTip label="停用">
        <span className="inline-flex items-center">
          <Switch checked onCheckedChange={noop} />
        </span>
      </IconTip>
    )
    expect(rootTag(html)).toContain('data-checked')
  })
})
