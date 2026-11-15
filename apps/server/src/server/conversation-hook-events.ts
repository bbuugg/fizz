/**
 * 会话状态事件 → 插件 hook 的**纯映射**。
 *
 * 单独抽出来是为了两件事：
 * 1. 映射规则可以在没有 `state.ts`（会打开数据目录）的情况下单测；
 * 2. 插件看到的是 `@fizz/plugin` 的稳定窄接口，不是 contracts 的 SSE 事件 —— 传输层
 *    以后加字段 / 改名，不该悄悄改变插件 API。
 *
 * 映射只做「挑字段」，不查工作区、不加载插件（那些由 `conversation-hooks.ts` 做）。
 */
import type {
  AskFollowupRequest,
  AgentConfirmRequest,
  ConversationConfirmEvent,
  ConversationConfirmResolvedEvent,
  ConversationFinishedEvent,
  ConversationFollowupEvent,
  ConversationFollowupResolvedEvent,
  ConversationStartedEvent,
  ServerEvent
} from '@fizz/contracts/types'
import {
  HOOKS,
  type ConversationConfirmPayload,
  type ConversationFollowupPayload,
  type ConversationHookPayload,
  type ConversationHookTarget,
  type HookName
} from '@fizz/plugin'

export interface ConversationHookWorkspace {
  id?: string
  name?: string
  /** 工作区目录（插件发现用；远端工作区不传，见宿主的说明） */
  path?: string
}

export interface ConversationHookDispatch {
  hook: HookName
  payload: ConversationHookPayload
  /** 长驻宿主 key：有工作区 = 工作区 id，没有 = '' */
  workspaceId: string
  /** 工作区目录（远端工作区 / 虚拟工作区没有） */
  workspacePath?: string
}

type ConversationEvent =
  | ConversationStartedEvent
  | ConversationFinishedEvent
  | ConversationConfirmEvent
  | ConversationConfirmResolvedEvent
  | ConversationFollowupEvent
  | ConversationFollowupResolvedEvent

const CONVERSATION_EVENT_TYPES = new Set<string>([
  HOOKS.conversationStarted,
  HOOKS.conversationFinished,
  HOOKS.conversationConfirm,
  HOOKS.conversationConfirmResolved,
  HOOKS.conversationFollowup,
  HOOKS.conversationFollowupResolved
])

function isConversationEvent(event: ServerEvent): event is ConversationEvent {
  return CONVERSATION_EVENT_TYPES.has(event.type)
}

function baseOf(
  event: ConversationEvent,
  workspace?: ConversationHookWorkspace
): ConversationHookTarget {
  return {
    conversationId: event.conversationId,
    requestId: event.requestId,
    title: event.title,
    ...(workspace?.id ? { workspaceId: workspace.id } : {}),
    ...(workspace?.name ? { workspaceName: workspace.name } : {})
  }
}

function confirmOf(confirm: AgentConfirmRequest): { confirm: ConversationConfirmPayload['confirm'] } {
  // 只挑出插件通知真正用得上的字段（尤其是不要带 requestId：会话坐标已经在 payload 上了）
  return {
    confirm: {
      id: confirm.id,
      toolCallId: confirm.toolCallId,
      toolName: confirm.toolName,
      command: confirm.command,
      ...(confirm.intent ? { intent: confirm.intent } : {}),
      ...(confirm.agentId ? { agentId: confirm.agentId } : {}),
      ...(confirm.agentName ? { agentName: confirm.agentName } : {}),
      ...(confirm.options?.length
        ? {
            options: confirm.options.map((option) => ({
              optionId: option.optionId,
              name: option.name,
              kind: option.kind
            }))
          }
        : {})
    }
  }
}

function followupOf(
  followup: AskFollowupRequest
): { followup: ConversationFollowupPayload['followup'] } {
  return {
    followup: {
      id: followup.id,
      toolCallId: followup.toolCallId,
      ...(followup.title ? { title: followup.title } : {}),
      questions: followup.questions.map((question) => ({
        id: question.id,
        question: question.question,
        header: question.header,
        multiSelect: question.multiSelect,
        options: question.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {})
        }))
      }))
    }
  }
}

export function conversationHookDispatch(
  event: ServerEvent,
  workspace?: ConversationHookWorkspace
): ConversationHookDispatch | null {
  if (!isConversationEvent(event)) return null

  const workspaceId = workspace?.id ?? ''
  const workspacePath = workspace?.path
  const base = baseOf(event, workspace)

  switch (event.type) {
    case 'conversation:started':
      return {
        hook: HOOKS.conversationStarted,
        payload: { ...base, startedAt: event.startedAt },
        workspaceId,
        ...(workspacePath ? { workspacePath } : {})
      }
    case 'conversation:finished':
      return {
        hook: HOOKS.conversationFinished,
        payload: {
          ...base,
          finishReason: event.finishReason,
          ...(event.excerpt ? { excerpt: event.excerpt } : {}),
          ...(event.error ? { error: event.error } : {}),
          ...(event.stopReason ? { stopReason: event.stopReason } : {}),
          ...(event.steps !== undefined ? { steps: event.steps } : {}),
          finishedAt: event.finishedAt
        },
        workspaceId,
        ...(workspacePath ? { workspacePath } : {})
      }
    case 'conversation:confirm':
      return {
        hook: HOOKS.conversationConfirm,
        payload: { ...base, ...confirmOf(event.confirm) },
        workspaceId,
        ...(workspacePath ? { workspacePath } : {})
      }
    case 'conversation:confirm-resolved':
      return {
        hook: HOOKS.conversationConfirmResolved,
        payload: { ...base, confirmId: event.confirmId, approved: event.approved },
        workspaceId,
        ...(workspacePath ? { workspacePath } : {})
      }
    case 'conversation:followup':
      return {
        hook: HOOKS.conversationFollowup,
        payload: { ...base, ...followupOf(event.followup) },
        workspaceId,
        ...(workspacePath ? { workspacePath } : {})
      }
    case 'conversation:followup-resolved':
      return {
        hook: HOOKS.conversationFollowupResolved,
        payload: {
          ...base,
          followupId: event.followupId,
          toolCallId: event.toolCallId
        },
        workspaceId,
        ...(workspacePath ? { workspacePath } : {})
      }
    default:
      return null
  }
}
