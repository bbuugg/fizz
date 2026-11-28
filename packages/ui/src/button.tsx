import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Button as ButtonPrimitive } from "@base-ui/react/button"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          // ⚠️ 与 shadcn 上游不同：上游是「白底 + 一圈细边」（`bg-background border`），
          // 在浅色主题里就是一片白色描边钮，跟本仓「灰底扁平」的控件语言（Input / Select
          // 的 `muted` 变体、Segmented 的凹槽）不是一套。
          // 这里改成同一套灰底：描边留 `border-transparent` 保宽度（聚焦 / 无效态换色不跳 1px）。
          "border border-transparent bg-muted text-foreground shadow-none hover:bg-muted/80",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * 按钮。
 *
 * 落到 Base UI 真正的 `Button` 原语（不是手写的 useRender 壳）：`asChild` 由它自己的
 * `render` 承接，只有渲染成非 `<button>`（比如链接）时才需要 `nativeButton={false}`。
 */
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const target =
    asChild && React.isValidElement(children) ? children : undefined
  const isNativeButton =
    target === undefined || target.type === "button"

  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      render={target}
      nativeButton={isNativeButton}
      {...props}
    >
      {target ? undefined : children}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
