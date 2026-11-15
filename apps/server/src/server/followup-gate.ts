/**
 * 提问（`ask`）的挂起 / 答复工厂 —— 聊天与容器型项目共用一份。
 *
 * 与 `confirm-gate.ts` 同一个理由：现在有两个入口需要这条反向通道（本地一轮
 * `chat-turn.ts`、容器内一轮 `container-projects/turn.ts`），各写一遍必然漂 ——
 * 帧的形状、广播给别的标签页的瞬时事件、释放时机（收尾 / abort）三处都得对齐，
 * 漏一处就是「卡片弹了但答复石沉大海」或者「一轮永远不收尾」。
 *
 * ⚠️ 谁调用 `requestFollowup`，谁就必须在收尾与 abort 两条路上调 `releaseAll()`：
 * 挂着的 Promise 不 settle，那一轮就永远停在等答复上（`pendingFollowups` 是全局表，
 * 按 requestId 释放，见 `releaseFollowupsFor`）。
 */
import { randomUUID } from 'node:crypto'
import type { AskFollowupAnswer, AskFollowupRequest } from '@fizz/contracts/types'
import { emit, type ChatRun } from './chat-run'
import { emitServerEvent, pendingFollowups } from './state'

/** 按 requestId 释放挂着的提问（答复缺失一律按 `null` = 跳过收场），幂等 */
export function releaseFollowupsFor(requestId: string): void {
  for (const [id, entry] of [...pendingFollowups]) {
    if (entry.requestId !== requestId) continue
    pendingFollowups.delete(id)
    entry.resolve(null)
  }
}

export interface FollowupGate {
  /** 推 `ask-followup` 帧 + 广播，等用户答复（跳过 / 超时 / run 结束一律 `null`） */
  requestFollowup(req: Omit<AskFollowupRequest, 'id'>): Promise<AskFollowupAnswer | null>
  /** 收尾 / abort 时调用：把这条 run 挂着的提问全部按「跳过」放行 */
  releaseAll(): void
  /**
   * 这一轮是不是被中断了（abort）。`ask` 返回 `null` 时工具靠它区分
   * 「用户点了跳过」与「根本没等到答复」—— 后者前端会渲染成可补答的卡。
   */
  interrupted(): boolean
}

export function createFollowupGate(input: {
  run: ChatRun
  /** 广播事件里的会话坐标（`conversation:followup` 通知要用它定位会话） */
  conversationId: string
  /** 广播用的会话标题（首轮自动标题已算进去，不要用读会话时的快照） */
  title: string
}): FollowupGate {
  const { run, conversationId, title } = input
  const requestId = run.requestId

  const requestFollowup = (req: Omit<AskFollowupRequest, 'id'>): Promise<AskFollowupAnswer | null> => {
    const id = randomUUID()
    const followup: AskFollowupRequest = { id, ...req }
    emit(run, { type: 'ask-followup', requestId, followup })
    emitServerEvent({
      type: 'conversation:followup',
      conversationId,
      requestId,
      title,
      followup
    })
    return new Promise<AskFollowupAnswer | null>((resolve) => {
      let settled = false
      const settle = (answer: AskFollowupAnswer | null): void => {
        if (settled) return
        settled = true
        pendingFollowups.delete(id)
        emit(run, {
          type: 'ask-followup-resolved',
          requestId,
          followupId: id,
          toolCallId: followup.toolCallId
        })
        emitServerEvent({
          type: 'conversation:followup-resolved',
          conversationId,
          requestId,
          title,
          followupId: id,
          toolCallId: followup.toolCallId
        })
        resolve(answer)
      }
      pendingFollowups.set(id, { requestId, resolve: settle })
    })
  }

  return {
    requestFollowup,
    releaseAll: () => releaseFollowupsFor(requestId),
    // 判据用 run 自己的 signal：abort 时 `releaseAll` 会先把挂着的提问按 null 放行，
    // 工具随即读这个值决定「是不是用户主动跳过」
    interrupted: () => run.controller.signal.aborted
  }
}
