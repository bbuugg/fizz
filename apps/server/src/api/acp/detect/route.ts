/**
 * 扫 PATH 上已装的 ACP agent（只读探测，给设置页「一键添加」用）。
 * GET /api/acp/detect
 *
 * 候选清单与探测逻辑在 `server/acp-detect.ts`（项目助手的 `detect_acp_agents`
 * 工具也用它 —— 两处各写一份的话，改参数时迟早只改一边）。
 */
import { detectAcpAgents } from '@/lib/server/acp-detect'

export async function GET() {
  return Response.json(await detectAcpAgents())
}
