/**
 * 插件框架的公共类型（纯类型，无运行时）。
 */
import type { Context } from './context'

/** 清理函数：`ctx.effect()` / `ctx.plugin()` 的返回值都长这样；可异步 */
export type Dispose = () => void | Promise<void>

/**
 * 对象形式的插件。
 *
 * - `name`：给人看的名字（日志 / 冲突报错里出现）；缺省用 `plugin`；
 * - `inject`：依赖的服务名清单。缺任何一项时**推迟挂载**，等那一项被 `ctx.set`
 *   提供出来再自动挂上（见 Context 的 pending 机制）——这样挂载顺序无关紧要；
 * - `apply`：真正干活的函数。返回值是「卸载时要跑的清理」，可省略。
 */
export interface PluginObject<C = unknown> {
  name?: string
  inject?: string[]
  apply(ctx: Context, config: C): void | Dispose
}

/** 函数形式的插件：等价于只有 `apply` 的对象插件 */
export type PluginFunction<C = unknown> = (ctx: Context, config: C) => void | Dispose

/**
 * 类形式的插件：`new Plugin(ctx, config)`，实例上若有 `dispose()` 会在卸载时调用。
 * 一般配合 `Service` 基类使用。
 */
export type PluginClass<C = unknown> = new (
  ctx: Context,
  config: C
) => { dispose?(): void | Promise<void> } | void

export type Plugin<C = unknown> = PluginObject<C> | PluginFunction<C> | PluginClass<C>

/** 事件监听器；`waterfall` 场景下最后一个参数是 `next` */
export type Listener = (...args: unknown[]) => unknown

// ---------- 发现 / 加载（镜像技能根的形态；纯类型，加载实现在子路径 loader） ----------

/** 插件来源根目录（内置、`<工作区>/.fizz/plugins`、`~/.fizz/plugins`） */
export interface PluginRoot<S extends string = string> {
  source: S
  dir: string
}

/**
 * 标准插件来源：
 * - `builtin`：**随产品分发**的内置插件根（`<仓库/安装目录>/plugins`，目录标记由宿主判定，
 *   见 `apps/server/src/server/builtin-dirs.ts`），
 *   对所有项目生效；开关在设置 →「插件」里（与用户级共用那一份全局启停）；
 * - `workspace`：`<工作区>/.fizz/plugins`，只对该项目生效，开关在项目「更多 → 插件」里；
 * - `user`：`~/.fizz/plugins`，所有项目生效，开关在设置 →「插件」里。
 */
export type StandardPluginSource = 'builtin' | 'workspace' | 'user'

/**
 * 插件自带前端 bundle 里声明的一个界面。
 *
 * 为什么声明放 manifest 而不是让 bundle 运行时注册：界面清单是**服务端驱动**的
 * （`listPluginSurfaces` 一次返回全部条目，前端按下标渲染）。让 bundle 再注册一遍就会有两份
 * 真源 —— 刷新前后条目顺序会变、插件没加载出来时列表整段消失。所以清单只声明「我有哪些面」，
 * bundle 只负责「这个面长什么样」（按 `id` 认领）。
 *
 * **面只有一种：`view`（标签页）**。插件不占图标栏、也没有自己的侧栏 —— 活动栏里那颗
 * 「插件」打开的是插件列表，点插件就在主区域开标签页（见 `activity-ids.ts` 的说明）。
 */
export interface PluginStaticSurface {
  /** 面种类：清单里只能是 `view`（标签页） */
  kind: 'view'
  /** 面 id（插件内唯一；bundle 用它认领渲染函数） */
  id: string
  /** 展示名（标签标题） */
  title: string
  /** 这一面的图标（data URI）；一般不用写 —— 插件图标在 `PluginManifest.icon` */
  icon?: string
  /** 排序（升序；缺省 100）。最小的那个就是点插件时默认打开的面 */
  order?: number
}

/**
 * 插件的前端半（浏览器端）。
 *
 * `entry` 指向插件目录里**已经构建好**的单文件 JS（浏览器跑不了 TS/TSX，宿主不做运行时转译——
 * 那等于把编译器塞进服务端、还多一份「插件源码能执行任意编译期代码」的攻击面）。
 *
 * bundle 契约（见 `packages/agent-kit/src/features/plugins/plugin-client.ts`）：
 * 顶层调用 `window.__FIZZ_PLUGIN__(<id>, factory)`，factory 收到宿主注入的模块表，
 * 返回 `{ render(surfaceId, ctx) }`。**React 只能从模块表取**，自带一份会让 hooks 报错。
 */
export interface PluginClientManifest {
  /** bundle 相对路径（目录内，如 `client.js`；必须以 `.js` 结尾） */
  entry: string
  /** 这个插件要占的界面 */
  surfaces?: PluginStaticSurface[]
}

/**
 * 插件目录里的 `plugin.json`（**唯一的接口判据**：没有它 / 字段不合格的目录不会被加载）。
 *
 * 一个插件 = 一个目录，入口由 manifest 的 `entry` 指定（不再支持单文件插件）。
 * `id` 是**稳定身份**：启停状态、设置值、模型配置 id 都按它记，改目录名不会失联。
 */
export interface PluginManifest {
  /** 全局唯一 id（`[A-Za-z0-9][A-Za-z0-9._-]*`，最长 64）；装插件时也用它做目录名 */
  id: string
  /** 展示名（设置页 / 报错里出现） */
  name: string
  /** 插件版本（semver，如 `1.0.0`） */
  version: string
  /** 宿主接口版本；当前只认 1 */
  apiVersion: number
  /** 入口源码（目录内相对路径，如 `index.ts` / `src/main.ts`） */
  entry: string
  /**
   * 插件图标：`data:image/*` 的 data URI（「插件」侧栏的列表行用它）。
   *
   * 写在这里比在 `apply()` 里调 `ctx.ui.icon(...)` 更省事 —— 静态声明，列表不必先把插件
   * 跑起来；服务端取它优先于 `ctx.ui.icon(...)` 的声明。尺寸控制在 64KB 以内（太重会让
   * 每次拉清单都变慢），只放行 `data:image/` 开头。
   */
  icon?: string
  /** 可选说明 */
  description?: string
  /** 可选作者 */
  author?: string
  /**
   * 前端半（可选）。给了它，这个插件的界面就在**浏览器里**渲染，
   * 由 `manifest.client.surfaces` 声明有哪些面。
   */
  client?: PluginClientManifest
  /**
   * 这个插件要装哪些 npm 包（包名 → semver range）。
   *
   * 装到**插件根目录**的一份共享 `node_modules` 里（不是每个插件一份）：
   * pnpm + `nodeLinker: hoisted`，缺的 peer 由宿主的解析层兜底，于是全进程只有一个
   * `@fizz/plugin` 实例。代价是同一个包的两个不兼容版本只能有一个生效（安装时会给 warning）。
   *
   * 禁止写 `@fizz/*`：那是宿主自己的包，插件版本一旦覆盖上去，`ctx` 的 `instanceof`
   * 判定就全乱了（见 `loader.ts` 的 `HOST_SHARED_PACKAGES`）。
   */
  dependencies?: Record<string, string>
  /** 兼容性声明：`{ "fizz": ">=1.2.0" }`。不满足时**不加载**（与配置无关，是作者声明） */
  engines?: { fizz?: string }
}

/** 扫描到的一个插件（一个目录 + 一份 manifest） */
export interface PluginCandidate<S extends string = string> {
  /** 插件 id = manifest.id（稳定；启停状态按它记） */
  id: string
  /** 给人看的名字 = manifest.name */
  name: string
  /** manifest 原文（发现阶段已校验） */
  manifest: PluginManifest
  /** 入口文件绝对路径（manifest.entry 解析后） */
  file: string
  /** 前端 bundle 绝对路径（`manifest.client.entry` 解析后；没有就是 undefined） */
  clientFile?: string
  /** 插件目录 */
  dir: string
  /** 来源根目录 */
  root: string
  source: S
}

/** 带配置与启停态的插件描述（API 返回给设置页的形状） */
export interface PluginDescriptor<S extends string = string> extends PluginCandidate<S> {
  /** 最终是否启用（plugins.yml 的 enabled + 用户设置合并后的结果） */
  enabled: boolean
  /** plugins.yml 里配给它的 config（原样透传） */
  config?: unknown
}

/** 插件启停偏好：**默认全启用**，`disabled` 里是被用户关掉的插件 id */
export interface PluginSettings {
  disabled: string[]
}

/**
 * 设置页展示用的**上传源摘要**：`UploadProviderRegistration` 里可以外传的那部分
 * （`put` / `resolveModelUrl` 这类函数留在宿主，不进 HTTP 响应）。
 *
 * 放在这个纯类型文件里而不是 `loader.ts`：前端要从包根入口 import type 它，
 * 而根入口刻意不导出 loader（那会把 jiti / fs 拖进浏览器产物）。
 */
export interface PluginUploadSourceInfo {
  id: string
  title: string
  acceptMime: string[]
  maxBytes?: number
}