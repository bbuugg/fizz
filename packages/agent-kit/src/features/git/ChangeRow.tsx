/**
 * 「源代码管理」面板的**文件行**（从 GitPanel.tsx 抽出）。
 *
 * 独立成文件的理由：它是个 props 完备的纯展示组件（11 个入参、零外部状态），
 * 而 GitPanel 主组件有 30+ 个 state —— 混在一个文件里时，「改一行显示」要滑过 2000 行。
 * `STATUS_LABEL` / `statusTone` 跟着搬过来：全仓只有这里用它们（状态码 → 颜色与悬浮文案）。
 */
import type { ReactNode } from 'react'
import { Loader2, Minus, Plus, RotateCcw } from 'lucide-react'
import { t } from '@fizz/i18n'
import { Button } from '@fizz/ui/button'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
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
        行内的缩进只作用于左边的可滚动区域；右侧暂存 / 回退按钮始终固定在行尾，
        不随目录层级和横向滚动移动（类似 antd 表格的固定列）。
      */}
      <div className="flex items-center gap-1.5 rounded py-1 pr-1.5 hover:bg-foreground/5">
        <div className="min-w-0 flex-1 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={onToggle}
            style={changeTreeIndent(depth ?? 0)}
            className="flex w-max min-w-full items-center gap-2 pr-2 text-left"
          >
            <span
              className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', statusTone(letter))}
              title={STATUS_LABEL[letter] ? t(STATUS_LABEL[letter]) : letter}
            >
              {letter}
            </span>
            <span className="whitespace-nowrap text-sm" title={fullTitle}>
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
        </div>
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
      {open && children}
    </div>
  )
}
