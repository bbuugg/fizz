/**
 * 设置 →「模型」标签页：模型配置（= 网关）列表 + 每份配置下的**模型清单**，以及两个弹窗。
 *
 * ## 信息架构（为什么这么分）
 * - 一份配置 = 一个网关（kind + baseURL + apiKey），**模型是它下面的一行一行** —— 不是弹窗里的
 *   一栏。模型的增（手工 / 上游拉取）、删、改窗口全在列表行上做，配置弹窗只管网关本身。
 *   好处：一眼看全「这个网关下有哪些模型、各自多大窗口」，不必先点开弹窗才知道。
 * - 列表上的增删与拉取**立即落库**（`domain.saveModel` 是整份 upsert，传全量清单）：
 *   列表就是真源，没有「改完忘了保存」这一层。apiKey 一律不传 → 服务端保留原密钥。
 * - 上下文窗口**按模型**配（见 `AiModelEntry.contextWindow`）：**只读展示在模型 id 后面**
 *   （灰字「默认」= 没单独配、走 `DEFAULT_CONTEXT_WINDOW` 兜底）；要改去 ✎ 打开模型弹窗，
 *   那里是预设几档 + 自定义。它同时是圆环的分母与自动压缩的阈值来源
 *   （`compactionTriggerTokens(窗口)` = 窗口 − 预留），所以改完不必重启，下一轮就按新窗口判断。
 * - **最大输出 token / 工具调用 / 图片输入 / 思考 / 接口风格**也都按模型存
 *   （`AiModelEntry.settings`）：同一个网关下不同模型的能力与上限可以不同。
 *   行尾只显示非默认项（如「输出 8k · 无图」），点 ✎ 在同一弹窗里改。
 * - 「从上游拉取」是独立弹窗：候选 id 可能很长，内嵌会把编辑弹窗撑出横向滚动条（实测）。
 *   勾选若干 → 一次性并进配置；**已在清单里的行默认勾上、也可以取消**（取消 = 保存时
 *   移出）—— 对着上游清单顺手清一遍，比回列表逐行点 × 快得多（用户报过「已选中的取消
 *   不了」）。只认**这次清单里出现过的**行，上游没返回的模型一律保留，免得上游分页 /
 *   少返回时把配置删空。
 *
 * ## 与旧版的关键差异
 * 旧版把「模型 id + 窗口」放在**配置弹窗**里编辑，导致两处都能改模型（且窗口只能手敲数字）。
 * 现在配置弹窗只剩网关切；模型只在列表里管。
 *
 * 弹窗走 Dialog（用户要求）：它本身嵌在「设置」弹窗里，属于 Radix 的嵌套 Dialog ——
 * 各自独立 portal + focus scope，Esc / 点遮罩只关最上层那一个，不用自己处理。
 */
import { useRef, useState } from 'react'
import { Check, Download, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { NumberField } from '@fizz/ui/number-field'
import { Switch } from '@fizz/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { cn, formatContextWindow } from '@fizz/agent-kit/shared/lib/utils'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import {
  compactionTriggerTokens,
  DEFAULT_CONTEXT_WINDOW,
  findModelEntry,
  type AiApiStyle,
  type AiModelEntry,
  type AiModelSettings,
  type AiProviderKind
} from '@fizz/contracts/types'
import type { ModelView, UpstreamModelsInput } from '@fizz/contracts/agent-api'

const KIND_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI 兼容',
  deepseek: 'DeepSeek',
  google: 'Google'
}

/**
 * 上下文窗口的预置档（点击填入输入框）。值按官方标称口径（k = 1000，见
 * `formatContextWindow`）：128k = 128,000，不是 131,072。
 *
 * 输入框留空 = **不单独配**（走 `DEFAULT_CONTEXT_WINDOW` 兜底）—— 与「配成 200k」
 * 是两回事：前者以后改兜底值会跟着变，后者钉死在 200k。
 */
const WINDOW_PRESETS: Array<{ value: number; label: string }> = [
  { value: 128_000, label: '128k' },
  { value: 200_000, label: '200k' },
  { value: 256_000, label: '256k' },
  { value: 512_000, label: '512k' },
  { value: 1_000_000, label: '1M' }
]

/**
 * 最大输出 token 的预置档（点击填入；留空 = 不限制）。
 *
 * ⚠️ 与上下文窗口**同一口径**（k = 1000）：4k = 4,000。以前这里写的是 4096 / 8192
 * 这种 2 的幂，看起来像按 1024 换算，实际只是实现里常用的整数上限 —— 和旁边的
 * 「128k = 128,000」并排就显得两套单位。预置值统一按十进制 k，想看精确上限请直接
 * 手填（如 4096），预置按钮只负责给一个整十的好记数字。
 */
const OUTPUT_PRESETS: Array<{ value: number; label: string }> = [
  { value: 4_000, label: '4k' },
  { value: 8_000, label: '8k' },
  { value: 16_000, label: '16k' },
  { value: 32_000, label: '32k' },
  { value: 64_000, label: '64k' }
]

/** 输入框下方的预置值按钮：点一下填进输入框；当前值命中的那颗高亮 */
function TokenPresetButtons({
  presets,
  value,
  clearLabel,
  onPick
}: {
  presets: ReadonlyArray<{ value: number; label: string }>
  /** 当前值；`null` = 空（走默认 / 不限制） */
  value: number | null
  clearLabel: string
  onPick: (next: number | null) => void
}) {
  const current = value !== null && value > 0 ? Math.floor(value) : null
  /**
   * 选中态只换颜色、**不换边框**：`secondary` 没有 border、`outline` 有，
   * 来回切会让按钮宽高各差 1px（点一下字号像跳了一下）。所以统一用 outline，
   * 选中时只改边框色与底色。
   */
  const chipClass = (active: boolean): string =>
    cn(
      'h-6 px-2 text-[0.6875rem] tabular-nums',
      active ? 'border-primary bg-secondary text-foreground dark:border-primary' : 'text-muted-foreground'
    )
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={chipClass(current === null)}
        onClick={() => onPick(null)}
      >
        {clearLabel}
      </Button>
      {presets.map((preset) => (
        <Button
          key={preset.value}
          type="button"
          size="sm"
          variant="outline"
          className={chipClass(current === preset.value)}
          onClick={() => onPick(preset.value)}
        >
          {preset.label}
        </Button>
      ))}
    </div>
  )
}

/**
 * 模型行尾的短标签：只显示**非默认**的设置，全默认时返回空数组（行上不多一个灰点）。
 * 与「上下文窗口」并排展示，让人不点开弹窗也能看出这个模型被削过哪些能力。
 *
 * ⚠️ 这是**纯函数**，`tr` 必须由调用方传入 —— 它在 `modelList.map()` 里被逐行调用，
 * 若在这里写 `const tr = useT()`，hook 调用次数就跟着模型个数走：加一个模型 = 多一个
 * hook = `React error #300`（Rendered more hooks than during the previous render），
 * 删一个模型对称地报 fewer hooks。列表长度会随增删变化，所以这个函数里**绝不能有 hook**。
 */
function modelSettingBadges(
  tr: (key: string, vars?: Record<string, string | number>) => string,
  settings: AiModelSettings | undefined
): string[] {
  if (!settings) return []
  const out: string[] = []
  if (settings.maxOutputTokens) out.push(tr('输出 {value}', { value: formatContextWindow(settings.maxOutputTokens) }))
  if (settings.toolCall === false) out.push(tr('无工具'))
  if (settings.imageInput === false) out.push(tr('无图'))
  if (settings.reasoning === false) out.push(tr('思考关'))
  if (settings.apiStyle) out.push(settings.apiStyle === 'responses' ? 'Responses' : 'Chat')
  return out
}

export function ModelsTab({ app }: { app: AgentApp }) {
  const tr = useT()
  // ---------- 配置弹窗（只管网关：名称 / 类型 / Base URL / API Key） ----------
  const [adding, setAdding] = useState(false)
  /** 正在编辑的配置 id；null = 新增模式 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AiProviderKind>('openai-compatible')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)

  // ---------- 模型弹窗（新增 / 编辑单个模型：id + 窗口） ----------
  /**
   * 存 `{ configId, modelId? }` 而不是整个 config 对象：列表会被 WS 全量推送覆盖，
   * 存快照会在保存时写回旧数据。渲染时按 id 现取（找不到 = 配置被删了，弹窗自动失效）。
   */
  const [modelEditing, setModelEditing] = useState<{ configId: string; modelId?: string } | null>(null)
  const [modelId, setModelId] = useState('')
  /** 上下文窗口（`null` = 不单独配，走兜底；输入框是草稿态，见 @fizz/ui/number-field） */
  const [modelWindowTokens, setModelWindowTokens] = useState<number | null>(null)
  /** 最大输出 token（`null` = 不单独配，走上游默认） */
  const [modelMaxOutput, setModelMaxOutput] = useState<number | null>(null)
  /** 能力开关草稿：只有显式关掉才落盘（缺省 = 开） */
  const [modelToolCall, setModelToolCall] = useState(true)
  const [modelImageInput, setModelImageInput] = useState(true)
  const [modelReasoning, setModelReasoning] = useState(true)
  /** 接口风格草稿：inherit = 跟随配置（再按 kind 取默认） */
  const [modelApiStyle, setModelApiStyle] = useState<'inherit' | AiApiStyle>('inherit')
  const [modelError, setModelError] = useState('')
  const [modelBusy, setModelBusy] = useState(false)

  /** 待确认的删除目标（null = 没弹窗）：整份配置 / 单个模型 */
  const [pending, setPending] = useState<
    | { kind: 'config'; item: ModelView }
    | { kind: 'model'; item: ModelView; modelId: string }
    | null
  >(null)

  // ---------- 上游拉取弹窗 ----------
  /** 拉取目标配置 id（null = 弹窗关着）；同样只存 id，避免写到过期快照上 */
  const [pickingId, setPickingId] = useState<string | null>(null)
  /** 本次勾选（草稿）：确认后才并进配置，取消就丢掉 */
  const [picked, setPicked] = useState<string[]>([])
  /**
   * 本次被**取消勾选的已有模型**（保存时移出配置）。
   *
   * 与 `picked` 分开记，是为了让「全选 / 清空选择」只作用于新增：一个数组同时表达
   * 「加」和「减」的话，「清空选择」会把整份配置一键清空，误触代价太大。
   */
  const [unpicked, setUnpicked] = useState<string[]>([])
  const [fetched, setFetched] = useState<string[] | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [filter, setFilter] = useState('')
  const fetchVersion = useRef(0)

  const isEditing = editingId != null
  const editingConfig = editingId ? app.models.find((m) => m.id === editingId) : undefined
  const modelConfig = modelEditing ? app.models.find((m) => m.id === modelEditing.configId) : undefined
  const pickingConfig = pickingId ? app.models.find((m) => m.id === pickingId) : undefined

  const resetForm = (): void => {
    setEditingId(null)
    setName('')
    setKind('openai-compatible')
    setBaseURL('')
    setApiKey('')
  }

  const resetUpstream = (): void => {
    // 关闭或切换配置后，忽略上一轮迟到的结果。
    fetchVersion.current += 1
    setFetching(false)
    setFetched(null)
    setFetchError('')
    setFilter('')
    setPicked([])
    setUnpicked([])
  }

  const openAdd = (): void => {
    setAdding(true)
    resetForm()
  }

  /** 打开配置编辑：用这份配置预填（apiKey 留空 = 保留原密钥） */
  const openEdit = (item: ModelView): void => {
    setEditingId(item.id)
    setName(item.name)
    setKind(item.kind)
    setBaseURL(item.baseURL ?? '')
    setApiKey('')
    setAdding(true)
  }

  const closeDialog = (): void => {
    setAdding(false)
    resetForm()
  }

  // ---------- 落库（整份 upsert） ----------

  /**
   * 把一份配置的模型清单整份写回（每个条目自带窗口与进阶设置）。
   *
   * ⚠️ `models` 是**整份替换**：不传 / 传空数组 = 清空清单，所以编辑时必须原样带回。
   * apiKey 不传 = 保留服务端已存的密钥。
   */
  const saveModels = async (config: ModelView, models: AiModelEntry[]): Promise<boolean> =>
    app.saveModel({
      id: config.id,
      name: config.name,
      kind: config.kind,
      models,
      ...(config.baseURL ? { baseURL: config.baseURL } : {})
    })

  // ---------- 配置弹窗提交 ----------

  const saveConfig = async (): Promise<void> => {
    setBusy(true)
    try {
      const ok = await app.saveModel({
        ...(editingId ? { id: editingId } : {}),
        // 名字留空交给服务端兜底（第一个模型 id > 原名字 > 占位名）；
        // 新配置还没有模型，这里落到空串即可（别把 undefined 传过去）
        name: name.trim() || editingConfig?.models?.[0]?.id || '',
        kind,
        // 模型清单不在这个弹窗里管：编辑时原样带回（否则等于把模型全删了），新建时为空
        models: editingConfig?.models ?? [],
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
        // 编辑时若没动 key（留空），server 会保留原密钥；新建时空 key 不传
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      })
      if (ok) closeDialog()
    } finally {
      setBusy(false)
    }
  }

  // ---------- 模型弹窗 ----------

  /** 打开模型弹窗：不传 modelId = 新增 */
  const openModelDialog = (config: ModelView, targetId?: string): void => {
    setModelEditing({ configId: config.id, ...(targetId ? { modelId: targetId } : {}) })
    setModelId(targetId ?? '')
    const entry = findModelEntry(config.models, targetId)
    const tokens = entry?.contextWindow
    setModelWindowTokens(tokens !== undefined && tokens > 0 ? tokens : null)
    // 进阶设置：缺省 = 工具 / 图片 / 思考都开、输出不限、协议跟随配置
    const extra = entry?.settings
    setModelMaxOutput(extra?.maxOutputTokens && extra.maxOutputTokens > 0 ? extra.maxOutputTokens : null)
    setModelToolCall(extra?.toolCall !== false)
    setModelImageInput(extra?.imageInput !== false)
    setModelReasoning(extra?.reasoning !== false)
    setModelApiStyle(extra?.apiStyle ?? 'inherit')
    setModelError('')
  }

  const closeModelDialog = (): void => {
    setModelEditing(null)
    setModelId('')
    setModelWindowTokens(null)
    setModelMaxOutput(null)
    setModelToolCall(true)
    setModelImageInput(true)
    setModelReasoning(true)
    setModelApiStyle('inherit')
    setModelError('')
  }

  /**
   * 「填了但不合法」只剩一种：填了 0 或负数（乱码 / 半截输入进不了 state —— 草稿态输入框
   * 只提交完整的数字）。留空仍然合法 = 走默认 / 不限制。
   */
  const windowInvalid = modelWindowTokens !== null && modelWindowTokens <= 0
  const outputInvalid = modelMaxOutput !== null && modelMaxOutput <= 0

  const saveModelEntry = async (): Promise<void> => {
    const config = modelConfig
    if (!config || !modelEditing) return
    const trimmed = modelId.trim()
    if (!trimmed) {
      setModelError(tr('模型 id 不能为空'))
      return
    }
    const oldId = modelEditing.modelId
    if (oldId && oldId !== trimmed && config.models.some((m) => m.id === trimmed)) {
      setModelError(tr('「{id}」已经在这份配置里了', { id: trimmed }))
      return
    }
    if (windowInvalid) {
      setModelError(tr('上下文窗口要填正整数（token），留空 = 默认'))
      return
    }
    // 输出上限：空 = 不配；填了就必须是正整数（挡掉 0 / NaN / 负数）
    if (outputInvalid) {
      setModelError(tr('最大输出 token 要填正整数（留空 = 不限制）'))
      return
    }
    const outputTokens = modelMaxOutput ?? undefined

    setModelBusy(true)
    try {
      /** 只写**非默认**项（缺省 true 不落盘）；改名时整条一起搬走（窗口 / 设置都在里面） */
      const settings: AiModelSettings = {
        ...(outputTokens !== undefined ? { maxOutputTokens: Math.floor(outputTokens) } : {}),
        ...(modelToolCall ? {} : { toolCall: false }),
        ...(modelImageInput ? {} : { imageInput: false }),
        ...(modelReasoning ? {} : { reasoning: false }),
        ...(modelApiStyle !== 'inherit' ? { apiStyle: modelApiStyle } : {})
      }
      const tokens = modelWindowTokens ?? undefined
      const entry: AiModelEntry = {
        id: trimmed,
        ...(tokens !== undefined ? { contextWindow: Math.floor(tokens) } : {}),
        ...(Object.keys(settings).length ? { settings } : {})
      }
      const models = oldId
        ? config.models.map((m) => (m.id === oldId ? entry : m))
        : [...config.models, entry]
      if (await saveModels(config, models)) closeModelDialog()
    } finally {
      setModelBusy(false)
    }
  }

  // ---------- 上游拉取 ----------

  const fetchUpstream = async (input: UpstreamModelsInput): Promise<void> => {
    const version = ++fetchVersion.current
    setFetching(true)
    setFetchError('')
    try {
      const list = await app.probeUpstreamModels(input)
      if (version !== fetchVersion.current) return
      setFetched(list)
    } catch (err) {
      // 拉不到就如实说（服务端会把上游的状态码与响应片段带回来），别静默成空列表
      if (version !== fetchVersion.current) return
      setFetched(null)
      setFetchError(err instanceof Error ? err.message : String(err))
    } finally {
      if (version === fetchVersion.current) setFetching(false)
    }
  }

  /** 打开候选弹窗：每次打开都重新问一次上游（与 ACP「挑模型」一致，免得看到过期清单） */
  const openPicker = (config: ModelView): void => {
    setPickingId(config.id)
    resetUpstream()
    void fetchUpstream({
      id: config.id,
      kind: config.kind,
      ...(config.baseURL ? { baseURL: config.baseURL } : {})
    })
  }

  const closePicker = (): void => {
    setPickingId(null)
    resetUpstream()
  }

  /**
   * 按本次勾选**同步**这份配置的模型清单：新增的追加、取消勾选的已有模型移出。
   *
   * 保留下来的原有条目**原样带着**（窗口 / 进阶设置都在条目里，重建会丢），
   * 新增的只有 `{ id }`（其余走默认）。
   */
  const confirmPick = async (): Promise<void> => {
    const config = pickingConfig
    if (!config || (!picked.length && !unpicked.length)) return
    const known = new Set(config.models.map((m) => m.id))
    const kept = config.models.filter((m) => !unpicked.includes(m.id))
    const added = picked.filter((id) => !known.has(id)).map((id) => ({ id }))
    const ok = await saveModels(config, [...kept, ...added])
    if (ok) closePicker()
  }

  const keyword = filter.trim().toLowerCase()
  const visible = !fetched
    ? []
    : keyword
      ? fetched.filter((m) => m.toLowerCase().includes(keyword))
      : fetched
  /** 候选里「还没在本配置里」的那些（全选只针对它们） */
  const visibleNew = visible.filter(
    (id) => !(pickingConfig?.models ?? []).some((model) => model.id === id)
  )

  const pendingCount = pending?.item.models?.length ?? 0
  const pendingDesc =
    pending?.kind === 'model'
      ? tr('「{id}」会从「{name}」这份配置里移除；网关地址与 API key 不受影响，之后还能再加回来。', { id: pending.modelId, name: pending.item.name })
      : pending
        ? tr('「{name}」会从列表里移除{models}、网关地址与 API key 也一起丢掉，删掉就得重新填。', { name: pending.item.name, models: pendingCount > 0 ? tr('，它下面的 {count} 个模型 id', { count: pendingCount }) : '' })
        : ''

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {tr('窗口为输入 + 输出的总上限；点 ✎ 修改模型设置。用满')}{' '}
        {Math.round((compactionTriggerTokens(DEFAULT_CONTEXT_WINDOW) / (DEFAULT_CONTEXT_WINDOW)) * 100)}{tr('% 自动摘要旧对话；「默认」=')} {DEFAULT_CONTEXT_WINDOW.toLocaleString()}。
      </p>

      {app.models.map((item) => {
        const modelList = item.models ?? []
        return (
          <div key={item.id} className="rounded-md border border-border/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{item.name}</span>
                  {item.readOnly && (
                    <span
                      className="shrink-0 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground"
                      title={
                        item.sourceName
                          ? tr('由插件「{name}」注册：在插件里修改', { name: item.sourceName })
                          : tr('由插件注册：在插件里修改')
                      }
                    >
                      {tr('插件')}{item.sourceName ? ` · ${item.sourceName}` : ''}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {tr(KIND_LABELS[item.kind] ?? item.kind)}
                  {item.baseURL ? ` · ${item.baseURL}` : ''}
                  {item.hasApiKey ? tr(' · 有 API key') : tr(' · 无 API key')}
                </div>
              </div>
              {!item.readOnly && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="size-7 p-0 text-muted-foreground"
                    aria-label={tr('从远端拉取 {name} 的模型', { name: item.name })}
                    title={tr('从远端拉取模型')}
                    disabled={fetching && pickingId === item.id}
                    onClick={() => openPicker(item)}
                  >
                    <Download className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="size-7 p-0 text-muted-foreground"
                    aria-label={tr('编辑 {name} 的网关设置', { name: item.name })}
                    title={tr('编辑网关设置')}
                    onClick={() => openEdit(item)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="size-7 p-0 text-muted-foreground hover:text-destructive"
                    aria-label={tr('删除模型配置 {name}', { name: item.name })}
                    title={tr('删除模型配置 {name}', { name: item.name })}
                    onClick={() => setPending({ kind: 'config', item })}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
            </div>

            {/* 模型清单：一行一个模型，窗口**只读展示**在 id 后面；要改窗口去 ✎ 打开模型弹窗。
                删到 0 个也允许 —— 空配置只是暂时不能用于对话，不会连这份配置一起被删掉。 */}
            {modelList.length > 0 ? (
              <div className="mt-2 space-y-1">
                {modelList.map((entry) => {
                  const m = entry.id
                  const stored = entry.contextWindow
                  const badges = modelSettingBadges(tr, entry.settings)
                  return (
                    <div
                      key={m}
                      className="flex items-center gap-2 rounded border border-border/40 px-2 py-1"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={m}>
                        {m}
                      </span>
                      {/* 窗口跟在名字后面：没单独配也显示**生效的兜底值**，不写「默认」两个字 */}
                      <span
                        className={cn(
                          'shrink-0 text-xs tabular-nums',
                          stored == null ? 'text-muted-foreground' : 'text-foreground'
                        )}
                        title={
                          stored == null
                            ? tr('未单独配置，按 {value} 兜底', { value: DEFAULT_CONTEXT_WINDOW.toLocaleString() })
                            : tr('上下文窗口 {size} token（用满 {trigger} 会自动摘要旧对话）', { size: stored.toLocaleString(), trigger: Math.round(compactionTriggerTokens(stored)).toLocaleString() })
                        }
                      >
                        {formatContextWindow(stored ?? DEFAULT_CONTEXT_WINDOW)}
                      </span>
                      {/* 非默认的进阶设置：不点开弹窗也能一眼看出被削过什么 */}
                      {badges.length > 0 && (
                        <span
                          className="shrink-0 text-[0.6875rem] text-muted-foreground"
                          title={badges.join(' · ')}
                        >
                          {badges.join(' · ')}
                        </span>
                      )}
                      {!item.readOnly && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="size-6 shrink-0 p-0 text-muted-foreground"
                            aria-label={tr('编辑模型 {id}', { id: m })}
                            title={tr('编辑模型 id / 上下文窗口 / 输出上限 / 能力开关 / 接口风格')}
                            onClick={() => openModelDialog(item, m)}
                          >
                            <Pencil className="size-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="size-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                            aria-label={tr('移除模型 {id}', { id: m })}
                            title={tr('移除模型 {id}', { id: m })}
                            onClick={() => setPending({ kind: 'model', item, modelId: m })}
                          >
                            <X className="size-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              /* 空配置：网关 / key 都还在，只是暂时没有模型 —— 这份配置不该被当成可有可无 */
              <p className="mt-2 text-[0.6875rem] text-muted-foreground">
                {tr('还没有模型：点下面「添加模型」，或右上角从上游拉取（这个配置暂时不能用于对话）。')}
              </p>
            )}

            {!item.readOnly && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1.5 h-6 px-2 text-xs text-muted-foreground"
                onClick={() => openModelDialog(item)}
              >
                <Plus className="size-3" /> {tr('添加模型')}
              </Button>
            )}
          </div>
        )
      })}

      {app.models.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {tr('还没有模型配置。加了模型 Agent 才能说话。')}
        </p>
      )}

      <Button size="sm" variant="outline" className="w-full" onClick={openAdd}>
        <Plus className="size-3.5" /> {tr('添加模型配置')}
      </Button>

      {/* 关掉只收起、不清空：误点遮罩 / Esc 不该把刚填的 key 弄丢（只有保存成功才清） */}
      <Dialog open={adding} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[85dvh] overflow-x-hidden overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEditing ? tr('编辑模型配置') : tr('添加模型配置')}</DialogTitle>
          </DialogHeader>

          {/* ⚠️ `min-w-0` 必需：`DialogContent` 是 `display: grid`，form 就是它的 grid item，
              默认 `min-width: auto` = 内容最小宽度，长内容会把轨道撑得比弹窗还宽 */}
          <form
            className="min-w-0 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void saveConfig()
            }}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder={tr('名称（可选）')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Select value={kind} onValueChange={(v) => setKind(v as AiProviderKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(KIND_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {tr(label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              placeholder={tr('Base URL（OpenAI 兼容网关才需要），如 http://127.0.0.1:7919/v1')}
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
            />
            <Input
              type="password"
              placeholder={isEditing ? tr('API Key（留空保留原密钥）') : tr('API Key（服务端会加密存）')}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="text-[0.6875rem] text-muted-foreground">
              {tr('模型不在这里加：保存后到列表里用「添加模型」或「从上游拉取」。')}
            </p>

            <DialogFooter className="pt-1">
              <Button type="button" size="sm" variant="ghost" onClick={closeDialog}>
                {tr('取消')}
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {tr('保存')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 新增 / 编辑单个模型：id + 窗口 + 输出上限 + 能力开关 + 接口风格 */}
      <Dialog open={modelEditing !== null} onOpenChange={(open) => !open && closeModelDialog()}>
        {/*
          弹窗本身**不滚动**：标题与底部按钮固定，只有中间内容区内部滚动。
          高度用 max-h 封顶（桌面 85dvh），scroll 容器靠 flex-1 + min-h-0 收缩 ——
          直接给 DialogContent 加 overflow-y-auto 会让整张弹窗（含按钮）一起滚，
          在小屏上按钮会被滚到看不见的地方。

          手机（<768px）直接铺到「视口 − 1rem」：85dvh 扣掉上下安全区 / 浏览器工具栏后，
          字段区只剩一小截，输入窗口 / 输出上限时要反复滚动。桌面仍按内容高度收缩。
          「导入会话 / 管理工作区」那两个弹窗没封顶、靠内容自然撑高；这个表单字段多，
          不能完全照抄（会顶出屏幕、按钮够不到），所以移动端钉满视口 + 中间区内部滚动。
        */}
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden max-md:h-[calc(100dvh-1rem)] max-md:max-h-[calc(100dvh-1rem)]">
          <DialogHeader className="shrink-0">
            <DialogTitle>{modelEditing?.modelId ? tr('编辑模型') : tr('添加模型')}</DialogTitle>
          </DialogHeader>

          <form
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void saveModelEntry()
            }}
          >
            {/* 可滚动的内容区：字段多了在这里滚，标题 / 错误 / 按钮都不动 */}
            <div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto pr-1">
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">{tr('模型 id')}</span>
                <Input
                  value={modelId}
                  onChange={(e) => {
                    setModelId(e.target.value)
                    setModelError('')
                  }}
                  placeholder={tr('如 gpt-4o-mini、openrouter/anthropic/claude-3-haiku')}
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">
                  {tr('上下文窗口（输入 + 输出共用的总上限，决定圆环分母与自动压缩阈值）')}
                </span>
                <NumberField
                  // 只标红不夹边界：token 数被悄悄改掉比报错更难发现（保存前还会再拦一次）
                  min={1}
                  clamp={false}
                  step="any"
                  placeholder={tr('留空 = 默认（{value}）', {
                    value: DEFAULT_CONTEXT_WINDOW.toLocaleString()
                  })}
                  value={modelWindowTokens}
                  invalidHint={tr('要填正整数（token），留空 = 默认')}
                  onValueChange={(next) => {
                    setModelWindowTokens(next)
                    setModelError('')
                  }}
                />
                <TokenPresetButtons
                  presets={WINDOW_PRESETS}
                  value={modelWindowTokens}
                  clearLabel={tr('默认')}
                  onPick={(next) => {
                    setModelWindowTokens(next)
                    setModelError('')
                  }}
                />
                {windowInvalid ? (
                  <span className="text-[0.6875rem] text-destructive">
                    {tr('要填正整数（token），留空 = 默认')}
                  </span>
                ) : (
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {tr('「默认」= 输入框留空、走 {value} 兜底。token 是按个计数的单位，k = 1000（不是 1024）：20k = 20,000 token。OpenAI 协议没有单独的输入上限：输入可用空间 = 窗口 − 最大输出。', { value: DEFAULT_CONTEXT_WINDOW.toLocaleString() })}
                  </span>
                )}
              </div>

              {/* 最大输出 token：OpenAI 的 max_output_tokens / max_completion_tokens（含思考 token） */}
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">{tr('最大输出 token（单次回复上限）')}</span>
                <NumberField
                  min={1}
                  clamp={false}
                  step="any"
                  placeholder={tr('留空 = 不限制（如 4000、64000）')}
                  value={modelMaxOutput}
                  invalidHint={tr('要填正整数（留空 = 不限制）')}
                  onValueChange={(next) => {
                    setModelMaxOutput(next)
                    setModelError('')
                  }}
                />
                <TokenPresetButtons
                  presets={OUTPUT_PRESETS}
                  value={modelMaxOutput}
                  clearLabel={tr('不限')}
                  onPick={(next) => {
                    setModelMaxOutput(next)
                    setModelError('')
                  }}
                />
                {outputInvalid ? (
                  <span className="text-[0.6875rem] text-destructive">{tr('要填正整数（留空 = 不限制）')}</span>
                ) : (
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {tr('对应 OpenAI 的 max_output_tokens；开启思考的模型里推理 token 也算在这里。自动摘要按窗口的 {percent}% 预留输出，输出上限特别大时建议把窗口一起调小。', { percent: Math.round(((DEFAULT_CONTEXT_WINDOW) - compactionTriggerTokens(DEFAULT_CONTEXT_WINDOW)) / (DEFAULT_CONTEXT_WINDOW) * 100) })}
                  </span>
                )}
              </div>

              {/* 能力开关：关掉的项在请求侧真正生效（工具不下发 / 图片被过滤 / 思考不透传） */}
              <div className="space-y-2 rounded-md border border-border/60 px-3 py-2">
                <span className="text-xs text-muted-foreground">{tr('能力')}</span>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs">{tr('工具调用')}</div>
                    <p className="text-[0.6875rem] leading-4 text-muted-foreground">
                      {tr('关掉后不向这个模型下发任何工具（含子任务派活），只做纯对话。')}
                    </p>
                  </div>
                  <Switch
                    checked={modelToolCall}
                    onCheckedChange={setModelToolCall}
                    aria-label={tr('工具调用')}
                  />
                </div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs">{tr('图片输入')}</div>
                    <p className="text-[0.6875rem] leading-4 text-muted-foreground">
                      {tr('关掉后发送图片会被拒绝；历史里的图片在发给模型时按一行说明省略，PDF 不受影响。')}
                    </p>
                  </div>
                  <Switch
                    checked={modelImageInput}
                    onCheckedChange={setModelImageInput}
                    aria-label={tr('图片输入')}
                  />
                </div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs">{tr('思考内容')}</div>
                    <p className="text-[0.6875rem] leading-4 text-muted-foreground">
                      {tr('关掉后不显示也不落盘模型的思考过程（不影响它内部推理，只影响透传）。')}
                    </p>
                  </div>
                  <Switch
                    checked={modelReasoning}
                    onCheckedChange={setModelReasoning}
                    aria-label={tr('思考内容')}
                  />
                </div>
              </div>

              {/* 接口风格：只对 openai / openai-compatible 有意义（其它 kind 的 provider 自己定协议） */}
              {(modelConfig?.kind === 'openai' || modelConfig?.kind === 'openai-compatible') && (
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">{tr('接口风格（OpenAI 协议）')}</span>
                  <Select
                    value={modelApiStyle}
                    onValueChange={(v) => setModelApiStyle(v as 'inherit' | AiApiStyle)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">{tr('跟随配置（{style}）', { style: modelConfig.kind === 'openai' ? 'Responses' : 'Chat Completions' })}</SelectItem>
                      <SelectItem value="chat-completions">Chat Completions（/v1/chat/completions）</SelectItem>
                      <SelectItem value="responses">Responses（/v1/responses）</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {tr('网关只实现其中一种时在这里按模型钉死，别让它跟随配置走错接口。')}
                  </span>
                </div>
              )}
            </div>

            {modelError && <p className="shrink-0 text-xs text-destructive">{modelError}</p>}

            <DialogFooter className="shrink-0 pt-1">
              <Button type="button" size="sm" variant="ghost" onClick={closeModelDialog}>
                {tr('取消')}
              </Button>
              <Button type="submit" size="sm" disabled={modelBusy || windowInvalid || outputInvalid}>
                {tr('保存')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/*
        「从上游拉取」的候选清单：**独立弹窗**。
        勾选只改本地草稿 `picked`，「确认添加」才并进配置 —— 取消不留痕迹。

        ⚠️ 滚动只在**列表**里发生，弹窗本身不滚（`overflow-hidden` + flex 列）：
        上游清单动辄几百个模型，让 DialogContent 自己滚的话标题、筛选框、底部按钮会
        跟着一起滚出视口，而且列表的 `max-h` 与弹窗的 `max-h` 会叠成两条滚动条。
        高度上限由 DialogContent 的 `max-h-[85dvh]` 提供，列表 `min-h-0 flex-1` 吃掉
        剩余空间并在内部滚 —— 与「编辑模型」弹窗同一套排法。
      */}
      <Dialog open={pickingId !== null} onOpenChange={(open) => !open && closePicker()}>
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>{tr('从上游拉取模型')}</DialogTitle>
          </DialogHeader>

          {fetching && (
            <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {tr('正在向上游要模型清单…')}
            </div>
          )}
          {/* 拉取失败的原文可能是很长的 URL / JSON 片段：break-all 让它在弹窗内换行 */}
          {fetchError && <p className="shrink-0 text-xs break-all text-destructive">{fetchError}</p>}

          {fetched && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex shrink-0 items-center gap-2">
                <Input
                  placeholder={tr('筛选模型…')}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="h-8 text-xs"
                />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {keyword ? `${visible.length}/${fetched.length}` : tr('{count} 个', { count: fetched.length })}
                </span>
              </div>

              {/* 唯一允许滚动的容器：`min-h-0` 让它能缩到比内容更小，滚动条才会落在列表上 */}
              <div className="min-h-0 flex-1 space-y-0.5 overflow-x-hidden overflow-y-auto pr-1">
                {visible.map((id) => {
                  const already = (pickingConfig?.models ?? []).some((model) => model.id === id)
                  // 已有项默认勾上，取消勾选只是记进 `unpicked`（保存时才真的移出）
                  const checked = already ? !unpicked.includes(id) : picked.includes(id)
                  const removing = already && !checked
                  return (
                    <div
                      key={id}
                      className={cn(
                        'flex items-center gap-2 rounded px-1.5 py-1 text-sm transition-colors',
                        checked ? 'bg-secondary/60' : 'hover:bg-secondary'
                      )}
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        title={already ? tr('{id}（已在列表中，取消勾选 = 保存后移出）', { id }) : id}
                        onClick={() =>
                          already
                            ? setUnpicked((prev) =>
                                prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
                              )
                            : setPicked((prev) =>
                                prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
                              )
                        }
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span
                          className={cn(
                            'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                            checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                          )}
                        >
                          {checked && <Check className="size-2.5" />}
                        </span>
                        <span
                          className={cn(
                            'min-w-0 truncate font-mono',
                            checked ? 'text-foreground' : 'text-muted-foreground',
                            removing && 'line-through'
                          )}
                        >
                          {id}
                        </span>
                        {already && (
                          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                            {removing ? tr('保存后移出') : tr('已在列表')}
                          </span>
                        )}
                      </button>
                      {!already && picked.includes(id) && (
                        <button
                          type="button"
                          aria-label={tr('取消选择 {id}', { id })}
                          title={tr('取消选择')}
                          onClick={() => setPicked((prev) => prev.filter((m) => m !== id))}
                          className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  )
                })}
                {visible.length === 0 && (
                  <div className="px-1.5 py-2 text-xs text-muted-foreground">
                    {fetched.length === 0 ? tr('上游没有返回任何模型。') : tr('没有匹配「{keyword}」的模型。', { keyword: filter.trim() })}
                  </div>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    // 全选 = 看得见的全勾上（刚被取消的已有项一并恢复，但不动筛选外那些）
                    setUnpicked((prev) => prev.filter((id) => !visible.includes(id)))
                    setPicked((prev) => [...new Set([...prev, ...visibleNew])])
                  }}
                >
                  {keyword ? tr('全选筛选结果') : tr('全选')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={!picked.length}
                  onClick={() => setPicked([])}
                >
                  {tr('清空选择')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={fetching}
                  onClick={() =>
                    pickingConfig &&
                    void fetchUpstream({
                      id: pickingConfig.id,
                      kind: pickingConfig.kind,
                      ...(pickingConfig.baseURL ? { baseURL: pickingConfig.baseURL } : {})
                    })
                  }
                >
                  {tr('重新拉取')}
                </Button>
              </div>
            </div>
          )}

          <DialogFooter className="shrink-0 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={closePicker}>
              {tr('取消')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={(!picked.length && !unpicked.length) || busy}
              onClick={() => {
                setBusy(true)
                void confirmPick().finally(() => setBusy(false))
              }}
            >
              {/* 有移除时不再是「添加」，写清 ±x 让用户按下去之前就知道会改动什么 */}
              {unpicked.length
                ? `${tr('保存')}（+${picked.length} / −${unpicked.length}）`
                : `${tr('确认添加')}${picked.length ? `（${picked.length}）` : ''}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除 / 移除的二次确认：整份配置与单个模型共用一个弹窗，标题与文案按 kind 分 */}
      <ConfirmDeleteDialog
        open={pending !== null}
        title={pending?.kind === 'model' ? tr('移除模型？') : tr('删除模型配置？')}
        confirmLabel={pending?.kind === 'model' ? tr('移除') : tr('删除')}
        description={pendingDesc}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const target = pending
          setPending(null)
          if (!target) return
          if (target.kind === 'config') {
            void app.deleteModel(target.item.id)
            return
          }
          // 允许删到 0 个：只摘掉这一个模型（窗口 / 进阶设置随条目一起消失），不碰网关与 key
          const rest = (target.item.models ?? []).filter((m) => m.id !== target.modelId)
          void saveModels(target.item, rest)
        }}
      />
    </div>
  )
}
