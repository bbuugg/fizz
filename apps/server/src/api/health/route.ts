import { listServerSkills } from '@/lib/server/skill-roots'
import { domain } from '@/lib/server/state'

// 启动副作用（定时任务调度器 / Flow 节点对账 / 工作区巡检）都由
// `instrumentation.ts` 的 `register()` 统一拉起 —— 它们全都是「服务开着就该跑」的东西，
// 不能挂在某个路由上（没人访问 /api/health 就永远不启动，节点会一直卡在 running）。

export async function GET(_request: Request) {
  const models = domain.listModels()
  const workspaces = domain.listWorkspaces()
  const conversations = domain.listConversations()
  const skills = await listServerSkills(workspaces[0]?.path)
  return Response.json({
    name: 'fizz-server',
    version: '0.0.23',
    hasModels: models.length > 0,
    workspaceCount: workspaces.length,
    conversationCount: conversations.length,
    skillCount: skills.skills.length
  })
}
