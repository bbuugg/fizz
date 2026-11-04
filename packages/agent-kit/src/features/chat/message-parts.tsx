"use client";

/**
 * 消息渲染零件：一条消息的「正文」怎么画（思考行 / 折叠的思考与工具 / 提问卡 / 操作行）。
 *
 * 这些零件原来长在 `ChatPanel` 里，容器工作台（`flow/node-workbench`）为了跟主会话
 * 同一套观感，直接 import 那一整个面板文件 —— 面板文件把 `useAgentApp`（工作区列表、
 * 会话列表、模型配置…）一起拖了进来，容器侧其实一个都不用。这里把它们单独成文件：
 * **只依赖 `@fizz/contracts` 的消息类型**，任何有消息流的宿主都能直接用。
 */
import { memo, useState, type ReactNode } from 'react'
import { Check, Copy, ArrowRightLeft, GitBranch, Pencil, RotateCw, Trash2 } from 'lucide-react'
import { ShimmerLabel } from '@fizz/agent-kit/shared/ai-elements/shimmer-label'
import { Button } from '@fizz/ui/button'
import { PartView } from '@fizz/agent-kit/features/chat/PartView'
import { TurnStepGroup } from '@fizz/agent-kit/features/chat/TurnStepGroup'
import {
  isStepInFlight,
  turnStepActivity,
  turnStepPreview,
  turnStepSummary,
  workDurationLabel
} from '@fizz/agent-kit/shared/lib/turn-step'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import {
  isErrorText,
  isStoppableToolRunning,
  textOf,
  toolState
} from '@fizz/agent-kit/shared/lib/parts'
import {
  normalizeFollowup,
  formatFollowupAnswer,
  getResumedFollowup,
  isUnansweredFollowup
} from '@fizz/agent-kit/shared/lib/ask-followup'
import { formatMessageTime, formatMessageTimeExact } from '@fizz/agent-kit/shared/lib/message-time'
import { ContextCompactionCard } from '@fizz/agent-kit/features/chat/ContextCompactionCard'
import type { ContextCompactionState } from '@fizz/agent-kit/shared/lib/stores/slices/conversation'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentMessagePart, AskFollowupAnswer } from '@fizz/contracts/types'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'

/**
 * 消息底部的「正在思考…」行：还没有任何 part 时、以及「在等模型下一步」时共用同一个观感。
 *
 * 文案用 `ShimmerLabel`（与分组抬头、思考条触发器同一份组件）：同一个「思考中」不能
 * 一会儿扫光、一会儿转圈，观感要一致。
 */
export function ThinkingRow() {
  // 订阅语言：切成英文后这行字要跟着变（`useT()` 同时提供文案）
  const tr = useT()
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <ShimmerLabel>{tr('正在思考…')}</ShimmerLabel>
    </div>
  )
}

/**
 * 整轮还在跑，但**最后一段已经落地**、正在等模型下一步输出 —— 这时要在消息底部把最初那个
 * 「正在思考…」补回来，否则界面看着像已经结束了（用户要求：「思考结束了、工具调用结束了，
 * 下方应该显示刚开始那个思考中的效果，直到有其他消息或者停止」）。
 *
 * 判据只看**尾段自己有没有「正在进行」的观感**，有就不补：
 * - `text`：正文还在流，本身就是进行中；
 * - `reasoning`：思考条的触发器在 streaming 时自己闪着「正在思考…」（`ShimmerLabel`）；
 * - `tool-call` **还没出结果**：卡片上是 Running 徽章 —— 出了结果（`hasOutput`）才算落地；
 * - 孤儿 `tool-result`：落地。
 *
 * 这个判据顺带把「在等用户」的情况排掉了：`ask_followup_question` 和「等审批」的工具都还没有
 * output，所以不会在那种时刻冒出「正在思考…」误导人。
 */
export function isWaitingNextStep(parts: AgentMessagePart[]): boolean {
  const last = parts[parts.length - 1]
  // 一个 part 都还没有的情况由调用方按 `parts.length === 0` 单独认（同一个 ThinkingRow），
  // 这里返回 false 是为了别在同一处渲染两遍
  if (!last) return false
  if (last.type === 'text' || last.type === 'reasoning') return false
  if (last.type === 'tool-call') return toolState(last).hasOutput
  return true
}

/**
 * 提问卡的接线（**容器工作台没有**作答通道，故整项可选）。
 *
 * 这里只判「有没有对应 toolCallId 的待答提问」，从不读它的字段，所以值类型取 unknown。
 * 抽出来是为了让 `MessageParts` 不再依赖 `AgentApp` —— 否则容器侧复用不了它。
 */
export interface MessageFollowupBridge {
  requests: Record<string, unknown>
  onResolve: (toolCallId: string, answer: AskFollowupAnswer | null) => void
  /**
   * 「补答」通道：那一轮已经结束了（应用退出 / 点了停止 / 进程崩了），答案回填不到
   * 工具里，只能当一条新消息发出去。不传 = 补答按钮不出现（容器侧没有发送语义）。
   *
   * 参数是**已经拼好的整条消息文本**（见 `formatFollowupAnswer`）—— 拼装规则放在
   * `shared/lib/ask-followup.ts` 里，这一层不碰格式。
   */
  onResume?: (text: string) => void
}

/**
 * 渲染一条消息的全部 parts（`MessageList` 消息循环里的 parts.map 就委托到这里）。
 *
 * 助手消息**两个阶段各有一套折叠口径**，靠同一段分组代码实现（差别只在「正文要不要收」）：
 *
 * 1. **流式中**：正文一段都不收（正在写的字必须看得见），但**思考 / 工具调用一律收进分组** ——
 *    包括最后那段正文之后的尾巴（正在思考 / 正在跑命令的那几步）。抬头左格报**最后做的那一件事**
 *    （工具的 `intent`，没有就工具名）、右格报**这一步的内容**（思考最后一行 / 命令 / 路径），
 *    **不报耗时** —— 读起来是 `[跑一下单测 · $ pnpm test] → 正文 → [思考中… · 最后一行]`。
 * 2. **一轮结束**（助手消息且不是正在流式的末条 —— 完成判据见 `turnDone` 的注释）：
 *    所有组连成**一个**（前面各段正文、思考、工具调用、提问卡……），**这时抬头才换成**
 *    整轮耗时（拿不到 usage 时退回 `turnStepSummary` 的计数）。
 *
 * 组内每一张卡（思考条 / 工具卡）**默认收起、可点开**，两个阶段一个口径 —— 组只管
 * 「这一段过程整体露不露」，细看哪一步交给用户自己点（不做嵌套自动展开）。
 *
 * 「最后一段正文」由 `lastTextIndex` 认定（最后一个有内容的 text part）。错误块（`⚠️ ` 前缀）
 * **永不折叠** —— 它带着「重新加载」按钮。用户消息整条原样铺开，不参与折叠。
 *
 * 整轮只有一段正文、没有任何思考 / 工具时没有折叠条（就是一条普通回复）；只调了工具
 * 就收尾时，折叠条就是这条消息的全部内容。
 *
 * ⚠️ 空白文本不算「文本」：模型会在思考 / 工具之间偶发输出纯换行的 text part
 * （实测存量数据里大量「\n\n\n」），它没有可见内容，若不打断会被当成正文渲染成
 * 空白段落，还会把本该连在一起的工具段拆成多个组 —— 分组时直接跳过。
 */
export interface MessagePartsProps {
  message: AgentChatMessage
  index: number
  /** 消息总条数：`index` 跟它比才知道「是不是最后一条」 */
  total: number
  streaming: boolean
  /** 不传 = 提问卡只读（容器侧） */
  followup?: MessageFollowupBridge
  /** 当前会话的交接文档；只有 `messageId` 匹配的那条消息会把它插进 parts 流。 */
  compaction?: ContextCompactionState | null
  /**
   * 「继续」：撞上步数上限的那一轮，正文后面那行提示旁边会有一颗按钮，点它由宿主发一条
   * 新消息把任务续下去。不传 = 只显示提示、不给按钮（容器工作台没有「发消息」的语义）。
   */
  onContinue?: () => void
}

/**
 * 「这一轮被步数上限截断」的提示行 +「继续」。
 *
 * 为什么必须有它：撞上限的那一轮 `finishReason` 仍是 `done`（它不是错误、也不是用户停的），
 * 以前界面上完全看不出来 —— 用户只看到「工具卡都跑完了，然后没有下文」。这一行是**唯一
 * 的解释**，所以它跟正文同一层级，不收进折叠条（收进去等于让人找不到）。
 *
 * 只在 `stopReason` 存在时出现：老数据没有这个字段，渲染与从前逐字节一致。
 */
function MaxStepsNotice({ steps, onContinue }: { steps?: number; onContinue?: () => void }) {
  const tr = useT()
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground">
      <span>
        {steps
          ? tr('本轮已用满 {n} 步工具上限，自动停止', { n: steps })
          : tr('本轮已用满工具步数上限，自动停止')}
      </span>
      {onContinue ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={onContinue}
        >
          {tr('继续')}
        </Button>
      ) : null}
    </div>
  )
}

function MessagePartsInner({
  message,
  index,
  total,
  streaming,
  followup,
  compaction,
  onContinue
}: MessagePartsProps) {
  // 订阅语言：折叠条摘要（思考 ×N / 工具调用 ×N）在渲染期用 `t()` 算，切语言要跟着变
  useT()
  /**
   * 抬头是否显示工具的「意图」（设置 → AI → 通用 → 工具意图）。
   *
   * 关掉时连历史里已有 intent 的组也回到工具名 —— 与工具卡（`PartView` 的 `cardHead`）
   * 同一个开关、同一个语义，否则组抬头有意图、点开卡片却是纯工具名。
   */
  const showToolIntent = useAgentStore((s) => s.toolIntent)
  /**
   * 「只停这一条」的通道（组抬头那颗停止钮用）：store 上的稳定引用，放进依赖不引发重渲。
   *
   * 与工具卡头部 / 输入框上方 chip 是同一个 action —— `stopCommand(toolCallId)` 内部自己
   * 取当前会话在跑那轮的 requestId，服务端只 abort 这一个工具（命令杀进程树 / 抓取 abort /
   * 子任务 abort 子 run），整轮继续。
   */
  const stopCommand = useAgentStore((s) => s.stopCommand)
  /*
   * 「查看子任务过程」的**打开通道由会话宿主提供**（`ChatSurface`），不在这里做：
   * 早先这块 state + Dialog 长在本组件里，于是过程面板只能是个弹窗、且存的是
   * 「点开那一刻」的 delegation 快照（运行中打开就冻住）。
   * 现在宿主拿 `toolCallId` 逐帧重取，直接把主会话换成子任务的消息流。
   */
  const isStreamingLast = streaming && index === total - 1
  // 一轮完成的判据：助手消息且不是「正在流式的末条」。
  // ⚠️ 不能拿 `message.usage` 当完成标记：usage 只在内置 agent 的 finish 帧里有，
  // ACP 的 finish 事件从不带（acp.ts 适配层把 usage 一律丢弃，会话回放同样没有）——
  // 按它判定的话 ACP 会话（Claude Code 等）的轮次永远收不进折叠条。
  // parts 只往当前正在跑的那条占位消息里追加，历史消息都是已终结的轮次，
  // 所以「非流式末条」本身就是完成信号。
  const turnDone = message.role === 'assistant' && !isStreamingLast
  /*
   * 整轮耗时**只在整轮结束后**才报，两个来源（互斥）：
   * - `usage.durationMs`：内置后端正常跑完（服务端采集，含网络与工具耗时）；
   * - `message.durationMs`：没有 `usage` 但知道耗时的轮次 —— ACP 全程如此（它没有 token
   *   用量），内置后端**被中断 / 出错**时也是（那一轮常常一个 usage chunk 都没收到）。
   * 两个都没有才退回计数摘要（`groupHead`），比如 ACP 会话被 `session/load` 重建之后。
   *
   * 流式中不再边走边报「已工作 N 秒」：那个数每秒都在变，占着抬头却什么也没说 ——
   * 用户明确要求「没结束就报最后做的那件事的名字 / 意图，结束了再报耗时」。
   */
  const durationMs = message.usage?.durationMs ?? message.durationMs

  const ownCompaction =
    compaction && compaction.messageId === message.id ? compaction : null
  const compactionIndex = Math.max(
    0,
    Math.min(ownCompaction?.afterPartIndex ?? message.parts.length, message.parts.length)
  )
  const compactionNode = ownCompaction ? (
    <ContextCompactionCard key={`${message.id}-compaction`} compaction={ownCompaction} />
  ) : null

  const renderPart = (part: AgentMessagePart, partIndex: number): ReactNode => {
    const tcid = part.type === 'tool-call' ? part.toolCallId : undefined
    const followupReq = tcid ? followup?.requests[tcid] : undefined
    /**
     * 补答：这一轮**已经结束**（`turnDone`）、这张卡从没拿到答案、也没有活跃的待答
     * 请求 —— 三种条件同时成立才出现。有活跃请求就是正常待答路径，由服务端回填。
     *
     * 场景：应用退出时那一轮被中止（提问还挂着），重开后工具卡留着 input 但没有答案，
     * 以前只显示「助手的提问（无待作答表单）」，问题等于白问。
     */
    const resumable =
      !followupReq &&
      turnDone &&
      !!followup?.onResume &&
      !(tcid && getResumedFollowup(tcid)) &&
      isUnansweredFollowup(part)
    /** 补答消息的抬头用表单标题（没有就留空，见 `formatFollowupAnswer`） */
    const resumableTitle =
      resumable && part.type === 'tool-call' ? normalizeFollowup(part.input).title : ''
    return (
      <PartView
        key={`${message.id}-${partIndex}`}
        part={part}
        // 流式 = 整轮在跑 + 这条是最后一条消息 + 这个 part 是消息的最后一个。
        // 只有 reasoning 消费它（「思考中」的判断依据）。
        streaming={isStreamingLast && partIndex === message.parts.length - 1}
        // 停止钮的判据：**整条消息在跑**（不要求是最后一个 part）—— 见 PartViewProps.turnLive。
        turnLive={isStreamingLast}
        followupPending={!!followupReq}
        followupResumable={resumable}
        onResolveFollowup={
          tcid && followupReq && followup
            ? (answer) => followup.onResolve(tcid, answer)
            : resumable && followup?.onResume
              ? (answer) => {
                  // 跳过 = 什么都不做（补答没有「跳过」的语义，卡片那边也不显示这颗钮）
                  if (!answer) return
                  followup.onResume?.(formatFollowupAnswer(answer, resumableTitle))
                }
              : undefined
        }
      />
    )
  }

  /** 原样铺开全部 parts（用户消息走这条；分组 / 折叠相关的一切都不参与） */
  const renderAll = (): ReactNode => {
    const out: ReactNode[] = []
    message.parts.forEach((part, partIndex) => {
      if (compactionNode && partIndex === compactionIndex) out.push(compactionNode)
      out.push(renderPart(part, partIndex))
    })
    if (compactionNode && compactionIndex >= message.parts.length) out.push(compactionNode)
    return <>{out}</>
  }

  // 用户消息：原样铺开 —— 它只有正文，没有任何可折叠的过程
  if (message.role !== 'assistant') return renderAll()

  // 空白文本（纯换行 / 空格）没有任何可见内容 —— 见函数头注释
  const isBlankText = (part: AgentMessagePart): boolean =>
    part.type === 'text' && !part.text.trim()

  /**
   * 最后一段有内容的正文的下标：**一轮结束后它留在明面上**，前面各段跟着过程一起收进
   * 折叠条。流式中它只有一个用途 —— 标出「过程段到哪里算落地了」（组抬头的进行中 / 耗时切换）。
   *
   * 一轮里模型常常分几段说话（段与段之间夹着思考 / 工具调用），全铺出来会把结论淹在过程
   * 里。错误块（`⚠️ ` 前缀）不参与竞争：它带着「重新加载」按钮，收进折叠条等于让人找不到
   * 恢复入口 —— 它永远单独铺在明面上（见下面 `foldable` 里的那条早退）。
   */
  let lastTextIndex = -1
  /** 最后一个「有东西」的 part（空白文本不算）：判断哪一段过程是正在跑的尾巴 */
  let lastVisibleIndex = -1
  message.parts.forEach((part, i) => {
    if (isBlankText(part)) return
    lastVisibleIndex = i
    if (part.type === 'text' && part.text.trim() && !isErrorText(part.text)) lastTextIndex = i
  })

  /**
   * 这个 part 要不要收进分组。
   *
   * - `text`：**流式中一段都不收**（正在写的正文必须看得见）；**一轮结束后只留最后一段**
   *   （见 `lastTextIndex`）。
   * - `reasoning` / `tool-call` / `tool-result`：**一律收** —— 流式中也收（抬头是最后那件事的
   *   `intent` / 工具名 + 一行内容，点开才看完整过程），不再有「自动折叠」开关。
   *
   * 没被收的 part 照常铺在消息里，而且**会打断分组**（分组只吃连续的同类 part，
   * 时间线不会被重排）。
   */
  const foldable = (part: AgentMessagePart, partIndex: number): boolean => {
    if (part.type === 'text') {
      // 错误块永远明面显示（它身上有「重新加载」）
      if (isErrorText(part.text)) return false
      // 流式中每段正文都看得见；一轮结束后只留最后一段
      if (!turnDone) return false
      return partIndex !== lastTextIndex
    }
    if (part.type === 'reasoning') return true
    if (part.type === 'tool-call' || part.type === 'tool-result') {
      /**
       * ⚠️ 没拿到答案的提问卡**不收进分组**：它是可点的（补答），而分组默认收起
       * —— 藏进去等于让人看不见那张还能答的卡。
       * 补答过之后（`getResumedFollowup` 有值）就变回普通的「已回答」横条，照常折叠。
       */
      if (
        followup?.onResume &&
        isUnansweredFollowup(part) &&
        !(part.type === 'tool-call' && getResumedFollowup(part.toolCallId))
      ) {
        return false
      }
      return true
    }
    return false
  }

  /**
   * 组抬头，两档口径（一行两格：左边名字、右边这一步的内容预览）：
   *
   * - **整轮还没结束**：左格报「最后做的那一件事」—— 工具的 `intent`（没有就工具名）、
   *   思考在跑时是「思考中…」、落地后是「思考过程」。**不报耗时**：那个数每秒都在变，
   *   占着抬头却看不出在干什么。
   * - **整轮结束**：左格报整轮耗时（`durationMs`，见上）；连耗时都拿不到（比如 ACP 会话
   *   被 `session/load` 重建）才退回计数摘要。
   *
   * 右格（`preview`）**只在整轮还没结束时**给：思考的最后一行 / 命令 / 路径 —— 流式中折叠
   * 着也能看出「这一步到底做的什么」，不用点开。整轮结束后抬头已经是一句总结（耗时 /
   * 计数），再把最后那一步的内容挂在右边，等于在总结后面接了个「当时在干什么」的尾巴：
   * 那一步的结果早就写在正文里了，用户要的是这一轮花了多久（用户明确要求）。
   *
   * `active`（抬头扫光 + 预览跟最新字）只在这段**真还在跑**时为真：整轮还在流式、这一段是
   * 最后一段可见内容、尾 part 自己真的在跑（见 `isStepInFlight`，等用户作答的提问卡不算）。
   *
   * `live` 是更宽的一档，只差尾 part 那一条：**这组还是本轮最后一段可见内容**就算。
   * 给展开态的「正在工作」用 —— 工具刚出结果、模型还在生成下一次调用的那几秒，
   * `isStepInFlight` 会翻 false，文案挂在 `active` 上就会来回闪（见 `TurnStepGroup`）。
   */
  const groupHead = (
    steps: { part: AgentMessagePart; partIndex: number }[]
  ): {
    label: string
    active: boolean
    live: boolean
    /** 尾 part 的类型 —— 抬头名字左边那颗图标（工具 / 脑）靠它，口径与左格文案一致 */
    kind: 'tool' | 'reasoning'
    /** 尾 part 是工具时给工具名：抬头那颗图标要靠它认出「执行命令 → 终端」 */
    toolName?: string
    preview?: { text: string; lineKey: number }
    /**
     * 这一段「此刻能就地停掉」时给那一步的 `toolCallId`（`undefined` = 不给停止钮）。
     * 抬头那行本来就写着「现在在干什么」，停止就该在它旁边 —— 见 `TurnStepGroup.onStop`。
     */
    stopToolCallId?: string
  } => {
    const parts = steps.map((step) => step.part)
    const tail = steps[steps.length - 1]
    const live = !turnDone && tail.partIndex === lastVisibleIndex
    const running = live && isStepInFlight(tail.part)
    const preview = turnStepPreview(parts)
    // 与 `turnStepActivity` 同一个分支：只有尾 part 是 tool-call 才走「工具」那一档，
    // 其余（思考 / 空组）按思考算 —— 否则图标会和那行文案对不上
    const kind: 'tool' | 'reasoning' = tail.part.type === 'tool-call' ? 'tool' : 'reasoning'
    // 抬头图标与组内那张卡同源：命令类是终端、文件类是文件（`toolHeadIcon`）
    const toolName = tail.part.type === 'tool-call' ? tail.part.toolName : undefined
    /*
     * 「这一组现在能不能停」的唯一判据，与工具卡头部那颗钮同源（`isStoppableToolRunning`：
     * execute_command / web_fetch / 派活工具 `agent-*`，且已拿到完整入参、还没出结果）。
     *
     * 三条同时成立才给：
     * - `isStreamingLast`：历史里因中止 / 断线残留的未结算 part 也停在 `input-available`，
     *   给它们一颗能点的钮是在骗人（点了服务端没有任何可 abort 的对象）；
     * - 尾 part 是 `tool-call`：抬头报的是「最后做的那一件事」，停的也只能是它；
     * - `isStoppableToolRunning`：入参还在流式生成时没有可停的东西 —— 工具卡那颗此时
     *   退回「中止整轮」，组抬头干脆不给（多停一整轮比少给一颗钮的代价大得多）。
     *
     * 组里并行多个工具时只停尾 part：抬头只展示了最后那一个，一颗钮停一个才说得清
     * 「按下它会发生什么」。其它几条要点开组、用各自卡片上的钮。
     */
    const stopToolCallId =
      !turnDone &&
      isStreamingLast &&
      tail.part.type === 'tool-call' &&
      isStoppableToolRunning(tail.part)
        ? tail.part.toolCallId
        : undefined
    if (!turnDone) {
      return {
        label: turnStepActivity(parts, { showIntent: showToolIntent, active: running }),
        active: running,
        live,
        kind,
        toolName,
        preview,
        stopToolCallId
      }
    }
    // 整轮结束：**不给 preview**（右格留白）—— 抬头这时是一句总结，不是「下一步做什么」。
    // 刻意不写成 `preview: undefined`，省得将来有人以为漏传了。
    const doneLabel = durationMs != null ? workDurationLabel(durationMs) : turnStepSummary(parts)
    return { label: doneLabel, active: false, live: false, kind }
  }

  // 按原始顺序走一遍：连续的「要折叠的」part 各自成组，其余穿插在各组之间
  // （时间线保持原样）。part 保留原始下标 —— key 与 PartView 的接线都靠它保持稳定。
  //
  // 于是同一段代码天然给出两种观感：
  // - **流式中**：正文一段不收，过程段（含最后那段正文之后的尾巴）全部成组 ——
  //   抬头一律是「最后做的那件事 + 它的内容」：
  //   `[跑一下单测 · $ pnpm test] → 正文 → [读取文件 · src/parts.ts] → 正文 → [思考中… · …]`；
  // - **一轮结束**：只有最后一段正文不收，前面所有过程（连同前面各段正文）连成**一个**
  //   折叠条，紧跟着就是那段结论；抬头这时才换成「已工作 N 秒」。
  //
  // 组内每张卡（思考条 / 工具卡）都是**收起且可点开**的，流式中与结束后一个口径：
  // 组只管「这一段过程整体露不露」，细看哪一步由用户自己点。
  const nodes: ReactNode[] = []
  let run: { part: AgentMessagePart; partIndex: number }[] = []
  const flushRun = (): void => {
    if (!run.length) return
    const current = run
    run = []
    const { label, active, live, kind, toolName, preview, stopToolCallId } = groupHead(current)
    nodes.push(
      <TurnStepGroup
        key={`${message.id}-steps-${current[0].partIndex}`}
        label={label}
        preview={preview}
        active={active}
        live={live}
        kind={kind}
        toolName={toolName}
        // 只停这一段里正在跑的那一步（判据在 `groupHead`），整轮继续
        onStop={stopToolCallId ? () => void stopCommand(stopToolCallId) : undefined}
      >
        {current.map(({ part: stepPart, partIndex: stepIndex }) =>
          renderPart(stepPart, stepIndex)
        )}
      </TurnStepGroup>
    )
  }
  message.parts.forEach((part, partIndex) => {
    if (compactionNode && partIndex === compactionIndex) {
      flushRun()
      nodes.push(compactionNode)
    }
    if (isBlankText(part)) return
    if (foldable(part, partIndex)) {
      run.push({ part, partIndex })
      return
    }
    flushRun()
    nodes.push(renderPart(part, partIndex))
  })
  flushRun()
  if (compactionNode && compactionIndex >= message.parts.length) nodes.push(compactionNode)
  /**
   * 撞步数上限：正文之后补一行「为什么停」+「继续」。
   *
   * 位置在**最后**：这一轮常常连一句正文都没有（工具跑完就被停），提示必须紧跟着过程
   * 折叠条，否则用户看到的就是一片空白。`turnDone` 兜住「还在跑」的那一小段窗口。
   */
  if (turnDone && message.stopReason === 'max-steps') {
    nodes.push(
      <MaxStepsNotice
        key={`${message.id}-max-steps`}
        steps={message.steps}
        onContinue={onContinue}
      />
    )
  }

  return <>{nodes}</>
}

/**
 * 一条消息的 parts 渲染（**带 memo**）。
 *
 * ⚠️ **为什么必须 memo**：流式期间每一批帧都会让整棵消息列表重渲（见 `lib/frame-batch.ts`
 * 的说明）。没有 memo 时，一条 200 条消息的历史每帧都要把**全部** parts 重新 render 一遍
 * —— 老消息的内容根本没变，全是白做的。memo 之后只有「引用变了的那条」（也就是正在
 * 流式的末条）会真的重渲，其余直接跳过。
 *
 * **为什么用自定义比较器**：`followup` 是调用方内联的对象字面量，每次渲染都是新引用
 * （见 `ChatPanel` 的 `<MessageList followup={{...}}>`）。逐字段浅比会永远判定「变了」，
 * memo 就白加了。这里只比它真正影响渲染的那一项：
 * - `requests` 是 store 里的对象（`app.followupRequests`），没变就是同一引用；
 * - `onResolve` 是 `(id, ans) => void app.resolveFollowup(...)`，闭包内部读的是 store
 *   **最新**值，引用变化不需要重渲。
 *
 * 其余依赖（`message` / `index` / `total` / `streaming`）都是「老消息引用不变、
 * 末条引用必变」的形状，逐项比即可。
 *
 * `onResume`（补答通道）只比**有没有**：它决定「没拿到答案的提问卡能不能补答」，
 * 而它本身同样是个内联箭头函数（闭包读 store 最新值），引用变化不需要重渲。
 *
 * `onContinue`（撞步数上限后的「继续」）同理**不参与比较**：它只在那条消息带
 * `stopReason` 时被用到，而 `message` 本身就是逐引用比的 —— 内容没变就不需要重渲。
 */
export const MessageParts = memo(
  MessagePartsInner,
  (prev, next) =>
    prev.message === next.message &&
    prev.index === next.index &&
    prev.total === next.total &&
    prev.streaming === next.streaming &&
    prev.compaction === next.compaction &&
    prev.followup?.requests === next.followup?.requests &&
    !!prev.followup?.onResume === !!next.followup?.onResume
)

/**
 * 删除消息的两种范围：`single` = 只删本条，`from` = 本条及其后的全部消息。
 * 「是否连同之后的消息一起删」由用户在行内确认条上现选。
 */
export type DeleteMessageMode = 'single' | 'from'

/**
 * 消息条上的操作按钮（复制 / 编辑 / 删除）。
 *
 * 位置跟着消息自己的那一侧站：用户消息靠右（`self-end`），AI 消息靠左（`self-start`）——
 * `Message` 是纵向 flex，横向对齐就看 `self-*`。
 * 外观上**不要边框 / 背景 / 阴影**：平时隐形，hover 消息或点了操作才浮现，只有按钮自己有 hover 底色。
 *
 * ⚠️ **流式输出的最后一条助手消息**上它只用来**占位**（用户要求：跑着时不挂可交互的按钮，
 * 见 `MessageList` 里的判断）——`MessageList` 把真行渲染在一个 `invisible` + `pointer-events-none`
 * 的壳里，高度逐像素一致但既看不见也点不到。光靠行自己的 `opacity-0` 挡不住：那个还能被
 * `group-hover` 翻出来，鼠标一扫就露出来了。占位是为了「结束那一帧」不凭空长出一行把正文顶上去。
 *
 * 正在编辑重发的那条消息也**不渲染**它（见 `ChatPanel` 的 `renderActions`）：编辑态的标识
 * 由「输入框上方的编辑条 + 消息上的描边」两处负责，操作行再杵在这儿只会多一个能点的入口
 * （再点一次「编辑」毫无意义，而「删除」正对着要重发的内容，很容易误点）。
 */
export function MessageActionRow({
  message,
  deleteCount,
  onEdit,
  onRetry,
  onDelete,
  onFork,
  onConvertFromHere,
  usageSlot
}: {
  message: AgentChatMessage
  /** 含本条在内、会被一起删掉的消息条数 */
  deleteCount: number
  /** 不传 = 不渲染「编辑并重发」（容器侧改不了历史消息） */
  onEdit?: () => void
  /**
   * 不传 = 不渲染「重试」（同样只在能改历史的宿主里给）。
   *
   * 语义就是「编辑 → 一个字不改 → 发送」：以这条为起点删掉本条及其后的消息，再按原样
   * 发一轮。调用方负责把原文与附件原样递回去（这里不碰消息内容）。
   *
   * 摆在「编辑」**左边**：两者是同一件事的两个入口，重试是「不改就发」的那一个，
   * 更常用，也就在更靠外侧、更容易点到。
   *
   * ⚠️ 会**不可逆地删掉后续历史**（与编辑重发同一条路），所以只在会话没在跑、没在删
   * 的时候由调用方给这个回调 —— 别在这里判，这里不需要知道会话状态。
   */
  onRetry?: () => void
  /** 不传 = 不渲染「删除」（容器侧改不了历史消息） */
  onDelete?: (mode: DeleteMessageMode) => void
  /** 不传 = 不渲染「从此签出」（会话分叉：以这条消息为终点开一个分支会话） */
  onFork?: () => void
  /**
   * 不传 = 不渲染「从此转为内置 Agent 会话」。
   *
   * 只对 **ACP 会话**给：ACP 的历史在外部 agent 进程里、本进程改不了，但可以把它
   * **复制**成一条内置（内置）会话 —— 以这条消息为终点，历史到这条为止（见
   * `convertAcpConversation`）。它比「从此签出」更彻底：签出仍是同一种后端，转换是换后端。
   */
  onConvertFromHere?: () => void
  /**
   * 「本轮用量」那颗图标（**渲染在这一排的最前面**，在「复制」之前）。
   *
   * 由调用方喂节点而不是在这里判 message：用量的数据来源与判据（内置 agent 看
   * `message.usage`、ACP 没有）都在 `ChatPanel` 那边，这里只负责「摆在复制左边、
   * 跟着这一排一起显隐」这一件事。不传就不渲染。
   */
  usageSlot?: ReactNode
}) {
  const tr = useT()
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const copy = (): void => {
    const text = textOf(message)
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  const showActions = copied

  /** 行内小按钮：无边框，只有 hover 底色 */
  const actionButton =
    'rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground'

  /*
   * 这一排里那格时刻。**位置左右不对称**，跟着角色走：
   *
   * - 用户消息：整排靠右（`self-end`），时间放在**按钮左边** —— 再往右就顶到消息区的
   *   右边距了，而左边还有富余；
   * - 助手消息：整排靠左（`self-start`），时间放在**按钮右边**。
   *
   * 语义上：
   * - 用户消息：**发送时间**（`createdAt` 就是发出去的那一刻）；
   * - 助手消息：**这一轮的结束时间** —— 服务端是整轮跑完才落盘，`createdAt` 取的就是
   *   收尾那一刻的 `Date.now()`（见 `chat-turn.ts` 的 `persistAssistantMessage`）。
   *   流式期间那条占位消息的 `createdAt` 是「开始」语义，但它不会渲染这一排
   *   （`MessageList` 统一不给流式末条挂操作行），所以这里不会先显示开始时间再跳成结束时间。
   *
   * 取不到就整格不渲染：ACP 会话没有可用时间戳（`acp.ts` 回放时给全体消息打同一个
   * `now`），不过那边走的是 `CopyOnlyActions`，压根到不了这一行。
   */
  const stamp = formatMessageTime(message.createdAt)
  const stampNode = stamp ? (
    <span
      title={tr(message.role === 'user' ? '发送时间 {time}' : '结束时间 {time}', {
        time: formatMessageTimeExact(message.createdAt)
      })}
      // `tabular-nums` 让 1 和 8 一样宽，显隐切换时不抖
      className="px-1 text-xs text-muted-foreground tabular-nums"
    >
      {stamp}
    </span>
  ) : null

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 rounded-md px-0.5 py-0.5 transition-opacity max-md:opacity-100',
        message.role === 'user' ? 'self-end' : 'self-start',
        showActions ? '' : 'opacity-0 md:group-hover:opacity-100'
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 用户消息的时刻在**按钮左边**（这一排靠右，右边再放就顶到边距了）；
          助手消息留在末尾，见下方 */}
      {message.role === 'user' ? stampNode : null}

      {/* 「本轮用量」在前：它是**读数**，复制 / 编辑 / 删除是**动作** —— 读在动之前 */}
      {usageSlot}

      <button
        type="button"
        title={copied ? tr('已复制') : tr('复制消息')}
        aria-label={tr('复制消息')}
        onClick={copy}
        className={actionButton}
      >
        {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
      </button>

      {onFork && (
        <button
          type="button"
          title={tr('从此签出：以这条消息为终点创建分支会话（历史到这里为止，两边各自独立）')}
          aria-label={tr('从此签出')}
          onClick={onFork}
          className={actionButton}
        >
          <GitBranch className="size-4" />
        </button>
      )}

      {onConvertFromHere && (
        <button
          type="button"
          title={tr('从此转为内置 Agent 会话：以这条消息为终点复制成一条内置会话（历史到这里为止）')}
          aria-label={tr('从此转为内置 Agent 会话')}
          onClick={onConvertFromHere}
          className={actionButton}
        >
          <ArrowRightLeft className="size-4" />
        </button>
      )}

      {/* 重试在编辑**左边**：两者同一件事，「不改就发」更常用（见 onRetry 的注释） */}
      {message.role === 'user' && onRetry && (
        <button
          type="button"
          title={tr('重试这条：不修改内容，直接以它为起点重新发送（会删掉它之后的消息）')}
          aria-label={tr('重试这条消息')}
          onClick={onRetry}
          className={actionButton}
        >
          <RotateCw className="size-4" />
        </button>
      )}

      {message.role === 'user' && onEdit && (
        <button
          type="button"
          title={tr('编辑并重新发送')}
          aria-label={tr('编辑并重新发送')}
          onClick={onEdit}
          className={actionButton}
        >
          <Pencil className="size-4" />
        </button>
      )}

      {!onDelete ? null : confirming ? (
        <span className="flex items-center gap-1 pr-0.5">
          <span className="whitespace-nowrap text-xs text-muted-foreground">{tr('删除本条？')}</span>
          <Button
            size="sm"
            variant="destructive"
            className="h-6 px-2 text-xs"
            onClick={() => onDelete('single')}
          >
            {tr('仅本条')}
          </Button>
          {/* 后面没有消息时「及后续」与「仅本条」等价，不重复给一个入口 */}
          {deleteCount > 1 && (
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-2 text-xs"
              onClick={() => onDelete('from')}
            >
              {tr('及后续 {count} 条', { count: deleteCount - 1 })}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setConfirming(false)}>
            {tr('取消')}
          </Button>
        </span>
      ) : (
        <button
          type="button"
          title={tr('删除这条消息（可选是否连同其后的消息一起删）')}
          aria-label={tr('删除这条消息')}
          onClick={() => setConfirming(true)}
          className={cn(actionButton, 'hover:bg-destructive/10 hover:text-destructive')}
        >
          <Trash2 className="size-4" />
        </button>
      )}

      {/* 助手消息的时刻压在按钮右侧（整排最后一个）：动作在前、时间在后，
          读起来像「复制完了，这轮是 14:03 收的尾」 */}
      {message.role === 'assistant' ? stampNode : null}
    </div>
  )
}