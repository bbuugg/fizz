/**
 * 「定时任务」编辑弹窗：**只放表单**（新建 / 修改一条定时任务）。
 *
 * ## 为什么从 `TriggerDialog` 里拆出来
 *
 * 原先新建 / 修改内嵌在清单弹窗的底部（清单 + 表单共用一张卡、共用一个滚动区）。
 * 现在两者分开：编辑弹窗只显示表单，**不重复显示清单** —— 清单在主区域的「定时任务」
 * 标签页里（`TriggersPanel`），那一页选中一条后点铅笔打开本弹窗。
 *
 * ## 表单项复用「新建会话」那一套
 *
 * 需求框、工作区、权限、模型、浏览器、MCP 本来就是会话上的概念，这里不再各写一份下拉，
 * 而是直接复用聊天输入区那几颗控件（`WorkspacePicker` / `PermissionPill` / `ModelPicker` /
 * `BrowserPicker` / `McpPicker`，样式与交互**只有一份实现**）。
 *
 * 模型那颗是**会话详情同一颗** `ModelPicker`（不是另写一层平铺清单）：分组（模型配置 /
 * 外部 Agent）、行尾设置齿轮、ACP 白名单、「跟随 agent 默认」全都一样 —— 定时任务跑的就是
 * 一个普通会话，手动会话能选什么它就该能选什么。区别只有数据来源：那边读 `chatTarget`，
 * 这边是表单自己的局部状态（`modelTarget`）。选完写进 `template.backend` / `configId` /
 * `modelId`，调度器照这一组建会话（见 `scheduler` 的 `resolveHeadlessTarget`）。
 * 外部 Agent 的权限是它自己发的请求，只有「完全访问」才自动放行，其余档会单独提示。
 *
 * 浏览器那颗在定时任务里**不是凑数**：`browser_*` 工具跑在**服务端**（用服务端那台机器的
 * Chromium / Edge / Chrome），不依赖用户面前的窗口 —— 无人值守的任务照样能开网页抓数据。
 *
 * ⚠️ 但**只在选内置模型时才有意义**：外部 Agent（ACP）自带工具、不读 `browserSettings` /
 * `mcpServerIds`，所以目标切到外部 Agent 时这一排换成与「开始新对话」页同一颗灰占位
 * （`ComposerToolbarPlaceholder`）—— 高度占住不抖，但点不动；保存时这两个字段也不写进
 * 模板（见 `submit`），否则任务详情会显示「浏览器：开启」这种用户从没设过的假事实。
 *
 * ⚠️ **布局也是抄的**，不是「摆得差不多」：需求这块必须与 `chat-surface.tsx` 的
 * `ChatComposer` 同构 —— 卡片上方工具条（MCP）、卡片内底部左权限右模型、卡片下方那条
 * 工作区窄条。第一版把这四样平铺进卡片的同一行，一眼就能看出不是同一个控件。
 *
 * ## 工作区是可选的
 *
 * 与「新建会话时不选工作区」同义：不选 = **每次触发自动建一个临时工作区**（目录在
 * `<数据目录>/conversations/<会话 id>`，不进项目列表）。定时任务因此不再依附于某个项目 ——
 * 想让它去改某个仓库时再绑一个。
 *
 * `trigger = null` 即新建。Radix 的 `DialogContent` 在关闭时会卸载，所以每次打开都是
 * 一棵新树、表单天然干净 —— 不需要「在同一张弹窗里切换编辑对象」时才需要的 `key` 重挂载。
 */
import { useState } from 'react'
import { CalendarClock, Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import type { AiPermissionMode, TaskTrigger } from '@fizz/contracts/types'
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from '@fizz/contracts'
import type { AgentWorkspace, AcpAgentView, ModelView } from '@fizz/contracts/agent-api'
import type { McpServerConfig } from '@fizz/mcp/types'
import { Button } from '@fizz/ui/button'
import { DateTimePicker } from '@fizz/ui/date-time-picker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fizz/ui/select'
import { PermissionPill } from '@fizz/agent-kit/features/chat/composer'
import {
  ModelPicker,
  type ModelTarget
} from '@fizz/agent-kit/features/chat/ModelPicker'
import { WorkspacePicker } from '@fizz/agent-kit/features/chat/WorkspacePicker'
import { BrowserPicker } from '@fizz/agent-kit/features/chat/BrowserPicker'
import { McpPicker } from '@fizz/agent-kit/features/chat/McpPicker'
import { ComposerToolbarPlaceholder } from '@fizz/agent-kit/features/chat/ComposerToolbar'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { TriggersState } from '@fizz/agent-kit/shared/hooks/useTriggers'

/**
 * 表单的 DOM id：提交按钮在滚动区之外（footer 固定），靠 `<button form={id}>` 关联回表单。
 * 同一文档里唯一即可（此弹窗同时只会开一个）。
 */
const FORM_ID = 'trigger-form'

/** 触发方式：定时（cron）/ 定时（一次性） */
type Mode = 'cron' | 'at'

/** 常用 cron 的快捷选项：新手不该被迫先学一遍 cron 语法 */
const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: '每小时', expr: '0 * * * *' },
  { label: '每天 9:00', expr: '0 9 * * *' },
  { label: '每天 18:00', expr: '0 18 * * *' },
  { label: '每周一 9:00', expr: '0 9 * * 1' },
  { label: '每月 1 号 9:00', expr: '0 9 1 * *' }
]

function triggerMode(trigger: TaskTrigger): Mode {
  return trigger.cron ? 'cron' : 'at'
}

export function TriggerEditDialog({
  triggers,
  workspaces,
  models,
  acpAgents,
  mcpServers,
  defaultPermissionMode,
  browserInstalled,
  defaultContextWindow,
  onOpenSettings,
  trigger,
  open,
  onOpenChange
}: {
  triggers: TriggersState
  /** 可绑的工作区（临时工作区已由调用方过滤掉：它们不该被手动选中） */
  workspaces: AgentWorkspace[]
  /** 设置 →「AI 模型」里的配置清单（内置 agent 用的那些） */
  models: ModelView[]
  /** 设置 →「外部 Agent」里配好的 ACP agent 清单（与模型配置同列在一个下拉里） */
  acpAgents: AcpAgentView[]
  /** 设置 → MCP 里配好的 server 清单（由调用方透传，避免弹窗再拉一次） */
  mcpServers: McpServerConfig[]
  /** 新建时权限档的预填值 = 当前全局权限档（与聊天输入框那颗 pill 同源） */
  defaultPermissionMode: AiPermissionMode
  /**
   * 内置浏览器（Playwright headless shell）装好了没有（`app.browserInstalled`）。
   *
   * 没装时这颗开关**不渲染** —— 与聊天工具条同一条判据。
   * 一个点了会在任务跑起来时拿到 `Executable doesn't exist` 的开关，不如不显示。
   */
  browserInstalled: boolean
  /**
   * 模型没单独配窗口时的兜底值（`app.defaultContextWindow`）：只用于模型下拉里那个
   * 参考数字，与「会话详情」那颗同源 —— 不传就按 `DEFAULT_CONTEXT_WINDOW`。
   */
  defaultContextWindow?: number
  /** 模型下拉行尾的设置齿轮（打开 设置 → AI 模型 / 外部 Agent）；不传则不渲染齿轮 */
  onOpenSettings?: (tab: 'models' | 'acp') => void
  /** 正在编辑的那条；`null` = 新建 */
  trigger: TaskTrigger | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* flex-col + overflow-hidden：把「滚动」收进中间那一段，header / footer 固定不动。
          不要用 `overflow-y-auto` 直接挂在 DialogContent 上 —— 那会让整块（标题、表单、按钮）
          共用一个滚动条，标题和底部按钮都跟着内容滚走（见 QuickActionsDialog 同款方案）。
          overflow-x-hidden + 各行的 min-w-0：长文本不再撑出横向滚动条 */}
      {/* `sm:max-w-2xl`（672px）：需求框里要横排「权限 … 模型」+ 下面那条工作区窄条，
          窄了模型 pill 只能截断、下方窄条也被挤成两行 —— 与聊天输入框的宽度感一致 */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{trigger ? t('编辑定时任务') : t('新建定时任务')}</DialogTitle>
          <DialogDescription>
            {t(
              '配置「什么时候自动起一轮会话」：按 cron 表达式，或指定一个时刻。跑起来的会话在侧栏里可见、可回看。'
            )}
          </DialogDescription>
        </DialogHeader>

        {/* 唯一的滚动区：表单字段（footer 在它外面，不滚） */}
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-1">
          <TriggerForm
            triggers={triggers}
            workspaces={workspaces}
            models={models}
            acpAgents={acpAgents}
            mcpServers={mcpServers}
            defaultPermissionMode={defaultPermissionMode}
            browserInstalled={browserInstalled}
            defaultContextWindow={defaultContextWindow}
            onOpenSettings={onOpenSettings}
            editing={trigger}
            onDone={() => onOpenChange(false)}
          />
        </div>

        {/* 按钮落在滚动区之外：始终可见。提交按钮用 `form` 关联到表单（按钮不在 form 里，
            但同一文档内合法），回车提交也走同一条路。
            没有任何「必填的工作区」了：不绑也能建（每次触发自动建临时工作区） */}
        <DialogFooter className="shrink-0">
          <Button type="submit" form={FORM_ID} disabled={triggers.busy}>
            {triggers.busy && <Loader2 className="size-4 animate-spin" />}
            {trigger ? t('保存修改') : t('创建定时任务')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 定时任务表单（新建 / 编辑共用）。
 *
 * **刻意拆成独立组件**：状态全用 `useState` 的初始值表达，由父组件在打开时重挂载
 * （Radix 关闭即卸载 → 再打开就是干净表单）。`editing = null` 即新建。
 */
function TriggerForm({
  triggers,
  workspaces,
  models,
  acpAgents,
  mcpServers,
  defaultPermissionMode,
  browserInstalled,
  defaultContextWindow,
  onOpenSettings,
  editing,
  onDone
}: {
  triggers: TriggersState
  workspaces: AgentWorkspace[]
  models: ModelView[]
  acpAgents: AcpAgentView[]
  mcpServers: McpServerConfig[]
  defaultPermissionMode: AiPermissionMode
  browserInstalled: boolean
  defaultContextWindow?: number
  onOpenSettings?: (tab: 'models' | 'acp') => void
  /** null = 新建 */
  editing: TaskTrigger | null
  onDone: () => void
}) {
  const t = useT()
  /**
   * 绑定的工作区；`null` = 不绑（每次触发自动建临时工作区）。
   *
   * 新建默认不绑：定时任务不该为了「能跑起来」先逼用户挑一个项目，更不该悄悄在用户
   * 正在用的仓库里改东西 —— 想让它改某个仓库时再明确绑一个。
   *
   * 编辑时**绑的那个已经不在清单里**（项目被删 / 级联漏了）→ 当成没绑：下拉里本来
   * 就选不中它（`WorkspacePicker` 找不到就显示「不选」），要是还把这个死 id 留着，
   * 一点保存就会被服务端以「工作区不存在」打回。改成不绑 = 顺手把它解绑。
   */
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    editing?.workspaceId && workspaces.some((w) => w.id === editing.workspaceId)
      ? editing.workspaceId
      : null
  )
  /**
   * 选中的工作区记录：目录被删 / 被移走时（服务端巡检标的 `dirMissing`）要**当场**提示。
   * 保存会被服务端以「工作区目录不存在」打回（定时任务无人值守，建的时候不拦就只能在到点
   * 那一刻炸），所以别让人填完一整张表单才发现。
   */
  const selectedWorkspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined
  const [mode, setMode] = useState<Mode>(editing ? triggerMode(editing) : 'cron')
  const [name, setName] = useState(editing?.name ?? '')
  const [cron, setCron] = useState(editing?.cron ?? CRON_PRESETS[1].expr)
  /** 一次性触发的时刻（时间戳，本地时区；`null` = 还没选） */
  const [at, setAt] = useState<number | null>(editing?.at ?? null)
  const [prompt, setPrompt] = useState(editing?.template.prompt ?? '')
  /** 权限档：新建时预填全局那一档，缺省值本身仍是「完全访问」（调度器口径） */
  const [permissionMode, setPermissionMode] = useState<AiPermissionMode>(
    editing?.template.permissionMode ?? defaultPermissionMode
  )
  /**
   * 选中的目标（后端 / 配置 / 模型）；`null` = **还没选**。
   *
   * 形状与会话详情那颗 `ModelPicker` 的 `value` 完全一致（`chatTarget` 也是它），
   * 所以同一颗控件两边都能用，不需要编码成字符串再解回来。
   *
   * - `{ backend: 'builtin', configId, modelId }`：内置模型（模型必选）；
   * - `{ backend: 'acp', configId }`：外部 Agent，用它自己的默认模型；
   * - `{ backend: 'acp', configId, modelId }`：外部 Agent + 它广告的某个模型
   *   （值来自 `agent.models[].value`，与手动会话里选的是同一份）。
   *
   * 没有「不指定 / 用第一份可用配置」这种选项：定时任务没人值守，用哪个跑必须由
   * 用户明确选 —— 没选就是没选，服务端也不会替你挑（见 `scheduler` 的
   * `resolveHeadlessTarget`）。
   *
   * 编辑时**绑的配置 / 模型 / agent 已经删了**也退回「没选」：否则 pill 上会显示一串
   * 原文（下拉里没有这一项，找不到名字），保存时还会把这串死 id 写回去。
   */
  const [modelTarget, setModelTarget] = useState<ModelTarget | null>(() => {
    const template = editing?.template
    const configId = template?.configId
    if (!configId) return null
    if (template?.backend === 'acp') {
      const agent = acpAgents.find((a) => a.id === configId)
      if (!agent) return null
      const modelId = template.modelId
      // 模型值不在 agent 当前暴露的清单里 = 失效（agent 升级后常见）→ 退回「跟随默认」
      return modelId && (agent.models ?? []).some((m) => m.value === modelId)
        ? { backend: 'acp', configId, modelId }
        : { backend: 'acp', configId }
    }
    const modelId = template?.modelId
    if (!modelId) return null
    const config = models.find((m) => m.id === configId)
    const catalog = (config?.models ?? []).map((model) => model.id)
    return catalog.includes(modelId) ? { backend: 'builtin', configId, modelId } : null
  })
  /** 触发时会话要挂的 MCP server id；空 = 一个都不挂（触发会话可以没有 MCP） */
  const [mcpServerIds, setMcpServerIds] = useState<string[]>(
    editing?.template.mcpServerIds ?? []
  )
  /**
   * 浏览器工具偏好（开关）。
   *
   * 定时任务也能用：`browser_*` 工具跑在**服务端**，靠的是服务端那台机器上的浏览器运行时，
   * 与用户面前有没有开窗口无关 —— 无人值守反而更需要它（抓页面、核数据）。
   * 新建预填**常量默认**（关）：没有「全局默认」那一层了，别拿当前会话的偏好去预填 ——
   * 用户在某个开着浏览器的会话里点进来，不该让新建的定时任务默认也开着。
   */
  const [browserSettings, setBrowserSettings] = useState<BrowserSettings>(
    editing?.template.browserSettings ?? DEFAULT_BROWSER_SETTINGS
  )

  /**
   * 当前选的是外部 Agent（权限语义与内置模型那套不同，下面要单独提示）。
   * 清单本身由 `ModelPicker` 自己渲染 —— 这里不再另建一份平铺的 options 数组。
   */
  const isAcpTarget = modelTarget?.backend === 'acp'

  async function submit(): Promise<void> {
    // 没选 = 不让存：触发时没人值守，存一条没有模型的任务只会变成「到点就报错」
    // （调度器不再回退到清单第一份，见 `scheduler` 的 `resolveHeadlessTarget`）
    // 校验失败统一 toast，弹窗里不再有内联错误区
    if (!modelTarget?.configId) {
      toast.error(
        t('先选一个模型或外部 Agent：定时任务触发时没人值守，不会替你挑一份配置')
      )
      return
    }
    const { backend, configId, modelId } = modelTarget
    // 内置模型必须挑到具体模型；外部 Agent 允许「跟随 agent 默认」（modelId 为空）
    if (backend === 'builtin' && !modelId) {
      toast.error(t('先选一个模型：定时任务触发时没人值守，不会替你挑一份配置'))
      return
    }
    // 一次性触发没选时刻 = 也不能存：那会变成一条「永远等不到」的任务（服务端同样会拒）
    if (mode === 'at' && at === null) {
      toast.error(t('选一个触发时刻：一次性任务必须知道「什么时候」跑'))
      return
    }
    // 只存**当前还存在**的 server id（设置里删掉的那些不必写进模板）
    const chosenMcpIds = mcpServerIds.filter((id) => mcpServers.some((s) => s.id === id))
    const ok = await triggers.saveTrigger({
      ...(editing ? { id: editing.id } : {}),
      // 空 = 解绑（服务端按「不传即不绑」处理，更新时会真的清掉旧值）
      ...(workspaceId ? { workspaceId } : {}),
      name: name.trim() || t('定时任务'),
      ...(mode === 'cron' ? { cron: cron.trim() } : {}),
      ...(mode === 'at' && at !== null ? { at } : {}),
      template: {
        prompt: prompt.trim(),
        permissionMode,
        backend,
        configId,
        // 外部 Agent 的「跟随默认」= 不写这个字段（省了就是 agent 自己的默认）
        ...(modelId ? { modelId } : {}),
        // 开关 + 来源**总是**带上（不能只在开启时写）：全局默认可能是开着的，
        // 用户在表单里明确关掉时得能把「关」这一状态存下来，否则触发时又按全局默认开回来。
        // 但**外部 Agent 那两个字段一律不写**：它自带工具、不读它们，写进去只会让任务详情
        // 显示「浏览器：开启」这种假事实（表单里这两颗对 ACP 是灰占位，用户根本没碰过）。
        ...(isAcpTarget
          ? {}
          : {
              browserSettings,
              ...(chosenMcpIds.length ? { mcpServerIds: chosenMcpIds } : {})
            })
      },
      enabled: editing?.enabled ?? true
    })
    if (ok) onDone()
  }

  return (
    <form
      id={FORM_ID}
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="trigger-name">{t('名称')}</Label>
        <Input
          id="trigger-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('每天巡检依赖')}
        />
      </div>

      {/*
        需求框：**逐像素照「开始新对话」页的输入卡片**（`chat-surface.tsx` 的
        `ChatComposer` 那一坨）。聊天里那块是四层叠出来的，这里一层都不能少 ——
        少一层就是「看着像另一个控件」（第一版把四样塞进卡片里的同一行，用户直接看出来了）：

        1. 卡片**上方**一条能力工具条：浏览器 + MCP（与聊天同一排、同一顺序）。
           一个 MCP server 都没配时那颗不渲染，但**这一行照渲**（地球那颗常在）；
        2. 卡片本体 `rounded-xl border border-border bg-card/70` + 无边框 textarea
           （尺寸、`field-sizing-content`、隐藏滚动条全照 `Composer` 的类名抄）；
        3. 卡片**内部**操作行 `justify-between`：左边权限、右边模型（聊天里右边还有
           语音 / 发送两颗圆钮，它们属于「发送」这个动作，表单的提交在弹窗外面的 footer，
           所以这里不复制 —— 复制会出现两个提交入口）；
        4. 卡片**下方**那条工作区窄条（`bg-sidebar/60` + `mx-3` + 圆下角），
           与聊天里「未指定工作区 / 选择工作区」那条**同一个东西、同一个位置**。
      */}
      <div className="space-y-1.5">
        <Label htmlFor="trigger-prompt">{t('需求')}</Label>
        <div>
          {/* 与聊天工具条同一条判据：浏览器没装 → 那颗不出现；连 MCP 也没配 →
              整行不渲染（空行会把需求框往下推，看着像多了一段空白）。

              选的是**外部 Agent** 时这一排不生效：`browser_*` 工具与提示词里的浏览器说明
              只在**内置链路**注入，MCP 也是按会话勾给内置 agent 的；ACP 走外部 agent，
              它自带工具、也不读 template.browserSettings / mcpServerIds（见 scheduler 的
              建会话那一段）。所以与「开始新对话」页同一套处理 —— 画灰占位把高度占住
              （在这里当场把目标从内置切到外部 Agent 时需求框不会上下跳），不给能点的开关。 */}
          {isAcpTarget ? (
            (browserInstalled || mcpServers.length > 0) && (
              <div className="mb-2">
                <ComposerToolbarPlaceholder
                  browser={browserInstalled}
                  mcp={mcpServers.length > 0}
                />
              </div>
            )
          ) : (browserInstalled || mcpServers.length > 0) && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {/* 浏览器工具跑在**服务端**，无人值守的任务一样能用（见 template.browserSettings） */}
              {browserInstalled && (
                <BrowserPicker
                  value={browserSettings}
                  onChange={(patch) =>
                    setBrowserSettings((prev) => ({ ...prev, ...patch }))
                  }
                />
              )}
              {mcpServers.length > 0 && (
                <McpPicker
                  servers={mcpServers}
                  value={mcpServerIds}
                  onChange={setMcpServerIds}
                />
              )}
            </div>
          )}
          <div className="rounded-xl border border-border bg-card/70 transition-colors">
            <textarea
              id="trigger-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder={t('例：检查依赖有没有新版本，有就升级并提交')}
              className="block max-h-40 min-h-[72px] w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none [scrollbar-width:none] placeholder:text-muted-foreground field-sizing-content [&::-webkit-scrollbar]:hidden"
            />
            {/* 操作行：左权限、右模型。`min-w-0` 两边都给 —— 窄屏时模型 pill 自己截断，
                而不是把这一行顶出卡片（与 `Composer` 同一条规矩，见那边的注释） */}
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="flex min-w-0 items-center gap-1">
                <PermissionPill value={permissionMode} onChange={setPermissionMode} />
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <ModelPicker
                  models={models}
                  acpAgents={acpAgents}
                  value={modelTarget}
                  onChange={setModelTarget}
                  // 「配置 · 模型」：表单比聊天工具条宽，带上配置名少一次猜
                  showProvider
                  emptyLabel={t('选择模型 / Agent')}
                  emptyTitle={t(
                    '触发时用什么跑：内置模型（配置 → 模型），或外部 Agent（ACP，可跟随它自己的默认模型）'
                  )}
                  defaultContextWindow={defaultContextWindow}
                  onOpenSettings={onOpenSettings}
                />
              </div>
            </div>
          </div>
          {/* 卡片下方那条工作区窄条：与聊天里同一处、同一套皮（贴着卡片、圆下角） */}
          <div className="mx-3 flex min-w-0 items-center gap-2 rounded-b-lg bg-sidebar/60 px-1">
            <WorkspacePicker
              value={workspaceId}
              workspaces={workspaces}
              onChange={setWorkspaceId}
              emptyLabel={t('每次运行自动创建')}
              title={t(
                '工作区：Agent 只能读写这个目录里的东西。不选 = 每次触发在数据目录下新建一个临时工作区（不进项目列表）'
              )}
            />
          </div>
        </div>
        {selectedWorkspace?.dirMissing ? (
          <p className="flex items-start gap-1.5 text-xs leading-5 text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {t('这个工作区的目录已不存在（{path}），保存会被拒绝：请重新选择工作区，或改用「每次运行自动创建」。', {
              path: selectedWorkspace.path
            })}
          </p>
        ) : null}
        <p className="text-xs leading-5 text-muted-foreground">
          {workspaceId
            ? t('每次触发都在这个工作区里跑一轮会话。')
            : t('不绑工作区：每次触发自动新建一个临时工作区（空目录、不进项目列表），从零干一遍。')}
          {isAcpTarget
            ? t(
                '权限 / 模型与新建会话时是同一套选项；浏览器 / MCP 只对内置模型生效 —— 外部 Agent 自带工具，不读这两个开关。'
              )
            : t(
                '权限 / 模型 / 浏览器 / MCP 与新建会话时是同一套选项；浏览器工具跑在服务端，无人值守也能用。'
              )}
          {t(
            '必须选一个目标（内置模型，或外部 Agent）—— 触发时没人值守，不会替你挑一个。外部 Agent 可以「跟随它自己的默认模型」。'
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>{t('触发方式')}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cron">{t('按时间表（cron）')}</SelectItem>
            <SelectItem value="at">{t('一次性（指定时刻）')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === 'cron' && (
        <div className="space-y-1.5">
          <Label htmlFor="trigger-cron">{t('cron 表达式')}</Label>
          <Input
            id="trigger-cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            className="font-mono text-xs"
            placeholder="0 9 * * *"
          />
          <div className="flex flex-wrap gap-1 pt-1">
            {CRON_PRESETS.map((preset) => (
              // 在 form 里，按钮默认是 submit —— 不写死 type 的话点预设会直接提交
              <Button
                key={preset.expr}
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={() => setCron(preset.expr)}
              >
                {t(preset.label)}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('分 时 日 月 周（周日为 0），由服务端内置 cron 调度')}
          </p>
        </div>
      )}

      {mode === 'at' && (
        <div className="space-y-1.5">
          <Label htmlFor="trigger-at">{t('触发时刻')}</Label>
          {/* 日期 + 24 小时时间（`@fizz/ui/date-time-picker`）：不用原生 `datetime-local` ——
              它的面板由浏览器画、跟不了主题，各平台还长得完全不一样 */}
          <DateTimePicker
            id="trigger-at"
            // 受控：Date 每次渲染新建一个不影响（Popover 内部不比较引用），只读它取时分
            value={at !== null ? new Date(at) : null}
            onChange={(next) => setAt(next ? next.getTime() : null)}
          />
          <p className="text-xs text-muted-foreground">{t('到点触发一次，之后自动停用')}</p>
        </div>
      )}

      {/*
        ⚠️ confirm 档在无人值守下等于「写操作全被拒」——`guardWrite` 等不到答复会 fail-closed。
        这不是能靠提示糊过去的小字，所以在选中它时给一条醒目的警告。
      */}
      {permissionMode === 'confirm' && (
        <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-500">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t(
              '「确认模式」要先有人点「允许」才放行写操作，而定任务跑的时候旁边通常没人 —— 写文件 / 执行命令会被拒绝。无人值守请选「完全访问」；只想看不想改就选「只读模式」。'
            )}
          </span>
        </p>
      )}

      {/*
        外部 Agent 的权限是**它自己发的请求**（不是内置工具那套档位）：只有「完全访问」才会
        自动放行，其余档一律等用户答复 —— 无人值守时等于等超时再拒绝。这条必须显式说出来，
        否则用户会看到「任务跑了，但 agent 什么也没干」。
      */}
      {isAcpTarget && permissionMode !== 'full' && (
        <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-500">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t(
              '外部 Agent 的权限请求只有「完全访问」才会自动放行；当前档位下这些请求会一直等不到人答复，超时后被拒绝 —— 需要它真的动手时请选「完全访问」。'
            )}
          </span>
        </p>
      )}

      <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
        <CalendarClock className="mt-0.5 size-3.5 shrink-0" />
        {t(
          '触发的会话与手动新建的会话完全一样（侧栏可回看、可继续对话），区别只是「谁按的开始」。'
        )}
      </p>
    </form>
  )
}
