/**
 * 单个会话：获取（含完整消息历史）/ 删除 / 重命名。
 *
 * PATCH /api/conversations/:id     → 重命名（body: { title }）
 * PATCH /api/conversations/:id/target → 设置/清除会话记住的模型（在 target/route.ts 里）
 */
import type { ConversationRenameInput } from '@fizz/contracts/agent-api'
import { agentBrowserSessionId } from '@fizz/contracts'
import { browserSessions } from '@fizz/tools'
import { domain } from '@/lib/server/state'
import { stopSessionRunning } from '@/lib/server/background-tasks'
import { stopConversationRun } from '@/lib/server/chat-run'
import { forgetAcpTranscript } from '@/lib/server/acp-transcripts'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const conversation = domain.getConversation(id)
  if (!conversation) return jsonError(404, '会话不存在')
  return Response.json(conversation)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // 先停掉正在跑的这一轮对话：工具还在跑、命令进程还占着端口的话，删完就再也没人能停它们；
  // 等它收尾（有超时兜底）再删，避免收尾落盘撞上「会话不存在」。
  await stopConversationRun(id)
  // 再停这个会话名下的后台命令：进程属于会话，会话没了就再没有能显示它的容器。
  // 只发信号不等收场（删除不该被一条杀不掉的进程拖住），任务体自己尽快收尾。
  stopSessionRunning(id)
  domain.deleteConversation(id)
  forgetAcpTranscript(id)
  /**
   * 这个会话的浏览器 profile 跟着删（Cookie / 登录态 / localStorage / HTTP 缓存都在
   * `<dataDir>/browser-profiles/<sessionId>` 里）。
   *
   * 以前这里只删领域数据，`purge()` 全仓没人调 —— 每删一个会话就永久留下**一份还带着
   * 登录状态的磁盘数据**，谁的、什么时候的都没人知道。必须在删会话的同一条路上清掉，
   * 否则只有设置页那颗「全部清除」能兜住。
   *
   * `purge` 内部先关进程再删目录（Windows 上被占着的文件删不干净）；失败只留残留，
   * 不阻断删除本身 —— 会话已经从列表里没了，这时候报 500 只会让界面显示一个幽灵条目。
   */
  await browserSessions.purge(agentBrowserSessionId(id), '会话已删除').catch(() => undefined)
  return Response.json(domain.listConversations())
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<ConversationRenameInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  if (typeof body?.title !== 'string' || !body.title.trim()) {
    return jsonError(400, '缺少 title')
  }
  try {
    domain.renameConversation(id, body.title)
    return Response.json(domain.listConversations())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
