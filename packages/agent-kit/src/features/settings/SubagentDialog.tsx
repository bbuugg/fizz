/**
 * 自定义子智能体的新建 / 编辑弹窗（设置 → AI → 通用 → 子任务）。
 *
 * 字段与 `SubagentDefinition` 一一对应：名称、用途（派活工具的描述）、指令、工具白名单、
 * 步数上限、专用模型。**工具只能选只读的那几个** —— 子 run 恒为 readonly 且没有审批通道，
 * 给它 `write` / `bash` 只会换来一句「当前是只读模式」。
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Textarea } from '@fizz/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { toolLabel } from '@fizz/agent-kit/shared/lib/parts'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import {
  SUBAGENT_DESCRIPTION_MAX,
  SUBAGENT_INSTRUCTIONS_MAX,
  SUBAGENT_MAX_STEPS,
  SUBAGENT_MIN_STEPS,
  SUBAGENT_NAME_MAX,
  SUBAGENT_TOOL_KEYS,
  type SubagentDefinition
} from '@fizz/contracts/types'

/** 弹窗里正在编辑的一份草稿（保存时再折算成 `SubagentDefinition`） */
export interface SubagentDraft {
  id?: string
  name: string
  description: string
  instructions: string
  tools: string[]
  /** 空串 = 用默认值（80） */
  maxSteps: string
  /** `'inherit'` 或 `configId::modelId` */
  model: string
}

export function emptySubagentDraft(): SubagentDraft {
  return {
    id: undefined,
    name: '',
    description: '',
    instructions: '',
    tools: ['read', 'glob', 'grep'],
    maxSteps: '',
    model: 'inherit'
  }
}

/** 已存在的定义 → 草稿 */
export function draftOf(def: SubagentDefinition): SubagentDraft {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    instructions: def.instructions ?? '',
    tools: [...def.tools],
    maxSteps: def.maxSteps !== undefined ? String(def.maxSteps) : '',
    model:
      def.modelConfigId && def.modelId ? `${def.modelConfigId}::${def.modelId}` : 'inherit'
  }
}

/** 生成一个新的自定义 id（服务端还会校验格式与唯一性） */
export function newSubagentId(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto?.getRandomValues?.(bytes)
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `custom-${hex}`
}

/** 草稿校验失败的三种情况（错误码而不是中文串：文案要在渲染层过 i18n） */
export type SubagentFormError = 'name' | 'description' | 'steps'

/** 草稿 → 定义；`error` 是错误码，由弹窗翻译成当前语言 */
export function definitionOf(draft: SubagentDraft): {
  definition?: SubagentDefinition
  error?: SubagentFormError
} {
  const name = draft.name.trim()
  if (!name) return { error: 'name' }
  const description = draft.description.trim()
  if (!description) return { error: 'description' }
  const rawSteps = draft.maxSteps.trim()
  let maxSteps: number | undefined
  if (rawSteps) {
    const n = Number(rawSteps)
    if (!Number.isInteger(n) || n < SUBAGENT_MIN_STEPS || n > SUBAGENT_MAX_STEPS) {
      return { error: 'steps' }
    }
    maxSteps = n
  }
  const [configId, modelId] =
    draft.model === 'inherit' ? [undefined, undefined] : draft.model.split('::')
  return {
    definition: {
      id: draft.id ?? newSubagentId(),
      name,
      description,
      ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
      tools: draft.tools.length > 0 ? [...draft.tools] : ['read', 'glob', 'grep'],
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(configId && modelId ? { modelConfigId: configId, modelId } : {})
    }
  }
}

export function SubagentDialog({
  open,
  initial,
  modelChoices,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  initial: SubagentDraft
  /** 可选的模型（`configId::modelId` → 展示名） */
  modelChoices: Array<{ value: string; label: string }>
  onOpenChange: (open: boolean) => void
  /** 返回错误文案 = 保存失败，弹窗不关 */
  onSubmit: (draft: SubagentDraft) => Promise<string | null>
}) {
  const tr = useT()
  const [draft, setDraft] = useState<SubagentDraft>(initial)
  const [error, setError] = useState<SubagentFormError | 'save' | null>(null)
  const [saving, setSaving] = useState(false)
  /** 保存失败时服务端给的原因（直接展示，不再翻译） */
  const [saveError, setSaveError] = useState<string | null>(null)

  /**
   * 每次**打开**都回到传入的初值（新建 / 编辑共用一个实例）。
   *
   * ⚠️ 依赖只放 `open`：`initial` 是调用方每次渲染新建的对象，放进依赖里会在
   * 每次按键重渲染时把草稿重置回初值 —— 表现为「输入框敲不进字」。
   */
  const initialRef = useRef(initial)
  initialRef.current = initial
  useEffect(() => {
    if (!open) return
    setDraft(initialRef.current)
    setError(null)
    setSaveError(null)
  }, [open])

  const patch = (next: Partial<SubagentDraft>): void => setDraft((prev) => ({ ...prev, ...next }))
  const toggleTool = (key: string): void =>
    setDraft((prev) => ({
      ...prev,
      tools: prev.tools.includes(key)
        ? prev.tools.filter((t) => t !== key)
        : [...prev.tools, key]
    }))

  const save = async (): Promise<void> => {
    const built = definitionOf(draft)
    if (!built.definition) {
      setError(built.error ?? 'name')
      return
    }
    setSaving(true)
    const failure = await onSubmit({ ...draft, id: built.definition.id })
    setSaving(false)
    if (failure) {
      setSaveError(failure)
      setError('save')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {draft.id ? tr('编辑子智能体') : tr('新建子智能体')}
          </DialogTitle>
          <DialogDescription>
            {tr('子智能体在只读模式下运行：它拿到的是任务原文，看不到主对话历史。')}
          </DialogDescription>
        </DialogHeader>

        <form
          className="min-w-0 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="space-y-1.5">
            <div className="text-xs font-medium">{tr('名称')}</div>
            <Input
              value={draft.name}
              maxLength={SUBAGENT_NAME_MAX}
              placeholder={tr('例如：文档核对')}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium">{tr('用途')}</div>
            <Textarea
              value={draft.description}
              maxLength={SUBAGENT_DESCRIPTION_MAX}
              rows={3}
              placeholder={tr('写清「什么活派给它」。这段就是派活工具的描述，模型靠它决定何时调用。')}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium">{tr('指令（可选）')}</div>
            <Textarea
              value={draft.instructions}
              maxLength={SUBAGENT_INSTRUCTIONS_MAX}
              rows={3}
              placeholder={tr('给这个子智能体的额外要求：关注什么、输出什么格式。只读、不许提问这些硬约束仍然生效。')}
              onChange={(e) => patch({ instructions: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium">{tr('可用工具（只读）')}</div>
            <div className="flex flex-wrap gap-1.5">
              {SUBAGENT_TOOL_KEYS.map((key) => {
                const checked = draft.tools.includes(key)
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => toggleTool(key)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs transition-colors',
                      checked
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-foreground/5'
                    )}
                  >
                    {toolLabel(key)}
                  </button>
                )
              })}
            </div>
            <p className="text-[0.6875rem] leading-4 text-muted-foreground">
              {tr('子智能体不能改文件、不能执行命令，所以这里只给只读工具。')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <div className="text-xs font-medium">{tr('步数上限')}</div>
              <Input
                value={draft.maxSteps}
                inputMode="numeric"
                placeholder={tr('默认 80')}
                onChange={(e) => patch({ maxSteps: e.target.value.replace(/[^\d]/g, '') })}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium">{tr('模型')}</div>
              <Select value={draft.model} onValueChange={(value) => patch({ model: value })}>
                <SelectTrigger className="h-9 w-full text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">{tr('沿用子任务模型')}</SelectItem>
                  {modelChoices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {error ? (
            <p className="text-xs text-destructive">
              {error === 'name'
                ? tr('请填写名称')
                : error === 'description'
                  ? tr('请填写用途（模型据此决定要不要派活给它）')
                  : error === 'steps'
                    ? tr('步数需为 {min}–{max} 的整数', {
                        min: SUBAGENT_MIN_STEPS,
                        max: SUBAGENT_MAX_STEPS
                      })
                    : (saveError ?? tr('填写有误'))}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {tr('取消')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? tr('保存中…') : tr('保存')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
