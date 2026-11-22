/**
 * 输入卡片下方的**常驻状态横条**：git 分支 / 权限档 / 上下文占用（工作区只在空会话里出现）。
 *
 * 以前这一条只在空会话里显示工作区选择，建完会话就整条消失；权限与上下文圆环挤在
 * 卡片内的操作行里（那行还要放附件、模型、语音、发送，窄屏时互相挤）。现在：
 *
 * - 横条**常驻**（高度只有一行控件，不再额外加纵向内边距）；
 * - 工作区入口不在这里：它在「开始新对话」页的标题句（「在 ___ 里做点什么？」）里；
 * - git 分支**常驻**，按状态置灰：**这一轮正在跑**时不可切；空闲时只要仓库有分支就能点，
 *   弹与「工作区选择」同一套 `PickerPanel`（搜索 + 列表 + 底部新建），切换 / 新建分支；
 * - 切换工作区时分支属于旧仓库：先显示 skeleton，读到新的再替换，避免闪一下旧分支名；
 * - 权限档与上下文圆环从卡片内搬到这一条右侧。
 */
import { useEffect, useState } from 'react'
import { ChevronDown, GitBranch, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverTrigger } from '@fizz/ui/popover'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Skeleton } from '@fizz/ui/skeleton'
import {
  PickerAction,
  PickerEmpty,
  PickerFooter,
  PickerItem,
  PickerLabel,
  PickerList,
  PickerPanel,
  PickerSearch
} from '@fizz/ui/picker-panel'
import type { GitBranchesResult } from '@fizz/git'
import { AcpPermissionPill } from '@fizz/agent-kit/features/chat/AcpPermissionPill'
import { ContextRing } from '@fizz/agent-kit/features/chat/ContextRing'
import { turnIsAcp } from '@fizz/agent-kit/features/chat/session-backend'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { PermissionPill, CHAT_PILL } from '@fizz/agent-kit/features/chat/composer'

/**
 * git 分支 pill（**常驻**，按状态置灰）。
 *
 * - 空闲 + 工作区是仓库：可点，弹 popover 切换分支 / 新建分支（从当前 HEAD）；
 * - 这一轮正在跑：显示当前分支但置灰不可点 —— 会话目录正被使用，切分支是危险操作；
 * - 没选工作区 / 工作区不是仓库：显示灰态占位（「Git」/「非 Git 仓库」），不可点。
 */
function BranchPill({ app, editable }: { app: AgentApp; editable: boolean }) {
  const tr = useT()
  const isMobile = useIsMobile()
  const { activePanel, patchActivePanel } = useAppContext()
  const branch = activePanel?.gitBranch ?? null
  const workspaceId = app.activeWorkspaceId
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)
  const [loading, setLoading] = useState(false)
  /** 切换工作区后、新仓库的分支读回来之前：显示骨架，别让旧分支名留在横条上 */
  const [branchLoading, setBranchLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const applyStatus = (status: Awaited<ReturnType<typeof app.gitStatus>>): void => {
    patchActivePanel({
      gitBranch: status.isRepo
        ? (status.branch ?? (status.detached ? tr('HEAD（分离）') : null))
        : null
    })
  }

  /**
   * 切换工作区 → 分支立刻作废：先骨架，再读新仓库的真实分支。
   *
   * 依赖只写 `workspaceId`：`app` / `patchActivePanel` 每次渲染都是新引用，进依赖会让
   * effect 每帧重跑（项目里这条坑踩过多次）。
   */
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    setBranchLoading(true)
    void app
      .gitStatus(workspaceId)
      .then((status) => {
        if (!cancelled) applyStatus(status)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setBranchLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  const hasWorkspace = Boolean(workspaceId)
  const isRepo = Boolean(branch)
  /**
   * 可点条件只看「有没有工作区、这一轮有没有在跑」：
   * 非 Git 仓库也可以点 —— 面板里给「初始化仓库」，而不是在横条上摆一行灰字。
   */
  const enabled = editable && hasWorkspace
  const label = branch ?? tr('Git')
  /** 置灰原因：tooltip 说清「为什么不能点」，别只留一个灰块 */
  const disabledHint = !hasWorkspace
    ? tr('先选择工作区')
    : isRepo
      ? tr('当前分支：{branch}（会话中不能切分支）', { branch: label })
      : tr('会话中不能初始化仓库')

  const reset = (): void => {
    setCreating(false)
    setNewName('')
    setQuery('')
  }

  const loadBranches = (): void => {
    if (!workspaceId) return
    setLoading(true)
    void app
      .gitBranches(workspaceId)
      .then(setBranches)
      .catch(() => setBranches(null))
      .finally(() => setLoading(false))
  }

  /** 切 / 建之后重读真实分支名，写回当前面板（横条显示的是这份） */
  const refreshBranch = async (): Promise<void> => {
    if (!workspaceId) return
    applyStatus(await app.gitStatus(workspaceId))
  }

  const switchTo = async (ref: string): Promise<void> => {
    if (!workspaceId || ref === branch) {
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      await app.gitAction(workspaceId, { action: 'checkout', ref })
      // 检出远端分支时本地名不一定是 ref 原文，重新读一次
      await refreshBranch()
      setOpen(false)
    } catch (err) {
      toast.error(
        tr('切换分支失败：{error}', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setBusy(false)
    }
  }

  const createBranch = async (): Promise<void> => {
    const name = newName.trim()
    if (!workspaceId || !name) return
    setBusy(true)
    try {
      await app.gitAction(workspaceId, { action: 'create-branch', name })
      await refreshBranch()
      setOpen(false)
      reset()
    } catch (err) {
      toast.error(
        tr('新建分支失败：{error}', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setBusy(false)
    }
  }

  /** 还不是仓库：就地 `git init`（不自动提交，避免把目录里现有的东西打包提交） */
  const initRepo = async (): Promise<void> => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await app.gitAction(workspaceId, { action: 'init' })
      await refreshBranch()
      setOpen(false)
    } catch (err) {
      toast.error(
        tr('初始化仓库失败：{error}', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setBusy(false)
    }
  }

  if (branchLoading) {
    return (
      <span className="flex h-8 min-w-0 items-center gap-1.5 px-3">
        <Skeleton className="h-4 w-24 rounded-md" />
      </span>
    )
  }

  if (!enabled) {
    return (
      <span
        // 与可点态同一套字号 / 行高，只把颜色压成次要色 + 降透明度表示不可用
        className="flex h-8 min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground opacity-60"
        title={disabledHint}
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="max-w-40 truncate">{label}</span>
      </span>
    )
  }

  const keyword = query.trim().toLowerCase()
  const match = (name: string): boolean => !keyword || name.toLowerCase().includes(keyword)
  const local = (branches?.branches ?? []).filter(match)
  const remote = (branches?.remotes ?? []).filter(match)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // 非仓库没有分支可列：只显示「初始化仓库」，别白打一次 branches 接口
        if (next && isRepo) loadBranches()
        reset()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            isRepo
              ? tr('当前 git 分支：{branch}，点击切换或新建', { branch: label })
              : tr('当前工作区还不是 Git 仓库，点击初始化')
          }
          // 与工作区选择器同款（两者都吃 CHAT_PILL）：字号 / 颜色 / hover 一致
          className={CHAT_PILL}
        >
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      {/*
        与「工作区选择」同一个面板原语（`PickerPanel`：搜索 + 列表 + 底部动作），
        不是另写一套列表。向上弹：横条贴着窗口底边。
      */}
      <PickerPanel
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        footer={
          <PickerFooter>
            {creating ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void createBranch()
                }}
              >
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={tr('分支名，如 feature/login')}
                  className="h-8 text-xs"
                  autoFocus
                />
                <div className="flex justify-end gap-1">
                  <Button type="button" variant="ghost" size="sm" className="h-7" onClick={reset}>
                    {tr('取消')}
                  </Button>
                  <Button type="submit" size="sm" className="h-7" disabled={!newName.trim() || busy}>
                    {tr('创建并切换')}
                  </Button>
                </div>
              </form>
            ) : !isRepo ? (
              <PickerAction icon={<GitBranch />} disabled={busy} onClick={() => void initRepo()}>
                {tr('初始化仓库')}
              </PickerAction>
            ) : (
              <PickerAction icon={<Plus />} onClick={() => setCreating(true)}>
                {tr('新建分支…')}
              </PickerAction>
            )}
          </PickerFooter>
        }
      >
        {isRepo ? (
          <PickerSearch
            autoFocus={!isMobile}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr('搜索分支')}
            aria-label={tr('搜索分支')}
          />
        ) : null}
        <PickerList>
          {!isRepo ? (
            <PickerEmpty>{tr('当前工作区还不是 Git 仓库')}</PickerEmpty>
          ) : loading ? (
            <PickerEmpty>{tr('读取分支…')}</PickerEmpty>
          ) : local.length === 0 && remote.length === 0 ? (
            <PickerEmpty>
              {keyword ? tr('没有匹配的分支') : tr('没有可切换的分支')}
            </PickerEmpty>
          ) : (
            <>
              {local.length ? <PickerLabel>{tr('本地分支')}</PickerLabel> : null}
              {local.map((name) => (
                <PickerItem
                  key={`local:${name}`}
                  value={`local:${name}`}
                  icon={<GitBranch />}
                  active={name === branch}
                  onSelect={() => void switchTo(name)}
                >
                  {name}
                </PickerItem>
              ))}
              {remote.length ? <PickerLabel>{tr('远端分支')}</PickerLabel> : null}
              {remote.map((name) => (
                <PickerItem
                  key={`remote:${name}`}
                  value={`remote:${name}`}
                  icon={<GitBranch />}
                  hint={tr('远端')}
                  active={name === branch}
                  onSelect={() => void switchTo(name)}
                >
                  {name}
                </PickerItem>
              ))}
            </>
          )}
        </PickerList>
      </PickerPanel>
    </Popover>
  )
}

export function ComposerStatusBar({ app, running }: { app: AgentApp; running: boolean }) {
  const isAcp = turnIsAcp(app)
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      {/* 「会话中」= 这一轮正在跑（不是「有没有会话」）：空闲的会话也能切分支 */}
      <BranchPill app={app} editable={!running} />
      {/* 与输入相关的控件留在卡片里；这两颗是「当前状态 / 全轮生效」的设置，归到横条 */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ContextRing app={app} />
        {isAcp ? (
          <AcpPermissionPill app={app} />
        ) : (
          <PermissionPill value={app.permissionMode} onChange={app.setPermissionMode} />
        )}
      </div>
    </div>
  )
}
