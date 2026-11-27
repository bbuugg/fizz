"use client"

import * as React from "react"
import { cn } from "cn"
import { Slider as SliderPrimitive } from "radix-ui"

type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  trackClassName?: string
  rangeClassName?: string
  rangeStyle?: React.CSSProperties
  thumbClassName?: string
  /** 语义应落在真正 role=slider 的拇指上，不能只标注外层 Root。 */
  thumbProps?: Pick<React.ComponentProps<typeof SliderPrimitive.Thumb>, "aria-label" | "aria-valuetext">
}

function Slider({
  className,
  trackClassName,
  rangeClassName,
  rangeStyle,
  thumbClassName,
  thumbProps,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: SliderProps) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max]
  )

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "relative grow overflow-hidden rounded-full bg-muted data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1",
          trackClassName
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "absolute bg-primary select-none data-horizontal:h-full data-vertical:w-full",
            rangeClassName
          )}
          style={rangeStyle}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          {...thumbProps}
          data-slot="slider-thumb"
          key={index}
          className={cn(
            "relative block size-3 shrink-0 rounded-full border border-ring bg-white ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50",
            thumbClassName
          )}
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
