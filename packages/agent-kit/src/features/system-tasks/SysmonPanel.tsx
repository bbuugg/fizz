'use client'

/**
 * 系统监控 + 任务管理器面板（`sysmon:list`，全局单例）。
 *
 * ## 这一页为什么长这样
 *
 * 参考实现是 `linux_web` 的 SystemMonitor：一张主机信息条 + 一排指标卡（CPU / 内存 /
 * 网络）+ 磁盘占用 + 进程表。「照搬」到这里只是**形状**一样，数据通路全部换成本项目的：
 *
 * | 这块 | 数据来源 |
 * |---|---|
 * | 主机信息条 / CPU / 内存 / 磁盘 / 趋势折线 | `GET /api/system?detail=1`（常驻采样器的快照） |
 * | 进程表 / 结束进程 | `GET /api/system/tasks` + `POST /api/system/tasks/kill`（按需现采） |
 *
 * 两套零件也复用状态栏那颗徽标的（`shared/components/monitor-parts`）：同一块界面里的
 * 「75% 转黄、90% 转红」只有一份实现，不然两处慢慢就会漂成两种标准。
 *
 * ## 与状态栏那颗监控徽标的关系（需求里的「独立」）
 *
 * 面板**不读**徽标的任何状态、也不影响它的采样：徽标走常驻采样器（关掉开关就停采），
 * 面板走按需现采（关掉标签就没请求）。所以「关掉系统监控开关」不会让这里变空，
 * 反过来在这里杀掉一个进程也不会让徽标显示出任何变化 —— 它们是同一台机器的两个视角。
 *
 * ## 布局上的一条硬约束
 *
 * **桌面（≥ sm）上进程表必须吃掉剩余全部高度并自己滚**（`min-h-0 flex-1 overflow-auto`）。
 * 上面那排卡片是 `shrink-0`：一张几十行的表如果能把这排卡片顶出视野，用户想对照
 * 「现在 CPU 多少」就得先滚回去 —— 而这正是看进程表时最常做的动作。
 *
 * **手机（< sm）反过来：整个面板是一个滚动容器**。窄屏上卡片是单列，主机信息条与工具栏
 * 还会换行，四张卡就够把一屏占满 —— 再让进程表「自己滚」，它等于永远待在视野外。所以
 * 窄屏把限高去掉（根节点 `overflow-y-auto`、进程区不再 `flex-1`），从上一直滚到表。
 *
 * ⚠️ **进程表在手机上必须塞得进 360–430px**：根节点是 `overflow-y-auto`，按 CSS 规范
 * 另一轴会变成 `auto` —— 表稍微宽一点，整页就会出现**左右滚动条**（2026-11 就是这么报的）。
 * 所以窄屏只留「名称 / PID / CPU % / 内存 % / 结束」，且数值列宽降一档（`w-12`/`w-14`）、
 * 名称列内边距收成 `px-1.5`。加列 / 加宽之前先按 360px 算一遍总宽，别再往表里塞绝对
 * 值列（内存 / 状态 / 累计 CPU / 用户都是 `sm:` / `md:` / `lg:` 才回来的）。
 *
 * ## CPU 百分比的口径
 *
 * **单核 100% 为满**（与 `top` / 任务管理器一致）：一个开满 8 线程的进程会显示 700%+。
 * 卡片上的总占用是 0–100（整机），表里的单进程可以超过 100 —— 两者不是一套口径，
 * 所以列的标题写「CPU %」并给了悬停提示，别让人以为加不起来是 bug。
 */
import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Pause,
  Play,
  RefreshCw,
  Search,
  Server,
  X
} from 'lucide-react'
import type { SystemTaskProcess, SystemTaskState } from '@fizz/contracts/agent-api'
import { Button } from '@fizz/ui/button'
import { Checkbox } from '@fizz/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Input } from '@fizz/ui/input'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import {
  LOAD_TEXT_CLASS,
  Sparkline,
  UsageBar,
  formatBytes,
  formatRate,
  formatUptime,
  loadLevel,
  pct
} from '@fizz/agent-kit/shared/components/monitor-parts'
import type { SysmonController, TaskSortKey } from '@fizz/agent-kit/features/system-tasks/use-sysmon'
import {
  SYSMON_INTERVALS,
  useSysmon
} from '@fizz/agent-kit/features/system-tasks/use-sysmon'

/**
 * 一眼就该警觉的进程名（Linux 与 Windows 各一套）。
 *
 * 只是**提示**不是拦截：真有权限、真知道自己在干什么的人当然可以杀。但要让人在按下
 * 「强制结束」之前多看一眼 —— 杀掉 `sshd` / `winlogon` 是「把机器搞成连不上」的经典事故，
 * 而降级提示的成本几乎为零。
 */
const CRITICAL_NAMES = new Set([
  'init',
  'systemd',
  'launchd',
  'sshd',
  'kthreadd',
  'system',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'explorer.exe'
])

function isCritical(name: string): boolean {
  return CRITICAL_NAMES.has(name.toLowerCase())
}

/** 状态 → 文案 */
const STATE_LABEL: Record<SystemTaskState, string> = {
  running: '运行',
  sleeping: '休眠',
  stopped: '暂停',
  zombie: '僵尸',
  unknown: '—'
}

const STATE_CLASS: Record<SystemTaskState, string> = {
  running: 'text-foreground/90',
  sleeping: 'text-muted-foreground',
  stopped: 'text-amber-500',
  zombie: 'text-destructive',
  unknown: 'text-muted-foreground/70'
}

/**
 * 单进程 CPU 的上色阈值。
 *
 * ⚠️ 与卡片上那个「75 / 90」分级**不是**一套：这里的数字是「单个核的百分比」，一个
 * 单线程进程吃满一个核就是 100%，在 32 核的机器上它只占整机 3%。用整机口径上色的话，
 * 表里永远不会有颜色 —— 而这张表存在的意义恰恰是「一眼找到吃 CPU 的那个」。
 */
function cpuTextClass(percent: number): string {
  if (percent >= 100) return 'text-destructive'
  if (percent >= 50) return 'text-amber-500'
  return 'text-foreground/80'
}

export function SysmonPanel(): React.JSX.Element {
  const sysmon = useSysmon()
  const [target, setTarget] = useState<SystemTaskProcess | null>(null)
  const tasks = sysmon.tasks

  /*
   * 「服务端是不是 Windows」只看**服务端报上来的平台**。
   *
   * ⚠️ 绝不能在这里（或任何前端文件里）用 `process.platform`：这段代码跑在浏览器 /
   * 渲染进程里，`process` 不是全局对象，一引用就是 `ReferenceError: process is not
   * defined`，而且是渲染期抛的 —— 整块面板直接白屏。
   *
   * `snapshot.os.platform` 就是服务端的 `process.platform`（'win32' / 'linux' / 'darwin'）。
   * 指标还没到时退回看采集后端：`cim` / `tasklist` 一定是 Windows，`ps` 一定不是。
   * 两个都拿不到就先按 POSIX 措辞显示（只是文案，不影响真正下发的信号 —— 模式由服务端决定）。
   */
  const serverPlatform = sysmon.metrics?.snapshot.os.platform ?? ''
  const source = tasks?.source ?? ''
  const isWindows =
    serverPlatform === 'win32' ||
    (serverPlatform === '' && (source === 'cim' || source === 'tasklist'))

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background sm:overflow-hidden">
      <HostBar sysmon={sysmon} />
      <StatCards sysmon={sysmon} />

      {/* 进程区：工具栏 + 表。桌面下自己滚；窄屏随整页一起滚（见文件头） */}
      <ProcessToolbar sysmon={sysmon} />
      <div className="sm:min-h-0 sm:flex-1 sm:overflow-auto">
        {sysmon.loading ? (
          // 骨架屏而不是转圈：形状先摆出来，数据一到原地替换（见 ProcessTableSkeleton）
          <ProcessTableSkeleton sysmon={sysmon} />
        ) : sysmon.error && !tasks ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
            <span className="text-destructive">读取失败：{sysmon.error}</span>
            <Button size="sm" variant="outline" onClick={() => void sysmon.refresh()}>
              重试
            </Button>
          </div>
        ) : (
          <ProcessTable sysmon={sysmon} onKill={setTarget} />
        )}
      </div>

      <KillDialog
        target={target}
        busy={sysmon.killingPid !== null}
        isWindows={isWindows}
        childCount={
          target && tasks ? tasks.processes.filter((p) => p.ppid === target.pid).length : 0
        }
        onCancel={() => setTarget(null)}
        onConfirm={(mode, tree) => {
          if (!target) return
          const current = target
          setTarget(null)
          void sysmon.kill({ process: current, mode, tree })
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主机信息条
// ---------------------------------------------------------------------------

function HostBar({ sysmon }: { sysmon: SysmonController }): React.JSX.Element {
  const snapshot = sysmon.metrics?.snapshot
  const stale = sysmon.error !== null

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Server className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">{snapshot?.os.hostname || '服务端'}</span>
      </span>
      {snapshot ? (
        <>
          <span>
            {snapshot.os.distro || snapshot.os.platform}
            {snapshot.os.release ? ` · ${snapshot.os.release}` : ''}
          </span>
          <span>{snapshot.os.arch}</span>
          <span>fizz 已运行 {formatUptime(snapshot.process.uptimeSeconds)}</span>
        </>
      ) : (
        // 首帧指标还没到（`/api/system` 通常几十毫秒，但网络慢 / 正好在重连时会有一瞬），
        // 用两条灰条占位 —— 否则这一行只有主机名，右边的状态与间隔选择会整体左移再弹回去
        <>
          <span className="h-2.5 w-40 animate-pulse rounded bg-foreground/10" />
          <span className="h-2.5 w-16 animate-pulse rounded bg-foreground/10" />
          <span className="h-2.5 w-24 animate-pulse rounded bg-foreground/10" />
        </>
      )}

      <span className="ml-auto inline-flex items-center gap-2">
        {/* 采集状态：只有一件事要看 —— 现在这帧是不是新的 */}
        <span
          className={cn(
            'inline-flex items-center gap-1',
            stale ? 'text-destructive' : 'text-muted-foreground'
          )}
          title={stale ? sysmon.error ?? '' : snapshot ? '最近一次采集成功' : '正在读取'}
        >
          <Activity className={cn('size-3', !stale && !sysmon.paused && 'animate-pulse')} />
          {stale ? '采集失败' : !snapshot ? '读取中' : sysmon.paused ? '已暂停' : '实时'}
        </span>
        {sysmon.lastAt && (
          <span className="font-mono tabular-nums" title="本机收到最后一帧的时刻">
            {new Date(sysmon.lastAt).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
        )}

        {/* 采集间隔换挡（只影响前端轮询节奏；进程表本来就是按请求现采） */}
        <span className="inline-flex items-center gap-0.5">
          {SYSMON_INTERVALS.map((ms) => (
            <button
              key={ms}
              type="button"
              onClick={() => sysmon.setInterval(ms)}
              className={cn(
                'cursor-pointer rounded px-1.5 py-0.5 tabular-nums transition-colors',
                ms === sysmon.intervalMs
                  ? 'bg-foreground/10 text-foreground'
                  : 'hover:bg-foreground/5'
              )}
            >
              {ms < 1000 ? `${ms}ms` : `${ms / 1000}s`}
            </button>
          ))}
        </span>

        <Button
          size="icon-xs"
          variant="ghost"
          title={sysmon.paused ? '继续自动刷新' : '暂停自动刷新'}
          onClick={() => sysmon.setPaused(!sysmon.paused)}
        >
          {sysmon.paused ? <Play className="size-3" /> : <Pause className="size-3" />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          title="立即刷新"
          disabled={sysmon.refreshing}
          onClick={() => void sysmon.refresh()}
        >
          <RefreshCw className={cn('size-3', sysmon.refreshing && 'animate-spin')} />
        </Button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 指标卡
// ---------------------------------------------------------------------------

function StatCard({
  icon,
  title,
  right,
  children
}: {
  icon: React.ReactNode
  title: string
  right?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/20 p-2.5">
      <div className="flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{title}</span>
        {right && <span className="ml-auto text-sm font-bold normal-case tracking-normal text-foreground">{right}</span>}
      </div>
      {children}
    </div>
  )
}

/**
 * 每核占用：**一根细柱一个核**，柱高 = 该核占用。
 *
 * 为什么不是「4 列小进度条 + 每核百分比文字」：32 核的机器上那就是 8 行字，卡片会顶到
 * 半屏高。细柱在几十核时反而更像一张「负载纹理」—— 扫一眼就知道是不是有核跑满了，
 * 具体数值交给悬停提示（`title`）。
 */
function CoreStrip({ values }: { values: number[] }): React.JSX.Element | null {
  if (values.length === 0) return null
  return (
    <div
      // overflow-hidden：几十上百核时固定 gap 之和也会把卡片顶宽（手机上就是整页横向滚动），
      // 宁可在极多核时裁掉最后一两根柱子，也不要让整页横着滚
      className="flex h-8 items-stretch gap-[2px] overflow-hidden"
      title={`每核占用（${values.length} 核）：${values.map((v) => `${pct(v)}%`).join(' / ')}`}
    >
      {values.map((value, index) => {
        const level = loadLevel(value)
        return (
          <div
            key={index}
            className="flex h-full min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-[1px] bg-foreground/10"
          >
            <div
              className={cn(
                'w-full rounded-[1px] transition-[height] duration-500',
                level === 'critical'
                  ? 'bg-destructive'
                  : level === 'elevated'
                    ? 'bg-amber-500'
                    : 'bg-foreground/45'
              )}
              style={{ height: `${Math.max(6, Math.min(100, value))}%` }}
            />
          </div>
        )
      })}
    </div>
  )
}

function StatCards({ sysmon }: { sysmon: SysmonController }): React.JSX.Element {
  const metrics = sysmon.metrics
  const snapshot = metrics?.snapshot
  const history = metrics?.history ?? []
  const net = sysmon.tasks?.net ?? null

  if (!snapshot) {
    // 占位卡也照真卡片的骨架长（标题 + 数值 + 两条内容），比四个纯灰方块更像「在加载」
    return (
      <div className="grid shrink-0 gap-2 p-2 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/20 p-2.5"
          >
            <div className="flex items-center gap-1.5">
              <div className="size-3 animate-pulse rounded bg-foreground/10" />
              <div className="h-2.5 w-10 animate-pulse rounded bg-foreground/10" />
              <div className="ml-auto h-3.5 w-10 animate-pulse rounded bg-foreground/10" />
            </div>
            <div className="h-2.5 w-3/4 animate-pulse rounded bg-foreground/[0.07]" />
            <div className="h-1.5 w-full animate-pulse rounded-full bg-foreground/10" />
            <div className="mt-auto h-2.5 w-1/2 animate-pulse rounded bg-foreground/[0.07]" />
          </div>
        ))}
      </div>
    )
  }

  const disks = snapshot.disks
  const shownDisks = disks.slice(0, 3)

  return (
    <div className="grid shrink-0 gap-2 p-2 sm:grid-cols-2 xl:grid-cols-4">
      {/* CPU */}
      <StatCard
        icon={<Cpu className="size-3" />}
        title="CPU"
        right={
          <span className={LOAD_TEXT_CLASS[loadLevel(snapshot.cpuLoad)]}>
            {pct(snapshot.cpuLoad)}%
          </span>
        }
      >
        <div className="truncate text-[0.625rem] text-muted-foreground" title={snapshot.cpuBrand}>
          {snapshot.cpuBrand || 'CPU'} · {snapshot.cpuCores} 核
          {snapshot.cpuSpeedGHz != null ? ` · ${snapshot.cpuSpeedGHz.toFixed(2)} GHz` : ''}
        </div>
        {/* 只画 CPU 一条线：内存有自己那张卡，两条线挤在这个高度里只会互相看不清 */}
        <div className="bg-background/40 px-1 py-0.5">
          <Sparkline cpu={history.map((h) => h.cpuLoad)} mem={[]} height={30} />
        </div>
        <CoreStrip values={snapshot.cpuLoadPerCore} />
      </StatCard>

      {/* 内存 */}
      <StatCard
        icon={<MemoryStick className="size-3" />}
        title="内存"
        right={
          <span className={LOAD_TEXT_CLASS[loadLevel(snapshot.memUsedPercent)]}>
            {pct(snapshot.memUsedPercent)}%
          </span>
        }
      >
        <UsageBar
          label="物理内存"
          used={snapshot.memUsed}
          total={snapshot.memTotal}
          percent={snapshot.memUsedPercent}
        />
        <div className="flex justify-between text-[0.625rem] text-muted-foreground">
          <span>可用 {formatBytes(snapshot.memAvailable)}</span>
          <span>
            fizz {formatBytes(snapshot.process.rss)} · 堆{' '}
            {formatBytes(snapshot.process.heapUsed)}
          </span>
        </div>
      </StatCard>

      {/* 磁盘 */}
      <StatCard icon={<HardDrive className="size-3" />} title="磁盘">
        {shownDisks.length === 0 ? (
          <div className="py-2 text-[0.625rem] text-muted-foreground">读不到分区信息</div>
        ) : (
          <div className="space-y-1">
            {shownDisks.map((disk) => (
              <UsageBar
                key={disk.mount}
                label={disk.mount}
                used={disk.used}
                total={disk.size}
                percent={disk.usedPercent}
              />
            ))}
            {disks.length > shownDisks.length && (
              <div className="text-[0.625rem] text-muted-foreground">
                另有 {disks.length - shownDisks.length} 个分区未显示
              </div>
            )}
          </div>
        )}
      </StatCard>

      {/* 网络 */}
      <StatCard icon={<Network className="size-3" />} title="网络">
        {net ? (
          <div className="space-y-1 text-[0.6875rem]">
            <div className="flex items-baseline justify-between">
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <ArrowDown className="size-3" />
                下行
              </span>
              <span className="font-mono tabular-nums">{formatRate(net.rxPerSec)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <ArrowUp className="size-3" />
                上行
              </span>
              <span className="font-mono tabular-nums">{formatRate(net.txPerSec)}</span>
            </div>
            <div className="flex justify-between text-[0.625rem] text-muted-foreground">
              <span>累计 ↓ {formatBytes(net.rxTotal)}</span>
              <span>↑ {formatBytes(net.txTotal)}</span>
            </div>
          </div>
        ) : (
          <div className="py-2 text-[0.625rem] leading-relaxed text-muted-foreground">
            当前平台读不到网卡速率。
            <br />
            服务端只在 Linux 上汇总 <code className="font-mono">/proc/net/dev</code>（排除
            lo）—— Windows / macOS 上没有不额外起进程的读取办法。
          </div>
        )}
      </StatCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 进程表
// ---------------------------------------------------------------------------

function ProcessToolbar({ sysmon }: { sysmon: SysmonController }): React.JSX.Element {
  const total = sysmon.tasks?.total ?? 0
  const shown = sysmon.rows.length
  const truncated = sysmon.tasks?.truncated ?? false

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5">
      <div className="relative w-56 max-w-[50vw]">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={sysmon.query}
          onChange={(event) => sysmon.setQuery(event.target.value)}
          placeholder="按名称 / 命令行 / 用户 / PID 筛选"
          className="h-7 pl-7 text-xs"
        />
      </div>

      <span className="inline-flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        {/* 每轮都在采（`ps` / PowerShell 要 0.6~2s），给一个「在动」的信号：
            没有它的话，点完刷新只能靠数字变没变去猜有没有生效 */}
        {sysmon.pulling && <RefreshCw className="size-3 animate-spin" />}
        {sysmon.loading ? (
          <span className="inline-block h-2.5 w-16 animate-pulse rounded bg-foreground/10" />
        ) : (
          <>
            {sysmon.query.trim() ? `${shown} / ${total}` : total} 个进程
            {truncated && sysmon.tasks ? `（只列前 ${sysmon.tasks.processes.length} 个）` : ''}
          </>
        )}
      </span>

      {/* 平台限制说明放这里而不是弹窗：它是这一页的常态，不是异常 */}
      {sysmon.tasks?.note && (
        <span
          className="max-w-full truncate text-[0.625rem] text-muted-foreground/80"
          title={sysmon.tasks.note}
        >
          · {sysmon.tasks.note}
        </span>
      )}

      {sysmon.error && (
        <span className="ml-auto inline-flex items-center gap-1 text-[0.625rem] text-destructive">
          <AlertTriangle className="size-3" />
          {sysmon.error}
        </span>
      )}
    </div>
  )
}

function SortHeader({
  label,
  sortKey,
  sysmon,
  align = 'left',
  className,
  title
}: {
  label: string
  sortKey?: TaskSortKey
  sysmon: SysmonController
  align?: 'left' | 'right'
  className?: string
  title?: string
}): React.JSX.Element {
  const active = sortKey != null && sysmon.sortKey === sortKey
  return (
    <th
      className={cn(
        'whitespace-nowrap px-2 py-1.5 text-[0.625rem] font-medium uppercase tracking-wide',
        align === 'right' ? 'text-right' : 'text-left',
        className
      )}
      title={title}
    >
      {sortKey ? (
        <button
          type="button"
          onClick={() => sysmon.toggleSort(sortKey)}
          className={cn(
            'inline-flex cursor-pointer items-center gap-0.5 transition-colors hover:text-foreground',
            active ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {label}
          {active ? (
            sysmon.sortDir === 'asc' ? (
              <ArrowUp className="size-3" />
            ) : (
              <ArrowDown className="size-3" />
            )
          ) : null}
        </button>
      ) : (
        <span className="text-muted-foreground">{label}</span>
      )}
    </th>
  )
}

/**
 * 表头。**抽出来是为了让骨架屏也能用同一份**（见 `ProcessTableSkeleton`）：
 * 加载中与加载完的表头如果各写一份，列宽会差几个像素，数据一到整张表就横向抖一下。
 */
function ProcessTableHead({ sysmon }: { sysmon: SysmonController }): React.JSX.Element {
  return (
    <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
      <tr>
        <SortHeader label="名称 / 命令行" sortKey="name" sysmon={sysmon} />
        <SortHeader label="PID" sortKey="pid" sysmon={sysmon} align="right" className="w-16" />
        <SortHeader label="用户" sysmon={sysmon} className="hidden w-28 md:table-cell" />
        <SortHeader
          label="CPU %"
          sortKey="cpu"
          sysmon={sysmon}
          align="right"
          className="w-16"
          title="单核 100% 为满；多线程进程可以超过 100"
        />
        <SortHeader label="内存 %" sortKey="mem" sysmon={sysmon} align="right" className="w-16" />
        <SortHeader label="内存" sortKey="rss" sysmon={sysmon} align="right" className="w-20" />
        <SortHeader label="状态" sysmon={sysmon} className="hidden w-16 sm:table-cell" />
        <SortHeader label="累计 CPU" sysmon={sysmon} align="right" className="hidden w-20 lg:table-cell" />
        <th className="w-10 px-1 py-1.5" />
      </tr>
    </thead>
  )
}

/**
 * 骨架行里「名称」那条灰条的宽度表。
 *
 * 刻意做成**长短不一**：一排等宽的灰条看起来像加载失败的空表格，长短错落才像「内容还没
 * 到」。8 条足够铺满大多数屏幕的可视高度，多了纯粹是浪费渲染。
 */
const SKELETON_NAME_WIDTHS = ['w-3/5', 'w-2/5', 'w-4/5', 'w-1/3', 'w-1/2', 'w-2/3', 'w-1/2', 'w-3/4']

/**
 * 进程表的加载骨架（首帧专用）。
 *
 * 与「一个居中的转圈」比，骨架屏能提前把**表格的形状**告诉用户：有哪些列、每行多高。
 * 数据一到就原地替换，没有「一块空白突然变成一张表」的跳变。表头用的是真组件，所以
 * 加载中也能点列头换排序（状态先记下，数据到了立刻按它排）。
 */
function ProcessTableSkeleton({ sysmon }: { sysmon: SysmonController }): React.JSX.Element {
  return (
    <>
      <table className="w-full border-collapse text-xs">
        <ProcessTableHead sysmon={sysmon} />
        <tbody>
          {SKELETON_NAME_WIDTHS.map((width, index) => (
            <tr key={index} className="border-b border-border/30">
              <td className="min-w-0 max-w-0 px-1.5 py-1.5 sm:px-2">
                <div className={cn('h-3 animate-pulse rounded bg-foreground/10', width)} />
                <div className="mt-1 h-2 w-2/3 animate-pulse rounded bg-foreground/[0.06]" />
              </td>
              <td className="px-1.5 py-1.5 sm:px-2">
                <div className="ml-auto h-3 w-10 animate-pulse rounded bg-foreground/10" />
              </td>
              <td className="hidden px-2 py-1.5 md:table-cell">
                <div className="h-3 w-16 animate-pulse rounded bg-foreground/10" />
              </td>
              <td className="px-1.5 py-1.5 sm:px-2">
                <div className="ml-auto h-3 w-8 animate-pulse rounded bg-foreground/10" />
              </td>
              <td className="px-1.5 py-1.5 sm:px-2">
                <div className="ml-auto h-3 w-8 animate-pulse rounded bg-foreground/10" />
              </td>
              <td className="hidden px-2 py-1.5 sm:table-cell">
                <div className="ml-auto h-3 w-12 animate-pulse rounded bg-foreground/10" />
              </td>
              <td className="hidden px-2 py-1.5 sm:table-cell">
                <div className="h-3 w-8 animate-pulse rounded bg-foreground/10" />
              </td>
              <td className="hidden px-2 py-1.5 lg:table-cell">
                <div className="ml-auto h-3 w-10 animate-pulse rounded bg-foreground/10" />
              </td>
              <td className="px-1 py-1.5" />
            </tr>
          ))}
        </tbody>
      </table>
      {/* 骨架是「正在采」而不是「没有数据」，所以配一句话说明慢在哪（放流式布局里，
          不做绝对定位 —— 绝对定位会盖在最后一行灰条上） */}
      <div className="flex items-center justify-center gap-1.5 py-2 text-[0.625rem] text-muted-foreground">
        <RefreshCw className="size-3 animate-spin" />
        正在读取进程表（首次要现采一次，Windows 上约 1~2 秒）
      </div>
    </>
  )
}

function ProcessTable({
  sysmon,
  onKill
}: {
  sysmon: SysmonController
  onKill: (proc: SystemTaskProcess) => void
}): React.JSX.Element {
  const rows = sysmon.rows
  const windowMs = sysmon.tasks?.windowMs ?? 0

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        {sysmon.query.trim() ? '没有匹配的进程' : '没有读到进程'}
      </div>
    )
  }

  return (
    <table className="w-full border-collapse text-xs">
      <ProcessTableHead sysmon={sysmon} />
      <tbody>
        {rows.map((proc) => (
          <tr
            key={proc.pid}
            className={cn(
              'transition-colors hover:bg-secondary/50',
              proc.self && 'bg-destructive/5'
            )}
          >
            <td className="min-w-0 max-w-0 px-1.5 py-1 sm:px-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium" title={proc.name}>
                  {proc.name}
                </span>
                {proc.self && (
                  <span className="shrink-0 rounded bg-destructive/15 px-1 text-[0.5625rem] text-destructive">
                    本服务
                  </span>
                )}
              </div>
              {proc.cmdline && proc.cmdline !== proc.name && (
                <div
                  className="truncate font-mono text-[0.625rem] text-muted-foreground"
                  title={proc.cmdline}
                >
                  {proc.cmdline}
                </div>
              )}
            </td>
            <td className="px-1.5 py-1 text-right font-mono tabular-nums text-muted-foreground sm:px-2">
              {proc.pid}
            </td>
            <td
              className="hidden max-w-0 truncate px-2 py-1 text-muted-foreground md:table-cell"
              title={proc.user}
            >
              {proc.user || '—'}
            </td>
            <td className="px-1.5 py-1 text-right font-mono tabular-nums sm:px-2">
              {/* windowMs = 0 说明还没采到第二帧，此时的 0 是「不知道」而不是「没用 CPU」 */}
              {windowMs === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className={cpuTextClass(proc.cpuPercent)}>{proc.cpuPercent.toFixed(1)}</span>
              )}
            </td>
            <td className="px-1.5 py-1 text-right font-mono tabular-nums sm:px-2">
              <span className={LOAD_TEXT_CLASS[loadLevel(proc.memPercent)]}>
                {proc.memPercent.toFixed(1)}
              </span>
            </td>
            <td className="hidden whitespace-nowrap px-2 py-1 text-right font-mono tabular-nums text-muted-foreground sm:table-cell">
              {formatBytes(proc.rss)}
            </td>
            <td
              className={cn(
                'hidden whitespace-nowrap px-2 py-1 sm:table-cell',
                STATE_CLASS[proc.state]
              )}
              title={proc.rawState}
            >
              {STATE_LABEL[proc.state]}
            </td>
            <td className="hidden whitespace-nowrap px-2 py-1 text-right font-mono tabular-nums text-muted-foreground lg:table-cell">
              {formatUptime(proc.cpuSeconds)}
            </td>
            <td className="px-1 py-1 text-right">
              <Button
                size="icon-xs"
                variant="ghost"
                className={cn(
                  'text-muted-foreground',
                  // 自己这个进程不给按钮：服务端也会挡，但界面上根本不该出现这个入口
                  !proc.self && 'hover:bg-destructive/15 hover:text-destructive'
                )}
                disabled={proc.self || sysmon.killingPid === proc.pid}
                title={
                  proc.self
                    ? '这是承载界面的 fizz 进程，不能从这里结束'
                    : `结束 ${proc.name}（pid ${proc.pid}）`
                }
                onClick={() => onKill(proc)}
              >
                {sysmon.killingPid === proc.pid ? (
                  <RefreshCw className="size-3 animate-spin" />
                ) : (
                  <X className="size-3.5" />
                )}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------------------
// 结束进程确认
// ---------------------------------------------------------------------------

/**
 * 结束进程的确认弹窗。
 *
 * 为什么值得一个弹窗（而不是行内一次点击就杀）：进程不会「撤回」。误点一下就可能让一个
 * 跑了半天的任务归零，所以这里把三件事摆在明面上 —— **它是什么**（名字 / pid / 用户 /
 * 命令行）、**用什么方式**（温和 / 强制）、**要不要连子进程**。默认停在最温和的一档。
 */
function KillDialog({
  target,
  busy,
  childCount,
  isWindows,
  onCancel,
  onConfirm
}: {
  target: SystemTaskProcess | null
  busy: boolean
  childCount: number
  /**
   * **服务端那台机器**是不是 Windows（决定文案说 `taskkill` 还是 `SIGTERM`）。
   *
   * ⚠️ 必须由外面传进来，**不能在这里写 `process.platform`** —— 这个文件跑在浏览器里，
   * `process` 不是全局对象，一引用就是 `ReferenceError: process is not defined`，
   * 而且是在渲染期炸的，整块面板直接白屏。判据取 `snapshot.os.platform`（那才是服务端的
   * `process.platform`），拿不到时退回看采集后端（`cim` / `tasklist` 一定是 Windows）。
   */
  isWindows: boolean
  onCancel: () => void
  onConfirm: (mode: 'term' | 'kill', tree: boolean) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'term' | 'kill'>('term')
  const [tree, setTree] = useState(false)

  /*
   * 换目标就把两个开关拨回默认。
   *
   * ⚠️ 不能只写在 `onOpenChange` 里：点「结束进程」是父组件把 `target` 置空关掉弹窗的，
   * Radix 的 `onOpenChange` 根本不会因此触发。少了这个 effect，上一轮选的「强制结束 +
   * 连子进程」会悄悄带到下一个进程上 —— 那是最不该被继承的两种选择。
   */
  useEffect(() => {
    setMode('term')
    setTree(false)
  }, [target?.pid])

  const critical = target ? isCritical(target.name) : false

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>结束进程？</DialogTitle>
          <DialogDescription>
            将要结束 <strong className="text-foreground">{target?.name}</strong>（PID{' '}
            {target?.pid}）
            {target?.user ? `，运行用户 ${target.user}` : ''}。这个操作无法撤销。
          </DialogDescription>
        </DialogHeader>

        {target?.cmdline && (
          <div className="max-h-20 overflow-auto rounded border border-border/60 bg-muted/30 p-2 font-mono text-[0.625rem] break-all text-muted-foreground">
            {target.cmdline}
          </div>
        )}

        {critical && (
          <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[0.6875rem] text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              这是系统关键进程。结束它可能让这台机器失去远程登录能力或直接重启 —— 确认你知道
              后果再继续。
            </span>
          </div>
        )}

        {/* 方式选择：两档并排，默认温和 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            aria-pressed={mode === 'term'}
            onClick={() => setMode('term')}
            className={cn(
              'cursor-pointer rounded-md border px-2 py-1.5 text-left transition-colors',
              mode === 'term'
                ? 'border-ring bg-accent/60'
                : 'border-border/60 hover:bg-accent/30'
            )}
          >
            <div className="text-xs font-medium">温和结束</div>
            <div className="text-[0.625rem] text-muted-foreground">
              {isWindows
                ? 'taskkill 不带 /F，先请它自己退'
                : 'SIGTERM，给它落盘 / 关连接的机会'}
            </div>
          </button>
          <button
            type="button"
            aria-pressed={mode === 'kill'}
            onClick={() => setMode('kill')}
            className={cn(
              'cursor-pointer rounded-md border px-2 py-1.5 text-left transition-colors',
              mode === 'kill'
                ? 'border-destructive/60 bg-destructive/10'
                : 'border-border/60 hover:bg-accent/30'
            )}
          >
            <div className="text-xs font-medium">强制结束</div>
            <div className="text-[0.625rem] text-muted-foreground">
              {isWindows ? 'taskkill /F，直接终止' : 'SIGKILL，立即终止'}
            </div>
          </button>
        </div>

        <label className="flex items-start gap-2 text-[0.6875rem]">
          <Checkbox
            className="mt-0.5"
            checked={tree}
            onCheckedChange={(value) => setTree(value === true)}
          />
          <span className="text-muted-foreground">
            连子进程一起结束
            {childCount > 0 ? `（按上一次采样，有 ${childCount} 个直接子进程）` : ''}
            <br />
            <span className="text-[0.625rem] text-muted-foreground/80">
              {isWindows
                ? '交给 taskkill /T 展开整棵子树'
                : '按 ppid 从深到浅逐个发信号，避免父进程退出前又把子进程拉起来'}
            </span>
          </span>
        </label>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => onConfirm(mode, tree)}
          >
            {busy ? <RefreshCw className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            {mode === 'kill' ? '强制结束' : '结束进程'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
