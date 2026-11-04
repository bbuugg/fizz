/**
 * 卸载插件：把那个插件**从磁盘上删掉**，并清干净它留下的痕迹。
 *
 * ## 只能卸「用户级 / 项目级」
 *
 * **内置插件不能卸载** —— 它随产品分发（进 git、打包后在 resourcesPath 里还可能只读），
 * 删它既污染发行物、也拿不到「恢复」的办法。不想用就在列表里停用（开关是软的、可撤销）。
 *
 * ## 只认「扫盘扫到的插件」
 *
 * `pluginId` 是 manifest 里的**稳定 id**，所以这里先扫一遍、在结果里找它，再用描述符
 * 里的 `dir` 去删 —— **绝不拿客户端给的 id 直接当路径删**，否则一个请求就能删磁盘上
 * 任意文件。找到之后还要确认它在自己的插件根里。
 *
 * ## 卸载要清三样残留
 *
 * 1. 模块缓存（文件没了，缓存条目留着会让「同名文件重新装回来」用到旧对象）；
 * 2. 上传源的长驻 context（否则它提供的上传源还挂在「传到哪儿」下拉里）；
 * 3. **启用 / 停用名单与设置值** —— 插件 id 是 manifest.id，重新装同一个 id 会挂到
 *    同一条记录上：不清停用名单 = 装回来还是停用的；不清设置值 = 新插件一上来就读到
 *    上一次填的 token。
 *
 * 响应是**重扫后的完整列表**（与启停同一形状），前端直接覆盖即可 —— 卸载后界面当场就对了。
 */
import { resolve, sep } from 'node:path'
import { rm } from 'node:fs/promises'
import { invalidatePluginModule } from '@fizz/plugin/loader'
import { discoverServerPlugins } from '@/lib/server/plugin-roots'
import { syncPluginRootDeps } from '@/lib/server/plugin-deps'
import { invalidateUploadProviders } from '@/lib/server/upload/registry'
import { invalidatePluginModels, refreshPluginModels } from '@/lib/server/plugin-models'
import { domain } from '@/lib/server/state'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { listGlobal, listWorkspace, resolveWorkspace, type PluginScope } from '../_lib/list'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<{
    scope?: PluginScope
    workspaceId?: string
    pluginId?: string
  }>(request)

  const pluginId = typeof body?.pluginId === 'string' ? body.pluginId.trim() : ''
  if (!pluginId) return jsonError(400, '缺少 pluginId')

  const scope: PluginScope = body?.scope === 'global' ? 'global' : 'workspace'
  const workspace = scope === 'workspace' ? resolveWorkspace(body?.workspaceId) : undefined

  // 先扫盘再找：只卸真实存在的插件（见文件头「只认扫盘扫到的插件」）
  const descriptors = await discoverServerPlugins({
    workspaceId: workspace?.id,
    workspacePath: workspace?.path
  })
  const item = descriptors.find((d) => d.id === pluginId) ?? null
  if (!item) return jsonError(404, '插件清单里没有它（可能已经卸载了）')
  if (item.source === 'builtin') {
    return jsonError(400, '内置插件不能卸载 —— 不想用就在列表里把它停用（开关随时能开回来）')
  }

  // 插件永远是一个目录：删整个目录（入口 / helper / manifest 一起走）
  const rootDir = resolve(item.root)
  const targetPath = resolve(item.dir)
  // 越界检查：删的一定在它自己的插件根里面
  if (targetPath !== rootDir && !targetPath.startsWith(rootDir + sep)) {
    return jsonError(400, '这个插件的路径不在它的插件目录里，拒绝删除')
  }

  await rm(targetPath, { recursive: true, force: true })

  /*
   * 依赖表是按根**合成**的（见 `@fizz/plugin/deps`）：删掉插件后要重算一次，
   * 否则它的依赖会一直留在 `node_modules` 里 —— 用户下次看到「我明明卸了，怎么还有这个包」
   * 只能去翻磁盘。失败**不阻断卸载**：目录已经删了，再回滚就变成
   * 「插件还在但文件没了」的更糟状态，这里只记日志。
   */
  const depSync = await syncPluginRootDeps({
    rootDir,
    ...(workspace?.id ? { workspaceId: workspace.id } : {}),
    ...(workspace?.path ? { workspacePath: workspace.path } : {})
  })
  if (!depSync.ok) console.warn('[server] 插件依赖清理失败：', depSync.output)

  // ---- 清残留（三样，见文件头）----
  invalidatePluginModule()
  // 两种 key 都清：`workspaceId` 那份（带项目的上传）与 '' 那份（不带项目的上传）
  await invalidateUploadProviders(workspace?.id)
  await invalidateUploadProviders()
  invalidatePluginModels()
  domain.deletePluginValues(pluginId)
  const global = domain.getGlobalPluginSettings()
  domain.saveGlobalPluginSettings({ disabled: global.disabled.filter((x) => x !== pluginId) })
  if (workspace) {
    const settings = domain.getPluginSettings(workspace.id)
    domain.savePluginSettings(workspace.id, {
      disabled: settings.disabled.filter((x) => x !== pluginId)
    })
  }

  if (scope === 'global') await refreshPluginModels()
  return scope === 'global' ? listGlobal() : listWorkspace(workspace?.id)
}
