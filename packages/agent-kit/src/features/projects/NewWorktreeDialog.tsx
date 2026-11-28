/**
 * 「新建 worktree」弹窗。
 *
 * 从项目行的「更多」菜单打开：在**当前项目**下按某个分支拉一个 git worktree，
 * 目录固定落在 `<项目目录>/.worktree/<标识>`，并在创建成功后把它登记成一个新项目
 * （侧栏名称右侧挂 worktree 徽标）。
 *
 * 与流程节点的工作区（`.fizz/`）是两码事：这个只是给人在浏览器里开一个独立工作树的
 * 普通项目。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { GitBranch, Loader2 } from 'lucide-react'
import type { AgentWorkspace } from '@fizz/contracts/agent-api'
import { WORKTREE_IDENTIFIER_RE } from '@fizz/contracts/agent-api'
import { Button } from '@fizz/ui/button'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fizz/ui/select'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 「用仓库当前分支」的哨兵值（Radix Select 不接受空字符串做 value） */
const HEAD_SENTINEL = '__head__'

export function NewWorktreeDialog({
  app,
  workspace,
  open,
  onOpenChange,
  onCreated
}: {
  app: AgentApp
  workspace: AgentWorkspace | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (workspace: AgentWorkspace) => void
}): ReactNode {
  const [identifier, setIdentifier] = useState('')
  const [name, setName] = useState('')
  /** 选中的基线分支；空串 = 仓库当前分支（服务端回落 HEAD） */
  const [baseBranch, setBaseBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const tr = useT()
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !workspace) return
    setIdentifier('')
    setName('')
    setBaseBranch('')
    setBranches([])
    setBusy(false)
    setError(null)
    // 清掉上一次操作留下的全局错误，免得弹窗一开就顶着一句无关的旧报错
    app.clearError()
    setLoadingBranches(true)
    let cancelled = false
    void app
      .gitBranches(workspace.id)
      .then((res) => {
        if (cancelled) return
        setBranches(res.branches)
        setBaseBranch(res.current ?? '')
      })
      .catch((err) => {
        // 拉不到分支不拦着提交：服务端会再判一次基线分支是否存在，真不行它给一句人话
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingBranches(false)
      })
    return () => {
      cancelled = true
    }
    // app 每次渲染都是新引用，只用 open / workspace 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspace?.id])

  const cleanIdentifier = identifier.trim()
  const identifierValid = WORKTREE_IDENTIFIER_RE.test(cleanIdentifier)

  const submit = async (): Promise<void> => {
    if (!workspace || busy) return
    if (!identifierValid) {
      setError(tr('worktree 标识只能包含字母、数字、-、_、.，且要以字母或数字开头'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await app.createWorktree(workspace.id, {
        identifier: cleanIdentifier,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(baseBranch ? { baseBranch } : {})
      })
      // 失败时 app.error 里有服务端给的原话，弹窗留着让用户改完重试
      if (created) onCreated?.(created)
    } finally {
      setBusy(false)
    }
  }

  const shownError = error ?? app.error

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr('新建 worktree')}</DialogTitle>
          <DialogDescription>
            {tr('在 {name} 下新建工作树，自动登记成项目。', {
              name: workspace?.name ?? tr('当前项目')
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-worktree-id">{tr('worktree 标识')}</Label>
            <Input
              variant="muted"
              id="new-worktree-id"
              autoFocus
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder={tr('英文标识，如 feature-login')}
            />
            <p className="text-xs text-muted-foreground">
              {tr('目录会建在 {path}/.worktree/{id}，分支名为 worktree/{id}。', {
                path: workspace?.path ?? tr('<项目目录>'),
                id: cleanIdentifier || 'xxx'
              })}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-worktree-name">{tr('项目名（可选）')}</Label>
            <Input
              variant="muted"
              id="new-worktree-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tr('留空 = 用标识作为项目名')}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            {/* 读取中把转圈塞进标题行：单独占一行会让下面的字段整体下移一下再回来（高度跳变） */}
            <Label className="flex items-center gap-1.5">
              {tr('基线分支')}
              {loadingBranches && (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              )}
            </Label>
            <Select
              value={baseBranch || HEAD_SENTINEL}
              items={{
                [HEAD_SENTINEL]: tr('仓库当前分支（HEAD）'),
                ...Object.fromEntries(branches.map((branch) => [branch, branch]))
              }}
              onValueChange={(v) => setBaseBranch(v === HEAD_SENTINEL ? '' : v)}
            >
              <SelectTrigger variant="muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HEAD_SENTINEL}>{tr('仓库当前分支（HEAD）')}</SelectItem>
                {branches.map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {shownError && <p className="text-xs text-destructive">{shownError}</p>}
        </div>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button disabled={!workspace || busy || !identifierValid} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <GitBranch className="size-4" />}
            {tr('创建 worktree')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}