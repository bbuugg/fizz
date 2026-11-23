import * as React from "react"
import { cn } from "cn"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"
import { ChevronRightIcon, CheckIcon } from "lucide-react"
import { useDismissFocusGuard } from "./focus-dismiss"
import { resolveCollisionPadding } from "./safe-area"
import { stopPortalClick } from "./portal-click-guard"
import {
  clearLiquidLens,
  GLASS_PANEL_CLASS,
  LiquidGlassPanel,
  trackLiquidLens,
} from "./liquid-glass"

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn("select-none", className)}
      {...props}
    />
  )
}

function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuPortal({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return (
    <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
  )
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  children,
  onPointerDown,
  onPointerDownOutside,
  onCloseAutoFocus,
  onClick,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
}) {
  // 指针关闭不回焦（否则被右键的那一处会被 :focus-visible 描出主色边框），见 focus-dismiss.ts
  const dismissFocus = useDismissFocusGuard()
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        {...props}
        data-slot="context-menu-content"
        collisionPadding={resolveCollisionPadding(props.collisionPadding)}
        // 菜单项上的点击不冒到「被右键的那一行」（React 事件沿 React 树走，portal 也照冒）：
        // 否则脚本卡片右键 → 点「移出分组」会连带把卡片的 onClick 跑了（打开编辑框）。见 portal-click-guard.ts
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
          // 与 DropdownMenu / Dialog / 选择器面板同一套液态玻璃外壳：实色面板底、淡描边与
          // 景深投影都来自 `GLASS_PANEL_CLASS`，跟随指针的边缘流光由 `LiquidGlassPanel` 铺。
          // ⚠️ 别再往这里加 `bg-*` / `border-*` / `shadow-*`：会把玻璃材质换掉。
          //
          // 滚动下放到内层 `overflow-y-auto`（见下面）：外壳只当定高的 flex，
          // 流光相对面板定位，不会跟着菜单项滚走。
          "relative z-50 flex max-h-[min(var(--radix-context-menu-content-available-height),calc(100vh_-_2rem))] max-w-[calc(100vw_-_1rem)] min-w-36 origin-(--radix-context-menu-content-transform-origin) flex-col overflow-hidden rounded-xl text-popover-foreground duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          GLASS_PANEL_CLASS,
          className
        )}
        // 边缘流光：指针位置写到容器自身的 CSS 变量上，由 `LiquidGlassPanel` 读取
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
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
          {children}
        </div>
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 focus:*:[svg]:text-accent-foreground data-[variant=destructive]:*:[svg]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  // 子菜单没有 `onCloseAutoFocus`（Radix 的 SubContent 不挂 FocusScope），
  // 关闭后本来就不回焦，不需要守卫。
  return (
    <ContextMenuPrimitive.SubContent
      {...props}
      data-slot="context-menu-sub-content"
      // 与一级菜单同一套玻璃外壳 + 边缘流光（滚动同样下放到内层）
      className={cn(
        "relative z-50 flex min-w-32 origin-(--radix-context-menu-content-transform-origin) flex-col overflow-hidden rounded-xl text-popover-foreground duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        GLASS_PANEL_CLASS,
        className
      )}
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
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
        {children}
      </div>
    </ContextMenuPrimitive.SubContent>
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon
          />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon
          />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/context-menu-item:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
