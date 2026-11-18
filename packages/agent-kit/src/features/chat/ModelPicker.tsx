/**
 * 模型 / 后端选择器 —— **受控版**：只吃 props，完全不知道 `AgentApp` 的存在。
 *
 * 从 `ModelSelect`（会话详情那颗 pill）里抽出来的，动机与工作区 / MCP / 浏览器那几颗
 * 完全一样（它们原来都挤在一个 `pickers.tsx` 里，现在各占一个文件）：**同一个控件只留
 * 一份实现**。定时任务表单要的就是会话详情这一颗 ——
 * 分组（模型配置 / 外部 Agent）、行尾设置齿轮、ACP 白名单、「跟随 agent 默认」这些
 * 行为一个都不能少；此前那边用的是一层平铺的 `ModelPill`，两边看着就是两个功能。
 *
 * 分工：
 * - 本文件：渲染 + 交互，`value` / `onChange` / 清单全从 props 进；
 * - `ModelSelect`（会话详情）：把 `app` 里的数据灌进来，再补自己的副作用
 *   （写 `chatTarget`、按活动会话锁定后端）；
 * - `TriggerEditDialog`（定时任务）：把表单自己的局部状态灌进来。
 *
 * ## 一个下拉装下「这一轮用什么」
 *
 * 标签行尾各有设置齿轮（配置入口永远可达）：
 * - AI 模型：每个模型配置一项，展开是它带的那几个模型；齿轮打开 设置 → AI 模型；
 * - 外部 Agent（ACP）：每个 agent 一项，展开是**设置里挑过的那几个**模型
 *   （一个 agent 常有十几二十个模型，全列出来太吵，白名单见设置 → 外部 Agent）；
 *   齿轮打开 设置 → 外部 Agent。没有任何模型 / agent 时分组也显示（给配置入口）。
 *
 * 会话类型在创建时就锁定，**被锁的整组不显示**（不是置灰）：
 * - acp 会话：只显示绑定的那个 agent 的模型（AI 模型组、其它 agent 一概不出）；
 * - 内置会话 / 定时任务：ACP 组由 `showAcp` 决定；
 * - 没有会话（空态）：两组全量可选。
 *
 * 唯一的例外是**远端工作区**：ACP 组留着标题与一行说明，但整组不可选
 * （`acpDisabledReason`）—— 外部 agent 是服务端本机 spawn 的进程，够不到 SSH 主机上的目录。
 */
import { Check, Settings, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import type { AgentBackend } from '@fizz/contracts/types'
import { DEFAULT_CONTEXT_WINDOW, resolveContextWindow } from '@fizz/contracts/types'
import type { AcpAgentView, ModelView } from '@fizz/contracts/agent-api'
import { CHAT_PILL } from '@fizz/agent-kit/features/chat/composer'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'
import { cn, formatContextWindow } from '@fizz/agent-kit/shared/lib/utils'

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
   * 固定在菜单底部的附加区块：**不随模型列表滚动**（列表在它上方单独滚）。
   *
   * 目前只有会话输入框的 `ModelSelect` 用它放「思考强度」（切模型时立刻跟着变），
   * 定时任务表单 / 项目助手面板不传 —— 那些地方没有这个设置。
   */
  footer?: ReactNode
  /**
   * 选中一项后是否自动关闭下拉。默认 `true`（Radix 的默认行为）。
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
  // 手机上把「配置 / 外部 Agent → 各自的模型」这层二级菜单拍平：Radix 的 DropdownMenuSub
  // 会往侧边展开，窄屏放不下就溢出视口；手机上改成在主面板内直接铺开（组名当标题、模型项
  // 紧随其后），主面板给高度上限 + 滚动。桌面端维持原有的侧向二级弹层。
  const renderGroup = (key: string, label: string, items: ReactNode) =>
    isMobile ? (
      <DropdownMenuGroup key={key}>
        {/* 拍平后组名和模型项是紧挨着的两行，**必须**在字面上就分得开。
                    原来这里写 `px-2 font-normal`：font-normal 把 DropdownMenuLabel 默认的
                    font-medium 抹掉了，剩下的 px-2 py-1.5 text-sm 与 DropdownMenuItem 逐项相同 ——
                    同字号、同字重、同内边距、同颜色，看上去就是一堆平铺的模型名。
                    改成小号灰字（与上面 renderSectionLabel 的「AI 模型」同一套标题样式）+ 组前一条
                    细线：线把每个配置的块框住，小字说明这行是标题而不是可选项。
                    ⚠️ 不要再加 pt-* / pb-* 试图改内边距：tailwind-merge 会把 DropdownMenuLabel 自带的
                    py-1.5 一起留着，最终哪条生效取决于 Tailwind 生成 CSS 的先后顺序（这里靠 mt-1.5
                    拉开组间距就够了）。模型项本身不动：它是 text-sm + 行尾窗口数字 / 勾，差距已够大。 */}
        <DropdownMenuLabel className="mt-1.5 px-2 text-xs font-medium text-muted-foreground">
          {label}
        </DropdownMenuLabel>
        {items}
      </DropdownMenuGroup>
    ) : (
      <DropdownMenuSub key={key}>
        <DropdownMenuSubTrigger>
          <span className="truncate">{label}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
          {items}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )

  /** 分组标签行：组名 + 行尾设置齿轮（打开设置里对应的分组；配置入口永远可达） */
  const renderSectionLabel = (label: string, tab: 'models' | 'acp') => (
    <DropdownMenuLabel className="flex items-center justify-between px-2 py-1.5 text-xs font-normal text-muted-foreground">
      <span>{label}</span>
      {onOpenSettings && (
        <button
          type="button"
          title={t('打开设置 → {tab}', { tab: tab === 'models' ? t('AI 模型') : t('外部 Agent（ACP）') })}
          aria-label={t('打开设置 → {tab}', { tab: tab === 'models' ? t('AI 模型') : t('外部 Agent（ACP）') })}
          onClick={(e) => {
            e.stopPropagation()
            onOpenSettings(tab)
          }}
          className="rounded p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <Settings className="size-3.5" />
        </button>
      )}
    </DropdownMenuLabel>
  )

  /** 触发器上显示的短标签（`null` = 没选或目标失效 → 用 `emptyLabel`） */
  const shortLabel = modelTargetLabel(models, acpAgents, value, showProvider)
  const fullLabel = modelTargetLabel(models, acpAgents, value, true)
  const triggerLabel = shortLabel ?? emptyLabel ?? t('选择模型')

  /**
   * 选中目标。`closeOnSelect === false` 时拦掉 Radix 的默认关闭 ——
   * 输入框里的下拉底部挂着思考强度，选完模型要能接着调档位。
   */
  const selectTarget = (next: ModelTarget) => (event: Event) => {
    if (!closeOnSelect) event.preventDefault()
    onChange(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 手写 button + DropdownMenu（不是 Select，因为要二级菜单）：样式与结构都走
            CHAT_PILL —— 前置图标、箭头大小 / 颜色必须和另外两个 pill 对齐 */}
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
      </DropdownMenuTrigger>
      {/* 与两个 Select 同款：向上弹 + 6px 间距。
          ⚠️ 手机上二级菜单会被拍平，项很多；高度上限**不能写死** `80dvh` —— 那样会盖掉
          Radix 算出的可用高度，列表比触发器上方的空间还高时会被顶出视口上沿。
          取 `min(80dvh, 可用高度)`：80dvh 兜住移动端动态视口（地址栏 / 键盘），可用
          高度兜住触发器以上的真实空间。collisionPadding 让面板与视口边缘留 8px，
          它也会算进那个可用高度里。没有 footer 时滚动由 DropdownMenuContent 自带；
          有 footer 时改由内部列表滚，底部那块固定在下面（见 `footer`）。 */}
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          'min-w-56',
          // 有 footer 时把滚动交给内部列表：外层只负责高度上限与裁切，
          // 底部那一块始终留在可视区里，不会被一长串模型名顶出去。
          footer && 'flex flex-col overflow-hidden p-0',
          isMobile && 'max-h-[min(80dvh,var(--radix-dropdown-menu-content-available-height))]'
        )}
      >
        <div className={cn(footer && 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1')}>
        {lockedAgent ? (
          <>
            {/* ---- acp 会话：只显示绑定的这个 agent 的模型（其它一切不出现） ---- */}
            {renderSectionLabel(`${lockedAgent.name}（ACP）`, 'acp')}
            {/* agent 没挑白名单时它只有一个状态：用 agent 自己的默认（agent 侧的
                缺省，不是 Fizz 的设置）；挑了白名单就必须具体选一个 */}
            {!(lockedAgent.models ?? []).length && (
              <DropdownMenuItem
                onSelect={selectTarget({ backend: 'acp', configId: lockedAgent.id })}
              >
                <span className="truncate">{t('跟随 agent 默认')}</span>
                {value?.backend === 'acp' && value.configId === lockedAgent.id && !value.modelId && (
                  <Check className="ml-auto size-3.5" />
                )}
              </DropdownMenuItem>
            )}
            {(lockedAgent.models ?? []).map((model) => {
              const active =
                value?.backend === 'acp' &&
                value.configId === lockedAgent.id &&
                value.modelId === model.value
              return (
                <DropdownMenuItem
                  key={model.value}
                  title={model.description ?? model.name}
                  onSelect={selectTarget({
                    backend: 'acp',
                    configId: lockedAgent.id,
                    modelId: model.value
                  })}
                >
                  <span className="truncate">{model.name}</span>
                  {active && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              )
            })}
          </>
        ) : (
          <>
            {/* ---- AI 模型：全量可选 ---- */}
            {renderSectionLabel(t('AI 模型'), 'models')}
            {models.length === 0 ? (
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                {t('还没有模型配置')}
              </DropdownMenuItem>
            ) : (
              models.map((config) => {
                const catalog = catalogOf(config)
                // 没有任何模型的配置不可选（服务端会拒绝），下拉里干脆不出现
                if (!catalog.length) return null
                const items = catalog.map((modelId) => {
                  const active =
                    value?.backend === 'builtin' &&
                    value.configId === config.id &&
                    value.modelId === modelId
                  return (
                    <DropdownMenuItem
                      key={modelId}
                      title={modelId}
                      onSelect={selectTarget({ backend: 'builtin', configId: config.id, modelId })}
                    >
                      <span className="truncate">{modelId}</span>
                      {/* 窗口一并显示：圆环的分母就是它，选之前就能对上预期 */}
                      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground tabular-nums">
                        {formatContextWindow(
                          resolveContextWindow(config.models, modelId, defaultContextWindow)
                        )}
                      </span>
                      {active && <Check className="size-3.5 shrink-0" />}
                    </DropdownMenuItem>
                  )
                })
                return renderGroup(config.id, config.name, items)
              })
            )}
            {/*
                          ---- 外部 Agent（ACP）：由 `showAcp` 决定出不出 ----
                          有会话时换不了类型（换类型 = 新建会话），所以 内置会话里这组不出。
                          选中即改目标，会话详情那边 `setChatTarget` 会顺手探一次这个 agent 的档位
                          （`probeDraftAcp`）—— 模式 / 思考档 pill 没有会话可读，只能先问 agent。
                        */}
            {showAcp && (
              <>
                {renderSectionLabel(t('外部 Agent（ACP）'), 'acp')}
                {acpDisabledReason ? (
                  /* 整组不可选（远端工作区）：只留说明。用 div 而不是 disabled 的
                     DropdownMenuItem —— 那句话比「还没有外部 Agent」长得多，菜单项是
                     不换行的一行 flex，会被 `overflow-x-hidden` 直接裁掉 */
                  <div className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
                    {acpDisabledReason}
                  </div>
                ) : acpAgents.length === 0 ? (
                  <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                    {t('还没有外部 Agent')}
                  </DropdownMenuItem>
                ) : (
                  acpAgents.map((agent) => {
                    const items = [
                      <DropdownMenuItem
                        key="__default"
                        onSelect={selectTarget({ backend: 'acp', configId: agent.id })}
                      >
                        <span className="truncate">{t('跟随 agent 默认')}</span>
                        {value?.backend === 'acp' &&
                          value.configId === agent.id &&
                          !value.modelId && <Check className="ml-auto size-3.5" />}
                      </DropdownMenuItem>,
                      ...(agent.models ?? []).map((model) => {
                        const active =
                          value?.backend === 'acp' &&
                          value.configId === agent.id &&
                          value.modelId === model.value
                        return (
                          <DropdownMenuItem
                            key={model.value}
                            title={model.description ?? model.name}
                            onSelect={selectTarget({
                              backend: 'acp',
                              configId: agent.id,
                              modelId: model.value
                            })}
                          >
                            <span className="truncate">{model.name}</span>
                            {active && <Check className="ml-auto size-3.5" />}
                          </DropdownMenuItem>
                        )
                      })
                    ]
                    // key 加前缀：agent id 与模型配置 id 不同域，可能撞名
                    return renderGroup(`acp:${agent.id}`, agent.name, items)
                  })
                )}
              </>
            )}
          </>
        )}
        </div>
        {footer && (
          <div className="shrink-0 border-t border-border px-3 pt-2 pb-2">{footer}</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
