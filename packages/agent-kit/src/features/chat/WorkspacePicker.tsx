/**
 * 工作区选择器 —— **受控版**：只吃 props，完全不知道 `AgentApp` 的存在。
 *
 * 从 `ChatPanel` 里抽出来，是因为「定时任务」表单也要同一套控件（用户明确要求：把创建
 * 会话里的权限 / 模型 / 工作区 / MCP / 需求框复用到定时任务上）。那边没有 `AgentApp`，
 * 只能吃 `value` + `onChange`，所以这里**只做展示与交互**，数据从 props 进。
 *
 * `ChatPanel` 里的 `WorkspaceSelect` 现在是薄壳：把 `app` 里的数据灌进来，再加自己的
 * 副作用（切档回空会话、添加项目）。样式与结构只有这一份实现 —— 别再在别处手写一份
 * `CHAT_PILL`，两处一漂看着就是两个功能。
 *
 * 其余同样受控、同样一个文件一颗的几颗：
 * - `PermissionPill`：`composer.tsx`（没有下拉，就一颗按钮）；
 * - `ModelPicker`：`ModelPicker.tsx`（会话详情与定时任务共用一份）；
 * - `McpPicker`：`McpPicker.tsx`（同上）；
 * - `BrowserPicker`：`BrowserPicker.tsx`（同上）。
 *
 * ## 长相来自 `@fizz/ui/picker-panel`（不要在这里改行高 / 底色）
 *
 * 面板是「顶部固定搜索 → 中间滚动列表 → 底部固定动作」三段，搜索框带底色、行首一枚图标、
 * 底部一整组动作只切一条上边线。这些**全部在 `PickerPanel` 那套原语里定型**：以后凡是
 * 「点开能搜、能滚、底部带几条动作」的选择器都该用它，长相自然一致。本文件只负责：
 * 把 `app` 里的数据灌进去、按搜索词筛好、把动作项翻成 `PickerAction`。
 *
 * 「未指定工作区」与添加类动作**同属底部那一组**，中间不再切一刀：它也是一次「选择」
 * （选「不用现成目录」），和「加一个新目录」是同一层动作（2026-11 用户要求）。
 */
import type { AgentWorkspace } from '@fizz/contracts/agent-api'
import { Popover, PopoverTrigger } from '@fizz/ui/popover'
import {
  PickerAction,
  PickerEmpty,
  PickerFooter,
  PickerItem,
  PickerList,
  PickerPanel,
  PickerSearch
} from '@fizz/ui/picker-panel'
import { ChevronDown, Folder, FolderMinus, FolderOpen, FolderPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { CHAT_PILL } from '@fizz/agent-kit/features/chat/composer'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { t } from '@fizz/i18n'

export interface WorkspacePickerProps {
  /** 选中的工作区 id；`null` = 不用现成工作区（真正落地时自动建一个临时目录） */
  value: string | null
  /** 可选项：**由调用方筛好**（临时工作区不该出现在下拉里，见 ChatPanel） */
  workspaces: AgentWorkspace[]
  onChange: (id: string | null) => void
  /** 「不选」那一项的文案：聊天是「未指定工作区」，定时任务是「每次运行自动创建」 */
  emptyLabel?: string
  /** 触发器悬停说明（讲清「不选」到底会发生什么） */
  title?: string
  /**
   * 底部固定的动作项（选择文件夹 / 从 Git 导入…），点中走 `onAction`、不改变 value。
   * `icon` 由调用方给（动作的语义只有调用方知道），不传就是纯文字行。
   */
  actions?: { value: string; label: string; icon?: ReactNode }[]
  onAction?: (value: string) => void
  /**
   * 底部那条「新建工作区」：点它就等于去命令面板的「新建工作区」页。
   *
   * 不传就不画（定时任务表单走的是 `actions` 那一套，不要这条）。原样透传回调，
   * 具体「怎么开面板」不归本组件管 —— 聊天里是 `requestCommandPalette('new-workspace')`。
   */
  onNewWorkspace?: () => void
  /**
   * 远端工作区所在主机的展示名（从 SSH 主机清单里查）。返回空 = 主机已删除
   * （此时显示「主机已删除」，`dirMissing` 的文案也不一样）。
   */
  remoteHostName?: (workspace: AgentWorkspace) => string | null
  /**
   * 触发器形态：
   * - `pill`（默认）：输入行那种胶囊，用于横条 / 定时任务表单；
   * - `inline`：标题句里的文字入口（「在 ▁▁▁ 里做点什么？」）。未选工作区时是一枚
   *   **不依赖字符**的淡色空位条（字体换了也不会变形），选中后宽度补间、句子跟着重新居中。
   */
  variant?: 'pill' | 'inline'
  /**
   * 面板弹出方向：默认 `bottom`（聊天「开始新对话」页的标题句上方，向下展开顺手）；
   * 定时任务表单传 `top`，与同排的模型下拉一致（两者都是弹窗里的 pill）。
   * 空间不够时 Radix 仍会自动翻转到另一侧。
   */
  side?: 'top' | 'bottom'
  disabled?: boolean
}

/**
 * 标题句里那颗 token 的尺寸，全部按 `load.txt` 里 demo 的 CSS 折算成 em（原值按字号 48px）：
 *
 * | demo | 原值 | 这里 |
 * | --- | --- | --- |
 * | token 高度 | 64px | `1.333em` |
 * | 底色高度 / 垂直偏移 | 54.8px / +3.16px | `1.142em` / `+0.066em` |
 * | 左右内边距 | 4.8px / 13.44px | `0.1em` / `0.28em` |
 * | 图标窗宽 | 64.97px | `1.354em` |
 * | 文字起点 | 77.45px | `1.614em` |
 *
 * 圆角是 999px（胶囊）。没选工作区时里面只有图标，但胶囊留一段**空位**（`BLANK_WIDTH`）——
 * 太窄会只剩一个图标按钮，看不出「这里还没填」；选中后同一颗胶囊里出现名字。
 */
const BLANK_WIDTH = 56 // 空态胶囊的固定长度（图标之后只留一小段空位）
const TOKEN_TEXT_LEFT = 1.614
const TOKEN_PAD_RIGHT = 0.28
const TOKEN_MAX_WIDTH = 224 // 与 `max-w-[14rem]` 对齐

/** 按字素切分（demo 的 Torph 用 `Intl.Segmenter`；类型库里未必有，这里用结构类型取） */
type SegmenterLike = new (
  locale?: string,
  options?: { granularity: 'grapheme' }
) => { segment(input: string): Iterable<{ segment: string }> }

function splitGraphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterLike }).Segmenter
  if (Segmenter) {
    return Array.from(
      new Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (part) => part.segment
    )
  }
  return Array.from(text)
}

/**
 * 工作区 pill：一个下拉选「这条消息 / 这次运行落在哪个工作区」。
 *
 * 聊天里它挂在输入卡片**下面**、只在空会话出现；定时任务表单里它是普通的一颗 pill。
 * 两者语义一致：**`null` 不是一种归属**，只是「还没选」—— 真正的落地动作（建临时
 * 工作区）在服务端，前端只负责把这个意图送出去。
 *
 * 不长成下拉的 `Select` 也一样叫 Picker：这里四个选择器按「选什么」命名，不按控件形态。
 */
export function WorkspacePicker({
  value,
  workspaces,
  onChange,
  // 默认值在调用时求值：`t()` 读当前语言，切成英文后父级重渲染就会跟着变
  emptyLabel = t('未指定工作区'),
  title = t('工作区：Agent 只能读写这个目录里的东西'),
  actions,
  onAction,
  onNewWorkspace,
  remoteHostName,
  variant = 'pill',
  side = 'bottom',
  disabled
}: WorkspacePickerProps) {
  // 订阅语言（默认值里的 t() 只在本组件重渲染时才会重算）
  useT()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  /** 搜索词：只活在一次打开里（关面板就清空，下次打开是完整历史） */
  const [query, setQuery] = useState('')

  const current = value ? workspaces.find((workspace) => workspace.id === value) : undefined
  const label = current?.name ?? emptyLabel

  /** 名字 / 目录路径 / 远端主机名，任一处命中即保留（不区分大小写） */
  const keyword = query.trim().toLowerCase()
  const filtered = keyword
    ? workspaces.filter((workspace) =>
        [workspace.name, workspace.path, remoteHostName?.(workspace) ?? '']
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(keyword))
      )
    : workspaces

  const close = (): void => setOpen(false)

  /**
   * 标题句入口的宽度 —— **直接照抄** inline-text-morph 那颗 token 的做法（原实现见仓库
   * 根目录 `load.txt` 的 `InlineTextMorphEngine` / `inlineMorph`）：宽度不走 CSS transition，
   * 而是每帧按弹簧积分推进：
   *
   *   velocity += ((target - width) * 600 - velocity * 34) * step   // 每帧 4 个子步
   *   width    += velocity * step
   *
   * 常量全部沿用原实现（stiffness 600 / damping 34 / dt 上限 1/30、收敛阈值 0.02px 与
   * 0.05px/s），所以手感和它一致；句子是 flex 居中的，宽度一变整句自己重新居中。
   *
   * 宽度用不可见副本量（字体与标题一致），不拿字符去凑：`______` 那种占位在不同字体 /
   * 字号下长度完全不一样。上限与 `max-w-[14rem]` 对齐。
   */
  const measureRef = useRef<HTMLSpanElement>(null)
  const widthRef = useRef<HTMLButtonElement>(null)
  const spring = useRef({ width: 0, target: 0, velocity: 0, raf: 0, last: 0, started: false })

  const tickSpring = (now: number): void => {
    const s = spring.current
    const el = widthRef.current
    s.raf = 0
    if (!el) return
    const dt = Math.min(Math.max((now - s.last) / 1000, 0) || 1 / 60, 1 / 30)
    s.last = now
    const target = s.target
    for (let i = 0; i < 4; i++) {
      const step = dt / 4
      s.velocity += ((target - s.width) * 600 - s.velocity * 34) * step
      s.width += s.velocity * step
    }
    if (Math.abs(target - s.width) < 0.02 && Math.abs(s.velocity) < 0.05) {
      s.width = target
      s.velocity = 0
    } else {
      s.raf = requestAnimationFrame(tickSpring)
    }
    el.style.width = `${s.width}px`
  }

  const springTo = (target: number, immediate: boolean): void => {
    const s = spring.current
    const el = widthRef.current
    if (!el) return
    if (s.raf) cancelAnimationFrame(s.raf)
    s.raf = 0
    // 首次挂载 / 用户要求减少动效：直接落定（原实现的 initial / reduced 分支）
    if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      s.width = target
      s.target = target
      s.velocity = 0
      el.style.width = `${target}px`
      return
    }
    s.target = target
    el.style.width = `${s.width}px`
    s.last = performance.now()
    s.raf = requestAnimationFrame(tickSpring)
  }

  /** 字体晚到 / 主题换字体都要重新量：原实现同样在 `document.fonts` 就绪后重算宽度 */
  const [fontEpoch, setFontEpoch] = useState(0)
  useLayoutEffect(() => {
    let alive = true
    const recompute = (): void => {
      if (alive) setFontEpoch((n) => n + 1)
    }
    void document.fonts?.ready.then(recompute)
    document.fonts?.addEventListener('loadingdone', recompute)
    return () => {
      alive = false
      document.fonts?.removeEventListener('loadingdone', recompute)
    }
  }, [])

  useLayoutEffect(() => {
    const immediate = !spring.current.started
    spring.current.started = true
    // 名字宽 + 图标窗 + 左右内边距（后两者是 em，按当前字号折成 px）；上限 14rem
    const el = widthRef.current
    const fontSize = el ? Number.parseFloat(getComputedStyle(el).fontSize) || 16 : 16
    const chrome = (TOKEN_TEXT_LEFT + TOKEN_PAD_RIGHT) * fontSize
    // 没选工作区时给一段更长的空位（只画图标会像一颗纯图标按钮，看不出「还没填」）
    const target = current
      ? Math.max(1, Math.min(measureRef.current?.scrollWidth ?? 0, TOKEN_MAX_WIDTH - chrome)) +
        chrome
      : BLANK_WIDTH
    springTo(target, immediate)
    // `springTo` / `tickSpring` 每次渲染都是新的，但这里只吃名字与字体版本
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.name, fontEpoch])

  /** 图标的弹入层（demo 的 `renderIcon`：scale .4 → 1.1 → 1、rotate -16° → +5° → 0） */
  const iconRef = useRef<HTMLSpanElement>(null)
  /** 文字层：逐字素切开，换名字时每个字从下方顶上来（Torph 用 `Intl.Segmenter`，同口径） */
  const textRef = useRef<HTMLSpanElement>(null)
  const morphSeen = useRef(false)
  useLayoutEffect(() => {
    // 首次挂载不动（demo 的 `initial` 分支）：从别的页面切回来不该每次都被抬一下
    const first = !morphSeen.current
    morphSeen.current = true
    if (first) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // 时长 / 曲线照抄 demo：图标 300ms、文字 200ms，都是 (0.19, 1, 0.22, 1)
    const ease = 'cubic-bezier(0.19, 1, 0.22, 1)'
    iconRef.current?.animate(
      [
        { opacity: 0, transform: 'scale(0.4) rotate(-16deg)' },
        { opacity: 1, transform: 'scale(1.1) rotate(5deg)', offset: 0.65 },
        { opacity: 1, transform: 'scale(1) rotate(0deg)' }
      ],
      { duration: 300, easing: ease }
    )
    const chars = textRef.current?.querySelectorAll<HTMLElement>('[data-morph-char]')
    chars?.forEach((node, index) => {
      node.animate(
        [
          { opacity: 0, transform: 'translateY(0.35em)' },
          { opacity: 1, transform: 'none' }
        ],
        // 逐字错开一点点，跟 demo 里字母一个个到位的感觉一致（80ms 封顶）
        { duration: 200, delay: Math.min(index * 12, 80), easing: ease, fill: 'backwards' }
      )
    })
  }, [current?.name])

  const nameChars = current ? splitGraphemes(current.name) : []

  // 卸载时把 rAF 停掉（原实现的 destroy）
  useLayoutEffect(() => () => {
    const s = spring.current
    if (s.raf) cancelAnimationFrame(s.raf)
    s.raf = 0
  }, [])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        {variant === 'inline' ? (
          /*
            标题句里的 token —— 长相照抄 `load.txt` 里 demo 的 `.itm-token`（尺寸见文件头常量表）：

            - 胶囊底不是铺满整颗 token：它只有 1.142em 高、中心再往下 0.066em，圆角 999px
              （demo 用 `::before` 干这事，这里用一层绝对定位的 span）；
            - 左边一枚图标窗（1.354em），名字从 1.614em 处开始，右边留 0.28em；
            - 没选工作区时没有字，只剩图标与胶囊底 —— 不用下划线字符，换字体 / 换语言都不变形；
            - 宽度由弹簧逐帧写进 `style.width`（demo 的 tick 积分），整句 flex 居中会自己重排；
            - 换工作区时图标弹一下（scale .4 → 1.1 → 1 / -16° → +5° → 0），名字逐字从下方顶上来。
          */
          <button
            type="button"
            ref={widthRef}
            disabled={disabled}
            aria-label={t('工作区')}
            title={title}
            className={cn(
              'group relative isolate inline-flex max-w-[14rem] min-w-0 items-center self-center p-0',
              current ? 'text-primary' : 'text-muted-foreground'
            )}
            style={{ height: '1.333em' }}
          >
            {/* 胶囊底：高度 / 偏移 / 圆角全按 demo 的 ::before 折算 */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-1/2 -z-10 rounded-full bg-foreground/10 transition-colors duration-[180ms] group-hover:bg-foreground/15 group-active:bg-foreground/20 group-focus-visible:outline-2 group-focus-visible:outline-offset-4 group-focus-visible:outline-muted-foreground"
              style={{ height: '1.142em', transform: 'translateY(calc(-50% + 0.066em))' }}
            />
            {/* 量宽用的不可见副本（跟着标题字体走，所以宽度是准的） */}
            <span
              ref={measureRef}
              aria-hidden
              className="pointer-events-none invisible absolute w-max whitespace-nowrap"
            >
              {current?.name ?? ''}
            </span>
            {/* 图标窗：demo 里是彩色贴纸，这里用设计系统的文件夹图标，尺寸按同一比例。
                位置固定在最左边（与 demo 的 `.itm-icon-window` 一致），空态时右边留空位。 */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 inline-flex items-center justify-center"
              style={{ left: '0.1em', width: '1.354em' }}
            >
              <span ref={iconRef} className="inline-flex origin-center will-change-transform">
                <Folder className="size-[0.9em] shrink-0" />
              </span>
            </span>
            {/* 文字层：逐字素渲染，换名字时每个字从下方顶上来 */}
            <span
              ref={textRef}
              className="pointer-events-none absolute inset-y-0 flex items-center overflow-hidden leading-none whitespace-nowrap"
              style={{ left: '1.614em', right: '0.28em' }}
            >
              {nameChars.map((char, index) => (
                <span
                  key={`${index}:${char}`}
                  data-morph-char
                  className="inline-block shrink-0 will-change-transform"
                >
                  {char === ' ' ? '\u00a0' : char}
                </span>
              ))}
            </span>
          </button>
        ) : (
          /* 手写 button（不是 Select 了）：样式仍走 CHAT_PILL —— 前置图标、箭头大小 / 颜色
             必须和权限 / 模型那两颗 pill 对齐。触发器自己不渲染默认箭头，这里自己画一枚小的。 */
          <button
            type="button"
            className={cn(CHAT_PILL, 'disabled:cursor-not-allowed disabled:opacity-50')}
            disabled={disabled}
            aria-label={t('工作区')}
            title={title}
          >
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        )}
      </PopoverTrigger>
      {/*
        方向由调用方选（`side`，默认向下 + 6px）。

        聊天里工作区入口挂在「开始新对话」页的标题句上，下方就是输入框与页面留白，
        向下展开才顺手（向上会顶到标题上方的空白 / 窗口边）；定时任务表单在弹窗里，
        与同排的模型下拉一致向上弹。空间不够时 Radix 会自己翻到另一侧，不会出界。
      */}
      <PickerPanel
        side={side}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        footer={
          <PickerFooter>
            {/* 「不选」与下面几条添加动作**同属一组**，中间不切分隔线（见文件头注释） */}
            <PickerAction
              icon={<FolderMinus />}
              active={value === null}
              onClick={() => {
                close()
                // 判据是 `value === null`（真的没选），不是 `current` —— 后者在「选中的那个
                // 已不在清单里」时也是 undefined，那样点一下不会把那个死 id 清掉
                if (value !== null) onChange(null)
              }}
            >
              {emptyLabel}
            </PickerAction>
            {onNewWorkspace ? (
              <PickerAction
                icon={<FolderPlus />}
                // 先关面板：命令面板会盖在这块上面，留着只会两层面板叠着
                onClick={() => {
                  close()
                  onNewWorkspace()
                }}
              >
                {t('新建工作区')}
              </PickerAction>
            ) : null}
            {(actions ?? []).map((action) => (
              <PickerAction
                key={action.value}
                icon={action.icon}
                // 先关面板：这些动作会开自己的弹窗 / 系统目录框，面板留着只会压在上面
                onClick={() => {
                  close()
                  onAction?.(action.value)
                }}
              >
                {action.label}
              </PickerAction>
            ))}
          </PickerFooter>
        }
      >
        <PickerSearch
          // 打开面板即可打字（桌面上搜索框就是唯一的入口）。
          // 手机上**不**自动聚焦：软键盘会在面板定位之后才弹出，Radix 算出的可用高度
          // 里没有它 —— 面板会被顶到键盘底下。那边点一下输入框再搜。
          autoFocus={!isMobile}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索工作区')}
          aria-label={t('搜索工作区')}
        />
        <PickerList>
          {filtered.map((workspace) => {
            const selected = workspace.id === value
            // 远端主机 / 目录不可用两条提示合成一段，挤在名字右边（面板只有 18rem 宽）
            const hint = [
              workspace.remote ? `· ${remoteHostName?.(workspace) ?? t('主机已删除')}` : '',
              workspace.dirMissing
                ? workspace.remote
                  ? t('（远端目录不可用）')
                  : t('（目录不存在）')
                : ''
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <PickerItem
                key={workspace.id}
                value={workspace.id}
                icon={<Folder />}
                hint={hint || undefined}
                active={selected}
                // 选中即生效：先关面板再改归属（父级会顺手回空会话 / 建临时工作区）。
                // 点中的就是当前那个 → 只关面板：`selectWorkspace` 会再落一次盘，
                // 而这一行只在空会话出现，重复选同一个本来就没有意义。
                onSelect={() => {
                  close()
                  if (!selected) onChange(workspace.id)
                }}
              >
                {workspace.name}
              </PickerItem>
            )
          })}
          {filtered.length ? null : (
            <PickerEmpty>{keyword ? t('没有匹配的工作区') : t('还没有工作区')}</PickerEmpty>
          )}
        </PickerList>
      </PickerPanel>
    </Popover>
  )
}
