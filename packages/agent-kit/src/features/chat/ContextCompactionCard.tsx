/**
 * 上下文压缩（compaction 摘要）的折叠块。
 *
 * 与思考 part 共用同一套视觉 / 交互：可展开收起、流式时自动展开、结束后收起。
 * 自动压缩展示在触发压缩的那条助手消息里（见 `MessageParts`）；
 * 手动压缩没有绑定消息，展示在消息列表末尾（见 `MessageList` 的 trailing compaction）。
 * 不是独立的 sticky 横幅。
 *
 * ⚠️ 数据仍来自会话级 `compaction` 展示态，不写进消息 parts：摘要不是对话内容，
 * 刷新后的真源是会话上的 `autoSummary` / `contextSummary`。
 */
import { CheckCircleIcon, ChevronRight, Minimize2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'
import { useEffect, useState } from 'react'
import { Loader } from '@fizz/agent-kit/shared/ai-elements/loader'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger
} from '@fizz/agent-kit/shared/ai-elements/reasoning'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { REVEAL_ON_HOVER_ARROW } from '@fizz/agent-kit/shared/lib/hover-reveal-arrow'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useConversationOptional } from '@fizz/agent-kit/shared/ai-elements/conversation'
import type { ContextCompactionState } from '@fizz/agent-kit/shared/lib/stores/slices/conversation'

export function ContextCompactionCard({
  compaction
}: {
  compaction: ContextCompactionState
}) {
  const t = useT()
  const streaming = compaction.status === 'streaming'
  const [open, setOpen] = useState(streaming)
  const conversation = useConversationOptional()

  // 压缩中自动展开（正在出摘要得看得见），结束就收起来（用户仍可手动点开）
  useEffect(() => {
    setOpen(streaming)
  }, [streaming])

  return (
    <Reasoning
      className="w-full"
      isStreaming={streaming}
      open={open}
      defaultOpen={false}
      onOpenChange={(next) => {
        conversation?.holdScroll()
        setOpen(next)
      }}
    >
      <ReasoningTrigger>
        {/*
         * ⚠️ **全部靠左、排成一行**，不要 `w-full` + `ml-auto`：
         * 那样会把「状态图标 + 折叠箭头」推到行的最右端，和标题隔开一整屏，看起来像
         * 两条互不相干的元素（用户明确要求它们紧跟标题）。这里与工具卡 `ToolHeader`
         * 同一套排法：图标 → 标题 → 状态 → 箭头，`inline-flex` 只占内容宽度。
         */}
        <span className="inline-flex min-w-0 max-w-full items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground">
            {/* 「向内收拢」的图标 = 压缩本身，不再用仪表盘（那是「用量」的语义） */}
            <Minimize2 className="size-3.5" />
            {t('压缩上下文')}
          </span>
          {/*
           * 状态与工具卡 `ToolHeader` **完全同一口径**：只有一颗图标，无底色、无文案 ——
           * 文案挂在 tooltip 里（悬停可看），读屏靠 `role="img"` + `aria-label`。
           *
           * 进行中用 `Loader`（`ai-elements/loader`，一圈对称辐条）而不是脉冲时钟：与工具卡
           * 同一个理由（见 `tool.tsx` 的 `statusIcon`）—— 脉冲幅度小，长任务里扫一眼分不出它
           * 和静止图标。完成用同一颗绿勾、同一个绿（`text-green-600`）。
           *
           * ⚠️ **不要换回 `Loader2Icon`**（我一开始就是它）：那个圈的弧线不是中心对称的，
           * 转起来轮廓一伸一缩，同一行里看着比旁边的绿勾大一圈，像图标在跳。工具卡换成
           * `Loader` 时踩过同一个坑，这里跟着对齐。
           */}
          <Tooltip delayDuration={100}>
            <TooltipTrigger asChild>
              <span
                role="img"
                aria-label={t(streaming ? '压缩中…' : '完成')}
                className="inline-flex shrink-0 items-center"
              >
                {streaming ? (
                  <Loader size={16} className="shrink-0" />
                ) : (
                  <CheckCircleIcon className="size-4 shrink-0 text-green-600" />
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t(streaming ? '压缩中…' : '完成')}</TooltipContent>
          </Tooltip>
          {/* 箭头与思考行 / 工具卡同一口径：平时隐形，悬停整行才浮出来（触屏常显） */}
          <ChevronRight
            className={cn(REVEAL_ON_HOVER_ARROW, 'size-4 shrink-0', open && 'rotate-90')}
          />
        </span>
      </ReasoningTrigger>
      <ReasoningContent>
        {compaction.text || t('等待模型输出…')}
      </ReasoningContent>
    </Reasoning>
  )
}
