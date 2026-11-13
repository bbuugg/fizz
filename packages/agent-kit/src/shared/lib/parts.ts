/**
 * 消息 part 的增量维护：把一条条流事件折叠进 assistant 消息的 parts 数组。
 *
 * 与桌面端 `app-store.ts` 的 `appendAgentPart` 保持同构（同样的 part 形状、
 * 同样的「tool-result 按 toolCallId 回填到对应 tool-call 上」），
 * 这样同一段历史在三个端渲染出来是一致的。
 */
import type { AgentChatMessage, AgentMessagePart, AgentStreamEvent } from '@fizz/contracts/types'
import { appendPartDelta, ERROR_TEXT_PREFIX } from '@fizz/contracts/types'
import { t } from '@fizz/i18n'

/**
 * 这条文本 part 是不是**一条错误**（见 `ERROR_TEXT_PREFIX` 的注释）。
 *
 * 错误在历史里就是一段以 `⚠️ ` 开头的纯文本（服务端落盘时也这么写），所以只能按前缀认。
 * 渲染层用它决定要不要在错误后面挂「重新加载」按钮。
 */
export function isErrorText(text: string): boolean {
  return text.trimStart().startsWith(ERROR_TEXT_PREFIX)
}

/** 去掉 `⚠️ ` 前缀后的正文（错误块里单独渲染正文时用；认不出前缀就原样返回） */
export function errorTextBody(text: string): string {
  const trimmed = text.trimStart()
  return trimmed.startsWith(ERROR_TEXT_PREFIX)
    ? trimmed.slice(ERROR_TEXT_PREFIX.length)
    : trimmed
}

/**
 * 断点续跑的回滚点：只保留到**最后一个已落定的工具结果**，其后的一律丢掉。
 *
 * 为什么是这个位置：续跑的前提是「上一次尝试已经跑完若干步」，而步与步之间的唯一边界
 * 就是工具结果（`onStepBoundary` 只在这之后被调用）。所以最后一个已落定的工具结果
 * **之前**的内容模型都看得见（断点里就有），必须留着；**之后**的内容属于失败的那一步，
 * 模型会重新生成，留着就会和新增量重复。
 *
 * 一个已落定的工具都没有时返回空数组：那种情况本来就不该有断点（第一步就失败了），
 * 退回「清空重来」是最安全的。
 */
export function truncateToLastSettledTool(parts: AgentMessagePart[]): AgentMessagePart[] {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (!part) continue
    // tool-result 是「找不到对应 tool-call」时的兜底 part，它本身就是落定的结果
    if (part.type === 'tool-result') return parts.slice(0, i + 1)
    if (part.type === 'tool-call' && part.output !== undefined) return parts.slice(0, i + 1)
  }
  return []
}

/**
 * `liveOutput`（运行中命令的实时输出）的字符上限：超过只保留尾部。
 *
 * `yes` / `find /` / 长构建能把 stdout 刷到几十 MB，而实时输出是**渲染态**
 * （最终内容以 tool-result 为准）—— 为它吃内存不划算。与 tools 层的
 * `MAX_CMD_CAPTURE` 同一思路：防爆，不丢正常命令的输出。
 */
export const MAX_LIVE_OUTPUT = 64_000

/**
 * 把一条流式 chunk 追加进某条流的缓冲，**stderr 行首插入 `[stderr] ` 前缀**。
 *
 * 行首判定（关键消歧）：chunk 是流式增量，一行可能被切成多个 chunk（`err-1` /
 * `\nerr-2\n` / `err-3`）—— 前缀必须只出现在「这一行的第一个非空字符」前，
 * 否则半行一个前缀。空行不插（避免满屏空 `[stderr]`）。
 */
export function appendStreamChunk(
  buf: string,
  stream: 'stdout' | 'stderr',
  chunk: string
): string {
  if (stream === 'stdout') return buf + chunk
  // 行首 = 缓冲为空或以 \n 结尾
  let atLineStart = buf.length === 0 || buf.endsWith('\n')
  let out = buf
  for (let i = 0; i < chunk.length; i += 1) {
    const ch = chunk[i]
    if (atLineStart && ch !== '\n' && stream === 'stderr') out += '[stderr] '
    out += ch
    atLineStart = ch === '\n'
  }
  return out
}

/**
 * 老数据的「碎片 parts」收敛成「一条思考 + 一条正文」。
 *
 * 只修显示、不改落盘数据：本仓的 ACP 适配层（以及部分网关）会把思考与正文**交替**流出来
 * —— `[思考两字][正文三字][思考两字]…`。早先的增量合并只认「最后一条」，那种一轮就落成
 * 十几条几字长的 part；渲染端按「连续的同类 part 成组」画，于是表现为：流式中每段思考各成
 * 一个「思考过程」分组、一段话被拆成十几个段落，整轮结束后除最后那一小段正文，其余全被
 * 收进折叠条（正文等于被藏了）。
 *
 * 合并口径与流式时**完全一样**（同一个 `appendPartDelta`，工具调用是边界），所以新老数据
 * 在这里收敛到同一个形状。
 *
 * 返回的 `originIndex` 是「新下标 → 原下标」：合并会改变下标，而
 * `ContextCompactionCard` 的插入位置（`afterPartIndex`）是按原下标给的，要靠它换算。
 */
export function coalescePartFragments(parts: AgentMessagePart[]): {
  parts: AgentMessagePart[]
  originIndex: number[]
} {
  const out: AgentMessagePart[] = []
  const originIndex: number[] = []
  parts.forEach((part, index) => {
    if (part.type !== 'text' && part.type !== 'reasoning') {
      out.push(part)
      originIndex.push(index)
      return
    }
    const before = out.length
    appendPartDelta(out, part.type, part.text)
    // 空字符串的 text part 不会新建 part（`appendPartDelta` 直接跳过），也就没有自己的下标
    if (out.length > before) originIndex.push(index)
  })
  return { parts: out, originIndex }
}

/** 往 parts 尾部追加一个流事件（返回新数组，供 React 状态更新用） */
export function applyEvent(parts: AgentMessagePart[], event: AgentStreamEvent): AgentMessagePart[] {
  const next = [...parts]

  switch (event.type) {
    case 'text-delta': {
      // 合并口径与落盘同源（`appendPartDelta`）：思考与正文交替流时不拆成一堆碎片
      appendPartDelta(next, 'text', event.delta)
      return next
    }
    case 'reasoning-delta': {
      appendPartDelta(next, 'reasoning', event.delta)
      return next
    }
    case 'file-part': {
      // agent 回传的图片（ACP 多模态输出）：整块追加，与用户附件同形，
      // 渲染端复用 `FilePartView`（缩略图 / 点开大图 / 下载都白拿）
      next.push({ type: 'file', name: event.name, mediaType: event.mediaType, url: event.url })
      return next
    }
    case 'tool-call-delta': {
      // 入参还在生成：卡片先建出来（工具名可能还没给），文本持续往里攒。
      // 完整 tool-call 到达时用 input 覆盖并丢掉 inputText（见下面的收口）。
      const index = next.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
      if (index === -1) {
        next.push({
          type: 'tool-call',
          toolCallId: event.toolCallId,
          // 增量帧常常没带工具名：空串由 toolCardTitle 兜底成「工具调用」，后到再补
          toolName: event.toolName ?? '',
          input: null,
          inputText: event.inputTextDelta
        })
        return next
      }
      const call = next[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
      next[index] = {
        ...call,
        toolName: call.toolName && call.toolName !== 'tool' ? call.toolName : (event.toolName ?? call.toolName),
        inputText: (call.inputText ?? '') + event.inputTextDelta
      }
      return next
    }
    case 'tool-output-delta': {
      // 命令执行期间的 stdout / stderr 实时增量：折叠进**同 id tool-call** 的
      // `liveOutput`（流式期字段，与 inputText / subagentText 同性质）。
      // 找不到对应 tool-call（上游没先发它）就忽略 —— tool-call 一定会先到，
      // 丢几帧增量只是少看一段过程，完整输出仍以 tool-result 为准。
      const index = next.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
      if (index === -1) return next
      const call = next[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
      const prev = call.liveOutput ?? { stdout: '', stderr: '' }
      let nextStdout = prev.stdout
      let nextStderr = prev.stderr
      if (event.stream === 'stdout') nextStdout = appendStreamChunk(prev.stdout, 'stdout', event.delta)
      else nextStderr = appendStreamChunk(prev.stderr, 'stderr', event.delta)
      // 防爆：两条流各自只留尾部（见 MAX_LIVE_OUTPUT）
      if (nextStdout.length > MAX_LIVE_OUTPUT) nextStdout = nextStdout.slice(-MAX_LIVE_OUTPUT)
      if (nextStderr.length > MAX_LIVE_OUTPUT) nextStderr = nextStderr.slice(-MAX_LIVE_OUTPUT)
      next[index] = { ...call, liveOutput: { stdout: nextStdout, stderr: nextStderr } } as AgentMessagePart
      return next
    }
    case 'subagent-start': {
      // 派活开跑：在派活卡（`agent-<id>` 那张）上建一份**过程记录**。找不到卡就忽略
      // —— 父侧 tool-call 一定会先到（引擎先发 tool-call 再开始派）。
      const index = next.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
      if (index === -1) return next
      const call = next[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
      next[index] = {
        ...call,
        delegation: {
          subagentId: event.subagentId,
          ...(event.name ? { name: event.name } : {}),
          task: event.task,
          parts: [],
          status: 'running',
          startedAt: Date.now()
        }
      } as AgentMessagePart
      return next
    }

    case 'subagent-event': {
      const index = next.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
      if (index === -1) return next
      const call = next[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
      const inner = event.event
      /**
       * 两件事一起做，互不替代：
       * 1. 折叠进 `delegation.parts` —— **递归调用本函数**，子任务的消息因此和主任务
       *    同一套形状（面板里直接交给 `MessageParts` 渲染）；
       * 2. 维护派活卡上那行轻量进度（`subagentText` / `subagentTool`），没有它时
       *    收起状态的卡片没有任何动静，看起来像卡死。
       *
       * `delegation` 可能还没有（start 帧丢了）：那种情况只做第 2 件，不建空记录 ——
       * 一条没有 subagentId / task 的记录进了历史反而更难看懂。
       */
      const patched: AgentMessagePart = {
        ...call,
        ...(call.delegation
          ? { delegation: { ...call.delegation, parts: applyEvent(call.delegation.parts, inner) } }
          : {}),
        ...(inner.type === 'text-delta'
          ? { subagentText: (call.subagentText ?? '') + inner.delta }
          : {}),
        ...(inner.type === 'tool-call'
          ? {
              subagentTool: inner.toolName,
              subagentToolCount: (call.subagentToolCount ?? 0) + 1,
              subagentToolId: inner.toolCallId
            }
          : {})
      }
      next[index] = patched
      return next
    }

    case 'subagent-end': {
      const index = next.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
      if (index === -1) return next
      const call = next[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
      if (!call.delegation) return next
      next[index] = {
        ...call,
        delegation: {
          ...call.delegation,
          status: event.status,
          // 派活方给的耗时更准（它包住的是子 run 自己的起止），拿不到才用本地时间戳
          endedAt: call.delegation.startedAt + (event.durationMs ?? Date.now() - call.delegation.startedAt)
        }
      } as AgentMessagePart
      return next
    }

    case 'tool-call': {
      // 同一个 toolCallId 可能来多次（ACP agent 的入参先发一半、后面补全）：
      // 按 id 合并入参，不要多出一张卡
      const index = next.findIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId)
      if (index === -1) {
        next.push({
          type: 'tool-call',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          ...(event.acpKind ? { acpKind: event.acpKind } : {}),
          ...(event.acpContent ? { acpContent: event.acpContent } : {})
        })
        return next
      }
      const call = next[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
      // 收口：完整入参到了，流式期攒的半成品入参文本作废（它只喂渲染，不进历史）。
      // 用解构丢字段而不是置 undefined —— `exactOptionalPropertyTypes` 下后者过不了类型。
      // ⚠️ `liveOutput`（实时输出）与 `subagentText` 同理**必须保留**：命令可能还在跑
      // （工具卡上「实时输出中」那一块），跟着 inputText 一起丢会让它突然消失。
      const { inputText: _streamed, ...settled } = call
      next[index] = {
        ...settled,
        toolName: call.toolName && call.toolName !== 'tool' ? call.toolName : event.toolName,
        input: { ...(call.input ?? {}), ...(event.input ?? {}) },
        // ⚠️ `subagentText`（子 agent 的文本增量）要留着：派活的完整 tool-call
        // 到达得比流式增量晚，跟着 inputText 一起丢掉的话，卡片刚攒起来的内容
        // 会在「派活结束」那一瞬间被清空。它在下面一并被压缩成结果。
        ...(call.subagentText ? { subagentText: call.subagentText } : {}),
        // ACP 的种类 / 展示内容：后到的覆盖（diff / 输出文本都是随 update 补全的）
        ...(event.acpKind || call.acpKind ? { acpKind: event.acpKind ?? call.acpKind } : {}),
        ...(event.acpContent || call.acpContent
          ? { acpContent: event.acpContent ?? call.acpContent }
          : {}),
        // agent 的展示标题：同上，后到的覆盖（它不是工具名，只做悬停提示）
        ...(event.title || call.title ? { title: event.title ?? call.title } : {})
      } as AgentMessagePart
      return next    }
    case 'tool-result': {
      // 结果回填到同 id 的 tool-call 上；找不到就单独追加（异常情况也不丢数据）
      const index = next.findIndex(
        (p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId
      )
      if (index === -1) {
        next.push({
          type: 'tool-result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
          ...(event.isError ? { isError: true } : {})
        })
        return next
      }
      const call = next[index] as Extract<AgentMessagePart, { type: 'tool-call' }>
      // 结果到了 = 运行期结束：`liveOutput`（实时输出）清口 —— 工具卡换成结果直显。
      // 用解构丢字段而不是置 undefined（与上面的收口同一理由）。
      const { liveOutput: _live, inputText: _streamed, ...rest } = call
      next[index] = {
        ...rest,
        output: event.output,
        ...(event.isError ? { isError: true } : {})
      } as AgentMessagePart
      return next
    }
    case 'error':
      next.push({ type: 'text', text: `${ERROR_TEXT_PREFIX}${event.message}` })
      return next
    case 'retry':
      // 两种重试对渲染的要求不同：
      // - 整轮重来：丢掉这一次尝试已渲染的全部输出（避免正文重复）；
      // - 断点续跑（`resume`）：模型接着失败的那一步跑，已完成的步骤它看得见 —— 全清会
      //   和上下文对不上，只回滚到最后一个已落定的工具结果。
      // 重试提示本身不是内容增量，由 handleFrame 路由到单独 state（见 conversation.ts）。
      return event.resume ? truncateToLastSettledTool(next) : []
    case 'finish':
      return next
    // context-compressed / context-compaction-* 是「通知」不是内容增量：不往 parts
    // 里塞任何东西，只是让 switch 对新类型保持穷尽（否则加一个新类型这里就要报错）。
    // 交接文档的展示由 handleFrame 路由到单独的 compaction 状态。
    case 'context-compressed':
    case 'context-compaction-start':
    case 'context-compaction-delta':
      return next
    // context-usage 同理不是内容：它是 agent 报的上下文占用快照，
    // 由 handleFrame 挂到消息的 `contextUsage` 字段上，parts 里不留痕。
    case 'context-usage':
      return next
    // user-injected 也不是内容增量：它携带一条**完整的** user 消息，由 handleFrame
    // 把 live 助手消息拆成两段、把它插进中间（见 conversation.ts）。parts 不动。
    case 'user-injected':
      return next
    // 多智能体协作的运行态（任务 / 消息 / Agent 状态 / 子 Agent 输出）由
    // handleFrame 路由到 conversation slice 的 `collab` 现场，主消息 parts 不掺和。
    case 'collab-task':
    case 'collab-message':
    case 'collab-agent':
    case 'collab-delta':
    case 'collab-tool':
      return next

    /**
     * ⚠️ 运行期兜底，**不能删**（它同时也是「不无限重连」的兜底）。
     *
     * 这个 switch 在**类型**上是穷尽的，但线上真的会收到本端不认识的事件类型（服务端 /
     * 客户端版本错位、上游新增事件、ACP 的 sessionUpdate 变化）。没有这一条时函数会
     * 走到末尾返回 `undefined`，`parts` 当场变成 `undefined`：表面看只是这一帧没内容，
     * 但**下一帧**开头 `const next = [...parts]` 会直接抛
     * `TypeError: undefined is not iterable`。
     *
     * 那个异常会穿出 `readSseFrames` 的 for-await，被 `attachRun` 当成「连接断了」：
     * 弹「连接中断，正在自动重连」→ 重连时从帧日志**头部回放** → 同一帧再炸一次 →
     * 无限重连（重连循环没有次数上限）。所以这里必须返回一个数组。
     */
    default: {
      /**
       * 下面这行是**编译期**的穷尽性守卫：新增事件类型忘了加 case 时，`event` 不再被
       * 收窄成 `never`，这行会直接报错 —— 有了运行期兜底也不该让类型检查变松。
       */
      const _exhaustive: never = event
      void _exhaustive
      console.warn('[parts] 收到未知的流事件类型，已忽略：', (event as { type?: unknown }).type)
      return next
    }
  }
}

/** tool-call part 的执行状态 → ai-elements 的 ToolHeader 用的 state */
export function toolState(part: AgentMessagePart): {
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
  hasOutput: boolean
  output: unknown
  isError: boolean
  /** 入参正在流式生成（攒着 inputText，还没收到完整 tool-call） */
  streamingInput: boolean
} {
  if (part.type !== 'tool-call') {
    return {
      state: 'input-available',
      hasOutput: false,
      output: undefined,
      isError: false,
      streamingInput: false
    }
  }
  // tool-result 会被回填到对应的 tool-call 上（见 applyEvent），所以这里按「有没有 output」判断
  const output = part.output
  const isError = part.isError === true
  const hasOutput = output !== undefined
  // 「入参正在流式生成」= 这个 part 上攒着 inputText —— 允许它是空串：
  // 上游「开始生成入参」那一帧只有工具名、还没有内容（见 agent.ts 的 streaming-start），
  // 那一刻就该进入流式态（卡片标题已是真实工具名），只是内容区还没东西可展开。
  const inputText = (part as { inputText?: unknown }).inputText
  const streamingInput = typeof inputText === 'string'
  return {
    state: hasOutput
      ? isError
        ? 'output-error'
        : 'output-available'
      : streamingInput
        ? 'input-streaming'
        : 'input-available',
    hasOutput,
    output,
    isError,
    streamingInput
  }
}

/**
 * 这条 part 是不是「**execute_command 正在跑**」（命令已启动、还没有结果）。
 *
 * 实时输出区的开关，也是卡片头部停止钮「只停这一条命令」还是「中止整轮」的分流判据
 * （见 PartView 的 `onStop`）。判据刻意**不看 `liveOutput`**：
 *
 * `liveOutput` 是「第一段 stdout/stderr 到达」时才被创建出来的流式字段
 * （见 `applyEvent` 的 `tool-output-delta` 分支，`call.liveOutput ?? {stdout:'',stderr:''}`）。
 * 拿它当判据会把「**在跑但什么都不吐**」的命令漏掉 —— `sleep 30`、长编译、
 * 拷文件、等网络都是这样：整张卡退化成只有一行头部（展开箭头在未结算态
 * `input-available` 是 **disabled** 的，见 ToolHeader 的 `isSettled`），
 * 用户点不开内容区，也就摸不到原先挂在内容区里的停止钮，只能干等它自己结束。
 * 头部那颗停止钮（不依赖内容区，未结算态照样可点）正是为此补上的。
 *
 * 所以只看三件事：是 execute_command、结果还没到、入参已定型
 * （`input-streaming` 时命令还没开始跑，该走「正在写入参」那个预览）。
 */
export function isCommandRunning(part: AgentMessagePart): boolean {
  if (part.type !== 'tool-call' || canonicalToolName(part.toolName) !== 'bash') return false
  const { hasOutput, streamingInput } = toolState(part)
  return !hasOutput && !streamingInput
}

/**
 * 卡片头部那颗「停止」钮**按条生效**的工具。
 *
 * 停止入口本来就是通用的（`POST /api/chat/command/stop` 只认 `requestId + toolCallId`，
 * 服务端按 toolCallId 查 run 的停止表），所以新增一个可停工具只要**名字加进来 +
 * 工具自己在执行期登记 stop**，不需要新接口、也不需要新按钮。
 *
 * 目前三类：
 * - `bash`（旧名 `execute_command`）：杀那一棵进程树；
 * - `web_fetch`：abort 这一次抓取（抓境外站点动辄等 30s，不该为它废掉整轮）；
 * - 派活工具 `agent-<id>`：abort 这一个子 run（见 `isStoppableToolName` 的说明）。
 */
export const STOPPABLE_TOOLS: ReadonlySet<string> = new Set(['bash', 'execute_command', 'web_fetch'])

/**
 * 派活工具（`agent-<id>`）也支持单条停止 —— 前缀判定，**不要**把 id 一个个塞进
 * `STOPPABLE_TOOLS`：`SubagentId` 是开放集合（新增见 contracts 的 `SUBAGENT_META`），
 * 漏写一个就变成「那个子任务没有停止钮」，而且没有任何地方会报错。
 *
 * 服务端那边派活工具同样把 stop 登记进 run 的停止表（见 `subagents.ts` 的
 * `commandStops`），所以这里放行就是「点了真的能停」。
 */
export function isStoppableToolName(toolName: string): boolean {
  return STOPPABLE_TOOLS.has(toolName) || toolName.startsWith('agent-')
}

/**
 * 「在飞且可单独停止」——判据与 `isCommandRunning` 同源（不看 `liveOutput`，理由见上），
 * 只是工具集合更宽。渲染层用它决定停止钮是「只停这条」还是「中止整轮」。
 */
export function isStoppableToolRunning(part: AgentMessagePart): boolean {
  if (part.type !== 'tool-call' || !isStoppableToolName(part.toolName)) return false
  const { hasOutput, streamingInput } = toolState(part)
  return !hasOutput && !streamingInput
}

/** 消息里最后一段正文（列表预览 / 通知用） */
export function textOf(message: AgentChatMessage): string {
  return message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim()
}

/**
 * 工具调用的中文名（内置工具一个都不漏：漏掉的会**原样显示英文**，见 toolLabel 的兜底）。
 *
 * ⚠️ 这张表与 `packages/tools/src/**` 的注册清单是两份东西：新增工具时**这里也要加**，
 * 否则界面上就是「web_fetch」这种裸英文。判据：`grep -n 'tool({' packages/tools/src/*.ts`
 * 列出来的每个 key 都该在下面有一条。
 */
export const TOOL_LABELS: Record<string, string> = {
  // 对齐 DeepSeek Harness 后的名字（read / write / edit / glob / grep / bash）
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  glob: '查找文件',
  grep: '搜索内容',
  bash: '执行命令',
  str_replace_editor: '查看与编辑文件',
  // 旧名保留：历史会话里存的是当时的工具名，去掉这些 key 会让旧卡片变成裸英文
  list_files: '列出目录',
  find_files: '查找文件',
  search_files: '搜索内容',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  delete_file: '删除文件',
  execute_command: '执行命令',
  // 终端助手（客户端执行）的四个工具。名字与 execute_command 刻意分开：前者在**用户
  // 眼前那条终端**里敲（等同人手输入），后者是服务端起一个子进程，失败面完全不同，
  // 卡片上混成同一个名字会让人分不清命令到底跑在哪。
  run_in_terminal: '在终端执行',
  read_terminal_output: '读取终端输出',
  send_keys: '发送按键',
  list_terminal_sessions: '列出终端会话',
  // Agent 自己维护的待办清单（每次整份重发；渲染端画成勾选清单）
  todo_write: '更新待办清单',
  // 全局只读工具：不依赖工作区，任何会话（含未绑定目录的「任务」会话）都可用
  web_fetch: '抓取网页',
  screenshot: '网页截图',
  git_read: '读取 Git',
  read_skill: '读取技能',
  ask_followup_question: '向用户提问',
  // ACP 外部 Agent 配置（只挂项目助手；改的是全局设置）
  list_acp_agents: '列出外部 Agent',
  detect_acp_agents: '探测外部 Agent',
  probe_acp_models: '探测 Agent 模型',
  create_acp_agent: '添加外部 Agent',
  update_acp_agent: '修改外部 Agent',
  delete_acp_agent: '删除外部 Agent',
  // Fizz 自己的项目管理工具（agent 在会话里查 / 建工作区、会话、worktree 用）
  list_projects: '列出项目',
  list_dirs: '浏览目录',
  create_project: '创建项目',
  open_project: '切换项目',
  create_conversation: '新建会话',
  remove_project: '移除项目',
  create_worktree: '创建 Worktree',
  remove_worktree: '删除 Worktree',
  create_task_trigger: '创建定时任务',
  list_task_triggers: '列出定时任务',
  update_task_trigger: '修改定时任务',
  delete_task_trigger: '删除定时任务',
  set_task_trigger_enabled: '启停定时任务',
  create_plugin: '创建插件',
  // 全局助手的模型配置工具：改的是「设置 → 模型」里那份全局配置（网关 / key / 模型清单）
  list_model_configs: '列出模型配置',
  fetch_upstream_models: '拉取模型清单',
  create_model_config: '新建模型配置',
  update_model_config: '修改模型配置',
  delete_model_config: '删除模型配置',
  add_model_entries: '添加模型',
  update_model_entry: '修改模型条目',
  remove_model_entry: '移除模型条目',
  // 子任务（subagent）派活：引擎的工具名就是 `agent-<subagentId>`，见
  // packages/agent/src/subagents.ts 的 SUBAGENT_SPECS。不用图标区分主次，
  // 一张卡 + 「子任务 · xxx」的标题已经够读。
  'agent-explorer': '子任务 · 侦察',
  'agent-reviewer': '子任务 · 审查'
}

/**
 * 旧工具名 → 新名。历史会话（`conversation.json`）里存的是当时的名字，不做映射的话
 * 旧卡片会掉进通用 JSON 分支；新名字一律走 canonical 后再判定。
 */
const LEGACY_TOOL_NAMES: Record<string, string> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  search_files: 'grep',
  find_files: 'glob',
  list_files: 'glob',
  execute_command: 'bash'
}

/** 把历史工具名折算成当前名字（未知名字原样返回） */
export function canonicalToolName(name: string): string {
  return LEGACY_TOOL_NAMES[name] ?? name
}

/** ACP agent 不给 name 时的占位工具名（与 @fizz/acp 的 acp.ts 里 ACP_UNNAMED_TOOL 一致） */
const ACP_UNNAMED_TOOL = 'tool'

/**
 * ACP 的 `toolCall.kind` → 中文（agent 只给 kind + title、不给 name 时靠它翻）。
 *
 * 与 TOOL_LABELS 分开：这些是 ACP 协议枚举（read / edit / execute …），
 * 不是本项目的内置工具名，混在一张表里会被误当成内置工具命中。
 */
export const ACP_KIND_LABELS: Record<string, string> = {
  read: '读取',
  edit: '编辑文件',
  delete: '删除文件',
  move: '移动文件',
  search: '搜索',
  execute: '执行命令',
  think: '思考',
  fetch: '抓取网页',
  switch_mode: '切换模式',
  other: '工具调用',
  [ACP_UNNAMED_TOOL]: '工具调用'
}

export function toolLabel(name: string): string {
  const label = TOOL_LABELS[name] ?? ACP_KIND_LABELS[name]
  // 认不出的工具名原样返回（agent 自己起的名，本来就是给终端用户看的英文名）
  return label ? t(label) : name
}

/**
 * 工具卡**头部标题**：内置工具名 → ACP 种类 → 原始名。
 *
 * ⚠️ 占位名（ACP agent 没给 name，历史上会把 agent 的 title 填进来）时千万别退回
 * `part.title`：那是 agent 给的自然语言描述，脚本 / 命令工具会把整段脚本塞进去
 * （`Bash: cat deploy.sh`），摆到标题上卡片就变成一长串命令。想看原文悬停工具名后面的
 * 明细（截断 + Tooltip，见 ToolHeader 的 detail）。
 */
export function toolCardTitle(name: string, kind?: string): string {
  const known = TOOL_LABELS[name]
  if (known) return t(known)
  if (!name || name === ACP_UNNAMED_TOOL) {
    const label = kind ? ACP_KIND_LABELS[kind] : undefined
    return t(label ?? ACP_KIND_LABELS.other)
  }
  return toolLabel(name)
}

/**
 * 工具入参里「这一步的意图」的字段名。
 *
 * 由 `@fizz/agent` 的 `withToolIntent()` 注入到每个工具的 schema 里（模型每次调用必填），
 * 两边的字符串必须一致 —— 改一处就要改另一处。
 */
export const TOOL_INTENT_FIELD = 'intent'

/**
 * 从**还在流式生成**的入参 JSON 里抠出 intent。
 *
 * 入参是一帧帧追加的（`{"intent":"修复类型错误","pa…`），完整 tool-call 到达前
 * `part.input` 还是空的，只能按文本抠 —— 这样卡片一出现标题就是意图，
 * 而不是先显示「执行命令」、等整段 JSON 收完再跳一下。
 */
function intentFromInputText(text: string): string {
  const matched = /"intent"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text)
  if (!matched) return ''
  const raw = matched[1]
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    // 半截（转义序列还没吐完）就先用原文，下一帧会覆盖
    return raw
  }
}

/** 这条工具调用的「意图」（模型填的那句话）；没有就返回空串 */
export function toolIntentOf(part: AgentMessagePart): string {
  if (part.type !== 'tool-call') return ''
  const input = part.input
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = (input as Record<string, unknown>)[TOOL_INTENT_FIELD]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return part.inputText ? intentFromInputText(part.inputText).trim() : ''
}

/** 工具卡只画在 tool-call part 上（tool-result 兜底卡单独渲染） */
export type ToolCallPart = Extract<AgentMessagePart, { type: 'tool-call' }>

/**
 * 工具卡头部：**有意图就把意图当标题**，工具名退到明细最前面
 * （`修复类型错误` / `编辑文件 · src/parts.ts`）。
 *
 * 退位而不是丢掉工具名：意图说的是「为什么」，工具名说的是「用什么干的」，
 * 排查时两样都要看。没有意图（老会话 / 模型没填 / 非内置工具）时与改造前完全一致。
 */
export function toolCardHead(
  part: ToolCallPart,
  detail?: string,
  /**
   * 是否显示意图（设置 → AI → 通用 → 工具意图）。缺省显示。
   *
   * 关掉时连**历史里已有 intent 的卡片**也回到工具名 —— 这个开关管的是「显示」，
   * 不只是「让模型填」，否则关掉开关后老会话还是满屏意图，看起来像没生效。
   */
  showIntent = true
): { title: string; detail?: string } {
  // 派活卡：用「子任务 · <显示名>」。自定义子智能体的名字随 delegation 落盘，
  // 所以定义被删掉之后历史卡片仍显示当时的名字，而不是 `agent-custom-1a2b3c4d`。
  const delegationName = part.toolName.startsWith('agent-') ? part.delegation?.name : undefined
  const label = delegationName
    ? t('子任务 · {name}', { name: delegationName })
    : toolCardTitle(part.toolName, part.acpKind)
  const intent = showIntent ? toolIntentOf(part) : ''
  if (!intent) return detail ? { title: label, detail } : { title: label }
  const extra = detail?.trim()
  return extra ? { title: intent, detail: `${label} · ${extra}` } : { title: intent, detail: label }
}

/** 把多行入参（命令 / 脚本 / prompt）压成一行：抬头右侧只有一行的高度 */
function oneLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * 工具调用的**主入参明细**：命令 / 路径 / 搜索词 / 派活 prompt（一行）。
 *
 * 与 `ToolHeader` 的 `detail` 是两个用途：那个是卡片自己的明细位，由 `PartView` 按分支
 * 各算各的（todo 是「3/5 已完成」这种摘要）；这里只服务**过程分组抬头右侧那一行**——
 * 要求各工具口径一致，而且**入参还在流式生成时也认得**（`input` 还没收口，只能从
 * `inputText` 的半截 JSON 里抠）。
 *
 * 命令带 `$` 前缀（与卡片内容区同一写法），一眼能分出「这是条命令」。
 */
export function toolDetailOf(part: ToolCallPart): string | undefined {
  const input = (part.input && typeof part.input === 'object' ? part.input : {}) as Record<
    string,
    unknown
  >
  const fromInput = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value.trim()) return value
    }
    return undefined
  }
  const fromPartial = (keys: string[]): string | undefined => {
    if (!part.inputText) return undefined
    for (const key of keys) {
      const value = partialJsonString(part.inputText, key)
      if (value?.trim()) return value
    }
    return undefined
  }
  const pick = (keys: string[]): string | undefined => fromInput(keys) ?? fromPartial(keys)

  const command = pick(['command', 'cmd'])
  if (command) return oneLine(`$ ${command}`)
  // 文件类：内置 agent 用 path，ACP 的编辑工具则常见 filePath（opencode/claude 都是它）。
  const path = pick(['path', 'file_path', 'filePath'])
  if (path) return oneLine(path)
  // 搜索类：内置 search_files 是 pattern，ACP 的 glob / grep 常见 query / keyword。
  const pattern = pick(['pattern', 'query', 'keyword'])
  if (pattern) return oneLine(pattern)
  // 抓取 / 截图类主入参是 URL。
  const url = pick(['url'])
  if (url) return oneLine(url)
  // 技能 / 终端按键：没有路径也没有命令，主入参就是名字 / 按了什么键。
  const target = pick(['name', 'skill'])
  if (target) return oneLine(target)
  const keys = pick(['keys'])
  if (keys) return oneLine(keys)
  const prompt = pick(['prompt'])
  if (prompt) return oneLine(prompt)
  /*
   * 兜底：ACP 工具可能只给了 `title`（不少 agent 在第一条 update 里不带 rawInput，
   * 见 `packages/acp/src/acp.ts` 的 mergeAcpInput）。编辑类的 title 本身就是文件路径，
   * 命令类已被上面的 command 拦截 —— 没有其它可用字段时，title 就是「这一步干了什么」。
   * 不放这条的话，编辑文件这类工具在过程分组抬头右侧就是空的。
   */
  const title = typeof part.title === 'string' ? part.title.trim() : ''
  if (title) return oneLine(title)
  return undefined
}

/** ask_followup_question 工具名（与 @fizz/tools 侧的 ASK_FOLLOWUP_TOOL 一致；web 不依赖 Node 侧包） */
export const ASK_FOLLOWUP_TOOL = 'ask_followup_question'

/** 把工具的入参 / 输出压成可读字符串（ai-elements 的 ToolInput/ToolOutput 吃 unknown） */
export function previewValue(value: unknown, max = 2000): string {
  if (value === null || value === undefined) return ''
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return raw.length > max ? `${raw.slice(0, max)}\n${t('…（已截断）')}` : raw
}

/** JSON 字符串里的转义 → 真字符（只覆盖模型写文件时真会用的那几个） */
const JSON_UNESCAPE: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/'
}

/**
 * 从**可能截断**的入参 JSON 文本里抠一个字符串字段的值（工具入参流式生成期用）。
 *
 * 那时候的入参是半截 JSON（`JSON.parse` 必抛），所以不追求解析出完整对象 ——
 * 按 `"key": "` 定位后一路扫到**未转义的**收尾引号，扫到末尾仍没闭合就取到末尾。
 * 只喂渲染，抠不出来返回 undefined（调用方据此回退）；这份文本永不落盘，
 * 收口时以完整 `tool-call` 的 `input` 为准。
 */
export function partialJsonString(text: string, key: string): string | undefined {
  const head = text.indexOf(`"${key}"`)
  if (head < 0) return undefined
  let i = head + key.length + 2
  // 跳过冒号与空白
  while (i < text.length && /[\s:]/.test(text[i])) i += 1
  if (text[i] !== '"') return undefined
  let out = ''
  for (i += 1; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      // 半截转义序列（文本正好停在反斜杠上）：就此收尾，别把孤立的反斜杠画出来
      if (next === undefined) break
      out += JSON_UNESCAPE[next] ?? next
      i += 1
      continue
    }
    if (ch === '"') break
    out += ch
  }
  return out
}

/**
 * 工具失败时给用户看的错误文本。
 *
 * ⚠️ **不能直接 `String(output)`**：ACP 后端（opencode 等）的 `rawOutput` 是个**对象**
 * （`acp.ts` 里 `output: update.rawOutput ?? {}`），`String({...})` 出来就是 `[object Object]`
 * —— 实测：只读模式下 write 被拒，工具卡上会多出一行红色的 `[object Object]`。
 *
 * 所以先尽量抠「人话」（string / `{ text | message | error | content }` / 数组逐项），
 * 抠不出来才退回**单行** JSON —— 卡片里那个 div 没有 `whitespace-pre-wrap`，
 * 多行 JSON（`JSON.stringify(x, null, 2)`）会被折成一坨，所以这里刻意不缩进。
 */
export function toolErrorText(output: unknown): string {
  const text = readableText(output)
  if (text) return text
  if (output === undefined || output === null) return t('工具执行失败')
  try {
    const json = JSON.stringify(output)
    // `{}` / `[]` 等于没信息 —— ACP 侧 `output: update.rawOutput ?? {}` 的缺省就是这个
    if (!json || json === '{}' || json === '[]') return t('工具执行失败')
    return json.length > 600 ? `${json.slice(0, 600)}${t('…（已截断）')}` : json
  } catch {
    // 循环引用之类
    return t('工具执行失败')
  }
}

/**
 * 工具输出里的「人话」文本（成功结果用）：字符串直接用；对象按 text / message / content /
 * stdout / stderr 依次钻。抠不出来返回 null —— 调用方（ACP 工具直显）据此决定回退折叠卡。
 */
export function toolOutputText(output: unknown): string | null {
  return readableText(output)
}

/**
 * 从任意形状里抠可读文本：字符串直接用；对象按 `text` / `message` / `error` / `content` / `stderr`
 * 依次往下找（ACP 的 content block 是 `{ type: 'text', text }`，包一层 `content` 也能钻进去）。
 * 深度限 4 层，避免自引用对象把调用栈打爆。抠不出来返回 null（交给调用方兜底）。
 */
function readableText(value: unknown, depth = 0): string | null {
  if (depth > 4) return null
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => readableText(item, depth + 1))
      .filter((item): item is string => item !== null)
    return parts.length ? parts.join('\n') : null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'message', 'error', 'content', 'stdout', 'stderr']) {
      const hit = readableText(record[key], depth + 1)
      if (hit) return hit
    }
  }
  return null
}
