/** 内置思考强度适配层：保留原八档、默认值和持久化语义，视觉交互走 `EffortSlider`（ACP 不用它）。 */
import type { AiReasoningEffort } from '@fizz/contracts/types'
import { EffortSlider } from '@fizz/agent-kit/features/chat/EffortSlider'
import { useT } from '@fizz/agent-kit/shared/lib/language'

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

/** 详情等只读展示也使用同一张档位表，避免文案漂移。 */
export function reasoningEffortLabel(value: AiReasoningEffort | null | undefined): string {
  const current = value === 'provider-default' ? null : (value ?? null)
  return LEVELS.find((level) => level.value === current)?.label ?? '默认'
}

export function ReasoningEffortPanel({ value, onChange }: {
  /** `undefined` / `null` / `provider-default` 都按「默认」显示。 */
  value: AiReasoningEffort | null | undefined
  onChange: (next: AiReasoningEffort | null) => void
}) {
  const t = useT()
  const current = value === 'provider-default' ? null : (value ?? null)
  return <EffortSlider
    levels={LEVELS.map((level) => ({ ...level, label: t(level.label) }))}
    value={current}
    onChange={onChange}
    label={t('思考强度')}
    unsetLabel={t('默认')}
    title={(name) => t('思考强度：{name}（下一轮生效；模型不支持时由服务商降级）', { name })}
  />
}
