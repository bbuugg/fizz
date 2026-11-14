/**
 * 「源代码管理」面板（git）：变更列表 / 暂存区 / 提交 / 检出 / 推送 / 历史 / 贮藏。
 *
 * 与「工作区文件」并列的一个右抽屉，**按会话常驻**（见 AgentApp 的 `PanelSession`）：
 * 切走只是隐藏，提交信息草稿、展开的 diff、拉过的历史都留着，切回来原样还在。
 *
 * 面板自己那一行头部**不写标题**（标签条上已有「源码管理」）：左边是分支下拉与
 * 分离头指针 / ↑↓ / 上游，右边是刷新 / 树状切换 / 更多。拉取、推送（含「推送到…」挑远端）、
 * 新建分支、管理远端（增 / 改地址 / 删）都在「更多」里 ——
 * 没有远端时点推送 / 拉取会直接开管理远端；**工作区还不是仓库时推送一律只回一句话**
 * （见 `push-policy.ts`：非仓库 / 状态还没到都不许把「管理远端」弹出来）。
 *
 * 快捷键：提交输入框里 Ctrl / ⌘ + Enter 提交（刻意排除了 shift，见提交输入框）；推送是
 * **面板级**快捷键（默认 Ctrl / ⌘ + Shift + Enter，可在「设置 → 快捷键」里改）—— 面板可见时
 * 挂在 window 上监听，不再要求先点提交框（见 push 之后那个 effect）。「可见」= 这个会话
 * 标签正被看着**且**侧栏停在这个面板上：后台标签的面板同样常挂载，只按侧栏判断会让
 * 别的会话的面板一起收到同一次按键（它们各自的状态还可能来自别的工作区）。
 *
 * 只做 git 允许的事：不做 force push、不做丢改动的 reset；检出 / 提交失败时把 git 的
 * 原话（「本地改动会被覆盖」这类）直接讲出来，而不是替用户决定要不要覆盖。
 *
 * ## 什么时候会重新拉状态
 *
 * 除了「面板变可见」与「面板自己的写操作跑完」，还订阅了 4 类**外部**触发点
 * （见下面 `requestRefresh` 处的注释）：一轮对话跑完、页面重新可见 / 窗口重新聚焦、
 * 工作区文件面板改过文件（有轮次在跑时的低频轮询兜底）。所有触发点共用一个
 * `requestRefresh`：并发去重 + 最小间隔，避免它们撞在一起时把 `git status` 打成连发。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  GitBranch as GitBranchIcon,
  GitBranchPlus,
  History,
  List,
  ListTree,
  Loader2,
  Minus,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  GitChange,
  GitCommit,
  GitStashEntry,
  GitStatusResult,
  GitBranchesResult
} from '@fizz/git'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@fizz/ui/alert-dialog'
import { Button } from '@fizz/ui/button'
import { Spinner } from '@fizz/ui/spinner'
import { SpinnerButton } from '@fizz/ui/spinner-button'
import { Checkbox } from '@fizz/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { Input } from '@fizz/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { FileDiffView } from '@fizz/agent-kit/features/git/FileDiffView'
import { ChangeTreeList } from '@fizz/agent-kit/features/git/GitChangeTree'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { ChangeRow } from '@fizz/agent-kit/features/git/ChangeRow'
import { GitHistory } from '@fizz/agent-kit/features/git/GitHistory'
import {
  dirRollbackWarning,
  rollbackDeleteCount,
  rollbackDeletes,
  rollbackDialogAction,
  rollbackDialogDescription,
  rollbackDialogTitle,
  rollbackWarning,
  type RollbackKind,
  type RollbackTarget
} from '@fizz/agent-kit/features/git/rollback-policy'
import { pushBlockedMessage, pushGate } from '@fizz/agent-kit/features/git/push-policy'
import { parseUnifiedDiff, type DiffHunk } from '@fizz/agent-kit/shared/lib/diff'
import {
  allChangeTreeDirPaths,
  changeTreeIndentPx,
  type ChangeTreeDir
} from '@fizz/agent-kit/shared/lib/git-change-tree'
import { setGitTreeView, useGitTreeView } from '@fizz/agent-kit/shared/lib/git-view-prefs'
import { subscribeWorkspaceFsChanged } from '@fizz/agent-kit/shared/lib/fs-changed'
import { subscribeServerEvent } from '@fizz/agent-kit/shared/lib/state-ws'
import { useActivities } from '@fizz/agent-kit/shared/lib/conversation-activity'
import { findShortcutByEvent, isShortcutRecording, useShortcuts } from '@fizz/agent-kit/shared/lib/shortcuts'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 外部触发点之间的最小间隔（ms）：一轮跑完 + 窗口重新聚焦可能连着来，1s 内的重复触发直接丢 */
const EXTERNAL_REFRESH_GAP_MS = 1000
/** 兜底轮询间隔（ms）：**仅**在「面板可见 + 这个工作区有轮次在跑」时才起定时器 */
const RUNNING_POLL_MS = 5000

/** 会用自己的按钮显示转圈的面板级操作（其余操作只禁用、不挂负载指示） */
type GitBusyAction =
  | 'commit'
  | 'push'
  | 'pull'
  | 'init'
  | 'stage-all'
  | 'unstage-all'
  | 'stash'
  | 'create-branch'
  | 'save-remote'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** git 的进度类输出（push / checkout）有用的东西常在最后一行 */
function lastLine(text: string): string {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

/**
 * git 操作的提示统一走**顶部居中的小 toast**（右上角那个位置留给 Agent 完成通知这类全局消息，顶中与它错开）。
 *
 * 两点说明：
 * - `position` 是 sonner 的**逐条**选项，不用动全局 `<Toaster>`（它被别的地方共用）；
 * - 宽度得用内联 `style` 覆盖 —— sonner 注入的样式没放进 `@layer`，优先级高于 Tailwind 工具类，
 *   靠 className 改宽度改不动。`fit-content` + maxWidth：一句话的提示只占一小块，
 *   长的 git 报错也不会撑出屏幕。
 */
const GIT_TOAST = {
  position: 'top-center',
  duration: 2600,
  style: {
    width: 'fit-content',
    maxWidth: 'min(92vw, 420px)',
    padding: '6px 12px',
    // **rem 不是 px**：这条内联样式落在 toast 的 DOM 上，走 rem 就跟着根字号一起缩放 ——
    // 手机端根字号被抬到 18px（见 `styles.css` 的「手机端整体放大」），写死 `12px` 的话
    // 界面长大了、只有这条提示还是原来那么大。`0.75rem` 在桌面端就是原来的 12px。
    fontSize: '0.75rem'
  }
} as const

function gitToast(message: string): void {
  toast.success(message, GIT_TOAST)
}

function gitToastError(message: string): void {
  toast.error(message, GIT_TOAST)
}

/** 「新建分支」里「起点 = 当前 HEAD」的哨兵值（Radix 的 SelectItem 不接受空字符串） */
const NEW_BRANCH_HEAD = '__head__'

/** 历史提交每页条数：点「加载更多」时按这个值用 `skip` 往后翻 */
const HISTORY_PAGE_SIZE = 30

export function GitPanel({
  app,
  workspaceId,
  visible,
  onChanges
}: {
  app: AgentApp
  /** 这个面板固定服务的工作区（按会话各挂一套，标签切换时不变） */
  workspaceId: string
  /**
   * 这个面板此刻是否**真露在外面**：侧栏停在这一页**且**它所属的会话标签正被看着。
   *
   * ⚠️ 两个条件都必要。面板与标签内容一律**常挂载**（收起只裁宽度 / `hidden`），后台标签
   * 的面板照样在渲染、照样挂 window 键盘监听 —— 只按侧栏判断的话，切过别的会话之后按
   * 推送快捷键会**同时**触发后台那几个面板（各自服务别的工作区，其中可能不是仓库）。
   *
   * 隐藏时不跑 git（不起轮询、不刷新），变可见时刷新一次。
   */
  visible: boolean
  /** 每次刷新完状态回报改动数量（给入口图标的 badge 用）；null = 不是仓库。
   *  同时回报当前分支（切分支 / 检出后，让会话名下的分支显示跟着变）。 */
  onChanges?: (info: { count: number; truncated: boolean; branch: string | null } | null) => void
}) {
  const t = useT()
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  /** 当前列表长度（刷新时用来判断用户是否已经「加载更多」，避免自动刷新把尾部丢掉） */
  const commitsRef = useRef<GitCommit[]>([])
  commitsRef.current = commits
  /** 历史还有没有下一页（上一页恰好取满 `HISTORY_PAGE_SIZE` 就算有） */
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * 正在跑的那个**面板级**操作（提交 / 推送 / 拉取 / 初始化 / 批量暂存…）。
   * 只用来决定「哪个按钮上转圈」—— 禁用与否仍看 `busy`（任何写操作期间都不许并发）。
   */
  const [busyAction, setBusyAction] = useState<GitBusyAction | null>(null)
  /** 手动刷新（点了头部那颗刷新 / 错误页的重试）期间，那颗图标自己转圈 */
  const [refreshing, setRefreshing] = useState(false)
  /**
   * 正在忙的那一行（按 `s?path` / `w?path` 记，避免两组串台）+ 在忙什么
   * （决定哪个按钮转圈、两个按钮都禁掉）
   */
  const [rowBusy, setRowBusy] = useState<{ key: string; kind: 'stage' | 'rollback' } | null>(null)
  /** 待确认的回退：破坏性操作，先弹 AlertDialog 说清后果再动手（文件行 / 目录行共用这一个确认框） */
  const [rollbackTarget, setRollbackTarget] = useState<RollbackTarget | null>(null)
  /**
   * 待确认的「批量回滚」（确认框是共用的一个）：
   * - `unstaged`：「更改」组标题上那个 —— 只这一组（未暂存 + 未跟踪）。
   */
  const [bulkRollback, setBulkRollback] = useState<'unstaged' | null>(null)
  const [message, setMessage] = useState('')
  /** 两组变更列表的展开状态（默认都展开；折叠后标题上的数量与「全部」按钮仍在） */
  const [stagedOpen, setStagedOpen] = useState(true)
  const [unstagedOpen, setUnstagedOpen] = useState(true)
  /** 树状还是平铺（存在 localStorage，默认树状；面板头部的图标切） */
  const treeView = useGitTreeView()
  /**
   * 折叠中的目录：`${staged ? 's' : 'w'}:${目录路径}` → true。两组各折叠各的，
   * 放在组件 state 里是为了 git 刷新后展开态还在（面板按会话常驻，见文件头注释）。
   */
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({})
  /** 展开的文件 diff：`openKey` 是 `${staged ? 's' : 'w'}:${path}`，`diff` 是解析后的 hunks */
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffHunk[] | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  /** 「新建分支」弹窗：分支名 + 起点（`NEW_BRANCH_HEAD` = 从当前 HEAD 切） */
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchFrom, setNewBranchFrom] = useState(NEW_BRANCH_HEAD)
  /**
   * 「管理远端」弹窗：列出全部远端，可增 / 改地址 / 删。
   * 没有远端时点「推送」「拉取」会直接开到这儿 —— 省得用户去终端敲 remote add。
   *
   * `remoteDraft` 是弹窗顶部那个表单的现场：`editing` 说明正在改某个已有远端的地址
   * （名字锁死，只改 URL），否则是「新增一个」。
   */
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [remoteDraft, setRemoteDraft] = useState<{ name: string; url: string; editing: boolean }>({
    name: '',
    url: '',
    editing: false
  })
  /** 待确认删除的远端名（删远端会连它的远端跟踪分支一起没，先问一句） */
  const [deletingRemote, setDeletingRemote] = useState<string | null>(null)
  /** 「贮藏当前更改」弹窗：说明（可空）+ 要不要连未跟踪文件一起收 */
  const [stashOpen, setStashOpen] = useState(false)
  const [stashMessage, setStashMessage] = useState('')
  const [stashUntracked, setStashUntracked] = useState(false)
  /** 贮藏那一段的展开状态（与「历史提交」同一套） */
  const [stashesOpen, setStashesOpen] = useState(false)
  /** 待确认删除的贮藏（drop 掉之后只剩 reflog 能找） */
  const [dropStash, setDropStash] = useState<GitStashEntry | null>(null)
  /**
   * 待确认的分支删除（本地 / 远端）。删分支就是把一条线扔掉、删远端分支还推得到别人面前，
   * 所以和回退一个路子：先弹 AlertDialog 把后果说清，点过确认才真的动手。
   */
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: 'local'; name: string }
    | { kind: 'remote'; remote: string; branch: string }
    | null
  >(null)
  /** 删除确认框里的「强制删除」（本地分支未合并也删 = `git branch -D`） */
  const [deleteForce, setDeleteForce] = useState(false)

  // 回调放 ref：`onChanges` 每次渲染都是新函数，进依赖会让 refresh 每帧都变，进而把
  // 「变可见就刷新」的 effect 拖成死循环（与 refreshRef 同一个理由）
  const onChangesRef = useRef(onChanges)
  onChangesRef.current = onChanges

  /**
   * 拉状态 + 分支 + 历史。
   * `pruneRemote` 只由手动点刷新传 true：顺带 fetch --prune 掉远端已删的分支。
   * 平时（打开面板、写操作之后）不联网，纯本地 ref，快。
   */
  const refresh = useCallback(async (pruneRemote = false): Promise<void> => {
    // 只有手动刷新（点头部那颗 / 错误页重试）才让那颗图标转圈；自动刷新是静默的
    if (pruneRemote) setRefreshing(true)
    try {
      const next = await app.gitStatus(workspaceId)
      setStatus(next)
      setLoadError(null)
      // 拿到状态就先把改动数 + 当前分支回报上去（后面拉分支 / 历史失败也不影响 badge 与会话名下的分支）
      onChangesRef.current?.(
        next.isRepo
          ? {
              count: next.changes.length,
              truncated: next.truncated,
              branch: next.branch ?? (next.detached ? t('HEAD（分离）') : null)
            }
          : null
      )
      if (next.isRepo) {
        const [nextBranches, nextCommits] = await Promise.all([
          app.gitBranches(workspaceId, pruneRemote),
          // 首屏只要一页；「加载更多」按 skip 继续往后翻，不再一次性拉满
          app.gitLog(workspaceId, HISTORY_PAGE_SIZE)
        ])
        setBranches(nextBranches)
        /*
         * 已经点过「加载更多」时别把尾部丢掉（自动刷新 / 轮询会频繁走到这里）：
         * 第一页整体替换，后面的记录按哈希去重保留 —— 历史是往顶部追加的，
         * 新提交只会出现在前面，旧尾部仍然有效。
         */
        if (commitsRef.current.length > HISTORY_PAGE_SIZE) {
          const fresh = new Set(nextCommits.map((c) => c.hash))
          setCommits([...nextCommits, ...commitsRef.current.filter((c) => !fresh.has(c.hash))])
        } else {
          setCommits(nextCommits)
          setHistoryHasMore(nextCommits.length === HISTORY_PAGE_SIZE)
        }
      }
    } catch (err) {
      setLoadError(errText(err))
    } finally {
      setLoading(false)
      if (pruneRemote) setRefreshing(false)
    }
  }, [app, workspaceId])

  /**
   * 历史提交「加载更多」：按当前已加载条数当 skip 取下一页，追加到列表末尾。
   *
   * 不去重：skip 是从 `commits.length` 算的，正常不会重叠；如果这期间刚好有人
   * 提交了新记录，列表前面的哈希会整体位移一次，最多出现一条重复 —— 下一次刷新
   * 就恢复了，不值得为此加一套合并逻辑。
   */
  const loadMoreHistory = useCallback(async (): Promise<void> => {
    if (historyLoadingMore) return
    setHistoryLoadingMore(true)
    try {
      const next = await app.gitLog(workspaceId, HISTORY_PAGE_SIZE, commits.length)
      setCommits((prev) => [...prev, ...next])
      setHistoryHasMore(next.length === HISTORY_PAGE_SIZE)
    } catch (err) {
      gitToastError(errText(err))
    } finally {
      setHistoryLoadingMore(false)
    }
  }, [app, workspaceId, commits.length, historyLoadingMore])

  // `app` 每次渲染都是新对象（useAgentApp 返回新对象），直接进依赖会
  // 「刷新 → setState → 重渲染 → 又刷新」死循环。用 ref 拿最新实现，只在**变可见**时拉一次。
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (!visible) return
    // 每次打开面板都把「更改」这组展开：收起它多半是临时腾地方，重新进来时最想看的还是这块
    setUnstagedOpen(true)
    void refreshRef.current()
  }, [visible])

  /**
   * 面板换了工作区 → 旧状态**立刻作废**。
   *
   * 挂载时这块面板服务的是哪个工作区不是恒定的：会话清单还没落地时调用方拿的是全局
   * `activeWorkspaceId`，等清单回来才换成会话自己的；草稿标签的工作区也会随用户切项目变。
   * 上面的「变可见才刷」只看 `visible` 的翻面，`workspaceId` 换了而面板一直开着就**不会**
   * 重拉 —— 于是 `status` 还是上一个工作区的（远端清单、`isRepo` 全是旧的），推送判据会
   * 按别人的仓库去推。这里清空，等下一次变可见 / 外部触发点重拉。
   */
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  /** 上一次渲染服务的工作区；**与初值相同 = 挂载那一拍**，跳过（免得开头多打一次 gitStatus） */
  const prevWorkspaceRef = useRef(workspaceId)
  useEffect(() => {
    if (prevWorkspaceRef.current === workspaceId) return
    prevWorkspaceRef.current = workspaceId
    setStatus(null)
    setBranches(null)
    setCommits([])
    setLoadError(null)
    setLoading(true)
    // 换工作区时面板一直是开着的话，「变可见」那条 effect 不会再跑，这里补一次
    if (visibleRef.current) void refreshRef.current()
    // 只在**工作区**变化时跑：`visible` 走上面的翻面 effect（进依赖会把刷新打两遍）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // -------------------------------------------------------------------------
  // 外部触发点
  //
  // 上面的「变可见才刷」只覆盖了「面板被重新打开」这一种情况。实际会改文件、而面板一直
  // 开着的场合有四类，逐个挂上去（改动列表不及时基本都出在这里）：
  //
  // 1. **一轮对话跑完**（`conversation:finished`）—— agent 跑一轮通常改一堆文件，
  //    这是最常见的一个。事件里只有 conversationId，用本工作区的会话 id 集合过滤。
  // 2. **页面重新可见 / 窗口重新聚焦**：切走再切回同一标签时 `visible` 没变过，
  //    只能靠这两个事件。切应用、切虚拟桌面、笔记本唤醒都走这里。
  // 3. **工作区文件面板改过文件**（`lib/fs-changed.ts`）：保存 / 复制 / 移动 / 删除 /
  //    新建，成功后都会喊一声。
  // 4. **兜底轮询**：上面三个都是「有人通知我」，剩下那些（终端里敲 git、外部编辑器、
  //    另一个 git 客户端改的）没人通知。只在「面板可见 + 本工作区有轮次在跑」时起
  //    定时器，两者任一不成立就停 —— 不可见时轮询纯属白跑 git 子进程。
  //
  // ⚠️ 四个触发点全走 `requestRefresh`：**并发去重 + 最小间隔**。一轮跑完时
  // 「finished 事件」和「最后一次轮询」很可能撞在一起，没有去重就会把 `git status`
  // 打成连发（每个 status 都是一次 git 子进程 + 一次分支/历史拉取）。
  // -------------------------------------------------------------------------

  const inFlightRef = useRef(false)
  const lastRefreshAtRef = useRef(0)
  /**
   * 刻意**不看 `visible`**：停放中的面板（`hidden` 但保持挂载）也要刷 ——
   * 改动数与分支是通过 `onChanges` 报到会话标题上的角标，不刷它就一直是旧值。
   * 开过 git 标签的会话数量有限，加上 `requestRefresh` 的去重与间隔，这条路的开销可控。
   */
  const requestRefresh = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return
    if (Date.now() - lastRefreshAtRef.current < EXTERNAL_REFRESH_GAP_MS) return
    inFlightRef.current = true
    lastRefreshAtRef.current = Date.now()
    try {
      await refreshRef.current()
    } finally {
      inFlightRef.current = false
    }
  }, [])

  /**
   * 本工作区下的会话 id 集合：用来把「某个会话跑完了」翻译成「这个工作区可能有改动」。
   *
   * 放 ref 而不是直接进 effect 依赖：`app` 每次渲染都是新对象（`useAgentApp` 的语义），
   * 进依赖会让上面几个订阅每帧退订重订。会话清单本身是 store 里的稳定数组，
   * 按它 + workspaceId 做 memo，变化时（新建 / 删除会话）才换新 Set。
   */
  const wsConversationIdsRef = useRef<Set<string>>(new Set())
  wsConversationIdsRef.current = useMemo(
    () =>
      new Set(
        app.conversations.filter((c) => c.workspaceId === workspaceId).map((c) => c.id)
      ),
    [app.conversations, workspaceId]
  )

  // 1. 一轮对话跑完 → 这个工作区的改动列表刷一次
  useEffect(() => {
    return subscribeServerEvent((event) => {
      if (event.type !== 'conversation:finished') return
      if (!wsConversationIdsRef.current.has(event.conversationId)) return
      void requestRefresh()
    })
  }, [requestRefresh])

  // 2. 页面重新可见 / 窗口重新聚焦
  useEffect(() => {
    const onWake = (): void => {
      if (document.visibilityState !== 'visible') return
      void requestRefresh()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [requestRefresh])

  // 3. 工作区文件面板改过文件（保存 / 复制 / 移动 / 删除 / 新建）
  useEffect(() => {
    return subscribeWorkspaceFsChanged((change) => {
      // workspaceId 为 null = 来源未知（自定义 FilesSource，比如流程节点的容器目录），
      // 那里没有 git 面板，一律不理
      if (change.workspaceId !== workspaceId) return
      void requestRefresh()
    })
  }, [requestRefresh, workspaceId])

  // 4. 兜底轮询：只有「可见 + 本工作区有轮次在跑」才起
  const activities = useActivities()
  let workspaceRunning = false
  for (const [id, activity] of activities) {
    if (activity.running && wsConversationIdsRef.current.has(id)) {
      workspaceRunning = true
      break
    }
  }
  useEffect(() => {
    if (!visible || !workspaceRunning) return
    const timer = setInterval(() => {
      void requestRefresh()
    }, RUNNING_POLL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [visible, workspaceRunning, requestRefresh])

  /** 跑一个写操作：成功 toast（给了 `done` 就用它，否则用 git 输出的最后一行），然后刷新状态 */
  async function run(
    fn: () => Promise<string>,
    done?: string,
    action?: GitBusyAction
  ): Promise<void> {
    setBusy(true)
    setBusyAction(action ?? null)
    try {
      const output = await fn()
      const text = done ?? lastLine(output)
      if (text) gitToast(text)
      await refreshRef.current()
    } catch (err) {
      gitToastError(errText(err))
    } finally {
      setBusy(false)
      setBusyAction(null)
    }
  }

  /** 最近一次点开的文件 key：用来丢弃「点得太快」时回来的过期 diff */
  const diffReqRef = useRef<string | null>(null)

  async function toggleFile(path: string, staged: boolean): Promise<void> {
    const key = `${staged ? 's' : 'w'}:${path}`
    if (openKey === key) {
      diffReqRef.current = null
      setOpenKey(null)
      setDiff(null)
      return
    }
    diffReqRef.current = key
    setOpenKey(key)
    setDiff(null)
    setDiffLoading(true)
    try {
      const res = await app.gitDiff(workspaceId, path, staged)
      if (diffReqRef.current !== key) return
      setDiff(parseUnifiedDiff(res.diff))
    } catch (err) {
      if (diffReqRef.current !== key) return
      gitToastError(errText(err))
      setOpenKey(null)
    } finally {
      if (diffReqRef.current === key) setDiffLoading(false)
    }
  }

  /** 暂存 / 取消暂存一批路径（单个文件、或树状视图里一个目录下的所有文件共用同一套） */
  async function stagePaths(paths: string[], key: string, staged: boolean): Promise<void> {
    if (!paths.length) return
    setRowBusy({ key, kind: 'stage' })
    try {
      await app.gitAction(workspaceId, staged
        ? { action: 'unstage', paths }
        : { action: 'stage', paths })
      await refreshRef.current()
    } catch (err) {
      gitToastError(errText(err))
    } finally {
      setRowBusy(null)
    }
  }

  /** 暂存 / 取消暂存单个文件 */
  function toggleStage(path: string, staged: boolean): void {
    void stagePaths([path], `${staged ? 's' : 'w'}:${path}`, staged)
  }

  /** 暂存 / 取消暂存一个目录（整棵子树里的所有改动文件） */
  function toggleStageDir(dir: ChangeTreeDir, staged: boolean): void {
    void stagePaths(dir.changes.map((c) => c.path), `${staged ? 's' : 'w'}:${dir.path}`, staged)
  }

  /** 回退（真正动手的那一步，确认框点过之后才会走到这里）：文件行与目录行都走它 */
  async function confirmRollback(): Promise<void> {
    const target = rollbackTarget
    if (!target) return
    setRollbackTarget(null)
    // 目录行按所在分组的语义走：已暂存组 = all（连索引一起回到 HEAD）、更改组 = worktree（已暂存的留着）
    const stagedScope = target.scope === 'dir' ? target.staged : target.kind === 'staged' || target.kind === 'added'
    if (!target.path) return
    const key = `${stagedScope ? 's' : 'w'}:${target.path}`
    setRowBusy({ key, kind: 'rollback' })
    try {
      const mode = stagedScope ? 'all' : 'worktree'
      // 未暂存的改动 → 只丢工作区那份；已暂存（含只存在于索引的新文件）→ 连索引一起回到 HEAD。
      // 目录级回滚只传**目录路径**（git pathspec 递归整棵子树，未跟踪的由服务端 clean 收掉），
      // 不枚举文件 —— 几千个文件时把每个路径塞进命令行会撞上系统命令长度上限（Windows ~32K 字符）
      const output = await app.gitAction(workspaceId, target.scope === 'dir'
        ? { action: 'rollback-dir', path: target.path, mode }
        : { action: 'rollback', path: target.path, mode })
      if (lastLine(output)) gitToast(lastLine(output))
      // 展开的 diff 属于「回退前」的内容，收掉免得看着像还没回退
      diffReqRef.current = null
      setOpenKey(null)
      setDiff(null)
      await refreshRef.current()
    } catch (err) {
      gitToastError(errText(err))
    } finally {
      setRowBusy(null)
    }
  }

  /** 批量回滚（确认框点过之后才走到这里）：只碰列出来的这些文件，仓库里别处不动 */
  async function rollbackListed(): Promise<void> {
    const paths = bulkPaths
    setBulkRollback(null)
    if (!paths.length) return
    await run(async () => {
      const output = await app.gitAction(workspaceId, { action: 'rollback-all', paths })
      // 展开的 diff 属于「回滚前」的内容，收掉免得看着像还没回滚
      diffReqRef.current = null
      setOpenKey(null)
      setDiff(null)
      return output
    })
  }

  /** 打开某个文件行的回退确认框（把「会发生什么」判出来，见 RollbackKind） */
  function openRollback(change: GitChange, staged: boolean): void {
    const kind: RollbackKind = staged
      ? change.index === 'A'
        ? 'added'
        : 'staged'
      : change.index === '?'
        ? 'untracked'
        : 'worktree'
    setRollbackTarget({ scope: 'file', path: change.path, kind })
  }

  /** 打开某个目录行的回退确认框（作用到整棵子树，见 dirRollbackWarning） */
  function openRollbackDir(dir: ChangeTreeDir, staged: boolean): void {
    if (!dir.changes.length) return
    setRollbackTarget({ scope: 'dir', path: dir.path, changes: dir.changes, staged })
  }

  const changes = status?.changes ?? []
  const stagedChanges = changes.filter((c) => c.index !== '.' && c.index !== '?')
  const unstagedChanges = changes.filter((c) => c.worktree !== '.')

  /** 批量回滚要动的文件：「更改」组标题的入口 = 只回滚未暂存 + 未跟踪的那一组 */
  const bulkChanges = bulkRollback === 'unstaged' ? unstagedChanges : []
  const bulkPaths = bulkChanges.map((c) => c.path)
  /**
   * 其中会被**删掉文件**的那几个（未跟踪 `?` 与「只存在于暂存区的新文件」`A`）。
   * 确认框必须写明 —— 这两种没有「上次提交」可回，回滚就是删文件。
   */
  const bulkDeletes = bulkChanges.filter((c) => c.index === '?' || c.index === 'A').length

  async function commit(): Promise<void> {
    const text = message.trim()
    if (!text) return
    await run(async () => {
      const output = await app.gitAction(workspaceId, { action: 'commit', message: text })
      setMessage('')
      return output
    }, undefined, 'commit')
  }

  const branchLabel = status?.branch ?? (status?.detached ? t('分离头指针') : t('（无分支）'))
  /** 贮藏栈（最近一次在前）；不是仓库 / 还没加载完时是空数组 */
  const stashes = status?.stashes ?? []
  const canCommit = !!message.trim() && stagedChanges.length > 0 && !busy
  const canCreateBranch = newBranchName.trim().length > 0 && !busy

  /** 从选中的起点切出一条新分支（起点不选 = 当前 HEAD，分离头指针下也能用） */
  async function createBranch(): Promise<void> {
    const name = newBranchName.trim()
    if (!name) return
    await run(async () => {
      const output = await app.gitAction(workspaceId, {
        action: 'create-branch',
        name,
        from: newBranchFrom === NEW_BRANCH_HEAD ? undefined : newBranchFrom
      })
      // 成功才关弹窗（失败时留着输入，让用户改个名字再来）
      setNewBranchOpen(false)
      setNewBranchName('')
      return output
    }, undefined, 'create-branch')
  }

  /** 「管理远端」弹窗里那个表单能不能提交（改地址时名字是锁死的，不用再校验） */
  const canSaveRemote =
    remoteDraft.url.trim().length > 0 && (remoteDraft.editing || remoteDraft.name.trim().length > 0) && !busy
  /** 删除确认框里显示的完整分支名（远端带着远端名前缀，免得看不出会被推到哪个远端） */
  const deleteLabel =
    deleteTarget?.kind === 'remote'
      ? `${deleteTarget.remote}/${deleteTarget.branch}`
      : (deleteTarget?.name ?? '')
  /** 远端分支名（`origin/feature/x`）→ { remote, branch }：分支名允许带 `/`，只能按第一段拆 */
  function splitRemoteBranch(name: string): { remote: string; branch: string } {
    const slash = name.indexOf('/')
    return { remote: name.slice(0, slash), branch: name.slice(slash + 1) }
  }

  /** 打开「管理远端」：表单复位成「新增」（没有远端时点推送 / 拉取会直接开到这儿） */
  function openRemoteDialog(): void {
    setRemoteDraft({ name: '', url: '', editing: false })
    setRemoteOpen(true)
  }

  /** 把某一行的地址填进表单，进入「改地址」态（名字不给改：改名是 git remote rename，另说） */
  function editRemote(name: string, url: string): void {
    setRemoteDraft({ name, url, editing: true })
  }

  /**
   * 删分支（确认框点过「删除」之后才走到这里）：本地 `git branch -d` / `-D`，远端
   * `git push <remote> --delete <branch>`。
   *
   * 统一走 `run()`：成功 toast + 刷新（删完分支清单、状态、历史都得重拿，删远端分支后
   * 本地那条 remote-tracking ref 也会跟着消失）。失败时面板把 git 的原话讲出来 ——
   * 「还没合并」「远端 ref 不存在」「没权限」都够用户判断下一步。
   */
  async function deleteBranch(): Promise<void> {
    const target = deleteTarget
    if (!target) return
    // 先取出来再清：`setDeleteTarget(null)` 之后 state 就不再属于这次操作了
    const force = deleteForce
    setDeleteTarget(null)
    setDeleteForce(false)
    await run(async () =>
      target.kind === 'remote'
        ? app.gitAction(workspaceId, {
            action: 'delete-remote-branch',
            remote: target.remote,
            branch: target.branch
          })
        : app.gitAction(workspaceId, { action: 'delete-branch', name: target.name, force })
    )
  }

  /**
   * 保存表单：新增一个远端，或改某个已有远端的地址（两者都是 `set-remote` 这一个动作）。
   *
   * 成功后**不关弹窗**，只把表单复位回「新增」—— 用户多半还要接着加 / 删；
   * 弹窗里的列表靠 `run()` 之后的刷新重拿（状态里带着 remotes）。
   */
  async function saveRemote(): Promise<void> {
    const name = remoteDraft.editing ? remoteDraft.name : remoteDraft.name.trim()
    const url = remoteDraft.url.trim()
    if (!name || !url) return
    await run(async () => {
      const output = await app.gitAction(workspaceId, { action: 'set-remote', name, url })
      setRemoteDraft({ name: '', url: '', editing: false })
      return output
    }, undefined, 'save-remote')
  }

  /** 删远端（确认框点过之后才走到这里）。删掉的正好是表单里在编辑的那个就把表单复位 */
  async function removeRemote(name: string): Promise<void> {
    setDeletingRemote(null)
    await run(async () => {
      const output = await app.gitAction(workspaceId, { action: 'remove-remote', name })
      setRemoteDraft((d) => (d.editing && d.name === name ? { name: '', url: '', editing: false } : d))
      return output
    })
  }

  /**
   * 推送当前分支。
   *
   * `remote` 给定时推到那个远端（「推送到…」子菜单挑的）；不给就按上游走 —— 没有上游时
   * 服务端会 `--set-upstream <远端>`（首选 `origin`，没有就退到现有那个远端）。
   * 两种入口共用这一份，**快捷键也是**。
   *
   * ⚠️ 判据全在 `push-policy.ts`（纯函数、有单测），这里只把它翻译成界面动作：
   * 只有「是仓库、但不是没配远端」这种才开「管理远端」；**不是仓库 / 状态还没到**一律
   * 只回一句话 —— 以前这里只判 `remotes.length === 0`，非仓库的 `remotes` 也是空数组，
   * 于是快捷键会弹出一个填了地址也 set 不上的「管理远端」。
   */
  async function push(remote?: string): Promise<void> {
    const gate = pushGate(status, remote)
    if (gate === 'no-remote') {
      openRemoteDialog()
      return
    }
    const blocked = pushBlockedMessage(gate)
    if (blocked) {
      gitToastError(blocked)
      return
    }
    await run(() => app.gitAction(workspaceId, { action: 'push', remote }), undefined, 'push')
  }

  /**
   * 推送快捷键（默认 Ctrl / ⌘ + Shift + Enter，可在「设置 → 快捷键」里改）。
   *
   * 挂在 `window` 上、且**只在面板可见时挂**：不再要求提交框先聚焦（原先挂在面板根节点上，
   * 只有焦点落在面板子树里才收得到）；面板没显示时这条监听根本不存在，这组按键完全不被应用占用。
   *
   * ⚠️ 全局分发器（app-shell）对 `git-push` 这类「面板级」动作会直接放行、不拦截
   * （见 shortcuts.ts 的 PANEL_SCOPED_SHORTCUT_ACTIONS）—— 否则它会在捕获阶段先把
   * 按键吃掉，这里永远收不到。
   */
  const shortcuts = useShortcuts()
  const pushRef = useRef(push)
  pushRef.current = push
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      // 输入法组合中 / 长按重复都不触发（与 app-shell 的全局分发同一套判断）
      if (e.isComposing || e.repeat) return
      // 设置页正在录制快捷键：这一下是要被录下来的，顺手把 push 也跑了就乱套了
      if (isShortcutRecording()) return
      const hit = findShortcutByEvent(shortcuts, e)
      if (!hit || hit.action !== 'git-push') return
      e.preventDefault()
      e.stopPropagation()
      // 正在跑别的 git 操作时不吃这一下（与「更多」菜单里那条禁用同义）
      if (busyRef.current) return
      void pushRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, shortcuts])

  /** 打开「贮藏当前更改」：说明与勾选都复位 */
  function openStashDialog(): void {
    setStashMessage('')
    setStashUntracked(false)
    setStashOpen(true)
  }

  /** 贮藏当前改动（成功才关弹窗，失败留着输入让用户改） */
  async function stashChanges(): Promise<void> {
    const message = stashMessage.trim()
    await run(async () => {
      const output = await app.gitAction(workspaceId, {
        action: 'stash-push',
        message: message || undefined,
        includeUntracked: stashUntracked
      })
      setStashOpen(false)
      return output
    }, undefined, 'stash')
  }

  /**
   * 弹出（pop，应用并从栈里删掉）/ 应用（apply，留着）一次贮藏。
   *
   * 刻意不用 `run()`：它只在成功时刷新，而 `stash pop` 撞上冲突是**失败但也真的改了工作区**
   * （文件里留下冲突标记）—— 那种情况必须照样刷新，用户才能立刻看到冲突文件。
   */
  async function applyStash(target: GitStashEntry, pop: boolean): Promise<void> {
    setBusy(true)
    try {
      const output = await app.gitAction(workspaceId, {
        action: pop ? 'stash-pop' : 'stash-apply',
        ref: target.ref
      })
      const text = lastLine(output)
      if (text) gitToast(text)
    } catch (err) {
      gitToastError(errText(err))
    } finally {
      await refreshRef.current()
      setBusy(false)
    }
  }

  /** 删除一次贮藏（确认框点过之后才走到这里） */
  async function dropStashEntry(): Promise<void> {
    // 先取出来再清：`setDropStash(null)` 之后 state 就不属于这次操作了
    const target = dropStash
    setDropStash(null)
    if (!target) return
    await run(() => app.gitAction(workspaceId, { action: 'stash-drop', ref: target.ref }))
  }

  /** 展开行下方的 diff 区（加载中 / 无可展示内容 / 正常渲染） */
  function diffArea(path: string, staged: boolean, depth = 0): ReactNode {
    /*
     * 对齐选中文件的名字（而不是行左边缘）：文件行的名字在「状态字母 + gap」之后，
     * 而 FileDiffView 自己的文件头还有 px-2。行内边距 + 20（字母 12 + 间距 8）- 8（px-2）= +12。
     * 树状视图里文件行本身有层级缩进，diff 也必须跟着缩进，否则会一直贴在最左边。
     */
    const indent = changeTreeIndentPx(depth) + 12
    if (diffLoading) {
      return (
        <div
          style={{ paddingLeft: indent }}
          className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground"
        >
          <Loader2 className="size-3.5 animate-spin" /> {t('读取 diff…')}
        </div>
      )
    }
    if (!diff) return null
    return (
      <div style={{ paddingLeft: indent }}>
        <FileDiffView
          path={staged ? t('{path}（已暂存）', { path }) : path}
          hunks={diff}
          deleted={false}
        />
      </div>
    )
  }

  /** 目录折叠态：两组的 key 带前缀（`s:` / `w:`），取出来时只留目录路径 */
  function collapsedOf(staged: boolean): ReadonlySet<string> {
    const prefix = staged ? 's:' : 'w:'
    const out = new Set<string>()
    for (const [key, collapsed] of Object.entries(collapsedDirs)) {
      if (collapsed && key.startsWith(prefix)) out.add(key.slice(prefix.length))
    }
    return out
  }

  function toggleDir(staged: boolean, dirPath: string): void {
    const key = `${staged ? 's' : 'w'}:${dirPath}`
    setCollapsedDirs((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  /** 一次性折叠 / 展开这一组里的所有目录（`dirs` 由 `collapseAllButton` 现算） */
  function setAllDirsCollapsed(staged: boolean, dirs: string[], collapse: boolean): void {
    const prefix = staged ? 's:' : 'w:'
    setCollapsedDirs((prev) => {
      const next = { ...prev }
      for (const dir of dirs) next[`${prefix}${dir}`] = collapse
      return next
    })
  }

  /**
   * 组标题行上的「全部折叠 / 全部展开」：一键把这一组的目录收起来或摊开。
   *
   * 只在树状视图、且这一组里真有目录时出现（平铺视图没有目录可言）。图标随当前状态变 ——
   * 全都折着时点它是展开，否则是折叠（按钮本身就是那一个动作，不需要两个）。
   */
  function collapseAllButton(staged: boolean): ReactNode {
    if (!treeView) return null
    const dirs = allChangeTreeDirPaths(staged ? stagedChanges : unstagedChanges)
    if (!dirs.length) return null
    const prefix = staged ? 's:' : 'w:'
    const allCollapsed = dirs.every((dir) => collapsedDirs[`${prefix}${dir}`])
    const label = allCollapsed ? t('展开这一组里的所有目录') : t('折叠这一组里的所有目录')
    return (
      <IconTip label={label}>
        <Button
          variant="ghost"
          className="size-5! shrink-0 p-0! text-muted-foreground"
          aria-label={label}
          onClick={() => setAllDirsCollapsed(staged, dirs, !allCollapsed)}
        >
          {allCollapsed ? (
            <ChevronsUpDown className="size-3.5" />
          ) : (
            <ChevronsDownUp className="size-3.5" />
          )}
        </Button>
      </IconTip>
    )
  }

  // 展开的 diff 可能藏在某个目录里：点开文件时把它的祖先目录一并展开，
  // 不然那个 diff 会跟着目录一起收起来，看着像「点不动」。
  useEffect(() => {
    if (!openKey) return
    const sep = openKey.indexOf(':')
    const parts = openKey.slice(sep + 1).split('/')
    if (parts.length < 2) return
    const prefix = `${openKey.slice(0, sep)}:`
    const openDirs: Record<string, boolean> = {}
    let dirPath = ''
    for (const seg of parts.slice(0, -1)) {
      dirPath = dirPath ? `${dirPath}/${seg}` : seg
      openDirs[`${prefix}${dirPath}`] = false
    }
    setCollapsedDirs((prev) => {
      // 状态没变就原样返回（不白渲染一次，也避免把依赖它的记忆值打脏）
      const changed = Object.keys(openDirs).some((k) => prev[k] === false)
      return changed ? { ...prev, ...openDirs } : prev
    })
  }, [openKey])

  /** 树状下只显示文件名（目录名已在父目录行里），完整路径进 title；重命名的旧名由 `ChangeRow` 自己取 */
  function shortLabel(change: GitChange): string {
    return change.path.split('/').pop() ?? change.path
  }

  /**
   * 树状视图里目录行右侧的两个按钮：暂存 / 取消暂存整棵子树、回滚整棵子树。
   *
   * 沿用文件行同一套按钮样式与 busy 逻辑（key 是 `s:` / `w:` + **目录**路径，
   * 与文件行的 key 不冲突）。改动过多被截断时不给暂存 —— 路径不全，暂存会漏。
   */
  function dirActions(dir: ChangeTreeDir, staged: boolean): ReactNode {
    const key = `${staged ? 's' : 'w'}:${dir.path}`
    const busyKind = rowBusy?.key === key ? rowBusy.kind : null
    const stageLabel = staged ? t('取消暂存这个目录') : t('暂存这个目录')
    const rollbackLabel = staged
      ? t('放弃这个目录的全部改动（含已暂存的），回到上次提交')
      : t('丢弃这个目录里未暂存的改动')
    return (
      <>
        <IconTip label={stageLabel}>
          <Button
            variant="ghost"
            className="size-6! shrink-0 p-0!"
            aria-label={stageLabel}
            disabled={busy || busyKind !== null || status?.truncated === true}
            onClick={() => toggleStageDir(dir, staged)}
          >
            {busyKind === 'stage' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : staged ? (
              <Minus className="size-3.5" />
            ) : (
              <Plus className="size-3.5" />
            )}
          </Button>
        </IconTip>
        <IconTip label={rollbackLabel}>
          <Button
            variant="ghost"
            className="size-6! shrink-0 p-0! text-muted-foreground hover:text-destructive"
            aria-label={rollbackLabel}
            disabled={busy || busyKind !== null}
            onClick={() => openRollbackDir(dir, staged)}
          >
            {busyKind === 'rollback' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
          </Button>
        </IconTip>
      </>
    )
  }

  /** 「已暂存的更改」组的一行（树状与平铺共用，`depth` 决定缩进） */
  function stagedRow(change: GitChange, depth: number): ReactNode {
    return (
      <ChangeRow
        key={`s:${change.path}`}
        change={change}
        letter={change.index}
        open={openKey === `s:${change.path}`}
        onToggle={() => void toggleFile(change.path, true)}
        onToggleStage={() => void toggleStage(change.path, true)}
        onRollback={() => openRollback(change, true)}
        staged
        stageLabel={t('取消暂存')}
        rollbackLabel={t('放弃这个文件的全部改动（含已暂存的），回到上次提交')}
        busy={rowBusy?.key === `s:${change.path}` ? rowBusy.kind : null}
        depth={treeView ? depth : 0}
        shortLabel={treeView ? shortLabel(change) : undefined}
      >
        {diffArea(change.path, true, treeView ? depth : 0)}
      </ChangeRow>
    )
  }

  /** 「更改」组的一行（未暂存 + 未跟踪） */
  function unstagedRow(change: GitChange, depth: number): ReactNode {
    return (
      <ChangeRow
        key={`w:${change.path}`}
        change={change}
        letter={change.index === '?' ? '?' : change.worktree}
        open={openKey === `w:${change.path}`}
        onToggle={() => void toggleFile(change.path, false)}
        onToggleStage={() => void toggleStage(change.path, false)}
        onRollback={() => openRollback(change, false)}
        staged={false}
        stageLabel={t('暂存这个文件')}
        rollbackLabel={change.index === '?' ? t('删除这个未跟踪文件') : t('丢弃这个文件未暂存的改动')}
        busy={rowBusy?.key === `w:${change.path}` ? rowBusy.kind : null}
        depth={treeView ? depth : 0}
        shortLabel={treeView ? shortLabel(change) : undefined}
      >
        {diffArea(change.path, false, treeView ? depth : 0)}
      </ChangeRow>
    )
  }

  /**
   * 分支下拉（头部那一行）：切换本地分支 / 检出远端分支，行尾那颗垃圾桶删分支。
   *
   * 它原来独占下面一整行状态条，现在直接占头部的标题位 —— 标签条上已经有「源码管理」，
   * 再写一遍「源代码管理」纯属重复。不是仓库（含加载中）时返回 null。
   */
  function branchDropdown(): ReactNode {
    if (!status?.isRepo) return null
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-6! min-w-0 gap-1 px-1.5! text-sm font-normal"
            disabled={busy}
            title={status.root ?? undefined}
          >
            <span className="max-w-[160px] truncate">{branchLabel}</span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
          <DropdownMenuLabel className="text-xs text-muted-foreground">{t('切换分支')}</DropdownMenuLabel>
          {branches?.branches.length ? (
            branches.branches.map((name) => (
              <DropdownMenuItem
                key={name}
                // group：给行尾那颗垃圾桶一个锚（`group` 挂在 DropdownMenuItem 上，
                // 见下行 className）；垃圾桶常驻显示 —— 触屏没有 hover，藏起来等于没有
                className="group gap-1.5 pr-1"
                onSelect={() => void run(() => app.gitAction(workspaceId, { action: 'checkout', ref: name }))}
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {name === status.branch && <Check className="size-3.5 shrink-0" />}
                <IconTip label={name === status.branch ? t('不能删除当前所在的分支') : t('删除本地分支 {name}…', { name })}>
                  <Button
                    variant="ghost"
                    className="size-6! shrink-0 rounded p-0! text-muted-foreground/50 hover:text-destructive"
                    aria-label={t('删除本地分支 {name}', { name })}
                    disabled={name === status.branch || busy}
                    onClick={(e) => {
                      // ⚠️ radix 菜单项的「选中」就是它自己的 onClick（见 MenuItemImpl），
                      // 不拦 stopPropagation 的话点垃圾桶会顺手把该分支检出、还会把菜单关掉。
                      // React 的合成事件冒泡到外层菜单项之前会先经过这里，拦得住。
                      e.stopPropagation()
                      setDeleteForce(false)
                      setDeleteTarget({ kind: 'local', name })
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </IconTip>
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem disabled>{t('还没有任何分支（先提交一次）')}</DropdownMenuItem>
          )}
          {branches?.remotes.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t('远端分支（检出为本地分支并跟踪）')}
              </DropdownMenuLabel>
              {branches.remotes.map((name) => (
                <DropdownMenuItem
                  key={name}
                  className="group gap-1.5 pr-1"
                  onSelect={() => void run(() => app.gitAction(workspaceId, { action: 'checkout', ref: name }))}
                >
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <IconTip label={t('删除远端分支 {name}…', { name })}>
                    <Button
                      variant="ghost"
                      className="size-6! ml-1 shrink-0 rounded p-0! text-muted-foreground/50 hover:text-destructive"
                      aria-label={t('删除远端分支 {name}', { name })}
                      disabled={busy}
                      onClick={(e) => {
                        // 同行内嵌按钮：不拦 stopPropagation 会连带触发外层的「检出」
                        e.stopPropagation()
                        const { remote, branch } = splitRemoteBranch(name)
                        setDeleteForce(false)
                        setDeleteTarget({ kind: 'remote', remote, branch })
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </IconTip>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        头部：分支下拉 + 刷新 / 树状 / 更多。

        **刻意不再写「源代码管理」这个标题**：标签条上已经有「源码管理」了，再重复一遍纯占地方，
        标题位让给分支 —— 它才是这一行最有用的东西（原来独占下面一整行状态条）。
        顺带把状态条上那几个指示（分离头指针 / ↑↓ / 上游）也搬上来，那行于是整行删掉。
      */}
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <GitBranchIcon
          className="size-4 shrink-0 text-muted-foreground"
          aria-label={status?.root ? t('仓库：{root}', { root: status.root }) : undefined}
        />
        {branchDropdown()}
        {status?.isRepo && status.detached && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600">
            {t('分离头指针')}
          </span>
        )}
        {status?.isRepo && status.ahead > 0 && (
          <span className="shrink-0 text-xs text-emerald-500">↑{status.ahead}</span>
        )}
        {status?.isRepo && status.behind > 0 && (
          <span className="shrink-0 text-xs text-amber-500">↓{status.behind}</span>
        )}
        {status?.isRepo && status.upstream && (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={status.upstream}>
            {status.upstream}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <IconTip label={t('刷新')}>
            <Button
              variant="ghost"
              className="size-7! p-0!"
              aria-label={t('刷新')}
              disabled={busy || refreshing}
              // 手动刷新才修剪远端分支（要联网；自动刷新别带，否则每次操作都要等远端）
              onClick={() => void refresh(true)}
            >
              {refreshing || busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
            </Button>
          </IconTip>
          {/* 树状 / 平铺：只改下面两组变更列表的排布，选择记在 localStorage */}
          <IconTip label={treeView ? t('改为平铺列表') : t('按目录树显示')}>
            <Button
              variant="ghost"
              className="size-7! p-0!"
              aria-label={treeView ? t('改为平铺列表') : t('按目录树显示')}
              onClick={() => setGitTreeView(!treeView)}
            >
              {treeView ? <ListTree className="size-4" /> : <List className="size-4" />}
            </Button>
          </IconTip>
          {/* 更多操作：拉取 / 推送 / 新建分支 / 管理远端都收进这里，只在工作区是仓库时才有得操作 */}
          {status?.isRepo && (
            <DropdownMenu>
              <IconTip label={t('更多操作')}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="size-7! p-0!"
                    aria-label={t('更多操作')}
                    disabled={busy}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </IconTip>
              {/* min-w 而不是固定宽：面板随最长内容自适应（分支名 / 远端名可能较长） */}
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem
                  title={
                    status.remotes.length === 0
                      ? t('还没有远端：先填一个远端地址')
                      : status.detached
                        ? t('分离头指针状态下不能拉取')
                        : status.upstream
                          ? t('从 {upstream} 拉取', { upstream: status.upstream })
                          : t('当前分支没有上游：先推送一次设好上游')
                  }
                  disabled={busy || status.detached}
                  onSelect={() => {
                    if (status.remotes.length === 0) {
                      openRemoteDialog()
                      return
                    }
                    if (status.detached || !status.upstream) return
                    void run(() => app.gitAction(workspaceId, { action: 'pull' }), t('已拉取'), 'pull')
                  }}
                >
                  <ArrowDown className="size-3.5" />
                  {status.behind > 0 ? t('拉取 {count}', { count: status.behind }) : t('拉取')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  title={
                    status.remotes.length === 0
                      ? t('还没有远端：先填一个远端地址')
                      : status.detached
                        ? t('分离头指针状态下不能推送')
                        : t('推送到远端（不做强推）')
                  }
                  disabled={busy || status.detached}
                  onSelect={() => void push()}
                >
                  <Upload className="size-3.5" />
                  {status.ahead > 0 ? t('推送 {count}', { count: status.ahead }) : t('推送')}
                </DropdownMenuItem>
                {/* 有不止一个远端时才给「推送到…」：只有一个的时候跟上面那条是同一个结果 */}
                {status.remotes.length > 1 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={busy || status.detached}>
                      <Network className="size-3.5" />
                      {t('推送到…')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {status.remotes.map((r) => (
                        <DropdownMenuItem
                          key={r.name}
                          title={r.url}
                          disabled={busy || status.detached}
                          onSelect={() => void push(r.name)}
                        >
                          <span className="min-w-0 truncate">{r.name}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  title={t('新建分支：从当前 HEAD 或任意分支切一条新分支出来')}
                  onSelect={() => {
                    setNewBranchName('')
                    setNewBranchFrom(NEW_BRANCH_HEAD)
                    setNewBranchOpen(true)
                  }}
                >
                  <GitBranchPlus className="size-3.5" />
                  {t('新建分支…')}
                </DropdownMenuItem>
                {/* 「管理远端」（增 / 改地址 / 删）收在这里：以前「没有远端」时状态条上有个
                    琥珀色入口，现在那个入口没了，这里就是唯一的地方 */}
                <DropdownMenuItem
                  title={
                    status.remotes.length === 0
                      ? t('还没有配置远端：在这里添加')
                      : t('已配置 {count} 个远端：查看 / 改地址 / 删除', { count: status.remotes.length })
                  }
                  onSelect={() => openRemoteDialog()}
                >
                  <Network className="size-3.5" />
                  {t('管理远端…')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('读取仓库状态…')}
        </div>
      ) : loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
          <span>{loadError}</span>
          <Button variant="outline" className="h-7!" onClick={() => void refresh(true)}>
            {t('重试')}
          </Button>
        </div>
      ) : !status?.isRepo ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <GitBranchIcon className="size-6 text-muted-foreground/50" />
          <p className="text-sm text-foreground">{t('这个工作区还不是 git 仓库。')}</p>
          <SpinnerButton
            className="h-7! gap-1.5 text-xs"
            disabled={busy}
            loading={busyAction === 'init'}
            spinnerClassName="size-3.5"
            title={t('在这个工作区目录里执行 git init（初始分支沿用你 git 配置里的 init.defaultBranch）')}
            onClick={() =>
              void run(() => app.gitAction(workspaceId, { action: 'init' }), t('已初始化 git 仓库'), 'init')
            }
          >
            {busyAction !== 'init' && <Plus className="size-3.5" />}
            {t('初始化 git 仓库')}
          </SpinnerButton>
          <p className="max-w-[280px] text-xs text-muted-foreground">
            {t('初始化后所有文件都是未跟踪状态；建议先补一个')} <code>.gitignore</code>{' '}
            {t('再提交。')}
          </p>
        </div>
      ) : (
        <>
          {/* 原来这里有一行状态条（分支下拉 / 分离头指针 / ↑↓ / 上游）—— 已整体并入头部，
              见文件顶部头部那段的注释 */}

          {/* 提交区：一行贴在变更列表上方 —— 输入提交信息，点提交（或 Ctrl / ⌘ + Enter）；只提交已暂存的改动 */}
          <div className="flex shrink-0 items-center gap-1.5 p-2">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                // 刻意排除 shift：Ctrl / ⌘ + Shift + Enter 是面板级的「推送」，
                // 不排掉的话这个输入框会把带 shift 的那一下也吞成提交
                if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'Enter' && canCommit) {
                  e.preventDefault()
                  void commit()
                }
              }}
              placeholder={t('提交信息（Ctrl / ⌘ + Enter 提交）')}
              className="h-7! min-w-0 flex-1 text-sm"
            />
            <SpinnerButton
              className="h-7! shrink-0 text-sm"
              disabled={!canCommit}
              loading={busyAction === 'commit'}
              spinnerClassName="size-3.5"
              title={stagedChanges.length === 0 ? t('先在「已暂存的更改」里暂存改动') : t('提交已暂存的改动')}
              onClick={() => void commit()}
            >
              {t('提交')}
            </SpinnerButton>
          </div>

          {/* 变更列表 + 历史 */}
          {/* 只留左右 / 底部内边距：顶部不留 —— 否则 sticky 标题滚动时会被这条 padding 顶出一段空隙，看着像浮着 */}
          <div data-git-scroll className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 space-y-2">
            {changes.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">{t('没有未提交的改动')}</div>
            ) : (
              <>
                {status.truncated && (
                  <div className="mx-1.5 mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600">
                    {t('改动太多，只列出前 {count} 项（多半是没配', { count: changes.length })}{' '}
                    <code>.gitignore</code>{' '}
                    {t('的依赖 / 产物目录）。为避免漏提交，批量暂存已停用，建议先把这些目录加进')}{' '}
                    <code>.gitignore</code>{t('。')}
                  </div>
                )}
                {stagedChanges.length > 0 && (
                  <div>
                    {/* 标题行 sticky：滚动时这一组（或下一组）的标题总有一个钉在顶部，随时知道自己在看哪一段 */}
                    <div className="sticky top-0 z-10 -mx-1 flex items-center gap-1.5 bg-background px-2.5 py-1 text-sm font-medium text-muted-foreground">
                      {/* 标题即开关：折叠后「全部」按钮仍在 —— 收起只是为了腾地方，不该顺带把批量操作也藏了 */}
                      <button
                        type="button"
                        onClick={() => setStagedOpen((v) => !v)}
                        title={stagedOpen ? t('收起这一组') : t('展开这一组')}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground"
                      >
                        {stagedOpen ? (
                          <ChevronDown className="size-3.5 shrink-0" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0" />
                        )}
                        <span className="shrink-0">{t('已暂存的更改')}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {stagedChanges.length}
                        </span>
                      </button>
                      {collapseAllButton(true)}
                      <IconTip
                        label={
                          status.truncated
                            ? t('改动过多、列表已截断，批量操作已停用')
                            : t('全部取消暂存')
                        }
                      >
                        <SpinnerButton
                          variant="ghost"
                          className="size-5! shrink-0 p-0! text-muted-foreground"
                          spinnerClassName="size-3.5"
                          loading={busyAction === 'unstage-all'}
                          aria-label={t('全部取消暂存')}
                          disabled={busy || status.truncated}
                          onClick={() => void run(
                            () => app.gitAction(workspaceId, {
                              action: 'unstage',
                              paths: stagedChanges.map((c) => c.path)
                            }),
                            t('已全部取消暂存'),
                            'unstage-all'
                          )}
                        >
                          {busyAction !== 'unstage-all' && <Minus className="size-4" />}
                        </SpinnerButton>
                      </IconTip>
                    </div>
                    {stagedOpen && (
                      <div className="pl-2">
                        {treeView ? (
                          <ChangeTreeList
                            changes={stagedChanges}
                            collapsed={collapsedOf(true)}
                            onToggleDir={(dir) => toggleDir(true, dir)}
                            renderFile={stagedRow}
                            renderDirActions={(dir) => dirActions(dir, true)}
                          />
                        ) : (
                          stagedChanges.map((c) => stagedRow(c, 0))
                        )}
                      </div>
                    )}
                  </div>
                )}

                {unstagedChanges.length > 0 && (
                  <div>
                    {/* 标题行 sticky：滚动时这一组（或下一组）的标题总有一个钉在顶部，随时知道自己在看哪一段 */}
                    <div className="sticky top-0 z-10 -mx-1 flex items-center gap-1.5 bg-background px-2.5 py-1 text-sm font-medium text-muted-foreground">
                      {/* 标题即开关：折叠后「全部」按钮仍在 —— 收起只是为了腾地方，不该顺带把批量操作也藏了 */}
                      <button
                        type="button"
                        onClick={() => setUnstagedOpen((v) => !v)}
                        title={unstagedOpen ? t('收起这一组') : t('展开这一组')}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground"
                      >
                        {unstagedOpen ? (
                          <ChevronDown className="size-3.5 shrink-0" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0" />
                        )}
                        <span className="shrink-0">{t('更改')}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {unstagedChanges.length}
                        </span>
                      </button>
                      {collapseAllButton(false)}
                      {/* 贮藏入口放在「更改」组标题上、回滚左侧：它操作的就是这一组的改动 */}
                      <IconTip label={t('贮藏当前更改（git stash）：工作区清空，改动收进贮藏栈')}>
                        <Button
                          variant="ghost"
                          className="size-5! shrink-0 p-0! text-muted-foreground hover:text-foreground"
                          aria-label={t('贮藏当前更改')}
                          disabled={busy}
                          onClick={() => openStashDialog()}
                        >
                          <Archive className="size-3.5" />
                        </Button>
                      </IconTip>
                      {/* 这一组的回滚入口：只回滚列出在这一组里的文件（未暂存 + 未跟踪） */}
                      <IconTip label={t('回滚「更改」里列出的这些文件（未暂存 + 未跟踪）')}>
                        <Button
                          variant="ghost"
                          className="size-5! shrink-0 p-0! text-muted-foreground hover:text-destructive"
                          aria-label={t('回滚「更改」里列出的这些文件')}
                          disabled={busy}
                          onClick={() => setBulkRollback('unstaged')}
                        >
                          <RotateCcw className="size-4" />
                        </Button>
                      </IconTip>
                      <IconTip
                        label={
                          status.truncated
                            ? t('改动过多、列表已截断，批量操作已停用')
                            : t('全部暂存')
                        }
                      >
                        <SpinnerButton
                          variant="ghost"
                          className="size-5! shrink-0 p-0! text-muted-foreground"
                          spinnerClassName="size-3.5"
                          loading={busyAction === 'stage-all'}
                          aria-label={t('全部暂存')}
                          disabled={busy || status.truncated}
                          onClick={() => void run(
                            () => app.gitAction(workspaceId, {
                              action: 'stage',
                              paths: unstagedChanges.map((c) => c.path)
                            }),
                            t('已全部暂存'),
                            'stage-all'
                          )}
                        >
                          {busyAction !== 'stage-all' && <Plus className="size-4" />}
                        </SpinnerButton>
                      </IconTip>
                    </div>
                    {unstagedOpen && (
                      <div className="pl-2">
                        {treeView ? (
                          <ChangeTreeList
                            changes={unstagedChanges}
                            collapsed={collapsedOf(false)}
                            onToggleDir={(dir) => toggleDir(false, dir)}
                            renderFile={unstagedRow}
                            renderDirActions={(dir) => dirActions(dir, false)}
                          />
                        ) : (
                          unstagedChanges.map((c) => unstagedRow(c, 0))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* 历史：点某次提交就地展开看它改了什么；「检出」切到那次提交（分离头指针），
                用分支下拉切回去。展开态的异步与缓存都在 GitHistory 里 */}
            <GitHistory
              app={app}
              workspaceId={workspaceId}
              commits={commits}
              busy={busy}
              hasMore={historyHasMore}
              loadingMore={historyLoadingMore}
              onLoadMore={() => void loadMoreHistory()}
              onCheckout={(hash) => void run(() => app.gitAction(workspaceId, { action: 'checkout', ref: hash }))}
            />

            {/* 贮藏：与「历史提交」同一套折叠；每一行可弹出（pop）/ 应用（apply）/ 删除（drop） */}
            <div>
              {/* 标题行 sticky：滚动时整行钉顶，免得只剩标题 */}
              <div className="sticky top-0 z-10 -mx-1 flex items-center gap-1 bg-background px-1">
                <button
                  type="button"
                  onClick={() => setStashesOpen((v) => !v)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-sm font-medium text-muted-foreground hover:bg-foreground/5"
                >
                  {stashesOpen ? (
                    <ChevronDown className="size-3.5 shrink-0" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0" />
                  )}
                  {t('贮藏')}
                </button>
              </div>
              {stashesOpen && (
                <div className="pl-2">
                  {stashes.length ? (
                    stashes.map((s) => (
                      <div
                        key={s.ref}
                        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-foreground/5"
                      >
                        <span className="shrink-0 font-mono text-muted-foreground">{s.ref}</span>
                        <span className="min-w-0 flex-1 truncate" title={s.message}>
                          {s.message}
                        </span>
                        <Button
                          variant="ghost"
                          className="h-5! shrink-0 gap-1 px-1.5! text-xs"
                          title={t('弹出（git stash pop）：应用这次贮藏，并从栈里删掉')}
                          disabled={busy}
                          onClick={() => void applyStash(s, true)}
                        >
                          <ArchiveRestore className="size-3" />
                          {t('弹出')}
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-5! shrink-0 px-1.5! text-xs"
                          title={t('应用（git stash apply）：应用这次贮藏，但留在栈里')}
                          disabled={busy}
                          onClick={() => void applyStash(s, false)}
                        >
                          {t('应用')}
                        </Button>
                        <IconTip label={t('删除这次贮藏（git stash drop）…')}>
                          <Button
                            variant="ghost"
                            className="size-5! shrink-0 p-0! text-muted-foreground hover:text-destructive"
                            aria-label={t('删除贮藏 {ref}', { ref: s.ref })}
                            disabled={busy}
                            onClick={() => setDropStash(s)}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </IconTip>
                      </div>
                    ))
                  ) : (
                    <div className="px-2 py-1 text-xs text-muted-foreground">{t('还没有贮藏')}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* 贮藏当前更改：说明可空（git 会自动补 `WIP on <分支>`），可选连未跟踪文件一起收 */}
      <Dialog open={stashOpen} onOpenChange={setStashOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('贮藏当前更改')}</DialogTitle>
            <DialogDescription>
              {t('工作区（和暂存区）里的改动会被收进贮藏栈，工作区回到干净状态；之后可以在变更列表下方的「贮藏」里再弹出来。')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={stashMessage}
              onChange={(e) => setStashMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) {
                  e.preventDefault()
                  void stashChanges()
                }
              }}
              placeholder={t('说明（可空，如：调一半的登录页）')}
              autoFocus
            />
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <Checkbox
                className="mt-px"
                checked={stashUntracked}
                onCheckedChange={(checked) => setStashUntracked(checked === true)}
              />
              <span>
                {t('连未跟踪文件一起收（')}<code>git stash -u</code>{t('）—— 不勾的话新文件会留在工作区')}
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button data-dialog-dismiss="" variant="ghost" className="h-8!" onClick={() => setStashOpen(false)}>
              {t('取消')}
            </Button>
            <SpinnerButton
              className="h-8!"
              disabled={busy}
              loading={busyAction === 'stash'}
              onClick={() => void stashChanges()}
            >
              {t('贮藏')}
            </SpinnerButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删贮藏确认：drop 掉之后只剩 reflog 能找回，所以先问一句 */}
      <AlertDialog
        open={dropStash !== null}
        onOpenChange={(open) => {
          if (!open) setDropStash(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('删除这次贮藏？')}</AlertDialogTitle>
            <AlertDialogDescription>
              <code className="font-mono">{dropStash?.ref}</code>
              {t('（{message}）会从贮藏栈里删掉。里面的改动没有别处保存，删完之后只剩 reflog（默认保留约 90 天）里还能找到 —— 想留着就先「应用」或「弹出」。', { message: dropStash?.message ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void dropStashEntry()}>
              {t('删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        新建分支：从「当前 HEAD」或任意本地 / 远端分支切一条新分支出来并切过去。
        这里用 Dialog 而不是在分支下拉里塞输入框 —— 下拉菜单是 modal 层，关闭时会收回
        body 的 pointer-events，紧接着开另一个 modal 层容易点不动（经典竞态）。
        起点用哨兵值而不是空字符串：Radix 的 SelectItem 不接受 value=""。
      */}
      <Dialog open={newBranchOpen} onOpenChange={setNewBranchOpen}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>{t('新建分支')}</DialogTitle>
            <DialogDescription>
              {t('从下面的起点切出一条新分支并切过去（当前未提交的改动会跟着带到新分支）。')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Input
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canCreateBranch) {
                  e.preventDefault()
                  void createBranch()
                }
              }}
              placeholder={t('分支名，如 feature/login')}
              autoFocus
            />
            <Select value={newBranchFrom} onValueChange={setNewBranchFrom}>
              <SelectTrigger className="w-full" title={t('从哪切出来')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" className="max-h-72">
                <SelectItem value={NEW_BRANCH_HEAD}>
                  {branchLabel ? t('当前 HEAD（{branch}）', { branch: branchLabel }) : t('当前 HEAD')}
                </SelectItem>
                {branches?.branches.length ? (
                  <SelectGroup>
                    <SelectLabel>{t('本地分支')}</SelectLabel>
                    {branches.branches.map((name) => (
                      <SelectItem key={`local:${name}`} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                {branches?.remotes.length ? (
                  <SelectGroup>
                    <SelectLabel>{t('远端分支（会带上游跟踪）')}</SelectLabel>
                    {branches.remotes.map((name) => (
                      <SelectItem key={`remote:${name}`} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button data-dialog-dismiss="" variant="ghost" className="h-8!" onClick={() => setNewBranchOpen(false)}>
              {t('取消')}
            </Button>
            <SpinnerButton
              className="h-8!"
              disabled={!canCreateBranch}
              loading={busyAction === 'create-branch'}
              onClick={() => void createBranch()}
            >
              {t('创建并切换')}
            </SpinnerButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        回退确认：丢掉未提交的内容是不可恢复的，所以**必须**由用户点过确认才动手。
        文案按三种情况分开写 —— 「未跟踪」是删文件、「已暂存」连索引一起丢，
        含糊地说「确定吗」用户根本不知道会失去什么。
      */}
      <AlertDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{rollbackDialogTitle(rollbackTarget)}</AlertDialogTitle>
            <AlertDialogDescription>
              {rollbackDialogDescription(rollbackTarget)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmRollback()}>
              {rollbackDialogAction(rollbackTarget)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        批量回滚确认：不说清「只会碰列出来的这些」与「有几个文件会被直接删掉」，
        用户没法判断这一下会失去什么。
      */}
      <AlertDialog
        open={bulkRollback !== null}
        onOpenChange={(open) => {
          if (!open) setBulkRollback(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('回滚「更改」里列出的文件？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('这 {count} 个文件会回到上次提交，已暂存的那份也会一起丢掉', { count: bulkPaths.length })}
              {bulkDeletes > 0
                ? t('；其中 {count} 个未跟踪 / 只存在于暂存区的新文件会被从磁盘上删除', { count: bulkDeletes })
                : ''}
              {t('。未提交的内容无法恢复。')}
              <span className="mt-1 block">
                {t('只影响工作区内、列表里列出的这些文件 —— 仓库里别处的改动不会被碰。')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void rollbackListed()}>
              {t('回滚 {count} 个文件', { count: bulkPaths.length })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        删除分支确认：本地 / 远端分开写后果 —— 含糊地说「确定吗」用户根本不知道会失去什么。
        本地分支默认走 `git branch -d`（git 自己判有没有合并），未合并的会被 git 拒绝；
        想连未合并的一起删得勾「强制删除」（= `-D`：删完只剩 reflog，默认约 90 天能找回）。
        远端分支删除就是 `git push <remote> --delete <branch>`，不可撤销。
      */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDeleteForce(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === 'remote' ? t('删除远端分支？') : t('删除本地分支？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === 'remote' ? (
                <>
                  {t('远端的 {branch} 会被删掉（=', { branch: deleteLabel })}{' '}
                  <code className="font-mono">{`git push ${deleteTarget.remote} --delete ${deleteTarget.branch}`}</code>
                  {t('）。这一步会推到远端，别人再 fetch 就会看到它消失，无法撤销。本地如果还有同名分支，不受影响。')}
                </>
              ) : (
                <>
                  {t('本地分支')} <code className="font-mono">{deleteLabel}</code>{' '}
                  {t('的引用会被删除。已经并进其它分支的提交不会丢；删完之后也只有 reflog（默认保留约 90 天）里还能找回它。')}
                </>
              )}
              {/* 强制删除只对本地分支有意义：远端分支删除本身就是强删（远端 ref 被推空） */}
              {deleteTarget?.kind !== 'remote' && (
                <label className="mt-2 flex items-start gap-2 text-xs">
                  <Checkbox
                    className="mt-px"
                    checked={deleteForce}
                    onCheckedChange={(checked) => setDeleteForce(checked === true)}
                  />
                  <span>
                    {t('强制删除：这个分支还没有合并也删（未合并的提交删完只剩 reflog 能找回）')}
                  </span>
                </label>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void deleteBranch()}>
              {t('删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        管理远端（增 / 改地址 / 删）：从头部「更多」进；没有远端时点「推送」「拉取」也会直接开到这儿。
        上半是表单（新增，或改某个已有远端的地址），下半是已有远端的列表 —— 列表数据来自
        `status.remotes`，每次写操作后 `run()` 里的刷新会把它重拿一遍，不用自己维护一份。
      */}
      <Dialog open={remoteOpen} onOpenChange={setRemoteOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t('管理远端')}</DialogTitle>
            <DialogDescription>
              {remoteDraft.editing
                ? t('修改远端「{name}」的地址。', { name: remoteDraft.name })
                : t('添加一个远端（https 与 git@host:path 两种写法都支持），配好就能推送了。')}
            </DialogDescription>
          </DialogHeader>

          {/* 表单：远端名 + 地址。改地址时名字锁死 —— git 改地址是 set-url，改名是另一回事 */}
          <div className="flex items-center gap-2">
            <Input
              value={remoteDraft.name}
              onChange={(e) => setRemoteDraft((d) => ({ ...d, name: e.target.value }))}
              disabled={remoteDraft.editing}
              placeholder="origin"
              title={t('远端名（一般就是 origin）')}
              className="w-28 shrink-0"
            />
            <Input
              value={remoteDraft.url}
              onChange={(e) => setRemoteDraft((d) => ({ ...d, url: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSaveRemote) {
                  e.preventDefault()
                  void saveRemote()
                }
              }}
              placeholder="git@github.com:you/repo.git"
              autoFocus
            />
            <SpinnerButton
              className="h-9! shrink-0"
              disabled={!canSaveRemote}
              loading={busyAction === 'save-remote'}
              onClick={() => void saveRemote()}
            >
              {remoteDraft.editing ? t('保存') : t('添加')}
            </SpinnerButton>
            {remoteDraft.editing && (
              <Button
                variant="outline"
                className="h-9! shrink-0"
                onClick={() => setRemoteDraft({ name: '', url: '', editing: false })}
              >
                {t('取消')}
              </Button>
            )}
          </div>

          {/* 已有远端：一行一个，行尾可「改地址」/「删除」 */}
          <div className="max-h-64 overflow-y-auto rounded-md border border-border/70">
            {status?.remotes.length ? (
              status.remotes.map((r) => {
                const editing = remoteDraft.editing && remoteDraft.name === r.name
                return (
                  <div
                    key={r.name}
                    className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5 text-xs last:border-b-0"
                  >
                    <span className="w-24 shrink-0 truncate font-medium" title={r.name}>
                      {r.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={r.url}>
                      {r.url}
                    </span>
                    <IconTip label={t('改「{name}」的地址', { name: r.name })}>
                      <Button
                        variant="ghost"
                        className={cn('size-6! shrink-0 p-0!', editing && 'text-primary')}
                        aria-label={t('修改远端 {name} 的地址', { name: r.name })}
                        disabled={busy}
                        onClick={() => editRemote(r.name, r.url)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    </IconTip>
                    <IconTip label={t('删除远端 {name}…', { name: r.name })}>
                      <Button
                        variant="ghost"
                        className="size-6! shrink-0 p-0! text-muted-foreground hover:text-destructive"
                        aria-label={t('删除远端 {name}', { name: r.name })}
                        disabled={busy}
                        onClick={() => setDeletingRemote(r.name)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </IconTip>
                  </div>
                )
              })
            ) : (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {t('还没有配置远端 —— 上面填一个地址点「添加」即可。')}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button data-dialog-dismiss="" variant="ghost" className="h-8!" onClick={() => setRemoteOpen(false)}>
              {t('关闭')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删远端确认：不动本地提交，但它的远端跟踪分支与当前分支的上游会一起消失 */}
      <AlertDialog
        open={deletingRemote !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingRemote(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('删除远端「{name}」？', { name: deletingRemote ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('只会删掉「这个远端配在哪」，本地分支与提交不受影响，远端仓库本身也不会变。但它的远端跟踪分支（')}
              <code className="font-mono">{`${deletingRemote}/*`}</code>
              {t('）和当前分支对它的上游设置会一起消失，之后要推送得重新配置。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void removeRemote(deletingRemote!)}>
              {t('删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
