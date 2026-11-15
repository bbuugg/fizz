/**
 * 会话事件 → 插件 hook 的映射。
 *
 * 这条测试防的是「桥接层悄悄改了插件看到的数据形状」：事件字段挑错 / 漏挑、
 * 工作区坐标丢失、把非会话事件也当成钩子发出去，都会让通知插件在运行时静默失灵
 * （监听器收不到或收到 undefined 字段），而这类错误不会有任何启动期报错。
 */
import { describe, expect, it } from 'vitest'
import { HOOKS } from '@fizz/plugin'
import type {
  AgentConfirmRequest,
  AskFollowupRequest,
  ConversationFinishedEvent,
  ConversationStartedEvent,
  ServerEvent
} from '@fizz/contracts/types'
import { conversationHookDispatch } from './conversation-hook-events'

const workspace = { id: 'ws-1', name: '演示项目', path: '/tmp/demo' }

const base = {
  conversationId: 'conv-1',
  requestId: 'req-1',
  title: '修一下登录'
}

describe('conversationHookDispatch', () => {
  it('started：带上会话坐标与工作区', () => {
    const event: ConversationStartedEvent = {
      type: 'conversation:started',
      ...base,
      startedAt: 123
    }
    const dispatch = conversationHookDispatch(event, workspace)
    expect(dispatch?.hook).toBe(HOOKS.conversationStarted)
    expect(dispatch?.workspaceId).toBe('ws-1')
    expect(dispatch?.workspacePath).toBe('/tmp/demo')
    expect(dispatch?.payload).toMatchObject({
      ...base,
      workspaceId: 'ws-1',
      workspaceName: '演示项目',
      startedAt: 123
    })
  })

  it('finished：摘要、错误、步数上限都保留', () => {
    const event: ConversationFinishedEvent = {
      type: 'conversation:finished',
      ...base,
      finishReason: 'done',
      excerpt: '已经修好了',
      stopReason: 'max-steps',
      steps: 24,
      finishedAt: 456
    }
    const dispatch = conversationHookDispatch(event, workspace)
    expect(dispatch?.hook).toBe(HOOKS.conversationFinished)
    expect(dispatch?.payload).toMatchObject({
      excerpt: '已经修好了',
      stopReason: 'max-steps',
      steps: 24,
      finishedAt: 456
    })
  })

  it('confirm：只挑通知用得上的字段，选项原样带上', () => {
    const confirm: AgentConfirmRequest = {
      id: 'confirm-1',
      requestId: 'req-1',
      toolCallId: 'tool-1',
      toolName: 'bash',
      command: 'rm -rf build',
      intent: '清理构建产物',
      options: [{ optionId: 'allow_once', name: '允许一次', kind: 'allow_once' }]
    }
    const dispatch = conversationHookDispatch(
      { type: 'conversation:confirm', ...base, confirm },
      workspace
    )
    expect(dispatch?.hook).toBe(HOOKS.conversationConfirm)
    expect(dispatch?.payload).toMatchObject({
      confirm: {
        id: 'confirm-1',
        toolName: 'bash',
        command: 'rm -rf build',
        intent: '清理构建产物',
        options: [{ optionId: 'allow_once', name: '允许一次', kind: 'allow_once' }]
      }
    })
    expect((dispatch?.payload as { confirm: Record<string, unknown> }).confirm.requestId).toBeUndefined()
  })

  it('followup：题目与选项都映射过去', () => {
    const followup: AskFollowupRequest = {
      id: 'follow-1',
      requestId: 'req-1',
      toolCallId: 'tool-2',
      title: '确认部署范围',
      questions: [
        {
          id: 'q1',
          question: '部署到哪个环境？',
          header: '环境',
          multiSelect: false,
          options: [{ label: '预发', description: '先验证' }, { label: '生产' }]
        }
      ]
    }
    const dispatch = conversationHookDispatch(
      { type: 'conversation:followup', ...base, followup },
      workspace
    )
    expect(dispatch?.hook).toBe(HOOKS.conversationFollowup)
    expect(dispatch?.payload).toMatchObject({
      followup: {
        id: 'follow-1',
        title: '确认部署范围',
        questions: [
          {
            id: 'q1',
            question: '部署到哪个环境？',
            header: '环境',
            multiSelect: false,
            options: [{ label: '预发', description: '先验证' }, { label: '生产' }]
          }
        ]
      }
    })
  })

  it('resolved 事件也映射；非会话事件一律返回 null', () => {
    const resolved = conversationHookDispatch(
      {
        type: 'conversation:confirm-resolved',
        ...base,
        confirmId: 'confirm-1',
        approved: true
      },
      workspace
    )
    expect(resolved?.hook).toBe(HOOKS.conversationConfirmResolved)

    const unrelated: ServerEvent = { type: 'backgroundTasks:changed' }
    expect(conversationHookDispatch(unrelated)).toBeNull()
  })

  it('没有工作区时不编造 workspaceId / workspacePath', () => {
    const dispatch = conversationHookDispatch(
      { type: 'conversation:started', ...base, startedAt: 1 },
      undefined
    )
    expect(dispatch?.workspaceId).toBe('')
    expect(dispatch?.workspacePath).toBeUndefined()
    expect((dispatch?.payload as { workspaceId?: string }).workspaceId).toBeUndefined()
  })
})
