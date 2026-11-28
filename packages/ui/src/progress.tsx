import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "@base-ui/react/progress"

/**
 * 进度条。
 *
 * Base UI 的结构是 `Root > Track > Indicator`，**填充宽度由原语自己按百分比写行内 style**，
 * 所以不要再手抄 Radix 那套 `translateX(-(100 - value)%)`。
 */
function Progress({
  className,
  value,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value ?? null}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Track className="h-full w-full">
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="h-full bg-primary transition-all"
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}

export { Progress }
