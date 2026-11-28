"use client"

import * as React from "react"
import { cn } from "cn"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

type SliderProps = Omit<
  React.ComponentProps<typeof SliderPrimitive.Root>,
  "onValueChange" | "onValueCommitted"
> & {
  /**
   * 值变化。**永远是数组**（与 Radix 一致）：Base UI 单拇指时给的是裸 number，
   * 这里统一包回数组，调用点的 `([next]) => …` 不用改。
   */
  onValueChange?: (
    value: number[],
    eventDetails?: SliderPrimitive.Root.ChangeEventDetails
  ) => void
  /** 提交（松手 / 键盘结束）。同样是数组；Base UI 的叫法比 Radix 多一个 `d`。 */
  onValueCommitted?: (
    value: number[],
    eventDetails?: SliderPrimitive.Root.CommitEventDetails
  ) => void
  trackClassName?: string
  rangeClassName?: string
  rangeStyle?: React.CSSProperties
  thumbClassName?: string
  /** 语义应落在真正 role=slider 的拇指上，不能只标注外层 Root。 */
  thumbProps?: Pick<
    SliderPrimitive.Thumb.Props,
    "aria-label" | "aria-valuetext"
  >
}

/**
 * 滑条。
 *
 * Base UI 的结构是 `Root > Control > Track > (Indicator, Thumb)`，比 Radix 多一层
 * `Control`（真正吃指针事件的拖拽面），Radix 的 `Range` 改叫 `Indicator`
 * 且填充宽度由原语自己写行内 style —— 不要再手写 `absolute` + 宽度。
 *
 * `thumbAlignment="edge"`：Radix 一直是「拇指贴着轨道两端」的观感，Base UI 默认
 * 是中心对齐（拇指会探出轨道半个身位）。
 */
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
  onValueChange,
  onValueCommitted,
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
      thumbAlignment="edge"
      onValueChange={(next, eventDetails) =>
        onValueChange?.(Array.isArray(next) ? [...next] : [next], eventDetails)
      }
      onValueCommitted={(next, eventDetails) =>
        onValueCommitted?.(
          Array.isArray(next) ? [...next] : [next],
          eventDetails
        )
      }
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full items-center data-vertical:h-full data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn(
            // 不能 `overflow-hidden`：拇指已经挪进 Track 里了，裁掉就只剩半个身子
            "relative grow rounded-full bg-muted data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1",
            trackClassName
          )}
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className={cn(
              "rounded-full bg-primary select-none",
              rangeClassName
            )}
            style={rangeStyle}
          />
          {Array.from({ length: _values.length }, (_, index) => (
            <SliderPrimitive.Thumb
              {...thumbProps}
              index={index}
              data-slot="slider-thumb"
              key={index}
              className={cn(
                "relative block size-3 shrink-0 rounded-full border border-ring bg-white ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 data-disabled:pointer-events-none data-disabled:opacity-50",
                thumbClassName
              )}
            />
          ))}
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
