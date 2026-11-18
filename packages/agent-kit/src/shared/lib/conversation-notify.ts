/**
 * 会话事件 → 通知内容（**纯函数**，有单测 `conversation-notify.test.ts`）。
 *
 * 从 `shared/hooks/use-notify-watcher.ts` 抽出来的：那里既是订阅点又是内容组装，于是
 * 「哪些事件要通知」「用户是不是**正看着这一屏**」两条判据都埋在一个闭包里 —— 漏一条
 * 没有任何东西会红。抽成纯函数后，三条分支（审批 / 提问 / 跑完）能被一起钉住。
 *
 * ## 为什么 `alreadyInView` 一条都不能少
 *
 * `notify()` 收到它才敢在前台**不弹应用内 toast**（见 `notify.ts` 文件头：用户正看着
 * 那一屏时，通知的用途根本不成立）。以前只有「跑完」带了这个字段，审批与提问没带 ——
 * 于是用户明明就停在那个会话里、确认卡 / 提问卡就在眼前，右下角仍然飘一条
 * 「等待你确认：…」「AI 有一个问题待回答：…」，纯属打扰。
 *
 * ⚠️ 它只回答「他是不是正看着这一屏」，**不管窗口在不在前台** —— 窗口在后台时
 * `notify()` 会忽略这一位、照发系统通知（人都看不到那一屏了，不叫回来才是丢事件）。
 */
import type {
  AgentConfirmRequest,
  AskFollowupRequest,
  ServerEvent
} from '@fizz/contracts/types'
import { truncateText } from '@fizz/agent-kit/shared/lib/notify'

/** 值得发一条通知的三类会话事件（其余事件本模块一律不管，见 `isConversationNotifyEvent`） */
export type ConversationNotifyEvent = Extract<
  ServerEvent,
  { type: 'conversation:confirm' | 'conversation:followup' | 'conversation:finished' }
>

/**
 * 这条事件要不要发通知。
 *
 * 放行三类会话事件；`container:files-changed`（预览面板自己订阅）、
 * `backgroundTasks:changed`（会话内的面板自己收）以及各种 `*-resolved`（用户已经处理过，
 * 或者别的标签页处理过了）都在这里被挡掉 —— 判据只写这一处，别在调用方再散一遍。
 */
export function isConversationNotifyEvent(
  event: ServerEvent
): event is ConversationNotifyEvent {
  return (
    event.type === 'conversation:confirm' ||
    event.type === 'conversation:followup' ||
    event.type === 'conversation:finished'
  )
}

/** `notify()` 需要的那些位（不含 `onClick`：点进去要哪个会话由调用方补） */
export interface ConversationNotifyOptions {
  title: string
  body: string
  /** 同 tag 互相顶掉：同一会话连着跑多轮不会在右下角 / 通知中心堆一串 */
  tag: string
  /** 用户此刻正看着这个会话（= 前台不必再弹 toast，见文件头） */
  alreadyInView: boolean
}

export interface ConversationNotifyPayload {
  /** 通知点进去要打开的会话 */
  conversationId: string
  options: ConversationNotifyOptions
}

/** 审批请求 → 通知正文：优先给待执行的命令（最需要用户看的），退而给工具名 */
function confirmBody(confirm: AgentConfirmRequest): string {
  const command = confirm.command?.trim()
  if (command) return truncateText(command, 60)
  return confirm.toolName || '需要确认'
}

/** 提问 → 通知正文：第一题的问题文本，没有就退回表单标题 */
function questionBody(followup: AskFollowupRequest): string {
  return truncateText(followup.questions?.[0]?.question ?? followup.title, 60)
}

/** 收尾 → 通知正文：出错给原因、被停给一句话、撞步数上限说明白、正常跑完给助手正文摘要 */
function finishedBody(event: Extract<ConversationNotifyEvent, { type: 'conversation:finished' }>): string {
  if (event.finishReason === 'error') return event.error ? `出错：${event.error}` : '这一轮出错了'
  if (event.finishReason === 'aborted') return '已停止'
  /**
   * 撞步数上限：`finishReason` 仍是 `done`（它不是错误），但**绝不能**当成正常跑完报
   * 摘要 —— 用户最需要知道的就是「它被截断了，不是自己说完的」。
   */
  if (event.stopReason === 'max-steps') {
    return event.steps
      ? `已用满 ${event.steps} 步工具预算，本轮自动停止`
      : '已用满工具步数预算，本轮自动停止'
  }
  return event.excerpt ?? ''
}

/**
 * 把一条会话事件翻译成通知内容。
 *
 * @param activeConversationId 「当前会话」（= 焦点标签正显示的那条，`app.activeConversationId`）。
 *   `null` = 面板上停的是工具标签 / 草稿，那就没人正看着任何会话，`alreadyInView` 自然为 false。
 */
export function conversationNotify(
  event: ConversationNotifyEvent,
  activeConversationId: string | null
): ConversationNotifyPayload {
  const conversationId = event.conversationId
  // 标题：服务端把会话标题一起带来了（清单快照可能还没到，见 `ConversationEventBase.title`）
  const title = truncateText(event.title, 40)
  const alreadyInView = activeConversationId === conversationId

  if (event.type === 'conversation:confirm') {
    return {
      conversationId,
      options: {
        title,
        body: `等待你确认：${confirmBody(event.confirm)}`,
        tag: `conv:${conversationId}:confirm`,
        alreadyInView
      }
    }
  }
  if (event.type === 'conversation:followup') {
    return {
      conversationId,
      options: {
        title,
        body: `AI 有一个问题待回答：${questionBody(event.followup)}`,
        tag: `conv:${conversationId}:followup`,
        alreadyInView
      }
    }
  }
  return {
    conversationId,
    options: {
      title,
      body: finishedBody(event),
      // 同一会话连续跑多轮时顶掉上一轮，不堆叠
      tag: `conv:${conversationId}`,
      alreadyInView
    }
  }
}
