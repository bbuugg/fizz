/**
 * 全局状态推送的 WebSocket 端点：`/api/state`。
 *
 * 背景：前端原本用 `setInterval` 轮询一堆列表接口（`/api/models`、会话 / 工作区 /
 * MCP / 技能 / docker 探测……）。这里改成**服务端有变更就通过一条全局 WS 把最新快照
 * 推下来**，前端不再轮询。
 *
 * ## 推送形态
 *
 * 服务端把每个「域」的最新数据算成快照，整个推下去（用户选定的方案是「直接推数据快照」，
 * 不是只推「哪变了」再让前端重拉）。为保证与现有 GET 接口**完全一致**，每个 provider 直接
 * 复用对应路由里的计算逻辑（同样的 `domain.listX()` / `listProjects()` / …）。
 *
 * - 连接建立：**一次性**把所有「全局域」的快照随 `init` 消息下发，前端立刻有全量数据；
 * - 之后：服务端数据一变（`markDirty`），去重、批量把 `{ type:'snapshot', key, data }` 推给
 *   所有连接。
 *
 * ⚠️ 这里**没有「按 id 订阅」了**：那套机制只服务流程项目详情（`flowProject:<id>`），
 * 流程功能已整个删除。要加参数化域时再补 `sub` 协议，别顺手把 `clientSubs` 提前铺开。
 *
 * ## 除了快照，还有**瞬时事件**
 *
 * 对话这类「需要立刻反应」的事（开跑 / 等确认 / 等回答 / 跑完 → 发系统通知）不适合走
 * 快照：它不是某个域的新样子，而是**刚刚发生的一件事**。服务端在 `state.ts` 的 `eventBus`
 * 上 `emitServerEvent(...)`，这里原样转成 `{ type:'event', event }` 广播给所有连接。
 * 契约见 `@fizz/contracts/types` 的 `ServerEvent`。
 *
 * 两者是互补的：事件丢一次（断线）不影响正确性 —— 持续状态另有 `activeRuns` 快照兜底。
 *
 * ## 变更怎么被发现
 *
 * - `domain` / `triggerDomain` 共用同一份 `JsonStore`，已在 `state.ts` 里被 `makeLiveStore`
 *   包成「每次 `mutate` 自动 `markDirty(STORE_KEYS)`」；
 * - 不走 JsonStore 的（容器型项目的 docker 探测）在各自写入点手动 `markDirty`；
 * - docker 容器状态不在任何 store 里，靠 docker 事件流 + 一条**服务端内部**的低频兜底
 *   定时器（不是前端轮询！）比对后推。
 *
 * ⚠️ 鉴权同其它 WS：`?token=` 查询参数 + `timingSafeEqual`（浏览器 `WebSocket` 拿不到
 * 自定义请求头，只能走查询参数，见 `terminal/ws.ts`）。
 */
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { spawn } from 'node:child_process'
import { WebSocketServer, type WebSocket } from 'ws'
import type { GitStatus } from '@fizz/git'
import type { ServerEvent } from '@fizz/contracts/types'
import { listServerSkills } from './skill-roots'
import { acpAgentViews } from './acp-agent-views'
import { domain, eventBus, markDirty, stateBus, triggerDomain } from './state'
import { rejectSocket } from './lib/ws'
import { verifyWsToken } from './auth'
import { listActiveRuns } from './chat-run'
import { tunnelManager } from './ssh/tunnels'
import { containerProjectsSnapshot } from './container-projects/lifecycle'
import { onContainerImageBuildProgress } from './container-projects/image'
import { watchDockerEvents } from './lib/docker'

/** 全局域（连接即全量下发，之后有变更就推） */
const GLOBAL_KEYS = [
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
  'git',
  'activeRuns',
  /**
   * 容器型项目的运行态。
   *
   * docker 侧的变化（构建进度、容器起停）不在任何 store 里：
   * 构建进度走 `onContainerImageBuildProgress` 回调标脏，起停走 docker 事件流，
   * 再加一条低频兜底比对 —— 见文件末尾 `tickDocker`。
   */
  'containerProjects',
  /**
   * 客户端偏好（`CoreData.prefs`）。
   *
   * 为什么进全局域：`POST /api/prefs` 改完要**所有端**（桌面主窗口 / 设置窗口 / 手机 /
   * 另一个标签）立刻看到同一份，而不是各自读自己的 localStorage。快照不大（十几个字符串），
   * 但只在实际改动时推（`markDirty` 去重）。
   */
  'prefs'
] as const

type GlobalKey = (typeof GLOBAL_KEYS)[number]

/** 每个全局域的快照生产者（直接复用对应 GET 路由的计算） */
const GLOBAL_PROVIDERS: Record<GlobalKey, () => Promise<unknown>> = {
  health: buildHealth,
  models: async () => domain.listModels(),
  // 与 GET /api/acp/agents 同源：出口处补运行时探测的 `imageInput`（前端回形针闸门靠它）
  acpAgents: async () => acpAgentViews(domain.listAcpAgents()),
  mcpServers: async () => domain.listMcpServers(),
  sshHosts: async () => domain.listSshHosts(),
  /**
   * 主机分组（主机 / 终端共用的多级归类树）。
   *
   * 与 `sshHosts` 分开一条域：拖拽重排会同时动分组与主机的归属，但**分组本身**的
   * 增删改只影响这一条，没必要让主机列表跟着重算一遍（两者都很小，分开只是省一次）。
   */
  hostGroups: async () => domain.listHostGroups(),
  /**
   * 隧道：配置（落 store）+ 运行态（只在内存）。
   *
   * 配置走 store 的自动标脏（`STORE_KEYS` 里有它），运行态由隧道管理器在
   * 起停 / 连接数变化时 `markDirty(['sshTunnels'])` —— 所以连接数这种
   * 高频变化也不会额外打接口，只是让这条快照重算一次。
   */
  sshTunnels: async () => tunnelManager.snapshot(),
  apiRequests: async () => domain.listApiRequests(),
  apiGroups: async () => domain.listApiGroups(),
  apiHistory: async () => domain.listApiHistory(),
  scripts: async () => domain.listScripts(),
  scriptGroups: async () => domain.listScriptGroups(),
  /**
   * 笔记根目录（用户登记进来的任意文件夹）。
   *
   * 只是一份**登记清单**：笔记正文在磁盘上，不走快照 —— 所以「在别处改了笔记内容」
   * 不会推到前端，需要用户在侧栏点刷新、或在编辑器里点重新加载（见 `features/notes`）。
   */
  notesRoots: async () => domain.listNotesRoots(),
  workspaces: async () => domain.listWorkspaces(),
  conversations: async () => domain.listConversations(),
  skills: async () => listServerSkills(domain.listWorkspaces()[0]?.path),
  taskTriggers: async () => triggerDomain.listTriggers(),
  git: buildGitStatus,
  /**
   * 在跑的那些对话轮次。与 `emitServerEvent` 的瞬时事件是**一对**：
   * 事件管「立刻反应」，这份快照管「最终对得上」（事件断线期间会丢）。
   * 轮次开始 / 结束时对话路由会 `markDirty(['activeRuns'])`。
   */
  activeRuns: async () => listActiveRuns(),
  containerProjects: () => containerProjectsSnapshot(),
  /**
   * 客户端偏好：直接读 store 里那份（`domain.getPrefs()` 已经归一化过）。
   * 写入口只有 `POST /api/prefs`，落盘后由 `STORE_KEYS` 自动标脏。
   */
  prefs: async () => domain.getPrefs()
}

/** 概览：与 `app.ts` 的 `/api/health` 响应**逐字段一致** */
async function buildHealth(): Promise<{
  name: string
  version: string
  hasModels: boolean
  workspaceCount: number
  conversationCount: number
  skillCount: number
}> {
  const models = domain.listModels()
  const workspaces = domain.listWorkspaces()
  const conversations = domain.listConversations()
  const skills = await listServerSkills(workspaces[0]?.path)
  return {
    name: 'fizz-server',
    version: '0.0.26',
    hasModels: models.length > 0,
    workspaceCount: workspaces.length,
    conversationCount: conversations.length,
    skillCount: skills.skills.length
  }
}

// ---------------------------------------------------------------------------
// 客户端集合 + 订阅
// ---------------------------------------------------------------------------

/**
 * git 可用性探测：**服务端**机器上能不能跑 `git`（Fizz 的 git 操作、建 worktree
 * 都发生在服务端，所以缺 git 要在服务端装）。
 *
 * 见头注释：整个服务端进程只探测一次（git 不会在进程存活期间凭空出现 / 消失），
 * 用模块级 Promise 缓存，连接建立时读结果即可，不必每次重跑。
 */
let gitStatusCache: Promise<GitStatus> | null = null
function buildGitStatus(): Promise<GitStatus> {
  if (gitStatusCache) return gitStatusCache
  gitStatusCache = new Promise<GitStatus>((resolve) => {
    const child = spawn('git', ['--version'], { windowsHide: true })
    let out = ''
    let err = ''
    child.on('error', () =>
      resolve({ available: false, error: 'git 未安装或不在服务端的 PATH 中' })
    )
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ available: true, version: out.trim() || undefined })
      } else {
        resolve({ available: false, error: err.trim() || `git --version 退出码 ${code ?? '未知'}` })
      }
    })
  })
  return gitStatusCache
}

const wss = new WebSocketServer({ noServer: true })
/** 当前连着的客户端。所有域都是全局的，没有「按连接订阅」这回事 */
const clients = new Set<WebSocket>()

/** 算某个 key 的快照（只认 `GLOBAL_KEYS` 里的域） */
async function snapshotForKey(key: string): Promise<unknown> {
  const provider = (GLOBAL_PROVIDERS as Record<string, (() => Promise<unknown>) | undefined>)[key]
  if (!provider) return undefined
  return provider()
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // 发送失败（连接正在关）：忽略，close 会清场
    }
  }
}

/** 把某个 key 的快照推给所有连接（没有按 id 订阅的域了，见文件头） */
function broadcast(key: string, data: unknown): void {
  const message = JSON.stringify({ type: 'snapshot', key, data })
  for (const ws of clients) send(ws, JSON.parse(message))
}

/** 连接建立：先把所有全局域全量推下去 */
async function sendInit(ws: WebSocket): Promise<void> {
  const entries = await Promise.all(
    GLOBAL_KEYS.map(async (key) => [key, await GLOBAL_PROVIDERS[key]()] as const)
  )
  const snapshots: Record<string, unknown> = {}
  for (const [key, value] of entries) snapshots[key] = value
  send(ws, { type: 'init', snapshots })
}

function onConnect(ws: WebSocket): void {
  clients.add(ws)
  void sendInit(ws)
  // 客户端目前**不发任何消息**（域都是全局的，`init` 已全量下发）。
  // 以后真要按需订阅，再在这里补 `sub` 分支。
  ws.on('close', () => {
    clients.delete(ws)
  })
  ws.on('error', () => undefined)
}

// ---------------------------------------------------------------------------
// 脏域去重广播
// ---------------------------------------------------------------------------

const pending = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flush, 30)
}

async function flush(): Promise<void> {
  flushTimer = null
  const keys = [...pending]
  pending.clear()
  await Promise.all(
    keys.map(async (key) => {
      try {
        const data = await snapshotForKey(key)
        // 顺带记住「刚推出去的样子」：兜底轮询靠它判断有没有变。
        // 不更新的话事件推过一次、60s 后兜底还会再推一份一模一样的。
        if (key === 'containerProjects') lastContainerProjects = JSON.stringify(data)
        broadcast(key, data)
      } catch (err) {
        console.error(`[state-ws] 计算快照失败（${key}）：`, err)
      }
    })
  )
}

stateBus.on('dirty', (keys: Iterable<string>) => {
  for (const key of keys) pending.add(key)
  scheduleFlush()
})

// ---------------------------------------------------------------------------
// 瞬时事件广播
// ---------------------------------------------------------------------------

/**
 * `stateBus` 的 `'event'` → 所有连接。
 *
 * 与快照分开广播（消息类型也不同：`{type:'event', event}` vs `{type:'snapshot', key, data}`）：
 * 事件是**一次性**的、不能重放的，所以走单独的通道最直白；前端按 `event.type` 分发，
 * 处理完就没了（连续状态另有快照兜底，见上面的说明）。
 *
 * ⚠️ 这里**不订阅**（没有 `sub`）：对话事件是全局的 —— 谁在跑、要人点头，跟「当前打开
 * 哪个会话 / 在哪个页面」无关。人人都有，不记订阅。
 */
eventBus.on('event', (event: ServerEvent) => {
  for (const ws of clients) send(ws, { type: 'event', event })
})

// ---------------------------------------------------------------------------
// docker 变化：事件流为主，低频轮询兜底
// ---------------------------------------------------------------------------

let lastContainerProjects = ''
/** 防重入：daemon 卡住时一次快照可能要几秒，上一拍没回来不叠加 */
let dockerProbing = false

/**
 * 容器事件里值得重算快照的动作。
 *
 * 只认「状态可能变了」的那几个：`exec_create` / `exec_start` / `attach` 这类高频噪声
 * 不重算 —— 一条 `docker exec` 会发三条事件，每条都算一次快照等于给自己加负载。
 */
const CONTAINER_ACTIONS = new Set([
  'create',
  'start',
  'restart',
  'die',
  'stop',
  'kill',
  'destroy',
  'pause',
  'unpause',
  'rename',
  'health_status'
])

/**
 * 事件驱动的标脏（按域节流）。
 *
 * 一次 `docker start` 会连着发 `create` / `start` / `health_status`，批量启动时更密。
 * 这里按域节流，`stateBus` 那边还有一次 30ms 去重 —— 两层都不做的话，事件风暴
 * （比如 `docker system prune` 删几十个容器）会把快照计算推成每秒几十次。
 */
const lastDirtyAt = new Map<string, number>()
function markDockerDirty(key: 'containerProjects', minGapMs = 120): void {
  const now = Date.now()
  if (now - (lastDirtyAt.get(key) ?? 0) < minGapMs) return
  lastDirtyAt.set(key, now)
  markDirty([key])
}

/**
 * docker 事件流：容器起停 / 镜像变化 → 立刻重算对应域。
 *
 * 这是**外部变化**的唯一发现渠道（用户手动 `docker stop`、容器 OOM 被杀、宿主机重启后
 * `unless-stopped` 把容器拉回来）。我们自己起停容器 / 构建镜像时另有 `markDirty`，
 * 不依赖这里。
 */
function subscribeDockerEvents() {
  return watchDockerEvents((event) => {
    if (event.type === 'container' && CONTAINER_ACTIONS.has(event.action)) {
      markDockerDirty('containerProjects')
    }
  })
}

let dockerEvents = subscribeDockerEvents()
/** 上一次探测时 daemon 是否可达（用来发现「事件流静默死掉」） */
let dockerReachable = true

/**
 * 重建订阅。
 *
 * 只在「daemon 可达性翻转」时调：流有可能**静默死掉** —— 实测 Docker Desktop 被关掉 /
 * 命名管道被系统回收时，流既不 emit `error` 也不 `end`（就是永远不再给数据），
 * `onDrop` 抓不到。这时唯一可靠的判断是「再去问一次 daemon」，所以放在兜底轮询里做。
 */
function restartDockerEvents(): void {
  dockerEvents.stop()
  dockerEvents = subscribeDockerEvents()
}

// 构建日志每来一行就标脏：`docker build` 是我们自己 spawn 的 CLI，docker 不发事件，
// 不这样只能靠轮询才看得到日志滚动（构建几分钟，用户要知道在动）
onContainerImageBuildProgress(() => markDockerDirty('containerProjects', 300))

/**
 * 兜底轮询：**只在事件流失效时**才有用。
 *
 * 事件流是主路径，但它是长连接 —— Docker Desktop 重启、daemon 升级、命名管道被系统
 * 回收都会断。虽然 `watchDockerEvents` 会自动重连，重连成功之前的窗口里事件是真的丢了。
 * 60s 一拍的成本是 0.017 次/秒，换来「最坏 60s 自愈」。
 *
 * ⚠️ 这里**不再有 1.5s 的高频窗口**：以前变化期（build → starting → running）靠它追，
 * 现在 build 进度走 `pushBuildLog` 回调、容器状态走事件流，都不需要追。
 */
function tickDocker(): void {
  // 没前端连着就不必算（快照本身要全量重算 + 序列化）
  if (clients.size === 0 || dockerProbing) return
  dockerProbing = true
  void (async () => {
    // 一条 `listContainers` 拿全（见 lifecycle 的 listProjectContainers），
    // 所以项目数量不影响这一跳的成本
    try {
      const snapshot = await containerProjectsSnapshot()
      // 事件流自愈：流可能静默死掉（见 `restartDockerEvents` 的说明），可达性翻转就重建
      const reachable = snapshot.available !== false
      if (reachable !== dockerReachable) {
        dockerReachable = reachable
        restartDockerEvents()
        /*
         * docker 刚变得可用 ⇒ 顺手清一次孤儿容器。
         *
         * 启动时那趟清扫在「服务先起来、Docker Desktop 后启动」的情况下会直接跳过（连不上
         * 就 return），而用户删项目时如果 docker 没起来，容器也就留了下来 —— 这里补上，
         * 不用等下次重启服务。幂等：还活着的项目不在清扫范围里（判据见 `purge.ts`）。
         */
        if (reachable) {
          void import('./container-projects/purge')
            .then((m) => m.sweepOrphanContainers())
            .catch(() => undefined)
        }
      }
      const projects = JSON.stringify(snapshot)
      if (projects !== lastContainerProjects) {
        lastContainerProjects = projects
        broadcast('containerProjects', JSON.parse(projects))
      }
    } catch {
      /* 探测失败忽略 */
    }
  })().finally(() => {
    dockerProbing = false
  })
}

setInterval(tickDocker, 60_000)

// ---------------------------------------------------------------------------
// 升级分流入口（供 `ws.ts` 调用）
// ---------------------------------------------------------------------------

const STATE_WS_PATH = '/api/state'

export function matchStatePath(pathname: string): boolean {
  return pathname === STATE_WS_PATH
}

export function handleStateUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  auth = true
): void {
  void (async () => {
    try {
      if (auth) {
        const err = await verifyWsToken(url)
        if (err) {
          rejectSocket(socket, 'HTTP/1.1 401 Unauthorized\r\n\r\n')
          return
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws))
    } catch {
      rejectSocket(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n')
    }
  })()
}
