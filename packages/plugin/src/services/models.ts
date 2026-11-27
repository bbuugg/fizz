/**
 * 模型配置注册表：`ctx.models` 的实体。**插件往「设置 → 模型」里加配置的唯一入口。**
 *
 * 一条注册 = 设置页里的一份**模型配置**（网关 + 模型清单 + 每个模型自己的窗口 / 进阶设置）：
 *
 * ```ts
 * ctx.models.register({
 *   id: 'my-gateway',
 *   name: '我的网关',
 *   kind: 'openai-compatible',
 *   baseURL: 'https://gateway.example.com/v1',
 *   apiKey: config?.token,          // 密钥项由宿主解密后随 config 传进来
 *   models: [
 *     { id: 'model-a', contextWindow: 128_000 },
 *     { id: 'model-b', settings: { imageInput: false } }
 *   ]
 * })
 * ```
 *
 * ## 只读、不落盘
 *
 * 注册的配置**不写进 `agent-core.json`**：真源是插件自己（每次插件挂载时重新声明）。
 * 所以在设置页里它们是**只读**的 —— 不能编辑网关 / 增删模型，要改就改插件源码或它的设置项。
 * 插件被停用 / 卸载后，配置自然从列表里消失（正在用它的会话会得到「配置不存在」的明确报错）。
 *
 * ## 只认全局插件（内置 / 用户级）
 *
 * 模型列表是**全局**的（不属于某个项目）。工作区级插件（`<项目>/.fizz/plugins`）在某一轮
 * 对话里注册的配置不会进设置页，也不会参与模型解析 —— 那会让「同一个模型 id 在 A 项目有、
 * B 项目没有」变成隐形的状态。要全局可见就把插件放到内置 / 用户级目录。
 *
 * ## id 会被宿主加前缀
 *
 * 插件只给**插件内唯一**的 id（如 `main`）。宿主收集时拼成 `plugin:<插件入口路径>:<id>`，
 * 两个插件都用 `main` 也不会撞；设置页 / 会话里存的是拼好的那个。
 */
import { Service } from '../service'
import type { Context } from '../context'
import type { Dispose } from '../types'
import type { AiApiStyle, AiModelEntry, AiProviderKind } from '@fizz/contracts/types'

/** 插件声明的**一份**模型配置（字段语义与 `AiModelConfig` 相同，但不需要时间戳 / 脱敏字段） */
export interface PluginModelConfig {
  /** 插件内唯一的配置 id（非空、不含空白）；宿主会加 `plugin:<插件路径>:` 前缀 */
  id: string
  /** 显示名；缺省用 `id` */
  name?: string
  kind: AiProviderKind
  baseURL?: string
  /**
   * API key（明文）。插件应优先从自己做注册时拿到的 `config` 里读（设置项由宿主解密），
   * 其次才是环境变量 —— 与其它插件设置项的约定一致。
   */
  apiKey?: string
  /** 仅 openai / openai-compatible 有效 */
  apiStyle?: AiApiStyle
  temperature?: number
  maxTokens?: number
  contextMessages?: number
  /** 该配置下的模型清单（顺序即展示顺序；允许为空）；每个条目自带窗口与进阶设置 */
  models: AiModelEntry[]
}

/** 注册表里的条目（宿主补上来源，`ctx.models.list()` 读到的就是它） */
export interface PluginModelRegistration extends PluginModelConfig {
  /** 注册来源（给人看的名字；缺省 `unknown`） */
  source: string
}

const KINDS: ReadonlySet<string> = new Set([
  'openai',
  'anthropic',
  'deepseek',
  'google',
  'openai-compatible'
])

/** 模型清单去空 / 去重 / 保序，并只保留已知字段（与 `AgentDomain.saveModel` 同一口径） */
function normalizeModels(raw: unknown): AiModelEntry[] {
  if (!Array.isArray(raw)) return []
  const out: AiModelEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const value = item as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const entry: AiModelEntry = { id }
    const window = value.contextWindow
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
      entry.contextWindow = Math.floor(window)
    }
    const settings = value.settings
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      entry.settings = settings as AiModelEntry['settings']
    }
    out.push(entry)
  }
  return out
}

export class ModelsService extends Service {
  private readonly _byId = new Map<string, PluginModelRegistration>()

  constructor(ctx: Context) {
    super(ctx)
  }

  get name(): string {
    return 'models'
  }

  /**
   * 注册一份模型配置；返回 disposer（随插件 fiber 卸载自动回收）。
   *
   * 同一个 id 重复注册时**保留先注册的**并告警（避免静默覆盖：
   * 抛错会把整轮对话 / 整个设置页带停，代价远大于一条冲突）。
   */
  register(input: PluginModelConfig, opts: { source?: string } = {}): Dispose {
    const source = opts.source?.trim() || 'unknown'
    const id = typeof input?.id === 'string' ? input.id.trim() : ''
    if (!id || /\s/.test(id)) {
      throw new Error(`模型配置 id 非法（来源 ${source}）：要是非空、不含空白的字符串`)
    }
    if (!KINDS.has(input.kind)) {
      throw new Error(`模型配置「${id}」的 kind 非法（来源 ${source}）：${String(input.kind)}`)
    }
    const models = normalizeModels(input.models)

    const reg: PluginModelRegistration = {
      id,
      name: input.name?.trim() || id,
      kind: input.kind,
      models,
      ...(input.baseURL?.trim() ? { baseURL: input.baseURL.trim() } : {}),
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
      ...(input.apiStyle ? { apiStyle: input.apiStyle } : {}),
      ...(typeof input.temperature === 'number' && Number.isFinite(input.temperature)
        ? { temperature: input.temperature }
        : {}),
      ...(typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens)
        ? { maxTokens: Math.floor(input.maxTokens) }
        : {}),
      ...(typeof input.contextMessages === 'number' && Number.isFinite(input.contextMessages)
        ? { contextMessages: Math.floor(input.contextMessages) }
        : {}),
      source
    }

    const existing = this._byId.get(id)
    if (existing) {
      this.ctx.logger.warn(
        `[models] 模型配置 id 冲突：「${id}」已被 ${existing.source} 注册，忽略这次来自 ${source} 的注册`
      )
      return () => {}
    }

    this._byId.set(id, reg)
    return this.bind(() => {
      if (this._byId.get(id) === reg) this._byId.delete(id)
    })
  }

  /** 当前注册清单（注册顺序） */
  list(): PluginModelRegistration[] {
    return [...this._byId.values()]
  }
}
