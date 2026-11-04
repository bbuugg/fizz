/**
 * UI 声明表：`ctx.ui` 的实体。**插件往界面里塞东西的唯一入口（轻服务）。**
 *
 * 三件事：
 * 1. **设置项** `setting()` —— 设置 →「插件」里的可编辑表单；
 * 2. **界面** —— 主视图区的一个**标签页**（`view()`）。内容由插件的 `render()` 在**服务端**
 *    算好，返回一串「块」（`UiBlock`），前端只负责把块画出来。
 *
 *    ⚠️ `activityBar()` / `sider()` 仍保留（老插件不会崩），但**界面上已经没有它们的位置**：
 *    图标栏只有一颗「插件」，点开是插件列表，点插件就在标签条里开它的 `view`。老插件的
 *    sider 面会作为标签页出现。新插件请只用 `view()`（或者直接写前端半，见 SKILL 3.7）。
 *
 * 只做「声明」与「产出数据」，**不做渲染**：插件不 import 任何 React 代码，纯 Node 侧也能
 * 声明 UI —— 与 `@fizz/agent-kit`「Node-only 包只能 import type」的约束相容，也不会出现「插件往
 * 界面注入标记」这种口子（SVG 是硬规矩：一律经 `<img>` 渲染，绝不注入 DOM）。
 *
 * ## 设置项的值（`value`）住在宿主，不在插件
 *
 * 插件声明 schema，**值由设置页填、服务端存**，挂载时作为 `apply(ctx, config)` 的第二个
 * 参数交给插件：
 *
 * ```ts
 * ctx.ui.setting({ id: 'token', title: 'API 令牌', type: 'string', secret: true })
 * // apply 里：
 * const token = config?.token ?? process.env.MY_TOKEN
 * ```
 *
 * 约定：**设置项的 `id` 就是 config 里的键名**。生效优先级
 * = `plugins.yml` 的 config < 设置页里存的值（界面上显式改过的更新）；
 * 环境变量仍在插件自己手里兜底（容器 / 无界面部署用得上）。
 *
 * 密钥项（`secret: true`）：值**不回传浏览器**（GET 只给 `hasValue`，与模型配置的
 * `hasApiKey` 同款），落盘经 `SecretBox` 加密 —— 明文只在进程内存里存在。
 */
import { Service } from '../service'
import type { Context } from '../context'
import type { Dispose } from '../types'
import type { PluginBlock, PluginSurfaceView } from '@fizz/contracts/agent-api'

export type UiSettingType = 'boolean' | 'string' | 'number' | 'select'

export interface UiSettingItem {
  /** 设置项 id —— **同时是 config 里的键名**（插件用 `config[id]` 读它） */
  id: string
  title: string
  description?: string
  type: UiSettingType
  default?: unknown
  /** `type === 'select'` 时的候选 */
  options?: { label: string; value: string }[]
  /** 密钥项：值不回传浏览器、落盘加密（见文件头） */
  secret?: boolean
  /** 输入框占位提示（`string` / `number` 用） */
  placeholder?: string
  /**
   * 多行文本（仅 `type === 'string'`）：前端渲染成 textarea，回车是换行、失焦才提交。
   * 系统提示词 / 模板这类整段文本用它；普通短串（URL / token）不要开。
   */
  multiline?: boolean
}

export interface UiPanel {
  id: string
  title: string
  description?: string
}

// ---------- 界面块（`ctx.ui.sider` / `ctx.ui.view` 的产出）----------

/**
 * 插件的界面内容 = **一串块**（block），由插件的 `render()` 在**服务端**算好，
 * 前端按 `kind` 渲染成对应的内置组件。
 *
 * 为什么不是「插件写 React / 给一段 HTML」：本仓库的硬规矩是**不许往界面注入标记**
 * （见下面 `ICON_RE` 的说明：连 SVG 源码都不收，只收 data URI）。插件是服务端代码，
 * 它产出**数据**，宿主负责渲染 —— 这样插件目录里永远不需要 import React，
 * 也不会出现「插件崩掉把整个界面带崩」的情况。
 */
export type UiBlockTone = 'normal' | 'muted' | 'success' | 'warn' | 'danger'

/** 列表里的一项（点它 = 触发 `actionId`） */
export interface UiListItem {
  /** 项 id（同一份内容里唯一；前端用它做 key） */
  id: string
  label: string
  /** 副标题（右侧灰字） */
  detail?: string
  /** 小块标签（如状态） */
  badge?: string
  tone?: UiBlockTone
  /** 点了这一项要触发哪个动作（配合 `onAction`） */
  actionId?: string
  /**
   * 随动作一起带回去的参数 —— 光有 `actionId` 分不出「点了哪一条」。
   *
   * ```ts
   * items: [{ id: k, label: k, actionId: 'open', args: { key: k } }]
   * // onAction({ actionId: 'open', args: { key: 'orders:1' } })
   * ```
   */
  args?: Record<string, string | number | boolean>
  /**
   * 行尾的**图标按钮**（编辑 / 删除这类小操作）：平时藏起来，鼠标移到这一行才浮现，
   * 与会话列表的行是同一套交互。
   *
   * 图标按**名字**给（`UiItemIcon`）—— 插件产出数据，宿主负责映射成组件。
   */
  actions?: UiItemAction[]
}

/**
 * 行尾图标按钮用的图标名。
 *
 * 只认这一组名字（宿主自己映射到图标组件）：插件给的是**数据**，不能往界面塞组件 /
 * 类名 / 图标源码 —— 与「图标只收 data URI」是同一条规矩。要新图标就往这里加一个名字。
 */
export type UiItemIcon =
  | 'pencil'
  | 'trash'
  | 'copy'
  | 'play'
  | 'pause'
  | 'plug'
  | 'unplug'
  | 'refresh'
  | 'external'
  | 'info'
  | 'terminal'
  | 'star'
  | 'plus'

/** 行尾的一个图标按钮 */
export interface UiItemAction {
  actionId: string
  icon: UiItemIcon
  /** 悬浮提示（同时是无障碍名 —— 图标按钮没有文字） */
  label: string
  args?: Record<string, string | number | boolean>
  /** 危险的（如删除）染成红色 */
  danger?: boolean
}

/** 一个按钮 */
export interface UiButtonItem {
  actionId: string
  label: string
  /** 带给 `onAction` 的参数（JSON 可序列化） */
  args?: Record<string, string | number | boolean>
}

/** 表单里的一个字段（`form` 块用） */
export interface UiFormField {
  /** 参数名：提交时值以 `args[<id>]` 带回去 */
  id: string
  label?: string
  placeholder?: string
  /** 初值（编辑已有条目时把当前值带出来） */
  value?: string
  /** 口令型：界面上遮住。只影响显示 —— 值照旧回传，加密是宿主存设置时的事 */
  secret?: boolean
  /** 多行：渲染成 textarea（编辑一整段文本 / JSON / 命令行输出时用） */
  multiline?: boolean
}

export type UiBlock =
  /** 一段文字（默认正文；`mono` = 等宽，适合路径 / 命令） */
  | { kind: 'text'; text: string; tone?: UiBlockTone; mono?: boolean }
  /** 键值表（状态 / 信息面板最常见） */
  | { kind: 'kv'; label?: string; rows: { label: string; value: string; tone?: UiBlockTone }[] }
  /** 列表（每项可点击） */
  | { kind: 'list'; label?: string; items: UiListItem[] }
  /** 一排按钮 */
  | { kind: 'buttons'; items: UiButtonItem[] }
  /** 一条提示条（空态 / 报错 / 警告） */
  | { kind: 'note'; text: string; tone?: UiBlockTone }
  /**
   * 输入框 + 提交按钮：值以 `args[<id>]` 的形式交给 `onAction`。
   *
   * ```ts
   * { kind: 'input', id: 'pattern', label: '过滤', placeholder: 'orders:*', actionId: 'filter' }
   * // onAction({ actionId: 'filter', args: { pattern: 'orders:*' } })
   * ```
   */
  | {
      kind: 'input'
      id: string
      label?: string
      placeholder?: string
      value?: string
      actionId: string
      submitLabel?: string
    }
  /**
   * 多字段表单 + 一个提交按钮：提交时**所有字段**的值一起交给 `onAction`
   * （`args: { <fieldId>: 值 }`）。
   *
   * 与 `input` 的关系：单个字段用 `input`；「新增一条连接」这种要一次填好几个的用 `form`，
   * 免得做成「填一个字段点一次」的多步流程。
   */
  | { kind: 'form'; label?: string; fields: UiFormField[]; actionId: string; submitLabel?: string }

// ---------- 三个 UI 注册面 ----------

/**
 * 三个面：
 * - `activityBar`：左侧图标栏里的一颗（点它打开某个 sider 或 view）；
 * - `sider`：图标栏右边那一列的内容（侧栏）；
 * - `view`：主视图区里的一个**标签页**。
 *
 * 三者**互相独立**：插件可以只要其中一个（比如只在侧栏显示），也可以组合
 * （一颗图标 + 侧栏 + 一个标签页）。
 */
export type UiSurfaceKind = 'activityBar' | 'sider' | 'view'

/** `render` 拿到的东西（刻意很小：插件真正需要的上下文都在它自己的闭包里） */
export interface UiRenderContext {
  /** 当前项目根目录（未绑定目录的会话没有） */
  workspacePath?: string
  /** 当前项目 id */
  workspaceId?: string
  /**
   * **这一面是哪个参数开的**（如 `{ conn: 'local' }`）。
   *
   * 有它，同一个面就能开出**多个标签页**：一个连接一个页、一个主机一个页……
   * 宿主把参数原样带回来（标签 key 与参数都记在登记表里，见 `params` 的传递链）。
   * 没用参数的面拿到的就是 undefined。
   */
  params?: Record<string, string | number | boolean>
  /**
   * 在插件内部弹一条提示（宿主用 sonner 弹）。**跟着这次请求走**：render 里调的
   * 随这次 render 带回，攒几条就带几条（见 `UiToastFn` 的说明）。
   */
  toast?: UiToastFn
  logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
}

/** toast 的种类（缺省 success；`message` 字段就是 `toast(message, 'success')` 的糖） */
export type UiToastKind = 'success' | 'error' | 'info' | 'warning'

/**
 * 插件内部的 `toast(message, kind?)`：服务端收集、随本次响应带回，宿主用 sonner 弹。
 *
 * 为什么是**回调**而不是服务：render / onAction 每次都是「现挂一次插件」，宿主给它
 * 的收集器跟着这一次请求走 —— 在插件里任何位置都能调（循环里、工具函数里都行），
 * 攒下来的随这一次 render / 动作一起回去，不会漏也不会串到别的请求。
 */
export type UiToastFn = (message: string, kind?: UiToastKind) => void
export interface UiOpenView {
  /** 要打开哪个面（插件内部 id） */
  surfaceId: string
  params?: Record<string, string | number | boolean>
  label?: string
  title?: string
}

/**
 * 动作可以请求宿主**弹一个对话框**（shadcn Dialog）。
 *
 * 「新增 / 编辑一条配置」这类交互，用户预期是弹窗而不是「在侧栏里换一屏」。
 * 弹窗是宿主的能力，插件只能请求；字段与 `form` 块共用一份（`UiFormField`），
 * 提交时所有字段的值作为 `args` 交给同一个 `onAction`。
 */
export interface UiOpenDialog {
  title: string
  /** 标题下那句说明（可省） */
  description?: string
  fields: UiFormField[]
  actionId: string
  submitLabel?: string
  cancelLabel?: string
}

/** `onAction` 除了「返回新内容」之外还能说的事 */
export interface UiActionOutcome {
  /** 给了就整面替换成它 */
  blocks?: UiBlock[]
  /** 一句话反馈（如「已保存」） */
  message?: string
  /** 请求宿主打开一个标签页（例：侧栏里点「打开这个连接」） */
  openView?: UiOpenView
  /** 请求宿主弹一个对话框（例：点「新增连接」弹出填写表单） */
  openDialog?: UiOpenDialog
}

/** 侧栏 / 标签页的声明 */
export interface UiSurfaceSpec {
  /** 面 id（同一个插件内唯一；前端的 key 是 `插件id:面id`） */
  id: string
  /** 显示名（侧栏标题 / 标签页标题 / 悬浮提示） */
  title: string
  /**
   * 侧栏顶栏右侧那排**图标按钮**（刷新 / 新增这类常驻操作）。
   *
   * 与块里的 `list` 行尾按钮同一套形状（图标名 + tooltip + args），但**位置在顶栏** ——
   * 对应宿主里 `SidebarTopBar` 的 `extra` 槽位（AI Agent 侧栏那颗「刷新列表」就在那儿）。
   * 顶栏是常驻 chrome，不该随内容滚走，所以它不写成块，而是面自己的声明。
   */
  headerActions?: UiItemAction[]
  /** 图标（`data:image/*` 的 data URI，规则同 `ctx.ui.icon`） */
  icon?: string
  /**
   * 出内容。**在服务端跑**（每次前端请求 / 刷新都跑一次），返回一串块。
   * 抛错 = 这一面显示成一条错误提示（不会拖垮界面，见服务端的渲染封装）。
   */
  render(ctx: UiRenderContext): UiBlock[] | Promise<UiBlock[]>
  /**
   * 处理块里那些可点的项（按钮 / 列表项 / 输入框 / 表单）触发的动作。
   *
   * 返回：
   * - 一串块 → **整面替换**成它；
   * - `UiActionOutcome` → 可以只说一句话、或请求宿主开一个标签页（`openView`）；
   * - 什么都不返回 → 前端自己重新拉一遍。
   *
   * `params` 是**这一面被打开时带的参数**（哪个连接 / 哪个主机…），动作按它区分实例。
   */
  onAction?(action: {
    actionId: string
    args?: Record<string, string | number | boolean>
    params?: Record<string, string | number | boolean>
    /** 处理这个动作的途中想弹点什么（error / warning / info…）就用它 */
    toast?: UiToastFn
  }):
    | UiBlock[]
    | UiActionOutcome
    | void
    | Promise<UiBlock[] | UiActionOutcome | void>
}

/** 图标栏里那一颗的声明 */
export interface UiActivityBarItem {
  id: string
  /** 悬浮提示 + 无障碍标签 */
  title: string
  icon?: string
  /** 排序（小在前）；缺省 = 按声明顺序排在内置项之后 */
  order?: number
  /**
   * 点它打开谁：`sider:<面id>` 或 `view:<面id>`。
   * 缺省 = 打开同 id 的 sider（有就开，没有就什么都不做）。
   */
  opens?: string
}

/** 注册项是「带函数」的声明（只在服务端存在，绝不发往浏览器） */
export interface UiSurfaceDeclaration {
  kind: UiSurfaceKind
  id: string
  title: string
  icon?: string
  order?: number
  opens?: string
  /** 侧栏顶栏右侧那排图标按钮（刷新 / 新增…）；见 `UiSurfaceSpec.headerActions` */
  headerActions?: UiItemAction[]
  render?: UiSurfaceSpec['render']
  onAction?: UiSurfaceSpec['onAction']
}

/**
 * 插件图标的允许形状：**`data:image/*` 的 data URI**。
 *
 * 为什么只收 data URI：
 * - **不收远程 URL** —— 渲染端可能跑在 file:// / 自定义协议下（桌面端），外链图片要靠 CSP
 *   放行，而且列表一打开就往外发请求（隐私 + 离线不可用）；
 * - **不收裸 SVG 源码** —— 本仓库的硬规矩是「SVG 一律经 `<img>` 渲染，绝不注入 DOM」，
 *   收源码就等于给插件一个往界面注入标记的口子。包成 data URI 后前端只当图片源用。
 */
const ICON_RE = /^data:image\/[a-z0-9.+-]+[;,]/i
/** 图标大小上限（data URI 形态）：够放一个 96×96 的 PNG，又不至于让列表拖成几兆 */
const MAX_ICON_CHARS = 96 * 1024

/**
 * 一个插件声明的 UI 汇总（按插件 id 归集，见 loader 的 `inspectPluginUi`）。
 *
 * 这里只有 schema，没有「当前值」—— 值住在宿主的存储里，发往前端时由服务端把
 * 当前值挂上去（见 `PluginUiView`）。
 */
export interface PluginUiDeclaration {
  settings: UiSettingItem[]
  panels: UiPanel[]
  /**
   * 插件注册的界面（图标栏 / 侧栏 / 标签页）。
   *
   * ⚠️ 这里带着 `render` / `onAction` **函数**，只活在服务端 —— 发往浏览器前必须换成
   * `PluginSurfaceView`（只有数据，见 `PluginUiView`），构建那一步在 `plugin-roots` 的
   * `toPluginUiView` 里。
   */
  surfaces: UiSurfaceDeclaration[]
  /** 插件图标（`data:image/*` data URI）；没声明 = 列表里不出图标 */
  icon?: string
}

/**
 * 发给前端的一个设置项：schema + 当前值。
 *
 * - 非密钥项：`value` 是已保存的值（没设过就没有这个字段，前端回落到 `default` / 占位提示）；
 * - 密钥项：**只给 `hasValue`**，明文绝不出网（同模型配置的 `hasApiKey`）。
 */
export interface PluginSettingView extends UiSettingItem {
  value?: string | number | boolean
  hasValue?: boolean
}

/** 发给前端的插件 UI：schema + 当前值（**不含任何函数**） */
export interface PluginUiView {
  settings: PluginSettingView[]
  panels: UiPanel[]
  /** 它注册了哪些界面；只有数据（服务端从 `UiSurfaceDeclaration` 上剥掉函数后得到） */
  surfaces: PluginSurfaceView[]
  icon?: string
}

/** 服务端给前端的块（就是契约里的 `PluginBlock`，这里转出一份别名方便就近引用） */
export type UiBlockView = PluginBlock

/** `POST /api/plugins/config` 的请求体 */
export interface PluginConfigInput {
  /** 插件 id（= 入口文件绝对路径，与 `GET /api/plugins` 里的一致） */
  id: string
  /**
   * 要写的设置项（**增量**：只写这里出现的键）。
   *
   * `null` = 清空该项；密钥项传空串 = **不改**（界面上留空表示「保持原值」，因为明文
   * 根本不在浏览器手里，没法回传）。没声明过的键会被服务端丢掉。
   */
  values: Record<string, string | number | boolean | null>
}

const SETTING_TYPES = new Set<UiSettingType>(['boolean', 'string', 'number', 'select'])

export class UiService extends Service {
  private readonly _settings = new Map<string, UiSettingItem>()
  private readonly _panels = new Map<string, UiPanel>()
  /** key = `${kind}:${id}`（同一个插件内，同类面的 id 唯一） */
  private readonly _surfaces = new Map<string, UiSurfaceDeclaration>()
  private _icon?: string

  constructor(ctx: Context) {
    super(ctx)
  }

  get name(): string {
    return 'ui'
  }

  /**
   * 声明插件图标（列表里显示在名字前面）。
   *
   * 必须是 **`data:image/*` 的 data URI**（为什么只收这个形状见 `ICON_RE` 的说明）；
   * 形状不对 / 太大**当场抛错**（错误显示在插件列表顶部），免得界面上出现一个破图。
   *
   * ```ts
   * ctx.ui.icon('data:image/png;base64,iVBORw0KGgo…')
   * ```
   */
  icon(dataUri: string): Dispose {
    if (typeof dataUri !== 'string' || !ICON_RE.test(dataUri)) {
      throw new Error(
        'ctx.ui.icon 只接受 data:image/* 的 data URI（不收远程 URL，也不收裸 SVG 源码）'
      )
    }
    if (dataUri.length > MAX_ICON_CHARS) {
      throw new Error(
        `ctx.ui.icon 太大了（${Math.round(dataUri.length / 1024)}KB > ${MAX_ICON_CHARS / 1024}KB）：` +
          '先缩一下图（列表里最大也就 32px 展示）'
      )
    }
    this._icon = dataUri
    return this.bind(() => {
      if (this._icon === dataUri) this._icon = undefined
    })
  }

  /** 声明的图标（没声明 = undefined） */
  get iconValue(): string | undefined {
    return this._icon
  }

  /**
   * 声明一个设置项。形状不对**当场抛错**（装配期大声报错，好过用户对着一个空白的设置项
   * 猜）：缺 id / type 不认识 / select 没给候选都会在这里被拦下，错误会显示在插件列表顶部。
   */
  setting(item: UiSettingItem): Dispose {
    if (!item?.id || typeof item.id !== 'string' || /\s/.test(item.id)) {
      throw new Error('ctx.ui.setting 需要一个非空、不含空白的 id（它同时是 config 里的键名）')
    }
    if (!SETTING_TYPES.has(item.type)) {
      throw new Error(
        `设置项「${item.id}」的 type 不认识：${String(item.type)}（只能是 boolean / string / number / select）`
      )
    }
    if (item.type === 'select' && (!Array.isArray(item.options) || item.options.length === 0)) {
      throw new Error(`设置项「${item.id}」是 select，但没有给 options`)
    }
    this._settings.set(item.id, item)
    return this.bind(() => {
      if (this._settings.get(item.id) === item) this._settings.delete(item.id)
    })
  }

  settings(): UiSettingItem[] {
    return [...this._settings.values()]
  }

  panel(panel: UiPanel): Dispose {
    if (!panel?.id || typeof panel.id !== 'string') {
      throw new Error('ctx.ui.panel 需要一个非空的 id')
    }
    this._panels.set(panel.id, panel)
    return this.bind(() => {
      if (this._panels.get(panel.id) === panel) this._panels.delete(panel.id)
    })
  }

  panels(): UiPanel[] {
    return [...this._panels.values()]
  }

  // ---------- 三个界面注册面 ----------

  /**
   * 注册一个「出内容的面」：`kind` 是 `sider`（侧栏）或 `view`（主视图区的一个标签页）。
   * 见下面 `sider` / `view` 两个薄封装。
   */
  private surface(kind: 'sider' | 'view', spec: UiSurfaceSpec): Dispose {
    const id = typeof spec?.id === 'string' ? spec.id.trim() : ''
    if (!id || /\s/.test(id)) {
      throw new Error(`ctx.ui.${kind} 需要一个非空、不含空白的 id`)
    }
    if (typeof spec.render !== 'function') {
      throw new Error(
        `界面「${id}」（${kind}）没有 render 方法：` +
          'render 必须在**服务端**跑并返回一串块（{ kind: ... }[]），这正是「插件不写 React」的落点'
      )
    }
    if (spec.onAction !== undefined && typeof spec.onAction !== 'function') {
      throw new Error(`界面「${id}」（${kind}）的 onAction 不是函数`)
    }
    this.checkIcon(spec.icon, `界面「${id}」`)

    const key = `${kind}:${id}`
    const decl: UiSurfaceDeclaration = {
      kind,
      id,
      title: String(spec.title ?? id).trim() || id,
      ...(spec.icon ? { icon: spec.icon } : {}),
      ...(Array.isArray(spec.headerActions) && spec.headerActions.length
        ? { headerActions: spec.headerActions }
        : {}),
      ...(typeof spec.onAction === 'function' ? { onAction: spec.onAction } : {}),
      render: spec.render
    }
    return this.put(key, decl)
  }

  /**
   * **已废弃**：以前在左侧图标栏里加一颗，现在图标栏只有统一的一颗「插件」。
   *
   * 声明仍然生效（`opens` 会被「插件」列表当作默认面参考），但**不会再出现在图标栏**。
   * 新插件不要调用：插件图标写在 `plugin.json` 的 `icon`（或 `ctx.ui.icon()`）里，
   * 内容面只声明 `view()`。
   */
  activityBar(item: UiActivityBarItem): Dispose {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (!id || /\s/.test(id)) {
      throw new Error('ctx.ui.activityBar 需要一个非空、不含空白的 id')
    }
    if (item.opens !== undefined && !/^(sider|view):\S+$/.test(item.opens)) {
      throw new Error(
        `图标栏项「${id}」的 opens 写法不对：${String(item.opens)} —— 要写成 'sider:<面id>' 或 'view:<面id>'`
      )
    }
    this.checkIcon(item.icon, `图标栏项「${id}」`)

    const decl: UiSurfaceDeclaration = {
      kind: 'activityBar',
      id,
      title: String(item.title ?? id).trim() || id,
      ...(item.icon ? { icon: item.icon } : {}),
      ...(typeof item.order === 'number' && Number.isFinite(item.order) ? { order: item.order } : {}),
      ...(item.opens ? { opens: item.opens } : {})
    }
    return this.put(`activityBar:${id}`, decl)
  }

  /**
   * **已废弃**：以前是图标栏右边那一列的内容，现在没有插件自己的侧栏了。
   *
   * 老插件声明的 sider 面会作为**标签页**出现在「插件」列表里（点插件默认打开它），
   * 所以不会点了没反应；新插件请用 `view()`。
   */
  sider(spec: UiSurfaceSpec): Dispose {
    return this.surface('sider', spec)
  }

  /** 主视图区里的一个**标签页** */
  view(spec: UiSurfaceSpec): Dispose {
    return this.surface('view', spec)
  }

  /** 声明的界面（三类混在一起，按注册顺序） */
  surfaces(): UiSurfaceDeclaration[] {
    return [...this._surfaces.values()]
  }

  /** 按 key 取一个面（服务端渲染 / 处理动作时用） */
  surfaceByKey(key: string): UiSurfaceDeclaration | undefined {
    return this._surfaces.get(key)
  }

  /** 图标形状校验（`icon()` / 各面上的 `icon` 共用同一条规矩） */
  private checkIcon(icon: unknown, what: string): void {
    if (icon === undefined) return
    if (typeof icon !== 'string' || !ICON_RE.test(icon)) {
      throw new Error(
        `${what} 的 icon 只接受 data:image/* 的 data URI（不收远程 URL，也不收裸 SVG 源码）`
      )
    }
    if (icon.length > MAX_ICON_CHARS) {
      throw new Error(
        `${what} 的 icon 太大了（${Math.round(icon.length / 1024)}KB > ${MAX_ICON_CHARS / 1024}KB）：先缩一下图`
      )
    }
  }

  /**
   * 放进注册表。**同类同 id 重复注册不覆盖**（与 `UploadsService` 同一取舍）：
   * 界面是用户能看见的东西，「谁盖谁」都不该静默发生 —— 保留先注册的，只告警。
   */
  private put(key: string, decl: UiSurfaceDeclaration): Dispose {
    const existing = this._surfaces.get(key)
    if (existing) {
      this.ctx.logger.warn(`[ui] 界面 key 重复：「${key}」已注册过（${existing.title}），忽略这次声明`)
      return () => {}
    }
    this._surfaces.set(key, decl)
    return this.bind(() => {
      if (this._surfaces.get(key) === decl) this._surfaces.delete(key)
    })
  }
}
