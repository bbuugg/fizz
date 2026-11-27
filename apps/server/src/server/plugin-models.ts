/**
 * 插件注册的模型配置：**发现 → 挂载一遍 → 把 `ctx.models.register()` 的声明灌进领域层**。
 *
 * ## 为什么需要这一层（而不是在 `listModels()` 里现扫）
 *
 * `AgentDomain.listModels()` / `resolveModelConfig()` 是**同步**的（会话创建、状态推送、
 * 定时任务都在同步路径上读它）。插件的发现与 apply 是异步的，所以只能在后台把结果先算好，
 * 塞给领域层一个内存快照（`domain.setExternalModels`）。
 *
 * ## 刷新时机与成本
 *
 * - 服务端启动（`background.ts`）；
 * - 每一轮对话 / 定时任务 / 助手回合开始前（`refreshPluginModels()` 内部按指纹短路，
 *   文件与设置值都没变时只是几次 stat）；
 * - 插件的安装 / 卸载 / 启停 / 设置保存（`invalidatePluginModels()` 清指纹，下一次读即重建）；
 * - `GET /api/models`（设置页打开时顺带刷新）。
 *
 * 指纹 = 插件目录源码（递归路径 + mtime + size + 启用态）+ 设置页里存的值（含密钥密文），
 * 统一由 `pluginFingerprint` 计算 —— 改插件源码 / 填完 token 下一次对话就生效。
 *
 * ## 作用域：只收集**全局**插件（内置 + 用户级）
 *
 * 模型列表是全局的，不属于任何项目。工作区级插件（`<项目>/.fizz/plugins`）注册的配置
 * 不会进设置页 —— 否则「同一个模型在 A 项目有、B 项目没有」会变成看不见的状态。
 * 这类插件在回合 context 里照样能拿到 `ctx.models`（不会因为 inject 被推迟），只是不落账。
 */
import {
  HooksService,
  ModelsService,
  PromptService,
  ToolsService,
  UiService,
  createAppContext
} from '@fizz/plugin'
import { loadPlugins } from '@fizz/plugin/loader'
import type { AiModelConfig } from '@fizz/contracts/types'
import { discoverServerPlugins, pluginFingerprint, withRuntimeConfig } from './plugin-roots'
import { domain } from './state'
import type { PluginModelEntry } from '@fizz/workspace'

/**
 * 宿主给插件配置 id 加的前缀。用**插件 manifest 的 id**（稳定、跨安装）做命名空间：
 * 两个插件都声明 `id: 'main'` 不会撞；卸载后会话里拼好的 id 悬空时会得到明确的
 * 「配置不存在」。
 */
const ID_PREFIX = 'plugin:'

let appliedFingerprint: string | null = null
let pending: Promise<void> | null = null

/** 插件声明 → 领域层的只读配置（补时间戳与来源；apiKey 保持明文，解析时不再解密） */
function toEntry(
  pluginId: string,
  pluginName: string,
  reg: ReturnType<ModelsService['list']>[number]
): PluginModelEntry {
  const now = Date.now()
  const model = reg.models[0]?.id ?? ''
  const config: AiModelConfig = {
    id: `${ID_PREFIX}${pluginId}:${reg.id}`,
    name: reg.name || reg.id,
    kind: reg.kind,
    models: reg.models,
    model,
    createdAt: now,
    updatedAt: now,
    ...(reg.baseURL ? { baseURL: reg.baseURL } : {}),
    ...(reg.apiKey ? { apiKey: reg.apiKey } : {}),
    ...(reg.apiStyle ? { apiStyle: reg.apiStyle } : {}),
    ...(reg.temperature !== undefined ? { temperature: reg.temperature } : {}),
    ...(reg.maxTokens !== undefined ? { maxTokens: reg.maxTokens } : {}),
    ...(reg.contextMessages !== undefined ? { contextMessages: reg.contextMessages } : {})
  }
  return { ...config, pluginId, sourceName: pluginName }
}

/**
 * 重建插件模型配置。指纹没变时直接返回（幂等、可高频调用）。
 *
 * 失败只记日志并**保留上一次的清单**：一个插件写坏了不该让所有插件模型凭空消失，
 * 更不该让正在用它们的会话突然报「配置不存在」。
 */
export async function refreshPluginModels(): Promise<void> {
  if (pending) return pending
  const task = (async () => {
    const descriptors = await discoverServerPlugins({})
    const enabled = descriptors.filter((d) => d.enabled)
    const fingerprint = await pluginFingerprint(enabled)
    if (fingerprint === appliedFingerprint) return

    const ctx = createAppContext('plugin-models')
    ctx.set('tools', new ToolsService(ctx))
    ctx.set('prompt', new PromptService(ctx))
    ctx.set('hooks', new HooksService(ctx))
    ctx.set('ui', new UiService(ctx))
    const models = new ModelsService(ctx)
    ctx.set('models', models)

    try {
      const { loaded, errors } = await loadPlugins(withRuntimeConfig(enabled))
      for (const err of errors) console.warn('[models] 插件加载失败（它的模型配置不可用）：', err)
      const byId = new Map(descriptors.map((d) => [d.id, d]))
      const entries: PluginModelEntry[] = []
      for (const item of loaded) {
        const owner = byId.get(item.id)
        // 用「apply 前后注册表长度的差」归属本次注册：ModelsService 在 context 上只有一份，
        // 没有按插件 fiber 隔离，而 `ctx.plugin` 的 apply 是同步的 —— 这一段新增的就属于
        // 当前插件。依赖未齐被推迟的 apply（自定义服务名）收不到，属于已知取舍。
        const before = models.list().length
        try {
          ctx.plugin(item.plugin, item.config)
        } catch (err) {
          console.warn(`[models] 插件 apply 失败（已跳过）：${item.id}`, err)
          continue
        }
        for (const reg of models.list().slice(before)) {
          entries.push(toEntry(item.id, owner?.name ?? reg.source, reg))
        }
      }
      domain.setExternalModels(entries)
      appliedFingerprint = fingerprint
    } catch (err) {
      console.warn('[models] 刷新插件模型配置失败（保留上一次的清单）：', err)
    } finally {
      await ctx.dispose().catch(() => {})
    }
  })().finally(() => {
    pending = null
  })
  pending = task
  return task
}

/**
 * 作废缓存：安装 / 卸载 / 启停 / 保存插件设置后调用。
 *
 * 不立即重建 —— 下一次 `GET /api/models` 或下一轮对话会按需重建，避免安装流程里
 * 多挂一次插件。
 */
export function invalidatePluginModels(): void {
  appliedFingerprint = null
}
