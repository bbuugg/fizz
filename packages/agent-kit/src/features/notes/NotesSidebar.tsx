'use client'

/**
 * 「笔记」功能区的侧栏：登记若干目录，每个目录一棵 **懒加载** 的 Markdown 树。
 *
 * ## 为什么笔记根要「登记」而不是随手传路径
 *
 * 所有笔记文件接口都先 `resolveInside(root.path, rel)`，**没登记过的目录一律 403**
 * （见 `apps/server/src/server/notes.ts`）。少了这层登记，那组接口就等于「读写服务端任意
 * 路径」的通用口子 —— 而它挂在 SSE 那套鉴权之后，一旦通了就是全盘可写。
 *
 * ## 树的状态放在模块级缓存里
 *
 * 展开态与每层条目都在 `notes-tree.ts`，**不是**这里的 `useState` —— 切换活动栏会让侧栏
 * 整条卸载重挂，放组件里等于「去别处点一下再回来，树自己收起来了」。
 *
 * ## 目录只用来分组
 *
 * 这一版**不做**新建 / 重命名 / 删除目录（只展开 / 收起）：目录一改名，它**下面所有
 * 笔记的相对路径都会变**，而路径是标签的保存目标（见 `tool-tabs.ts` 的
 * `retargetNoteTab`）—— 要正确处理得连带重算整棵子树的所有标签，收益远不如风险。
 * 文件级的增删改是齐的。
 *
 * ## 版式与 AI Agent 侧栏同构
 *
 * 一个 `SectionShell`，自上而下：**顶部整行动作**（`SidebarActions` → 「添加笔记目录」）
 * → **一块内容组**（`SidebarGroup`，`size="fill"` 吃剩余高度、组内自己滚，标题右侧挂
 * 「收起全部目录」）。三者（AI Agent / 主机 / 笔记）共用 `shared/components/SidebarGroups`
 * 那一份，改版式改那边，别在这里写回来。
 *
 * 早先的形态是「`SectionHeader` + 两颗图标挤在标题行右侧」：标题行只有 260px 宽，
 * 「添加笔记目录」和「收起全部目录」把「笔记」两个字夹在中间，两颗图标还长得一样大、
 * 干的事却完全不同（一个写登记表、一个只动展开态）。拆开之后动作在顶部成行、可读，
 * 组的操作留在组标题旁，语义各归各位。
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import {
  ChevronRight,
  ChevronsDownUp,
  CirclePlus,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import type { NotesEntry, NotesRoot } from '@fizz/contracts/types'
import { openNoteTab, noteTabKeyOf, retargetNoteTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { closeTab } from '@fizz/agent-kit/shared/lib/panel-store'
import { SectionContent, SectionShell } from '@fizz/agent-kit/shared/components/StackedSections'
import { SidebarScaffold } from '@fizz/agent-kit/shared/components/SidebarScaffold'
import {
  SidebarAction,
  SidebarActions,
  SidebarGroup
} from '@fizz/agent-kit/shared/components/SidebarGroups'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { ROW_ACTION_CLASS, RowActionButton } from '@fizz/agent-kit/shared/components/RowAction'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Input } from '@fizz/ui/input'
import { useDirectoryPicker } from '@fizz/agent-kit/shared/hooks/use-directory-picker'
import { errorMessage } from '@fizz/agent-kit/shared/lib/stores/shared'
import { treeIndent } from '@fizz/agent-kit/shared/lib/tree-indent'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import {
  collapseAllNotesDirs,
  expandNotesDir,
  forgetNotesRoot,
  pruneNotesRoots,
  reloadNotesDir,
  toggleNotesDir,
  treeKey,
  useNotesTree
} from '@fizz/agent-kit/features/notes/notes-tree'

/** 行尾小按钮：平时隐形，hover 所在行才浮现；触摸设备没有 hover，常显（与主机行同一套） */
const ROW_ACTION = cn(
  ROW_ACTION_CLASS,
  'opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100'
)

/**
 * 树行的展开 / 收起箭头：跟着**名字**走（排在名字右边），平时隐身，hover 整行才浮现。
 *
 * 与主机侧栏的分组行、AI Agent 侧栏的项目行是同一套（那边早就是这么做的）：箭头原先
 * 排在行**首**，一棵树展开后每行最左边都是一排同样的 `>`，和文件夹图标抢同一个位置，
 * 还让「这一行是不是缩进错了」变得难判断 —— 用户原话「笔记的目录的展开和折叠图标也要
 * 放名字右侧 hover 后出现」。
 *
 * `hover:bg-foreground/10` 是行尾动作按钮的共用底板（`RowAction`）：它虽然只是提示
 * 「这里能开合」（整行也能点），但侧栏里裸图标看着不像能点。
 *
 * ⚠️ 触摸设备没有 hover 态，用 `max-md:opacity-100` 常显 —— 那时它是唯一的手势入口。
 */
function TreeChevron({
  expanded,
  label,
  onToggle
}: {
  expanded: boolean
  label: string
  onToggle: () => void
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className={cn(
        // 底板直接复用行尾动作按钮那份（`RowAction`）：圆角、`p-0.5`、hover 底色、
        // 触摸端的放大可点面积都在里面，别在这里再写一遍字面量
        ROW_ACTION_CLASS,
        'shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100'
      )}
    >
      <ChevronRight
        className={cn('size-3.5 transition-transform duration-200', expanded && 'rotate-90')}
      />
    </button>
  )
}

/**
 * 行尾动作的浮层：绝对定位 + 从底色渐隐，hover 整行才接鼠标事件。
 *
 * ⚠️ `rounded-r-md` 不能省：这层是不透明的渐隐底色（`from-sidebar`），方角压在行上
 * 会把行的 `rounded-md` **右圆角盖掉** —— 表现就是「hover 一行时，高亮的右边是直角」。
 * 半径与行的 `rounded-md` 一致，两段圆弧正好重合。同一个坑在 `features/plugins/
 * PluginBlocks` 里已经踩过并写了注释，那边也是 `rounded-r-md` 兜的。
 */
function RowActions({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      className={cn(
        'pointer-events-none absolute right-0 top-0 flex h-full items-center gap-0.5 rounded-r-md pl-4 pr-1.5',
        'bg-gradient-to-l from-sidebar from-70% to-transparent',
        'opacity-0 transition-opacity',
        'group-hover:pointer-events-auto group-hover:opacity-100 max-md:pointer-events-auto max-md:opacity-100'
      )}
    >
      {children}
    </div>
  )
}

/** 摊平之后的一行（树的渲染走「先摊平成数组再 map」，与主机树同一套） */
type Row =
  | { kind: 'root'; root: NotesRoot; depth: number }
  | { kind: 'dir'; root: NotesRoot; entry: NotesEntry; depth: number }
  | { kind: 'file'; root: NotesRoot; entry: NotesEntry; depth: number }
  /** 占位行：加载中 / 这一层列不出来 / 空目录 */
  | {
      kind: 'status'
      root: NotesRoot
      depth: number
      loading: boolean
      /** 出错的层（重试用）；加载中与空目录时是空串 */
      dir: string
      message?: string
    }

/** 相对路径的父目录（`a/b.md` → `a`；顶层文件 → `''`） */
function parentDir(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

export function NotesSidebar({
  app,
  width,
  mobileOpen,
  onMobileOpenChange
}: {
  app: AgentApp
  /** 侧栏宽度（px）：由 AppShell 持有并持久化 */
  width: number
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
}): ReactElement {
  const tree = useNotesTree()
  const roots = app.notesRoots

  /** 正在跑的异步动作（`新建 / 重命名 / 删除` 的 key），期间禁掉对应按钮防连点 */
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * 选目录：桌面端弹系统框、web 用内置的服务端目录浏览器（见 `useDirectoryPicker`）。
   *
   * 副标题只在 web 那条路上会显示 —— 默认文案说的是「登记为工作区」，用在这里是错的。
   */
  const { pick: pickDirectory, node: directoryPicker } = useDirectoryPicker(
    app,
    '这里列的是服务端上的目录（Agent 就跑在那台机器上）。选中的目录会登记为笔记目录。'
  )
  /** 待移除登记的根（非 null 即弹确认） */
  const [removing, setRemoving] = useState<NotesRoot | null>(null)
  /** 待重命名的笔记 */
  const [renaming, setRenaming] = useState<{ root: NotesRoot; entry: NotesEntry } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** 待删除的笔记 */
  const [deleting, setDeleting] = useState<{ root: NotesRoot; entry: NotesEntry } | null>(null)

  // 根清单是快照域，别的端摘掉一个根时会推过来 —— 顺手把它的树缓存丢掉，
  // 免得「重新登记同一个 id」时读到上一世的条目（见 notes-tree 的 pruneNotesRoots）
  const rootIds = useMemo(() => roots.map((root) => root.id), [roots])
  useEffect(() => {
    pruneNotesRoots(rootIds)
  }, [rootIds])

  const rows = useMemo((): Row[] => {
    const out: Row[] = []

    const walk = (root: NotesRoot, dir: string, depth: number): void => {
      const state = tree.dirs[treeKey(root.id, dir)]
      if (!state) return
      if (state.error) {
        out.push({ kind: 'status', root, depth, dir, loading: false, message: state.error })
        return
      }
      if (!state.entries) {
        if (state.loading) out.push({ kind: 'status', root, depth, dir, loading: true })
        return
      }
      if (state.entries.length === 0) {
        out.push({
          kind: 'status',
          root,
          depth,
          dir,
          loading: false,
          message: '（这个目录里没有笔记）'
        })
        return
      }
      for (const entry of state.entries) {
        if (entry.type === 'dir') {
          out.push({ kind: 'dir', root, entry, depth })
          if (tree.expanded[treeKey(root.id, entry.path)]) walk(root, entry.path, depth + 1)
        } else {
          out.push({ kind: 'file', root, entry, depth })
        }
      }
    }

    for (const root of roots) {
      out.push({ kind: 'root', root, depth: 0 })
      if (tree.expanded[treeKey(root.id, '')]) walk(root, '', 1)
    }
    return out
  }, [roots, tree])

  const openNote = useCallback(
    (root: NotesRoot, entry: NotesEntry): void => {
      openNoteTab({ rootId: root.id, path: entry.path, label: entry.name })
    },
    []
  )

  /** 新建一篇空笔记：拉新目录 → 重拉那一层 → 直接开标签（省一次点击） */
  const createNote = useCallback(
    async (root: NotesRoot, dir: string): Promise<void> => {
      const key = `create:${root.id}:${dir}`
      setBusy(key)
      try {
        const created = await app.createNoteFile(root.id, dir)
        expandNotesDir(root.id, dir)
        reloadNotesDir(root.id, dir)
        openNoteTab({
          rootId: root.id,
          path: created.path,
          label: created.path.split('/').pop()
        })
      } catch (err) {
        toast.error(`新建笔记失败：${errorMessage(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [app]
  )

  const submitRename = useCallback(async (): Promise<void> => {
    if (!renaming) return
    const name = renameDraft.trim()
    if (!name) return
    const { root, entry } = renaming
    setBusy(`rename:${root.id}:${entry.path}`)
    try {
      const result = await app.renameNoteFile(root.id, entry.path, name)
      // 已开的标签改到新路径（正文不动、没保存的编辑留着），再重拉父目录
      retargetNoteTab(root.id, entry.path, { path: result.path })
      reloadNotesDir(root.id, parentDir(entry.path))
      setRenaming(null)
    } catch (err) {
      toast.error(`重命名失败：${errorMessage(err)}`)
    } finally {
      setBusy(null)
    }
  }, [app, renaming, renameDraft])

  const submitDelete = useCallback(async (): Promise<void> => {
    if (!deleting) return
    const { root, entry } = deleting
    setBusy(`delete:${root.id}:${entry.path}`)
    try {
      await app.deleteNoteFile(root.id, entry.path)
      // 文件没了，开着的标签也没有意义：直接关（**不过守卫**）—— 删除本身已经确认过一次，
      // 再弹一个「有未保存的修改」是连着两个弹窗；而且「保存」会把刚删的文件重新长出来。
      const key = noteTabKeyOf(root.id, entry.path)
      if (key) closeTab(key)
      reloadNotesDir(root.id, parentDir(entry.path))
      setDeleting(null)
    } catch (err) {
      toast.error(`删除失败：${errorMessage(err)}`)
    } finally {
      setBusy(null)
    }
  }, [app, deleting])

  const submitRemoveRoot = useCallback(async (): Promise<void> => {
    if (!removing) return
    const root = removing
    setBusy(`remove:${root.id}`)
    try {
      await app.removeNotesRoot(root.id)
      forgetNotesRoot(root.id)
      setRemoving(null)
    } catch (err) {
      toast.error(`移除失败：${errorMessage(err)}`)
    } finally {
      setBusy(null)
    }
  }, [app, removing])

  /**
   * 添加一个笔记根：**先问用户要目录，再登记**。
   *
   * 选目录这一步走 `useDirectoryPicker` —— 桌面端弹系统框、web 才用内置的服务端目录浏览器
   * （那个弹窗的副标题由这里给，见 hook 的注释）。
   */
  const addRoot = useCallback(async (): Promise<void> => {
    const path = await pickDirectory()
    if (!path) return
    setBusy('add-root')
    try {
      const root = await app.addNotesRoot({ path })
      if (!root) {
        toast.error(`添加目录失败：${app.error ?? '未知错误'}`)
        return
      }
      toast.success(`已添加「${root.name}」`)
    } finally {
      setBusy(null)
    }
  }, [app, pickDirectory])

  return (
    <>
      <SidebarScaffold
        width={width}
        mobileOpen={mobileOpen}
        onMobileOpenChange={onMobileOpenChange}
      >
        <SectionShell grow={1} minHeight={200}>
          {/*
            版式见文件头「版式与 AI Agent 侧栏同构」。这里只留一条约束：

            ⚠️ 「新建笔记」**不在动作区**：它必须知道落在哪个目录（根 / 子目录），
            没有「全局新建」这回事 —— 入口留在根行与目录行的行尾（`FilePlus2`）。
          */}
          <SidebarActions>
            {/* 与 AI Agent 的「新对话」同一颗 `CirclePlus`：同是「从无到有」的动作 */}
            <SidebarAction
              icon={CirclePlus}
              label="添加笔记目录"
              title="选一个放 Markdown 的文件夹，登记为笔记目录"
              disabled={busy === 'add-root'}
              // 选目录 / 登记是异步的（桌面端还要弹系统框）：跑着时行尾转圈，别让用户以为没反应
              trailing={
                busy === 'add-root' ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : undefined
              }
              onClick={() => void addRoot()}
            />
          </SidebarActions>

          <SectionContent>
            {/*
              **外层兜底滚动容器**（与另外两条侧栏同构）：树在组内自己滚，这层只在
              窗口极矮、组的 `minHeight` 放不下时才兜底滚一次。

              `px-2` 在**这一层**、不在组上（与主机侧栏一模一样）：组标签自带 `px-2`
              （见 `SectionHeader`），所以标签落在 8 + 8 = 16px；行落在 8 + 6
              （`px-1.5` / `treeIndent` 的 6px 基准）= 14px —— 与主机行的 14px 同一列。
              （用户反馈的「笔记文件夹和主机没有左对齐」主因是行首那格空出来的箭头位
              （14px 图标 + 6px 间距 = 20px），这一层的内边距差 2px 只是余数。）
            */}
            <div className="flex min-h-0 flex-1 flex-col overflow-auto no-scrollbar px-2">
              <SidebarGroup
                title="笔记"
                count={roots.length}
                alignIndent
                // 唯一一块内容组：吃满剩余高度、超出在组内滚
                size="fill"
                grow={1}
                // 只留底部内边距：横向的由外层容器统一给（见上面那段注释）
                className="pb-2"
                // 「收起全部目录」跟着**这一组**的标题走（它收的就是下面这棵树）。
                // 用小号的 `RowActionButton` 而不是 28px 的 ghost Button：标题行只有 32px 高、
                // 标签是 12px 灰字，大按钮贴上去比标题还抢眼（与主机侧栏那颗「新建分组」同款）。
                extra={
                  <IconTip label="收起全部目录">
                    <RowActionButton
                      aria-label="收起全部目录"
                      className="shrink-0"
                      disabled={roots.length === 0}
                      onClick={() => collapseAllNotesDirs()}
                    >
                      <ChevronsDownUp className="size-3.5" />
                    </RowActionButton>
                  </IconTip>
                }
                empty={
                  <span className="block px-1.5 py-5 text-center leading-5">
                    还没有笔记。
                  </span>
                }
              >
                {rows.map((row) => {
                  if (row.kind === 'root') {
                    const expanded = Boolean(tree.expanded[treeKey(row.root.id, '')])
                    return (
                      <div
                        key={`root:${row.root.id}`}
                        role="button"
                        tabIndex={0}
                        title={row.root.path}
                        onClick={() => toggleNotesDir(row.root.id, '')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            toggleNotesDir(row.root.id, '')
                          }
                        }}
                        className="group relative flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm text-foreground transition-colors hover:bg-primary-soft"
                      >
                        {/* 行首**不再**留图标槽：箭头搬到名字右侧后那一格就空了，留着等于
                            整棵树比主机侧栏多缩进 20px（用户反馈「笔记文件夹和主机不左对齐」）。
                            行的 `px-1.5`(6px) 就是基准，与主机行同一列。 */}
                        {expanded ? (
                          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <Folder className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        {/*
                          名字 + 箭头包在同一个 flex 里（与 AI Agent 侧栏的项目行同款）：
                          - 名字**不给** `flex-1`，它按自身宽度占位，箭头才会跟着名字长度走；
                          - 行尾让位（`group-hover:pe-16`）作用在箭头**之后**，否则箭头会被
                            浮在行尾的那两颗按钮压住；
                          - 名字长到顶不住时由 `min-w-0 truncate` 截断，不溢出。
                        */}
                        <div className="flex min-w-0 flex-1 items-center gap-1.5 transition-[padding] group-hover:pe-16 max-md:pe-16">
                          <div data-name-text className="min-w-0 truncate">
                            {row.root.name}
                          </div>
                          <TreeChevron
                            expanded={expanded}
                            label={expanded ? '收起目录' : '展开目录'}
                            onToggle={() => toggleNotesDir(row.root.id, '')}
                          />
                        </div>
                        <RowActions>
                          <IconTip label={`在「${row.root.name}」里新建笔记`}>
                            <button
                              type="button"
                              aria-label="新建笔记"
                              disabled={busy !== null}
                              onClick={(event) => {
                                event.stopPropagation()
                                void createNote(row.root, '')
                              }}
                              className={ROW_ACTION}
                            >
                              <FilePlus2 className="size-3.5" />
                            </button>
                          </IconTip>
                          <IconTip label="移除登记（不删磁盘上的文件）">
                            <button
                              type="button"
                              aria-label="移除登记"
                              disabled={busy !== null}
                              onClick={(event) => {
                                event.stopPropagation()
                                setRemoving(row.root)
                              }}
                              className={cn(ROW_ACTION, 'hover:text-destructive')}
                            >
                              <X className="size-3.5" />
                            </button>
                          </IconTip>
                        </RowActions>
                      </div>
                    )
                  }

                  if (row.kind === 'status') {
                    // 出错的行才给「重试」（加载中不用、空目录更不用）；重试的是**这一层**
                    const canRetry = !row.loading && row.message !== '（这个目录里没有笔记）'
                    return (
                      <div
                        key={`status:${row.root.id}:${row.dir}:${row.loading ? 'loading' : 'done'}`}
                        className="flex items-center gap-1.5 py-1 pr-1.5 text-xs text-muted-foreground"
                        style={{ paddingLeft: treeIndent(row.depth) }}
                      >
                        {row.loading && <Loader2 className="size-3 shrink-0 animate-spin" />}
                        <span className="min-w-0 flex-1 truncate">
                          {row.loading ? '读取中…' : row.message}
                        </span>
                        {canRetry && (
                          <button
                            type="button"
                            aria-label="重试"
                            title="重试"
                            onClick={() => reloadNotesDir(row.root.id, row.dir)}
                            className={ROW_ACTION_CLASS}
                          >
                            <RotateCw className="size-3" />
                          </button>
                        )}
                      </div>
                    )
                  }

                  if (row.kind === 'dir') {
                    const expanded = Boolean(tree.expanded[treeKey(row.root.id, row.entry.path)])
                    return (
                      <div
                        key={`dir:${row.root.id}:${row.entry.path}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleNotesDir(row.root.id, row.entry.path)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            toggleNotesDir(row.root.id, row.entry.path)
                          }
                        }}
                        className="group relative flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-sm text-foreground transition-colors hover:bg-primary-soft"
                        style={{ paddingLeft: treeIndent(row.depth) }}
                      >
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                        <div className="flex min-w-0 flex-1 items-center gap-1.5 transition-[padding] group-hover:pe-8 max-md:pe-8">
                          <div data-name-text className="min-w-0 truncate">
                            {row.entry.name}
                          </div>
                          <TreeChevron
                            expanded={expanded}
                            label={expanded ? '收起目录' : '展开目录'}
                            onToggle={() => toggleNotesDir(row.root.id, row.entry.path)}
                          />
                        </div>
                        <RowActions>
                          <IconTip label={`在「${row.entry.name}」里新建笔记`}>
                            <button
                              type="button"
                              aria-label="新建笔记"
                              disabled={busy !== null}
                              onClick={(event) => {
                                event.stopPropagation()
                                void createNote(row.root, row.entry.path)
                              }}
                              className={ROW_ACTION}
                            >
                              <FilePlus2 className="size-3.5" />
                            </button>
                          </IconTip>
                        </RowActions>
                      </div>
                    )
                  }

                  // 文件
                  return (
                    <div
                      key={`file:${row.root.id}:${row.entry.path}`}
                      role="button"
                      tabIndex={0}
                      title={row.entry.path}
                      onClick={() => openNote(row.root, row.entry)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          openNote(row.root, row.entry)
                        }
                      }}
                      className="group relative flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-sm text-foreground transition-colors hover:bg-primary-soft"
                      style={{ paddingLeft: treeIndent(row.depth) }}
                    >
                      {/* 与目录行同列：两边都不再垫「箭头槽」，文件图标与文件夹图标对齐 */}
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <div
                        data-name-text
                        className="min-w-0 flex-1 truncate transition-[padding] group-hover:pe-14 max-md:pe-14"
                      >
                        {row.entry.name}
                      </div>
                      <RowActions>
                        <IconTip label={`重命名 ${row.entry.name}`}>
                          <button
                            type="button"
                            aria-label="重命名"
                            disabled={busy !== null}
                            onClick={(event) => {
                              event.stopPropagation()
                              setRenameDraft(row.entry.name)
                              setRenaming({ root: row.root, entry: row.entry })
                            }}
                            className={ROW_ACTION}
                          >
                            <Pencil className="size-3.5" />
                          </button>
                        </IconTip>
                        <IconTip label={`删除 ${row.entry.name}`}>
                          <button
                            type="button"
                            aria-label="删除"
                            disabled={busy !== null}
                            onClick={(event) => {
                              event.stopPropagation()
                              setDeleting({ root: row.root, entry: row.entry })
                            }}
                            className={cn(ROW_ACTION, 'hover:text-destructive')}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </IconTip>
                      </RowActions>
                    </div>
                  )
                })}
              </SidebarGroup>
            </div>
          </SectionContent>
        </SectionShell>
      </SidebarScaffold>

      {/* 选目录：桌面端是系统框（这里为 null），web 是内置的服务端目录浏览器 */}
      {directoryPicker}

      {/* 重命名：只换文件名（不换目录）—— 换目录等于换路径，标签的保存目标也得跟着动 */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重命名笔记</DialogTitle>
            <DialogDescription>
              只换文件名，目录不变。带不带 <span className="font-mono">.md</span> 都行。
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitRename()
            }}
            className="font-mono text-sm"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button
              disabled={!renameDraft.trim() || busy !== null}
              onClick={() => void submitRename()}
            >
              重命名
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleting !== null}
        title="删除这篇笔记？"
        description={
          <>
            将删除 <span className="font-mono text-foreground">{deleting?.entry.path}</span>。
            这是真删，不进回收站，也没有撤销。
          </>
        }
        onCancel={() => setDeleting(null)}
        onConfirm={() => void submitDelete()}
      />

      <ConfirmDeleteDialog
        open={removing !== null}
        title="移除这个笔记目录？"
        confirmLabel="移除"
        description={
          <>
            只是把 <span className="font-mono text-foreground">{removing?.path}</span>{' '}
            从登记表里摘掉，
            <span className="text-foreground">磁盘上的文件一个都不会动</span>
            。之后想再用，重新添加即可。
          </>
        }
        onCancel={() => setRemoving(null)}
        onConfirm={() => void submitRemoveRoot()}
      />
    </>
  )
}
