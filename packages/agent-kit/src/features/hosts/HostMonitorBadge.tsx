'use client'

/**
 * 远端 SSH 主机的性能监控徽标（状态栏右侧，**只在该主机标签是焦点标签时出现**）。
 *
 * ## 与本机那颗（`SystemMonitorBadge`）的关系
 *
 * 长得一样、零件共用（`shared/components/monitor-parts`），但数据源与生命周期不同：
 * 本机那颗常驻、走 `/api/system`；这颗跟着**焦点主机标签**挂载 / 卸载，走
 * `/api/ssh/hosts/:id/metrics`。服务端按「最近还有人来取数」决定要不要继续采
 * （空闲 30s 回收，见 `server/ssh/monitor.ts`），所以这里的轮询同时充当心跳 ——
 * 切走标签后本组件卸载、请求停止，服务端过一会儿自己收摊，不会养僵尸连接。
 *
 * ## 首帧没有快照是正常的
 *
 * 远端要**现连 SSH + 跑一条命令**（几百毫秒到几秒），服务端刻意不 await 首帧，第一次
 * 轮询通常拿到 `snapshot: null` —— 显示「读取中…」即可，不要把它当错误。
 *
 * ## 「不支持监控」是终态 —— 收到就**整条徽标撤掉**
 *
 * 非 Linux 目标（Windows / BSD / macOS）读不到 `/proc`，服务端连续几轮后上报
 * `unsupported` 并停采（`ssh/monitor.ts` 的 `reportUnsupported`，不会再翻回来）。
 * 这里收到后**停止轮询**，并且 `return null` —— 不支持的主机在状态栏右下角**什么都不留**：
 * 常年摆一句「暂不支持监控」只是白占一块地方，而且每台这类主机都重复一遍，没有信息量
 * （用户要求：不支持就别显示）。
 *
 * ⚠️ 别把 `unsupported` 当成「暂时连不上」：连不上 / 命令跑挂走的是 `error` 那条路
 * （采样器会自愈重试，见 `tick()` 的 `execFailures`），只有「命令跑通了、却一个字段都
 * 读不到」连续若干轮才判 `unsupported`。所以这里隐藏是安全的，不会因为一次网络抖动就
 * 让徽标永久消失。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Server, Timer } from 'lucide-react'
import type { HostMetrics } from '@fizz/contracts/agent-api'
import type { AgentApi } from '@fizz/agent-client/api'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { STATUS_ITEM_CLASS } from '@fizz/agent-kit/shared/lib/status-bar'
import { Popover, PopoverContent, PopoverTrigger } from '@fizz/ui/popover'
import {
  LOAD_TEXT_CLASS,
  Row,
  Section,
  Sparkline,
  UsageBar,
  formatBytes,
  formatRate,
  formatUptime,
  loadLevel,
  pct,
  pctText
} from '@fizz/agent-kit/shared/components/monitor-parts'

/** 可选采集间隔（毫秒）：前端换挡只是换个 `interval` 参数，服务端随即按新节奏采。 */
const INTERVALS = [200, 500, 1000, 2000, 5000] as const
const DEFAULT_INTERVAL = 2000
const INTERVAL_KEY = 'fizz.agent.hostMonitorInterval'

function loadInterval(): number {
  if (typeof window === 'undefined') return DEFAULT_INTERVAL
  const n = Number(window.localStorage.getItem(INTERVAL_KEY))
  return (INTERVALS as readonly number[]).includes(n) ? n : DEFAULT_INTERVAL
}

/**
 * 「数据陈旧」判据。
 *
 * ⚠️ 不能用「服务端 `snapshot.at` 与本机时钟之差」：两端钟不一定同步（远端机器尤其）。
 * 所以只看**本机收到最后一帧之后过了多久**（`receivedAt`），再与服务端给的采样间隔比 ——
 * 超过若干倍没新帧，或最近一次请求失败，就标记为陈旧（灰掉 + 提示），但不隐藏旧值：
 * 先看到上次的数比一片空白有用。
 */
const STALE_FACTOR = 4
const STALE_MIN_MS = 6000

function isStale(receivedAt: number | null, intervalMs: number, error: string | null): boolean {
  if (error) return true
  if (receivedAt === null) return false
  return Date.now() - receivedAt > Math.max(STALE_MIN_MS, intervalMs * STALE_FACTOR)
}

export function HostMonitorBadge({
  api,
  hostId,
  hostName
}: {
  api: AgentApi | null
  hostId: string
  /** 主机名（悬停提示用；不传就只显示指标） */
  hostName?: string
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [metrics, setMetrics] = useState<HostMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [intervalMs, setIntervalMs] = useState(loadInterval)
  /** 本机收到最后一帧的时间（判陈旧用，见 `isStale`） */
  const [receivedAt, setReceivedAt] = useState<number | null>(null)
  /** 每秒重渲染一次，让「陈旧」标记随时间自己亮起来（否则没人触发渲染） */
  const [, forceTick] = useState(0)

  const intervalRef = useRef(intervalMs)
  intervalRef.current = intervalMs

  const changeInterval = useCallback((next: number) => {
    setIntervalMs(next)
    if (typeof window !== 'undefined') window.localStorage.setItem(INTERVAL_KEY, String(next))
  }, [])

  useEffect(() => {
    if (!api) return
    // 换主机 / 换 api：旧数据与旧错误都不能留给新主机
    setMetrics(null)
    setError(null)
    setReceivedAt(null)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      try {
        const next = await api.getSshHostMetrics(hostId, intervalRef.current)
        if (stopped) return
        setMetrics(next)
        setError(null)
        // 拿到新快照才算「新鲜」；首帧 snapshot 仍为 null 时不该刷新新鲜度
        if (next.snapshot) setReceivedAt(Date.now())
        // 「不支持监控」是终态：不再排下一轮，省得每 2 秒白问一次
        if (next.unsupported) return
      } catch (err) {
        if (stopped) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), intervalRef.current)
      }
    }
    void poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [api, hostId])

  // 让陈旧标记随时间推进（只在本组件挂着时跑）
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  if (!api) return null

  const snap = metrics?.snapshot ?? null
  const history = metrics?.history ?? []
  const unsupported = metrics?.unsupported ?? null
  const stale = isStale(receivedAt, intervalMs, error)

  /**
   * 「不支持监控」是终态：**整条徽标撤掉**，不在状态栏里留一句话（见文件头）。
   * 放在这里而不是更早：上面的 `unsupported` 是轮询结果，而所有 hook 都已经跑完了。
   */
  if (unsupported) return null

  const trigger = (): React.ReactNode => {
    if (!snap) {
      return (
        <span className="inline-flex items-center gap-1">
          <Activity className="size-3" />
          {error ? t('监控不可用') : t('读取中…')}
        </span>
      )
    }
    return (
      <>
        <span
          className={cn('inline-flex items-center gap-1 tabular-nums', LOAD_TEXT_CLASS[loadLevel(snap.cpuPercent ?? 0)])}
          title={t('CPU 占用 {value}', { value: pctText(snap.cpuPercent) })}
        >
          <Cpu className="size-3" />
          {pctText(snap.cpuPercent)}
        </span>
        <span
          className={cn('inline-flex items-center gap-1 tabular-nums', LOAD_TEXT_CLASS[loadLevel(snap.memPercent)])}
          title={t('内存占用 {value}%', { value: pct(snap.memPercent) })}
        >
          <MemoryStick className="size-3" />
          {pct(snap.memPercent)}%
        </span>
        {/* 窄屏藏速率：状态栏那点宽度优先留给 CPU / 内存两个百分比 */}
        <span className="hidden items-center gap-2 tabular-nums sm:inline-flex">
          <span className="inline-flex items-center gap-0.5">
            <ArrowDown className="size-3" />
            {formatRate(snap.netRxPerSec)}
          </span>
          <span className="inline-flex items-center gap-0.5">
            <ArrowUp className="size-3" />
            {formatRate(snap.netTxPerSec)}
          </span>
        </span>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={hostName ? t('{host} 性能监控', { host: hostName }) : t('主机性能监控')}
          className={cn(STATUS_ITEM_CLASS, 'gap-2.5', stale && 'opacity-60')}
        >
          {trigger()}
        </button>
      </PopoverTrigger>

      {/* 高度固定 + 夹一层 Radix 可用高度：与 SystemMonitorBadge 同一套（见那边的长注释） */}
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={8}
        className="h-[min(480px,var(--radix-popover-content-available-height,480px))] w-[380px] max-w-[85vw] overflow-y-auto overscroll-contain no-scrollbar p-3"
      >
        {!snap ? (
          <div className="flex min-h-full items-center justify-center py-4 text-center text-xs text-muted-foreground">
            {error ? t('监控不可用：{error}', { error }) : t('正在连接主机并读取指标…')}
          </div>
        ) : (
          <div className="space-y-3">
            {/* 头部：主机名 + 系统 + 状态 */}
            <div className="flex items-center gap-2">
              <Server className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={snap.hostname || hostName}>
                  {snap.hostname || hostName || t('SSH 主机')}
                </div>
                <div className="truncate text-[0.6875rem] text-muted-foreground">
                  {snap.distro || 'Linux'}
                  {snap.release ? ` · ${snap.release}` : ''}
                  {snap.arch ? ` · ${snap.arch}` : ''}
                </div>
              </div>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 text-[0.625rem]',
                  stale ? 'text-muted-foreground' : 'text-muted-foreground'
                )}
              >
                <Activity className={cn('size-3', !stale && 'animate-pulse')} />
                {stale ? t('已陈旧') : t('实时')}
              </span>
            </div>

            {/* 采集间隔换挡 */}
            <div className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">
              <Timer className="size-3" />
              <span>{t('采集间隔')}</span>
              <span className="ml-auto inline-flex items-center gap-0.5">
                {INTERVALS.map((ms) => (
                  <button
                    key={ms}
                    type="button"
                    onClick={() => changeInterval(ms)}
                    className={cn(
                      'cursor-pointer rounded px-1.5 py-0.5 tabular-nums transition-colors',
                      ms === intervalMs
                        ? 'bg-foreground/10 text-foreground'
                        : 'hover:bg-foreground/5'
                    )}
                  >
                    {ms < 1000 ? `${ms}ms` : `${ms / 1000}s`}
                  </button>
                ))}
              </span>
            </div>

            {error && stale && (
              <div className="rounded-md border border-dashed border-border px-2 py-1 text-[0.625rem] text-muted-foreground">
                {t('最近一次读取失败：{error}', { error })}
              </div>
            )}

            {/* 趋势折线（有 ≥2 个点才画得出一条线） */}
            {history.length > 1 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[0.625rem] text-muted-foreground">
                  <span>
                    {t('近约 {seconds} 秒', {
                      seconds: Math.round(
                        ((history.length - 1) * (metrics?.sampleIntervalMs ?? intervalMs)) / 1000
                      )
                    })}
                  </span>
                  <span className="inline-flex items-center gap-2.5">
                    <span className="inline-flex items-center gap-1">
                      <i className="h-0.5 w-3 bg-foreground" /> CPU
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <i className="h-0 w-3 border-t border-dashed border-muted-foreground" /> {t('内存')}
                    </span>
                  </span>
                </div>
                <div className="bg-muted/20 px-1.5 py-1">
                  <Sparkline
                    cpu={history.map((h) => h.cpuPercent)}
                    mem={history.map((h) => h.memPercent)}
                  />
                </div>
              </div>
            )}

            {/* CPU + 负载 */}
            <Section
              icon={<Cpu className="size-3" />}
              title="CPU"
              right={
                <span className={LOAD_TEXT_CLASS[loadLevel(snap.cpuPercent ?? 0)]}>
                  {pctText(snap.cpuPercent)}
                </span>
              }
            >
              <Row
                label={snap.cpuBrand || 'CPU'}
                sub={t('{n} 逻辑核', { n: snap.cores })}
                value={t('{n} 核', { n: snap.cores })}
              />
              <Row label={t('负载 (1 / 5 / 15 分)')} value={`${snap.load1.toFixed(2)} / ${snap.load5.toFixed(2)} / ${snap.load15.toFixed(2)}`} />
              <Row label={t('已运行')} value={formatUptime(snap.uptime)} />
            </Section>

            {/* 内存 + swap */}
            <Section
              icon={<MemoryStick className="size-3" />}
              title={t('内存')}
              right={<span className={LOAD_TEXT_CLASS[loadLevel(snap.memPercent)]}>{pct(snap.memPercent)}%</span>}
            >
              <UsageBar label={t('物理内存')} used={snap.memUsed} total={snap.memTotal} percent={snap.memPercent} />
              {snap.swapTotal > 0 && (
                <UsageBar label="Swap" used={snap.swapUsed} total={snap.swapTotal} percent={snap.swapPercent} />
              )}
            </Section>

            {/* 磁盘 */}
            {snap.disk.length > 0 && (
              <Section icon={<HardDrive className="size-3" />} title={t('磁盘')}>
                <div className="space-y-1.5">
                  {snap.disk.map((d) => (
                    <UsageBar key={d.mount} label={d.mount} used={d.used} total={d.total} percent={d.percent} />
                  ))}
                </div>
              </Section>
            )}

            {/* 网络汇总 */}
            <Section title={t('网络')}>
              <Row
                label={t('合计速率')}
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                      <ArrowDown className="size-2.5" />
                      {formatRate(snap.netRxPerSec)}
                    </span>
                    <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                      <ArrowUp className="size-2.5" />
                      {formatRate(snap.netTxPerSec)}
                    </span>
                  </span>
                }
              />
              <Row label={t('内存占用')} value={`${formatBytes(snap.memUsed)} / ${formatBytes(snap.memTotal)}`} />
            </Section>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
