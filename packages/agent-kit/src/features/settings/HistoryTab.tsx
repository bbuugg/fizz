/**
 * 设置 →「历史会话」：管理**已归档**的会话。
 *
 * ## 为什么在这里
 *
 * 归档是「我把它收起来了」的存量数据，属于「清理 / 找回」这一类动作，与「今天在干什么」
 * 无关。它原先在侧栏占着一整组（先是在项目树下面一段滚动区，后来变成侧栏顶上可折叠的
 * 一组），侧栏的宽度和高度都是最贵的资源：一个只在找回旧会话时才用到的清单，不该每天
 * 占着半屏，也不该让人每次找项目都从上往下划过它。
 *
 * 所以：侧栏不再有「历史会话」组，入口收敛到设置里的这一页（同一个面板的「会话」分组）。
 *
 * ## 交互
 *
 * - **点行 = 打开那条会话**（归档状态不变 —— 打开一个归档会话不会把它自动捞回来；
 *   想让它回到项目树里，点行尾的「取消归档」）。
 * - **取消归档是一键**：可逆操作，不套「点两次确认」。
 * - **彻底删除是两段式**（`InlineDeleteButton`：第一次点变红勾、第二次才真删，鼠标移开
 *   该行即反悔）：它不可逆，且这里没有「删除会话」弹窗——ACP 会话那个「同时删除 agent
 *   侧会话」的复选框在这条路上没有入口，行为等价于「开弹窗、不勾、直接删」：本地绑定
 *   删掉、agent 侧历史留着。要连 agent 侧一起删就先取消归档，再从项目树里删。
 * - **分组行尾的「清空」**：把这个分组下的归档会话**全部彻底删除**，同样是两段式
 *   （第一次点变「确认清空」、移开分组头即反悔）。删除是**串行**的 —— `deleteConversation`
 *   用服务端回包整体替换会话清单，并发删会让几个回包互相覆盖；串行还能让行一条条消失，
 *   进度看得见。删除期间按钮换成转圈，不许重复点。
 *
 * ## 分组
 *
 * 按项目分组（`app.workspaces` 的顺序），临时工作区的会话单列成「临时会话」，项目已经
 * 被删掉的归档会话兜到「未知项目」—— 那条记录还在库里，**不能因为找不到项目就丢掉**。
 */
import { useMemo, useState } from 'react'
import { Archive, ArchiveRestore, Folder, Loader2, MessageSquare } from 'lucide-react'
import { useAgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { InlineDeleteButton } from '@fizz/agent-kit/shared/components/InlineDeleteButton'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { conversationTitle } from '@fizz/agent-kit/shared/lib/conversation-title'

/** 归档会话行只需要这几个字段（`app.conversations` 的一项就是它） */
type ArchivedConversation = AgentApp['conversations'][number]

/** 项目已经被删掉的归档会话兜到这一组 */
const ORPHAN_NAME = '未知项目'

/** 一个分组（项目 / 临时会话 / 未知项目） */
interface HistoryGroup {
  id: string
  name: string
  scratch: boolean
  list: ArchivedConversation[]
}

export function HistoryTab({ app }: { app: AgentApp }) {
  const tr = useT()
  /** 待确认「彻底删除」的会话 id（取消归档是一键，不需要确认态） */
  const [pendingPurge, setPendingPurge] = useState<string | null>(null)
  /** 正在彻底删除的会话 id：行尾那颗按钮换成转圈，期间这一行不再可点 */
  const [deleting, setDeleting] = useState<Set<string>>(new Set())
  /** 待确认「清空」的分组 id（两段式；鼠标移开分组头即反悔） */
  const [pendingClear, setPendingClear] = useState<string | null>(null)
  /** 正在清空的分组 id：按钮转圈，期间不允许再点 */
  const [clearing, setClearing] = useState<string | null>(null)

  /** 归档会话：按归档时间倒序（先归档的通常更旧，放后面） */
  const archived = useMemo(() => {
    const list: ArchivedConversation[] = []
    for (const conversation of app.conversations) {
      if (conversation.archivedAt) list.push(conversation)
    }
    return list.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  }, [app.conversations])

  /**
   * 分桶：项目 id → 会话。
   *
   * 顺序在渲染处决定（项目树顺序 → 临时会话 → 未知项目），这里只管归类；
   * 桶内已经是归档时间倒序（沿 `archived` 的排列顺序 push 即可）。
   */
  const byWorkspace = useMemo(() => {
    const map = new Map<string, ArchivedConversation[]>()
    for (const conversation of archived) {
      const list = map.get(conversation.workspaceId) ?? []
      list.push(conversation)
      map.set(conversation.workspaceId, list)
    }
    return map
  }, [archived])

  /** 分组：项目（有归档的才列）→ 临时会话 → 未知项目 */
  const groups = useMemo<HistoryGroup[]>(() => {
    const known = app.workspaces
      .filter((workspace) => !workspace.scratch && byWorkspace.has(workspace.id))
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        scratch: false,
        list: byWorkspace.get(workspace.id) ?? []
      }))
    // 临时会话合并成一组：一条会话一个 uuid 目录，按工作区分组会列出一长串同名组
    const scratchList = app.workspaces
      .filter((workspace) => workspace.scratch)
      .flatMap((workspace) => byWorkspace.get(workspace.id) ?? [])
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
    const scratch = scratchList.length
      ? [{ id: '__scratch__', name: '临时会话', scratch: true, list: scratchList }]
      : []
    const orphans = [...byWorkspace.keys()]
      .filter((id) => !app.workspaces.some((workspace) => workspace.id === id))
      .map((id) => ({ id, name: ORPHAN_NAME, scratch: false, list: byWorkspace.get(id) ?? [] }))
    return [...known, ...scratch, ...orphans]
  }, [app.workspaces, byWorkspace])

  /**
   * 打开一条归档会话：就地打开（设置是主区域的标签，与对话共享同一份 store）。
   */
  const openArchived = (conversationId: string): void => {
    void app.openConversation(conversationId)
  }

  /**
   * 彻底删除一条（行尾按钮的第二次点击）。
   *
   * 期间该行挂 `deleting`：图标换成转圈、行本身不再响应点击 —— 删除是个往返，没有反馈
   * 的话用户会以为没点上，接着再点一次（那条已经不在列表里了）。
   */
  const purge = async (conversationId: string): Promise<void> => {
    setPendingPurge(null)
    setDeleting((prev) => new Set(prev).add(conversationId))
    try {
      await app.deleteConversation(conversationId)
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev)
        next.delete(conversationId)
        return next
      })
    }
  }

  /**
   * 清空一个分组：把它的归档会话逐条彻底删除。
   *
   * ⚠️ **必须串行**：`deleteConversation` 用服务端回包**整体替换**会话清单，并发发出去的
   * 几个回包会互相覆盖（后到的把刚删掉的那条又带回来，列表闪一下）。串行还顺带给了
   * 「一条条消失」的进度反馈。中途失败就停：剩下的还在列表里，用户看得见删到哪了。
   */
  const clearGroup = async (group: HistoryGroup): Promise<void> => {
    setPendingClear(null)
    setClearing(group.id)
    try {
      for (const conversation of group.list) {
        const result = await app.deleteConversation(conversation.id)
        if (!result.ok) break
      }
    } finally {
      setClearing(null)
    }
  }

  /**
   * 一条归档会话行：点击打开 / 行尾「取消归档」+「彻底删除」。
   *
   * `locked` = 整组正在清空：这些行马上就会被删掉，别让用户再点开其中一条。
   */
  const renderRow = (conversation: ArchivedConversation, locked = false) => {
    const purging = pendingPurge === conversation.id
    const isDeleting = deleting.has(conversation.id)
    const inactive = isDeleting || locked
    return (
      <div
        key={conversation.id}
        onClick={() => {
          if (!inactive) openArchived(conversation.id)
        }}
        onMouseLeave={() => {
          // 移开 = 反悔（与侧栏里那套同款）
          if (purging) setPendingPurge(null)
        }}
        className={cn(
          'group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-primary-soft',
          inactive ? 'pointer-events-none opacity-60' : 'cursor-pointer'
        )}
        title={conversationTitle(conversation.title)}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            purging && 'text-destructive'
          )}
        >
          {conversationTitle(conversation.title)}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">
          {conversation.archivedAt
            ? new Date(conversation.archivedAt).toLocaleDateString()
            : ''}
        </span>
        <IconTip label={tr('取消归档 {title}', { title: conversationTitle(conversation.title) })}>
          <button
            type="button"
            aria-label={tr('取消归档 {title}', { title: conversationTitle(conversation.title) })}
            onClick={(e) => {
              e.stopPropagation()
              void app.archiveConversation(conversation.id, false)
            }}
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-colors hover:bg-primary-soft hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          >
            <ArchiveRestore className="size-3.5" />
          </button>
        </IconTip>
        {isDeleting ? (
          // 删除是个往返：没有反馈用户会以为没点上、接着再点一次（那条已经没了）
          <span
            className="shrink-0 p-0.5 text-muted-foreground"
            role="status"
            aria-label={tr('正在删除')}
          >
            <Loader2 className="size-3.5 animate-spin" />
          </span>
        ) : (
          <InlineDeleteButton
            armed={purging}
            label={tr('彻底删除')}
            title={conversation.title}
            onArm={() => setPendingPurge(conversation.id)}
            onConfirm={() => void purge(conversation.id)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Archive className="size-3.5" />
          {/*
            ⚠️ 这里**不带条数**：它是「有存量数据」的静态标题，数量一变（删一条 / 清空一组）
            整个标题就重排一次，观感像内容在闪。数量该看的地方是下面各分组的组头。
          */}
          {tr('历史会话')}
        </div>

        {/* 清单没落地前不下「还没有归档会话」这个结论（否则打开设置先闪一句空态） */}
        {!app.conversationsLoaded && !app.error ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">{tr('正在加载会话…')}</div>
        ) : archived.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
            {tr('还没有归档会话。会话行行尾那颗归档按钮点一下，它就会收进这里。')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {groups.map((group) => {
              const isClearing = clearing === group.id
              const armed = pendingClear === group.id
              return (
                <div key={group.id} className="flex flex-col gap-0.5">
                  {/* 组名：归档后项目树上那一行可能已经不在视野里，这里补上归属。
                      行尾是「清空」：把这个分组下的归档会话全部彻底删除（两段式）。 */}
                  <div
                    className="flex h-7 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground"
                    onMouseLeave={() => {
                      // 移开分组头 = 反悔（与行尾删除同款）
                      setPendingClear((cur) => (cur === group.id ? null : cur))
                    }}
                  >
                    {group.scratch ? (
                      <MessageSquare className="size-3.5 shrink-0" />
                    ) : (
                      <Folder className="size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{tr(group.name)}</span>
                    <span className="shrink-0 tabular-nums">（{group.list.length}）</span>
                    <button
                      type="button"
                      disabled={isClearing || clearing !== null}
                      aria-label={tr('清空 {name} 下的 {count} 条归档会话', {
                        name: tr(group.name),
                        count: group.list.length
                      })}
                      title={
                        armed
                          ? tr('再点一次确认清空 {name}', { name: tr(group.name) })
                          : tr('清空 {name} 下的 {count} 条归档会话', {
                              name: tr(group.name),
                              count: group.list.length
                            })
                      }
                      onClick={() => {
                        if (isClearing) return
                        if (!armed) setPendingClear(group.id)
                        else void clearGroup(group)
                      }}
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[0.6875rem] font-normal transition-colors disabled:opacity-60',
                        armed
                          ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                          : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
                      )}
                    >
                      {isClearing && <Loader2 className="size-3 animate-spin" />}
                      {isClearing
                        ? tr('清空中…')
                        : armed
                          ? tr('确认清空 {count} 条', { count: group.list.length })
                          : tr('清空')}
                    </button>
                  </div>
                  <div className="ml-3.5 flex flex-col gap-0.5 border-l border-border pl-2">
                    {group.list.map((conversation) => renderRow(conversation, isClearing))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
