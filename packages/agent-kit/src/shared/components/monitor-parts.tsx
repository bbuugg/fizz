'use client'

/**
 * 监控徽标 / 详情弹窗的**共用零件**。
 *
 * 本机监控（`SystemMonitorBadge`，数据来自 `/api/system`）与远端 SSH 主机监控
 * （`features/hosts/HostMonitorBadge`，数据来自 `/api/ssh/hosts/:id/metrics`）是两份
 * 不同的数据源，但「怎么把一份指标画成徽标 + 弹窗」这件事**完全一样** —— 分级配色、
 * 字节 / 速率 / 运行时长格式化、迷你折线、分区小标题 / 行 / 进度条。
 *
 * 抽到这里只有一个理由：**两处必须长得一模一样**。同一块状态栏里，本机那颗与主机那颗
 * 如果各写一套阈值或各写一个格式化函数，慢慢就会漂成「一个黄一个灰」，读的人反而以为
 * 出问题了。零件只放**纯展示 + 纯函数**，不碰任何数据获取。
 */
import type { ReactNode } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { t } from '@fizz/i18n'
import { Progress } from '@fizz/ui/progress'

/**
 * 负载分级：按百分比把指标分成「正常 / 偏高 / 很高」三档，每档一个语义色。
 *
 * 阈值取 75 / 90：75 以下都算正常 —— 负载本来就有波动，压到 60 就叫黄会天天闪，
 * 警示色一旦常态出现就等于没有。90 以上基本是跑满了，给红色。
 *
 * CPU / 内存 / 磁盘共用这一套（`UsageBar` 与徽标都走它），免得同一块界面里
 * 每个指标各写一个阈值、颜色标准还不一致。
 */
export type LoadLevel = 'normal' | 'elevated' | 'critical'

export function loadLevel(percent: number): LoadLevel {
  if (percent >= 90) return 'critical'
  if (percent >= 75) return 'elevated'
  return 'normal'
}

/**
 * 负载分级 → 文本色类名。
 *
 * `normal` 刻意留空：常态跟着容器自己的颜色走（徽标是 `STATUS_ITEM_CLASS` 的
 * muted-foreground、弹窗是 foreground/80~90），不把「正常」也染上色 ——
 * 满屏都是色块的话，真正的告警反而没人注意。
 */
export const LOAD_TEXT_CLASS: Record<LoadLevel, string> = {
  normal: '',
  elevated: 'text-amber-500',
  critical: 'text-destructive'
}

// ---------------------------------------------------------------------------
// 格式化（全部纯函数）
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / 1024 ** i
  const text = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1)
  return `${text} ${units[i]}`
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  if (sec < 60) return t('{n} 秒', { n: Math.floor(sec) })
  const m = Math.floor(sec / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return t('{d} 天 {h} 时', { d, h: h % 24 })
  if (h > 0) return t('{h} 时 {m} 分', { h, m: m % 60 })
  return t('{m} 分', { m })
}

export const pct = (n: number): number => Math.round(n)

/** 百分比可能为首帧 null（远端第一次采样没有基准）：显示破折号而不是假的 0% */
export const pctText = (n: number | null): string => (n == null ? '—' : `${pct(n)}%`)

// ---------------------------------------------------------------------------
// 迷你趋势折线：内联 SVG，两条线（CPU 实线 / 内存虚线），viewBox 横向拉伸
// ---------------------------------------------------------------------------

export function Sparkline({
  cpu,
  mem,
  height = 44
}: {
  cpu: number[]
  mem: number[]
  height?: number
}) {
  const n = Math.max(cpu.length, mem.length, 2)
  const toPoints = (arr: number[]): string =>
    arr
      .map((v, i) => {
        const x = (i / (n - 1)) * 100
        const y = height - (Math.min(Math.max(v, 0), 100) / 100) * height
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' ')

  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      className="w-full"
      role="img"
      aria-label="CPU 与内存近期占用趋势"
    >
      <polyline
        points={toPoints(cpu)}
        fill="none"
        stroke="var(--foreground)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={toPoints(mem)}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
        strokeDasharray="3 3"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// 详情弹窗里的小零件
// ---------------------------------------------------------------------------

export function Section({
  icon,
  title,
  right,
  children
}: {
  icon?: ReactNode
  title: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 text-[0.6875rem] font-medium text-muted-foreground">
        {icon}
        <span>{title}</span>
        {right && (
          <span className="ml-auto font-normal tabular-nums text-foreground/80">{right}</span>
        )}
      </div>
      <div className="space-y-1 pl-0">{children}</div>
    </div>
  )
}

export function Row({
  label,
  value,
  sub
}: {
  label: ReactNode
  value: ReactNode
  sub?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[0.6875rem]">
      <span
        className="min-w-0 truncate text-muted-foreground"
        title={typeof sub === 'string' ? sub : undefined}
      >
        {label}
      </span>
      <span className="shrink-0 tabular-nums text-foreground/90">{value}</span>
    </div>
  )
}

/** 一条「已用 / 总量 + 进度条」（内存 / swap / 磁盘都用它） */
export function UsageBar({
  label,
  sub,
  used,
  total,
  percent
}: {
  label: string
  sub?: string
  used: number
  total: number
  percent: number
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-2 text-[0.6875rem]">
        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
          <span className="truncate">{label}</span>
          {sub && <span className="shrink-0 text-[0.625rem] text-muted-foreground">{sub}</span>}
        </span>
        {/* 与徽标同一个分级：这样弹窗里的百分比和状态栏那颗对得上，不会一个红一个灰 */}
        <span
          className={cn(
            'shrink-0 tabular-nums text-foreground/90',
            LOAD_TEXT_CLASS[loadLevel(percent)]
          )}
        >
          {formatBytes(used)} / {formatBytes(total)} · {pct(percent)}%
        </span>
      </div>
      <Progress value={percent} className="h-1.5" />
    </div>
  )
}
