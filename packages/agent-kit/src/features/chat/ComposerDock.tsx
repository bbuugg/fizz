'use client'

/**
 * 会话的「活动入口」：**两枚药丸**（子智能体 / 后台任务），点开向上弹出一张清单。
 *
 * ## 位置
 *
 * 挂在输入框上方那一行的**右端**，与左边「浏览器 / MCP」那条能力开关同排（对齐由
 * `chat-surface.tsx` 的 `above` 壳保证，`justify-between`）。两者都是「这个会话现在还有什么」
 * 的常驻状态，各占一行会白吃掉 32px；而且工具栏在没装浏览器 / 没配 MCP 时整条不渲染，
 * 那时这一排会自然退回左边，不会孤零零飘在右边。
 *
 * ## 为什么从「常驻卡片」改成「药丸 + 弹出面板」
 *
 * 这两块以前是两套形态：运行中的子任务是一排胶囊（每个子任务一颗），后台任务是一张
 * 一直展开的卡片。它们都钉在输入框上方，于是两种毛病：
 *
 * - 子任务一多，那排胶囊自己折成两三行；
 * - 后台任务卡片默认展开，哪怕只有一个 `dev server` 也占掉 `min(200px, 24vh)`，
 *   把输入框和审批卡往下推 —— 而绝大多数时候用户根本不需要看它。
 *
 * 现在统一成「有事才出现的一枚药丸」：**数量就是信号**（`2 个子智能体` / `1 个后台任务`），
 * 要看细节点开，清单从药丸上方弹出来。
 *
 * 外壳**就是模型选择那一套**（`PickerPanel` + `PickerList`，见 `@fizz/ui/picker-panel`）：
 * 同一条 `side="top"` + 6px 间距、同一块液态玻璃底、同一段 `--radix-popper-available-height`
 * 高度上限、贴边自动翻转、点外面 / Esc 关闭。不要在这里另写一份 `PopoverContent`
 * 拼长相 —— 两处一漂，用户一眼就看出「这块面板和模型面板不是一套」。
 *
 * 面板**不占布局**：它渲染在 portal 里、浮在消息区之上，所以展开 / 收起都不改变输入框
 * 的位置（早先的「就地撑开一块」会推着输入框和审批卡上下跳）。
 *
 * 宽度取**输入框宽度的一半**（`panelWidth`，量的是所在那一行的宽度，见下方测量处的
 * 注释）：模型面板固定 `w-72` 是因为它只有单行短名，这里每行是「标题 + 副行」，
 * 按半宽铺开正好，也不至于像通栏那样一路顶到消息区边上。
 *
 * ## 什么在跑，谁就亮
 *
 * 药丸在「还有活在跑」时套一圈**边框流光**（`BorderBeam`），与输入框收音 / 文件悬停那条
 * 同源（见 `composer.tsx` 的卡片）：同一条彩虹光束沿边框跑，按当前实际亮暗取色。
 * 两枚各看各的 —— 子智能体那枚「在就代表在跑」；后台任务那枚要 `running === true`
 * （刚结束的任务还会在这一排挂 10 秒优雅窗口，那 10 秒不亮）。减少动态效果时退成静态
 * 内描边，与输入卡片同一条规则。
 *
 * ## 为什么同时只能开一块
 *
 * 两块同时开着就是两张浮层互相压，用户点开其中一块时本来也只想看那一块。所以 `open`
 * 是一个单值，点第二枚药丸自动收掉第一块。
 *
 * ## 数据怎么来（两块各自的老规矩，这里只是换了外壳）
 *
 * - 子智能体：**每次渲染现扫消息**（`collectRunningSubagents`）。子任务跑着时 `delegation`
 *   每帧都是新对象，缓存下来的只会是过期快照；`live`（本轮是否还在流式）是必需的门 ——
 *   进程被杀时落盘的派活记录会一直停在 `running`。
 * - 后台任务：事件（`backgroundTasks:changed`）管「立刻反应」，轮询管兜底（有活在跑 2s、
 *   全空闲 8s），两者共用一个 in-flight 闸。只显示**当前会话**名下的任务，刚结束的留
 *   10 秒优雅窗口，日志只在点开某一行时才拉。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ListTree,
  Loader2,
  Square,
  SquareTerminal,
  X,
  XCircle
} from 'lucide-react'
import type {
  AgentChatMessage,
  BackgroundTaskDetail,
  BackgroundTaskStatus,
  BackgroundTaskView
} from '@fizz/contracts/agent-api'
import { SUBAGENT_META, type SubagentDelegation } from '@fizz/contracts/types'
import { BorderBeam } from 'border-beam'
import { Popover, PopoverTrigger } from '@fizz/ui/popover'
import { PickerList, PickerPanel } from '@fizz/ui/picker-panel'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useTheme } from '@fizz/agent-kit/shared/hooks/useTheme'
import { usePrefersReducedMotion } from '@fizz/agent-kit/shared/hooks/usePrefersReducedMotion'
import { toolLabel } from '@fizz/agent-kit/shared/lib/parts'
import { initStateClient, subscribeServerEvent } from '@fizz/agent-kit/shared/lib/state-ws'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { OpenSubagent } from '@fizz/agent-kit/features/chat/subagent-view'

/** 有任务在跑时的轮询间隔：要跟手（点了停止 2s 内看到反应） */
const POLL_ACTIVE_MS = 2_000
/** 全空闲时的轮询间隔：只为发现别处起的任务 */
const POLL_IDLE_MS = 8_000
/** 展开日志且任务还在跑时的详情轮询间隔（比列表快一点，输出才像在动） */
const LOG_POLL_MS = 1_200
/**
 * 结束后的优雅窗口：任务收场后再留 10 秒。
 *
 * 为什么要留：`npm run dev` 挂掉时，最有用的信息就是最后那几行报错和退出码；一结束就
 * 抹掉等于让用户永远看不到「它为什么死了」。10 秒够读完一段栈，又不至于把输入框顶住。
 */
const ENDED_VISIBLE_MS = 10_000

/** 输入框上方那排入口里的一个子任务 */
export interface SubagentDockItem {
  toolCallId: string
  delegation: SubagentDelegation
  /** 子 agent 此刻正在用的工具（`read` 之类）；还没动手时没有 */
  tool?: string
}

/** 当前展开的是哪一块（单值 = 两块不会同时展开，见文件头） */
type DockSection = 'subagents' | 'tasks'

/**
 * 收集当前会话里**还在跑**的子任务。
 *
 * `live`（本轮是否还在流式）是必需的门：进程被杀 / 断电时，落盘的派活记录会一直停在
 * `running`，重启后照它画一枚「正在运行」就是永远不会消失的假信号。子任务真的在跑时主轮
 * 必然还在流式 —— 子 run 的 signal 与父轮取或（见 `subagents.ts`）。
 */
export function collectRunningSubagents(
  messages: AgentChatMessage[],
  live: boolean
): SubagentDockItem[] {
  if (!live) return []
  const items: SubagentDockItem[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool-call') continue
      const delegation = part.delegation
      if (!delegation || delegation.status !== 'running') continue
      items.push({ toolCallId: part.toolCallId, delegation, tool: part.subagentTool })
    }
  }
  return items
}

/** 毫秒 → 人话时长（`45s` / `3m 07s` / `1h 12m`） */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * 每秒提一次的「现在」，只给子任务的运行时长用。
 *
 * 不能直接 `Date.now()` 了事：模型停顿（长思考 / 等工具返回）时没有新帧，秒数会冻住，
 * 看上去像那个子任务卡死了 —— 而「还在动」正是这枚药丸要传达的第一信息。
 */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

/** 派活原文的第一行：清单里一行放得下的「它在干什么」 */
function firstLine(text: string): string {
  const line = text
    .trim()
    .split('\n')
    .find((part) => part.trim().length > 0)
  return line?.trim() ?? ''
}

/** 调用方的文字前缀（跑着的说「已运行多久」，结束的说「用了多久」） */
function describeStatus(
  task: BackgroundTaskView,
  now: number,
  t: (key: string, vars?: Record<string, string | number>) => string
): string {
  const end = task.finishedAt ?? now
  switch (task.status) {
    case 'running':
      return t('已运行 {time}', { time: formatDuration(now - task.startedAt) })
    case 'done':
      return t('用时 {time}', { time: formatDuration(end - task.startedAt) })
    case 'canceled':
      return t('已取消')
    case 'failed':
      return t('失败')
  }
}

function TaskStatusIcon({ status }: { status: BackgroundTaskStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
    case 'done':
      return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
    case 'failed':
      return <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
    case 'canceled':
      return <XCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  }
}

/**
 * 输出预览：等宽、可滚、**贴着底才自动滚**。
 *
 * 「贴底」判断不能省：用户往上翻看前面的输出时，新来一行就把他弹回底部会直接毁掉
 * 「翻历史」这件事。滚轮往上拖一下关掉跟随，拖回底部又自动开回来。
 */
function LogPane({ lines, loading }: { lines: BackgroundTaskDetail['logs']; loading: boolean }) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const t = useT()

  useEffect(() => {
    const el = boxRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div
      ref={boxRef}
      onScroll={(event) => {
        const el = event.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      className="mt-1 max-h-40 overflow-y-auto overscroll-contain rounded-md bg-muted/40 px-2 py-1 font-mono text-[0.6875rem] leading-[1.5]"
    >
      {lines.length === 0 ? (
        <div className="py-0.5 text-muted-foreground">
          {loading ? t('加载日志…') : t('还没有输出')}
        </div>
      ) : (
        lines.map((line, index) => (
          // 同一毫秒可能有多行（`at` 不唯一），索引当 key 的一部分才稳
          <div
            key={`${line.at}-${index}`}
            className={cn(
              'whitespace-pre-wrap break-all',
              line.level === 'error'
                ? 'text-destructive'
                : line.level === 'warn'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-foreground'
            )}
          >
            {line.text}
          </div>
        ))
      )}
    </div>
  )
}

/**
 * 入口药丸：图标 + 数量 + 名词。它是 Popover 的触发器（`PopoverTrigger asChild` 注入
 * 展开状态与点击），所以这里**只管长相**，不要自己写 `onClick` / `aria-expanded`
 * —— 两处各改一次会互相打架（点一下开又立刻关）。
 *
 * ⚠️ **`...rest` 和 `ref` 必须一路透传到 `<button>`，这不是样式问题，是「点不开」的根因**：
 * `asChild` 走的是 Radix `Slot`，它靠 `cloneElement` 把 `onClick` / `aria-expanded` /
 * `data-state` / `ref` 挂到 child 上。child 是我们自己的函数组件，只要签名里没接这些 props
 * （或没转发 `ref`），事件就到不了 Radix —— 药丸长得完全正常、点了毫无反应，而且不报任何错。
 * 之前正是只写了 `icon/count/label/open/ariaLabel` 五个 props，面板一直打不开。
 *
 * ⚠️ 数量单独用 `text-foreground`：它才是这枚药丸上真正会变的信息（1 → 3 个子任务），
 * 名词只是说明这块是什么。整枚都用 `text-muted-foreground` 的话，流式期间新起一个子任务
 * 在视觉上完全没有反馈。
 */
function DockPill({
  icon,
  count,
  label,
  open,
  ariaLabel,
  className,
  ...rest
}: {
  icon: ReactNode
  count: number
  label: string
  open: boolean
  ariaLabel: string
} & ComponentProps<'button'>) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        'inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors',
        open ? 'bg-secondary' : 'bg-secondary/70 hover:bg-secondary hover:text-foreground',
        className
      )}
    >
      {icon}
      <span className="shrink-0 font-medium tabular-nums text-foreground">{count}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * 面板最窄 15rem：手机上输入框只有 360px 上下，严格取半条就成了「一条缝」，
 * 两行文字全被截断反而没法认。
 */
const MIN_PANEL_WIDTH = 240

/**
 * 清单里的一行：图标位 + 两行文字 + 行尾动作。整块可点（行体那颗按钮撑满剩余宽度）。
 *
 * 横向内边距交给 `PickerList`（`px-2`）+ 行自身 `px-2`，与模型面板里
 * `PickerList(px-2) + PickerItem(px-2.5)` 的 18px 左缘基本对齐，两块面板看起来是一套。
 */
const DOCK_ROW_CLASS =
  'flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/60'

/**
 * 清单里的行是**普通按钮**，不是 cmdk 的 item，所以键要在这里截住：
 * `PickerPanel` 内部的 `Command` 根接管了整棵子树的键盘事件，**Enter 一律 `preventDefault`
 * 后去选高亮项**（`picker-panel` 头注释里那条同理，底部动作因此放在 `Command` 外面）。
 * 不拦的话键盘用户 Tab 到「停止」再按 Enter 什么都不会发生。
 *
 * ⚠️ `Escape` 必须放行：Radix 的 `DismissableLayer` 在 **document** 上收 Escape，
 * 中途 `stopPropagation` 会让事件冒不到 document，面板就关不掉了。
 */
const interceptPanelKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
  if (event.key === 'Escape') return
  event.stopPropagation()
}

/** 后台任务那块的数据：清单轮询 + 详情（日志）按需拉，口径与状态栏那张全局清单一致 */
function useSessionTasks(api: AgentApp['api'], conversationId: string | undefined) {
  const [all, setAll] = useState<BackgroundTaskView[]>([])
  /**
   * 「刚结束」的任务 → 窗口起点（id → 时间戳），见 `apply` 里的补起点规则。
   *
   * 只用来算「还能显示多久」：任务本身的状态永远以服务端清单为准，这里不复制状态。
   */
  const [endedAt, setEndedAt] = useState<Record<string, number>>({})
  /** 每秒走一格的「现在」：跑着的行要显示实时时长，结束的行要靠它算窗口到期 */
  const [now, setNow] = useState(() => Date.now())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<BackgroundTaskDetail | null>(null)
  /** 上一轮还在跑的 id：只用来决定下一轮轮询该多快（有活在跑就 2s） */
  const runningRef = useRef<Set<string>>(new Set())

  /**
   * 拿回一份清单：整体替换 + 给「刚结束」的行打上优雅窗口的起点。
   *
   * 起点用任务自己的 `finishedAt` 而不是 `Date.now()`：轮询间隔（2s）里完全可能
   * 「起完又结束」（一条 1 秒的 build），那种任务我们一次都没见它跑过 —— 用 `finishedAt`
   * 补起点，它才不至于连一眼都露不出来。**只补刚结束的**（窗口内）：登记表里躺着几小时前
   * 的已结束任务是给状态栏那张全局清单看的。
   */
  const apply = useCallback((next: BackgroundTaskView[]) => {
    runningRef.current = new Set(
      next.filter((task) => task.status === 'running').map((task) => task.id)
    )
    setAll(next)
    const stamp = Date.now()
    setEndedAt((prev) => {
      let out: Record<string, number> | null = null
      for (const task of next) {
        if (task.status === 'running') continue
        const at = task.finishedAt
        if (at === undefined || stamp - at >= ENDED_VISIBLE_MS) continue
        if (prev[task.id] !== undefined) continue
        out ??= { ...prev }
        out[task.id] = at
      }
      return out ?? prev
    })
  }, [])

  // 清单：事件驱动 + 轮询兜底（两条路共用一个 in-flight 闸）
  useEffect(() => {
    if (!api) return
    let stopped = false
    let inFlight = false
    let queued = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const refresh = async (): Promise<void> => {
      if (inFlight) {
        queued = true
        return
      }
      inFlight = true
      clearTimeout(timer)
      try {
        const result = await api.listBackgroundTasks()
        if (stopped) return
        apply(result.tasks ?? [])
      } catch {
        // 拉不到就按空闲节奏重试：这是个附加面板，不该为它弹错误
      } finally {
        inFlight = false
        if (stopped) return
        if (queued) {
          queued = false
          void refresh()
          return
        }
        timer = setTimeout(
          () => void refresh(),
          runningRef.current.size > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS
        )
      }
    }

    void refresh()
    // 幂等：整应用只开一条状态 WS（app-shell 已经调过也没关系），这里补一次是为了
    // 让本组件在别的壳（面板 / 手机布局）里挂载时也能收到事件
    initStateClient()
    const off = subscribeServerEvent((event) => {
      if (event.type === 'backgroundTasks:changed') void refresh()
    })
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      off()
    }
  }, [api, apply])

  /**
   * 只留这个会话的行，再按可见性筛一遍。
   *
   * 排序：跑着的在前，同组按开始时间倒序（新起的在上面）—— 与状态栏那张清单同一套顺序，
   * 用户在两个地方看到的相对位置不会变。
   */
  const rows = useMemo(() => {
    const mine = all.filter((task) => task.sessionId === conversationId)
    const visible: BackgroundTaskView[] = []
    for (const task of mine) {
      if (task.status === 'running' || task.id === expandedId) {
        visible.push(task)
        continue
      }
      const ended = endedAt[task.id]
      if (ended !== undefined && now - ended < ENDED_VISIBLE_MS) visible.push(task)
    }
    return visible.sort((a, b) => {
      const running = Number(b.status === 'running') - Number(a.status === 'running')
      return running !== 0 ? running : b.startedAt - a.startedAt
    })
  }, [all, conversationId, endedAt, now, expandedId])

  // 有行才需要秒针（跑着的要时长、结束的要算到期）；没有行就停掉，别每秒白重渲染
  const ticking = rows.length > 0
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [ticking])

  /** 展开那条任务的状态：一从 running 变成结束，下面的详情 effect 会重跑一次拿终局输出 */
  const expandedStatus = all.find((task) => task.id === expandedId)?.status

  // 详情（含日志）：只有展开的那一条才拉，跑着就 1.2s 续拉
  useEffect(() => {
    if (!api || !expandedId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // 换行时先清掉上一条的日志，否则会短暂看到「上一行的输出挂在这一行下面」
    setDetail((prev) => (prev?.task.id === expandedId ? prev : null))

    const load = async (): Promise<void> => {
      try {
        const next = await api.getBackgroundTask(expandedId)
        if (stopped) return
        setDetail(next)
        if (next.task.status === 'running') timer = setTimeout(() => void load(), LOG_POLL_MS)
      } catch {
        // 任务刚被关掉 / 服务重启：静默收场，清单那边会把这一行清掉
      }
    }

    void load()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [api, expandedId, expandedStatus])

  // 那一行没了（被关掉 / 被清空）：展开态跟着收起来，别留一个没有主的日志面板
  useEffect(() => {
    if (expandedId && !all.some((task) => task.id === expandedId)) {
      setExpandedId(null)
      setDetail(null)
    }
  }, [all, expandedId])

  /** 每条操作接口都回全量清单，拿回来直接整体替换（不用自己算增删） */
  const applyResult = (result: { tasks: BackgroundTaskView[] }): void => apply(result.tasks ?? [])
  const stop = (id: string): void => {
    void api?.cancelBackgroundTask(id).then(applyResult).catch(() => undefined)
  }
  const dismiss = (id: string): void => {
    void api?.dismissBackgroundTask(id).then(applyResult).catch(() => undefined)
  }

  return { rows, now, detail, expandedId, setExpandedId, stop, dismiss }
}

/**
 * 会话输入框上方的两枚入口（子智能体 / 后台任务）与就地展开的清单。
 *
 * 两块都为空时返回 `null`：这是「有事才出现」的东西，常驻一个空壳只会把输入框往下推。
 */
export function ComposerDock({
  app,
  conversationId,
  subagents,
  onOpenSubagent
}: {
  /** 没有 app（容器侧的片段渲染）时不拉后台任务，只剩子智能体那一枚 */
  app?: AgentApp
  /** 当前会话 id：后台任务按它过滤（没有会话时那一枚不出现） */
  conversationId?: string
  subagents: SubagentDockItem[]
  onOpenSubagent: OpenSubagent
}) {
  const t = useT()
  const tasks = useSessionTasks(app?.api ?? null, conversationId)
  const [open, setOpen] = useState<DockSection | null>(null)
  /**
   * 只停**这一条**子任务的通道 —— 与派活卡头部那颗停止钮是同一个 action
   * （`stopCommand(toolCallId, scope)`，服务端 abort 这一个子 run，父轮继续）。
   */
  const stopCommand = useAgentStore((s) => s.stopCommand)
  /** 已点、服务端还没回：那颗钮换成转圈并禁用，免得连点（子 run 收尾有几十毫秒的窗口） */
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set())
  /** 子任务行上的运行时长（每秒一格，见 `useNow` 的注释） */
  const subagentNow = useNow(subagents.length > 0)
  /**
   * 面板宽度 = **输入框宽度的一半**。
   *
   * 量的是**父级那一行**，不是这一排药丸自己：药丸合并到工具栏同一行之后只剩内容宽
   * （`flex` 子项不再撑满），父级才是与输入框卡片等宽的那条壳 —— `ChatComposer` 的
   * `above` 容器（`mx-auto w-full max-w-3xl`，见 `chat-surface.tsx` 里那段注释）。
   * `ResizeObserver` 跟上窗口缩放与侧栏开合（限宽 768px 以内会跟着变）。
   *
   * 面板渲染在 portal 里、跟药丸不在同一棵 DOM，所以宽度只能算成像素用 `style` 给 ——
   * 写 `w-1/2` 会变成「视口的一半」，不是输入框的一半。
   *
   * ⚠️ 因此调用方必须把它放进一条**满宽**的行里（不能是 `w-fit` / 居中的壳），否则
   * 算出来的是那条壳的一半，不是输入框的一半。
   */
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const [rowWidth, setRowWidth] = useState(0)
  useLayoutEffect(() => {
    const row = rootEl?.parentElement
    if (!row) return
    const measure = (): void => setRowWidth(row.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [rootEl])
  const panelWidth =
    rowWidth > 0 ? Math.max(MIN_PANEL_WIDTH, Math.round(rowWidth / 2)) : undefined

  // 展开的那一块自己空了（子任务跑完 / 任务被关掉）：跟着收起，别留一块空清单
  useEffect(() => {
    if (open === 'subagents' && subagents.length === 0) setOpen(null)
  }, [open, subagents.length])
  useEffect(() => {
    if (open === 'tasks' && tasks.rows.length === 0) setOpen(null)
  }, [open, tasks.rows.length])

  /**
   * 药丸边框的流光 —— **与输入框收音 / 文件悬停那一条同源**（`BorderBeam` +
   * `useTheme`，见 `composer.tsx` 的输入卡片）：同一条彩虹光束沿边框跑，按当前实际
   * 亮暗取透明度。这里只换个尺寸（`sm`，胶囊档）和强度。
   *
   * 判定按「**现在还有没有活在跑**」，两枚药丸各看各的：
   * - 子智能体那枚**在就代表有在跑的**（`subagents` 本来就是 `collectRunningSubagents`
   *   的结果，跑完就从列表里消失），所以它天然常亮；
   * - 后台任务那枚必须单独判 `running` —— 刚结束的任务还会在这排挂 10 秒优雅窗口，
   *   那 10 秒里药丸在、但已经没有活了，不该还在转。
   */
  const { theme } = useTheme()
  const reducedMotion = usePrefersReducedMotion()

  if (subagents.length === 0 && tasks.rows.length === 0) return null

  const hasSubagents = subagents.length > 0
  const hasTasks = tasks.rows.length > 0
  const runningTasks = tasks.rows.filter((task) => task.status === 'running').length

  const stopSubagent = (toolCallId: string): void => {
    setStopping((prev) => new Set(prev).add(toolCallId))
    /*
     * `scope` 必须显式传这个面板的会话 id，不能靠「活跃会话」兜底：多标签 / 分屏下
     * 停非焦点标签里的子任务时，兜底会去停**焦点会话**那一轮（`stopCommand` 内部按
     * `resolveConvId(scope)` 取 requestId）。
     *
     * 请求回来就把转圈摘掉，不「等到这一行消失」：`stopCommand` 在没命中（子任务刚好自己
     * 跑完 / 服务端那轮已经不在）时是空成功，永远不摘的转圈就成了「点了没反应」的假象。
     * 摘掉后仍可再点 —— 幂等，多按一次没有副作用。
     */
    void stopCommand(toolCallId, conversationId).finally(() => {
      setStopping((prev) => {
        if (!prev.has(toolCallId)) return prev
        const next = new Set(prev)
        next.delete(toolCallId)
        return next
      })
    })
  }

  return (
    <div ref={setRootEl} className="flex shrink-0 flex-wrap items-center gap-1.5">
      {hasSubagents ? (
        <Popover
          open={open === 'subagents'}
          onOpenChange={(next) => setOpen(next ? 'subagents' : null)}
        >
          <BorderBeam
            size="sm"
            colorVariant="colorful"
            theme={theme}
            active={!reducedMotion}
            strength={0.9}
            // 别让 flex 把它压瘦：宽度由药丸自己的内容决定
            style={{ flexShrink: 0 }}
          >
            <PopoverTrigger asChild>
              <DockPill
                icon={<ListTree className="size-3.5 shrink-0 text-muted-foreground" />}
                count={subagents.length}
                label={t('个子智能体')}
                open={open === 'subagents'}
                ariaLabel={
                  open === 'subagents'
                    ? t('收起子智能体')
                    : t('展开子智能体（{count} 个运行中）', { count: subagents.length })
                }
                // 减少动态效果：流光不开，退成静态内描边（与输入卡片同一条规则）
                className={cn(reducedMotion && 'shadow-[inset_0_0_0_1px_var(--primary)]')}
              />
            </PopoverTrigger>
          </BorderBeam>
          <PickerPanel
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            style={{ width: panelWidth }}
          >
            <PickerList className="pt-2" onKeyDown={interceptPanelKeys}>
              {subagents.map((item) => {
                const meta = SUBAGENT_META[item.delegation.subagentId]
                const displayName =
                  item.delegation.name ?? meta?.name ?? item.delegation.subagentId
                const title = firstLine(item.delegation.task) || displayName
                const seconds = Math.max(
                  0,
                  Math.floor((subagentNow - item.delegation.startedAt) / 1000)
                )
                const isStopping = stopping.has(item.toolCallId)
                return (
                  <div key={item.toolCallId} className={DOCK_ROW_CLASS}>
                    {/*
                      行体是**独立的一颗按钮**，停止钮是它旁边的另一颗：
                      `<button>` 套 `<button>` 是非法 HTML，浏览器会把内层拍平 —— 点停止会
                      连带进过程视图，还会嵌套触发一次。

                      点进去先把面板收掉：过程视图是铺满整块的覆盖层，留着面板会飘在它上面
                      （Radix 只在自己的内容外面按下时才关，点行内不会自动关）。
                    */}
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(null)
                        onOpenSubagent(item.toolCallId, item.delegation)
                      }}
                      aria-label={t('查看子任务过程')}
                      title={item.delegation.task}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded text-left"
                    >
                      <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.8125rem] font-medium text-foreground">
                          {title}
                        </span>
                        <span className="flex min-w-0 items-baseline gap-1 text-[0.6875rem] text-muted-foreground">
                          <span className="shrink-0">{displayName}</span>
                          {item.tool ? (
                            <span className="min-w-0 truncate">
                              {t('· 正在 {tool}', { tool: toolLabel(item.tool) })}
                            </span>
                          ) : null}
                          <span className="shrink-0 tabular-nums">· {seconds}s</span>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={isStopping}
                      aria-label={t('停止子任务')}
                      title={t('停止子任务')}
                      onClick={() => stopSubagent(item.toolCallId)}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
                    >
                      {isStopping ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Square className="size-3" />
                      )}
                    </button>
                  </div>
                )
              })}
            </PickerList>
          </PickerPanel>
        </Popover>
      ) : null}

      {hasTasks ? (
        <Popover
          open={open === 'tasks'}
          onOpenChange={(next) => setOpen(next ? 'tasks' : null)}
        >
          <BorderBeam
            size="sm"
            colorVariant="colorful"
            theme={theme}
            // 只有**还在跑**才转：刚结束的任务还会挂 10 秒优雅窗口，那段时间不该亮
            active={!reducedMotion && runningTasks > 0}
            strength={0.9}
            // 别让 flex 把它压瘦：宽度由药丸自己的内容决定
            style={{ flexShrink: 0 }}
          >
            <PopoverTrigger asChild>
              <DockPill
                icon={<SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />}
                count={tasks.rows.length}
                label={t('个后台任务')}
                open={open === 'tasks'}
                ariaLabel={
                  open === 'tasks'
                    ? t('收起后台任务')
                    : runningTasks > 0
                      ? t('展开后台任务（{count} 个运行中）', { count: runningTasks })
                      : t('展开后台任务（{count} 个已结束）', { count: tasks.rows.length })
                }
                className={cn(
                  reducedMotion &&
                    runningTasks > 0 &&
                    'shadow-[inset_0_0_0_1px_var(--primary)]'
                )}
              />
            </PopoverTrigger>
          </BorderBeam>
          <PickerPanel
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            style={{ width: panelWidth }}
          >
            <PickerList className="pt-2" onKeyDown={interceptPanelKeys}>
              {tasks.rows.map((task) => {
                const expanded = tasks.expandedId === task.id
                const isRunning = task.status === 'running'
                // 详情可能还是上一条的（切换那一瞬），对不上就当「加载中」
                const lines = tasks.detail?.task.id === task.id ? tasks.detail.logs : []
                return (
                  <div key={task.id} className={DOCK_ROW_CLASS} data-state={task.status}>
                    <TaskStatusIcon status={task.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        {/* 命令原文：等宽 + 单行截断，长命令不折行把行高撑乱 */}
                        <code
                          className="min-w-0 shrink truncate font-mono text-xs text-foreground"
                          title={task.title}
                        >
                          {task.title}
                        </code>
                        <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">
                          {describeStatus(task, tasks.now, t)}
                        </span>
                      </div>
                      {/* 跑着的时候最新一行日志就是进度（收起来时才有意义，展开后就是冗余） */}
                      {!expanded && isRunning && task.lastLog ? (
                        <div
                          className="truncate font-mono text-[0.6875rem] text-muted-foreground"
                          title={task.lastLog}
                        >
                          {task.lastLog}
                        </div>
                      ) : null}
                      {task.status === 'failed' && task.error ? (
                        <div className="break-words text-[0.6875rem] text-destructive">
                          {task.error}
                        </div>
                      ) : null}
                      {/* 有输出才给展开入口：后台命令的日志就是它唯一的过程证据 */}
                      {task.logCount > 0 ? (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() =>
                            tasks.setExpandedId(expanded ? null : task.id)
                          }
                          className="mt-0.5 inline-flex items-center gap-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <ChevronRight
                            className={cn('size-3 transition-transform', expanded && 'rotate-90')}
                          />
                          <span className="tabular-nums">
                            {t('日志 {count}', { count: task.logCount })}
                          </span>
                        </button>
                      ) : null}
                      {expanded ? (
                        <LogPane
                          lines={lines}
                          loading={tasks.detail?.task.id !== task.id}
                        />
                      ) : null}
                    </div>

                    {isRunning ? (
                      <button
                        type="button"
                        aria-label={t('停止后台命令')}
                        title={t('停止后台命令')}
                        onClick={() => tasks.stop(task.id)}
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        <Square className="size-3" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={t('关闭这条后台任务')}
                        title={t('关闭这条后台任务')}
                        onClick={() => tasks.dismiss(task.id)}
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </PickerList>
          </PickerPanel>
        </Popover>
      ) : null}
    </div>
  )
}
