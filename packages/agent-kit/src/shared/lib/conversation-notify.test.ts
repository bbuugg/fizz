/**
 * `conversation-notify.ts` 的回归用例。
 *
 * 钉住两条东西：
 * 1. **「用户正看着这一屏」= `alreadyInView`**：审批 / 提问 / 跑完三条分支**都要带**。
 *    曾经只有「跑完」带 —— 用户盯着确认卡 / 提问卡，右上角照样飘一条 toast。
 * 2. 只有「审批 / 提问 / 跑完」发通知：`*-resolved`、预览文件变化、后台任务清单都不发。
 */
import { describe, expect, it } from 'vitest'
import type {
  ConversationConfirmEvent,
  ConversationFinishedEvent,
  ConversationFollowupEvent,
  ServerEvent
} from '@fizz/contracts/types'
import {
  conversationNotify,
  isConversationNotifyEvent
} from './conversation-notify'

const CONV = 'conv-1'

function confirmEvent(
  confirm: Partial<ConversationConfirmEvent['confirm']> = {}
): ConversationConfirmEvent {
  return {
    type: 'conversation:confirm',
    conversationId: CONV,
    requestId: 'req-1',
    title: '会话一',
    confirm: {
      id: 'confirm-1',
      requestId: 'req-1',
      toolCallId: 'tool-1',
      toolName: 'bash',
      command: 'rm -rf build',
      ...confirm
    }
  }
}

function followupEvent(
  followup: Partial<ConversationFollowupEvent['followup']> = {}
): ConversationFollowupEvent {
  return {
    type: 'conversation:followup',
    conversationId: CONV,
    requestId: 'req-1',
    title: '会话一',
    followup: {
      id: 'followup-1',
      requestId: 'req-1',
      toolCallId: 'tool-1',
      title: '确认一下',
      questions: [
        { id: 'q1', question: '要覆盖还是跳过？', header: '选择', options: [], multiSelect: false }
      ],
      ...followup
    }
  }
}

function finishedEvent(
  overrides: Partial<ConversationFinishedEvent> = {}
): ConversationFinishedEvent {
  return {
    type: 'conversation:finished',
    conversationId: CONV,
    requestId: 'req-1',
    title: '会话一',
    finishReason: 'done',
    excerpt: '改好了',
    finishedAt: 1,
    ...overrides
  }
}

describe('conversationNotify · 用户正看着这一屏', () => {
  // 这三条是本文件的核心：三条分支必须都由同一个判据决定 alreadyInView
  it.each([
    ['审批', confirmEvent()],
    ['提问', followupEvent()],
    ['跑完', finishedEvent()]
  ] as const)('%s：当前会话就是它 → alreadyInView = true', (_label, event) => {
    expect(conversationNotify(event, CONV).options.alreadyInView).toBe(true)
  })

  it.each([
    ['审批', confirmEvent()],
    ['提问', followupEvent()],
    ['跑完', finishedEvent()]
  ] as const)('%s：停在别处 / 没开任何会话 → alreadyInView = false', (_label, event) => {
    expect(conversationNotify(event, 'conv-2').options.alreadyInView).toBe(false)
    expect(conversationNotify(event, null).options.alreadyInView).toBe(false)
  })
})

describe('conversationNotify · 内容与 tag', () => {
  it('审批优先给命令，没有命令退回工具名', () => {
    expect(conversationNotify(confirmEvent(), null).options.body).toBe('等待你确认：rm -rf build')
    const noCommand = confirmEvent({ command: '   ', toolName: 'bash' })
    expect(conversationNotify(noCommand, null).options.body).toBe('等待你确认：bash')
  })

  it('提问取第一题的问题文本，没题就退回表单标题', () => {
    expect(conversationNotify(followupEvent(), null).options.body).toBe(
      'AI 有一个问题待回答：要覆盖还是跳过？'
    )
    const none = followupEvent({ questions: [] })
    expect(conversationNotify(none, null).options.body).toBe(
      'AI 有一个问题待回答：确认一下'
    )
  })

  it('跑完按 finishReason 给正文', () => {
    expect(conversationNotify(finishedEvent(), null).options.body).toBe('改好了')
    expect(
      conversationNotify(finishedEvent({ finishReason: 'aborted', excerpt: undefined }), null)
        .options.body
    ).toBe('已停止')
    expect(
      conversationNotify(finishedEvent({ finishReason: 'error', error: '网关超时' }), null)
        .options.body
    ).toBe('出错：网关超时')
  })

  it('三类事件的 tag 互不相同，且带上会话 id（同 tag 会互相顶掉）', () => {
    const tags = [
      conversationNotify(confirmEvent(), null).options.tag,
      conversationNotify(followupEvent(), null).options.tag,
      conversationNotify(finishedEvent(), null).options.tag
    ]
    expect(new Set(tags).size).toBe(3)
    for (const tag of tags) expect(tag).toContain(CONV)
  })

  it('把会话 id 带出来给「查看」用', () => {
    expect(conversationNotify(confirmEvent(), null).conversationId).toBe(CONV)
  })
})

describe('isConversationNotifyEvent', () => {
  it('审批 / 提问 / 跑完放行', () => {
    expect(isConversationNotifyEvent(confirmEvent())).toBe(true)
    expect(isConversationNotifyEvent(followupEvent())).toBe(true)
    expect(isConversationNotifyEvent(finishedEvent())).toBe(true)
  })

  it('答复类与别的域事件一律不发通知', () => {
    const resolved = {
      type: 'conversation:confirm-resolved',
      conversationId: CONV,
      requestId: 'req-1',
      title: '会话一',
      confirmId: 'confirm-1',
      approved: true
    } as unknown as ServerEvent
    const followupResolved = {
      type: 'conversation:followup-resolved',
      conversationId: CONV,
      requestId: 'req-1',
      title: '会话一',
      followupId: 'followup-1',
      toolCallId: 'tool-1'
    } as unknown as ServerEvent
    const filesChanged = { type: 'container:files-changed' } as unknown as ServerEvent
    const tasksChanged = { type: 'backgroundTasks:changed' } as unknown as ServerEvent

    for (const event of [resolved, followupResolved, filesChanged, tasksChanged]) {
      expect(isConversationNotifyEvent(event)).toBe(false)
    }
  })
})
