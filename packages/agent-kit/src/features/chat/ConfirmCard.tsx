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
 * - 不带（内置工具）：通用的「允许 / 拒绝」两行。
 *
 * ## 外观
 *
 * 骨架与提问卡（`FollowupForm`）同参 —— 两张卡都顶替输入框，用户在同一个位置做
 * 「回答」这个动作：
 *
 * ```
 * [🛡] 跑一下测试                  [执行命令] [agent 名] 第 1 / 3 项   ← 首行（意图 + 右端标签）
 * ┌─────────────────────────────────┐
 * │ npm run test                    │                ← 命令原文（浅灰底、等宽、可滚）
 * └─────────────────────────────────┘
 * 允许执行                                            ← 选项行（纯文字 + 悬停箭头）
 * 拒绝                            [‹] [›] [全部允许]   ← 底部（导航 + 批量，仅多项时）
 * ```
 *
 * **没有单独的标题行**：改造前首行是一句固定的「需要你确认」，跟下面「是这件什么事」
 * 说的是同一件事，白占一行高度。现在盾牌图标（`amber`）单独表示「这是要你答复的卡」，
 * 文字只留工具名和模型写的意图。
 *
 * 与提问卡**刻意不同的一处**：选项前面**不放序号**。提问卡的序号是模型给的题号
 * （「第 2 题」是用户要回答的对象），而这里的选项就是动作本身（「允许 / 拒绝」），
 * 编号会让它读起来像一道选择题。
 *
 * 选项是「整宽一行 + 悬停底色」而不是按钮：一列 `variant=default` 的按钮会把卡片变成
 * 彩色块矩阵，而这张卡最该显眼的是命令原文。悬停才浮出的 `→` 是「点这行」的暗示；
 * 点了立即答复，所以没有选中态 —— 允许 / 拒绝只差文字颜色（`text-foreground` /
 * `text-destructive`），不换底（底色是「选中」的语义）。
 *
 * 选项**只有 agent 给的 `name` 一行**，不加我们自己的副标题（原来的「本次会话内不再
 * 询问」已去掉）：那句是我们替 agent 解释它的选项，而 `name` 本身就是它挑的说法；对
 * `reject_always` 那种选项，补的这句甚至是不成立的。要读的信息在题干和命令原文里。
 *
 * ## 命令原文
 *
 * 只给一块浅灰底（`bg-muted`）+ 等宽 `pre`，`max-h-40` 内滚动。**不加标题条、不加
 * 复制按钮** —— 用户要看的是「到底跑什么」，一块可读的原文就够；卡片上元素越少，
 * 「允许 / 拒绝」越显眼。空正文整块不渲染（`<pre>` 空着也占一行 padding）。
 *
 * 工作区名不显示：卡片就出现在那个会话的输入框位置，用户不会搞错自己在哪个工作区。
 *
 * ## 为什么一批要一屏一项（`ConfirmQueue`）
 *
 * 模型一批 tool-call 会一次性推来一叠 `confirm`（AI SDK 用 `Promise.all` 并行下发，
 * 每个破坏性工具各挂起一次）。一条一张卡地摞起来会把这块区域撑到看不见消息。所以多张时
 * 走 `ConfirmQueue`：**一屏只看一项**（可左右翻），高度与单张卡一致；内置工具再给
 * 「全部允许 / 全部拒绝」批量答复。
 */
import { useState, type ReactNode } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { toolLabel } from '@fizz/agent-kit/shared/lib/parts'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { AgentConfirmOption } from '@fizz/contracts/types'
import type { AgentConfirmRequest } from '@fizz/contracts/agent-api'

/**
 * 一个选项：**整宽一行**，只有 agent 给的那句文案，鼠标指向才浮出一层夜色和一个 `→`。
 *
 * 没有序号章 —— 这里的选项就是动作，不是题号（见文件头）。
 *
 * **没有副标题**：agent 的 `name` 已经是它自己挑的说法，再补一句我们写的解释（原来的
 * 「本次会话内不再询问」）等于替 agent 解释它的选项，而选项语义本来就该由 `name` 说清；
 * 补的那句对 `reject_always` 甚至不成立（拒绝永远不是「不再询问」）。
 *
 * `px-2.5` 与命令块（`ConfirmCommand` 的 `px-2.5`）同宽：两块的**盒子**左边缘都在
 * `px-3` 上，盒内的**文字**也都在 22px，上下扫下来是一条线。行内边距比命令块小的话，
 * 选项文字会比命令文字左出一截，看起来就是「没对齐」。
 *
 * `items-start`：`name` 有时是 agent 的英文长句会折行，箭头要贴首行而不是居中到两行之间。
 */
function ChoiceRow({
  label,
  destructive = false,
  onClick
}: {
  label: string
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full shrink-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-foreground/5',
        destructive ? 'text-destructive' : 'text-foreground'
      )}
    >
      <span className="min-w-0 flex-1 break-words">{label}</span>
      {/* `mt-0.5`：16px 的图标对齐 `text-sm` 首行（20px）的中线；`aria-hidden` —— 它是
          装饰，读屏有 label 就够 */}
      <ArrowRight
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  )
}

/**
 * 命令原文：一块浅灰底 + 等宽字，`max-h-40` 内滚动。
 *
 * 空正文整块不渲染。ACP 那边 `command` 是 `ToolCall.title`（agent 连 title 都没给时
 * 才是空串），内置工具则是命令原文。
 */
function ConfirmCommand({ command }: { command: string }) {
  if (!command.trim()) return null
  return (
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed">
      {command}
    </pre>
  )
}

/**
 * 题干：盾牌图标 + 意图（+ 命令原文），工具名小标 / agent 名小标 / 批量计数贴右端。
 *
 * **首行就是整张卡的标题**：改造前这里上面还压着一行固定的「需要你确认」，两行说的是
 * 同一件事（「有件事要你答」+「是这件」），白白占掉一行高度。现在合成一行 —— 盾牌图标
 * 单独承担「这是审批卡」这个身份（`amber` 也只在审批卡上用），文字只留真正有信息量的
 * 那部分：工具名 + 模型写的意图。
 *
 * 小标与提问卡的 `header` 同款（`rounded bg-primary/10 px-1.5 py-0.5 text-xs
 * font-medium text-primary`）：一张卡上「这个字段是什么」靠这一层标出来，比在正文里塞
 * 括号（改造前的「需要你确认：X（工具名）（工作区「y」）」）好读得多 —— 那串东西在窄屏
 * 会折成三行，标点和括号的嵌套关系每次都要重新数。
 */
function ConfirmBody({
  confirm,
  count,
  index
}: {
  confirm: AgentConfirmRequest
  /** 这一叠里一共几项（单张恒为 1）；>1 时才显示右端的计数 */
  count: number
  /** 当前是第几项（从 1 起）；单张不传 */
  index?: number
}) {
  const tr = useT()
  const label = toolLabel(confirm.toolName)
  return (
    <div className="flex flex-col gap-1.5 px-3">
      <div className="flex items-start gap-1.5">
        {/* `mt-0.5`：16px 图标对齐 `text-sm` 首行（20px）的中线 */}
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        {/* 意图在最前：用户点「允许」之前最想知道的是**为什么要跑这条命令**，所以这句
            紧贴图标，先读到；`font-medium` 比命令原文（等宽 `text-xs`）重一档 —— 这一行
            取代了原来的标题，视觉上得是标题。
            换行不截断（`break-words`）—— 这是真正要读的那句话。
            模型没给意图时回落到「是否允许执行这次操作？」：图标只说明了「这是一张要答复
            的卡」，不说明「什么事」，这一行是唯一交代动作性质的地方，空着会只剩一堆标签。
            标签（工具名 / agent 名）退到右端：它们是**出处**，不是要读的内容 —— 尤其
            ACP 的工具名是 `acp/bash` 这类机器名，摆在句首会把真正的句子顶到第二行去。 */}
        <span className="min-w-0 grow break-words text-sm font-medium text-foreground">
          {confirm.intent || tr('是否允许执行这次操作？')}
        </span>
        {/* 右端一组：标签 + 计数。`items-start` 让标签顶边贴句子首行（小标高 20px，
            与 `text-sm` 的行高同高，直接顶对齐就是中心对齐） */}
        <span className="ml-auto flex shrink-0 items-start gap-1.5">
          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
            {label}
          </span>
          {confirm.agentName && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {confirm.agentName}
            </span>
          )}
          {index !== undefined && (
            <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
              {tr('第 {index} / {total} 项', { index, total: count })}
            </span>
          )}
        </span>
      </div>
      <ConfirmCommand command={confirm.command} />
    </div>
  )
}

/**
 * 审批卡的外壳：与提问卡同一套（圆角 + 描边 + `bg-card/70` + 高度上限）。
 *
 * 卡片自己不带左右内边距：题干、命令块、选项区各自 `px-3`，全部对齐同一条线。
 */
function ConfirmShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex max-h-[min(70vh,36rem)] w-full flex-col rounded-xl border border-border bg-card/70 py-2.5">
      {children}
    </div>
  )
}

/** ACP：agent 给的选项原样列出（顺序也不动），整宽一行一个，点了回哪个 optionId */
function OptionRows({
  options,
  onPick
}: {
  options: AgentConfirmOption[]
  onPick: (approved: boolean, optionId: string) => void
}) {
  return (
    <>
      {options.map((option) => (
        <ChoiceRow
          key={option.optionId}
          label={option.name}
          destructive={option.kind.startsWith('reject')}
          onClick={() => onPick(!option.kind.startsWith('reject'), option.optionId)}
        />
      ))}
    </>
  )
}

/** 内置工具的两行：允许 / 拒绝 */
function PlainRows({ onPick }: { onPick: (approved: boolean) => void }) {
  const tr = useT()
  return (
    <>
      <ChoiceRow label={tr('允许执行')} onClick={() => onPick(true)} />
      <ChoiceRow label={tr('拒绝')} destructive onClick={() => onPick(false)} />
    </>
  )
}

/**
 * 选项区：整体可滚（高度上限被撑满时只有这里滚，标题与底部按钮不动）。
 *
 * `grow` 而不是 `flex-1`：`grow` 只改 `flex-grow`、`flex-basis` 仍是 `auto`，容器高度
 * 为 auto 时按内容尺寸计算；`flex-1` 的 `0%` 基准在嵌套 flex 里容易把这一层压成 0 高
 * （同 `FollowupForm` 的取舍）。
 */
function ConfirmChoices({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 flex min-h-0 grow flex-col overflow-y-auto overscroll-contain px-3">
      {children}
    </div>
  )
}

export function ConfirmCard({
  confirm,
  onResolve
}: {
  confirm: AgentConfirmRequest
  onResolve: (id: string, approved: boolean, optionId?: string) => void
}) {
  const options = confirm.options ?? []
  return (
    <ConfirmShell>
      <ConfirmBody confirm={confirm} count={1} />
      <ConfirmChoices>
        {options.length > 0 ? (
          <OptionRows
            options={options}
            onPick={(approved, optionId) => onResolve(confirm.id, approved, optionId)}
          />
        ) : (
          <PlainRows onPick={(approved) => onResolve(confirm.id, approved)} />
        )}
      </ConfirmChoices>
    </ConfirmShell>
  )
}

/**
 * 一叠审批：一屏只渲染当前这一项，左右可翻，内置工具再给批量答复。
 *
 * 只有 1 项时退化成普通的 `ConfirmCard`（与单张完全一致，不引入导航）。
 * 高度恒定为「一张卡」，所以无论模型一次推来几项，这块区域都不会被撑高。
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
    <ConfirmShell>
      <ConfirmBody confirm={current} count={confirms.length} index={safeIndex + 1} />
      <ConfirmChoices>
        {options.length > 0 ? (
          <OptionRows
            options={options}
            onPick={(approved, optionId) => onResolve(current.id, approved, optionId)}
          />
        ) : (
          <PlainRows onPick={(approved) => onResolve(current.id, approved)} />
        )}
      </ConfirmChoices>
      {/* 底部：左边翻页、右边批量答复 —— 与提问卡的「‹ ▸ 提交 / 跳过」同一位置关系 */}
      <div className="mt-2 flex shrink-0 items-center gap-2 px-3">
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={safeIndex === 0}
            aria-label={tr('上一项')}
            title={tr('上一项')}
            onClick={() => setIndex(Math.max(0, safeIndex - 1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={safeIndex >= confirms.length - 1}
            aria-label={tr('下一项')}
            title={tr('下一项')}
            onClick={() => setIndex(Math.min(confirms.length - 1, safeIndex + 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        {/* 批量答复刻意是两枚 ghost：一屏一项的意义是让用户逐项看清，「全部允许」不该
            做成 primary 去引导手快点过去（顺序保持「允许 → 拒绝」，不改肌肉记忆） */}
        {allPlain && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-[0.8125rem]"
              onClick={() => confirms.forEach((c) => onResolve(c.id, true))}
            >
              {tr('全部允许')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-[0.8125rem]"
              onClick={() => confirms.forEach((c) => onResolve(c.id, false))}
            >
              {tr('全部拒绝')}
            </Button>
          </div>
        )}
      </div>
    </ConfirmShell>
  )
}
