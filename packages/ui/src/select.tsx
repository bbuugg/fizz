"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Select as SelectPrimitive } from "radix-ui"
import { useDismissFocusGuard } from "./focus-dismiss"
import {
  clearLiquidLens,
  GLASS_PANEL_CLASS,
  LiquidGlassPanel,
  trackLiquidLens,
} from "./liquid-glass"
import { resolveCollisionPadding } from "./safe-area"

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

/**
 * 触发器长相。
 *
 * `muted` 与 `Input` 的 `muted` 变体同款（见 `input.tsx`）：灰底、无可见描边、扁平、
 * 聚焦不变色 —— 设置面板里输入框和下拉框常常上下叠着，一个描边一个不描边就成了两套控件。
 *
 * 边框同样用 `border-transparent` 而不是去掉边框：宽度保留着，切到 `aria-invalid`
 * （红边）和默认变体时内容不会横向跳 1px。
 */
const selectTriggerVariants = cva(
  "flex w-fit items-center justify-between gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
  {
    variants: {
      variant: {
        default:
          "border border-input bg-transparent shadow-xs focus-visible:border-ring aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40",
        muted:
          "rounded-lg border border-transparent bg-muted px-2.5 shadow-none focus-visible:border-transparent aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function SelectTrigger({
  className,
  size = "default",
  variant = "default",
  children,
  /**
   * 右侧那枚下拉箭头：默认渲染；`icon={false}` 时不渲染。
   *
   * 用在哪：输入行里的 pill（权限 / 工作区）用的是 shadcn 的 Select，但那一排 pill
   * （同会话的 MCP / 模型是手写 button）**约定不露箭头** —— 触发器自己就是个胶囊，
   * 箭头只会再啃掉一截横向空间（pill 有 `max-w-56`，窄面板下文字正愁不够截断）。
   * 别改成全局默认 false：弹窗 / 设置里那些正规 Select 仍要靠箭头表明「这是个下拉」。
   */
  icon = true,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> &
  VariantProps<typeof selectTriggerVariants> & {
    size?: "sm" | "default"
    /** 是否渲染右侧的下拉箭头（见上面的说明） */
    icon?: boolean
  }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      data-variant={variant}
      className={cn(selectTriggerVariants({ variant, className }))}
      {...props}
    >
      {children}
      {icon && (
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon className="size-4 opacity-50" />
        </SelectPrimitive.Icon>
      )}
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  /**
   * 面板顶部的**固定区**（标题 + 一句说明），渲染在 Viewport 之外：
   * 选项再多也只滚列表，头不跟着滚。
   *
   * 用在哪：权限选择那两颗 pill（`PermissionPill` / `AcpPermissionPill`）——
   * 三档名字自解释不了「点下去到底放宽了什么」，头里那句说明是它们唯一的解释位。
   * 普通 Select（设置页、表单）不要传，会白占一截高度。
   */
  header,
  onPointerDown,
  onPointerDownOutside,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
  /** 面板顶部的固定区（见上）；不传 = 没有这一块 */
  header?: React.ReactNode
}) {
  // 指针关闭不回焦（否则触发器会被 :focus-visible 描成主色边框），见 focus-dismiss.ts
  const dismissFocus = useDismissFocusGuard()
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
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
          // 弹出面板（select 的「二级」下拉）：与 Dialog / AlertDialog / 选择器面板同一套
          // 液态玻璃外壳 —— 实色面板底、淡描边与景深投影都来自 `GLASS_PANEL_CLASS`，
          // 跟随指针的边缘光圈由 `LiquidGlassPanel` 铺在内容之上。
          // ⚠️ 别再往这里加 `bg-*` / `border-*` / `shadow-*`：会把玻璃材质换掉。
          //
          // 滚动交给 `Select.Viewport`（它自带 `flex:1` + `overflow:hidden auto`，Radix 的
          // 上下滚动按钮读的也是它的 `scrollTop`）：Content 只当 `flex flex-col` 的定高外壳，
          // 这样边缘光圈是相对**面板**定位的，不会跟着列表一起滚走。
          //
          // 尺寸兜底（窄窗口 / 小屏）：
          // - 高度取「Radix 给的可用高度」与「视口高度 - 2rem」的**较小者**，超了就面板内滚；
          // - 宽度封顶到视口宽 - 1rem：否则 `min-w-*` / 长选项会把面板撑出视口，
          //   超出去的那截被浏览器直接裁掉（用户看到的就是「菜单一半被 hidden」）。
          "relative z-50 flex max-h-[min(var(--radix-select-content-available-height),calc(100vh_-_2rem))] max-w-[calc(100vw_-_1rem)] min-w-[8rem] origin-(--radix-select-content-transform-origin) flex-col overflow-hidden rounded-xl text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          GLASS_PANEL_CLASS,
          className
        )}
        position={position}
        align={align}
        {...props}
        // 玻璃的边缘光圈：指针位置写到容器自身的 CSS 变量上，由 `LiquidGlassPanel` 读取
        onPointerEnter={(event) => {
          trackLiquidLens(event)
          props.onPointerEnter?.(event)
        }}
        onPointerMove={(event) => {
          trackLiquidLens(event)
          props.onPointerMove?.(event)
        }}
        onPointerLeave={(event) => {
          clearLiquidLens(event)
          props.onPointerLeave?.(event)
        }}
      >
        <LiquidGlassPanel />
        {header ? (
          <div
            data-slot="select-header"
            className="shrink-0 border-b border-border px-4 pt-3.5 pb-3"
          >
            {header}
          </div>
        ) : null}
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            // 有 header = 「富面板」（权限那两颗），内边距放宽一档：选中项的灰底要离面板
            // 边缘留出气口，4px 会贴边显得像被裁掉。
            header ? "p-2" : "p-1",
            // Viewport 是面板里唯一的滚动区（Radix 自带 `flex:1` + `overflow:hidden auto`）：
            // 必须能收缩到内容以下才滚得起来，否则会把 Content 顶高、把面板撑出视口。
            "min-h-0",
            position === "popper" &&
              // `min-h-` 而不是 `h-`：锁死成触发器高度的话，多出来的选项在 Viewport 里放不下，
              // 面板看起来就只剩「第一项」，其余看不见
              "min-h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * 选项。两种形态：
 *
 * - **一行**（缺省，shadcn 原样）：图标 / 文本一行放完，选中项右侧一枚勾。设置页、表单用这个。
 * - **富行**（传了 `description`）：图标 + 标题 + 下方一句说明，整行更高，**选中态只靠
 *   右侧那枚勾**，勾对齐标题那一行。权限那两颗 pill 用它 —— 三档名字（确认 / 只读 /
 *   完全访问）自解释不了「点下去到底放宽了什么」，说明文字必须跟选项长在一起。
 *
 * 选中态**不铺底色**（两种形态一致）：底色是 hover / 键盘焦点的语言，被选中项再铺一层，
 * 就分不清「我选的是哪个」和「光标停在哪」了（2026-11 用户明确要求去掉）。
 * 两种形态共用同一份 Radix `Item`，所以键盘导航 / 选中语义完全一致；差别只在排版。
 */
function SelectItem({
  className,
  children,
  description,
  icon,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
  /** 第二行说明；传了就是「富行」形态（见上） */
  description?: React.ReactNode
  /** 富行左侧的图标（一行形态直接把图标塞进 children 即可） */
  icon?: React.ReactNode
}) {
  const rich = description !== undefined
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        // `cursor-pointer` 而不是 shadcn 原样的 `cursor-default`：这一排 pill / 下拉里的
        // 每一项都是「点一下就生效」的动作，鼠标移上去该给出可点的反馈（2026-11 用户要求）。
        // 禁用项不受影响 —— 它们走 `data-[disabled]:pointer-events-none`，根本吃不到指针。
        "relative flex w-full cursor-pointer text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        rich
          ? // 富行：勾改成绝对定位到右上，所以右侧留 pr-10。**选中不铺底色**（只有勾），
            // 底色留给 hover / 键盘焦点 —— 两件事共用一个视觉就分不清「我选的」和「光标在哪」
            "items-start gap-3 rounded-lg py-2.5 pr-10 pl-3 focus:bg-accent"
          : // 一行：shadcn 原样，同样**不加**选中底色
            "items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 focus:bg-accent focus:text-accent-foreground *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className={cn(
          "absolute flex items-center justify-center",
          // 富行的行高随说明文字变，勾钉在标题那一行的垂直中线上（pt-2.5 + 行高 20 的一半）
          rich ? "top-3 right-3 size-4" : "right-2 size-3.5"
        )}
      >
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      {rich ? (
        <SelectPrimitive.ItemText asChild>
          <div className="flex min-w-0 flex-1 items-start gap-3">
            {icon ? <span className="mt-px flex shrink-0 items-center">{icon}</span> : null}
            <div className="min-w-0">
              <div className="leading-5 font-medium">{children}</div>
              <div className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
                {description}
              </div>
            </div>
          </div>
        </SelectPrimitive.ItemText>
      ) : (
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      )}
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
}
