/**
 * 内置浏览器的 **profile 落盘位置与清理**（一个会话一份）。
 *
 * 目录是 `<profilesRoot>/<sessionId 派生>`，由 `chromium.launchPersistentContext` 直接
 * 写盘（见 `engine.ts` 的 `launch()`）。里面是 Cookie / 登录态 / localStorage / IndexedDB /
 * HTTP 缓存 —— 也就是「这个会话登过哪些站、下轮还能不能免密进去」。
 *
 * 本文件**不 import playwright**：目录派生、占用统计、删除这三件事与浏览器进程无关，
 * 拆出来才可被纯 Node 测试直接跑（`profiles.test.ts`）。引擎只负责起 / 停进程。
 *
 * ⚠️ **删目录前必须先关进程**（`BrowserSessionManager.purge` / `purgeAllBrowserProfiles`
 * 就是这么做的）：Windows 上正在被写的 profile 文件删不掉，`rm` 只成功一半，
 * 留下半份坏 profile —— 下次启动读到它比没登录更难查。
 *
 * ⚠️ 目录名是 `sessionId` 把非 `[a-zA-Z0-9._-]` 一律换成 `-`（会话 id 是 UUID，
 * `agent-browser:<uuid>` 里的 `:` 就是靠这条换掉的）。改这条规则 = 所有存量 profile
 * 全部失联（用户表现为「所有会话都被登出了」），别动。
 */
import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserProfileUsage } from '@fizz/contracts'
import { directorySize } from '../dir-size'

/** profile 根目录；null = 没注入（此时引擎退化成临时上下文，登录态不落盘） */
let profilesRoot: string | null = null

/**
 * 注入 profile 根目录。后端启动时经 `configureBrowser` 给一次。
 *
 * 没注入时（纯 Node 脚本 / 极端部署）引擎用临时上下文：会话一关登录态即失，也不落盘，
 * 于是本模块的清单与统计恒为空 —— 这是「没有数据」，不是「读失败」。
 */
export function setBrowserProfilesRoot(dir: string | null): void {
  profilesRoot = dir
}

export function browserProfilesRoot(): string | null {
  return profilesRoot
}

/** 某会话的 profile 目录；没注入根目录时 null（= 不落盘） */
export function browserProfileDirOf(sessionId: string): string | null {
  if (!profilesRoot) return null
  return join(profilesRoot, sessionId.replace(/[^a-zA-Z0-9._-]/g, '-'))
}

/**
 * 磁盘上**实际存在**的 profile 目录。
 *
 * 刻意不按会话清单反推：历史版本删会话时没扫 profile（残留还在盘上），按清单算就
 * 永远发现不了它们。统计与「全部清除」都以磁盘为准。
 */
export function browserProfileDirs(): string[] {
  if (!profilesRoot || !existsSync(profilesRoot)) return []
  try {
    return readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(profilesRoot as string, String(entry.name)))
  } catch {
    return []
  }
}

/** 网站数据占用：几个 profile、共占多少字节 */
export function browserProfileUsage(): BrowserProfileUsage {
  const dirs = browserProfileDirs()
  let sizeBytes = 0
  for (const dir of dirs) sizeBytes += directorySize(dir)
  return { count: dirs.length, sizeBytes }
}

/**
 * 删一个 profile 目录（失败不抛：Windows 上偶尔有杀不掉的子进程占着文件）。
 *
 * 调用方**必须先把对应浏览器关掉**（见文件头）。失败也不该让「清除网站数据」整体报错 ——
 * 用户要的是「尽量清掉」，剩一份残留由下次「全部清除」兜住。
 */
export async function removeBrowserProfileDir(dir: string | null): Promise<void> {
  if (!dir) return
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}
