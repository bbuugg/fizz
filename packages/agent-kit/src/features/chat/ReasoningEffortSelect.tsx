/**
 * 内置会话的「思考强度」pill —— 只给 内置 Agent，ACP 的思考档是另一个控件
 * （`AcpThoughtLevelSelect`，走 `acpThoughtLevel` / `session/set_config_option`）。
 *
 * 档位随会话落库（`AgentConversation.reasoningEffort`），切换模型不丢。滑块覆盖
 * 「默认 / 无 / 最小 / 低 / 中 / 高 / 极高 / 最高」八档；不支持的档位由服务商自己
 * 降级，UI 不做假设。
 */
import { useState, type CSSProperties } from 'react'
import { Brain } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@fizz/ui/popover'
import { Slider } from '@fizz/ui/slider'
import { LiquidGlassSurface } from '@fizz/ui/liquid-glass'
import type { AiReasoningEffort } from '@fizz/contracts/types'
import { CHAT_ICON_PILL } from '@fizz/agent-kit/features/chat/composer'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** `null` = 默认（不向 provider 下发 reasoning）；其余按强度递增。 */
const LEVELS: readonly { value: AiReasoningEffort | null; label: string }[] = [
  { value: null, label: '默认' },
  { value: 'none', label: '无' },
  { value: 'minimal', label: '最小' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高' },
]

const PIPE_GRADIENT =
  'linear-gradient(90deg, #64748b 0%, #22d3ee 14.29%, #38bdf8 28.57%, #818cf8 42.86%, #a78bfa 57.14%, #f472b6 71.43%, #f43f5e 85.71%, #dc2626 100%)'

export function ReasoningEffortSelect({ app }: { app: AgentApp }) {
  const t = useT()
  // 拖动中保存连续值（如 2.37），松手/点击档位后才吸附到整数档
  const [draftValue, setDraftValue] = useState<number | null>(null)
  // 拖动中给填充条加 transition 会拖泥带水，只在吸附时动画
  const [dragging, setDragging] = useState(false)
  // ACP 走自己的思考档；没选内置模型时也没有可设置的档位
  if (
    app.chatTarget?.backend !== 'builtin' ||
    !app.chatTarget.configId ||
    !app.chatTarget.modelId
  )
    return null

  const current = app.reasoningEffort === 'provider-default' ? null : (app.reasoningEffort ?? null)
  const currentIndex = Math.max(0, LEVELS.findIndex((o) => o.value === current))
  const sliderValue = draftValue ?? currentIndex
  const valueIndex = Math.min(LEVELS.length - 1, Math.max(0, Math.round(sliderValue)))
  const displayValue = LEVELS[valueIndex]?.value ?? null
  const currentLabel = LEVELS[valueIndex]?.label ?? '默认'
  // 同 `AcpThoughtLevelSelect`：切换只影响下一轮（服务端每轮开跑时读会话值）
  const title = t('思考强度：{name}（下一轮生效；模型不支持时由服务商降级）', {
    name: t(currentLabel),
  })
  /*
   * 强度用颜色表达（冷 → 暖）。`!` 压掉 `CHAT_ICON_PILL` 的
   * `hover:[&_svg]:text-primary`，否则鼠标一悬停语义色就没了。
   */
  const iconColor =
    displayValue === 'minimal'
      ? 'text-sky-600! dark:text-sky-400!'
      : displayValue === 'low'
        ? 'text-indigo-600! dark:text-indigo-400!'
        : displayValue === 'medium'
          ? 'text-violet-600! dark:text-violet-400!'
          : displayValue === 'high'
            ? 'text-pink-600! dark:text-pink-400!'
            : displayValue === 'xhigh' || displayValue === 'max'
              ? 'text-red-600! dark:text-red-400!'
              : 'text-muted-foreground!'

  const ratio = sliderValue / (LEVELS.length - 1)
  const rangeStyle: CSSProperties = {
    backgroundImage: PIPE_GRADIENT,
    backgroundSize: ratio === 0 ? '100% 100%' : `${100 / ratio}% 100%`,
    backgroundPosition: 'left center',
    backgroundRepeat: 'no-repeat',
  }
  const commit = (index: number) => {
    // 吸附到最近档位；先落 draft，避免 store 回写前的瞬间跳回旧值
    setDraftValue(index)
    app.setReasoningEffort(LEVELS[index]?.value ?? null)
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) {
          setDragging(false)
          setDraftValue(null)
        }
      }}
    >
      <IconTip label={title}>
        <PopoverTrigger asChild>
          {/* 触发器只放图标：档位名收进 tooltip 与浮层，避免这一排 pill 被文字挤宽 */}
          <button
            type="button"
            className={CHAT_ICON_PILL}
            aria-label={title}
          >
            <Brain className={cn('size-3.5 shrink-0 transition-colors', iconColor)} />
          </button>
        </PopoverTrigger>
      </IconTip>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-80 gap-2">
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="text-xs font-medium">{t('思考强度')}</span>
          <span className="text-xs text-muted-foreground">{t(currentLabel)}</span>
        </div>
        <div className="px-1 pt-1">
          {/* 液态玻璃条：材质与跟随指针的扫光 / 光圈都收在 `LiquidGlassSurface` 里，
              与终端悬浮球（`LiquidGlassButton`）共用同一份配方。
              鼠标指向时只加深投影，不做位移 —— 滑条是交互控件，指向时整条上下跳 1px
              会让人以为指针没对准（用户反馈）。 */}
          <LiquidGlassSurface
            tone="contrast"
            className="transition-shadow duration-200 ease-out hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_22px_50px_-16px_rgba(15,23,42,0.3)]"
          >
            {/* 挡位点：两端不放（条的两头就是端点），只标中间 6 个挡位。
                放在 Slider **之前** = 压在渐变层下面；已填充到的挡位直接**不渲染** ——
                渐变边缘正好落在点的圆心上，留着的话总会有半个点露在右侧（用户反馈）。
                判据用连续的 `sliderValue` 而不是取整后的 `valueIndex`：后者在拖动到
                2.51 时就把第 3 档的点藏掉，而渐变边缘还没走到那里。
                `pointer-events-none` 别去掉 —— 点在条上，必须让指针事件穿过去才能拖动。 */}
            <div aria-hidden className="pointer-events-none absolute inset-0">
              {LEVELS.slice(1, -1).map((level, offset) => {
                const index = offset + 1
                if (index <= sliderValue) return null
                return (
                  <span
                    key={level.value ?? 'default'}
                    className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/25 transition-colors"
                    style={{ left: `${(index / (LEVELS.length - 1)) * 100}%` }}
                  />
                )
              })}
            </div>
            <Slider
              min={0}
              max={LEVELS.length - 1}
              // 细步长让拖动连续顺滑，松手时再按最近档位吸附
              step={0.01}
              value={[sliderValue]}
              onValueChange={(next) => {
                setDragging(true)
                setDraftValue(next[0] ?? 0)
              }}
              onValueCommit={(next) => {
                setDragging(false)
                commit(Math.round(next[0] ?? 0))
              }}
              aria-label={t('思考强度')}
              className="h-7 cursor-pointer"
              // 轨道本身透明：底色由上面那层玻璃给，未填充部分直接透出玻璃材质
              trackClassName="data-horizontal:h-7 rounded-full bg-transparent"
              rangeClassName={cn(
                'rounded-full shadow-[inset_0_1px_1px_rgba(255,255,255,0.3)]',
                !dragging && 'transition-[width,background-size] duration-200 ease-out',
              )}
              rangeStyle={rangeStyle}
              thumbClassName="size-6 border-0 bg-transparent opacity-0 shadow-none ring-0 hover:ring-0 focus-visible:opacity-100 focus-visible:ring-2 active:ring-0"
            />
          </LiquidGlassSurface>
        </div>
        <div className="grid grid-cols-8 gap-0.5 px-0.5">
          {LEVELS.map((level, index) => (
            <button
              key={level.value ?? 'default'}
              type="button"
              aria-pressed={index === valueIndex}
              onClick={() => commit(index)}
              className={cn(
                'rounded py-0.5 text-[10px] leading-tight transition-colors hover:text-foreground',
                index === valueIndex ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(level.label)}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
