/**
 * desktop 宿主的实现。
 *
 * 与 web 宿主的差别只有这四处：
 * - **请求**：不碰网络，交给 preload 注入的 IPC 桥（主进程里是**进程内**的 Hono 应用）；
 * - **连接**：内置后端，固定空地址（无连接页、无断开按钮）；
 * - **主题 / 权限模式**：同样落 localStorage，但 key 与 web 分开（两套客户端各自独立）；
 *   主题变更会经窗口桥推给主进程（`nativeTheme.themeSource`，托盘菜单等原生 UI 跟随亮暗）。
 *
 * `createIpcFetch` 把桥包成 fetch 形状，于是 `@fizz/agent-client` 的数据层照旧是
 * 「fetch + 读 SSE 字节流」—— 与 web 端共用同一份代码，一行都不用改。
 */
import type {
  AgentHost,
  SshTerminalOpenOptions,
  StateSocket,
  TerminalOpenOptions,
  TerminalProcess,
  WorkbenchSocket
} from '@fizz/agent-client/host'
import {
  TERMINAL_WS_PATH,
  apiClientWsPath,
  sshTerminalWsPath,
  type SshConnectProgress
} from '@fizz/contracts/agent-api'
import { agentBrowserSessionId } from '@fizz/contracts'
import type {
  AgentTransportBridge,
  AgentTransportRequest,
  PtyDataEvent,
  PtyExitEvent
} from '@fizz/agent-host/channels'

declare global {
  interface Window {
    /** preload 经 contextBridge 暴露的传输桥（见 packages/agent-host/src/preload.ts） */
    fizzHost: AgentTransportBridge
  }
}

const THEME_KEY = 'fizz.desktop.theme'
/** 旧版 useTheme 直写的 key（迁移用，见 loadTheme） */
const LEGACY_THEME_KEY = 'fizz.web.theme'
/** 命令执行权限：默认 confirm，与 web 端一致 */
const PERMISSION_KEY = 'fizz.desktop.permissionMode'
/** confirm 审批超时（分钟）：默认 10，0 = 不超时 */
const CONFIRM_TIMEOUT_KEY = 'fizz.desktop.confirmTimeout'
/** 对话结束后系统通知：默认开 */
const NOTIFY_ON_FINISH_KEY = 'fizz.desktop.notifyOnFinish'
/** 上次打开的工作区（启动恢复现场用；空串 = 没有） */
const ACTIVE_WORKSPACE_KEY = 'fizz.desktop.activeWorkspaceId'
/** 上次打开的会话（启动恢复现场用；空串 = 没有） */
const ACTIVE_CONVERSATION_KEY = 'fizz.desktop.activeConversationId'
/** 终端字号：缺省 14，非数字 / 没存过都回落 14 */
const TERMINAL_FONT_KEY = 'fizz.desktop.terminalFontSize'

/** 这些状态码不允许带 body（`new Response(body, { status })` 会直接抛错） */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

let streamSeq = 0

/**
 * 是否 dev（渲染进程由 Vite dev server 提供 → `http://`；生产走 `file://`）。
 *
 * ⚠️ 桌面端的「网络请求」其实**不出网**：渲染端 → IPC 桥 → 主进程里的进程内 Hono，
 * 所以 DevTools 的 Network 面板永远是空的。开发时想看请求只能靠日志 —— 下面把每次调用的
 * **方法 / 路径 / 请求体 / 响应体（含 SSE 帧）** 打到 console。
 * dev 下 `scripts/dev.mjs` 设了 `ELECTRON_ENABLE_LOGGING=1`，渲染端 console 会一并进终端。
 */
const DEV = location.protocol === 'http:'

/** 单条日志最多这么多字符：SSE 帧 / 大 JSON 截断，别把终端刷爆 */
const DEBUG_LOG_LIMIT = 2000

function truncateLog(text: string): string {
  return text.length > DEBUG_LOG_LIMIT
    ? `${text.slice(0, DEBUG_LOG_LIMIT)}…（共 ${text.length} 字符）`
    : text
}

/** 生产环境渲染端跑在 file:// 下，localStorage 不可用时不该让整个界面挂掉 */
function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * 逐帧打印 SSE 原始字节的开关：**默认关**，要看时在 DevTools 里
 * `localStorage.setItem('fizz.debug.sse','1')` 再刷新。
 *
 * ⚠️ 别再把它挂回 `DEV` 上。`DEV` 的判据是 `location.protocol === 'http:'`，**桌面端的
 * dev 形态**（渲染端由 Vite dev server 提供）也算 true —— 于是流式回复的**每一个分片**
 * 都要走一次 TextDecoder + console.log。`execute_command` 的实时输出 / 长正文下这是每秒
 * 成百上千次主线程日志：流式明显发卡，而且真出问题时的报错会被自己的日志淹掉（想排查
 * 「连接中断」时恰恰最需要看到那一行）。请求级 / 响应级的日志（每条请求一条）不受影响，
 * 仍旧跟着 `DEV` 走。
 */
const SSE_TRACE = readKey('fizz.debug.sse') === '1'

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存不下就算了：主题 / 权限模式退化成「本次会话有效」
  }
}

/** 调用方（createApi）拼的是 `/api/...`；兜底处理绝对 URL，只取 path + query */
function toPath(url: string): string {
  if (url.startsWith('/')) return url
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

function toHeaders(init?: HeadersInit): Record<string, string> {
  if (!init) return {}
  if (init instanceof Headers) return Object.fromEntries(init.entries())
  if (Array.isArray(init)) return Object.fromEntries(init)
  return { ...init }
}

/**
 * 开一条 SSE：`agent:sse:open` 打开，chunk / end 由主进程推回来，
 * 在这里拼成 `ReadableStream` —— 对上层就是一个普通的 fetch 响应。
 */
function openSse(
  bridge: AgentTransportBridge,
  req: AgentTransportRequest,
  signal: AbortSignal | null
): Promise<Response> {
  const streamId = `sse-${++streamSeq}-${Date.now()}`
  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let unsubscribe: (() => void) | null = null
    let settled = false

    const detach = (): void => {
      unsubscribe?.()
      unsubscribe = null
      signal?.removeEventListener('abort', onAbort)
    }

    /** 正常收尾：把流关掉（error 非空时按错误结束） */
    const finish = (error?: string): void => {
      if (settled) return
      settled = true
      detach()
      const c = controller
      controller = null
      if (!c) return
      if (error) c.error(new Error(error))
      else c.close()
    }

    function onAbort(): void {
      // 只断开这条读流；服务端那一轮要停得显式调 /api/chat/abort
      void bridge.closeSse(streamId)
      if (settled) return
      if (!controller) {
        // 还没 open 成功就被中止
        settled = true
        detach()
        reject(new DOMException('请求已中止', 'AbortError'))
        return
      }
      finish()
    }

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        settled = true
        detach()
        void bridge.closeSse(streamId)
      }
    })

    /**
     * 逐帧调试日志（开关见 `SSE_TRACE`，默认关）—— 对一条流式请求来说这就是它的「响应体」。
     * ⚠️ 解码器必须**每条流各一个**：`decode(chunk, { stream: true })` 是有状态的，跨流共用
     * 会把上一条流残留的半个多字节字符带进来。
     */
    const debugDecoder = SSE_TRACE ? new TextDecoder() : null
    const offChunk = bridge.onSseChunk((event) => {
      if (event.streamId !== streamId || !controller) return
      if (debugDecoder) {
        console.log(
          `[api]   sse: ${truncateLog(debugDecoder.decode(event.chunk, { stream: true }))}`
        )
      }
      controller.enqueue(event.chunk)
    })
    const offEnd = bridge.onSseEnd((event) => {
      if (event.streamId !== streamId) return
      if (DEV) {
        console.log(
          `[api]   sse 结束${event.error ? `（错误：${event.error}）` : ''} ${req.method} ${req.path}`
        )
      }
      finish(event.error)
    })
    unsubscribe = () => {
      offChunk()
      offEnd()
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    void bridge
      .openSse({ ...req, streamId })
      .then((result) => {
        if (settled) return
        if (!result.ok) {
          settled = true
          detach()
          /**
           * ⚠️ **HTTP 状态码必须带出去**（挂在 `status` 上）。
           *
           * 数据层 `attachRun` 的 catch 靠状态码区分 401（token 失效 → 登出收场）与
           * 404（run 已结束 / 过期 → 正常收场）。它只认 `instanceof ApiError` 是拿不到的
           * —— 桌面端的请求经 IPC 走主进程，这里抛的是宿主桥造的普通 Error，状态码到不了
           * 数据层，那两条分支在桌面端全是死代码（见 `lib/api.ts` 的 `httpStatusOf`）。
           *
           * `status === 0` 是桥自己报的错（后端还没就绪 / 打开失败），不是 HTTP 状态，不带。
           */
          const err = Object.assign(new Error(result.error ?? `HTTP ${result.status}`), {
            ...(result.status > 0 ? { status: result.status } : {})
          })
          reject(err)
          return
        }
        resolve(
          new Response(body, {
            status: result.status,
            headers: { 'content-type': 'text/event-stream' }
          })
        )
      })
      .catch((err: unknown) => {
        if (settled) return
        settled = true
        detach()
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

/** 把 IPC 桥包成 fetch 形状：普通请求走 invoke，SSE 走事件回流 */
function createIpcFetch(bridge: AgentTransportBridge): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (typeof input === 'object' && !(input instanceof URL) ? input.method : 'GET')).toUpperCase()
    const headers = toHeaders(init?.headers)
    const request: AgentTransportRequest = {
      path: toPath(raw),
      method,
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {})
    }

    // dev：请求体一并打出来（这就是「渲染端 → 服务端」那次调用能看到的全部信息）
    if (DEV) {
      console.log(
        `[api] → ${method} ${request.path}${request.body ? `\n  body: ${truncateLog(request.body)}` : ''}`
      )
    }
    const started = Date.now()

    // 与 web 端一致：数据层用 accept 头区分流式与一次性请求
    if (headers.accept === 'text/event-stream') {
      return openSse(bridge, request, init?.signal ?? null)
    }

    const res = await bridge.request(request)
    if (DEV) {
      console.log(`[api] ← ${res.status} ${method} ${request.path}（${Date.now() - started}ms）`)
      if (typeof res.body === 'string' && res.body) {
        console.log(`[api]   res: ${truncateLog(res.body)}`)
      }
    }
    return new Response(NULL_BODY_STATUS.has(res.status) ? null : res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers
    })
  }
}

/**
 * 本机终端：IPC 桥开主进程 PTY（shell 由 `shellId` 指定，不传则平台默认）。
 *
 * `openPty` 是异步的，而 TerminalProcess 的方法是同步的：打开前的输入先攒着，
 * 拿到 sessionId 再补写；打不开（理论上只有极端环境）就按「退出码 -1」收场。
 */
function openLocalTerminal({
  cwd,
  cols,
  rows,
  shellId,
  args,
  autoCommand
}: {
  cwd: string
  cols: number
  rows: number
  shellId?: string
  args?: string[]
  autoCommand?: string
}): TerminalProcess {
  const bridge = window.fizzHost
  const dataSubs = new Set<(data: Uint8Array) => void>()
  const exitSubs = new Set<(exitCode: number, reason?: string) => void>()
  /** 未拿到 sessionId 前的输入（字符串 = 键盘文本，Uint8Array = ZMODEM 二进制） */
  let queue: Array<string | Uint8Array> = []
  let dead = false
  /**
   * `sessionId` 还没拿到时的暂存：PTY 一开始输出就可能早于 `openPty` 的回包
   * （主进程 spawn 完就把首包推回来了，invoke 的 promise 还在路上）。
   */
  const pendingData: PtyDataEvent[] = []
  const pendingExit: PtyExitEvent[] = []
  let sessionId: string | null = null

  /**
   * ⚠️ 这两个订阅是**窗口级**的（preload 只暴露了 `onPtyData` / `onPtyExit`，不带会话参数），
   * 所以**必须自己按 `event.sessionId` 过滤**。
   *
   * 不过滤会怎样（实测用户反馈的现象）：换终端时旧会话被 `ptyKill` 杀掉，它的 exit
   * 晚一拍回来（node-pty 走 ConPTY socket，是异步回调），落到**新**面板的订阅上 →
   * 面板显示「（已退出，代码 -1）」，而新 shell 活得好好的。用户看到的就是
   * 「终端偶尔说已退出，点重新打开也不起作用」。
   */
  const offData = bridge.onPtyData((event) => {
    if (!sessionId) {
      pendingData.push(event)
      return
    }
    if (event.sessionId !== sessionId) return
    dataSubs.forEach((cb) => cb(event.data))
  })
  const offExit = bridge.onPtyExit((event) => {
    if (!sessionId) {
      pendingExit.push(event)
      return
    }
    if (event.sessionId !== sessionId) return
    exitSubs.forEach((cb) => cb(event.exitCode))
  })

  void bridge
    .openPty({
      cwd,
      cols,
      rows,
      ...(shellId ? { shellId } : {}),
      ...(args?.length ? { args } : {}),
      ...(autoCommand ? { autoCommand } : {})
    })
    .then((result) => {
      if (dead) {
        /**
         * ⚠️ 组件已经收工（换会话 / 关面板 / 退出后重开）而 PTY 刚建好：**这里必须补一刀 kill**。
         * `kill()` 只置了 `dead` 并跳过 `ptyKill`（那时 `sessionId` 还没回来），
         * 若这里直接 return，主进程里就留下一个没人管的 shell —— 快速连续重开会一个接一个漏。
         */
        if (result.ok && result.sessionId) void bridge.ptyKill(result.sessionId)
        return
      }
      if (!result.ok || !result.sessionId) {
        // 启动失败：把主进程给的错误当 reason 带出去（否则 UI 只会显示一个没意义的 -1）
        exitSubs.forEach((cb) => cb(-1, result.error ?? '终端启动失败'))
        return
      }
      sessionId = result.sessionId
      // 回放暂存的包，只留属于这条会话的
      for (const event of pendingData) {
        if (event.sessionId === sessionId) dataSubs.forEach((cb) => cb(event.data))
      }
      for (const event of pendingExit) {
        if (event.sessionId === sessionId) exitSubs.forEach((cb) => cb(event.exitCode))
      }
      pendingData.length = 0
      pendingExit.length = 0
      for (const chunk of queue) void bridge.ptyWrite(sessionId, chunk)
      queue = []
    })
    .catch((err: unknown) => {
      if (!dead) {
        exitSubs.forEach((cb) => cb(-1, err instanceof Error ? err.message : '终端启动失败'))
      }
    })

  return {
    write: (data) => {
      if (sessionId) void bridge.ptyWrite(sessionId, data)
      else queue.push(data)
    },
    resize: (nextCols, nextRows) => {
      if (sessionId) void bridge.ptyResize(sessionId, nextCols, nextRows)
    },
    kill: () => {
      if (dead) return
      dead = true
      offData()
      offExit()
      if (sessionId) void bridge.ptyKill(sessionId)
    },
    /*
     * 「停止」：让主进程收掉**前台作业**（POSIX 上按 `ps` 探到的前台进程组发信号），
     * 不置 `dead`、不断订阅 —— 终端还在，输出还在，用户接着用。
     *
     * 为什么不复用 `kill()`：那是「关掉这个终端标签」，会把 `sessionId` 作废、
     * 让外壳以为终端没了。用户按 Ctrl+C 只是要那条命令死、端口释放。
     * 引擎侧（`agent-host/src/pty.ts` 的 `stopForeground`）拿不到前台作业时什么都不做 ——
     * 这条由 Ctrl+C 的延时补刀调用，**不能**把 shell 一起杀掉。
     */
    stop: () => {
      if (sessionId) void bridge.ptyStop(sessionId)
    },
    onData: (cb) => {
      dataSubs.add(cb)
      return () => dataSubs.delete(cb)
    },
    onExit: (cb) => {
      exitSubs.add(cb)
      return () => exitSubs.delete(cb)
    }
  }
}

/** 审批超时分钟数：解析失败 / 非法值都回落到缺省 10 */
function readConfirmTimeout(): number {
  const raw = readKey(CONFIRM_TIMEOUT_KEY)
  if (raw === null) return 10
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 10
}

// ---------------------------------------------------------------------------
// WebSocket 桥（全局状态推送 / 节点工作台）
// ---------------------------------------------------------------------------

/**
 * 与 HTTP / SSE / PTY 同一条原则：**渲染端不碰网络**。真正的 WebSocket 由主进程
 * 代为建立（目标是进程内后端的内部 loopback server），这里只拿一个 streamId
 * 收发帧 —— 于是「渲染端与后端的往来只走 IPC、不出进程」对四类通道一体成立，
 * 渲染端永远不需要知道后端在哪个端口。
 *
 * 三个 `open*` 都是同步签名（`AgentHost` 的契约），而建连是异步的：这里用
 * 「先登记订阅、`openWs` 回来后把攒下的订阅接到桥上」的方式补齐 —— 上行帧在
 * 连接就绪前先攒着（与 web 端 `openTerminal` 对 WS 未就绪输入的处理一致）。
 */

/** 一条经 IPC 桥的 WS 连接：订阅表 + 就绪前的上行缓冲 */
interface BridgeSocket {
  streamId: string
  messageSubs: Set<(data: string | ArrayBufferLike, binary: boolean) => void>
  closeSubs: Set<(reason?: string) => void>
  openSubs: Set<() => void>
  /** openWs 还没回来（或失败）前的上行帧缓冲 */
  pending: Array<string | Uint8Array>
  ready: boolean
  closedByUs: boolean
}

const bridgeSockets = new Map<string, BridgeSocket>()
let bridgeSeq = 0
/**
 * ⚠️ 光有自增序号不够 —— 「唯一」这件事是在**主进程**那边判的。
 *
 * 序号是**渲染端上下文内**的模块变量，而主进程的 `wsStreams` 是**全进程一张表**，
 * 于是下面两种情形一定会撞号：
 * - **整页重载**（dev 的 HMR 全量刷新 / DevTools 的 Reload）：`bridgeSeq` 回到 0，
 *   可旧页开的连接还活着 —— 主进程只在 webContents `destroyed`（窗口关掉）时收它们，
 *   重载不算销毁（`transport-ipc.ts` 里另有一道 `did-start-navigation` 的收尾）；
 * - **多窗口**：主窗口 / 会话浮窗 / 设置窗口各是一份 JS 上下文，各自从 0 数。
 *
 * 撞号后主进程的 `wsOpen` 直接回 `streamId 已存在`，渲染端把它当「连接已断开」的
 * reason 交给终端 —— 用户看到的就是「刚连上就报 streamId 已存在然后断开」。
 * 给每个上下文生成一次的随机前缀把两把钥匙错开，代价为零。
 *
 * （SSE 那边一直是 `sse-${seq}-${Date.now()}`，天然错开，所以从没出过这个问题。
 *   这里别退回「只用序号」。）
 */
const bridgeIdPrefix = Math.random().toString(36).slice(2, 8)

function openBridgeSocket(path: string, readyMarker: () => void): BridgeSocket {
  const streamId = `ws-${bridgeIdPrefix}-${++bridgeSeq}`
  const socket: BridgeSocket = {
    streamId,
    messageSubs: new Set(),
    closeSubs: new Set(),
    openSubs: new Set(),
    pending: [],
    ready: false,
    closedByUs: false
  }
  bridgeSockets.set(streamId, socket)

  void (async () => {
    const res = await window.fizzHost.openWs({ streamId, path })
    if (!res.ok) {
      bridgeSockets.delete(streamId)
      socket.closeSubs.forEach((cb) => cb(res.error))
      return
    }
    socket.ready = true
    for (const data of socket.pending) void window.fizzHost.sendWs({ streamId, data })
    socket.pending = []
    readyMarker()
    socket.openSubs.forEach((cb) => cb())
  })()

  return socket
}

// 全局订阅一次：按 streamId 分发到对应的连接（contextBridge 的回调是全局的）
window.fizzHost.onWsData((event) => {
  const socket = bridgeSockets.get(event.streamId)
  if (!socket) return
  const binary = typeof event.data !== 'string'
  const data = binary
    ? (event.data as Uint8Array).buffer as ArrayBufferLike
    : (event.data as string)
  socket.messageSubs.forEach((cb) => cb(data, binary))
})
window.fizzHost.onWsClosed((event) => {
  const socket = bridgeSockets.get(event.streamId)
  if (!socket) return
  bridgeSockets.delete(event.streamId)
  if (socket.closedByUs) return
  socket.closeSubs.forEach((cb) => cb(event.reason || '连接已断开'))
})

/** 把一条桥连接包成 `AgentHost` 要的 socket 形状 */
function bridgeToSocket(socket: BridgeSocket) {
  return {
    send: (data: string | ArrayBuffer | Blob) => {
      if (socket.closedByUs) return
      // IPC 结构化克隆只认 string / 二进制视图；Blob 本仓没有调用方会传（真传了就忽略）
      const payload: string | Uint8Array | null =
        typeof data === 'string'
          ? data
          : data instanceof Uint8Array
            ? data
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : null
      if (payload === null) return
      // 连接还没建立（openWs 的回包没到）：先攒着，就绪后按序补发
      if (!socket.ready) {
        socket.pending.push(payload)
        return
      }
      void window.fizzHost.sendWs({ streamId: socket.streamId, data: payload })
    },
    onMessage: (cb: (data: string | ArrayBufferLike, binary: boolean) => void) => {
      socket.messageSubs.add(cb)
      return () => socket.messageSubs.delete(cb)
    },
    onOpen: (cb: () => void) => {
      socket.openSubs.add(cb)
      return () => socket.openSubs.delete(cb)
    },
    onClose: (cb: (reason?: string) => void) => {
      socket.closeSubs.add(cb)
      return () => socket.closeSubs.delete(cb)
    },
    close: () => {
      if (socket.closedByUs) return
      socket.closedByUs = true
      bridgeSockets.delete(socket.streamId)
      void window.fizzHost.closeWs(socket.streamId)
    }
  }
}

/** 全局状态推送（`/api/state`）：协议与 web 端同款，由 `state-ws.ts` 解释 */
function openBridgeStateSocket(): StateSocket {
  return bridgeToSocket(openBridgeSocket('/api/state', () => undefined)) as unknown as StateSocket
}

/** 节点工作台：双向 WS，服务端反向代理到容器 bridge */
function openBridgeWorkbench(pathAndQuery: string): WorkbenchSocket {
  return bridgeToSocket(openBridgeSocket(pathAndQuery, () => undefined))
}

/**
 * SSH 终端：连服务端的 `/api/ssh/terminal`，与 web 端是同一条协议 ——
 * 客户端 → JSON 控制帧（input / resize），服务端 → 二进制输出帧 + JSON `exit`。
 *
 * 只说 `hostId`：主机凭据在服务端解密后直接去连，**不进渲染端**；
 * 这里把桥的原始帧适配成 `TerminalProcess`（与 `openLocalTerminal` 的形状一致）。
 */
function openBridgeSshTerminal({ hostId, cols, rows }: SshTerminalOpenOptions): TerminalProcess {
  const socket = openBridgeWorkbench(sshTerminalWsPath({ hostId, cols, rows }))
  const dataSubs = new Set<(data: Uint8Array) => void>()
  const exitSubs = new Set<(exitCode: number, reason?: string) => void>()
  /** SSH 建连进度订阅（与 web 端同一条协议，见 web-host 的 openTerminalWs） */
  const progressSubs = new Set<(progress: SshConnectProgress) => void>()
  let exited = false
  let closedByUs = false

  const notifyExit = (code: number, reason?: string): void => {
    if (exited) return
    exited = true
    exitSubs.forEach((cb) => cb(code, reason))
  }

  const offMessage = socket.onMessage((raw, binary) => {
    if (binary) {
      dataSubs.forEach((cb) => cb(new Uint8Array(raw as ArrayBufferLike)))
      return
    }
    try {
      const message = JSON.parse(raw as string) as {
        type?: string
        exitCode?: number
        stage?: SshConnectProgress['stage']
        detail?: string
      }
      // 服务端明确告知的退出：这条才带 SSH 会话的真实退出码
      if (message.type === 'exit') notifyExit(message.exitCode ?? 0)
      // SSH 建连进度：渲染端据此浮出连接进度卡片
      else if (message.type === 'progress' && message.stage) {
        progressSubs.forEach((cb) => cb({ stage: message.stage!, detail: message.detail }))
      }
    } catch {
      // 非 JSON 的文本帧：忽略
    }
  })
  // 与 web 端同理：WS 断开 ≠ shell 退出，-1 只是「没收到 exit 帧就断了」的兜底码
  socket.onClose((reason) => {
    if (closedByUs) return
    notifyExit(-1, reason || 'SSH 连接已断开')
  })

  return {
    // 文本走 JSON 控制帧；二进制（ZMODEM 帧）走裸二进制帧 —— 服务端 SSH WS 收到
    // `isBinary` 就按原始字节喂给 ssh 流（与 web 端同一条协议）
    write: (data) =>
      socket.send(typeof data === 'string' ? JSON.stringify({ type: 'input', data }) : data),
    resize: (nextCols, nextRows) =>
      socket.send(JSON.stringify({ type: 'resize', cols: nextCols, rows: nextRows })),
    kill: () => {
      if (closedByUs) return
      closedByUs = true
      offMessage()
      socket.close()
    },
    /*
     * SSH 终端**刻意不实现 `stop`**（`TerminalProcess.stop?` 是可选的）。
     *
     * 远端进程组不在宿主视野里，这里够不到任何进程 —— 以前这里是「再补发 `\x03` + `\x1c`」，
     * 表面上像「够到哪算哪」，实际只是**替用户自动又按了一次 Ctrl+C**：
     * `TerminalPanel` 的 Ctrl+C 会在 1.2s 后调它做兜底，于是用户看到的是「命令已经退出、
     * 过一会儿终端里又冒出一个 `^C`」（那记迟到的 `\x03` 落在已经回到提示符的 shell 上）。
     * 发 stop 帧同样没用：服务端 SSH 通道只认 input / resize / ping（见 `ssh/ws.ts`）。
     *
     * 所以：不实现 = 面板只发一次 `\x03`，要强杀远端命令由用户自己再按（或去远端 kill）。
     */
    onData: (cb) => {
      dataSubs.add(cb)
      return () => dataSubs.delete(cb)
    },
    onExit: (cb) => {
      exitSubs.add(cb)
      return () => exitSubs.delete(cb)
    },
    onProgress: (cb) => {
      progressSubs.add(cb)
      return () => progressSubs.delete(cb)
    }
  }
}

/**
 * 容器终端（容器型项目）：连服务端 `/api/terminal?container=<工作区 id>`，
 * 由服务端现算容器名并 `docker exec` 进去 —— 与 web 端同一条协议
 * （JSON 控制帧 input / resize / stop，二进制输出帧 + JSON `exit`）。
 *
 * 为什么不复用主进程的本机 PTY：容器不归宿主进程管 —— 容器名约定
 * （`fizz-proj-<slug>`）只在服务端有一份，也只有服务端能校验「这个工作区确实是容器型项目」。
 * 客户端只传工作区 id，传不了容器名（否则就能 exec 进任意容器）。
 */
function openBridgeContainerTerminal({
  cwd,
  cols,
  rows,
  containerWorkspaceId,
  containerShell
}: TerminalOpenOptions): TerminalProcess {
  const socket = openBridgeWorkbench(
    `${TERMINAL_WS_PATH}?cwd=${encodeURIComponent(cwd)}&cols=${cols}&rows=${rows}` +
      `&container=${encodeURIComponent(containerWorkspaceId ?? '')}` +
      (containerShell ? `&containerShell=${encodeURIComponent(containerShell)}` : '')
  )
  const dataSubs = new Set<(data: Uint8Array) => void>()
  const exitSubs = new Set<(exitCode: number, reason?: string) => void>()
  let exited = false
  let closedByUs = false

  const notifyExit = (code: number, reason?: string): void => {
    if (exited) return
    exited = true
    exitSubs.forEach((cb) => cb(code, reason))
  }

  const offMessage = socket.onMessage((raw, binary) => {
    if (binary) {
      dataSubs.forEach((cb) => cb(new Uint8Array(raw as ArrayBufferLike)))
      return
    }
    try {
      const message = JSON.parse(raw as string) as { type?: string; exitCode?: number }
      if (message.type === 'exit') notifyExit(message.exitCode ?? 0)
    } catch {
      // 非 JSON 的文本帧：忽略
    }
  })
  // 与 SSH 同理：WS 断开 ≠ 容器内 shell 退出，-1 是「没收到 exit 帧就断了」的兜底码
  socket.onClose((reason) => {
    if (closedByUs) return
    notifyExit(-1, reason || '容器终端已断开')
  })

  return {
    write: (data) =>
      socket.send(typeof data === 'string' ? JSON.stringify({ type: 'input', data }) : data),
    resize: (nextCols, nextRows) =>
      socket.send(JSON.stringify({ type: 'resize', cols: nextCols, rows: nextRows })),
    kill: () => {
      if (closedByUs) return
      closedByUs = true
      offMessage()
      socket.close()
    },
    /*
     * 「停止」：容器里的 shell 是本机 docker exec 拉起的进程树，服务端够得着
     * （`session.stopForeground()`），所以这里**发 stop 帧**而不是只发 Ctrl+C
     * —— 与 SSH 通道不同（那条远端进程组不在宿主视野里）。
     */
    stop: () => {
      if (closedByUs) return
      socket.send(JSON.stringify({ type: 'stop' }))
    },
    onData: (cb) => {
      dataSubs.add(cb)
      return () => dataSubs.delete(cb)
    },
    onExit: (cb) => {
      exitSubs.add(cb)
      return () => exitSubs.delete(cb)
    }
  }
}

export const desktopHost: AgentHost = {
  /** 内置后端：连接恒存在，直接进主界面（token 留空 —— 进程内直连不走鉴权） */
  loadConnection: () => ({ token: '' }),
  /** 没有可断开的连接，也没有要持久化的东西 */
  saveConnection: () => undefined,
  fetch: createIpcFetch(window.fizzHost),
  /*
   * 三种模式：light / dark / system（**默认**，跟随系统）；没存过、存坏、storage 被禁都回落 system。
   * 旧版 UI 的 useTheme 直接写 web 的 key（fizz.web.theme），本宿主的 key 当时
   * 无人写入 —— 已存的主题选择要从旧 key 迁移一次（saveTheme 会写到新 key，之后走新 key）。
   *
   * ⚠️ 回落值必须与 `index.html` 里那段首帧前内联脚本一致，否则首帧会闪。
   * `readKey` 自带 try/catch（storage 被禁时返回 null），所以这里不用再包。
   */
  loadTheme: () => {
    const raw = readKey(THEME_KEY) ?? readKey(LEGACY_THEME_KEY)
    return raw === 'light' || raw === 'dark' ? raw : 'system'
  },
  saveTheme: (theme) => {
    writeKey(THEME_KEY, theme)
    // 同步给主进程：托盘右键菜单这类原生 UI 的亮暗走 nativeTheme.themeSource，
    // 渲染端的 DOM 类名管不到它们（主进程会缓存进 window-prefs.json 供下次启动用）
    void window.fizzWindow.setTheme(theme)
  },
  // 三种模式：full / confirm（默认）/ readonly；存坏了都回落到 confirm
  loadPermissionMode: () => {
    const raw = readKey(PERMISSION_KEY)
    return raw === 'full' || raw === 'readonly' ? raw : 'confirm'
  },
  loadConfirmTimeout: readConfirmTimeout,
  saveConfirmTimeout: (minutes) => writeKey(CONFIRM_TIMEOUT_KEY, String(minutes)),
  loadNotifyOnFinish: () => readKey(NOTIFY_ON_FINISH_KEY) !== 'false',
  saveNotifyOnFinish: (enabled) => writeKey(NOTIFY_ON_FINISH_KEY, enabled ? 'true' : 'false'),
  /** 上次打开的现场（工作区 / 会话）：下次启动据此恢复，连带恢复会话记住的模型 */
  loadActiveWorkspaceId: () => readKey(ACTIVE_WORKSPACE_KEY),
  saveActiveWorkspaceId: (id) => writeKey(ACTIVE_WORKSPACE_KEY, id ?? ''),
  loadActiveConversationId: () => readKey(ACTIVE_CONVERSATION_KEY) || null,
  saveActiveConversationId: (id) => writeKey(ACTIVE_CONVERSATION_KEY, id ?? ''),
  // 终端字号：缺省 14；非数字 / 没存过都回落 14
  loadTerminalFontSize: () => {
    const raw = readKey(TERMINAL_FONT_KEY)
    if (raw === null) return 14
    const n = Number(raw)
    return Number.isFinite(n) ? n : 14
  },
  saveTerminalFontSize: (size) => writeKey(TERMINAL_FONT_KEY, String(size)),
  /**
   * 关闭行为：偏好由**主进程**持有（renderer 的 localStorage 在窗口关掉时读不到），
   * 这里只做透传（同步读 / 异步写）。
   */
  loadCloseToTray: () => window.fizzWindow.loadCloseToTray(),
  saveCloseToTray: (enabled) => {
    void window.fizzWindow.setCloseToTray(enabled)
  },
  /** 系统通知：主进程做前台判定（在前台时不弹，改由渲染端发应用内 toast），点通知拉回主窗口 */
  notify: (notice) => window.fizzWindow.notify(notice),
  /**
   * 应用内自动更新：状态机在主进程（`autoUpdater` 是全局单例），这里全是透传。
   *
   * **下载只有 `download()` 一条入口** —— 主进程 `autoDownload = false`，静默检查
   * 发现新版本只置状态，必须用户点「下载」才会开始下（产品约定）。
   */
  appUpdate: {
    status: () => window.fizzWindow.appUpdateStatus(),
    check: () => window.fizzWindow.appUpdateCheck(),
    download: () => window.fizzWindow.appUpdateDownload(),
    cancel: () => window.fizzWindow.appUpdateCancel(),
    install: () => window.fizzWindow.appUpdateInstall(),
    onStatus: (cb) => window.fizzWindow.onAppUpdateChange(cb)
  },
  savePermissionMode: (mode) => writeKey(PERMISSION_KEY, mode),
  showConnectionGate: false,
  canDisconnect: false,
  title: 'Fizz',
  platform: 'desktop',
  capabilities: {
    nativeTitleBar: true,
    voice: false,
    localServer: true,
    localMediaFetch: true,
    webview: true
  },
  /**
   * 有本机文件系统（后端就在这个进程里），所以工作区目录用系统目录选择框挑；
   * 装了本方法，UI 就不会退化成「浏览服务端目录」那套（对桌面端是绕远路）。
   */
  pickLocalDirectory: () => window.fizzHost.pickDirectory(),
  /**
   * 外部 Markdown 文件（双击系统里的 `.md` 用本应用打开）。
   *
   * 读 / 写走主进程，且**只认被授权过的路径**（对话框选中的、或系统交来的）——
   * 授权集合在主进程（`@fizz/agent-host` 的 `local-files`），渲染端绕不过去。
   */
  pickLocalMarkdownFile: () => window.fizzHost.pickLocalMarkdownFile(),
  readLocalFile: (path) => window.fizzHost.readLocalFile(path),
  writeLocalFile: (path, content) => window.fizzHost.writeLocalFile(path, content),
  // 存量（先存后取）+ 增量，两个都要：只用事件会丢「监听挂上之前就发完」的那批
  takePendingExternalFiles: () => window.fizzWindow.takePendingExternalFiles(),
  onExternalFileOpen: (cb) => window.fizzWindow.onExternalFileOpen(cb),
  /**
   * 浮窗「在主窗口打开这个会话」的入口：主进程拉窗口 + 把会话 id 递过来（见
   * `app/layout/use-deep-link.ts`）。同样是存量 + 增量，只是存量做成同步的。
   */
  openInMainWindow: (conversationId) => window.fizzWindow.openInMainWindow(conversationId),
  takePendingDeepLink: () => window.fizzWindow.takePendingDeepLink(),
  onDeepLink: (cb) => window.fizzWindow.onDeepLink(cb),
  /**
   * 会话详情区「在浮窗中打开」：主进程管那个单例窗口（同一条就聚焦，换一条就带
   * 新 id 重载渲染端，见 `main/index.ts` 的 `openConversationWindow`）。
   */
  openConversationWindow: (conversationId) =>
    window.fizzWindow.openConversationWindow(conversationId),
  /** 脏标签计数推给主进程缓存 —— 退出拦截时主进程读它，不做往返询问（见 window.ts 的注释） */
  setDirtyTabCount: (count) => window.fizzWindow.setDirtyTabCount(count),
  /**
   * ZMODEM（rz/sz）的文件能力：全部走主进程的系统对话框 / 写盘
   * （`agent:zmodem:*` 三条通道，见 agent-host 的 transport-ipc）。
   */
  zmodem: {
    pickFiles: () => window.fizzHost.zmodemPickFiles(),
    askSavePath: (defaultName) => window.fizzHost.zmodemAskSavePath(defaultName),
    saveFileTo: (target, data) => window.fizzHost.zmodemSaveFileTo(target, data)
  },
  /**
   * SFTP 分片传输的落盘能力（下载用）：系统保存框 + 逐片追加写盘。
   *
   * ⚠️ 这两条**必须**在桌面端实现：`shared/lib/file-transfer/sink.ts` 靠「desktop 且两条
   * 都在」认桌面支，缺一条就会**静默掉进 web 支**（FSA / Blob）—— 表现是「下载不弹保存框、
   * 也不再边收边落盘」，而且不报错。
   */
  fileAskSavePath: (defaultName) => window.fizzHost.fileAskSavePath(defaultName),
  fileSaveChunk: (target, data, append) =>
    window.fizzHost.fileSaveChunk(target, data, append),
  fileRemovePath: (target) => window.fizzHost.fileRemovePath(target),
  /**
   * 终端：**容器型项目**走服务端的 `docker exec`（`openBridgeContainerTerminal`，经 IPC 桥
   * 连内部 loopback 的 `/api/terminal`）；其余仍是主进程 node-pty（本机 PTY，web 端则是
   * 服务端 PTY（WS））。
   */
  openTerminal: (options) =>
    options.containerWorkspaceId ? openBridgeContainerTerminal(options) : openLocalTerminal(options),
  /** SSH 终端：连**进程内后端**的 `/api/ssh/terminal`（凭据由后端解密，渲染端只说 hostId） */
  openSshTerminal: openBridgeSshTerminal,
  /**
   * 状态推送：连**进程内后端**的内部 WS 端口（见上面的说明）。
   * 不实现的话 `web-host` 会退回浏览器实现 —— 那条在 `file://` 下根本拼不出地址，
   * desktop 的列表就只剩「进来时拉一次」，之后再也不更新。
   */
  openStateSocket: openBridgeStateSocket,
  /**
   * 浏览器画面：连**进程内后端**的内部 WS 端口，sessionId 由 conversationId 推出
   * （与后端引擎、Agent 工具是同一个会话）。desktop 必须实现这条，否则 UI 退回浏览器
   * 实现、`file://` 下拼不出地址，面板永远连不上。
   * `autostart` 透传成查询参数（只有面板「启动浏览器」后的那次重连会带），
   * 服务端据此连上就拉起浏览器。
   */
  openBrowserSocket: (conversationId, opts) =>
    openBridgeWorkbench(
      `/api/browser?sessionId=${encodeURIComponent(agentBrowserSessionId(conversationId))}${opts?.autostart ? '&autostart=1' : ''}`
    ),
  /**
   * 接口调试中继：走 IPC 桥打服务端的 `/api/api-client/ws/:connId`（与 web 端同一条路径）。
   * 远端目标由服务端中继连接，desktop 在这里只负责把浏览端与中继的帧转过去。
   */
  openApiClientSocket: (connId) => openBridgeWorkbench(apiClientWsPath(connId)),
  /** 远程访问（desktop 专属）：开关 / 端口 / 凭据与状态都由主进程持有，这里只透传 */
  loadRemoteAccess: () => window.fizzWindow.loadRemoteAccess(),
  saveRemoteAccess: (input) => window.fizzWindow.setRemoteAccess(input),
  /** 快捷功能：系统浏览器开链接 / 系统默认程序开路径（主进程做协议白名单） */
  openExternal: (url) => window.fizzHost.openExternal(url),
  openPath: (path) => window.fizzHost.openPath(path),
  /** 文件面板「在文件管理器中显示」：定位并选中单个文件（主进程按平台分岔） */
  revealInFileManager: (absPath) => window.fizzWindow.revealFile(absPath),
  /** 顶栏「打开」：文件管理器 / 检测到的 IDE（检测与启动都在主进程） */
  openFileManagerAt: (dir) => window.fizzWindow.openFileManager(dir),
  listIdes: () => window.fizzWindow.listIdes(),
  openIde: (id, dir) => window.fizzWindow.openIde(id, dir)
}
