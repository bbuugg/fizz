import * as React from "react"
import { cn } from "cn"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "./button"
import { orderDialogActions } from "./dialog-actions"
import { useHeightTransition } from "./height-transition"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // 上沿读 `--overlay-top`，**不写死 `inset-0`**：desktop 那条自绘标题栏右端是
        // 窗口的最小化 / 最大化 / 关闭，且整条是 `app-drag`（Windows / Linux 下是系统级
        // caption 命中，遮罩盖上去 mousedown 会被窗口过程拿去拖窗口），蒙住就等于把窗口
        // 按钮收走了；web 那边这个 token 覆盖成 0，整屏压暗；手机 = 安全区，也是整屏。
        // 各端取值在 tokens.css / 各端 styles.css 里，组件一行判断都不用加。
        "fixed inset-x-0 bottom-0 top-[var(--overlay-top)] isolate z-50 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  /**
   * 内容变化时高度不跳：弹窗高度是内容撑出来的（列表加载完、校验提示出现 / 消失、
   * 切到第二个视图），不补这段过渡就是「啪」地一截。实现见 `height-transition.ts`，
   * 与选择器面板同一份。
   *
   * ⚠️ 高度由 CSS 定死的弹窗（`h-[32rem]` 那种）不受影响：量出来和原来一样，直接落定。
   */
  useHeightTransition(contentRef)

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={contentRef}
        data-slot="dialog-content"
        className={cn(
          // 边界：遮罩**不压暗**（`DialogOverlay` 只有可选毛玻璃），光靠 `shadow-2xl`
          // 在 light 下弹窗和页面同为纯白、边界会糊。这里用三层把轮廓勾出来：
          // ① `ring-1` 发丝边（light 黑 10%，dark 白 10%）；② 贴地小阴影；
          // ③ 远距大投影；dark 下再加顶部 1px 内高光，补上深色里看不见的投影。
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-black/10 outline-none duration-100 sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 dark:ring-white/10 dark:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.06),0_20px_50px_-12px_rgb(0_0_0/0.7)] shadow-[0_2px_4px_rgb(0_0_0/0.04),0_20px_50px_-12px_rgb(0_0_0/0.25)]",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

/** 取消用 DialogClose 或 data-dialog-dismiss 标记：横排时它是最左那颗，竖排（`<sm`）时 order 把它推到底部。 */
function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col gap-2 rounded-b-xl p-4 max-sm:[&>[data-dialog-dismiss]]:order-last sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {orderDialogActions(children, [DialogClose, DialogPrimitive.Close])}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
