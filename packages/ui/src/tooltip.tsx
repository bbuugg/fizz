import * as React from "react"
import { useSyncExternalStore } from "react"
import { cn } from "cn"
import { resolveCollisionPadding } from "./safe-area"
import { Tooltip as TooltipPrimitive } from "radix-ui"

/**
 * 触屏设备上**不启用 Tooltip**。
 *
 * 手机 / 平板没有真正的悬停：第一次点按会先让提示出现（或把元素带进 hover 态），
 * 用户必须再点一次才落到按钮上，表现为「每个图标按钮都要点两下」。提示在触屏上本来就
 * 没有「悬停查看」的语义，留着只会挡路，所以这一层直接跳过 Radix 的 Trigger / Content：
 * 按钮照常渲染、照常点击，只是不再有气泡。
 *
 * 用 `useSyncExternalStore` 而不是 effect + state：首帧就要定下来，否则触屏上会先挂上
 * Radix Trigger、effect 跑完再拆掉，第一次点按仍可能被吃掉。
 */
const TOUCH_QUERY = "(hover: none), (pointer: coarse)"

function subscribeTouchQuery(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const mql = window.matchMedia(TOUCH_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function isTouchUi(): boolean {
  return typeof window !== "undefined" && window.matchMedia(TOUCH_QUERY).matches
}

function useTouchUi(): boolean {
  return useSyncExternalStore(subscribeTouchQuery, isTouchUi, () => false)
}

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

/**
 * 气泡只做视觉提示，**不参与指针命中**：
 *
 * - `disableHoverableContent`：默认打开。关掉 Radix 的「grace area」——指针离开触发器后
 *   不再为了能滑进气泡而把旧气泡多留一会儿。密集按钮行里气泡常压着隔壁按钮，留着
 *   grace area 会表现为「旧提示挂着不走，隔壁按钮的提示同时冒出来」。
 * - `pointer-events-none`（加在 `TooltipContent` 上）：气泡覆盖到哪个按钮，悬停 / 点击
 *   就穿透到哪个按钮，不会再出现「提示挡住下一颗按钮、鼠标指不过去」。
 *
 * 代价是鼠标不能移进气泡（悬停即关闭）、气泡文字不可选中；本项目气泡全是一行标签，
 * 没有可交互内容，所以是可以接受的取舍。
 */
function Tooltip({
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

function TooltipTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const touch = useTouchUi()
  if (touch) {
    // `asChild` 是绝大多数用法：直接把子元素还回去，不套 Radix 的事件处理器。
    if (asChild) return children as React.ReactElement
    return (
      <button type="button" data-slot="tooltip-trigger" {...props}>
        {children}
      </button>
    )
  }
  return (
    <TooltipPrimitive.Trigger data-slot="tooltip-trigger" asChild={asChild} {...props}>
      {children}
    </TooltipPrimitive.Trigger>
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const touch = useTouchUi()
  if (touch) return null
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={resolveCollisionPadding(props.collisionPadding)}
        className={cn(
          "pointer-events-none z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
