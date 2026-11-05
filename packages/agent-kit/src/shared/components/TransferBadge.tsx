/**
 * 「SFTP 传输」入口：一个徽标 + 一张传输清单弹层。桌面 / Web 挂在底部状态栏，
 * 手机壳（`apps/mobile`）挂在顶栏 —— 与 `BackgroundTasksBadge` 同一套形态。
 *
 * ## 为什么从「右下角浮层」改成状态栏徽标
 *
 * 原来的 `TransferTray` 是一张 `fixed` 浮层：只要有一条传输就常驻右下角，**没有收起态**，
 * 挡住正文右下角那块（终端 / 文件列表的行尾操作就在那儿）。改成状态栏徽标后：
 * 一条传输都没跑时整颗不渲染；跑着时只占底栏一行（`传输 N`），要看进度才点开 ——
 * 与「后台任务」完全一致的心智，两端也共用同一份组件。
 *
 * **为什么是全局的**：传输活得比发起它的组件长 —— 用户把 SFTP 面板关掉、切到别的标签，
 * 传输仍在跑。没有一个常驻的可见入口，那些传输就成了「看不见也停不掉」的后台任务。
 * 所以它挂在应用外壳里（`app-shell.tsx` 的 `actions` 槽），数据来自 store 的 `transfer` slice。
 *
 * ⚠️ **不持久化**（见 `slices/transfer.ts` 文件头）：活跃传输绑在进程上，刷新后本来就断了。
 *
 * ## 手机上它也在，只是换了条栏
 *
 * 手机壳没有底部状态栏（`apps/mobile/src/styles.css` 把 `--status-bar-height` 压成 0），
 * 而这颗徽标恰恰是「关掉面板、切走标签之后唯一还能告诉你传输还在跑」的东西，不能跟着
 * 那条栏一起消失 —— 它被挂到 `MobileAppBar` 右端（新建对话左边）。
 *
 * 于是与后台任务徽标同样两个入参：弹层**朝下**展开（`side="bottom"`）、宽度按视口收
 * （`contentClassName`）。其余没有任何手机分支。
 *
 * ## 空闲时不占地方
 *
 * 一条传输都没有就回 `null`（与后台任务徽标同一个原则）：徽标是「有事才出现」的东西，
 * 常驻一个空壳只会挤占底栏。
 */
import type { ReactNode } from 'react'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUpFromLine,
  CheckCircle2,
  Eraser,
  FolderOpen,
  Loader2,
  X
} from 'lucide-react'
import type { AgentHost } from '@fizz/agent-client/host'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { STATUS_ITEM_CLASS } from '@fizz/agent-kit/shared/lib/status-bar'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import type { TransferTask } from '@fizz/agent-kit/shared/lib/stores/slices/transfer'
import { cancelTransfer } from '@fizz/agent-kit/shared/lib/file-transfer/engine'
import { formatBytes, formatRate } from '@fizz/agent-kit/shared/components/monitor-parts'
import { Popover, PopoverContent, PopoverTrigger } from '@fizz/ui/popover'
import { Progress } from '@fizz/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'

/** 图标按钮统一成这一档尺寸：行高与标题行对齐，别各自定 */
const ICON_BUTTON_CLASS =
  'inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'

function RowIconButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick} className={ICON_BUTTON_CLASS}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function TransferRow({ task, host }: { task: TransferTask; host: AgentHost | null }) {
  const percent = task.size > 0 ? Math.min(100, Math.round((task.done / task.size) * 100)) : 0
  /** 总大小未知（远端目录项没给 size）时走不确定态 —— 画一条 0% 的死进度更糟 */
  const indeterminate = task.status === 'active' && task.size <= 0

  const canReveal =
    task.status === 'done' && !!task.localPath && typeof host?.revealInFileManager === 'function'

  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        {task.kind === 'upload' ? (
          <ArrowUpFromLine className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ArrowDownToLine className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={task.name}>
          {task.name}
        </span>
        {task.status === 'active' && (
          <RowIconButton label="取消传输" onClick={() => cancelTransfer(task.id)}>
            <X className="size-3.5" />
          </RowIconButton>
        )}
        {canReveal && (
          <RowIconButton
            label="在文件管理器中显示"
            onClick={() => {
              void host?.revealInFileManager?.(task.localPath!)
            }}
          >
            <FolderOpen className="size-3.5" />
          </RowIconButton>
        )}
      </div>

      {indeterminate ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
      ) : (
        <Progress value={task.status === 'active' ? percent : 100} className="h-1.5" />
      )}

      <div className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{task.hostLabel}</span>
        <span className="shrink-0 tabular-nums">{describeRight(task, percent)}</span>
      </div>

      {task.status === 'failed' && task.error && (
        <div className="flex items-start gap-1.5 text-[0.6875rem] text-destructive">
          <AlertCircle className="mt-px size-3 shrink-0" />
          <span className="min-w-0 break-words">{task.error}</span>
        </div>
      )}
    </div>
  )
}

/** 行尾那段：按状态给不同信息，都用 `tabular-nums` 对齐数字 */
function describeRight(task: TransferTask, percent: number): string {
  switch (task.status) {
    case 'active':
      return task.size > 0
        ? `${percent}% · ${formatBytes(task.done)} / ${formatBytes(task.size)}${
            task.speed > 0 ? ` · ${formatRate(task.speed)}` : ''
          }`
        : '传输中…'
    case 'done':
      return `${formatBytes(task.size)} · 已完成`
    case 'canceled':
      return task.size > 0 ? `${formatBytes(task.done)} / ${formatBytes(task.size)} · 已取消` : '已取消'
    case 'failed':
      return task.size > 0 ? `${formatBytes(task.done)} / ${formatBytes(task.size)}` : ''
  }
}

export function TransferBadge({
  side = 'top',
  contentClassName
}: {
  /**
   * 弹层从触发器哪一侧展开。桌面底栏贴在屏幕底缘，朝上（默认）；手机那枚挂在顶栏，
   * 必须朝下，否则弹层要顶出屏幕再被 collision 推回来，位置会跳。
   */
  side?: 'top' | 'bottom'
  /** 弹层额外类名：桌面固定 23rem，手机窄屏传 `w-[calc(100vw-1rem)]` 收进视口 */
  contentClassName?: string
}) {
  const transfers = useAgentStore((s) => s.transfers)
  const clearFinished = useAgentStore((s) => s.clearFinishedTransfers)

  // 一条都没有时完全不渲染：徽标是「有活干才出现」的东西，常驻一个空壳只会挤占底栏
  if (transfers.length === 0) return null

  const activeCount = transfers.filter((t) => t.status === 'active').length
  const hasFinished = transfers.some((t) => t.status !== 'active')
  const host = getAgentHostOrNull()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            activeCount > 0 ? `SFTP 传输：${activeCount} 项进行中` : `SFTP 传输：${transfers.length} 项已结束`
          }
          className={cn(STATUS_ITEM_CLASS, 'gap-1')}
        >
          {activeCount > 0 ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              <span className="tabular-nums">传输 {activeCount}</span>
            </>
          ) : (
            <>
              <ArrowDownUp className="size-3" />
              <span className="tabular-nums">传输 {transfers.length}</span>
            </>
          )}
        </button>
      </PopoverTrigger>

      {/* 右缘对齐触发器、向左展开：徽标总在屏幕右端（底栏 actions 槽 / 手机顶栏右侧） */}
      <PopoverContent
        side={side}
        align="end"
        collisionPadding={8}
        className={cn('w-[23rem] p-0 gap-0', contentClassName)}
        /*
        打开时**不抢焦点**：这张清单是「看一眼」的信息位，抢焦点会把焦点从聊天输入框 /
        编辑器里拽走（与后台任务清单同一处理）。
      */
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-2 px-3 py-1.5">
          {activeCount > 0 ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {activeCount > 0 ? `传输中 ${activeCount} 项` : `传输结束 ${transfers.length} 项`}
          </span>
          {/* 只在真有已结束的行时才给「清空」——否则那颗按钮点下去什么都不会发生 */}
          {hasFinished && (
            <RowIconButton label="清空已结束" onClick={clearFinished}>
              <Eraser className="size-3.5" />
            </RowIconButton>
          )}
        </div>

        <div className={cn('overflow-y-auto overscroll-contain', transfers.length > 4 && 'max-h-64')}>
          {transfers.map((task) => (
            <TransferRow key={task.id} task={task} host={host} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
