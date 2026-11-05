/**
 * 手动运行一次定时任务（面板上的「立即运行」）。
 * POST /api/task-triggers/[id]/run
 *
 * 与到点触发走同一条派发队列（见 `scheduler.fireTriggerNow`）：只跳过
 * 「已停用 / 一次性已经跑过」两道闸，模型 / 外部 Agent / 工作区 / 权限校验照旧。
 * 派发是异步的（一轮可能跑几分钟），这里只回「已开始」。
 */
import { triggerDomain } from '@/lib/server/state'
import { fireTriggerNow } from '@/lib/server/scheduler'
import { jsonError } from '@/app/api/_lib/auth'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Ctx) {
  const { id } = await params
  if (!triggerDomain.getTrigger(id)) return jsonError(404, '定时任务不存在')
  fireTriggerNow(id)
  return Response.json({ ok: true })
}
