/**
 * 插件前端半的 bundle 源码：GET /api/plugins/client?pluginId=…&workspaceId=…
 *
 * ## 为什么是「读文件 + 返回文本」而不是静态托管
 *
 * - desktop 的渲染进程没有 HTTP 端口（渲染端 ↔ 服务端只有 IPC 桥），`<script src>` 发不出去；
 * - `<script>` 也带不了 `authorization` 头，开了鉴权就等于所有插件 UI 全白；
 * - 三端共用一条通道，前端拿文本后用 `new Function` 执行（模块表注入见 agent-kit）。
 *
 * ## 边界
 *
 * - 只服务**已启用**且 manifest 里真的声明了 `client.entry` 的插件；
 * - 路径来自 `readPluginManifest` 校验过的 `clientFile`（绝对路径，已在插件目录内），
 *   这里**不再拼接客户端传来的任何路径**；
 * - 体积封顶 2MB：插件的 UI bundle 是几百 KB 量级，超了多半是把整个 node_modules 打进去了。
 */
import { readFile } from 'node:fs/promises'
import { clientBundleRev, discoverServerPlugins } from '@/lib/server/plugin-roots'
import { jsonError } from '@/app/api/_lib/auth'

/** bundle 体积上限 */
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const pluginId = (url.searchParams.get('pluginId') ?? '').trim()
  if (!pluginId) return jsonError(400, '缺少 pluginId')
  const workspaceId = (url.searchParams.get('workspaceId') ?? '').trim() || undefined

  const all = await discoverServerPlugins(workspaceId ? { workspaceId } : {})
  const descriptor = all.find((item) => item.id === pluginId)
  if (!descriptor) return jsonError(404, `找不到插件 ${pluginId}`)
  if (!descriptor.enabled) return jsonError(404, `插件「${descriptor.name}」已停用`)
  if (!descriptor.clientFile) {
    return jsonError(404, `插件「${descriptor.name}」没有声明 client.entry`)
  }
  const rev = await clientBundleRev(descriptor.clientFile)
  if (!rev) return jsonError(404, `插件「${descriptor.name}」的 client.entry 文件不存在`)

  const bytes = await readFile(descriptor.clientFile).catch(() => null)
  if (!bytes) return jsonError(404, `读不到插件「${descriptor.name}」的前端 bundle`)
  if (bytes.length > MAX_BUNDLE_BYTES) {
    return jsonError(
      400,
      `插件「${descriptor.name}」的前端 bundle 太大（${Math.round(bytes.length / 1024)}KB，上限 ${MAX_BUNDLE_BYTES / 1024}KB）——` +
        ' 检查一下是不是把 node_modules 打进去了'
    )
  }
  return Response.json({ code: bytes.toString('utf8'), rev })
}
