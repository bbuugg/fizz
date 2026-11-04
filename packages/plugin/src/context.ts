/**
 * Context —— 插件框架的心脏（Cordis 风格的精简实现）。
 *
 * 一个 Context 是：
 * 1. **服务容器**：`get` / `set` / `has`，查找沿 parent 链向上（子能看见父的，父看不见子的）；
 * 2. **effect 作用域**：`effect(fn)` 登记的副作用在卸载时按 **LIFO 逆序回收**；
 * 3. **插件挂载点**：`plugin(p, cfg)` 为每个插件实例造一个**隔离子 Context（fiber）**并 apply，
 *    返回 `Fork`；`fork.dispose()` 回收该插件的一切；
 * 4. **依赖注入**：`inject(deps, cb)`（以及对象插件的 `inject`）在依赖齐全前**推迟**执行，
 *    依赖一旦被 `set` 提供就自动补跑 —— 所以挂载顺序无关紧要；
 * 5. **类型化事件总线**：`on` / `emit` / `waterfall` / `bail`，事件沿 parent 链**向上冒泡**；
 * 6. **生命周期**：`start()`（emit `ready`）/ `dispose()`（先拆子、再 emit `dispose`、最后 LIFO 回收）。
 *
 * 两层上下文用法（本仓库的实际用法）：
 * - **App Context**（长驻）：logger / storage / 插件发现加载器；
 * - `app.isolate('turn:<id>')` 派生的 **Turn Context**：挂 builtin 插件 + 每轮选中的插件，
 *   收尾 `turn.dispose()` —— 新一轮全部重建，互不污染。
 *
 * 隔离语义：`isolate()` 出来的子 Context **自带一套服务表与 effect 作用域**，
 * 但通过 parent 链仍能读到 App 层的长驻服务。这正是「每轮重建」实现的方式。
 */
import { Logger } from './logger'
import { bindEffect, withContext } from './scope'
import { EventsService } from './services/events'
import { PromptService } from './services/prompt'
import { ToolsService } from './services/tools'
import { UiService } from './services/ui'
import { UploadsService } from './services/uploads'
import { RpcService } from './services/rpc'
import { ModelsService } from './services/models'
import { WorkspaceService } from './services/workspace'
import { HooksService } from './hooks'
import type { Dispose, Listener, Plugin, PluginFunction, PluginObject } from './types'

interface EffectEntry {
  dispose: Dispose
}

/** 「等依赖」的挂起项（对象插件的 inject / `ctx.inject`） */
interface PendingEntry {
  ctx: Context
  inject?: string[]
  apply: () => void
}

/** 插件实例的运行句柄 */
export class Fork {
  constructor(private readonly parent: Context, readonly ctx: Context) {}

  get name(): string {
    return this.ctx.name
  }

  /** 卸载这个插件（幂等）：回收其 fiber 的一切 effect，并从父的挂起表里摘掉 */
  dispose(): Promise<void> {
    this.parent._dropPendingFor(this.ctx)
    return this.ctx.dispose()
  }
}

function isClass(fn: (...args: never[]) => unknown): boolean {
  return /^class[\s{]/.test(Function.prototype.toString.call(fn))
}

/** 把三种插件形态归一成对象形态 */
function normalizePlugin(plugin: Plugin): PluginObject {
  if (typeof plugin === 'function') {
    if (isClass(plugin as (...a: never[]) => unknown)) {
      const Cls = plugin as new (
        ctx: Context,
        config: unknown
      ) => { dispose?(): void | Promise<void> } | void
      return {
        name: (plugin as { name?: string }).name || 'plugin',
        apply: (ctx, config) => {
          const inst = new Cls(ctx, config)
          if (inst && typeof inst.dispose === 'function') return () => inst.dispose!()
        }
      }
    }
    const fn = plugin as PluginFunction
    return { name: fn.name || 'plugin', apply: fn }
  }
  if (plugin && typeof plugin === 'object' && typeof (plugin as PluginObject).apply === 'function') {
    return plugin as PluginObject
  }
  throw new Error('无效的插件：需要函数、类或 { apply } 对象')
}

function applyPlugin(ctx: Context, plugin: PluginObject, config: unknown): void {
  // withContext：让插件 apply 期间登记的工具 / 提示词 / 监听器都记到本 fiber 头上
  const result = withContext(ctx, () => plugin.apply(ctx, config))
  if (typeof result === 'function') ctx._pushEffect(result)
}

export class Context {
  private readonly _services = new Map<string, unknown>()
  private readonly _effects: EffectEntry[] = []
  private readonly _listeners = new Map<string, Set<Listener>>()
  private readonly _children = new Set<Context>()
  private _pending: PendingEntry[] = []
  private _logger?: Logger
  private _events?: EventsService
  private _disposed = false

  constructor(
    readonly parent: Context | null = null,
    readonly name = 'root'
  ) {
    parent?._children.add(this)
  }

  get disposed(): boolean {
    return this._disposed
  }

  /** 树的根（App Context） */
  get root(): Context {
    return this.parent ? this.parent.root : this
  }

  // ---------- 服务容器 ----------

  has(name: string): boolean {
    if (name === 'logger' || name === 'events') return true
    if (this._services.has(name)) return true
    return this.parent ? this.parent.has(name) : false
  }

  get<T = unknown>(name: string): T | undefined {
    // 内建：logger / events 恒可用（按本 Context 现造，故带上下文位置语义）
    if (name === 'logger') return this.logger as unknown as T
    if (name === 'events') return this.events as unknown as T
    if (this._services.has(name)) return this._services.get(name) as T
    return this.parent ? this.parent.get<T>(name) : undefined
  }

  /** 提供服务（并登记一条 effect：卸载时自动摘除）；返回提前摘除的 disposer */
  set<T>(name: string, value: T): Dispose {
    this._services.set(name, value)
    // 在插件 apply 期间调的 set 记到该插件 fiber 上，否则记到本 Context
    const dispose = bindEffect(this, () => {
      if (this._services.get(name) === value) this._services.delete(name)
    })
    // 可能有插件正等着这个依赖
    this.root._flushPending()
    return dispose
  }

  get logger(): Logger {
    if (!this._logger) this._logger = new Logger(this.name, this.parent?.logger)
    return this._logger
  }

  get events(): EventsService {
    if (!this._events) this._events = new EventsService(this)
    return this._events
  }

  /** 工具注册表（未提供时抛错：说明这轮没建 turn context） */
  get tools(): ToolsService {
    const s = this.get<ToolsService>('tools')
    if (!s) throw new Error('tools 服务未提供：请先 ctx.set("tools", new ToolsService(ctx))')
    return s
  }

  get prompt(): PromptService {
    const s = this.get<PromptService>('prompt')
    if (!s) throw new Error('prompt 服务未提供：请先 ctx.set("prompt", new PromptService(ctx))')
    return s
  }

  get ui(): UiService {
    const s = this.get<UiService>('ui')
    if (!s) throw new Error('ui 服务未提供：请先 ctx.set("ui", new UiService(ctx))')
    return s
  }

  /**
   * 模型配置注册表（`ctx.models`）。
   *
   * ⚠️ 只有**收集全局模型配置的 context** 才提供它（服务端启动 / 模型列表刷新时建的那份）。
   * 回合 context 上也给了一份：插件顶层 `inject: ['models']` 不会被推迟（否则它在回合里
   * 干脆不 apply，工具 / 提示词一起消失），但**工作区级插件注册的模型不会进设置页** ——
   * 模型列表是全局的，见 `services/models.ts` 的说明。
   */
  get models(): ModelsService {
    const s = this.get<ModelsService>('models')
    if (!s) throw new Error('models 服务未提供：请先 ctx.set("models", new ModelsService(ctx))')
    return s
  }

  /**
   * 上传源注册表（`ctx.uploads`）。
   *
   * ⚠️ 只有**长驻的 upload context**（`apps/server/src/server/upload/registry.ts` 建的）才有它 ——
   * 上传发生在「还没有回合」的时候，turn context 上**刻意不提供**它。所以回合里的插件要想用
   * 上传源，得写 `inject: ['uploads']`：依赖不齐时框架会**推迟挂载**（那个回合里它干脆不 apply，
   * 既不报错也不白跑），而不是让 `ctx.uploads.register` 撞一个 undefined。
   *
   * 没提供时这里抛错（与 tools / prompt 同款）：真走到了说明宿主漏建了这个能力，
   * 报错比「静默什么都不做」好查。
   */
  get uploads(): UploadsService {
    const s = this.get<UploadsService>('uploads')
    if (!s) {
      throw new Error(
        'uploads 服务未提供：这个 context 没有上传能力（上传源注册只挂在长驻 upload context 上，' +
          '回合里请用 inject: ["uploads"] 声明依赖）'
      )
    }
    return s
  }

  /** 钩子总线（未提供时抛错：说明这轮没建 turn context） */
  get hooks(): HooksService {
    const s = this.get<HooksService>('hooks')
    if (!s) throw new Error('hooks 服务未提供：请先 ctx.set("hooks", new HooksService(ctx))')
    return s
  }

  /**
   * 插件 RPC（前端半拿数据的通道，见 `services/rpc.ts`）。
   *
   * 只挂在**长驻 context** 上（与 uploads 同级）：前端可能在任意时刻调用它，
   * 而回合结束时 turn context 已经销毁了。想在回合里注册方法就写 `inject: ['rpc']`。
   */
  get rpc(): RpcService {
    const s = this.get<RpcService>('rpc')
    if (!s) {
      throw new Error(
        'rpc 服务未提供：这个 context 没有 RPC 能力（只挂在长驻 context 上，' +
          '回合里请用 inject: ["rpc"] 声明依赖）'
      )
    }
    return s
  }

  /**
   * 工作区（`ctx.workspace`）：只有**绑定了目录的回合**才提供（未绑定目录的会话、以及
   * 设置页那种临时 inspect context 都没有 —— 它们本来也没有「工作区」这个东西）。
   *
   * 所以插件**不要**把 `workspace` 写进顶层 `inject`：那样会在 inspect context 里被推迟，
   * 连它的设置项声明都收不到（设置页就看不到它了）。要工作区的**工具那半**单独用
   * `ctx.inject(['workspace', 'tools'], …)` 注册即可。
   *
   * 没提供时这里抛错（与 tools / uploads 同款）：真走到了说明宿主忘了 set。
   */
  get workspace(): WorkspaceService {
    const s = this.get<WorkspaceService>('workspace')
    if (!s) {
      throw new Error(
        'workspace 服务未提供：这个 context 没有绑定工作区（回合请用 inject: ["workspace"] 声明依赖）'
      )
    }
    return s
  }

  // ---------- effect 作用域 ----------

  /**
   * 运行 `fn` 并把它的返回值当作清理函数登记下来；返回一个**幂等**的提前回收器。
   * 卸载时所有未回收的 effect 按登记顺序的**逆序**执行。
   */
  effect(fn: () => void | Dispose): Dispose {
    const raw = fn()
    if (typeof raw !== 'function') return () => {}
    return this._pushEffect(raw)
  }

  /** 直接登记一个已算好的清理函数（插件 apply 的返回值走这里） */
  _pushEffect(dispose: Dispose): Dispose {
    const entry: EffectEntry = { dispose }
    this._effects.push(entry)
    let done = false
    return () => {
      if (done) return
      done = true
      const i = this._effects.indexOf(entry)
      if (i >= 0) this._effects.splice(i, 1)
      return entry.dispose()
    }
  }

  // ---------- 隔离 / 挂载 / 注入 ----------

  /** 派生一个隔离子 Context（自带服务表与 effect 作用域，仍能读到父的服务） */
  isolate(name = 'isolate'): Context {
    return new Context(this, name)
  }

  /**
   * 挂载插件：为它造一个隔离 fiber 并 apply。
   * `inject` 声明的依赖没齐时**推迟**，等依赖被提供后自动补跑（顺序无关）。
   */
  plugin(plugin: Plugin, config?: unknown): Fork {
    const obj = normalizePlugin(plugin)
    const fiber = new Context(this, obj.name ?? 'plugin')
    const fork = new Fork(this, fiber)
    const entry: PendingEntry = {
      ctx: fiber,
      inject: obj.inject,
      apply: () => applyPlugin(fiber, obj, config)
    }
    if (fiber._missing(obj.inject).length === 0) entry.apply()
    else this.root._pending.push(entry)
    return fork
  }

  /** 声明式依赖：依赖齐全时立即跑 `cb`；否则挂起等依赖出现 */
  inject(deps: string[], cb: (ctx: Context) => void | Dispose): Dispose {
    let inner: Dispose | null = null
    const entry: PendingEntry = {
      ctx: this,
      inject: deps,
      apply: () => {
        const d = cb(this)
        inner = typeof d === 'function' ? this._pushEffect(d) : null
      }
    }
    if (this._missing(deps).length === 0) {
      entry.apply()
      return () => {
        inner?.()
      }
    }
    this.root._pending.push(entry)
    return () => {
      const i = this.root._pending.indexOf(entry)
      if (i >= 0) this.root._pending.splice(i, 1)
      inner?.()
    }
  }

  private _missing(inject?: string[]): string[] {
    return (inject ?? []).filter((name) => !this.has(name))
  }

  /** 摘掉「等这个 Context 的依赖」的挂起项（Fork 卸载时用；同一类内也会互相调） */
  _dropPendingFor(ctx: Context): void {
    this.root._pending = this.root._pending.filter((e) => e.ctx !== ctx)
  }

  private _flushPending(): void {
    if (this._pending.length === 0) return
    const runnable: PendingEntry[] = []
    const remaining: PendingEntry[] = []
    for (const entry of this._pending) {
      if (entry.ctx._disposed) continue
      if (entry.ctx._missing(entry.inject).length === 0) runnable.push(entry)
      else remaining.push(entry)
    }
    this._pending = remaining
    // 先摘表再执行：apply 期间若又 set 触发 _flushPending，不会重复执行同一项
    for (const entry of runnable) entry.apply()
  }

  // ---------- 事件总线 ----------

  /** 监听事件；返回 disposer（随本 Context 卸载自动回收） */
  on(name: string, listener: Listener): Dispose {
    let set = this._listeners.get(name)
    if (!set) {
      set = new Set()
      this._listeners.set(name, set)
    }
    set.add(listener)
    const target = set
    return bindEffect(this, () => {
      target.delete(listener)
      if (target.size === 0 && this._listeners.get(name) === target) this._listeners.delete(name)
    })
  }

  /** 广播：沿 parent 链向上，逐层触发监听器（近的层先触发） */
  emit(name: string, ...args: unknown[]): void {
    for (let c: Context | null = this; c; c = c.parent) {
      const set = c._listeners.get(name)
      if (set) for (const listener of [...set]) listener(...args)
    }
  }

  /**
   * 拦截型钩子：监听器签名 `(...args, next)`。可读 / 改参数再 `next(...)` 继续，
   * 或直接返回一个值**中断链路**（后面的监听器不再执行）。
   * `fallback` 是所有人都放行后的兜底（通常是内置行为）。
   */
  waterfall<T>(name: string, args: unknown[], fallback: (...a: unknown[]) => T): T {
    const chain: Listener[] = []
    for (let c: Context | null = this; c; c = c.parent) {
      const set = c._listeners.get(name)
      if (set) chain.push(...set)
    }
    let index = -1
    const next = (...override: unknown[]): T => {
      index += 1
      if (index >= chain.length) return fallback(...(override.length ? override : args))
      return chain[index](...args, next) as T
    }
    return next()
  }

  /** 收集型：第一个返回非 undefined 的监听器结果胜出 */
  bail<T>(name: string, ...args: unknown[]): T | undefined {
    for (let c: Context | null = this; c; c = c.parent) {
      const set = c._listeners.get(name)
      if (!set) continue
      for (const listener of [...set]) {
        const result = listener(...args)
        if (result !== undefined) return result as T
      }
    }
    return undefined
  }

  // ---------- 生命周期 ----------

  /** 启动：emit `ready`（挂载完成后调一次） */
  start(): void {
    this.emit('ready')
  }

  /**
   * 卸载：先拆子 Context（含插件 fiber），再 emit `dispose`，最后 LIFO 回收本层 effect。
   * 幂等。effect 的异常被吞掉（卸载不该因为一个清理失败而半途而废），但会打日志。
   */
  async dispose(): Promise<void> {
    if (this._disposed) return
    this._disposed = true

    for (const child of [...this._children].reverse()) {
      try {
        await child.dispose()
      } catch (err) {
        this.logger.warn('子 Context 卸载失败：', err)
      }
    }
    this._children.clear()

    this._dropPendingFor(this)

    this.emit('dispose')

    for (const entry of [...this._effects].reverse()) {
      try {
        await entry.dispose()
      } catch (err) {
        this.logger.warn('effect 回收失败：', err)
      }
    }
    this._effects.length = 0
    this._listeners.clear()
    this._services.clear()
    this.parent?._children.delete(this)
  }
}

/** 造一个根 Context（App Context 的起点） */
export function createAppContext(name = 'app'): Context {
  return new Context(null, name)
}