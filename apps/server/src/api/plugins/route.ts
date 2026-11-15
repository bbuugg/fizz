/**
 * 插件路由：扫插件目录 + **分作用域**的启停设置。
 *
 * 两个面**刻意分开**，各自只管自己那份（用户明确要求，也是产品定位的结果）：
 * - `?scope=global`（设置 →「插件」页）：扫**内置**（随产品分发，`<仓库/安装目录>/plugins`）
 *   与**用户级**（`~/.fizz/plugins`）两个根，启停存全局一份
 *   （`domain.getGlobalPluginSettings`）。这两类都对所有项目生效，开关自然也该是全局的。
 * - 其余（侧栏项目「更多」→「插件」弹窗）：只扫**该项目**的 `<项目>/.fizz/plugins`，
 *   启停按 workspaceId 存（`domain.getPluginSettings`）。
 *
 * 不传 `workspaceId` 时回退到第一个项目 —— 老调用方的既有行为，没动。
 *
 * 装配与响应形状都在 `_lib/list.ts`（安装 / 卸载两条路由共用同一份，返回同一形状）。
 * 插件是磁盘上的 `.ts` / `.js` 文件，这里做「发现 + 列表 + 启停」，外加**收集已启用插件
 * 声明的 UI**（只读展示）。⚠️ 真正把插件挂进对话仍发生在每一轮对话开始时（见
 * `lib/server/chat-turn.ts`）—— 插件要挂到那一轮的 turn context 上。本路由为了让 UI 看到
 * 插件声明了什么，会**额外把每个已启用插件 apply 一遍**（见 `inspectPluginUi` 的副作用说明）。
 */
import { domain } from '@/lib/server/state'
import { invalidatePluginModels, refreshPluginModels } from '@/lib/server/plugin-models'
import { invalidateConversationHooks } from '@/lib/server/conversation-hooks'
import { parseJsonBody } from '@/app/api/_lib/auth'
import { listGlobal, listWorkspace, resolveWorkspace, type PluginScope } from './_lib/list'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  if (params.get('scope') === 'global') return listGlobal()
  return listWorkspace(params.get('workspaceId'))
}

export async function POST(request: Request) {
  const body = await parseJsonBody<{
    scope?: PluginScope
    workspaceId?: string
    disabled?: string[]
  }>(request)
  // HTTP 请求体是不可信输入：非字符串项直接丢掉
  const disabled = Array.isArray(body?.disabled)
    ? body.disabled.filter((x): x is string => typeof x === 'string')
    : []

  if (body?.scope === 'global') {
    domain.saveGlobalPluginSettings({ disabled })
    invalidatePluginModels()
    // 内置 / 用户级插件是所有工作区共用的：启停一变，全部会话钩子宿主都作废
    await invalidateConversationHooks()
    await refreshPluginModels()
    return listGlobal()
  }

  const workspace = resolveWorkspace(body?.workspaceId)
  if (workspace) {
    domain.savePluginSettings(workspace.id, { disabled })
    await invalidateConversationHooks(workspace.id)
  }
  return listWorkspace(workspace?.id)
}
