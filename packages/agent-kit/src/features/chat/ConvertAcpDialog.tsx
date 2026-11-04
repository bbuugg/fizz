/**
 * 「转为内置 Agent 会话」确认弹窗 —— 与「从此签出」（`ForkDialog`）同一个壳
 * （`BranchTargetDialog`）：都让用户选「在当前工作区分叉」还是「新建 worktree 并签出」。
 *
 * 转换是**不可逆的形态变更**（把 ACP 会话复制成内置 内置会话），所以不能像以前那样点一下
 * 直接执行 —— 先确认，并顺带让用户决定新会话落在哪个工作区。
 *
 * - `messageId` 给了 = 只保留到该条（含）为止的历史（消息行那颗按钮）；不给 = 整条会话全量转换
 *   （侧栏会话行「更多」里那一项）。
 */
import { toast } from 'sonner'
import { BranchTargetDialog } from '@fizz/agent-kit/features/chat/BranchTargetDialog'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function ConvertAcpDialog({
  app,
  conversationId,
  messageId,
  open,
  onOpenChange
}: {
  app: AgentApp
  /** 要转换的 ACP 会话 id */
  conversationId: string
  /** 终点消息（含）；null / 不传 = 整条会话全量转换 */
  messageId?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <BranchTargetDialog
      open={open}
      onOpenChange={onOpenChange}
      title="转为内置 Agent 会话"
      description="把这条 ACP 会话复制成一条内置 Agent 会话：历史到这里为止，之后由内置 Agent 接管；原 ACP 会话保持不动。"
      confirmLabel="转换"
      busyLabel="转换中…"
      onSubmit={async (target) => {
        const ok = await app.convertAcpConversation(
          conversationId,
          messageId ?? undefined,
          target
        )
        // 失败原因 store 已写进全局错误条（弹窗不再重复显示）；这里抛出只为让弹窗留在原地
        // （见 BranchTargetDialog 约定 —— 抛出的文案不会被展示）
        if (!ok) throw new Error('转换为内置 Agent 会话失败')
        toast.success('已转换为内置 Agent 会话')
      }}
    />
  )
}