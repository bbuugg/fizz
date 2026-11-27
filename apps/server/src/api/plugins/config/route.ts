/**
 * 保存插件设置项的值：POST /api/plugins/config
 *
 * 插件用 `ctx.ui.setting({ id, title, type, secret })` 声明设置项，设置页渲染成表单，值存这里
 * （服务端）；挂载插件时作为 `apply(ctx, config)` 的第二个参数交给它 —— 于是
 * 「storage.to 的 API 令牌」这类东西不必再写进环境变量。
 *
 * 三条约束：
 * 1. **请求体是不可信输入**：只有插件**自己声明过**的键才收，类型按声明收敛（`select` 还要
 *    落在候选里）—— 否则界面上一个手改的请求就能往存储里塞任意键值；
 * 2. **密钥项**（`secret: true`）加密落盘（SecretBox），且空串 = **保持原值**（明文不在浏览器
 *    手里，没法回传）；要清空请显式传 `null`；
 * 3. 配置进入插件缓存指纹（`pluginFingerprint`），下一次调用界面或开始对话会使用新值。
 *
 * 不在这里返回刷新后的清单：前端保存成功后自己重拉（面板已有 load），少一份要同步的形状。
 */
import { inspectPluginUi } from '@fizz/plugin/loader'
import type { PluginConfigInput, UiSettingItem, UiSettingType } from '@fizz/plugin'
import { discoverServerPlugins, pluginRuntimeConfig } from '@/lib/server/plugin-roots'
import { domain } from '@/lib/server/state'
import { invalidatePluginModels, refreshPluginModels } from '@/lib/server/plugin-models'
import { invalidateConversationHooks } from '@/lib/server/conversation-hooks'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

/** 按声明的类型收敛一个值；返回 undefined = 类型不对（回 400） */
function coerceValue(
  item: UiSettingItem,
  raw: string | number | boolean
): string | number | boolean | undefined {
  if (item.type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (raw === 'true') return true
    if (raw === 'false') return false
    return undefined
  }
  if (item.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  // string / select
  if (typeof raw !== 'string') return undefined
  if (item.type === 'select' && !item.options?.some((o) => o.value === raw)) return undefined
  return raw
}

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<PluginConfigInput & { workspaceId?: string }>(request)
  if (!body?.id || typeof body.id !== 'string') return jsonError(400, '缺少插件 id')
  if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
    return jsonError(400, '缺少 values')
  }

  // 找这个插件（内置 / 用户级 / 项目级都可能 —— 项目级要带 workspaceId 才扫得到）
  const workspaceId =
    typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined
  const workspacePath = workspaceId ? domain.getWorkspace(workspaceId)?.path : undefined
  const all = await discoverServerPlugins({ workspaceId, workspacePath })
  const target = all.find((d) => d.id === body.id)
  if (!target) return jsonError(404, '这个插件不存在或没被扫描到（可能已被删除）')

  // 它自己声明了哪些设置项 —— 只认这些键
  const { ui, errors } = await inspectPluginUi([
    { ...target, config: pluginRuntimeConfig(target.id, target.config) }
  ])
  if (errors.length) return jsonError(400, `插件没通过校验，无法保存配置：${errors.join('；')}`)
  const declared = ui[target.id]?.settings ?? []
  if (declared.length === 0) return jsonError(400, '这个插件没有声明任何设置项')

  const patch: Record<string, string | number | boolean | null> = {}
  for (const item of declared) {
    if (!(item.id in body.values)) continue
    const raw = body.values[item.id]
    if (raw === null) {
      patch[item.id] = null
      continue
    }
    // 密钥项的空串 = 保持原值（界面留空就是「不改」），不当清空
    if (item.secret && raw === '') continue
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      return jsonError(400, `设置项「${item.title}」的值类型不对`)
    }
    const value = coerceValue(item, raw)
    if (value === undefined) {
      return jsonError(400, `设置项「${item.title}」的值不合法（应为 ${item.type as UiSettingType}）`)
    }
    patch[item.id] = value
  }
  if (Object.keys(patch).length === 0) return jsonError(400, '没有任何可保存的设置项')

  try {
    domain.savePluginValues(
      target.id,
      patch,
      declared.filter((item) => item.secret).map((item) => item.id)
    )
  } catch (err) {
    return jsonError(500, `保存失败：${err instanceof Error ? err.message : String(err)}`)
  }
  // 插件可能用刚保存的 token 注册模型配置：立即重建全局模型清单
  invalidatePluginModels()
  // 通知类插件靠设置值决定发不发：宿主指纹不含实时配置，必须当场作废
  if (target.source === 'workspace' && workspaceId) {
    await invalidateConversationHooks(workspaceId)
  } else {
    await invalidateConversationHooks()
  }
  await refreshPluginModels()
  return Response.json({ ok: true })
}
