// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { Gauge } from "lucide-react";
import { type ReactNode } from "react";
import { formatDuration, formatDurationExact } from "@fizz/agent-kit/shared/lib/duration";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@fizz/ui/hover-card";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type TurnUsage } from "@fizz/contracts/types";

/**
 * 一轮结束后的**用量统计**：一颗图标按钮，悬停出卡片（TPS / 各项 token / 缓存命中率 / 耗时）。
 *
 * 为什么从「一整行文字」改成「一颗图标 + 悬停卡片」（用户要求）：那一行（输入 / 输出 /
 * 合计 / 思考 / 缓存 / 耗时）比正文还宽，每条助手消息下面都挂一条，把消息列表压得很碎；
 * 而这些数字是**偶尔核对**的元信息，不是每次都要读的正文。收成一颗图标后，
 * 它和「复制 / 编辑 / 删除」那排操作按钮**同一形态、同一套样式**，视觉上归为「操作」而不是「内容」。
 *
 * 图标沿用圆环那套（`Gauge`）：它与输入框那栏的上下文用量圆环是「同一类信息」的两种粒度
 * —— 那颗是「整个会话的上下文占用」，这颗是「这一轮的账目」。
 */
export function UsageRow({ usage }: { usage?: TurnUsage }) {
  /*
   * 没有 usage 就整颗不渲染（不再有「占位形态」）。
   * 用户已明确要求「不要占位」：占位会把结束那一帧的高度提前撑起来，而那种
   * invisible 的高度在屏幕上就是一片看不见的空白，代价与收益不成比例。
   */
  const t = useT();
  if (!usage) return null;

  /** 卡片里的一个「标签 + 数值」格（`title` 用来挂原始数，如百分比的分子分母） */
  const row = (label: string, value: ReactNode, title?: string): ReactNode => (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );

  /** token 数一行：千分位；值为空（上游没报）就不渲染这一格 */
  const stat = (label: string, value: number | undefined): ReactNode =>
    value === undefined || value === null ? null : row(label, value.toLocaleString());

  /*
   * 缓存命中率 = `cachedInputTokens ÷ inputTokens`。
   *
   * `cachedInputTokens` 是 `inputTokens` 的**子集**（见 `contracts/src/types.ts` 的
   * 「命中缓存的输入 tokens」，以及 `agent/src/context.ts` 里「别照抄 pi 四项相加」那段），
   * 所以分母就是输入 tokens，不用把两者相加。
   *
   * 上游没报这个字段、或这一轮输入为 0（除不出来）时是 `undefined` —— 那一格不渲染，
   * 而不是摆一个凭空的 0%。
   */
  const cachedTokens = usage.cachedInputTokens;
  const hitRate =
    cachedTokens === undefined || !usage.inputTokens ? undefined : cachedTokens / usage.inputTokens;

  /** 一位小数：命中率常见 99.x%，取整会把「几乎全命中」和「全命中」抹成同一个数 */
  const formatRate = (rate: number): string => {
    const pct = Math.round(rate * 1000) / 10;
    return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
  };

  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        {/* 与 `MessageActionRow` 里的复制按钮同一套样式（无边框、hover 底色） */}
        <button
          type="button"
          title={t("本轮用量")}
          aria-label={t("本轮用量")}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <Gauge className="size-4" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-64">
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Gauge className="size-3.5" />
            {t("本轮用量")}
          </div>
          {/*
           * 速度与耗时是「一眼想看」的两个数，放在最上面一行（大一点）。
           * `formatDuration` 短轮次到 0.1s、超一分钟换 `3m 45s`；精确毫秒值放 title。
           */}
          <div
            className="flex items-baseline gap-1.5"
            title={t("整轮耗时 {time}", { time: formatDurationExact(usage.durationMs) })}
          >
            <span className="text-lg font-semibold tabular-nums">
              {usage.tps}
            </span>
            <span className="text-muted-foreground">tok/s</span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {formatDuration(usage.durationMs)}
            </span>
          </div>
          <div className="space-y-0.5 border-t pt-1.5">
            {stat(t("输入"), usage.inputTokens)}
            {stat(t("输出"), usage.outputTokens)}
            {stat(t("合计"), usage.totalTokens)}
            {stat(t("思考"), usage.reasoningTokens)}
            {/*
              * 缓存命中给**百分比**而不是 token 数（用户要求）：这一格要回答的是「这轮的
              * 输入有多少是从缓存里读的」，绝对数看不出比例。原始 token 数挂在 `title`
              * 上，想核对具体数字时悬停即可，不必回到日志里翻。
              */}
            {hitRate === undefined
              ? null
              : row(
                  t("缓存命中率"),
                  formatRate(hitRate),
                  t("缓存命中 {cached} / 输入 {input}", {
                    cached: (cachedTokens ?? 0).toLocaleString(),
                    input: usage.inputTokens.toLocaleString()
                  })
                )}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
