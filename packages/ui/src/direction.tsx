"use client"

import * as React from "react"
import {
  DirectionProvider as DirectionProviderPrimitive,
  useDirection,
} from "@base-ui/react/direction-provider"

/**
 * 文本方向。
 *
 * Base UI 的 prop 叫 `direction`（不是 Radix 的 `dir`）。导航菜单 / 菜单 / 选择器等
 * 原语里那一堆 `dir` 属性都已经被移除，方向只从这里读（或祖先 DOM 的 `dir`）。
 */
function DirectionProvider({
  dir,
  direction,
  children,
}: {
  dir?: "ltr" | "rtl"
  direction?: "ltr" | "rtl"
  children?: React.ReactNode
}) {
  return (
    <DirectionProviderPrimitive direction={direction ?? dir}>
      {children}
    </DirectionProviderPrimitive>
  )
}

export { DirectionProvider, useDirection }
