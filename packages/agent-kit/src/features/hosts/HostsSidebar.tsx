"use client";

/**
 * 「主机」功能区的侧边栏：**主机清单 + 本地终端**（外加脚本的入口）。
 *
 * 从设置页的「SSH 主机」搬过来的（配置表单见 `HostDialog`）—— 主机从「一条设置项」
 * 升格成一个功能区，因为它是**每天都在用**的东西：连着看日志、传文件、跑命令，
 * 不该每次都要「打开设置 → SSH 主机 → 再去命令面板」。
 *
 * ## 版式（与 AI Agent 侧栏同构）
 *
 * 整条侧栏的骨架（外壳宽度 / 手机抽屉 + 分区容器）交给
 * `shared/components/SidebarScaffold`，三个功能区侧栏共用同一份；这里只声明内容。
 *
 * **一个**分区（`SectionShell`），自上而下：
 *
 * 1. 顶部动作（`SidebarActions`）：「新建主机 / 隧道 / 脚本」—— 与 AI Agent 的
 *    「新对话 / 定时任务」同一套版式（整行、带图标、带文字）；
 * 2. **一块**可折叠的内容组（`SidebarGroup`）：「主机与终端」，组内自己滚，外层只在
 *    窗口过矮时兜底滚一次。标题行右侧那颗图标按钮是「新建分组」。
 *
 * ## 脚本已经搬去主区域了
 *
 * 它原先是下面那块可折叠组，260px 宽只塞得下名字 + 一颗「运行」，描述 / 正文 /
 * 分组层级全看不见。现在它是主区域的**单例标签页**（`features/scripts/ScriptsPanel`，
 * 由 `openScriptsTab()` 打开），入口是顶部动作区「隧道」下面那颗「脚本」。
 *
 * 它仍从这条侧栏进（而不是占一个独立的功能区图标）：用的场景就是「连主机之前先挑一段
 * 命令」，入口贴着主机清单才顺手；但脚本本身横跨所有主机（同一段命令可以选任意机器跑），
 * 所以清单归主区域那一页管。
 *
 * 组标签的折叠箭头排在名字**后面**、hover / 键盘聚焦才浮现（见 `SectionHeader`）；
 * 折叠只切内容、不动布局高度，状态只在内存里（刷新即回默认展开）。
 * 分区的「收起 / 关闭侧栏」按钮也不出现在这条侧栏里（收起 / 展开走活动栏那颗当前功能区的
 * 图标，手机另有遮罩可点，见 `ActivityBar`）。
 *
 * 分区标题「主机与终端」用的还是这个功能区的名字 + 它实际装的两类东西（SSH 主机 + 本地
 * 终端）—— 两类东西并列时叫「主机与终端」本来就比只叫「主机」准确。
 *
 * ## 两类条目，同一份清单
 *
 * - **SSH 主机**：点一行 = 在主区域开一个到它的终端标签（`host:<id>#<seq>`，**可多开**：
 *   同一台机器再点一次就再开一条，方便同时看好几条链路）；
 * - **本地终端**：清单里存的是「常用的本机终端」（shell / 启动参数 / 启动后自动命令），
 *   点一行 = 按那份配置开一条本机终端标签（`local:<n>`，每次都是新的一条）。
 *
 * 两者的落点都是**主区域的内容标签**，不是右侧面板 —— 打开动作由
 * `app/layout/tool-tabs.ts` 完成，`useEnsureChatView()` 负责先把用户切到
 * 会渲染面板的**对话视图**上（面板只在对话视图渲染）。
 *
 * 新增 / 编辑统一走 `HostDialog`（顶部 Tab 选「本地终端 / SSH」；编辑时不显示 Tab —— 类型不可改）。
 *
 * ## 分组树（与「接口请求」同一套）
 *
 * 主机与终端按**多级分组树**排列，两类条目**共用同一套分组** —— 它们本来就同列在侧栏，
 * 分两套只会让「本机终端放不进任何分组」。树模型与拖拽落点的纯逻辑跟接口请求、脚本两个
 * 面板共用（`shared/lib/group-tree.ts` + `shared/lib/group-dnd.tsx`），别在这里另写一份。
 *
 * - 未分组的主机平铺在**树之后**（与接口请求面板同款：先分组、后散条目）；
 * - 右键：分组行是「添加 / 新建子分组 / 移动到… / 重命名 / 删除分组」，主机行是
 *   「连接 / SFTP / 隧道 / 编辑 / 移出分组 / 删除」；
 * - 拖拽：主机可跨组拖、可在组内排序；分组可拖（**整棵子树一起走**）并可改层级；
 * - 折叠 / 展开：整行可点，箭头在**名字右侧**（hover 才浮现，与 AI Agent 侧栏的工作区行
 *   同一套），空分组不参与折叠；
 * - 渲染是**递归**的（`renderGroupNode`），不是拍平成一维数组再按 `depth` 缩进：每层子树
 *   套一个 `SUB_TREE`（缩进 + **左侧一条竖线**），层级靠 DOM 嵌套累积 —— 只有缩进的话，
 *   多级分组看起来只是「文字往右挪」，看不出谁挂在谁下面；
 * - 删分组弹二次确认，**组内有条目时**多一个「同时删除组内主机 / 终端」勾选项 ——
 *   不勾就只删分组，组内条目上移一级（顶级分组则回到未分组）。
 *
 * 所有改动都走 `app.arrangeHosts` / `saveHostGroup` / `deleteHostGroup`：分组顺序 + 条目归属
 * **一次提交**，不留中间态；这三个动作**不刷全量列表**（拖拽是高频动作，见 `server-lists.ts`
 * 的 `withHostTree`）。
 *
 * ## 每行只有一行
 *
 * 行里只放「图标 + 名称」：连接信息（`user@host:port`）与跳板标注**不上列表** ——
 * 侧栏本来就窄，两行会把清单撑得又高又碎，而点开标签后标题栏里就有完整连接信息，
 * 要核对地址看行的悬停提示即可。
 *
 * ## 行内动作
 *
 * 编辑 / 删除收在行的**右侧浮层**里（hover 才浮现）—— 与 AI Agent 侧栏的会话行同一套做法：
 * 侧栏本来就窄，常驻按钮会把主机名挤没。
 *
 * 原来的「测试连接」按钮已移除：它只是探一次连通性（连上即断、不改状态），而真要连的时候
 * 点一下行就有结果，为它多留一颗按钮不值得（服务端那条路由也一并删了）。
 */
import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useDrag } from 'react-dnd'
import {
  ChevronRight,
  FileCode2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Network,
  Pencil,
  Plus,
  Server,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
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
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@fizz/ui/context-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import { SidebarScaffold } from '@fizz/agent-kit/shared/components/SidebarScaffold'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { SectionContent, SectionShell } from '@fizz/agent-kit/shared/components/StackedSections'
// 顶部动作区 + 内容组：与 AI Agent 侧栏共用同一份（版式、高度策略都在那边）
import {
  SidebarAction,
  SidebarActions,
  SidebarGroup,
  SidebarRowsSkeleton
} from '@fizz/agent-kit/shared/components/SidebarGroups'
import { HOSTS_LIST_SECTION } from '@fizz/agent-kit/shared/lib/section-ids'
import {
  openHostTab,
  openLocalTerminalTab,
  openScriptsTab,
  openSftpTab,
  openTunnelTab
} from '@fizz/agent-kit/shared/lib/tool-tabs'
import { HostDialog } from '@fizz/agent-kit/features/hosts/HostDialog'
import { hostSummary } from '@fizz/agent-kit/features/hosts/host-format'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { ROW_ACTION_CLASS, RowActionButton } from '@fizz/agent-kit/shared/components/RowAction'
import { resetTruncatedName, revealTruncatedName } from '@fizz/agent-kit/shared/lib/hover-reveal'
import { treeIndent } from '@fizz/agent-kit/shared/lib/tree-indent'
import {
  buildGroupTree,
  collectUngrouped,
  countSubtreeItems,
  flattenBlocks,
  moveGroup,
  subtreeOf,
  type GroupNode
} from '@fizz/agent-kit/shared/lib/group-tree'
import { DropLine, useRowDrop, type DragItem } from '@fizz/agent-kit/shared/lib/group-dnd'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { HostConfig, HostGroup, LocalHostConfig, SshHostConfig } from '@fizz/contracts/types'

/** react-dnd 拖拽类型：主机 / 终端与分组各一种，落点按类型分别处理 */
const DND_HOST = 'host-item'
const DND_GROUP = 'host-group'

/** 一个列表块：`groupId` 为空 = 未分组块。数组顺序即 DFS 前序显示顺序 */
interface Block {
  groupId?: string
  items: HostConfig[]
}

/** 本功能区在泛型分组树上的具体实例（树模型纯函数见 `@/shared/lib/group-tree`） */
type HostGroupNode = GroupNode<HostGroup, HostConfig>

/**
 * 分组 Select 的「顶级」哨兵值。
 *
 * Radix Select **不允许**空字符串当 `value`（会当成「无值」而显示占位符），
 * 所以「顶级分组」用一个不可能撞车的哨兵字符串代表。
 */
const TOP_GROUP = '__top__'

/** 拖拽落点处理函数签名（主机与分组共用，由分区统一重排后一次写回） */
type DropHost = (
  dragId: string,
  targetId: string | null,
  targetGroupId: string | undefined,
  after: boolean
) => void
type DropGroup = (dragId: string, targetGroupId: string, after: boolean) => void

/**
 * 行尾小按钮：平时隐形，hover 所在行才浮现；触摸设备没有 hover，常显。
 *
 * 底色来自 `shared/components/RowAction` 的共用底板（与 Agent 侧栏、主区域标签同一套）；
 * 这里只额外补「显形」那部分，**不能**写进底板 —— 见 `AgentSidebar` 里同一处的注释。
 */
const HOST_ACTION = cn(
  ROW_ACTION_CLASS,
  'opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100'
)

/**
 * 分组**子树**的容器：缩进 + 左侧一条竖线。
 *
 * 与 AI Agent 侧栏的工作区子树是同一份（`AgentSidebar` 的 `subList`）：
 * 层级靠 DOM 嵌套累积，竖线跟着一层层往里画 —— 原来只按 `treeIndent(depth)` 加
 * `paddingLeft`，多级分组看起来只是「文字往右挪」，看不出谁挂在谁下面。
 *
 * 用 rem 类名而不是 px：手机端整体放大靠抬根字号（见 `tree-indent.ts` 文件头），
 * 缩进必须跟着文字一起长。
 */
const SUB_TREE = 'ml-3.5 flex flex-col gap-0.5 border-l border-border pl-2.5'

export function HostsSidebar({
  app,
  width,
  mobileOpen,
  onMobileOpenChange
}: {
  app: AgentApp
  /** 侧栏宽度（px）：由 AppShell 持有并持久化 */
  width: number
  /** 手机端抽屉开关 */
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
}) {
  const t = useT()

  /** 表单弹窗：`editing` 为 null = 新增；弹窗开着时非 null（用一个独立布尔区分「关着」） */
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<HostConfig | null>(null)
  /** 新增时的归属分组（分组行的「在此分组添加」传进来） */
  const [formGroupId, setFormGroupId] = useState<string | undefined>(undefined)
  /** 待确认删除的条目（二次确认弹窗；null = 关着） */
  const [deleteTarget, setDeleteTarget] = useState<HostConfig | null>(null)

  /** 显式展开的分组（缺省全收起，与接口请求面板一致） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 新建（id 空）/ 重命名分组；`parentId` 只在新建子分组时带 */
  const [groupEdit, setGroupEdit] = useState<{ id?: string; name: string; parentId?: string } | null>(
    null
  )
  /** 待确认删除的分组 + 「是否连同组内主机一起删」 */
  const [pendingGroupDelete, setPendingGroupDelete] = useState<HostGroup | null>(null)
  const [deleteGroupHosts, setDeleteGroupHosts] = useState(false)
  /** 「移动到…」弹窗 */
  const [moveTarget, setMoveTarget] = useState<HostGroup | null>(null)
  const [moveParent, setMoveParent] = useState<string>(TOP_GROUP)

  const openForm = (target: HostConfig | null, groupId?: string): void => {
    setEditing(target)
    setFormGroupId(groupId)
    setFormOpen(true)
  }

  /** 点一台 SSH 主机 = 在主区域**新开**一个到它的终端标签（可多开，见 tool-tabs） */
  const openHost = (host: SshHostConfig): void => {
    openHostTab(host)
  }

  /**
   * 打开该主机的 **SFTP 文件管理**标签（右键菜单入口，仅 SSH 主机）。
   *
   * 一台主机一条标签：再打开一次是「聚焦已有标签」。本机终端没有远端可浏览，
   * 菜单里按类型挡掉了，这里也收窄成 `SshHostConfig`。
   */
  const openSftp = (host: SshHostConfig): void => {
    openSftpTab(host)
  }

  /**
   * 打开 **SSH 隧道**面板（右键菜单入口，仅 SSH 主机），并**预选**这台主机。
   *
   * 与 SFTP 不同，隧道面板是**全局单例**（隧道列表横跨多台主机），所以这里不是「给这台
   * 主机开一个标签」，而是「打开面板 + 把新建弹窗的主机选成它」；已在面板里时就是聚焦 +
   * 预选，不新开（见 `tool-tabs.ts` 的 `openTunnelTab`）。
   */
  const openTunnels = (host: SshHostConfig): void => {
    openTunnelTab({ hostId: host.id })
  }

  /**
   * 打开 **SSH 隧道**面板（分区标题栏那颗按钮，**不带主机**）。
   *
   * 与右键菜单的 `openTunnels` 是同一个落点（`tunnel:list` 全局单例），差别只在**不预选主机**
   * —— 标题栏的入口是「看看配了哪些隧道 / 新建一条」，不针对某一台机器。
   */
  const openTunnelPanel = (): void => {
    openTunnelTab()
  }

  /**
   * 点一条本机终端配置 = 按它存下的 shell / 工作目录 / 启动参数 / 启动后自动命令开一条终端标签。
   *
   * ⚠️ **与当前项目无关**：「主机与终端」是独立功能，开出来的是**宿主 shell** ——
   * 目录取自**这条配置自己的 `cwd`**（留空 = 主目录），不从 `activeWorkspace` 取，
   * 也不带项目 id（命令历史走全局一份，见 `TerminalPanel` 的 `localHistory`）。以前这里
   * 顺手把当前项目目录 / id 传下去，结果「项目是容器型 → 这条本机终端被 `docker exec`
   * 进容器」，用户报过。
   */
  const openLocalHost = (host: LocalHostConfig): void => {
    openLocalTerminalTab({
      // 目录来自**这条配置自己**（留空 = 主目录），与当前项目无关
      cwd: host.cwd ?? '',
      shellId: host.shellId ?? null,
      shellName: host.shellName,
      label: host.name,
      args: host.args,
      autoCommand: host.autoCommand
    })
  }

  // ---------- 分组树：模型 / 展开 / 重排 / 增删改 ----------

  const groups = app.hostGroups
  const hosts = app.sshHosts

  const groupTree = useMemo(() => buildGroupTree(groups, hosts), [groups, hosts])
  const ungrouped = useMemo(() => collectUngrouped(hosts, groups), [hosts, groups])
  /** 完整的块结构（拖拽落点计算一律用它，与显示行的展开状态无关） */
  const blocks = useMemo(() => flattenBlocks(groupTree, ungrouped), [groupTree, ungrouped])

  /** 把树摊平成显示行（分组在前，未分组主机平铺在最后） */
  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 展开某分组的整条父链（让新建 / 移动后的分组立刻可见） */
  const expandAncestors = (gid?: string): void => {
    if (!gid) return
    const byId = new Map(groups.map((g) => [g.id, g]))
    const chain: string[] = []
    let cur: HostGroup | undefined = byId.get(gid)
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      chain.push(cur.id)
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    if (chain.length) setExpanded((prev) => new Set([...prev, ...chain]))
  }

  /** 把调整后的块结构整体写回（分组顺序 + 条目归属一次提交，避免中间态） */
  const commit = (next: Block[]): void => {
    const groupOrder: HostGroup[] = []
    const seen = new Set<string>()
    for (const b of next) {
      if (!b.groupId || seen.has(b.groupId)) continue
      seen.add(b.groupId)
      const g = groups.find((x) => x.id === b.groupId)
      if (g) groupOrder.push(g)
    }
    for (const g of groups) {
      if (!seen.has(g.id)) groupOrder.push(g)
    }
    void app.arrangeHosts({
      groups: groupOrder.map((g) => ({ id: g.id, parentId: g.parentId })),
      hosts: next.flatMap((b) => b.items.map((h) => ({ id: h.id, groupId: b.groupId })))
    })
  }

  /** 主机拖拽落点：插到目标主机前 / 后；`targetId` 为空时追加到目标分组末尾 */
  const dropHost: DropHost = (dragId, targetId, targetGroupId, after) => {
    const next = blocks.map((b) => ({ groupId: b.groupId, items: [...b.items] }))
    const from = next.findIndex((b) => b.items.some((h) => h.id === dragId))
    if (from < 0) return
    const at0 = next[from].items.findIndex((h) => h.id === dragId)
    const [moved] = next[from].items.splice(at0, 1)
    if (targetId) {
      const blk = next.findIndex((b) => b.items.some((h) => h.id === targetId))
      if (blk >= 0) {
        const at = next[blk].items.findIndex((h) => h.id === targetId)
        next[blk].items.splice(at + (after ? 1 : 0), 0, moved)
        commit(next)
        return
      }
    }
    const blk = next.findIndex((b) => b.groupId === targetGroupId)
    if (blk < 0) return
    next[blk].items.push(moved)
    // 拖进收起的分组里等于「东西消失了」：落点分组自动展开 —— 主机清单本来就短，
    // 一条拖没了的条目比请求面板那边更难再被想起来。
    if (targetGroupId) expandAncestors(targetGroupId)
    commit(next)
  }

  /** 分组拖拽落点：移到目标分组前 / 后（整棵子树一起走） */
  const dropGroup: DropGroup = (dragId, targetGroupId, after) => {
    const next = blocks.map((b) => ({ groupId: b.groupId, items: b.items }))
    const from = next.findIndex((b) => b.groupId === dragId)
    if (from < 0) return
    const subtree = subtreeOf(groups, dragId)
    let runLen = 1
    while (
      from + runLen < next.length &&
      next[from + runLen].groupId &&
      subtree.has(next[from + runLen].groupId!)
    ) {
      runLen += 1
    }
    const run = next.splice(from, runLen)
    let to = next.findIndex((b) => b.groupId === targetGroupId)
    if (to < 0) return
    if (after) to += 1
    // 「未分组」块固定首位：分组不能落到它前面
    const firstGroup = next.findIndex((b) => b.groupId)
    if (firstGroup >= 0 && to < firstGroup) to = firstGroup
    next.splice(to, 0, ...run)
    commit(next)
  }

  const submitGroupEdit = async (): Promise<void> => {
    const name = groupEdit?.name.trim()
    if (!groupEdit || !name) return
    const ok = await app.saveHostGroup({
      id: groupEdit.id,
      name,
      parentId: groupEdit.parentId
    })
    if (ok) {
      if (!groupEdit.id) expandAncestors(groupEdit.parentId)
      setGroupEdit(null)
    }
  }

  const confirmGroupDelete = async (): Promise<void> => {
    const target = pendingGroupDelete
    if (!target) return
    const alsoHosts = deleteGroupHosts
    const fallbackName =
      (target.parentId && groups.find((g) => g.id === target.parentId)?.name) ?? t('未分组')
    setPendingGroupDelete(null)
    setDeleteGroupHosts(false)
    const ok = await app.deleteHostGroup(target.id, alsoHosts)
    if (ok) {
      toast.success(
        alsoHosts
          ? t('已删除分组「{name}」：组内及子分组的主机 / 终端已一并删除', { name: target.name })
          : t('已删除分组「{name}」：组内及子分组的主机 / 终端已移到「{fallback}」', {
              name: target.name,
              fallback: fallbackName
            })
      )
    }
  }

  const confirmMoveGroup = async (): Promise<void> => {
    const target = moveTarget
    if (!target) return
    const parentId = moveParent === TOP_GROUP ? undefined : moveParent
    setMoveTarget(null)
    if (parentId === target.parentId) return
    const nextGroups = moveGroup(groups, target.id, parentId)
    const ok = await app.arrangeHosts({
      groups: nextGroups.map((g) => ({ id: g.id, parentId: g.parentId })),
      hosts: hosts.map((h) => ({ id: h.id, groupId: h.groupId }))
    })
    if (ok) {
      if (parentId) expandAncestors(parentId)
      toast.success(
        parentId
          ? t('已移动「{name}」到所选分组下', { name: target.name })
          : t('已移动「{name}」到顶级分组', { name: target.name })
      )
    }
  }

  /** 把一条主机 / 终端移出到「未分组」（只改该条的归属，其余顺序不动） */
  const moveOutOfGroup = (host: HostConfig): void => {
    void app.arrangeHosts({
      groups: groups.map((g) => ({ id: g.id, parentId: g.parentId })),
      hosts: hosts.map((h) => ({
        id: h.id,
        groupId: h.id === host.id ? undefined : h.groupId
      }))
    })
  }

  /** 「移动到…」下拉里的分组选项（缩进反映层级；排掉自身与自己的子树，避免成环） */
  const flatGroupOptions = useMemo((): Array<{ id: string; name: string; depth: number }> => {
    const skip = moveTarget ? subtreeOf(groups, moveTarget.id) : new Set<string>()
    const out: Array<{ id: string; name: string; depth: number }> = []
    const walk = (nodes: HostGroupNode[], depth: number): void => {
      for (const n of nodes) {
        if (skip.has(n.group.id)) continue
        out.push({ id: n.group.id, name: n.group.name, depth })
        walk(n.children, depth + 1)
      }
    }
    walk(buildGroupTree(groups, []), 0)
    return out
  }, [groups, moveTarget])

  /**
   * 分组树：**递归渲染**（不再拍平成 `rows` 再按 `depth` 加 `paddingLeft`）。
   *
   * 拍平那版画不出「展开后左侧一条竖线」，而那条线是「谁挂在谁下面」唯一的视觉线索 ——
   * 多级分组只靠缩进，看着就是「文字往右挪」。递归之后层级由 DOM 嵌套累积：
   * 每进一层套一个 `SUB_TREE`（与 AI Agent 侧栏的工作区子树同一份）。
   *
   * 先定义 `renderHost` 再定义 `renderGroupNode`：后者在闭包里调前者，
   * 反过来写会踩 TDZ。
   */
  const renderHost = (host: HostConfig, hasGroup: boolean): ReactNode => (
    <HostRow
      key={host.id}
      host={host}
      hasGroup={hasGroup}
      onOpen={() => (host.kind === 'local' ? openLocalHost(host) : openHost(host))}
      onSftp={openSftp}
      onTunnels={openTunnels}
      onEdit={() => openForm(host)}
      onMoveOut={() => moveOutOfGroup(host)}
      onDelete={() => setDeleteTarget(host)}
      onDropHost={dropHost}
      onDropGroup={dropGroup}
    />
  )

  const renderGroupNode = (node: HostGroupNode): ReactNode => {
    const group = node.group
    const isEmpty = node.items.length === 0 && node.children.length === 0
    const isExpanded = expanded.has(group.id)
    return (
      <div key={group.id} className="flex flex-col gap-0.5">
        <GroupRow
          node={node}
          expanded={isExpanded}
          onToggle={() => toggleExpand(group.id)}
          onAddHost={() => openForm(null, group.id)}
          onNewSub={() => {
            setGroupEdit({ name: '', parentId: group.id })
            expandAncestors(group.id)
          }}
          onMove={() => {
            setMoveParent(group.parentId ?? TOP_GROUP)
            setMoveTarget(group)
          }}
          onRename={() => setGroupEdit({ id: group.id, name: group.name })}
          onDelete={() => {
            setDeleteGroupHosts(false)
            setPendingGroupDelete(group)
          }}
          onDropHost={dropHost}
          onDropGroup={dropGroup}
        />
        {!isEmpty && isExpanded && (
          <div className={SUB_TREE}>
            {node.children.map(renderGroupNode)}
            {node.items.map((h) => renderHost(h, true))}
          </div>
        )}
      </div>
    )
  }

  const pendingSubtreeHostCount = pendingGroupDelete
    ? countSubtreeItems(groups, hosts, pendingGroupDelete.id)
    : 0

  return (
    /*
      骨架（外壳 + 分区容器）交给 `shared/components/SidebarScaffold`，三个功能区侧栏共用
      同一份 —— 这里只声明内容。

      版式与 AI Agent 侧栏**同构**（`shared/components/SidebarGroups`）：
      一个 `SectionShell` 里自上而下是「顶部动作 → 主机与终端组」，
      组可折叠、自己滚，外层只在窗口极矮时兜底滚一次。

      ⚠️ 弹窗挂在骨架**外面**（同一个 fragment 里并列，见文件末尾）：它们既不属于任何一个
      分区，也不该让这层骨架重新长出各功能区特有的东西 —— 见 `SidebarScaffold` 里那条说明。
    */
    <>
      <SidebarScaffold
        width={width}
        mobileOpen={mobileOpen}
        onMobileOpenChange={onMobileOpenChange}
      >
        {/*
          主机 / 终端：**一个**分区装一块可折叠内容组。
          脚本已经不在这里了（它是主区域的 `scripts:list` 标签页，入口在上面的动作区），
          所以这块组自己吃满剩下的高度 —— `size="fill"` + `grow={1}`，不再需要与别的组
          按权重分。
        */}
        <SectionShell spec={HOSTS_LIST_SECTION} minHeight={200}>
          {/*
            顶部动作：新建主机 / 隧道 / 脚本。原先这几颗挤在「主机与终端」的标题行右侧
            —— 标题行本来就只有 260px 宽，几颗图标把标题挤得只剩几个字。现在与 AI Agent
            侧栏同款：提到分区顶部、与下面的内容组分隔开（`SidebarActions`）。

            「新建分组」不在这一排：它是**分组**的操作，跟着「主机与终端」那行更顺
            （那颗图标按钮在下面 `SidebarGroup` 的 `extra` 里）。

            「隧道」是全局单例面板（隧道列表横跨多台主机），所以这里不带主机、纯打开列表
            —— 与命令面板那个入口同一个落点；给单台机器配隧道仍走主机行的右键菜单。

            「脚本」同样是全局单例面板（`scripts:list`，清单在主区域那一页），这里只负责
            把标签打开 —— 与「隧道」并列，因为两者都是「主机之外的那一类东西」。
          */}
          <SidebarActions>
            <SidebarAction icon={Plus} label={t('新建主机')} onClick={() => openForm(null)} />
            <SidebarAction icon={Network} label={t('隧道')} onClick={openTunnelPanel} />
            <SidebarAction icon={FileCode2} label={t('脚本')} onClick={() => openScriptsTab()} />
          </SidebarActions>

          <SectionContent>
            {/*
              **外层兜底滚动容器**（与 AI Agent 侧栏同构）：组自己滚，这层只在窗口极矮、
              组的 `minHeight` 放不下时才兜底滚一次。
              `px-2` 与 AI Agent 侧栏的列表容器同宽：行自己还有 `px-2`，所以清单里文字的
              左边距 = 8 + 8 = 16px，与项目树里的行**同列**。两条侧栏别单独改其中一个 ——
              来回切时文字会左右挪一下。
            */}
            <div className="flex min-h-0 flex-1 flex-col overflow-auto no-scrollbar px-2">
              <SidebarGroup
                title={t('主机与终端')}
                count={hosts.length}
                alignIndent
                size="fill"
                grow={1}
                className="pb-2"
                // 标题行右侧的「新建分组」：放在分组这一行的行尾才找得到（它建的是
                // 下面树里的分组）。**用行尾动作钮那套小按钮**（`RowActionButton`，
                // 与分组行右侧那颗「+」同一个水底）：标题行只有 32px 高、标签是 12px 灰字，
                // 一颗 28px 的 ghost Button 贴上去比标题还抢眼。
                // 与分组行那颗「+」的唯一差别是**不藏起来**：那颗是行内快捷方式（行本身
                // 可点、右键菜单是主入口），这颗是「新建分组」现在唯一的入口。
                extra={
                  <IconTip label={t('新建分组')}>
                    <RowActionButton
                      aria-label={t('新建分组')}
                      className="shrink-0"
                      onClick={() => setGroupEdit({ name: '' })}
                    >
                      <FolderPlus className="size-3.5" />
                    </RowActionButton>
                  </IconTip>
                }
                // 只有「一条主机 / 终端都没有、也没有分组」时才算空 —— 有分组时要让分组行露出来。
                // **加载中不传**：清单还没落地时 hosts / groups 也是空数组，摆出来就是
                // 「先闪一句还没有主机或终端，再冒出内容」（骨架在 children 里，见下）
                empty={
                  hosts.length === 0 &&
                  groups.length === 0 &&
                  (app.hostsLoaded || app.error)
                    ? t('还没有主机或终端。')
                    : undefined
                }
              >
                {/* 清单没落地 = 加载窗口：上骨架，别先闪空态。加载失败（app.error）
                    回退真实空态，错误信息另有横幅展示 */}
                {!app.hostsLoaded && !app.error ? (
                  <SidebarRowsSkeleton rows={2} />
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {/* 分组树（递归：每层子树自带左侧竖线）+ 未分组条目平铺在最下面 */}
                    {groupTree.map(renderGroupNode)}
                    {ungrouped.map((h) => renderHost(h, false))}
                  </div>
                )}
              </SidebarGroup>
            </div>
          </SectionContent>
        </SectionShell>
      </SidebarScaffold>

      {/* 底部不再放「菜单」按钮：它已经搬到**底部状态栏**左侧（AppShell → StatusBar），
          两个功能区共用那一份 —— 侧栏各自再挂一份，收起侧栏时又得多渲染一处 */}

      {/* 添加 / 编辑表单（`editing` 为 null = 新增；顶部可切本地终端 / SSH）。
          `defaultGroupId` 只作用于新增 —— 从分组行的「在此分组添加」进来时预置归属。 */}
      <HostDialog
        app={app}
        open={formOpen}
        editing={editing}
        defaultGroupId={formGroupId}
        onOpenChange={setFormOpen}
      />

      {/* 删除条目：二次确认（SSH 说清连带影响 —— 用了它当跳板的主机会被摘掉跳板） */}
      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        title={deleteTarget?.kind === 'local' ? t('删除本机终端？') : t('删除 SSH 主机？')}
        description={
          deleteTarget
            ? deleteTarget.kind === 'local'
              ? t('「{name}」会从列表里移除。已经打开的终端标签不受影响。', {
                  name: deleteTarget.name
                })
              : t('「{name}」（{summary}）会从列表里移除。以它为跳板机的主机会变成直连，删掉就得重新添加。已经打开的终端标签不受影响，但关掉之后就再也连不上了。', {
                  name: deleteTarget.name,
                  summary: hostSummary(deleteTarget)
                })
            : ''
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget
          setDeleteTarget(null)
          if (target) void app.deleteSshHost(target.id)
        }}
      />

      {/* 新建 / 重命名分组：只有新建时才有「上级分组」这一项（重命名不改层级，层级靠拖拽 / 移动到…） */}
      <Dialog open={groupEdit !== null} onOpenChange={(open) => !open && setGroupEdit(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{groupEdit?.id ? t('重命名分组') : t('新建分组')}</DialogTitle>
            <DialogDescription>
              {t('分组对 SSH 主机与本机终端是**共用**的，可以建多级；条目归属靠拖拽调整。')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              value={groupEdit?.name ?? ''}
              placeholder={t('分组名称')}
              onChange={(e) =>
                setGroupEdit((s) => (s ? { ...s, name: e.target.value } : s))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitGroupEdit()
              }}
            />
            {!groupEdit?.id && (
              <Select
                value={groupEdit?.parentId ?? TOP_GROUP}
                onValueChange={(v) =>
                  setGroupEdit((s) => (s ? { ...s, parentId: v === TOP_GROUP ? undefined : v } : s))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('顶级分组')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TOP_GROUP}>{t('顶级分组')}</SelectItem>
                  {flatGroupOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      <span style={{ paddingLeft: treeIndent(o.depth, 12, 0) }}>{o.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGroupEdit(null)}>
              {t('取消')}
            </Button>
            <Button disabled={!groupEdit?.name.trim()} onClick={() => void submitGroupEdit()}>
              {t('保存')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除分组：二次确认 +「是否连组内主机一起删」（不勾 = 组内条目上移一级，不丢数据） */}
      <Dialog
        open={pendingGroupDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingGroupDelete(null)
            setDeleteGroupHosts(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('删除分组「{name}」？', { name: pendingGroupDelete?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {t('它的子分组会一并删除。')}
              {pendingSubtreeHostCount > 0
                ? t('组内及子分组共有 {count} 个主机 / 终端。', { count: pendingSubtreeHostCount })
                : t('组内没有主机 / 终端。')}
            </DialogDescription>
          </DialogHeader>
          {pendingSubtreeHostCount > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={deleteGroupHosts}
                onCheckedChange={(v) => setDeleteGroupHosts(v === true)}
              />
              {t('同时删除组内（含子分组）的主机 / 终端')}
            </label>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingGroupDelete(null)
                setDeleteGroupHosts(false)
              }}
            >
              {t('取消')}
            </Button>
            <Button variant="destructive" onClick={() => void confirmGroupDelete()}>
              {deleteGroupHosts ? t('删除分组与组内条目') : t('仅删除分组')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 移动到…：多级树下光靠拖拽不好「一步到顶级 / 到很深的组」，留一个显式入口 */}
      <Dialog open={moveTarget !== null} onOpenChange={(open) => !open && setMoveTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('移动分组「{name}」', { name: moveTarget?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {t('整棵子树会一起移动；下拉里已经排掉它自己和它的子分组。')}
            </DialogDescription>
          </DialogHeader>
          <Select value={moveParent} onValueChange={setMoveParent}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('顶级分组')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TOP_GROUP}>{t('顶级分组')}</SelectItem>
              {flatGroupOptions.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  <span style={{ paddingLeft: treeIndent(o.depth, 12, 0) }}>{o.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoveTarget(null)}>
              {t('取消')}
            </Button>
            <Button onClick={() => void confirmMoveGroup()}>{t('移动')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * 分组行：文件夹图标 + 名称 + **名字右侧**的展开箭头（hover 浮现）+ 行尾 hover 浮现的
 * 「在此分组添加」。
 *
 * 箭头的位置与显隐照 AI Agent 侧栏的**工作区行**：跟着名字走、平时隐身 —— 整行可点也能
 * 展开，箭头只是「这里能展开」的提示，一排常显的箭头会跟行首图标抢注意力。展开后的子树
 * 由 `renderGroupNode` 套 `SUB_TREE`（左侧一条竖线），那才是层级的主要视觉线索。
 *
 * 空分组（既无子分组也无条目）**不参与折叠** —— 箭头不转、点了也不展开，与接口请求面板一致：
 * 一个点了没反应的箭头比没有箭头更让人困惑。
 *
 * 拖拽：分组可拖（整棵子树一起走）；落点判定「落在行的上半 / 下半」决定插到它前面还是后面。
 */
function GroupRow({
  node,
  expanded,
  onToggle,
  onAddHost,
  onNewSub,
  onMove,
  onRename,
  onDelete,
  onDropHost,
  onDropGroup
}: {
  node: HostGroupNode
  expanded: boolean
  onToggle: () => void
  onAddHost: () => void
  onNewSub: () => void
  onMove: () => void
  onRename: () => void
  onDelete: () => void
  onDropHost: DropHost
  onDropGroup: DropGroup
}): ReactElement {
  const t = useT()
  const group = node.group
  const isEmpty = node.items.length === 0 && node.children.length === 0

  const [{ isDragging }, dragRef] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_GROUP,
      item: { id: group.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [group.id]
  )

  const { ref, over, after } = useRowDrop<HTMLDivElement>(
    DND_HOST,
    DND_GROUP,
    (item) => item.id !== group.id,
    (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, group.id, at)
      else onDropHost(item.id, null, group.id, at)
    },
    dragRef
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          onClick={onToggle}
          className={cn(
            'group/grp relative flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm text-foreground transition-colors hover:bg-foreground/5',
            isDragging && 'opacity-40',
            over && 'bg-primary/10'
          )}
        >
          {over && <DropLine after={after} />}
          {/* 行首图标：与下面的主机行（`size-4`）同宽，同层文字才对得齐 ——
              分组行的箭头搬到名字右边之后，左边空着会让人以为这行是缩进错位 */}
          {expanded && !isEmpty ? (
            <FolderOpen className="size-4 shrink-0" />
          ) : (
            <Folder className="size-4 shrink-0" />
          )}
          <span className="min-w-0 truncate">{group.name}</span>
          {/*
            展开 / 收起箭头：跟着名字走、**平时隐身**，hover 整行（或键盘聚焦到这颗按钮）
            才浮现 —— 与 AI Agent 侧栏的工作区行同一套规矩：侧栏本来就窄，一排常显的箭头
            会跟行首图标抢注意力；整行可点也能展开，箭头只是「这里能展开」的提示。
            触摸端没有 hover，用 `max-md:opacity-100` 常显（那时它是唯一的手势入口）。
          */}
          <button
            type="button"
            aria-label={expanded ? t('收起分组') : t('展开分组')}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
            className={cn(
              'shrink-0 rounded transition-opacity hover:bg-foreground/10',
              'opacity-0 group-hover/grp:opacity-100 focus-visible:opacity-100 max-md:opacity-100'
            )}
          >
            {/* 空分组：箭头压暗表示「点了也不会展开」。⚠️ 压暗要落在**图标**上，
                不能和按钮的 `opacity-0` 并列 —— 两个 opacity 工具类同特异度，
                谁生效取决于产物 CSS 的顺序 */}
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform duration-200',
                expanded && !isEmpty && 'rotate-90',
                isEmpty && 'opacity-30'
              )}
            />
          </button>
          {/* 撑开剩余宽度：名字按自身宽度占位，箭头才跟着名字往右走（与工作区行同款） */}
          <span className="min-w-0 flex-1" />
          {/* hover 浮现的「在此分组添加」：与右键菜单同一组动作的快捷方式（右键是主入口）。
              ⚠️ 用 `group/grp` 这个**具名** group，不能吃行的 `group` —— 行上的 `group`
              还管着主机行的浮层显形，两者混在一起会让「悬停一行时另一类行的按钮也冒出来」。 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('在「{name}」中添加', { name: group.name })}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  ROW_ACTION_CLASS,
                  'shrink-0 opacity-0 group-hover/grp:opacity-100 max-md:opacity-100'
                )}
              >
                <Plus className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem onSelect={onAddHost}>
                <Plus className="size-3.5" />
                {t('在此分组添加主机 / 终端')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onNewSub}>
                <FolderPlus className="size-3.5" />
                {t('新建子分组')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={onAddHost}>
          <Plus className="size-3.5" />
          {t('在此分组添加主机 / 终端')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onNewSub}>
          <FolderPlus className="size-3.5" />
          {t('新建子分组')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onMove}>
          <FolderInput className="size-3.5" />
          {t('移动到…')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRename}>
          <Pencil className="size-3.5" />
          {t('重命名')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-3.5" />
          {t('删除分组')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 主机 / 终端行：图标 + 名称，右键菜单与行尾浮层动作。
 *
 * 行里不再显示连接信息（见文件头），悬停提示就是核对地址的地方。
 *
 * 拖拽：本行可拖；落点判定「落在行的上半 / 下半」决定插到它前面还是后面。
 * 落到一条**有分组**的主机上 = 跟着它进同一个分组；落到未分组的主机上 = 移出分组。
 */
function HostRow({
  host,
  hasGroup,
  onOpen,
  onSftp,
  onTunnels,
  onEdit,
  onMoveOut,
  onDelete,
  onDropHost,
  onDropGroup
}: {
  host: HostConfig
  hasGroup: boolean
  onOpen: () => void
  onSftp: (host: SshHostConfig) => void
  onTunnels: (host: SshHostConfig) => void
  onEdit: () => void
  onMoveOut: () => void
  onDelete: () => void
  onDropHost: DropHost
  onDropGroup: DropGroup
}): ReactElement {
  const t = useT()
  const isLocal = host.kind === 'local'
  // 行里不再显示连接信息（见文件头），悬停提示就是核对地址的地方。
  // 本机终端顺带把**工作目录**也带上：同一个 shell 配两条不同目录的终端很常见，
  // 光看 shell 名分不出来。
  const detail = isLocal
    ? [host.shellName ?? t('默认终端'), host.cwd].filter(Boolean).join(' · ')
    : hostSummary(host)
  const title = isLocal
    ? t('打开 {name} · {detail}', { name: host.name, detail })
    : t('打开 {name} · {detail} · 再点会新开一个标签', { name: host.name, detail })

  const [{ isDragging }, dragRef] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_HOST,
      item: { id: host.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [host.id]
  )

  const { ref, over, after } = useRowDrop<HTMLDivElement>(
    DND_HOST,
    DND_GROUP,
    (item, type) =>
      type === DND_GROUP ? hasGroup && item.id !== host.groupId : item.id !== host.id,
    (item, type, at) => {
      if (type === DND_GROUP) {
        if (hasGroup && host.groupId) onDropGroup(item.id, host.groupId, at)
      } else {
        onDropHost(item.id, host.id, host.groupId, at)
      }
    },
    dragRef
  )

  return (
    /*
      右键菜单（仅 SSH 主机有「SFTP 文件管理」这一项）：本机终端没有
      远端可浏览，所以对它只留「连接 / 编辑 / 删除」三项，菜单结构与
      SSH 主机略有差别 —— 与其给本机终端也摆一个点了就报错的入口，
      不如按类型少列一项。
    */
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          onClick={onOpen}
          onMouseEnter={(e) => revealTruncatedName(e.currentTarget)}
          onMouseLeave={(e) => resetTruncatedName(e.currentTarget)}
          title={title}
          className={cn(
            'group relative flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm text-foreground transition-colors hover:bg-foreground/5',
            isDragging && 'opacity-40',
            over && 'bg-primary/10'
          )}
        >
          {over && <DropLine after={after} />}
          {isLocal ? (
            <SquareTerminal className="size-4 shrink-0" />
          ) : (
            <Server className="size-4 shrink-0" />
          )}
          {/* `data-name-text`：被行尾浮层挤成省略号时由 lib/hover-reveal.ts 滑到行尾。
              **不给**自己的颜色：整行是 `text-muted-foreground`、hover 才加深到
              `text-foreground` —— 与 AI Agent 侧栏的项目行 / 会话行同一套
              （行名比行本身更亮会让侧栏里的灰阶层级乱掉）。 */}
          <div
            data-name-text
            className="min-w-0 flex-1 truncate transition-[padding] group-hover:pe-20 max-md:pe-20"
          >
            {host.name}
          </div>

          {/*
            编辑 / 删除：绝对定位在行尾、hover 整行才浮现（见文件头）。

            ⚠️ `rounded-r-md` 不能省：这层是不透明的渐隐底色，方角压在行上会把行的
            `rounded-md` 右圆角盖掉（表现就是「hover 一行时高亮的右边是直角」）。
            半径与行一致，两段圆弧正好重合 —— 与 `features/plugins/PluginBlocks`、
            `features/notes/NotesSidebar` 的同类浮层同一处理。
          */}
          <div
            className={cn(
              'pointer-events-none absolute right-0 top-0 flex h-full items-center gap-0.5 rounded-r-md pl-4 pr-1.5',
              'bg-gradient-to-l from-sidebar from-70% to-transparent',
              'opacity-0 transition-opacity',
              'group-hover:pointer-events-auto group-hover:opacity-100 max-md:pointer-events-auto max-md:opacity-100'
            )}
          >
            <IconTip label={t('编辑 {name}', { name: host.name })}>
              <button
                type="button"
                aria-label={t('编辑 {name}', { name: host.name })}
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit()
                }}
                className={HOST_ACTION}
              >
                <Pencil className="size-3.5" />
              </button>
            </IconTip>
            <IconTip label={t('删除 {name}', { name: host.name })}>
              <button
                type="button"
                aria-label={t('删除 {name}', { name: host.name })}
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete()
                }}
                className={cn(HOST_ACTION, 'hover:text-destructive')}
              >
                <Trash2 className="size-3.5" />
              </button>
            </IconTip>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={onOpen}>
          {isLocal ? (
            <>
              <SquareTerminal className="size-3.5" />
              {t('打开终端')}
            </>
          ) : (
            <>
              <Server className="size-3.5" />
              {t('连接')}
            </>
          )}
        </ContextMenuItem>
        {/* SFTP 文件管理：只有远端 SSH 主机有文件系统可浏览 */}
        {!isLocal && (
          <ContextMenuItem onSelect={() => onSftp(host)}>
            <FolderOpen className="size-3.5" />
            {t('SFTP 文件管理')}
          </ContextMenuItem>
        )}
        {/* 隧道：同样只有 SSH 主机能承载（本机终端没有可复用的 SSH 连接）。
            打开的是全局隧道面板，并把这台主机预选进「新建隧道」弹窗。 */}
        {!isLocal && (
          <ContextMenuItem onSelect={() => onTunnels(host)}>
            <Network className="size-3.5" />
            {t('隧道…')}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={onEdit}>
          <Pencil className="size-3.5" />
          {t('编辑')}
        </ContextMenuItem>
        {/* 移出分组：只在真的在某个分组里时才给（未分组的条目点了等于什么都没发生） */}
        {hasGroup && (
          <ContextMenuItem onSelect={onMoveOut}>
            <FolderInput className="size-3.5" />
            {t('移出分组')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-3.5" />
          {t('删除')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}