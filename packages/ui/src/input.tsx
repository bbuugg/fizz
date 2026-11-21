import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/**
 * `muted` 是选择面板顶部那颗搜索框的形态（见 `picker-panel.tsx` 的 `PickerSearch`）：
 * 灰底、无可见描边、扁平（无阴影）、聚焦也不变色。
 *
 * 边框用 `border-transparent` 而不是 `border-0`：宽度保留，聚焦 / 无效态切换颜色时不会
 * 让内容跳 1px。无效态仍给红边——灰底输入框不给任何反馈，用户看不出校验失败。
 */
const inputVariants = cva(
  "h-8 w-full min-w-0 rounded-md px-3 py-1 text-base transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
  {
    variants: {
      variant: {
        default:
          "border border-input bg-transparent shadow-xs dark:bg-input/30 focus-visible:border-ring aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        muted:
          "rounded-lg border border-transparent bg-muted px-2.5 shadow-none focus-visible:border-transparent aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Input({
  className,
  type,
  variant = "default",
  ...props
}: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      className={cn(
        inputVariants({ variant, className }),
        /**
         * 系统画的数字上下箭头：各家主题下都是同一副灰、宽度随数值位数浮动，
         * 还会把内容挤向左边。`NumberField` 里换成自绘的一对小箭头，这里统一收掉原生的。
         *
         * 直接写 `<Input type="number">`（不回传 NumberField）的地方**不受影响**：
         * 键盘 ArrowUp / ArrowDown 是 input 的原生行为，与这枚 spinner 无关。
         */
        type === "number" &&
          "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      )}
      {...props}
    />
  )
}

export { Input, inputVariants }
