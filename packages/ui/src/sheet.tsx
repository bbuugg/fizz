import * as React from "react"
import { cn } from "cn"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"

import { Button } from "./button"
import { asChildSlot } from "./polymorphic"
import { XIcon } from "lucide-react"

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({
  asChild,
  children,
  ...props
}: SheetPrimitive.Trigger.Props & { asChild?: boolean }) {
  return (
    <SheetPrimitive.Trigger
      data-slot="sheet-trigger"
      {...asChildSlot(asChild, children)}
      {...props}
    />
  )
}

function SheetClose({
  asChild,
  children,
  ...props
}: SheetPrimitive.Close.Props & { asChild?: boolean }) {
  return (
    <SheetPrimitive.Close
      data-slot="sheet-close"
      {...asChildSlot(asChild, children)}
      {...props}
    />
  )
}

function SheetPortal({
  ...props
}: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

/** Base UI 里 Radix 的 `Overlay` 叫 `Backdrop`。 */
function SheetOverlay({
  className,
  ...props
}: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        // 与 `DialogOverlay` 同一条：上沿读 `--overlay-top`（desktop 让开窗口按钮，
        // web 覆盖成 0 = 整屏，手机 = 安全区），见 tokens.css
        "fixed inset-x-0 bottom-0 top-[var(--overlay-top)] z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        // Base UI 的 Dialog 没有 Positioner，`data-side` 不会被自动写上；
        // 侧边面板的定位/动画全靠这个属性（下面那一大片 data-[side=*] 变体）。
        data-side={side}
        className={cn(
          // 侧边面板（left / right）**从常驻顶栏下沿开始**：`inset-y-0` 会让它盖住
          // desktop 标题栏右端那三颗窗口按钮（与遮罩同一条理由，见 `SheetOverlay`）。
          // 上下都用 inset 定位，所以 `h-full` 必须去掉 —— 两个都写会被判成 over-constrained，
          // 结果是「从 32px 开始、高 100vh」溢出到底部。
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:bottom-0 data-[side=left]:left-0 data-[side=left]:top-[var(--sidebar-drawer-top)] data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:bottom-0 data-[side=right]:right-0 data-[side=right]:top-[var(--sidebar-drawer-top)] data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-[side=bottom]:data-open:slide-in-from-bottom-10 data-[side=left]:data-open:slide-in-from-left-10 data-[side=right]:data-open:slide-in-from-right-10 data-[side=top]:data-open:slide-in-from-top-10 data-closed:animate-out data-closed:fade-out-0 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=left]:data-closed:slide-out-to-left-10 data-[side=right]:data-closed:slide-out-to-right-10 data-[side=top]:data-closed:slide-out-to-top-10",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={<Button variant="ghost" className="absolute top-3 right-3" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
