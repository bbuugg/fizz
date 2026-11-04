/**
 * 服务端视角的插件根：「一次插件发现」的统一组装口。
 *
 * 内置插件根（随产品分发，`<仓库根>/plugins`）**在哪儿**由 `builtin-dirs.ts` 探测
 * （三种运行形态 + 标记文件判据，见那份文件头）。
 *
 * 这里存在的理由：三个调用点（每轮对话、插件路由、上传源目录）都要「根目录 + 按来源分开的
 * 启停偏好」这一份组装规则。各写一遍的话，早晚出现「对话侧扫了内置插件、上传侧没扫」
 * 这种只在某处少一个参数的 bug。
 */
import { homedir } from 'node:os'
import { discoverPlugins, pluginSourceSignature, standardPluginRoots } from '@fizz/plugin/loader'
import type {
  PluginDescriptor,
  PluginRoot,
  PluginUiDeclaration,
  PluginUiView,
  StandardPluginSource
} from '@fizz/plugin'
import { promises as fs } from 'node:fs'
import { resolveBuiltinPluginsDir } from './builtin-dirs'
import { domain } from './state'

/**
 * 前端 bundle 的版本指纹：`<mtimeMs>-<size>`（36 进制，短一点）。
 *
 * 用 stat 而不是文件内容：界面清单**每次刷新都调它**，插件的 bundle 动辄几百 KB，
 * 每次读一遍纯属浪费；mtime + size 足以识别「插件作者改过 client.js」。
 * 文件被人删了返回 `undefined`（前端就不会去加载它，也不会一直报错）。
 */
export async function clientBundleRev(clientFile?: string): Promise<string | undefined> {
  if (!clientFile) return undefined
  const info = await fs.stat(clientFile).catch(() => null)
  if (!info?.isFile()) return undefined
  return `${Math.floor(info.mtimeMs).toString(36)}-${info.size.toString(36)}`
}

/**
 * 插件的**运行时配置** = `plugins.yml` 里的 config **叠加**设置页里存的值（后者优先：
 * 界面上显式改过的更新）。挂载时作为 `apply(ctx, config)` 的第二个参数交给插件。
 *
 * 约定：设置项的 `id` 就是 config 里的键名（见 `ctx.ui.setting` 的说明），所以两者能直接合并。
 * 返回值在没有配置时是 `undefined`（与「这个插件没配过任何东西」逐字节一致，老插件无感）。
 *
 * 密钥项在这里已经是**明文**（来自 `resolvePluginConfigValues`）—— 它只交给插件进程内存，
 * 绝不出网；要发给浏览器的走 `pluginSettingStates`（那份不含密钥值）。
 */
export function pluginRuntimeConfig(pluginId: string, ymlConfig?: unknown): unknown {
  const stored = domain.resolvePluginConfigValues(pluginId)
  if (Object.keys(stored).length === 0) return ymlConfig
  if (ymlConfig && typeof ymlConfig === 'object' && !Array.isArray(ymlConfig)) {
    return { ...(ymlConfig as Record<string, unknown>), ...stored }
  }
  // yml 没配（或配了非映射的值）：设置页里那些值就是配置本身
  return stored
}

/**
 * 把描述符的 `config` 换成运行时配置（供 `loadPlugins` / `inspectPluginUi` 直接用）。
 *
 * 三个挂载点（每轮对话、上传源目录、设置页 inspect）都要这一道 —— 各写一遍的话，早晚
 * 出现「设置页里填的值，某条路径上没生效」，而那种漏法完全不报错。
 */
export function withRuntimeConfig(descriptors: PluginDescriptor[]): PluginDescriptor[] {
  return descriptors.map((item) => ({ ...item, config: pluginRuntimeConfig(item.id, item.config) }))
}

/**
 * 把「声明」合成「给前端的视图」：挂上当前值。
 *
 * - 非密钥项：带 `value`（没设过就不带，前端回落到 `default` / 占位提示）；
 * - 密钥项：**只带 `hasValue`**，明文绝不出网（与模型配置的 `hasApiKey` 同款，见
 *   `docs`/AGENTS.md 的「发往浏览器的视图不含明文密钥」）。
 */
export function toPluginUiView(
  ui: Record<string, PluginUiDeclaration>,
  /** 插件 id → 显示名（界面项里要标归属；传空 = 只显示 id） */
  names: Record<string, string> = {}
): Record<string, PluginUiView> {
  const out: Record<string, PluginUiView> = {}
  for (const [pluginId, decl] of Object.entries(ui)) {
    const { values, secretIds } = domain.pluginSettingStates(pluginId)
    const secrets = new Set(secretIds)
    out[pluginId] = {
      panels: decl.panels,
      ...(decl.icon ? { icon: decl.icon } : {}),
      /**
       * 界面项：**只带数据**（`render` / `onAction` 是函数，绝不出网 —— 它们在服务端跑）。
       * key 用 `插件id:类型:id`：插件 id 是绝对路径，所以不同目录里的同名面也不会撞。
       */
      surfaces: decl.surfaces.map((item) => ({
        key: surfaceKeyOf(pluginId, item),
        pluginId,
        pluginName: names[pluginId] ?? '',
        kind: item.kind,
        id: item.id,
        title: item.title,
        ...(item.icon ? { icon: item.icon } : {}),
        order: typeof item.order === 'number' ? item.order : 0,
        ...(item.opens ? { opens: item.opens } : {}),
        hasAction: typeof item.onAction === 'function'
      })),
      settings: decl.settings.map((item) => {
        if (item.secret) return { ...item, hasValue: secrets.has(item.id) }
        const value = values[item.id]
        return value === undefined ? { ...item } : { ...item, value }
      })
    }
  }
  return out
}

/**
 * 一个界面项的前端 key：`插件id:类型:id`。
 *
 * 导出它是因为**两处**都要算：设置页的清单（`toPluginUiView`）与 `/api/plugins/surfaces`
 * 的清单 —— 各写一遍迟早会出现「两边 key 不一样，点过去找不到面」。
 */
export function surfaceKeyOf(
  pluginId: string,
  item: { kind: string; id: string }
): string {
  return `${pluginId}:${item.kind}:${item.id}`
}

/**
 * 「插件清单 + 设置值」的指纹：任一变化就说明**该重新 mount 了**。
 *
 * - 源码：目录内每个文件的相对路径 + `mtimeMs` + `size`（与 `@fizz/plugin/loader` 的模块缓存同一判据）；
 * - 配置：`domain.pluginValuesFingerprint`（含密钥**密文**，不含明文）。
 *
 * ⚠️ 配置必须进来：上传源目录是**长驻 context**，只在插件文件变化时重建的话，用户在设置页
 * 填完 token 也得重启才生效 —— 那种「填了没用」的 bug 极难自查。指纹里用密文而不是明文，
 * 是为了不把明文密钥拼进一个可能被日志/调试打出来的字符串。
 */
export async function pluginFingerprint(descriptors: PluginDescriptor[]): Promise<string> {
  const parts: string[] = []
  for (const item of descriptors) {
    const signature = await pluginSourceSignature(item.dir)
    parts.push(
      `${item.id}|${item.enabled ? 1 : 0}|${signature}|${domain.pluginValuesFingerprint(item.id)}`
    )
  }
  return parts.sort().join('\n')
}

/** 标准插件根列表（内置 + 项目 + 用户级），顺序见 `standardPluginRoots` */
export function serverPluginRoots(opts: { workspacePath?: string }): Array<
  PluginRoot<StandardPluginSource>
> {
  return standardPluginRoots({
    workspacePath: opts.workspacePath,
    home: homedir(),
    builtinDir: resolveBuiltinPluginsDir()
  })
}

/**
 * 发现插件：根目录 + **按来源分开的启停偏好**（内置 / 用户级认全局那份，项目级认项目那份）。
 *
 * 三个调用点（每轮对话、插件路由、上传源目录）都用它 —— 组装规则只有一份，才不会出现
 * 「对话侧扫了内置插件、上传侧没扫」这种只在某一处少一个参数的 bug。
 */
export async function discoverServerPlugins(opts: {
  workspaceId?: string
  workspacePath?: string
}): Promise<PluginDescriptor[]> {
  return discoverPlugins({
    workspacePath: opts.workspacePath,
    home: homedir(),
    builtinDir: resolveBuiltinPluginsDir(),
    settings: opts.workspaceId ? domain.getPluginSettings(opts.workspaceId) : undefined,
    globalSettings: domain.getGlobalPluginSettings()
  })
}
