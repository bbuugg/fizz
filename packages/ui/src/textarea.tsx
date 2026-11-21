import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/**
 * 多行输入框长相。
 *
 * `muted` 与 `Input` / `SelectTrigger` 的 `muted` 同款（见 `input.tsx`）：灰底、无可见描边、
 * 扁平、聚焦不变色。设置面板与主机表单里多行框常和输入框上下叠着，样式必须一致。
 *
 * 边框同样用 `border-transparent` 而不是去掉边框：宽度保留，切到 `aria-invalid`（红边）
 * 与默认变体时内容不横向跳。
 *
 * ⚠️ `input-group.tsx` 的 `InputGroupTextarea` 依赖这里的 base 类再用 `border-0` 覆盖，
 * 改 base 时留意它 —— `cn` 的 tailwind-merge 会让调用方的 `border-0` 胜出，别把边框
 * 挪进调用方拿不到的位置。
 */
const textareaVariants = cva(
  "flex field-sizing-content min-h-16 w-full rounded-md px-3 py-2 text-base transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
  {
    variants: {
      variant: {
        default:
          "border border-input bg-transparent shadow-xs focus-visible:border-ring aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
        muted:
          "rounded-lg border border-transparent bg-muted px-2.5 shadow-none focus-visible:border-transparent aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Textarea({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>) {
  return (
    <textarea
      data-slot="textarea"
      data-variant={variant}
      className={cn(textareaVariants({ variant, className }))}
      {...props}
    />
  )
}

export { Textarea, textareaVariants }
