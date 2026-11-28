import * as React from "react"
import { cn } from "cn"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"
import { ChevronRightIcon, CheckIcon } from "lucide-react"
import { resolveCollisionPadding } from "./safe-area"
import { stopPortalClick } from "./portal-click-guard"
import { useGlassPanel } from "./liquid-glass"
import { asChildSlot } from "./polymorphic"

function ContextMenu({
  ...props
}: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  className,
  asChild,
  children,
  ...props
}: ContextMenuPrimitive.Trigger.Props & { asChild?: boolean }) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      {...asChildSlot(asChild, children)}
      className={cn("select-none", className)}
      {...props}
    />
  )
}

function ContextMenuGroup({
  ...props
}: ContextMenuPrimitive.Group.Props) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuPortal({
  ...props
}: ContextMenuPrimitive.Portal.Props) {
  return (
    <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
  )
}

function ContextMenuSub({
  ...props
}: ContextMenuPrimitive.SubmenuRoot.Props) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />
}

function ContextMenuRadioGroup({
  ...props
}: ContextMenuPrimitive.RadioGroup.Props) {
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
  side,
  align,
  alignOffset,
  sideOffset,
  collisionPadding,
  collisionBoundary,
  finalFocus,
  onClick,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Pick<
    ContextMenuPrimitive.Positioner.Props,
    | "side"
    | "align"
    | "alignOffset"
    | "sideOffset"
    | "collisionPadding"
    | "collisionBoundary"
  >) {
  // 液态玻璃外壳与指针追踪（边缘流光）由 Hook 统一给
  const glass = useGlassPanel(props)
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        // 默认锚在指针位置：**不要**给它 side / align（那会把每次右键都摆偏）；
        // 调用方显式传了才往下传。
        side={side}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        collisionPadding={resolveCollisionPadding(collisionPadding)}
        collisionBoundary={collisionBoundary}
        className="isolate z-50 outline-none"
      >
        <ContextMenuPrimitive.Popup
          {...props}
          {...glass.handlers}
          data-slot="context-menu-content"
          /*
           * 指针关闭不回焦（否则被右键的那一处会被 :focus-visible 描出主色边框）。
           * Base UI 把它收成 `finalFocus(closeType)`：键盘关照旧回焦，指针关不动焦点。
           */
          finalFocus={finalFocus ?? ((closeType) => closeType === "keyboard")}
          // 菜单项上的点击不冒到「被右键的那一行」（React 事件沿 React 树走，portal 也照冒）：
          // 否则脚本卡片右键 → 点「移出分组」会连带把卡片的 onClick 跑了（打开编辑框）。见 portal-click-guard.ts
          onClick={(event) => {
            stopPortalClick(event)
            onClick?.(event)
          }}
          className={cn(
            // 与 DropdownMenu / Dialog / 选择器面板同一套液态玻璃外壳：实色面板底、淡描边与
            // 景深投影都来自 `GLASS_PANEL_CLASS`，跟随指针的边缘流光由 `LiquidGlassPanel` 铺。
            // ⚠️ 别再往这里加 `bg-*` / `border-*` / `shadow-*`：会把玻璃材质换掉。
            //
            // 滚动下放到内层 `overflow-y-auto`（见下面）：外壳只当定高的 flex，
            // 流光相对面板定位，不会跟着菜单项滚走。
            "relative z-50 flex max-h-[min(var(--available-height),calc(100vh_-_2rem))] max-w-[calc(100vw_-_1rem)] min-w-36 origin-(--transform-origin) flex-col overflow-hidden rounded-xl text-popover-foreground outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            glass.className,
            className
          )}
        >
          {glass.edge}
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
            {children}
          </div>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  onSelect,
  onClick,
  ...props
}: ContextMenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
  /** @deprecated 用 `onClick`；两者等价 */
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      onClick={(event) => {
        onClick?.(event)
        onSelect?.(event)
      }}
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
}: ContextMenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
  )
}

function ContextMenuSubContent({
  className,
  children,
  ...props
}: ContextMenuPrimitive.Popup.Props) {
  const glass = useGlassPanel(props)
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        side="right"
        align="start"
        alignOffset={4}
        sideOffset={0}
        className="isolate z-50 outline-none"
      >
        <ContextMenuPrimitive.Popup
          {...props}
          {...glass.handlers}
          data-slot="context-menu-sub-content"
          // 与一级菜单同一套玻璃外壳 + 边缘流光（滚动同样下放到内层）
          className={cn(
            "relative z-50 flex min-w-32 origin-(--transform-origin) flex-col overflow-hidden rounded-xl text-popover-foreground outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            glass.className,
            className
          )}
        >
          {glass.edge}
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
            {children}
          </div>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  onSelect,
  onClick,
  ...props
}: ContextMenuPrimitive.CheckboxItem.Props & {
  inset?: boolean
  /** @deprecated 用 `onClick`；两者等价 */
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void
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
      onClick={(event) => {
        onClick?.(event)
        onSelect?.(event)
      }}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  onSelect,
  onClick,
  ...props
}: ContextMenuPrimitive.RadioItem.Props & {
  inset?: boolean
  /** @deprecated 用 `onClick`；两者等价 */
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void
}) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      data-inset={inset}
      onClick={(event) => {
        onClick?.(event)
        onSelect?.(event)
      }}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <ContextMenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

/**
 * 分组标题。
 *
 * ⚠️ Base UI 的 `Menu.GroupLabel` 必须待在 `Menu.Group` 里（缺 context 会直接抛错），
 * 本仓大量标题是自由漂浮的，所以这里仍是普通 div。
 */
function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean
}) {
  return (
    <div
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
}: ContextMenuPrimitive.Separator.Props) {
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
