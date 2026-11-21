import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { cn } from "cn"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog"
import { Kbd } from "./kbd"
import { SearchIcon } from "lucide-react"

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  commandProps,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  /** 透传给内部 Command 根（如二级搜索视图用 shouldFilter=false 关掉 cmdk 本地过滤） */
  commandProps?: Omit<React.ComponentProps<typeof CommandPrimitive>, "children">
  /**
   * 拦 Esc：Radix 在 document 捕获层处理 Esc 并关闭弹层，`event.preventDefault()` 可挡住。
   * 二级命令视图用它实现「Esc 先回上一级，最后才关面板」。
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => void
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        /*
          垂直方向**钉住上沿**：`top-[10vh]` + `translate-y-0` 覆盖 DialogContent 默认的
          「垂直居中 + -translate-y-1/2」。面板高度是跟内容走的（命令少就矮），居中定位时
          一变高 / 变矮，上沿与下沿会同时朝中心收，搜索框那行跟着上下跳；钉住上沿后只有
          下沿在动，视线始终落在搜索框上，缩的时候也是从底部往上收。
          10vh 而不是固定 px：小窗口 / 横屏手机也要留住上边距（列表自带 `max-h` 兜底，
          整块不会顶出视口）。
        */
        className={cn("top-[10vh] translate-y-0 overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        <Command
          // 搜索框的高 / 图标尺寸由 `CommandInput` 自己给，这里只调列表与分组的内边距。
          // 别再往这里加 `[cmdk-input]` / `[cmdk-input-wrapper]` 的覆盖 —— 两处都写高度，
          // 改一处就漏一处。
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
          {...commandProps}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 面板顶部的搜索框。
 *
 * **无外壳、无底色**：命令面板是一整块浮层，搜索框就是它最上面那一行，直接铺在
 * `--popover` 上（`h-10` + `px-3`），不再套 `SearchField` 那种 `p-2` + `bg-muted`
 * 的圆角壳 —— 有底色的壳会把面板切出一截「输入区」，看着像嵌了第二个弹窗。
 * 选择面板（`PickerSearch`）仍然走 `SearchField`：它是浮在列表上方的一颗独立输入框，
 * 有底色才分得清边界。两处场景不同，别再往这里套回来。
 */
function CommandInput({
  className,
  leading,
  trailing,
  icon,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  /** 渲染在搜索图标左侧的元素（如二级视图的「返回」按钮） */
  leading?: React.ReactNode
  /** 渲染在输入框右侧的元素（如目录浏览那颗「选择」） */
  trailing?: React.ReactNode
  /**
   * 替换默认搜索图标的元素（如搜索进行中的转圈）；`false` = **不画图标**。
   * 目录浏览那类输入框里装的是绝对路径本身，前面再挂个放大镜只是噪音。
   */
  icon?: React.ReactNode
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-10 shrink-0 items-center gap-2 px-3"
    >
      {leading}
      {icon === false ? null : (icon ?? <SearchIcon className="size-4 shrink-0 text-muted-foreground" />)}
      {/* 必须是 cmdk 自己的 Input：过滤值在 Command 的 store 里，原生 input 筛不动列表 */}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full min-w-0 rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
      {trailing}
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto no-scrollbar",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        /*
         * 选中项用 `primary-subtle`（22% 主题色）而不是 `primary-soft`（13%）。
         *
         * 两个原因：
         * 1. 与全应用的分档约定一致 —— hover 用 soft、**选中 / 当前项用 subtle**
         *    （见 AgentSidebar / DesktopSettingsPanel / MobileSettingsPanel）；
         * 2. `--primary-soft` 是「13% 主题色混进 `--background`」，而命令面板铺的是
         *    `--popover`。暗色下 background 0.145、popover 0.205，soft 算出来才 0.224
         *    —— 比面板底色只亮一点点，选中行几乎看不出来（用户实测反馈）。
         *    subtle 落在 0.278，与侧栏选中行同一档，暗色下才分得清。
         */
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-primary-subtle data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * 面板底部提示条：一条分隔线 + 一行键位说明（如「↑↓ 选择 · Enter 执行 · Esc 关闭」）。
 *
 * 放在 `Command` 根的子节点最后一位即可 —— 根是 `flex-col`、列表是 `flex-1`，
 * 提示条会被自然顶到面板底部，列表滚动区不会盖住它（也不需要额外定位）。
 * 文案由调用方给：不同层级的键位语义不一样（Esc 在二级视图是「返回」不是「关闭」）。
 *
 * 排布按「键帽 + 说明」成对（见 `CommandFooterHint`），条内允许换行：
 * 手机窄屏放不下三组时折行，而不是把文字挤成一条缝。
 *
 * 顶部分界**不用 `border-t`**：底栏是一层浮在列表上的亮面，一条硬边框会把它切成两截。
 * 这里用两条伪元素仿那种「一圈白影」的效果 —— `before` 把面板底色向上渐隐 12px
 * （列表最后一行滚到这儿会淡出，看起来就是一圈柔光），`after` 只留一条极淡的发丝线，
 * 免得暗色主题下渐隐看不见、整个底栏和列表糊成一块。
 */
function CommandFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        "relative flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 bg-popover px-3 py-2 text-xs text-muted-foreground",
        "before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-3 before:bg-linear-to-t before:from-popover before:to-transparent",
        "after:pointer-events-none after:absolute after:inset-x-0 after:top-0 after:h-px after:bg-border/60",
        className
      )}
      {...props}
    />
  )
}

/**
 * 底栏的一组键位提示：`[↑][↓] 选择`。
 *
 * 键帽是**纯灰底、不描边**（`bg-muted`，键位文字用 `text-foreground` 压住对比度）：
 * 描边键帽在浅色主题里像一颗颗按钮，会和列表里的可点行抢注意力。
 * 只吃 key 文本，不认业务：哪一组键配哪句话由调用方决定。
 */
function CommandFooterHint({
  keys,
  label,
  className,
}: {
  /** 同一个动作的多个键（如 ↑↓），顺序即展示顺序 */
  keys: string[]
  /** 键位对应的动作说明（已翻译） */
  label: string
  className?: string
}) {
  return (
    <span
      data-slot="command-footer-hint"
      className={cn("inline-flex items-center gap-1 whitespace-nowrap", className)}
    >
      {keys.map((key) => (
        <Kbd
          key={key}
          className="rounded-md bg-muted px-1.5 leading-none text-foreground"
        >
          {key}
        </Kbd>
      ))}
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
  CommandFooter,
  CommandFooterHint,
}
