/**
 * 手写的轮次消息队列：用于 `session/load`（v1）/ `session/resume`（v2）恢复出来的会话。
 *
 * SDK 的 `ActiveSession` 只挂在 `session/new` 上，恢复出来的会话没有它帮忙把
 * `session/update` 通知排进队列 —— 这里按 sessionId 自己路由，提供与 `AcpTurnSource`
 * 完全同形的 `prompt` / `nextUpdate` / `drainAll`，让 `acp.ts` 的轮次循环对「新建」
 * 与「恢复」两种来源通用。
 *
 * ⚠️ 「同形」包括**失败也走队列**：`prompt` 的 rejection 会被调用方吞掉，如果不在
 * 这里把错误推进队列，`nextUpdate()` 会永远挂着（界面一直「思考中」）。
 */
import type { AcpTurnMessage, AcpTurnSource } from './types'

/**
 * @param sessionId 这条来源对应的 agent 侧会话 id
 * @param send 发送一轮 prompt 的实现；resolve 出 stopReason 时由本类入队 stop，
 *   resolve 出 null 表示「完成信号走别处」（v2 的 idle state_update），由 adapter 调 `stop()`
 */
export class ManualTurnSource implements AcpTurnSource {
  private queue: AcpTurnMessage[] = []
  private waiters: Array<{
    resolve: (message: AcpTurnMessage) => void
    reject: (err: unknown) => void
  }> = []
  /** 还没有等待者的错误（agent 回 error 时轮次可能还没走到 nextUpdate） */
  private failure: unknown = null

  constructor(
    readonly sessionId: string,
    private readonly send: (blocks: unknown[]) => Promise<string | null>,
  ) {}

  /** 收到一条 session/update 通知 */
  handleUpdate(update: { sessionUpdate: string; [key: string]: unknown }): void {
    this.push({ kind: 'session_update', update })
  }

  /** 一轮结束（v2 的 idle state_update 走这里） */
  stop(stopReason: string): void {
    this.push({ kind: 'stop', stopReason })
  }

  fail(err: unknown): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.reject(err)
    else this.failure = err
  }

  drainAll(): AcpTurnMessage[] {
    const out = this.queue
    this.queue = []
    return out
  }

  async prompt(prompt: unknown[]): Promise<void> {
    // 新一轮开始：丢掉上一轮残留的错误
    this.failure = null
    try {
      const stopReason = await this.send(prompt)
      if (stopReason !== null) this.push({ kind: 'stop', stopReason })
    } catch (err) {
      this.fail(err)
      throw err
    }
  }

  async nextUpdate(): Promise<AcpTurnMessage> {
    const queued = this.queue.shift()
    if (queued) return queued
    if (this.failure !== null) {
      const err = this.failure
      this.failure = null
      throw err
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  private push(message: AcpTurnMessage): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(message)
    else this.queue.push(message)
  }
}
