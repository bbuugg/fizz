/**
 * 会话行首的图标槽：**类型图标 + 运行态**。
 *
 * 三种类型：普通对话 / 外部 ACP agent（机器人）/ 多智能体协作（网络）；
 * 三种运行态**盖在类型之上**（优先级从高到低）：在等确认（盾牌问号）→ 在等回答
 * （问号气泡）→ 正在跑（打字气泡）→ 停下来才回到类型图标。
 * 「在等用户」优先于「在跑」：这时正卡住不动，画成在跑会让人以为还在干活。
 *
 * 为什么抽成组件：标签页（`panel-view/tab-meta.tsx`）与侧栏各要画一遍同一套映射，
 * 各写一套就一定会漂 —— 一边是机器人 / 网络图标、在跑还有气泡，另一边却恒画
 * `MessageSquare`，用户就分不清点下去会开什么、也不知道它在干嘛。
 *
 * 类型判定口径与契约一致：`backend === 'acp'` 才是 ACP（旧值 / 缺省落进普通对话），
 * `kind === 'collab'` 才是协作会话。
 */
import { Bot, MessageCircleQuestion, MessageSquare, Network, ShieldQuestion } from 'lucide-react'
import { Loader } from '@fizz/agent-kit/shared/ai-elements/loader'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { TypingBubble } from '@fizz/agent-kit/features/chat/TypingBubble'
import type { ConversationWaiting } from '@fizz/agent-kit/shared/lib/conversation-activity'

/** 与侧栏其它行首图标同尺寸（`TypingBubble` 自带 `size-4 shrink-0`） */
const ICON = 'size-4 shrink-0'

export function ConversationRowIcon({
  backend,
  kind,
  waiting = null,
  running = false,
  loading = false,
  loadingLabel,
  className
}: {
  backend?: 'builtin' | 'acp'
  kind?: 'chat' | 'collab'
  /** 运行态：正在等用户回应（有它就不看 `running`） */
  waiting?: ConversationWaiting | null
  /** 运行态：有一轮正在跑（已由调用方与 `waiting` 做过去重） */
  running?: boolean
  /** 正在从 agent 侧重新拉取转录（重载会话）：优先盖掉所有状态，否则看起来像没反应 */
  loading?: boolean
  /** loading 的读屏标签：重载 / 重启语义不同，由调用方给 */
  loadingLabel?: string
  /** **追加**的布局类（如重命名态要多一份左外边距）；不要用它改尺寸 / 颜色，会把状态色顶掉 */
  className?: string
}) {
  const t = useT()
  if (loading) {
    return (
      <Loader
        size={16}
        className={cn(ICON, 'text-muted-foreground', className)}
        aria-label={loadingLabel ?? t('正在处理会话')}
      />
    )
  }
  if (waiting) {
    // 区分两种「等你」：权限申请用盾牌、AI 提问用问号气泡
    const label = waiting.kind === 'confirm' ? t('等待确认') : t('等待回答')
    const Icon = waiting.kind === 'confirm' ? ShieldQuestion : MessageCircleQuestion
    return <Icon className={cn(ICON, 'text-amber-500', className)} aria-label={label} />
  }
  if (running) {
    // 打字气泡而不是转圈：一屏十几行转圈太晃，也读不出「在输出」
    return <TypingBubble className={className} />
  }
  if (backend === 'acp') {
    return (
      <Bot className={cn(ICON, 'text-muted-foreground', className)} aria-label={t('ACP 会话')} />
    )
  }
  if (kind === 'collab') {
    return (
      <Network
        className={cn(ICON, 'text-muted-foreground', className)}
        aria-label={t('多智能体协作会话')}
      />
    )
  }
  return (
    <MessageSquare
      className={cn(ICON, 'text-muted-foreground', className)}
      aria-label={t('对话会话')}
    />
  )
}
