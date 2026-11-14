/**
 * 渲染一条消息里的一个 part（正文 / 思考 / 工具调用）。
 *
 * 用的是 ai-elements 的原生组件：
 * - 正文 `MessageResponse`（走 streamdown，流式 markdown）
 * - 思考 `Reasoning`（默认收起，头部报「正在思考…」，可随时展开）
 * - 工具调用 `Tool`（默认收起，头部显示「中文工具名 + 主入参明细（截断，悬停看全文）+ 状态徽章」）
 *
 * 分组是**列表侧统一收口**的：一条助手消息里的思考 / 工具调用都由 `message-parts.tsx`
 * 收进 `TurnStepGroup`（抬头左格说「最后做的那件事」——工具的 `intent` / 工具名 / 「思考中…」，
 * 右格说这一步的内容；**整轮结束**才换成「已工作 N 秒」）。
 * 组内每张卡仍是**收起的、可点开的**（流式中、一轮结束后都一样）—— 组只管「这一段过程
 * 整体要不要露出来」，细看哪一步由用户自己点，不做嵌套自动展开。
 *
 * 我们的事件模型是服务端自定义的 `AgentMessagePart`，这里负责把它翻译成
 * ai-elements 期望的形状（`ToolUIPart['type']` / `['state']`）。
 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, Circle, CircleQuestionMark, FileText, ImageOff, ListTree, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
import { ImageViewer } from '@fizz/ui/image-viewer'
import { useOpenSubagent } from '@fizz/agent-kit/features/chat/subagent-view'
import type { ToolUIPart } from 'ai'
import { useStickToBottom } from 'use-stick-to-bottom'
import { saveImageLocally } from '@fizz/agent-kit/shared/lib/image-download'
import { AskFollowupCard } from '@fizz/agent-kit/shared/ai-elements/followup-card'
import { useConversationOptional } from '@fizz/agent-kit/shared/ai-elements/conversation'
import { MessageResponse } from '@fizz/agent-kit/shared/ai-elements/message'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  reasoningPreview,
} from '@fizz/agent-kit/shared/ai-elements/reasoning'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@fizz/agent-kit/shared/ai-elements/tool'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'
import { FileDiffView, type DiffHunk } from '@fizz/agent-kit/features/git/FileDiffView'
import {
  ASK_FOLLOWUP_TOOL,
  canonicalToolName,
  isCommandRunning,
  isStoppableToolName,
  isStoppableToolRunning,
  isErrorText,
  partialJsonString,
  toolCardHead,
  type ToolCallPart,
  toolErrorText,
  toolLabel,
  toolOutputText,
  toolState
} from '@fizz/agent-kit/shared/lib/parts'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { diffLines } from '@fizz/agent-kit/shared/lib/diff'
import {
  isTerminalTool,
  terminalOutputForDisplay
} from '@fizz/agent-kit/shared/lib/terminal/display'
import { collapsedBody, shouldRefreshSnapshot } from '@fizz/agent-kit/shared/lib/collapse-swap'
import { loadMediaObjectUrl } from '@fizz/agent-kit/shared/lib/media-url'
import type { AgentMessagePart, SubagentDelegation, TodoItem } from '@fizz/contracts/types'
import type { AskFollowupAnswer } from '@fizz/contracts/types'

/**
 * 思考段：**默认收起、随时可展开**（流式中也一样，一轮结束后同样可开合）。
 *
 * 不能只靠 ai-elements 自带的 `defaultOpen`：那个只在**挂载时**取一次初值
 * （`useControllableState` 的 defaultProp），而且它内置的「播完 1 秒自动收」是
 * `hasAutoClosed` 只跑一次 —— 用户手动点开一个已结束的思考还会被它再收回去。
 *
 * 所以自己控 `open`：`defaultOpen={false}` 把组件内部那套自动开合让开。初值一律收起，
 * **不跟 `streaming` 联动**：思考过程已经收进外层分组（见 `message-parts.tsx` 的
 * `TurnStepGroup`），组内每张卡都默认折叠；一到流式就自己弹开，会把分组撑成一大片、
 * 也违背「过程默认折叠」的口径。
 *
 * **折叠 + 仍在思考时**，触发行上会跟着一行实时预览（思考正文的最后一行）：不然思考条只剩
 * 「正在思考…」四个字，长时间思考时完全看不出它在写什么。
 */
function ReasoningView({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  // 消息区的滚动上下文（可能不在 Conversation 里，拿不到就退化成空操作）
  const conversation = useConversationOptional()

  // 折叠 + 流式 → 触发行上多跟一行实时预览（最新一行）；展开 / 不流式时不传。
  // `lineKey` 一起传：预览靠它判「换行」，好把这一行整体上滚一格（见 reasoningPreview）。
  const preview = !open && streaming && text.trim() ? reasoningPreview(text) : undefined

  return (
    <Reasoning
      className="w-full"
      isStreaming={streaming}
      open={open}
      defaultOpen={false}
      // 用户手动开合：暂停自动贴底，让内容向下长（否则一展开就被拽到底、点的那条往上跳）。
      onOpenChange={(next) => {
        conversation?.holdScroll()
        setOpen(next)
      }}
    >
      <ReasoningTrigger
        previewText={preview?.line}
        previewLineKey={preview?.lineKey}
      />
      <ReasoningContent>{text}</ReasoningContent>
    </Reasoning>
  )
}

/**
 * 工具卡：**所有工具调用的统一折叠外壳**（内置 / ACP、有无直显内容都走它）。
 *
 * 默认**收起、只由用户点开**（流式中也一样，运行中也能展开看实时输出）：
 * 它已经在消息列表的过程分组里（抬头就是它的 `intent` + 命令 / 路径），
 * 组内每张卡再自动摊开，就等于把过程直接铺在明面上，与「统一折叠成一个组」相悖。
 *
 * 展开后的内容形态由调用方决定：没有直显内容时给「输入 / 输出 JSON」，
 * 有直显内容（diff / 命令 / 文本）时直接铺那块内容 —— 头部与折叠行为完全一致。
 *
 * ⚠️ 不能用 `defaultOpen={hasOutput}` 那套写法：Radix 的 `Collapsible` 只在**挂载时**
 * 取一次 `defaultOpen` 初值（`useControllableState` 的 defaultProp），之后 props 变了也不理。
 * 而一轮结束时 `loadMessages()` 会拿服务端落盘的权威消息覆盖本地流式那份 —— 助手消息 id 从
 * `a-local-…` 变成服务端 id，`ChatPanel` 里 `PartView` 的 key（`${message.id}-${partIndex}`）
 * 跟着变，整棵子树**重新挂载**，`defaultOpen` 被重新取值 → 表现就是
 * 「一跑完所有工具卡自己全展开」。同理，工具在流式过程中完成也不会自动弹开。
 *
 * 所以自己控 `open`：`defaultOpen={false}` 是为了把 Radix 内部那套初值逻辑彻底让开
 * （与 ReasoningView 同一写法）；初值一律收起，之后只由用户开合 —— 一轮结束后同样可开合。
 */
function ToolCallCard({
  title,
  type,
  state,
  detail,
  status,
  onStop,
  live = true,
  children
}: {
  title: string
  type: ToolUIPart['type']
  state: ToolUIPart['state']
  /** 头部明细（命令 / 主入参）：截断显示在工具名后面，悬停出 Tooltip 看全文 */
  detail?: string
  /** 工具名右侧的运行态（子任务「运行中 · 正在读文件 · 已调用 N 个工具」） */
  status?: ReactNode
  /** 工具在飞（pending / 执行中）时给的停止回调，透传给头部那颗停止钮 */
  onStop?: () => void
  /**
   * 这一条是不是**本轮直播里还在跑**：决定运行态图标转不转（见 ToolHeader 的 `live`）。
   *
   * 历史里因异常中断残留的未结算 part 也停在运行态，那里必须给静态图标 ——
   * 一直转圈等于在说「它还在跑」，而那一轮早就结束了。
   */
  live?: boolean
  children: ReactNode
}) {
  // 消息区的滚动上下文（可能不在 Conversation 里，拿不到就退化成空操作）
  const conversation = useConversationOptional()
  const [open, setOpen] = useState(false)

  /**
   * 「先折叠、再换内容」：收起动画（ToolContent 的 animate-out，150ms）期间继续渲染
   * **上次开着时**的内容，动画结束 / 下次展开才是最新的。
   *
   * 快照只在 open 为真时刷新（shouldRefreshSnapshot）—— 关着时也刷，折叠那一瞬间渲染
   * 的就是新内容，正是用户报的「内容先变、才开始折叠」。关着时内容被 Radix 卸掉了
   * （CollapsibleContent 没有 forceMount），快照旧一点看不见；用户再点开走的是
   * 「开着」那条，拿到的又是最新的。规则与说明见 lib/collapse-swap.ts。
   */
  const openSnapshotRef = useRef(children)
  useEffect(() => {
    if (shouldRefreshSnapshot(open)) openSnapshotRef.current = children
  }, [open, children])
  const body = collapsedBody(open, children, openSnapshotRef.current)

  return (
    <Tool
      open={open}
      // 用户手动展开 / 收起：暂停自动贴底。展开时内容会长高（ToolContent 带 animate-in），
      // 不暂停的话贴底逻辑会把视图拽到底部、用户点的那张卡被顶上去（看起来像「点展开、
      // 页面往上滚」）。暂停后视口纹丝不动，内容在原地下方长出来。
      onOpenChange={(next) => {
        conversation?.holdScroll()
        setOpen(next)
      }}
      defaultOpen={false}
    >
      <ToolHeader
        title={title}
        type={type}
        state={state}
        detail={detail}
        status={status}
        onStop={onStop}
        live={live}
      />
      <ToolContent>{body}</ToolContent>
    </Tool>
  )
}

/**
 * 从工具入参构造「代码修改前后对比」。
 *
 * 故意只依赖入参、不依赖工具返回值：返回值会被原样送回模型，把整文件塞进去会灌爆上下文；
 * 而入参（edit_file 的 oldText/newText、write_file 的 content）本来就持久化在 part 里，
 * 刷新后照常能渲染。delete_file 入参没有内容，只能提示删了哪个文件。
 */
function buildFileDiff(part: AgentMessagePart): {
  path: string
  hunks: DiffHunk[]
  deleted?: boolean
} | null {
  const p = part as { toolName?: string; input?: unknown }
  const input = p.input as
    | {
        path?: string
        file_path?: string
        content?: string
        old_string?: string
        new_string?: string
        edits?: Array<{ oldText?: string; newText?: string }>
        command?: string
        file_text?: string | null
        old_str?: string | null
        new_str?: string | null
      }
    | undefined
  if (!input) return null
  const name = canonicalToolName(p.toolName ?? '')
  const path = input.file_path ?? input.path ?? ''

  // str_replace_editor：create / str_replace 能直接出 diff，insert 只有新内容、走通用卡
  if (name === 'str_replace_editor') {
    if (input.command === 'create') {
      return {
        path,
        hunks: [{ header: t('@@ 新建 / 覆盖 @@'), lines: diffLines('', input.file_text ?? '') }]
      }
    }
    if (input.command === 'str_replace') {
      return {
        path,
        hunks: [
          {
            header: t('@@ 编辑 {index} @@', { index: 1 }),
            lines: diffLines(input.old_str ?? '', input.new_str ?? '')
          }
        ]
      }
    }
    return null
  }
  if (name === 'edit' && !Array.isArray(input.edits)) {
    // 新 schema：一次一处字面量替换（old_string → new_string）
    return {
      path,
      hunks: [
        {
          header: t('@@ 编辑 {index} @@', { index: 1 }),
          lines: diffLines(input.old_string ?? '', input.new_string ?? '')
        }
      ]
    }
  }
  if (p.toolName === 'edit_file' && Array.isArray(input.edits)) {
    return {
      path: input.path ?? '',
      hunks: input.edits.map((e, i) => ({
        header: t('@@ 编辑 {index} @@', { index: i + 1 }),
        lines: diffLines(e.oldText ?? '', e.newText ?? '')
      }))
    }
  }
  if (name === 'write' && typeof input.content === 'string') {
    return {
      path,
      hunks: [{ header: t('@@ 新建 / 覆盖 @@'), lines: diffLines('', input.content) }]
    }
  }
  if (p.toolName === 'delete_file') {
    return { path: input.path ?? '', hunks: [], deleted: true }
  }
  return null
}

function DelegationRunning({ toolName, toolCount }: { toolName?: string; toolCount?: number }) {
  const tr = useT()
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  // 一行内联（挂在工具名右侧，见 `ToolHeader` 的 `status`）：不再自成一行，
  // 所以这里不能 `flex-wrap` —— 窄屏靠外层 truncate 收口。
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span className="shrink-0">{tr('子任务运行中… {seconds}s', { seconds })}</span>
      {toolName ? (
        <span className="min-w-0 truncate">{tr('· 正在 {tool}', { tool: toolLabel(toolName) })}</span>
      ) : null}
      {toolCount ? <span className="shrink-0">{tr('· 已调用 {count} 个工具', { count: toolCount })}</span> : null}
    </span>
  )
}

/**
 * 派活的 prompt（`agent-<id>` 的入参结构就是 `{ prompt }`）—— 放到头部明细位，
 * 紧跟工具名截断显示，悬停看全文（ToolHeader 的 detail 本来就是干这个的）。
 *
 * 故意只认 `prompt` 一个字段：派活的入参以后可能加字段（`skills` 之类），
 * 逐个摊开会把明细位变成第二张说明书。
 */
function delegationPromptOf(input: unknown): string | undefined {
  const prompt = (input as { prompt?: unknown } | null | undefined)?.prompt
  if (typeof prompt !== 'string') return undefined
  const text = prompt.trim()
  return text || undefined
}

/**
 * 入参**流式生成期**的预览：从半截 JSON 里抠出「主入参」（明细）+「正在写的内容」。
 *
 * 与 `buildFileDiff` 的分工：那个吃完整 `input`、生成前后对比；这个吃 `inputText`、
 * 只给一坨正在变长的文本。两者不会同时命中（有 `inputText` 就说明还没收口）。
 * 返回 null = 抠不出可看的东西，调用方按普通卡渲染（不展开空壳）。
 */
function renderStreamingPreview(part: AgentMessagePart): { detail?: string; text?: string } | null {
  const raw = (part as { inputText?: unknown }).inputText
  if (typeof raw !== 'string' || !raw.trim()) return null
  const path =
    partialJsonString(raw, 'path') ||
    partialJsonString(raw, 'file_path') ||
    partialJsonString(raw, 'filePath')
  const command = partialJsonString(raw, 'command') || partialJsonString(raw, 'cmd')
  const content = partialJsonString(raw, 'content') || partialJsonString(raw, 'newText')
  // 命令类：明细在触发行右侧单行截断显示（见 ToolHeaderProps.detail），这里再往内容区
  // 铺一份完整命令 —— 头部那截会被省略号切掉，展开后要能看到原文。
  if (command) return { detail: `$ ${command}`, text: `$ ${command}` }
  if (path || content) {
    return {
      ...(path ? { detail: path } : {}),
      ...(content ? { text: content } : {})
    }
  }
  return null
}

/**
 * 正在生成的入参文本：等宽 + 限高滚动，随增量一帧帧变长。
 *
 * `mono=false`（子任务输出）走 markdown 渲染：子 agent 写的是给人看的结论，等宽 pre 会把
 * `**加粗**` / `- 列表` 原样吐出来，反而更难读。
 *
 * 贴底用 `use-stick-to-bottom`（与 ReasoningContent / 消息区同一套）：内容长过 `max-h-64`
 * 之后自动跟到底部；用户中途上滚即停止跟随、滚回底部自动恢复 —— 写大文件时不会一边
 * 滚一边把用户正在看的位置拽走。
 *
 * `label` 由调用方给：入参是「疯狂输出中...」（等宽 JSON），子 agent 的文本是
 * 「子任务输出中...」且要正常比例字体 —— 自然语言用等宽 + break-all 很难读。
 */
function StreamingInputBlock({ text, label, mono = true }: {
  text: string
  label?: string
  mono?: boolean
}) {
  const tr = useT()
  const { scrollRef, contentRef } = useStickToBottom({ initial: 'instant' })
  return (
    <div className="flex flex-col gap-1 border border-border rounded-lg mt-2 p-2">
      <span className="text-xs text-muted-foreground">{label ?? tr('疯狂输出中...')}</span>
      <div
        ref={scrollRef}
        className="max-h-64 overflow-y-auto rounded-md bg-muted/50"
        // overflow-anchor: none —— 关掉 Chromium 滚动锚定（它会在文本重排时「帮忙」修位置，
        // 造成偶发跳顶）；滚动位置由 use-stick-to-bottom 显式管理。
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={contentRef}>
          {mono ? (
            <pre className="whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-xs">{text}</pre>
          ) : (
            // 子任务的输出是给人看的结论：markdown（列表 / 代码块 / 加粗）比等宽 pre 好读。
            // 仍坐在下面那个 max-h-64 的滚动容器里，长输出不会把消息流撑爆。
            <MessageResponse className="px-2 py-1.5 tracking-[0.02em]">{text}</MessageResponse>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * execute_command 运行中的**实时输出区**（stdout / stderr 合并纯文本）。
 *
 * - stderr 行首的 `[stderr] ` 前缀已在 parts 层加好（见 `appendStreamChunk`）——
 *   这里只负责展示，不再解析一次；
 * - 贴底用 `useStickToBottom`（与 StreamingInputBlock / 消息区同一套）：内容长过
 *   `max-h-64` 后自动贴底，用户上滚即停跟，不会把正在看的位置拽走；
 * - **停止钮不在这里**：已上移到卡片头部（`ToolHeader` 的 `onStop`）——
 *   放在输出面板里时，`input-streaming`（Pending）阶段压根没有这块内容、
 *   用户找不到停止，执行中的命令也得先看这块板子。命令结束（tool-result 到达）
 *   后本区块被结果直显替换。
 *
 * ⚠️ **没有输出也要照常渲染这一块**：`live` 可能是全空（命令刚起步、或压根不吐东西），
 * 用占位文案填空，头部那句状态随之换 —— 「实时输出中…」/「命令运行中，暂无输出」。
 */
function LiveOutputBlock({ live }: { live: { stdout: string; stderr: string } }) {
  const tr = useT()
  const { scrollRef, contentRef } = useStickToBottom({ initial: 'instant' })
  // 两条流合并展示：stderr 接在 stdout 后（行首前缀已在数据里，视觉上能区分）
  const text = live.stderr
    ? live.stdout + (live.stdout && !live.stdout.endsWith('\n') ? '\n' : '') + live.stderr
    : live.stdout
  return (
    <div className="flex flex-col gap-1 border border-border rounded-lg mt-2 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {text ? tr('实时输出中...') : tr('命令运行中，暂无输出')}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="max-h-64 overflow-y-auto rounded-md bg-muted/50"
        // overflow-anchor: none —— 关掉 Chromium 滚动锚定；滚动位置由 use-stick-to-bottom 管
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={contentRef}>
          <pre className="whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-xs">
            {text || tr('（这个命令还没有产生任何 stdout / stderr。它可能正在跑，也可能一直沉默。）')}
          </pre>
        </div>
      </div>
    </div>
  )
}

/**
 * 从 `todo_write` 的入参 / 结果里抠出清单条目。
 *
 * 优先用**结果**（收口后的规范形态），结果还没到时退回到**入参**（模型刚提交的那份）——
 * 两者形状相同（都是 `{ todos: [{content, status}] }`），只是一个来自模型、一个来自工具返回。
 * 形状不对一律当空清单，不抛错（坏数据不该把整条消息渲染炸掉）。
 */
function todoItemsOf(input: unknown, output: unknown): TodoItem[] {
  const fromOutput = (output as { todos?: unknown } | null | undefined)?.todos
  const fromInput = (input as { todos?: unknown } | null | undefined)?.todos
  const src = Array.isArray(fromOutput) ? fromOutput : fromInput
  if (!Array.isArray(src)) return []
  return src
    .map((t) => {
      const item = t as { content?: unknown; status?: unknown }
      const content = typeof item?.content === 'string' ? item.content.trim() : ''
      const status: TodoItem['status'] =
        item?.status === 'in_progress' || item?.status === 'completed' ? item.status : 'pending'
      return { content, status }
    })
    .filter((t) => t.content)
}

/**
 * 待办清单（`todo_write` 的结果视图）：一行一项，勾选 / 进行中 / 待办三种图标。
 *
 * 与命令卡同样的直显外壳（`border + 圆角`），不铺「输入 / 输出 JSON」——
 * 清单本来就是给人看的进度，JSON 化等于白建。
 */
function TodoChecklist({ items }: { items: TodoItem[] }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border mt-2 p-2">
      <ul className="flex flex-col gap-1.5">
        {items.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            {t.status === 'completed' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : t.status === 'in_progress' ? (
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" />
            )}
            <span
              className={cn(
                'min-w-0',
                t.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'
              )}
            >
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 文本块直显。
 *
 * 两条分支都**不折行**：`whitespace-pre` 保留原有换行，超宽的行靠**横向滚动**看
 * （而不是 `break-all` 把一行拆成十几行、把消息流撑长）。纵向给 `max-h`，超出内部滚动。
 *
 * `singleLine`（脚本 / 命令的**结果**用）：同一条结果的纵向空间压到 12rem，全文仍挂在
 * `title` 上悬停可看。不带 `singleLine`（ACP 内容块等）：纵向上限 8rem。
 */
function AcpTextBlock({ text, singleLine }: { text: string; singleLine?: boolean }) {
  if (singleLine) {
    return (
      <div
        // 工具输出（脚本 / 命令结果）：不是 <pre>，靠 data-selectable 进 styles.css 的内容白名单
        data-selectable
        className="overflow-x-auto overflow-y-auto whitespace-pre rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs max-h-48"
        title={text}
      >
        {text}
      </div>
    )
  }
  return (
    <pre className="max-h-32 overflow-auto whitespace-pre rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs">
      {text}
    </pre>
  )
}

/**
 * 直显内容 + 明细。
 *
 * `content`：展开后的内容区（diff / 输出文本等）；
 * `detail`：命令 / 主入参，排在**触发行右侧**（单行截断，见 `ToolHeaderProps.detail`），
 * 同时也是标题 Tooltip / 触屏弹窗里的全文。命令类工具另有一份完整回声在 `content` 第一行
 * （`$ 命令`），展开卡片就能看到没被截断的原文。
 */
type DirectResult = { content: ReactNode; detail?: string }

/**
 * 收集 ACP 工具的可直显内容；返回 null = 没有（回退通用折叠卡）。
 * 优先级：diff / text 内容块 → 输出（execute / terminal 类）。
 */
function renderAcpDirect(part: AgentMessagePart): DirectResult | null {
  if (part.type !== 'tool-call') return null
  const nodes: ReactNode[] = []
  const content = Array.isArray(part.acpContent) ? part.acpContent : []

  for (const [i, item] of content.entries()) {
    if (item?.type === 'diff' && (item.newText !== undefined || item.oldText !== undefined)) {
      // 文件修改：直接给前后对比（与内置 edit_file 的直显同一套视图）
      nodes.push(
        <FileDiffView
          key={`diff-${i}`}
          path={item.path ?? ''}
          hunks={[
            { header: `@@ ${item.path ?? 'diff'} @@`, lines: diffLines(item.oldText ?? '', item.newText ?? '') }
          ]}
        />
      )
    } else if (item?.type === 'content' && item.content?.type === 'text' && item.content.text) {
      nodes.push(<AcpTextBlock key={`text-${i}`} text={item.content.text} />)
    } else if (
      item?.type === 'content' &&
      item.content?.type === 'image' &&
      item.content.mimeType &&
      item.content.data
    ) {
      /**
       * 工具回传的图片（读图 / 截图 / 渲染预览这类工具）。走 `FilePartView` 而不是裸
       * `<img>`：缩略尺寸、点开大图、下载三件事都白拿，与用户附件同一观感。
       * 数据是 base64 内联的（ACP 没有 URL 这条路），拼成 data URL 即可 ——
       * `loadMediaObjectUrl` 对 `data:` 直通，不做 fetch。
       */
      const { mimeType, data } = item.content
      nodes.push(
        <FilePartView
          key={`image-${i}`}
          part={{
            type: 'file',
            name: `image.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length) || 'png'}`,
            mediaType: mimeType,
            url: data.startsWith('data:') ? data : `data:${mimeType};base64,${data}`
          }}
        />
      )
    }
    // type === 'terminal' 只有 terminalId（输出在 rawOutput / 后续 content 里）：不单独渲染，
    // 交给下面的 execute 分支直显输出
  }

  // 明细：默认给 agent 的标题；命令执行类优先入参里的命令
  //（agent 标题常带「Bash: 」前缀 / 是整段脚本，命令本身更干净）
  let detail = part.title
  if (nodes.length === 0 && (part.acpKind === 'execute' || content.some((i) => i?.type === 'terminal'))) {
    const input = part.input as { command?: string; cmd?: string; title?: string } | undefined
    const command = input?.command ?? input?.cmd ?? input?.title
    if (command) detail = `$ ${command}`
    // output 是 tool-result 回填进来的（contracts 的 tool-call 形状没声明）：运行时一定在
    const outputText = toolOutputText((part as { output?: unknown }).output)
    // 命令在触发行右侧已截断显示（见 ToolHeaderProps.detail）：内容区再回声一份完整的，
    // 长命令在头部只剩半截时，展开就能看到跑的到底是什么。
    const echoed = [command ? `$ ${command}` : '', outputText ?? ''].filter(Boolean).join('\n')
    if (echoed) nodes.push(<AcpTextBlock key="output" text={echoed} singleLine />)
  }

  if (nodes.length === 0 && !detail) return null
  return { content: nodes.length > 0 ? <>{nodes}</> : null, detail }
}

/**
 * 收集**内置**工具的可直显内容（与 ACP 的直显同一观感）：每个工具挑最有信息量的
 * 入参做主入参 → `detail`（工具名后面截断显示），结果抠成人话文本留在内容区。
 * 返回 null = 覆盖不到（回退通用折叠卡）。
 *
 * 文件类工具（write_file / edit_file / delete_file）不走这里 —— 它们由 buildFileDiff
 * 生成前后对比，在直显分支里铺。
 */
function renderBuiltinDirect(
  part: AgentMessagePart,
  hasOutput: boolean,
  output: unknown
): DirectResult | null {
  if (part.type !== 'tool-call' || part.acpContent?.length) return null
  const input = (part.input ?? {}) as Record<string, unknown>
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined

  /**
   * 终端工具（`run_in_terminal` / `read_terminal_output` / `send_keys` /
   * `list_terminal_sessions`，客户端在用户眼前那条终端里执行）。
   *
   * 结果是一段**终端原始文本**，不是结构化对象 —— 走下面的通用分支会掉进「Parameters /
   * Result 两坨 JSON」的兜底卡：终端输出被 `JSON.stringify` 当 JSON 高亮，数字全被拆成
   * 独立 span（用户看到的「满屏乱跳的数字」，`x86_64` 还会被切成 `x` + `86` + `_` + `64`）。
   *
   * 所以按 `execute_command` 的样子直显：`$ 命令` 铺在内容区第一行，后面接结果文本。
   * 两处与 execute_command 不同：
   * - **命令什么都没输出时不铺内容区**：工具会回一句「（等待期内没有捕获到新输出…）」，
   *   那是给模型的（免得它以为调用失败），摆给用户看就是一句废话；
   * - `send_keys` 只显示按了什么键：它的结果是一句固定回执（「已向 local:1 发送按键」），
   *   对用户没有信息量。
   */
  if (isTerminalTool(part.toolName)) {
    const command = str(input.command)
    const keys = str(input.keys)
    const body =
      part.isError === true || !hasOutput || part.toolName === 'send_keys'
        ? null
        : terminalOutputForDisplay(toolOutputText(output) ?? '')
    // 命令在触发行右侧已截断显示，内容区第一行再铺一份完整的（这条链路没有 diff 视图）
    const echoed = command ? (body ? `$ ${command}\n${body}` : `$ ${command}`) : body
    return {
      ...(command ? { detail: `$ ${command}` } : keys ? { detail: t('按键 {keys}', { keys }) } : {}),
      content: echoed ? <AcpTextBlock text={echoed} singleLine /> : null
    }
  }

  let subject: string | undefined
  const name = canonicalToolName(part.toolName)
  switch (name) {
    case 'bash':
      subject = str(input.command)
      break
    case 'read':
      subject = str(input.file_path) ?? str(input.path)
      break
    case 'glob':
      subject = str(input.pattern) ?? str(input.query)
      break
    case 'grep':
      subject = str(input.pattern) ?? str(input.query) ?? str(input.keyword)
      break
    case 'read_skill':
      subject = str(input.name) ?? str(input.skill) ?? str(input.path)
      break
    case 'web_fetch':
      subject = str(input.url)
      break
    case 'screenshot':
      subject = str(input.url)
      break
    default:
      return null
  }
  if (!subject) return null

  const isExec = name === 'bash'
  const detail = isExec ? `$ ${subject}` : subject
  // 结果文本：抠不出来（结构化对象 / 还没结果）就不硬造一块 —— 有结果才给
  const outputText = toolOutputText(output)
  // bash 的结果文本只有 stdout / stderr / 退出码标记（与 dsh 的 renderResult 一致），
  // 不带命令行 —— 所以这里必须补一行 `$ 命令`，否则用户看不出这条输出来自哪条命令。
  const echo = isExec ? `$ ${subject}` : ''
  if (outputText) {
    const text = isExec ? `${echo}\n${outputText}` : outputText
    return { content: <AcpTextBlock text={text} singleLine />, detail }
  }
  if (hasOutput && !isToolResultEmpty(output)) {
    // 结果在但抠不出人话：回退折叠卡，别丢信息
    return null
  }
  return { content: echo ? <AcpTextBlock text={echo} singleLine /> : null, detail }
}

/** 结果是否「等于没信息」（{} / [] / 空串）—— 与 toolErrorText 里的判断同一口径 */
function isToolResultEmpty(output: unknown): boolean {
  if (output === undefined || output === null || output === '') return true
  try {
    const json = JSON.stringify(output)
    return json === '{}' || json === '[]'
  } catch {
    return false
  }
}

/**
 * 一条**错误**（`⚠️ ` 前缀的文本 part，见 `ERROR_TEXT_PREFIX`）：只渲染正文，不挂任何按钮。
 *
 * ## 这里原来挂着一颗「重新加载」
 *
 * 一轮失败时（断线、模型配置不对、ACP 建连失败……）客户端 / 服务端都把错误写成一条
 * 文本 part 落进历史，那颗按钮做的是 `reloadConversation`（等价于「刷新页面 → 点开它」）。
 * 挪走的理由：错误只是该重拉的一种时机 —— 「一条消息都没有」往往才是**没加载成功**，
 * 那种状态下正文里根本没有这条错误 part，按钮无从出现，可用户恰恰最需要重拉。
 *
 * ⚠️ 别把按钮加回来。重拉这条会话的入口统一放在消息区空态（「历史消息没有显示？」），
 * 多一个入口只会让「为什么这里还是旧的」这类问题更难解释。
 */
function ErrorTextBlock({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <MessageResponse className="tracking-[0.02em]">{text}</MessageResponse>
    </div>
  )
}

export interface PartViewProps {
  part: AgentMessagePart
  streaming?: boolean
  /**
   * 整轮是不是正处在**这一条消息**的流式里（= 这条是最后一条消息且在跑）。
   *
   * 与 `streaming` 的分工：`streaming` 只对**消息的最后一个 part** 为真（思考条靠它判
   * 「正在思考」）；而停止钮要覆盖整条消息里的**每一个工具卡** —— 模型一步里并行发多条
   * tool-call 时，只有末位那个 part 拿得到 `streaming`，若拿它当判据，前面那几条命令
   * 就没了停止钮。所以这里用「整条消息在跑」这个更宽的信号。
   */
  turnLive?: boolean
  /**
   * 该 part 是否是在等的 ask_followup_question：是则**不在消息流里渲染表单**，
   * 只留一条「请在输入框里作答」的指引（真正的表单在 `ChatComposer` 的 cover 槽位）。
   */
  followupPending?: boolean
  /**
   * 该 part 是**已经结束那一轮**留下的、从没拿到答案的提问（应用退出 / 点了停止 /
   * 进程崩了）。渲染成可作答的卡片，但答案当新消息发出去 —— 见 `AskFollowupCard`
   * 的 `resumable`。
   */
  followupResumable?: boolean
  onResolveFollowup?: (answer: AskFollowupAnswer | null) => void
}

function PartViewInner({
  part,
  streaming,
  turnLive,
  followupPending,
  followupResumable,
  onResolveFollowup
}: PartViewProps) {
  // 停止动作（工具在飞时头部那颗停止钮用）。两个都是 store 上的稳定引用，
  // 不会因为它们在依赖里引发额外重渲染。
  // 订阅语言：本组件是 memo 的，不自己订阅的话切语言时工具卡标题 / 状态文案不会变
  const tr = useT()
  const stopCommand = useAgentStore((s) => s.stopCommand)
  const stopTurn = useAgentStore((s) => s.stop)
  /** 工具卡是否显示「意图」（设置 → AI → 通用 → 工具意图） */
  const showToolIntent = useAgentStore((s) => s.toolIntent)
  /** 头部标题 / 明细：开关关掉时 title 回到工具名（见 toolCardHead） */
  const cardHead = (target: ToolCallPart, detail?: string) =>
    toolCardHead(target, detail, showToolIntent)
  /** 「查看过程」的打开通道（由会话宿主 `ChatSurface` 提供；容器侧的片段渲染里是 null） */
  const openSubagent = useOpenSubagent()

  if (part.type === 'text') {
    /*
     * ⚠️ 只有空白的文本 part 直接不渲染（别改成渲染空元素）。
     *
     * 模型在工具调用之间经常只吐几个换行（实测一条消息 22 个文本 part 里 21 个是
     * `"\n\n\n"`）：它们自身高度是 0，看着"没东西"，但**照样是 MessageContent 里
     * 的一个 flex 子项、照样吃掉一个 gap-2(8px)** —— 于是每个思考条的下面都比上面
     * 多出 8px，整列横条看着"思考条偏上、工具条偏下"。渲染层直接返回 null 就没有
     * 盒子，gap 也就不会为它留空。
     */
    if (!part.text.trim()) return null
    // 错误（`⚠️ ` 前缀，见 `ERROR_TEXT_PREFIX`）：正文照原样渲染（重拉走消息区下拉刷新手势）
    if (isErrorText(part.text)) {
      return <ErrorTextBlock text={part.text} />
    }
    // tracking 只加在正文上（思考 / 工具横条是 text-sm 的紧凑行，隔着 MessageContent 一起加会显得散）
    return <MessageResponse className="tracking-[0.02em]">{part.text}</MessageResponse>
  }

  if (part.type === 'reasoning') {
    return <ReasoningView text={part.text} streaming={!!streaming} />
  }

  // 单独出现的 tool-result（正常流里会被回填到 tool-call 上，这里兜底渲染）
  if (part.type === 'tool-result') {
    return (
      <ToolCallCard
        title={toolLabel(part.toolName)}
        type={`tool-${part.toolName}` as ToolUIPart['type']}
        state={part.isError ? 'output-error' : 'output-available'}
      >
        {/* 错误时只给「人话」文本：output 是对象（ACP 的 rawOutput）时，
            再渲染一份 JSON 代码块会在卡片上把同一件事说两遍 */}
        <ToolOutput
          output={part.isError ? undefined : part.output}
          errorText={part.isError ? toolErrorText(part.output) : undefined}
        />
      </ToolCallCard>
    )
  }

  // 附件 part：图片缩略图（可放大）/ PDF 文件 chip（用户消息里排在正文上方 —— parts 顺序已保证）
  if (part.type === 'file') {
    return <FilePartView part={part} />
  }

  // ask_followup_question：正常待答时表单在**输入框槽位**里（`ChatComposer` 的 cover），
  // 消息流这里只留一条指引，避免同一张表单出现两次；补答 / 已回答仍走卡片本身。
  if (part.toolName === ASK_FOLLOWUP_TOOL) {
    const { output, isError } = toolState(part)
    const live = !!followupPending && onResolveFollowup != null
    if (live) {
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleQuestionMark className="size-4 shrink-0" />
          {tr('助手的提问（请在输入框里作答）')}
        </p>
      )
    }
    const resumable = !!followupResumable && onResolveFollowup != null
    return (
      <AskFollowupCard
        toolCallId={part.toolCallId}
        input={part.input}
        output={output}
        isError={isError}
        pending={false}
        resumable={resumable}
        onResolve={onResolveFollowup ?? (() => undefined)}
      />
    )
  }

  const { state, hasOutput, output, isError, streamingInput } = toolState(part)

  // 工具卡头部的停止钮**只给真有「单条取消」通道的工具**（`isStoppableToolName`：
  // execute_command / web_fetch / 派活工具 `agent-*`）：其它工具没有这条通道，
  // 在它们上面挂停止钮要么是空操作、要么等于偷偷中止整轮，语义不诚实 —— 所以干脆不显示，
  // 要停整轮用输入框那颗停止钮。
  //
  // 工具「在飞」= pending（入参还在流式生成）或执行中（已收到完整入参、结果还没回），
  // 且**当前这条消息还在流式**（`turnLive`）——历史里因异常中断残留的未结算 part
  // 不该出现停止钮。
  const toolCallId = part.type === 'tool-call' ? part.toolCallId : undefined
  const stoppableInFlight =
    turnLive &&
    isStoppableToolName(part.toolName) &&
    (state === 'input-streaming' || state === 'input-available')
  const onStop =
    stoppableInFlight && toolCallId
      ? () => {
          // 已经在执行 → 只停**那一条**（命令杀进程树 / 抓取 abort / 子任务 abort 子 run，
          // 工具结果收尾成「（已中止）」，整轮继续）；入参还在生成（还没真正跑起来）→
          // 没有可停的，退回中止这一轮。
          if (isStoppableToolRunning(part)) void stopCommand(toolCallId)
          else void stopTurn()
        }
      : undefined

  // 待办清单（todo_write）：入参 / 结果都是结构化的 `{ todos: [...] }`，画成勾选清单，
  // 不铺「输入 / 输出 JSON」。这是「动态规划」在界面上的落点 —— 模型每改写一次清单，
  // 就多一张卡，用户能看到计划是怎么随执行推进而演变的。
  //
  // `!streamingInput`：入参还在流式生成时 `part.input` 还是 undefined（只有 inputText），
  // 这时抠不出条目，交给下面的流式预览分支；否则会闪一下「清单已清空」。
  if (part.toolName === 'todo_write' && !streamingInput) {
    const items = todoItemsOf(part.input, output)
    const done = items.filter((t) => t.status === 'completed').length
    return (
      <ToolCallCard
        type={`tool-${part.toolName}` as ToolUIPart['type']}
        state={state}
        live={turnLive}
        {...cardHead(
          part,
          items.length ? t('{done}/{total} 已完成', { done, total: items.length }) : undefined
        )}
      >
        {items.length ? (
          <TodoChecklist items={items} />
        ) : (
          <AcpTextBlock text={t('（待办清单已清空）')} />
        )}
      </ToolCallCard>
    )
  }

  // 派活卡（toolName = `agent-<id>`）：入参是「给子 agent 的任务说明」，输出是「子 agent
  // 写的结论」，两边都得按人的读法来，所以单独一个分支：
  //   - 头部明细放 **prompt**（`detail` 自带截断 + Tooltip 看全文），而不是
  //     `{"prompt":"…"}` 这坨原始 JSON；
  //   - 内容区只渲染**结论的 markdown**，工具过程已被主进程的 slimDelegationOutput
  //     收敛掉（实测 subAgentToolResults 会把整份文件塞进来，还会原样进会话历史）。
  //
  // 与其余工具卡一个待遇：默认收起，要看子任务产出自己点开（运行态在头部，折叠也不瞎）。
  const subText = typeof (part as { subagentText?: unknown }).subagentText === 'string'
    ? ((part as { subagentText?: string }).subagentText as string)
    : ''
  // 派活卡「还在跑」的判据：**不能只看有没有流式文本**。子 agent 常常先连续翻
  // 十几个文件才吐第一段正文；没有这条时整张卡在工具阶段完全没动静，看起来像卡死。
  // 用 `streaming`（当前消息仍在流）排除历史里因异常中断残留的未结算 part。
  const delegationRunning = Boolean(streaming) && !hasOutput && !isError
  const delegationStreaming = Boolean(subText.trim()) && !hasOutput
  if (part.toolName.startsWith('agent-')) {
    const resultText = isError || !hasOutput ? null : toolOutputText(output)
    return (
      <ToolCallCard
        type={`tool-${part.toolName}` as ToolUIPart['type']}
        state={state}
        live={turnLive}
        {...cardHead(part, delegationPromptOf(part.input))}
        // 运行态挂在**头部**（工具名右边），内容区只放子任务产出与过程入口
        status={
          delegationRunning ? (
            <DelegationRunning toolName={part.subagentTool} toolCount={part.subagentToolCount} />
          ) : undefined
        }
        onStop={onStop}
      >
        {/*
         * 过程入口：子任务的思考 / 工具调用 / 正文都在 `delegation.parts` 里，
         * 点开把**主会话整块换成子任务的消息流**（与主任务同一套观感），头部有返回。
         * 没有这份记录（老消息 / 执行环境不支持）时不画按钮，别给一个点了没反应的入口。
         *
         * ⚠️ 必须把 `part.toolCallId` 一起交出去：宿主拿它逐帧重取最新的 delegation，
         * 否则运行中打开看到的是点开那一刻的快照（见 `subagent-view.ts`）。
         *
         * 跑着的时候不用翻卡片：输入框上方那排「运行中的子任务」是常驻的同类入口
         * （见 `ChatSurface` 的 `RunningSubagents`）。这里是**回看**历史派活的入口。
         */}
        {part.delegation && openSubagent ? (
          <SubagentProcessEntry
            delegation={part.delegation}
            onOpen={() => openSubagent(part.toolCallId, part.delegation as SubagentDelegation)}
          />
        ) : null}
        {isError && <AcpTextBlock text={toolErrorText(output)} />}
        {delegationStreaming ? (
          <StreamingInputBlock text={subText} label={t('子任务输出中...')} mono={false} />
        ) : null}
        {resultText ? <StreamingInputBlock text={resultText} label={t('子任务结论')} mono={false} /> : null}
      </ToolCallCard>
    )
  }

  // execute_command **运行中**（还没有 tool-result）：铺实时输出区 + 单条命令停止。
  // 结果到达后 hasOutput 变 true，本分支让位给下面的直显分支（结果文本），
  // liveOutput 也已被 parts 层清口（见 applyEvent 的 tool-result case）。
  //
  // ⚠️ 判据用 `isCommandRunning(part)`，**不能**加「liveOutput 在不在」这一条
  // （最早就是这么写的，实测踩到）：那个字段只在**第一段输出**到达时才被创建，
  // 而「在跑但什么都不吐」的命令（sleep 30 / 长编译 / 等网络）整轮都没有输出 ——
  // 于是整张卡只剩一行头部，内容区（含那块占位与输出区）压根不渲染，看起来像卡死。
  // 停止钮不受影响：它挂在**头部**（`onStop`），收起时也点得到。
  if (isCommandRunning(part)) {
    const cmdRaw = (part.input as { command?: unknown } | undefined)?.command
    const cmd = typeof cmdRaw === 'string' ? cmdRaw : ''
    // 没有输出时 liveOutput 还没被创建：给个空对象，LiveOutputBlock 照样铺占位 + 停止按钮
    const live =
      (part as { liveOutput?: { stdout: string; stderr: string } }).liveOutput ?? { stdout: '', stderr: '' }
    return (
      <ToolCallCard
        type={`tool-${part.toolName}` as ToolUIPart['type']}
        state={state}
        live={turnLive}
        {...cardHead(part, `$ ${cmd}`)}
        // 默认收起（与其余卡一致），要看实时输出点开 —— 头部有运行态图标与停止钮，
        // 折叠状态下也能判断「还在跑」、也能停。
        onStop={onStop}
      >
        {/* 命令在触发行右侧已截断显示（见 ToolHeaderProps.detail）；这里铺一份完整的，
            运行中也能一眼看到当前跑的是哪条命令，不用去悬停。 */}
        {cmd ? <AcpTextBlock text={`$ ${cmd}`} singleLine /> : null}
        <LiveOutputBlock live={live} />
      </ToolCallCard>
    )
  }

  // 入参还在流式生成：卡片直接铺「正在写什么」（半截 JSON 抠出来的内容，一帧帧变长）。
  // 完整 tool-call 到达后 inputText 被清掉（见 lib/parts.ts），自动回到下面的直显分支。
  if (streamingInput) {
    const preview = renderStreamingPreview(part)
    return (
      <ToolCallCard
        type={`tool-${part.toolName}` as ToolUIPart['type']}
        state={state}
        live={turnLive}
        {...cardHead(part, preview?.detail)}
        // 默认收起：入参在长的时候头部明细已经跟着截断刷新了，要细看半截 JSON 自己点开
        onStop={onStop}
      >
        {preview?.text ? <StreamingInputBlock text={preview.text} /> : null}
      </ToolCallCard>
    )
  }

  // 文件类工具（write_file / edit_file / delete_file）：从入参构造「修改前后对比」。
  const fileDiff = buildFileDiff(part)
  // ACP 工具：diff / 文本 / 命令+输出 直显（renderAcpDirect 判据见函数注释）
  const acpDirect = renderAcpDirect(part)
  // 内置工具：与 ACP 统一 —— 主入参 + 结果文本直显（文件类走上面的 diff）
  const builtinDirect = fileDiff || acpDirect ? null : renderBuiltinDirect(part, hasOutput, output)

  // 直显分支：有可直显内容（diff / 文本 / 命令）时不铺「输入 / 输出 JSON」，展开直接是
  // diff 对比或人话文本 —— 但外壳仍是同一个 ToolCallCard，头部 / 折叠行为与兜底卡完全一致
  // （默认收起、点头部展开，头部样式与思考条同口径）。命令 / 主入参走头部明细（detail，
  // 截断 + Tooltip），内容区只在真有东西时才铺边框盒，避免「还在跑、没输出」时
  // 展开出一片空白。
  if (acpDirect || fileDiff || builtinDirect) {
    const detail = fileDiff ? fileDiff.path : (acpDirect?.detail ?? builtinDirect?.detail)
    const hasBody = Boolean(isError || fileDiff || acpDirect?.content || builtinDirect?.content)
    return (
      <ToolCallCard
        type={`tool-${part.toolName}` as ToolUIPart['type']}
        state={state}
        live={turnLive}
        {...cardHead(part, detail)}
        onStop={onStop}
      >
        {hasBody && (
          <div className="flex flex-col gap-2 border border-border rounded-lg mt-2">
            {isError && <AcpTextBlock text={toolErrorText(output)} />}
            {fileDiff && <FileDiffView key="diff" {...fileDiff} />}
            {acpDirect?.content}
            {builtinDirect?.content}
          </div>
        )}
      </ToolCallCard>
    )
  }

  return (
    // 兜底：没有任何可直显内容的工具（未知 / 结果是结构化对象）——
    // 保留「中文工具名 + 状态徽章」的折叠卡，展开是原始参数与结果
    <ToolCallCard
      // ai-elements 的头部按 `tool-xxx` 前缀推断图标/文案，我们补一个中文标题覆盖它
      type={`tool-${part.toolName}` as ToolUIPart['type']}
      state={state}
      live={turnLive}
      {...cardHead(part)}
      onStop={onStop}
    >
      {part.input !== undefined && part.input !== null && <ToolInput input={part.input} />}
      {hasOutput && (
        // 失败时不要把 output 原样塞进去：ACP 的 rawOutput 是对象，
        // `String(output)` 会渲染成 [object Object]（见 lib/parts.ts 的 toolErrorText）
        <ToolOutput
          output={isError ? undefined : output}
          errorText={isError ? toolErrorText(output) : undefined}
        />
      )}
    </ToolCallCard>
  )
}

/**
 * 派活卡内容区里的「查看子任务过程」入口（**回看**用：跑着的时候有输入框上方那排常驻 chip）。
 *
 * 点开把**主会话整块换成子任务的消息流**，头部有返回；流式期那份过程跟着往下走。
 *
 * 为什么放在内容区而不是触发行：触发行是「这一步在干什么」的状态位，点开过程是一个
 * **导航**动作 —— 两种语义混在一个点击区域里，用户想展开卡片时会误开过程（这个按钮
 * 曾经放在触发行右侧，用户明确否掉了，理由也是「不该跟状态挤在同一行」）。
 *
 * 右边那行状态只在**异常终态**时出现：`empty` / `failed` / `aborted` 正是「为什么没结论」
 * 的答案，从前只体现在父侧的兜底文案里，用户得猜。
 */
function SubagentProcessEntry({
  delegation,
  onOpen
}: {
  delegation: SubagentDelegation
  onOpen: () => void
}) {
  const tr = useT()
  const statusText =
    delegation.status === 'empty'
      ? tr('跑完了，但没有产出结论')
      : delegation.status === 'failed'
        ? tr('执行失败')
        : delegation.status === 'aborted'
          ? tr('已中止')
          : null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={onOpen}
      >
        <ListTree className="size-3.5" />
        {tr('查看子任务过程')}
      </Button>
      {statusText ? (
        <span
          className={cn(
            'text-xs',
            delegation.status === 'empty' || delegation.status === 'failed'
              ? 'text-amber-600 dark:text-amber-500'
              : 'text-muted-foreground'
          )}
        >
          {statusText}
        </span>
      ) : null}
    </div>
  )
}

/**
 * 单个 part 的渲染（**带 memo**）。
 *
 * ⚠️ **为什么必须 memo**：流式期间每一批帧都会重渲整棵消息列表（见 `lib/frame-batch.ts`）。
 * `applyEvent` 追加 delta 时只重建**最后一个** part 对象，前面那些 part 的引用是不变的
 * —— 所以一条有几十个 part 的长消息里，每帧真正需要重画的只有末尾那一个。没有 memo 时
 * 全部 part 都要重跑一遍（`MessageResponse` 内部的 streamdown 解析、工具卡的 JSON 序列化…），
 * 纯属白做。
 *
 * **为什么用自定义比较器**：`onResolveFollowup` 是 `MessageParts` 里内联的箭头函数
 * （闭包住 `tcid` 与 `followup`），每次渲染都是新引用 —— 逐项浅比会永远判「变了」。
 * 它只用于「用户点了提问卡」这一个交互，且闭包内部读的是 store 最新值；真正决定卡片
 * 形态的是 `followupPending` / `followupResumable`（都在比），所以忽略它的引用变化是安全的。
 */
export const PartView = memo(
  PartViewInner,
  (prev, next) =>
    prev.part === next.part &&
    prev.streaming === next.streaming &&
    prev.turnLive === next.turnLive &&
    prev.followupPending === next.followupPending &&
    prev.followupResumable === next.followupResumable
)

/**
 * 附件 part（用户消息里的图片 / PDF）。
 *
 * 图片的 src 统一经 `loadMediaObjectUrl` 解析：web 同源直用；desktop 没有服务端口，
 * 走 IPC 桥 fetch 成 blob objectURL。加载失败给一个明确的占位（不吞错误）。
 * PDF 渲染成文件 chip（浏览器里直接内嵌 PDF 预览的收益小、泄露面大 —— 只展示文件名）。
 *
 * 图片点开的是共享的 `ImageViewer`（全屏缩放 / 旋转 / 平移）。它的下载按钮是**按需渲染**的
 * —— 不传 `onDownload` 就没有那颗按钮，所以消息附件以前只能看不能存。这里把下载接上：
 * `src` 已经是可 fetch 的地址（web 同源 / desktop 的 `blob:`），落盘与 Markdown 正文里的图
 * 走同一份实现（`saveImageLocally`），文件名用附件自己的 `name`（带扩展名就原样用）。
 */
function FilePartView({ part }: { part: Extract<AgentMessagePart, { type: 'file' }> }) {
  const tr = useT()
  const isImage = part.mediaType.startsWith('image/')
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  /** 全屏查看器开关：点图打开 */
  const [zoomOpen, setZoomOpen] = useState(false)
  /** 下载中去抖：blob 往返期间禁掉按钮，免得连点叠出多个下载 */
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    if (!isImage) return
    let alive = true
    setSrc('')
    setFailed(false)
    loadMediaObjectUrl(part.url)
      .then((resolved) => {
        if (alive) setSrc(resolved)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [isImage, part.url])

  if (!isImage) {
    return (
      <span className="flex max-w-72 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{part.name}</span>
      </span>
    )
  }
  if (failed || !src) {
    return (
      <span className="flex h-16 w-24 items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-muted-foreground">
        <ImageOff className="size-3.5" />
        {failed ? tr('图片加载失败') : tr('加载中…')}
      </span>
    )
  }
  const download = (): void => {
    if (downloading) return
    setDownloading(true)
    void saveImageLocally(src, { name: part.name, mime: part.mediaType })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(tr('下载失败：{error}', { error: msg }))
      })
      .finally(() => setDownloading(false))
  }
  return (
    <>
      <img
        src={src}
        alt={part.name}
        onClick={() => setZoomOpen(true)}
        className="max-h-60 max-w-64 cursor-zoom-in rounded-lg border border-border object-cover"
      />
      <ImageViewer
        src={src}
        alt={part.name}
        open={zoomOpen}
        onOpenChange={setZoomOpen}
        onDownload={download}
      />
    </>
  )
}
