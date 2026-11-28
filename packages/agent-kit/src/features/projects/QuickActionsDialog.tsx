/**
 * 快捷功能管理弹窗：增删改 / 排序落在 `<工作区>/.fizz/workspace.json` 的 `quickActions`
 * —— 也就是顶栏 ⚡ 下拉里那些条目。
 *
 * ## 它从哪来、为什么只剩这一块
 *
 * 前身是「工作区设置」弹窗（Tab 分区：快捷功能 / 免确认命令，顶栏一颗齿轮进去）。
 * 2026-10 把那层外壳拆掉：齿轮入口删了，管理入口收进 **⚡ 下拉的最底部**
 * （见 `WorkspaceQuickActions`），于是「工作区设置」这个概念不再存在，弹窗只剩
 * 快捷功能一块内容 —— 单块内容不需要 Tab 条，直接用一块滚动区。
 *
 * 同一份 `workspace.json` 里另外两个字段**照旧原样带过**（见 `persist` 里的
 * `defaultTerminal` / `approvedCommands`）：它们还有别的写入方（终端偏好会记住上次选择；
 * agent 点「始终允许此命令」会直接写盘），这里要是「按字段重建」就等于静默清空。
 * 「免确认命令」那一页随弹窗一起移除后**没有 UI 入口了**，想删只能手改文件。
 *
 * ## 排版
 *
 * 高度**跟内容走、只封顶**（`max-h-[min(480px,85dvh)]`，与下面「编辑单条」那颗同值）：
 * 不再钉死固定高度 —— 只有一两条快捷功能时，定高会在底部留一大块空白。
 * 高度变化（加载完 / 加一条）由 `DialogContent` 的
 * `useHeightTransition` 补一段过渡（与选择器面板同一份，见 `height-transition.ts`），
 * 不会「啪」地跳；超过封顶之后只有列表区内部滚动。
 * 外层 `min-h-0` 不能删：DialogContent 是 grid，grid 子项默认 `min-height: auto`，
 * 不给 0 的话这个 `flex-1` 容器宁可顶破 `max-h-*` 也不交出高度，列表滚不起来。
 *
 * 数据流：AgentApp 按工作区给快照 + 保存回调，每次改动**整体重写**这份配置（文件是给人
 * 手改的，格式要保持可读的 JSON）；弹窗打开时先强制重拉一次（`onRefresh`）—— 文件可能
 * 在别处被改（手改 / 别的窗口），懒加载的缓存里看不到，不刷新的话保存任意一项会把它覆盖掉。
 *
 * ## 排序：左侧把手拖拽（与队列消息同一份实现）
 *
 * 早先是行尾两颗 ↑↓ 箭头（为触屏准备的），现在统一成 `SortableRow`（`shared/components`，
 * 队列 / 插话两张待发送列表用的就是它）：左边一把把手，拖到哪条就插到哪条前，鼠标走
 * react-dnd、触屏走把手的指针捕获 —— 两套设备一套指示器。
 *
 * ⚠️ 拖拽期间 `moveTo` 每次经过都会被调，而这里每次重排都要**整份重写** workspace.json，
 * 所以拖动过程只改本地 `order`，**松手才落库**（`onDragEnd`）。别改成在 `moveTo` 里直接
 * `persist`：一次拖动会写出好几份文件。
 */
import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, Trash2, Zap } from 'lucide-react'
import { toast } from 'sonner'
import {
  QUICK_ACTION_KINDS,
  WORKSPACE_CONFIG_VERSION,
  newQuickActionId,
  normalizeQuickAction,
  validateQuickAction,
  type QuickAction,
  type QuickActionKind,
  type WorkspaceConfigSnapshot
} from '@fizz/contracts/workspace-config'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@fizz/ui/dialog'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@fizz/ui/empty'
import { Input } from '@fizz/ui/input'
import { Button } from '@fizz/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@fizz/ui/tabs'
import MonacoEditor from '@fizz/agent-kit/features/files/MonacoEditor'
import {
  QUICK_ACTION_ICONS,
  QUICK_ACTION_KIND_LABELS,
  QUICK_ACTION_TARGET_HINTS
} from '@fizz/agent-kit/shared/lib/quick-actions'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { ROW_ACTION_CLASS } from '@fizz/agent-kit/shared/components/RowAction'
import { SortableRow } from '@fizz/agent-kit/shared/components/SortableRow'
import { supportsTouch } from '@fizz/agent-kit/shared/lib/supports-touch'

/**
 * 快捷功能的拖拽类型。与队列 / 插话的类型**刻意分开**：跨列表拖拽没有语义（往弹窗里拖一条
 * 待发送消息没有任何意义），靠类型让彼此互不接受。
 */
const QUICK_ACTION_ITEM_TYPE = 'quick-action'

/** 新建一条时的初始草稿：默认做成「打开链接」，那是用得最多的一类 */
function emptyDraft(): QuickAction {
  return { id: newQuickActionId(), kind: 'link', label: '', target: '' }
}

/** 行尾小按钮的底板：与 ActionRow 的 ROW_ACTION_CLASS 同款（这里只有删除，抽成局部常量） */
const rowActionClass = cn(ROW_ACTION_CLASS, 'p-1 shrink-0')

/**
 * 列表行的正文与按钮。**行外壳（含左侧拖拽把手）由 `SortableRow` 提供** —— 排序那套
 * 交互与队列消息共用一份，这里只管「这一行长什么样、右边有哪两颗钮」。
 */
function ActionRow({
  action,
  busy,
  onEdit,
  onDelete
}: {
  action: QuickAction
  busy: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const tr = useT()
  const Icon = QUICK_ACTION_ICONS[action.kind]
  // 底板与别处的行尾按钮共用（shared/components/RowAction）；这里原来是
  // `p-1`（比会话行大 2px），保持不变
  const rowAction = cn(ROW_ACTION_CLASS, 'p-1')
  // 删除不用弹窗确认（规则禁用原生 confirm；为一条配置再引 AlertDialog 太重）：
  // 点第一下变红「再点确认」，失焦还原
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <Icon className="size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{action.label}</div>
        <div className="truncate text-xs text-muted-foreground" title={action.target}>
          {tr(QUICK_ACTION_KIND_LABELS[action.kind])} · {action.target}
        </div>
      </div>
      <button
        type="button"
        aria-label={tr('编辑快捷功能')}
        title={tr('编辑')}
        disabled={busy}
        onClick={onEdit}
        className={rowAction}
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={tr('删除快捷功能')}
        title={confirming ? tr('再点一次确认删除') : tr('删除')}
        disabled={busy}
        onClick={() => {
          if (confirming) {
            setConfirming(false)
            onDelete()
          } else {
            setConfirming(true)
          }
        }}
        onBlur={() => setConfirming(false)}
        className={cn(rowAction, confirming && 'bg-destructive/10 text-destructive')}
      >
        <Trash2 className="size-3.5" />
      </button>
    </>
  )
}

export function QuickActionsDialog({
  workspaceId,
  snapshot,
  onSave,
  onRefresh,
  open,
  onClose
}: {
  workspaceId: string
  /** 该工作区的配置快照（AgentApp 按工作区加载；null = 还没读到） */
  snapshot: WorkspaceConfigSnapshot | null
  /** 整体写回配置（AgentApp 负责落到 server 并更新快照） */
  onSave: (
    workspaceId: string,
    config: {
      version: number
      defaultTerminal: string | null
      quickActions: QuickAction[]
      approvedCommands: string[]
    }
  ) => Promise<void>
  /**
   * 强制重拉配置快照：弹窗**打开时**调一次。快照是懒加载缓存的 —— 文件可能在弹窗外
   * 被改（手改 / 别的窗口 / agent 写 `approvedCommands`），缓存里看不到；不刷新的话
   * 保存任意一项会把那些改动**整体覆盖**掉。
   */
  onRefresh: (workspaceId: string) => Promise<void>
  open: boolean
  onClose: () => void
}) {
  // 订阅语言：空态与标题都走 `tr()`
  const tr = useT()
  const configActions = snapshot?.config.quickActions
  const actions = useMemo(() => configActions ?? [], [configActions])
  /**
   * 旧版的「工作区默认终端」字段：设置页已不再提供入口，但保存时要原样带过，
   * 别把用户以前配过（以及旧版本写的）值冲掉。
   */
  const currentDefault = snapshot?.config.defaultTerminal ?? null
  /**
   * 免确认命令（confirm 档审批卡上点过「始终允许此命令」的清单）：管理入口已随
   * 「工作区设置」弹窗一起移除，这里**只负责原样带过**，别让它被保存快捷功能时清空。
   */
  const approvedCommands = snapshot?.config.approvedCommands ?? []

  useEffect(() => {
    if (open) void onRefresh(workspaceId)
    // 只在「打开」这个事件上刷：onRefresh 是 provider 的 useCallback（随 app.api 变），
    // 把它放进依赖会让「流式期间每帧重拉」（app 每次渲染都是新引用，见 AGENTS.md）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId])

  /** 正在编辑 / 新建的那条（null = 不在编辑态） */
  const [draft, setDraft] = useState<QuickAction | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * 拖拽排序期间的**本地顺序**（null = 用快照里的顺序）。
   *
   * 拖动时 `moveTo` 每次经过都会被调，而这里每改一次顺序都要整份重写 workspace.json ——
   * 所以拖动过程只改这份本地数组，松手（`onDragEnd`）才落库。快照一更新就丢掉它
   * （此时服务端那份就是刚才提交的顺序，两者本来就一致）。
   */
  const [order, setOrder] = useState<QuickAction[] | null>(null)
  const rows = order ?? actions
  useEffect(() => {
    setOrder(null)
  }, [configActions])
  /** 触屏上 HTML5 拖拽起不动：那些设备由把手自己扛指针事件（见 `SortableRow`） */
  const canTouch = supportsTouch()

  /** 整体写回配置 */
  const persist = async (next: QuickAction[]): Promise<boolean> => {
    setBusy(true)
    try {
      await onSave(workspaceId, {
        version: snapshot?.config.version ?? WORKSPACE_CONFIG_VERSION,
        // 保存快捷功能时一并带上默认终端与免确认命令，别把它们冲掉
        defaultTerminal: currentDefault,
        quickActions: next,
        approvedCommands
      })
      return true
    } catch (err) {
      toast.error(tr('保存失败：{error}', { error: err instanceof Error ? err.message : String(err) }))
      return false
    } finally {
      setBusy(false)
    }
  }

  /**
   * 把 `draggedId` 挪到 `beforeId` 前面（`SortableRow` 每经过一条就调一次）。
   *
   * 只动本地顺序 —— 落库在 `commitOrder`（松手时）。下标一律从**当前**数组现算：
   * 拖拽期间数组一直在变，别把下标当参数传进来。
   */
  const moveTo = (draggedId: string, beforeId: string): void => {
    setOrder((prev) => {
      const list = [...(prev ?? actions)]
      const from = list.findIndex((a) => a.id === draggedId)
      const to = list.findIndex((a) => a.id === beforeId)
      if (from < 0 || to < 0 || from === to) return prev
      const [moved] = list.splice(from, 1)
      // 抽出后目标下标会前移一格（当 from < to）—— 两种情况都落成「插到目标前面」
      list.splice(from < to ? to - 1 : to, 0, moved!)
      return list
    })
  }

  /** 松手：顺序真变了才写一次盘（`moveTo` 只改内存，见文件头） */
  const commitOrder = async (): Promise<void> => {
    if (!order) return
    const unchanged = order.every((a, i) => a.id === actions[i]?.id)
    if (unchanged) return
    if (!(await persist(order))) setOrder(null)
  }

  const submitDraft = async () => {
    if (!draft) return
    const invalid = validateQuickAction(draft)
    if (invalid) {
      toast.warning(invalid)
      return
    }
    const action = normalizeQuickAction(draft)
    if (!action) {
      toast.warning(tr('请填写完整的快捷功能信息'))
      return
    }
    const exists = actions.some((a) => a.id === action.id)
    const next = exists ? actions.map((a) => (a.id === action.id ? action : a)) : [...actions, action]
    if (await persist(next)) setDraft(null)
  }

  const DraftIcon = draft ? QUICK_ACTION_ICONS[draft.kind] : null

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogContent
          className="flex max-h-[min(480px,85dvh)] flex-col overflow-hidden sm:max-w-md"
          // 打开时不抢焦点（用户要求）：默认会聚焦第一个可聚焦元素
          initialFocus={false}
        >
          <DialogTitle>{tr('快捷功能')}</DialogTitle>

          {/* 列表区：`min-h-0 flex-1` + 内部滚动（见文件头「排版」）。
              `data-dialog-scroll`：滚动条贴弹窗右沿，且没条时右侧也留满 16px（见 styles.css）。 */}
          <div data-dialog-scroll="" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pt-1">
            {rows.length === 0 ? (
              <Empty className="border border-border/70 py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Zap />
                  </EmptyMedia>
                  <EmptyTitle>{tr('还没有快捷功能')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              rows.map((action) => (
                <SortableRow
                  key={action.id}
                  id={action.id}
                  dragType={QUICK_ACTION_ITEM_TYPE}
                  canTouch={canTouch}
                  moveTo={moveTo}
                  onDragEnd={() => void commitOrder()}
                  /* 带边框的卡片外壳（与改版前一致）；行容器与把手来自 `SortableRow` */
                  className="border border-border/70 px-2 py-1.5"
                >
                  <ActionRow
                    action={action}
                    busy={busy}
                    onEdit={() => setDraft({ ...action })}
                    onDelete={() => void persist(actions.filter((a) => a.id !== action.id))}
                  />
                </SortableRow>
              ))
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDraft(emptyDraft())}
              className="w-full border-dashed"
            >
              <Plus className="size-3.5" />
              {tr('添加快捷功能')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/*
        编辑单条：嵌套弹窗，列表仍留在下层，改完能立刻看到顺序与内容。

        高度**跟内容走、只封顶**（`max-h-[min(480px,85dvh)]`）：三种类型的「目标」控件
        本来就不一样高（链接 / 路径是一行输入框，命令是 8rem 的 Monaco），换类型时高度
        由 `DialogContent` 的 `useHeightTransition` 补一段过渡，不再钉死定高留空白。
        超过封顶后表单区只有内部滚动 —— 表单再长也不用滚到底才能看到「取消 / 保存」。
      */}
      <Dialog open={draft !== null} onOpenChange={(next) => (next ? undefined : setDraft(null))}>
        <DialogContent
          className="flex max-h-[min(480px,85dvh)] flex-col overflow-hidden sm:max-w-[480px]"
          // 编辑弹窗同样不自动聚焦：下面的名称输入框也不挂 autoFocus
          initialFocus={false}
        >
          <DialogTitle>
            {actions.some((a) => a.id === draft?.id) ? tr('编辑快捷功能') : tr('添加快捷功能')}
          </DialogTitle>

          {draft && (
            <>
              {/* `data-dialog-scroll`：滚动条贴弹窗右沿 + 没条时右侧也留满 16px（见 styles.css）。
                  原来挂 `no-scrollbar` 把条整个藏了（那时条在 p-4 内侧、像多一条轨道）——
                  贴边之后没必要藏了。 */}
              <div data-dialog-scroll="" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pt-1">
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">{tr('类型')}</div>
                  {/* 类型用 shadcn 默认变体（灰底胶囊）。Tabs 不挂 TabsContent ——
                      这里只是选值，内容区在下面。宽的时候横向滚，别让 4 个类型把弹窗撑破。

                      `overflow-y-hidden` 不能省：只写 `overflow-x-auto` 时另一轴按规范被算成
                      `auto`，而 `TabsTrigger` 的选中态指示条是 `after:bottom-[-5px]` 的绝对定位
                      伪元素（default 变体里 `opacity-0`，但**照样占位**），它往容器外多探出
                      2–5px，于是这行凭空长出一条纵向滚动条。纵向本来就不需要滚。 */}
                  <div className="min-w-0 overflow-x-auto overflow-y-hidden">
                    <Tabs
                      value={draft.kind}
                      onValueChange={(value) => setDraft({ ...draft, kind: value as QuickActionKind })}
                    >
                      <TabsList className="w-full">
                        {QUICK_ACTION_KINDS.map((kind) => {
                          const Icon = QUICK_ACTION_ICONS[kind]
                          return (
                            <TabsTrigger key={kind} value={kind}>
                              <Icon className="size-3.5" />
                              {tr(QUICK_ACTION_KIND_LABELS[kind])}
                            </TabsTrigger>
                          )
                        })}
                      </TabsList>
                    </Tabs>
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">{tr('名称')}</div>
                  <Input
                    variant="muted"
                    placeholder={tr('按钮上的文字，例如「项目看板」')}
                    value={draft.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitDraft()
                    }}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">
                    {draft.kind === 'command' ? tr('命令') : draft.kind === 'link' ? tr('链接') : tr('路径')}
                  </div>
                  {/*
                    三种类型的「目标」形状本来就不同，别共用一个 textarea：
                    - 链接 / 路径是**一行**，回车即保存（与上面的名称框一致）；
                    - 命令是多行（按行顺序执行），给 Monaco（语言 shell）—— 语法高亮 / 行号 /
                      撤销都白拿，loader 与主题复用文件面板那一份，不额外付包体。
                      高度**钉死 8rem**（用户要求「不要太高」）：够看四五条命令，再多在编辑器内滚；
                      同时弹窗高度不随输入的长短跳。
                  */}
                  {draft.kind === 'command' ? (
                    <div className="h-32 overflow-hidden rounded-lg border">
                      <MonacoEditor
                        value={draft.target}
                        onChange={(value) => setDraft({ ...draft, target: value })}
                        language="shell"
                        showHeader={false}
                      />
                    </div>
                  ) : (
                    <Input
                      variant="muted"
                      placeholder={tr(QUICK_ACTION_TARGET_HINTS[draft.kind])}
                      value={draft.target}
                      onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitDraft()
                      }}
                    />
                  )}
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">{tr('说明（可选）')}</div>
                  <Input
                    variant="muted"
                    placeholder={tr('鼠标悬停在按钮上时的提示')}
                    value={draft.description ?? ''}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {DraftIcon && <DraftIcon className="size-3.5" />}
                  {draft.kind === 'command'
                    ? tr('在工作区新开内嵌终端，按行顺序执行。')
                    : draft.kind === 'path'
                      ? tr('相对路径按工作区根目录解析（仅桌面端）。')
                      : tr('用系统默认浏览器打开该链接。')}
                </div>
              </div>

              {/* 按钮钉在底部、不进滚动区：表单再长也不用滚到底才能保存 */}
              <div
                data-slot="dialog-footer"
                className="flex shrink-0 justify-end gap-2 pt-3"
              >
                <Button size="sm" disabled={busy} onClick={() => void submitDraft()}>
                  {tr('保存')}
                </Button>
                <Button data-dialog-dismiss="" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                  {tr('取消')}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
