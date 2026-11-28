import * as React from "react"
import { cn } from "cn"

/**
 * 表单标签。
 *
 * Base UI 没有独立 Label 原语（`Field.Label` 只在它自己的 `Field.Root` 里成立），所以这里
 * 落成原生 `<label>`：Radix 那点额外行为（双击不选中文字）由 `select-none` 承担。
 */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
