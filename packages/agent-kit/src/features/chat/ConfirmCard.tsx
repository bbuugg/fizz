/**
 * 命令执行审批卡（confirm 模式）。
 *
 * 服务端在要执行破坏性操作（`execute_command` / `delete_file`）或 ACP agent 发来
 * 权限请求（`session/request_permission`）时**停住等答复**，流里推一帧 `confirm`；
 * 这里渲染成一张卡，用户点选后 POST 回去，流才继续。
 *
 * 两种形态：
 * - 带 `options`（ACP）：agent 给什么选项就渲染什么（name + kind），点哪个就把哪个
 *   optionId 原样回传 —— **不做任何映射**；
 * - 不带（内置工具）：通用的「允许 / 拒绝」两颗按钮。
 *
 * 放在输入框上方（而不是塞进对应的工具卡里）：工具卡默认是折叠的，
 * 审批被折叠起来就等于没提示 —— 这个动作必须显眼。
 *
 * 宽度与间距都不自己定：宽度由外壳（`ChatComposer` 的对齐壳，与输入框卡片、消息列
 * 同一档）给，间距由外壳的 `space-y-2` 给 —— 所以这里不能带 `mb-*`，否则两处叠加成 16px。
 * 容器工作台的 `PermissionCard` 同此，两者因此能逐像素对齐。
 *
 * ⚠️ **模型一批 tool-call 会一次性推来一叠 `confirm`**（AI SDK 用 `Promise.all` 并行
 * 下发，每个破坏性工具各挂起一次）。一条一张卡地摞在输入框上方，会把输入框直接顶出
 * 屏幕（用户报过「输入框被挤压到看不见」）。所以多张时必须走 `ConfirmQueue`：**一屏只看
 * 一项**（可左右翻），高度恒定，输入框永远在视线里；内置工具再给「全部允许 / 全部拒绝」
 * 批量答复。
 */
import { useState } from 'react'
import { Ban, Check, ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { toolLabel } from '@fizz/agent-kit/shared/lib/parts'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentConfirmOption } from '@fizz/contracts/types'
import type { AgentConfirmRequest } from '@fizz/contracts/agent-api'

/** 选项按钮的观感：允许类主色、拒绝类描边警示（名字仍是 agent 给的原文） */
function optionButtonClass(kind: AgentConfirmOption['kind']): string {
  return kind.startsWith('reject')
    ? 'border-destructive/40 text-destructive! hover:bg-destructive/10! hover:border-destructive/50'
    : ''
}

function optionIcon(kind: AgentConfirmOption['kind']) {
  return kind.startsWith('reject') ? (
    <Ban className="size-3.5" />
  ) : (
    <Check className="size-3.5" />
  )
}

/** 审批项的一句话头：「需要你确认：<意图>（<工具名>）（工作区「x」）」 */
function ConfirmHeadline({ confirm }: { confirm: AgentConfirmRequest }) {
  const tr = useT()
  const label = toolLabel(confirm.toolName)
  return (
    <div className="text-sm font-medium">
      {confirm.agentName && (
        <span className="mr-1 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
          {confirm.agentName}
        </span>
      )}
      {/* 意图在前：用户点「允许」之前最想知道的是**为什么要跑这条命令**，
          工具名退到括号里（没有意图时与改造前完全一致） */}
      {tr('需要你确认：{tool}', { tool: confirm.intent || label })}
      {confirm.intent && (
        <span className="font-normal text-muted-foreground">{tr('（{tool}）', { tool: label })}</span>
      )}
      {confirm.workspaceName && (
        <span className="font-normal text-muted-foreground">
          {tr('（工作区「{name}」）', { name: confirm.workspaceName })}
        </span>
      )}
    </div>
  )
}

/** 审批项的命令块（等宽、可滚动，长命令不撑破卡片） */
function ConfirmCommand({ command }: { command: string }) {
  // 空正文不渲染：`<pre>` 没内容也占一行 padding，卡片上会多出一条空条。
  // 正文是 ACP 的 `ToolCall.title`（服务端按增量回查补齐），agent 连 title 都没给时
  // 才会是空串 —— 那种情况下抬头已经把工具名说清楚了。
  if (!command.trim()) return null
  return (
    <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 px-2 py-1.5 font-mono text-xs">
      {command}
    </pre>
  )
}

/** ACP：agent 给的选项原样列出（顺序也不动），点了哪个回哪个 optionId */
function OptionButtons({
  options,
  onPick
}: {
  options: AgentConfirmOption[]
  onPick: (approved: boolean, optionId: string) => void
}) {
  const tr = useT()
  return (
    <>
      {options.map((option) => (
        <Button
          key={option.optionId}
          size="sm"
          variant={option.kind.startsWith('reject') ? 'outline' : 'default'}
          className={optionButtonClass(option.kind)}
          title={tr('性质：{kind}', { kind: option.kind })}
          onClick={() => onPick(!option.kind.startsWith('reject'), option.optionId)}
        >
          {optionIcon(option.kind)}
          {option.name}
        </Button>
      ))}
    </>
  )
}

export function ConfirmCard({
  confirm,
  onResolve
}: {
  confirm: AgentConfirmRequest
  onResolve: (id: string, approved: boolean, optionId?: string) => void
}) {
  const tr = useT()
  const options = confirm.options ?? []
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <ConfirmHeadline confirm={confirm} />
          <ConfirmCommand command={confirm.command} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {options.length > 0 ? (
              <OptionButtons
                options={options}
                onPick={(approved, optionId) => onResolve(confirm.id, approved, optionId)}
              />
            ) : (
              <>
                <Button size="sm" onClick={() => onResolve(confirm.id, true)}>
                  {tr('允许执行')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => onResolve(confirm.id, false)}>
                  {tr('拒绝')}
                </Button>
              </>
            )}
            <span className="text-xs text-muted-foreground">
              {tr('不答复会一直等（超时后按拒绝处理，时长可在设置的「通用」里调整或关闭）')}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 一叠审批：一屏只渲染当前这一项，左右可翻，内置工具再给批量答复。
 *
 * 只有 1 项时退化成普通的 `ConfirmCard`（与改动前逐像素一致，不引入导航）。
 * 高度恒定为「一张卡」，所以无论模型一次推来几项，输入框都不会被顶出屏幕。
 */
export function ConfirmQueue({
  confirms,
  onResolve
}: {
  confirms: AgentConfirmRequest[]
  onResolve: (id: string, approved: boolean, optionId?: string) => void
}) {
  const tr = useT()
  const [index, setIndex] = useState(0)
  if (confirms.length === 0) return null
  if (confirms.length === 1) return <ConfirmCard confirm={confirms[0]} onResolve={onResolve} />

  // 答复会把这批里的项从列表移除，长度会缩：越界的 index 就地夹回最后一页
  const safeIndex = Math.min(index, confirms.length - 1)
  const current = confirms[safeIndex]
  const options = current.options ?? []
  // 只有全是内置「允许 / 拒绝」时才给批量答复 —— ACP 的选项语义各不相同，不能替它选
  const allPlain = confirms.every((c) => !c.options || c.options.length === 0)

  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">
              {tr('需要你确认 {count} 项操作', { count: confirms.length })}
              <span className="font-normal text-muted-foreground">
                {tr('（第 {index} / {total} 项）', { index: safeIndex + 1, total: confirms.length })}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={safeIndex === 0}
                aria-label={tr('上一项')}
                onClick={() => setIndex(Math.max(0, safeIndex - 1))}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={safeIndex >= confirms.length - 1}
                aria-label={tr('下一项')}
                onClick={() => setIndex(Math.min(confirms.length - 1, safeIndex + 1))}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <ConfirmHeadline confirm={current} />
          <ConfirmCommand command={current.command} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {options.length > 0 ? (
              <OptionButtons
                options={options}
                onPick={(approved, optionId) => onResolve(current.id, approved, optionId)}
              />
            ) : (
              <>
                <Button size="sm" onClick={() => onResolve(current.id, true)}>
                  {tr('允许执行')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => onResolve(current.id, false)}>
                  {tr('拒绝')}
                </Button>
              </>
            )}
            {allPlain && (
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => confirms.forEach((c) => onResolve(c.id, true))}>
                  {tr('全部允许')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => confirms.forEach((c) => onResolve(c.id, false))}>
                  {tr('全部拒绝')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
