/**
 * 终端命令历史（按项目）：读写 `<项目>/.fizz/terminal-history.json`。
 *
 * - GET    → `{ entries }`（最新在前）
 * - POST   body `{ cmd }` → 记录一条（终端回车时上报；去重置顶、超限丢尾部）
 * - DELETE `?cmd=<命令文本>` → 删单条；不带 `cmd` → 清空
 *
 * 终端面板的历史管理与命令预测共用这一份数据；项目目录不存在时读写都得到空
 * （历史功能不创建项目目录，见 `lib/server/terminal/history.ts`）。
 */
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { describeError, jsonError } from '@/app/api/_lib/auth'
import {
  addTerminalHistory,
  clearTerminalHistory,
  listTerminalHistory,
  removeTerminalHistory
} from '@/lib/server/terminal/history'
import type { TerminalHistoryData } from '@fizz/contracts/agent-api'

async function respond(workspaceId: string): Promise<Response> {
  const workspace = domain.getWorkspace(workspaceId)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, '终端历史')
  if (denied) return denied
  try {
    const data: TerminalHistoryData = { entries: await listTerminalHistory(workspace.path) }
    return Response.json(data)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  return respond(id)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, '终端历史')
  if (denied) return denied
  try {
    const input = (await request.json()) as { cmd?: unknown }
    if (typeof input?.cmd !== 'string') return jsonError(400, '缺少 cmd')
    await addTerminalHistory(workspace.path, input.cmd)
    return respond(id)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, '终端历史')
  if (denied) return denied
  try {
    const cmd = new URL(request.url).searchParams.get('cmd')
    if (cmd) await removeTerminalHistory(workspace.path, cmd)
    else await clearTerminalHistory(workspace.path)
    return respond(id)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
