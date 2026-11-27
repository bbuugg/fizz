/**
 * 输入卡片下方的**常驻状态横条**：本地 / 远程、git 分支 / 权限档 / 上下文占用（工作区只在空会话里出现）。
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
 * - 同一工作区首次加载完成后，轮末刷新保留现有分支与改动数，不再显示 skeleton；
 * - 权限档与上下文圆环从卡片内搬到这一条右侧。
 */
import { useEffect, useRef, useState } from 'react'
import { Cloud, Folder, GitBranch } from 'lucide-react'
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
 * 点击 = 打开 / 收起**本标签**的「源代码管理」侧栏。切分支、建分支、暂存、提交这些操作
 * 都在面板里，横条上只展示当前分支（没有工作区 / 不是仓库时仍可点开面板，由面板给出
 * 「初始化仓库」等入口）。
 *
 * `panelKey` = 本标签的 key。面板现场按标签存，所以它必须由宿主（`ConversationTab`）
 * 一路传下来 —— 从 `app.activeConversationId` 反推是错的：那会把别的标签的面板改掉。
 */
function BranchPill({ app, panelKey }: { app: AgentApp; panelKey: string }) {
  const tr = useT()
  const { panelOf, patchPanelOf, toggleSideTabOf } = useAppContext()
  const workspaceId = app.activeWorkspaceId
  const panel = panelOf(panelKey)
  const branch = panel?.gitBranch ?? null
  const changeCount = panel?.gitChanges?.count ?? 0
  const gitBadge = changeCount > 0
    ? `${changeCount}${panel?.gitChanges?.truncated ? '+' : ''}`
    : null
  /** 仅当前标签 / 工作区首次加载显示骨架，后续刷新保留现有状态。 */
  const [branchLoading, setBranchLoading] = useState(false)
  const loadedScope = useRef<{ workspaceId: string; panelKey: string } | null>(null)

  const applyStatus = (status: Awaited<ReturnType<typeof app.gitStatus>>): void => {
    patchPanelOf(panelKey, (base) => ({
      ...base,
      gitChanges: status.isRepo
        ? { count: status.changes.length, truncated: status.truncated }
        : null,
      gitBranch: status.isRepo
        ? (status.branch ?? (status.detached ? tr('HEAD（分离）') : null))
        : null
    }))
  }

  /**
   * 切换工作区 → 先骨架，再读新仓库的真实分支；同仓库轮末只做静默刷新。
   *
   * 依赖绑定本标签的工作区 / 面板 / 运行状态，轮末也刷新非焦点标签。
   * `app` 每次渲染都是新引用，进依赖会让
   * effect 每帧重跑（项目里这条坑踩过多次）。
   */
  useEffect(() => {
    if (!workspaceId) {
      // 横条上不能继续挂着上一个工作区的分支名
      loadedScope.current = null
      setBranchLoading(false)
      if (branch || changeCount) {
        patchPanelOf(panelKey, (base) => ({ ...base, gitBranch: null, gitChanges: null }))
      }
      return
    }
    if (app.streaming) {
      setBranchLoading(false)
      return
    }
    let cancelled = false
    setBranchLoading(
      loadedScope.current?.workspaceId !== workspaceId || loadedScope.current?.panelKey !== panelKey
    )
    void app
      .gitStatus(workspaceId)
      .then((status) => {
        if (!cancelled) applyStatus(status)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          loadedScope.current = { workspaceId, panelKey }
          setBranchLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, panelKey, app.streaming])

  const label = branch ?? tr('Git')
  /** 没有工作区时没有「源代码管理」可看，横条置灰且不可点 */
  const disabled = !workspaceId

  return (
    <div className="flex min-w-0 items-center text-sm text-muted-foreground">
      {/*
        hover 底色挂在**按钮自己**、且高度收到 `h-6`（24px）：原来挂在外面那层 `h-8` 上，
        32px 的方块比文字高出一截，和右侧权限 / 上下文那几颗「只变色、不出块」的 pill 摆在一起
        很突兀（用户反馈「hover 后有一个很高的背景」）。外层因此不再定高、也不再带 hover。
      */}
      <button
        type="button"
        onClick={() => toggleSideTabOf(panelKey, 'git')}
        disabled={disabled}
        title={disabled ? tr('先选择工作区') : tr('打开源代码管理（Git）面板')}
        className={
          'flex h-6 min-w-0 items-center gap-1.5 rounded-md pl-3 pr-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60' +
          (disabled ? '' : ' hover:bg-foreground/5 hover:text-foreground')
        }
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
 * 「本地 / 远程」pill：告诉人这个项目在哪儿（本地 = 文件夹图标，远端 = 云 + 主机名）。
 *
 * 点击 = 打开当前工作区的**文件面板**（与顶栏 / 侧栏那些入口同一个 side tab）。
 * 没有活动工作区、或工作区没有目录时返回 null —— 没有目录就没有文件面板可开，
 * 留一颗点不动的入口只会让人以为坏了。
 *
 * 与 git pill 同一套尺寸与 hover（`h-6` + 淡前景色，见 `BranchPill` 的注释）。
 */
function WorkspaceLocationPill({ app, panelKey }: { app: AgentApp; panelKey: string }) {
  const tr = useT()
  const { toggleSideTabOf } = useAppContext()
  const workspace = app.activeWorkspace
  if (!workspace?.path) return null
  const remote = workspace.remote
  const hostName = remote
    ? app.sshHosts.find((host) => host.id === remote.hostId)?.name
    : undefined
  const Icon = remote ? Cloud : Folder
  // 远端尽量报主机名（「远程 · termux」比一个泛泛的「远程」有用）；主机已删就退回「远程」
  const label = remote ? (hostName ?? tr('远程')) : tr('本地')
  const title = `${label} · ${workspace.path}\n${tr('打开文件面板')}`
  return (
    <div className="flex min-w-0 items-center text-sm text-muted-foreground">
      <button
        type="button"
        onClick={() => toggleSideTabOf(panelKey, 'files')}
        title={title}
        aria-label={title}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-md pl-3 pr-1.5 text-left transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="max-w-40 truncate">{label}</span>
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

/** `panelKey` = 本标签的 key（状态横条里的入口都改**本标签**的面板现场，见 `BranchPill`） */
export function ComposerStatusBar({
  app,
  panelKey,
  running,
}: {
  app: AgentApp;
  panelKey: string;
  running: boolean;
}) {
  const isAcp = turnIsAcp(app)
  // 定高 `h-8`：右侧权限 / 上下文 pill 是 32px，左侧 pill 是 24px。某些状态（ACP
  // 空会话：无会话 → 权限 pill 与上下文圆环都不渲染）整条只剩左侧 24px，横条会矮一截、
  // 和卡片底部对不上。统一锁到「显示时」的高度。
  return (
    <div className="flex h-8 w-full min-w-0 items-center gap-2">
      <WorkspaceLocationPill app={app} panelKey={panelKey} />
      <BranchPill app={app} panelKey={panelKey} />
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
