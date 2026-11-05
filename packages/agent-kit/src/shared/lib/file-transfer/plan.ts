/**
 * 传输引擎的纯函数：分片计划 + 速度采样。
 *
 * ⚠️ **本文件必须零 import**。它被 `scripts/verify-sftp-chunked.mjs` 用 jiti 直跑，
 * 一旦 import 了 `@fizz/agent-client/host`（那会在模块求值期读 `window`）或任何带副作用的模块，测试就
 * 跑不起来 —— 而这正是本改造唯一会「静默出错」的地方，不能没有测试。
 */

export interface ChunkPlanItem {
  index: number
  start: number
  /** 结束偏移，**不含**（`slice(start, end)` 语义） */
  end: number
}

/**
 * 把 `size` 字节切成 `chunkBytes` 一片。
 *
 * 两条边界都是踩过的坑：
 * - **`size === 0` 必须发一片空片**（而不是发 0 片）：服务端的 `index === 0` 那一支走
 *   `'w'` **创建**文件，一片都不发的话远端根本不会出现这个文件 —— 用户上传了一个 0 字节
 *   文件，界面上却「成功」了，远端什么都没有。
 * - **正好整除时不多发空尾片**：`size = 8, chunk = 4` 只发 2 片。多发的空片虽然内容无害
 *   （追加 0 字节），但会让进度条在 100% 上再跳一次，也白跑一趟网络。
 */
export function planUploadChunks(size: number, chunkBytes: number): ChunkPlanItem[] {
  if (size <= 0) return [{ index: 0, start: 0, end: 0 }]
  const plan: ChunkPlanItem[] = []
  for (let start = 0; start < size; start += chunkBytes) {
    plan.push({ index: plan.length, start, end: Math.min(start + chunkBytes, size) })
  }
  return plan
}

/**
 * 速度采样（字节/秒）。
 *
 * `deltaMs <= 0` 原样返回：`performance.now()` 在同一毫秒里被连问两次是完全正常的，
 * 拿它做除数会得到 `Infinity` 或 `NaN`，那个数字会一路显示到徽标清单上。
 *
 * 首次采样（`prev <= 0`）直接取瞬时值 —— 没有历史可平滑，硬套 EWMA 只会从 0 慢慢爬。
 * 之后用 EWMA（0.7 旧 / 0.3 新）：纯瞬时值在分片大小不齐时会来回跳，纯平均又反应太慢。
 */
export function nextSpeed(prev: number, deltaBytes: number, deltaMs: number): number {
  if (deltaMs <= 0) return prev
  const instant = (deltaBytes * 1000) / deltaMs
  if (prev <= 0) return instant
  return prev * 0.7 + instant * 0.3
}
