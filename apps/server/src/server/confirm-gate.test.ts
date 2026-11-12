/**
 * 审批挂起期间的那颗「停止」钮。
 *
 * 工具卡头部的停止钮在「入参定型 + 还没有结果」时就会画出来
 * （`packages/agent-kit/src/shared/lib/parts.ts` 的 `isStoppableToolRunning`），而
 * 「等审批」正好长这样 —— 但命令还没起跑，工具也就还没往 `run.commandStops` 里登记
 * 自己的停止。这两条用例防的就是「点了没反应」（路由查表查不到，回 `{ stopped: false }`），
 * 以及修这件事时把容器一轮原有的停止转发器盖掉。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatRun } from './chat-run'

// 真实的 state 会在 import 时初始化状态目录；这里只需要那两张表
vi.mock('./state', () => ({
  pendingConfirms: new Map(),
  chatRuns: { runs: new Map(), activeByConversation: new Map(), doneResolves: new Map() }
}))

const { createConfirmGate } = await import('./confirm-gate')
const { pendingConfirms } = (await import('./state')) as unknown as {
  pendingConfirms: Map<string, { resolve: (reply: { approved: boolean; optionId?: string }) => void }>
}

function makeRun(): ChatRun {
  return {
    requestId: 'req-gate',
    commandStops: new Map<string, () => void>(),
    frames: [],
    subscribers: new Set(),
    controller: new AbortController()
  } as unknown as ChatRun
}

function framesOf(run: ChatRun): Array<{ type: string; approved?: boolean; confirm?: { id: string } }> {
  return run.frames as unknown as Array<{ type: string; approved?: boolean; confirm?: { id: string } }>
}

describe('审批挂起期间的停止钮', () => {
  it('按「别跑了」收场：决议为拒绝，并把占位撤掉', async () => {
    const run = makeRun()
    const gate = createConfirmGate({
      run,
      ownerKey: 'stop-while-pending',
      title: '测试会话',
      confirmTimeoutMs: 0
    })

    const pending = gate.requestConfirm({
      toolCallId: 'tc-1',
      toolName: 'execute_command',
      command: 'npm test',
      intent: '跑一下单测'
    })

    // 命令没起跑，但停止位必须已经在表里（否则路由停不到）
    const stop = run.commandStops.get('tc-1')
    expect(stop).toBeTypeOf('function')

    stop?.()

    await expect(pending).resolves.toBe(false)
    expect(run.commandStops.has('tc-1')).toBe(false)
    expect(framesOf(run).some((f) => f.type === 'confirm-resolved' && f.approved === false)).toBe(true)
  })

  it('容器一轮：结案后把原来的停止转发器放回去', async () => {
    const run = makeRun()
    // 容器在发 tool-call 时就登记好了转发器，审批帧在那之后才来
    const forward = vi.fn()
    run.commandStops.set('tc-2', forward)

    const gate = createConfirmGate({
      run,
      ownerKey: 'restore-forwarder',
      title: '测试会话',
      confirmTimeoutMs: 0
    })
    const pending = gate.requestConfirm({
      toolCallId: 'tc-2',
      toolName: 'execute_command',
      command: 'npm run build'
    })

    // 挂起期间被换成「按拒绝答复」，点停止才有反应
    expect(run.commandStops.get('tc-2')).not.toBe(forward)

    const confirmId = framesOf(run).find((f) => f.type === 'confirm')?.confirm?.id
    expect(confirmId).toBeTypeOf('string')
    pendingConfirms.get(confirmId as string)?.resolve({ approved: true })
    await expect(pending).resolves.toBe(true)

    // 批完还得能停：转发器原样回去
    expect(run.commandStops.get('tc-2')).toBe(forward)
  })
})
