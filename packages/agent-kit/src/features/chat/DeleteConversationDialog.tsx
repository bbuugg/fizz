/**
 * 「删除会话」确认弹窗（侧栏会话行尾垃圾桶点开）。
 *
 * 内置 Agent 会话：删的是本地落盘的记录，弹窗只做二次确认。
 * ACP 会话：本地记录 + agent 侧的 session 是两份数据 —— 多一个复选框
 * 「同时删除 ACP agent 侧的会话」（默认不勾，误删代价大）。勾了就走
 * `session/delete`（可选能力：agent 没广告 `sessionCapabilities.delete` 时
 * 删不掉，toast 提示后照常删本地 —— 不把用户卡死在一个删不掉的会话上）。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Trash2 } from 'lucide-react'
import type { ConversationSummary } from '@fizz/contracts/agent-api'
import { Button } from '@fizz/ui/button'
import { Checkbox } from '@fizz/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { conversationTitle } from '@fizz/agent-kit/shared/lib/conversation-title'

export function DeleteConversationDialog({
  app,
  conversation,
  onCancel,
  onConfirm
}: {
  app: AgentApp
  /** 待删除的会话；null = 关着 */
  conversation: ConversationSummary | null
  /** 取消 / 关闭（调用方把待删状态清掉即可） */
  onCancel: () => void
  /**
   * 确认删除本地会话（调用方是 Provider 包装的删除：会同步退回 URL / 接上落点）。
   * agent 侧的删除（勾了复选框时）由弹窗自己先做完再回调。
   *
   * **必须 await**：接口回来的 `ok` 决定弹窗关不关 —— 删除比较慢，请求期间按钮要一直
   * 转圈，成功才由调用方清掉待删状态（弹窗随 `conversation` 变 null 关掉）。
   */
  onConfirm: (conversation: ConversationSummary) => Promise<boolean>
}) {
  const acpBound = !!(
    conversation &&
    conversation.backend === 'acp' &&
    conversation.configId &&
    conversation.acpSessionId
  )
  const [deleteAcp, setDeleteAcp] = useState(false)
  const [busy, setBusy] = useState(false)

  const confirm = async (): Promise<void> => {
    if (!conversation || busy) return
    setBusy(true)
    try {
      // 先删 agent 侧（勾了才做），失败不阻断本地删除 —— 本地记录才是弹窗的主目标
      if (acpBound && deleteAcp && conversation.configId && conversation.acpSessionId) {
        const res = await app.deleteAcpAgentSession(
          conversation.configId,
          conversation.acpSessionId
        )
        if (!res.ok) {
          toast.warning(
            res.supported === false
              ? '该 Agent 不支持删除会话（session/delete），已只删除本地会话'
              : `删除 agent 侧会话失败：${res.error ?? '未知错误'}，已只删除本地会话`
          )
        }
      }
      // 本地删除**成功才收尾**：调用方拿到 true 才会清掉待删状态把弹窗关掉。
      // 失败时弹窗继续开着（busy 在 finally 复位），用户可以重试或取消。
      const ok = await onConfirm(conversation)
      if (!ok) toast.error('删除会话失败，请重试')
    } finally {
      setBusy(false)
      setDeleteAcp(false)
    }
  }

  return (
    <Dialog
      open={conversation !== null}
      onOpenChange={(open) => {
        // busy 期间不给 Esc / 点遮罩关掉：agent 侧删除是破坏性操作，做一半停下状态不明
        if (!open && !busy) {
          setDeleteAcp(false)
          onCancel()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除会话？</DialogTitle>
          <DialogDescription>
            「{conversationTitle(conversation?.title)}」将被删除
            {conversation?.backend === 'acp' ? '（历史保存在 agent 侧）' : '，该操作不可撤销'}。
          </DialogDescription>
        </DialogHeader>

        {acpBound && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/70 px-3 py-2 text-sm">
            <Checkbox
              checked={deleteAcp}
              onCheckedChange={(v) => setDeleteAcp(v === true)}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">同时删除 ACP agent 侧的会话</span>
              <span className="block text-xs text-muted-foreground">
                历史在 agent 侧，勾选后一并删除
              </span>
            </span>
          </label>
        )}

        <DialogFooter className="pt-1">
          <Button data-dialog-dismiss="" autoFocus
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDeleteAcp(false)
              onCancel()
            }}
          >
            取消
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
