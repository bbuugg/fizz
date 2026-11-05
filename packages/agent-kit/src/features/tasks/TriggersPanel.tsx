/**
 * 「定时任务」管理面板（主区域单例标签 `triggers:list`）：**全局**的增删改查。
 *
 * ## 为什么从侧栏那块清单独立成一页
 *
 * 侧栏那块是「瞧一眼有没有在跑」的看板：宽度只有 260px，每行塞得下名字 + 一个开关 +
 * 两颗小图标，cron / prompt / MCP 全看不见。结果是已经有的那些看不出它跑什么、
 * 下次什么时候跑 —— 只能挨个点铅笔进去看。
 *
 * 现在改成主区域一整页：左边列全部任务（按归属分组），右边是选中那条的完整信息 +
 * 新建 / 编辑按钮（表单见 `TriggerEditDialog`）。侧栏顶部那颗「定时任务」改成**开这个
 * 标签页**，项目行菜单里那一项删掉 —— 新建只有这一处入口。
 *
 * ## 归属：工作区是**可选**的
 *
 * 定时任务是「什么时候起一轮会话」的规则，不该被某个项目绑架：不绑工作区时，**每次触发
 * 都新建一个临时工作区**（与「新建会话不选工作区」同一套）。所以清单里有一组
 * 「每次运行自动创建」排在最前，那是正常状态、不是缺字段。
 *
 * ## 数据
 *
 * `triggers` 走 `useAppContext()` 里那一份（`useTriggers`，WS 推送 `taskTriggers` 域），
 * 不在这里再拉一份：别处（侧栏 / 标签页）看到的必须是同一个数。
 * 工作区 / 模型 / MCP 清单同理走 `app`，编辑弹窗不再自己拉。
 *
 * ## 布局
 *
 * 照 `LogsPanel` 的口径：顶部工具条固定（标题 + 统计 + 刷新 + 新建），下面才滚。
 * 主体**左列分组清单 / 右列详情**，窄屏（`lg` 以下）退化成上下两块、清单在上。
 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  CalendarClock,
  Clock,
  Folder,
  FolderPlus,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Timer,
  TriangleAlert
} from 'lucide-react'
import type { TaskTrigger } from '@fizz/contracts/types'
import { t as translate } from '@fizz/i18n'
import { Button } from '@fizz/ui/button'
import { Switch } from '@fizz/ui/switch'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { InlineDeleteButton } from '@fizz/agent-kit/shared/components/InlineDeleteButton'
import { RowActionButton } from '@fizz/agent-kit/shared/components/RowAction'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { permissionOption } from '@fizz/agent-kit/shared/lib/permission'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { conversationTitle } from '@fizz/agent-kit/shared/lib/conversation-title'
import { TriggerEditDialog } from '@fizz/agent-kit/features/tasks/TriggerEditDialog'

/** 「刚触发过」的判定窗口：窗口内的行亮绿点（与侧栏看板同一口径） */
const RECENT_MS = 60_000

/** 「已删除的项目」的兜底名：任务绑了工作区、而那个工作区后来被删了 */
const ORPHAN_NAME = '（已删除的项目）'

/**
 * 「不绑工作区」那一桶的 key —— 这些任务每次触发都自建临时工作区，
 * 与「绑了某个项目」在观感上是两类东西，清单里单独归一组、排在最前。
 */
const AUTO_GROUP = '__auto__'
const AUTO_GROUP_NAME = '每次运行自动创建'

/** 触发方式对应的行首图标（cron / 一次性 / 老记录） */
function triggerIcon(trigger: TaskTrigger) {
  if (trigger.cron) return CalendarClock
  if (trigger.at !== undefined) return Timer
  return Clock
}

/**
 * 运行记录里的短时间：今天只给 `HH:mm`，其余给 `MM-DD HH:mm`。
 *
 * 列表里一列 `2026/10/20 09:00:00` 会把这行挤成一坨；用户看的是「哪一轮更新」，
 * 精确到秒没有意义（真要精确定位就点进去看消息时间）。
 */
function shortTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/** 触发方式的一句话描述 */
function scheduleText(trigger: TaskTrigger): string {
  if (trigger.cron) return translate('cron：{cron}', { cron: trigger.cron })
  if (trigger.at !== undefined)
    return translate('一次性：{at}', { at: new Date(trigger.at).toLocaleString() })
  return translate('未设置时间表')
}

/**
 * 模型那一行的人话：配置 / agent / 模型都按**现存清单**取名字；没选（或配置已被删）就写
 * 「未选择」—— 不显示裸 id，也没有「用第一份可用配置」这种兜底说法（调度器不回退了，
 * 没选目标的任务到点只会报错，见 `scheduler` 的 `resolveHeadlessTarget`）。
 *
 * 外部 Agent（`backend: 'acp'`）没有模型也是合法状态（= 跟随 agent 默认），所以那一档
 * 只写 agent 名（+ 模型名，选了才带）。
 */
function modelTextOf(
  template: TaskTrigger['template'],
  models: { id: string; name: string }[],
  acpAgents: { id: string; name: string; models?: { value: string; name: string }[] }[]
): string {
  const { configId, modelId } = template
  if (!configId) return translate('未选择')
  if (template.backend === 'acp') {
    const agent = acpAgents.find((a) => a.id === configId)
    if (!agent) return translate('未选择（外部 Agent 已删除）')
    if (!modelId) return translate('{name} · 跟随 agent 默认', { name: agent.name })
    const model = (agent.models ?? []).find((m) => m.value === modelId)
    return `${agent.name} · ${model?.name ?? modelId}`
  }
  if (!modelId) return translate('未选择')
  const config = models.find((m) => m.id === configId)
  return config ? `${config.name} · ${modelId}` : translate('未选择（配置已删除）')
}

/** 相对时间（本地时钟驱动，秒级刷新） */
function relativeTime(from: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1000))
  if (seconds < 60) return translate('{n} 秒前', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return translate('{n} 分钟前', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return translate('{n} 小时前', { n: hours })
  return translate('{n} 天前', { n: Math.floor(hours / 24) })
}

/** 「上次触发」那半句：没触发过 / 已停用各有各的说法 */
function lastText(trigger: TaskTrigger, now: number): string {
  if (trigger.lastTriggeredAt !== undefined)
    return translate('上次触发：{time}', { time: relativeTime(trigger.lastTriggeredAt, now) })
  return trigger.enabled ? translate('还没触发过') : translate('已停用')
}

export function TriggersPanel() {
  // `openConversation` 是**宿主包装过**的那个（选中 + 切视图 + 把面板标签也落到位），
  // 不是 store 里那个裸的 —— 光调 store 在「目标已经是当前会话」时会早退，看着像点了没反应
  const { app, triggers, openConversation, openSettingsTab } = useAppContext()
  const t = useT()
  /** 本地时钟：相对时间秒级刷新用（服务端推送只管数据，不管「时间在走」） */
  const [now, setNow] = useState(() => Date.now())
  /** 右列选中的那条（`null` = 没选，右列显示一句引导） */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /**
   * 编辑弹窗：`editing` = 正在编辑的那条（`null` = 新建），`editOpen` 单独控开合
   * （新建时 `editing` 也是 `null`，两者分不开）。
   */
  const [editing, setEditing] = useState<TaskTrigger | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  /** 删除按钮的「二次确认」态挂在哪个 id 上（null = 没有） */
  const [armedId, setArmedId] = useState<string | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 挂载时对一次表：WS 推送是主路，这里兜「推送恰好断着」的窗口
  useEffect(() => {
    void triggers.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- triggers 对象每次渲染都是新的，只认挂载
  }, [])

  /**
   * 按工作区分桶（同桶内按创建时间倒序，比服务端返回顺序稳定）。
   * 没绑工作区的归到 `AUTO_GROUP` —— 它们不是「归属丢了」，而是**故意不绑**。
   */
  const byWorkspace = useMemo(() => {
    const map = new Map<string, TaskTrigger[]>()
    for (const trigger of triggers.list) {
      const key = trigger.workspaceId ?? AUTO_GROUP
      const list = map.get(key) ?? []
      list.push(trigger)
      map.set(key, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.createdAt - a.createdAt)
    return map
  }, [triggers.list])

  /**
   * 分组顺序：「自动创建」那组排最前（最常见、也最不需要解释），再按项目树顺序列出
   * 有任务的项目，最后把「绑的项目已经没了」的兜到最后。
   * 那句「（已删除的项目）」不能省 —— 兜不住就等于这条记录从界面上凭空消失。
   */
  const groups = useMemo(() => {
    const auto = byWorkspace.has(AUTO_GROUP)
      ? [{ id: AUTO_GROUP, name: AUTO_GROUP_NAME }]
      : []
    const known = app.workspaces
      .filter((workspace) => byWorkspace.has(workspace.id))
      .map((workspace) => ({ id: workspace.id, name: workspace.name }))
    const orphans = [...byWorkspace.keys()]
      .filter(
        (id) => id !== AUTO_GROUP && !app.workspaces.some((workspace) => workspace.id === id)
      )
      .map((id) => ({ id, name: ORPHAN_NAME }))
    return [...auto, ...known, ...orphans]
  }, [app.workspaces, byWorkspace])

  /** 选中的那条：列表里被删（或从没选过）时自动回落到第一条，右列不至于空着 */
  const selected = useMemo(() => {
    const found = triggers.list.find((t) => t.id === selectedId)
    if (found) return found
    // 回落到清单里的第一条（按项目树的顺序 + 每桶的排序，与左列看到的顺序一致）
    for (const group of groups) {
      const first = byWorkspace.get(group.id)?.[0]
      if (first) return first
    }
    return null
  }, [triggers.list, selectedId, groups, byWorkspace])

  /**
   * 选中那条**跑出来过的会话**（最新在前）。
   *
   * - `conversationIds` 是每轮追加的完整索引（见 `TaskTrigger.conversationIds`）；
   * - 存量任务只有 `lastConversationId` 一条 —— 老数据不能因此显示「从没跑过」；
   * - 会话被用户删掉的那些**在展示时过滤掉**（id 还留在记录里，见字段注释），
   *   被删了就点不开，留着只会是死链。
   */
  const runs = (() => {
    if (!selected) return []
    const ids = selected.conversationIds?.length
      ? selected.conversationIds
      : selected.lastConversationId
        ? [selected.lastConversationId]
        : []
    return ids
      .map((id) => app.conversations.find((c) => c.id === id))
      .filter((c) => c !== undefined)
  })()
  /** 记录里有、但会话已经不在了的条数（提示一句「有些运行记录已被删除」） */
  const missingRuns = (() => {
    if (!selected) return 0
    const ids = selected.conversationIds?.length
      ? selected.conversationIds
      : selected.lastConversationId
        ? [selected.lastConversationId]
        : []
    return ids.length - runs.length
  })()

  const total = triggers.list.length
  const enabledCount = triggers.list.filter((t) => t.enabled).length

  /**
   * 选中那条绑的工作区**目录没了**（服务端巡检标的 `dirMissing`）：调度器到点会拒跑
   * （见 `scheduler.processFire`：不退化到临时工作区，免得产物落到别处还显示「跑完了」）。
   * 这里明说一句，否则用户只会看到「这条任务再也不动了」。
   */
  const selectedWorkspaceMissing = !!(
    selected?.workspaceId &&
    app.workspaces.find((w) => w.id === selected.workspaceId)?.dirMissing
  )

  /**
   * 归属那一行的文案：没绑 = 「每次运行自动创建」（这是**正常状态**，不是缺失）；
   * 绑了但项目已被删 = 兜底名（触发时会自动退化成临时工作区，见调度器）。
   */
  const workspaceNameOf = (id?: string): string => {
    if (!id) return t(AUTO_GROUP_NAME)
    return app.workspaces.find((w) => w.id === id)?.name ?? t(ORPHAN_NAME)
  }

  const openCreate = () => {
    setEditing(null)
    setEditOpen(true)
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await triggers.refresh()
    } finally {
      setRefreshing(false)
    }
  }

  /** 「立即运行」：服务端只回「已受理」，会话异步起，所以成功提示在面板这一层给 */
  const runNow = async (trigger: TaskTrigger) => {
    try {
      await triggers.runTrigger(trigger.id)
      toast.success(t('已开始运行「{name}」', { name: trigger.name }))
    } catch {
      // 失败提示已由 hook 里的 `run()` 统一 toast
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        顶部工具条：窄屏竖排、宽屏横排（`sm:` 断点切换）。
        不能一直是 `justify-between`：右边带字按钮是 `shrink-0`，标题块是 `min-w-0`，
        窄屏下标题会被压到 0 宽（`LogsPanel` 同款处理）。
      */}
      <div className="flex shrink-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{t('定时任务')}</h1>
          <p className="text-xs text-muted-foreground">
            {t('到点自动起一轮会话 · 共 {total} 条 · {enabledCount} 条启用中', {
              total,
              enabledCount
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
            {t('刷新')}
          </Button>
          {/* 不再要求「先有项目」：不绑工作区也能建（每次触发自动建临时工作区） */}
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            {t('新建定时任务')}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 pb-4 sm:px-5 lg:flex-row">
        {/* 左列：按归属（工作区 / 自动创建）分组的清单 */}
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border lg:max-w-md">
          {triggers.loading && total === 0 ? (
            <div className="flex h-full items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('正在加载定时任务…')}
            </div>
          ) : total === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
              <CalendarClock className="size-8 text-muted-foreground/50" />
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('还没有定时任务')}</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1 p-2">
              {groups.map((group) => (
                <div key={group.id} className="flex flex-col gap-0.5">
                  {/* 归属分组：「自动创建」那组不是项目，图标也换掉，别让人以为点它是个目录 */}
                  <div
                    className={cn(
                      'flex h-7 items-center gap-1.5 px-2 text-xs font-medium',
                      group.name === ORPHAN_NAME
                        ? 'text-amber-600 dark:text-amber-500'
                        : 'text-muted-foreground'
                    )}
                  >
                    {group.id === AUTO_GROUP ? (
                      <FolderPlus className="size-3.5 shrink-0" />
                    ) : (
                      <Folder className="size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {group.id === AUTO_GROUP
                        ? t(AUTO_GROUP_NAME)
                        : group.name === ORPHAN_NAME
                          ? t(ORPHAN_NAME)
                          : group.name}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {byWorkspace.get(group.id)?.length ?? 0}
                    </span>
                  </div>
                  {(byWorkspace.get(group.id) ?? []).map((trigger) => {
                    const Icon = triggerIcon(trigger)
                    const recent =
                      trigger.lastTriggeredAt !== undefined &&
                      now - trigger.lastTriggeredAt < RECENT_MS
                    const active = selected?.id === trigger.id
                    return (
                      <div
                        key={trigger.id}
                        // 选中态用左侧色条 + 底色：清单里同时有停用（压暗）与选中两种状态，
                        // 只用底色的话停用的那条选中了也看不出来
                        className={cn(
                          'flex w-full items-start gap-1 rounded-md border-l-2 px-2 py-1.5 text-sm transition-colors',
                          active
                            ? 'border-l-primary bg-primary-soft'
                            : 'border-l-transparent hover:bg-foreground/5',
                          !trigger.enabled && 'opacity-55'
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(trigger.id)
                            // 换了选中 = 放弃上一次的删除确认（与「点别处就反悔」同一口径）
                            setArmedId(null)
                          }}
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                          title={`${trigger.name} — ${scheduleText(trigger)} · ${lastText(trigger, now)}`}
                        >
                          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              {recent && (
                                <span
                                  className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                                  aria-label={t('刚触发过')}
                                />
                              )}
                              <span className="min-w-0 flex-1 truncate">{trigger.name}</span>
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {scheduleText(trigger)} · {lastText(trigger, now)}
                            </span>
                          </span>
                        </button>
                        {/* 行尾「立即运行」：与「编辑 / 删除」同一套小图标钮。**放在行按钮外面**
                            （嵌套按钮不合法），所以点它不会连带选中 / 打开这一行 */}
                        <IconTip label={t('立即运行')}>
                          <RowActionButton
                            className="mt-0.5 shrink-0"
                            aria-label={t('立即运行定时任务')}
                            onClick={() => void runNow(trigger)}
                          >
                            <Play className="size-3.5" />
                          </RowActionButton>
                        </IconTip>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右列：选中那条的详情 + 操作 */}
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
          {!selected ? (
            <div className="flex h-full items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
              {t('选中左边一条定时任务查看详情。')}
            </div>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-base font-semibold">{selected.name}</h2>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    {selected.workspaceId ? (
                      <Folder className="size-3 shrink-0" />
                    ) : (
                      <FolderPlus className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{workspaceNameOf(selected.workspaceId)}</span>
                    {selectedWorkspaceMissing ? (
                      <span className="shrink-0 text-destructive">
                        {t('（目录不存在，触发会被跳过）')}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {/*
                    开关直接写盘（`toggleTrigger`），不做二次确认：这是**可逆**操作，
                    点错了再点回来即可 —— 与删除不同，删除才需要那两步。

                    ⚠️ **必须用一层 `<span>` 当 tooltip 的触发器，不能把 IconTip 直接套在
                    Switch 上**（这一条是踩过的坑，别「顺手」简化掉）：
                    `TooltipTrigger asChild` 会往子元素注 `data-state="closed|delayed-open"`，
                    而 Radix 的 Switch 恰恰靠 `data-state="checked|unchecked"` 决定轨道颜色 ——
                    并且它内部把 `{...switchProps}` 排在自带的 `data-state` **之后**，所以
                    传进来的 tooltip 状态会把它覆盖掉。结果：`data-checked` / `data-unchecked`
                    两个档位都不命中，轨道背景整个丢失、只剩一个和面板同色的圆点，
                    看起来就是「按钮不见了，只有悬停时才冒出一个 tooltip」。
                  */}
                  <IconTip label={selected.enabled ? t('停用') : t('启用')}>
                    <span className="inline-flex items-center">
                      <Switch
                        checked={selected.enabled}
                        onCheckedChange={(checked) =>
                          void triggers.toggleTrigger(selected.id, checked)
                        }
                        aria-label={
                          selected.enabled ? t('停用定时任务') : t('启用定时任务')
                        }
                      />
                    </span>
                  </IconTip>
                  <IconTip label={t('编辑')}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-8 p-0"
                      aria-label={t('编辑定时任务')}
                      onClick={() => {
                        setEditing(selected)
                        setEditOpen(true)
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  </IconTip>
                  {/*
                    两步删除：第一次点变成红框勾，第二次才真删（`InlineDeleteButton` 只负责
                    交互，`armed` 由这里持有）。选中换了就把 `armedId` 清掉 —— 反悔的路是
                    「看点别的」，不是等超时。

                    ⚠️ 它自带 `IconTip`，别在外面再套一层（会出两个 tooltip）；默认态是
                    `opacity-0 / group-hover` 浮现，那是给侧栏列表行用的 —— 这里是常驻的
                    详情工具条，没有可 hover 的行，所以用 `className` 覆盖成常显。
                  */}
                  <InlineDeleteButton
                    armed={armedId === selected.id}
                    title={selected.name}
                    className="size-8 rounded-md text-muted-foreground opacity-100 hover:bg-foreground/10 hover:text-destructive"
                    onArm={() => setArmedId(selected.id)}
                    onConfirm={() => {
                      setArmedId(null)
                      void triggers.deleteTrigger(selected.id)
                    }}
                  />
                </div>
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('触发方式')}</dt>
                <dd className="min-w-0 break-all">{scheduleText(selected)}</dd>
                <dt className="text-muted-foreground">{t('状态')}</dt>
                <dd>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5',
                      selected.enabled ? 'text-emerald-600 dark:text-emerald-500' : ''
                    )}
                  >
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        selected.enabled ? 'bg-emerald-500' : 'bg-muted-foreground'
                      )}
                    />
                    {selected.enabled ? t('启用中') : t('已停用')}
                  </span>
                </dd>
                <dt className="text-muted-foreground">{t('上次触发')}</dt>
                <dd>{lastText(selected, now)}</dd>
                <dt className="text-muted-foreground">{t('创建时间')}</dt>
                <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">{t('权限')}</dt>
                <dd
                  className={cn(
                    'min-w-0',
                    (selected.template.permissionMode ?? 'full') === 'confirm' &&
                      'text-amber-600 dark:text-amber-500'
                  )}
                >
                  {permissionOption(selected.template.permissionMode ?? 'full').label}
                  {(selected.template.permissionMode ?? 'full') === 'confirm' && (
                    <span className="ml-1.5 text-xs">{t('（无人值守时会拒绝写操作）')}</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">{t('模型 / Agent')}</dt>
                <dd className="min-w-0 truncate">
                  {modelTextOf(selected.template, app.models, app.acpAgents)}
                </dd>
                {/* 外部 Agent 自带工具、不读这两个字段（表单里那两颗对它就是灰占位，
                    保存时也不写进模板）：这一档合并成一行「不适用」，否则会显示
                    「浏览器：关闭 / MCP：不挂」这种用户从没设过的假事实 */}
                {selected.template.backend === 'acp' ? (
                  <>
                    <dt className="text-muted-foreground">{t('浏览器 / MCP')}</dt>
                    <dd className="min-w-0">{t('不适用（外部 Agent 自带工具）')}</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-muted-foreground">{t('浏览器')}</dt>
                    <dd className="min-w-0">
                      {selected.template.browserSettings
                        ? selected.template.browserSettings.enabled
                          ? t('开启')
                          : t('关闭')
                        : // 存量任务没有这个字段 = 触发时按**全局默认**走（不是「关闭」）
                          t('跟随全局默认')}
                    </dd>
                    <dt className="text-muted-foreground">MCP</dt>
                    <dd className="min-w-0">
                      {selected.template.mcpServerIds?.length
                        ? selected.template.mcpServerIds
                            .map(
                              (id) =>
                                app.mcpServers.find((server) => server.id === id)?.name ?? id
                            )
                            .join('、')
                        : t('不挂')}
                    </dd>
                  </>
                )}
              </dl>

              <div className="space-y-1.5">
                <h3 className="text-sm font-medium">{t('需求')}</h3>
                {selected.template.prompt ? (
                  <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
                    {selected.template.prompt}
                  </pre>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('（没有填需求）')}</p>
                )}
              </div>

              {/*
                运行记录：这条任务每跑一轮都会起一个会话，这里按时间倒序列出来，点一条直接
                打开那个会话（`openConversation` 会切到对话视图并把标签落到位）。

                会话被删掉的条目**不列**（点了也是死链），只在底部提示一句还有几条已经没了。
              */}
              <div className="space-y-1.5">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  {t('运行记录')}
                  {runs.length > 0 && (
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                      {t('{n} 次', { n: runs.length })}
                    </span>
                  )}
                </h3>
                {runs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {selected.enabled
                      ? t('还没跑过：到点会在侧栏里出现一个会话。')
                      : t('还没跑过（现在是停用状态）。')}
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-md border divide-y divide-border">
                    {runs.map((conversation) => (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() =>
                          openConversation(conversation.id, conversation.workspaceId)
                        }
                        title={t('打开这个会话：{title}', {
                          title: conversationTitle(conversation.title)
                        })}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-foreground/5"
                      >
                        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{conversationTitle(conversation.title)}</span>
                        {/* 还没点开过：与侧栏会话行同一个标记 */}
                        {conversation.unseen && (
                          <span
                            aria-label={t('未查看')}
                            className="size-1.5 shrink-0 rounded-full bg-destructive"
                          />
                        )}
                        {/* 用 `createdAt`（这一轮什么时候起的），不是 `updatedAt`
                            —— 后者会随跑的过程一直往后走，看着像「刚刚又跑了一次」 */}
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {shortTime(conversation.createdAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {missingRuns > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('另有 {n} 条会话已被删除，不再列出。', { n: missingRuns })}
                  </p>
                )}
              </div>

              <p className="flex items-start gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs leading-5 text-muted-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {t('跑出来的会话与手动新建的会话完全一样，在侧栏里能看到。')}
                {selected.workspaceId
                  ? t('每次触发都落在上面那个工作区里。')
                  : t('每次触发都会新建一个临时工作区（空目录、不进项目列表）。')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/*
        新建 / 编辑弹窗：工作区 / 权限 / 模型（含外部 Agent）/ MCP 都与「新建会话」同一套数据源，
        临时工作区不进下拉（那是自动建的，不该被手动选中）。
      */}
      <TriggerEditDialog
        triggers={triggers}
        workspaces={app.workspaces.filter((workspace) => workspace.path && !workspace.scratch)}
        models={app.models}
        acpAgents={app.acpAgents}
        mcpServers={app.mcpServers}
        defaultPermissionMode={app.permissionMode}
        // 没装就不显示那颗开关（与聊天工具条同一条判据）
        browserInstalled={app.browserInstalled}
        // 模型下拉与会话详情同一颗：窗口兜底值、设置齿轮都从同一处来
        // （`defaultContextWindow` 是 `number | null`，转 undefined 走组件内的默认兜底）
        defaultContextWindow={app.defaultContextWindow ?? undefined}
        onOpenSettings={openSettingsTab}
        trigger={editing}
        open={editOpen}
        onOpenChange={(next) => {
          setEditOpen(next)
          // 关掉后把「正在编辑」清掉：下次点「新建」必须是干净的表单
          if (!next) setEditing(null)
        }}
      />
    </div>
  )
}
