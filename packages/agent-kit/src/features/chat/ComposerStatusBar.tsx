/**
 * 输入卡片下方的**常驻状态横条**：git 分支 / 权限档 / 上下文占用（工作区只在空会话里出现）。
 *
 * 以前这一条只在空会话里显示工作区选择，建完会话就整条消失；权限与上下文圆环挤在
 * 卡片内的操作行里（那行还要放附件、模型、语音、发送，窄屏时互相挤）。现在：
 *
 * - 横条**常驻**（高度只有一行控件，不再额外加纵向内边距）；
 * - 工作区入口不在这里：它在「开始新对话」页的标题句（那段淡色空位条）里；
 * - git pill：有工作区时可点，打开 / 收起「源代码管理」侧栏（分支切换、暂存、提交都在
 *   那里面，见 `GitPanel`）；**没选工作区时置灰不可点**。这里负责显示当前分支与未提交
 *   改动数（徽章从顶栏那颗 git 按钮迁过来）。不再兼做分支选择器；
 * - 切换工作区时分支属于旧仓库：先显示 skeleton，读到新的再替换，避免闪一下旧分支名；
 * - 权限档与上下文圆环从卡片内搬到这一条右侧。
 */
import { useEffect, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { Skeleton } from '@fizz/ui/skeleton'
import { AcpPermissionPill } from '@fizz/agent-kit/features/chat/AcpPermissionPill'
import { ContextRing } from '@fizz/agent-kit/features/chat/ContextRing'
import { turnIsAcp } from '@fizz/agent-kit/features/chat/session-backend'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { PermissionPill } from '@fizz/agent-kit/features/chat/composer'

/**
 * git 分支 pill（**常驻、任何时候都可点**）。
 *
 * 点击 = 打开 / 收起当前会话的「源代码管理」侧栏。切分支、建分支、暂存、提交这些操作
 * 都在面板里，横条上只展示当前分支（没有工作区 / 不是仓库时仍可点开面板，由面板给出
 * 「初始化仓库」等入口）。
 */
function BranchPill({ app }: { app: AgentApp }) {
  const tr = useT()
  const { activePanel, patchActivePanel, toggleSideTab, gitBadge } = useAppContext()
  const branch = activePanel?.gitBranch ?? null
  const workspaceId = app.activeWorkspaceId
  /** 切换工作区后、新仓库的分支读回来之前：显示骨架，别让旧分支名留在横条上 */
  const [branchLoading, setBranchLoading] = useState(false)

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
    if (!workspaceId) {
      // 横条上不能继续挂着上一个工作区的分支名
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

  const label = branch ?? tr('Git')
  /** 没有工作区时没有「源代码管理」可看，横条置灰且不可点 */
  const disabled = !workspaceId

  return (
    <div
      className={
        'flex h-8 min-w-0 items-center rounded text-sm text-muted-foreground transition-colors' +
        (disabled ? '' : ' hover:bg-foreground/5 hover:text-foreground')
      }
    >
      <button
        type="button"
        onClick={() => toggleSideTab('git')}
        disabled={disabled}
        title={disabled ? tr('先选择工作区') : tr('打开源代码管理（Git）面板')}
        className="flex min-w-0 items-center gap-1.5 rounded py-1 pl-3 pr-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="inline-flex min-w-0 items-center">
          {branchLoading ? (
            <Skeleton className="h-4 w-24 rounded-md" />
          ) : (
            <span className="max-w-40 truncate">{label}</span>
          )}
          {/* 等分支名读回来再挂徽章：切工作区时骨架旁边先冒出个旧数字很别扭。
              用行内相对位移抬到右上角，而不是 absolute 压在文字上 —— 数字再长也不会挡住分支名。 */}
          {!branchLoading && gitBadge ? (
            <span className="relative -top-1.5 ml-1 min-w-4 shrink-0 rounded-full bg-primary px-1 text-center text-[0.625rem] font-medium leading-4 text-primary-foreground tabular-nums">
              {gitBadge}
            </span>
          ) : null}
        </span>
      </button>
    </div>
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
      <BranchPill app={app} />
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
