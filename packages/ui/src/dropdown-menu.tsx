import * as React from "react"
import { cn } from "cn"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { useDismissFocusGuard } from "./focus-dismiss"
import { useGlassPanel } from "./liquid-glass"
import { resolveCollisionPadding } from "./safe-area"
import { stopPortalClick } from "./portal-click-guard"

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  )
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  )
}

function DropdownMenuContent({
  className,
  children,
  sideOffset = 4,
  onPointerDown,
  onPointerDownOutside,
  onCloseAutoFocus,
  onClick,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  // 指针关闭不回焦（否则触发器会被 :focus-visible 描成主色边框），见 focus-dismiss.ts
  const dismissFocus = useDismissFocusGuard()
  // 液态玻璃外壳与指针追踪（边缘流光）由 Hook 统一给
  const glass = useGlassPanel(props)
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        {...props}
        {...glass.handlers}
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={resolveCollisionPadding(props.collisionPadding)}
        // 菜单项上的点击**不往挂载它的那一行冒**（React 的事件沿 React 树走，portal 也照冒），
        // 否则「侧栏项目行 → 更多 → 点菜单项」会先把那一行点了（跳去新建会话页）。见 portal-click-guard.ts
        onClick={(event) => {
          stopPortalClick(event)
          onClick?.(event)
        }}
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
          // 与 Dialog / AlertDialog / Select / 选择器面板同一套液态玻璃外壳：实色面板底、
          // 淡描边与景深投影都来自 `GLASS_PANEL_CLASS`，跟随指针的边缘光圈由
          // `LiquidGlassPanel` 铺在内容之上。
          // ⚠️ 别再往这里加 `bg-*` / `border-*` / `shadow-*`：会把玻璃材质换掉。
          //
          // 滚动放在内层那圈 `overflow-y-auto` 上（见下面），Content 只当定高的 flex 外壳：
          // 边缘光圈是相对**面板**定位的，不会跟着菜单项一起滚走。
          //
          // 尺寸兜底（窄窗口 / 小屏）：高度取 Radix 可用高度与视口高 - 2rem 的较小者（超了内滚），
          // 宽度封顶视口宽 - 1rem —— 不封顶的话长菜单会撑出视口，多出来的那截被浏览器直接裁掉。
          "relative z-50 flex max-h-[min(var(--radix-dropdown-menu-content-available-height),calc(100vh_-_2rem))] max-w-[calc(100vw_-_1rem)] min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) flex-col overflow-hidden rounded-xl text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          glass.className,
          className
        )}
      >
        {glass.edge}
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
          {children}
        </div>
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-sm font-medium data-[inset]:pl-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[inset]:pl-8 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  children,
  onClick,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  // 子菜单没有 `onCloseAutoFocus`（Radix 的 SubContent 不挂 FocusScope），
  // 关闭后本来就不回焦，不需要守卫。
  const glass = useGlassPanel(props)
  return (
    <DropdownMenuPrimitive.SubContent
      {...props}
      {...glass.handlers}
      data-slot="dropdown-menu-sub-content"
      // 同 Content：子菜单也是 portal，点击不冒到外面那一行
      onClick={(event) => {
        stopPortalClick(event)
        onClick?.(event)
      }}
      className={cn(
        // 与主面板同一套液态玻璃外壳 + 边缘流光（滚动同样下放到内层）：
        // 子菜单是**另一个组件**（DropdownMenuSubContent），不会跟着 Content 一起改。
        "relative z-50 flex min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) flex-col overflow-hidden rounded-xl text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        glass.className,
        className
      )}
    >
      {glass.edge}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
        {children}
      </div>
    </DropdownMenuPrimitive.SubContent>
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
