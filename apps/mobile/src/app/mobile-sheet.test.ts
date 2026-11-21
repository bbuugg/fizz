/** 回归：手机版底部动作顺序与桌面一致（取消在最前），同时保留取消按钮升为 outline 的适配。 */
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { Button } from '@fizz/ui/button'
import { SheetFooter } from './mobile-sheet'

const dismiss = { 'data-dialog-dismiss': '' }

function actions(children: ReactNode) {
  const footer = SheetFooter({ children })
  return Children.toArray(footer.props.children).filter(isValidElement) as ReactElement<{
    children: string
    variant?: string
    disabled?: boolean
  }>[]
}

describe('SheetFooter · 取消在最前', () => {
  it('两按钮按取消、保存排列，取消仍保留 outline 外观', () => {
    const buttons = actions([
      createElement(Button, { key: 'save' }, '保存'),
      createElement(Button, { key: 'cancel', ...dismiss, variant: 'ghost', disabled: true }, '取消'),
    ])
    expect(buttons.map((b) => b.props.children)).toEqual(['取消', '保存'])
    expect(buttons[0].props.variant).toBe('outline')
    expect(buttons[0].props.disabled).toBe(true)
  })

  it('三按钮的取消即使原来位于中间，也固定到竖排最上面', () => {
    const buttons = actions([
      createElement(Button, { key: 'close', variant: 'outline' }, '仅关闭标签'),
      createElement(Button, { key: 'cancel', ...dismiss, variant: 'ghost' }, '取消'),
      createElement(Button, { key: 'stop', variant: 'destructive' }, '停止并关闭'),
    ])
    expect(buttons.map((b) => b.props.children)).toEqual(['取消', '仅关闭标签', '停止并关闭'])
  })
})
