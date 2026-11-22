/**
 * 分支选择器 —— **受控版**：只吃 props，完全不知道 `AgentApp` / `GitPanel` 的存在。
 *
 * 原先是 `ComposerStatusBar` 里的私有 `BranchPill`：切分支、新建、删除、确认框全写在
 * 那一颗里。`GitPanel` 头部那颗分支下拉是另一套（Radix `DropdownMenu`，不能搜、不分组、
 * 也没有面板的高度动画），两边越走越不像。现在把整块面板抽到这里，两处共用：
 *
 * - `ComposerStatusBar` 传 `variant="pill"`（输入卡片下方横条那颗）；
 * - `GitPanel` 传 `variant="header"`（面板头部那颗幽灵按钮）。
 *
 * 数据仍由调用方管：分支清单、当前分支、loading / busy、以及四个动作（检出 / 新建 /
 * 初始化仓库 / 删除）都从 props 进 —— 调用方各自有自己的刷新与错误 toast（`GitPanel`
 * 走 `run()`，composer 自己 toast），本文件只负责面板长相与交互。
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
import { ChevronDown, GitBranch, GitBranchPlus, Trash2 } from 'lucide-react'
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

export interface BranchPickerProps {
  /** 当前分支名（`null` = 分离头指针 / 非仓库）；用于「当前项打勾」与「不能删自己」 */
  branch: string | null
  isRepo: boolean
  /** 分支清单；`null` = 还没读到 */
  branches: GitBranchesResult | null
  /** 正在读分支清单（面板里显示「读取分支…」） */
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
  /** 给了才在底部出现「新建分支…」的内联表单（从当前 HEAD 新建） */
  onCreate?: (name: string) => void | Promise<void>
  /**
   * 底部「新建分支…」交给调用方自己开弹窗（`GitPanel` 的新建分支要选起点，比内联表单
   * 复杂）。与 `onCreate` 二选一：给了 `onCreate` 就走内联表单。
   */
  onRequestCreate?: () => void
  /** 不是仓库时面板里的「初始化仓库」 */
  onInit?: () => void | Promise<void>
  /** 确认框点过「删除」之后调用；不传 = 不画垃圾桶 */
  onDelete?: (target: BranchDeleteTarget, force: boolean) => void | Promise<void>
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
  onRequestCreate,
  onInit,
  onDelete,
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
  const [deleteTarget, setDeleteTarget] = useState<BranchDeleteTarget | null>(null)
  const [deleteForce, setDeleteForce] = useState(false)

  const text = label ?? branch ?? emptyLabel ?? tr('Git')

  const close = (): void => setOpen(false)
  const reset = (): void => {
    setCreating(false)
    setNewName('')
    setQuery('')
  }

  const keyword = query.trim().toLowerCase()
  const match = (name: string): boolean => !keyword || name.toLowerCase().includes(keyword)
  const local = (branches?.branches ?? []).filter(match)
  const remote = (branches?.remotes ?? []).filter(match)

  /** 确认框里显示的分支全名（远端带上远端名，免得看不出推的是哪条） */
  const deleteLabel =
    deleteTarget?.kind === 'remote'
      ? `${deleteTarget.remote}/${deleteTarget.branch}`
      : (deleteTarget?.name ?? '')

  /**
   * 行尾那颗垃圾桶：与会话行同一套「hover 整行才浮现」的底板（`RowAction`）。
   * 只改 `opacity`，不挪布局 —— 槽位一直占着（`PickerItem` 的 `action`）。
   * 触摸设备没有 hover 态，常显。
   */
  const deleteClass = cn(
    ROW_ACTION_CLASS,
    'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 hover:text-destructive'
  )

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
    close()
    reset()
    await onCreate(name)
  }

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget
    if (!target || !onDelete) return
    const force = deleteForce
    setDeleteTarget(null)
    setDeleteForce(false)
    await onDelete(target, force)
  }

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
            ) : !isRepo ? undefined : onCreate ? (
              <PickerFooter>
                <PickerAction icon={<GitBranchPlus />} onClick={() => setCreating(true)}>
                  {tr('新建分支…')}
                </PickerAction>
              </PickerFooter>
            ) : onRequestCreate ? (
              <PickerFooter>
                <PickerAction
                  icon={<GitBranchPlus />}
                  onClick={() => {
                    // 先关面板：调用方会开自己的弹窗（要选起点），留着只会两层叠在一起
                    close()
                    reset()
                    onRequestCreate()
                  }}
                >
                  {tr('新建分支…')}
                </PickerAction>
              </PickerFooter>
            ) : undefined
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
            ) : loading ? (
              <PickerEmpty>{tr('读取分支…')}</PickerEmpty>
            ) : local.length === 0 && remote.length === 0 ? (
              <PickerEmpty>
                {keyword ? tr('没有匹配的分支') : tr('没有可切换的分支')}
              </PickerEmpty>
            ) : (
              /* 一颗 provider 管整张列表：提示只在名字真被截断时才挂（见 `BranchName`），
                 `delayDuration` 给 400ms —— 鼠标扫过一行不该立刻冒气泡 */
              <TooltipProvider delayDuration={400}>
                {local.length ? <PickerLabel>{tr('本地分支')}</PickerLabel> : null}
                {local.map((name) => (
                  <PickerItem
                    key={`local:${name}`}
                    value={`local:${name}`}
                    icon={<GitBranch />}
                    active={name === branch}
                    // 当前所在的分支不能删（git 会拒）：不摆垃圾桶，免得点了才被拒
                    action={
                      onDelete && name !== branch
                        ? deleteAction({ kind: 'local', name }, tr('删除分支 {name}', { name }))
                        : undefined
                    }
                    onSelect={() => void select(name)}
                  >
                    <BranchName name={name} />
                  </PickerItem>
                ))}
                {remote.length ? <PickerLabel>{tr('远端分支')}</PickerLabel> : null}
                {remote.map((name) => (
                  <PickerItem
                    key={`remote:${name}`}
                    value={`remote:${name}`}
                    icon={<GitBranch />}
                    active={name === branch}
                    action={
                      onDelete
                        ? deleteAction(
                            { kind: 'remote', ...splitRemoteBranch(name) },
                            tr('删除远端分支 {name}', { name })
                          )
                        : undefined
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
