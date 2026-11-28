"use client"

import * as React from "react"
import { cn } from "cn"

/**
 * 固定宽高比的外框。
 *
 * Base UI 没有 AspectRatio 原语：Radix 那层是「padding-bottom 撑高度 + 内部绝对定位」的
 * 老写法，现在直接用 CSS `aspect-ratio` 就行 —— 子元素按正常流填进来即可。
 */
function AspectRatio({
  ratio = 1,
  className,
  style,
  ...props
}: React.ComponentProps<"div"> & {
  /** 宽 / 高，例如 `16 / 9` */
  ratio?: number
}) {
  return (
    <div
      data-slot="aspect-ratio"
      className={cn("w-full", className)}
      style={{ aspectRatio: String(ratio), ...style }}
      {...props}
    />
  )
}

export { AspectRatio }
