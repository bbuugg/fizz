/**
 * 回归：取消必须在所有执行操作之前，横排靠左、竖排靠上。
 * Footer 是纯渲染函数，直接检查其真实 React 子树，不引入 DOM 测试环境。
 */
import { Children, Fragment, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DialogFooter } from './dialog'
import { AlertDialogAction, AlertDialogCancel, AlertDialogFooter } from './alert-dialog'

function button(id: string, dismiss = false, extra: Record<string, unknown> = {}) {
  return createElement('button', {
    key: id, 'data-action': id,
    ...(dismiss ? { 'data-dialog-dismiss': '' } : {}), ...extra
  }, id)
}

function actions(footer: ReactElement<{ children?: ReactNode }>) {
  return Children.toArray(footer.props.children).filter(isValidElement) as ReactElement<{
    'data-action'?: string
    disabled?: boolean
    onClick?: () => void
    ref?: unknown
  }>[]
}

describe.each([
  { name: 'DialogFooter', render: (children: ReactNode) => DialogFooter({ children }) },
  { name: 'AlertDialogFooter', render: (children: ReactNode) => AlertDialogFooter({ children }) }
])('$name · 取消固定最前', ({ render }) => {
  it('两按钮：取消在前，确认在后', () => {
    expect(actions(render([button('confirm'), button('cancel', true)])).map((c) => c.props['data-action']))
      .toEqual(['cancel', 'confirm'])
  })

  it('三按钮：取消原本在中间也要移到最前，其他动作相对顺序不变', () => {
    expect(actions(render([button('close'), button('cancel', true), button('stop')])).map((c) => c.props['data-action']))
      .toEqual(['cancel', 'close', 'stop'])
  })

  it('按语义而非按钮文案、ghost 样式或禁用状态识别取消', () => {
    expect(actions(render([
      button('leave', true, { disabled: true }),
      button('preview', false, { variant: 'ghost' }), button('save')
    ])).map((c) => c.props['data-action'])).toEqual(['leave', 'preview', 'save'])
  })

  it('片段与条件子项不会让取消留在后面', () => {
    const children = [
      createElement(Fragment, { key: 'group' }, button('save'), false, button('cancel', true)),
      null, button('other')
    ]
    expect(actions(render(children)).map((c) => c.props['data-action']))
      .toEqual(['cancel', 'save', 'other'])
  })

  it('移动后保留原来的点击处理、ref 和 disabled，不重写操作含义', () => {
    const onClick = vi.fn()
    const ref = { current: null }
    const cancel = actions(render([button('confirm'), button('cancel', true, { onClick, ref, disabled: true })])).at(0)!
    expect(cancel.props.ref).toBe(ref)
    expect(cancel.props.disabled).toBe(true)
    cancel.props.onClick?.()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('没有取消时，不改变按钮、提示文字的相对顺序', () => {
    const footer = render(['提示', button('preview'), button('confirm')])
    expect(Children.toArray(footer.props.children).map((c) => isValidElement(c) ? (c.props as { 'data-action': string })['data-action'] : c))
      .toEqual(['提示', 'preview', 'confirm'])
  })
})

it('原生 AlertDialogCancel 不需要调用方额外标记也会排在最前', () => {
  const footer = AlertDialogFooter({ children: [
    createElement(AlertDialogAction, { key: 'confirm' }, '确认'),
    createElement(AlertDialogCancel, { key: 'cancel' }, '取消')
  ] })
  expect(actions(footer).map((c) => c.type)).toEqual([AlertDialogCancel, AlertDialogAction])
})
