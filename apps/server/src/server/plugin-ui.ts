/**
 * 插件界面的运行时：**列出所有面 / 渲染一面 / 处理一个动作**。
 *
 * ## 为什么是「一次性挂载」而不是长驻 context
 *
 * 插件声明的三个面（`ctx.ui.activityBar` / `sider` / `view`）都带 `render` / `onAction`
 * 回调，那些是**插件自己的闭包**（里面是它的 config、凭据、连接）。长驻 context 要解决
 * 「文件改了 / 设置改了就重建」的缓存失效问题（上传源那套 registry 就是这么做的），
 * 而这里**每次请求现挂一次**就够了：
 *
 * - 挂载只是「跑一遍 apply + 读注册表」，jiti 的模块缓存在进程级（热重载照样生效）；
 * - 免掉一整套指纹 / 重建 / 并发去重的代码，也就不会留下「什么时候该重建」的坑；
 * - 界面内容是**每次都要重算**的（Redis 状态、端口扫描结果…），本来就不该缓存。
 *
 * ## 安全边界：凡是出网的内容都不带函数，且**只留认识的字段**
 *
 * 插件是第三方代码，它 `render()` 出来的东西一律当成**不可信输入**：
 * - 只认 `UiBlock` 里那几种 `kind`，其它丢掉；
 * - 每个字段都收敛成字符串（不往前端送对象 / 不送任意嵌套结构）；
 * - 数量封顶（块数 / 列表项数），免得一屏内容把请求体拖到几兆。
 *
 * 这样即便插件写坏了，界面上出现的也只是一块「内容不认识」的提示，而不是白屏或注入。
 */
import {
  HooksService,
  PromptService,
  RpcService,
  ToolsService,
  UiService,
  UploadsService,
  ModelsService,
  createAppContext
} from '@fizz/plugin'
import { loadPluginModule } from '@fizz/plugin/loader'
import type { PluginDescriptor, UiSurfaceDeclaration } from '@fizz/plugin'
import type {
  PluginBlock,
  PluginBlockTone,
  PluginFormField,
  PluginItemAction,
  PluginSurfaceActionResult,
  PluginSurfaceContent,
  PluginSurfaceView,
  PluginToast
} from '@fizz/contracts/agent-api'
import { clientBundleRev, discoverServerPlugins, surfaceKeyOf, withRuntimeConfig } from './plugin-roots'
import { domain } from './state'

/** 一个面的坐标：哪个插件 + 哪一类 + 哪个 id（+ 可选参数：同一个面可以开多份） */
export interface SurfaceRef {
  pluginId: string
  kind: UiSurfaceDeclaration['kind']
  id: string
  /**
   * 面的参数（如「哪个连接」）。宿主把它原样带回 `render(ctx)` / `onAction({…})`，
   * 于是**一个面能同时开多个标签页**（一个连接一页）。这是纯数据，与前端 key 无关。
   */
  params?: Record<string, string | number | boolean>
}

/** `render` / `onAction` 的超时：插件吊死不能把请求挂住（界面会转圈） */
const CALL_TIMEOUT_MS = Number(process.env.FIZZ_PLUGIN_UI_TIMEOUT_MS ?? 10_000)
/**
 * RPC 的超时比界面长得多：界面只是画一下，RPC 往往真在干活（查一次数据库、跑一次命令）。
 * 10s 会把「慢但正常」的调用判死，用户看到的是「插件坏了」。
 */
const RPC_TIMEOUT_MS = Number(process.env.FIZZ_PLUGIN_RPC_TIMEOUT_MS ?? 60_000)
/** 一屏最多多少个块 */
const MAX_BLOCKS = 200
/** 一个列表块最多多少项（超了截断，并在块上标出来） */
const MAX_LIST_ITEMS = 500
/** 文本字段的单条长度上限 */
const MAX_TEXT = 2000

const TONES: PluginBlockTone[] = ['normal', 'muted', 'success', 'warn', 'danger']

/** 收敛成字符串（不可信输入：什么都不信，长度也砍一刀） */
function str(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, MAX_TEXT)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function tone(value: unknown): PluginBlockTone | undefined {
  return typeof value === 'string' && (TONES as string[]).includes(value)
    ? (value as PluginBlockTone)
    : undefined
}

/**
 * 清洗随块一起来的**动作参数**（不可信输入：只留标量，键名与长度都封顶）。
 *
 * 与路由里那份是同一个口径（`surfaces/action/route.ts`），这里再实现一次是因为块里的
 * `args` 根本不过那条路由 —— 各写一遍，总比把参数原样塞进插件的 `onAction` 强。
 */
function cleanArgs(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= 20) break
    if (typeof raw === 'string') out[key.slice(0, 100)] = raw.slice(0, 500)
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key.slice(0, 100)] = raw
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 上面那个清洗函数的**导出别名**：两条路由（清单/渲染、动作）都要洗一遍，
 * 各写一份迟早出现「这边洗了那边没洗」的偏差 —— 用同一份。
 */
export { cleanArgs as cleanSurfaceParams }

/**
 * 把插件 `render()` 的返回值收敛成能发往浏览器的块。
 *
 * 不认识的 `kind` **直接丢**（不报错、不整屏失败）：插件写错一块内容，不该让整个面消失。
 */
function normalizeBlocks(raw: unknown): PluginBlock[] {
  if (!Array.isArray(raw)) return []
  const out: PluginBlock[] = []
  for (const item of raw.slice(0, MAX_BLOCKS)) {
    const block = item as Record<string, unknown> | null
    if (!block || typeof block !== 'object') continue
    switch (block.kind) {
      case 'text': {
        const text = str(block.text)
        if (!text) break
        out.push({ kind: 'text', text, ...(tone(block.tone) ? { tone: tone(block.tone)! } : {}), ...(block.mono ? { mono: true } : {}) })
        break
      }
      case 'kv': {
        const rows = Array.isArray(block.rows) ? block.rows : []
        out.push({
          kind: 'kv',
          ...(str(block.label) ? { label: str(block.label) } : {}),
          rows: rows.slice(0, MAX_LIST_ITEMS).map((row) => {
            const r = (row ?? {}) as Record<string, unknown>
            return {
              label: str(r.label),
              value: str(r.value),
              ...(tone(r.tone) ? { tone: tone(r.tone)! } : {})
            }
          })
        })
        break
      }
      case 'list': {
        const items = Array.isArray(block.items) ? block.items : []
        const truncated = items.length > MAX_LIST_ITEMS
        out.push({
          kind: 'list',
          ...(str(block.label) ? { label: str(block.label) } : {}),
          items: items.slice(0, MAX_LIST_ITEMS).map((entry, index) => {
            const e = (entry ?? {}) as Record<string, unknown>
            const id = str(e.id) || String(index)
            return {
              id,
              label: str(e.label) || id,
              ...(str(e.detail) ? { detail: str(e.detail) } : {}),
              ...(str(e.badge) ? { badge: str(e.badge) } : {}),
              ...(tone(e.tone) ? { tone: tone(e.tone)! } : {}),
              ...(str(e.actionId) ? { actionId: str(e.actionId) } : {}),
              ...(cleanArgs(e.args) ? { args: cleanArgs(e.args)! } : {}),
              // 行尾的图标按钮：图标只认白名单里的名字（ITEM_ICONS），其它一律丢弃
              ...(cleanItemActions(e.actions) ? { actions: cleanItemActions(e.actions)! } : {})
            }
          }),
          ...(truncated
            ? {}
            : {})
        })
        // 截断时补一条说明（作为 note 跟在后面，前端照常渲染）
        if (truncated) {
          out.push({ kind: 'note', text: `列表过长，只显示前 ${MAX_LIST_ITEMS} 项。`, tone: 'muted' })
        }
        break
      }
      case 'buttons': {
        const items = Array.isArray(block.items) ? block.items : []
        const buttons = items
          .slice(0, 50)
          .map((entry) => {
            const e = (entry ?? {}) as Record<string, unknown>
            const actionId = str(e.actionId)
            const label = str(e.label) || actionId
            if (!actionId) return null
            const args: Record<string, string | number | boolean> = {}
            if (e.args && typeof e.args === 'object') {
              for (const [k, v] of Object.entries(e.args as Record<string, unknown>)) {
                if (typeof v === 'string') args[k] = v.slice(0, 500)
                else if (typeof v === 'number' || typeof v === 'boolean') args[k] = v
              }
            }
            return { actionId, label, ...(Object.keys(args).length ? { args } : {}) }
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
        if (buttons.length) out.push({ kind: 'buttons', items: buttons })
        break
      }
      case 'note': {
        const text = str(block.text)
        if (!text) break
        out.push({ kind: 'note', text, ...(tone(block.tone) ? { tone: tone(block.tone)! } : {}) })
        break
      }
      case 'input': {
        const actionId = str(block.actionId)
        // 没有 actionId 的输入框点了也没人接 —— 不如不画（避免出现一个死控件）
        if (!actionId) break
        out.push({
          kind: 'input',
          id: str(block.id) || 'value',
          actionId,
          ...(str(block.label) ? { label: str(block.label) } : {}),
          ...(str(block.placeholder) ? { placeholder: str(block.placeholder) } : {}),
          ...(str(block.value) ? { value: str(block.value) } : {}),
          ...(str(block.submitLabel) ? { submitLabel: str(block.submitLabel) } : {})
        })
        break
      }
      case 'form': {
        const actionId = str(block.actionId)
        if (!actionId) break
        const fields = cleanFields(block.fields)
        // 一个字段都没有的表单 = 一个点不动的死控件，不画
        if (fields)
          out.push({
            kind: 'form',
            fields,
            actionId,
            ...(str(block.label) ? { label: str(block.label) } : {}),
            ...(str(block.submitLabel) ? { submitLabel: str(block.submitLabel) } : {})
          })
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * 挂一个插件、返回一个「能干活」的句柄。
 *
 * 服务**全给齐**（tools / prompt / hooks / ui / uploads）：插件的 `inject` 声明了其中某个
 * 却被推迟的话，`apply` 就不会跑，界面声明也就收不到（与 `inspectPluginUi` 同一取舍）。
 */
async function mountOnce(pluginId: string, workspaceId?: string) {
  const workspace = workspaceId ? domain.getWorkspace(workspaceId) : undefined
  const all = await discoverServerPlugins({
    workspaceId,
    workspacePath: workspace?.path
  })
  const descriptor = all.find((p) => p.id === pluginId)
  if (!descriptor) {
    throw new Error(`找不到插件 ${pluginId}（可能已被删除 / 停用，或不在当前作用域里）`)
  }
  const mounted = await mountDescriptor(descriptor, workspace?.path)
  return { ...mounted, workspacePath: workspace?.path }
}

/**
 * 按**已解析好的描述符**挂一次插件（RPC 与界面两条路共用）。
 *
 * 服务全给齐（tools / prompt / hooks / ui / uploads / models / rpc）：插件的 `inject`
 * 声明了其中某个却被推迟的话，`apply` 就不会跑，注册表也就是空的。
 */
async function mountDescriptor(descriptor: PluginDescriptor, workspacePath?: string) {
  const [withConfig] = withRuntimeConfig([descriptor])
  const plugin = await loadPluginModule(descriptor.file)

  const ctx = createAppContext(`plugin-ui:${descriptor.name}`)
  ctx.set('tools', new ToolsService(ctx))
  ctx.set('prompt', new PromptService(ctx))
  ctx.set('hooks', new HooksService(ctx))
  const ui = new UiService(ctx)
  ctx.set('ui', ui)
  ctx.set('uploads', new UploadsService(ctx))
  ctx.set('models', new ModelsService(ctx))
  const rpc = new RpcService(ctx)
  ctx.set('rpc', rpc)
  const fork = ctx.plugin(plugin, withConfig.config)
  return {
    ctx,
    fork,
    ui,
    rpc,
    descriptor,
    name: descriptor.name,
    workspacePath
  }
}

/**
 * 调一次插件注册的 RPC 方法（`ctx.rpc.handle`）。
 *
 * 与界面同一套生命周期：**每次请求现挂一次**（见文件头的说明），调用完就拆。
 * 拆分口径：方法不存在 → `notFound`（路由映射 404）；处理器抛错 → `error`（映射 400，
 * 原话回给前端 —— 插件写的「请先配置 API key」要能被用户看见）。
 */
export async function invokePluginRpc(opts: {
  pluginId: string
  method: string
  payload?: unknown
  workspaceId?: string
}): Promise<{ ok: true; data: unknown } | { ok: false; status: 404 | 400; error: string }> {
  let mounted: Awaited<ReturnType<typeof mountDescriptor>> | null = null
  try {
    const workspace = opts.workspaceId ? domain.getWorkspace(opts.workspaceId) : undefined
    const all = await discoverServerPlugins({
      workspaceId: opts.workspaceId,
      workspacePath: workspace?.path
    })
    const descriptor = all.find((p) => p.id === opts.pluginId)
    if (!descriptor) {
      return { ok: false, status: 404, error: `找不到插件 ${opts.pluginId}（可能已被删除 / 停用）` }
    }
    if (!descriptor.enabled) {
      return { ok: false, status: 404, error: `插件「${descriptor.name}」已停用，先在设置里开启它` }
    }
    mounted = await mountDescriptor(descriptor, workspace?.path)
    if (!mounted.rpc.methods().length) {
      return {
        ok: false,
        status: 404,
        error: `插件「${descriptor.name}」没有注册任何 RPC 方法（服务端半要写 ctx.rpc.handle(...)）`
      }
    }
    const data = await withTimeout(
      'rpc',
      Promise.resolve(
        mounted.rpc.invoke(opts.method, opts.payload, {
          ...(workspace?.path ? { workspacePath: workspace.path } : {}),
          origin: 'surface'
        })
      ),
      RPC_TIMEOUT_MS
    )
    return { ok: true, data: data ?? null }
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (mounted) {
      await mounted.fork.dispose().catch(() => undefined)
      await mounted.ctx.dispose().catch(() => undefined)
    }
  }
}

/** 行尾图标按钮允许的图标名（与契约里的 `PluginItemIcon` 同一份白名单） */
const ITEM_ICONS = new Set([
  'pencil',
  'trash',
  'copy',
  'play',
  'pause',
  'plug',
  'unplug',
  'refresh',
  'external',
  'info',
  'terminal',
  'star',
  'plus'
])

/** 清洗行尾图标按钮：图标名不在白名单里的直接丢，每行封顶 5 个 */
function cleanItemActions(value: unknown): PluginItemAction[] | undefined {
  const raw = Array.isArray(value) ? value : []
  const actions = raw
    .slice(0, 5)
    .map((entry) => {
      const a = (entry ?? {}) as Record<string, unknown>
      const actionId = str(a.actionId).slice(0, 200)
      const icon = str(a.icon).slice(0, 40)
      if (!actionId || !ITEM_ICONS.has(icon)) return null
      const args = cleanArgs(a.args)
      return {
        actionId,
        icon: icon as PluginItemAction['icon'],
        label: str(a.label).slice(0, 200) || icon,
        ...(args ? { args } : {}),
        ...(a.danger ? { danger: true } : {})
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  return actions.length ? actions : undefined
}

/**
 * 清洗一组表单字段（`form` 块与「弹个对话框」共用一套口径）。
 *
 * 只留 `id` + 可选的展示属性；字段数封顶 20，字符串按 `str()` 封顶。
 * 一个有效字段都没有就返回 undefined —— 那是个点不动的死控件，不画。
 */
function cleanFields(value: unknown): PluginFormField[] | undefined {
  const raw = Array.isArray(value) ? value : []
  const fields = raw
    .slice(0, 20)
    .map((entry) => {
      const f = (entry ?? {}) as Record<string, unknown>
      const id = str(f.id)
      if (!id) return null
      return {
        id,
        ...(str(f.label) ? { label: str(f.label) } : {}),
        ...(str(f.placeholder) ? { placeholder: str(f.placeholder) } : {}),
        ...(str(f.value) ? { value: str(f.value) } : {}),
        ...(f.secret ? { secret: true } : {}),
        ...(f.multiline ? { multiline: true } : {})
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  return fields.length ? fields : undefined
}

/**
 * 「请宿主弹一个对话框」的清洗（不可信输入：标题 / 提交动作 / 字段三者缺一就不弹）。
 */
function cleanOpenDialog(value: unknown): PluginSurfaceActionResult['openDialog'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const title = str(raw.title).slice(0, 200)
  const actionId = str(raw.actionId).slice(0, 200)
  // 没有字段是**合法**的：那就是一个纯确认框（标题 + 说明 + 确认/取消）。
  // 「删除这条连接」用它，不必为了凑字段塞一个假的输入框。
  const fields = cleanFields(raw.fields)
  if (!title || !actionId) return undefined
  return {
    title,
    actionId,
    ...(fields ? { fields } : {}),
    ...(str(raw.description) ? { description: str(raw.description) } : {}),
    ...(str(raw.submitLabel) ? { submitLabel: str(raw.submitLabel) } : {}),
    ...(str(raw.cancelLabel) ? { cancelLabel: str(raw.cancelLabel) } : {})
  }
}

/**
 * 「请宿主开一个标签页」的清洗（不可信输入：只要 id 与标量参数，字符串都封顶）。
 *
 * 为什么要有这个口子：块的语义里没有「开标签」这种东西 —— 那是宿主的能力。插件只能
 * **请求**（`onAction` 返回 `openView`），宿主照办。少了它，侧栏里就开不出
 * 「每个连接一个管理页」这种最自然的形态。
 */
function cleanOpenView(value: unknown): PluginSurfaceActionResult['openView'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const surfaceId = str(raw.surfaceId).slice(0, 100)
  if (!surfaceId) return undefined
  const params = cleanArgs(raw.params)
  return {
    surfaceId,
    ...(params ? { params } : {}),
    ...(str(raw.label) ? { label: str(raw.label) } : {}),
    ...(str(raw.title) ? { title: str(raw.title) } : {})
  }
}

/**
 * toast 收集器（这次请求专属）：插件在 render / onAction 里调 `toast(...)`，
 * 攒下来的随这一次响应一起带回。**封顶 5 条** —— 弹十几条 toast 是插件写坏了。
 */
function toastCollector(): { fn: (message: unknown, kind?: unknown) => void; drain: () => PluginToast[] } {
  const toasts: PluginToast[] = []
  return {
    fn: (message, kind) => {
      if (toasts.length >= 5) return
      const text = str(message)
      if (!text) return
      const allowed = new Set(['success', 'error', 'info', 'warning'])
      const k = typeof kind === 'string' && allowed.has(kind) ? (kind as PluginToast['kind']) : undefined
      toasts.push({ message: text.slice(0, 500), ...(k ? { kind: k } : {}) })
    },
    drain: () => toasts
  }
}

/** 给 `render` / `onAction` 的上下文（刻意很小：插件真正需要的都在它自己的闭包里） */
function renderContextOf(
  mounted: Awaited<ReturnType<typeof mountOnce>>,
  workspaceId?: string,
  params?: Record<string, string | number | boolean>,
  toast?: (message: unknown, kind?: unknown) => void
) {
  return {
    workspacePath: mounted.workspacePath,
    workspaceId,
    // 这一面是哪个参数开的（一个连接 / 一台主机…）；没用参数的面拿不到这个字段
    ...(params ? { params } : {}),
    ...(toast ? { toast } : {}),
    logger: {
      warn: (...args: unknown[]) => console.warn(`[plugin-ui:${mounted.name}]`, ...args),
      error: (...args: unknown[]) => console.error(`[plugin-ui:${mounted.name}]`, ...args)
    }
  }
}

/** 带超时地跑一个插件回调（插件是自己写的代码，吊死要能兜住） */
async function withTimeout<T>(
  label: string,
  run: Promise<T>,
  timeoutMs: number = CALL_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（>${timeoutMs}ms）`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 列出当前可见插件注册的所有界面。
 *
 * 只列**已启用**的（停用的插件不该出现在插件列表里，与上传源同一取舍）。
 * 单个插件加载失败只进 `errors`，不影响其它插件 —— 界面清单挂掉比它慢更糟。
 */
export async function listPluginSurfaces(opts: {
  workspaceId?: string
}): Promise<{ surfaces: PluginSurfaceView[]; errors: string[] }> {
  const workspaceId = opts.workspaceId || undefined
  const workspace = workspaceId ? domain.getWorkspace(workspaceId) : undefined
  const all = await discoverServerPlugins({
    workspaceId,
    workspacePath: workspace?.path
  })
  const enabled = withRuntimeConfig(all.filter((p) => p.enabled))
  const surfaces: PluginSurfaceView[] = []
  const errors: string[] = []

  for (const item of enabled) {
    const ctx = createAppContext(`plugin-ui:list:${item.name}`)
    ctx.set('tools', new ToolsService(ctx))
    ctx.set('prompt', new PromptService(ctx))
    ctx.set('hooks', new HooksService(ctx))
    const ui = new UiService(ctx)
    ctx.set('ui', ui)
    ctx.set('uploads', new UploadsService(ctx))
    ctx.set('models', new ModelsService(ctx))
    ctx.set('rpc', new RpcService(ctx))
    try {
      const plugin = await loadPluginModule(item.file)
      const fork = ctx.plugin(plugin, item.config)
      /**
       * 显示名优先用**插件自己声明的** `name`：文件发现的 `item.name` 只是文件名
       * （`demo.ts` → `demo`），而插件里常写中文名（「演示插件」）。函数式插件没有
       * 声明名，`plugin.name` 会是函数名，也够用。
       */
      const declared = (plugin as { name?: unknown } | null)?.name
      const pluginName = typeof declared === 'string' && declared ? declared : item.name
      /**
       * 插件级图标：清单里写的优先（静态、不用跑插件就能得到），否则用插件在
       * `apply()` 里 `ctx.ui.icon(...)` 声明的那一个。
       *
       * 它只给「插件」侧栏的列表行用（`PluginSurfaceView.pluginIcon`）；面自己的
       * `icon` 是另一回事，别混。
       */
      const pluginIcon = item.manifest.icon ?? ui.iconValue
      /**
       * 插件级信息（图标 / 说明 / 版本）**在每个面上都塞同一份**：侧栏列表行按插件分组的
       * 时候随便取一个面就够，不必再单独拉一次 `GET /api/plugins`（那条路只有设置页要，
       * 而且带着 config / 路径这些侧栏用不到的东西）。
       */
      const pluginMeta = {
        ...(pluginIcon ? { pluginIcon } : {}),
        ...(item.manifest.description ? { pluginDescription: item.manifest.description } : {}),
        ...(item.manifest.version ? { pluginVersion: item.manifest.version } : {})
      }
      for (const decl of ui.surfaces()) {
        surfaces.push({
          key: surfaceKeyOf(item.id, decl),
          pluginId: item.id,
          pluginName,
          kind: decl.kind,
          id: decl.id,
          title: decl.title,
          ...(decl.icon ? { icon: decl.icon } : {}),
          ...pluginMeta,
          order: typeof decl.order === 'number' ? decl.order : 0,
          ...(decl.opens ? { opens: decl.opens } : {}),
          hasAction: typeof decl.onAction === 'function',
          // 顶栏图标按钮：与列表行尾按钮共用同一份清洗（白名单图标 + 标量 args）
          ...(cleanItemActions(decl.headerActions) ? { headerActions: cleanItemActions(decl.headerActions)! } : {})
        })
      }
      /**
       * 前端半声明的面。清单只声明「我有哪些面」，bundle 只负责「怎么画」
       * （理由见 `PluginStaticSurface` 的注释：界面清单是服务端驱动的，
       *  两处注册会出现刷新前后顺序不同、加载失败时整段消失）。
       */
      const clientSurfaces = item.manifest.client?.surfaces ?? []
      if (clientSurfaces.length) {
        const clientRev = await clientBundleRev(item.clientFile)
        if (!clientRev) {
          errors.push(`${item.name}：plugin.json 声明了 client.surfaces，但 client.entry 文件不存在`)
        } else {
          for (const decl of clientSurfaces) {
            const clash = ui.surfaceByKey(`${decl.kind}:${decl.id}`)
            if (clash) {
              // 同一个面只能有一个渲染者：服务端已经注册了，前端半再声明一遍就是配置错误
              errors.push(
                `${item.name}：${decl.kind}/${decl.id} 同时由服务端半和前端半声明，只保留服务端那份`
              )
              continue
            }
            surfaces.push({
              key: surfaceKeyOf(item.id, decl),
              pluginId: item.id,
              pluginName,
              kind: decl.kind,
              id: decl.id,
              title: decl.title,
              ...(decl.icon ? { icon: decl.icon } : {}),
              ...pluginMeta,
              order: typeof decl.order === 'number' ? decl.order : 0,
              // 前端半自己画，没有服务端 headerActions / onAction
              hasAction: false,
              renderMode: 'client',
              clientRev
            })
          }
        }
      }
      await fork.dispose()
    } catch (err) {
      errors.push(`${item.name}（${item.file}）：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await ctx.dispose()
    }
  }

  // 稳定顺序：按 order（小在前）→ 插件名 → 面 id；同名同序时保持声明顺序。
  // 「点插件默认打开哪一面」也靠它（插件列表取该插件里 order 最小的面）
  surfaces.sort(
    (a, b) =>
      a.order - b.order ||
      a.pluginName.localeCompare(b.pluginName) ||
      a.id.localeCompare(b.id)
  )
  return { surfaces, errors }
}

/** 渲染一面（调插件的 `render`）。**不抛错**：失败变成 `error` 字段，界面上显示一条提示 */
export async function renderPluginSurface(opts: SurfaceRef & { workspaceId?: string }): Promise<PluginSurfaceContent> {
  const key = surfaceKeyOf(opts.pluginId, opts)
  const empty: PluginSurfaceContent = { key, blocks: [], renderedAt: Date.now() }
  let mounted: Awaited<ReturnType<typeof mountOnce>> | null = null
  try {
    mounted = await mountOnce(opts.pluginId, opts.workspaceId || undefined)
    const surface = mounted.ui.surfaceByKey(`${opts.kind}:${opts.id}`)
    if (!surface?.render) {
      /*
       * 前端半声明的面走的是「浏览器直接渲染」这条路，服务端**没有**它的 render。
       * 走到这里说明前端拿的是旧清单（或本不该发这个请求）—— 回一句话指路，
       * 比「插件没注册这个界面」这种像 bug 的文案有用得多。
       */
      const isClientSurface = mounted.descriptor.manifest.client?.surfaces?.some(
        (decl) => decl.kind === opts.kind && decl.id === opts.id
      )
      return {
        ...empty,
        error: isClientSurface
          ? `界面「${opts.id}」由插件的前端半渲染（renderMode: client），不该走服务端渲染`
          : `插件没注册这个界面（${opts.kind}:${opts.id}）`
      }
    }
    // 插件在 render 里 toast(...) 出来的提示：随这次响应一起带回
    const collected = toastCollector()
    const raw = await withTimeout(
      'render',
      Promise.resolve(
        surface.render(
          renderContextOf(mounted, opts.workspaceId || undefined, opts.params, collected.fn)
        )
      )
    )
    const toasts = collected.drain()
    return {
      key,
      blocks: normalizeBlocks(raw),
      ...(toasts.length ? { toasts } : {}),
      renderedAt: Date.now()
    }
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (mounted) {
      await mounted.fork.dispose().catch(() => undefined)
      await mounted.ctx.dispose().catch(() => undefined)
    }
  }
}

/**
 * 处理一面里的一个动作（点击 / 按钮）。
 *
 * 返回 `blocks` = 整面替换成它；不给 `blocks` = 前端自己重新拉一遍（多数插件写
 * 「改完状态就返回」比「返回新内容」省事）。
 */
export async function runPluginSurfaceAction(opts: SurfaceRef & {
  workspaceId?: string
  actionId: string
  args?: Record<string, string | number | boolean>
}): Promise<PluginSurfaceActionResult> {
  let mounted: Awaited<ReturnType<typeof mountOnce>> | null = null
  try {
    mounted = await mountOnce(opts.pluginId, opts.workspaceId || undefined)
    const surface = mounted.ui.surfaceByKey(`${opts.kind}:${opts.id}`)
    if (!surface) {
      return { error: `插件没注册这个界面（${opts.kind}:${opts.id}）` }
    }
    if (typeof surface.onAction !== 'function') {
      return { error: `界面「${surface.title}」没声明 onAction，处理不了动作 ${opts.actionId}` }
    }
    // 动作处理途中插件也可以 toast（error / warning / info…）
    const collected = toastCollector()
    const raw = await withTimeout(
      'onAction',
      Promise.resolve(
        surface.onAction({
          actionId: opts.actionId,
          ...(opts.args ? { args: opts.args } : {}),
          ...(opts.params ? { params: opts.params } : {}),
          toast: collected.fn
        })
      )
    )
    const toasts = collected.drain()
    // 一串块 = 整面替换（最常见的写法）
    if (Array.isArray(raw)) return { blocks: normalizeBlocks(raw), ...(toasts.length ? { toasts } : {}) }
    // 也能只说一句话 / 请求宿主开一个标签页
    if (raw && typeof raw === 'object') {
      const outcome = raw as {
        blocks?: unknown
        message?: unknown
        openView?: unknown
        /** 请求宿主弹一个对话框（新增 / 编辑一条配置这类交互） */
        openDialog?: unknown
      }
      const result: PluginSurfaceActionResult = {}
      if (Array.isArray(outcome.blocks)) result.blocks = normalizeBlocks(outcome.blocks)
      if (typeof outcome.message === 'string' && outcome.message) result.message = outcome.message.slice(0, 500)
      const openView = cleanOpenView(outcome.openView)
      if (openView) result.openView = openView
      const openDialog = cleanOpenDialog(outcome.openDialog)
      if (openDialog) result.openDialog = openDialog
      if (toasts.length) result.toasts = toasts
      return result
    }
    return toasts.length ? { toasts } : {}
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (mounted) {
      await mounted.fork.dispose().catch(() => undefined)
      await mounted.ctx.dispose().catch(() => undefined)
    }
  }
}
