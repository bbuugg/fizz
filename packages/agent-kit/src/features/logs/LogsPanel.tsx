/**
 * 「应用日志」面板（主区域单例标签 `logs:list`）：全 App 的业务事件记录。
 *
 * ## 形态来源
 *
 * 照搬 dogi 的「主机日志」，三处改造：
 * 1. **不再是主机专属**：命名空间由各功能模块注册（server 侧 `registerNamespace`），
 *    面板从应答里的 `namespaces` 读 Tab 列表，**不写死** —— 新增功能只需注册一行。
 * 2. **Tab = 命名空间**：面板第一层就是命名空间（SSH / 终端 / 隧道 / 插件 …），
 *    切 Tab 只在前端过滤，不重连（日志总量有上限，不值得为每个 Tab 建一条 SSE）。
 * 3. **UI 换成 shadcn**：dogi 那份是 antd，这里用 `Tabs` / `Input` / `Button` / `Badge`。
 *
 * 数据链路见 `logs-store.ts`：挂载时拉全量 + 订阅增量，卸载时断开订阅。
 * 日志产生在 server 侧（`@fizz/workspace` 的 `appLog`），web 与 desktop 同一份。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  FolderOpen,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { toast } from 'sonner'
import type { AppLogEntry, AppLogLevel } from '@fizz/contracts/agent-api'
import { Tabs, TabsList, TabsTrigger } from '@fizz/ui/tabs'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import {
  PanelHeader,
  PanelHeaderActionLabel
} from '@fizz/agent-kit/shared/components/PanelHeader'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import {
  acquireLogs,
  clearLogs,
  getLogsState,
  releaseLogs,
  retryLogs,
  subscribeLogs
} from '@fizz/agent-kit/features/logs/logs-store'

/** 级别展示元数据：状态点颜色 + 文本颜色 */
const LEVEL_META: Record<AppLogLevel, { dot: string; text: string; label: string }> = {
  info: { dot: 'bg-sky-500', text: '', label: '信息' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-500', label: '警告' },
  error: { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-500', label: '错误' }
}

/** 「全部」Tab 的哨兵值（不能与任何命名空间 id 撞车） */
const ALL = '__all__'

/** 单条日志：时间 + 级别点 +（可选）命名空间标签 + 正文；有 detail 时补一行等宽详情 */
function LogRow({ entry, scopeLabel }: { entry: AppLogEntry; scopeLabel?: string }) {
  const meta = LEVEL_META[entry.level]
  const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })
  const full = new Date(entry.ts).toLocaleString('zh-CN', { hour12: false })
  return (
    <div
      className="rounded px-2 py-1 transition-colors hover:bg-accent/50"
      data-log-scope={entry.scope}
      data-log-level={entry.level}
    >
      <div className="flex items-baseline gap-2 text-xs">
        <span
          className={cn('size-1.5 shrink-0 self-center rounded-full', meta.dot)}
          title={meta.label}
        />
        <span className="shrink-0 font-mono text-muted-foreground" title={full}>
          {time}
        </span>
        {/* 命名空间标签只在「全部」Tab 里给（`scopeLabel` 由父级按当前 Tab 决定是否传）——
            单命名空间 Tab 下每条都重复一遍同一个标签很吵 */}
        {scopeLabel && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {scopeLabel}
          </span>
        )}
        <span className={cn('min-w-0 flex-1 break-all whitespace-pre-wrap', meta.text)}>
          {entry.message}
        </span>
      </div>
      {entry.detail && (
        <pre className="mt-1 rounded bg-muted/50 p-1.5 font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
          {entry.detail}
        </pre>
      )}
    </div>
  )
}

export function LogsPanel() {
  const state = useSyncExternalStore(subscribeLogs, getLogsState, getLogsState)
  /** 桌面端：日志目录就在用户本机（server 跑在进程内），可以「打开目录」 */
  const isDesktop = getAgentHostOrNull()?.capabilities.localServer
  const [scope, setScope] = useState<string>(ALL)
  const [keyword, setKeyword] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  // 挂载时拉全量 + 订阅增量；卸载时断开（引用计数，见 logs-store）
  useEffect(() => {
    acquireLogs()
    return () => releaseLogs()
  }, [])

  /**
   * Tab 列表：注册表来的命名空间 + 兜底（出现过但没注册的）。
   *
   * 只显示**有日志的**命名空间，加上当前选中的那个 —— 一个从没记过日志的功能
   * 不必占一个空 Tab（注册项可能有十几个，全列出来一半是空的）。
   */
  const tabs = useMemo(() => {
    const present = new Set(state.entries.map((e) => e.scope))
    const known = state.namespaces.filter((ns) => present.has(ns.id))
    const knownIds = new Set(known.map((ns) => ns.id))
    const extra = [...present]
      .filter((id) => !knownIds.has(id))
      .sort()
      .map((id) => ({ id, label: id }))
    return [...known, ...extra]
  }, [state.namespaces, state.entries])

  // 当前 Tab 失效（日志被清空 / 换了命名空间）时回落到「全部」
  const activeScope = scope !== ALL && !tabs.some((t) => t.id === scope) ? ALL : scope

  const errorCount = state.entries.filter((e) => e.level === 'error').length

  /** 命名空间 id → 展示名（未注册的回落成 id 本身，与服务端的兜底一致） */
  const scopeName = (id: string): string =>
    state.namespaces.find((ns) => ns.id === id)?.label ?? id

  /** 倒序（最新在前）+ 过滤：数据量上限 1000，直接全量换算即可 */
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return state.entries
      .filter((e) => activeScope === ALL || e.scope === activeScope)
      .filter((e) => !kw || e.message.toLowerCase().includes(kw))
      .slice()
      .reverse()
  }, [state.entries, activeScope, keyword])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      retryLogs()
      // 给首帧一点时间，避免按钮动画一闪而过
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具条：版式见 `PanelHeader`（标题在左、按钮在右，窄了按钮只留图标） */}
      <PanelHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            应用日志
            {/* 有「出现过但没注册」的命名空间时提示一下 —— 日志没丢，只是 Tab 名退化成 id，
                这是提醒开发者去 `app-log-namespaces.ts` 补一行注册（见服务端那个文件） */}
            {state.unregistered.length > 0 && (
              <IconTip
                label={`有 ${state.unregistered.length} 个命名空间未注册（${state.unregistered.join('、')}），Tab 名暂用标识代替`}
              >
                <TriangleAlert className="size-3.5 text-amber-500" />
              </IconTip>
            )}
          </span>
        }
        description={`共 ${state.entries.length} 条 · 错误 ${errorCount} 条 · ${
          state.status === 'live'
            ? '实时同步中'
            : state.status === 'loading'
              ? '加载中…'
              : (state.error ?? '未连接')
        }`}
        actions={
          <>
            {/*
              「打开日志目录」只在**桌面端**给：日志的落盘位置是 server 那台机器上的
              （`FIZZ_DATA_DIR` 或 `~/.fizz-server/logs`）。桌面端 server 跑在进程内、
              那台机器就是用户本机，`openPath` 能直接打开；web 端部署在 VPS 上时那是
              VPS 的路径，浏览器碰不到 —— 这时把路径放进悬停提示，让用户自己上服务器看。
            */}
            {state.directory && (
              <Button
                variant="ghost"
                size="sm"
                // 窄容器下这段文案会收成图标（`PanelHeaderActionLabel`），名字得挂在按钮上
                aria-label={isDesktop ? '打开日志目录' : '复制日志目录路径'}
                title={
                  isDesktop
                    ? '在文件管理器中打开日志目录'
                    : `日志目录（在服务端所在机器上）：${state.directory}`
                }
                onClick={() => {
                  if (isDesktop) {
                    void getAgentHostOrNull()?.openPath?.(state.directory)
                    return
                  }
                  // web 端没有本机文件系统：复制路径，用户自己上服务器看
                  void navigator.clipboard?.writeText(state.directory)
                  toast.success('日志目录路径已复制')
                }}
              >
                <FolderOpen className="size-4" />
                <PanelHeaderActionLabel>
                  {isDesktop ? '打开目录' : '复制路径'}
                </PanelHeaderActionLabel>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={refreshing}
              aria-label="刷新"
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
              <PanelHeaderActionLabel>刷新</PanelHeaderActionLabel>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="清空"
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 className="size-4" />
              <PanelHeaderActionLabel>清空</PanelHeaderActionLabel>
            </Button>
          </>
        }
      />

      {/* 命名空间 Tab + 搜索 */}
      <div className="flex shrink-0 items-center gap-2 px-4 sm:gap-3 sm:px-5">
        {/* 命名空间可能很多（注册表十几项），横向滚动而不是挤成一团。
            ⚠️ `pb-2` 是给激活态下划线留的位置：`TabsTrigger` 的 `after` 画在
            `bottom-[-5px]`，容器加了 `overflow-x-auto` 之后它会正好落在裁剪边界外，
            被整条裁掉（表现为「选中的 Tab 没有下划线」）。留出下边距让它有地方画。 */}
        <div className="min-w-0 flex-1 overflow-x-auto pb-2">
          <Tabs value={activeScope} onValueChange={setScope}>
            {/* `w-max` 不能省：`TabsTrigger` 自带 `flex-1`，不限宽的话十几个 Tab
                会被均分撑满、每个都挤成几个字宽 */}
            <TabsList variant="line" className="w-max">
              <TabsTrigger value={ALL}>全部</TabsTrigger>
              {tabs.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索日志…"
            className="h-8 w-28 pl-7 text-xs sm:w-48 lg:w-56"
          />
        </div>
      </div>

      {/* 日志列表（倒序：最新在最上，不用管自动滚动） */}
      <div className="min-h-0 flex-1 overflow-auto px-4 pt-2 pb-6 sm:px-5">
        {state.status === 'loading' && state.entries.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在加载日志…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <ScrollText className="size-12 opacity-30" />
            <div className="text-sm">
              {state.entries.length === 0 ? '还没有日志' : '没有匹配的日志'}
            </div>
            <div className="text-xs">
              各功能模块在运行中产生的业务事件都会记录在这里
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((e) => (
              <LogRow
                key={e.seq}
                entry={e}
                // 只在「全部」Tab 下补命名空间标签（当前 Tab 就是它自己时没必要重复）
                scopeLabel={activeScope === ALL ? scopeName(e.scope) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* 清空确认：按项目约定不用原生 confirm（不跟主题且阻塞渲染），走 ConfirmDeleteDialog。
          日志清空不可恢复，文案要把「落盘文件也清掉」讲清楚。 */}
      <ConfirmDeleteDialog
        open={confirmClear}
        title="清空应用日志？"
        description="内存缓冲与落盘的日志文件都会被清空，且不可恢复。"
        confirmLabel="清空"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearLogs()}
      />
    </div>
  )
}
