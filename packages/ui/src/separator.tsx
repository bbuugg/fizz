import * as React from "react"
import { cn } from "cn"
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

/**
 * 分隔线。
 *
 * Base UI 的 Separator 是单部件（直接可调用），**没有 `decorative`**：它永远带
 * `role="separator"`。纯装饰性的横线请用 `<div aria-hidden>` 或边框，不要再指望这个属性。
 */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
