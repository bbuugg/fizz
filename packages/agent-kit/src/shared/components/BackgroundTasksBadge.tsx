'use client'

/**
 * 「后台任务」入口：一个徽标 + 一张任务清单弹层。桌面 / Web 挂在底部状态栏，
 * 手机壳（`apps/mobile`）挂在顶栏 —— 同一份组件、同一份轮询，只有弹层方向与宽度不同。
 *
 * ## 为什么这件事必须在状态栏
 *
 * 耗时任务（`git clone` 现在，将来的批量导入 / 备份同理）一旦允许「转到后台」，就需要一个
 * **不依赖发起它的那个弹窗**的常驻入口 —— 弹窗关了、切到别的功能区，用户仍然要知道
 * 「活还在跑 / 跑完了 / 挂了」。状态栏是唯一整宽常驻的地方，所以入口放这儿。
 *
 * 位置在**右端 `actions` 槽**（`app-shell.tsx`）：左边留给系统监控这类常驻读数，右边的
 * 「更新 / 日志」是偶发操作；后台任务夹在 spacer 之后第一颗，不跟左侧读数抢位置。
 *
 * 徽标样式套 `STATUS_ITEM_CLASS`，与底栏其它条目（系统监控等）对齐。
 *
 * ## 手机上它也在，只是换了条栏
 *
 * 手机壳没有底部状态栏（`apps/mobile/src/styles.css` 把 `--status-bar-height` 压成 0），
 * 而这颗徽标恰恰是「关掉弹窗、切走页面之后唯一还能告诉你活还在跑」的东西，不能跟着
 * 那条栏一起消失 —— 它被挂到 `MobileAppBar` 右端（新建对话左边）。
 *
 * 于是多出两个入参：弹层**朝下**展开（`side="bottom"`，桌面那套是按「贴在屏幕底缘」
 * 设的 `top`），宽度按视口收（`contentClassName`，桌面固定 `w-[23rem]` 在 360px 宽的手机
 * 上会顶到屏幕边）。除这两个之外没有任何手机分支：徽标长什么样、多久轮询、清单里能做什么，
 * 两端完全一致。
 *
 * ## 数据怎么来
 *
 * HTTP 轮询 `GET /api/background-tasks`（不进全局状态推送）：服务端的任务表本来就是
 * 「读的人随时来取」的形状。**有任务在跑时 2s 一轮，全空闲时 8s 一轮** —— 空闲时没必要
 * 按跑着的节奏打接口，但也不能不轮，否则别处（比如另一个窗口）起的任务永远发现不了。
 *
 * 一轮里发现「刚跑完且产出了新项目」时顺手 `app.refresh()` 一次：转到后台的克隆跑完，
 * 侧栏的项目列表得自己长出来，不能等用户手动刷新。
 *
 * ## 日志是「按需展开」的
 *
 * 列表每行只带**最新一行**（`lastLog`，跑着的任务等于实时进度），整份日志走
 * `GET /api/background-tasks/:id`，**只有用户点开日志才拉** —— 否则每 2s 白传几十 KB。
 * 展开期间如果任务还在跑，详情按 1.2s 自己续拉；任务一收场就停（列表那边会把
 * 状态改过来，这个 effect 的依赖跟着变，正好再补一次终局日志）。
 *
 * ## 空闲时不占地方
 *
 * 一条任务都没有就回 `null`（与隔壁的 SFTP 传输徽标 `TransferBadge` 同一个原则）：徽标是
 * 「有事才出现」的东西，常驻一个空壳只会挤占底栏。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Eraser,
  FolderOpen,
  GitBranch,
  ListChecks,
  Loader2,
  Square,
  X,
  XCircle
} from 'lucide-react'
import type {
  BackgroundTaskDetail,
  BackgroundTaskLogLine,
  BackgroundTaskStatus,
  BackgroundTaskView
} from '@fizz/contracts/agent-api'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { STATUS_ITEM_CLASS } from '@fizz/agent-kit/shared/lib/status-bar'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { Popover, PopoverContent, PopoverTrigger } from '@fizz/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'

/** 有任务在跑时的轮询间隔（要跟手：用户点了取消 / 转后台，2s 内要看到反应） */
const POLL_ACTIVE_MS = 2_000
/** 全空闲时的轮询间隔（只为发现别处起的任务，慢一点没影响） */
const POLL_IDLE_MS = 8_000
/** 展开日志且任务还在跑时的详情轮询间隔（比列表快一点，进度行才像在动） */
const LOG_POLL_MS = 1_200

/** 图标按钮：统一尺寸，别让每行的按钮各自高矮 */
const ICON_BUTTON_CLASS =
  'inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'

/** 毫秒 → 人话时长（`45s` / `3m 07s` / `1h 12m`） */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** 时间戳 → `21:12:31`（日志行前缀：只要时分秒，日期就是今天） */
function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 行尾那段状态话术：跑着的显示「已运行多久」，结束的显示「用了多久」 */
function describeStatus(task: BackgroundTaskView, now: number): string {
  const end = task.finishedAt ?? now
  switch (task.status) {
    case 'running':
      return `已运行 ${formatDuration(now - task.startedAt)}`
    case 'done':
      return `用时 ${formatDuration(end - task.startedAt)}`
    case 'canceled':
      return '已取消'
    case 'failed':
      return '失败'
  }
}

function StatusIcon({ status }: { status: BackgroundTaskStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-muted-foreground" />
    case 'done':
      return <CheckCircle2 className="mt-px size-3.5 shrink-0 text-muted-foreground" />
    case 'failed':
      return <AlertCircle className="mt-px size-3.5 shrink-0 text-destructive" />
    case 'canceled':
      return <XCircle className="mt-px size-3.5 shrink-0 text-muted-foreground" />
  }
}

function IconAction({
  label,
  onClick,
  children,
  className
}: {
  label: string
  onClick: () => void
  children: ReactNode
  /** 只有「贴在任务名后面」那种行内场景需要缩到 size-4，别的一律用默认尺寸 */
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={cn(ICON_BUTTON_CLASS, className)}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * 日志面板：等宽、可滚、**贴着底才自动滚**。
 *
 * 「贴底」这个判断不能省：任务跑到一半用户往上翻看前面的输出，新来一行就把他弹回底部
 * 会直接毁掉「翻历史」这件事。滚轮往上拖一下就把自动跟随关掉，拖回底部又自动开回来。
 */
function LogPane({ logs, loading }: { logs: BackgroundTaskLogLine[]; loading: boolean }) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const el = boxRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <div
      ref={boxRef}
      onScroll={(event) => {
        const el = event.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      /*
       * 位置由外面那个 grid 决定：左边缘和「日志 N›」的箭头同列，右侧铺到操作按钮
       * 的右边缘 —— 不是卡片左边缘（那会让人以为日志属于整张卡片、连状态图标一起），
       * 也不是缩进到文字列里（那样右边会留一大块空白）。这里只管自身外观。
       */
      className="max-h-44 overflow-y-auto overscroll-contain rounded-md bg-muted/40 px-1.5 py-1 font-mono text-[0.6875rem] leading-[1.45]"
    >
      {logs.length === 0 ? (
        <div className="py-1 text-muted-foreground">{loading ? '加载日志…' : '还没有日志'}</div>
      ) : (
        logs.map((line, index) => (
          // 同一毫秒可能有多行（`at` 不唯一），索引当 key 的一部分才稳
          <div key={`${line.at}-${index}`} className="flex gap-1.5">
            <span className="shrink-0 tabular-nums text-muted-foreground/60">
              {formatClock(line.at)}
            </span>
            <span
              className={cn(
                'min-w-0 whitespace-pre-wrap break-all',
                line.level === 'error'
                  ? 'text-destructive'
                  : line.level === 'warn'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-foreground/85'
              )}
            >
              {line.text}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

export function BackgroundTasksBadge({
  app,
  side = 'top',
  contentClassName
}: {
  app: AgentApp
  /**
   * 弹层从触发器哪一侧展开。桌面底栏贴在屏幕底缘，朝上（默认）；手机那枚挂在顶栏，
   * 必须朝下，否则弹层要顶出屏幕再被 collision 推回来，位置会跳。
   */
  side?: 'top' | 'bottom'
  /** 弹层额外类名：桌面固定 23rem，手机窄屏传 `w-[calc(100vw-1rem)]` 收进视口 */
  contentClassName?: string
}) {
  const api = app.api
  const [tasks, setTasks] = useState<BackgroundTaskView[]>([])
  const [open, setOpen] = useState(false)
  /** 当前展开日志的任务 id（一次只开一个：两张日志面板并排没人读得下去） */
  const [expandedId, setExpandedId] = useState<string | null>(null)
  /** 展开那条任务的详情（任务 + 日志）；切行 / 收起时清掉 */
  const [detail, setDetail] = useState<BackgroundTaskDetail | null>(null)
  /** 每秒走一格的「现在」：跑着的任务要显示实时时长（只有真有活时才起定时器） */
  const [now, setNow] = useState(() => Date.now())
  /** 上一轮还在跑的 id：用来认出「这一轮刚好跑完」的任务，好刷新一次项目列表 */
  const runningRef = useRef<Set<string>>(new Set())
  /** `app.refresh` 每次渲染都是新引用，放进 effect 依赖会把轮询重启一遍 —— 用 ref 拿最新那个 */
  const refreshRef = useRef(app.refresh)
  refreshRef.current = app.refresh

  // `open` 进依赖：打开弹层时立刻再拉一次，弹层里看到的就是最新清单
  useEffect(() => {
    if (!api) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      let delay = POLL_IDLE_MS
      try {
        const result = await api.listBackgroundTasks()
        if (stopped) return
        const next = result.tasks ?? []
        setTasks(next)

        // 刚跑完且产出了新项目（转到后台的克隆就是这样收场的）：把项目列表拉一次
        const finishedWithWorkspace = next.some(
          (t) => t.status === 'done' && !!t.workspaceId && runningRef.current.has(t.id)
        )
        runningRef.current = new Set(next.filter((t) => t.status === 'running').map((t) => t.id))
        if (finishedWithWorkspace) void refreshRef.current()
        if (runningRef.current.size > 0) delay = POLL_ACTIVE_MS
      } catch {
        // 拉不到就按空闲节奏重试：这是一个徽标，不该为它弹错误
        delay = POLL_IDLE_MS
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), delay)
      }
    }

    void poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [api, open])

  // 有任务在跑才需要秒针；全结束就停掉（不然每秒一次无意义的重渲染）
  useEffect(() => {
    if (!tasks.some((t) => t.status === 'running')) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [tasks])

  /**
   * 任务被关掉 / 被清空后，展开态要跟着收起来。
   *
   * 放在 effect 里而不是渲染期判空：渲染期 setState 会触发 React 的警告，
   * 而这里本来就要等下一轮列表刷新才知道「那条没了」。
   */
  useEffect(() => {
    if (expandedId && !tasks.some((task) => task.id === expandedId)) {
      setExpandedId(null)
      setDetail(null)
    }
  }, [tasks, expandedId])

  /** 展开那条任务的状态：任务一从 running 变成结束，下面的详情 effect 会重跑一次拿终局日志 */
  const expandedStatus = tasks.find((task) => task.id === expandedId)?.status

  useEffect(() => {
    if (!api || !open || !expandedId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // 换行时先把上一条的日志清掉，否则会短暂看到「上一行的日志挂在这一行下面」
    setDetail((prev) => (prev?.task.id === expandedId ? prev : null))

    const load = async (): Promise<void> => {
      try {
        const next = await api.getBackgroundTask(expandedId)
        if (stopped) return
        setDetail(next)
        // 还在跑就继续跟；收场了就停（列表那边状态一变，本 effect 会重跑拿最终日志）
        if (next.task.status === 'running') timer = setTimeout(() => void load(), LOG_POLL_MS)
      } catch {
        // 任务刚好被关掉 / 服务重启：静默收场，列表轮询会把那一行清理掉
      }
    }

    void load()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [api, open, expandedId, expandedStatus])

  if (!api || tasks.length === 0) return null

  const running = tasks.filter((t) => t.status === 'running').length
  const finished = tasks.length - running

  /** 每条操作接口都回全量清单，拿回来直接整体替换（不用自己算增删） */
  const applyResult = (result: { tasks: BackgroundTaskView[] }): void => {
    setTasks(result.tasks)
  }

  const cancelTask = (id: string): void => {
    void api.cancelBackgroundTask(id).then(applyResult).catch(() => undefined)
  }
  const dismissTask = (id: string): void => {
    void api.dismissBackgroundTask(id).then(applyResult).catch(() => undefined)
  }
  const clearFinished = (): void => {
    void api.clearBackgroundTasks().then(applyResult).catch(() => undefined)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={running > 0 ? `后台任务：${running} 项运行中` : `后台任务：${finished} 项已结束`}
          className={cn(STATUS_ITEM_CLASS, 'gap-1')}
        >
          {running > 0 ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              <span className="tabular-nums">后台 {running}</span>
            </>
          ) : (
            <>
              <ListChecks className="size-3" />
              <span className="tabular-nums">任务 {finished}</span>
            </>
          )}
        </button>
      </PopoverTrigger>

      {/* 右缘对齐触发器、向左展开：徽标总在屏幕右端（底栏 actions 槽 / 手机顶栏右侧），
          对齐 end 才不出屏。`side` / 宽度由调用方按所在那条栏给（见文件头「手机上」） */}
      <PopoverContent
        side={side}
        align="end"
        collisionPadding={8}
        className={cn('w-[23rem] p-0', contentClassName)}
        /*
        打开时**不抢焦点**：这张清单是「看一眼」的信息位，抢焦点会把焦点从聊天输入框 /
        编辑器里拽走，用户点开瞄一眼再点回去，光标就没了。Esc 关闭不受影响
        （DismissableLayer 的 Esc 走 document 监听，不依赖内容内是否有焦点）。
      */
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {running > 0 ? `后台任务 · ${running} 项运行中` : '后台任务'}
          </span>
          {/* 只在真有已结束的行时才给「清空」—— 否则点下去什么都不会发生 */}
          {finished > 0 && (
            <IconAction label="清空已结束" onClick={clearFinished}>
              <Eraser className="size-3.5" />
            </IconAction>
          )}
        </div>

        <div className={cn('overflow-y-auto overscroll-contain', tasks.length > 5 && 'max-h-80')}>
          {tasks.map((task) => {
            const expanded = expandedId === task.id
            // 详情可能还是上一条的（切换那一瞬），对不上就当「加载中」
            const logs = detail?.task.id === task.id ? detail.logs : []
            return (
              <div key={task.id} className="border-b last:border-b-0">
                {/*
                  这一行用 **grid** 而不是 flex：`[auto | minmax(0,1fr) | auto | auto]`
                  四列 —— 状态图标 / 文字 / 运行时间 / 操作。目的只有一个：让日志面板能
                  同时做到「左边跟 `日志 N›` 的箭头对齐」和「右边一直铺到操作按钮的右边缘」。
                  面板放在第 2 列起、横跨到第 4 列末尾：
                    · 左边 = 文字列的左边缘 = 箭头的左边缘（同一列，天生对齐）；
                    · 右边 = 操作列的右边缘 = 这一行的内容右边界，不是卡片内缩一半的位置。
                  用 flex + 手写缩进（12px padding + 14px 图标 + 8px gap）也能凑出来，
                  但那些数字一改就对不上；用列定位就不用维护这个偏移量。
                */}
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-start gap-x-2 px-3 py-2">
                  <div className="col-start-1 row-start-1">
                    <StatusIcon status={task.status} />
                  </div>
                  <div className="col-start-2 row-start-1 min-w-0">
                    <div className="flex min-w-0 items-center gap-1">
                      {task.kind === 'git-clone' && (
                        <GitBranch className="size-3 shrink-0 text-muted-foreground" />
                      )}
                      {/* 标题不占 flex-1：让后面的图标紧贴它，长标题自己截断（shrink 照旧生效） */}
                      <span
                        className="min-w-0 shrink truncate text-xs text-foreground"
                        title={task.title}
                      >
                        {task.title}
                      </span>
                      {/* 跑完的克隆：一个小图标直接去那个项目，不占一行也不跟「日志」抢位置 */}
                      {task.status === 'done' && task.workspaceId && (
                        <IconAction
                          label="打开项目"
                          className="size-4"
                          onClick={() => {
                            app.selectWorkspace(task.workspaceId!)
                            setOpen(false)
                          }}
                        >
                          <FolderOpen className="size-3" />
                        </IconAction>
                      )}
                    </div>
                    {task.detail && (
                      <div className="truncate text-[0.6875rem] text-muted-foreground" title={task.detail}>
                        {task.detail}
                      </div>
                    )}
                    {/* 跑着的任务：最新一行日志就是进度（`Receiving objects: 45%`）；
                        展开日志后这行就冗余了（面板里滚到最底就是它），收起来 */}
                    {!expanded && task.status === 'running' && task.lastLog && (
                      <div
                        className="truncate font-mono text-[0.6875rem] text-muted-foreground/80"
                        title={task.lastLog}
                      >
                        {task.lastLog}
                      </div>
                    )}
                    {task.status === 'failed' && task.error && (
                      <div className="flex items-start gap-1.5 text-[0.6875rem] break-words text-destructive">
                        <span className="min-w-0">{task.error}</span>
                      </div>
                    )}
                    {/* 有日志才给展开入口；面板紧跟在它下面，左边缘与箭头对齐 */}
                    {task.logCount > 0 && (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : task.id)}
                        className="mt-0.5 inline-flex items-center gap-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronRight
                          className={cn('size-3 transition-transform', expanded && 'rotate-90')}
                        />
                        <span className="tabular-nums">日志 {task.logCount}</span>
                      </button>
                    )}
                    {/*
                      面板由下面那个 grid 子项渲染（`col-start-2 col-span-3`）：
                      从这里挪出去才能铺到右侧满宽，同时左边仍然贴着箭头。
                    */}
                  </div>

                  <span className="col-start-3 row-start-1 pt-px text-[0.6875rem] tabular-nums text-muted-foreground">
                    {describeStatus(task, now)}
                  </span>

                  {/* 还在跑：方形 = 停止；已结束：× = 从清单里抹掉（两者互斥，占同一格） */}
                  <div className="col-start-4 row-start-1">
                    {task.cancelable && (
                      <IconAction label="取消任务" onClick={() => cancelTask(task.id)}>
                        <Square className="size-3" />
                      </IconAction>
                    )}
                    {task.status !== 'running' && (
                      <IconAction label="关闭" onClick={() => dismissTask(task.id)}>
                        <X className="size-3.5" />
                      </IconAction>
                    )}
                  </div>

                  {/* 日志：左对齐「日志」箭头（第 2 列）、右侧铺到操作列末尾（第 4 列） */}
                  {expanded && (
                    <div className="col-start-2 col-span-3 row-start-2 mt-1">
                      <LogPane logs={logs} loading={detail?.task.id !== task.id} />
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
