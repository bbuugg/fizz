/**
 * 设置弹窗 →「ACP agent」标签页：外部 ACP 进程的预设列表 + 探测 + 新增 / 编辑弹窗。
 * ACP 命令在服务端执行，这里只维护「怎么启动它」的配置。
 *
 * 「挑模型」：一个外部 agent 往往能选十几二十个模型，全塞进会话下拉太吵 ——
 * 这里向它要一次清单（ACP 没有「列模型」方法，是它建立会话时广告的 configOptions），
 * 用户勾几个，存进 `AcpAgentConfig.models`，会话里就只列这几个。
 *
 * 模型清单走 **Dialog**（用户要求，与「模型」页一致）：点列表行的**拉取模型图标**
 * （`Download`，与「模型」页那份同款）弹出，顶部带搜索框，
 * 勾选后点「保存」把选中的写进白名单。列表行只显示人类可读的 name，模型 id（value）收进悬停 tooltip；
 * 移除靠「取消勾选」（不再有独立的 × 按钮）。除了勾选探测到的候选，还能**手动添加**模型 id ——
 * agent 没广告清单（`configId` 为空）/ 探测失败时兜底，或直接按 id 指定模型。
 * 已添加的模型会作为可移除的标签直接显示在 ACP 列表里，每个标签带 ×，点一下弹二次确认 ——
 * 不用进弹窗也能移走某几个。
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
 * 比「点两次按钮就地确认」值得多问一句。移除白名单里的单个模型同样走这套确认弹窗。
 */
import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Download, Loader2, Pencil, Plus, Power, RefreshCw, Trash2, X } from 'lucide-react'
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
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
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
  AcpModelChoices,
  AcpModelOption
} from '@fizz/acp'
import type { AcpAgentView, AcpProcessInfo, DetectedAcpAgent } from '@fizz/contracts/agent-api'
import { acpAgentKey } from '@fizz/contracts/agent-api'

/** 某个 agent 的模型清单探测状态：还没问 / 正在问 / 结果（字符串 = 出错信息） */
type ProbeState = AcpModelChoices | 'loading' | { error: string }

/** agent 类型在界面上的短标签（列表行展示用） */
const ACP_TYPE_LABELS: Record<AcpAgentType, string> = {
  generic: '通用',
  opencode: 'opencode',
  pi: 'pi'
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
  /** 当前开着「挑模型」弹窗的 agent id（null = 关着） */
  const [modelAgentId, setModelAgentId] = useState<string | null>(null)
  /** 弹窗里这一次的探测结果 */
  const [probe, setProbe] = useState<ProbeState | null>(null)
  /** 弹窗里当前的勾选（模型 value 列表，保存前） */
  const [selected, setSelected] = useState<string[]>([])
  /** 弹窗里的搜索词 */
  const [search, setSearch] = useState('')
  /** 弹窗里「手动添加」的两个输入：模型 id（必填）与展示名（可选） */
  const [manualId, setManualId] = useState('')
  const [manualName, setManualName] = useState('')
  /**
   * 本次弹窗里手动敲进来的模型。只活在这一次弹窗会话里 —— 保存后它们随白名单一起落进
   * `agent.models`，下次打开就从「已保存」那一路读回来，不必单独持久化。
   * 用途：agent 没广告清单（`configId` 为空）/ 探测失败时兜底，或直接按 id 指定模型。
   */
  const [manualModels, setManualModels] = useState<AcpModelOption[]>([])
  /** 待确认删除的 ACP agent（二次确认弹窗；null = 关着） */
  const [deleteTarget, setDeleteTarget] = useState<AcpAgentView | null>(null)
  /** 待确认从白名单里移除的单个模型（二次确认弹窗；null = 关着） */
  const [removeTarget, setRemoveTarget] = useState<{
    agent: AcpAgentView
    model: AcpModelOption
  } | null>(null)

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

  /** 弹窗对应的 agent（找不到说明刚被删了，弹窗内容会是空的） */
  const openAgent = modelAgentId ? app.acpAgents.find((a) => a.id === modelAgentId) ?? null : null

  const probeOptions =
    probe && typeof probe === 'object' && 'options' in probe ? probe.options : []
  const keyword = search.trim().toLowerCase()

  /**
   * 建一张「value → 模型信息」表：优先用已保存的白名单（agent.models），
   * 再用手动添加的、最后用本次探测结果（probeOptions）补齐。这样「上次加了、但这次没探测出来」
   * 的模型、以及手动敲进来的模型，都依然能在列表里显示并勾选/取消，不会一点弹窗就丢。
   */
  const modelByValue = new Map<string, AcpModelOption>()
  for (const m of openAgent?.models ?? []) modelByValue.set(m.value, m)
  for (const m of manualModels) if (!modelByValue.has(m.value)) modelByValue.set(m.value, m)
  for (const o of probeOptions) if (!modelByValue.has(o.value)) modelByValue.set(o.value, o)

  /** 搜索同时匹配展示名与模型值（value） */
  const match = (m: AcpModelOption): boolean =>
    !keyword || m.name.toLowerCase().includes(keyword) || m.value.toLowerCase().includes(keyword)

  /** 已加入白名单的模型（按 value 去重、过滤搜索词） */
  const addedList = selected
    .map((v) => modelByValue.get(v))
    .filter((m): m is AcpModelOption => Boolean(m))
    .filter(match)
  /** 探测清单里的模型 value（判断哪些「已保存 / 手动添加」的要追加到末尾） */
  const probeValueSet = new Set(probeOptions.map((o) => o.value))
  /**
   * 单列表：顺序**只跟探测清单走** —— 先按 agent 广告的原始顺序，再追加这次没探测到的
   * （上次保存的、刚手动添加的）。勾选 / 取消只改 `added` 标记，
   * **不会把某一行挪到列表最上面**（用户明确要求：选中的模型不要往上跑），搜索也只是过滤、不重排。
   */
  const modelRows = [
    ...probeOptions.map((o) => ({
      model: modelByValue.get(o.value) ?? o,
      added: selected.includes(o.value)
    })),
    ...[...modelByValue.values()]
      .filter((m) => !probeValueSet.has(m.value))
      .map((m) => ({ model: m, added: selected.includes(m.value) }))
  ].filter(({ model }) => match(model))
  /** 当前白名单里的模型数（= 保存后写入的条数） */
  const chosenCount = selected.length

  /** 问一次这个 agent 的可选模型（起一次它的进程，问完服务端会收掉） */
  const loadModels = async (agentId: string): Promise<void> => {
    setProbe('loading')
    try {
      const choices = await app.probeAcpModels(agentId)
      setProbe(choices)
    } catch (err) {
      setProbe({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 打开「挑模型」弹窗：勾选从已保存清单起步，并拉一次最新候选 */
  const openModelDialog = (agent: AcpAgentView): void => {
    setModelAgentId(agent.id)
    setSelected((agent.models ?? []).map((m) => m.value))
    setSearch('')
    setManualId('')
    setManualName('')
    setManualModels([])
    void loadModels(agent.id)
  }

  const closeModelDialog = (): void => setModelAgentId(null)

  /** 弹窗内：在「白名单选中集」里增删某个模型（点行 = 勾选/取消） */
  const toggleModel = (value: string): void =>
    setSelected((s) => (s.includes(value) ? s.filter((v) => v !== value) : [...s, value]))

  /**
   * 手动添加一个模型：把 id 当作 value 记进「本次手动清单」并直接勾上。
   * 已经在清单里（探测到 / 已保存 / 本次已手动加过）的不重复加，只保证它被勾选。
   */
  const addManualModel = (): void => {
    const value = manualId.trim()
    if (!value) return
    const name = manualName.trim() || value
    setManualId('')
    setManualName('')
    if (modelByValue.has(value)) {
      setSelected((s) => (s.includes(value) ? s : [...s, value]))
      return
    }
    setManualModels((list) => [...list, { value, name }])
    setSelected((s) => (s.includes(value) ? s : [...s, value]))
  }

  /** 保存：把勾选（=白名单）写回；selected 初始化时含已保存项，删掉的已一并移出 */
  const saveModels = async (): Promise<void> => {
    if (!openAgent) return
    const byValue = new Map<string, AcpModelOption>()
    for (const m of openAgent.models ?? []) byValue.set(m.value, m)
    for (const m of manualModels) if (!byValue.has(m.value)) byValue.set(m.value, m)
    for (const o of probeOptions) if (!byValue.has(o.value)) byValue.set(o.value, o)
    const payload = selected.map((v) => byValue.get(v)).filter((m): m is AcpModelOption => Boolean(m))
    const ok = await app.saveAcpAgentModels(openAgent.id, payload)
    if (ok) closeModelDialog()
  }

  /** 在 ACP 列表里直接移除某一个已添加模型（白名单去掉这一项） */
  const removeModel = async (agent: AcpAgentView, value: string): Promise<void> => {
    const remaining = (agent.models ?? []).filter((m) => m.value !== value)
    await app.saveAcpAgentModels(agent.id, remaining)
  }

  /** 清空表单草稿（只有保存成功、或重新打开表单时才动它） */
  const resetAcpDraft = (): void => {
    setAcpName('')
    setAcpCommand('')
    setAcpArgs('')
    setAcpType('generic')
    setAcpAllow('once')
  }

  /** 打开表单弹窗：给了 `agent` 就是编辑（预填它当前的配置），不给就是新增（空表单） */
  const openAcpForm = (agent?: AcpAgentView): void => {
    setEditingId(agent?.id ?? null)
    setAcpName(agent?.name ?? '')
    setAcpCommand(agent?.command ?? '')
    setAcpArgs(formatCommandArgs(agent?.args ?? []))
    setAcpType(agent?.type ?? 'generic')
    setAcpAllow(agent?.allowStrategy ?? 'once')
    setAdding(true)
  }

  /** 关表单：只收起，不清草稿（见下方 Dialog 上的注释） */
  const closeAcpForm = (): void => {
    setAdding(false)
    setEditingId(null)
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
      allowStrategy: acpAllow
    })
    // 成功才清空 + 关弹窗；失败（服务端也会拦重复）保留草稿，别让人重敲一遍
    if (ok) {
      closeAcpForm()
      resetAcpDraft()
    }
  }

  /** 关检测弹窗：连结果一起清掉，下次点是重新扫（PATH 可能刚装完东西） */
  const closeDetect = (): void => {
    setDetectOpen(false)
    setDetected(null)
    setDetectError(null)
    setPicked([])
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
        const ok = await app.saveAcpAgent({
          name: item.name,
          command: item.command,
          args: item.args
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
        const models = agent.models ?? []
        return (
          <div key={agent.id} className="rounded-md border border-border/60">
            <div className="flex items-center gap-2 px-3 py-2">
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
              </div>
              {/*
                拉取模型：与「模型」页那份**同款**（`Download` 图标、ghost / `size-7`、同样的
                aria-label 与 title 口径）。这里刻意**不显示已选数量** —— 已添加的模型在下面
                以标签形式全列出来了，按钮上再挂一个数字是重复信息，还把按钮撑得比相邻两颗宽。
              */}
              <Button
                size="sm"
                variant="ghost"
                className="size-7 p-0 text-muted-foreground"
                aria-label={tr('从远端拉取 {name} 的模型', { name: agent.name })}
                title={tr('从远端拉取模型')}
                onClick={() => openModelDialog(agent)}
              >
                <Download className="size-3.5" />
              </Button>
              {/* 编辑：预填当前配置，改完保存（带 id 走更新，模型白名单不受影响） */}
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

            {/* 已添加的模型：作为可移除标签直接显示在 ACP 列表里，点 × 即移除 */}
            {models.length > 0 && (
              <div className="flex flex-wrap gap-1 px-3 py-2">
                {models.map((m) => (
                  <span
                    key={m.value}
                    title={m.description ?? m.value}
                    className="inline-flex max-w-full items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem]"
                  >
                    <span className="truncate">{m.name}</span>
                    <button
                      type="button"
                      aria-label={tr('移除模型 {name}', { name: m.name })}
                      title={tr('移除模型 {name}', { name: m.name })}
                      onClick={() => setRemoveTarget({ agent, model: m })}
                      className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
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
          {detecting && <Loader2 className="size-3.5 animate-spin" />}
          {tr('检测已安装')}
        </Button>
        <Button size="sm" variant="outline" className="flex-1" onClick={() => openAcpForm()}>
          <Plus className="size-3.5" /> {tr('添加 ACP agent')}
        </Button>
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
        关掉只收起、不清草稿：误点遮罩 / Esc 不该把刚填的命令弄丢（只有保存成功才清）。
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
              placeholder={tr('名称，如 Codex CLI')}
              value={acpName}
              onChange={(e) => setAcpName(e.target.value)}
            />
            <Input
              placeholder={tr('启动命令，如 codex-acp')}
              value={acpCommand}
              onChange={(e) => setAcpCommand(e.target.value)}
            />
            <Input
              placeholder={tr('启动参数（空格分隔，可留空）')}
              value={acpArgs}
              onChange={(e) => setAcpArgs(e.target.value)}
            />
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">
                {tr('类型（决定会话里的模式 UI：opencode → 权限档，pi → 思考档，通用 → 不显示）')}
              </div>
              <Select value={acpType} onValueChange={(v) => setAcpType(v as AcpAgentType)}>
                <SelectTrigger className="h-9 w-full min-w-0 overflow-hidden text-sm">
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
                <SelectTrigger className="h-9 w-full min-w-0 overflow-hidden text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">{tr('仅允许一次（推荐，下次仍会询问）')}</SelectItem>
                  <SelectItem value="always">{tr('允许并永久记住（agent 侧不再询问）')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {duplicate && (
              <p className="text-xs text-muted-foreground">
                {tr('这个命令（含参数）已经被别的条目占了，换个命令或参数。')}
              </p>
            )}
            <DialogFooter className="pt-1">
              <Button type="button" size="sm" variant="ghost" onClick={closeAcpForm}>
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
            <Button type="button" size="sm" variant="ghost" onClick={closeDetect}>
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
            ? tr('「{name}」（{command}）会从列表里移除，为它挑好的模型清单也一起丢掉。删掉就得重新添加。', { name: deleteTarget.name, command: `${deleteTarget.command} ${deleteTarget.args.join(' ')}` })
            : ''
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget
          setDeleteTarget(null)
          if (target) void app.deleteAcpAgent(target.id)
        }}
      />

      {/* 从白名单里移除单个模型：二次确认（写清模型名与所属 agent，避免名字相近时点错） */}
      <ConfirmDeleteDialog
        open={removeTarget !== null}
        title={tr('移除模型？')}
        confirmLabel={tr('移除')}
        description={
          removeTarget
            ? tr('「{model}」会从「{agent}」的模型白名单里移除；之后可以再点「模型」把它加回来。', { model: removeTarget.model.name, agent: removeTarget.agent.name })
            : ''
        }
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget
          setRemoveTarget(null)
          if (target) void removeModel(target.agent, target.model.value)
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

      {/* 挑模型弹窗：搜索 + 勾选 + 保存。与「添加 ACP agent」互不影响（各自独立 portal） */}
      <Dialog
        open={modelAgentId != null}
        onOpenChange={(open) => !open && closeModelDialog()}
      >
        {/*
          滚动的只能是模型列表：别把 `overflow-y-auto` 挂在 DialogContent 上 —— 那会让
          标题 / 搜索框 / 手动添加 / 底部按钮跟模型列表共用一个滚动条，ACP 一广告几十个模型
          整块弹窗就开始滚（用户报过）。这里用 flex-col + overflow-hidden 把高度收住，
          列表 `flex-auto overflow-y-auto` 自己滚，其余各行 `shrink-0` 不动。

          ⚠️ 高度**钉死**（`h-[min(34rem,85dvh)]`，不是 `max-h`）：弹窗一开是「正在问它要
          模型清单」，探测回来后多出搜索行与整片列表 —— 用 `max-h` 的话弹窗会先小后大地跳
          一下（与「管理工作区 / 导入会话」同一条规矩）。定高之后内容怎么变都在这张卡里换。

          ⚠️ **打开时不要自动聚焦**（`onOpenAutoFocus` 里 preventDefault）：Radix 默认把焦点
          送到第一个可聚焦元素，而这里第一个是**搜索框** —— 弹窗一开焦点就跳进输入框，手机
          上直接弹起软键盘、桌面端还平白多一个焦点环（用户要求去掉）。焦点留在原处即可，
          Esc / Tab 由 Radix 的焦点陷阱与 DismissableLayer 照常接管，点击列表也能正常落焦。
        */}
        <DialogContent
          className="flex h-[min(34rem,85dvh)] flex-col gap-4 overflow-hidden"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{tr('选择 {name} 的模型', { name: openAgent?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {tr('选择你需要的模型。')}
            </DialogDescription>
          </DialogHeader>

          {probe === 'loading' && (
            <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {tr('正在问它要模型清单…')}
            </div>
          )}
          {probe && typeof probe === 'object' && 'error' in probe && (
            <div className="shrink-0 text-xs text-destructive">{tr('读取失败：{error}', { error: probe.error })}</div>
          )}

          {/* 探测结果说明：没广告清单时不显示搜索，但仍可在下面手动添加 */}
          {probe && typeof probe === 'object' && 'configId' in probe && probe.configId == null && (
            <div className="shrink-0 text-xs text-muted-foreground">
              {tr('这个 agent 没有广告可选模型（或它不支持 ACP 的会话配置项）。')}
              {addedList.length > 0 && tr(' 下方仍是已添加的模型，取消勾选即可移出。')}
              {tr('也可以在下面手动填模型 id。')}
            </div>
          )}

          {/* 搜索：只在探测到候选时出现（`configId` 非空即 options 非空） */}
          {probeOptions.length > 0 && (
            <div className="flex shrink-0 items-center gap-2">
              <Input
                placeholder={tr('搜索模型…')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 text-xs"
              />
              <span className="shrink-0 text-xs text-muted-foreground">
                {keyword ? `${modelRows.length}/${probeOptions.length}` : tr('{count} 个', { count: probeOptions.length })}
              </span>
            </div>
          )}

          {/*
            列表：按探测清单的原始顺序（未探测到的已保存 / 手动模型追加在末尾），
            **勾选不改变行位置**。行内只靠勾选框 + 底色区分「已添加」。
            不挂在「探测成功」分支下 —— 探测失败 / 进行中时，已保存与手动添加的模型仍要能看见、能取消。

            ⚠️ 容器**无条件渲染**并常驻 `flex-auto`：只有探测回来那一刻才出现列表的话，
            加载中 / 无候选时这一块不存在，下面「全选 / 清空」与底部按钮会紧贴上方内容浮在
            卡片中间（用户报过「按钮跑上面去了」）。常驻之后它永远吃掉剩余高度，列表区高度
            固定，下方各行始终贴在底部。
          */}
          <div className="min-h-0 flex-auto space-y-0.5 overflow-y-auto pr-1">
            {modelRows.map(({ model, added }) => (
                <div
                  key={model.value}
                  className={cn(
                    'flex items-center gap-2 rounded px-1.5 py-1 text-sm transition-colors',
                    added ? 'bg-secondary/60' : 'hover:bg-secondary'
                  )}
                >
                  {/*
                    整行就是勾选触发器（role=checkbox）：列表里只留人类可读的 name，
                    模型 id（value，往往很长，如 openrouter/anthropic/claude-3-haiku…）
                    收进悬停 tooltip，不再占一行宽度。

                    不再单独渲染已添加项的 × 按钮：勾选框本身就是「取消勾选 = 移出」
                    的开关，× 与它重复。
                  */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={added}
                        onClick={() => toggleModel(model.value)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span
                          className={cn(
                            'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                            added ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                          )}
                        >
                          {added && <Check className="size-2.5" />}
                        </span>
                        {/*
                          ⚠️ 不要给这里加 shrink-0：模型 name 也可能很长，一旦拒绝收缩，
                          `truncate` 就永远不生效，整行被撑宽 —— 外层 `overflow-y-auto`
                          按 CSS 规则会把 overflow-x 也算成 auto，于是列表内部出现横向滚动条。
                          min-w-0 才让 truncate 真正生效。
                        */}
                        <span
                          className={cn(
                            'min-w-0 truncate',
                            added ? 'text-foreground' : 'text-muted-foreground'
                          )}
                        >
                          {model.name}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="start" className="max-w-80 text-left text-pretty">
                      <div className="font-mono text-xs">{model.value}</div>
                      {model.description && (
                        <div className="mt-0.5 text-[0.6875rem] opacity-70">{model.description}</div>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </div>
              ))}
            {modelRows.length === 0 && keyword && (
              <div className="px-1.5 py-2 text-xs text-muted-foreground">
                {tr('没有匹配「{keyword}」的模型。', { keyword: search.trim() })}
              </div>
            )}
          </div>

          {/*
            手动添加：agent 没广告清单 / 探测失败时兜底，或直接按 id 指定模型。
            回车即添加（包成 form，焦点在任一输入框时提交）。
          */}
          <form
            className="shrink-0 space-y-1 rounded-md border border-dashed border-border px-2 py-2"
            onSubmit={(e) => {
              e.preventDefault()
              addManualModel()
            }}
          >
            <div className="text-xs text-muted-foreground">
              {tr('手动添加：填模型 id（必填），展示名留空则直接用 id。')}
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder={tr('模型 id，如 anthropic/claude-sonnet-4')}
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                className="h-8 min-w-0 flex-1 font-mono text-xs"
              />
              <Input
                placeholder={tr('展示名（可选）')}
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                className="h-8 w-36 shrink-0 text-xs"
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 px-2 text-xs"
                disabled={!manualId.trim()}
              >
                <Plus className="size-3.5" /> {tr('添加')}
              </Button>
            </div>
          </form>

          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={probeOptions.length === 0}
              onClick={() => setSelected(probeOptions.map((o) => o.value))}
            >
              {tr('全选')}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelected([])}>
              {tr('清空')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => modelAgentId && loadModels(modelAgentId)}
            >
              {tr('重新读取')}
            </Button>
          </div>

          {/*
            列表区常驻 `flex-auto` 已吃满剩余高度，这一行自然落在底部；
            `mt-auto` 只是兜底，保证即使列表容器将来被改成不占空间，按钮也不会浮上去。
          */}
          <DialogFooter className="mt-auto shrink-0 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={closeModelDialog}>
              {tr('取消')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={probe == null || probe === 'loading'}
              onClick={() => void saveModels()}
            >
              {tr('保存（{count} 个）', { count: chosenCount })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
