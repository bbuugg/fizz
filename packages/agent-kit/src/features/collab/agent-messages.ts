/**
 * 协作 Agent 名单的运行态展示口径。
 *
 * 消息本体不再有「每个 Agent 一块独立对话区」—— 所有 Agent 的回复直接进同一条会话
 * 时间线（带 `agentName` 归属）。这里只留下名单面板需要的两样东西：状态点的配色，
 * 以及把流式文本里模型原样吐出的工具标记洗成「[工具名]」。
 */
import { toolLabel } from '@fizz/agent-kit/shared/lib/parts'
import type { CollabAgentStatus } from '@fizz/contracts/types'

/** 状态点 / 文案的配色（名单卡片共用一套观感） */
export const STATUS_META: Record<
  CollabAgentStatus,
  { label: string; dot: string; text: string }
> = {
  idle: { label: '空闲', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
  queued: { label: '排队', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  running: {
    label: '运行中',
    dot: 'bg-emerald-500 animate-pulse',
    text: 'text-emerald-600 dark:text-emerald-400'
  },
  waiting: { label: '等回答', dot: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400' },
  done: { label: '完成', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  error: { label: '出错', dot: 'bg-destructive', text: 'text-destructive' },
  cancelled: { label: '已取消', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' }
}

/** 流式文本里可能混着模型原样吐出的工具调用标记；界面上只展示「做了什么」 */
export function displayLiveText(text: string): string {
  return text
    .replace(
      /<invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/invoke>/gi,
      (_match, name: string) => `[${toolLabel(name)}]`
    )
    .replace(
      /<invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*$/i,
      (_match, name: string) => `[${toolLabel(name)}]`
    )
    .replace(/<\/?invoke\b[^>]*>/gi, '')
    .replace(/<parameter\b[^>]*>|<\/parameter>/gi, '')
    .trim()
}
