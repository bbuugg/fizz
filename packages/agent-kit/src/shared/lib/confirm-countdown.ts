/**
 * 审批卡的倒计时文案。
 *
 * 输入是服务端下发的**绝对到期时刻**（`AgentConfirmRequest.expiresAt`），不是剩余秒数：
 * 审批卡会排队（`ConfirmQueue` 一屏一项），第 2、3 张如果按「收到时刻」重新计时，用户
 * 看到的时间会比服务端真实剩余时间长，卡甚至会在倒计时没走完时先消失。
 *
 * 超时为 0（一直等）时服务端**不下发** `expiresAt`，界面整行不渲染 —— 见 ConfirmCard。
 */

/** 剩余毫秒（已过期按 0，不返回负数） */
export function remainingMs(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now)
}

/**
 * `m:ss`，超过一小时用 `h:mm:ss`。
 *
 * 取 ceil 而不是 floor：剩 0.4 秒时显示 `0:01`。floor 会让最后不到一秒的卡提前显示
 * `0:00`，看起来像「已经该自动拒绝了却还杵着」。
 */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}
