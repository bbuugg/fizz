/**
 * 「导入会话」弹窗：把 ACP agent 侧的既有会话绑成本地会话（**支持多选**）。
 *
 * 流程：先选一个 ACP agent → 从它那里拉取这个项目（cwd 过滤）下的会话清单
 * （需要 agent 广告 `sessionCapabilities.list`）→ 勾选若干条 → 逐条创建 acp 会话，
 * 直接绑定各自的 sessionId（消息不复制，历史仍在 agent 侧，打开时经 session/load 回放）。
 *
 * 会话类型（acp）与 agent 在创建时就锁死；模型不在这里选 —— 用 agent 默认模型，
 * 进入会话后仍可在该 agent 的模型里换。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, Loader2 } from 'lucide-react'
import type { AgentWorkspace } from '@fizz/contracts/agent-api'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@fizz/ui/empty'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

interface AcpSessionRow {
  sessionId: string
  cwd: string
  title?: string
  updatedAt?: string
}

export function ImportConversationDialog({
  app,
  workspace,
  open,
  onOpenChange,
  onImported
}: {
  app: AgentApp
  /** 目标项目（= 工作区）；null = 还没选项目，此时不给提交 */
  workspace: AgentWorkspace | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 导入成功后回调（带上全部新建的会话 id，最后一个排在末尾） */
  onImported?: (ids: string[]) => void
}) {
  const tr = useT()
  const [agentId, setAgentId] = useState('')
  /** agent 侧既有会话清单与选中的 sessionId 集合（多选） */
  const [sessions, setSessions] = useState<AcpSessionRow[] | null>(null)
  const [sessionsSupported, setSessionsSupported] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 导入进度：正在导入第 N / 共 M 条（多选是逐条建会话，给个进度免得像卡住） */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  /** 提交锁：`busy` 是渲染后才生效的，连点两次会建出重复会话 */
  const submittingRef = useRef(false)

  // 每次打开都从空开始：上一次的选择不该带到下一次
  useEffect(() => {
    if (open) {
      setAgentId('')
      setSessions(null)
      setSessionsSupported(false)
      setSelectedIds(new Set())
      setLoadingSessions(false)
      setProgress(null)
      setBusy(false)
      submittingRef.current = false
    }
  }, [open])

  /**
   * 选了 agent 之后：拉它的既有会话清单（cwd 过滤 = 只看这个项目下的）。
   *
   * ⚠️ 换 agent 才清清单与勾选；**重拉同一个 agent**（「重新拉取」按钮）保留旧清单 ——
   * 清掉的话清单区会先塌成一行「正在拉取」再长回去，弹窗高度跟着跳（与管理工作区同一条）。
   */
  const pickAgent = async (nextAgentId: string): Promise<void> => {
    const sameAgent = nextAgentId === agentId
    setAgentId(nextAgentId)
    if (!sameAgent) {
      setSelectedIds(new Set())
      setSessions(null)
      setSessionsSupported(false)
    }
    if (!nextAgentId || !workspace?.path) return
    setLoadingSessions(true)
    try {
      const res = await app.listAcpAgentSessions(nextAgentId, workspace.path)
      setSessionsSupported(res.supported)
      setSessions(res.supported ? res.sessions : [])
    } finally {
      setLoadingSessions(false)
    }
  }

  /** 勾选 / 取消一条（保持集合引用不变时 React 不重渲染，这里每次新建 Set） */
  const toggleSession = (sessionId: string): void => {
    // 已导入的不给勾（UI 上也禁用了，这里双保险）
    if (importedIds.has(sessionId)) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (!workspace || !agentId || selectedIds.size === 0 || busy || submittingRef.current) return
    // 清单里按服务端给的顺序逐条导入； agent 侧失败一条就停（后面还没导的保持未导入，
    // 用户修好后再来一遍 —— 已导入的会话已经在了，重选不会重复绑）
    const picked = (sessions ?? []).filter((s) => selectedIds.has(s.sessionId))
    submittingRef.current = true
    setBusy(true)
    setProgress({ done: 0, total: picked.length })
    const created: string[] = []
    try {
      for (const session of picked) {
        const id = await app.newConversation(workspace.id, session.title, {
          backend: 'acp',
          configId: agentId,
          // 导入：创建时就绑到 agent 侧的 sessionId，打开时直接 session/load 续聊
          acpSessionId: session.sessionId
        })
        // newConversation 失败返回 null（app.error 里已有原因），中止剩余导入
        if (!id) break
        created.push(id)
        setProgress({ done: created.length, total: picked.length })
      }
      if (created.length > 0) onImported?.(created)
    } finally {
      submittingRef.current = false
      setBusy(false)
      setProgress(null)
    }
  }

  const selectedCount = selectedIds.size
  /** 首次拉取（还没有任何结果）：清单区显示「正在拉取」；之后的重新拉取保留旧清单 */
  const firstLoad = loadingSessions && sessions === null

  /**
   * 已导入的会话（同一个 agent + 同一个 acpSessionId 只能导一次）：本地会话清单里
   * 已经有绑定关系的，直接标记出来并且**不再可选** —— 服务端也有同一条查重兜底，
   * 这里拦在前面是为了不让人点进去白忙一场。
   */
  const importedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const session of sessions ?? []) {
      if (
        app.conversations.some(
          (c) =>
            c.backend === 'acp' &&
            c.configId === agentId &&
            c.acpSessionId === session.sessionId
        )
      ) {
        ids.add(session.sessionId)
      }
    }
    return ids
  }, [sessions, app.conversations, agentId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tr('导入会话')}</DialogTitle>
          <DialogDescription>
            {tr('可多选；绑定后直接续聊，历史留在 agent 侧。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{tr('ACP Agent')}</span>
            <Select
              value={agentId}
              items={Object.fromEntries(app.acpAgents.map((agent) => [agent.id, agent.name]))}
              onValueChange={(v) => void pickAgent(v)}
            >
              <SelectTrigger variant="muted" className="w-full" aria-label={tr('选择 ACP Agent')}>
                <SelectValue
                  placeholder={app.acpAgents.length ? tr('选择 Agent…') : tr('还没有配置 ACP Agent')}
                />
              </SelectTrigger>
              <SelectContent>
                {app.acpAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/*
            清单区**高度钉死**（`h-48` = 原来的 `max-h-48`）：未选 Agent / 拉取中 / 清单 /
            空态四种内容都在同一个盒子里换，选 Agent、点「重新拉取」都不会让弹窗先塌再长
            （与「管理工作区」同一条规矩）。重拉期间保留旧清单，只降透明度 + 禁点。
          */}
          <div className="flex flex-col gap-1 rounded-md border border-border/70 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {selectedCount > 0
                  ? tr('已选 {count} 条', { count: selectedCount })
                  : agentId
                    ? tr('该 Agent 在这个项目下的会话')
                    : tr('会话清单')}
              </span>
              <div className="flex items-center gap-1">
                {/* 全选 / 清除：只作用于**还没导入过**的会话；清单全部导完就没有可选项 */}
                {sessions && sessions.length > importedIds.size && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    onClick={() =>
                      setSelectedIds((prev) =>
                        prev.size > 0
                          ? new Set()
                          : new Set(
                              sessions
                                .filter((s) => !importedIds.has(s.sessionId))
                                .map((s) => s.sessionId)
                            )
                      )
                    }
                  >
                    {selectedCount > 0 ? tr('清除') : tr('全选')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs"
                  disabled={!agentId || loadingSessions}
                  onClick={() => void pickAgent(agentId)}
                >
                  {loadingSessions ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Download className="size-3" />
                  )}
                  {tr('重新拉取')}
                </Button>
              </div>
            </div>

            <div className="flex h-48 min-h-0 flex-col overflow-hidden">
              {!agentId ? (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  {tr('先在上面选一个 ACP Agent')}
                </div>
              ) : firstLoad ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {tr('正在拉取会话清单…')}
                </div>
              ) : sessions && sessions.length > 0 ? (
                <div
                  className={cn(
                    'min-h-0 flex-1 overflow-y-auto',
                    loadingSessions && 'pointer-events-none opacity-60'
                  )}
                  aria-busy={loadingSessions || undefined}
                >
                  {sessions.map((session) => {
                    const checked = selectedIds.has(session.sessionId)
                    // 已导入（本地已有绑定）：置灰 + 标记，不可再选
                    const imported = importedIds.has(session.sessionId)
                    return (
                      <button
                        key={session.sessionId}
                        type="button"
                        disabled={imported}
                        onClick={() => toggleSession(session.sessionId)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                          checked && 'bg-primary/10 text-foreground'
                        )}
                      >
                        {/* 勾选框：选中打勾，未选中空框 —— 多选语义要一眼可辨 */}
                        <span
                          className={cn(
                            'flex size-3.5 shrink-0 items-center justify-center rounded border',
                            checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                          )}
                        >
                          {checked && <Check className="size-2.5" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block w-full truncate font-medium">
                            {session.title || session.sessionId}
                          </span>
                          {session.updatedAt && (
                            <span className="block text-muted-foreground">
                              {new Date(session.updatedAt).toLocaleString()}
                            </span>
                          )}
                        </span>
                        {imported && (
                          <span className="shrink-0 rounded border border-border px-1 text-[0.625rem] leading-4 text-muted-foreground">
                            {tr('已导入')}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <Empty className="flex-1 p-4">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Download />
                    </EmptyMedia>
                    <EmptyTitle>
                      {sessionsSupported ? tr('没有找到会话') : tr('这个 Agent 不支持会话清单')}
                    </EmptyTitle>
                    <EmptyDescription>
                      {sessionsSupported
                        ? tr('它在当前项目下还没有可导入的会话')
                        : tr('需要在 Agent 侧开启 session/list 能力')}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {tr('取消')}
          </Button>
          <Button disabled={!agentId || selectedCount === 0 || busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            {busy && progress
              ? tr('导入中 {done}/{total}', { done: progress.done, total: progress.total })
              : selectedCount > 0
                ? tr('导入（{count}）', { count: selectedCount })
                : tr('导入')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
