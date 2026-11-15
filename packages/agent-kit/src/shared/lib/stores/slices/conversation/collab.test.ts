/**
 * 协作事件折叠的回归守卫。
 *
 * 重点盯「实时工具卡」：`collab-tool` 事件必须当场变成一张 part，否则右侧面板在整个
 * 任务期间只有流式正文，工具过程要等任务收口才「啪」地补出来 —— 用户以为子 Agent
 * 什么都没干。另外要盯住收口时清掉实时现场，否则快照和实时两份会叠着渲染。
 */
import { describe, expect, it } from 'vitest'
import type { CollabTask } from '@fizz/contracts/types'
import { applyCollabEvent } from './collab'
import type { CollabClientState } from './types'

function emptyState(): CollabClientState {
  return {
    state: { version: 1, tasks: [], messages: [], statuses: {}, updatedAt: 0 },
    liveText: {},
    liveParts: {},
  }
}

const doneTask: CollabTask = {
  id: 't1',
  agentId: 'a1',
  agentName: 'A',
  from: 'main',
  prompt: '查一下',
  status: 'done',
  createdAt: 1,
  parts: [{ type: 'text', text: '结论' }],
}

describe('applyCollabEvent', () => {
  it('工具一开始就落一张卡，不等任务跑完', () => {
    const next = applyCollabEvent(emptyState(), {
      type: 'collab-tool',
      agentId: 'a1',
      taskId: 't1',
      toolCallId: 'c1',
      toolName: 'read',
      phase: 'start',
      label: 'a.ts',
      input: '{"file_path":"a.ts"}',
    })
    // 入参会被还原成对象：卡片抬头的明细（toolDetailOf）只认 file_path / command 这些键
    expect(next.liveParts.a1).toEqual([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { file_path: 'a.ts' } },
    ])
  })

  it('入参被截断成半截 JSON 时保留原文，不丢整张卡', () => {
    const next = applyCollabEvent(emptyState(), {
      type: 'collab-tool',
      agentId: 'a1',
      toolCallId: 'c2',
      toolName: 'write',
      phase: 'start',
      input: '{"file_path":"a.ts","content":"半截',
    })
    expect(next.liveParts.a1?.[0]).toMatchObject({
      toolName: 'write',
      input: '{"file_path":"a.ts","content":"半截',
    })
  })

  it('工具结束时结果折进同一张卡，失败带 isError', () => {
    let state = applyCollabEvent(emptyState(), {
      type: 'collab-tool',
      agentId: 'a1',
      toolCallId: 'c1',
      toolName: 'bash',
      phase: 'start',
      input: '{"command":"pnpm test"}',
    })
    state = applyCollabEvent(state, {
      type: 'collab-tool',
      agentId: 'a1',
      toolCallId: 'c1',
      toolName: 'bash',
      phase: 'end',
      ok: false,
      output: 'boom',
    })
    const parts = state.liveParts.a1 ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ output: 'boom', isError: true })
  })

  it('正文与工具卡按发生顺序交错（不是卡片全堆在正文前面）', () => {
    let state = applyCollabEvent(emptyState(), {
      type: 'collab-delta',
      agentId: 'a1',
      channel: 'text',
      delta: '我先看看仓库',
    })
    state = applyCollabEvent(state, {
      type: 'collab-tool',
      agentId: 'a1',
      toolCallId: 'c1',
      toolName: 'read',
      phase: 'start',
      input: '{"file_path":"a.ts"}',
    })
    state = applyCollabEvent(state, {
      type: 'collab-delta',
      agentId: 'a1',
      channel: 'text',
      delta: '结论是……',
    })
    expect((state.liveParts.a1 ?? []).map((part) => part.type)).toEqual([
      'text',
      'tool-call',
      'text',
    ])
  })

  it('任务收口后清空实时现场，交给快照里的 parts', () => {
    let state = applyCollabEvent(emptyState(), {
      type: 'collab-tool',
      agentId: 'a1',
      toolCallId: 'c1',
      toolName: 'read',
      phase: 'start',
      input: 'a.ts',
    })
    state = applyCollabEvent(state, { type: 'collab-task', task: doneTask })
    expect(state.liveParts.a1).toBeUndefined()
    expect(state.state.tasks[0]?.parts).toEqual([{ type: 'text', text: '结论' }])
  })

  it('缺 liveParts 的旧现场不会炸（升级瞬间的 store 还带着上一版形状）', () => {
    const legacy = { ...emptyState(), liveParts: undefined } as unknown as CollabClientState
    const next = applyCollabEvent(legacy, {
      type: 'collab-delta',
      agentId: 'a1',
      channel: 'text',
      delta: 'hi',
    })
    expect(next.liveParts.a1).toEqual([{ type: 'text', text: 'hi' }])
  })
})
