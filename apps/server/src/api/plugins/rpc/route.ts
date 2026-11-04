/**
 * 插件 RPC：POST /api/plugins/rpc { pluginId, method, payload }
 *
 * 这条路由是**插件前端半唯一的后端入口**（理由见 `packages/plugin/src/services/rpc.ts`：
 * 插件不能自己注册 HTTP 路由 —— desktop 走 IPC 桥、根本没有端口）。
 *
 * 边界：
 * - `method` 必须在插件里显式注册过，没注册就是 404（不存在反射调用任意导出）；
 * - `payload` 只有**形状**约束（JSON、体积封顶），语义由插件自己验 —— 这里不做业务猜测；
 * - 插件的错误原话回给前端：作者写「请先配置 API Key」就是给用户看的，别吞成 500。
 */
import type { PluginRpcResponse } from '@fizz/contracts/agent-api'
import { invokePluginRpc } from '@/lib/server/plugin-ui'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

/** payload 体积上限：插件之间传的是界面参数与查询结果，256KB 足够；再大多是写错了 */
const MAX_PAYLOAD_BYTES = 256 * 1024

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<{
    pluginId?: unknown
    method?: unknown
    payload?: unknown
    workspaceId?: unknown
  }>(request)

  const pluginId = typeof body?.pluginId === 'string' ? body.pluginId.trim() : ''
  if (!pluginId) return jsonError(400, '缺少 pluginId')
  const method = typeof body?.method === 'string' ? body.method.trim() : ''
  if (!method) return jsonError(400, '缺少 method')

  // 体积按序列化后的字节算：直接量 `payload` 的话数组 / 深层对象都能绕过
  let payloadBytes = 0
  if (body?.payload !== undefined) {
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(body.payload) ?? '', 'utf8')
    } catch {
      return jsonError(400, 'payload 不能序列化成 JSON')
    }
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      return jsonError(400, `payload 太大（${payloadBytes} 字节，上限 ${MAX_PAYLOAD_BYTES}）`)
    }
  }

  const workspaceId =
    typeof body?.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined

  const result = await invokePluginRpc({
    pluginId,
    method,
    ...(body?.payload === undefined ? {} : { payload: body.payload }),
    ...(workspaceId ? { workspaceId } : {})
  })

  if (!result.ok) {
    // 404 用 HTTP 状态码区分「方法不存在」，其余一律 400 + 插件原话
    return jsonError(result.status, result.error)
  }
  const response: PluginRpcResponse = { ok: true, data: result.data }
  return Response.json(response)
}
