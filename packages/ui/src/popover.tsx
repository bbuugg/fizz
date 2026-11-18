import * as React from "react"
import { cn } from "cn"
import { Popover as PopoverPrimitive } from "radix-ui"
import { useDismissFocusGuard } from "./focus-dismiss"
import { resolveCollisionPadding } from "./safe-area"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ref,
  onPointerDown,
  onPointerDownOutside,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  /**
   * 面板元素本身。**量高度 / 给高度变化加动画**的调用方要它（如 `PickerPanel`）：
   * 那种动画只能在 DOM 节点上做（FLIP），拿不到节点就只能整体重挂载。
   */
  ref?: React.Ref<HTMLDivElement>
}) {
  // 指针关闭不回焦（否则触发器会被 :focus-visible 描成主色边框），见 focus-dismiss.ts
  const dismissFocus = useDismissFocusGuard()
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        {...props}
        ref={ref}
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={resolveCollisionPadding(props.collisionPadding)}
        onPointerDown={(event) => {
          dismissFocus.markPointer()
          onPointerDown?.(event)
        }}
        onPointerDownOutside={(event) => {
          dismissFocus.markPointer()
          onPointerDownOutside?.(event)
        }}
        onCloseAutoFocus={(event) => dismissFocus.closeAutoFocus(event, onCloseAutoFocus)}
        className={cn(
          // 尺寸兜底（窄窗口 / 小屏）：`w-72` 这类固定宽度在窄视窗里会撑出屏幕，
          // 超出的部分不会「溢出窗口」而是被浏览器裁掉 —— 所以宽度封顶视口宽 - 1rem，
          // 高度封顶视口高 - 2rem（超了内部滚）。
          "z-50 flex max-h-[calc(100vh_-_2rem)] w-72 max-w-[calc(100vw_-_1rem)] origin-(--radix-popover-content-transform-origin) flex-col gap-2.5 overflow-y-auto rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
