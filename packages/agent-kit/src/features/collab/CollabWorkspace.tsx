'use client'

/**
 * 多智能体协作的**Agent 名单**（不再是画布）。
 *
 * 一个 collab 会话就是「一条共享会话 + 若干平级 Agent」：
 * - 这里负责增删改 Agent、显示实时状态 / 正在做什么、调并行与单轮运行上限；
 * - 右侧永远是同一条会话时间线，所有 Agent 的回复带名字进去；
 * - 路由（@ 点名 / 无 @ 广播判定 / SendMessage 投递）在服务端 `CollabRuntime.runTurn`。
 */
import { useMemo, useState } from 'react'
import {
  Activity,
  Bot,
  CircleStop,
  Loader2,
  MessagesSquare,
  Pencil,
  Plus,
  Settings2,
  Trash2
} from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Badge } from '@fizz/ui/badge'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { AgentConfigDialog } from '@fizz/agent-kit/features/collab/AgentConfigDialog'
import { STATUS_META, displayLiveText } from '@fizz/agent-kit/features/collab/agent-messages'
import {
  DEFAULT_COLLAB_SETTINGS,
  createCollabAgent,
  normalizeCollabSettings,
  type CollabAgentConfig,
  type CollabAgentRuntime,
  type CollabState,
  type CollabTask
} from '@fizz/contracts/types'

/** 这个 Agent 最近一次运行（用于「停止」按钮） */
function activeTaskOf(state: CollabState | null, agentId: string): CollabTask | null {
  if (!state) return null
  return (
    [...state.tasks]
      .filter((task) => task.agentId === agentId)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  )
}

export function CollabWorkspace({ app }: { app: AgentApp }) {
  const tr = useT()
  const confirm = useConfirm()
  const conversation = app.conversations.find((item) => item.id === app.activeConversationId)
  const settings = useMemo(
    () => normalizeCollabSettings(conversation?.collab ?? DEFAULT_COLLAB_SETTINGS),
    [conversation?.collab]
  )
  const state = app.collab?.state ?? null
  const liveText = app.collab?.liveText ?? {}
  const [editing, setEditing] = useState<{ agent: CollabAgentConfig; isNew: boolean } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState({
    maxParallel: settings.maxParallel,
    maxTasksPerTurn: settings.maxTasksPerTurn
  })
  const [logOpen, setLogOpen] = useState(false)

  const openSettings = (): void => {
    setSettingsDraft({
      maxParallel: settings.maxParallel,
      maxTasksPerTurn: settings.maxTasksPerTurn
    })
    setSettingsOpen(true)
  }

  const save = async (next: typeof settings): Promise<void> => {
    await app.saveCollabSettings(next)
  }

  const runningCount = settings.agents.filter(
    (agent) => state?.statuses[agent.id]?.status === 'running'
  ).length

  const addAgent = (): void => {
    // 默认名不能重复：@ 路由按名字解析，两个同名 Agent 会被同一条 @ 一起命中
    const names = new Set(settings.agents.map((agent) => agent.name))
    let index = settings.agents.length + 1
    while (names.has(`智能体 ${index}`)) index += 1
    setEditing({ agent: createCollabAgent({ name: `智能体 ${index}` }), isNew: true })
  }

  const upsertAgent = async (agent: CollabAgentConfig): Promise<void> => {
    const exists = settings.agents.some((item) => item.id === agent.id)
    const agents = exists
      ? settings.agents.map((item) => (item.id === agent.id ? agent : item))
      : [...settings.agents, agent]
    setEditing(null)
    await save({ ...settings, agents })
  }

  const removeAgent = async (agent: CollabAgentConfig): Promise<void> => {
    const ok = await confirm({
      title: tr('删除这个智能体？'),
      description: tr('删除后它不再接收 @ 点名或广播；已开始的运行会被取消，历史消息保留。'),
      confirmLabel: tr('删除'),
      destructive: true
    })
    if (!ok) return
    for (const task of state?.tasks ?? []) {
      if (task.agentId !== agent.id) continue
      if (task.status === 'queued' || task.status === 'running') {
        await app.cancelCollabTask(task.id)
      }
    }
    await save({
      ...settings,
      agents: settings.agents.filter((item) => item.id !== agent.id)
    })
  }

  const stopAgent = async (agent: CollabAgentConfig): Promise<void> => {
    const task = activeTaskOf(state, agent.id)
    if (task && (task.status === 'queued' || task.status === 'running')) {
      await app.cancelCollabTask(task.id)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Bot className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{tr('协作智能体')}</div>
          <div className="truncate text-xs text-muted-foreground">
            {tr('@ 点名由该智能体处理；不点名时全体判断是否需要接手')}
          </div>
        </div>
        {runningCount > 0 && (
          <Badge variant="secondary" className="gap-1">
            <Loader2 className="size-3 animate-spin" />
            {runningCount}
          </Badge>
        )}
        <Button variant="ghost" size="icon" onClick={() => setLogOpen(true)} title={tr('协作记录')}>
          <MessagesSquare className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={openSettings} title={tr('协作设置')}>
          <Settings2 className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={addAgent} title={tr('添加智能体')}>
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {settings.agents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <Bot className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{tr('还没有智能体，先添加一个')}</p>
            <Button size="sm" onClick={addAgent}>
              <Plus className="size-4" />
              {tr('添加智能体')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {settings.agents.map((agent) => {
              const status: CollabAgentRuntime = state?.statuses[agent.id] ?? {
                status: 'idle',
                updatedAt: 0
              }
              const meta = STATUS_META[status.status] ?? STATUS_META.idle
              const task = activeTaskOf(state, agent.id)
              const live = displayLiveText(liveText[agent.id] ?? '')
              const preview = live || (task?.status === 'error' ? (task.error ?? '') : '')
              const busy =
                status.status === 'running' ||
                status.status === 'queued' ||
                status.status === 'waiting'
              return (
                <div
                  key={agent.id}
                  className={cn(
                    'group rounded-lg border bg-card px-2.5 py-2 transition-colors',
                    busy && 'border-emerald-500/40'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      @{agent.name}
                    </span>
                    <span className={cn('shrink-0 text-xs', meta.text)}>{tr(meta.label)}</span>
                    {busy && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={() => void stopAgent(agent)}
                        title={tr('停止')}
                      >
                        <CircleStop className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={() => setEditing({ agent, isNew: false })}
                      title={tr('编辑')}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={() => void removeAgent(agent)}
                      title={tr('删除')}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  {agent.role && (
                    <div className="mt-1 truncate text-xs text-muted-foreground">{agent.role}</div>
                  )}
                  {(preview || status.toolName) && (
                    <div className="mt-1.5 rounded-md bg-muted/50 px-2 py-1">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Activity className="size-3" />
                        <span className="truncate">
                          {status.toolName
                            ? `${tr('正在执行')} ${status.toolName}`
                            : tr('正在回复')}
                        </span>
                      </div>
                      {preview && (
                        <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                          {preview}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {editing && (
        <AgentConfigDialog
          app={app}
          agent={editing.agent}
          isNew={editing.isNew}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSave={(agent) => void upsertAgent(agent)}
        />
      )}

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tr('协作设置')}</DialogTitle>
            <DialogDescription>
              {tr('控制同一时刻并行跑几个 Agent，以及单轮最多触发多少次运行（含 SendMessage 唤醒）。')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="collab-max-parallel">{tr('并行上限')}</Label>
              <Input
                id="collab-max-parallel"
                type="number"
                min={1}
                max={8}
                value={settingsDraft.maxParallel}
                onChange={(event) =>
                  setSettingsDraft((prev) => ({
                    ...prev,
                    maxParallel: Math.min(8, Math.max(1, Number(event.target.value) || 1))
                  }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="collab-max-tasks">{tr('单轮运行上限')}</Label>
              <Input
                id="collab-max-tasks"
                type="number"
                min={1}
                max={64}
                value={settingsDraft.maxTasksPerTurn}
                onChange={(event) =>
                  setSettingsDraft((prev) => ({
                    ...prev,
                    maxTasksPerTurn: Math.min(64, Math.max(1, Number(event.target.value) || 1))
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setSettingsOpen(false)
                void save({ ...settings, ...settingsDraft })
              }}
            >
              {tr('完成')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="flex max-h-[80dvh] flex-col gap-3 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{tr('协作记录')}</DialogTitle>
            <DialogDescription>
              {tr('用户点名、Agent 之间的 SendMessage 投递与每条回复的摘要。')}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-2">
            {(state?.messages ?? []).length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {tr('还没有协作记录')}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {(state?.messages ?? []).slice(-120).map((message) => (
                  <div key={message.id} className="rounded-md bg-muted/40 px-2 py-1.5">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {message.from === 'user'
                          ? tr('用户')
                          : `@${settings.agents.find((a) => a.id === message.from)?.name ?? message.from}`}
                      </span>
                      <span>→</span>
                      <span>
                        @{settings.agents.find((a) => a.id === message.to)?.name ?? message.to}
                      </span>
                      <span className="ml-auto">{message.kind}</span>
                    </div>
                    <div className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {message.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
