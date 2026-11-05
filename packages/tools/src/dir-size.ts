/**
 * 递归统计目录占用（不跟随符号链接；读不了的文件跳过，不让统计失败拖垮接口）。
 *
 * 两处在用：设置页「浏览器」里的运行时体积（`playwright-browsers.ts`，约 150MB 那份
 * headless shell）与**每个会话的网站数据**体积（`browser/profiles.ts`）。别在各自的
 * 文件里再抄一份 —— 统计口径（目录项算不算、读不到时算多少）必须一致，否则同一页上
 * 两个数字看起来会互相打架。
 */
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export function directorySize(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, String(entry.name))
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          /* 统计不到就少算，不影响「占了多少」的量级 */
        }
      }
    }
  }
  return total
}
