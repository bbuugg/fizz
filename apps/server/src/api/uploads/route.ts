/**
 * 上传对话附件：POST /api/uploads
 *
 * 协议刻意是 **JSON + base64** 而不是 multipart：desktop 的 IPC 桥 body 只支持字符串
 * （`packages/agent-host/src/channels.ts` 的 `AgentTransportRequest.body?: string`），
 * 两端走同一条协议才不用做两套上传。10MB 文件 base64 后 ~13.7MB，一次性传输成本。
 *
 * **这次上传落到哪儿**由请求体的 `provider` 决定（缺省 = 内置存储 `local`）：
 * 内置走 `server/upload/local.ts`（数据目录 + `/api/uploads/<name>`），插件注册的上传源
 * 走 `server/upload/registry.ts`（长驻 context，见那里的说明）。请求里可以带 `workspaceId`，
 * 带了我这个项目的插件也能提供上传源；不带就只有**全局（用户级）插件**那一份可用。
 *
 * 这里只做协议与形状校验（JSON / 文件名 / base64），**类型与大小由选中的上传源自己判**
 * （内置 = 契约白名单 + 10MB；插件可以声明自己的 accept，见 `UploadProviderSpec`）。
 *
 * ⚠️ 上传成功后必须 `recordIssuedUpload`：附件 URL 是**直传**给模型的，服务端不下载校验，
 * 所以「这条 URL 是我们发出去的」只能靠这张签发记录证明（`server/upload/trust.ts`）。
 * 少了这一步，插件上传的附件在发送时会被 `validateUploadFiles` 判为「不合法」。
 */
import type { UploadInput } from '@fizz/contracts/agent-api'
import { jsonError } from '@/app/api/_lib/auth'
import {
  initUploadTrust,
  putWithProvider,
  recordIssuedUpload
} from '@/lib/server/upload/index'
import { UploadRequestError } from '@/lib/server/upload/registry'
import { domain } from '@/lib/server/state'

/** base64 严格形状（容忍空白与缺 padding）：Buffer.from 对非法字符是宽容解码，会静默产出脏字节 */
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return jsonError(400, '上传必须使用 JSON 请求体（不支持 multipart）')
  }
  let body: UploadInput
  try {
    body = (await request.json()) as UploadInput
  } catch {
    return jsonError(400, '请求体不是合法 JSON')
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 255 || /[/\\]/.test(name)) return jsonError(400, '非法文件名')
  if (typeof body?.mediaType !== 'string' || !body.mediaType) return jsonError(400, '缺少文件类型')
  if (typeof body?.dataBase64 !== 'string' || !BASE64_RE.test(body.dataBase64)) {
    return jsonError(400, '文件内容不是合法 base64')
  }

  const bytes = new Uint8Array(Buffer.from(body.dataBase64, 'base64'))
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined
  // 项目级插件要按项目扫插件目录（拿不到 workspace 时只用插件，是预期行为而非故障）
  const workspacePath = workspaceId ? domain.getWorkspace(workspaceId)?.path : undefined
  const providerId = typeof body.provider === 'string' && body.provider ? body.provider : undefined

  // 先把「已签发」表读回来再写：避免读盘结果覆盖刚记下的一条（同一进程里两者都写这张表）
  await initUploadTrust()
  if (request.signal.aborted) return new Response(null, { status: 499 })

  try {
    const { url, providerId: used } = await putWithProvider({
      workspaceId,
      workspacePath,
      providerId,
      signal: request.signal,
      input: { name, mediaType: body.mediaType, bytes, workspacePath }
    })
    if (request.signal.aborted) throw new DOMException('上传已取消', 'AbortError')
    recordIssuedUpload(url, body.mediaType)
    return Response.json({ url, name, mediaType: body.mediaType, size: bytes.length, provider: used })
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    const message = err instanceof Error ? err.message : String(err)
    // 客户端能自己改的（未知上传源 / 类型不支持 / 太大）回 400，其余（上游报错、超时、
    // 插件返回值越界）回 500 —— 前端两种都直接把 message 显示出来
    if (err instanceof UploadRequestError) return jsonError(400, message)
    return jsonError(500, `附件上传失败：${message}`)
  }
}
