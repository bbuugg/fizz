"use client"

import * as React from "react"
import { useSyncExternalStore } from "react"
import { cn } from "cn"
import { resolveCollisionPadding } from "./safe-area"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { asChildSlot } from "./polymorphic"

/**
 * 触屏设备上**不启用 Tooltip**。
 *
 * 手机 / 平板没有真正的悬停：第一次点按会先让提示出现（或把元素带进 hover 态），
 * 用户必须再点一次才落到按钮上，表现为「每个图标按钮都要点两下」。提示在触屏上本来就
 * 没有「悬停查看」的语义，留着只会挡路，所以这一层直接跳过 Trigger / Popup：
 * 按钮照常渲染、照常点击，只是不再有气泡。
 *
 * 用 `useSyncExternalStore` 而不是 effect + state：首帧就要定下来，否则触屏上会先挂上
 * Trigger、effect 跑完再拆掉，第一次点按仍可能被吃掉。
 *
 * 极少数列表确实需要「触屏也能看提示」（模型清单的完整 id），这些地方在 Tooltip 根上
 * 传 `allowTouch` 显式放行 —— 默认仍然禁用，不能全局打开，否则又回到「每个图标点两下」。
 */
const AllowTouchTooltipContext = React.createContext(false)

/**
 * 打开延迟。
 *
 * Base UI 把延迟从 Root 挪到了 **Trigger**（`delay`），而本仓调用点仍习惯写在
 * `<Tooltip delayDuration={…}>` 上。这里用一层 context 把它送到 Trigger。
 */
const TooltipDelayContext = React.createContext<number | undefined>(undefined)

const TOUCH_QUERY = "(hover: none), (pointer: coarse)"

function subscribeTouchQuery(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const mql = window.matchMedia(TOUCH_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function isTouchUi(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia(TOUCH_QUERY).matches
}

function useTouchUi(): boolean {
  return useSyncExternalStore(subscribeTouchQuery, isTouchUi, () => false)
}

function TooltipProvider({
  delayDuration = 0,
  ...props
}: TooltipPrimitive.Provider.Props & {
  /** Radix 的叫法，Base UI 叫 `delay` */
  delayDuration?: number
}) {
  const { delay, ...rest } = props as TooltipPrimitive.Provider.Props
  return (
    <TooltipPrimitive.Provider
      delay={delay ?? delayDuration}
      {...rest}
    />
  )
}

/**
 * 气泡只做视觉提示，**不参与指针命中**：
 *
 * - `disableHoverablePopup`：默认打开。关掉「grace area」——指针离开触发器后
 *   不再为了能滑进气泡而把旧气泡多留一会儿。密集按钮行里气泡常压着隔壁按钮，留着
 *   grace area 会表现为「旧提示挂着不走，隔壁按钮的提示同时冒出来」。
 * - `pointer-events-none`（加在 `TooltipContent` 上）：气泡覆盖到哪个按钮，悬停 / 点击
 *   就穿透到哪个按钮。
 *
 * 代价是鼠标不能移进气泡（悬停即关闭）、气泡文字不可选中；本项目气泡全是一行标签，
 * 没有可交互内容，所以是可以接受的取舍。
 */
function Tooltip({
  disableHoverableContent = true,
  delayDuration,
  allowTouch = false,
  children,
  ...props
}: TooltipPrimitive.Root.Props & {
  /** Radix 的叫法，Base UI 叫 `disableHoverablePopup` */
  disableHoverableContent?: boolean
  /** Radix 写在 Root 上的打开延迟；Base UI 在 Trigger 上，这里用 context 转过去 */
  delayDuration?: number
  allowTouch?: boolean
}) {
  return (
    <AllowTouchTooltipContext.Provider value={allowTouch}>
      <TooltipDelayContext.Provider value={delayDuration}>
        <TooltipPrimitive.Root
          data-slot="tooltip"
          disableHoverablePopup={disableHoverableContent}
          {...props}
        >
          {children}
        </TooltipPrimitive.Root>
      </TooltipDelayContext.Provider>
    </AllowTouchTooltipContext.Provider>
  )
}

function TooltipTrigger({
  asChild,
  children,
  delay,
  onFocus,
  ...props
}: TooltipPrimitive.Trigger.Props & { asChild?: boolean }) {
  const delayFromRoot = React.useContext(TooltipDelayContext)
  const touch = useTouchUi() && !React.useContext(AllowTouchTooltipContext)
  if (touch) {
    // `asChild` 是绝大多数用法：直接把子元素还回去，不套任何事件处理器。
    if (asChild) return children as React.ReactElement
    const buttonProps = props as React.ComponentProps<"button">
    return (
      <button type="button" data-slot="tooltip-trigger" {...buttonProps}>
        {children}
      </button>
    )
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...asChildSlot(asChild, children)}
      delay={delay ?? delayFromRoot}
      /*
       * 只有**键盘**（`:focus-visible`）才按焦点弹提示。
       *
       * 菜单 / 选择器 / 弹窗关闭时会把焦点还给自己的触发器 —— 指针关闭那一下是
       * **程序化回焦**，不该再弹一条提示，否则表现就是「菜单关掉了、提示又冒出来」。
       *
       * ⚠️ 这是 Radix 时代靠 `preventDefault()` 拦住打开逻辑的做法；Base UI 的
       * Trigger 不一定尊重这次 preventDefault，运行时可能仍会闪一条 —— 见迁移报告里
       * tooltip 的「Behavior changes」。
       */
      onFocus={(event) => {
        onFocus?.(event)
        if (!event.defaultPrevented && !event.currentTarget.matches(":focus-visible")) {
          event.preventDefault()
        }
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  side,
  sideOffset = 0,
  align,
  alignOffset,
  collisionPadding,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "side" | "align" | "alignOffset" | "sideOffset" | "collisionPadding"
  >) {
  const touch = useTouchUi() && !React.useContext(AllowTouchTooltipContext)
  if (touch) return null
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        collisionPadding={resolveCollisionPadding(collisionPadding)}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "pointer-events-none z-50 w-fit origin-(--transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 rotate-45 rounded-[2px] bg-foreground fill-foreground" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
