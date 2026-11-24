/**
 * 输入卡片下方的**常驻状态横条**：git 分支 / 权限档 / 上下文占用（工作区只在空会话里出现）。
 *
 * 以前这一条只在空会话里显示工作区选择，建完会话就整条消失；权限与上下文圆环挤在
 * 卡片内的操作行里（那行还要放附件、模型、语音、发送，窄屏时互相挤）。现在：
 *
 * - 横条**常驻**（高度只有一行控件，不再额外加纵向内边距）；
 * - 工作区入口不在这里：它在「开始新对话」页的标题句（那段淡色空位条）里；
 * - git 分支**常驻**，按状态置灰：**这一轮正在跑**时不可切；空闲时只要仓库有分支就能点；
 * - 切换工作区时分支属于旧仓库：先显示 skeleton，读到新的再替换，避免闪一下旧分支名；
 * - 权限档与上下文圆环从卡片内搬到这一条右侧。
 *
 * ## 分支面板已抽到 `BranchPicker`
 *
 * 面板长相（搜索 / 本地 · 远端分组 / 新建 / hover 删除 / 删除确认）与 `GitPanel` 头部
 * 那颗共用一份实现（见 `BranchPicker.tsx`）。这里只剩「composer 特有的那截」：读当前
 * 工作区的分支、按会话是否在跑决定置灰、以及四个写动作成功后的刷新与 toast。
 */
import { useEffect, useRef, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { Skeleton } from '@fizz/ui/skeleton'
import type { GitBranchesResult } from '@fizz/git'
import { AcpPermissionPill } from '@fizz/agent-kit/features/chat/AcpPermissionPill'
import {
  BranchPicker,
  type BranchDeleteTarget
} from '@fizz/agent-kit/features/chat/BranchPicker'
import { ContextRing } from '@fizz/agent-kit/features/chat/ContextRing'
import { turnIsAcp } from '@fizz/agent-kit/features/chat/session-backend'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { PermissionPill } from '@fizz/agent-kit/features/chat/composer'

/**
 * git 分支 pill（**常驻**，按状态置灰）。
 *
 * - 空闲 + 工作区是仓库：可点，弹 `BranchPicker`（与 `GitPanel` 同一颗）；
 * - 这一轮正在跑：显示当前分支但置灰不可点 —— 会话目录正被使用，切分支是危险操作；
 * - 没选工作区 / 工作区不是仓库：显示灰态占位（「Git」/「非 Git 仓库」），不可点。
 */
function BranchPill({ app, editable }: { app: AgentApp; editable: boolean }) {
  const tr = useT()
  const { activePanel, patchActivePanel } = useAppContext()
  const branch = activePanel?.gitBranch ?? null
  const workspaceId = app.activeWorkspaceId
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)
  const [loading, setLoading] = useState(false)
  /** 切换工作区后、新仓库的分支读回来之前：显示骨架，别让旧分支名留在横条上 */
  const [branchLoading, setBranchLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 分支清单请求的代次：换工作区后旧请求的结果必须丢掉（否则旧仓库的清单会晚到覆盖） */
  const branchLoadGen = useRef(0)

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
    // 换工作区（或被删 / 取消选择）：旧仓库的分支清单、在途请求与 loading 都作废
    branchLoadGen.current += 1
    setBranches(null)
    setLoading(false)
    if (!workspaceId) {
      // 上一次请求的 cleanup 会把它自己的 `finally` 置为不生效，这里必须自己收骨架屏；
      // 横条上也不能继续挂着上一个工作区的分支名
      setBranchLoading(false)
      if (branch) patchActivePanel({ gitBranch: null })
      return
    }
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

  /**
   * 读分支清单。
   *
   * `silent` = 面板已经开着、手上有一份清单时用（改名 / 新建 / 删除 / 初始化之后）：
   * **不置 loading、不清旧数据**，结果回来原地替换。否则面板会先切回骨架屏
   * 再长回列表 —— 高度跳一下（用户报过）。
   */
  const loadBranches = (silent = false): void => {
    if (!workspaceId) return
    const gen = ++branchLoadGen.current
    if (!silent) setLoading(true)
    void app
      .gitBranches(workspaceId)
      .then((result) => {
        if (branchLoadGen.current === gen) setBranches(result)
      })
      .catch(() => {
        // 静默刷新失败就保留旧清单（别把列表清成骨架屏）
        if (branchLoadGen.current === gen && !silent) setBranches(null)
      })
      .finally(() => {
        // 只判 `silent`、不判代次：静默刷新若抢先返回，首个非静默请求的代次已过期，
        // 再把 `setLoading(false)` 一起跳过就会永远停在骨架屏。
        if (!silent) setLoading(false)
      })
  }

  /** 切 / 建 / 删之后重读真实分支名，写回当前面板（横条显示的是这份） */
  const refreshBranch = async (): Promise<void> => {
    if (!workspaceId) return
    applyStatus(await app.gitStatus(workspaceId))
  }

  const switchTo = async (ref: string): Promise<void> => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await app.gitAction(workspaceId, { action: 'checkout', ref })
      // 检出远端分支时本地名不一定是 ref 原文，重新读一次
      await refreshBranch()
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

  const createBranch = async (name: string, from?: string): Promise<void> => {
    if (!workspaceId || !name) return
    setBusy(true)
    try {
      // `from` 不传 = 从当前 HEAD 切；面板里可以把起点改成任意本地 / 远端分支
      await app.gitAction(workspaceId, { action: 'create-branch', name, ...(from ? { from } : {}) })
      await refreshBranch()
      loadBranches(true)
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
      // 面板不关：初始化完当场换成分支清单（不然会停在「没有可切换的分支」）
      await refreshBranch()
      loadBranches(true)
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

  /**
   * 删分支（确认框点过「删除」之后才走到这里）：本地 `git branch -d` / `-D`，远端
   * `git push <remote> --delete <branch>` —— 与「源代码管理」面板走同一个动作。
   *
   * 删完分支清单与横条上的当前分支都重读：删远端分支时本地那条 remote-tracking ref
   * 也会跟着消失。git 的拒绝原话（「还没合并」「没权限」）原样带回 toast。
   */
  const deleteBranch = async (target: BranchDeleteTarget, force: boolean): Promise<void> => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await app.gitAction(
        workspaceId,
        target.kind === 'remote'
          ? { action: 'delete-remote-branch', remote: target.remote, branch: target.branch }
          : { action: 'delete-branch', name: target.name, force }
      )
      loadBranches(true)
      await refreshBranch()
    } catch (err) {
      toast.error(
        tr('删除分支失败：{error}', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setBusy(false)
    }
  }

  /**
   * 本地分支改名（`git branch -m`）：只动引用名，提交与工作区内容都不变；当前分支也能改，
   * HEAD 会跟着指向新名字。成功后面板不关，分支清单与横条上的当前分支都重读。
   */
  const renameBranch = async (from: string, to: string): Promise<void> => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await app.gitAction(workspaceId, { action: 'rename-branch', from, to })
      loadBranches(true)
      await refreshBranch()
    } catch (err) {
      toast.error(
        tr('重命名分支失败：{error}', {
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

  return (
    <BranchPicker
      branch={branch}
      isRepo={isRepo}
      branches={branches}
      loading={loading}
      busy={busy}
      // 与「工作区选择」同款 pill；面板向上弹（横条贴着窗口底边）
      label={label}
      emptyLabel={tr('Git')}
      // 分支可能在终端里被切过：每次打开面板都重读「当前分支 + 清单」，
      // 只刷清单的话打勾项与 pill 文案仍是旧的（用户报过）
      onOpen={() => {
        void refreshBranch()
        loadBranches()
      }}
      onCheckout={switchTo}
      onCreate={createBranch}
      onInit={initRepo}
      onDelete={deleteBranch}
      onRename={renameBranch}
      side="top"
      align="start"
    />
  )
}

/**
 * 本轮**实时估算**的输出速度（tok/s），放在上下文圆环左侧。
 *
 * 只在「这一轮正在跑、且已经采到速度」时出现：数字来自流式增量的客户端估算
 * （见 `shared/lib/live-tps.ts` 的口径说明），轮末会以服务端 `usage.tps` 为准 ——
 * 所以这里不显示在空闲态，也不进 tooltip 之外的任何统计。
 */
function LiveTps({ app, running }: { app: AgentApp; running: boolean }) {
  const tr = useT()
  const tps = app.liveTps?.tps ?? 0
  if (!running || tps <= 0) return null
  return (
    <span
      className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground"
      title={tr(
        '实时输出速度（按字符估算）：{tps} tokens/秒。轮次结束后以服务端统计为准。',
        { tps }
      )}
    >
      {tr('{tps} tok/s', { tps })}
    </span>
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
        <LiveTps app={app} running={running} />
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
