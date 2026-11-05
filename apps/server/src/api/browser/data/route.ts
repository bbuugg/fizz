/**
 * 内置浏览器的**网站数据**（每个会话一份 profile）：GET、DELETE /api/browser/data。
 *
 * - `GET`    → `BrowserProfileUsage`（几个 profile、共占多少），设置页打开时读一次；
 * - `DELETE` → 清掉**所有会话**的网站数据：先关掉所有浏览器会话再删目录，回清完的快照。
 *
 * 为什么是「整份 profile」而不是「清缓存 / 清 Cookie」两颗按钮：内置浏览器没有全局
 * 池子，一个会话一份持久化 profile（`chromium.launchPersistentContext`），而 profile
 * 本身就是登录态 —— 拆开清只会让人以为「清了缓存但还登着」。日常场景（这个会话登错
 * 号了）走会话级那条 `DELETE /api/conversations/:id/browser-data`，这条是兜底。
 *
 * ⚠️ 与 `/api/browser/runtime` 分开两条路：运行时体积有缓存（`sizeCache`），而网站
 * 数据每次都得真扫目录；别为了少写一个文件把它们并进同一个响应，安装进度轮询
 * （1.5s 一次）会把几十个 Chromium profile 反复 walk 一遍。
 */
import { jsonError } from '@/app/api/_lib/auth'
import { browserDataSnapshot, clearAllBrowserData } from '@/lib/server/browser-runtime'

export async function GET(): Promise<Response> {
  return Response.json(browserDataSnapshot())
}

export async function DELETE(): Promise<Response> {
  try {
    return Response.json(await clearAllBrowserData())
  } catch (err) {
    return jsonError(500, err instanceof Error ? err.message : String(err))
  }
}
