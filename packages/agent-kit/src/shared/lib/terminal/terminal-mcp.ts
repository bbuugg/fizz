/**
 * 终端工具的 **MCP server**（进程内，跑在渲染端）+ 一组给 AI 用的工具定义。
 *
 * ## 为什么走 MCP
 *
 * 「让 AI 操作终端」这件事在 dogi 里是**内置服务端工具**；fizz 的终端在服务端
 * 但会话不可寻址（见 `terminal-registry.ts`），所以执行必须在渲染端。把渲染端的这几个
 * 能力包成一个**进程内 MCP server**（`@modelcontextprotocol/sdk` 的 `McpServer` +
 * `InMemoryTransport`），有两点实打实的好处：
 *
 * 1. 工具**定义**（名字 / 描述 / JSON Schema）由 MCP 的 `tools/list` 产出，不是手写常量
 *    —— 将来加工具只改一处，客户端与服务端看到的是同一份；
 * 2. 与「客户端 mcp 工具」这条通道**天然同构**：随请求上送的就是 MCP 工具清单，
 *    服务端按普通 MCP 工具对待（`ClientToolSpec` 就是 MCP `Tool` 的子集）。
 *
 * ## 生命周期
 *
 * 懒创建（第一次要用时才建 server + 连 in-memory 管道），进程内一条即可。绑定的目标
 * 终端**不在 server 里**：每次调用由 `boundTabKey` 现传（见 `callTerminalTool`），
 * 因为同一个 server 会服务多个标签页。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
/**
 * 用高层的 `McpServer`（SDK 推荐 API）：工具由 `registerTool` 声明，`tools/list` 的
 * JSON Schema 与 `tools/call` 的入参校验都取自**同一份 zod 形状**，不会出现「模型看到
 * 一份 schema、执行时按另一份」的漂移。
 *
 * ⚠️ 代价：`server/mcp.js` 静态引 `zod-to-json-schema` + `zod/v4-mini`，渲染端产物里多出
 * 一整条 zod 依赖链。为了四个终端工具认这笔账（见 `TOOL_SCHEMAS`），但别把它当通用通道。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { z } from 'zod'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ClientToolSpec } from '@fizz/contracts/agent-api'
import {
  getActiveTerminalTabKey,
  kindLabel,
  listTerminals,
  resolveTerminal,
  type TerminalHandle
} from '@fizz/agent-kit/shared/lib/terminal/terminal-registry'
import { waitForNewOutput, waitForOutputToSettle } from '@fizz/agent-kit/shared/lib/terminal/output-settle'
// 「没输出」的回执文案与渲染端共用（那边靠它认出「这句是给模型的、别显示」）
import {
  TERMINAL_EMPTY,
  TERMINAL_NO_OUTPUT
} from '@fizz/agent-kit/shared/lib/terminal/display'

/** 去掉 ANSI 转义序列，让模型拿到纯文本（xterm 缓冲里带颜色 / 光标控制） */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC
    .replace(/\u001b[@-Z\\-_]/g, '') // 两字节转义
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

/** 把语义化按键翻译成终端控制字节（与 dogi 的 translateKeys 同一套写法） */
export function translateKeys(keys: string): string {
  return keys
    .replace(/C-([a-zA-Z])/g, (_m, c: string) =>
      String.fromCharCode(c.toUpperCase().charCodeAt(0) & 0x1f)
    )
    .replace(/Escape/gi, '\u001b')
    .replace(/Enter|Return/gi, '\r')
    .replace(/\r?\n/g, '\r')
}

const DEFAULT_WAIT_MS = 10_000
/**
 * 单次调用的等待上限。
 *
 * **必须小于服务端的 `CLIENT_TOOL_TIMEOUT_MS`（60s，见 `apps/server/src/server/client-tool-gate.ts`）**：
 * 客户端工具是「服务端挂起 → 客户端回填」的，超过那个闸门就直接按调用超时收场，
 * 我们精心攒的那段输出一个字都回不去。45s 留 15s 给读缓冲 / 回填。
 */
const MAX_WAIT_MS = 45_000
const DEFAULT_READ_CHARS = 4000
/**
 * 输出安静多久算「这条命令跑完了」。
 *
 * - 前 5 秒用 600ms：比 shell 回显 → 输出 → 提示符之间的正常间隔宽，又不至于让 `ls`
 *   这种命令白等；
 * - 跑过 5 秒就是长任务了，改成 2 秒：构建 / 安装 / 编译本来就一顿一顿地打日志，
 *   一两秒的间隙是常态，还按 600ms 判会「提前收工」，模型只好反复 `read_terminal_output`
 *   （用户看到的「快速不停地读取」）。
 *
 * 判据只有「安静」这一条（不猜提示符，见 `output-settle.ts` 的说明），所以它始终是
 * **上限**意义上的启发式：中途停顿超过窗口的长命令会提前返回，工具说明里让模型看末尾
 * 有没有提示符。
 */
const SHORT_IDLE_MS = 600
const LONG_IDLE_MS = 2_000
const LONG_AFTER_MS = 5_000
/** 已等待多久 → 这一刻用哪个安静窗口（传给 `waitForOutputToSettle` 的 `idleMs`） */
const idleWindow = (elapsedMs: number): number =>
  elapsedMs >= LONG_AFTER_MS ? LONG_IDLE_MS : SHORT_IDLE_MS
/**
 * `read_terminal_output` 的默认等待上限。
 *
 * 它以前是「立刻返回当前缓冲」，模型为了等一条长命令只好**疯狂连读**（每次几十毫秒，
 * 一轮几十次），既刷屏又费 token。现在它会**等新输出出现**：命令还在跑时用它等，
 * 一次调用拿一段，别连着调。
 */
const DEFAULT_READ_WAIT_MS = 20_000
/**
 * `read_terminal_output` 第一阶段的耐心：这么久还没新输出就先返回。
 *
 * 「看一眼当前屏幕」（查交互式程序 / 确认提示符）是它的常见用法，不能因为终端本来
 * 就不动而干等满 `waitMs`。
 */
const FIRST_OUTPUT_MS = 8_000
/** 单次回给模型的增量上限：长任务的日志可以几十万字符，整段塞进去会把上下文撑爆 */
const MAX_DELTA_CHARS = 12_000

/** 每次调用的绑定上下文：本轮绑定哪个终端（由发起请求的标签页决定） */
let boundTabKey: string | null = null

/** 设置本轮绑定（发请求前调用；`null` = 不绑定，工具回落到「当前被看着的那条」） */
export function setBoundTerminal(tabKey: string | null): void {
  boundTabKey = tabKey
}

function requireTerminal(explicit?: string): TerminalHandle {
  const handle = resolveTerminal(boundTabKey, explicit)
  if (!handle) {
    throw new Error('当前没有可用的终端会话（请先打开一个终端标签）')
  }
  return handle
}

// ---------------------------------------------------------------------------
// 串行化：同一条终端上的工具调用必须排队
// ---------------------------------------------------------------------------

/**
 * 每条终端一条 FIFO 队列：落到同一条终端上的工具调用按**到达顺序**依次执行。
 *
 * ## 为什么必须串行
 *
 * 模型**一次可以并发下发多个工具调用**，这不是异常而是常态：AI SDK 在同一个 step 里用
 * `Promise.all` 并行执行同批 tool-call，客户端又是「帧到就派出去」（`client-tools.ts`
 * 的 `handleClientToolCall` 不 await，见 `assistant.ts` 的分发点）。于是「A 命令还没跑完、
 * B 命令已经写进去」必然会发生。
 *
 * 而 `runInTerminal` 取增量靠的是**字符长度快照**（执行前记 `before` → 写命令 → 等 → 读
 * 全量再 `slice(before - 200)`）。两条命令交错时，两边的 `before` / `after` 互相污染，
 * 结果就是两边都读到对方的输出（用户看到的「终端输出有些乱」）；`read_terminal_output`
 * 插在命令执行中途同样只能读到半截。所以串行化是**正确性要求**，不是优化。
 *
 * ## 为什么按终端分组，而不是全局一条
 *
 * 不同终端的缓冲互不相干，一条长命令不该把另一条终端上的读操作也堵住。分组 key 取
 * **解析出的 tabKey**（见 `targetKeyOf`），不是入参原文 —— 显式 sessionId 与本轮绑定
 * key 可能写法不同却指向同一条终端。
 *
 * 注意：队列只保证「同一终端上的调用不交错」。不同终端之间仍然并行，这是刻意的。
 */
const tails = new Map<string, Promise<void>>()

/** 把 task 挂到 `key` 那条队列的队尾（`key` 由调用方在**收到调用时**同步算好） */
function serializeOn<T>(key: string, task: () => Promise<T> | T): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  // 前一个失败也要接着跑，所以两个分支都接同一个 task（队列不会因一次报错卡死）
  const run = prev.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  tails.set(key, tail)
  void tail.then(() => {
    // 只有自己仍是队尾时才清（期间可能已经排了新任务）
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}

/**
 * 一次调用实际会落到哪条终端上 —— 队列分组的 key。
 *
 * 先按 `resolveTerminal` 的优先级解析出真正的 handle 再取 `tabKey`：显式 sessionId 与
 * 本轮绑定 key 可能写法不同却指向同一条终端，按入参原文分组会把它们拆成两条队列，
 * 串行就白做了。终端不存在时（这次调用马上会以「没有可用终端」失败）退回显式 / 绑定
 * key，仅作分组兜底。
 */
function targetKeyOf(input: Record<string, unknown>): string {
  const explicit =
    typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : undefined
  return (
    resolveTerminal(boundTabKey, explicit)?.tabKey ??
    explicit ??
    boundTabKey ??
    getActiveTerminalTabKey() ??
    '（未绑定终端）'
  )
}

/**
 * 需要按终端串行的工具：它们**读写某条终端的缓冲 / 输入**。
 *
 * `list_terminal_sessions` 不在里面 —— 它只列清单，不碰缓冲，排队只会平白加延迟。
 * 新增工具时若它会读写终端，**必须**登记进来。
 */
const SERIALIZED_TOOLS = new Set(['run_in_terminal', 'read_terminal_output', 'send_keys'])

// ---------------------------------------------------------------------------
// 工具实现（纯函数：入参 → 文本结果）
// ---------------------------------------------------------------------------

/**
 * 在绑定的终端里执行一条命令，**等输出安静下来**（或到 waitMs 上限）后返回这段新增输出。
 *
 * 从前是 `sleep(waitMs)` 硬等：`ls` 这种几十毫秒就完的命令白等 3 秒，而长命令又只能拿到
 * 半截。现在改成「安静了就返回」——快命令约 0.6 秒返回，长命令只要中途不停顿也会在
 * 跑完的那一刻返回（`waitMs` 从「等多久」变成「最多等多久」）。
 *
 * 「安静」的窗口**随已等待时长放大**（`idleWindow`）：前 5 秒 600ms 保灵敏度，之后 2 秒
 * 避免长任务的正常停顿被误判成「跑完了」—— 误判的代价是模型转头去连读 `read_terminal_output`。
 *
 * ⚠️ 三处依赖，别改坏：
 * 1. 增量靠 `outputOffset` / `readSince`（渲染端的原始输出环形缓冲）—— **不能**改成
 *    「执行前后比 xterm 缓冲长度」：滚动缓冲只有 1000 行，长任务几秒就顶满，长度不再增长，
 *    做差出来的是碎片甚至空串，模型会以为没输出然后连读；
 * 2. **只有在同一终端上不与其它调用交错时**增量才不串味 —— 由 `SERIALIZED_TOOLS` 的队列
 *    保证，别绕过 `CallToolRequestSchema` 直接调这个函数；
 * 3. 安静判定靠 `outputSeq` / `lastOutputAt`（登记表提供），**必须在本轮写入之前取基线** ——
 *    写进去之后 shell 会先回显命令，那次回显本身就是一段输出。
 */
async function runInTerminal(input: {
  command: string
  sessionId?: string
  waitMs?: number
}): Promise<string> {
  const handle = requireTerminal(input.sessionId)
  if (!handle.isAlive()) throw new Error('目标终端已退出，无法执行命令')
  const maxMs = Math.min(input.waitMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS)
  // 基线：seq 判「安静了没有」，offset 取「之后的新输出」（**不能**用缓冲长度，见 registry 注释）
  const baselineSeq = handle.outputSeq()
  const baselineOffset = handle.outputOffset()
  const command = input.command.endsWith('\n') ? input.command : `${input.command}\r`
  handle.write(command)
  const settled = await waitForOutputToSettle(handle, baselineSeq, {
    idleMs: idleWindow,
    maxMs
  })
  const { text, truncated } = handle.readSince(baselineOffset)
  if (!text.trim()) return TERMINAL_NO_OUTPUT
  const delta = formatDelta(text, truncated)
  // 到上限还在往外吐：别让模型把半截输出当成「跑完了」
  return settled === 'timeout'
    ? `${delta}\n（注：到 waitMs 上限（${Math.round(maxMs / 1000)} 秒）时输出还没安静下来，命令可能仍在运行；再用 read_terminal_output 等下一段，别连续快速调用）`
    : delta
}

function listTerminalSessions(): string {
  const all = listTerminals()
  if (all.length === 0) return '当前没有打开任何终端会话。'
  const active = getActiveTerminalTabKey()
  const lines = all.map((t) => {
    const marks = [
      t.tabKey === boundTabKey ? '本轮绑定' : '',
      t.tabKey === active ? '正在看着' : '',
      t.isAlive() ? '' : '已退出'
    ].filter(Boolean)
    return `- ${t.tabKey} · ${t.title} · ${kindLabel(t.kind)}${marks.length ? `（${marks.join('，')}）` : ''}`
  })
  return ['当前打开的终端会话：', ...lines].join('\n')
}

/** 增量过长时只留尾部：长任务的日志几十万字符，整段塞回上下文没有意义 */
function clipDelta(text: string): string {
  if (text.length <= MAX_DELTA_CHARS) return text
  return `（本次输出较长，只保留最后 ${MAX_DELTA_CHARS} 字符）\n…${text.slice(text.length - MAX_DELTA_CHARS)}`
}

/** 一段增量 + 必要的「被截断」说明（过长 / 起点已滚出环形缓冲） */
function formatDelta(text: string, truncated: boolean): string {
  const clipped = clipDelta(text.trimEnd())
  return truncated
    ? `（这段输出很长，更早的部分已经滚出缓冲，只能拿到最近的）\n${clipped}`
    : clipped
}

/**
 * 读终端输出 —— **会等**，不是「拍一张就走」。
 *
 * 为什么必须等：它从前是立刻返回当前缓冲，模型为了盯一条长命令只能**连读**（每次几十
 * 毫秒，一轮几十次），用户看到的就是「快速不停地读取」。现在分两段：
 *
 * 1. 先等**新输出出现**，最多 `FIRST_OUTPUT_MS`：终端本来就不动（命令早跑完 / 只想看
 *    一眼屏幕）时不会干等满 `waitMs`，等一小会儿就按「没有新输出」返回；
 * 2. 有新输出后，再等它**安静下来**（或到 `waitMs` 上限），把这一段一起带回去。
 *
 * `waitMs: 0` = 立刻返回当前屏幕（明确的「就看一眼」）。
 */
async function readTerminalOutput(input: {
  sessionId?: string
  maxChars?: number
  waitMs?: number
}): Promise<string> {
  const handle = requireTerminal(input.sessionId)
  const maxChars = input.maxChars ?? DEFAULT_READ_CHARS
  const tail = (): string => {
    const text = handle.read(maxChars)
    return text.trim() ? text : TERMINAL_EMPTY
  }
  const waitMs = Math.min(Math.max(0, input.waitMs ?? DEFAULT_READ_WAIT_MS), MAX_WAIT_MS)
  if (waitMs <= 0) return tail()

  const baselineSeq = handle.outputSeq()
  const baselineOffset = handle.outputOffset()
  const deadline = Date.now() + waitMs
  const appeared = await waitForNewOutput(handle, baselineSeq, {
    maxMs: Math.min(FIRST_OUTPUT_MS, waitMs)
  })
  if (!appeared) {
    return (
      `（等了约 ${Math.round(Math.min(FIRST_OUTPUT_MS, waitMs) / 1000)} 秒没有新输出：命令可能仍在运行但暂时没打印，也可能已经跑完。\n` +
      '**不要连续调用本工具**：确实只想看当前屏幕就传 waitMs: 0，要等长命令就再调一次让它继续等。）\n\n' +
      tail()
    )
  }
  const settled = await waitForOutputToSettle(handle, baselineSeq, {
    idleMs: idleWindow,
    maxMs: Math.max(0, deadline - Date.now())
  })
  const { text, truncated } = handle.readSince(baselineOffset)
  if (!text.trim()) return tail()
  const delta = formatDelta(text, truncated)
  return settled === 'timeout'
    ? `${delta}\n（注：到 waitMs 上限时输出还没安静下来，命令可能仍在运行；可以再调一次继续等）`
    : delta
}

function sendKeys(input: { keys: string; sessionId?: string }): string {
  const handle = requireTerminal(input.sessionId)
  if (!handle.isAlive()) throw new Error('目标终端已退出，无法发送按键')
  handle.write(translateKeys(input.keys))
  return `已向 ${handle.tabKey} 发送按键：${JSON.stringify(input.keys)}`
}

/**
 * 工具清单：**zod 形状是唯一真源**。
 *
 * `tools/list` 的 JSON Schema 由 SDK 从这里反推（`zod/v4-mini` 的 `toJSONSchema`），
 * `tools/call` 的入参也按同一份 schema 校验 —— 参数说明写在 `.describe()` 里，**别在别处
 * 再抄一份 `inputSchema` 常量**：两份迟早对不上（模型看到 A、校验用 B，且不报错）。
 *
 * `.describe()` 的文案就是模型读到的参数说明，「默认值 / 上限 / 什么时候别调」这类会直接
 * 影响它怎么用工具的约束必须写进去，别只写「目标终端 id」这种名字级别的废话。
 */
const TOOL_SCHEMAS = {
  list_terminal_sessions: {
    description: '列出当前打开的所有终端会话（本机终端与 SSH 主机终端）。',
    shape: {}
  },
  run_in_terminal: {
    description:
      '在终端会话中执行一条命令（等同于用户在键盘上输入并回车），返回本次命令的新增输出（不含历史内容）。**输出一停下来就返回**（安静约 0.6 秒即认为停了；命令跑过 5 秒后按 2 秒算，避免长任务一顿一顿的日志被误判成结束），最多等 waitMs（默认 10 秒）—— 所以快命令很快返回，长命令会在跑完的那一刻返回。未指定 sessionId 时使用当前绑定的终端。同一条终端上的调用按到达顺序串行执行，输出不会与其它调用交错。⚠️ 「安静」不等于「跑完」：返回的输出末尾若有 shell 提示符说明命令已执行完；若没有，说明命令可能仍在运行（或中途停顿了一下）或进入了交互式程序（如 vim / top / less）—— 不要据此继续输入新命令；要等长任务跑完，用 read_terminal_output 一次等一段（它会自己等，**不要连续快速调用**），交互式程序用 send_keys 退出。',
    shape: {
      command: z.string().describe('要执行的命令，无需附加换行符'),
      sessionId: z
        .string()
        .optional()
        .describe('目标终端会话 id（即标签 key），缺省为当前绑定的终端'),
      waitMs: z
        .number()
        .optional()
        .describe(
          '**等待上限**毫秒数，默认 10000（不是固定等待：输出安静下来会提前返回）。已知是长耗时命令（构建 / 安装 / 测试）可以加大，最大 45000'
        )
    }
  },
  read_terminal_output: {
    description:
      '读取终端会话的输出。**它会等**：先等新输出出现（最多 8 秒），有新输出就继续等它安静下来，然后把这一段增量返回（最多 waitMs，默认 20 秒）。命令还在跑时用它「等下一段」，**一次调用就够，不要连续快速调用**（每次调用本身就会等）。只想立刻看一眼当前屏幕（确认提示符 / 交互式程序状态）时传 waitMs: 0。',
    shape: {
      sessionId: z.string().optional().describe('目标终端会话 id，缺省为当前绑定的终端'),
      maxChars: z
        .number()
        .optional()
        .describe('最多返回字符数，默认 4000（waitMs: 0 时看当前屏幕用）'),
      waitMs: z
        .number()
        .optional()
        .describe('等待上限毫秒数，默认 20000；0 = 立刻返回当前屏幕（不等新输出）；最大 45000')
    }
  },
  send_keys: {
    description:
      '向终端发送按键或控制序列（不会自动回车）。主要用于退出交互式 / 前台程序：发送 "q" 退出 htop/less/man，发送 "C-c" 发送 Ctrl-C，发送 "C-d" 发送 Ctrl-D。',
    shape: {
      keys: z
        .string()
        .describe(
          "要发送的按键序列。普通字符直接写（如 'q'、'exit'）；控制键写法 'C-c'、'C-d'、'Escape'；回车用 'Enter'。"
        ),
      sessionId: z.string().optional().describe('目标终端会话 id，缺省为当前绑定的终端')
    }
  }
} satisfies Record<string, { description: string; shape: ZodRawShapeCompat }>

/** 工具名（注册、分派、串行集合都从这一份字面量派生） */
type TerminalToolName = keyof typeof TOOL_SCHEMAS

/** 工具名 → 实现。键必须与 `TOOL_SCHEMAS` 一一对应：漏一个编译期就报错 */
const IMPLEMENTATIONS: Record<
  TerminalToolName,
  (input: Record<string, unknown>) => Promise<string> | string
> = {
  list_terminal_sessions: () => listTerminalSessions(),
  read_terminal_output: (input) =>
    readTerminalOutput(input as { sessionId?: string; maxChars?: number; waitMs?: number }),
  run_in_terminal: (input) =>
    runInTerminal(input as { command: string; sessionId?: string; waitMs?: number }),
  send_keys: (input) => sendKeys(input as { keys: string; sessionId?: string })
}

/**
 * 分派一次工具调用：同终端串行 + 异常直接抛（`McpServer` 会把 message 包成 `isError` 结果）。
 *
 * ⚠️ `serializeOn` 必须**同步**入队（中间不许 `await`）：入队顺序就是调用到达顺序，晚一步
 * 算 key 就可能排到别的调用后面（见 `serializeOn` 的注释）。`McpServer` 在回调之前会先
 * `await` 一次入参校验，四条工具走的是同一条校验路径、到达顺序仍然保持 —— 但**别在这条
 * 路径上加「按工具分支」的异步前置步骤**，那会打乱这个前提。
 */
function dispatch(
  name: TerminalToolName,
  input: Record<string, unknown>
): Promise<string> | string {
  const impl = IMPLEMENTATIONS[name]
  return SERIALIZED_TOOLS.has(name) ? serializeOn(targetKeyOf(input), () => impl(input)) : impl(input)
}

/**
 * 会**改动终端状态**的工具 —— 上送服务端时按 `mutating` 标记，服务端据此套审批闸
 * （`readonly` 拒 / `confirm` 问 / `full` 放行，见 server 的 `client-tool-gate.ts`）。
 *
 * 只读的两个（`list_terminal_sessions` / `read_terminal_output`）**刻意不在名单里**：
 * 把「看一眼日志」也变成一次审批，用户很快就会学会无脑点允许，那才是真的没有闸。
 *
 * 新增工具时**默认按改动类处理**（除非它确实只读）—— 漏标一个 = 它悄悄绕过审批。
 */
const MUTATING_TOOLS = new Set(['run_in_terminal', 'send_keys'])

// ---------------------------------------------------------------------------
// MCP server（懒创建，进程内一条）
// ---------------------------------------------------------------------------

interface TerminalMcp {
  listTools(): Promise<ClientToolSpec[]>
  callTool(name: string, input: Record<string, unknown>): Promise<string>
}

let mcpPromise: Promise<TerminalMcp> | null = null

async function createTerminalMcp(): Promise<TerminalMcp> {
  const server = new McpServer({ name: 'fizz-terminal', version: '0.1.0' })
  /**
   * 注册顺序 = `tools/list` 的返回顺序（`list_terminal_sessions` 排最前：模型先看到清单再动手）。
   *
   * 入参校验交给 SDK：`inputSchema` 传 zod raw shape，`McpServer` 包成 `z.object(...)` 并在
   * 回调前 `safeParse` —— 模型多给的字段被剥掉、类型不对直接回 `isError`（从前是原样塞进
   * 各实现的 `as` 硬转，错了要到终端里才炸）。回调里抛的异常也由它包成 `isError` 结果。
   */
  for (const [name, def] of Object.entries(TOOL_SCHEMAS)) {
    server.registerTool(
      name,
      { description: def.description, inputSchema: def.shape },
      async (args: Record<string, unknown>) => {
        const text = await dispatch(name as TerminalToolName, args)
        return { content: [{ type: 'text' as const, text }] }
      }
    )
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'fizz-terminal-client', version: '0.1.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    listTools: async () => {
      const { tools } = await client.listTools()
      return tools.map((t) => {
        /**
         * SDK 从 zod 反推的 schema 会带一个 `$schema` 版本声明 —— 那是「用哪套 zod 生成的」
         * 的副作用，不是模型要的信息。上送前摘掉，`ClientToolSpec.inputSchema` 保持纯 draft 子集。
         */
        const inputSchema = { ...(t.inputSchema as Record<string, unknown> | undefined) }
        delete inputSchema.$schema
        return {
          name: t.name,
          description: t.description ?? t.name,
          ...(Object.keys(inputSchema).length ? { inputSchema } : {}),
          // 改动类工具带 `mutating`：服务端据此套审批闸（只读的不带 = 原样直通）
          ...(MUTATING_TOOLS.has(t.name) ? { mutating: true } : {})
        }
      })
    },
    callTool: async (name, input) => {
      const result = await client.callTool({ name, arguments: input })
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n')
      if (result.isError) throw new Error(text || '终端工具执行失败')
      return text || '（无输出）'
    }
  }
}

function getMcp(): Promise<TerminalMcp> {
  if (!mcpPromise) mcpPromise = createTerminalMcp()
  return mcpPromise
}

/**
 * 取终端工具的**声明**，用于随请求上送服务端。
 *
 * `boundTabKey` 同时记进模块态（工具执行时要用它解析目标）—— 上送与执行必须是同一轮，
 * 所以调用方（客户端工具 broker）在**发请求前**调这个函数。
 */
export async function listTerminalToolSpecs(tabKey: string | null): Promise<ClientToolSpec[]> {
  setBoundTerminal(tabKey)
  const mcp = await getMcp()
  return mcp.listTools()
}

/** 执行一个终端工具（服务端推来 `client-tool-call` 帧时调） */
export async function callTerminalTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const mcp = await getMcp()
  return mcp.callTool(name, input)
}

/** 这些是不是终端工具（broker 据此决定要不要交给终端 MCP 执行） */
export const TERMINAL_TOOL_NAMES = new Set(Object.keys(IMPLEMENTATIONS))
