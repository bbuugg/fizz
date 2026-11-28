import * as React from "react"
import { cn } from "cn"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { resolveCollisionPadding } from "./safe-area"
import { asChildSlot, usePolymorphic } from "./polymorphic"

/**
 * 锚点元素。
 *
 * Base UI 没有 `Anchor` 部件：没有 Trigger 时用 Positioner 的 `anchor` prop（元素 / ref /
 * 函数）。这里把子元素登记到 Root 的 ref 上，Content 再交给 Positioner。
 */
const PopoverAnchorContext = React.createContext<React.RefObject<Element | null> | null>(
  null
)

function Popover({
  children,
  ...props
}: PopoverPrimitive.Root.Props) {
  const anchorRef = React.useRef<Element | null>(null)
  return (
    <PopoverAnchorContext.Provider value={anchorRef}>
      <PopoverPrimitive.Root data-slot="popover" {...props}>
        {children}
      </PopoverPrimitive.Root>
    </PopoverAnchorContext.Provider>
  )
}

function PopoverTrigger({
  asChild,
  children,
  ...props
}: PopoverPrimitive.Trigger.Props & { asChild?: boolean }) {
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      {...asChildSlot(asChild, children)}
      {...props}
    />
  )
}

type PopoverPositionerProps = Pick<
  PopoverPrimitive.Positioner.Props,
  | "side"
  | "align"
  | "alignOffset"
  | "sideOffset"
  | "collisionPadding"
  | "collisionBoundary"
  | "collisionAvoidance"
  | "anchor"
>

function PopoverContent({
  className,
  side,
  align = "center",
  alignOffset,
  sideOffset = 4,
  collisionPadding,
  collisionBoundary,
  collisionAvoidance,
  anchor,
  ref,
  ...props
}: PopoverPrimitive.Popup.Props &
  PopoverPositionerProps & {
    /**
     * 面板元素本身。**量高度 / 给高度变化加动画**的调用方要它（如 `PickerPanel`）：
     * 那种动画只能在 DOM 节点上做（FLIP），拿不到节点就只能整体重挂载。
     */
    ref?: React.Ref<HTMLDivElement>
  }) {
  const anchorRef = React.useContext(PopoverAnchorContext)

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        collisionPadding={resolveCollisionPadding(collisionPadding)}
        collisionBoundary={collisionBoundary}
        collisionAvoidance={collisionAvoidance}
        anchor={anchor ?? anchorRef ?? undefined}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          {...props}
          ref={ref}
          data-slot="popover-content"
          /*
           * 指针关闭不回焦（否则触发器会被 :focus-visible 描成主色边框）。
           * Base UI 把「关闭时要不要回焦」收成一个 `finalFocus` 回调，参数是交互类型：
           * 键盘关（Esc / Tab）照旧回焦，鼠标 / 触摸关就不动焦点。
           */
          finalFocus={(closeType) => closeType === "keyboard"}
          className={cn(
            // 尺寸兜底（窄窗口 / 小屏）：`w-72` 这类固定宽度在窄视窗里会撑出屏幕，
            // 超出的部分不会「溢出窗口」而是被浏览器裁掉 —— 所以宽度封顶视口宽 - 1rem，
            // 高度封顶视口高 - 2rem（超了内部滚）。
            "z-50 flex max-h-[calc(100vh_-_2rem)] w-72 max-w-[calc(100vw_-_1rem)] origin-(--transform-origin) flex-col gap-2.5 overflow-y-auto rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  asChild,
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const anchorRef = React.useContext(PopoverAnchorContext)
  return usePolymorphic("div", asChild, children, {
    ref: anchorRef ?? undefined,
    "data-slot": "popover-anchor",
    className,
    ...props,
  })
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
