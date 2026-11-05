/**
 * 清除**这一个会话**的网站数据：DELETE /api/conversations/:id/browser-data。
 *
 * 内置浏览器给每个会话一份持久化 profile（`<dataDir>/browser-profiles/<sessionId>`），
 * 里面是 Cookie / 登录态 / localStorage / IndexedDB / HTTP 缓存 —— 这份 profile 就是
 * 「这个会话的浏览器」。删掉它 = 关掉浏览器进程 + 删目录，**会话与历史消息不受影响**，
 * 下次启动浏览器要重新登录。
 *
 * 为什么走 HTTP 而不是复用 screencast 那条 WS：用户在「浏览器未启动」的空状态里也要能
 * 清（那时候 WS 早就关了，往死连接上 `send` 什么都不会发生）。HTTP 一条命令服务端
 * 直接干活，面板靠 `closed` 事件（reason「网站数据已清除」）自己切到未启动状态。
 *
 * 返回 204：清完没有可展示的新状态，占用数字由设置页那条全局 `GET /api/browser/data` 负责。
 */
import { agentBrowserSessionId } from '@fizz/contracts'
import { browserSessions } from '@fizz/tools'
import { domain } from '@/lib/server/state'
import { jsonError } from '@/app/api/_lib/auth'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  if (!domain.getConversation(id)) return jsonError(404, '会话不存在')
  /**
   * `purge` 内部先 `close` 再删目录 —— 顺序不能反（Windows 上被占着的 profile 删不干净，
   * 会留下半份坏数据）。失败也按成功回：目录里可能有一个杀不掉的子进程占着文件，
   * 用户再点一次多半就好了，这时候弹错误只会让人以为「清不掉」。
   */
  await browserSessions.purge(agentBrowserSessionId(id), '网站数据已清除').catch(() => undefined)
  return new Response(null, { status: 204 })
}
