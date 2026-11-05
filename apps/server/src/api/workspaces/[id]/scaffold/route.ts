/**
 * 脚手架路由：给工作区新建一份模板文件（技能 SKILL.md / AGENTS.md）。
 *
 * 逻辑在 `lib/server/scaffold.ts`，这里只做「解析 body → 调领域 → 转响应」。
 * 斜线命令 `/create-skill` 已移除，目前没有界面入口（这条路由作为服务端能力保留）。
 */
import type { FsScaffoldInput } from '@fizz/contracts/agent-api'
import { scaffoldFile, ScaffoldError } from '@/lib/server/scaffold'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<FsScaffoldInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  if (body.kind !== 'skill' && body.kind !== 'agents') {
    return jsonError(400, `kind 只能是 skill 或 agents（收到 ${JSON.stringify(body.kind)}）`)
  }
  try {
    return Response.json(await scaffoldFile(id, body))
  } catch (err) {
    if (err instanceof ScaffoldError) return jsonError(err.status, err.message)
    throw err
  }
}