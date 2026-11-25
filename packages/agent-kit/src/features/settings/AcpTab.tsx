/**
 * 设置弹窗 →「ACP agent」标签页：外部 ACP 进程的预设列表 + 检测 + 新增 / 编辑弹窗。
 * ACP 命令在服务端执行，这里只维护「怎么启动它」的配置。
 *
 * 模型清单**不在这里维护**：每个 agent 的候选模型由聊天里的模型选择器在首次进入时
 * 自动拉取并落盘（`agent.models`），要更新就在选择器二级标题行点刷新。
 * 但「检测」按钮会复用同一次探针，**顺手刷新模型缓存** —— 用户看到的是「这个 agent
 * 能不能正常用」，检测结果（成功 / 失败原因）由服务端落进 `agent.health`，
 * 刷新页面或换客户端都不会丢。配置页不列模型白名单：一个 agent 能选十几二十个模型，
 * 在设置里勾一遍既容易过期，也多一套和选择器不一致的口径。
 *
 * 「检测已安装」也走 Dialog（用户要求）：扫完服务端 PATH 后把候选列出来，勾选后一次写入，
 * 已添加过的按 `acpAgentKey` 自动勾上并标注「已添加」（勾选态 = 它已经在列表里，点不动）。
 * 空结果与探测失败同样开这个弹窗 —— 「没装」和「探测失败」是两件事，得在那里分开说。
 *
 * 新增与编辑共用同一套 Dialog（`editingId` 为空即新增）：字段完全一样，只是保存时多带一个
 * id —— 服务端带 id 走更新、不带 id 走新建（带 id 时不判重，见 `domain.saveAcpAgent`）。
 * 它本身嵌在「设置」弹窗里，属于 Radix 的嵌套 Dialog ——
 * 各自独立 portal + focus scope，Esc / 点遮罩只关最上层那一个。
 *
 * 删除走二次确认弹窗（名称 + 命令写进正文）：配置删掉就得重新敲一遍，
 * 比「点两次按钮就地确认」值得多问一句。
 */
import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  LoaderPinwheel,
  LogIn,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@fizz/ui/tooltip'
import { AcpAgentIcon } from '@fizz/agent-kit/shared/components/AcpAgentIcon'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import {
  ACP_AGENT_PRESETS,
  findAcpPreset,
  type AcpAgentPreset
} from '@fizz/agent-kit/shared/lib/acp-agent-presets'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { formatCommandArgs, parseCommandArgs } from '@fizz/agent-kit/shared/lib/command-args'
import { formatDuration } from '@fizz/agent-kit/shared/lib/duration'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type {
  AcpAgentType,
  AcpAllowStrategy,
  AcpAuthMethod,
  AcpProtocolVersion
} from '@fizz/acp'
import type { AcpAgentView, AcpProcessInfo, DetectedAcpAgent } from '@fizz/contracts/agent-api'
import { acpAgentKey } from '@fizz/contracts/agent-api'

/** agent 类型在界面上的短标签（列表行展示用） */
const ACP_TYPE_LABELS: Record<AcpAgentType, string> = {
  generic: '通用',
  opencode: 'opencode',
  pi: 'pi'
}

/** 上次检测时间的展示（坏时间戳不显示，别让配置里的一颗脏值把整行搞崩） */
function formatCheckedAt(ts: number): string {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

export function AcpTab({ app }: { app: AgentApp }) {
  const tr = useT()
  const [acpName, setAcpName] = useState('')
  const [acpCommand, setAcpCommand] = useState('')
  const [acpArgs, setAcpArgs] = useState('')
  /** 表单里的「类型」：决定会话里模式 UI 的语义与位置（opencode → 权限档；pi → 思考档） */
  const [acpType, setAcpType] = useState<AcpAgentType>('generic')
  /** 表单里的「完全放行答复」：`once` = 只允许一次（下次仍问）；`always` = 让 agent 永久记住 */
  const [acpAllow, setAcpAllow] = useState<AcpAllowStrategy>('once')
  /** 表单里的协议版本：`v1` = stable（缺省）；`v2` = draft（会话恢复走 resume） */
  const [acpProtocol, setAcpProtocol] = useState<AcpProtocolVersion>('v1')
  /**
   * 表单里这条配置的「预设身份」：新增时从预设带上，之后改命令 / 参数也不变。
   * 自定义 agent 为 null（图标回落 Bot）。
   */
  const [acpPresetId, setAcpPresetId] = useState<string | null>(null)
  /** 登录弹窗：探到 agent 广告的登录方式后让用户挑一个 */
  const [authOpen, setAuthOpen] = useState(false)
  const [authAgent, setAuthAgent] = useState<AcpAgentView | null>(null)
  const [authMethods, setAuthMethods] = useState<AcpAuthMethod[]>([])
  const [authBusy, setAuthBusy] = useState(false)
  /** 新增 / 编辑共用的表单弹窗是否打开 */
  const [adding, setAdding] = useState(false)
  /** 表单弹窗正在编辑哪个 agent（null = 新增） */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 检测弹窗是否打开（探测完成后才开，避免先弹一个空壳） */
  const [detectOpen, setDetectOpen] = useState(false)
  /** 正在扫服务端 PATH */
  const [detecting, setDetecting] = useState(false)
  /** 这一次探测到的候选（null = 还没探测过） */
  const [detected, setDetected] = useState<DetectedAcpAgent[] | null>(null)
  /** 探测失败的原因（null = 没失败） */
  const [detectError, setDetectError] = useState<string | null>(null)
  /** 弹窗里勾中的候选（`acpAgentKey`；已添加的不进这里，它们只回显成勾选） */
  const [picked, setPicked] = useState<string[]>([])
  /** 正在把勾中的候选逐个写进去 */
  const [savingPicked, setSavingPicked] = useState(false)
  /** 待确认删除的 ACP agent（二次确认弹窗；null = 关着） */
  const [deleteTarget, setDeleteTarget] = useState<AcpAgentView | null>(null)
  /** 正在检测可用性的 agent id（可同时检测不同 agent；同一行按钮显示转圈） */
  const [checkingIds, setCheckingIds] = useState<string[]>([])
  /** 检测请求本身失败（网络 / 服务端不可达）时的兜底错误；正常检测失败由服务端 health 提供 */
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({})

  /** 常驻进程诊断区：展开状态 / 快照 / 错误 */
  const [processesOpen, setProcessesOpen] = useState(false)
  const [processes, setProcesses] = useState<AcpProcessInfo[] | null>(null)
  const [processesLoading, setProcessesLoading] = useState(false)
  const [processesError, setProcessesError] = useState<string | null>(null)
  /** 待确认结束的常驻进程（二次确认；null = 关着） */
  const [processKillTarget, setProcessKillTarget] = useState<AcpProcessInfo | null>(null)

  const loadProcesses = async (): Promise<void> => {
    const api = app.api
    if (!api) return
    setProcessesLoading(true)
    setProcessesError(null)
    try {
      const res = await api.listAcpProcesses()
      setProcesses(res.sessions)
    } catch (err) {
      setProcessesError(err instanceof Error ? err.message : String(err))
    } finally {
      setProcessesLoading(false)
    }
  }

  const killProcess = async (p: AcpProcessInfo): Promise<void> => {
    const api = app.api
    if (!api) return
    try {
      await api.killAcpProcess(p.agentId, p.conversationId)
      await loadProcesses()
    } catch (err) {
      setProcessesError(err instanceof Error ? err.message : String(err))
    }
  }

  // 展开时每 5 秒刷一次：这是诊断视图，用户盯着看的时候应该能看到进程自己消失
  const processesApi = app.api
  useEffect(() => {
    if (!processesOpen || !processesApi) return
    // 用本帧的 api 建轮询：api 还没就绪时不要起一个永远拿不到数据的定时器
    const load = async (): Promise<void> => {
      setProcessesLoading(true)
      setProcessesError(null)
      try {
        const res = await processesApi.listAcpProcesses()
        setProcesses(res.sessions)
      } catch (err) {
        setProcessesError(err instanceof Error ? err.message : String(err))
      } finally {
        setProcessesLoading(false)
      }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [processesOpen, processesApi])

  /**
   * 已添加过的 agent 身份（命令 + 参数，判据与服务端 `acpAgentKey` 同一份）。
   * 探测列表据此标「已添加」并置灰，新增表单据此禁用保存 —— 服务端也会拦，
   * 但那是一条红字报错，能在点下去之前说清就别让人撞上去。
   */
  const addedKeys = new Set(app.acpAgents.map((a) => acpAgentKey(a)))
  /**
   * 预设卡片上的「已添加」标记：认落盘的 `preset`（老数据没有就按命令兜底）——
   * 用户改过命令 / 参数也还是同一个 agent，不该再让他从预设里加一份。
   */
  const addedPresetIds = new Set(
    app.acpAgents
      .map((a) => a.preset ?? findAcpPreset(a.command)?.id)
      .filter((id): id is string => Boolean(id))
  )
  /**
   * 判重用的身份集合：**编辑时把自己排除掉**。名称不参与判重，编辑时只改个名字 → key 还是
   * 自己那一个，拿全量集合去比会把自己挡下来（保存按钮永远禁用）。
   * 「探测到」列表里的「已添加」标记仍用全量 `addedKeys`。
   */
  const takenKeys = new Set(
    app.acpAgents.filter((a) => a.id !== editingId).map((a) => acpAgentKey(a))
  )
  /** 表单里这份草稿是不是已经有了（命令为空时不算重复，按钮本来也是禁用的） */
  const draftArgs = parseCommandArgs(acpArgs)
  const duplicate =
    !!acpCommand.trim() && takenKeys.has(acpAgentKey({ command: acpCommand, args: draftArgs }))



  /** 打开表单弹窗：给了 `agent` 就是编辑（预填它当前的配置），不给就是新增（空表单） */
  const openAcpForm = (agent?: AcpAgentView): void => {
    setEditingId(agent?.id ?? null)
    setAcpName(agent?.name ?? '')
    setAcpCommand(agent?.command ?? '')
    setAcpArgs(formatCommandArgs(agent?.args ?? []))
    setAcpType(agent?.type ?? 'generic')
    setAcpAllow(agent?.allowStrategy ?? 'once')
    setAcpProtocol(agent?.protocolVersion ?? 'v1')
    // 老数据没有 `preset`：按命令补一次，之后这条配置的身份就固定了
    setAcpPresetId(agent ? agent.preset ?? findAcpPreset(agent.command)?.id ?? null : null)
    setAdding(true)
  }

  /**
   * 关表单：**只收起，不动任何表单状态**。
   *
   * 退出动画期间 `DialogContent` 还挂着，这时候清 `editingId` 会让标题 / 描述瞬间从
   * 「编辑」闪成「添加」（用户报过「关闭时文案闪了一下、高度也跟着变」）。
   * 字段的复位交给下一次 `openAcpForm` / `openPresetForm` —— 它们每次都会把每个字段重写一遍。
   */
  const closeAcpForm = (): void => {
    setAdding(false)
  }

  /**
   * 从预设打开新增表单：只把默认命令 / 参数 / 类型**填进表单**，不直接落库 ——
   * 用户往往要先改参数（比如 Gemini 的 `--skip-trust`、Codex 的 profile），
   * 保存前必须能看见并编辑。
   */
  const openPresetForm = (preset: AcpAgentPreset): void => {
    setEditingId(null)
    setAcpName(preset.name)
    setAcpCommand(preset.command)
    setAcpArgs(formatCommandArgs(preset.args))
    setAcpType(preset.type ?? 'generic')
    setAcpAllow('once')
    setAcpProtocol('v1')
    // 身份随预设一起定下来：之后在表单里改命令 / 参数，它仍然是这个 agent
    setAcpPresetId(preset.id)
    setAdding(true)
  }

  /**
   * 保存表单：带 id 走更新、不带 id 走新建（服务端同一个 POST 路由）。
   *
   * 编辑时刻意**不传 models** —— 服务端约定「不传就沿用原有」。否则这里得把模型清单原样回传，
   * 一旦漏传就把用户在「模型」弹窗里挑好的白名单抹掉了。
   */
  const saveAcpAgent = async (): Promise<void> => {
    if (!acpCommand.trim() || duplicate) return
    const ok = await app.saveAcpAgent({
      ...(editingId ? { id: editingId } : {}),
      name: acpName.trim() || acpCommand.trim(),
      command: acpCommand.trim(),
      args: draftArgs,
      type: acpType,
      ...(acpPresetId ? { preset: acpPresetId } : {}),
      allowStrategy: acpAllow,
      protocolVersion: acpProtocol
    })
    // 成功才关弹窗；失败（服务端也会拦重复）保留草稿，别让人重敲一遍。
    // 关的那一下不重置字段 —— 退出动画期间清空会让输入框当场闪一下。
    if (ok) closeAcpForm()
  }

  /** 关检测弹窗：连结果一起清掉，下次点是重新扫（PATH 可能刚装完东西） */
  const closeDetect = (): void => {
    setDetectOpen(false)
    setDetected(null)
    setDetectError(null)
    setPicked([])
  }

  /**
   * 检测一个已添加的 agent 能不能正常启动。
   *
   * 服务端会在同一次探针里刷新模型缓存并落盘 `health`；这里只负责当前行的转圈与
   * **请求本身**失败（断网 / 服务不可达）的兜底错误 —— 那是「没问成」，不是 agent 的病。
   */
  const checkAgent = async (agent: AcpAgentView): Promise<void> => {
    setCheckingIds((prev) => (prev.includes(agent.id) ? prev : [...prev, agent.id]))
    setCheckErrors((prev) => {
      if (prev[agent.id] === undefined) return prev
      const next = { ...prev }
      delete next[agent.id]
      return next
    })
    const result = await app.checkAcpAgent(agent.id)
    setCheckingIds((prev) => prev.filter((id) => id !== agent.id))
    // 服务端已经记下结论的失败由 agent.health 展示；只有请求本身失败才需要本地兜底，
    // 否则用户改完命令后健康状态已清空，本地错误还会把那一行染红。
    if (!result.ok && result.error && !result.persisted) {
      setCheckErrors((prev) => ({ ...prev, [agent.id]: result.error! }))
    }
  }

  /** 打开登录弹窗：真起一次探针问 agent 支持哪些登录方式（登录方式不落盘） */
  const openAcpAuth = async (agent: AcpAgentView): Promise<void> => {
    setAuthAgent(agent)
    setAuthMethods([])
    setAuthBusy(true)
    setAuthOpen(true)
    try {
      const caps = await app.probeAcpCapabilities(agent.id)
      setAuthMethods(caps.authMethods)
    } catch (err) {
      app.setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthBusy(false)
    }
  }

  const loginWith = async (methodId: string): Promise<void> => {
    if (!authAgent) return
    setAuthBusy(true)
    const ok = await app.authenticateAcpAgent(authAgent.id, methodId)
    setAuthBusy(false)
    if (ok) setAuthOpen(false)
  }

  const logout = async (): Promise<void> => {
    if (!authAgent) return
    setAuthBusy(true)
    const ok = await app.logoutAcpAgent(authAgent.id)
    setAuthBusy(false)
    if (ok) setAuthOpen(false)
  }

  /**
   * 扫一遍服务端 PATH，把结果放进弹窗让用户勾选。
   *
   * 探测本身无副作用（`detectAcpAgents` 不刷列表），所以失败不弹 toast ——
   * 「这台机器上没装」和「探测本身失败了」是两件事，得在弹窗里分得清。
   */
  const runDetect = async (): Promise<void> => {
    setDetecting(true)
    setDetectError(null)
    try {
      const list = await app.detectAcpAgents()
      setDetected(list)
      setPicked([])
    } catch (err) {
      setDetected([])
      setPicked([])
      setDetectError(err instanceof Error ? err.message : String(err))
    } finally {
      setDetecting(false)
      setDetectOpen(true)
    }
  }

  /** 弹窗内勾选 / 取消某个候选 */
  const togglePicked = (key: string): void =>
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]))

  /**
   * 把勾中的候选逐个写进去。**串行 await**：`saveAcpAgent` 每成功一次都会刷一遍全量列表，
   * 并发发出去只会互相覆盖，也拿不到单条成败。
   *
   * 已经添加过的候选不会进 `picked`（它们只回显成勾选），所以不会重复写；
   * 中途失败就停（继续写只会把 error 盖成最后一条），并把已写成功的从勾选里摘掉。
   */
  const addPicked = async (): Promise<void> => {
    if (!detected || picked.length === 0) return
    setSavingPicked(true)
    try {
      for (const key of picked) {
        const item = detected.find((d) => acpAgentKey(d) === key)
        if (!item) continue
        // 探测到的候选都是内置预设：把身份一并落盘，之后改命令也不会丢图标
        const presetId = findAcpPreset(item.command)?.id
        const ok = await app.saveAcpAgent({
          name: item.name,
          command: item.command,
          args: item.args,
          ...(presetId ? { preset: presetId } : {})
        })
        if (!ok) return
        setPicked((p) => p.filter((k) => k !== key))
      }
      setDetectOpen(false)
    } finally {
      setSavingPicked(false)
    }
  }

  /** 弹窗里的候选列表（null 时按空列表渲染） */
  const detectRows = detected ?? []

  return (
    <div className="space-y-3">
      <p className="text-xs leading-4 text-muted-foreground">
        {tr('ACP 会话由外部 agent 进程运行；模型、技能与提示词由它自己管理。命令在服务端执行。')}
      </p>

      {app.acpAgents.map((agent) => {
        const checking = checkingIds.includes(agent.id)
        const health = agent.health
        const localError = checkErrors[agent.id]
        const failed = health?.status === 'error' || Boolean(localError)
        const errorText = health?.status === 'error' ? health.error : localError
        const errorDetail = health?.status === 'error' ? health.detail : undefined
        const errorTitle = [errorText, errorDetail].filter(Boolean).join('\n')
        const checkedAt = health?.status === 'ok' ? health.checkedAt : undefined
        return (
          <div key={agent.id} className="rounded-md border border-border/60">
            <div className="flex items-center gap-2 px-3 py-2">
              {/* size-9 = 右侧两行文字（text-sm 20 + text-xs 16）的总高，图标与文字块等高 */}
              <AcpAgentIcon presetId={agent.preset} command={agent.command} className="size-9" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{agent.name}</span>
                  {agent.type && agent.type !== 'generic' && (
                    <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
                      {tr(ACP_TYPE_LABELS[agent.type])}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {agent.command} {agent.args.join(' ')}
                </div>
                {/* 触屏没有 hover：失败原因除了 tooltip，也在行内留一行可读的摘要 */}
                {failed && errorText && (
                  <div className="truncate text-[0.6875rem] text-destructive" title={errorTitle}>
                    {tr('检测失败：{error}', { error: errorText })}
                  </div>
                )}
              </div>
              {/* 可用性检测：结果由服务端落盘，刷新 / 换客户端后仍能恢复 */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={cn(
                      'size-7 p-0',
                      failed ? 'text-destructive hover:text-destructive' : 'text-muted-foreground'
                    )}
                    aria-label={
                      failed
                        ? tr('重新检测 ACP agent {name}', { name: agent.name })
                        : tr('检测 ACP agent {name}', { name: agent.name })
                    }
                    aria-busy={checking}
                    onClick={() => void checkAgent(agent)}
                  >
                    {checking ? (
                      <LoaderPinwheel className="size-3.5 animate-spin" />
                    ) : failed ? (
                      <AlertCircle className="size-3.5" />
                    ) : checkedAt !== undefined ? (
                      <CheckCircle2 className="size-3.5 text-emerald-500" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-72">
                  {checking ? (
                    tr('正在检测…')
                  ) : failed ? (
                    <div className="space-y-1">
                      <div className="font-medium">{tr('检测失败')}</div>
                      {errorText && (
                        <div className="whitespace-pre-wrap break-words text-xs">{errorText}</div>
                      )}
                      {errorDetail && (
                        <div className="whitespace-pre-wrap break-words font-mono text-[0.6875rem] text-muted-foreground">
                          {errorDetail}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">{tr('点击重试')}</div>
                    </div>
                  ) : checkedAt !== undefined ? (
                    <div className="space-y-1">
                      <div>{tr('检测正常')}</div>
                      <div className="text-xs text-muted-foreground">
                        {tr('上次检测：{time}', { time: formatCheckedAt(checkedAt) })}
                      </div>
                    </div>
                  ) : (
                    tr('检测这个 Agent 能否正常启动并完成 ACP 握手')
                  )}
                </TooltipContent>
              </Tooltip>
              {/* 登录：真起一次探针列出 agent 广告的登录方式（terminal 类型需去终端里完成） */}
              <Button
                size="sm"
                variant="ghost"
                className="size-7 p-0 text-muted-foreground"
                aria-label={tr('登录 {name}', { name: agent.name })}
                title={tr('登录 {name}', { name: agent.name })}
                onClick={() => void openAcpAuth(agent)}
              >
                <LogIn className="size-3.5" />
              </Button>
              {/* 编辑：预填当前配置，改完保存（带 id 走更新，已缓存的模型清单不受影响） */}
              <Button
                size="sm"
                variant="ghost"
                className="size-7 p-0 text-muted-foreground"
                aria-label={tr('编辑 ACP agent {name}', { name: agent.name })}
                title={tr('编辑 ACP agent {name}', { name: agent.name })}
                onClick={() => openAcpForm(agent)}
              >
                <Pencil className="size-3.5" />
              </Button>
              {/* 删除：走二次确认弹窗（配置删了就得重填，不是「点两次按钮」那一档） */}
              <Button
                size="sm"
                variant="ghost"
                className="size-7 p-0 text-muted-foreground hover:text-destructive"
                aria-label={tr('删除 ACP agent {name}', { name: agent.name })}
                title={tr('删除 ACP agent {name}', { name: agent.name })}
                onClick={() => setDeleteTarget(agent)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        )
      })}

      {/* 两个入口并排：检测（扫服务端 PATH → 弹窗勾选）与手动添加（走弹窗） */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          disabled={detecting}
          onClick={() => void runDetect()}
        >
          <span className="inline-flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
            {detecting ? (
              <LoaderPinwheel className="size-full animate-spin" />
            ) : (
              <RefreshCw className="size-full text-muted-foreground" />
            )}
          </span>
          {tr('检测已安装')}
        </Button>
        <Button size="sm" variant="outline" className="flex-1" onClick={() => openAcpForm()}>
          <Plus className="size-3.5" /> {tr('添加 ACP agent')}
        </Button>
      </div>

      {/*
        预设清单：常见外部 agent 都带一份默认命令 / 参数，点一下只是**填进新增表单**，
        保存前可以改。已添加过的按命令置灰 —— 再点一次只会造出一条重复配置。
      */}
      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">
          {tr('预设 agent（点击填入默认命令与参数，保存前可以修改）')}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ACP_AGENT_PRESETS.map((preset) => {
            const added = addedPresetIds.has(preset.id)
            return (
              <button
                key={preset.id}
                type="button"
                disabled={added}
                title={`${preset.command} ${preset.args.join(' ')}`.trim()}
                onClick={() => openPresetForm(preset)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs transition-colors',
                  added ? 'cursor-default opacity-60' : 'hover:bg-foreground/5'
                )}
              >
                <AcpAgentIcon presetId={preset.id} className="size-3.5" />
                <span>{preset.name}</span>
                {added && (
                  <span className="rounded bg-secondary px-1 py-0.5 text-[0.625rem] text-muted-foreground">
                    {tr('已添加')}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* 常驻进程诊断：只在展开时拉取，5 秒轮询一次；空闲回收由 @fizz/acp 自己负责 */}
      <div className="rounded-md border border-border/60">
        <button
          type="button"
          onClick={() => setProcessesOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-foreground/5"
        >
          {processesOpen ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">{tr('运行中的 ACP 进程')}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {processes ? processes.length : '—'}
          </span>
          {processesLoading && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        </button>
        {processesOpen && (
          <div className="space-y-1.5 border-t border-border/60 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {tr('空闲超过 10 分钟会自动回收；有轮次在跑的不回收。')}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-xs"
                disabled={processesLoading}
                onClick={() => void loadProcesses()}
              >
                <RefreshCw className={cn('size-3.5', processesLoading && 'animate-spin')} />
                {tr('刷新')}
              </Button>
            </div>
            {processesError ? (
              <p className="text-xs text-destructive">
                {tr('读取失败：{error}', { error: processesError })}
              </p>
            ) : processes === null ? (
              <p className="text-xs text-muted-foreground">{tr('正在读取…')}</p>
            ) : processes.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tr('当前没有常驻的 ACP 进程')}</p>
            ) : (
              processes.map((p) => {
                const agentName = app.acpAgents.find((a) => a.id === p.agentId)?.name ?? p.agentId
                const conv = app.conversations.find((c) => c.id === p.conversationId)
                return (
                  <div
                    key={`${p.agentId}::${p.conversationId}`}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={`${agentName} · ${conv?.title ?? p.conversationId}`}
                    >
                      {agentName} · {conv?.title ?? p.conversationId.slice(0, 8)}
                    </span>
                    <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">
                      PID {p.pid ?? '—'}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem]',
                        p.running
                          ? 'bg-primary/10 text-primary'
                          : 'bg-secondary text-muted-foreground'
                      )}
                    >
                      {p.running
                        ? tr('运行中')
                        : tr('空闲 {time}', { time: formatDuration(p.idleMs) })}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-5 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                      title={
                        p.running
                          ? tr('运行中的轮次请先在输入框停止')
                          : tr('结束进程')
                      }
                      aria-label={tr('结束进程')}
                      disabled={p.running}
                      onClick={() => setProcessKillTarget(p)}
                    >
                      <Power className="size-3" />
                    </Button>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>

      {/*
        新增与编辑共用这一个弹窗（`editingId` 为空 = 新增）。
        关闭时**不动任何可见状态**（`editingId` / 字段全部保留到下一次打开再重写）：
        退出动画期间 `DialogContent` 还挂着，清状态会让标题 / 描述当场闪成另一套文案。
      */}
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (!open) closeAcpForm()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? tr('编辑 ACP agent') : tr('添加 ACP agent')}</DialogTitle>
            <DialogDescription>
              {tr('命令在服务端上执行，工作目录是会话所属工作区。')}
              {editingId
                ? tr('改完保存即可，已挑好的模型清单不受影响。')
                : tr('同一个命令（含参数）只能添加一次。')}
            </DialogDescription>
          </DialogHeader>

          {/* 包成 form：焦点在任一输入框时回车即保存。
              `min-w-0` 不能省：DialogContent 是 grid，子项默认 `min-width: auto`，
              权限策略那个 Select 的长文案（whitespace-nowrap）会把整条表单撑到
              max-w 之外，溢出弹窗。 */}
          <form
            className="min-w-0 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void saveAcpAgent()
            }}
          >
            <Input
              variant="muted"
              placeholder={tr('名称，如 Codex CLI')}
              value={acpName}
              onChange={(e) => setAcpName(e.target.value)}
            />
            <Input
              variant="muted"
              placeholder={tr('启动命令，如 codex-acp')}
              value={acpCommand}
              onChange={(e) => setAcpCommand(e.target.value)}
            />
            <Input
              variant="muted"
              placeholder={tr('启动参数（空格分隔，可留空）')}
              value={acpArgs}
              onChange={(e) => setAcpArgs(e.target.value)}
            />
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">
                {tr('协议版本：v1 是稳定版；v2 仍是 draft（会话恢复走 session/resume，且没有 set_mode）')}
              </div>
              <Select
                value={acpProtocol}
                onValueChange={(v) => setAcpProtocol(v as AcpProtocolVersion)}
              >
                <SelectTrigger variant="muted" className="h-9 w-full min-w-0 overflow-hidden text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="v1">{tr('v1（stable，推荐）')}</SelectItem>
                  <SelectItem value="v2">{tr('v2（draft，agent 必须支持）')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">
                {tr('类型（决定会话里的模式 UI：opencode → 权限档，pi → 思考档，通用 → 不显示）')}
              </div>
              <Select value={acpType} onValueChange={(v) => setAcpType(v as AcpAgentType)}>
                <SelectTrigger variant="muted" className="h-9 w-full min-w-0 overflow-hidden text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="generic">{tr('通用（不显示模式 UI）')}</SelectItem>
                  <SelectItem value="opencode">{tr('opencode（Session Modes 当权限档）')}</SelectItem>
                  <SelectItem value="pi">{tr('pi（thought_level 当思考档）')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">
                {tr('「完全放行」时的答复：缺省「仅允许一次」（下次仍会询问）；选「永久记住」后由 agent 自己记着不再问，届时切回「确认」也要不回询问')}
              </div>
              <Select value={acpAllow} onValueChange={(v) => setAcpAllow(v as AcpAllowStrategy)}>
                <SelectTrigger variant="muted" className="h-9 w-full min-w-0 overflow-hidden text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">{tr('仅允许一次（推荐，下次仍会询问）')}</SelectItem>
                  <SelectItem value="always">{tr('允许并永久记住（agent 侧不再询问）')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="pt-1">
              <Button data-dialog-dismiss="" type="button" size="sm" variant="ghost" onClick={closeAcpForm}>
                {tr('取消')}
              </Button>
              <Button type="submit" size="sm" disabled={!acpCommand.trim() || duplicate}>
                {tr('保存')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/*
        检测结果弹窗：勾选要添加的候选，一次写进去。
        已添加过的（`acpAgentKey` 命中）自动勾上并标注「已添加」—— 勾选态就是「它已经在列表里」，
        点它无效（不能再写一遍）。空结果 / 探测失败也开这个弹窗：那里才有地方把两种原因说清。
      */}
      <Dialog open={detectOpen} onOpenChange={(open) => !open && closeDetect()}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tr('检测已安装的 ACP agent')}</DialogTitle>
            <DialogDescription>
              {tr('这些是服务端 PATH 上找到的命令。勾选要添加的条目，点「添加」一次写进去；已经添加过的会自动勾上并标注。')}
            </DialogDescription>
          </DialogHeader>

          {detectError && <div className="text-xs text-destructive">{tr('探测失败：{error}', { error: detectError })}</div>}

          {!detectError && detectRows.length === 0 && (
            <div className="text-xs leading-5 text-muted-foreground">
              {tr('服务端 PATH 上没有找到可用的 ACP agent。可以点「添加 ACP agent」手动填启动命令。')}
            </div>
          )}

          {detectRows.length > 0 && (
            <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
              {detectRows.map((item) => {
                const key = acpAgentKey(item)
                const added = addedKeys.has(key)
                const checked = added || picked.includes(key)
                return (
                  <button
                    key={key}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`${item.name}（${item.command}）`}
                    disabled={added}
                    title={item.path}
                    onClick={() => togglePicked(key)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors',
                      added ? 'cursor-default opacity-60' : 'hover:bg-secondary'
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border'
                      )}
                    >
                      {checked && <Check className="size-2.5" />}
                    </span>
                    <AcpAgentIcon command={item.command} className="size-9" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{item.name}</span>
                      <span className="block truncate font-mono text-[0.6875rem] text-muted-foreground">
                        {item.command} {item.args.join(' ')}
                      </span>
                    </span>
                    {added && (
                      <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
                        {tr('已添加')}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          <DialogFooter className="pt-1">
            <Button data-dialog-dismiss="" type="button" size="sm" variant="ghost" onClick={closeDetect}>
              {tr('取消')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={picked.length === 0 || savingPicked}
              onClick={() => void addPicked()}
            >
              {savingPicked && <Loader2 className="size-3.5 animate-spin" />}
              {tr('添加')}{picked.length > 0 ? tr('（{count} 个）', { count: picked.length }) : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除 ACP agent：二次确认（写清删的是哪一条，避免列表里名字相近时点错） */}
      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        title={tr('删除 ACP agent？')}
        description={
          deleteTarget
            ? tr('「{name}」（{command}）会从列表里移除，缓存的模型清单也一起丢掉。删掉就得重新添加。', { name: deleteTarget.name, command: `${deleteTarget.command} ${deleteTarget.args.join(' ')}` })
            : ''
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget
          setDeleteTarget(null)
          if (target) void app.deleteAcpAgent(target.id)
        }}
      />

      {/* 手动结束常驻进程：与删除配置不同，这里只杀进程，不改任何配置 / 历史 */}
      <ConfirmDeleteDialog
        open={processKillTarget !== null}
        title={tr('结束这个 ACP 进程？')}
        confirmLabel={tr('结束进程')}
        description={
          processKillTarget
            ? tr(
                '「{agent}」在「{conversation}」上的 agent 进程会被结束；下一轮会自动重新连接并恢复上下文。',
                {
                  agent:
                    app.acpAgents.find((a) => a.id === processKillTarget.agentId)?.name ??
                    processKillTarget.agentId,
                  conversation:
                    app.conversations.find((c) => c.id === processKillTarget.conversationId)?.title ??
                    processKillTarget.conversationId.slice(0, 8)
                }
              )
            : ''
        }
        onCancel={() => setProcessKillTarget(null)}
        onConfirm={() => {
          const target = processKillTarget
          setProcessKillTarget(null)
          if (target) void killProcess(target)
        }}
      />

      {/* 登录：登录方式不落盘，每次打开都现探一次（agent 版本变了方法也可能变） */}
      <Dialog
        open={authOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAuthOpen(false)
            setAuthMethods([])
            setAuthAgent(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tr('登录 {name}', { name: authAgent?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {tr('登录方式由 agent 在初始化时广告；「终端」类型需要到终端里手动完成。')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {authBusy && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {tr('正在读取登录方式…')}
              </div>
            )}
            {!authBusy && authMethods.length === 0 && (
              <div className="text-xs text-muted-foreground">
                {tr('这个 agent 没有广告登录方式（可能不需要登录，或还没完成初始化）。')}
              </div>
            )}
            {!authBusy &&
              authMethods.map((method) => (
                <div
                  key={method.id}
                  className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{method.name}</div>
                    {method.description && (
                      <div className="truncate text-xs text-muted-foreground">
                        {method.description}
                      </div>
                    )}
                    {method.type === 'terminal' && (
                      <div className="text-[0.6875rem] text-muted-foreground">
                        {tr('需要在终端里完成')}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    disabled={authBusy || method.type === 'terminal'}
                    onClick={() => void loginWith(method.id)}
                  >
                    {tr('登录')}
                  </Button>
                </div>
              ))}
          </div>
          <DialogFooter className="pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={authBusy || !authAgent}
              onClick={() => void logout()}
            >
              {tr('退出登录')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAuthOpen(false)}>
              {tr('关闭')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

