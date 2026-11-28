/**
 * 本地后端（BackendManager）：把共享的 `@fizz/server` 的 Hono 应用**装进主进程**，
 * 桌面因此是个纯 UI —— AI Agent / 工作区 / 模型 / MCP / 技能全在这份进程内服务上跑。
 *
 * 为什么不 spawn 子进程、不占端口：桌面和 server 本来就同机同用户，进程内
 * `app.fetch()` 跑的是同一份路由代码，但省掉了子进程管理、空闲端口挑选、token 下发、
 * 健康轮询这一整套（也顺手解决了打包后找不到 server 产物的问题）。
 *
 * ⚠️ web / cli 不受影响：它们仍然用 `apps/server/src/index.ts` 的 `serve()` 监听端口，
 * HTTP 契约与部署路径不变。
 *
 * 数据目录见 `./env.ts`：userData/server-data，与外部部署的 `~/.fizz-server` 隔离。
 *
 * ⚠️ 后台维护（定时任务调度器 / Flow 对账 / 性能采样器）也在这里拉起
 * —— 独立服务在入口文件里启动它们，进程内形态没有「入口」，必须在装配时补上；
 * 漏了的表现就是「定时任务建了永远不跑」（实测踩过）。
 *
 * 生命周期：`start()` 在 app ready 后调用（失败不阻塞 UI，渲染端只会看到请求报错）；
 * `stop()` 在 will-quit 调用，停掉后台维护并拆掉常驻的 ACP agent 进程。
 */
import './env' // ⚠️ 必须排在所有 @fizz/server 导入之前求值（原因见 env.ts）
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Hono } from 'hono'
import { startBackgroundServices, stopBackgroundServices } from '@/lib/server/background'

export interface BackendStatus {
  running: boolean
  /** 开始装配的时间戳；就绪后保留 */
  startedAt: number | null
  error?: string
}

/** 进程内后端还没就绪时抛这个，调用方据此提示「后端没跑」 */
export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendUnavailableError'
  }
}

class BackendManager {
  private app: Hono | null = null
  /** 正在进行的装配（幂等：并发 start() 共享同一次） */
  private starting: Promise<void> | null = null
  private startedAt = 0
  private error: string | undefined
  private listeners = new Set<(s: BackendStatus) => void>()
  /** 退出时用来拆 server 侧常驻的 ACP 会话（agent 子进程） */
  private disposeAcp: (() => void) | null = null
  /**
   * 内部 WS server（`127.0.0.1` 随机端口）。
   *
   * 为什么必须有它：Hono 的 `app.fetch()` 只能应答 HTTP；`upgrade` 事件必须挂在
   * 真正的 `node:http` server 上，而 `attachWebSockets` 只在独立 server 的入口
   * （`apps/server/src/index.ts`）被调用。进程内形态如果不自己建一个，
   * **desktop 的全部 WebSocket（全局状态推送 / 节点工作台）都没有落点**，
   * 渲染端只能退化成「列表拉一次、之后不再更新」。
   */
  private wsServer: Server | null = null
  private wsPortValue: number | null = null

  status(): BackendStatus {
    return {
      running: this.app !== null,
      startedAt: this.startedAt || null,
      ...(this.error ? { error: this.error } : {})
    }
  }

  onStatus(cb: (s: BackendStatus) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    const status = this.status()
    for (const cb of this.listeners) cb(status)
  }

  /** 装配共享后端应用。幂等：已就绪直接返回；并发调用共享同一次装配。 */
  async start(): Promise<BackendStatus> {
    if (this.app) return this.status()
    if (!this.starting) {
      this.startedAt = Date.now()
      this.starting = this.init()
    }
    await this.starting
    this.emit()
    return this.status()
  }

  private async init(): Promise<void> {
    try {
      // 动态 import：server 模块带顶层 await（打开数据存储），静态 import 会拖住
      // 整个主进程的求值；放这里才能「窗口先出来、后端随后就绪」。
      const [server, serverWs, acp] = await Promise.all([
        import('@fizz/server'),
        import('@fizz/server/ws'),
        import('@fizz/acp')
      ])
      // auth: false —— 进程内直连，没有第三方能碰到这条通道
      // staticWeb: false —— 桌面渲染进程走 file://，不需要同源托管 web 产物
      this.app = server.createApp({ auth: false, staticWeb: false })
      this.disposeAcp = acp.disposeAcpSessions
      // 独立服务在入口文件里做的事，进程内形态在这里补齐 —— 每个服务都幂等
      startBackgroundServices()

      // 内部 WS server：绑 127.0.0.1 随机端口（不与任何已有端口冲突），渲染端经它
      // 连状态推送 / 工作台。HTTP 请求一律 404 —— 这个端口只为 upgrade 存在。
      // 未启用鉴权时 verifyWsToken 直接放行（desktop 进程内正是如此），无需带 token。
      const httpServer = createServer((_req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('fizz desktop: websocket only')
      })
      // ⚠️ auth:false —— 渲染端手里没有 JWT（进程内直连不走登录），而开了远程访问后
      // `authEnabled()` 会变 true；不去掉这道校验，内部所有 WS（状态推送 / 工作台）
      // 都会被 401 拒掉，渲染端陷入「1 秒重连一次」的死循环（实测踩过）。
      // 这条通道只服务本进程的 IPC 桥，不出进程，没有第三方能碰到。
      serverWs.attachWebSockets(httpServer, { auth: false })
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      this.wsServer = httpServer
      this.wsPortValue = (httpServer.address() as AddressInfo).port

      this.error = undefined
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      console.error('[backend] 共享后端装配失败：', err)
    } finally {
      this.starting = null
    }
  }

  /**
   * 内部 WS server 的端口（后端还没就绪时是 `null`）。
   *
   * 渲染端在「要开 WS 的那一刻」经 IPC 来取，先 `await whenReady()` 再读。
   */
  wsPort(): number | null {
    return this.wsPortValue
  }

  /**
   * 等正在进行的装配结束（没在装配就立即返回）。
   *
   * 窗口比后端先就绪是常态：`whenReady` 里 `void start()` 之后立刻建窗口，渲染端挂载时
   * 发出的首批请求正好落在装配窗口里。**必须等它落地**，不能当场回「尚未就绪」——
   * 那会在启动时弹一条无意义的报错（偶发，取决于磁盘与模块导入耗时）。
   */
  async whenReady(): Promise<void> {
    if (this.starting) await this.starting
  }

  /**
   * 进程内直连：把请求直接交给 Hono 应用，不走网络。
   * `server-client` 是唯一调用方。
   */
  async fetch(request: Request): Promise<Response> {
    if (!this.app) await this.whenReady()
    const app = this.app
    if (!app) throw new BackendUnavailableError(this.error ?? '共享后端尚未就绪')
    return app.fetch(request)
  }

  /**
   * 退出时收尾：停掉后台维护（调度器 / 收尾轮询 / 采样器），并拆掉常驻的
   * ACP agent 进程（以前是 server 子进程整体退出顺带带走的）。
   */
  stop(): void {
    void stopBackgroundServices()
    this.disposeAcp?.()
    this.app = null
    // 内部 WS server 一并收掉（上面的连接会以 close 收场，渲染端按断开处理）
    this.wsServer?.close()
    this.wsServer = null
    this.wsPortValue = null
  }

  /**
   * 退出前的**异步**收尾：把还在跑的那一轮对话停掉、等它把已产生的部分落盘，
   * 再把 store 里在途的写盘等完。**必须在 `stop()` 之前调**（`stop()` 会把后台服务
   * 拆掉，而中止一轮要靠 chat-turn 自己那条收尾链把 parts 写进会话文件）。
   *
   * 为什么桌面端非做不可：这套收尾本来是给独立 server 的 `runShutdown`（SIGINT /
   * SIGTERM）写的，而桌面是**进程内直连** —— 关窗口 = 进程直接没了，收不到任何信号，
   * 于是「run 与半截正文只在内存」这件事在桌面端从来没人收。实测症状：agent 用
   * `ask` 提问、正挂着等用户答复（那一轮看起来「停了」，其实活着），
   * 这时候关掉应用再打开，**那一轮的消息整段消失**（用户消息还在，助手一个字不在）。
   *
   * 与 `runShutdown` 的第 3.9 / 4 / 6 步同一口径：先停后台命令，再 `abortAllRuns()`
   * 等 `run.done`（`finishRun` 之前 chat-turn 已经把 parts 落盘），最后 `store.flush()`。
   * 每一步都有超时兜底 —— 收尾卡住也不能把退出钉死。
   */
  async drain(timeoutMs = 5_000): Promise<void> {
    const delay = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      })
    /*
      * 后台命令（`shell` 的 `runInBackground` 起的 dev server / watch）。
     *
     * 它们**故意活过一轮对话**（那是这个能力的意义），所以既不在 `commandStops` 里、
     * 也不受 `abortRun` 影响 —— 只有进程退出时这一处能收它们。POSIX 上是 `detached`
     * 自成进程组，Windows 上 Node 也不会跟着父进程退，**不停就是一堆占着端口的孤儿**；
     * 更糟的是登记表随进程消失，之后再没有任何界面能停它们。
     *
     * 顺序与 `runShutdown` 一致（3.9 在 4 之前）：先发停止信号，再中止对话 ——
     * 反过来会让「对话收尾时还指望那条命令的输出」的路径读到半截日志。
     */
    try {
      const { stopAllRunning } = await import('@/lib/server/background-tasks')
      stopAllRunning()
    } catch (err) {
      console.error('[backend] 退出前停止后台命令失败：', err)
    }
    try {
      const { abortAllRuns } = await import('@/lib/server/chat-run')
      const pending = abortAllRuns()
      if (pending.length) await Promise.race([Promise.all(pending), delay(timeoutMs)])
    } catch (err) {
      console.error('[backend] 退出前中止在跑的对话失败：', err)
    }
    try {
      const { store } = await import('@/lib/server/state')
      await store.flush()
    } catch (err) {
      console.error('[backend] 退出前等待写盘失败：', err)
    }
  }
}

export const backendManager = new BackendManager()
