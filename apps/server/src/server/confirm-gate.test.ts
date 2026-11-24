/**
 * 审批挂起期间的那颗「停止」钮。
 *
 * 工具卡头部的停止钮在「入参定型 + 还没有结果」时就会画出来
 * （`packages/agent-kit/src/shared/lib/parts.ts` 的 `isStoppableToolRunning`），而
 * 「等审批」正好长这样 —— 但命令还没起跑，工具也就还没往 `run.commandStops` 里登记
 * 自己的停止。这两条用例防的就是「点了没反应」（路由查表查不到，回 `{ stopped: false }`），
 * 以及修这件事时把容器一轮原有的停止转发器盖掉。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@fizz/i18n'
import type { ChatRun } from './chat-run'

afterEach(() => setLanguage('zh'))

// 真实的 state 会在 import 时初始化状态目录；这里只需要那两张表
vi.mock('./state', () => ({
  pendingConfirms: new Map(),
  chatRuns: {
    runs: new Map(),
    activeByConversation: new Map(),
    startingByConversation: new Set(),
    doneResolves: new Map()
  }
}))

const { createConfirmGate, releaseConfirmsFor } = await import('./confirm-gate')
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

interface ConfirmFrame {
  type: string
  approved?: boolean
  confirm?: {
    id: string
    options?: Array<{ optionId: string; name: string; kind: string }>
  }
}

function framesOf(run: ChatRun): ConfirmFrame[] {
  return run.frames as unknown as ConfirmFrame[]
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
      toolName: 'bash',
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
      toolName: 'bash',
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

/**
 * 运行中把权限档切到「完全访问」（`POST /api/chat/permission`）：已经挂在屏幕上的
 * 审批自动按批准收场。闸门挂起后不再看档位，路由不主动结算的话，用户刚表态
 * 「别再逐条问我」，桌面上那张卡却还杵着等点击。
 *
 * 防两条：只放行目标 run（多标签 / 父子 run 同时挂审批时不能误批别人的），
 * 以及放行必须走 settle（要发 confirm-resolved，前端才撤得掉卡）。
 */
describe('切到完全访问时自动批准挂起审批', () => {
  it('只放行该 run 挂起的审批，并按批准收场', async () => {
    const runA = makeRun()
    const runB = makeRun()
    runB.requestId = 'req-other'
    const gateA = createConfirmGate({
      run: runA,
      ownerKey: 'approve-a',
      title: '会话 A',
      confirmTimeoutMs: 0
    })
    const gateB = createConfirmGate({
      run: runB,
      ownerKey: 'approve-b',
      title: '会话 B',
      confirmTimeoutMs: 0
    })
    const pendingA = gateA.requestConfirm({ toolCallId: 'tc-a', toolName: 'bash', command: 'echo a' })
    const pendingB = gateB.requestConfirm({ toolCallId: 'tc-b', toolName: 'bash', command: 'echo b' })

    releaseConfirmsFor(runA.requestId, true)

    await expect(pendingA).resolves.toBe(true)
    expect(framesOf(runA).some((f) => f.type === 'confirm-resolved' && f.approved === true)).toBe(true)
    // 挂起期间占的停止位跟着撤掉，留着会让人以为命令还在等
    expect(runA.commandStops.has('tc-a')).toBe(false)

    // 另一条 run 的审批不受影响：还挂着，等它自己的答复
    expect(pendingConfirms.size).toBe(1)
    expect(framesOf(runB).some((f) => f.type === 'confirm-resolved')).toBe(false)
    const confirmB = framesOf(runB).find((f) => f.type === 'confirm')?.confirm?.id
    pendingConfirms.get(confirmB as string)?.resolve({ approved: false })
    await expect(pendingB).resolves.toBe(false)
  })
})

/**
 * 内置选项的文案：`name` 是我们自己写的中文源文案，必须在**下发那一刻**按界面
 * 语言翻译。以前直接下发 `BUILTIN_CONFIRM_OPTIONS` 的原文，英文界面里审批卡上
 * 四行选项全露中文。防的是两条：忘了翻译、以及在模块顶层翻译（切语言后失效）。
 */
describe('内置审批选项的文案', () => {
  it('英文界面：选项名翻译，optionId / kind 原样', async () => {
    setLanguage('en')
    const run = makeRun()
    const gate = createConfirmGate({
      run,
      ownerKey: 'options-en',
      title: '测试会话',
      confirmTimeoutMs: 0
    })
    const pending = gate.requestConfirm({
      toolCallId: 'tc-3',
      toolName: 'bash',
      command: 'rm -rf dist'
    })

    const frame = framesOf(run).find((f) => f.type === 'confirm')
    const options = frame?.confirm?.options ?? []
    expect(options.map((option) => option.name)).toEqual([
      'Allow once',
      'Always allow this command',
      'Deny once',
      'Always deny this command'
    ])
    // 回传给服务端的键不能跟着翻译（`requestConfirm` 按 optionId 认「始终」）
    expect(options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always'
    ])

    const id = frame?.confirm?.id
    pendingConfirms.get(id as string)?.resolve({ approved: false })
    await expect(pending).resolves.toBe(false)
  })
})

/**
 * 沙箱提权卡：**只有一次性选项，且不写任何「始终」记忆**。
 *
 * 用户在一张提权卡上批准的是「这一次越界写入」，不是「这条命令以后都能绕过沙箱」。
 * 一旦把命令记进白名单，同一条命令下次连卡都不弹 —— 等于把沙箱关掉一半。
 */
describe('沙箱提权是一次性决定', () => {
  it('只给一次性选项，连续两次申请都要重新弹卡', async () => {
    const run = makeRun()
    const gate = createConfirmGate({
      run,
      ownerKey: 'sandbox-escalation',
      title: '测试会话',
      confirmTimeoutMs: 0
    })
    const req = {
      toolCallId: 'tc-esc',
      toolName: 'bash',
      command: 'echo x > /etc/fizz',
      sandboxRequestedMode: 'danger-full-access' as const,
      sandboxJustification: '需要写入系统配置目录'
    }

    const first = gate.requestConfirm(req)
    const firstFrame = framesOf(run).find((f) => f.type === 'confirm')
    // 没有「始终允许 / 始终拒绝」：提权只对这一次生效
    expect(firstFrame?.confirm?.options?.map((option) => option.optionId)).toEqual([
      'allow_once',
      'reject_once'
    ])
    pendingConfirms.get(firstFrame?.confirm?.id as string)?.resolve({
      approved: true,
      optionId: 'allow_once'
    })
    await expect(first).resolves.toBe(true)

    // 第二次同样要弹卡（上一张的批准没有被记住）
    const second = gate.requestConfirm(req)
    const frames = framesOf(run).filter((f) => f.type === 'confirm')
    expect(frames).toHaveLength(2)
    pendingConfirms.get(frames[1]?.confirm?.id as string)?.resolve({
      approved: false,
      optionId: 'reject_once'
    })
    await expect(second).resolves.toBe(false)
  })
})

/**
 * 审批超时的倒计时依据。
 *
 * 下发的是**绝对到期时刻**而不是剩余秒数：审批卡会排队（`ConfirmQueue` 一屏一项），
 * 第 2、3 张按「收到时刻」重新计时会比服务端真实剩余时间长，卡会在倒计时没走完时先消失。
 * 超时为 0（一直等）时必须**不带**这个字段，前端据此整行不渲染。
 */
describe('审批超时的到期时刻', () => {
  it('超时 > 0 时下发 expiresAt', async () => {
    const run = makeRun()
    const gate = createConfirmGate({
      run,
      ownerKey: 'timeout-on',
      title: '测试会话',
      confirmTimeoutMs: 60_000
    })
    const before = Date.now()
    const pending = gate.requestConfirm({ toolCallId: 'tc-t', toolName: 'bash', command: 'echo t' })
    const confirm = framesOf(run).find((f) => f.type === 'confirm')?.confirm as
      | { id: string; expiresAt?: number }
      | undefined
    expect(confirm?.expiresAt).toBeTypeOf('number')
    expect(confirm?.expiresAt as number).toBeGreaterThanOrEqual(before + 59_000)
    expect(confirm?.expiresAt as number).toBeLessThanOrEqual(Date.now() + 60_000)

    pendingConfirms.get(confirm?.id as string)?.resolve({ approved: false })
    await expect(pending).resolves.toBe(false)
  })

  it('超时为 0（一直等）时不带该字段', async () => {
    const run = makeRun()
    const gate = createConfirmGate({
      run,
      ownerKey: 'timeout-off',
      title: '测试会话',
      confirmTimeoutMs: 0
    })
    const pending = gate.requestConfirm({ toolCallId: 'tc-t2', toolName: 'bash', command: 'echo t' })
    const confirm = framesOf(run).find((f) => f.type === 'confirm')?.confirm
    expect(confirm).not.toHaveProperty('expiresAt')

    pendingConfirms.get((confirm as { id: string }).id)?.resolve({ approved: false })
    await expect(pending).resolves.toBe(false)
  })
})
