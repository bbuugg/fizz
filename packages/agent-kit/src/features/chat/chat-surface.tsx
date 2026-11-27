"use client";

/**
 * 会话主界面（消息列表 + 输入框 + 落底指示器）—— 主会话与容器工作台**共用的一份**。
 *
 * ## 为什么要这一个文件
 *
 * 两处会话视图本来各写一份消息流 + 输入框：
 * - 主会话 `ChatPanel`（对话视图）—— 数据来自 `useAgentApp`；
 * - 容器工作台 `flow/node-workbench.tsx`（流程节点）—— 数据来自 `useNodeWorkbench`。
 *
 * 两边的**观感必须一致**（注释里明写了「否则两边会各自漂移」），但那时只有「零件」共用
 * （`MessageParts` / `ThinkingRow` / `MessageActionRow` / `Composer`），**外层结构**仍是两份手写
 * JSX：滚动容器、对齐壳、落底钮、消息循环、零 part 分支、空态各写一遍。改一处漏一处就漂。
 * 这里把外层结构也收进来，数据与两侧特有的部分走 props。
 *
 * ## 刻意留在调用方的东西（语义不同，不该共用）
 *
 * - 顶栏 / 右侧面板（终端、文件、git）：工作台那边标签只有两个，主会话三个；
 * - 输入框两侧的 pill：主会话是「工作区 + 权限 / 后端模型」，工作台是「权限 / 容器模型」；
 * - 输入框上方的卡片：主会话是「待发送队列」，工作台是「待答复权限 + 当前任务」；
 * - 待答复的权限卡走 `cover`：直接顶替输入卡片（审批期间 agent 停着，输入框无用）；
 * - 消息级操作：主会话能编辑重发 / 删除；工作台与 acp 会话的历史改不了（只留复制）。
 *
 * 它们通过 `leading` / `trailing` / `header` / `above` / `renderActions` 这几个槽位进来。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  Bot,
  ChevronLeft,
  CircleHelp,
  Loader2,
  MessageSquare,
  RotateCw,
  Unplug
} from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { SubagentViewProvider, type OpenSubagent } from '@fizz/agent-kit/features/chat/subagent-view'
import {
  WorkspaceFileOpenerProvider,
  type WorkspaceFileOpener
} from '@fizz/agent-kit/features/files/open-file'
import { SUBAGENT_META, type SubagentDelegation } from '@fizz/contracts/types'
import { workDurationLabel } from '@fizz/agent-kit/shared/lib/turn-step'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton
} from '@fizz/agent-kit/shared/ai-elements/conversation'
import { Message, MessageContent } from '@fizz/agent-kit/shared/ai-elements/message'
import { Skeleton } from '@fizz/ui/skeleton'
import { Popover, PopoverContent, PopoverTrigger } from '@fizz/ui/popover'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { isTouchOnlyInput } from '@fizz/agent-kit/shared/hooks/useVirtualKeyBar'
import { ComposerDock, collectRunningSubagents } from '@fizz/agent-kit/features/chat/ComposerDock'
import { MessageOutline } from '@fizz/agent-kit/features/chat/MessageOutline'
import { ChatFind } from '@fizz/agent-kit/features/chat/chat-find'
import { ContextCompactionCard } from '@fizz/agent-kit/features/chat/ContextCompactionCard'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useConversationActivity } from '@fizz/agent-kit/shared/lib/conversation-activity'
import { Composer } from '@fizz/agent-kit/features/chat/composer'
import {
  MessageActionRow,
  MessageParts,
  ThinkingRow,
  type MessageFollowupBridge
} from '@fizz/agent-kit/features/chat/message-parts'
import { waitingIndicatorSlot } from '@fizz/agent-kit/shared/lib/waiting-indicator'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import type { AgentConfirmRequest } from '@fizz/contracts/types'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { ContextCompactionState } from '@fizz/agent-kit/shared/lib/stores/slices/conversation'
import { recoveryStatusText } from '@fizz/agent-kit/shared/lib/stores/slices/conversation'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

// ---------------------------------------------------------------------------
// 消息列表
// ---------------------------------------------------------------------------

/** 首屏渲染的消息条数：再往上滚一次追加一批（见 `MessageList` 里的 `visibleCount`） */
const INITIAL_VISIBLE_MESSAGES = 40
/** 每次「加载更早」追加的条数 */
const LOAD_OLDER_STEP = 40

export interface MessageListProps {
  /** 助手等独立会话宿主提供自己的取消通道。 */
  onStopTool?: (toolCallId: string) => void
  onStopTurn?: () => void
  messages: AgentChatMessage[]
  /**
   * 这些消息属于哪条会话（`ChatPanel` 传当前那条）。
   *
   * 给「上拉刷新」用（`onRefresh` → `reloadConversation`）：多标签面板里可能同时挂着好几条
   * 会话，读「当前会话」会刷错。不传（容器工作台）就**不挂**上拉刷新 —— 那边没有「重拉这条
   * 会话」的语义。
   */
  conversationId?: string
  /** 本轮是否在跑（末条助手消息的处理、流式结束后的操作行都看它） */
  streaming: boolean
  /**
   * 正在回放现场（断线重连后服务端从帧日志头部重放这一轮）—— 只影响滚动跟随方式。
   *
   * 回放是「先把这一轮的 parts 清空、再逐帧重建」，内容高度先塌后长；这段窗口里若还
   * 用流式那套 spring 平滑跟随，用户看到的就是「消息列表像在重新加载、一直从顶部往下
   * 滚」。所以回放期间降级成**瞬时贴底**（与图片加载完成那类「没人操作却长高」同理，
   * 见 ai-elements/conversation.tsx 的 smoothResize 说明）。默认 false。
   */
  replaying?: boolean
  /**
   * 变化时**瞬时落底**：切会话 / 历史装载完成 / 自己发出新消息。
   * 用户往上翻过历史后滚动容器已退出跟随，靠「内容变高」那套贴底救不回来，必须显式落底。
   */
  resetKey: string
  /**
   * 消息列的壳类名。其中的 `max-w-*` 就是「内容右缘到面板右缘」那条空白带的宽度来源：
   * 面板够宽（≥820px）时带子宽得放得下目录那列横杠，不必给内容让位；面板一窄就靠
   * `--rail-channel` 补右内边距（见下面对 `ConversationContent` 的注释）。
   *
   * 纵向内边距压到最小（上下各 4px）：用户明确要求「下面空白太大不能接受」，
   * 而滚动容器是贴底的 —— 这里的 `pb` 会**原样变成滚到底之后那片空白的底**。
   * 代价：末条消息的操作行贴着滚动区底边，悬停显形时可能被裁剪线切到一点。
   * 不能压到 0：留一点点，至少让末条消息的按钮不正好压在边上。
   *
   * 横向务必保留移动端内边距（`px-2`，与 `ChatComposer` 的 `p-2` 对齐）：
   * 只写 `sm:px-6` 的话手机上消息会**左右贴边**（用户报过「左边没有边距」）。
   */
  contentClassName?: string
  /** 消息流**之前**的内容（如连接中断 sticky 条） */
  header?: ReactNode
  /**
   * 历史装载失败：给了就整块替换消息流（调用方传自己的「错误 + 重试」组件）。
   * ⚠️ 必须与 `loading` 互斥判断：装载窗口里先上骨架，别闪错误。
   */
  error?: ReactNode
  /** 历史装载中：还没有任何消息时上骨架屏（形状对齐真实消息流） */
  loading?: boolean
  /**
   * 正在删消息（「仅本条」/「本条及其后」/ 编辑重发里的那一步）。
   *
   * 删除完成后要整体回拉历史，中途再点别的消息（编辑 / 删除 / 签出）只会让两边的回拉
   * 互相盖，所以这段窗口里**消息内容暂时不接收点击**（滚动照常）、顶部挂一条进度。
   * 用户报过「删的时候很慢、没有任何提示，还能继续点别的消息」。
   */
  deleting?: boolean
  /** 一条消息都没有时的内容（会包在 `ConversationEmptyState` 里） */
  emptyState?: ReactNode
  /** 提问卡的作答通道；不传 = 提问卡只读（容器工作台没有） */
  followup?: MessageFollowupBridge
  /**
   * 本会话正在等答复的审批：对应的工具卡 / 分组抬头据此显示「等待审批」。
   * 不传 = 没有审批现场（容器侧、子任务片段）。
   */
  pendingConfirms?: AgentConfirmRequest[]
  /**
   * 消息下方的**文档入口**（本轮写出的 markdown 文档，见
   * `shared/lib/artifacts.ts`）。返回 null 则不渲染。
   *
   * ⚠️ 这里**不再有 `renderFooter`**（原先放「本轮用量」那一行）：2026-10 用户要求把
   * 用量收成一颗图标、与「复制」并排在同一行里，于是它改走 `renderActions` 的
   * `usageSlot`（见 `MessageActionRow`）。**别再往正文下方加常驻的一行元信息** ——
   * 那种行比正文还宽，每条消息下面挂一条会把列表压得很碎，用户已明确不接受。
   */
  renderArtifacts?: (message: AgentChatMessage) => ReactNode
  /**
   * 消息条底部的操作行。返回 null 则不渲染。
   * ⚠️ 「流式输出的最后一条助手消息」这条规则由本组件统一挡掉，调用方不必自己判 ——
   * 内容还在长时复制到的是半截文本、删除也容易点错时机。
   *
   * ⚠️ 但**该条上这个回调仍会被调用一次**：返回的节点会被渲染进一个不可见、不可交互的
   * 壳里**占位**（理由见下面那段注释）。所以实现里不要带副作用，也不要假设「被调用 =
   * 用户能点到」。
   */
  renderActions?: (args: MessageActionArgs) => ReactNode
  /**
   * 消息目录：右侧「拉线」时间轴，用户消息各占线上的一个点，指针移到点上跳转。
   * 桌面与窄屏共用同一形态（见 `MessageOutline`）。
   */
  outline?: boolean
  /**
   * 模型请求正在重试：把「第 N 次重试」这条**单条**提示渲染在「正在思考…」的位置。
   * `attempt` 变化时整条重建，重放一遍入场动画；屏幕上始终只有一条。
   * 带 `resume` 时是断点续跑（内容保留、接着失败那一步），文案也会区分。
   */
  retryNotice?: RetryNoticeView | null
  /**
   * 连接断了但服务端那轮还在跑：正在自动重接（第几次）。渲染在「正在思考…」的位置 ——
   * 用户看到的是「没新内容是因为连接断了」，而不是「卡住了」。与 `retryNotice` 同位，
   * 两者同时出现时优先显示重连（连接不通时重试提示没有意义）。
   */
  reconnectNotice?: { attempt: number } | null
  /**
   * 当前会话的上下文交接文档。带着 `messageId`（触发压缩的那条助手消息）时作为该消息
   * 里的一个折叠块渲染；手动压缩没有绑定消息（`messageId` 缺省），渲染在消息列表末尾。
   * 两者与思考 part 同一形态，不再放在列表顶部。
   */
  compaction?: ContextCompactionState | null
  /**
   * 正在编辑重发的那条消息（null = 不在编辑）。该条消息加描边压暗，输入框上方同时显示
   * 「编辑消息」条 —— 两处一起才是完整标识：条上写着原文，消息上是它在哪。
   */
  editingMessageId?: string | null
  /**
   * 「继续」：撞上步数上限的那条助手消息底部有颗按钮，点它发一条新消息把任务续下去。
   * 不传 = 只显示提示、不给按钮（容器工作台没有「发消息」的语义）。
   */
  onContinueMessage?: (message: AgentChatMessage) => void
  /**
   * 多智能体协作的**实时回复**（还没落盘的那些）：渲染在消息流末尾，和正式消息长得一样，
   * 只是不挂操作行。本轮结束（`streaming` 落回 false）后由权威历史替换掉。
   */
  liveMessages?: AgentChatMessage[]
}

/** `MessageList` 里 `renderActions` 的参数 */
export interface MessageActionArgs {
  message: AgentChatMessage
  /** 该条在消息列表中的下标 */
  index: number
  /** 消息总条数（`deleteCount` 由此算出：含本条在内会被一起删掉的条数） */
  total: number
}

/**
 * 消息列表：贴底滚动容器 + 消息循环 + 「回到底部」指示器。
 *
 * 滚动位置由 `Conversation` 显式管理（库内部 `use-stick-to-bottom`），本组件只在
 * `resetKey` 变化时让它瞬时落底；其余的跟随 / 停跟交给库。
 */
export function MessageList({
  onStopTool,
  onStopTurn,
  messages,
  liveMessages,
  conversationId,
  streaming,
  replaying = false,
  resetKey,
  contentClassName = 'mx-auto w-full px-2 py-1 sm:px-6 max-w-3xl',
  header,
  error,
  loading = false,
  deleting = false,
  emptyState,
  followup,
  pendingConfirms,
  renderArtifacts,
  renderActions,
  outline = false,
  editingMessageId = null,
  retryNotice = null,
  reconnectNotice = null,
  compaction = null,
  onContinueMessage
}: MessageListProps) {
  const tr = useT()
  /**
   * 重拉这条会话（与标签右键的「刷新」同一个 action）。
   *
   * 触发路径：最新错误旁 / 空态里的「重新加载会话」，以及空态出现时的**自动补拉**
   * （一条消息都没有常常是历史没拉回来；自动拉一次能救回来就别先让用户自己点）。
   * 自动那一趟静默成功，不从 toast 里冒出来。
   */
  const recoveryPhase = useAgentStore((s) => conversationId ? s.slices[conversationId]?.recoveryPhase ?? null : null)
  const recoveryError = useAgentStore((s) => conversationId ? s.slices[conversationId]?.error ?? null : null)
  const reloading = !!recoveryPhase
  const reloadPending = useRef(false)
  const refreshConversation = useCallback(
    async (silent = false) => {
      if (!conversationId || reloadPending.current) return
      if (useAgentStore.getState().slices[conversationId]?.recoveryPhase) return
      // 本入口在生成期间禁用，避免用户把恢复现场误当成重试生成。
      if (streaming) {
        if (!silent) toast(tr('这一轮还在生成，先停止再重新加载'))
        return
      }
      reloadPending.current = true
      try {
        const ok = await useAgentStore.getState().reloadConversation(conversationId)
        if (ok && !silent) toast.success(tr('已重新加载会话'))
        else if (!ok && !silent) toast.error(tr('重新加载会话失败：{error}', {
          error: useAgentStore.getState().slices[conversationId]?.error ?? tr('未知错误')
        }))
      } catch (err) {
        if (!silent) toast.error(tr('重新加载会话失败：{error}', {
          error: err instanceof Error ? err.message : String(err)
        }))
      } finally {
        reloadPending.current = false
      }
    },
    [conversationId, streaming, tr]
  )
  /**
   * 消息区根节点，给右侧「消息目录」定位用。
   *
   * 刻意不用 `document.getElementById`：桌面端能同时挂多个会话面板，同一个会话在两个
   * 分屏里打开时全局 id 会撞，拿到的可能是另一个面板里的节点。所以在本面板内按
   * `data-message-id` 找。
   */
  const panelRef = useRef<HTMLDivElement>(null)

  /**
   * 「下拉加载更早的消息」：历史一次性都在 store 里（服务端返回完整历史），这里只控制
   * **渲染多少条**，避免一进长会话就挂出几百条消息（代码高亮 / 图片 / 工具卡全部展开）。
   * 默认只渲染最近 `INITIAL_VISIBLE_MESSAGES` 条，滚到顶部继续往下拉再追加一批。
   *
   * 切换会话要复位 —— 否则在一条长会话里展开到 200 条，切去另一条也直接渲染 200 条。
   */
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES)
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_MESSAGES)
  }, [conversationId])

  /**
   * 协作轮里主对话没有「唯一一条助手消息」：多个 Agent 同时流式输出时先挂在末尾，
   * 结束（`streaming` 落回 false / 权威历史刷新）后由落盘消息替换。
   * 同时把那条空的主占位隐藏掉（它不会有内容，露出来会显示「本轮没有返回内容」）。
   */
  const live = streaming && liveMessages?.length ? liveMessages : []
  /**
   * 协作轮里主对话那条空占位要隐藏（它不会有内容，露出来会显示「本轮没有返回内容」），
   * 这层处理要在窗口裁剪**之前**做，否则被裁到窗口外的占位会让下标算错。
   */
  const baseMessages =
    live.length > 0
      ? messages.filter(
          (message, index) =>
            !(
              index === messages.length - 1 &&
              message.role === 'assistant' &&
              message.parts.length === 0
            )
        )
      : messages
  /** 还没渲染出来的更早消息条数（0 = 全部已渲染） */
  const hiddenCount = Math.max(0, baseMessages.length - visibleCount)
  const visibleMessages = hiddenCount > 0 ? baseMessages.slice(hiddenCount) : baseMessages
  const displayMessages = [...visibleMessages, ...live]
  /** 渲染条数（用于「流式末条」的判断） */
  const total = displayMessages.length
  /**
   * 完整消息条数（含被窗口裁掉的）。`renderActions` / `MessageParts` 的 `index` 与 `total`
   * 必须是**完整列表**口径 —— 删除「本条及其后」的条数靠 `total - index` 算，按窗口算会少删。
   */
  const fullTotal = baseMessages.length + live.length

  /**
   * 空态自动补拉：本屏已经绑了会话、又没在装载 / 生成 / 重放 / 删除 / 报错，却一条消息
   * 都没有 —— 大概率是历史没拉回来。每个会话只自动试一次，静默进行；拉回来仍是空
   * （本来就没有 / 确实失败）再露出手动按钮，不反复请求。
   *
   * 服务端还在跑时，空列表可能只是恢复未结束，不额外触发空态补拉。
   * 显式恢复已统一为「快照合并 + 复用直播订阅」，不会覆盖正在输出的助手消息。
   */
  const activity = useConversationActivity(conversationId ?? null)
  const [autoReloadedFor, setAutoReloadedFor] = useState<string | null>(null)
  useEffect(() => {
    setAutoReloadedFor(null)
  }, [conversationId])
  useEffect(() => {
    if (
      !conversationId ||
      activity.running ||
      total > 0 ||
      loading ||
      reloading ||
      streaming ||
      replaying ||
      deleting ||
      error
    )
      return
    if (autoReloadedFor === conversationId) return
    setAutoReloadedFor(conversationId)
    void refreshConversation(true)
  }, [
    conversationId,
    activity.running,
    total,
    loading,
    reloading,
    streaming,
    replaying,
    deleting,
    error,
    autoReloadedFor,
    refreshConversation
  ])

  /**
   * 展开更早一批。展开前记下滚动容器的高度与位置，layout effect 里把差值补回 `scrollTop`
   * —— 否则新内容插在可视区上方，用户正看着的那条会被顶走。
   */
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  const loadOlder = useCallback(() => {
    if (visibleCount >= baseMessages.length) return
    const el = panelRef.current?.querySelector<HTMLElement>('[data-message-scroll]')
    if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
    setVisibleCount(Math.min(baseMessages.length, visibleCount + LOAD_OLDER_STEP))
  }, [baseMessages.length, visibleCount])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    anchorRef.current = null
    if (!anchor) return
    const el = panelRef.current?.querySelector<HTMLElement>('[data-message-scroll]')
    if (!el) return
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height)
  }, [visibleCount])

  /** 顶部哨兵进入可视区（滚到顶 / 触屏下拉）就自动再展开一批 */
  const olderSentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = olderSentinelRef.current
    if (!node || hiddenCount === 0) return
    const root = panelRef.current?.querySelector<HTMLElement>('[data-message-scroll]') ?? null
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadOlder()
      },
      // 提前一屏预取，滚到顶不会先看见「加载中」再等
      { root, rootMargin: '240px 0px 0px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hiddenCount, loadOlder])

  /** 消息目录点击：目标被窗口裁掉时先全部展开，再滚到它（消息上的 `scroll-mt-6` 留边距） */
  const jumpToMessage = useCallback(
    (messageId: string): void => {
      const index = messages.findIndex((message) => message.id === messageId)
      if (index >= 0 && index < baseMessages.length - visibleCount) {
        setVisibleCount(baseMessages.length)
      }
      requestAnimationFrame(() => {
        const node = panelRef.current?.querySelector(
          `[data-message-id="${CSS.escape(messageId)}"]`
        )
        node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    },
    [messages, visibleCount, baseMessages.length]
  )

  return (
    // relative 只包住消息区（不含下方输入框）：「消息目录」的竖条相对它垂直居中。
    // `@container`：给下面的「窄面板让出竖线通道」用容器查询（判的是**面板**宽度，
    // 不是视口宽度 —— 侧栏、右侧分栏都会挤面板，而视口可能还很宽）。
    <div
      ref={panelRef}
      aria-busy={deleting || undefined}
      className="@container relative flex min-h-0 flex-1 flex-col"
    >
      <Conversation
        className="min-h-0 flex-1"
        resetKey={resetKey}
        /*
         * 只有「本轮正在流式输出」才用平滑跟随（消息向上流动的观感）；
         * 其余内容长高（图片加载完成、历史刷新…）一律瞬时贴底，不要自己滚。
         *
         * ⚠️ `replaying` 必须一起判：断线重连的回放窗口里 `streaming` 也是 true，
         * 但那是「清空后逐帧重建」，内容先塌后长 —— 用 spring 跟随就是一段「列表像在
         * 重新加载、从顶部往下滚」的动画（用户实测反馈过）。回放期间瞬时贴底，
         * 视角一直落在底部，等 `replay-end` 之后再恢复流式的平滑跟随。
         *
         * ⚠️ `loading` 一起判：刷新 / 切会话的装载窗口里 slice 可能已经带着上一轮的
         * `streaming`（刷新时那轮还在生成），骨架换成整份历史那一下高度暴增，用 spring
         * 就是「从顶部平滑滚到底部」。另外 `Conversation` 自己还有一段装载期窗口兜底
         * （见那边的 `settling`），两条一起才盖得住分阶段长高。
         */
        smoothResize={streaming && !replaying && !loading}
      >
        {/* 面板一窄，目录那列横杠就贴着面板右缘，而**用户消息是右对齐的**（ai-elements 的
            `ml-auto`）、操作行也靠在消息右缘 —— 不让开位置，横杠正好压在用户消息下面那排
            按钮（删除）上，点不动（手机上必现）。所以窄面板要给内容补右内边距：
            `--rail-channel` = 横杠通道 + 列宽 + 缝，与横杠自己的落点**同源**（都由
            `styles.css` 的 `--rail-inset` 推导）—— 不再各写一个魔数靠注释互指。
            用**容器查询**而不是 `md:` 视口断点：挤压来自面板宽度（侧栏 / 右侧分栏都会挤），
            跟视口多宽没关系；阈值 820px 取自「内容右内边距自然值 ≥ 通道」的临界点
            （面板 ≥ 820 时居中留白已经够宽，横杠根本够不着内容）。 */}
        <ConversationContent
          className={cn(
            contentClassName,
            outline && '@max-[820px]:pr-[var(--rail-channel)]',
            // 删除窗口里整块内容压暗 + 不收点击：鼠标滚轮落在滚动容器上，滚动不受影响，
            // 但消息上的操作行（编辑 / 删除 / 签出）与正文链接都点不到
            deleting && 'pointer-events-none opacity-50 transition-opacity'
          )}
        >
          {reloading && (
            <div role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {tr(recoveryStatusText(recoveryPhase))}
            </div>
          )}
          {!reloading && recoveryError && total > 0 && (
            <div role="alert" className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="min-w-0 break-words">{tr('重新加载会话失败：{error}', { error: recoveryError })}</span>
              <Button size="sm" variant="ghost" disabled={streaming} onClick={() => void refreshConversation()}>
                <RotateCw aria-hidden="true" className="size-3.5" />
                {tr('重试')}
              </Button>
            </div>
          )}
          {header}
          {error ? (
            error
          ) : loading && total === 0 ? (
            // 切会话 / 刷新后的历史装载窗口：消息气泡骨架
            <div className="flex flex-col gap-6" aria-busy="true" aria-hidden="true">
              {/* 消息区本身可能透出壁纸（主题背景遮罩），骨架再用 `bg-muted` 会跟底色糊在一起。
                  这里统一加深一档，保证透明背景下也能看见加载中的形状。 */}
              <Skeleton className="h-4 w-1/3 self-end bg-foreground/10" />
              {/* `max-w-full` 挂在**外层**：`self-start` 的 flex 子项按 max-content 收缩，
                  子元素的 `max-w-full` 不参与它的内在宽度计算 —— 窄屏上 26rem 会顶出
                  容器、让消息区横向可拖（并连带禁用侧栏滑动，见 `use-sidebar-swipe.ts`）。 */}
              <div className="flex w-full max-w-[26rem] min-w-0 flex-col gap-2 self-start">
                <Skeleton className="h-4 w-[26rem] max-w-full bg-foreground/10" />
                <Skeleton className="h-4 w-[20rem] max-w-full bg-foreground/10" />
              </div>
              <Skeleton className="h-4 w-1/4 self-end bg-foreground/10" />
              <div className="flex w-full max-w-[26rem] min-w-0 flex-col gap-2 self-start">
                <Skeleton className="h-4 w-[22rem] max-w-full bg-foreground/10" />
              </div>
            </div>
          ) : total === 0 ? (
            <ConversationEmptyState>
              {emptyState ?? <DefaultEmptyState />}
              {/*
                会话存在却一条消息都没有：多半是历史没拉回来（ACP 回放没起来 / 刷新正好
                撞上装载窗口）。空态本身看不出「是本来就没有，还是加载失败」，这里给一个
                显式出口，别让人以为会话被清空了。生成中不给 —— 那会和流式现场抢历史。
              */}
              {conversationId && !streaming && autoReloadedFor === conversationId ? (
                <div className="flex flex-col items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    {tr('历史消息没有显示？')}
                  </span>
                  <button
                    type="button"
                    disabled={reloading}
                    onClick={() => void refreshConversation()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-default disabled:opacity-60"
                  >
                    {reloading ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RotateCw className="size-3.5" />
                    )}
                    {reloading ? tr(recoveryStatusText(recoveryPhase)) : tr('重新加载会话')}
                  </button>
                </div>
              ) : null}
            </ConversationEmptyState>
          ) : (
            <>
              {/* 顶部哨兵：还有更早的消息没渲染时挂在这里，滚到顶自动再展开一批 */}
              {hiddenCount > 0 && (
                <div ref={olderSentinelRef} className="flex justify-center pb-3">
                  <button
                    type="button"
                    onClick={loadOlder}
                    className="rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                  >
                    {tr('加载更早的消息（还有 {count} 条）', { count: hiddenCount })}
                  </button>
                </div>
              )}
              {displayMessages.map((message, index) => {
                const isStreamingLast = streaming && index === total - 1
                /** 完整列表里的下标（窗口裁掉了更早的那些，见 `fullTotal`） */
                const fullIndex = hiddenCount + index
                /** 正在编辑重发的那条：描边 + 压暗，和输入框上方的「编辑消息」条是一对标识 */
                const isEditing = !!editingMessageId && message.id === editingMessageId
                const messageCompaction =
                  compaction && compaction.messageId === message.id ? compaction : null
                /** 状态槽的三种落法见 `waitingIndicatorSlot`（压缩中不挂 / 真状态行 / 隐形占位） */
                const waitingSlot = waitingIndicatorSlot(message.parts, messageCompaction)
                // 实时回复还没落盘，不挂编辑 / 删除 / 签出这些需要稳定 id 的操作
                const isLive = message.id.startsWith('collab-live-')
                const actions = isLive
                  ? null
                  : (renderActions?.({ message, index: fullIndex, total: fullTotal }) ?? null)
                /*
                 * 流式末条**不渲染操作行**（连占位也不）—— 用户明确要求「不要占位」。
                 *
                 * 代价（已知并接受）：操作行是「结束那一帧」才出现的，而滚动是贴底的 ——
                 * 正文的位置只由它下面的内容决定，所以结束那一帧这一行凭空多出的高度
                 * （~28px，加上 `Message` 的 `gap-2` 约 36px）会把正文顶上去一小截。
                 * 这就是最早那个「会话结束后消息列表会跳一下」的成因；用户在看到
                 * 「占位导致底部空白太大」之后，明确选择用「跳一下」换「不留空白」。
                 * ⚠️ 若哪天要把它改回去，做法是：流式末条把**真行**渲染进
                 * `invisible` + `pointer-events-none` 的壳里（`visibility: hidden`，
                 * 不能只用 `opacity-0` —— 挡不住行自己的 `md:group-hover:opacity-100`）。
                 */
                const showActions = !isStreamingLast
                return (
                  <Message
                    key={message.id}
                    from={message.role}
                    // data-message-id + scroll-mt-6：给右侧「消息目录」定位 / 留上边距用。
                    data-message-id={message.id}
                    // 引用片要标「你的消息 / 助手消息」（见 MessageQuoteLayer）：role 只体现在
                    // `is-user` / `is-assistant` class 上，靠 class 判太脆，这里显式给一个属性
                    data-role={message.role}
                    // 有目录时消息的宽度上限，**按面板宽窄分两档**（判据是容器查询，与上面 `pr` 同一口径）：
                    // - **窄面板（≤820px）→ `max-w-full`**：那儿已经由 `--rail-channel` 整段让出了
                    //   横杠通道，再叠一个百分比就是**双重让位** —— 助手的长内容（代码块 / 表格）右缘
                    //   会平白多空出一段（手机上「92% 的剩余宽度 + 40px 通道」合起来能到 ~67px，正是
                    //   用户报的「右侧一大片空白」）。让位只留一处，通道说了算。
                    //   ⚠️ 必须**显式**写 `max-w-full`：ai-elements 的 `Message` 自带 `max-w-[95%]`，
                    //   不覆盖它就还是双重让位（用户消息右对齐不受影响，助手内容是左对齐的，会少一截）。
                    // - **宽面板（>820px）→ 95%**：横杠列在面板右缘，但面板刚过 820px 时空白带还很窄
                    //   （26px 上下），内容收一档才留得住余量。
                    // ⚠️ 早先这里写的是 `max-w-[92%] md:max-w-[95%]` —— `md:` 是**视口**断点，于是
                    // 桌面窄分栏会被判成「宽」（95% 叠上通道）、手机反而被多让一次，两头都不对。
                    className={cn(
                      'mb-6 scroll-mt-6',
                      outline && '@max-[820px]:max-w-full @min-[820px]:max-w-[95%]'
                    )}
                  >
                    {/* 正文 15px：ai-elements 默认是 text-base(16px)，用户反馈偏大，收一档。
                        层级仍高于思考 / 工具 / 代码（都是 text-sm 14px）。
                        正在编辑的那条加 `ring` 描边并压暗 —— 圆角沿用用户气泡自身的
                        （`group-[.is-user]:rounded-lg`，改不了 ai-elements 内部，只能靠 ring 描一圈）。 */}
                    <MessageContent
                      className={cn(
                        'text-[0.9375rem]',
                        isEditing && 'opacity-60 ring-2 ring-ring/70 ring-offset-2 ring-offset-background'
                      )}
                    >
                      {/* 协作会话的消息上标注是哪个 Agent 说的（普通会话不带 agentName） */}
                      {message.role === 'assistant' && message.agentName ? (
                        <div className="-mt-1 mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Bot className="size-3.5" />
                          <span className="font-medium text-foreground">{message.agentName}</span>
                        </div>
                      ) : null}
                      {/*
                        零 part 的助手消息有两种，必须分开：
                        - **正在跑**：还没吐第一个 part，显示「正在思考…」（由下面那个状态行槽渲染）；
                        - **已经跑完却什么都没吐**（外部 ACP agent 直接 end_turn、模型返回空流…）：
                          绝不能还转圈。原来这里无条件渲染 ThinkingRow，实测「pi-acp 复用会话的
                          第二轮」整轮只有一条 finish 事件 → parts 永远为空 → 界面永久停在
                          「正在思考…」，且一条报错都没有。
                      */}
                      {message.parts.length === 0 && !messageCompaction ? (
                        /* 空 parts 且正在跑：交给下面那个「状态行槽」渲染，别在两处各放一份 */
                        streaming && isStreamingLast ? null : (
                          <div className="text-sm text-muted-foreground">{tr('（本轮没有返回内容）')}</div>
                        )
                      ) : (
                        <MessageParts
                          onStopTool={onStopTool}
                          onStopTurn={onStopTurn}
                          message={message}
                          index={fullIndex}
                          total={fullTotal}
                          streaming={streaming}
                          followup={followup}
                          pendingConfirms={pendingConfirms}
                          compaction={messageCompaction}
                          onReload={conversationId ? refreshConversation : undefined}
                          reloading={reloading}
                          onContinue={
                            onContinueMessage ? () => onContinueMessage(message) : undefined
                          }
                        />
                      )}
                      {/*
                        消息底部状态行（正在思考… / 第 N 次重试 / 正在重连）。

                        ⚠️ 这行是**时有时无**的：尾段一落地就补上「正在思考…」，下一个 part 一开流
                        （正文 / 思考重新开始）又撤掉。直接放进内容流里，内容高度就在流式途中反复
                        ±一行 —— 贴底时 `use-stick-to-bottom` 每变一次尺寸都要重算滚动位置，
                        眼睛看到的就是「列表被顶了一下」外加一次滚动（用户报的）。所以没什么可报
                        的时候也要占住同样的一行高度。

                        ⚠️ 但占位**不能写死像素**（原来这里是 `min-h-5`）：`h-5` 走的是
                        `--spacing × --fizz-density`，而 `text-sm` 的行高走的是 `--fizz-text-scale`。
                        内置主题几乎都让这两个倍率不相等（如 1.02× / 0.96×），于是行总比槽位高
                        1~2px —— 这一行每次出现都把内容顶一下（用户报的「顶一点点」）。
                        现在空着时渲染同一份 `ThinkingRow`（`placeholder` → `invisible`）：
                        高度由真实的一行 `text-sm` 撑出来，与有字时逐像素一致，换字号 / 密度都不抖。

                        ⚠️ 槽位只挂在**最后一条助手消息**上（`isStreamingLast`）：历史消息后面
                        不能留一片空白。整轮结束时槽位跟着撤掉，那一下由下面的操作行接上。
                      */}
                      {streaming &&
                      message.role === 'assistant' &&
                      isStreamingLast &&
                      waitingSlot !== 'hidden' ? (
                        waitingSlot === 'status' ? (
                          <StreamingStatusNotice retryNotice={retryNotice} reconnectNotice={reconnectNotice} />
                        ) : (
                          <ThinkingRow placeholder />
                        )
                      ) : null}
                    </MessageContent>

                    {/* 文档入口：紧贴正文之下（交付物）。「本轮用量」不在这里 —— 它是操作行
                        最前面那颗图标（见 `renderActions` / `MessageActionRow`）。

                        ⚠️ **本轮没结束时一律不渲染**：`write` 一返回 `presentedDocsOf`
                        就能认出文档，但流式期间把卡片挂出来会让「交付物」在模型还没说完时
                        提前出现（还会把下面的内容高度顶一下）。等这一轮真正落定（`isStreamingLast`
                        为假）再显示 —— 与操作行 / 用量的出现时机一致。 */}
                    {!isStreamingLast && renderArtifacts?.(message)}

                    {/* 流式末条整行不渲染（含占位）—— 理由与代价见上面 `showActions` */}
                    {actions && showActions ? actions : null}
                  </Message>
                )
              })}
              {compaction && !compaction.messageId && (
                <Message from="assistant" className="mb-6">
                  <MessageContent className="text-[0.9375rem]">
                    <ContextCompactionCard compaction={compaction} />
                  </MessageContent>
                </Message>
              )}
            </>
          )}
        </ConversationContent>
        {/* 「回到底部」指示器（不贴底时才出现） */}
        <ConversationScrollButton />
      </Conversation>

      {/* 删除进度：悬浮在消息区顶部中央。**绝对定位**而不是塞进消息流 —— 插进流里会让
          内容高度跳一下、还可能把用户的阅读位置顶走（正在被删的恰恰是中间那段历史） */}
      {deleting && (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-2">
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-full border border-border/60 bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            {tr('正在删除消息…')}
          </div>
        </div>
      )}

      {/* 消息目录：右缘一列横杠，hover 展开成摘要清单（见 MessageOutline） */}
      {outline ? <MessageOutline messages={messages} onJump={jumpToMessage} /> : null}

      {/* 会话内查找（Ctrl/Cmd+F）：浮在消息区右上角，不开时不占位（见 chat-find.tsx） */}
      <ChatFind
        panelRef={panelRef}
        messages={messages}
        // 查找扫的是 DOM：先把被「加载更早」裁掉的历史展开，否则搜不到旧消息
        onSearchActive={() => setVisibleCount(baseMessages.length)}
      />
    </div>
  )
}

/** 没给 `emptyState` 时的兜底空态 */
function DefaultEmptyState() {
  const tr = useT()
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <MessageSquare className="size-8 opacity-40" />
      <div className="text-sm font-medium">{tr('还没有消息')}</div>
    </div>
  )
}

/**
 * 「第 N 次重试」提示条的入参。
 *
 * `resume` = 断点续跑：这一次不是从头重来，而是接着失败的那一步（已渲染内容只回滚到
 * 最后一个落定工具结果）。提示文案不再区分两种重试，统一显示「第 N 次重试」。
 *
 * `message` = 这次失败的原文（服务端 `retry.message` 透传）。有它就显示成次数后面的
 * 问号图标（悬停看全文），用户能立刻分清是上游限流（改并发 / 等配额）还是网络断了。
 */
type RetryNoticeView = {
  attempt: number
  maxRetries: number | null
  resume?: boolean
  message?: string
}

/**
 * 重试失败原因的问号提示。
 *
 * `Tooltip` 在触屏上被整体停用（`packages/ui/tooltip.tsx`：没有悬停语义），问号会变成
 * 「点了没反应」。所以触屏改用**点开**的 Popover —— 判据与虚拟键条同源（输入能力，
 * 不是视口宽度），手机横屏 / 平板一样命中。
 */
function RetryErrorHint({ message }: { message: string }) {
  if (isTouchOnlyInput()) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={message}
            className="inline-flex items-center text-destructive"
          >
            <CircleHelp className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          className="w-auto max-w-xs text-xs whitespace-pre-wrap break-words"
        >
          {message}
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <IconTip label={<span className="block max-w-xs whitespace-pre-wrap break-words">{message}</span>}>
      <span
        role="img"
        aria-label={message}
        className="inline-flex cursor-help items-center text-destructive"
      >
        <CircleHelp className="size-3.5" />
      </span>
    </IconTip>
  )
}

/**
 * 「第 N 次重试」提示条（单条自替换）。
 *
 * 调用方用 `key={attempt}` —— 次数变化时整条重建，从而**重放一遍入场动画**
 * （只在同一节点上改文本不会重新触发 CSS 动画）。因为 `retryNotice` 只有一份
 * （每次重试覆盖上一条），屏幕上任何时刻只有这一条。
 *
 * 失败原文放在问号的提示里（桌面悬停 / 触屏点开），不再占行内宽度：这一行住在固定高度的
 * 状态槽里（见 `MessageList` 里那段 `min-h-5` 的说明），一条上游报文换行就会让内容高度在
 * 流式途中抖动。没有原文时不渲染图标。
 */
function RetryRow({ notice }: { notice: RetryNoticeView }) {
  const tr = useT()
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-300"
    >
      <RotateCw className="size-3.5 shrink-0 animate-spin" />
      <span className="shrink-0">{tr('第 {attempt} 次重试', { attempt: notice.attempt })}</span>
      {notice.message && <RetryErrorHint message={notice.message} />}
    </div>
  )
}

/**
 * 流式期间消息底部那一行的**状态提示**：按优先级挑一条渲染。
 *
 * - 断线重接中：连接断了（页面切后台 / 电脑休眠 / 网络切换最常见），服务端那轮还在跑。
 *   这条必须盖过其余两种 —— 不然用户看到「正在思考」转圈，以为模型在憋一个长回答。
 * - 模型重试中：第 N 次重试（失败原文挂在次数后的问号 tooltip 里）。
 * - 其余：普通「正在思考…」。
 */
function StreamingStatusNotice({
  retryNotice,
  reconnectNotice
}: {
  retryNotice: RetryNoticeView | null
  reconnectNotice: { attempt: number } | null
}) {
  const tr = useT()
  if (reconnectNotice) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-300"
      >
        <Unplug className="size-3.5 shrink-0" />
        <span>
          {tr('连接中断，正在重连（第 {attempt} 次）…', { attempt: reconnectNotice.attempt })}
          <span className="ml-1 text-xs">{tr('服务端这一轮还在跑，接上就继续')}</span>
        </span>
      </div>
    )
  }
  if (retryNotice) {
    return <RetryRow notice={retryNotice} />
  }
  return <ThinkingRow />
}

/**
 * 只有「复制」的操作行：容器工作台的历史消息在容器里，改不了也删不掉，
 * 所以 `onEdit` / `onDelete` 都不给（见 `MessageActionRow`）。
 *
 * `onConvert` 可选传入额外挂一颗「从此转为内置 Agent 会话」（只有 ACP 会话用得上）。
 * `usageSlot` 可选传入「本轮用量」那颗图标（与主会话同形：挨在复制左边）。
 */
export function CopyOnlyActions({
  message,
  index,
  total,
  onConvert,
  usageSlot
}: MessageActionArgs & { onConvert?: () => void; usageSlot?: ReactNode }): ReactNode {
  // 含本条在内、从本条往后的消息条数（与主会话同口径）
  return (
    <MessageActionRow
      message={message}
      deleteCount={total - index}
      onConvertFromHere={onConvert}
      usageSlot={usageSlot}
    />
  )
}

// ---------------------------------------------------------------------------
// 输入区
// ---------------------------------------------------------------------------

/**
 * 输入区外壳的两种排布。
 *
 * - `page`（主会话）：整块可滚（待发送队列长了要能滚），列宽与消息列一致（`max-w-3xl`）；
 * - `panel`（容器工作台）：面板可能只有 380px 宽，上下留白收一档，输入框列左右用 `px-3`。
 *
 * ⚠️ 这里以前镜像了消息区滚动容器的 `scrollbar-gutter`（消息列在「面板宽 − 槽位」里居中，
 * 输入框得落在同一坐标系）。现在消息区**不画滚动条也不留槽位**（见 `Conversation`），
 * 宽度恒定，那份补偿已撤掉 —— 别再给哪一侧补 padding 去「对齐槽位」，那会真的错开。
 */
export type ChatComposerVariant = 'page' | 'panel'

export interface ChatComposerProps {
  value: string
  onChange: (value: string) => void
  /** 发送（Enter 或点发送钮）；本轮在跑时入队，等本轮结束按序自动发 */
  onSubmit: () => void
  /**
   * 只入队、不立刻发（发送方式下拉里的「放入队列」）。不传 = 显示单颗发送钮。
   * 见 `Composer` 上同名字段。
   */
  onEnqueue?: () => void
  /** 「放入队列」不可用（编辑态）：菜单项灰掉并给出原因 */
  enqueueDisabled?: boolean
  /** 停止（点停止钮，或输入框里按 Esc） */
  onCancel: () => void
  streaming: boolean
  /** 输入框与发送钮一并不可用（会话未就绪 / 没选工作区…） */
  disabled?: boolean
  /** 只禁发送、不禁输入（手动压缩进行中）：发送钮灰掉、Enter 不出手 */
  sendDisabled?: boolean
  /** 禁发原因（上传附件中等）：传给发送钮 tooltip，不传回落「上下文压缩中」 */
  sendDisabledHint?: string
  /** 有附件没文字也允许发送：解除「草稿为空」对发送钮的禁用（Enter 仍走 sendDisabled） */
  allowEmptySend?: boolean
  /**
   * 提交后到「这一轮真的开跑」之间，把发送钮换成转圈（且不可点）。
   *
   * 只该在这个等待真的明显时才传：目前唯一的使用者是「开始新对话」页选 ACP 后发送 ——
   * 服务端要先起外部 agent 进程、`session/new` 拿到档位才建会话，几百毫秒到几秒，
   * 这段时间界面完全没反应，用户会以为没点上而反复点。内置模型那次往返很快，不必转。
   */
  sending?: boolean
  placeholder?: string
  /** 操作行左侧（工作区 / 权限） */
  leading?: ReactNode
  /** 操作行右侧、**发送钮左边**（模型） */
  trailing?: ReactNode
  /**
   * 输入框卡片内的 `header`（渲染在同一张卡片内，与 textarea 浑然一体），
   * 如主会话的「待发送队列」。
   */
  header?: ReactNode
  /**
   * 输入框**上方**、卡片之外的内容：运行中的子任务、后台任务之类。
   * 与 `header` 的区别是它不带卡片底色与分隔线。
   */
  above?: ReactNode
  /**
   * 顶替输入卡片的内容（待答复的权限卡 / 待回答的提问卡）：位置、宽度与输入框完全一致。
   *
   * 审批 / 提问期间 agent 正停着等答复，输入框没有用处；让卡片**盖住输入框区域**
   * 比把它摞在输入框上方更醒目，也不会把输入框越顶越高。
   *
   * ⚠️ 它同时顶掉 `above`（浏览器 / MCP 工具条、后台任务）：那两样在等答复期间既点不动、
   * 也没有可操作的对象，留着就只是把卡片往下推。
   */
  cover?: ReactNode
  /**
   * 输入框**下方**、卡片之外的内容：常驻状态横条（工作区 / git 分支 / 权限档 / 上下文占用）。
   *
   * 与 `above` 对称（同一对齐壳内、卡片外，不带底色）。放在卡片**外**而不是 `leading`：
   * 卡片内的操作行只留输入相关控件，状态类信息集中在这一条，窄屏也不会把模型 / 发送挤变形。
   */
  below?: ReactNode
  /** 暴露 textarea 引用（编辑队列消息写回输入框后聚焦用） */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  /**
   * 粘贴 / 拖拽进来的文件（截图、图片、从资源管理器拖来的文件）；透传给 `Composer`。
   * 不传 = 本输入框没有附件区（工作台 / ACP 会话），也不接管粘贴与拖放。
   */
  onAttachFiles?: (files: File[]) => void
  /** 斜线命令（不传 = 无此功能）；透传给 Composer 的 `/` 命令浮层 */
  slashCommands?: import('@fizz/agent-kit/shared/lib/slash-commands').SlashCommand[]
  /** 命令执行上下文（与 slashCommands 一同传） */
  slashContext?: import('@fizz/agent-kit/shared/lib/slash-commands').SlashCommandContext
  /** `@` 点名的候选 Agent（多智能体协作会话） */
  mentionCandidates?: Array<{ id: string; name: string; role?: string }>
  variant?: ChatComposerVariant
  /** 紧凑输入框（初始高度一行）—— 窄面板里的助手用，见 Composer 的 compact */
  compact?: boolean
  /**
   * 语音快捷键的作用域（本输入框所属的标签 key）：`voiceStart / Stop` 广播里带着
   * 焦点组当前标签的 key，只有对得上的输入框开麦 —— 分屏时两栏不能一起收音。
   * 见 `Composer` 的 `voiceScope`；不传的宿主退回「焦点在自己卡片里」。
   */
  voiceScope?: string | null
}

/**
 * 会话输入区：与消息列逐像素对齐的壳 + 共用的 `Composer`。
 *
 * 草稿由调用方持有（主会话的在 `PromptInputProvider` 里，工作台的是它自己的 `useState`），
 * 这里不替它们做决定。
 */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onEnqueue,
  enqueueDisabled,
  onCancel,
  streaming,
  disabled,
  sendDisabled,
  sendDisabledHint,
  allowEmptySend,
  sending,
  placeholder,
  leading,
  trailing,
  header,
  above,
  cover,
  below,
  textareaRef,
  onAttachFiles,
  slashCommands,
  slashContext,
  mentionCandidates,
  variant = 'page',
  compact,
  voiceScope
}: ChatComposerProps) {
  const panel = variant === 'panel'
  return (
    <div
      className={panel ? 'shrink-0 pt-3 pb-3 overflow-y-auto' : 'shrink-0 overflow-y-auto'}
    >
      {/*
        ⚠️ `above`（审批卡 / 当前任务卡）与 `Composer` 必须在**同一个对齐壳**里：
        壳只有一处定义（宽度上限 max-w-3xl + 左右内边距），所以权限卡的宽度永远
        与输入框卡片、与消息列逐像素对齐 —— 三者在同一坐标系里。
        以前 `above` 单独套了个 `px-3` 的壳（不限宽），面板一宽权限卡就铺满、输入框
        却限在 768px，同一块区域里两种宽度；现在两者同壳，`space-y-2` 统一给间距
        （卡片自身的 `mb-*` 已去掉，间距不再由卡片自己带 —— 免得两处叠加成 16px）。
      */}
      <div
        className={
          panel
            ? 'mx-auto w-full max-w-3xl space-y-2 px-3'
            : /*
               * 底部内边距从 `sm:pb-6`（24px）收到 `sm:pb-2`（8px）：用户明确要求
               * 「消息列表下面空白太大不能接受」。这一层紧挨着消息区，它的 `pb`
               * 就是「消息列底部 → 输入框卡片」那一段空白的主体（原来 24px）。
               * 顶部维持 `pt-2`：输入框上方要跟消息留出视觉间隔，那一段不算「底部空白」。
               */
              'mx-auto w-full max-w-3xl p-2 sm:px-6 sm:pb-4'
        }
      >
        {/*
          `cover` 顶替的是**整块输入区**（工具条 + 卡片），不只是卡片本身。
          提问 / 审批期间发不出消息：浏览器 / MCP 开关点不动、后台进程也只是「顺便看一眼」，
          留在卡片上方只会把「现在必须答」的那张卡往下挤。所以 cover 一出现，above 整块让位
          （两处调用方都不用各自判断，`AssistantPanel` 本来就没传 above）。
        */}
        {cover ? null : above ? <div className="space-y-2 mb-1">{above}</div> : null}
        {cover ?? (
          <Composer
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            onEnqueue={onEnqueue}
            enqueueDisabled={enqueueDisabled}
            onCancel={onCancel}
            streaming={streaming}
            disabled={disabled}
            sendDisabled={sendDisabled}
            sendDisabledHint={sendDisabledHint}
            allowEmptySend={allowEmptySend}
            sending={sending}
            placeholder={placeholder}
            leading={leading}
            trailing={trailing}
            header={header}
            textareaRef={textareaRef}
            onAttachFiles={onAttachFiles}
            slashCommands={slashCommands}
            slashContext={slashContext}
            mentionCandidates={mentionCandidates}
            compact={compact}
            voiceScope={voiceScope}
          />
        )}
        {below ? <div className="flex min-w-0 items-center gap-2 px-1 bg-sidebar/60 rounded-b-lg mx-3">{below}</div> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 组合：会话主界面
// ---------------------------------------------------------------------------

/**
 * 会话主界面：消息列表 + 输入框（+ 落底指示器）。
 *
 * 两个会话视图的**共同骨架**就是这一个组件；调用方只负责传数据与两侧特有的槽位内容。
 *
 * `list` / `composer` 分成两组而不是拍平成一组：`streaming`、`header` 这两个名字两边都有
 * 但**含义不同**（消息列表的 `header` 是消息流上方的 sticky 条，输入区的 `header` 是
 * 卡片内的待发送队列），拍平必然互相盖掉。
 */
export interface ChatSurfaceProps {
  list: Omit<MessageListProps, 'renderActions'> & {
    renderActions?: (args: MessageActionArgs) => ReactNode
  }
  composer: ChatComposerProps
  /**
   * 这棵会话视图的根节点。
   *
   * 给 `MessageQuoteLayer` 用：分屏时两栏同时挂着浮层，必须按「选区落在谁家」区分，
   * 否则两栏都会弹、点下去写进另一栏的输入框（见 `quotes.tsx` 的 `scopeRef`）。
   */
  rootRef?: React.Ref<HTMLDivElement>
  /** 消息列表与输入框之间的内容（错误条之类） */
  between?: ReactNode
  /**
   * 工具卡里「点文件名 → 在右侧文件面板里打开」的能力（见 `features/files/open-file.ts`）。
   *
   * 由**会话面板**（`ChatPanel`）给：它才知道这个标签的面板 key 与会话所属工作区。
   * 不传 / `null` = 没有文件面板可开（容器工作台的片段渲染、项目管理助手），
   * 工具卡上的路径保持普通文字。
   *
   * ⚠️ 引用必须稳定：它是 context 的值，一变整列 memo 过的 `PartView` 都会白重渲。
   */
  fileOpener?: WorkspaceFileOpener | null
  /**
   * 应用状态：输入框上方「后台任务」那枚入口要靠 `app.api` 拉**当前会话**名下在跑的命令。
   *
   * 不传（容器侧的片段渲染 / 项目管理助手）就只剩子智能体那枚入口 —— 那边本来也没有
   * 本会话的后台任务语义。子智能体入口不依赖它（数据来自 `list.messages`）。
   */
  app?: AgentApp
}

/**
 * 会话主界面 + **子任务过程视图**的宿主。
 *
 * ## 为什么子任务视图挂在这一层
 *
 * 它是「消息列表 + 输入框」的边界：盖住时输入框也跟着被盖住（子任务只读，不能对它
 * 发消息），返回时两样一起回来。挂在 `MessageList` 里就只能盖住消息区，输入框还杵在
 * 下面 —— 用户会以为在跟子 agent 说话。
 *
 * ## 为什么是**覆盖层**而不是换掉主列表
 *
 * 换掉的话主列表会卸载重挂：滚动位置丢了、返回后跳到底部；更糟的是主会话可能正在流式
 * 输出，卸载期间的增量全靠重新拉历史补。覆盖层让主列表一直活着 —— 返回时位置、草稿、
 * 流式全都还是原样。
 *
 * ## 为什么不存 `delegation` 快照
 *
 * 子任务跑着的时候每帧都会重建 `delegation` 对象。只存快照的话，运行中打开看到的是
 * 「点开那一刻」的过程，后面全冻住。所以只存 `toolCallId`，每次渲染从当前消息里重新取
 * （见下面的 `findDelegation`），流式期就能跟着往下走。找不到（消息被删 / 切了会话）
 * 就退回打开时的快照，不会白屏。
 */
export function ChatSurface({
  list,
  composer,
  between,
  fileOpener,
  app,
  rootRef
}: ChatSurfaceProps) {
  /** 正在看的子任务：工具调用 id + 兜底快照 */
  const [viewing, setViewing] = useState<{
    toolCallId: string
    delegation: SubagentDelegation
  } | null>(null)
  /** 覆盖层：进子任务时把焦点从输入框抢走，否则按回车会把字发进被盖住的主会话 */
  const overlayRef = useRef<HTMLDivElement | null>(null)

  /** ⚠️ 引用要稳定：它是 context 的值，变了会让整列 `PartView`（都 memo 了）白重渲 */
  const openSubagent = useCallback<OpenSubagent>(
    (toolCallId, delegation) => setViewing({ toolCallId, delegation }),
    []
  )
  const closeSubagent = useCallback(() => setViewing(null), [])

  /*
   * 切会话就退出子任务视图。
   *
   * 不靠 `findDelegation` 找不到来自动退出：它找不到时还要用快照兜底（历史刚加载的
   * 一瞬间会找不到），两者混在一起会「切了会话还停在上一个会话的子任务里」。
   */
  const conversationId = list.conversationId
  useEffect(() => {
    setViewing(null)
  }, [conversationId])

  // Esc 返回主会话：与弹窗的惯用键一致，进子任务后不用去找那颗按钮。
  // 焦点在覆盖层里，keydown 会冒泡到 window，所以监听 window 就够。
  useEffect(() => {
    if (!viewing) return
    overlayRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setViewing(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewing])

  /**
   * 当前会话里**还在跑**的子任务（输入框上方那枚「子智能体」入口的数据源）。
   *
   * 每次渲染现扫消息：子任务每帧都会重建 `delegation`，缓存下来的只会是过期快照。
   * 消息量级是「一轮对话几十条 part」，扫一遍比维护一份同步状态便宜且不会漏。
   */
  const runningSubagents = collectRunningSubagents(list.messages, list.streaming)

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col">
      {/*
        工具卡里那截文件路径的「点开」能力由宿主递下去（见 `features/files/open-file.ts`）：
        只有宿主知道这个视图的面板 key 与会话所属的工作区，消息流深处拿不到。
        `null` = 没有文件面板可开（容器工作台 / 项目管理助手），文件名保持普通文字。
      */}
      <WorkspaceFileOpenerProvider value={fileOpener ?? null}>
        <SubagentViewProvider value={openSubagent}>
          <MessageList {...list} />
        </SubagentViewProvider>
      </WorkspaceFileOpenerProvider>
      {between}
      <ChatComposer
        {...composer}
        /*
         * 会话活动入口（子智能体 / 后台任务）与工具栏**同一行、靠右**：两者都是「这个
         * 会话现在还有什么」的常驻状态，各占一行会白吃掉输入框上方 32px。左手是
         * 「这一轮装什么能力」（浏览器 / MCP），右手是「后台还有几个活在跑」。
         *
         * `justify-between` 只有一个子项时退回靠左 —— 浏览器没装、也没配 MCP 时
         * `ComposerToolbar` 整条不渲染（返回 null），这时药丸不该孤零零飘在右边。
         *
         * ⚠️ 这一行同时是 `ComposerDock` **量宽度的地方**（它取父元素宽度算「输入框的
         * 一半」），所以它必须铺满与输入框卡片同宽的那条壳，别给它加 `w-fit` / 居中。
         */
        above={
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            {composer.above}
            <ComposerDock
              app={app}
              conversationId={conversationId}
              subagents={runningSubagents}
              onOpenSubagent={openSubagent}
            />
          </div>
        }
      />
      {viewing ? (
        /*
         * 铺满整个 surface（含输入框）：`z-20` 高于消息区与输入区，低于 Dialog 的 portal。
         * `tabIndex={-1}` 只为可编程聚焦，键盘进来后不会再 Tab 到后面的主会话。
         */
        <div
          ref={overlayRef}
          tabIndex={-1}
          className="absolute inset-0 z-20 flex flex-col bg-background outline-none"
        >
          <SubagentTranscript
            delegation={findDelegation(list.messages, viewing.toolCallId) ?? viewing.delegation}
            onBack={closeSubagent}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * 从消息流里按 `toolCallId` 找那份 delegation。
 *
 * 扫全部消息而不是只扫末条：子任务可能连着好几轮都在派活，而打开的是历史上任意一张卡。
 * 同名 toolCallId 在一份历史里是唯一的（模型每次调用都自己生成 id），所以命中即是。
 */
function findDelegation(
  messages: AgentChatMessage[],
  toolCallId: string
): SubagentDelegation | null {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool-call' && part.toolCallId === toolCallId && part.delegation) {
        return part.delegation
      }
    }
  }
  return null
}

/**
 * 子任务的完整过程：**把 `delegation.parts` 当成一条普通助手消息**交给 `MessageParts`。
 *
 * 「attach 进子任务、看到的消息和主任务一模一样」的全部实现就是这一句 —— 不复制渲染逻辑，
 * 所以折叠条、思考条、工具卡、正文的观感天然一致：跑着时正文逐段露出、思考与工具收进
 * 一条过程，跑完后合成一条「已工作 N 秒」，跟主对话完全同源。
 *
 * ⚠️ 这里是 `MessageParts` 引用自己：子 agent 没有派活工具（只读白名单），`parts` 里不会
 * 再有 `delegation`，所以不会无限套娃。
 *
 * ⚠️ 标题**不用**派活卡的 `label`：那个会随工具意图开关变成「侦察代码库」之类，
 * 这里要的是稳定的「子任务 · 侦察」。
 */
function SubagentTranscript({
  delegation,
  onBack
}: {
  delegation: SubagentDelegation
  onBack: () => void
}) {
  const tr = useT()
  const { subagentId, name, task, parts, status, startedAt, endedAt } = delegation
  const running = status === 'running'
  const elapsed = endedAt != null ? endedAt - startedAt : undefined
  /** 一句话说清「它现在 / 最后怎么了」—— `empty` / `failed` 就是用户最想知道的两种 */
  const stateText = running
    ? tr('运行中…')
    : status === 'empty'
      ? tr('跑完了，但没有产出结论')
      : status === 'failed'
        ? tr('执行失败（详情只在服务端日志里）')
        : status === 'aborted'
          ? tr('已中止')
          : elapsed != null
            ? tr('已工作 {time}', { time: workDurationLabel(elapsed) })
            : tr('已完成')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1.5 sm:px-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label={tr('返回主会话')}
          className="-ml-1 h-7 shrink-0 gap-1 px-1.5 text-xs"
        >
          <ChevronLeft className="size-4" />
          {tr('返回主会话')}
        </Button>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-xs font-medium text-foreground">
            {tr('子任务 · {name}', { name: name ?? SUBAGENT_META[subagentId]?.name ?? subagentId })}
          </span>
          <span className="truncate text-xs text-muted-foreground">{stateText}</span>
        </div>
      </div>

      <Conversation
        className="min-h-0 flex-1"
        // 打开时落底一次（看最新一步）；流式中再按平滑跟随往上走
        resetKey={`subagent-${startedAt}`}
        smoothResize={running}
      >
        <ConversationContent className="mx-auto w-full max-w-3xl px-2 py-3 sm:px-6">
          {/*
            派给它的任务 → **一条用户消息**，而不是头栏下面那块说明条。

            子任务的心智模型就是「主 agent 给它发了一条消息」：任务原文右对齐、进气泡，
            跟主会话里你发出去的那条长得一模一样，助手的过程接在下面。做成固定说明条的话，
            它既不随消息流滚走（长过程里永远占着首屏）、也不像「说过的话」——用户得自己
            转换一次「这行灰字是它的输入」。
          */}
          {task.trim() ? (
            <Message from="user" className="mb-6">
              <MessageContent className="text-[0.9375rem]">
                <MessageParts
                  message={{
                    id: `subagent-task-${startedAt}`,
                    role: 'user',
                    parts: [{ type: 'text', text: task }],
                    createdAt: startedAt
                  }}
                  index={0}
                  total={1}
                  streaming={false}
                />
              </MessageContent>
            </Message>
          ) : null}
          {parts.length ? (
            <Message from="assistant" className="mb-6">
              <MessageContent className="text-[0.9375rem]">
                <MessageParts
                  message={{
                    id: `subagent-${startedAt}`,
                    role: 'assistant',
                    parts,
                    createdAt: startedAt,
                    // 与主消息同口径：只在没有 usage 时单独给耗时，抬头才会报「已工作 N 秒」
                    ...(elapsed != null && !running ? { durationMs: elapsed } : {})
                  }}
                  index={0}
                  total={1}
                  streaming={running}
                />
              </MessageContent>
            </Message>
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {tr('还没有过程记录')}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  )
}
