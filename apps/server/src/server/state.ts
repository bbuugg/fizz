/**
 * 服务端共享状态：数据存储 / 领域对象 / 进行中对话 / 等待审批 / 等待提问。
 *
 * 各路由模块从此处导入，保证整应用只有一份 store / domain / 时钟类状态，
 * 不散落在单个路由文件里。
 *
 * ⚠️ **跨加载器单例**：`server.mjs` 由 tsx 加载，Next.js Route Handlers 由
 * Turbopack 加载，两者有各自独立的模块缓存。如果直接 `export const store = ...`，
 * 会产生两份互不可见的实例（TOKEN 不一致、triggerDomain 数据不同步 → WS 404）。
 * 所以这里把全部有状态的对象挂到 `globalThis.__FIZZ_STATE__` 上，
 * 第一次加载时初始化，后续加载复用同一份 —— 无论哪个加载器先到。
 */
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { AgentDomain, JsonStore, TriggerDomain, type CoreData } from '@fizz/workspace'
import { setLanguage } from '@fizz/i18n'
import { loadEnvFile, type EnvFileResult } from '@fizz/workspace'
import type { AgentChatMessage, AskFollowupAnswer, ServerEvent } from '@fizz/contracts/types'
import type { ChatRun } from './chat-run'

// ---------------------------------------------------------------------------
// globalThis 单例：第一次加载（无论 tsx 还是 Turbopack）初始化，之后复用
// ---------------------------------------------------------------------------

interface FizzState {
  envFile: EnvFileResult | null
  stateBus: EventEmitter
  eventBus: EventEmitter
  store: JsonStore
  domain: AgentDomain
  triggerDomain: TriggerDomain
  /**
   * 项目管理助手的会话存储(跨项目的轻量对话,不进会话树 / state-ws)。
   * 与 chatRuns 同理挂 globalThis:assistant-turn 在 Route Handler(Turbopack)里调,
   * REST 路由也在 Turbopack 侧,单例保证同进程一份索引。
   */
  /**
   * 对话 run 注册表（见 `chat-run.ts`：那里的 Map 不能是模块级 ——
   * run 由 Route Handler 建、却被 tsx 侧的状态 WS 读，两份缓存互不可见）。
   *
   * 这里用 type-only 的 `ChatRun` 反向引用 `chat-run.ts`，编译期擦除，不构成运行时循环。
   */
  chatRuns: {
    /** requestId → run */
    runs: Map<string, ChatRun>
    /** conversationId → requestId（同一会话同时只跑一轮） */
    activeByConversation: Map<string, string>
    /** requestId → finishRun 时要 resolve 的那个函数 */
    doneResolves: Map<string, () => void>
  }
  /**
   * ACP 会话的**进程内视图快照**：conversationId → 已折叠好的消息。
   *
   * ACP 的历史在 agent 侧、本地不落盘，但「刷新时这一轮还在跑」不能去 `session/load`
   * —— 那个入口会 teardown 掉正在跑的子进程。所以每轮开始 / 收尾时把用户消息与
   * 助手消息同步进这份内存快照，跑动中的刷新只读它 + attach 帧日志，不碰 agent 进程。
   * 空闲时的刷新仍以 `session/load` 为准，并顺手用它重建这份快照。
   *
   * 与 `chatRuns` 一样挂 globalThis：run 由 Route Handler 建、状态 WS 由 tsx 读。
   */
  acpTranscripts: Map<string, AgentChatMessage[]>
  token: string
  pendingConfirms: Map<
    string,
    {
      requestId: string
      resolve: (reply: { approved: boolean; optionId?: string }) => void
      timer?: NodeJS.Timeout
    }
  >
  pendingFollowups: Map<string, { requestId: string; resolve: (answer: AskFollowupAnswer | null) => void }>
  /**
   * 挂起等**客户端执行**的客户端工具调用：callId → 该轮 requestId + 解铃回调。
   *
   * 与 `pendingConfirms` / `pendingFollowups` 同构 —— 客户端工具也是「服务端推一帧、
   * 客户端另开一条 HTTP 回填」的反向通道（见 `client-tool-gate.ts`）。
   */
  pendingClientTools: Map<
    string,
    {
      requestId: string
      resolve: (payload: { ok: boolean; result?: unknown; error?: string }) => void
    }
  >
}

const GLOBAL_KEY = '__FIZZ_STATE__'

async function getState(): Promise<FizzState> {
  // 已初始化：直接复用（tsx / Turbopack 谁后到都走这里）
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as FizzState | undefined
  if (existing) return existing

  // ---------- 第一次加载：初始化全部共享状态 ----------

  /**
   * 读 `.env`（Node 不会自动读，见 `@fizz/workspace` 的 env.ts）。
   * 候选顺序：当前工作目录 → 仓库根；**真实环境变量优先于文件**。
   *
   * ⚠️ 不再用 `import.meta.url` 推导 `__dirname`：Turbopack 打包后该值不可靠。
   * Next.js 自定义 server 始终从项目根（= 仓库根）启动，`process.cwd()` 即可。
   */
  const envFile = loadEnvFile([
    process.cwd(),
    join(process.cwd(), '..')
  ])

  /**
   * 状态变更总线：服务端任何「可被前端轮询到」的数据变化都往这里 emit `'dirty'`，
   * 由 `server/state-ws.ts` 收下、去重、批量把新快照推给所有前端（见那里的说明）。
   * 这是「全局一条 WS 推送」的关键：前端不再轮询，服务端改了就推。
   */
  const stateBus = new EventEmitter()

  /**
   * 瞬时事件总线：与上面的 `stateBus` 是**一对互补的通道**。
   *
   * - `stateBus` 的 `'dirty'` = 「某个域的数据变了」，前端去取新快照（状态，幂等，错过没事）；
   * - `eventBus` 的 `'event'` = 「刚刚发生了这件事」，前端立刻反应（通知、角标）。
   *
   * 为什么事件也要挂 globalThis：事件的**产生方**是 Route Handlers（Turbopack），
   * **消费方**是 `server/state-ws.ts`（tsx）。两个加载器模块缓存不通，只有挂上去
   * 才收得到。同理，`eventBus` 只在 state-ws 里挂**一个**监听器。
   */
  const eventBus = new EventEmitter()

  /**
   * 这些快照全部直接读自 `domain` / `triggerDomain`（同一份 JsonStore），所以任意一次
   * `store.mutate` 都会让它们全部失效 —— 一并标脏最省事，推送时再各自重算。
   */
  const STORE_KEYS = [
    'health',
    'models',
    'acpAgents',
    'mcpServers',
    'sshHosts',
    'hostGroups',
    'sshTunnels',
    'apiRequests',
    'apiGroups',
    'apiHistory',
    'scripts',
    'scriptGroups',
    'notesRoots',
    'workspaces',
    'conversations',
    'skills',
    'taskTriggers',
    // 容器型项目的「有哪些项目 / 各自的配置」也在这份 store 里（`AgentWorkspace.container`）：
    // 新建 / 改名 / 换镜像 / 删项目都会动它，所以一并标脏，前端不必等下一次轮询
    'containerProjects',
    // 客户端偏好（`CoreData.prefs`）：`POST /api/prefs` 改一个 key 就要让所有端看到
    'prefs'
  ] as const

  /**
   * 把 `JsonStore` 包一层 Proxy：每次 `mutate` 落地后自动 `markDirty(STORE_KEYS)`。
   * 这样所有经领域对象（`AgentDomain` / `TriggerDomain`）的写入都会触发前端状态推送，
   * 而不用在每个路由里手动标记。读（`snapshot` / `dataDir`）原样转发。
   */
  function makeLiveStore(base: JsonStore, onChange: () => void): JsonStore {
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'mutate') {
          return (fn: (data: CoreData) => void): CoreData => {
            const result = target.mutate(fn)
            onChange()
            return result
          }
        }
        return Reflect.get(target, prop, receiver)
      }
    }) as unknown as JsonStore
  }

  const store = makeLiveStore(await JsonStore.open(), () => stateBus.emit('dirty', STORE_KEYS))
  const domain = new AgentDomain(store)
  /**
   * 工具描述 / 系统提示词按界面语言生成：进程启动时先把语言同步进 i18n 单例，
   * 之后设置页改动由 `/api/system/language` 的 POST 再同步一次。
   */
  setLanguage(domain.getLanguage())
  /**
   * 定时任务领域（cron / 一次性规则）。
   *
   * 与 `domain` 共用同一个 store，但**刻意分成两个实例**：这一套与「工作区 / 会话 / 模型」
   * 在概念上并列、互不依赖（见 `packages/workspace/src/trigger-domain.ts` 的说明）。
   */
  const triggerDomain = new TriggerDomain(store)

  /** 容器回连宿主机的事件回传用的固定 token：随机生成、挂到 globalThis 固定下来（不依赖环境变量） */
  const token = randomBytes(24).toString('base64url')

  /**
   * 等待用户答复的审批：审批 id → 该轮的 requestId + 解铃回调。
   *
   * 一轮对话本身（中止器 / 帧日志 / 订阅者）在 `chat-run.ts` 里，不在这里 ——
   * 那份状态是「跟着 run 走」的，粒度比这里的 map 粗一层。
   * 审批是**一轮对话里的多次**（每条破坏性命令一次），所以粒度细一层；
   * `requestId` 只用来在整轮结束/中止时把它们一起清掉。
   */
  const pendingConfirms = new Map<
    string,
    {
      requestId: string
      resolve: (reply: { approved: boolean; optionId?: string }) => void
      /** 超时定时器（confirmTimeoutMs > 0 时才有）：解铃时要清掉 */
      timer?: NodeJS.Timeout
    }
  >()

  /**
   * 等待用户答复的 ask 提问：提问 id → 该轮的 requestId + 解铃回调。
   * 与 `pendingConfirms` 同构，但答复体是 `AskFollowupAnswer | null`（null = 跳过）。
   */
  const pendingFollowups = new Map<
    string,
    {
      requestId: string
      resolve: (answer: AskFollowupAnswer | null) => void
    }
  >()

  /**
   * 挂起等客户端执行的客户端工具调用（见 `client-tool-gate.ts`）。
   * 粒度与 `pendingConfirms` 一样是「一轮里的多次」—— 模型可能连着调好几个客户端工具。
   */
  const pendingClientTools = new Map<
    string,
    {
      requestId: string
      resolve: (payload: { ok: boolean; result?: unknown; error?: string }) => void
    }
  >()

  const state: FizzState = {
    envFile,
    stateBus,
    eventBus,
    chatRuns: {
      runs: new Map(),
      activeByConversation: new Map(),
      doneResolves: new Map()
    },
    acpTranscripts: new Map(),
    store,
    domain,
    triggerDomain,
    token,
    pendingConfirms,
    pendingFollowups,
    pendingClientTools
  }
  ;(globalThis as Record<string, unknown>)[GLOBAL_KEY] = state
  return state
}

const _state = await getState()

// ---------------------------------------------------------------------------
// 对外导出：全部从 globalThis 单例取，保证跨加载器一致
// ---------------------------------------------------------------------------

export const ENV_FILE = _state.envFile
export const stateBus = _state.stateBus

/** 瞬时事件总线（见上面 `eventBus` 的说明）：广播「刚刚发生了什么」 */
export const eventBus = _state.eventBus

/** 广播一条瞬时事件（`server/state-ws.ts` 收下后推给所有前端连接） */
export function emitServerEvent(event: ServerEvent): void {
  _state.eventBus.emit('event', event)
}

/** 对话 run 注册表（跨加载器共享，见 `FizzState.chatRuns` 的说明） */
export const chatRuns = _state.chatRuns

/** ACP 会话的进程内视图快照（见 `FizzState.acpTranscripts` 的说明） */
export const acpTranscripts = _state.acpTranscripts

/**
 * 标记若干状态域「已变更」，需要推给前端。
 *
 * - store 支持的域（`domain` / `triggerDomain` 共用同一份 `JsonStore`）由 `makeLiveStore`
 *   在每次 `mutate` 后自动 `markDirty(STORE_KEYS)`，不用手动调；
 * - 不走 JsonStore 的域（流程项目走文件系统、docker 探测、模型探活）在各自的
 *   写入点手动 `markDirty([...])`。
 */
export function markDirty(keys: Iterable<string>): void {
  _state.stateBus.emit('dirty', keys)
}

/**
 * 这些快照全部直接读自 `domain` / `triggerDomain`（同一份 JsonStore），所以任意一次
 * `store.mutate` 都会让它们全部失效 —— 一并标脏最省事，推送时再各自重算。
 */
export const STORE_KEYS = [
  'health',
  'models',
  'acpAgents',
  'mcpServers',
  'sshHosts',
  'hostGroups',
  'sshTunnels',
  'workspaces',
  'conversations',
  'skills',
  'taskTriggers',
  'notesRoots',
  'containerProjects',
  // 客户端偏好：任何 `savePrefs` 都要推给所有端（见 `POST /api/prefs`）
  'prefs'
] as const

export const store = _state.store
export const domain = _state.domain
export const triggerDomain = _state.triggerDomain

/** 容器回连宿主机的事件回传用的固定 token（随机生成，见上方 `token`） */
export const TOKEN = _state.token

export const pendingConfirms = _state.pendingConfirms
export const pendingFollowups = _state.pendingFollowups
export const pendingClientTools = _state.pendingClientTools
