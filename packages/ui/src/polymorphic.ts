"use client"

import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

/**
 * Radix `asChild` 在 Base UI 里的等价实现（内部工具，不对外导出）。
 *
 * Base UI 没有 `Slot`：替换元素走各部件自己的 `render` prop。本仓的调用点有 150+ 处
 * 用的是 `asChild`，为了不在业务代码里做机械 rewrite，这里把两者接起来：
 *
 * - `asChild` 且子节点是**单个合法 React 元素** → 把子元素交给 `render`，props 合并上去
 *   （className 拼接、style 合并、事件处理器依次调用，交给 base-ui 的 `mergeProps`）；
 * - 其余情况 → 老老实实渲染 `defaultTagName`。
 *
 * ⚠️ 只给「本身不是 Base UI 部件」的普通元素（Badge / Item / Marker / 气泡内容…）用。
 * Base UI 自带的部件（Button / Trigger / Close…）自己有 `render`，直接传就行。
 */
export function usePolymorphic(
  defaultTagName: keyof React.JSX.IntrinsicElements,
  asChild: boolean | undefined,
  children: React.ReactNode,
  props: Record<string, unknown>
): React.ReactElement {
  const { ref, ...rest } = props
  const target =
    asChild && React.isValidElement(children) ? children : undefined

  return useRender({
    defaultTagName,
    render: target,
    ref: ref as React.Ref<Element> | undefined,
    props: mergeProps(
      rest as Record<string, unknown>,
      target ? {} : { children }
    ) as Record<string, unknown>,
  })
}

/**
 * 给 **Base UI 部件**（自带 `render`）用的 `asChild` 兼容层：直接展开到部件上。
 *
 * ```tsx
 * <DialogPrimitive.Close data-slot="dialog-close" {...asChildSlot(asChild, children)} {...props} />
 * ```
 *
 * `nativeButton` 只在能确定标签时给：`<button>` → true、`<a>` → false，
 * 自定义组件（如本仓的 `Button`，最终仍是 `<button>`）留空走默认值。
 */
export function asChildSlot(
  asChild: boolean | undefined,
  children: React.ReactNode
): {
  render?: React.ReactElement
  children?: React.ReactNode
  nativeButton?: boolean
} {
  const target =
    asChild && React.isValidElement(children) ? children : undefined
  if (!target) return { children }
  const type = target.type
  const nativeButton =
    type === "button" ? true : type === "a" ? false : undefined
  return { render: target, children: undefined, nativeButton }
}
