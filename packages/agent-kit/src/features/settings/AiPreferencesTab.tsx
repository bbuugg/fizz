/**
 * AI 通用设置（导航上：设置 → AI → 通用）：从「通用」组里抽出来的、**只作用于 AI 的那几条**
 * —— 工具权限 + 工具调用并发 + 工具步数上限 + 工具意图 + 子任务（subagent）+
 * 命令审批超时 + 模型请求重试。
 *
 * 为什么单开一页而不是留在通用里：通用里真正「跟 AI 无关」的只剩通知 / 常亮 / 监控 / 更新
 * 那几项，而守在通用里找「它能改什么、能跑多快」的正好是 AI 组里的这些配置。现在
 * 设置 → AI → 通用 就是「这套 AI 怎么干活」的唯一入口。
 *
 * ⚠️ 导航上叫「通用」不叫「偏好」：这一页装的是 AI 的**默认行为**（权限档 / 并发 / 步数 /
 * 意图 / 子任务），不是个人口味，叫「偏好」会让人以为里面是主题、字号。**tab id 仍是
 * `ai-prefs`**，别跟着改（`SettingsContent` / `types.ts` 都按它分发）。
 *
 * ⚠️ 这里只搬了 UI：所有偏好仍然读写同一份 store（`useAgentStore` / `app.*`），
 * 落盘字段、`DATA_VERSION` 迁移、服务端上送路径一律没动 —— 搬家不改数据。
 *
 * 留在「通用」组里的：结束通知 / 屏幕常亮 / 语音输入静音超时 / 系统监控 / 远程访问 / 软件更新
 * （它们是宿主环境与提醒的事，不是 AI 的行为）。
 */
import { toast } from 'sonner'
import { Check, ShieldCheck } from 'lucide-react'
import { NumberField } from '@fizz/ui/number-field'
import { Switch } from '@fizz/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { permissionOption, permissionOptions } from '@fizz/agent-kit/shared/lib/permission'
import {
  SUBAGENT_IDS,
  SUBAGENT_MAX_STEPS,
  SUBAGENT_META,
  SUBAGENT_MIN_STEPS,
  type SubagentId
} from '@fizz/contracts/types'
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_TOOL_CALL_CONCURRENCY,
  MAX_MAX_STEPS,
  MIN_MAX_STEPS
} from '@fizz/contracts'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { Segmented } from '@fizz/agent-kit/shared/components/Segmented'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function AiPreferencesTab({ app }: { app: AgentApp }) {
  const tr = useT()
  const current = permissionOption(app.permissionMode)

  /**
   * 子任务模型选项：把所有模型配置下的模型摊平成一份清单。
   * 值用 `configId::modelId`（configId 是 UUID，不会含 `::`）。
   */
  const subagentModelChoices = (app.models ?? []).flatMap((config) =>
    (config.models ?? []).map((model) => ({
      value: `${config.id}::${model.id}`,
      label: `${config.name} · ${model.id}`
    }))
  )
  const savedSubagentModel =
    app.subagentSettings?.modelConfigId && app.subagentSettings.modelId
      ? `${app.subagentSettings.modelConfigId}::${app.subagentSettings.modelId}`
      : 'inherit'
  const subagentModelValue =
    savedSubagentModel === 'inherit' ||
    subagentModelChoices.some((choice) => choice.value === savedSubagentModel)
      ? savedSubagentModel
      : 'inherit'
  const savedSubagentModelUnavailable =
    savedSubagentModel !== 'inherit' && subagentModelValue === 'inherit'

  const saveSubagentModel = async (value: string): Promise<void> => {
    let next: { configId: string; modelId: string } | null = null
    if (value !== 'inherit') {
      const separator = value.indexOf('::')
      if (separator > 0) {
        next = {
          configId: value.slice(0, separator),
          modelId: value.slice(separator + 2)
        }
      }
    }
    const ok = await app.setSubagentModel(next)
    if (!ok) {
      toast.error(tr('保存失败：{error}', { error: useAgentStore.getState().error ?? tr('未知原因') }))
      return
    }
    toast.success(next ? tr('已保存子任务模型') : tr('子任务已改为沿用父会话模型'))
  }

  /**
   * 提交一个子任务的步数上限（空 = 回到默认值）。
   *
   * 越界**不静默夹到边界**：夹了之后界面上看不出「我填的 200 变成了 64」，
   * 用户只会觉得「设了没用，它还是中途停」。所以直接拒绝并说清范围。
   * 输入框那边配的是 `clamp={false}` —— 组件不替这里做决定。
   */
  const saveSubagentMaxSteps = async (
    id: SubagentId,
    name: string,
    steps: number | null
  ): Promise<void> => {
    if (
      steps !== null &&
      (!Number.isInteger(steps) || steps < SUBAGENT_MIN_STEPS || steps > SUBAGENT_MAX_STEPS)
    ) {
      toast.error(
        tr('步数需为 {min}–{max} 的整数', { min: SUBAGENT_MIN_STEPS, max: SUBAGENT_MAX_STEPS })
      )
      return
    }
    const ok = await app.setSubagentMaxSteps(id, steps)
    if (!ok) {
      toast.error(tr('保存失败：{error}', { error: useAgentStore.getState().error ?? tr('未知原因') }))
      return
    }
    toast.success(
      steps === null
        ? tr('「{name}」已恢复默认步数', { name })
        : tr('「{name}」步数上限已设为 {n}', { name, n: steps })
    )
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <ShieldCheck className="size-3.5" />
          {tr('工具权限')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('控制 Agent 能修改或执行哪些操作；查看与搜索始终允许。下一轮对话生效。')}
        </p>
        <Segmented
          ariaLabel={tr('工具权限')}
          value={app.permissionMode}
          onChange={app.setPermissionMode}
          options={permissionOptions()}
        />
        {current && <p className="text-xs leading-4 text-muted-foreground">{current.hint}</p>}
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">{tr('工具调用并发')}</div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('同一批工具调用最多并行几个；多出的排队。1 = 串行，默认')}{' '}
          {DEFAULT_TOOL_CALL_CONCURRENCY}{tr('，上限 10。')}
        </p>
        <div className="flex items-center gap-2">
          {/* 草稿态输入：删空不会回填，失焦才夹到 1–10（见 @fizz/ui/number-field） */}
          <NumberField
            value={app.toolCallConcurrency}
            min={1}
            max={10}
            onValueChange={(next) => app.setToolCallConcurrency(next ?? DEFAULT_TOOL_CALL_CONCURRENCY)}
            invalidHint={tr('需为 1–10 的整数，离开输入框会夹到最近的边界')}
            aria-label={tr('工具调用并发')}
            className="w-28 font-mono"
          />
          <span className="text-xs text-muted-foreground">{tr('个')}</span>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">{tr('工具调用最大步数')}</div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('一轮对话里最多连续调用工具多少次（1 步 = 一次模型请求 + 一轮工具执行）。达到上限后即使还有没跑完的工具调用也会停下这一轮。默认')}{' '}
          {DEFAULT_MAX_STEPS}{tr('，上限')} {MAX_MAX_STEPS}
          {tr('；调大能跑更长的任务，代价是每步都要重发全量上下文，成本随步数累加。')}
        </p>
        <div className="flex items-center gap-2">
          <NumberField
            value={app.maxSteps}
            min={MIN_MAX_STEPS}
            max={MAX_MAX_STEPS}
            onValueChange={(next) => app.setMaxSteps(next ?? DEFAULT_MAX_STEPS)}
            invalidHint={tr('需为 {min}–{max} 的整数，离开输入框会夹到最近的边界', {
              min: MIN_MAX_STEPS,
              max: MAX_MAX_STEPS
            })}
            aria-label={tr('工具调用最大步数')}
            className="w-28 font-mono"
          />
          <span className="text-xs text-muted-foreground">{tr('步')}</span>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">{tr('工具意图')}</div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr(
            '让模型为每次工具调用写一句「这一步要干什么」，显示成工具卡的标题（「修复类型错误」而不是「编辑文件」）。' +
              '关掉后工具卡立刻回到工具名，模型也不再被要求填这句（下一轮生效）。'
          )}
        </p>
        <div className="flex items-center gap-2">
          <Switch
            id="tool-intent-enabled"
            checked={app.toolIntent}
            onCheckedChange={app.setToolIntent}
          />
          <label htmlFor="tool-intent-enabled" className="text-xs text-muted-foreground">
            {app.toolIntent ? tr('已开启') : tr('已关闭（工具卡只显示工具名）')}
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">{tr('子任务（subagent）')}</div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('把只读、产出长的任务交给子 Agent，减少主对话上下文占用。子任务')}<b>{tr('不能修改文件或执行命令')}</b>{tr('。')}
          {tr('每项可以单独设步数上限（搜索 / 读文件各算一步），留空用默认值。')}
        </p>
        <div className="space-y-2">
          {SUBAGENT_IDS.map((id) => {
            const enabled = (app.subagentSettings?.enabled ?? []).includes(id)
            /** 用户设过的步数；`null` = 没设，输入框留空并显示默认值占位 */
            const savedSteps = app.subagentSettings?.maxSteps?.[id] ?? null
            const meta = SUBAGENT_META[id]
            return (
              <div
                key={id}
                className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2"
              >
                <button
                  type="button"
                  aria-label={enabled ? tr('停用子任务 {name}', { name: meta.name }) : tr('启用子任务 {name}', { name: meta.name })}
                  aria-pressed={enabled}
                  onClick={async () => {
                    const ok = await app.toggleSubagent(id, !enabled)
                    // ⚠️ 必须自己看结果：`withRefresh` 失败只往 store 写 error，而
                    // `app.error` **只有登录页会渲染**（ConnectGate）。不在这里
                    // 兜一次的话，保存失败的表现就是「点了没反应」。
                    if (!ok) {
                      toast.error(tr('保存失败：{error}', { error: useAgentStore.getState().error ?? tr('未知原因') }))
                    } else if (enabled) {
                      toast.success(tr('已停用「{name}」子任务', { name: meta.name }))
                    } else {
                      // 开启也要吭一声：开了不等于这一轮就会派活，别让用户盯着
                      // 一个没变化的界面猜「到底开没开」
                      toast.success(tr('已启用「{name}」子任务', { name: meta.name }), {
                        description: tr('是否派活由主 Agent 自己判断，简单的活它通常自己干')
                      })
                    }
                  }}
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
                    enabled
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-transparent'
                  )}
                >
                  <Check className="size-3" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{meta.name}</span>
                    <code className="text-[0.625rem] text-muted-foreground">agent-{id}</code>
                  </div>
                  <div className="text-xs leading-4 text-muted-foreground">{tr(meta.hint)}</div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="text-[0.625rem] text-muted-foreground">{tr('步数上限')}</span>
                    {/* 留空 = 用默认值；只在失焦时提交，越界交给 saveSubagentMaxSteps 拒绝 */}
                    <NumberField
                      value={savedSteps}
                      min={SUBAGENT_MIN_STEPS}
                      max={SUBAGENT_MAX_STEPS}
                      clamp={false}
                      commitWhileTyping={false}
                      placeholder={tr('默认 {n}', { n: meta.defaultMaxSteps })}
                      aria-label={tr('「{name}」步数上限', { name: meta.name })}
                      invalidHint={tr('步数需为 {min}–{max} 的整数', {
                        min: SUBAGENT_MIN_STEPS,
                        max: SUBAGENT_MAX_STEPS
                      })}
                      onValueChange={(next) => void saveSubagentMaxSteps(id, meta.name, next)}
                      className="h-7 w-20 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium">{tr('子任务模型')}</div>
          <Select value={subagentModelValue} onValueChange={(value) => void saveSubagentModel(value)}>
            <SelectTrigger className="h-9 w-full text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{tr('沿用父会话模型')}</SelectItem>
              {subagentModelChoices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-4 text-muted-foreground">
            {tr('子任务通常只读文件并汇总，选快 / 便宜的模型即可；模型不可用时自动退回父会话模型。')}
            {savedSubagentModelUnavailable ? tr(' 原模型已不可用。') : ''}
          </p>
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('默认关闭；是否派活由主 Agent 判断。')}
        </p>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">{tr('命令审批超时')}</div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('等待审批的最长时间，超时按拒绝处理。0 = 一直等待。')}
        </p>
        <div className="flex items-center gap-2">
          <NumberField
            value={app.confirmTimeoutMin}
            min={0}
            onValueChange={(next) => app.setConfirmTimeoutMin(next ?? 0)}
            invalidHint={tr('需为不小于 0 的整数（0 = 一直等待）')}
            aria-label={tr('命令审批超时')}
            className="w-28 font-mono"
          />
          <span className="text-xs text-muted-foreground">
            {tr('分钟')}{app.confirmTimeoutMin === 0 ? tr('（不超时）') : ''}
          </span>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">{tr('模型请求重试')}</div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('请求失败后的自动重试次数。已跑完工具步骤的轮次会从断点继续，不会重跑已完成的工具。0 = 不限，默认 2。')}
        </p>
        <div className="flex items-center gap-2">
          <NumberField
            value={app.maxRetries}
            min={0}
            onValueChange={(next) => app.setMaxRetries(next ?? 0)}
            invalidHint={tr('需为不小于 0 的整数（0 = 不限）')}
            aria-label={tr('模型请求重试')}
            className="w-28 font-mono"
          />
          <span className="text-xs text-muted-foreground">
            {tr('次')}{app.maxRetries === 0 ? tr('（不限制）') : ''}
          </span>
        </div>
      </section>
    </div>
  )
}
