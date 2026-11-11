"use client";

/**
 * 「接口请求」功能区的侧边栏：**保存的请求分组树 + 请求历史**。
 *
 * 从 dogi 的 `features/api/ApiPanel.tsx` 平移，但把 antd（Tree / TreeSelect / Modal /
 * Dropdown / Checkbox / message）全换成 shadcn/ui + `cn()` + sonner —— 本仓库禁用 antd。
 *
 * ## 上半区：分组树 + 请求
 *
 * - 保存的请求按分组树排列（多级分组，DFS 前序），未分组的请求平铺在最后；
 * - 请求 / 分组都可用 react-dnd 拖拽重排（请求可跨组、分组带整棵子树），写回走
 *   `app.arrangeApi`（`ApiArrangeInput`：分组顺序 + 请求归属一次提交）；
 * - 新建请求 / 导入 cURL / 新建子分组 / 移动到… / 重命名 / 删除等动作收在行的悬浮按钮
 *   与右键菜单里（侧栏本来就窄，常驻按钮会把名字挤没）。
 *
 * ## 版式与另外三条侧栏同构
 *
 * **一个分区、两块内容组**（请求 → 历史记录），与 AI Agent 侧栏的「任务 → 工作区」
 * 完全同构：顶部一排整行动作，下面两块可折叠的组共用同一个滚动区。两块组**顺序固定、
 * 各自独立展开**（展开不重排，与 VSCode 侧栏一致）：展开组吃剩余高度，只展开「请求」
 * 时「历史记录」的标题被挤到底部；两组都展开时按上次的位置分（没拖过就 1:1）、
 * 交界处可拖动改比例。
 *
 * 新建类动作（新建请求 / 新建 WebSocket / 导入 cURL / 导入 OpenAPI）在 `SidebarActions`
 * 里平铺；「新建分组」是**分组**的操作，挂在「请求」组标题的 `extra` 上（与主机侧栏那颗
 * 同款）；「清空历史」同理挂在「历史记录」组标题的 `extra` 上。见
 * `shared/components/SidebarGroups`。
 *
 * 早先这几个入口全挤在「请求」标题行右侧的两颗 28px 图标里（一颗直接建分组、一颗弹
 * 4 项菜单），260px 宽的标题行里标题被压得只剩几个字，两颗图标还看不出区别。
 *
 * ## 历史记录（第二块组）
 *
 * 发送请求后自动记录（`ApiHistoryEntry`，最多 50 条，见 ApiPage）。点一行 = 载入成
 * 一个**未保存草稿**（经 `api-draft.ts` 的模块级种子传给 ApiPage）。
 *
 * 按天分桶（今天 / 昨天 / 某月某日），日期是**组内的小标签**，不是第二个分区 ——
 * 原先它自己是一个 `SectionShell`，带自己的标题栏和一条可拖边界，与 AI Agent 的形态
 * 不是一回事。
 *
 * ## 打开落点
 *
 * 点请求 / 历史都往**主区域**开一个 `api:` 内容标签（`tool-tabs.ts`），所以先
 * `useEnsureChatView()` 把用户切到会渲染面板的**对话视图**上（面板只在对话视图渲染）。
 *
 * ## 已覆盖范围
 *
 * HTTP 与 WebSocket（「新建 WebSocket」是动作区里独立的一行，`protocol: 'ws'` 的
 * 条目也在这棵树里，点开由 `PanelView` 按 protocol 分发到 WsPage）。导入两条路也都在
 * 动作区：cURL（粘贴命令，`parseCurl`）与 OpenAPI / Swagger（`OpenApiImportModal`，
 * 选文件或抓 URL，按 tag 建组 + 建请求）。
 *
 * ## 骨架（没有顶部栏）
 *
 * 外壳（宽度 / 手机抽屉）+ 分区容器整段交给 `shared/components/SidebarScaffold`
 * —— 四个功能区侧栏共用同一份骨架。这里只声明那**一个**分区的内容。
 *
 * **顶上没有「接口请求」那条顶栏了**：与 AI Agent / 主机三条侧栏对齐，第一行就是
 * 动作区（理由见 `SidebarScaffold`）。原先那条写着面板名，作用只是把活动栏图标的
 * 提示词又抄一遍，还让几条侧栏的顶部差一整条栏的高度。
 *
 * ⚠️ 分区**不能折叠**（`SectionShell` 早就没有折叠能力，见 `StackedSections` 的文件头）：
 * 能折叠的只有里面那两块内容组。
 *
 * 「收起 / 关闭侧栏」那颗按钮也不出现在这条侧栏里 —— 收起 / 展开走活动栏那颗当前
 * 功能区的图标，手机另有遮罩可点。
 */
import { useMemo, useState } from 'react'
import { useDrag } from 'react-dnd'
import {
  Cable,
  ChevronRight,
  CirclePlus,
  Eraser,
  FileJson,
  Folder,
  FolderInput,
  FolderPlus,
  Globe,
  Pencil,
  Plus,
  Terminal,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
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
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { SidebarScaffold } from '@fizz/agent-kit/shared/components/SidebarScaffold'
import { SectionContent, SectionShell } from '@fizz/agent-kit/shared/components/StackedSections'
// 内容组（请求）+ 顶部动作区：与 AI Agent / 主机 / 笔记侧栏共用同一份，见
// `shared/components/SidebarGroups` —— 高度策略（封顶 / 吃剩余）也在那边，别在这里各写一遍。
import {
  SidebarAction,
  SidebarActions,
  SidebarGroup
} from '@fizz/agent-kit/shared/components/SidebarGroups'
import { API_REQUESTS_SECTION } from '@fizz/agent-kit/shared/lib/section-ids'
import { openApiDraftTab, openApiTab, openWsDraftTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { activeTabKey, usePanelState } from '@fizz/agent-kit/shared/lib/panel-store'
import { treeIndent } from '@fizz/agent-kit/shared/lib/tree-indent'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { ROW_ACTION_CLASS, RowActionButton } from '@fizz/agent-kit/shared/components/RowAction'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { parseCurl, methodClass } from '@fizz/agent-kit/features/api/api-client'
import { OpenApiImportModal } from '@fizz/agent-kit/features/api/OpenApiImportModal'
import { setApiDraftSeed } from '@fizz/agent-kit/features/api/api-draft'
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
import type {
  ApiGroup,
  ApiHistoryEntry,
  ApiRequestEntry
} from '@fizz/contracts/types'

/** react-dnd 拖拽类型：请求 / 分组各一种，落点按类型分别处理 */
const DND_REQUEST = 'api-request'
const DND_GROUP = 'api-group'

/** 一个列表块：`groupId` 为空 = 未分组块。数组顺序即 DFS 前序显示顺序 */
interface Block {
  groupId?: string
  items: ApiRequestEntry[]
}

/** 本功能区在泛型分组树上的具体实例（树模型纯函数见 `@/shared/lib/group-tree`） */
type ApiGroupNode = GroupNode<ApiGroup, ApiRequestEntry>

/**
 * 分组 Select 的「顶级」哨兵值。
 *
 * Radix Select **不允许**空字符串当 `value`（会当成「无值」而显示占位符），
 * 所以「顶级分组」用一个不可能撞车的哨兵字符串代表。
 */
const TOP_GROUP = '__top__'

/**
 * 「未分组」哨兵值（请求归属用）。
 *
 * 与 `TOP_GROUP` 刻意分开：那个是**分组层级**里的「顶级分组」（一个真实层级，分组能挂上去），
 * 这个是「不属于任何分组」。Radix Select 不允许空字符串当 `value`，所以两者都得用哨兵。
 */
const NO_GROUP = '__none__'

/** 请求的副标题：优先展示地址，没填地址时给个提示 */
function subtitleOf(req: ApiRequestEntry): string {
  const url = req.url.trim()
  return url || (req.protocol === 'ws' ? '尚未填写连接地址' : '尚未填写请求地址')
}

/** 历史记录按天分桶的标签：今天 / 昨天 / M月D日（更早的按具体日期） */
function dayBucket(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays <= 0) return '今天'
  if (diffDays === 1) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 历史行的完整时间（悬停提示用） */
function formatFullTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function ApiPanel({
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
  return (
    /*
      骨架（外壳 + 分区容器）在 `SidebarScaffold` 里，四个功能区侧栏共用 ——
      这里只填**一个**分区（没有顶部栏，第一行就是动作区）。
    */
    <SidebarScaffold
      width={width}
      mobileOpen={mobileOpen}
      onMobileOpenChange={onMobileOpenChange}
    >
      {/*
        一个分区、两块内容组（请求 → 历史记录）—— 与 AI Agent 侧栏的「任务 → 工作区」
        同构：两块共用一个滚动区，顺序固定、各自独立展开；两组都展开时按 `grow` 分
        剩余高度（没拖过就 1:1），交界处可上下拖。

        ⚠️ 两块组在同一个 `SectionShell` 里，所以它们**必须**由同一个组件渲染出来
        （动作区的 4 个入口要用请求那块的状态）—— 历史那块的 UI 仍是独立组件，
        作为第二块组挂在 `ApiSidebarBody` 的内容区里，见那边的注释。
      */}
      <ApiSidebarBody app={app} />
    </SidebarScaffold>
  )
}

/** 分组树的一个显示行 */
type TreeRow =
  | { kind: 'group'; node: ApiGroupNode; depth: number }
  | { kind: 'request'; request: ApiRequestEntry; depth: number; hasGroup: boolean }

/**
 * 侧栏主体：**一个分区**装两块内容组 —— 请求（分组树）→ 历史记录。
 *
 * 与 AI Agent 侧栏的「任务 → 工作区」同构（见 `shared/components/SidebarGroups`）：
 * 顶部是一排整行动作，下面是两块内容组，共用同一个滚动区。
 * 两块组**顺序固定、各自独立展开**（展开不重排）：展开组吃剩余高度，只展开「请求」
 * 时「历史记录」的标题被挤到底部；两组都展开时按上次的位置分（没拖过就 1:1）、
 * 交界处可拖动改比例。
 *
 * 为什么两块组挤在同一个组件里：动作区那 4 个「新建 / 导入」入口要用请求这块的状态
 * （草稿、cURL 弹窗、OpenAPI 弹窗），而 `SidebarActions` 必须是 `SectionContent` 的
 * **兄弟**节点、不能塞进组里。历史那块的 UI 仍然是独立组件（`HistorySection`），
 * 作为第二块组挂在这里的内容区。
 *
 * 请求那块的分区头不再有按钮：新建 / 导入提到动作区，「新建分组」挂到组标题的 `extra`
 * （与主机侧栏那颗同款）。分区头只管这个分区自己 ——「这是什么功能区」由活动栏那颗
 * 图标表达（顶栏已删，见 `ApiPanel`）。
 */
function ApiSidebarBody({ app }: { app: AgentApp }) {
  const panelState = usePanelState()
  const activeKey = activeTabKey(panelState)

  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  /** 待确认删除的请求 / 分组 */
  const [pendingDelete, setPendingDelete] = useState<ApiRequestEntry | null>(null)
  const [pendingGroupDelete, setPendingGroupDelete] = useState<ApiGroup | null>(null)
  const [deleteGroupRequests, setDeleteGroupRequests] = useState(false)

  /** 新建（id 空）/ 重命名分组；parentId 只在新建子分组时带 */
  const [groupEdit, setGroupEdit] = useState<{ id?: string; name: string; parentId?: string } | null>(
    null
  )
  /**
   * 改「分组 + 名称」弹窗（请求行那颗编辑按钮）：**临时值**，点「确定」才写库。
   * 这一行是**已保存**的请求，没有「草稿」概念 —— 确定即直接落盘，不经过详情页的「保存」。
   */
  const [metaTarget, setMetaTarget] = useState<ApiRequestEntry | null>(null)
  const [metaName, setMetaName] = useState('')
  const [metaGroupId, setMetaGroupId] = useState<string | undefined>(undefined)

  /** 「移动到…」弹窗 */
  const [moveTarget, setMoveTarget] = useState<ApiGroup | null>(null)
  const [moveParent, setMoveParent] = useState<string>(TOP_GROUP)
  /** OpenAPI / Swagger 导入弹窗 */
  const [openApiOpen, setOpenApiOpen] = useState(false)
  /** cURL 导入弹窗 */
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [curlGroupId, setCurlGroupId] = useState<string | undefined>(undefined)
  const [importing, setImporting] = useState(false)

  const groups = app.apiGroups
  const requests = app.apiRequests

  /**
   * 两块内容组（请求 / 历史记录）的展开态与高度：**顺序固定、各自独立展开**，
   * 可以同时展开（与 VSCode 侧栏一致，展开不重排）。展开组用 `size="fill"` 吃剩余
   * 高度，所以只展开「请求」时「历史记录」的标题被挤到底部；两组都展开时按上次的
   * 位置分（没拖过就 1:1），交界处可拖动改比例（`requestsHeight`）。拖出来的高度
   * **不被折叠清掉**：只剩请求组时高度值照传、由 `solo` 让它吃满（basis 仍是记住的
   * 像素）；历史记录再展开回来仍落回上次的位置。折叠态与高度只存内存，刷新回默认。
   */
  const [requestsOpen, setRequestsOpen] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(true)
  const [requestsHeight, setRequestsHeight] = useState<number | undefined>(undefined)
  /** 只有两组都展开时「请求」组才需要「固定高度 + 分隔条」（只剩它时吃满剩余高度） */
  const requestsResizable = requestsOpen && historyOpen

  /** 点组标题：只切展开态 —— 拖出来的高度不清，再展开时要回到那个位置 */
  const toggleRequests = (): void => {
    setRequestsOpen((v) => !v)
  }
  const toggleHistory = (): void => {
    setHistoryOpen((v) => !v)
  }

  const groupTree = useMemo(() => buildGroupTree(groups, requests), [groups, requests])
  const ungrouped = useMemo(() => collectUngrouped(requests, groups), [requests, groups])
  /** 完整的块结构（拖拽落点计算一律用它，与搜索过滤无关） */
  const blocks = useMemo(() => flattenBlocks(groupTree, ungrouped), [groupTree, ungrouped])

  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  const hitRequest = (r: ApiRequestEntry): boolean =>
    !searching ||
    r.name.toLowerCase().includes(q) ||
    r.url.toLowerCase().includes(q) ||
    r.method.toLowerCase().includes(q)

  /** 搜索时过滤分组树：组名命中 = 整组保留；否则只留命中的请求 / 子孙分组 */
  const filterNode = (n: ApiGroupNode): { node: ApiGroupNode; hit: boolean } => {
    const childResults = n.children.map(filterNode)
    const keptChildren = childResults.filter((r) => r.hit).map((r) => r.node)
    const nameHit = n.group.name.toLowerCase().includes(q)
    const keptItems = searching ? n.items.filter(hitRequest) : n.items
    const hit = !searching || nameHit || keptItems.length > 0 || keptChildren.length > 0
    return { node: { group: n.group, children: keptChildren, items: keptItems }, hit }
  }
  const viewTree = searching
    ? groupTree.map(filterNode).filter((r) => r.hit).map((r) => r.node)
    : groupTree
  const viewUngrouped = searching ? ungrouped.filter(hitRequest) : ungrouped

  /** 把树摊平成显示行（搜索时全部展开，平时按 expanded 展开） */
  const rows = useMemo((): TreeRow[] => {
    const out: TreeRow[] = []
    const walk = (nodes: ApiGroupNode[], depth: number): void => {
      for (const n of nodes) {
        const isEmpty = n.items.length === 0 && n.children.length === 0
        out.push({ kind: 'group', node: n, depth })
        if (isEmpty) continue
        if (!searching && !expanded.has(n.group.id)) continue
        walk(n.children, depth + 1)
        for (const r of n.items) out.push({ kind: 'request', request: r, depth: depth + 1, hasGroup: true })
      }
    }
    walk(viewTree, 0)
    for (const r of viewUngrouped) {
      out.push({ kind: 'request', request: r, depth: 0, hasGroup: false })
    }
    return out
  }, [viewTree, viewUngrouped, expanded, searching])

  /** 在完整块结构里按请求 id 定位 */
  const locate = (list: Block[], id: string): { b: number; i: number } | null => {
    for (let b = 0; b < list.length; b++) {
      const i = list[b].items.findIndex((r) => r.id === id)
      if (i >= 0) return { b, i }
    }
    return null
  }

  /** 把调整后的块结构整体写回（顺序 + 归属一次提交，避免中间态） */
  const commit = (next: Block[]): void => {
    const groupOrder: ApiGroup[] = []
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
    void app.arrangeApi({
      groups: groupOrder.map((g) => ({ id: g.id, parentId: g.parentId })),
      requests: next.flatMap((b) => b.items.map((r) => ({ id: r.id, groupId: b.groupId })))
    })
  }

  /** 请求拖拽落点：插到目标请求前 / 后；targetId 为空时追加到目标分组末尾 */
  const dropRequest = (
    dragId: string,
    targetId: string | null,
    targetGroupId: string | undefined,
    after: boolean
  ): void => {
    const next = blocks.map((b) => ({ groupId: b.groupId, items: [...b.items] }))
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
    const blk = next.findIndex((b) => b.groupId === targetGroupId)
    if (blk < 0) return
    next[blk].items.push(moved)
    commit(next)
  }

  /** 分组拖拽落点：移到目标分组前 / 后（同一层级内调整顺序，整棵子树一起走） */
  const dropGroup = (dragId: string, targetGroupId: string, after: boolean): void => {
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
    const firstGroup = next.findIndex((b) => b.groupId)
    if (firstGroup >= 0 && to < firstGroup) to = firstGroup
    next.splice(to, 0, ...run)
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

  /** 展开某分组的父链（让新建 / 移动后的分组立刻可见） */
  const expandAncestors = (gid?: string): void => {
    if (!gid) return
    const byId = new Map(groups.map((g) => [g.id, g]))
    const chain: string[] = []
    let cur: ApiGroup | undefined = byId.get(gid)
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      chain.push(cur.id)
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    if (chain.length) setExpanded((prev) => new Set([...prev, ...chain]))
  }

  /** 打开一个已保存的请求标签 */
  const openRequest = (req: ApiRequestEntry): void => {
    openApiTab(req)
  }

  /** 新建：只开一个未保存草稿标签（真正落盘在 ApiPage 里按 Ctrl/Cmd+S） */
  const openDraft = (): void => {
    openApiDraftTab()
  }

  /** 新建 WebSocket：开一个未保存的连接草稿标签（真正落盘在 WsPage 里按 Ctrl/Cmd+S） */
  const openWsDraft = (): void => {
    openWsDraftTab()
  }

  const removeRequest = async (target: ApiRequestEntry): Promise<void> => {
    const ok = await app.deleteApiRequest(target.id)
    if (ok) toast.success('已删除该请求')
  }

  const submitGroupEdit = async (): Promise<void> => {
    const name = groupEdit?.name.trim()
    if (!groupEdit || !name) return
    const ok = await app.saveApiGroup({
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
    const alsoRequests = deleteGroupRequests
    const fallbackName =
      (target.parentId && groups.find((g) => g.id === target.parentId)?.name) ?? '未分组'
    setPendingGroupDelete(null)
    setDeleteGroupRequests(false)
    const ok = await app.deleteApiGroup(target.id, alsoRequests)
    if (ok) {
      toast.success(
        `已删除分组「${target.name}」：${alsoRequests ? '组内及子分组请求已一并删除' : `组内及子分组请求已移到「${fallbackName}」`
        }`
      )
    }
  }

  /** 请求行那颗编辑按钮：把这一行当前的分组 / 名称灌进弹窗（取消不写回） */
  const openRequestMeta = (target: ApiRequestEntry): void => {
    setMetaName(target.name)
    setMetaGroupId(target.groupId)
    setMetaTarget(target)
  }

  /**
   * 弹窗确定：名称走 `saveApiRequest`、分组归属走 `arrangeApi`，**两条路都得走**。
   *
   * 分组不能顺手塞进 `saveApiRequest`：`groupId` 为 `undefined` 时 JSON 会把这个键整个丢掉，
   * 服务端 `{ ...prev, ...input }` 于是把老分组继承回来 —— 「改成未分组」会静默失败。
   * 契约里也写明 `groupId` 只由 arrange 改（见 `ApiRequestEntry.groupId` 的注释）。
   */
  const submitRequestMeta = async (): Promise<void> => {
    const target = metaTarget
    if (!target) return
    const name = metaName.trim()
    const groupId = metaGroupId
    setMetaTarget(null)
    // 只改动的字段才发请求 / 才提一句：没改就点「确定」不该写库，也不该弹「已更新」
    const changed: string[] = []
    if (name !== target.name) {
      const ok = await app.saveApiRequest({ ...target, name })
      if (!ok) return
      changed.push('名称')
    }
    if (groupId !== target.groupId) {
      const ok = await app.arrangeApi({
        groups: groups.map((g) => ({ id: g.id, parentId: g.parentId })),
        requests: requests.map((r) => ({
          id: r.id,
          groupId: r.id === target.id ? groupId : r.groupId
        }))
      })
      if (!ok) return
      changed.push('分组')
    }
    if (changed.length) toast.success(`已更新${changed.join(' / ')}`)
  }

  const confirmMoveGroup = async (): Promise<void> => {
    const target = moveTarget
    if (!target) return
    const parentId = moveParent === TOP_GROUP ? undefined : moveParent
    setMoveTarget(null)
    if (parentId === target.parentId) return
    const nextGroups = moveGroup(groups, target.id, parentId)
    const ok = await app.arrangeApi({
      groups: nextGroups.map((g) => ({ id: g.id, parentId: g.parentId })),
      requests: requests.map((r) => ({ id: r.id, groupId: r.groupId }))
    })
    if (ok) {
      if (parentId) expandAncestors(parentId)
      toast.success(`已移动「${target.name}」${parentId ? '到所选分组下' : '到顶级分组'}`)
    }
  }

  /** 把一个请求移出到「未分组」（只改该请求的归属，保持其它顺序不变） */
  const moveOutOfGroup = (req: ApiRequestEntry): void => {
    void app.arrangeApi({
      groups: groups.map((g) => ({ id: g.id, parentId: g.parentId })),
      requests: requests.map((r) => ({
        id: r.id,
        groupId: r.id === req.id ? undefined : r.groupId
      }))
    })
  }

  /** 导入 cURL：解析成一条新的保存请求并打开它的标签（从分组发起时落到该组） */
  const handleImportCurl = async (): Promise<void> => {
    let parsed: ReturnType<typeof parseCurl>
    try {
      parsed = parseCurl(curlText)
    } catch (e) {
      toast.error('导入失败：' + (e instanceof Error ? e.message : String(e)))
      return
    }
    setImporting(true)
    try {
      const before = new Set(requests.map((r) => r.id))
      const ok = await app.saveApiRequest({
        id: '',
        name: parsed.url,
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body,
        bodyType: parsed.bodyType,
        bodyFormFields: parsed.bodyFields,
        groupId: curlGroupId,
        createdAt: 0,
        updatedAt: 0
      })
      if (!ok) return
      const created = useAgentStore.getState().apiRequests.find((r) => !before.has(r.id))
      if (created) openRequest(created)
      setCurlOpen(false)
      setCurlText('')
      setCurlGroupId(undefined)
      toast.success('已导入 cURL 命令')
    } finally {
      setImporting(false)
    }
  }

  const pendingSubtreeRequestCount = pendingGroupDelete
    ? countSubtreeItems(groups, requests, pendingGroupDelete.id)
    : 0

  const isEmpty = requests.length === 0 && groups.length === 0
  const noMatch = searching && rows.length === 0

  /**
   * 两块内容组按**固定顺序**渲染（请求在前、历史记录在后）：展开 / 收起不会重排，
   * 与 VSCode 侧栏一致。展开组吃剩余高度，所以只展开「请求」时「历史记录」的标题
   * 会被挤到底部；两组都展开时按上次的位置分（没拖过就 1:1，拖过按记住的像素
   * 高度），请求组底部出现可拖的分隔条。
   */
  const requestsGroup = (
    <SidebarGroup
      title="请求"
      count={requests.length}
      alignIndent
      open={requestsOpen}
      onToggle={toggleRequests}
      // 展开时吃剩余高度；只展开这一组时下面那行标题自然沉到底部
      size="fill"
      // 记住的高度**一直传**（历史记录收起时也不清）：`SidebarGroup` 在只剩本组时把
      // 它当弹性基准（`1 1 Hpx`）继续长满，另一组再展开只改 grow、basis 恒为 H ——
      // 展开动画单调，不会先冲高再缩回（见 `SidebarGroup` 的 `height` 注释）
      height={requestsHeight}
      // 历史记录收起时本组是唯一展开的组：吃满剩余高度
      solo={!requestsResizable}
      onResizeHeight={requestsResizable ? setRequestsHeight : undefined}
      // 搜索框常驻在组内、不跟着列表滚 —— 所以容器不滚，由 children 自己分：
      // 「搜索框（shrink-0） + 列表（flex-1 自己滚）」，见 `SidebarGroup` 的 `scroll`
      scroll={false}
      // 只留底部内边距：横向的由外层容器统一给（见上面那段注释）
      className="pb-1"
      // 「新建分组」跟着**这一组**的标题走（它建的就是这里的一级分组），
      // 与主机侧栏那颗同款：标题行只有 32px 高、标签是 12px 灰字，用大按钮会喧宾夺主
      extra={
        <IconTip label="新建分组">
          <RowActionButton
            aria-label="新建分组"
            className="shrink-0"
            onClick={() => setGroupEdit({ name: '' })}
          >
            <FolderPlus className="size-3.5" />
          </RowActionButton>
        </IconTip>
      }
      // 空态**不用** `empty`：那个属性会把组里的 children 整块换掉，搜索框跟着消失。
      // 这里把空态卡片放进下面的列表区，搜索框始终在位（布局不跳）。
    >
      {/* 搜索框常驻在组内、**不跟着列表滚**（组容器 `scroll={false}`，见上）；
          没有横向内边距：外框与行的高亮底色都从外层容器的 8px 起 */}
      <div className="shrink-0 pb-1.5">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索请求…"
          className="h-8 text-sm"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto no-scrollbar">
        {isEmpty ? (
          <div className="mx-1 mt-2 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs leading-5">
            还没有保存的请求。
          </div>
        ) : noMatch ? (
          <div className="mx-1 mt-6 rounded-md px-3 py-6 text-center text-xs text-muted-foreground">
            没有匹配「{search}」的请求。
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {rows.map((row) =>
              row.kind === 'group' ? (
                <GroupRow
                  key={`g:${row.node.group.id}`}
                  node={row.node}
                  depth={row.depth}
                  expanded={expanded.has(row.node.group.id)}
                  searching={searching}
                  onToggle={() => toggleExpand(row.node.group.id)}
                  onNewRequest={() => openDraft()}
                  onImportCurl={() => {
                    setCurlGroupId(row.node.group.id)
                    setCurlOpen(true)
                  }}
                  onNewSub={() => {
                    setGroupEdit({ name: '', parentId: row.node.group.id })
                    expandAncestors(row.node.group.id)
                  }}
                  onMove={() => {
                    setMoveParent(row.node.group.parentId ?? TOP_GROUP)
                    setMoveTarget(row.node.group)
                  }}
                  onRename={() =>
                    setGroupEdit({ id: row.node.group.id, name: row.node.group.name })
                  }
                  onDelete={() => {
                    setDeleteGroupRequests(false)
                    setPendingGroupDelete(row.node.group)
                  }}
                  onDropRequest={dropRequest}
                  onDropGroup={dropGroup}
                />
              ) : (
                <RequestRow
                  key={`r:${row.request.id}`}
                  request={row.request}
                  depth={row.depth}
                  hasGroup={row.hasGroup}
                  active={activeKey === `api:${row.request.id}`}
                  onOpen={() => openRequest(row.request)}
                  onEdit={() => openRequestMeta(row.request)}
                  onMoveOut={() => moveOutOfGroup(row.request)}
                  onDelete={() => setPendingDelete(row.request)}
                  onDropRequest={dropRequest}
                  onDropGroup={dropGroup}
                />
              )
            )}
          </div>
        )}
      </div>
    </SidebarGroup>
  )

  /** 第二块：请求历史（与请求组同一个滚动区、同一套组标题与行样式，见 `HistorySection`） */
  const historyGroup = (
    <HistorySection app={app} open={historyOpen} onToggle={toggleHistory} />
  )

  return (
    <SectionShell spec={API_REQUESTS_SECTION} minHeight={280}>
      {/*
        版式与 AI Agent / 主机 / 笔记侧栏**同构**（`shared/components/SidebarGroups`）：
        一个 `SectionShell` 里自上而下是「顶部动作 → 请求组 → 历史记录组」，两块组共用
        一个滚动区、**顺序固定且各自独立展开**（与 VSCode 侧栏一致，展开不会重排）；
        展开的组用 `size="fill"` 分剩余高度，两组都展开时交界处可拖动改比例。
        外层只在窗口极矮时兜底滚一次。

        原先标题行右侧挤着两颗 28px 的 ghost 图标（「新建分组」「新建 / 导入」）—— 标题行
        只有 260px 宽，它们把「请求 (n)」压得只剩几个字，而且两颗图标大小一样、一个是
        「建一个分组」一个是「弹一个 4 项菜单」，完全看不出区别。现在拆成两处：

        - 新建 / 导入类动作提到分区顶部做整行（`SidebarActions`），4 个动作**平铺** ——
          整行动作区里没有下拉的位置（`SidebarAction` 就是一颗按钮），而且这 4 个都是
          「从无到有」，平铺比藏进菜单更好找；
        - 「新建分组」是**分组**的操作，跟着「请求」那行更顺（在 `SidebarGroup` 的
          `extra` 里，与主机侧栏那颗「新建分组」同款）。

        ⚠️ `minHeight` 提到 280：动作区 4 行（约 146px）+ 两块组标题（64px）+ 请求组的
        搜索框（48px）之后，下限还得留出「至少一行请求」。
      */}
      <SidebarActions>
        {/* 「新建请求」与 AI Agent 的「新对话」同一颗 `CirclePlus` —— 同为「从无到有」
            的动作，行首图标一致，四条侧栏的动作区才是同一套语言 */}
        <SidebarAction icon={CirclePlus} label="新建请求" onClick={() => openDraft()} />
        <SidebarAction icon={Cable} label="新建 WebSocket" onClick={() => openWsDraft()} />
        <SidebarAction
          icon={Terminal}
          label="导入 cURL"
          onClick={() => {
            setCurlGroupId(undefined)
            setCurlOpen(true)
          }}
        />
        <SidebarAction
          icon={FileJson}
          label="导入 OpenAPI / Swagger"
          onClick={() => setOpenApiOpen(true)}
        />
      </SidebarActions>

      <SectionContent>
        {/* **外层兜底滚动容器**（与另外三条侧栏同构）：展开组自己滚，这层只在窗口极矮、
            组的 `minHeight` 放不下时才兜底滚一次。

            `px-2` 在**这一层**、不在组上（与主机侧栏一模一样）：组标签自带 `px-2`，
            所以标签落在 16px；行落在 8 + 6（`treeIndent` 的 6px 基准）= 14px。 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto no-scrollbar px-2">
          {/*
            固定顺序：请求 → 历史记录（与 VSCode 侧栏一致，展开不重排）。
            两个元素的内容与注释在 `return` 之前的 `requestsGroup` / `historyGroup` 里。
          */}
          {requestsGroup}
          {historyGroup}
        </div>
      </SectionContent>

      {/* 新建 / 重命名 / 新建子分组 */}
      <Dialog open={groupEdit !== null} onOpenChange={(o) => !o && setGroupEdit(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>
              {groupEdit?.id ? '重命名分组' : groupEdit?.parentId ? '新建子分组' : '新建分组'}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {!groupEdit?.id && (
              <Select
                value={groupEdit?.parentId ?? TOP_GROUP}
                onValueChange={(v) =>
                  setGroupEdit((g) => (g ? { ...g, parentId: v === TOP_GROUP ? undefined : v } : g))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="父分组（缺省为顶级分组）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TOP_GROUP}>顶级分组</SelectItem>
                  {flatGroupOptions(groupTree).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      <span style={{ paddingLeft: treeIndent(o.depth, 12, 0) }}>{o.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input
              autoFocus
              value={groupEdit?.name ?? ''}
              placeholder="分组名称，如：用户服务"
              onChange={(e) => setGroupEdit((g) => (g ? { ...g, name: e.target.value } : g))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitGroupEdit()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGroupEdit(null)}>
              取消
            </Button>
            <Button disabled={!groupEdit?.name.trim()} onClick={() => void submitGroupEdit()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 改请求的分组与名称：请求行那颗编辑按钮点开；确定即落盘（见 submitRequestMeta） */}
      <Dialog open={metaTarget !== null} onOpenChange={(o) => !o && setMetaTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>修改分组与名称</DialogTitle>
            <DialogDescription>确定后立即生效，不需要再去详情页按「保存」。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="api-req-group">分组</Label>
              <Select
                value={metaGroupId ?? NO_GROUP}
                onValueChange={(v) => setMetaGroupId(v === NO_GROUP ? undefined : v)}
              >
                <SelectTrigger id="api-req-group" className="w-full">
                  <SelectValue placeholder="未分组" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_GROUP}>未分组</SelectItem>
                  {flatGroupOptions(groupTree).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      <span style={{ paddingLeft: treeIndent(o.depth, 12, 0) }}>{o.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="api-req-name">名称</Label>
              <Input
                id="api-req-name"
                autoFocus
                value={metaName}
                placeholder="请求名称，留空则显示「方法 + 路径」"
                onChange={(e) => setMetaName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRequestMeta()
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMetaTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void submitRequestMeta()}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 移动到…：分组跨层级移动（带着整棵子树） */}
      <Dialog open={moveTarget !== null} onOpenChange={(o) => !o && setMoveTarget(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>移动分组「{moveTarget?.name ?? ''}」</DialogTitle>
            <DialogDescription>
              选择新的父分组：选「顶级分组」把它移到最外层；该分组连同所有子分组一起移动。
            </DialogDescription>
          </DialogHeader>
          <Select value={moveParent} onValueChange={setMoveParent}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择父分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TOP_GROUP}>顶级分组</SelectItem>
              {flatGroupOptions(
                groupTree,
                moveTarget ? subtreeOf(groups, moveTarget.id) : undefined
              ).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span style={{ paddingLeft: treeIndent(o.depth, 12, 0) }}>{o.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoveTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void confirmMoveGroup()}>移动</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除分组：确认 + 「是否连同组内请求一起删」勾选项（ConfirmDeleteDialog 塞不下 Checkbox） */}
      <Dialog
        open={pendingGroupDelete !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingGroupDelete(null)
            setDeleteGroupRequests(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>删除分组？</DialogTitle>
          </DialogHeader>
          {/* wrap-anywhere：分组名可能是无空格的长英文，不加会把 grid 轨道撑宽、按钮推出弹窗 */}
          <p className="text-sm wrap-anywhere text-muted-foreground">
            「{pendingGroupDelete?.name}」将被删除（连同所有子分组）
            {pendingSubtreeRequestCount > 0 ? `，其中共 ${pendingSubtreeRequestCount} 个请求。` : '。'}
          </p>
          {pendingSubtreeRequestCount > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={deleteGroupRequests}
                onCheckedChange={(v) => setDeleteGroupRequests(v === true)}
              />
              同时删除组内及子分组的请求
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            {deleteGroupRequests
              ? '请求将一并删除，该操作不可撤销。'
              : '不勾选时，请求会随子孙分组一起上移一级（删除顶级分组则回到「未分组」）。'}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingGroupDelete(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmGroupDelete()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* OpenAPI / Swagger 导入（选文件 / 抓 URL → 预览 → 建组 + 建请求） */}
      <OpenApiImportModal
        app={app}
        open={openApiOpen}
        onClose={() => setOpenApiOpen(false)}
        onImported={openRequest}
      />

      {/* cURL 导入 */}
      <Dialog
        open={curlOpen}
        onOpenChange={(o) => {
          if (!o) {
            setCurlOpen(false)
            setCurlGroupId(undefined)
          }
        }}
      >
        <DialogContent className="sm:max-w-[576px]">
          <DialogHeader>
            <DialogTitle>导入 cURL 命令</DialogTitle>
            <DialogDescription>
              {curlGroupId
                ? '粘贴 curl 命令，解析后保存为一条新请求并放入当前分组'
                : '粘贴 curl 命令，解析后保存为一条新的请求并打开'}
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={curlText}
            onChange={(e) => setCurlText(e.target.value)}
            placeholder={'curl -X POST https://api.example.com/users \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"foo"}\''}
            spellCheck={false}
            className="h-48 w-full resize-none rounded-md border border-input bg-transparent p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setCurlOpen(false)
                setCurlGroupId(undefined)
              }}
            >
              取消
            </Button>
            <Button disabled={!curlText.trim() || importing} onClick={() => void handleImportCurl()}>
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除请求 */}
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        title="删除接口请求？"
        description={
          pendingDelete
            ? `「${pendingDelete.name.trim() || pendingDelete.url || '未命名请求'}」将被永久删除，该操作不可撤销。`
            : ''
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) void removeRequest(target)
        }}
      />
    </SectionShell>
  )
}

/** 分组树摊平成带缩进层级的选择项（Select 用；exclude 排除目标自己 / 子孙） */
function flatGroupOptions(
  nodes: ApiGroupNode[],
  exclude?: Set<string>,
  depth = 0
): Array<{ value: string; label: string; depth: number }> {
  const out: Array<{ value: string; label: string; depth: number }> = []
  for (const n of nodes) {
    if (exclude?.has(n.group.id)) continue
    out.push({ value: n.group.id, label: n.group.name, depth })
    out.push(...flatGroupOptions(n.children, exclude, depth + 1))
  }
  return out
}

/** 拖拽落点处理函数签名（请求 / 分组共用） */
type DropRequest = (
  dragId: string,
  targetId: string | null,
  targetGroupId: string | undefined,
  after: boolean
) => void
type DropGroup = (dragId: string, targetGroupId: string, after: boolean) => void

/** 分组行：可拖动排序（整棵子树）、可右键、行内有「+」新建下拉 */
function GroupRow({
  node,
  depth,
  expanded,
  searching,
  onToggle,
  onNewRequest,
  onImportCurl,
  onNewSub,
  onMove,
  onRename,
  onDelete,
  onDropRequest,
  onDropGroup
}: {
  node: ApiGroupNode
  depth: number
  expanded: boolean
  searching: boolean
  onToggle: () => void
  onNewRequest: () => void
  onImportCurl: () => void
  onNewSub: () => void
  onMove: () => void
  onRename: () => void
  onDelete: () => void
  onDropRequest: DropRequest
  onDropGroup: DropGroup
}) {
  const group = node.group
  const isEmpty = node.items.length === 0 && node.children.length === 0

  const [{ isDragging }, drag] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({ type: DND_GROUP, item: { id: group.id }, collect: (m) => ({ isDragging: m.isDragging() }) }),
    [group.id]
  )

  const { ref, over, after } = useRowDrop<HTMLDivElement>(
    DND_REQUEST,
    DND_GROUP,
    (item) => item.id !== group.id,
    (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, group.id, at)
    },
    drag
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          className={cn(
            'group/grow relative flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1.5 text-sm text-foreground transition-colors hover:bg-primary-soft',
            isDragging && 'opacity-40'
          )}
          style={{ paddingLeft: treeIndent(depth) }}
          onClick={onToggle}
        >
          {over && <DropLine after={after} />}
          {/*
            行首图标：分组行原先**没有**图标（那一格站的是展开箭头）。箭头搬到名字右侧
            之后这一格就空了，补一个文件夹图标 —— 一是与笔记 / 主机的分组行同一档，
            二是分组收起时仍看得出「这是一组」（箭头平时是隐身的）。
          */}
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          {/* 名字**不给** `flex-1`：它按自身宽度占位，箭头才会跟着名字长度往右走
              （与主机分组行、AI Agent 项目行同一套） */}
          <span className="min-w-0 truncate">{group.name}</span>
          {/*
            展开 / 收起箭头：跟着名字走、**平时隐身**，hover 整行（或键盘聚焦到这颗按钮）
            才浮现 —— 与主机分组行、笔记树的目录行同一套。底板复用行尾动作按钮那份
            （`RowAction`），hover 时有一圈圆角底色。
            触摸端没有 hover，用 `max-md:opacity-100` 常显（那时它是唯一的手势入口）。
          */}
          <button
            type="button"
            aria-label={expanded ? '收起分组' : '展开分组'}
            title={expanded ? '收起分组' : '展开分组'}
            className={cn(
              ROW_ACTION_CLASS,
              'shrink-0 opacity-0 group-hover/grow:opacity-100 focus-visible:opacity-100 max-md:opacity-100'
            )}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', (expanded || searching) && !isEmpty && 'rotate-90')}
            />
          </button>
          {/* 撑开剩余宽度：名字按自身宽度占位，箭头跟着名字走，行尾那颗 `+` 才被推到右边 */}
          <span className="min-w-0 flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="新建"
                className={cn(ROW_ACTION_CLASS, 'opacity-0 group-hover/grow:opacity-100 max-md:opacity-100')}
                onClick={(e) => e.stopPropagation()}
              >
                <Plus className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={onNewRequest}>
                <Plus className="size-4" />
                在此分组新建请求
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onImportCurl}>
                <Terminal className="size-4" />
                导入 cURL 到此分组
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onNewSub}>
                <FolderPlus className="size-4" />
                新建子分组
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onNewRequest}>
          <Plus className="size-4" />
          在此分组新建请求
        </ContextMenuItem>
        <ContextMenuItem onSelect={onImportCurl}>
          <Terminal className="size-4" />
          导入 cURL 到此分组
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onNewSub}>
          <FolderPlus className="size-4" />
          在此分组新建子分组
        </ContextMenuItem>
        <ContextMenuItem onSelect={onMove}>
          <FolderInput className="size-4" />
          移动到…
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

/** 请求行：可拖动排序 / 跨组；点击打开，右键打开 / 移出分组 / 删除 */
function RequestRow({
  request,
  depth,
  hasGroup,
  active,
  onOpen,
  onEdit,
  onMoveOut,
  onDelete,
  onDropRequest,
  onDropGroup
}: {
  request: ApiRequestEntry
  depth: number
  hasGroup: boolean
  active: boolean
  onOpen: () => void
  /** 改这一行的分组 / 名称（弹窗直接落盘） */
  onEdit: () => void
  onMoveOut: () => void
  onDelete: () => void
  onDropRequest: DropRequest
  onDropGroup: DropGroup
}) {
  const [{ isDragging }, drag] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({ type: DND_REQUEST, item: { id: request.id }, collect: (m) => ({ isDragging: m.isDragging() }) }),
    [request.id]
  )

  const { ref, over, after } = useRowDrop<HTMLDivElement>(
    DND_REQUEST,
    DND_GROUP,
    (item, type) =>
      type === DND_GROUP ? hasGroup && item.id !== request.groupId : item.id !== request.id,
    (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, request.groupId!, at)
      else onDropRequest(item.id, request.id, request.groupId, at)
    },
    drag
  )

  const isWs = request.protocol === 'ws'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          className={cn(
            'group/req relative flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-sm transition-colors',
            isDragging && 'opacity-40',
            active
              ? 'bg-primary/15 text-foreground'
              : 'text-foreground hover:bg-primary-soft'
          )}
          style={{ paddingLeft: treeIndent(depth) }}
          onClick={onOpen}
          title={`${isWs ? 'WS' : request.method} ${request.url}`}
        >
          {over && <DropLine after={after} />}
          {isWs ? (
            <Cable className="size-3.5 shrink-0 opacity-70" />
          ) : (
            <Globe className="size-3.5 shrink-0 opacity-70" />
          )}
          <span
            className={cn(
              'shrink-0 font-mono text-[0.6875rem] font-semibold leading-none',
              isWs ? 'text-sky-500' : methodClass(request.method)
            )}
          >
            {isWs ? 'WS' : request.method || 'GET'}
          </span>
          {/* 行名不给自己的字号 / 行高：整行是 `text-sm`，与 AI Agent 侧栏的会话行同一套
              （原来这里是 `text-[0.8125rem] leading-none`，行比分组行矮一截）。 */}
          <span className="min-w-0 flex-1 truncate">{request.name.trim() || subtitleOf(request)}</span>
          {/* 分组 / 名称的编辑入口就在这一行上（详情页那颗铅笔已撤）：
              已保存的请求在列表里有自己的一行，就地改比翻到详情页改更顺手。
              放在「删除」左侧 —— 两颗行尾动作按钮的次序与其它列表（编辑在前、摧毁在后）一致。 */}
          <IconTip label="修改分组与名称">
            <button
              type="button"
              aria-label="修改分组与名称"
              className={cn(
                ROW_ACTION_CLASS,
                'opacity-0 group-hover/req:opacity-100 max-md:opacity-100 hover:text-foreground'
              )}
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
            >
              <Pencil className="size-3.5" />
            </button>
          </IconTip>
          <IconTip label="删除请求">
            <button
              type="button"
              aria-label="删除请求"
              className={cn(
                ROW_ACTION_CLASS,
                'opacity-0 group-hover/req:opacity-100 max-md:opacity-100 hover:text-destructive'
              )}
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </IconTip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={onOpen}>
          {isWs ? <Cable className="size-4" /> : <Globe className="size-4" />}
          打开
        </ContextMenuItem>
        {request.groupId && (
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

/**
 * 第二块内容组：请求历史（按天分桶）。点一行 = 载入成一个未保存草稿。
 *
 * 与「请求」组**同一个滚动区、同一套组标题与行样式**（`size="fill"`：展开时吃剩余
 * 高度；只展开请求组时本组只剩一行标题沉到底部 —— 两组固定顺序、独立展开）。
 * 原先它自己是一个 `SectionShell`、和「请求」之间还有一条可拖的边界 ——
 * 那与 AI Agent 侧栏「一个分区 + 两块内容组」的形态不是一回事（用户要求「整体和
 * ai-agent 一样两栏」）。
 *
 * 日期（今天 / 昨天 / 某月某日）是**组内的小标签**，不是第二个分区 —— 它只负责给
 * 下面几行分组，不该有自己的标题栏和操作按钮。
 */
function HistorySection({
  app,
  open,
  onToggle
}: {
  app: AgentApp
  /** 展开态由父组件控：两组固定顺序、各自独立展开 */
  open: boolean
  onToggle: () => void
}) {
  const history = app.apiHistory
  const confirm = useConfirm()

  const groups = useMemo(() => {
    const map = new Map<string, ApiHistoryEntry[]>()
    for (const e of history) {
      const key = dayBucket(e.at)
      const arr = map.get(key)
      if (arr) arr.push(e)
      else map.set(key, [e])
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }))
  }, [history])

  const loadDraft = (entry: ApiHistoryEntry): void => {
    setApiDraftSeed(entry)
    openApiDraftTab()
  }

  /** 清空是整条历史一起没，不可撤销 —— 与删单条请求一样先弹确认 */
  const clearHistory = async (): Promise<void> => {
    const ok = await confirm({
      title: '清空请求历史？',
      description: '全部历史记录都会被删除，无法恢复。保存的请求不受影响。',
      confirmLabel: '清空',
      destructive: true
    })
    if (ok) await app.clearApiHistory()
  }

  return (
    <SidebarGroup
      title="历史记录"
      count={history.length}
      alignIndent
      open={open}
      onToggle={onToggle}
      // 展开时吃剩余高度、超出才在组内滚（只展开请求组时本组只剩标题行）
      size="fill"
      className="pb-2"
      // 「清空历史」跟着**这一组**走：与「请求」组那颗「新建分组」同一个位置、同一种
      // 小按钮（`RowActionButton`）—— 标题行只有 32px 高，28px 的 ghost Button 会喧宾夺主。
      // 图标用 `Eraser`（「清掉这一堆」）而不是 `Trash2`：后者在侧栏里已经是「删除单个
      // 请求 / 分组 / 会话」的图标，清空整段历史再用它就分不清点下去会删多少
      extra={
        <IconTip label="清空历史">
          <RowActionButton
            aria-label="清空历史"
            className="shrink-0 disabled:opacity-40"
            disabled={history.length === 0}
            onClick={() => void clearHistory()}
          >
            <Eraser className="size-3.5" />
          </RowActionButton>
        </IconTip>
      }
      empty="还没有请求历史。"
    >
      {/* 按天分桶：`space-y-1` 让「日期标签 + 它的几行」成一块，块与块之间才断开 */}
      <div className="space-y-1">
        {groups.map((g) => (
          <div key={g.label}>
            {/* 日期标签：与组标签同一档（12px 灰字），只是缩进对齐到行文字 */}
            <div className="px-1.5 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
              {g.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {g.items.map((entry, idx) => (
                <div
                  key={entry.id || idx}
                  // 与 `RequestRow` 同一套行：`gap-1.5` / `px-1.5` / `py-1.5` /
                  // `rounded-md` / `hover:bg-primary-soft`（原先这里是 `gap-2 py-1 rounded
                  // hover:bg-primary/5`，同一份清单里两种行高、两种悬停色）
                  className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm transition-colors hover:bg-primary-soft"
                  title={`${formatFullTime(entry.at)} · 载入「${entry.method} ${entry.url}」到新建请求`}
                  onClick={() => loadDraft(entry)}
                >
                  {/* 方法色条：与 `RequestRow` 那颗同款（`methodClass` 只给字色，没有底） */}
                  <span
                    className={cn(
                      'shrink-0 font-mono text-[0.6875rem] font-semibold leading-none',
                      methodClass(entry.method)
                    )}
                  >
                    {entry.method || 'GET'}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs"
                    title={entry.url}
                  >
                    {entry.url}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SidebarGroup>
  )
}