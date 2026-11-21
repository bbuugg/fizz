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
import { SearchField } from "./search-field"

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
        className={cn("overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        <Command
          // 搜索框的高 / 图标尺寸由 `CommandInput` 自己给（与 `PickerSearch` 同一套），
          // 这里只调列表与分组的内边距。别再往这里加 `[cmdk-input]` / `[cmdk-input-wrapper]`
          // 的覆盖 —— 两处都写高度，改一处就漏一处。
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
 * 外壳来自 `search-field.tsx` 的 `SearchField`（模型选择 / 工作区选择的 `PickerSearch`
 * 共用同一份）：`p-2` 外边距 + `bg-muted` 圆角底 + 图标在左。命令面板 / 模型选择 /
 * 工作区选择这几处的搜索框本来就该长一样，别再往这里单独写外壳。
 *
 * `size="md"`（40px）比选择器那档（`sm` = 32px，与列表行同高）高两档：命令面板是一整块
 * 480px 宽的大面板，搜索框是它唯一的主入口，压到 32px 会显得憋屈。
 */
function CommandInput({
  className,
  leading,
  icon,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  /** 渲染在搜索图标左侧的元素（如二级视图的「返回」按钮） */
  leading?: React.ReactNode
  /** 替换默认搜索图标的元素（如搜索进行中的转圈）；不传 = 默认 SearchIcon */
  icon?: React.ReactNode
}) {
  return (
    <SearchField size="md" leading={leading} icon={icon} inputClassName={className}>
      {/* 必须是 cmdk 自己的 Input：过滤值在 Command 的 store 里，原生 input 筛不动列表 */}
      <CommandPrimitive.Input data-slot="command-input" {...props} />
    </SearchField>
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
 */
function CommandFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        "flex shrink-0 items-center px-3 py-2 text-xs text-muted-foreground",
        className
      )}
      {...props}
    />
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
}
