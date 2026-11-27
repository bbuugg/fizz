/** 防回归：动态档位不能退回固定八档；拖动只在提交时发送原值，取消 / 禁用 / 卸载不发送；
 * 松手后拇指必须停在刚提交的档位，不能因为 `value` 回灌晚一拍就滑回原档。
 * 使用 Node 服务端渲染和捕获的控件回调，不启动浏览器、不引入 DOM 测试依赖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Slider } from '@fizz/ui/slider'
import type { NativeSelect } from '@fizz/ui/native-select'
import { EffortSlider, shouldResetPreview } from './EffortSlider'
import { ReasoningEffortPanel, reasoningEffortLabel } from './ReasoningEffortPanel'

type SliderProps = ComponentProps<typeof Slider>
const mocks = vi.hoisted(() => ({
  slider: null as SliderProps | null,
  select: null as ComponentProps<typeof NativeSelect> | null,
  effects: [] as Array<() => void | (() => void)>,
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useLayoutEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
}))
vi.mock('gsap', () => ({ gsap: {} }))
vi.mock('@fizz/ui/slider', () => ({ Slider: (props: SliderProps) => {
  mocks.slider = props
  return createElement('span', { role: 'slider', ...props.thumbProps, 'aria-valuemax': props.max })
} }))
vi.mock('@fizz/ui/native-select', async (importOriginal) => {
  const real = await importOriginal<typeof import('@fizz/ui/native-select')>()
  return { ...real, NativeSelect: (props: ComponentProps<typeof NativeSelect>) => {
    mocks.select = props
    return createElement(real.NativeSelect, props)
  } }
})
vi.mock('@fizz/agent-kit/shared/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }))
vi.mock('@fizz/agent-kit/shared/lib/language', () => ({ useT: () => (text: string) => text }))

const levels = [
  { value: 'vendor:eco', label: '节省', description: '较少预算' },
  { value: 'vendor:balanced', label: '平衡' },
  { value: 'vendor:deep', label: '深入' },
]
const pointer = (clientX = 0) => ({
  isPrimary: true, button: 0, pointerId: 1, clientX, timeStamp: clientX + 1,
}) as Parameters<NonNullable<SliderProps['onPointerDownCapture']>>[0]
const key = (name: string) => ({
  key: name, preventDefault: vi.fn(), stopPropagation: vi.fn(),
}) as unknown as Parameters<NonNullable<SliderProps['onKeyDownCapture']>>[0]

function render(patch: Partial<ComponentProps<typeof EffortSlider<string>>> = {}) {
  const onChange = vi.fn<(value: string) => void>()
  const html = renderToStaticMarkup(createElement(EffortSlider<string>, {
    levels, value: levels[0].value, label: '思考强度', unsetLabel: '未选择', onChange, ...patch,
  }))
  return { html, onChange, slider: mocks.slider! }
}

beforeEach(() => { mocks.slider = null; mocks.select = null; mocks.effects = [] })

describe('动态档位滑块', () => {
  it('实际三档对应三个吸附点，沿用名称并给拇指提供值文本', () => {
    const { html, slider } = render({ value: levels[1].value })
    expect(slider.max).toBe(2)
    expect(slider.value).toEqual([1])
    expect(slider.thumbProps).toEqual({ 'aria-label': '思考强度', 'aria-valuetext': '平衡' })
    expect(html).toContain('repeat(3, minmax(0, 1fr))')
    expect(html).not.toContain('grid-cols-8')
    expect(html).not.toContain('最高')
  })

  it('拖动中只预览，松手才发送对应的原始值，重复 commit 不重复请求', () => {
    const { slider, onChange } = render()
    slider.onPointerDownCapture!(pointer())
    slider.onValueChange!([1.8])
    expect(onChange).not.toHaveBeenCalled()
    slider.onPointerUpCapture!(pointer(30))
    // 故意传旧快照；应以最新 previewRef 吸附到第三档。
    slider.onValueCommit!([0])
    slider.onValueCommit!([0])
    expect(onChange.mock.calls).toEqual([['vendor:deep']])
  })

  it('取消手势和卸载后不能提交旧档位', () => {
    const { slider, onChange } = render()
    const cleanup = mocks.effects[0]()
    slider.onPointerDownCapture!(pointer())
    slider.onValueChange!([2])
    slider.onPointerCancel!(pointer())
    slider.onValueCommit!([2])
    expect(onChange).not.toHaveBeenCalled()
    if (cleanup) cleanup()
    slider.onKeyDownCapture!(key('End'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([{ disabled: true }, { busy: true }])('禁用或提交中不会发出变更：%j', (patch) => {
    const { html, slider, onChange } = render(patch)
    expect(slider.disabled).toBe(true)
    expect(html).toContain('disabled=""')
    slider.onPointerDownCapture!(pointer())
    slider.onValueChange!([2])
    slider.onValueCommit!([2])
    slider.onKeyDownCapture!(key('End'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('键盘按离散档位移动，Home / End 按实际数量定位', () => {
    const { slider, onChange } = render()
    for (const name of ['ArrowRight', 'ArrowRight', 'Home', 'End']) slider.onKeyDownCapture!(key(name))
    expect(onChange.mock.calls).toEqual([
      ['vendor:balanced'], ['vendor:deep'], ['vendor:eco'], ['vendor:deep'],
    ])
  })

  it('没有候选项时隐藏，只有一档时只读展示，不产生除零比例', () => {
    expect(render({ levels: [] }).html).toBe('')
    const { html } = render({ levels: levels.slice(0, 1) })
    expect(mocks.slider).toBeNull()
    expect(html).toContain('节省')
    expect(html).not.toMatch(/NaN|Infinity|role="slider"/)
  })

  it('未知当前值显示未选择，不虚构默认档，也不误标第一档已选', () => {
    const { html, slider, onChange } = render({ value: undefined })
    expect(slider.thumbProps?.['aria-valuetext']).toBe('未选择')
    expect(html).not.toContain('aria-pressed="true"')
    slider.onPointerDownCapture!(pointer())
    slider.onValueCommit!([0])
    expect(onChange).toHaveBeenCalledWith('vendor:eco')
  })

  it.each([
    { options: Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `档位 ${i}` })) },
    { options: [{ value: 'long', label: '这是外部 Agent 提供的完整思考档名称' }, levels[1]] },
  ])('多档或长名称保留滑块，用完整选单承载全部候选项', ({ options }) => {
    const { html, slider, onChange } = render({ levels: options, value: options[0].value })
    expect(slider.max).toBe(options.length - 1)
    expect(html).toContain('<select')
    for (const option of options) expect(html).toContain(option.label)
    expect(html).not.toContain('reasoning-effort-stops')
    mocks.select!.onChange!({ target: { value: String(options.length - 1) } } as React.ChangeEvent<HTMLSelectElement>)
    expect(onChange).toHaveBeenCalledWith(options.at(-1)!.value)
  })

  it('模型身份、候选项数量或顺序变化都重建手势实例', () => {
    const props = { levels, value: levels[0].value, label: '强度', unsetLabel: '未选择', onChange: vi.fn(), resetKey: 'model-a' }
    const first = EffortSlider(props)!
    expect(EffortSlider({ ...props, resetKey: 'model-b' })!.key).not.toBe(first.key)
    expect(EffortSlider({ ...props, levels: [...levels].reverse() })!.key).not.toBe(first.key)
    expect(EffortSlider({ ...props, levels: levels.slice(0, 2) })!.key).not.toBe(first.key)
  })
})

describe('松手后的拇指位置', () => {
  it('自己提交的档位回声保留预览，只有外部改值才把预览拉回落库档位', () => {
    const shapes = [{ value: 'a' }, { value: 'b' }, { value: 'c' }]
    // 回声：落库值正是刚提交的那一档 → 保留预览，拇指不回落
    expect(shouldResetPreview({ levels: shapes, value: 'b', submitted: 'b', disabled: false })).toBe(false)
    // 落库值被外部改回旧档（保存失败回退 / 服务端推送）→ 拉回
    expect(shouldResetPreview({ levels: shapes, value: 'a', submitted: 'b', disabled: false })).toBe(true)
    // 生成开始等禁用态 → 拉回
    expect(shouldResetPreview({ levels: shapes, value: 'b', submitted: 'b', disabled: true })).toBe(true)
    // 未设置本身也是合法档位：两边都没设置时不算外部改值
    const withUnset = [{ value: null }, { value: 'b' }]
    expect(shouldResetPreview({ levels: withUnset, value: null, submitted: null, disabled: false })).toBe(false)
    expect(shouldResetPreview({ levels: withUnset, value: null, submitted: 'b', disabled: false })).toBe(true)
  })
})

describe('内置八档兼容', () => {
  it('原八档和值语义不变，provider-default 仍显示默认且默认提交 null', () => {
    const onChange = vi.fn()
    renderToStaticMarkup(createElement(ReasoningEffortPanel, { value: 'high', onChange }))
    const slider = mocks.slider!
    expect(slider.max).toBe(7)
    expect(slider.value).toEqual([5])
    slider.onKeyDownCapture!(key('Home'))
    expect(onChange).toHaveBeenCalledWith(null)
    expect(reasoningEffortLabel('provider-default')).toBe('默认')
    expect(reasoningEffortLabel(undefined)).toBe('默认')
    expect(reasoningEffortLabel('xhigh')).toBe('极高')
  })
})
