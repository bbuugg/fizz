/**
 * 「管理工作区」弹窗。
 *
 * 从项目行的「更多」菜单 →「工作区」二级菜单打开：扫描**当前项目**目录下 `.worktree/`
 * 里既有的 worktree（本仓库的 worktree 落点约定，见 `NewWorktreeDialog`），一个清单里
 * 同时管两件事：
 *
 * - **导入**：还没登记过的目录（别处手工 `git worktree add` 出来的、换机器只带过来目录的）
 *   勾一个导入 —— 服务端只把它**登记**成 worktree 项目，不建目录、不建分支
 *   （那是「新建工作区」干的事，见 NewWorktreeDialog）。
 * - **移除**：已经登记的那条从工作区列表里摘掉；勾上对话框里的「同时删除 git worktree」
 *   还会连磁盘目录一起删（确认弹窗与侧栏 / 设置共用 `WorkspaceDeleteDialog`）。
 *
 * 之前这里只有「加载」这一个动作，功能上就是 import 的旧叫法 —— 现在名字与职责对齐了。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import type {
  AgentWorkspace,
  WorkspaceDeleteInput,
  WorktreeScanEntry
} from '@fizz/contracts/agent-api'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@fizz/ui/empty'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { WorkspaceDeleteDialog } from '@fizz/agent-kit/features/projects/WorkspaceDeleteDialog'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function ManageWorktreeDialog({
  app,
  workspace,
  open,
  onOpenChange,
  onLoaded
}: {
  app: AgentApp
  /** 源项目（= 工作区）；null = 还没选项目，此时不给提交 */
  workspace: AgentWorkspace | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 导入成功后回调（带上新登记的那个项目） */
  onLoaded?: (workspace: AgentWorkspace) => void
}): ReactNode {
  const tr = useT()
  const [entries, setEntries] = useState<WorktreeScanEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 待确认移除的已登记 worktree（null = 没弹确认窗） */
  const [pendingRemove, setPendingRemove] = useState<AgentWorkspace | null>(null)
  /** 提交锁：`busy` 要等重渲染才生效，连点两次会走两遍登记 */
  const submittingRef = useRef(false)

  /** 扫一次工作区列表；`retry` 时把上一次的错误清掉 */
  const scan = async (target: AgentWorkspace): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setEntries(await app.scanWorktrees(target.id))
    } catch (err) {
      // 失败**不清清单**：上一次的结果还留着，用户能在原处重试；清空会让清单区
      // 从「一屏列表」塌成一行错误，弹窗高度跟着跳（用户报的就是这个观感）
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open || !workspace) return
    // 每次打开都从空开始：上一次的选择不该带到下一次
    setEntries(null)
    setSelected(null)
    setBusy(false)
    setError(null)
    setPendingRemove(null)
    submittingRef.current = false
    // 清掉上一次操作留下的全局错误，免得弹窗一开就顶着一句无关的旧报错
    app.clearError()
    void scan(workspace)
    // app 每次渲染都是新引用，只用 open / workspace 驱动（与 NewWorktreeDialog 一致）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspace?.id])

  const submit = async (): Promise<void> => {
    if (!workspace || !selected || busy || submittingRef.current) return
    submittingRef.current = true
    setBusy(true)
    try {
      // 失败时 app.error 里有服务端给的原话，弹窗留着让用户改完重试
      const created = await app.loadWorktree(workspace.id, { identifier: selected })
      if (created) {
        setSelected(null)
        onLoaded?.(created)
      }
    } finally {
      submittingRef.current = false
      setBusy(false)
    }
  }

  /** 已登记的那条 → 拿到完整的 workspace 对象，交给共用确认弹窗 */
  const findWorkspace = (workspaceId: string): AgentWorkspace | null =>
    app.workspaces.find((ws) => ws.id === workspaceId) ?? null

  const remove = async (
    target: AgentWorkspace,
    options: WorkspaceDeleteInput
  ): Promise<void> => {
    setPendingRemove(null)
    setBusy(true)
    try {
      // 返回 false 表示服务端报错（原因已进 app.error），清单保持原样让用户重试
      const ok = await app.deleteWorkspace(target.id, options)
      if (ok) setSelected(null)
    } finally {
      setBusy(false)
    }
  }

  const shownError = error ?? app.error
  const available = (entries ?? []).filter((entry) => !entry.workspaceId)
  /** 首次扫描（还没有任何结果）：清单区显示「正在读取」；之后的重扫保留旧清单 */
  const firstScan = loading && entries === null
  /** 首次扫描就失败：错误直接占住清单区（不再在下面多挂一行，免得又是一次高度变化） */
  const boxError = entries === null && !loading ? shownError : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr('管理工作区')}</DialogTitle>
          <DialogDescription>
            {tr('勾选导入为工作区，已导入的可移除。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {loading
                ? tr('正在扫描…')
                : tr('共 {total} 个，可导入 {available} 个', {
                    total: entries?.length ?? 0,
                    available: available.length
                  })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-xs"
              disabled={loading || busy || !workspace}
              onClick={() => workspace && void scan(workspace)}
            >
              {loading ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              {tr('重新扫描')}
            </Button>
          </div>

          {/*
            清单区**高度钉死**（`h-60` = 原来的 `max-h-60`）：空态 / 清单 / 扫描中三种内容
            都在同一个盒子里换，点「重新扫描」时弹窗不会先塌再长（用户报的「高度跳变」）。
            重扫期间**保留旧清单**（只降透明度 + 禁点），而不是卸载成一行提示 —— 内容不消失，
            高度自然不动；首次扫描（还没有任何结果）才显示「正在读取」。
          */}
          <div className="flex h-60 min-h-0 flex-col overflow-hidden rounded-md border border-border/70">
            {firstScan && (
              <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {tr('正在读取 .worktree/ 目录…')}
              </div>
            )}

            {boxError && (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-destructive">
                {boxError}
              </div>
            )}

            {!firstScan && !boxError && entries && entries.length > 0 && (
              <div
                className={cn(
                  'min-h-0 flex-1 overflow-y-auto p-1',
                  loading && 'pointer-events-none opacity-60'
                )}
                aria-busy={loading || undefined}
              >
                {entries.map((entry) => {
                  const loadedWs = entry.workspaceId ? findWorkspace(entry.workspaceId) : null
                  // 不是 git worktree 的目录不给导入：登记进去只会在侧栏多一个坏项目
                  const selectable = !entry.workspaceId && entry.isWorktree
                  const checked = selected === entry.identifier
                  return (
                    <div
                      key={entry.identifier}
                      className={cn(
                        'flex items-center gap-2 rounded px-1.5 py-1 text-xs',
                        checked && 'bg-primary/10 text-foreground'
                      )}
                    >
                      <button
                        type="button"
                        disabled={!selectable || busy}
                        onClick={() => setSelected(selectable ? entry.identifier : null)}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                          loadedWs && 'cursor-default'
                        )}
                      >
                        {/* 单选语义：选中打勾，未选中空框 */}
                        <span
                          className={cn(
                            'flex size-3.5 shrink-0 items-center justify-center rounded border',
                            checked
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border'
                          )}
                        >
                          {checked && <Check className="size-2.5" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block w-full truncate font-medium">
                            {entry.identifier}
                          </span>
                          <span className="block w-full truncate text-muted-foreground">
                            {entry.branch ? tr('分支 {branch}', { branch: entry.branch }) : entry.path}
                          </span>
                        </span>
                      </button>
                      {loadedWs ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 shrink-0 px-1.5 text-xs text-destructive hover:text-destructive"
                          disabled={busy}
                          onClick={() => setPendingRemove(loadedWs)}
                        >
                          {tr('移除')}
                        </Button>
                      ) : (
                        !entry.isWorktree && (
                          <span className="shrink-0 rounded border border-border px-1 text-[0.625rem] leading-4 text-muted-foreground">
                            {tr('不是 worktree')}
                          </span>
                        )
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/*
              扫不到任何目录：用 shadcn 的 `Empty` 收口，不写一段解释性长文案 ——
              这里是「清单为空」的占位，不是教学页；该怎么建 worktree 由「新建工作区」
              那个入口负责（它自己的弹窗里有说明）。
            */}
            {!firstScan && !boxError && entries && entries.length === 0 && (
              <Empty className="flex-1 p-4">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderOpen />
                  </EmptyMedia>
                  <EmptyTitle>{tr('还没有工作区')}</EmptyTitle>
                  <EmptyDescription>
                    {tr('这个项目的 .worktree/ 目录是空的')}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>

          {/* 首次扫描失败时错误已经占住清单区（见 boxError），这里只挂「清单还在、重扫失败」那种 */}
          {!boxError && shownError && <p className="text-xs text-destructive">{shownError}</p>}
        </div>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {tr('取消')}
          </Button>
          <Button disabled={!workspace || !selected || busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderOpen className="size-4" />}
            {tr('导入')}
          </Button>
        </DialogFooter>

        {/* 移除是破坏性的，弹一层共用确认（「同时删除 git worktree」的勾选在那边） */}
        <WorkspaceDeleteDialog
          workspace={pendingRemove}
          onCancel={() => setPendingRemove(null)}
          onConfirm={(target, options) => void remove(target, options)}
        />
      </DialogContent>
    </Dialog>
  )
}