/**
 * 面板顶部「搜索框」的唯一一份长相：`p-2` 外边距 + 灰底圆角外壳 + 左侧图标 + 输入槽。
 *
 * 选择面板（`picker-panel.tsx` 的 `PickerSearch`）与命令面板（`command.tsx` 的
 * `CommandInput`）本来就是同一个控件，之前各写一份，高度一档、内边距一档地漂。
 *
 * ## 为什么输入元素是插槽
 *
 * 命令面板的输入框**必须是** `CommandPrimitive.Input`：cmdk 的过滤读它自己的 store，
 * 换成原生 `<input>` 后 `Command` 根收不到输入值，列表就永远不筛。所以外壳只负责
 * 「容器 + 图标 + 尺寸」，输入节点由调用方给，样式经 `cloneElement` 注入。
 *
 * ## 两档高度
 *
 * - `sm`（32px）：选择面板里与列表行同高，差一档就看出是两套控件；
 * - `md`（40px）：命令面板是一整块 480px 宽的大面板，搜索框是唯一主入口，压到 32px 显得憋屈。
 */
import * as React from 'react'
import { SearchIcon } from 'lucide-react'
import { cn } from 'cn'

/** 输入元素的基础样式：高度 / 边框 / 底色都由外壳管，这里只保证它能填满并融进灰底 */
const SEARCH_FIELD_INPUT_CLASS =
  'h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50'

/** 外壳尺寸：`sm` 与列表行同高，`md` 给命令面板这种大面板 */
const SIZE_CLASS = {
  sm: 'h-8 px-2.5',
  md: 'h-10 px-3'
} as const

function SearchField({
  size = 'md',
  icon,
  leading,
  className,
  inputClassName,
  children
}: {
  size?: keyof typeof SIZE_CLASS
  /** 替换默认搜索图标（如搜索进行中的转圈）；不传 = `SearchIcon` */
  icon?: React.ReactNode
  /** 渲染在搜索图标左侧的元素（如二级视图的「返回」按钮） */
  leading?: React.ReactNode
  /** 追加到最外层（`p-2` 那层） */
  className?: string
  /** 追加到输入元素（调用方原来直接写在 `Input` / `PickerSearch` 上的 className） */
  inputClassName?: string
  /** 唯一的输入元素：原生 `input` 或 cmdk 的 `CommandPrimitive.Input` */
  children: React.ReactElement<{ className?: string }>
}) {
  return (
    <div data-slot="search-field" className={cn('shrink-0 p-2', className)}>
      <div
        data-slot="search-field-shell"
        className={cn(
          'flex items-center gap-2 rounded-lg bg-muted',
          SIZE_CLASS[size]
        )}
      >
        {leading}
        {icon ?? <SearchIcon className="size-4 shrink-0 text-muted-foreground" />}
        {/* 输入元素的 className 三处来源合并：基础样式 ← 调用方追加 ← 元素自己写的 */}
        {React.cloneElement(children, {
          className: cn(
            SEARCH_FIELD_INPUT_CLASS,
            inputClassName,
            children.props.className
          )
        })}
      </div>
    </div>
  )
}

export { SearchField }
