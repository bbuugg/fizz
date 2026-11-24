/**
 * 模型 / 后端选择器 —— **受控版**：只吃 props，完全不知道 `AgentApp` 的存在。
 *
 * 从 `ModelSelect`（会话详情那颗 pill）里抽出来的，动机与工作区 / MCP / 浏览器那几颗
 * 完全一样（它们原来都挤在一个 `pickers.tsx` 里，现在各占一个文件）：**同一个控件只留
 * 一份实现**。定时任务表单要的就是会话详情这一颗 —— 分组、行尾设置齿轮、ACP 白名单、
 * 「跟随 agent 默认」这些行为一个都不能少；此前那边用的是一层平铺的 `ModelPill`，
 * 两边看着就是两个功能。
 *
 * 分工：
 * - 本文件：渲染 + 交互，`value` / `onChange` / 清单全从 props 进；
 * - `ModelSelect`（会话详情）：把 `app` 里的数据灌进来，再补自己的副作用
 *   （写 `chatTarget`、按活动会话锁定后端）；
 * - `TriggerEditDialog`（定时任务）：把表单自己的局部状态灌进来。
 *
 * ## 两级，但不是二级菜单（2026-11 用户要求）
 *
 * 一级把「跑什么」列清楚：**内置 Agent** + 每个外部 Agent（ACP）。
 * 点一项进二级，看它下面的模型；二级左上角「返回」回一级重选。
 *
 * 这比原来「一个面板里铺满所有配置的模型」少一层噪音：模型动辄几十个，
 * 一级只回答「用哪个 agent」，二级才回答「用它的哪个模型」。
 *
 * **会话一建好，一级就被锁死**（`agentLocked`）：内置会话打开直接落在「内置 Agent」
 * 的二级，ACP 会话直接落在它绑定的 agent 的二级，且没有返回 —— 换 agent = 新建会话。
 * 二级里换模型仍然可以，下一轮生效。
 *
 * ## 搜索
 *
 * 一级**不设搜索框**：条目本来就少（内置 + 几个 ACP），先把「用哪个 agent」看全；
 * 二级的搜索框紧贴在 agent 名下面，按模型名 / 模型值（内置还带配置名）筛。
 * 进 / 出二级都会清空搜索词，免得上一次的过滤条件带到另一层去。
 *
 * ## 设置入口
 *
 * 二级标题行尾挂一枚齿轮，按当前组跳到对应的设置页（内置 → AI 模型，ACP → 外部 Agent）。
 * 一级不再放配置入口（用户要求去掉底部那两行）。
 *
 * 唯一的例外是**远端工作区**：ACP agent 不出现在一级，只留一行说明
 * （`acpDisabledReason`）—— 外部 agent 是服务端本机 spawn 的进程，够不到 SSH 主机上的目录。
 */
import { Bot, ChevronLeft, Loader2, RefreshCw, Settings } from 'lucide-react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode
} from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Popover, PopoverTrigger } from '@fizz/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'
import {
  PickerFooter,
  PickerItem,
  PickerLabel,
  PickerList,
  PickerNote,
  PickerPanel,
  PickerSearch
} from '@fizz/ui/picker-panel'
import type { AgentBackend } from '@fizz/contracts/types'
import { DEFAULT_CONTEXT_WINDOW, resolveContextWindow } from '@fizz/contracts/types'
import type { AcpAgentView, ModelView } from '@fizz/contracts/agent-api'
import appLogo from '@fizz/agent-kit/shared/assets/logo.png'
import { AcpAgentIcon } from '@fizz/agent-kit/shared/components/AcpAgentIcon'
import { CHAT_PILL } from '@fizz/agent-kit/features/chat/composer'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { needsAcpModelLoad, type AcpModelLoadError } from '@fizz/agent-kit/shared/lib/acp-models'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn, formatContextWindow } from '@fizz/agent-kit/shared/lib/utils'
import { t } from '@fizz/i18n'

/**
 * 「用哪个后端 / 哪份配置 / 哪个模型」。与 `AgentApp['chatTarget']` 同一形状（刻意）：
 * 会话详情那边直接透传，不做转换。
 */
export interface ModelTarget {
  backend: AgentBackend
  configId?: string
  modelId?: string
}

/** 二级面板代表的那个「agent」：内置 agent，或某个外部 ACP agent */
type PickerGroup = { kind: 'builtin' } | { kind: 'acp'; agentId: string }

/** 一份配置下能选的模型 id 清单 */
function catalogOf(config: ModelView): string[] {
  return (config.models ?? []).map((model) => model.id)
}

/**
 * 把目标解析成给人看的标签；**目标已失效返回 `null`**（配置 / agent / 模型被删）。
 *
 * 失效时**不回退**到清单第一项：让用户自己重选，而不是替他挑一个从没选过的模型
 * （与 `chatTarget` 的「不自动预选」同一条规矩）。
 */
export function modelTargetLabel(
  models: ModelView[],
  acpAgents: AcpAgentView[],
  target: ModelTarget | null,
  withProvider = true
): string | null {
  if (!target?.configId) return null
  if (target.backend === 'acp') {
    const agent = acpAgents.find((a) => a.id === target.configId)
    if (!agent) return null
    const model = agent.models?.find((m) => m.value === target.modelId)
    if (withProvider) return model ? `${agent.name} · ${model.name}` : agent.name
    return model ? model.name : agent.name
  }
  const config = models.find((m) => m.id === target.configId)
  if (!config) return null
  if (!target.modelId || !catalogOf(config).includes(target.modelId)) return null
  return withProvider ? `${config.name} · ${target.modelId}` : target.modelId
}

/** 二级里的一行（小标题不进这里：它们不是可选项） */
interface PickerRow {
  /** cmdk 的 value，全局唯一：配置 id 与 agent id 不同域，带前缀防撞 */
  key: string
  label: string
  /** 行尾次要信息（内置模型显示上下文窗口：圆环的分母就是它） */
  hint?: string
  title?: string
  /** 悬停气泡：只在需要看完整 id / 描述的行上给（触屏由 Tooltip 的 allowTouch 放行） */
  tip?: ReactNode
  active: boolean
  /** 搜索文本：把小标题也拼进来，敲配置名 / Agent 名也能搜到它下面的模型 */
  search: string
  onSelect: () => void
}

/** 内置模型的一个分段：配置名 + 它下面的模型 */
interface PickerSection {
  key: string
  name: string
  rows: PickerRow[]
}

/**
 * 二级标题：返回箭头 + 组图标 + 组名（+ 行尾的设置齿轮）。
 *
 * 没有直接复用 `PickerLabel`：返回箭头要放在**最左**、且在 truncate 文本之外，
 * 它和品牌图标不是同一层语义。
 */
function PickerGroupHeader({
  icon,
  label,
  action,
  onBack
}: {
  icon?: ReactNode
  label: string
  action?: ReactNode
  onBack?: () => void
}) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
      {onBack ? (
        <button
          type="button"
          aria-label={t('返回')}
          title={t('返回')}
          onClick={onBack}
          className="-ml-1 rounded p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
        </button>
      ) : null}
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {action}
    </div>
  )
}

export interface ModelPickerProps {
  /** 设置 →「AI 模型」里的配置清单 */
  models: ModelView[]
  /** 设置 →「外部 Agent」里配好的 ACP agent 清单 */
  acpAgents: AcpAgentView[]
  /** 当前选中的目标；`null` = 还没选 */
  value: ModelTarget | null
  onChange: (next: ModelTarget) => void
  /**
   * acp 会话绑定的那个 agent：二级只显示它的模型，**其它 agent 一律不出现**。
   * 不传 = 没锁到某个具体 agent（内置会话 / 还没建会话）。
   */
  lockedAgent?: AcpAgentView
  /**
   * 会话已创建：一级「内置 Agent / 哪个 ACP agent」**不能再改** ——
   * 打开面板直接落在二级（内置会话 → 内置模型，ACP 会话 → 它绑定的 agent），
   * 也不给返回箭头。二级里换模型仍然可以（下一轮生效）。
   *
   * 不传 / false = 还没有会话（输入框空态、定时任务表单），从一级开始选。
   */
  agentLocked?: boolean
  /** 一级是否显示「外部 Agent（ACP）」分组：已有内置会话时为 false（换类型 = 新建会话） */
  showAcp?: boolean
  /**
   * 非空 = **一级的外部 Agent（ACP）分组不可选**，组内只留这一行说明（远端工作区）。
   *
   * 为什么不直接 `showAcp={false}`：整组凭空消失，用户只会以为是自己没配好；而
   * 分组标题行上还挂着设置齿轮（配置入口），留着它 + 一句「为什么不能选」才解释得通。
   *
   * 判据在调用方（`ModelSelect` 看当前工作区是不是远端）：ACP 要 `spawn` 一个**本机**
   * 进程、cwd 就是工作区目录，远端目录在 SSH 主机上够不着 —— 服务端建会话时也按同一条
   * 判据拒掉（见 `apps/server/src/api/conversations/route.ts`）。
   */
  acpDisabledReason?: string
  /** 触发器上是否带「配置名 · 」前缀（默认不带，只有模型名 —— 位置窄） */
  showProvider?: boolean
  /** 还没选 / 目标失效时触发器上的文案 */
  emptyLabel?: string
  /** 还没选时触发器的 tooltip（选了就显示完整目标） */
  emptyTitle?: string
  /**
   * 模型没单独配上下文窗口时的兜底值（`app.defaultContextWindow`）。
   * 不传就按 `DEFAULT_CONTEXT_WINDOW` 显示 —— 只是给人看的参考数字。
   */
  defaultContextWindow?: number
  /** 打开设置里某个分组的入口；不传则整颗齿轮不渲染 */
  onOpenSettings?: (tab: 'models' | 'acp') => void
  /**
   * 拉取某个 ACP agent 的模型清单（模型选择器首次进入该 agent 时自动调，刷新按钮传
   * `force`）。实现方负责探测并**落盘**，失败返回一行结论 + 可选排查细节（成功 `null`）。
   *
   * 不传 = 不加载（只显示已经存下来的清单）—— 终端助手面板不接 ACP，就不传。
   */
  onLoadAcpModels?: (
    agentId: string,
    force?: boolean
  ) => Promise<AcpModelLoadError | null>
  /**
   * 固定在面板底部的附加区块：**不随模型列表滚动**（列表在它上方单独滚）。
   *
   * 目前只有会话输入框的 `ModelSelect` 用它放「思考强度」（切模型时立刻跟着变），
   * 定时任务表单 / 项目助手面板不传 —— 那些地方没有这个设置。
   */
  footer?: ReactNode
  /**
   * 选中一项后是否自动关闭面板。默认 `true`。
   *
   * 输入框里的选择器传 `false`：底部挂着思考强度，选完模型还要接着调档位，
   * 一选就关会让用户每次都重新打开。
   */
  closeOnSelect?: boolean
}

export function ModelPicker({
  models,
  acpAgents,
  value,
  onChange,
  lockedAgent,
  agentLocked = false,
  showAcp = true,
  acpDisabledReason,
  showProvider = false,
  emptyLabel,
  emptyTitle,
  defaultContextWindow = DEFAULT_CONTEXT_WINDOW,
  onOpenSettings,
  onLoadAcpModels,
  footer,
  closeOnSelect = true
}: ModelPickerProps) {
  // 订阅语言：下面所有 t() 都是渲染期求值的
  useT()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  /** 搜索词：只活在一次打开 / 这一层里（进二级、关面板都清空） */
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLowerCase()
  /** 当前进到哪个二级组；`null` = 停在一级。会话已创建时由 `lockedGroup` 接管 */
  const [group, setGroup] = useState<PickerGroup | null>(null)

  /**
   * 会话已创建时锁死的那一组：ACP 会话 → 它绑定的 agent；内置会话 → 内置 Agent。
   * 绑定的 agent 被删了（会话里记的还是旧 id）就退回一级，让用户能看到
   * 「原来那个已经不在清单里」并重选（与旧版「当作没锁」同一条兜底）。
   */
  const lockedGroup: PickerGroup | null = agentLocked
    ? lockedAgent
      ? { kind: 'acp', agentId: lockedAgent.id }
      : { kind: 'builtin' }
    : null
  const activeGroup = lockedGroup ?? group
  const activeAcpAgent =
    activeGroup?.kind === 'acp'
      ? acpAgents.find((a) => a.id === activeGroup.agentId) ?? null
      : null
  const atLevel2 =
    activeGroup != null && (activeGroup.kind === 'builtin' || activeAcpAgent != null)

  /** 正在拉模型清单的 agent id（同一时刻最多一个在转） */
  const [loadingAcp, setLoadingAcp] = useState<string | null>(null)
  /** 拉取失败的原因（按 agent id；重开面板或再次刷新时清掉） */
  const [acpLoadErrors, setAcpLoadErrors] = useState<Record<string, AcpModelLoadError>>({})
  const activeAcpLoadError = activeAcpAgent ? acpLoadErrors[activeAcpAgent.id] : undefined

  /**
   * 拉一次某个 agent 的模型清单。`force` = 刷新按钮；非强制时已有 `models` 字段
   * 就直接跳过 —— 打开面板不该每次都起一个外部 agent 进程。
   *
   * 失败只记在本地：这里不弹全局 toast（选择器正开着，就地显示更近）。
   */
  const loadAcp = useCallback(
    (agent: AcpAgentView, force: boolean): void => {
      if (!onLoadAcpModels) return
      if (!force && !needsAcpModelLoad(agent)) return
      setLoadingAcp(agent.id)
      setAcpLoadErrors((prev) => {
        if (prev[agent.id] === undefined) return prev
        const next = { ...prev }
        delete next[agent.id]
        return next
      })
      void onLoadAcpModels(agent.id, force).then((error) => {
        setLoadingAcp((current) => (current === agent.id ? null : current))
        if (error) setAcpLoadErrors((prev) => ({ ...prev, [agent.id]: error }))
      })
    },
    [onLoadAcpModels]
  )

  /**
   * 进入某个 ACP agent 的二级时自动拉一次（`models` 缺失 = 新加的 / 老数据）。
   *
   * 失败**不自动重试**：依赖里只有 agent 对象与回调，失败后它们不变，不会打转；
   * 关掉重开面板会再试，或者点标题行尾的刷新。
   */
  useEffect(() => {
    if (!open || !activeAcpAgent) return
    if (!needsAcpModelLoad(activeAcpAgent)) return
    loadAcp(activeAcpAgent, false)
  }, [open, activeAcpAgent, loadAcp])

  /** 触发器上显示的短标签（`null` = 没选或目标失效 → 用 `emptyLabel`） */
  const shortLabel = modelTargetLabel(models, acpAgents, value, showProvider)
  const fullLabel = modelTargetLabel(models, acpAgents, value, true)
  const triggerLabel = shortLabel ?? emptyLabel ?? t('选择 Agent')

  /** 选中目标是 ACP 时对应的 agent（触发器上要显示它在列表里那颗品牌图标） */
  const selectedAcpAgent =
    value?.backend === 'acp' && value.configId
      ? acpAgents.find((agent) => agent.id === value.configId) ?? null
      : null

  /** 选中即写回；`closeOnSelect === false` 时留着面板（底部思考强度要能接着调） */
  const pick = (next: ModelTarget): void => {
    onChange(next)
    if (closeOnSelect) setOpen(false)
  }

  /** 进二级 / 退回一级：都清掉搜索词，别把上一层的过滤条件带过去 */
  const enterGroup = (next: PickerGroup): void => {
    setGroup(next)
    setQuery('')
  }
  const leaveGroup = (): void => {
    setGroup(null)
    setQuery('')
  }

  /** 打开设置里对应的分组：面板先关（设置是弹窗，留着它只会压在新弹窗下面） */
  const openSettings = (tab: 'models' | 'acp'): void => {
    if (!onOpenSettings) return
    setOpen(false)
    onOpenSettings(tab)
  }

  /** 二级标题行尾的设置齿轮（配置入口永远可达） */
  const gear = (tab: 'models' | 'acp'): ReactNode => {
    if (!onOpenSettings) return null
    const label = t('打开设置 → {tab}', {
      tab: tab === 'models' ? t('AI 模型') : t('外部 Agent（ACP）')
    })
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation()
          openSettings(tab)
        }}
        className="rounded p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <Settings className="size-3.5" />
      </button>
    )
  }

  /** 二级标题行尾的刷新（ACP）：强制重新探测模型清单 */
  const refreshAcp = (agent: AcpAgentView): ReactNode => {
    if (!onLoadAcpModels) return null
    const loading = loadingAcp === agent.id
    const label = t('重新加载模型清单')
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        disabled={loading}
        onClick={(event) => {
          event.stopPropagation()
          loadAcp(agent, true)
        }}
        className="rounded p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
      </button>
    )
  }

  /** 内置模型：按配置分段（二级里给模型列表用） */
  const builtinSections: PickerSection[] = []
  for (const config of models) {
    const catalog = catalogOf(config)
    // 没有任何模型的配置不可选（服务端会拒绝），列表里干脆不出现
    if (!catalog.length) continue
    const rows: PickerRow[] = catalog.map((modelId) => ({
      key: `builtin:${config.id}:${modelId}`,
      label: modelId,
      // 窗口一并显示：圆环的分母就是它，选之前就能对上预期
      hint: formatContextWindow(
        resolveContextWindow(config.models, modelId, defaultContextWindow)
      ),
      title: modelId,
      active:
        value?.backend === 'builtin' &&
        value.configId === config.id &&
        value.modelId === modelId,
      search: `${config.name} ${modelId}`.toLowerCase(),
      onSelect: () => pick({ backend: 'builtin', configId: config.id, modelId })
    }))
    builtinSections.push({ key: config.id, name: config.name, rows })
  }

  /**
   * 某个 agent 下面能选什么（二级）：
   * - 没锁（`locked` 为 false）= 先「跟随 agent 默认」，再接它的白名单模型；
   * - 锁了且**挑过白名单** = 只有那些模型（必须具体选一个，「跟随默认」不出现）；
   * - 锁了但没挑白名单 = 只有一个状态：「跟随 agent 默认」。
   */
  const acpRowsOf = (agent: AcpAgentView, locked: boolean): PickerRow[] => {
    const agentModels = agent.models ?? []
    const rows: PickerRow[] = []
    if (!locked || !agentModels.length) {
      const label = t('跟随 agent 默认')
      rows.push({
        key: `acp:${agent.id}:__default`,
        label,
        active:
          value?.backend === 'acp' && value.configId === agent.id && !value.modelId,
        search: `${agent.name} ${label} 默认`.toLowerCase(),
        onSelect: () => pick({ backend: 'acp', configId: agent.id })
      })
    }
    for (const model of agentModels) {
      // 空串 / 纯空白的描述不占一行：agent 有时会广告一个只有空白的 description
      const tipValue = model.value.trim()
      const tipDescription = model.description?.trim()
      rows.push({
        key: `acp:${agent.id}:${model.value}`,
        label: model.name,
        ...(tipValue || tipDescription
          ? {
              tip: (
                <>
                  {tipValue ? <div className="break-all font-mono">{tipValue}</div> : null}
                  {tipDescription ? (
                    // tooltip 是反色底（bg-foreground / text-background）：这里不能再用
                    // text-muted-foreground（那是给普通底色用的灰），会糊得看不清；
                    // 用透明度压一档即可（与其它 tooltip 的次要行同一做法）
                    <div className="mt-0.5 text-pretty opacity-80">{tipDescription}</div>
                  ) : null}
                </>
              )
            }
          : {}),
        active:
          value?.backend === 'acp' &&
          value.configId === agent.id &&
          value.modelId === model.value,
        search: `${agent.name} ${model.name} ${model.value}`.toLowerCase(),
        onSelect: () => pick({ backend: 'acp', configId: agent.id, modelId: model.value })
      })
    }
    return rows
  }

  /**
   * agent 的图标：预设 agent 用品牌图标，认不出的（自定义 agent）由 `AcpAgentIcon`
   * 回落到通用 Bot —— 与设置页、会话列表保持一致。
   */
  const presetIcon = (agent: AcpAgentView, className = 'size-4'): ReactNode => (
    <AcpAgentIcon presetId={agent.preset} command={agent.command} className={className} />
  )

  /** 内置 Agent 的图标：用应用自己的 logo（与顶栏品牌同一份资产） */
  const builtinIcon = (size = 'size-4'): ReactNode => (
    <img
      src={appLogo}
      alt=""
      aria-hidden
      className={`${size} shrink-0 rounded-[3px] object-contain`}
    />
  )

  /** 触发器左侧：选中的 ACP agent 用它在那份清单里的品牌图标，否则走 Bot / logo */
  const triggerIcon = selectedAcpAgent
    ? presetIcon(selectedAcpAgent, 'size-3.5')
    : null

  /** 一级：内置 Agent 的文案（触发器、标题、一级条目共用） */
  const builtinLabel = t('内置 Agent')

  /** 一级：ACP agent 行（远端工作区整组不可选，只留说明） */
  const level1Agents = showAcp && !acpDisabledReason ? acpAgents : []

  /** 二级：内置模型（按配置分段，搜索按配置名 / 模型名过滤） */
  const visibleBuiltinSections = keyword
    ? builtinSections
        .map((section) => ({
          ...section,
          rows: section.rows.filter((row) => row.search.includes(keyword))
        }))
        .filter((section) => section.rows.length > 0)
    : builtinSections

  /** 二级：当前 ACP agent 的模型行 */
  const level2AcpRows =
    activeAcpAgent != null
      ? acpRowsOf(activeAcpAgent, Boolean(agentLocked && lockedAgent)).filter(
          (row) => !keyword || row.search.includes(keyword)
        )
      : []

  /**
   * 行的可读名：需要看完整 id / 描述的行（ACP 模型）用气泡包住。
   *
   * 触屏用**长按**打开（不是点按——点按是选中模型）：
   * - `allowTouch` 只让组件在触屏上渲染出来，Radix 的触发器本身还会忽略 touch 指针
   *   （`pointerType === 'touch'` 直接 return），所以必须自己控制 `open`；
   * - 按住约 450ms 打开气泡，并在随后的一小段窗口里忽略 Radix 的自动关闭 ——
   *   抬手会依次触发 pointerleave / click，不拦的话气泡立刻被关掉，只能看到一闪；
   * - 长按之后的这一次 click 要**吃掉**（只查看，不选中）；手指移动超过阈值（列表滚动）
   *   就取消长按。
   */
  const [tipKey, setTipKey] = useState<string | null>(null)
  const tipHoldUntil = useRef(0)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressStart = useRef<{ x: number; y: number } | null>(null)
  const longPressedKey = useRef<string | null>(null)
  const clearPress = (): void => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }
  useEffect(() => clearPress, [])

  const touchTipHandlers = (
    row: PickerRow
  ): {
    onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onPointerLeave: () => void
    onClickCapture: (event: ReactMouseEvent<HTMLSpanElement>) => void
    onContextMenu: (event: ReactMouseEvent<HTMLSpanElement>) => void
  } => ({
    onPointerDown: (event) => {
      if (event.pointerType !== 'touch') return
      clearPress()
      longPressedKey.current = null
      // 换一行重新按：上一行还挂着的气泡先收掉，别等到新气泡出来才换
      setTipKey(null)
      pressStart.current = { x: event.clientX, y: event.clientY }
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null
        longPressedKey.current = row.key
        // 抬手前后 Radix 会连续要求关闭，留一个窗口让用户看清
        tipHoldUntil.current = Date.now() + 1500
        setTipKey(row.key)
      }, 450)
    },
    onPointerMove: (event) => {
      if (event.pointerType !== 'touch' || !pressStart.current) return
      const dx = event.clientX - pressStart.current.x
      const dy = event.clientY - pressStart.current.y
      // 手指在列表上滑动 = 滚动，不该算长按
      if (Math.hypot(dx, dy) > 10) clearPress()
    },
    onPointerUp: clearPress,
    onPointerCancel: clearPress,
    onPointerLeave: clearPress,
    onClickCapture: (event) => {
      if (longPressedKey.current !== row.key) return
      longPressedKey.current = null
      // 长按只为看 id：这一下不要顺带选中模型
      event.preventDefault()
      event.stopPropagation()
    },
    onContextMenu: (event) => {
      // 长按在移动端会招来系统菜单 / 文本选择，这里一并压掉
      if (longPressedKey.current === row.key) event.preventDefault()
    }
  })

  const rowLabel = (row: PickerRow): ReactNode =>
    row.tip ? (
      <Tooltip
        allowTouch
        open={tipKey === row.key}
        onOpenChange={(next) => {
          if (next) {
            setTipKey(row.key)
            return
          }
          if (Date.now() < tipHoldUntil.current) return
          setTipKey(null)
        }}
      >
        <TooltipTrigger asChild>
          <span className="block select-none truncate" {...touchTipHandlers(row)}>
            {row.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-80 text-left text-pretty">
          {row.tip}
        </TooltipContent>
      </Tooltip>
    ) : (
      row.label
    )

  const renderSection = (section: PickerSection): ReactNode => (
    <div key={section.key}>
      {/* 二级里的小标题（配置名）比一级分组再轻一档：贴紧下面的行 */}
      <PickerLabel className="pt-1.5 pb-0.5 font-normal">{section.name}</PickerLabel>
      {section.rows.map((row) => (
        <PickerItem
          key={row.key}
          value={row.key}
          title={row.title}
          hint={row.hint}
          active={row.active}
          onSelect={row.onSelect}
        >
          {rowLabel(row)}
        </PickerItem>
      ))}
    </div>
  )

  /** 一级没有搜索框：焦点落在列表容器上，方向键 / 回车才继续由 cmdk 接管 */
  const levelOneRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (open && !atLevel2) levelOneRef.current?.focus()
  }, [open, atLevel2])

  const level2Acp = activeGroup?.kind === 'acp'
  const level2Label = level2Acp && activeAcpAgent ? `${activeAcpAgent.name}（ACP）` : builtinLabel

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // 每次开合都回到一级：会话已创建的由 `lockedGroup` 直接接管二级，
        // 其余场景（空态 / 定时任务表单）每次都从「选哪个 agent」开始。
        setGroup(null)
        setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        {/* 手写 button（不是 Select）：样式与结构都走 CHAT_PILL —— 前置图标、箭头大小 / 颜色
            必须和另外两个 pill 对齐 */}
        <button
          type="button"
          aria-label={t('选择后端')}
          title={fullLabel ?? emptyTitle ?? t('这一轮用哪个模型 / 哪个外部 Agent（下一轮生效）')}
          className={CHAT_PILL}
        >
          {/* 选中 ACP agent 时用它在那份清单里的品牌图标；内置模型用应用 logo；未选时用 Bot */}
          {triggerIcon ??
            (value?.backend === 'builtin' && shortLabel ? (
              builtinIcon('size-3.5')
            ) : (
              <Bot className="size-3.5 shrink-0 text-muted-foreground" />
            ))}
          {/* 选中目标可能是「配置 · 模型」这种长名：截断时靠 title 看全 */}
          <span className="truncate" title={fullLabel ?? triggerLabel}>
            {triggerLabel}
          </span>
        </button>
      </PopoverTrigger>
      {/* 与另外两颗 pill 同款：向上弹 + 6px 间距（贴边时 Radix 自动翻转） */}
      <PickerPanel
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        header={
          atLevel2 ? (
            // 二级：agent 名（+ 返回 / 设置）固定在面板最上方，搜索框紧贴在它下面
            <PickerGroupHeader
              icon={
                activeAcpAgent ? presetIcon(activeAcpAgent) : builtinIcon('size-3.5')
              }
              label={level2Label}
              action={
                level2Acp ? (
                  <span className="flex items-center gap-1">
                    {activeAcpAgent ? refreshAcp(activeAcpAgent) : null}
                    {gear('acp')}
                  </span>
                ) : (
                  gear('models')
                )
              }
              onBack={agentLocked ? undefined : leaveGroup}
            />
          ) : (
            <PickerGroupHeader label={t('选择 Agent')} />
          )
        }
        footer={
          footer ? <PickerFooter className="px-3">{footer}</PickerFooter> : undefined
        }
      >
        {atLevel2 ? (
          <>
            <PickerSearch
              // 桌面端进二级即可打字；手机上不聚焦（软键盘会把面板顶到键盘底下）
              autoFocus={!isMobile}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('搜索模型 / Agent')}
              aria-label={t('搜索模型 / Agent')}
            />
            <PickerList>
              {level2Acp ? (
                <>
                  {activeAcpAgent && loadingAcp === activeAcpAgent.id && (
                    <PickerNote>
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="size-3.5 animate-spin" />
                        {t('正在加载模型清单…')}
                      </span>
                    </PickerNote>
                  )}
                  {activeAcpLoadError && (
                    <PickerNote title={activeAcpLoadError.detail}>
                      {activeAcpLoadError.detail
                        ? activeAcpLoadError.message
                        : t('模型清单加载失败：{error}', { error: activeAcpLoadError.message })}
                    </PickerNote>
                  )}
                  {level2AcpRows.length ? (
                    level2AcpRows.map((row) => (
                      <PickerItem
                        key={row.key}
                        value={row.key}
                        title={row.title}
                        hint={row.hint}
                                      active={row.active}
                        onSelect={row.onSelect}
                      >
                        {rowLabel(row)}
                      </PickerItem>
                    ))
                  ) : activeAcpAgent &&
                    loadingAcp !== activeAcpAgent.id &&
                    !acpLoadErrors[activeAcpAgent.id] ? (
                    <PickerNote>
                      {keyword ? t('没有匹配的模型') : t('它没有可选的模型')}
                    </PickerNote>
                  ) : null}
                </>
              ) : visibleBuiltinSections.length ? (
                visibleBuiltinSections.map((section) => renderSection(section))
              ) : (
                <PickerNote>
                  {keyword ? t('没有匹配的模型') : t('还没有模型配置')}
                </PickerNote>
              )}
            </PickerList>
          </>
        ) : (
          /*
            一级不设搜索框：只回答「用哪个 agent」，条目本来就少（内置 + 几个 ACP）。
            容器可聚焦，打开面板时把焦点落进来，方向键 / 回车仍按 cmdk 那一套走。
          */
          <div
            ref={levelOneRef}
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col outline-none"
          >
            {/* 顶部标题由 PickerPanel 的 header 槽提供，列表本身不再补上边距 */}
            <PickerList className="pb-2">
              {/* ---- 一级：一条平铺清单（内置 Agent + 各 ACP agent，不再分两组） ---- */}
              <PickerItem
                icon={builtinIcon()}
                value="group:builtin"
                active={value?.backend === 'builtin'}
                hint={
                  value?.backend === 'builtin'
                    ? modelTargetLabel(models, acpAgents, value, false) ?? undefined
                    : undefined
                }
                onSelect={() => enterGroup({ kind: 'builtin' })}
              >
                {builtinLabel}
              </PickerItem>

              {showAcp && acpDisabledReason ? (
                // 远端工作区：ACP 整组不可选，只留一行说明
                <PickerNote>{acpDisabledReason}</PickerNote>
              ) : showAcp ? (
                level1Agents.map((agent) => {
                  const active = value?.backend === 'acp' && value.configId === agent.id
                  return (
                    <PickerItem
                      key={agent.id}
                      icon={presetIcon(agent)}
                      value={`group:acp:${agent.id}`}
                      active={active}
                      hint={
                        active
                          ? modelTargetLabel(models, acpAgents, value, false) ?? undefined
                          : undefined
                      }
                      onSelect={() => enterGroup({ kind: 'acp', agentId: agent.id })}
                    >
                      {agent.name}
                    </PickerItem>
                  )
                })
              ) : null}
            </PickerList>
          </div>
        )}
      </PickerPanel>
    </Popover>
  )
}
