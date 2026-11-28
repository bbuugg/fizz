import * as React from "react"
import { cn } from "cn"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { useGlassPanel } from "./liquid-glass"
import { resolveCollisionPadding } from "./safe-area"
import { stopPortalClick } from "./portal-click-guard"
import { asChildSlot } from "./polymorphic"

function DropdownMenu({
  ...props
}: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({
  ...props
}: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({
  asChild,
  children,
  ...props
}: MenuPrimitive.Trigger.Props & { asChild?: boolean }) {
  return (
    <MenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...asChildSlot(asChild, children)}
      {...props}
    />
  )
}

function DropdownMenuContent({
  className,
  children,
  side,
  align,
  alignOffset,
  sideOffset = 4,
  collisionPadding,
  collisionBoundary,
  finalFocus,
  onClick,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
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
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        collisionPadding={resolveCollisionPadding(collisionPadding)}
        collisionBoundary={collisionBoundary}
        className="isolate z-50 outline-none"
      >
        <MenuPrimitive.Popup
          {...props}
          {...glass.handlers}
          data-slot="dropdown-menu-content"
          /*
           * 指针关闭不回焦（否则触发器会被 :focus-visible 描成主色边框）。
           * Base UI 把它收成 `finalFocus(closeType)`：键盘关（Esc / Tab）照旧回焦，指针关不动焦点。
           */
          finalFocus={finalFocus ?? ((closeType) => closeType === "keyboard")}
          // 菜单项上的点击**不往挂载它的那一行冒**（React 的事件沿 React 树走，portal 也照冒），
          // 否则「侧栏项目行 → 更多 → 点菜单项」会先把那一行点了（跳去新建会话页）。见 portal-click-guard.ts
          onClick={(event) => {
            stopPortalClick(event)
            onClick?.(event)
          }}
          className={cn(
            // 与 Dialog / AlertDialog / Select / 选择器面板同一套液态玻璃外壳：实色面板底、
            // 淡描边与景深投影都来自 `GLASS_PANEL_CLASS`，跟随指针的边缘光圈由
            // `LiquidGlassPanel` 铺在内容之上。
            // ⚠️ 别再往这里加 `bg-*` / `border-*` / `shadow-*`：会把玻璃材质换掉。
            //
            // 滚动放在内层那圈 `overflow-y-auto` 上（见下面），Popup 只当定高的 flex 外壳：
            // 边缘光圈是相对**面板**定位的，不会跟着菜单项一起滚走。
            //
            // 尺寸兜底（窄窗口 / 小屏）：高度取可用高度与视口高 - 2rem 的较小者（超了内滚），
            // 宽度封顶视口宽 - 1rem —— 不封顶的话长菜单会撑出视口，多出来的那截被浏览器直接裁掉。
            "relative z-50 flex max-h-[min(var(--available-height),calc(100vh_-_2rem))] max-w-[calc(100vw_-_1rem)] min-w-[8rem] origin-(--transform-origin) flex-col overflow-hidden rounded-xl text-popover-foreground outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            glass.className,
            className
          )}
        >
          {glass.edge}
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({
  ...props
}: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

/**
 * 菜单项。
 *
 * `onSelect` 是 Radix 的叫法，这里保留成兼容 prop（内部转成 `onClick`）：
 * 全仓有几十处调用点仍写 `onSelect`，且语义等价（点击 / Enter 都触发）。
 */
function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  onSelect,
  onClick,
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
  /** @deprecated 用 `onClick`；两者等价 */
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      onClick={(event) => {
        onClick?.(event)
        onSelect?.(event)
      }}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!",
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
  onSelect,
  onClick,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  /** @deprecated 用 `onClick`；两者等价 */
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      onClick={(event) => {
        onClick?.(event)
        onSelect?.(event)
      }}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon className="size-4" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  onSelect,
  onClick,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  /** @deprecated 用 `onClick`；两者等价 */
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      onClick={(event) => {
        onClick?.(event)
        onSelect?.(event)
      }}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <MenuPrimitive.RadioItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

/**
 * 分组标题。
 *
 * ⚠️ Base UI 的 `Menu.GroupLabel` 必须待在 `Menu.Group` 里（它要给组写 `aria-labelledby`，
 * 缺 context 直接抛错）；本仓大量标题是「自由漂浮」的，所以这里仍是一个普通 div。
 */
function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean
}) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-sm font-medium data-inset:pl-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
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
}: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-8 data-popup-open:bg-accent data-popup-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  children,
  onClick,
  ...props
}: MenuPrimitive.Popup.Props) {
  const glass = useGlassPanel(props)
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side="right"
        align="start"
        alignOffset={-3}
        sideOffset={0}
        className="isolate z-50 outline-none"
      >
        <MenuPrimitive.Popup
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
            "relative z-50 flex min-w-[8rem] origin-(--transform-origin) flex-col overflow-hidden rounded-xl text-popover-foreground outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            glass.className,
            className
          )}
        >
          {glass.edge}
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
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
