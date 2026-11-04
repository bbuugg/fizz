/**
 * 插件列表的**共享装配**：`GET`（列）、`POST`（改启停）、安装、卸载四处都要它。
 *
 * 为什么单独放一份：这四个入口返回**同一份 `PluginsResponse` 形状**，前端于是可以直接
 * 拿响应覆盖当前状态（`setData(result)`），不必再拉一次 —— 装 / 卸之后列表立刻是对的，
 * 这就是「热重载」在界面那一半的落点。各写一遍迟早出现「某个入口少返回一个字段，
 * 面板上那一块就空了」。
 *
 * ⚠️ 放在 `_lib` 而不是 `route.ts`：路由是 `app.ts` 里用 Vite 的 `import.meta.glob`
 * **编译期**收集的（只收 `api` 下那些 `route.ts`），这个目录里的文件不会变成路由，
 * 纯属共享代码。
 */
import { inspectPluginUi } from '@fizz/plugin/loader'
import {
  discoverServerPlugins,
  serverPluginRoots,
  toPluginUiView,
  withRuntimeConfig
} from '@/lib/server/plugin-roots'
import { domain } from '@/lib/server/state'
import { iconOnlyUi } from './stopped-icons'

/** 请求的作用域：global = 内置 + 用户级（设置页）；其余 = 某个项目（项目弹窗） */
export type PluginScope = 'global' | 'workspace'

/** 解析这次请求针对哪个项目：给了有效 workspaceId 就用它，否则回退到第一个项目 */
export function resolveWorkspace(workspaceId?: string | null) {
  return (workspaceId ? domain.getWorkspace(workspaceId) : undefined) ?? domain.listWorkspaces()[0]
}

/**
 * 这个作用域下**可写**的插件根目录。
 *
 * 只可能是**用户级**（`~/.fizz/plugins`）或**项目级**（`<项目>/.fizz/plugins`）——
 * **内置根不可写**：它随产品分发（进 git、打包后进 resourcesPath 还可能只读），
 * 往里写等于污染仓库。目录由服务端按 scope 推导，**不接受客户端传绝对路径**。
 */
export function writableRoot(
  scope: PluginScope,
  workspaceId?: string | null
): { dir: string; source: string } | null {
  if (scope === 'global') {
    return serverPluginRoots({}).find((root) => root.source === 'user') ?? null
  }
  const workspace = resolveWorkspace(workspaceId)
  if (!workspace) return null
  return (
    serverPluginRoots({ workspacePath: workspace.path }).find(
      (root) => root.source === 'workspace'
    ) ?? null
  )
}

/**
 * 扫一遍**全局**（内置 + 用户级）插件根，返回列表 + 全局启停设置 + 已启用插件声明的 UI。
 * 不传 `workspacePath` → 只扫这两类根（这正是「全局」的语义）。
 */
export async function listGlobal() {
  const settings = domain.getGlobalPluginSettings()
  const roots = serverPluginRoots({})
  const plugins = await discoverServerPlugins({})
  return respond(plugins, settings, roots)
}

/**
 * 扫一遍**该项目**的插件根目录。**只返回项目自己的插件**：内置 / 用户级插件归设置页
 * （全局）管，摆在这里既点不动（项目开关对它无效）又容易让人以为「在这里关掉就全局关了」。
 */
export async function listWorkspace(workspaceId?: string | null) {
  const workspace = resolveWorkspace(workspaceId)
  const settings = workspace ? domain.getPluginSettings(workspace.id) : { disabled: [] }
  const all = await discoverServerPlugins({
    workspaceId: workspace?.id,
    workspacePath: workspace?.path
  })
  const roots = serverPluginRoots({ workspacePath: workspace?.path }).filter(
    (root) => root.source === 'workspace'
  )
  return respond(
    all.filter((plugin) => plugin.source === 'workspace'),
    settings,
    roots
  )
}

/**
 * 共用响应装配。
 *
 * 声明（设置项 / 面板 / 界面 / 上传源）**只收已启用**的插件：停用的插件不该在列表里
 * 显示「它给了我什么能力」，更不该占着「配置」入口。
 *
 * **但图标例外** —— 见下面 `stoppedIcons`。图标是插件的**身份**（列表里那一格小图），
 * 不是它对外提供的能力：把插件停用之后它在列表里退化成统一占位图，用户会认不出
 * 刚停用的是哪一个，也会以为「停用把插件弄坏了」。
 *
 * 收集声明要真跑一遍 apply，所以这里顺带就是「加载 + 校验」的体检结果（含工具形状报错、
 * 上传源形状报错，见 ToolsService.register / UploadsService.register）。**原样回给前端**，
 * 在插件列表里直接显示，别让用户对着一句「执行中」猜。
 *
 * `ui` 还要再过一道 `toPluginUiView`：把**当前值**挂上去（密钥项只给 `hasValue`，值不出网），
 * 设置页才是一个能编辑的表单而不是只读清单。
 */
async function respond(
  plugins: Awaited<ReturnType<typeof discoverServerPlugins>>,
  settings: { disabled: string[] },
  roots: Array<{ source: string; dir: string }>
) {
  const enabled = plugins.filter((p) => p.enabled)
  const stopped = plugins.filter((p) => !p.enabled)
  const { ui, uploads, errors } = await inspectPluginUi(withRuntimeConfig(enabled))

  /**
   * 停用插件的**图标**：单独再 inspect 一遍，只取 `icon`（为什么只留它，规则写在
   * `iconOnlyUi` 的文件头）。
   *
   * 之所以要多这一遍：图标是 `ctx.ui.icon()` **命令式**声明的，`plugin.json` 里没有静态
   * 副本 —— 只 inspect 启用插件的话 `ui[id]` 整条不存在，前端就退回统一占位图，
   * 于是「禁用插件」看起来像把插件弄坏了。
   *
   * 代价是每个停用插件多一次 apply（与它启用时那份相同量级）：禁用的收益在**对话轮次**
   * 里不再挂载它，而不是「连设置页列表都不碰它」。
   */
  const stoppedIcons = stopped.length
    ? iconOnlyUi((await inspectPluginUi(withRuntimeConfig(stopped))).ui)
    : {}

  for (const err of errors) console.warn('[server] 插件加载/校验失败：', err)
  return Response.json({
    plugins,
    settings,
    roots,
    ui: toPluginUiView(
      { ...ui, ...stoppedIcons },
      Object.fromEntries(plugins.map((p) => [p.id, p.name]))
    ),
    uploads,
    errors
  })
}
