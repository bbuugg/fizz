/**
 * 分支选择器 —— **受控版**：只吃 props，完全不知道 `AgentApp` / `GitPanel` 的存在。
 *
 * 原先是 `ComposerStatusBar` 里的私有 `BranchPill`：切分支、新建、删除、确认框全写在
 * 那一颗里。`GitPanel` 头部那颗分支下拉是另一套（Radix `DropdownMenu`，不能搜、不分组、
 * 也没有面板的高度动画），两边越走越不像。现在把整块面板抽到这里：
 *
 * - `GitPanel` 传 `variant="header"`（面板头部那颗幽灵按钮）；
 * - `variant="pill"` 是原先 composer 输入条下面那颗的长相 —— composer 已不再挂分支入口
 *   （底栏 `StatusBarNodes` 有常驻入口），这一档留着只当受控组件的样式选项。
 *
 * 数据仍由调用方管：分支清单、当前分支、loading / busy、以及四个动作（检出 / 新建 /
 * 初始化仓库 / 删除）都从 props 进 —— 调用方各自有自己的刷新与错误处理（`GitPanel`
 * 走 `run()`），本文件只负责面板长相与交互。
 *
 * 面板长相来自 `@fizz/ui/picker-panel`（搜索 + 列表 + 底部固定动作），与工作区 / 模型
 * 选择器同一套，高度动画由 `PickerPanel` 自带（`useHeightTransition`）。
 *
 * ## 删除确认在组件内部
 *
 * 删分支是破坏性动作，必须二次确认；共享这份确认框意味着两处对后果的说法只有一份
 * （本地 `-d` / 可勾强制 `-D`、远端 `push --delete`），不会一个地方说「能找回」、
 * 另一个地方含糊带过。确认后调 `onDelete(target, force)`，真正的命令与刷新在调用方。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Copy, GitBranch, GitBranchPlus, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { GitBranchesResult } from '@fizz/git'
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
import { Checkbox } from '@fizz/ui/checkbox'
import { Input } from '@fizz/ui/input'
import { Popover, PopoverTrigger } from '@fizz/ui/popover'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@fizz/ui/tooltip'
import { CHAT_PILL } from '@fizz/agent-kit/features/chat/composer'
import { NotARepoState } from '@fizz/agent-kit/features/git/NotARepoState'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { ROW_ACTION_CLASS } from '@fizz/agent-kit/shared/components/RowAction'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 待删除的分支：本地一个名字；远端要拆成远端名 + 分支名（分支名允许带 `/`） */
export type BranchDeleteTarget =
  | { kind: 'local'; name: string }
  | { kind: 'remote'; remote: string; branch: string }

/**
 * 远端分支名（`origin/feature/x`）→ { remote, branch }：只能按第一段拆
 * （远端名本身不允许含 `/`，分支名可以）。
 */
function splitRemoteBranch(name: string): { remote: string; branch: string } {
  const slash = name.indexOf('/')
  return { remote: name.slice(0, slash), branch: name.slice(slash + 1) }
}

/**
 * 分支名：面板宽度固定（`w-72`），长名字由行内 `truncate` 截断，悬停出一颗设计系统的
 * 提示显示全名。
 *
 * ⚠️ 只在**真的被截断**（`scrollWidth > clientWidth`）时才挂 Tooltip：短名字不弹、
 * 鼠标划过列表时也不会一路冒气泡。别改回原生 `title` —— 它要等一两秒、样式不跟主题，
 * 上一版就是因为它「看起来没有提示」。
 */
function BranchName({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)

  // 面板刚挂上时量一次（宽度固定，名字变了才会变）
  useEffect(() => {
    const el = ref.current
    if (el) setTruncated(el.scrollWidth > el.clientWidth + 1)
  }, [name])

  const text = (
    <span ref={ref} className="block truncate">
      {name}
    </span>
  )

  if (!truncated) return text
  return (
    <Tooltip>
      <TooltipTrigger asChild>{text}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-80 break-all">
        {name}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * 读分支 / 空结果占位区的共用高度（px）：一行分组标题（`pt-2` + 12px 条 + `pb-1` = 24）
 * 加三行 32px 的行高。
 *
 * 两个状态都按它占位：加载完发现一条分支都没有时，面板高度不动，不会「啪」地缩成一截
 * （用户报过：加载中的骨架屏和空态之间高度跳变）。骨架屏加行、改行高时这里要跟着改。
 */
const BRANCH_PLACEHOLDER_HEIGHT = 24 + 3 * 32

/**
 * 读分支清单时的骨架屏：按 `PickerItem` 的几何摆几行（32px 行高、16px 图标位、文字条），
 * 数据到了原地替换 —— 比一行「读取分支…」更像列表正在长出来。
 *
 * 总高度必须等于 `BRANCH_PLACEHOLDER_HEIGHT`（空态按同一个数占位）。
 * 文字条宽度刻意错落：几根等长的条看着像加载失败的占位，不像分支名。
 */
function BranchListSkeleton() {
  return (
    <div aria-busy="true" aria-hidden="true">
      <div className="px-2.5 pt-2 pb-1">
        <Skeleton className="h-3 w-16 rounded" />
      </div>
      {['w-[70%]', 'w-[52%]', 'w-[84%]'].map((width) => (
        <div key={width} className="flex h-8 items-center gap-2.5 px-2.5 py-1.5">
          <Skeleton className="size-4 shrink-0 rounded" />
          <Skeleton className={cn('h-3.5 rounded', width)} />
        </div>
      ))}
    </div>
  )
}

export interface BranchPickerProps {
  /** 当前分支名（`null` = 分离头指针 / 非仓库）；用于「当前项打勾」与「不能删自己」 */
  branch: string | null
  isRepo: boolean
  /** 分支清单；`null` = 还没读到 */
  branches: GitBranchesResult | null
  /** 正在读分支清单（面板里显示骨架屏） */
  loading?: boolean
  /** 有写操作在跑：触发器与行内动作一起禁用 */
  busy?: boolean
  disabled?: boolean
  /** 触发器形态：输入条下的 pill / 面板头部的幽灵按钮 */
  variant?: 'pill' | 'header'
  /** 触发器上显示的文字；默认 `branch ?? emptyLabel`（分离头指针之类由调用方给文案） */
  label?: string
  /** 不是仓库时 pill 上的字（默认「Git」） */
  emptyLabel?: string
  /** 触发器 hover 说明 */
  title?: string
  /** 打开面板时刷新分支清单（调用方自己发请求） */
  onOpen?: () => void
  onCheckout: (ref: string) => void | Promise<void>
  /**
   * 给了才在底部出现「新建分支…」的内联表单。`from` = 起点分支（本地或远端 ref），
   * 不传 = 从当前 HEAD 切 —— 用户在表单里可以用「起点」那颗按钮改。
   */
  onCreate?: (name: string, from?: string) => void | Promise<void>
  /** 不是仓库时面板里的「初始化仓库」 */
  onInit?: () => void | Promise<void>
  /** 确认框点过「删除」之后调用；不传 = 不画垃圾桶 */
  onDelete?: (target: BranchDeleteTarget, force: boolean) => void | Promise<void>
  /** 本地分支改名（`git branch -m`）；不传 = 不画铅笔 */
  onRename?: (from: string, to: string) => void | Promise<void>
  side?: 'top' | 'bottom'
  align?: 'start' | 'end' | 'center'
}

export function BranchPicker({
  branch,
  isRepo,
  branches,
  loading = false,
  busy = false,
  disabled = false,
  variant = 'pill',
  label,
  emptyLabel,
  title,
  onOpen,
  onCheckout,
  onCreate,
  onInit,
  onDelete,
  onRename,
  side = 'bottom',
  align = 'start'
}: BranchPickerProps) {
  const tr = useT()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  /** 搜索词：只活在一次打开里（关面板就清空） */
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  /** 新建分支的起点（空串 = 当前 HEAD） */
  const [newFrom, setNewFrom] = useState('')
  /** 正在主列表里挑起点（此时列表展示分支而不是可切换分支的动作） */
  const [pickingBase, setPickingBase] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<BranchDeleteTarget | null>(null)
  const [deleteForce, setDeleteForce] = useState(false)
  /** 正在改名的本地分支（null = 没开弹窗）；输入值单独存，取消即丢 */
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')

  const text = label ?? branch ?? emptyLabel ?? tr('Git')

  const close = (): void => setOpen(false)
  const reset = (): void => {
    setCreating(false)
    setNewName('')
    setNewFrom('')
    setPickingBase(false)
    setQuery('')
  }

  const keyword = query.trim().toLowerCase()
  const match = (name: string): boolean => !keyword || name.toLowerCase().includes(keyword)
  const local = (branches?.branches ?? []).filter(match)
  const remote = (branches?.remotes ?? []).filter(match)
  /**
   * 还没有任何提交（`git init` 之后）：`git branch` 一条 ref 都没有，`checkout -b` 只是给
   * 这根「未出生」的分支改个名 —— 命令返回成功，但分支清单依然空白。服务端现在直接拒
   * （见 git/action 路由），这里也不摆「新建分支…」入口，空态改成「先提交一次」。
   *
   * 判据：仓库里一条本地 / 远端 ref 都没有，且仍挂在某个分支名上（分离头指针是有提交的，
   * `branch` 为 null，不算）。
   */
  const noCommits =
    isRepo &&
    !loading &&
    branches !== null &&
    branches.branches.length === 0 &&
    branches.remotes.length === 0 &&
    branch !== null

  /** 确认框里显示的分支全名（远端带上远端名，免得看不出推的是哪条） */
  const deleteLabel =
    deleteTarget?.kind === 'remote'
      ? `${deleteTarget.remote}/${deleteTarget.branch}`
      : (deleteTarget?.name ?? '')

  /**
   * 行尾动作按钮：与会话行同一套「hover 整行才浮现」的底板（`RowAction`）。
   * 只改 `opacity`，不挪布局 —— 槽位一直占着（`PickerItem` 的 `action`）。
   * 触摸设备没有 hover 态，常显。
   */
  const iconActionClass = cn(
    ROW_ACTION_CLASS,
    'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'
  )
  const deleteClass = cn(iconActionClass, 'hover:text-destructive')

  const select = async (ref: string): Promise<void> => {
    if (busy) return
    close()
    // 点中的就是当前那个：只关面板，不重复检出
    if (ref === branch) return
    await onCheckout(ref)
  }

  const submitCreate = async (): Promise<void> => {
    const name = newName.trim()
    if (!name || !onCreate) return
    const from = newFrom || undefined
    // **不关面板**（用户要求）：建完当场就能看到新分支并继续操作，只把底部表单收起来
    setCreating(false)
    setNewName('')
    setNewFrom('')
    setPickingBase(false)
    await onCreate(name, from)
  }

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget
    if (!target || !onDelete) return
    const force = deleteForce
    setDeleteTarget(null)
    setDeleteForce(false)
    await onDelete(target, force)
  }

  /** 改名表单能不能提交：非空、不能同名、不能以 `-` 开头或带空白（与服务端同一套校验） */
  const renameTo = renameName.trim()
  const canRename =
    !!renameTarget &&
    !!renameTo &&
    renameTo !== renameTarget &&
    !renameTo.startsWith('-') &&
    !/\s/.test(renameTo) &&
    !busy

  const cancelRename = (): void => {
    setRenameTarget(null)
    setRenameName('')
  }

  const submitRename = async (): Promise<void> => {
    const from = renameTarget
    if (!from || !canRename || !onRename) return
    setRenameTarget(null)
    setRenameName('')
    await onRename(from, renameTo)
  }

  /**
   * 复制分支名：走 promise 而不是 void 一把梭 —— 剪贴板在非安全上下文 / 无焦点时会拒，
   * 静默失败的话用户以为已经复制到了。
   */
  const copyBranch = (name: string): void => {
    navigator.clipboard.writeText(name).then(
      () => toast.success(tr('已复制分支名')),
      (err: unknown) =>
        toast.error(
          tr('复制失败：{error}', { error: err instanceof Error ? err.message : String(err) })
        )
    )
  }

  /** 行尾动作（复制分支名）：复制面板里显示的那条 ref（远端含远端名），排在铅笔左侧 */
  const copyAction = (name: string): React.ReactNode => (
    <IconTip label={tr('复制分支名')}>
      <button
        type="button"
        aria-label={tr('复制分支名 {name}', { name })}
        // 行本身是「切换到这条分支」：不拦的话点复制会顺手触发检出
        onClick={(e) => {
          e.stopPropagation()
          copyBranch(name)
        }}
        className={iconActionClass}
      >
        <Copy className="size-3.5" />
      </button>
    </IconTip>
  )

  /** 行尾动作（删除）：不看 `onDelete` 就给不画 */
  const deleteAction = (
    target: BranchDeleteTarget,
    ariaName: string
  ): React.ReactNode => (
    <IconTip label={tr('删除分支')}>
      <button
        type="button"
        aria-label={ariaName}
        disabled={busy}
        // 行本身是「切换到这条分支」：不拦的话点垃圾桶会顺手触发检出
        onClick={(e) => {
          e.stopPropagation()
          setDeleteForce(false)
          setDeleteTarget(target)
        }}
        className={deleteClass}
      >
        <Trash2 className="size-3.5" />
      </button>
    </IconTip>
  )

  /** 行尾动作（改名）：只对本地分支有意义，排在垃圾桶左侧 */
  const renameAction = (name: string): React.ReactNode => (
    <IconTip label={tr('重命名分支')}>
      <button
        type="button"
        aria-label={tr('重命名分支 {name}', { name })}
        disabled={busy}
        // 同行内嵌按钮：不拦的话点铅笔会顺手把这条分支检出
        onClick={(e) => {
          e.stopPropagation()
          setRenameName(name)
          setRenameTarget(name)
        }}
        className={iconActionClass}
      >
        <Pencil className="size-3.5" />
      </button>
    </IconTip>
  )

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) onOpen?.()
          reset()
        }}
      >
        <PopoverTrigger asChild>
          {variant === 'header' ? (
            <Button
              variant="ghost"
              className="h-6! min-w-0 gap-1 px-1.5! text-sm font-normal"
              disabled={disabled}
              aria-label={tr('当前 git 分支：{branch}，点击切换或新建', { branch: text })}
              title={title ?? text}
            >
              <span className="max-w-[160px] truncate">{text}</span>
              <ChevronDown className="size-3 shrink-0" />
            </Button>
          ) : (
            <button
              type="button"
              aria-label={
                isRepo
                  ? tr('当前 git 分支：{branch}，点击切换或新建', { branch: text })
                  : tr('当前工作区还不是 Git 仓库，点击初始化')
              }
              // 与工作区 / 模型 pill 同一套（都吃 CHAT_PILL），只多一颗分支图标
              className={CHAT_PILL}
              title={title ?? text}
              disabled={disabled}
            >
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{text}</span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </button>
          )}
        </PopoverTrigger>
        {/*
          面板与工作区 / 模型选择器同一个原语，宽度吃 `PopoverContent` 的固定 `w-72`：
          长分支名在行内 `truncate`，悬停靠行上的 `title` 看全名 —— 宽度固定后
          左侧图标 / 右侧删除与勾的位置也稳定，不会随分支名长短左右挪。
        */}
        <PickerPanel
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          footer={
            creating ? (
              <PickerFooter>
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void submitCreate()
                  }}
                >
                  <Input
                    variant="muted"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={tr('分支名，如 feature/login')}
                    className="h-8 text-xs"
                    autoFocus
                  />
                  {/*
                    起点：默认当前 HEAD，点一下把上面的列表切成分支清单去挑（本地 / 远端都行）。
                    **不用 Select** —— Radix Select 的内容是 portal，点它会被外层 Popover 判成
                    「点在外面」直接关掉面板；用面板自己的列表挑就不存在这层冲突。
                  */}
                  <button
                    type="button"
                    title={tr('选择从哪条分支创建（默认当前 HEAD）')}
                    onClick={() => {
                      setPickingBase((value) => !value)
                      setQuery('')
                    }}
                    className="flex h-7 w-full items-center gap-1.5 rounded-md bg-muted px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <GitBranch className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {tr('起点：{from}', { from: newFrom || tr('当前 HEAD') })}
                    </span>
                    <ChevronDown
                      className={cn(
                        'size-3 shrink-0 transition-transform',
                        pickingBase && 'rotate-180'
                      )}
                    />
                  </button>
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      onClick={reset}
                    >
                      {tr('取消')}
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      className="h-7"
                      disabled={!newName.trim() || busy}
                    >
                      {tr('创建并切换')}
                    </Button>
                  </div>
                </form>
              </PickerFooter>
            ) : !isRepo || !onCreate ? undefined : (
              /*
                底部动作**始终占一行**（有提交时可用、还没有提交时禁用）：
                分支清单是打开面板后才读回来的，若「要不要画这一行」跟着数据变，
                面板会先长出一行再缩回去 —— 高度跳一下（用户报过）。
                没有提交时置灰即可，理由由上面的空态说明（「先提交一次」）。
              */
              <PickerFooter>
                <PickerAction
                  icon={<GitBranchPlus />}
                  disabled={busy || noCommits}
                  onClick={() => {
                    if (noCommits) return
                    setNewFrom('')
                    setPickingBase(false)
                    setCreating(true)
                  }}
                >
                  {tr('新建分支…')}
                </PickerAction>
              </PickerFooter>
            )
          }
        >
          {isRepo ? (
            <PickerSearch
              autoFocus={!isMobile}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={pickingBase ? tr('搜索起点分支') : tr('搜索分支')}
              aria-label={pickingBase ? tr('搜索起点分支') : tr('搜索分支')}
            />
          ) : null}
          <PickerList>
            {!isRepo ? (
              // 非仓库态与 `GitPanel` 的整页空态**同一份实现**（图标 + 说明 + 初始化按钮 +
              // .gitignore 提醒）：这一步唯一的动作就是初始化，不该缩成一行灰字
              onInit ? (
                <NotARepoState
                  className="py-4"
                  busy={busy}
                  initializing={busy}
                  onInit={() => void onInit()}
                />
              ) : (
                <PickerEmpty>{tr('当前工作区还不是 Git 仓库')}</PickerEmpty>
              )
            ) : creating && pickingBase ? (
              /*
                挑起点：复用主列表（本地 / 远端分组 + 搜索），选中即回到表单。
                这里不摆改名 / 删除按钮 —— 这一步只是选一个 ref。
              */
              <TooltipProvider delayDuration={400}>
                <PickerItem
                  value="base:head"
                  icon={<GitBranch />}
                  reserveCheck={false}
                  active={newFrom === ''}
                  onSelect={() => {
                    setNewFrom('')
                    setPickingBase(false)
                  }}
                >
                  {tr('当前 HEAD')}
                </PickerItem>
                {local.length ? <PickerLabel>{tr('本地分支')}</PickerLabel> : null}
                {local.map((name) => (
                  <PickerItem
                    key={`base-local:${name}`}
                    value={`base-local:${name}`}
                    icon={<GitBranch />}
                    reserveCheck={false}
                    active={newFrom === name}
                    onSelect={() => {
                      setNewFrom(name)
                      setPickingBase(false)
                    }}
                  >
                    <BranchName name={name} />
                  </PickerItem>
                ))}
                {remote.length ? <PickerLabel>{tr('远端分支')}</PickerLabel> : null}
                {remote.map((name) => (
                  <PickerItem
                    key={`base-remote:${name}`}
                    value={`base-remote:${name}`}
                    icon={<GitBranch />}
                    reserveCheck={false}
                    active={newFrom === name}
                    onSelect={() => {
                      setNewFrom(name)
                      setPickingBase(false)
                    }}
                  >
                    <BranchName name={name} />
                  </PickerItem>
                ))}
              </TooltipProvider>
            ) : loading && branches === null ? (
              // 只在「手上还没有任何清单」时摆骨架屏：重开面板刷新时旧清单原样留着、
              // 数据到了原地替换 —— 否则每次打开都先切骨架屏再长回列表，高度来回跳。
              <BranchListSkeleton />
            ) : local.length === 0 && remote.length === 0 ? (
              // 搜索没命中按一行显示（用户正敲字，面板跟着缩是预期）；
              // 其余空态按骨架屏的高度占位 —— 加载完没分支时面板高度不变。
              !keyword || noCommits ? (
                <div
                  className="flex items-center justify-center"
                  style={{ minHeight: BRANCH_PLACEHOLDER_HEIGHT }}
                >
                  <PickerEmpty className="py-0">
                    {noCommits
                      ? tr('还没有任何分支（先提交一次）')
                      : tr('没有可切换的分支')}
                  </PickerEmpty>
                </div>
              ) : (
                <PickerEmpty>{tr('没有匹配的分支')}</PickerEmpty>
              )
            ) : (
              /* 一颗 provider 管整张列表：提示只在名字真被截断时才挂（见 `BranchName`），
                 `delayDuration` 给 400ms —— 鼠标扫过一行不该立刻冒气泡 */
              <TooltipProvider delayDuration={400}>
                {local.length ? <PickerLabel>{tr('本地分支')}</PickerLabel> : null}
                {local.map((name) =>
                  /* 行内改名（与侧栏会话行同一套：Enter 提交、Esc / 失焦取消）。
                     这一行**不走 PickerItem**：cmdk 的行会把输入框里的键盘抢去做「选中 = 检出」。 */
                  renameTarget === name ? (
                    <div key={`local:${name}`} className="flex items-center gap-2.5 px-2.5 py-1">
                      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                        <GitBranch />
                      </span>
                      <Input
                        autoFocus
                        value={renameName}
                        onChange={(e) => setRenameName(e.target.value)}
                        onKeyDown={(e) => {
                          // 别让 cmdk 根的键盘处理抢走回车 / 方向键
                          e.stopPropagation()
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void submitRename()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelRename()
                          }
                        }}
                        onBlur={cancelRename}
                        // 描边主题色（与会话行内改名一致）：默认 `--input` 灰看不出正在改哪行
                        className="h-6 min-w-0 flex-1 rounded border-primary px-1.5 py-0 text-sm focus-visible:border-primary"
                      />
                    </div>
                  ) : (
                    <PickerItem
                      key={`local:${name}`}
                      value={`local:${name}`}
                      icon={<GitBranch />}
                      reserveCheck={false}
                      active={name === branch}
                      /*
                        行尾动作：复制 + 铅笔（改名）+ 垃圾桶（删除）。复制与改名都在，
                        删不了「当前所在的分支」（git 会拒），但**改名可以改当前分支**
                        （HEAD 跟着改名，不切走）。
                      */
                      action={
                        <span className="flex items-center gap-0.5">
                          {copyAction(name)}
                          {onRename ? renameAction(name) : null}
                          {onDelete && name !== branch
                            ? deleteAction(
                                { kind: 'local', name },
                                tr('删除分支 {name}', { name })
                              )
                            : null}
                        </span>
                      }
                      onSelect={() => void select(name)}
                    >
                      <BranchName name={name} />
                    </PickerItem>
                  )
                )}
                {remote.length ? <PickerLabel>{tr('远端分支')}</PickerLabel> : null}
                {remote.map((name) => (
                  <PickerItem
                    key={`remote:${name}`}
                    value={`remote:${name}`}
                    icon={<GitBranch />}
                    reserveCheck={false}
                    active={name === branch}
                    action={
                      <span className="flex items-center gap-0.5">
                        {copyAction(name)}
                        {onDelete
                          ? deleteAction(
                              { kind: 'remote', ...splitRemoteBranch(name) },
                              tr('删除远端分支 {name}', { name })
                            )
                          : null}
                      </span>
                    }
                    onSelect={() => void select(name)}
                  >
                    <BranchName name={name} />
                  </PickerItem>
                ))}
              </TooltipProvider>
            )}
          </PickerList>
        </PickerPanel>
      </Popover>

      {/*
        删除分支确认：本地 / 远端分开写后果 —— 含糊地说「确定吗」用户根本不知道会失去什么。
        本地默认走 `git branch -d`（git 自己判有没有合并），想连未合并的一起删得勾
        「强制删除」（= `-D`）；远端分支删除就是 `git push <remote> --delete <branch>`，不可撤销。
      */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteTarget(null)
            setDeleteForce(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === 'remote' ? tr('删除远端分支？') : tr('删除本地分支？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === 'remote' ? (
                <>
                  {tr('远端的 {branch} 会被删掉（=', { branch: deleteLabel })}{' '}
                  <code className="font-mono">{`git push ${deleteTarget.remote} --delete ${deleteTarget.branch}`}</code>
                  {tr(
                    '）。这一步会推到远端，别人再 fetch 就会看到它消失，无法撤销。本地如果还有同名分支，不受影响。'
                  )}
                </>
              ) : (
                <>
                  {tr('本地分支')} <code className="font-mono">{deleteLabel}</code>{' '}
                  {tr(
                    '的引用会被删除。已经并进其它分支的提交不会丢；删完之后也只有 reflog（默认保留约 90 天）里还能找回它。'
                  )}
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
                    {tr('强制删除：这个分支还没有合并也删（未合并的提交删完只剩 reflog 能找回）')}
                  </span>
                </label>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('取消')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              {tr('删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
