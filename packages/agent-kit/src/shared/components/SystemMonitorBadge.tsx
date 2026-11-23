'use client'

/**
 * 底部状态栏右侧的「服务器性能监控」徽标（类 dogi 的 `MonitorBadge`）+ 详情弹窗。
 *
 * ## 为什么是状态栏里的一行徽标
 *
 * 监控是「服务开着就在跑」的东西，要看它时通常人在别处干活（聊天 / 跑任务），不想专程
 * 切页。原先它是 AI Agent **侧栏底部的一张多行卡片**，但卡片只在「AI Agent」功能区可见，
 * 切到别的功能区就没了。搬到状态栏后两点都解决：整宽常驻（哪个功能区都在），且一行
 * 徽标不占竖向空间 —— 一眼扫过 CPU / 内存，点开才是完整分解（每核 / 磁盘 / 自身进程）
 * + 一条近期趋势折线。指标全由服务端用 Node 内置 API 采集（无 `systeminformation`、
 * 无 `ps`、无子进程）。
 *
 * 徽标样式套 `STATUS_ITEM_CLASS`（`@/shared/lib/status-bar`），与底栏其它条目对齐。
 *
 * ## 数据怎么来
 *
 * 走 HTTP 轮询 `/api/system`（不是 WS）：服务端有个常驻采样器按 ~2s 采一帧，这里按同样
 * 节奏去取快照即可（纯读、不进全局状态推送，与「用量」一个思路）。**关着只取轻量**，
 * **点开弹窗才 `detail`** —— 磁盘这些要 `fs.statfs` 的采集按需才付成本。
 */
import { useEffect, useState } from 'react'
import { Activity, Cpu, Gauge, HardDrive, MemoryStick, Server } from 'lucide-react'
import type { SystemMetrics } from '@fizz/contracts/agent-api'
import type { AgentApi } from '@fizz/agent-client/api'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { STATUS_ITEM_CLASS } from '@fizz/agent-kit/shared/lib/status-bar'
import {
  LOAD_TEXT_CLASS,
  Row,
  Section,
  Sparkline,
  UsageBar,
  formatBytes,
  formatUptime,
  loadLevel,
  pct
} from '@fizz/agent-kit/shared/components/monitor-parts'
import { Popover, PopoverContent, PopoverTrigger } from '@fizz/ui/popover'
import {
  clearLiquidLens,
  GLASS_PANEL_CLASS,
  LiquidGlassPanel,
  trackLiquidLens
} from '@fizz/ui/liquid-glass'

/** 轮询间隔：与服务端采样节奏对齐（快一点也能拿到最新帧） */
const POLL_MS = 2_000

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function SystemMonitorBadge({ api }: { api: AgentApi | null }) {
  const [open, setOpen] = useState(false)
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * 轮询：开合状态进依赖 —— 关着 `detail=false`（轻量），点开 `detail=true`（现采磁盘/进程/温度）。
   * 切换会重跑 effect 顺带立即取一次，比「等下一个周期」更跟手。取消时把 in-flight 结果丢弃。
   */
  useEffect(() => {
    if (!api) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      try {
        const next = await api.getSystemMetrics(open)
        if (!stopped) {
          setMetrics(next)
          setError(null)
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), POLL_MS)
      }
    }
    void poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [api, open])

  // 未连接：状态栏右侧此时也没有别的内容，这里干脆不占地方
  if (!api) return null

  const snap = metrics?.snapshot
  const history = metrics?.history ?? []

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="服务器性能监控"
          className={cn(STATUS_ITEM_CLASS, 'gap-2.5')}
        >
          {snap ? (
            <>
              {/* 徽标是「扫一眼」用的，所以 CPU / 内存这两颗百分比按负载分级上色：
                  偏高黄、很高红；正常不染色，跟着状态栏的 muted 走 */}
              <span
                className={cn(
                  'inline-flex items-center gap-1 tabular-nums',
                  LOAD_TEXT_CLASS[loadLevel(snap.cpuLoad)]
                )}
                title={`CPU 占用 ${pct(snap.cpuLoad)}%`}
              >
                <Cpu className="size-3" />
                {pct(snap.cpuLoad)}%
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 tabular-nums',
                  LOAD_TEXT_CLASS[loadLevel(snap.memUsedPercent)]
                )}
                title={`内存占用 ${pct(snap.memUsedPercent)}%`}
              >
                <MemoryStick className="size-3" />
                {pct(snap.memUsedPercent)}%
              </span>
            </>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Activity className="size-3" />
              {error ? '监控不可用' : '读取中…'}
            </span>
          )}
        </button>
      </PopoverTrigger>

        {/*
          高度**固定**（不再只限上限）：弹层内容分几段长出来 —— 打开时「加载中」→
          首个快照到达 → 第二个采样点画出趋势折线。之前只有 `max-h`，每一段都会把
          弹层撑高一截，而锚点又贴在触发器上方，视觉上就是整块在跳。

          固定值取 380px：按「折线 + CPU / 内存 / 磁盘 / 自身进程」全展开时的实测高度定；
          磁盘更多的机器内容更长，交给内部的 `overflow-y-auto` 滚（滚动条出现与否都不再
          影响外层高度）。同时仍夹一层 Radix 暴露的可用高度 —— Popper 只把「触发器到视口
          边缘还剩多少空间」以 CSS 变量给出（`--radix-popover-content-available-height`），
          小屏上若不夹，弹窗会整块顶出视口、被 body 裁掉（内部滚动救不了屏幕外那截）。

          `collisionPadding` 给一圈呼吸缝：它参与可用空间的计算，不给的话弹窗会死死贴着
          视口边缘，可用高度也算成贴边值。

          `align="end"`：触发器在状态栏**最右**，弹层右缘对齐它、向左展开才不出屏。
        */}
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={8}
        // 与上下文圆环 / 模型下拉同一套液态玻璃外观：实色底 + 描边 + 景深来自
        // `GLASS_PANEL_CLASS`，跟随指针的边缘流光由 `LiquidGlassPanel` 铺。
        // 滚动下放到内层，保证流光钉在面板上、不随内容滚走。
        className={cn(
          'h-[min(380px,var(--radix-popover-content-available-height,380px))] w-[380px] max-w-[85vw] overflow-hidden rounded-xl p-0 ring-0',
          GLASS_PANEL_CLASS
        )}
        onPointerEnter={(event) => trackLiquidLens(event)}
        onPointerMove={(event) => trackLiquidLens(event)}
        onPointerLeave={(event) => clearLiquidLens(event)}
      >
        <LiquidGlassPanel />
        <div className="no-scrollbar h-full overflow-y-auto overscroll-contain p-3">
        {!snap ? (
          // 固定高度下加载 / 报错态居中，别缩在顶部留一大块空
          <div className="flex min-h-full items-center justify-center py-4 text-center text-xs text-muted-foreground">
            {error ? `监控不可用：${error}` : '加载中…'}
          </div>
        ) : (
          <div className="space-y-3">
            {/* 头部：主机名 + 系统 + 实时标记 */}
            <div className="flex items-center gap-2">
              <Server className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={snap.os.hostname}>
                  {snap.os.hostname || '服务器'}
                </div>
                <div className="truncate text-[0.6875rem] text-muted-foreground">
                  {snap.os.distro || snap.os.platform}
                  {snap.os.release ? ` · ${snap.os.release}` : ''} · {snap.os.arch}
                </div>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 text-[0.625rem] text-muted-foreground">
                <Activity className="size-3 animate-pulse" />
                实时
              </span>
            </div>

            {/* 趋势折线（有 ≥2 个点才画得出一条线） */}
            {history.length > 1 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[0.625rem] text-muted-foreground">
                  <span>近约 {Math.round((history.length - 1) * (metrics?.sampleIntervalMs ?? POLL_MS) / 1000)} 秒</span>
                  <span className="inline-flex items-center gap-2.5">
                    <span className="inline-flex items-center gap-1">
                      <i className="h-0.5 w-3 bg-foreground" /> CPU
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <i className="h-0 w-3 border-t border-dashed border-muted-foreground" /> 内存
                    </span>
                  </span>
                </div>
                <div className="bg-muted/20 px-1.5 py-1">
                  <Sparkline cpu={history.map((h) => h.cpuLoad)} mem={history.map((h) => h.memUsedPercent)} />
                </div>
              </div>
            )}

            {/* CPU */}
            <Section
              icon={<Cpu className="size-3" />}
              title="CPU"
              right={<span className={LOAD_TEXT_CLASS[loadLevel(snap.cpuLoad)]}>{pct(snap.cpuLoad)}%</span>}
            >
              <Row label={snap.cpuBrand || 'CPU'} sub={`${snap.cpuCores} 逻辑核`} value={`${snap.cpuCores} 核`} />
              {snap.cpuSpeedGHz != null && <Row label="当前主频" value={`${snap.cpuSpeedGHz.toFixed(2)} GHz`} />}
            </Section>

            {/* 内存 */}
            <Section
              icon={<MemoryStick className="size-3" />}
              title="内存"
              right={
                <span className={LOAD_TEXT_CLASS[loadLevel(snap.memUsedPercent)]}>
                  {pct(snap.memUsedPercent)}%
                </span>
              }
            >
              <UsageBar
                label="物理内存"
                used={snap.memUsed}
                total={snap.memTotal}
                percent={snap.memUsedPercent}
              />
            </Section>

            {/* 磁盘（detail） */}
            {snap.disks.length > 0 && (
              <Section icon={<HardDrive className="size-3" />} title="磁盘">
                <div className="space-y-1.5">
                  {snap.disks.map((d) => (
                    <UsageBar
                      key={d.mount || d.fsType}
                      label={d.mount}
                      sub={d.fsType}
                      used={d.used}
                      total={d.size}
                      percent={d.usedPercent}
                    />
                  ))}
                </div>
              </Section>
            )}

            {/* fizz 进程自身 */}
            <Section icon={<Gauge className="size-3" />} title="fizz 进程">
              <Row label={`Node ${snap.process.nodeVersion}`} value={`RSS ${formatBytes(snap.process.rss)}`} />
              <Row
                label="V8 堆（已用 / 总量）"
                value={`${formatBytes(snap.process.heapUsed)} / ${formatBytes(snap.process.heapTotal)}`}
              />
              <Row label="已运行" value={formatUptime(snap.process.uptimeSeconds)} />
            </Section>
          </div>
        )}
        </div>
      </PopoverContent>
    </Popover>
  )
}