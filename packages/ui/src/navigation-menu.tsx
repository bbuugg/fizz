import * as React from "react"
import { cva } from "class-variance-authority"
import { cn } from "cn"
import { NavigationMenu as NavigationMenuPrimitive } from "@base-ui/react/navigation-menu"
import { ChevronDownIcon } from "lucide-react"
import { asChildSlot } from "./polymorphic"

/**
 * 导航菜单。
 *
 * ⚠️ 结构变化最大的一支：Radix 的 `Viewport` 是挂在 Root 上、由 Root 自己量宽高的
 * 一块**共享面板**；Base UI 的弹层模型是真正的锚定定位 ——
 * `Portal > Positioner > Popup > Viewport`，每个 `Content` 在被激活时被搬进 `Viewport`。
 * `viewport` 布尔值因此没有对应物（保留入参只为调用点不用改）。
 */
function NavigationMenu({
  className,
  children,
  viewport = true,
  ...props
}: NavigationMenuPrimitive.Root.Props & {
  /** @deprecated Base UI 没有这个开关，恒为「有共享面板」；传 false 也不会变 */
  viewport?: boolean
}) {
  return (
    <NavigationMenuPrimitive.Root
      data-slot="navigation-menu"
      data-viewport={viewport}
      className={cn(
        "group/navigation-menu relative flex max-w-max flex-1 items-center justify-center",
        className
      )}
      {...props}
    >
      {children}
      {viewport && <NavigationMenuViewport />}
    </NavigationMenuPrimitive.Root>
  )
}

function NavigationMenuList({
  className,
  ...props
}: NavigationMenuPrimitive.List.Props) {
  return (
    <NavigationMenuPrimitive.List
      data-slot="navigation-menu-list"
      className={cn(
        "group flex flex-1 list-none items-center justify-center gap-0",
        className
      )}
      {...props}
    />
  )
}

function NavigationMenuItem({
  className,
  ...props
}: NavigationMenuPrimitive.Item.Props) {
  return (
    <NavigationMenuPrimitive.Item
      data-slot="navigation-menu-item"
      className={cn("relative", className)}
      {...props}
    />
  )
}

const navigationMenuTriggerStyle = cva(
  "group/navigation-menu-trigger inline-flex h-8 w-max items-center justify-center rounded-lg px-2.5 py-1.5 text-sm font-medium transition-all outline-none hover:bg-muted focus:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-muted/50 data-popup-open:hover:bg-muted data-popup-open:focus:bg-muted"
)

function NavigationMenuTrigger({
  className,
  children,
  ...props
}: NavigationMenuPrimitive.Trigger.Props) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn(navigationMenuTriggerStyle(), "group", className)}
      {...props}
    >
      {children}{" "}
      <ChevronDownIcon
        className="relative top-px ml-1 size-3 transition duration-300 group-data-popup-open/navigation-menu-trigger:rotate-180"
        aria-hidden="true"
      />
    </NavigationMenuPrimitive.Trigger>
  )
}

function NavigationMenuContent({
  className,
  ...props
}: NavigationMenuPrimitive.Content.Props) {
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn(
        // 进出场方向：Radix 的 `data-motion=from-start/to-end…` 换成了
        // `data-activation-direction=left|right|up|down`（新激活的触发器相对上一个的方向）。
        "top-0 left-0 w-full p-1 ease-[cubic-bezier(0.22,1,0.36,1)] data-[activation-direction=left]:slide-in-from-right-52 data-[activation-direction=right]:slide-in-from-left-52 **:data-[slot=navigation-menu-link]:focus:ring-0 **:data-[slot=navigation-menu-link]:focus:outline-none md:absolute md:w-auto",
        className
      )}
      {...props}
    />
  )
}

/**
 * 共享面板：`Portal > Positioner > Popup > Viewport`。
 *
 * 名字沿用 `NavigationMenuViewport`，但它现在**必须**和 `Content` 同处一棵树
 *（`Content` 会被 Base UI 搬进这里的 `Viewport`），不能再当成一个独立浮层随意摆放。
 */
function NavigationMenuViewport({
  className,
  ...props
}: NavigationMenuPrimitive.Viewport.Props) {
  return (
    <NavigationMenuPrimitive.Portal>
      <NavigationMenuPrimitive.Positioner
        sideOffset={6}
        className="isolate z-50 flex justify-center"
      >
        <NavigationMenuPrimitive.Popup
          className="origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:zoom-in-90 data-closed:animate-out data-closed:zoom-out-90"
        >
          <NavigationMenuPrimitive.Viewport
            data-slot="navigation-menu-viewport"
            className={cn(
              // 高度 / 宽度改读 Popup 上的 `--popup-height` / `--popup-width`
              //（Radix 是 `--radix-navigation-menu-viewport-*`）。
              "relative h-(--popup-height) w-(--popup-width) overflow-hidden",
              className
            )}
            {...props}
          />
        </NavigationMenuPrimitive.Popup>
      </NavigationMenuPrimitive.Positioner>
    </NavigationMenuPrimitive.Portal>
  )
}

function NavigationMenuLink({
  asChild,
  children,
  className,
  ...props
}: NavigationMenuPrimitive.Link.Props & { asChild?: boolean }) {
  return (
    <NavigationMenuPrimitive.Link
      data-slot="navigation-menu-link"
      {...asChildSlot(asChild, children)}
      className={cn(
        "flex items-center gap-2 rounded-lg p-2 text-sm transition-all outline-none hover:bg-muted focus:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1 in-data-[slot=navigation-menu-content]:rounded-md data-active:bg-muted/50 data-active:hover:bg-muted data-active:focus:bg-muted [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

/**
 * 触发器上的小箭头。
 *
 * ⚠️ 语义与 Radix 的 `Indicator` **不同**：Radix 那颗会跟着当前激活的触发器在列表下方
 * 滑动；Base UI 的 `Icon` 只是 Trigger 内部的一枚图标（`data-popup-open` 时高亮）。
 * 没有「跟随激活项滑动」的对应部件 —— 需要那个视觉就用 Popup 里的 `Arrow`。
 */
function NavigationMenuIndicator({
  className,
  ...props
}: NavigationMenuPrimitive.Icon.Props) {
  return (
    <NavigationMenuPrimitive.Icon
      data-slot="navigation-menu-indicator"
      className={cn(
        "top-full z-1 flex h-1.5 items-end justify-center overflow-hidden",
        className
      )}
      {...props}
    >
      <div className="relative top-[60%] h-2 w-2 rotate-45 rounded-tl-sm bg-border shadow-md" />
    </NavigationMenuPrimitive.Icon>
  )
}

export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuContent,
  NavigationMenuTrigger,
  NavigationMenuLink,
  NavigationMenuIndicator,
  NavigationMenuViewport,
  navigationMenuTriggerStyle,
}
