/**
 * 插件依赖的服务端入口：把「某个插件根里所有插件声明的 dependencies」交给 pnpm。
 *
 * 这一层只干两件事，装依赖的全部细节在 `@fizz/plugin/deps`（Node-only 子路径）：
 * 1. 按根的**绝对路径**筛出属于它的插件（内置根 / 用户级 / 项目级各自独立）；
 * 2. 把 pnpm 的输出接进服务端日志 —— 装依赖失败时那是唯一的解释。
 *
 * 为什么按根分隔：`~/.fizz/plugins` 与 `<项目>/.fizz/plugins` 是两个独立的 pnpm 工程，
 * 各自有一份 `node_modules`。合成一个的话，某个项目的插件改了依赖会波及所有项目。
 */
import { resolve } from 'node:path'
import { syncRootDependencies } from '@fizz/plugin/deps'
import type { SyncResult } from '@fizz/plugin/deps'
import { discoverServerPlugins } from './plugin-roots'

/**
 * 同步一个插件根的依赖。
 *
 * `changed=false` 的语义：这个根里**没有任何插件声明 dependencies**，什么都没动
 * （不写 package.json、不跑 pnpm）—— 绝大多数用户是这种情况，不该为它付一次 pnpm 启动。
 */
export async function syncPluginRootDeps(opts: {
  rootDir: string
  workspaceId?: string
  workspacePath?: string | null
}): Promise<SyncResult & { changed: boolean }> {
  const rootDir = resolve(opts.rootDir)
  const all = await discoverServerPlugins({
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.workspacePath ? { workspacePath: opts.workspacePath } : {})
  })
  const owners = all
    .filter((plugin) => resolve(plugin.root) === rootDir)
    .map((plugin) => ({ id: plugin.id, dependencies: plugin.manifest.dependencies }))
  if (!owners.some((owner) => owner.dependencies && Object.keys(owner.dependencies).length)) {
    return { ok: true, changed: false, output: '', warnings: [] }
  }
  const result = await syncRootDependencies({
    rootDir,
    owners,
    log: (line) => console.log(`[server] ${line}`)
  })
  if (result.warnings.length) {
    for (const warning of result.warnings) console.warn('[server] 插件依赖冲突：', warning)
  }
  return { ...result, changed: true }
}
