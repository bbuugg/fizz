"use client"

import * as React from "react"
import { cn } from "cn"
import { resolveCollisionPadding } from "./safe-area"
import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card"
import { asChildSlot } from "./polymorphic"

/**
 * 悬停延迟。
 *
 * Base UI 把 `openDelay` / `closeDelay` 从 Root 挪到了 **Trigger**（`delay` /
 * `closeDelay`），而调用点仍习惯写在 `<HoverCard openDelay={…}>` 上。这里用一层
 * context 转过去。
 */
const HoverCardDelayContext = React.createContext<{
  openDelay?: number
  closeDelay?: number
}>({})

/** Base UI 里 Radix 的 `HoverCard` 叫 `PreviewCard`，导出的名字保持不变。 */
function HoverCard({
  openDelay,
  closeDelay,
  children,
  ...props
}: PreviewCardPrimitive.Root.Props & {
  /** Radix 写在 Root 上的打开延迟（Base UI 在 Trigger 上） */
  openDelay?: number
  /** Radix 写在 Root 上的关闭延迟（Base UI 在 Trigger 上） */
  closeDelay?: number
}) {
  return (
    <HoverCardDelayContext.Provider value={{ openDelay, closeDelay }}>
      <PreviewCardPrimitive.Root data-slot="hover-card" {...props}>
        {children}
      </PreviewCardPrimitive.Root>
    </HoverCardDelayContext.Provider>
  )
}

function HoverCardTrigger({
  asChild,
  children,
  delay,
  closeDelay,
  ...props
}: PreviewCardPrimitive.Trigger.Props & { asChild?: boolean }) {
  const fromRoot = React.useContext(HoverCardDelayContext)
  return (
    <PreviewCardPrimitive.Trigger
      data-slot="hover-card-trigger"
      {...asChildSlot(asChild, children)}
      delay={delay ?? fromRoot.openDelay}
      closeDelay={closeDelay ?? fromRoot.closeDelay}
      {...props}
    />
  )
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  side,
  alignOffset,
  collisionPadding,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<
    PreviewCardPrimitive.Positioner.Props,
    "side" | "align" | "alignOffset" | "sideOffset" | "collisionPadding"
  >) {
  return (
    <PreviewCardPrimitive.Portal data-slot="hover-card-portal">
      <PreviewCardPrimitive.Positioner
        side={side}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        collisionPadding={resolveCollisionPadding(collisionPadding)}
        className="isolate z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            "z-50 w-64 origin-(--transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            className
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
