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
 * ## 一个下拉装下「这一轮用什么」，但**没有二级菜单**（2026-11 用户要求）
 *
 * 原来是「AI 模型 → 某个配置 → 它的模型」两级 `DropdownMenuSub`，手机上再拍平一次，
 * 桌面 / 手机两套形状。现在只有一套：**一个能搜、能滚的平铺列表**（`@fizz/ui/picker-panel`），
 * 配置 / Agent 只当分组小标题（`PickerLabel`），模型行直接铺在它下面。
 *
 * 分段的理由不是「还原二级菜单」：同一个模型名在多个配置里会重名（`gpt-5` 可能同时挂在
 * 两个 key 下），没有小标题就分不清选的是哪一个；而小标题**不可点、不进方向键遍历**，
 * 敲字时它跟着筛，选中 / 回车永远只落在模型行上。
 *
 * 搜索命中「配置名 / Agent 名 / 模型名」任一处即可（`search` 把三样拼在一起）。
 *
 * ## 设置齿轮永远可达
 *
 * 「AI 模型」「外部 Agent（ACP）」两个分段标题行尾各挂一枚齿轮，打开设置里对应的分组
 * ——没有任何配置时那行也照样显示，否则用户连「去哪儿加」都找不到。
 *
 * 唯一的例外是**远端工作区**：ACP 组留着标题与一行说明，但整组不可选
 * （`acpDisabledReason`）—— 外部 agent 是服务端本机 spawn 的进程，够不到 SSH 主机上的目录。
 */
import { Settings, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { Popover, PopoverTrigger } from '@fizz/ui/popover'
import {
  PickerEmpty,
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
import { CHAT_PILL } from '@fizz/agent-kit/features/chat/composer'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { formatContextWindow } from '@fizz/agent-kit/shared/lib/utils'
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

/** 平铺后的一行（小标题不进这里：它们不是可选项） */
interface PickerRow {
  /** cmdk 的 value，全局唯一：配置 id 与 agent id 不同域，带前缀防撞 */
  key: string
  label: string
  /** 行尾次要信息（内置模型显示上下文窗口：圆环的分母就是它） */
  hint?: string
  title?: string
  active: boolean
  /** 搜索文本：把小标题也拼进来，敲配置名 / Agent 名也能搜到它下面的模型 */
  search: string
  onSelect: () => void
}

/** 一个分段：小标题 + 它下面的行 */
interface PickerSection {
  key: string
  name: string
  rows: PickerRow[]
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
   * acp 会话绑定的那个 agent：只显示它的模型，**其它一切不出现**（会话类型已锁定）。
   * 不传 = 没锁定，走正常的「AI 模型 + 外部 Agent」两组。
   */
  lockedAgent?: AcpAgentView
  /** 是否显示「外部 Agent（ACP）」分组：已有 内置会话时为 false（换类型 = 新建会话） */
  showAcp?: boolean
  /**
   * 非空 = **外部 Agent（ACP）这一组整组不可选**，组内只留这一行说明（远端工作区）。
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
  showAcp = true,
  acpDisabledReason,
  showProvider = false,
  emptyLabel,
  emptyTitle,
  defaultContextWindow = DEFAULT_CONTEXT_WINDOW,
  onOpenSettings,
  footer,
  closeOnSelect = true
}: ModelPickerProps) {
  // 订阅语言：下面所有 t() 都是渲染期求值的
  useT()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  /** 搜索词：只活在一次打开里（关面板就清空，下次打开是完整清单） */
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLowerCase()

  /** 触发器上显示的短标签（`null` = 没选或目标失效 → 用 `emptyLabel`） */
  const shortLabel = modelTargetLabel(models, acpAgents, value, showProvider)
  const fullLabel = modelTargetLabel(models, acpAgents, value, true)
  const triggerLabel = shortLabel ?? emptyLabel ?? t('选择模型')

  /** 选中即写回；`closeOnSelect === false` 时留着面板（底部思考强度要能接着调） */
  const pick = (next: ModelTarget): void => {
    onChange(next)
    if (closeOnSelect) setOpen(false)
  }

  /** 分段小标题行尾的设置齿轮（配置入口永远可达） */
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
          // 面板先关：设置是弹窗，留着它只会压在新弹窗下面
          setOpen(false)
          onOpenSettings(tab)
        }}
        className="rounded p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <Settings className="size-3.5" />
      </button>
    )
  }

  /** ---- 内置模型：按配置分段 ---- */
  const builtinSections: PickerSection[] = []
  if (!lockedAgent) {
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
  }

  /**
   * 某个 agent 下面能选什么：
   * - 没锁（`lockedAgent` 为空）= 先「跟随 agent 默认」，再接它的白名单模型；
   * - 锁了且**挑过白名单** = 只有那些模型（必须具体选一个，「跟随默认」不出现）；
   * - 锁了但没挑白名单 = 只有一个状态：「跟随 agent 默认」。
   */
  const acpRowsOf = (agent: AcpAgentView): PickerRow[] => {
    const agentModels = agent.models ?? []
    const rows: PickerRow[] = []
    if (!lockedAgent || !agentModels.length) {
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
      rows.push({
        key: `acp:${agent.id}:${model.value}`,
        label: model.name,
        title: model.description ?? model.name,
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

  const acpSections: PickerSection[] =
    lockedAgent
      ? [
          {
            key: `acp:${lockedAgent.id}`,
            name: `${lockedAgent.name}（ACP）`,
            rows: acpRowsOf(lockedAgent)
          }
        ]
      : showAcp && !acpDisabledReason
        ? acpAgents.map((agent) => ({
            key: `acp:${agent.id}`,
            name: agent.name,
            rows: acpRowsOf(agent)
          }))
        : []

  /** 敲了字就只留有命中的分段；小标题跟着筛（没命中的段连标题一起消失） */
  const filterSections = (sections: PickerSection[]): PickerSection[] =>
    keyword
      ? sections
          .map((section) => ({
            ...section,
            rows: section.rows.filter((row) => row.search.includes(keyword))
          }))
          .filter((section) => section.rows.length > 0)
      : sections

  const visibleBuiltin = filterSections(builtinSections)
  const visibleAcp = filterSections(acpSections)
  const visibleCount =
    visibleBuiltin.reduce((total, section) => total + section.rows.length, 0) +
    visibleAcp.reduce((total, section) => total + section.rows.length, 0)

  /**
   * 敲字时**整段都没命中就连小标题一起收掉**：否则会剩下「AI 模型」「外部 Agent（ACP）」
   * 两个空标题挂在一句「没有匹配的模型」上面，看着像加载失败。
   */
  const showBuiltinSection = !keyword || visibleBuiltin.length > 0
  const showAcpSection = showAcp && (!keyword || visibleAcp.length > 0)

  const renderSection = (section: PickerSection): ReactNode => (
    <div key={section.key}>
      {/* 二级标题（配置名 / agent 名）比「AI 模型」那一行更轻：小一号、不加粗、贴紧下面的行 */}
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
          {row.label}
        </PickerItem>
      ))}
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
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
          <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
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
        footer={
          footer ? <PickerFooter className="px-3">{footer}</PickerFooter> : undefined
        }
      >
        <PickerSearch
          // 桌面端打开即可打字；手机上不聚焦（软键盘会把面板顶到键盘底下）
          autoFocus={!isMobile}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索模型 / Agent')}
          aria-label={t('搜索模型 / Agent')}
        />
        <PickerList>
          {lockedAgent ? (
            <>
              {/* ---- acp 会话：只显示绑定的这个 agent（其它一切不出现） ---- */}
              {!keyword || visibleCount > 0 ? (
                <PickerLabel action={gear('acp')}>{`${lockedAgent.name}（ACP）`}</PickerLabel>
              ) : null}
              {visibleAcp.flatMap((section) =>
                section.rows.map((row) => (
                  <PickerItem
                    key={row.key}
                    value={row.key}
                    title={row.title}
                    active={row.active}
                    onSelect={row.onSelect}
                  >
                    {row.label}
                  </PickerItem>
                ))
              )}
            </>
          ) : (
            <>
              {/* ---- AI 模型 ---- */}
              {showBuiltinSection ? (
                <>
                  <PickerLabel action={gear('models')}>{t('AI 模型')}</PickerLabel>
                  {visibleBuiltin.length ? (
                    visibleBuiltin.map((section) => renderSection(section))
                  ) : (
                    <PickerNote>{t('还没有模型配置')}</PickerNote>
                  )}
                </>
              ) : null}
              {/* ---- 外部 Agent（ACP）：由 `showAcp` 决定出不出 ----
                  有会话时换不了类型（换类型 = 新建会话），所以内置会话里这组不出。 */}
              {showAcpSection ? (
                <>
                  <PickerLabel action={gear('acp')}>{t('外部 Agent（ACP）')}</PickerLabel>
                  {acpDisabledReason ? (
                    // 整组不可选（远端工作区）：只留说明
                    <PickerNote>{acpDisabledReason}</PickerNote>
                  ) : visibleAcp.length ? (
                    visibleAcp.map((section) => renderSection(section))
                  ) : (
                    <PickerNote>{t('还没有外部 Agent')}</PickerNote>
                  )}
                </>
              ) : null}
            </>
          )}
          {keyword && visibleCount === 0 ? (
            <PickerEmpty>{t('没有匹配的模型')}</PickerEmpty>
          ) : null}
        </PickerList>
      </PickerPanel>
    </Popover>
  )
}
