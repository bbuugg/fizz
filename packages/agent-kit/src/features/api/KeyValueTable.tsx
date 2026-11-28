"use client";

/**
 * 「接口请求」页的键值对表格 —— 请求头 / 参数 / 请求体表单（两张）四处共用。
 *
 * ## 目标是「像电子表格」，不是「一堆输入框」
 *
 * 单元格**永远没有边框、没有圆角，聚焦也不出描边** —— 聚焦只把底色压深一档，像表格里
 * 被选中的那个格子。这是这张表的底线：一旦描边 + 圆角，视觉上立刻退回成「表单里的
 * 一堆输入框」，而那正是它要摆脱的东西。行与列的区分交给表头、行分隔线和整行 hover。
 *
 * ## 行模型（与 `tidyHeaderRows` / `tidyFormRows` 配套）
 *
 * 每行 = **启用勾选 + 名称 + 值 + 删除**，末行恒为空槽位：
 * - 空槽位不渲染勾选与删除 —— 那两样对「等着你填的行」没有意义，删了也会被 tidy 立刻补回来；
 * - 停用（`enabled === false`）的行**照旧可编辑**，只是文字变淡、不随请求发出。
 *   做成只读会很难受：想改个错字还得先启用，改完再停用。
 *
 * ## 窄屏（手机）横向滚动
 *
 * 表头与所有行包在**同一个**横向滚动层里，整体给一个最小宽度；宽度不够时整表一起横拖，
 * 而不是把「名称 / 值」挤成两个几像素的格子。表头与行必须同层同滚，否则一横拖就会错位
 * （见 `minWidth` 上方那段注释）。
 *
 * ## 补全：**不用原生 `<datalist>`**
 *
 * 原生那个下拉由浏览器 / 系统绘制（Windows 与 macOS 各一套），既跟不上主题，也和表格的
 * 观感对不上。这里用 Radix `Popover` 自绘一份，输入框自己保持焦点（见 `CellSuggestInput`）。
 *
 * ## 补全与额外列都从外面注入
 *
 * 组件本身不认识 `ApiHeaderPair` / `ApiFormField`，只要求行对象有 `key` / `value` / `enabled`：
 * - 名称 / 值两列的补全候选逐行给（候选是按请求头名称算出来的，见 `headerValueSuggestions`）；
 * - form-data 多一列「类型」和「文件选择」两处特例，分别由 `kindOf` / `renderValue` 注入，
 *   所以这张表不用为「文件」长出半套逻辑，请求头表也不会带着一堆用不上的分支。
 */
import { useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { Checkbox } from '@fizz/ui/checkbox'
import { Button } from '@fizz/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@fizz/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fizz/ui/select'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { isRowEnabled } from '@fizz/agent-kit/features/api/api-client'

/** 一行至少要有的东西（`ApiHeaderPair` / `ApiFormField` 都满足） */
export interface KeyValueRow {
  key: string
  value: string
  enabled?: boolean
}

/** 「类型」列（form-data 专用）的当前取值与切换回调 */
export interface KindCell {
  value: string
  onChange: (next: string) => void
}

/**
 * 单元格输入框：**零边框、零圆角、聚焦也不描边**。
 *
 * 用原生 `<input>` 而不是 shadcn 的 `Input`：`Input` 自带边框 + 阴影 + 36px 高度 + 圆角，
 * 那是「表单控件」的形态，放表格格里正好就是用户嫌的那个「一堆输入框」。
 * 这里要的是**表格格子里的一块可编辑文字**，所以从零写，只借用主题色变量。
 *
 * 导出去给 `ApiPage` 的文件字段值格用（那格是只读文件名，但必须是同一副长相）。
 */
export function CellInput({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      data-slot="kv-cell-input"
      className={cn(
        // h-7 与表头行高、勾选框尺寸对齐；font-mono 是因为这几列几乎都是头名 / 参数名 / 值
        'h-7 w-full min-w-0 border-0 bg-transparent px-1.5 font-mono text-xs',
        'outline-none transition-colors placeholder:font-sans placeholder:text-muted-foreground',
        // 聚焦只换底色：像电子表格里选中的格子，而不是给输入框描个边
        'focus:bg-muted/70',
        className
      )}
    />
  )
}

/** 单元格里的下拉：把 Radix `Select` 压成「格子里的一行文字 + 箭头」，同样零边框零圆角 */
const CELL_SELECT_TRIGGER =
  'data-[size=sm]:h-7 w-full rounded-none border-0 bg-transparent px-1 text-xs shadow-none dark:bg-transparent dark:hover:bg-transparent'

/**
 * 「类型」列的选项标题（`items` 与选项共用同一份，避免两处字面量漂移）。
 * Base UI 不给 `items` 时触发器里显示的是原始 value（`text` / `file`）。
 */
const KIND_LABELS: Record<string, string> = { text: '文本', file: '文件' }

/**
 * 「名称」列宽：手机上收窄（`w-[8rem]`，桌面 `w-[12.5rem]`）。
 *
 * 桌面给的 200px 在手机端太奢侈 —— 请求头的头名本身大多不长（`Content-Type`、`Accept`），
 * 而它们加上「类型 + 值 + 两个图标」的总宽一旦超过屏宽，整表就得横向滚。收窄这一列能省下
 * 十几个字符给值列，多数请求头在手机上一屏就能看全（真放不下时仍然横向滚动，见 `minWidth`）。
 *
 * 表头与每一行**共用这一个常量**：两处各写一份字面量，改一处忘了另一处，标题就会和内容错位。
 */
const COL_KEY = 'w-[8rem] md:w-[12.5rem]'

/**
 * 「类型」列宽（form-data 专用）。表头与行也用同一个常量，理由同上。
 */
const COL_KIND = 'w-[4.75rem]'

/**
 * 带补全的单元格（名称 / 值两列共用）。
 *
 * 补全列表是自绘的，**不是原生 `<datalist>`**（见文件头）。两个关键点：
 * 1. `onOpenAutoFocus` / `onCloseAutoFocus` 都 `preventDefault`：列表弹出 / 收起时焦点
 *    必须留在输入框里，否则一边打字一边弹窗会不停抢焦点；
 * 2. 列表项 `onMouseDown` 要 `preventDefault`：不这么做的话，鼠标按下的瞬间输入框先失焦、
 *    `onBlur` 把列表关掉，`onClick` 根本来不及触发（点了个寂寞）。
 */
function CellSuggestInput({
  value,
  onValueChange,
  suggestions,
  ...inputProps
}: Omit<ComponentProps<'input'>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (next: string) => void
  /** 候选；空 / 不传 = 这一格没有补全 */
  suggestions?: string[]
}) {
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(-1)
  /**
   * 下拉的宽度 = 这一格的宽度（聚焦时量一次）。
   *
   * 不用 Radix 的 `--radix-popover-trigger-width`：那个变量是 `PopoverTrigger` 挂上去的，
   * 这里用的是 `PopoverAnchor`（锚在一个裸 `<input>` 上，不想要 Trigger 那套按钮语义），
   * 拿不到那个变量 —— 拿不到时按它取宽度的写法会整条失效，宽度悄悄退回内容自适应。
   *
   * ⚠️ 这条注释**刻意不写出那个宽度工具类的字面量**：Tailwind v4 是按**原始文本**扫源码的
   * （不解析注释），注释里写一个「带占位省略号的任意值类名」会被它当成真类名、
   * 生成一条宽度取值非法的声明 —— 构建时冒一条 LightningCSS 警告，白扫一遍还落个脏规则。
   * 要举例子就用**合法**的 CSS，或者像这样绕着说。
   */
  const [width, setWidth] = useState<number | undefined>(undefined)

  /** 候选按当前输入过滤（包含匹配，够用），最多列 8 条免得盖住半屏 */
  const list = useMemo(() => {
    const all = suggestions ?? []
    const q = value.trim().toLowerCase()
    const hit = q ? all.filter((s) => s.toLowerCase().includes(q)) : all
    return hit.slice(0, 8)
  }, [suggestions, value])

  const open = focused && list.length > 0
  /**
   * 键盘高亮项。**`-1` = 没有显式选中**，这时列表一条都不高亮 ——
   * 别默认高亮第一条：用户手打完 `Accept-Encoding` 顺手敲回车，会被第一条
   * `Accept`（包含匹配）顶掉，等于悄悄改了他的输入。
   */
  const highlight = active >= 0 && active < list.length ? active : -1

  const pick = (next: string): void => {
    onValueChange(next)
    setFocused(false)
  }

  return (
    <Popover open={open} modal={false}>
      <PopoverAnchor asChild>
        <CellInput
          {...inputProps}
          value={value}
          autoComplete="off"
          onChange={(e) => {
            onValueChange(e.target.value)
            setActive(-1)
            // 选完一条之后列表是关着的（`focused` 被清掉了，但输入框其实还有焦点）；
            // 接着打字要能重新弹出来，所以这里补一次。
            setFocused(true)
          }}
          onFocus={(e) => {
            setFocused(true)
            setWidth(e.currentTarget.offsetWidth)
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (!open) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => (i < 0 || i >= list.length - 1 ? 0 : i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => (i <= 0 ? list.length - 1 : i - 1))
            } else if (e.key === 'Enter') {
              // 只有真的用 ↑↓ 选过才顶替输入，否则回车就该是「就这样」
              if (highlight < 0) return
              e.preventDefault()
              pick(list[highlight])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setFocused(false)
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={2}
        // 列表弹出 / 收起都不动焦点：焦点留在正在输入的那个单元格里（等价于 Radix 的
        // `onOpenAutoFocus` / `onCloseAutoFocus` 里各 preventDefault 一次）。
        initialFocus={false}
        finalFocus={false}
        style={{ width: width ? `${width}px` : undefined }}
        className="min-w-40 gap-0 rounded-md p-0.5"
      >
        {list.map((item, i) => (
          <button
            key={item}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(item)}
            onMouseEnter={() => setActive(i)}
            className={cn(
              'block w-full truncate rounded-sm px-1.5 py-1 text-left font-mono text-xs',
              i === highlight ? 'bg-accent text-accent-foreground' : 'text-foreground'
            )}
          >
            {item}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export interface KeyValueTableProps<T extends KeyValueRow> {
  rows: T[]
  /** 名称 / 值两列的占位文案（如「名称，如 Content-Type」） */
  keyPlaceholder: string
  valuePlaceholder: string
  /** 名称列的补全候选（逐行给；不传 / 返回空 = 无补全） */
  keySuggestions?: (row: T, index: number) => string[]
  /** 值列的补全候选（逐行给，候选按请求头名称算） */
  valueSuggestions?: (row: T, index: number) => string[]
  /** 「类型」列；不传 = 没有这一列（只有 form-data 用） */
  kindOf?: (row: T, index: number) => KindCell | null
  /** 值单元格的整格替换（form-data 的文件行：只读文件名 + 「选择文件」按钮）；返回 null = 用默认输入框 */
  renderValue?: (row: T, index: number) => ReactNode
  /** 改某一行的某个字段（`enabled` 也走这里，与 `key` / `value` 同一条路） */
  onPatch: (index: number, patch: Partial<T>) => void
  onRemove: (index: number) => void
}

export function KeyValueTable<T extends KeyValueRow>({
  rows,
  keyPlaceholder,
  valuePlaceholder,
  keySuggestions,
  valueSuggestions,
  kindOf,
  renderValue,
  onPatch,
  onRemove
}: KeyValueTableProps<T>) {
  const hasKindColumn = Boolean(kindOf)
  /**
   * 表格的**最小宽度**：窄屏（手机竖屏）上宁可整表横向滚动，也不把「名称 / 值」两列压成
   * 两个几像素宽的格子（挤在一起连自己填了什么都看不全）。值列下限给得比名称列宽 ——
   * 值才是内容最长的那一列。列宽都是 rem，跟着手机端抬高的根字号一起变大，所以这个
   * 下限在手机端也是等比例的（见 `styles.css` 里「手机端整体放大」那段）。
   *
   * 装得下（≥ 这个值）时它就是个普通的 `w-full` 表格，正常铺满、不出现滚动条。
   */
  const minWidth = hasKindColumn ? 'min-w-[34rem]' : 'min-w-[30rem]'
  /** 末行是不是「等着填」的空槽位：是的话不给勾选与删除按钮 */
  const isBlankRow = (row: T, index: number): boolean =>
    index === rows.length - 1 && !(row?.key ?? '').trim() && !(row?.value ?? '').trim()

  return (
    /*
     * 横向滚动层：这一层只负责 `overflow-x-auto`，**表头与所有行必须包在同一个内层里**
     * —— 分成两个滚动容器的话两边会各自滚，一横拖表头就跟行错位了。
     * `min-w-0` 不能省：作为 flex / grid 子项时默认 `min-width: auto`，不给 0 的话内层
     * 的 `min-w-[30rem]` 会把这个容器自己顶宽，`overflow-x` 就永远不触发、反而去撑破外面。
     */
    <div className="min-w-0 overflow-x-auto text-xs">
      <div className={cn('flex w-full flex-col', minWidth)}>
        {/* 表头：把「哪一列是什么」写出来，这是它和「一堆输入框」最直接的分别。
            文字列各带 px-1.5，与下面单元格输入框自己的内边距对齐 —— 否则标题会比内容
            整体左移 6px，一眼就能看出没对齐。 */}
        <div className="flex items-center gap-2 border-b border-border/60 px-1.5 pb-1 text-[0.6875rem] font-medium text-muted-foreground">
          <div className="w-4 shrink-0" />
          <div className={cn('shrink-0 px-1.5', COL_KEY)}>名称</div>
          {hasKindColumn && <div className={cn('shrink-0 px-1', COL_KIND)}>类型</div>}
          <div className="min-w-0 flex-1 px-1.5">值</div>
          <div className="w-7 shrink-0" />
        </div>

        <div className="flex w-full flex-col">
          {rows.map((row, i) => {
            const enabled = isRowEnabled(row)
            const blank = isBlankRow(row, i)
            const kind = kindOf?.(row, i) ?? null
            const customValue = renderValue?.(row, i)
            return (
              <div
                key={i}
                className={cn(
                  'group flex min-w-0 items-center gap-2 border-b border-border/40 px-1.5 last:border-b-0',
                  'transition-colors hover:bg-muted/40',
                  // 停用的行整行变淡 —— 一眼能看出「这行不参与发送」，但内容还在、还能改
                  !enabled && 'text-muted-foreground'
                )}
              >
                <div className="flex w-4 shrink-0 items-center justify-center">
                  {blank ? null : (
                    <Checkbox
                      checked={enabled}
                      onCheckedChange={(next) => onPatch(i, { enabled: next === true } as Partial<T>)}
                      title={enabled ? '停用该行（保留内容，不随请求发出）' : '启用该行'}
                      aria-label={enabled ? '停用该行' : '启用该行'}
                    />
                  )}
                </div>

                <div className={cn('shrink-0', COL_KEY)}>
                  <CellSuggestInput
                    value={row.key}
                    onValueChange={(next) => onPatch(i, { key: next } as Partial<T>)}
                    suggestions={keySuggestions?.(row, i)}
                    placeholder={keyPlaceholder}
                    aria-label="名称"
                  />
                </div>

                {/* 「类型」列放在值这一列**前面**：先决定这行是文本还是文件，再看/填值 */}
                {hasKindColumn && (
                  <div className={cn('shrink-0', COL_KIND)}>
                    {kind ? (
                      /* 高度必须写成 `data-[size=sm]:h-7`：`SelectTrigger` 自带的那条同变体规则
                         特异性更高，光写 `h-7` 会被它压掉（`cn` 只在**同变体同组**时才去重）。 */
                      <Select
                        value={kind.value}
                        items={KIND_LABELS}
                        onValueChange={kind.onChange}
                      >
                        <SelectTrigger size="sm" className={CELL_SELECT_TRIGGER} aria-label="字段类型">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">{KIND_LABELS.text}</SelectItem>
                          <SelectItem value="file">{KIND_LABELS.file}</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : null}
                  </div>
                )}

                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {customValue ?? (
                    <CellSuggestInput
                      value={row.value}
                      onValueChange={(next) => onPatch(i, { value: next } as Partial<T>)}
                      suggestions={valueSuggestions?.(row, i)}
                      placeholder={valuePlaceholder}
                      aria-label="值"
                    />
                  )}
                </div>

                <div className="flex w-7 shrink-0 items-center justify-center">
                  {blank ? null : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-6 text-muted-foreground hover:text-destructive"
                      title="删除该行"
                      aria-label="删除该行"
                      onClick={() => onRemove(i)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
