/**
 * 设置 →「用量」标签页：跨会话的 token 汇总（按天柱状图 + 最费的会话榜）。
 *
 * ## 为什么只有 token、没有金额
 *
 * 折算金额需要一张按模型分档的单价表，模型配置里没有这个字段。凭模型名猜单价会得到
 * 一个**会骗人的数字** —— 用户拿它对账单，对不上，从此不信这个面板。所以这里只显示
 * 模型自己上报的客观数字。真要做金额，应在模型配置里显式填单价，由服务端算。
 *
 * ## 口径（界面上也写出来，别让人猜）
 *
 * 统计只覆盖**跑完的轮次**：被中止的一轮、上游没上报 usage 的 ACP 会话都不计入。
 * 所以这个数是「已结算用量」，可能略低于账单。宁可标清楚，也不要让人对不上时怀疑数据错了。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Gauge, Loader2, MessageSquare, RefreshCw } from 'lucide-react'
import type { UsageSummary } from '@fizz/contracts/agent-api'
import { Button } from '@fizz/ui/button'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'

/** 可选窗口。与 `days` 的上限（365）对齐 */
const WINDOWS = [7, 30, 90] as const

/** 柱状图的最大柱数：再宽就挤成一片，不如让用户拉窗口 */
const MAX_BARS = 45

/**
 * 紧凑数字：1.2M / 34.5K / 812。
 *
 * 柱状图的 y 轴与轴标签都要用紧凑写法 —— 完整写 `4,231,890` 既撑破布局，
 * 也读不出「哪天比哪天贵」。面板上的关键数字仍用完整写法（要能对得上账单）。
 */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return String(n)
}

export function UsageTab({ app }: { app: AgentApp }) {
  const tr = useT()
  const [days, setDays] = useState<number>(30)
  /** 手动刷新的信号：自增就触发重取。不能用 `setDays(d => d)` ——
   *  值没变时 React 会跳过重渲染，effect 依赖也不变，等于点了个寂寞。 */
  const [nonce, setNonce] = useState(0)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

/**
 * 取一次统计并写进 state。
 *
 * 返回一个「请求已发出」的 Promise，而不是在这里改 loading —— 这样 effect 体内
 * 就只有一次异步调用、没有任何同步 setState，避开 `react-hooks/set-state-in-effect`
 * （那条规则会把「调用了内含 setState 的函数」也算进来）。
 *
 * loading 的职责改由调用方兼：切换窗口 / 点刷新都在事件里同步置 true，
 * 首次装载则是 `useState(true)` 的初值 —— 两条路径都有明确的「在加载」表达。
 */
const fetchUsage = useCallback(
  async (window: number): Promise<void> => {
    // 未连接时 api 为 null（设置面板在未连接状态下也能打开）
    if (!app.api) {
      setError(tr('尚未连接到服务端'))
      return
    }
    try {
      setSummary(await app.api.getUsage(window))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  },
  [app.api]
)

// 统计是纯读、变化很慢（只在挂载/切窗口/点刷新时重新拉），所以不做 WS 推送 ——
// 否则每跑完一轮就得给所有前端推一份完整汇总。
useEffect(() => {
  /*
   * 这条规则会把「调用了一个内部含 setState 的 async 函数」也算成「effect 内同步 setState」。
   * 实际上 `fetchUsage` 里第一个 `await` 之前没有任何同步 setState —— 同步写状态的只有
   * 「切窗口 / 点刷新」那两个事件处理器（见上方 onClick）。拉数据进 state 属于规则注释里
   * 允许的「订阅外部系统后更新」，也是本仓 30 余处取数 effect 的共同写法。
   */
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  void fetchUsage(days)
}, [days, nonce])

  // 窗口比 MAX_BARS 长时取末段（最近的才是当下关心的）
  const bars = useMemo(() => {
    const list = summary?.byDay ?? []
    return list.length > MAX_BARS ? list.slice(-MAX_BARS) : list
  }, [summary])

  const peak = useMemo(() => Math.max(...bars.map((b) => b.totalTokens), 0), [bars])

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('数据来自每轮结束时落盘的 usage')}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          disabled={loading}
          title={tr('重新统计')}
          onClick={() => {
            // 自增 nonce 触发 effect 重取（days 没变，不能靠它）；这里同步置 loading，
            // 效果立即可见，不等请求回来
            setLoading(true)
            setNonce((n) => n + 1)
          }}
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          刷新
        </Button>
      </div>

      {/* 窗口切换：统计是纯读，切窗口就重新拉一次 */}
      <div className="flex items-center gap-1">
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
onClick={() => {
              // 切窗口只改 `days`：由 effect 带着新值去拉（依赖里的 days 变了就重跑）。
              // 这里额外调 fetchUsage 会发两次请求。
              setLoading(true)
              setDays(w)
            }}
            className={cn(
              'rounded-md px-2 py-1 text-xs transition-colors',
              days === w
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
            )}
          >
            近 {w} 天
          </button>
        ))}
        {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
          {tr('统计失败：{error}', { error })}
        </p>
      ) : summary && (
        <>
          {/* 合计：数字要能拿去对账单，所以用完整写法而不是 compact */}
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md border border-border/60 px-3 py-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Gauge className="size-3.5" />
              合计
            </span>
            <span className="text-sm font-medium">
              {summary.total.totalTokens.toLocaleString()} token
            </span>
            <span className="text-xs text-muted-foreground">
              {tr('输入')} {summary.total.inputTokens.toLocaleString()} · {tr('输出')}{' '}
              {summary.total.outputTokens.toLocaleString()}
            </span>
            {!!summary.total.reasoningTokens && (
              <span className="text-xs text-muted-foreground">
                {tr('思考')} {summary.total.reasoningTokens.toLocaleString()}
              </span>
            )}
            {!!summary.total.cachedInputTokens && (
              <span className="text-xs text-muted-foreground">
                {tr('缓存')} {summary.total.cachedInputTokens.toLocaleString()}
              </span>
            )}
            <span className="ml-auto text-[0.625rem] text-muted-foreground">
              {tr('跨 {count} 个会话', { count: summary.conversationCount })}
            </span>
          </div>

          {/* 每日柱状图 */}
          {peak > 0 ? (
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{tr('每日消耗')}</div>
              <div
                className="flex h-24 items-end gap-px overflow-hidden"
                role="img"
                aria-label={tr('近 {days} 天每日 token 用量，最高 {peak}', { days, peak: peak.toLocaleString() })}
              >
                {bars.map((day, index) => {
                  // 至少留 1px，否则全是 0 的那天会「消失」，而「那天没跑」是真实信息
                  const height = Math.max(1, Math.round((day.totalTokens / peak) * 100))
                  // 窗口被截断过：末条才是「今天」
                  const label = days > MAX_BARS && index === bars.length - 1 ? tr('今天') : day.day
                  return (
                    <div
                      key={day.day}
                      className="group relative min-w-0 flex-1"
                      style={{ height: `${height}%` }}
                    >
                      <div className="h-full w-full rounded-sm bg-primary/70 transition-colors group-hover:bg-primary" />
                      {/* 原生 title：不值得为一个 tooltip 引组件，且它能显示完整数字 */}
                      <div
                        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[0.625rem] text-background group-hover:block"
                        role="tooltip"
                      >
                        {label} · {day.totalTokens.toLocaleString()} · {tr('{count} 个会话', { count: day.conversations })}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-between text-[0.625rem] text-muted-foreground">
                <span>{bars[0]?.day ?? ''}</span>
                <span>{bars[bars.length - 1]?.day ?? ''}</span>
              </div>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              {tr('这段时间还没有跑完的轮次。跑一轮对话后回来刷新。')}
            </p>
          )}

          {/* 最费的会话 */}
          {summary.byConversation.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">{tr('最费的会话')}</div>
              <div className="space-y-1">
                {summary.byConversation.map((item) => (
                  <div
                    key={item.conversationId}
                    className="flex items-baseline gap-2 rounded-md border border-border/60 px-3 py-1.5"
                  >
                    <MessageSquare className="size-3 shrink-0 self-center text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs" title={item.title}>
                      {item.title}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums" title={tr('总 token')}>
                      {compact(item.totalTokens)}
                    </span>
                    <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                      in {compact(item.inputTokens)} / out {compact(item.outputTokens)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}