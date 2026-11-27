/**
 * 复制一条主机清单条目（SSH 主机 / 本机终端）。
 * POST /api/ssh/hosts/:id/duplicate → 最新清单
 *
 * 克隆由领域层做：凭据密文只有它拿得到（客户端看到的是脱敏视图），
 * 让它「读出来再存一遍」等于把密码 / 私钥清空。新条目没有任何运行态，
 * 所以这里不需要停采集 / 停隧道（那是「改参数」才要做的事）。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return Response.json(domain.duplicateSshHost(id))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
