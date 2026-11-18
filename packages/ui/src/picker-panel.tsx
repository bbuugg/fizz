/**
 * 可搜索的弹出选择面板：`Popover` 里那一套「搜索 + 列表 + 底部动作」的**唯一一份长相**。
 *
 * ## 为什么单独抽一个原语
 *
 * 工作区 / 项目 / 分支这类选择器都是同一个形状：触发器是一颗 pill，点开是一个能搜、
 * 能滚、底部固定几条动作的面板。长相散在各自的调用方里写过两轮就开始漂（搜索框一处有
 * 底色一处没有、行高一档紧一档松），所以这里把「面板 / 搜索 / 列表 / 行 / 底部动作」
 * 五件东西定型，**调用方只填数据**。
 *
 * ## 为什么不是 Radix `Select`
 *
 * `Select` 的选项必须是 `SelectItem`，把搜索框塞进 `header` 看着能跑，实际键盘 / 焦点 /
 * 筛选全是坑（输入框一敲字就撞上 Select 自己的 typeahead，选中项还会被 `ItemAligned`
 * 顶到触发器上）。这里用 `Popover` + `cmdk`：`Command` 提供方向键 / 回车选中，
 * 搜索框与底部动作各自固定，只有中间列表滚。
 *
 * ## 三段式
 *
 * ```
 * ┌──────────────────────────┐
 * │ [🔍 搜索…]               │  ← PickerSearch（固定，不随列表滚）
 * │  📁 项目 A                │  ┐
 * │  📁 项目 B                │  ├ PickerList（唯一的滚动区）
 * │  📁 项目 C                │  ┘
 * ├──────────────────────────┤  ← PickerFooter 的上边线
 * │  ＋ 新建…                 │  ← PickerAction（固定）
 * └──────────────────────────┘
 * ```
 *
 * ⚠️ 底部那块必须放在 `Command` **外面**（`footer` 槽）：`Command` 根节点接管了整棵
 * 子树的键盘事件，Enter 一律 `preventDefault` 后去选高亮项 —— 放进去的话底部按钮按
 * 回车不会触发按钮本身。
 *
 * ## 筛选由调用方算
 *
 * 面板固定 `shouldFilter={false}`：搜索要能匹配「目录路径 / 主机名」这类**不显示在行里**
 * 的字段，cmdk 只认行文本。调用方拿 `PickerSearch` 的 `value` 自己筛好再喂给
 * `PickerList`（见 `WorkspacePicker`）。
 */
import * as React from 'react'
import { CheckIcon, SearchIcon } from 'lucide-react'
import { cn } from 'cn'

import { Command, CommandItem } from './command'
import { useHeightTransition } from './height-transition'
import { PopoverContent } from './popover'

/**
 * 面板外壳：`PopoverContent` + 内部的 `Command` 根 + 底部固定槽。
 *
 * 高度上限**必须吃 Radix 算出来的可用高度**（`--radix-popper-available-height`，由
 * `Popper.Content` 以内联变量给出，已扣掉 `collisionPadding`），再与 26rem 取小：
 *
 * - 只写 `100dvh` 是错的：那是**整窗高度**，模型 / 工作区列表一长，面板就长到将近一屏，
 *   贴在输入框上方的面板直接顶出视口上沿 —— 搜索框被窗口裁掉，看起来像「溢出、顶部被遮挡」。
 *   Radix 的翻转只在两侧都放得下时才有用，面板比两侧空间都高时它只能留在原位溢出。
 * - `26rem` 是桌面上的舒适上限：再高就该滚了，不该继续长。
 *
 * `min-h-0` + `flex-1` 让中间的列表收缩并自己滚（不要给列表写死 `h-*`）。
 * `dvh` 那一段只是首帧兜底：可用高度是量出来才写上去的，第一次绘制时可能还没值。
 *
 * 搜索时面板会变矮（筛掉了大部分行），高度变化由 `useHeightTransition` 补一段过渡
 * （与对话框共用同一份实现，见 `height-transition.ts`）。
 */
function PickerPanel({
  children,
  footer,
  className,
  onOpenAutoFocus,
  ...props
}: React.ComponentProps<typeof PopoverContent> & {
  /** 底部固定区（`PickerFooter`）；不传 = 没有这一块 */
  footer?: React.ReactNode
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  useHeightTransition(panelRef)

  return (
    <PopoverContent
      {...props}
      ref={panelRef}
      // 面板里第一颗就是搜索框（自己 `autoFocus`）；让 Radix 的 FocusScope 别再抢一次焦点
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        onOpenAutoFocus?.(event)
      }}
      className={cn(
        'flex max-h-[min(26rem,var(--radix-popper-available-height,calc(100dvh_-_3rem)))] w-72 flex-col gap-0 overflow-hidden rounded-xl p-0',
        className
      )}
    >
      <Command shouldFilter={false} className="h-auto min-h-0 flex-1 gap-0 bg-transparent">
        {children}
      </Command>
      {footer}
    </PopoverContent>
  )
}

/**
 * 顶部固定的搜索框：一颗带底色的圆角输入框，图标在左。
 *
 * 高度与列表行**一致**（`h-8` = 32px = `py-1.5` + 20px 行高）：它俩上下叠在一起，
 * 差一档就看得出是两套控件。
 *
 * `autoFocus` 由调用方决定（手机不聚焦：软键盘会在面板定位之后才弹出，把面板顶到键盘下）。
 */
function PickerSearch({
  className,
  onKeyDown,
  ...props
}: React.ComponentProps<'input'>) {
  return (
    <div className="shrink-0 p-2">
      <div className="flex h-8 items-center gap-2 rounded-lg bg-muted px-2.5">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          {...props}
          onKeyDown={(event) => {
            // `Command` 根节点把 Home / End 抢去当「选第一项 / 最后一项」，而这两个键在
            // 输入框里是「光标到行首 / 行尾」—— 搜索词打到一半想回去改一个字都做不到
            if (event.key === 'Home' || event.key === 'End') event.stopPropagation()
            onKeyDown?.(event)
          }}
          className={cn(
            'h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground',
            className
          )}
        />
      </div>
    </div>
  )
}

/** 中间的滚动区：**整块面板只有这里滚**，两侧留 8px 让行与搜索框左缘对齐 */
function PickerList({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      {...props}
      className={cn(
        'min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-2',
        className
      )}
    />
  )
}

/**
 * 分组小标题：列表按来源（某个模型配置 / 某个 Agent）分段时用。
 *
 * 它**不可点、不进方向键的遍历范围**（不是 cmdk item）—— 拍平后的列表只靠它分段，
 * 不再用二级菜单。`action` 放行尾的入口（设置齿轮那类）。
 */
function PickerLabel({
  className,
  action,
  children
}: {
  className?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground',
        className
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {action}
    </div>
  )
}

/** 列表里的一句说明（「还没有模型配置」「这组不可用」这类，不可点） */
function PickerNote({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      {...props}
      className={cn('px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground', className)}
    />
  )
}

/**
 * 一行可选项：图标 + 标题 +（可选）行尾说明 +（可选）选中勾。
 *
 * 行高 32px（`py-1.5` + 20px 行高）：与全局其它下拉 / 菜单项同一档。**别往回调到
 * `py-2.5`** —— 那是第一版照参考图放大的值，用户实测「单个菜单的高度有点高」。
 *
 * 勾用**固定占位**：有没有选中都不改行宽，切到名字最长的那一项时面板宽度才不会跳。
 * 必须在 `PickerPanel` 里用（它渲染的是 cmdk 的 item）。
 */
function PickerItem({
  icon,
  hint,
  active = false,
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandItem> & {
  /** 行首图标（16px） */
  icon?: React.ReactNode
  /** 行尾说明：远端主机名、「目录不存在」这类次要信息，超宽截断 */
  hint?: React.ReactNode
  /** 是否为当前选中项（只影响行尾那枚勾） */
  active?: boolean
}) {
  return (
    <CommandItem
      {...props}
      className={cn('cursor-pointer gap-2.5 rounded-lg px-2.5 py-1.5 text-sm', className)}
    >
      {icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? (
        <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{hint}</span>
      ) : null}
      <span className="flex size-4 shrink-0 items-center justify-center">
        {active ? <CheckIcon className="size-4 text-foreground" /> : null}
      </span>
    </CommandItem>
  )
}

/**
 * 底部固定区：一条上边线 + 一组动作行。
 *
 * 上边线**只画一条**：里面的「不选 / 新建 / 打开」是同一组动作，中间再切一刀就成了
 * 两套语义（用户明确要求过别切）。
 */
function PickerFooter({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('shrink-0 px-2 pb-2', className)}>
      <div className="border-t border-border pt-2">{children}</div>
    </div>
  )
}

/**
 * 底部动作行（普通按钮，不走 cmdk —— 它不进方向键的遍历范围）。
 *
 * 行高与 `PickerItem` **必须一致**（32px）：两组行贴在一条分隔线两侧，差 4px 一眼就能
 * 看出是两套东西。`active` 与 `PickerItem` 同一个含义：`未指定工作区` 这种「也是一种
 * 选择」的动作行靠它打勾，勾的占位尺寸也一致。
 */
function PickerAction({
  icon,
  active = false,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & {
  icon?: React.ReactNode
  active?: boolean
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50',
        className
      )}
    >
      {icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {active ? <CheckIcon className="size-4 text-foreground" /> : null}
      </span>
    </button>
  )
}

/** 列表为空时的一行说明（搜索结果为空 / 还没有任何可选项） */
function PickerEmpty({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      {...props}
      className={cn('px-2.5 py-6 text-center text-sm text-muted-foreground', className)}
    />
  )
}

export {
  PickerPanel,
  PickerSearch,
  PickerList,
  PickerLabel,
  PickerNote,
  PickerItem,
  PickerFooter,
  PickerAction,
  PickerEmpty
}
