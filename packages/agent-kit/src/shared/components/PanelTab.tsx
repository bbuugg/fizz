/**
 * 面板标签条上的**一颗标签** —— 主区域多标签面板（`app/layout/PanelView`）与对话右侧
 * 多标签面板（`features/chat/SidePanel`）共用同一份。两条标签条此前各写一套：底色 / 圆角 /
 * 名字截断的让位都还算好抄，**最容易走样的恰恰是行尾那颗关闭 ×**（一处内联常占位、一处
 * 绝对定位浮层，hover 底色也各写各的）。收到这里之后，两处的标签在肉眼上就是同一套控件。
 *
 * ## 行尾浮层（关闭 × 及其左侧的 `actions`）是**绝对定位 + 不透明渐变底**
 *
 * 这一层现在装两样东西：`onClose` 的关闭 ×，以及 `actions` 传进来的行内动作（文件面板的
 * 「从磁盘重新读取」就挂在 × 左侧）。两者**共用同一个浮层**，于是显隐、渐变底、开合时序
 * 天生一致 —— 分开写两份迟早会漂成「一颗先出现、另一颗晚半拍」。
 *
 * 与会话行（`AgentSidebar` 的 `renderConversationRow`）同一套做法：× 平时 `opacity-0`，
 * hover 整颗标签才浮现，且浮层自带一条从标签底色渐隐到透明的底。放在 flex 流里的话，
 * 即便 `opacity-0`（只是不可见）也照样占一格 —— 名字被提前截断，而空出来的地方什么也没有。
 *
 * 渐变底是必需的（用户报的 bug）：长名字被 `truncate` 截成省略号时，如果浮层是**全透明**的，
 * 那颗 × 就直接压在文字尾巴上，两个字叠在一起谁也看不清。渐变底的颜色按标签**自己的**
 * 底色取（选中态是 `secondary`，未选中态压在面板底色 `background` 上），右端不透明、
 * 往左渐隐 —— 于是 × 下面永远是干净的底色，名字的尾巴则被渐隐盖住。名字自己再用
 * `pe-7` 让出一段（配合 `hover-reveal` 的跑马灯，见下）。
 *
 * ## 让位 padding 只在**名字真的被截断**的标签上、且只在 hover 时占位
 *
 * 历史：最早是 `group-hover/tab:pe-7` + `transition-[padding]`（不 hover 不吃 padding）。
 * 它把**自适应宽度**的短标签 hover 时整个撑宽 ~28px、后面所有标签跟着往右跳 —— 用户报的
 * 「鼠标一指上去标签长度就变」（好几个面板都有）。于是改成**常驻**让位：几何稳了，但代价是
 * **没 hover 时右缘也恒留一段空位**，长名字被提前截断一截 —— 用户看到的正是这个。
 *
 * 现在两头都要，靠两条判据同时成立：
 *
 * 1. **只有名字被截断的标签才让位**（`isNameTruncated` 实测，见下面的测量 effect）。
 *    被截断 ⟹ 名字的自然宽度已经顶到 `max-w-52` 上限 ⟹ 标签宽度**由上限决定、与 padding
 *    无关**，所以给这类标签 hover 时加 padding **不会改变标签宽度**（只是名字自己截得更早，
 *    尾巴由跑马灯滑出来，见 `hover-reveal`）。短名字的标签压根不加这段 —— 它本来就不截断，
 *    也就没有「撑宽往右跳」的问题。
 * 2. **padding 是 `group-hover/tab:` 的，不是常驻**：不 hover 时名字吃满整条标签，hover
 *    才让出浮层那一段（此时浮层已经盖上来，那段本来也看不见）。
 *
 * 于是「不 hover 时名字显示更多」与「几何不随鼠标进出变化」同时成立。
 *
 * 同一条理由也适用于「只有激活标签才有 × 左侧动作」：那会让标签宽度随「谁被激活」变化，
 * 与 hover 撑宽是同一类毛病，所以 `actions` 一律**每颗标签都给**（文件面板的刷新即如此）。
 *
 * ## 触摸设备
 *
 * 没有 hover 能力（`hover: none`）时 × **常驻**（就是下面那条 `hover:none` 的常驻分支）：
 * Tailwind v4 把 `hover:` / `group-hover:` 变体包进 `@media (hover: hover)`，触摸端那两条
 * 规则会被媒体查询整个排除，只留基座的 `opacity-0` —— 按钮永远隐形，标签关不掉（实测过）。
 * 判据用**能力**（`hover: none`）而不是视口宽度（`max-md`）：触屏笔记本既窄又有鼠标。
 *
 * 同一层浮层既然常显，让位 padding 在触摸端也只能**常驻**（`[@media(hover:none)]:pe-*`）：
 * 那里没有「hover 才出现」这回事，留白是真被按钮用掉的。桌面端那条 `group-hover/tab:pe-*`
 * 则被 `@media (hover: hover)` 排除掉，两端互不干扰。
 *
 * ## 名字能不能滑
 *
 * `data-name-text` 是给 `shared/lib/hover-reveal.ts` 定位「要被滑动的那个」用的：hover
 * 整颗标签时，名字若被截断就自己滑到行尾（跑马灯），移开复位。这里在根节点上挂
 * `onMouseEnter` / `onMouseLeave` 代劳，调用方不必各自再接一遍。
 */
import { type ComponentProps, type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Input } from '@fizz/ui/input'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { isNameTruncated, resetTruncatedName, revealTruncatedName } from '@fizz/agent-kit/shared/lib/hover-reveal'
import { RowActionButton } from '@fizz/agent-kit/shared/components/RowAction'
import type { TabStatus, TabStatusTone } from '@fizz/agent-kit/shared/lib/tab-decorations'

/**
 * 状态点的语义色。只在这里定一次 —— 标签条（主区域 / 侧栏）共用同一套视觉，
 * 外部（`tab-decorations.ts`）只能选 `tone`，不能自带颜色，免得同一排标签里出现
 * 三种「绿」。
 */
const STATUS_TONE: Record<TabStatusTone, string> = {
  busy: 'bg-primary animate-pulse',
  waiting: 'bg-amber-500',
  ok: 'bg-emerald-500',
  error: 'bg-destructive'
}

export interface PanelTabProps extends ComponentProps<'div'> {
  /** 是否是当前活动标签（底色更实） */
  active: boolean
  /**
   * 视觉变体：
   * - `'pill'`（默认）：圆角 + 灰底选中态 —— 对话右侧 `SidePanel`、文件面板的标签条用它；
   * - `'tab'`：**方形 + 顶部 2px 主色横条** —— 主区域 `PanelView` 用它，与参考实现（dogi）
   *   的主面板标签同款（dogi 的侧栏标签仍是圆角，所以这不是全项目替换，是按标签条选）。
   */
  variant?: 'pill' | 'tab'
  /** 标签条上的短名 */
  label: string
  /** 悬停提示（更完整的描述） */
  title: string
  /** 类型图标：一列标签里混着「对话 / 主机 / 终端」几种东西，光看名字分不出来 */
  icon: ReactNode
  /**
   * 图标右上角的状态点（终端活着 = 绿、已退出 = 红）。**绝对定位**盖在图标上，
   * 不参与布局 —— 标签的 `min-w` / hover 让位 / 截断那套几何必须与没有它时完全一致
   * （见文件头「宽度必须稳定」）。
   */
  status?: TabStatus
  /** 点标签：切过去 */
  onActivate: () => void
  /** 关闭这一颗；不传则不渲染关闭 × */
  onClose?: () => void
  /**
   * 关闭 × **左侧**的行内动作（文件面板的「从磁盘重新读取」走这里）。
   *
   * 与 × 同处一个浮层：**同样只在 hover 整颗标签时浮现**（触摸设备常显）。刻意不做成
   * 「只有激活标签才有」—— 那会让标签宽度随「谁被激活」变化，与下面 `pe-7` 那条
   * 「宽度必须稳定」是同一条理由。
   *
   * 传了它名字的让位会相应加宽（见下面 `showActions` 的 padding 分支）。
   */
  actions?: ReactNode
  /** 就地重命名态：显示输入框而不是「图标 + 名字」（主区域标签支持，侧栏标签暂不支持） */
  renaming?: boolean
  /** 重命名草稿 */
  renameValue?: string
  onRenameChange?: (value: string) => void
  /** 提交重命名（回车 / 失焦） */
  onRenameSubmit?: () => void
  /** 放弃重命名（Esc） */
  onRenameCancel?: () => void
  /**
   * 重命名输入框的 ref。
   *
   * 存在的唯一理由：**`autoFocus` 在这里不一定抢得到焦点**。标签的重命名是从右键菜单
   * 点进来的，而 Radix 模态菜单的 `FocusScope` 在**退场动画期间仍然活着**（`Presence`
   * 要等 `animationend` 才卸载内容），它会立刻把任何外部 `focus()` 拽回菜单项 ——
   * 于是输入框挂出来时是「有框、没焦点」。调用方要等菜单真正卸载后（`onCloseAutoFocus`）
   * 拿这个 ref 再补一次焦点，见 `PanelView` 的 `onCloseAutoFocus`。
   */
  renameInputRef?: Ref<HTMLInputElement>
  /**
   * 叠在标签之上的额外内容（主区域的拖拽落区提示走这里）。
   * 关闭 × 之后渲染，所以调用方给的东西要自带 `pointer-events-none`。
   */
  children?: ReactNode
}

export function PanelTab({
  active,
  variant = 'pill',
  label,
  title,
  icon,
  status,
  onActivate,
  onClose,
  actions,
  renaming = false,
  renameValue = '',
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  renameInputRef,
  className,
  onMouseEnter,
  onMouseLeave,
  children,
  ...rest
}: PanelTabProps): React.ReactElement {
  /** 是否有那颗关闭 ×（重命名态不显示）。也决定名字要不要为它让出这段留白。 */
  const showClose = !renaming && !!onClose
  /** 是否有 × 左侧那组行内动作；它和 × 共用同一个浮层与同一套显隐 */
  const showActions = !renaming && actions != null
  /** 行尾浮层要不要渲染（有 × 或有行内动作） */
  const showTrailing = showClose || showActions

  /**
   * 名字**此刻是否被截断**（实测，见文件头第 1 条）。只有它会决定 hover 时要不要让位：
   * 没被截断的标签一让位就会整颗撑宽（后面标签跟着跳），被截断的不会（宽度已由上限定）。
   */
  const [nameTruncated, setNameTruncated] = useState(false)
  const nameRef = useRef<HTMLSpanElement | null>(null)
  /** 指针是否停在本标签上 —— 量截断时要避开让位 padding 生效的这段（见下面测量函数） */
  const hoveredRef = useRef(false)

  /**
   * 量「名字有没有被截断」。
   *
   * ⚠️ **必须按「没有让位 padding」的几何量**：让位是 `group-hover/tab:` 的，指针若正停在本
   * 标签上，`tailDistance` 会把那段 padding 减掉、量出偏小的可用宽度（把不截断的名字判成截断，
   * 于是它下次 hover 就被撑宽）。所以 hover 期间一律不量（`hoveredRef`），退出时补一次。
   *
   * 判据直接用 `hover-reveal` 的 `isNameTruncated`：它读的是 `padding-inline-end` 与
   * `scrollLeft`，静止时正好等于「文字右缘 − 内容盒右缘」，与跑马灯同一套测量，不另立标准。
   */
  const measureTruncation = useCallback(() => {
    setNameTruncated(isNameTruncated(nameRef.current))
  }, [])

  /*
   * 名字长度（`label`）或标签宽度变了都要重量：标签条被拖窄、窗口缩放、字体加载完都会改变
   * 可用宽度，而 `ResizeObserver` 正好覆盖这几种。标签宽度由内容撑开时不会因为 hover 的
   * padding 变化（被截断的标签宽度由上限定，见文件头），所以这里不用担心量到被污染的值。
   */
  useEffect(() => {
    measureTruncation()
    const el = nameRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!hoveredRef.current) measureTruncation()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [measureTruncation, label])

  return (
    <div
      /*
       * `{...rest}` 放在前面：调用方从 Radix `asChild` 或拖拽源带进来的 `ref` / `onContextMenu`
       * 等原样透到根节点上，下面显式的鼠标处理器与 `className` 覆盖它们。
       */
      {...rest}
      onMouseEnter={(e) => {
        hoveredRef.current = true
        onMouseEnter?.(e)
        revealTruncatedName(e.currentTarget)
      }}
      onMouseLeave={(e) => {
        hoveredRef.current = false
        onMouseLeave?.(e)
        resetTruncatedName(e.currentTarget)
        // 让位 padding 刚撤掉，等一帧重量（同一帧里 `:hover` 的样式未必已落地）
        window.requestAnimationFrame(measureTruncation)
      }}
      className={cn(
        // `relative` 是行尾关闭浮层的定位基准；`min-w-0` 让名字能被截断
        'group/tab relative flex min-w-0 items-center transition-colors',
        // `h-7`：标签的**固定高度**。两处标签条（主区域 `PanelView` / 侧栏 `SidePanel`）都
        // 按这个来 —— 以前侧栏那份不设高度，被内容撑成比主区域矮一截，肉眼上就不是同一套
        // 控件了。高度是「这颗粒子长什么样」的一部分，收进共享组件，别留给调用方各写各的。
        'h-7',
        variant === 'tab'
          ? cn(
              /*
               * 方形标签 + 顶部 2px 主色横条（主区域 `PanelView`，对齐 dogi 的主面板标签）。
               *
               * 横条走 `border-t-2` + `border-t-primary` / `border-t-transparent`，**不用**
               * 绝对定位的色块：未激活时也必须占住这 2px，否则切换标签时内容会上下跳 2px。
               * 外框高度不受影响 —— 标签是 `h-7`，而 preflight 把 `box-sizing` 设成
               * `border-box`，多出来的边框吃的是内容盒。
               */
              'border-t-2',
              active
                ? 'border-t-primary bg-primary-soft text-foreground'
                : 'border-t-transparent text-muted-foreground hover:bg-primary-soft'
            )
          : cn(
              'rounded-md',
              active ? 'bg-primary-soft text-foreground' : 'text-muted-foreground hover:bg-primary-soft'
            ),
        className
      )}
    >
      {renaming ? (
        <Input
          ref={renameInputRef}
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange?.(e.target.value)}
          // 在输入框里拖选文字不该把整颗标签拖起来（dragstart 会冒泡到标签这个拖拽源）
          onDragStart={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameSubmit?.()
            else if (e.key === 'Escape') onRenameCancel?.()
          }}
          onBlur={onRenameSubmit}
          className="mx-1 h-5.5 w-36 min-w-0 px-1.5 py-0 text-sm"
        />
      ) : (
        <button
          type="button"
          title={title}
          aria-pressed={active}
          onClick={onActivate}
          className="flex min-w-20 items-center gap-1.5 px-2 py-0.5 text-sm"
        >
          {/*
            图标尺寸在共享组件里**统一**成 `size-3.5`：调用方各传各的（主区域 `size-3.5`、
            侧栏 `size-4`），不归一的话同一条标签在两处的图标大小就对不上。`[&>svg]:size-3.5`
            比 svg 自己那个 `size-4` 多一个类型选择器（0,1,1 > 0,1,0），所以压得过调用方的尺寸。

            ⚠️ `inline-flex items-center` 不是装饰，是**对齐用**的。图标在 `<span>` 里是
            inline 级盒子，会按**基线**排进这一行的 line box（`text-sm` 的行高 20px，基线约在
            14px 处）：svg 的基线是它的下边缘，于是被顶高约 3px；而 `TypingBubble` 这种
            `inline-flex` 的基线取自内部第一个子项（那几个没有文字的圆点），于是被压低约 3px。
            两者方向相反，一个「看着偏高」一个「明显偏下」—— 用户报的就是后者。把这一格改成
            flex 容器，图标成了 flex 项，靠 `items-center` 居中，基线彻底不参与，谁传进来都
            落在同一根中线上。

            `relative` 只为下面那颗状态点定位：点是**绝对定位**的，图标本身仍是原来的
            `size-3.5` 盒子 —— 标签宽度、hover 让位、截断测量都不受它影响。
          */}
          <span className="relative inline-flex shrink-0 items-center justify-center [&>svg]:size-3.5">
            {icon}
            {/*
              6px（`size-1.5`）的小点，压在图标右上角，半颗盖在图标上。尺寸刻意不跟着图标
              缩放：再小就在 1x 屏上糊成一粒灰，再大就把图标盖住了。
            */}
            {status && (
              <span
                className={cn(
                  'absolute -right-0.5 -top-0.5 size-1.5 rounded-full',
                  STATUS_TONE[status.tone]
                )}
                title={status.label}
                aria-label={status.label}
                role="img"
              />
            )}
          </span>
          {/*
            名字要能滑，就得是溢出裁剪的**滚动容器**：`truncate` 的 `overflow:hidden`
            正好满足（见 hover-reveal 文件头第 1 条）。

            ⚠️ 让位用的是这个 span 自己的 `padding-inline-end`，**不能**挪到外层 `button`
            上、也**不能**改成 margin：`hover-reveal` 的 `tailDistance` 读的正是它。

            ⚠️ 这段让位**只在名字被截断时、且只在 hover 时**才占位（见文件头）：不 hover
            时名字吃满整条标签（这正是用户要的「别因为看不见的按钮提前截断」）；被截断 ⟹ 标签
            已顶到宽度上限 ⟹ 加这段 padding 不会改变标签宽度，所以也不会「鼠标一进来整条标签
            就变宽」。**别改回常驻 `pe-7` / `pe-12`**（那就是「不 hover 也白白少显示一截」）。
          */}
          <span
            ref={nameRef}
            data-name-text
            className={cn(
              'min-w-0 truncate',
              showTrailing &&
                nameTruncated &&
                (showActions ? 'group-hover/tab:pe-12' : 'group-hover/tab:pe-7'),
              // 触摸设备没有 hover 态：浮层**常显**（按钮也更大），让位只能常驻 —— 但同样只给
              // 被截断的名字（浮层一直盖着，那段留白是实打实在用的）
              showTrailing && (showActions ? '[@media(hover:none)]:pe-16' : '[@media(hover:none)]:pe-9')
            )}
          >
            {label}
          </span>
        </button>
      )}

      {/*
        行尾浮层：**绝对定位**在标签右缘、hover 整颗标签才浮现 —— × 与 `actions` 共用这一层
        （两颗一起浮现 / 一起消失，不会一颗在另一颗不在这）。渐变底的取色跟着标签自己的
        选中态走（见文件头）。
      */}
      {showTrailing && (
        <div
          className={cn(
            // ⚠️ 这层浮层的圆角必须与标签根**同值**：它是整高矩形，右缘与标签右缘重合；
            // 不跟着走的话它会把标签右上 / 右下那两道圆角盖成直角 —— 表现为「hover 一出现
            // 关闭 ×，标签就没圆角了」（用户报的 bug）。方形变体（`variant='tab'`）下
            // 标签根本来就没有圆角，浮层也不加。
            'pointer-events-none absolute right-0 top-0 flex h-full items-center gap-0.5 px-1',
            variant === 'pill' && 'rounded-r-md',
            // 不透明渐变底：右端是标签自己的底色，往左渐隐（见文件头）
            'bg-gradient-to-l from-70% to-transparent',
            // 渐隐底必须跟着标签**当下**的底色走：选中用主题色淡底；未选中平时是透明的
            // （露出标签条的 background），hover 时会铺上 primary-soft —— 所以鼠标 hover 时
            // 渐变也切成 primary-soft，否则右缘那 30% 会是一条与标签底色对不上的白边。
            // 触屏没有 hover：未选中项靠 `[@media(hover:none)]` 常显，渐变保持 background 才对。
            active
              ? 'from-primary-soft'
              : 'from-background group-hover/tab:from-primary-soft',
            'opacity-0 transition-opacity',
            'group-hover/tab:pointer-events-auto group-hover/tab:opacity-100',
            '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100'
          )}
        >
          {/* 行内动作在 × **左侧**（文件面板的「从磁盘重新读取」） */}
          {showActions && <div className="flex items-center gap-0.5">{actions}</div>}
          {showClose && onClose && (
            <RowActionButton
              title={`关闭${label}`}
              aria-label={`关闭${label}`}
              className="hover:text-destructive"
              onClick={onClose}
            >
              <X className="size-3.5" />
            </RowActionButton>
          )}
        </div>
      )}

      {children}
    </div>
  )
}