/**
 * 安装插件的 npm 依赖：POST /api/plugins/deps { scope, workspaceId }
 *
 * ## 什么时候需要手动调它
 *
 * 走 `/api/plugins/install` 装的插件会自动装依赖（那是唯一的主路径）。
 * 这个端点服务的是「插件是手工拷进目录的」——把 `plugin.json` 里写了 `dependencies`
 * 的目录直接扔进 `~/.fizz/plugins`，然后点一下设置页的「安装依赖」。没有它的话，
 * 用户只能看到一句 `Cannot find module 'xxx'`，而不知道要跑什么命令。
 *
 * 按 scope 分隔是必须的：用户级与项目级插件根是**两个独立的 pnpm 工程**，
 * 装错根的表现是「依赖装上了，但插件还是找不到」。
 */
import { resolveWorkspace, writableRoot } from '@/app/api/plugins/_lib/list'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { syncPluginRootDeps } from '@/lib/server/plugin-deps'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<{ scope?: unknown; workspaceId?: unknown }>(request)
  const scope = body?.scope === 'workspace' ? 'workspace' : 'global'
  const workspaceId =
    typeof body?.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined

  const root = writableRoot(scope, workspaceId)
  if (!root) {
    return jsonError(400, scope === 'workspace' ? '没有可用的项目' : '找不到用户级插件目录')
  }
  const workspace = scope === 'workspace' ? resolveWorkspace(workspaceId) : undefined
  if (scope === 'workspace' && !workspace) return jsonError(400, '没有可用的项目')

  const result = await syncPluginRootDeps({
    rootDir: root.dir,
    ...(workspace?.id ? { workspaceId: workspace.id } : {}),
    ...(workspace?.path ? { workspacePath: workspace.path } : {})
  })
  if (!result.ok) {
    return jsonError(400, result.output || '依赖安装失败')
  }
  return Response.json({
    ok: true,
    /** 这个根里没有任何插件声明 dependencies（什么都没做） */
    changed: result.changed,
    root: root.dir,
    warnings: result.warnings,
    output: result.output
  })
}
