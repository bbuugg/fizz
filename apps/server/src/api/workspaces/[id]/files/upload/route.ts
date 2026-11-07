/**
 * 上传文件到工作区：POST /api/workspaces/:id/files/upload（body: FsUploadInput）。
 *
 * **为什么不复用「写文件」（POST .../files/read）**：那条路把 content 当字符串、以
 * `fs.writeFile(abs, content, 'utf8')` 落盘 —— 图片 / 压缩包经它写出来是坏的（非 UTF-8
 * 字节被替换成 U+FFFD），而且它的 2MB 上限是按文本正文定的。这里按 base64 收字节、
 * 解码成 Buffer 后**不带编码**写入，与 `/api/uploads`（对话附件）同一套协议与校验思路。
 *
 * 冲突语义：目标已存在且没带 `overwrite: true` → **409**，由客户端问过用户再重传。
 * 这条不能省：面板的树是懒加载的，右键的那个目录很可能还没展开、面板根本不知道里面
 * 有什么，所以「同名冲突」只能由服务端（权威）来判。
 */
import { promises as fs } from 'node:fs'
import { FS_UPLOAD_MAX_BYTES, type FsUploadInput } from '@fizz/contracts/agent-api'
import { resolveInside } from '@fizz/contracts/workspace'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

/** base64 严格形状（容忍空白与缺 padding）：Buffer.from 对非法字符是宽容解码，会静默产出脏字节 */
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, '文件面板')
  if (denied) return denied

  const body = await parseJsonBody<FsUploadInput>(request)
  if (!body) return jsonError(400, '缺少请求体')
  const rel = typeof body.path === 'string' ? body.path.trim() : ''
  if (!rel) return jsonError(400, '缺少 path')
  // 必须是文件路径：目录路径会让 writeFile 抛 EISDIR，与其 500 不如明确拒掉
  if (rel.endsWith('/') || rel.endsWith('\\')) return jsonError(400, 'path 必须是文件路径')
  if (typeof body.dataBase64 !== 'string' || !BASE64_RE.test(body.dataBase64)) {
    return jsonError(400, '文件内容不是合法 base64')
  }
  const bytes = Buffer.from(body.dataBase64, 'base64')
  if (bytes.length === 0) return jsonError(400, '文件内容为空')
  if (bytes.length > FS_UPLOAD_MAX_BYTES) {
    return jsonError(400, `文件超过大小上限（${Math.round(FS_UPLOAD_MAX_BYTES / 1024 / 1024)}MB）`)
  }

  let abs: string
  try {
    abs = resolveInside(workspace.path, rel)
  } catch {
    return jsonError(403, '路径越界')
  }

  if (!body.overwrite) {
    const exists = await fs
      .stat(abs)
      .then((stat) => stat.isFile())
      .catch(() => false)
    if (exists) {
      return jsonError(409, `已存在同名文件：${rel.split('/').pop() ?? rel}`)
    }
  }

  try {
    // 不传编码 = 按字节原样写（二进制安全）
    await fs.writeFile(abs, bytes)
  } catch (err) {
    return jsonError(500, `写入失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return new Response(null, { status: 204 })
}
