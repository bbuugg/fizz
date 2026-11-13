"use client";

/**
 * 「脚本」管理面板（主区域单例标签 `scripts:list`）：脚本清单的**全局**增删改。
 *
 * ## 为什么从侧栏的一块内容组搬成一整页
 *
 * 它原先挂在主机侧栏里（「主机与终端」下面那块可折叠组），宽度只有 260px ——
 * 每行塞得下名字 + 一颗「运行」，描述、正文、分组层级全看不见，搜索框还要跟清单抢
 * 高度。脚本又是**一段段命令**：不看见正文根本分不清「部署」和「重启服务」。
 *
 * 现在它和定时任务 / 隧道 / 日志一样是主区域的单例标签页（`openScriptsTab()`）：
 * 入口在主机侧栏顶部动作区（「隧道」下面那颗「脚本」），整页宽度足够摆
 * 「名称 + 描述/首行」两行，也能把分组与拖拽重排摊开。
 *
 * ## 它管的是「清单」，不是「某一个脚本」
 *
 * 点一行 = 打开**编辑对话框**（`ScriptEditDialog`）。本页只负责「有哪些脚本、怎么分组
 * 排序、跑哪一个」——正文编辑一律在那个模态框里做，避免同一份内容出现两处编辑态
 * （那是互相覆盖的经典来源）。
 *
 * ## 数据与顺序
 *
 * - 清单走 `useAppContext().app.scripts` / `app.scriptGroups`（与编辑对话框同一份，
 *   不在这里再拉一份）；
 * - 顺序即存储顺序（不按 updatedAt 排），重排走 `app.arrangeScripts` **一次提交**
 *   （顺序 + 归属一起写，不留中间态）；
 * - 脚本分组**只有一层**、不可嵌套（见 contracts 的 `ScriptGroup`），所以这里没有多级树。
 *
 * ## 布局
 *
 * 顶部工具条用 `PanelHeader`（与定时任务 / 日志 / 隧道同一套：标题 + 统计在左、动作在右），
 * 下面「搜索框 + 自己滚的清单」。清单是**卡片网格**（一行多张，见
 * `SCRIPT_CARDS`）—— 不像定时任务那样分左列清单 / 右列详情，因为脚本的「详情」就是
 * 正文，而正文归编辑对话框管。
 *
 * 为什么是卡片而不是一行一条：脚本之间**没有主从关系**，每条就是「一个名字 + 一段
 * 命令」，一列长条在宽屏上会把右边大半宽度空着；卡片能在同样高度里摆下三四个脚本。
 */
import { useMemo, useState } from 'react'
import { useDrag } from 'react-dnd'
import {
  ChevronRight,
  FileCode2,
  Folder,
  FolderInput,
  FolderPlus,
  Pencil,
  Play,
  Plus,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Checkbox } from '@fizz/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@fizz/ui/context-menu'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import {
  PanelHeader,
  PanelHeaderActionLabel
} from '@fizz/agent-kit/shared/components/PanelHeader'
import { ScriptEditDialog } from '@fizz/agent-kit/features/scripts/ScriptEditDialog'
import { openRunScriptDialog } from '@fizz/agent-kit/shared/lib/script-run'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { DropLine, useRowDrop, type DragItem } from '@fizz/agent-kit/shared/lib/group-dnd'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { ROW_ACTION_CLASS } from '@fizz/agent-kit/shared/components/RowAction'
import type { ScriptEntry, ScriptGroup } from '@fizz/contracts/types'

/** react-dnd 拖拽类型：脚本与分组各一种，落点按类型分别处理 */
const DND_SCRIPT = 'script-item'
const DND_GROUP = 'script-group'

/**
 * 卡片网格：一行摆**多张**卡片。
 *
 * 脚本清单是「一堆等价的命令」，一列长条在宽屏上会把大半宽度空着 —— 卡片能一眼扫到
 * 十几个名字。断点跟着**视口**走（不是容器查询）：主区域分屏后窗格变窄时卡片会被挤到
 * 2 列，名字截断、描述夹两行，仍然比一列好扫。
 */
const SCRIPT_CARDS = 'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'

/** 一个列表块：`group` 为空 = 未分组块（恒首位） */
interface Block {
  group?: ScriptGroup
  items: ScriptEntry[]
}

/** 拖拽落点处理函数签名（脚本与分组共用，由面板统一重排后一次写回） */
type DropScript = (
  dragId: string,
  targetId: string | null,
  targetGroupId: string | undefined,
  after: boolean
) => void
type DropGroup = (dragId: string, targetGroupId: string, after: boolean) => void

/**
 * 行里的第二行文字：优先描述，没有描述就取正文第一行非空内容。
 *
 * 脚本大多只有一个名字（描述是可选字段），光看「部署」「重启」分不清跑的是什么；
 * 正文首行通常就是那行有意义的命令（`#!/bin/bash` / `docker compose ...`）。
 */
function previewTextOf(script: ScriptEntry): string {
  const desc = script.description?.trim()
  if (desc) return desc
  const first = script.content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'))
  return first || '（空脚本）'
}

export function ScriptsPanel() {
  const { app } = useAppContext()

  const [search, setSearch] = useState('')
  /** 显式展开的分组（缺省全收起，与接口请求 / 主机清单一致） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  /** 待确认删除的脚本 / 分组 */
  const [pendingDelete, setPendingDelete] = useState<ScriptEntry | null>(null)
  const [pendingGroupDelete, setPendingGroupDelete] = useState<ScriptGroup | null>(null)
  const [deleteGroupScripts, setDeleteGroupScripts] = useState(false)

  /** 新建（id 空）/ 重命名分组 */
  const [groupEdit, setGroupEdit] = useState<{ id?: string; name: string } | null>(null)

  /**
   * 新建 / 编辑脚本的对话框：`script` 为空 = 新建。
   *
   * `groupId` 只对新建有意义（从分组行的「+」进来时预置归属）；编辑时不动归属
   * —— 那条路是拖拽 / 右键「移出分组」，见 `ScriptEditDialog` 的文件头。
   */
  const [edit, setEdit] = useState<{ script: ScriptEntry | null; groupId?: string } | null>(null)

  const scripts = app.scripts
  const groups = app.scriptGroups

  // 分组归类（groupId 指向已不存在的分组时按未分组处理），「未分组」块恒首位
  const blocks = useMemo((): Block[] => {
    const ungrouped: ScriptEntry[] = []
    const byGroup = new Map<string, ScriptEntry[]>()
    const valid = new Set(groups.map((g) => g.id))
    for (const s of scripts) {
      if (s.groupId && valid.has(s.groupId)) {
        const list = byGroup.get(s.groupId) ?? []
        list.push(s)
        byGroup.set(s.groupId, list)
      } else {
        ungrouped.push(s)
      }
    }
    const out: Block[] = [{ group: undefined, items: ungrouped }]
    for (const g of groups) out.push({ group: g, items: byGroup.get(g.id) ?? [] })
    return out
  }, [scripts, groups])

  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  const hitScript = (s: ScriptEntry): boolean =>
    !searching ||
    s.name.toLowerCase().includes(q) ||
    (s.description ?? '').toLowerCase().includes(q) ||
    s.content.toLowerCase().includes(q)

  /** 渲染用的块结构：搜索时按命中过滤（组名命中 = 整组保留） */
  const viewBlocks: Block[] = !searching
    ? blocks
    : blocks
        .map((b) => {
          const groupHit = b.group ? b.group.name.toLowerCase().includes(q) : false
          return { group: b.group, items: groupHit ? b.items : b.items.filter(hitScript) }
        })
        .filter((b) => b.items.length > 0 || (b.group && b.group.name.toLowerCase().includes(q)))

  /** 在完整块结构里按脚本 id 定位 */
  const locate = (list: Block[], id: string): { b: number; i: number } | null => {
    for (let b = 0; b < list.length; b++) {
      const i = list[b].items.findIndex((s) => s.id === id)
      if (i >= 0) return { b, i }
    }
    return null
  }

  /** 把调整后的块结构整体写回（顺序 + 归属一次提交，避免中间态） */
  const commit = (next: Block[]): void => {
    void app.arrangeScripts({
      groupIds: next.filter((b) => b.group).map((b) => b.group!.id),
      scripts: next.flatMap((b) => b.items.map((s) => ({ id: s.id, groupId: b.group?.id })))
    })
  }

  /**
   * 展开某个分组。
   *
   * 两个调用点：新建脚本（落盘后要让新脚本所在的分组露出来）、把脚本拖进收起的分组
   * （不展开的话用户看到的就是「东西凭空消失了」）。
   */
  const expandGroup = (gid?: string): void => {
    if (!gid) return
    setExpanded((prev) => (prev.has(gid) ? prev : new Set([...prev, gid])))
  }

  /** 脚本拖拽落点：插到目标脚本前 / 后；targetId 为空时追加到目标分组末尾 */
  const dropScript: DropScript = (dragId, targetId, targetGroupId, after) => {
    const next = blocks.map((b) => ({ group: b.group, items: [...b.items] }))
    const from = locate(next, dragId)
    if (!from) return
    const [moved] = next[from.b].items.splice(from.i, 1)
    if (targetId) {
      const at = locate(next, targetId)
      if (at) {
        next[at.b].items.splice(at.i + (after ? 1 : 0), 0, moved)
        commit(next)
        return
      }
    }
    const blk = next.findIndex((b) => b.group?.id === targetGroupId)
    if (blk < 0) return
    next[blk].items.push(moved)
    // 拖进收起的分组里等于「东西消失了」：落点分组自动展开
    expandGroup(targetGroupId)
    commit(next)
  }

  /** 分组拖拽落点：移到目标分组前 / 后（组内脚本跟着一起走） */
  const dropGroup: DropGroup = (dragId, targetGroupId, after) => {
    const next = blocks.map((b) => ({ group: b.group, items: b.items }))
    const from = next.findIndex((b) => b.group?.id === dragId)
    if (from < 0) return
    const [moved] = next.splice(from, 1)
    let to = next.findIndex((b) => b.group?.id === targetGroupId)
    if (to < 0) return
    if (after) to += 1
    // 「未分组」块固定首位：分组不能落到它前面
    const firstGroup = next.findIndex((b) => b.group)
    if (firstGroup >= 0 && to < firstGroup) to = firstGroup
    next.splice(to, 0, moved)
    commit(next)
  }

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 打开新建 / 编辑对话框（`script` 为空 = 新建，`groupId` 预置归属） */
  const openEdit = (script: ScriptEntry | null, groupId?: string): void => {
    setEdit({ script, groupId })
  }

  const submitGroupEdit = async (): Promise<void> => {
    const name = groupEdit?.name.trim()
    if (!groupEdit || !name) return
    const ok = await app.saveScriptGroup({ id: groupEdit.id, name })
    if (ok) setGroupEdit(null)
  }

  /** 待删除分组内的脚本数量（用于确认框文案与勾选项） */
  const groupScriptCount = pendingGroupDelete
    ? scripts.filter((s) => s.groupId === pendingGroupDelete.id).length
    : 0

  const confirmGroupDelete = async (): Promise<void> => {
    const target = pendingGroupDelete
    if (!target) return
    const alsoScripts = deleteGroupScripts
    setPendingGroupDelete(null)
    setDeleteGroupScripts(false)
    const ok = await app.deleteScriptGroup(target.id, alsoScripts)
    if (ok) {
      toast.success(
        `已删除分组「${target.name}」：${alsoScripts ? '组内脚本已一并删除' : '组内脚本已移到「未分组」'}`
      )
    }
  }

  /** 把一个脚本移出到「未分组」：只改该脚本的归属，保持其它顺序不变 */
  const moveOutOfGroup = (script: ScriptEntry): void => {
    void app.arrangeScripts({
      groupIds: groups.map((g) => g.id),
      scripts: scripts.map((s) => ({
        id: s.id,
        groupId: s.id === script.id ? undefined : s.groupId
      }))
    })
  }

  const isEmpty = scripts.length === 0 && groups.length === 0
  const noMatch = searching && viewBlocks.every((b) => b.items.length === 0)
  const viewUngrouped = viewBlocks.find((b) => !b.group)?.items ?? []
  const viewGroups = viewBlocks.filter((b) => b.group)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具条：版式见 `PanelHeader`（标题在左、按钮在右，窄了按钮只留图标） */}
      <PanelHeader
        title="脚本"
        description={`可复用的命令片段 · 共 ${scripts.length} 个 · ${groups.length} 个分组 · 选任意主机运行`}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label="新建分组"
              onClick={() => setGroupEdit({ name: '' })}
            >
              <FolderPlus className="size-4" />
              <PanelHeaderActionLabel>新建分组</PanelHeaderActionLabel>
            </Button>
            <Button size="sm" aria-label="新建脚本" onClick={() => openEdit(null)}>
              <Plus className="size-4" />
              <PanelHeaderActionLabel>新建脚本</PanelHeaderActionLabel>
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 sm:px-5">
        {/* 搜索框：常驻在清单上方（不跟着清单滚）。一条脚本都没有时收起来 ——
            对着空清单给一个搜索框，只会让人以为「东西被筛掉了」 */}
        {!isEmpty && (
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索脚本（名称 / 描述 / 正文）…"
            className="h-8 w-full max-w-sm text-sm"
          />
        )}

        {/*
          空态**不进滚动容器**：`h-full` 是百分比，父级只保证「能用多少」而不是「一定
          多高」，撑不起来时居中的内容就贴着顶部缩成一团。这里让它直接占 `flex-1` ——
          高度和「有脚本时的卡片区」完全一致，只是里面换成了居中提示。
          也不给「新建脚本」按钮：同一个动作顶栏已经有一颗，空态再摆就是重复。
        */}
        {isEmpty ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <FileCode2 className="size-8 text-muted-foreground/50" />
            <div className="space-y-1">
              <p className="text-sm font-medium">还没有脚本</p>
              <p className="text-xs text-muted-foreground">
                把常用的命令存成脚本，之后选一台主机直接跑。
              </p>
            </div>
          </div>
        ) : noMatch ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
            没有匹配「{search}」的脚本。
          </div>
        ) : (
          /*
            列表容器**不画边框**：卡片自己带边框，外面再套一层就是「框里套框」（暗色主题下
            两层半透明边框叠起来发灰）。`p-1` 只为了让卡片的 hover 边框不贴着滚动条。
          */
          <div className="min-h-0 flex-1 overflow-auto p-1">
            <div className="flex flex-col gap-4">
              {/* 分组在前（可展开），未分组脚本排在最后；每组下面是**一排卡片** */}
              {viewGroups.map((b) => {
                const group = b.group!
                const count = blocks.find((x) => x.group?.id === group.id)?.items.length ?? 0
                const isEmptyGroup = count === 0
                const isExpanded = searching || (!isEmptyGroup && expanded.has(group.id))
                return (
                  <section key={group.id} className="flex flex-col gap-2">
                    <GroupRow
                      group={group}
                      count={count}
                      expanded={isExpanded}
                      isEmpty={isEmptyGroup}
                      onToggle={() => toggleExpand(group.id)}
                      onNew={() => openEdit(null, group.id)}
                      onRename={() => setGroupEdit({ id: group.id, name: group.name })}
                      onDelete={() => {
                        setDeleteGroupScripts(false)
                        setPendingGroupDelete(group)
                      }}
                      onDropGroup={dropGroup}
                      onDropScript={dropScript}
                    />
                    {isExpanded && (
                      <div className={SCRIPT_CARDS}>
                        {b.items.map((s) => (
                          <ScriptCard
                            key={s.id}
                            script={s}
                            onOpen={() => openEdit(s)}
                            onRun={() => openRunScriptDialog(s.id)}
                            onMoveOut={() => moveOutOfGroup(s)}
                            onDelete={() => setPendingDelete(s)}
                            onDropScript={dropScript}
                            onDropGroup={dropGroup}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                )
              })}
              {viewUngrouped.length > 0 && (
                <section className="flex flex-col gap-2">
                  {/* 有分组时给未分组那批补一个标题，否则它们看起来像最后一组的一部分 */}
                  {viewGroups.length > 0 && (
                    <div className="flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium text-muted-foreground">
                      <Folder className="size-3.5 shrink-0 opacity-60" />
                      <span className="min-w-0 flex-1 truncate">未分组</span>
                      <span className="shrink-0 tabular-nums">{viewUngrouped.length}</span>
                    </div>
                  )}
                  <div className={SCRIPT_CARDS}>
                    {viewUngrouped.map((s) => (
                      <ScriptCard
                        key={s.id}
                        script={s}
                        onOpen={() => openEdit(s)}
                        onRun={() => openRunScriptDialog(s.id)}
                        onMoveOut={() => moveOutOfGroup(s)}
                        onDelete={() => setPendingDelete(s)}
                        onDropScript={dropScript}
                        onDropGroup={dropGroup}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 新建 / 编辑脚本：模态框里改完显式保存，清单在背后一直可见（不会开新标签） */}
      <ScriptEditDialog
        app={app}
        open={edit !== null}
        script={edit?.script ?? null}
        defaultGroupId={edit?.groupId}
        // 新建到某个分组里时，把它展开 —— 否则保存完看起来「什么都没发生」
        onSaved={() => expandGroup(edit?.groupId)}
        onOpenChange={(open) => !open && setEdit(null)}
      />

      {/* 新建 / 重命名分组 */}
      <Dialog open={groupEdit !== null} onOpenChange={(o) => !o && setGroupEdit(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{groupEdit?.id ? '重命名分组' : '新建分组'}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={groupEdit?.name ?? ''}
            placeholder="分组名称，如：部署脚本"
            onChange={(e) => setGroupEdit((g) => (g ? { ...g, name: e.target.value } : g))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitGroupEdit()
            }}
          />
          <DialogFooter>
            <Button data-dialog-dismiss="" variant="ghost" onClick={() => setGroupEdit(null)}>
              取消
            </Button>
            <Button disabled={!groupEdit?.name.trim()} onClick={() => void submitGroupEdit()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除分组：确认 + 「是否连同组内脚本一起删」勾选项 */}
      <Dialog
        open={pendingGroupDelete !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingGroupDelete(null)
            setDeleteGroupScripts(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>删除分组？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            「{pendingGroupDelete?.name}」将被删除
            {groupScriptCount > 0 ? `，组内共 ${groupScriptCount} 个脚本。` : '。'}
          </p>
          {groupScriptCount > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={deleteGroupScripts}
                onCheckedChange={(v) => setDeleteGroupScripts(v === true)}
              />
              同时删除组内的脚本
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            {deleteGroupScripts
              ? '组内脚本将一并删除，该操作不可撤销。'
              : '不勾选时，组内脚本会移到「未分组」。'}
          </p>
          <DialogFooter>
            <Button data-dialog-dismiss="" variant="ghost" onClick={() => setPendingGroupDelete(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmGroupDelete()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除脚本 */}
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        title="删除脚本？"
        description={
          pendingDelete ? `「${pendingDelete.name}」将被永久删除，该操作不可撤销。` : ''
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) void app.deleteScript(target.id).then((ok) => ok && toast.success('已删除'))
        }}
      />
    </div>
  )
}

/** 分组行：可拖动排序（组内脚本跟着走）、可展开、行内「+」新建、右键新建 / 重命名 / 删除 */
function GroupRow({
  group,
  count,
  expanded,
  isEmpty,
  onToggle,
  onNew,
  onRename,
  onDelete,
  onDropScript,
  onDropGroup
}: {
  group: ScriptGroup
  count: number
  expanded: boolean
  /** 空分组不参与展开/折叠（不挂子节点、点击无效，避免空展开抖动） */
  isEmpty: boolean
  onToggle: () => void
  onNew: () => void
  onRename: () => void
  onDelete: () => void
  onDropScript: DropScript
  onDropGroup: DropGroup
}) {
  const [{ isDragging }, drag] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_GROUP,
      item: { id: group.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [group.id]
  )

  const { ref, over, after } = useRowDrop<HTMLDivElement>(
    DND_SCRIPT,
    DND_GROUP,
    (item) => item.id !== group.id,
    (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, group.id, at)
      else onDropScript(item.id, null, group.id, at)
    },
    drag
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          className={cn(
            'group/sgrp relative flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5',
            isDragging && 'opacity-40'
          )}
          onClick={isEmpty ? undefined : onToggle}
        >
          {over && <DropLine after={after} />}
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 transition-transform',
              expanded && !isEmpty && 'rotate-90',
              isEmpty && 'opacity-30'
            )}
          />
          <Folder className="size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
          <span className="shrink-0 tabular-nums">{count}</span>
          <IconTip label="在此分组新建脚本">
            <button
              type="button"
              aria-label="在此分组新建脚本"
              className={cn(
                ROW_ACTION_CLASS,
                'opacity-0 group-hover/sgrp:opacity-100 max-md:opacity-100'
              )}
              onClick={(e) => {
                e.stopPropagation()
                onNew()
              }}
            >
              <Plus className="size-3.5" />
            </button>
          </IconTip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={onNew}>
          <Plus className="size-4" />
          在此分组新建脚本
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onRename}>
          <Pencil className="size-4" />
          重命名
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-4" />
          删除分组
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 脚本卡片：清单的**一格**（一行摆多张，见 `SCRIPT_CARDS`）。
 *
 * 两行版式：名称（一行截断）+ 描述或正文首行（夹两行）。整页宽度下这是最能区分
 * 「部署」和「重启服务」的信息。卡片整块可点 = 编辑对话框；行尾的「运行」平时隐形、
 * hover 才浮现 —— 与侧栏行同一套动作钮。
 *
 * 拖拽落点用同一个 `useRowDrop`：判定仍是「卡片上半 / 下半」，网格里表现为「插到这张
 * 卡片前面 / 后面」。别改成按左右判定 —— 分组行的落点还在用同一套语义，两处会打架。
 */
function ScriptCard({
  script,
  onOpen,
  onRun,
  onMoveOut,
  onDelete,
  onDropScript,
  onDropGroup
}: {
  script: ScriptEntry
  /** 点击卡片 / 右键「编辑」：打开编辑对话框 */
  onOpen: () => void
  onRun: () => void
  onMoveOut: () => void
  onDelete: () => void
  onDropScript: DropScript
  onDropGroup: DropGroup
}) {
  const [{ isDragging }, drag] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_SCRIPT,
      item: { id: script.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [script.id]
  )

  const { ref, over, after } = useRowDrop<HTMLDivElement>(
    DND_SCRIPT,
    DND_GROUP,
    (item, type) =>
      type === DND_GROUP
        ? Boolean(script.groupId) && item.id !== script.groupId
        : item.id !== script.id,
    (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, script.groupId!, at)
      else onDropScript(item.id, script.id, script.groupId, at)
    },
    drag
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          className={cn(
            'group/scr relative flex cursor-pointer flex-col gap-1 rounded-lg border border-border/60 bg-surface-1 p-2.5 transition-colors hover:border-primary/40 hover:bg-foreground/5',
            isDragging && 'opacity-40'
          )}
          onClick={onOpen}
          // 完整描述 / 首行命令：卡片里夹了两行，长命令看不全，悬停补上
          title={script.description?.trim() || script.name}
        >
          {over && <DropLine after={after} />}
          <div className="flex items-center gap-1.5">
            <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{script.name}</span>
            <IconTip label="运行脚本">
              <button
                type="button"
                aria-label="运行脚本"
                className={cn(
                  ROW_ACTION_CLASS,
                  'shrink-0 opacity-0 group-hover/scr:opacity-100 max-md:opacity-100'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  onRun()
                }}
              >
                <Play className="size-3.5" />
              </button>
            </IconTip>
          </div>
          {/* `min-h-10` + `leading-5`：给两行留固定高度，卡片之间不会因为描述一行 / 两行
              而高低不齐（`break-all` 是因为命令常常没有空格，不断词就顶出卡片） */}
          <p className="line-clamp-2 min-h-10 break-all text-xs leading-5 text-muted-foreground">
            {previewTextOf(script)}
          </p>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={onOpen}>
          <FileCode2 className="size-4" />
          编辑
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRun}>
          <Play className="size-4" />
          运行
        </ContextMenuItem>
        {script.groupId && (
          <ContextMenuItem onSelect={onMoveOut}>
            <FolderInput className="size-4" />
            移出分组
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-4" />
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
