'use client'

/**
 * SSH 隧道面板（全局单例标签 `tunnel:list`）。
 *
 * 三类转发各占一行：
 * - **本地转发（-L）**：服务端监听 `bindHost:bindPort`，连接经 SSH 送到远端可达的 `targetHost:targetPort`；
 * - **远程转发（-R）**：让**远端主机**监听 `bindHost:bindPort`，连接经 SSH 回到服务端可达的 `targetHost:targetPort`；
 * - **动态代理（-D）**：服务端开一个 SOCKS5，客户端把它当代理就能访问远端内网。
 *
 * ## ⚠️ 监听端口在哪台机器上
 *
 * 在**跑 server 的那台机器**上，不是浏览器那台 —— 这是 `ssh -L/-R/-D` 的标准语义
 * （监听端永远在 SSH 客户端侧），而本仓库里 SSH 客户端只有 server 一个：
 * 桌面端是把 server 装进进程内跑（所以正好是你本机），VPS 上部署的 web 则是 VPS 自己。
 *
 * 所以文案一律写「**服务端所在机器的端口**」，并在标题栏标出当前是哪台：
 * 桌面端显示「本机」，web 显示当前访问的域名（页面就是由那台 server 提供的）。
 *
 * ## 数据来源
 *
 * 配置（`app.sshTunnels`）与运行态（`app.tunnelRuntimes`）都来自 state-ws 的
 * `sshTunnels` 快照域：起停 / 连接数变化由服务端推送，**面板不轮询**。
 * 启停动作的返回也直接写回 store（见 store 的 `withTunnelSnapshot`），
 * 所以点下去那一帧就有反馈，不必等下一帧推送。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  MoveLeft,
  MoveRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Shuffle,
  Square,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
import { Switch } from '@fizz/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@fizz/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
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
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import {
  PanelHeader,
  PanelHeaderActionLabel
} from '@fizz/agent-kit/shared/components/PanelHeader'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { getToolTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type {
  HostConfig,
  SshHostConfig,
  SshTunnel,
  SshTunnelInput,
  SshTunnelRuntime,
  SshTunnelType
} from '@fizz/contracts/types'

/** 回环地址：默认绑定，且是**唯一**不需要二次确认的选择 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** 类型全称（列表行里用它，一行说清是哪种转发） */
const TYPE_LABEL: Record<SshTunnelType, string> = {
  local: '本地转发（-L）',
  remote: '远程转发（-R）',
  dynamic: '动态代理（-D，SOCKS5）'
}

/**
 * 类型 Tab 的短文案。
 *
 * Tab 条在一行里平摊三格，用的是 `TYPE_LABEL` 那种全称（「动态代理（-D，SOCKS5）」）
 * 会把 `sm:max-w-md` 的弹窗撑破 —— Tab 只是选哪一类，解释性文字交给下面的 `TYPE_HINT`。
 */
const TYPE_TAB_LABEL: Record<SshTunnelType, string> = {
  local: '本地转发 -L',
  remote: '远程转发 -R',
  dynamic: '动态代理 -D'
}

const TYPE_HINT: Record<SshTunnelType, string> = {
  local: '在服务端所在机器监听一个端口，连接经 SSH 送到「远端主机可达」的目标地址。',
  remote: '让远端主机监听一个端口，连接经 SSH 回到服务端，再送到「服务端所在机器可达」的目标地址。',
  dynamic: '在服务端所在机器开一个 SOCKS5 代理，客户端把它当代理即可访问远端内网（无需逐个配端口）。'
}

/** 类型图标：-L 往外送（→），-R 往回收（←），-D 是通用代理 */
function typeIcon(type: SshTunnelType): typeof MoveRight {
  if (type === 'remote') return MoveLeft
  if (type === 'dynamic') return Shuffle
  return MoveRight
}

/** 一行的转发摘要（与运行日志同风格，见服务端 `ssh/tunnels.ts`） */
function tunnelSummary(tunnel: SshTunnel): string {
  const bind = `${tunnel.bindHost}:${tunnel.bindPort || '自动'}`
  if (tunnel.type === 'dynamic') return `SOCKS5 ${bind}`
  const target = `${tunnel.targetHost ?? '?'}:${tunnel.targetPort ?? '?'}`
  return tunnel.type === 'remote' ? `${bind} → 服务端 ${target}` : `${bind} → ${target}`
}

/** 隧道名字（备注优先） */
function tunnelName(tunnel: SshTunnel): string {
  return tunnel.label?.trim() || tunnelSummary(tunnel)
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

export function TunnelPanel({ tabKey }: { tabKey: string }) {
  const { app } = useAppContext()

  /** 服务端所在机器的显示名：桌面端就是本机，web 就是当前访问的域名（页面由那台 server 提供） */
  const serverLabel = getAgentHostOrNull()?.capabilities.localServer ? '本机' : window.location.host

  const hostById = useMemo(() => {
    const map = new Map<string, HostConfig>()
    for (const host of app.sshHosts) map.set(host.id, host)
    return map
  }, [app.sshHosts])

  const runtimeById = useMemo(() => {
    const map = new Map<string, SshTunnelRuntime>()
    for (const runtime of app.tunnelRuntimes) map.set(runtime.id, runtime)
    return map
  }, [app.tunnelRuntimes])

  /** 可选主机：只有 SSH 主机能承载隧道（本机终端没有可复用的 SSH 连接） */
  const sshHosts = useMemo(
    () => app.sshHosts.filter((host): host is SshHostConfig => host.kind !== 'local'),
    [app.sshHosts]
  )

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<SshTunnel | null>(null)
  /** 新建时的预选主机（主机右键「隧道…」带进来） */
  const [presetHostId, setPresetHostId] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SshTunnel | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  /**
   * 从主机右键菜单进来时：开「新建隧道」弹窗并预选那台主机。
   *
   * 依赖 `tunnelRequestSeq`（每次带 hostId 打开都 +1）而不是 `tunnelHostId`：
   * 同一台主机连点两次，hostId 没变，只比它收不到任何信号（见 `tool-tabs.ts`）。
   * 值在 effect 里现取，避免把 `getToolTab` 的返回值关进闭包。
   */
  const requestSeq = getToolTab(tabKey)?.tunnelRequestSeq
  useEffect(() => {
    if (!requestSeq) return
    setEditing(null)
    setPresetHostId(getToolTab(tabKey)?.tunnelHostId ?? '')
    setFormOpen(true)
  }, [requestSeq, tabKey])

  /** 有非回环绑定时顶部给一条提醒（VPS 上等于把内网服务挂到公网） */
  const exposed = app.sshTunnels.filter((t) => !isLoopback(t.bindHost))

  const start = async (tunnel: SshTunnel): Promise<void> => {
    setBusyId(tunnel.id)
    try {
      await app.startSshTunnel(tunnel.id)
    } finally {
      setBusyId(null)
    }
  }

  const stop = async (tunnel: SshTunnel): Promise<void> => {
    setBusyId(tunnel.id)
    try {
      await app.stopSshTunnel(tunnel.id)
    } finally {
      setBusyId(null)
    }
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await app.refresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：版式见 `PanelHeader`（与定时任务 / 脚本 / 日志同一套：左标题右按钮） */}
      <PanelHeader
        title="SSH 隧道"
        description={`监听端口开在 ${serverLabel}（服务端所在机器）上，不是当前浏览器这台`}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label="刷新"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
              <PanelHeaderActionLabel>刷新</PanelHeaderActionLabel>
            </Button>
            <Button
              size="sm"
              aria-label="新建隧道"
              onClick={() => {
                setEditing(null)
                setPresetHostId(sshHosts[0]?.id ?? '')
                setFormOpen(true)
              }}
            >
              <Plus className="size-4" />
              <PanelHeaderActionLabel>新建隧道</PanelHeaderActionLabel>
            </Button>
          </>
        }
      />

      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          // 空态时把这块变成立式 flex，好让提示占满剩余高度（见下面那个 `flex-1`）
          app.sshTunnels.length === 0 && 'flex flex-col'
        )}
      >
        {exposed.length > 0 && (
          // 左右边距跟着顶栏（`PanelHeader` 的 `px-4 sm:px-5`），否则这条提醒会比标题缩进 4px
          <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 sm:mx-5 dark:text-amber-400">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <div className="leading-5">
              有 {exposed.length} 条隧道的监听地址不是回环地址（{exposed.map((t) => t.bindHost).join('、')}）。
              这些端口不经过登录鉴权，若服务端部署在有公网 IP 的机器上，等于把它们直接暴露出去。
            </div>
          </div>
        )}

        {app.sshTunnels.length === 0 ? (
          /*
            `flex-1` 撑满整块内容区再居中：只靠内容定高的话，`justify-center` 没有可分的
            空间，提示会贴在顶部（横向倒是因为 `items-center` 看着是居中的）。
          */
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <MoveRight className="size-8 opacity-40" />
            <div className="text-sm font-medium">还没有隧道</div>
            <p className="max-w-xs text-xs leading-5 text-muted-foreground">
              {sshHosts.length === 0
                ? '先在「主机」里添加一台 SSH 主机，再回来配隧道。'
                : '新建一条隧道：本地转发（-L）最常用，动态代理（-D）可以一次打通整个远端内网。'}
            </p>
          </div>
        ) : (
          <ul className="divide-y">
            {app.sshTunnels.map((tunnel) => {
              const runtime = runtimeById.get(tunnel.id)
              const status = runtime?.status ?? 'stopped'
              const host = hostById.get(tunnel.hostId)
              const Icon = typeIcon(tunnel.type)
              const busy = busyId === tunnel.id
              return (
                // 行首缩进与顶栏一致（`px-4 sm:px-5`），否则标题与列表看着对不齐
                <li key={tunnel.id} className="px-4 py-2.5 sm:px-5">
                  <div className="flex items-start gap-2.5">
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {tunnelName(tunnel)}
                        </span>
                        <StatusBadge status={status} />
                        {tunnel.autoStart && (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            自动启动
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {tunnelSummary(tunnel)}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">
                          {host ? host.name : '主机已删除'}
                          <span className="mx-1">·</span>
                          {TYPE_LABEL[tunnel.type]}
                        </span>
                        {status === 'running' && runtime?.conns ? (
                          <span className="shrink-0">{runtime.conns} 条连接</span>
                        ) : null}
                      </div>
                      {status === 'error' && runtime?.error && (
                        <div className="mt-1 text-xs leading-5 text-destructive">{runtime.error}</div>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {status === 'running' || status === 'starting' ? (
                        <IconTip label="停止">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="停止"
                            disabled={busy}
                            onClick={() => void stop(tunnel)}
                          >
                            <Square className="size-3.5" />
                          </Button>
                        </IconTip>
                      ) : (
                        <IconTip label="启动">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="启动"
                            disabled={busy}
                            onClick={() => void start(tunnel)}
                          >
                            <Play className="size-3.5" />
                          </Button>
                        </IconTip>
                      )}
                      <IconTip label="编辑">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="编辑"
                          onClick={() => {
                            setEditing(tunnel)
                            setPresetHostId(tunnel.hostId)
                            setFormOpen(true)
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      </IconTip>
                      <IconTip label="删除">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="删除"
                          onClick={() => setDeleteTarget(tunnel)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </IconTip>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <TunnelDialog
        app={app}
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        hosts={sshHosts}
        presetHostId={presetHostId}
        serverLabel={serverLabel}
      />

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        title="删除隧道？"
        description={
          deleteTarget
            ? `「${tunnelName(deleteTarget)}」的配置会被删除${
                runtimeById.get(deleteTarget.id)?.status === 'running' ? '，正在运行的监听会先被停止' : ''
              }。删掉之后要重新添加才能再用。`
            : ''
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget
          setDeleteTarget(null)
          if (target) void app.deleteSshTunnel(target.id)
        }}
      />
    </div>
  )
}

/** 状态徽标：颜色 + 文案一起给（只靠颜色区分状态对色盲不友好） */
function StatusBadge({ status }: { status: SshTunnelRuntime['status'] }) {
  if (status === 'running') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        运行中
      </span>
    )
  }
  if (status === 'starting') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        <Loader2 className="size-2.5 animate-spin" />
        启动中
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
        <span className="size-1.5 rounded-full bg-destructive" />
        失败
      </span>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground/50" />
      未启动
    </span>
  )
}

/**
 * 新建 / 编辑隧道弹窗。
 *
 * 版式照项目约定：窄弹窗（`sm:max-w-md`）、字段**单列**，只有「地址 + 端口」这种
 * 明显不挤的配对才并成一行（短的那列留死一个最小值，别写裸 `1fr` —— 地址一长
 * 就会把端口挤成几像素）。
 *
 * 非回环监听要**二次确认**：那是把一个不鉴权的端口对外开出去，dogi 那边只给一条
 * 黄条提示，在 VPS 部署的场景下不够（面板里还有一条常驻提醒兜底）。
 */
function TunnelDialog({
  app,
  open,
  onOpenChange,
  editing,
  hosts,
  presetHostId,
  serverLabel
}: {
  app: ReturnType<typeof useAppContext>['app']
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: SshTunnel | null
  hosts: SshHostConfig[]
  presetHostId: string
  serverLabel: string
}) {
  const [hostId, setHostId] = useState('')
  const [type, setType] = useState<SshTunnelType>('local')
  const [bindHost, setBindHost] = useState('127.0.0.1')
  const [bindPort, setBindPort] = useState('')
  const [targetHost, setTargetHost] = useState('')
  const [targetPort, setTargetPort] = useState('')
  const [label, setLabel] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 非回环监听：待确认的绑定地址（确认后才真保存） */
  const [confirmBind, setConfirmBind] = useState<string | null>(null)

  // 每次打开按目标预填（弹窗本体常挂载，用初始值会一直是第一次那条的数据）
  useEffect(() => {
    if (!open) return
    setError(null)
    setConfirmBind(null)
    if (editing) {
      setHostId(editing.hostId)
      setType(editing.type)
      setBindHost(editing.bindHost)
      setBindPort(String(editing.bindPort))
      setTargetHost(editing.targetHost ?? '')
      setTargetPort(editing.targetPort ? String(editing.targetPort) : '')
      setLabel(editing.label ?? '')
      setAutoStart(editing.autoStart ?? false)
      return
    }
    setHostId(presetHostId || hosts[0]?.id || '')
    setType('local')
    setBindHost('127.0.0.1')
    setBindPort('')
    setTargetHost('')
    setTargetPort('')
    setLabel('')
    setAutoStart(false)
  }, [open, editing, presetHostId, hosts])

  const buildInput = (): SshTunnelInput => ({
    ...(editing ? { id: editing.id } : {}),
    hostId,
    type,
    bindHost: bindHost.trim() || '127.0.0.1',
    bindPort: Number(bindPort),
    ...(type === 'dynamic'
      ? {}
      : { targetHost: targetHost.trim(), targetPort: Number(targetPort) }),
    label: label.trim() || undefined,
    autoStart
  })

  /** 本地校验：只拦「一定不合法」的输入，语义性判断交给服务端（错误原文直接显示） */
  const validate = (input: SshTunnelInput): string | null => {
    if (!input.hostId) return '请选择主机'
    if (!Number.isInteger(input.bindPort) || input.bindPort < 0 || input.bindPort > 65535) {
      return '监听端口必须是 0 - 65535 的整数'
    }
    if (input.bindPort === 0 && input.type !== 'remote') {
      return '只有远程转发（-R）可以让远端自动分配端口'
    }
    if (input.type !== 'dynamic') {
      if (!input.targetHost) return '请填写目标地址'
      if (
        !Number.isInteger(input.targetPort) ||
        (input.targetPort as number) < 1 ||
        (input.targetPort as number) > 65535
      ) {
        return '目标端口必须是 1 - 65535 的整数'
      }
    }
    return null
  }

  const submit = async (): Promise<void> => {
    const input = buildInput()
    const message = validate(input)
    if (message) {
      setError(message)
      return
    }
    // 非回环监听：先确认（端口不经过登录鉴权，VPS 上有公网 IP 就等于对外开）
    if (!isLoopback(input.bindHost ?? '127.0.0.1')) {
      setConfirmBind(input.bindHost ?? '127.0.0.1')
      return
    }
    await save(input)
  }

  const save = async (input: SshTunnelInput): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ok = await app.saveSshTunnel(input)
      if (ok) {
        onOpenChange(false)
      } else {
        // 失败原因（服务端原话）已进 store 的 error，同时留在弹窗里方便对着改
        setError(null)
      }
    } finally {
      setBusy(false)
      setConfirmBind(null)
    }
  }

  const isDynamic = type === 'dynamic'
  const bindTarget = type === 'remote' ? '远端主机' : `服务端（${serverLabel}）`
  const targetScope = type === 'remote' ? `服务端（${serverLabel}）可达` : '远端主机可达'

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑隧道' : '新建隧道'}</DialogTitle>
            <DialogDescription>
              监听端口开在 {bindTarget} 上；请确认这是你想要的那台机器。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tunnel-host">主机</Label>
              <Select value={hostId} onValueChange={setHostId}>
                <SelectTrigger id="tunnel-host" className="w-full">
                  <SelectValue placeholder="选择承载隧道的 SSH 主机" />
                </SelectTrigger>
                <SelectContent>
                  {hosts.map((host) => (
                    <SelectItem key={host.id} value={host.id}>
                      {host.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>类型</Label>
              {/* 三类转发字段完全不同（-D 没有目标地址），用 Tab 一眼看清当前是哪一类 ——
                  与「添加主机」的「本地终端 / SSH」「密码 / 私钥」同一个做法（`HostDialog`）。 */}
              <Tabs
                value={type}
                onValueChange={(value) => setType(value as SshTunnelType)}
                className="w-full"
              >
                <TabsList className="w-full">
                  {(['local', 'remote', 'dynamic'] as SshTunnelType[]).map((value) => (
                    <TabsTrigger key={value} value={value}>
                      {TYPE_TAB_LABEL[value]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <p className="text-xs leading-5 text-muted-foreground">{TYPE_HINT[type]}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tunnel-bind">监听地址与端口</Label>
              <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
                <Input
                  id="tunnel-bind"
                  value={bindHost}
                  placeholder="127.0.0.1"
                  onChange={(e) => setBindHost(e.target.value)}
                />
                <Input
                  value={bindPort}
                  inputMode="numeric"
                  placeholder={type === 'remote' ? '0=自动' : '端口'}
                  onChange={(e) => setBindPort(e.target.value)}
                />
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {type === 'remote'
                  ? '在远端主机上监听的地址；填 0.0.0.0 还需远端 sshd 开启 GatewayPorts。'
                  : `在 ${serverLabel} 上监听的地址；非 127.0.0.1 的端口不经过登录鉴权。`}
              </p>
            </div>

            {!isDynamic && (
              <div className="space-y-1.5">
                <Label htmlFor="tunnel-target">目标地址与端口</Label>
                <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
                  <Input
                    id="tunnel-target"
                    value={targetHost}
                    placeholder={type === 'remote' ? '127.0.0.1' : '10.0.0.5'}
                    onChange={(e) => setTargetHost(e.target.value)}
                  />
                  <Input
                    value={targetPort}
                    inputMode="numeric"
                    placeholder="端口"
                    onChange={(e) => setTargetPort(e.target.value)}
                  />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  连接最终送到这里（要求 {targetScope}）。
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="tunnel-label">备注（可选）</Label>
              <Input
                id="tunnel-label"
                value={label}
                placeholder="例如：内网 PostgreSQL"
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="tunnel-auto">服务启动后自动拉起</Label>
                <p className="text-xs leading-5 text-muted-foreground">
                  服务端启动时自动连上并开始监听。
                </p>
              </div>
              <Switch id="tunnel-auto" checked={autoStart} onCheckedChange={setAutoStart} />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void submit()}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {editing ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 非回环监听的二次确认：说清「这个端口不过鉴权」，而不是一句「确定吗」 */}
      <AlertDialog open={confirmBind !== null} onOpenChange={(next) => !next && setConfirmBind(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>把监听地址设为 {confirmBind}？</AlertDialogTitle>
            <AlertDialogDescription>
              {type === 'remote'
                ? `这会让远端主机在所有网卡上监听该端口，任何能访问那台机器的人都可以经它转发；通常还需要远端 sshd 开启 GatewayPorts。`
                : `这会让 ${serverLabel} 在所有网卡上监听该端口，且该端口不经过本服务的登录鉴权。若这台机器有公网 IP，等于把目标服务直接暴露到公网。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const input = buildInput()
                setConfirmBind(null)
                void save(input)
              }}
            >
              仍然使用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
