/**
 * 「源代码管理」面板的**文件行**（从 GitPanel.tsx 抽出）。
 *
 * 独立成文件的理由：它是个 props 完备的纯展示组件（11 个入参、零外部状态），
 * 而 GitPanel 主组件有 30+ 个 state —— 混在一个文件里时，「改一行显示」要滑过 2000 行。
 * `STATUS_LABEL` / `statusTone` 跟着搬过来：全仓只有这里用它们（状态码 → 颜色与悬浮文案）。
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { FileText, Loader2, Minus, Plus, RotateCcw } from 'lucide-react'
import { t } from '@fizz/i18n'
import { Button } from '@fizz/ui/button'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import {
  captureFileRowScroll,
  restoreFileRowScroll,
  type FileRowScrollAnchor
} from '@fizz/agent-kit/features/git/file-row-scroll'
import { changeTreeIndent } from '@fizz/agent-kit/shared/lib/git-change-tree'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { GitChange } from '@fizz/git'

/** git 状态码 → 人话（鼠标悬停时显示） */
const STATUS_LABEL: Record<string, string> = {
  M: '修改',
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  U: '冲突',
  '?': '未跟踪'
}

/** 状态码 → 颜色（省略号那类不认识的码留默认色，别崩） */
export function statusTone(code: string): string {
  if (code === '?' || code === 'A') return 'text-emerald-500'
  if (code === 'D') return 'text-red-500'
  if (code === 'U') return 'text-amber-500'
  return 'text-muted-foreground'
}

/** 一组变更（已暂存 / 未暂存）里的一个文件行：点行看 diff，右侧是（取消）暂存与回退 */
export function ChangeRow({
  change,
  letter,
  open,
  onToggle,
  onToggleStage,
  onRollback,
  onOpenFile,
  openFileLabel,
  staged,
  stageLabel,
  rollbackLabel,
  busy,
  depth,
  shortLabel,
  children
}: {
  change: GitChange
  letter: string
  open: boolean
  onToggle: () => void
  onToggleStage: () => void
  onRollback: () => void
  /** 给了才渲染「打开文件」按钮（删除态 / 虚拟工作区 / 工作区外文件由调用方不传） */
  onOpenFile?: () => void
  /** 「打开文件」按钮的 IconTip 文案与 aria-label */
  openFileLabel?: string
  /** 这一行属于「已暂存的更改」组（右侧按钮变「取消暂存」） */
  staged: boolean
  stageLabel: string
  rollbackLabel: string
  /** 这一行正在忙什么（两个按钮都禁掉，转圈只转在点的那一个上） */
  busy: 'stage' | 'rollback' | null
  /** 树状视图里的层级（0 = 顶层）；平铺时传 0 */
  depth?: number
  /**
   * 树状视图下只显示文件名（目录名已经在父目录行里了，再把整条路径重复一遍纯属噪音）；
   * 平铺时留空，显示完整路径。重命名 / 复制的旧名会自动取同名规则（`origPath` 的末段）。
   */
  shortLabel?: string
  children?: ReactNode
}) {
  const scrollAnchorRef = useRef<FileRowScrollAnchor | null>(null)
  useLayoutEffect(() => {
    // 只补偿这次展开/收起；异步 diff 返回时不再拉回用户后来滚动到的位置。
    const anchor = scrollAnchorRef.current
    scrollAnchorRef.current = null
    restoreFileRowScroll(anchor)
  }, [open])

  const fullTitle = change.origPath ? `${change.origPath} → ${change.path}` : change.path
  const showName = shortLabel ?? change.path
  const showOrig = change.origPath
    ? shortLabel
      ? (change.origPath.split('/').pop() ?? change.origPath)
      : change.origPath
    : undefined
  return (
    <div>
      {/*
        行内缩进只作用于文件按钮；右侧暂存 / 回退操作始终固定在行尾，不随目录层级移动。
      */}
      <div
        className={cn(
          // 与「文件」页文件树的行（`FileTreeRow` 的 `TreeRow`）同一套骨架与色板：
          // 同字号 / 同内外边距 / 无圆角、hover 与选中都用同一档前景色叠加。
          //
          // 高度固定成 `h-7`（= 文件行的 `py-1` + `text-sm` 行高 = 1.75rem）而不是用 `py-1`：
          // 行尾那几颗 `size-6` 的操作按钮是 1.5rem，撑出来会比文件行高 4px —— 两个页签
          // 来回切时一眼就看得出「git 的行更高」。
          //
          // `relative` 是行尾动作浮层的定位基准（见下面那层 `absolute` 容器）。
          'group/row relative flex h-7 items-center gap-1.5 pr-2 text-sm',
          open ? 'bg-primary/15 text-foreground' : 'text-foreground',
          'hover:bg-foreground/10'
        )}
      >
        <button
          type="button"
          onClick={(event) => {
            // 上方的旧 diff 会同时收起；提交布局后补偿位移，别把刚点击的文件带出视口。
            scrollAnchorRef.current = captureFileRowScroll(event.currentTarget)
            onToggle()
          }}
          title={fullTitle}
          style={changeTreeIndent(depth ?? 0)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span
            className={cn('w-4 shrink-0 text-center font-mono text-xs font-semibold', statusTone(letter))}
            title={STATUS_LABEL[letter] ? t(STATUS_LABEL[letter]) : letter}
          >
            {letter}
          </span>
          {/* 平时路径吃满整行；hover 整行时才让出浮层那一段 */}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm transition-[padding]',
              // 让位宽度与下面的浮层一一对应：3 颗按钮（24px × 3 + gap-0.5）或 2 颗
              onOpenFile
                ? 'group-hover/row:pe-24 [@media(hover:none)]:pe-24'
                : 'group-hover/row:pe-18 [@media(hover:none)]:pe-18'
            )}
            title={fullTitle}
          >
            {/* 重命名 / 复制：把旧名一并显示（只 hover 提示的话，光看一列新名字看不出改过名） */}
            {change.origPath ? (
              <>
                <span className="text-muted-foreground">{showOrig}</span>
                <span className="text-muted-foreground"> → </span>
                <span>{showName}</span>
              </>
            ) : (
              showName
            )}
          </span>
        </button>
        {/*
          行尾动作：**绝对定位**在行右缘、hover 整行才浮现（与侧栏会话行同一套）。

          这几颗按钮此前留在 flex 流里，即使 `opacity-0` 也照样各占 24px —— 路径被三个
          图标位提前截断，hover 才出现的按钮却全程在吃宽度。改成浮层后平时路径吃满整行，
          hover 时靠名字的 `pe-*` 让位；浮层自带从面板底色渐隐过去，文字不会硬贴在按钮下。
        */}
        <div
          className={cn(
            // 浮层自身**不带底色**：名字已经用 `pe-*` 让位，不需要渐隐遮字；
            // 带 `from-background` 的渐隐底会在 hover 时把行尾盖成面板底色（灰底断开一截）
            'pointer-events-none absolute right-0 top-0 flex h-full items-center gap-0.5 pl-4 pr-1.5',
            'opacity-0 transition-opacity',
            'group-hover/row:pointer-events-auto group-hover/row:opacity-100',
            // 触摸设备没有 hover 态，按钮常显（判的是能力而不是视口宽度）
            '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100'
          )}
        >
          {onOpenFile && (
            <IconTip label={openFileLabel ?? t('在文件面板中打开 {path}', { path: change.path })}>
              <Button
                variant="ghost"
                className="size-6! shrink-0 p-0! text-muted-foreground"
                aria-label={openFileLabel ?? t('在文件面板中打开 {path}', { path: change.path })}
                onClick={onOpenFile}
              >
                <FileText className="size-3.5" />
              </Button>
            </IconTip>
          )}
          <IconTip label={stageLabel}>
            <Button
              variant="ghost"
              className="size-6! shrink-0 p-0!"
              aria-label={stageLabel}
              disabled={busy !== null}
              onClick={onToggleStage}
            >
              {busy === 'stage' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : staged ? (
                <Minus className="size-3.5" />
              ) : (
                <Plus className="size-3.5" />
              )}
            </Button>
          </IconTip>
          {/* 回退（丢掉这个文件的未提交改动）：破坏性，点它只弹确认框，真正动手在确认之后 */}
          <IconTip label={rollbackLabel}>
            <Button
              variant="ghost"
              className="size-6! shrink-0 p-0! text-muted-foreground hover:text-destructive"
              aria-label={rollbackLabel}
              disabled={busy !== null}
              onClick={onRollback}
            >
              {busy === 'rollback' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
            </Button>
          </IconTip>
        </div>
      </div>
      {open && children}
    </div>
  )
}
