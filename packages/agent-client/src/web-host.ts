/**
 * 传输层：**「谁来实现」的分发 + 浏览器兜底实现**。
 *
 * 本模块对外仍是 UI 唯一入口（`loadConnection` / `openTerminal` / `openStateSocket` …），
 * 但内部改成两级：
 *
 * 1. **宿主优先**：宿主（`AgentHost`）实现了对应能力就走宿主 —— desktop 用它把请求
 *    换成 IPC 桥、终端换成本机 PTY；
 * 2. **浏览器兜底**：宿主没实现（web 宿主可以一条都不实现）或还没注入时，走下面的
 *    `browser*` 实现 —— 同源 fetch / WS 打服务端。
 *
 * 这样 web 端行为与 Next 版逐行一致（零回归），desktop 只覆盖它真正不同的那几条。
 * 之所以不让 UI 各处直接调 `getAgentHost()`：调用点有十来处、且都需要兜底，
 * 把分发收在这里，UI 其余文件一行不用改。
 *
 * 客户端偏好（主题 / 权限档 / 面板宽度 / 终端字号…）**不在这里**：它们直接落
 * localStorage —— Electron 渲染进程同样有 localStorage，两个宿主行为一致，不需要抽象。
 */
import type { SshConnectProgress, TerminalServerMessage } from '@fizz/contracts/agent-api'
import {
  TERMINAL_WS_PATH,
  apiClientWsPath,
  sshTerminalWsPath
} from '@fizz/contracts/agent-api'
import { agentBrowserSessionId } from '@fizz/contracts'
import type { Connection } from './api'
import { normalizeServerBase, getServerBaseOverride } from './server-base'
import {
  getAgentHostOrNull,
  type SshTerminalOpenOptions,
  type StateSocket,
  type TerminalOpenOptions,
  type TerminalProcess,
  type WorkbenchSocket,
  type ZmodemBridge,
  type ZmodemFile
} from './host'
import { createLiveness } from './terminal-liveness'

// 传输契约的真源在 `host.ts`（它属于宿主能力面），这里只做转出，避免两处定义漂移
export type {
  SshTerminalOpenOptions,
  StateSocket,
  TerminalOpenOptions,
  TerminalProcess,
  WorkbenchSocket,
  ZmodemBridge,
  ZmodemFile
} from './host'

// ---------------------------------------------------------------------------
// 分发：宿主优先，浏览器兜底
// ---------------------------------------------------------------------------

/** 连接信息：desktop 由宿主持有；web 读 localStorage（见 `browserLoadConnection`） */
export function loadConnection(): Connection | null {
  const host = getAgentHostOrNull()
  return host ? host.loadConnection() : browserLoadConnection()
}

/** 持久化连接：desktop 由宿主持有；web 写 localStorage */
export function saveConnection(connection: Connection | null): void {
  const host = getAgentHostOrNull()
  if (host) host.saveConnection(connection)
  else browserSaveConnection(connection)
}

/** 开终端：desktop = 本机 PTY（IPC 桥）；web = 服务端 PTY（WS） */
export function openTerminal(options: TerminalOpenOptions): TerminalProcess {
  const host = getAgentHostOrNull()
  if (host?.openTerminal) return host.openTerminal(options)
  return browserOpenTerminal(options)
}

/** 开 SSH 终端：desktop = IPC 桥连服务端 `/api/ssh/terminal`；web = 同源 WS */
export function openSshTerminal(options: SshTerminalOpenOptions): TerminalProcess {
  const host = getAgentHostOrNull()
  if (host?.openSshTerminal) return host.openSshTerminal(options)
  return browserOpenSshTerminal(options)
}

/** 全局状态推送：宿主没实现就打服务端的 `/api/state` */
export function openStateSocket(): StateSocket {
  const host = getAgentHostOrNull()
  if (host?.openStateSocket) return host.openStateSocket()
  return browserOpenStateSocket()
}

/** 打开链接：desktop = 系统浏览器（主进程协议白名单）；web = `window.open` */
export function openExternal(url: string): Promise<{ ok: boolean; error?: string }> {
  const host = getAgentHostOrNull()
  if (host?.openExternal) return host.openExternal(url)
  return browserOpenExternal(url)
}

/** 浏览器画面：宿主没实现就打服务端的 `/api/browser` */
export function openBrowserSocket(
  conversationId: string,
  opts?: { autostart?: boolean }
): WorkbenchSocket {
  const host = getAgentHostOrNull()
  if (host?.openBrowserSocket) return host.openBrowserSocket(conversationId, opts)
  return browserOpenBrowserSocket(conversationId, opts)
}

/** 接口调试中继：宿主没实现就打服务端的 `/api/api-client/ws/:connId` */
export function openApiClientSocket(connId: string): WorkbenchSocket {
  const host = getAgentHostOrNull()
  if (host?.openApiClientSocket) return host.openApiClientSocket(connId)
  return browserOpenApiClientSocket(connId)
}

/**
 * ZMODEM（rz/sz）的文件选择 / 保存能力：宿主优先（desktop = 系统对话框），
 * 没实现就走浏览器兜底（见下面的 `browserZmodem`）。
 */
export function getZmodemBridge(): ZmodemBridge {
  const host = getAgentHostOrNull()
  return host?.zmodem ?? browserZmodem
}

// ---------------------------------------------------------------------------
// 浏览器兜底实现「连接信息」
// ---------------------------------------------------------------------------

/** 连接信息（token 与密码同级敏感，别塞进 URL） */
const CONNECTION_KEY = 'fizz.web.connection'

/**
 * WS 地址：**默认同源**（页面由 server 托管，WS 连当前 host，协议随页面 http/https 升 ws/wss）；
 * 连接信息里带 `serverBase` 时改连那个地址（跨源 —— 页面由别的 dev server / Capacitor
 * 本地 `www` 托管）。
 *
 * ⚠️ `serverBase` 的协议是 `http(s)://`，WS 必须换回 `ws(s)://`，直接拼会连不上。
 * 非默认端口要带上（`location.host` 自带端口，`URL.host` 同样带）。
 */
function wsUrlFor(connection: Connection | null, pathAndQuery: string): string {
  const serverBase = normalizeServerBase(connection?.serverBase)
  if (!serverBase) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}${pathAndQuery}`
  }
  const { host } = new URL(serverBase)
  return `${serverBase.startsWith('https:') ? 'wss' : 'ws'}://${host}${pathAndQuery}`
}

function browserLoadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(CONNECTION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Connection>
    if (typeof parsed.token !== 'string' || !parsed.token) return null
    // 落到连接上的优先是显式覆盖（独立 vite 工程 / Capacitor 本地 `www`），其次才是存下来的值
    const serverBase = getServerBaseOverride() ?? normalizeServerBase(parsed.serverBase)
    return { token: parsed.token ?? '', ...(serverBase ? { serverBase } : {}) }
  } catch {
    return null
  }
}

function browserSaveConnection(connection: Connection | null): void {
  if (!connection) localStorage.removeItem(CONNECTION_KEY)
  else localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection))
}

/**
 * 兜底实现取连接：走上面的 `loadConnection`（**宿主注入了就以宿主为准**），没连接就抛。
 *
 * 下面这些 `browser*` 是「宿主没实现该能力」时的兜底，但「连接存在哪」归宿主管：
 * 手机壳把连接存在 `fizz.mobile.connection`（见 `apps/mobile/src/host.ts`），而
 * `browserLoadConnection` 只认 `fizz.web.connection` —— 兜底里直接调它会拿到 `null`，
 * 于是终端 / 工作台 / `/api/state` 全部抛「未连接服务端」，症状是**一条 WS 都连不上**
 * 而 HTTP（走宿主 `loadConnection`）一切正常。
 */
function requireConnection(): Connection {
  const connection = loadConnection()
  if (!connection) throw new Error('未连接服务端')
  return connection
}

// ---------------------------------------------------------------------------
// 浏览器兜底实现「终端：服务端 PTY（WS）」
// ---------------------------------------------------------------------------

/**
 * 服务端终端 WS 的公共实现：给一条已拼好的 WS 地址，按终端协议接管这条连接。
 *
 * 协议与 contracts 一致：客户端 → JSON 文本（input / resize / ping），
 * 服务端 → 二进制帧（PTY 输出）+ JSON 文本（exit / pong / progress）。
 * `/api/terminal`（本机 PTY）与 `/api/ssh/terminal`（SSH）协议逐条相同，故共用 ——
 * 区别只在 SSH 那条会多发 `progress` 建连进度帧（本机 PTY 不发）。
 */
function openTerminalWs(wsUrl: string): TerminalProcess {
  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'

  const dataSubs = new Set<(data: Uint8Array) => void>()
  const exitSubs = new Set<(exitCode: number, reason?: string) => void>()
  /** SSH 建连进度订阅（本机 PTY `/api/terminal` 不发 progress 帧，订阅了也不会触发） */
  const progressSubs = new Set<(progress: SshConnectProgress) => void>()
  /** WS 就绪前的输入先攒着（xterm 建好那一刻用户就可能敲键）；二进制（ZMODEM）同样入队 */
  let queue: Array<string | Uint8Array> = []
  let exited = false
  /** 我们自己主动关的（换会话 / 收工）：那不算 shell 退出，不能再报一次 */
  let closedByUs = false

  const notifyExit = (code: number, reason?: string): void => {
    if (exited) return
    exited = true
    exitSubs.forEach((cb) => cb(code, reason))
  }

  /**
   * 一段输入：文本走 JSON 控制帧（`{type:'input',data}`），二进制（ZMODEM 帧）走
   * **裸二进制帧** —— 服务端 `ws.on('message')` 收到 `isBinary` 就按原始字节喂给会话，
   * 免掉 base64 的 33% 膨胀与编解码开销。两侧帧序由 WS 保证，不会乱。
   *
   * ⚠️ 二进制要**复制成 `ArrayBuffer` 后端的视图**再发：裸 `Uint8Array` 的类型参数是
   * `ArrayBufferLike`（含 SharedArrayBuffer），不满足 lib.dom 的 `BufferSource`。
   * 协议帧只有几 KB，复制的代价可以忽略。
   */
  const sendInput = (chunk: string | Uint8Array): void => {
    if (typeof chunk === 'string') ws.send(JSON.stringify({ type: 'input', data: chunk }))
    else ws.send(new Uint8Array(chunk))
  }

  /**
   * 保活：定时发 `ping`（撑过代理空闲超时）+ 用回帧探活。
   *
   * 判定逻辑在 `lib/terminal-liveness.ts` 里，单独成模块是为了能在 Node 里用假时钟
   * 复现「页面切后台、定时器被浏览器节流」这个场景。
   */
  const liveness = createLiveness({
    ping: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
    },
    declareDead: () => {
      // 服务端 / 链路已死：主动断开（不带 closedByUs，让 UI 收到「终端连接已断开」）
      try {
        ws.close(4000, '终端心跳超时')
      } catch {
        // 已经关了
      }
    }
  })

  ws.onopen = () => {
    const pending = queue
    queue = []
    for (const chunk of pending) sendInput(chunk)
    liveness.start()
  }
  ws.onmessage = (event) => {
    // 收到**任何**一帧（pong / PTY 输出 / exit）都说明链路是活的
    liveness.noteFrame()
    if (typeof event.data !== 'string') {
      const data = new Uint8Array(event.data as ArrayBuffer)
      dataSubs.forEach((cb) => cb(data))
      return
    }
    try {
      const message = JSON.parse(event.data) as TerminalServerMessage
      // 服务端明确告知的退出：这条才带 shell 的真实退出码（`pong` 在上面已按「收到回帧」处理）
      if (message.type === 'exit') notifyExit(message.exitCode)
      // SSH 建连进度：渲染端据此浮出连接进度卡片（本机 PTY 不会发这条）
      else if (message.type === 'progress') {
        const { stage, detail } = message
        progressSubs.forEach((cb) => cb({ stage, detail }))
      }
    } catch {
      // 非 JSON 的文本帧：忽略
    }
  }
  /**
   * ⚠️ **WS 断开 ≠ shell 退出**。`-1` 是这里的兜底码，含义只有一句：
   * 「没收到 exit 帧，连接就没了」—— 网络断了 / 服务端重启 / 浏览器掐掉后台标签的 WS
   * 都会走到这儿。所以：
   * - 主动 `kill()` 的（换终端、关面板）**直接不报**：否则旧会话的 close 会晚一拍落到
   *   新面板上，显示成「（已退出，代码 -1）」，而新终端活得好好的；
   * - 被动断开时把服务端的 close reason 带上（启动失败时服务端会 `close(1011, 原因)`），
   *   拿不到 reason（1006 之类）才退回一句人话，别只丢个 -1 让人猜。
   */
  ws.onclose = (event) => {
    liveness.stop()
    if (closedByUs) return
    notifyExit(-1, event.reason || '终端连接已断开')
  }

  return {
    write: (data) => {
      if (ws.readyState === WebSocket.OPEN) sendInput(data)
      else queue.push(data)
    },
    resize: (nextCols, nextRows) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: nextCols, rows: nextRows }))
      }
    },
    kill: () => {
      if (closedByUs) return
      closedByUs = true
      try {
        ws.close()
      } catch {
        // 已经关了
      }
    },
    /**
     * 「停止」：发 `{type:'stop'}`，让**服务端**按进程组杀前台那条命令的整棵树。
     *
     * 客户端自己做不到：浏览器看不见 PTY 里的进程树，只能往流里写 `\x03`（那是请求，
     * 程序可以不理会）。服务端收到 stop 帧才真正 SIGTERM → SIGKILL。
     * 只对本机 PTY 有效；SSH 通道的服务端会忽略它（远端进程组不在宿主视野里）。
     */
    stop: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }))
    },
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

/** 本机终端：WS 打 `/api/terminal`（token / cwd / 初始尺寸 / shell / 启动参数都在查询参数里） */
function browserOpenTerminal({
  cwd,
  cols,
  rows,
  shellId,
  args,
  autoCommand,
  containerWorkspaceId,
  containerShell
}: TerminalOpenOptions): TerminalProcess {
  const connection = requireConnection()
  return openTerminalWs(
    wsUrlFor(
      connection,
      `${TERMINAL_WS_PATH}?token=${encodeURIComponent(connection.token)}` +
        `&cwd=${encodeURIComponent(cwd)}&cols=${cols}&rows=${rows}` +
        // shell 是 ShellProfile.id；不传 = 服务端的平台默认（服务端认不出来也会回落）
        (shellId ? `&shell=${encodeURIComponent(shellId)}` : '') +
        // 额外启动参数以 JSON 数组上送（服务端只认字符串数组，坏值当没传）
        (args?.length ? `&args=${encodeURIComponent(JSON.stringify(args))}` : '') +
        // 启动后自动执行的命令
        (autoCommand ? `&auto=${encodeURIComponent(autoCommand)}` : '') +
        // 容器型项目的终端：给**工作区 id**（服务端现算容器名并校验），宿主侧的
        // shell / args / cwd 在服务端都不再参与（见 pty.ts 的 TerminalContainerTarget）
        (containerWorkspaceId ? `&container=${encodeURIComponent(containerWorkspaceId)}` : '') +
        (containerShell ? `&containerShell=${encodeURIComponent(containerShell)}` : '')
    )
  )
}

/**
 * SSH 终端：WS 打 `/api/ssh/terminal`（只传 hostId，凭据由服务端解密后连）。
 * 服务端连不上 / 认证失败会把错误行写进输出再 close，UI 侧按普通终端处理即可。
 */
function browserOpenSshTerminal({ hostId, cols, rows, cwd }: SshTerminalOpenOptions): TerminalProcess {
  const connection = requireConnection()
  return openTerminalWs(
    wsUrlFor(
      connection,
      `${sshTerminalWsPath({ hostId, cols, rows, ...(cwd ? { cwd } : {}) })}&token=${encodeURIComponent(connection.token)}`
    )
  )
}

// ---------------------------------------------------------------------------
// 浏览器兜底实现「工作台：节点 / 任务容器 bridge 的反代 WS」
// ---------------------------------------------------------------------------

/**
 * 节点工作台连接（会话流 / PTY）：**双向** WS，服务端反向代理到容器 bridge。
 *
 * 与「日志订阅」的差别是「不重连、不记 offset」—— 它是有状态的交互通道
 * （agent 会话 / shell），断线后从零重连没有意义（PTY 的 scrollback 在容器侧、
 * 会话历史在 agent 侧，重连后各自都会重放），所以**断开就把原因交给 UI**，
 * 由用户决定要不要重开（与 `openTerminal` 同款处理）。
 */
/**
 * 浏览器画面 WS（web 兜底）：同源打 `/api/browser`，sessionId 由 conversationId 推出来
 * （与后端引擎、Agent 工具是同一个会话）。token 走查询参数（浏览器 WebSocket 拿不到
 * 自定义请求头）。会话不存在时服务端会带原因 close，UI 据此显示「浏览器未启动」。
 *
 * `autostart=1` = 连上就把浏览器拉起来（只有面板「启动浏览器」后的那次重连会带）。
 */
function browserOpenBrowserSocket(
  conversationId: string,
  opts?: { autostart?: boolean }
): WorkbenchSocket {
  const connection = requireConnection()
  const autostart = opts?.autostart ? '&autostart=1' : ''
  const url = wsUrlFor(
    connection,
    `/api/browser?sessionId=${encodeURIComponent(agentBrowserSessionId(conversationId))}&token=${encodeURIComponent(connection.token)}${autostart}`
  )
  return createWorkbenchSocket(url)
}

/**
 * 接口调试中继 WS（web 兜底）：同源打 `/api/api-client/ws/:connId`。
 *
 * 与 `createWorkbenchSocket` 的差别只有一处：**就绪前的上行帧要缓冲**。
 * 调用方（WsPage）建好 socket 后立刻发首帧 `connect`（此时 `readyState` 多半还是
 * CONNECTING），`createWorkbenchSocket.send` 在这种状态下会静默丢弃 —— 那样目标永远
 * 连不起来。所以这里把未就绪的帧攒到 `onopen` 再按序补发。
 */
function browserOpenApiClientSocket(connId: string): WorkbenchSocket {
  const connection = requireConnection()
  const ws = new WebSocket(
    wsUrlFor(connection, `${apiClientWsPath(connId)}?token=${encodeURIComponent(connection.token)}`)
  )
  ws.binaryType = 'arraybuffer'

  const messageSubs = new Set<(data: string | ArrayBufferLike, binary: boolean) => void>()
  const closeSubs = new Set<(reason?: string) => void>()
  let pending: string[] = []
  let closedByUs = false

  ws.onopen = () => {
    const queued = pending
    pending = []
    for (const text of queued) ws.send(text)
  }
  ws.onmessage = (event) => {
    // 中继协议全部是 JSON 文本帧；二进制帧不该出现，忽略
    if (typeof event.data === 'string') messageSubs.forEach((cb) => cb(event.data as string, false))
  }
  ws.onclose = (event) => {
    if (closedByUs) return
    closeSubs.forEach((cb) => cb(event.reason || '中继连接已断开'))
  }
  ws.onerror = () => undefined

  return {
    send: (data) => {
      const text = typeof data === 'string' ? data : ''
      if (!text) return
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
      else if (ws.readyState === WebSocket.CONNECTING) pending.push(text)
    },
    onMessage: (cb) => {
      messageSubs.add(cb)
      return () => messageSubs.delete(cb)
    },
    onClose: (cb) => {
      closeSubs.add(cb)
      return () => closeSubs.delete(cb)
    },
    close: () => {
      if (closedByUs) return
      closedByUs = true
      pending = []
      try {
        ws.close()
      } catch {
        // 已经关了
      }
    }
  }
}

/**
 * 工作台 WS 的公共骨架。
 *
 * 刻意不重连、不记 offset —— 它是有状态的交互通道（agent 会话 / shell），断线后从零
 * 重连没有意义，所以断线就把原因交给 UI，由用户决定要不要重开（与 `openTerminal` 同款处理）。
 */
function createWorkbenchSocket(url: string): WorkbenchSocket {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  const messageSubs = new Set<(data: string | ArrayBufferLike, binary: boolean) => void>()
  const closeSubs = new Set<(reason?: string) => void>()
  let closedByUs = false

  ws.onmessage = (event) => {
    const binary = typeof event.data !== 'string'
    const data = binary ? (event.data as ArrayBuffer) : (event.data as string)
    messageSubs.forEach((cb) => cb(data, binary))
  }
  /**
   * `reason` 是服务端 close 时给的（节点 / 任务没在跑、连不上容器时都带一句人话）；
   * 拿不到（1006 之类）才退回一句通用说明，别只丢一个「已断开」让人猜。
   */
  ws.onclose = (event) => {
    if (closedByUs) return
    closeSubs.forEach((cb) => cb(event.reason || '工作台连接已断开'))
  }
  ws.onerror = () => undefined

  return {
    send: (data) => {
      if (ws.readyState !== WebSocket.OPEN) return
      // 二进制帧要复制成 ArrayBuffer 后端再发（见 openTerminalWs 的 sendInput 说明）
      ws.send(data instanceof Uint8Array ? new Uint8Array(data) : data)
    },
    onMessage: (cb) => {
      messageSubs.add(cb)
      return () => messageSubs.delete(cb)
    },
    onClose: (cb) => {
      closeSubs.add(cb)
      return () => closeSubs.delete(cb)
    },
    close: () => {
      if (closedByUs) return
      closedByUs = true
      try {
        ws.close()
      } catch {
        // 已经关了
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 浏览器兜底实现「全局状态推送」
// ---------------------------------------------------------------------------

/**
 * 全局状态 WebSocket（`/api/state`）：服务端把各数据域快照推下来，前端不再轮询。
 * 鉴权同其它 WS：`?token=` 查询参数（浏览器 `WebSocket` 拿不到自定义请求头）。
 */
function browserOpenStateSocket(): StateSocket {
  const connection = requireConnection()
  const url = wsUrlFor(connection, `/api/state?token=${encodeURIComponent(connection.token)}`)
  const ws = new WebSocket(url)

  const messageSubs = new Set<(data: string) => void>()
  const openSubs = new Set<() => void>()
  const closeSubs = new Set<(reason?: string) => void>()
  let closedByUs = false

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') messageSubs.forEach((cb) => cb(event.data))
  }
  ws.onopen = () => {
    openSubs.forEach((cb) => cb())
  }
  ws.onclose = (event) => {
    if (closedByUs) return
    closeSubs.forEach((cb) => cb(event.reason || '状态连接已断开'))
  }
  ws.onerror = () => undefined

  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    },
    onMessage: (cb) => {
      messageSubs.add(cb)
      return () => messageSubs.delete(cb)
    },
    onOpen: (cb) => {
      openSubs.add(cb)
      return () => openSubs.delete(cb)
    },
    onClose: (cb) => {
      closeSubs.add(cb)
      return () => closeSubs.delete(cb)
    },
    close: () => {
      if (closedByUs) return
      closedByUs = true
      try {
        ws.close()
      } catch {
        // 已经关了
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 浏览器兜底实现「浏览器自有能力」
// ---------------------------------------------------------------------------

/** 快捷功能「打开链接」：浏览器自己开新标签页（noopener 防 opener 攻击） */
function browserOpenExternal(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const protocol = new URL(url).protocol
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') {
      return Promise.resolve({ ok: false, error: `不允许的协议：${protocol}` })
    }
    window.open(url, '_blank', 'noopener,noreferrer')
    return Promise.resolve({ ok: true })
  } catch {
    return Promise.resolve({ ok: false, error: '链接格式不合法' })
  }
}

// ---------------------------------------------------------------------------
// 浏览器兜底实现「ZMODEM（rz/sz）的文件选择 / 保存」
// ---------------------------------------------------------------------------

/**
 * 去掉路径分隔符与控制字符。浏览器下载名与桌面端保存框的默认名都用它 ——
 * 远端给的文件名是不可信输入（`../../x`、带控制字符的名字都出现过）。
 */
function sanitizeFileName(raw: string): string {
  return raw.replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '').trim() || 'file'
}

/** 触发一次浏览器下载（Blob + `<a download>`），返回是否已发起 */
function triggerDownload(fileName: string, data: Uint8Array): boolean {
  try {
    // 复制一份：Blob 会持有这段内存，而入参数组后面可能被 zmodem.js 复用
    const blob = new Blob([new Uint8Array(data)])
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = sanitizeFileName(fileName)
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 立刻 revoke 在部分浏览器上会让下载中断：交给浏览器读完再清（一分钟足够）
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return true
  } catch {
    return false
  }
}

// ---------- 文件选择：优先 File System Access API ----------

/**
 * File System Access API 的最小形状。
 *
 * 自己声明而不是用 lib.dom：这套 API（`showOpenFilePicker`）只在 Chromium 系的
 * **安全上下文**里有，TS 的 DOM 声明不保证带上；Firefox / Safari、以及 `http://<局域网 IP>`
 * 这种非安全上下文压根没有，所以调用前必须判存在。
 */
interface FilePickerHandle {
  getFile: () => Promise<File>
}
interface FilePickerWindow {
  showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<FilePickerHandle[]>
}

/** 有 File System Access API 就返回 window，否则 null（不支持的浏览器要回退） */
function fileSystemPicker(): FilePickerWindow | null {
  const api = window as unknown as FilePickerWindow
  return typeof api.showOpenFilePicker === 'function' ? api : null
}

/**
 * 用**系统原生选择框**选文件（File System Access API 版）。
 *
 * 为什么优先它：这是浏览器给「弹系统选框」的正规入口（不往 DOM 里塞表单控件、还要得到 File
 * handle），比隐藏 `<input type="file">` + `click()` 干净（兜底仍留在 `pickFilesViaInput`）。
 *
 * ⚠️ **别再把「rz 选文件时鼠标指针消失」记到这条路的账上。** 那个坑曾一度被归因成「隐藏
 * input 的锅」，于是换了 FSA —— 但后来用户在走 FSA 的情况下同样复现，实测根因是
 * **Win11 24H2 + Chromium + 非默认的鼠标指针方案**（「文本选择」光标不绘制，而系统选框里
 * 几乎全是需要它的区域），与我们用哪条路弹框无关，页面侧改不了。系统侧的解法见
 * `AGENTS.md` §51。
 *
 * 返回 `null` = 这次用不了（没有用户手势 / 上下文不安全），调用方回退到 `<input>`。
 */
async function pickFilesViaFileSystem(api: FilePickerWindow): Promise<ZmodemFile[] | null> {
  try {
    const handles = await api.showOpenFilePicker!({ multiple: true })
    return await Promise.all(
      handles.map(async (handle) => {
        const file = await handle.getFile()
        return {
          name: file.name,
          size: file.size,
          data: new Uint8Array(await file.arrayBuffer())
        }
      })
    )
  } catch (err) {
    // 用户在框里点了取消：与「没选文件」同义，按空结果收场
    if (err instanceof DOMException && err.name === 'AbortError') return []
    // 其余（没有用户手势 / 非安全上下文）交给 `<input>` 那条路
    return null
  }
}

/**
 * 强制浏览器重算一次鼠标指针样式（改一次 `document.body.style.cursor` 再下一帧还原）。
 *
 * ⚠️ 这是**保险，不是那个 24H2 坑的解法**：用户报的「rz 选文件时指针消失」真因在系统侧
 * （Win11 24H2 + 非默认指针方案，见 `pickFilesViaFileSystem` 与 `docs/lessons/ui.md`
 * 「终端传文件（ZMODEM）」），页面改不了。
 * 留着它是给「系统框关掉之后 Chromium 不重新应用指针样式」这类相邻行为兜一手 ——
 * 代价只是一次样式写入（一帧内还原，观感无变化）。**别把它当成已修复的证据**。
 */
function refreshMouseCursor(): void {
  const body = document.body
  const prev = body.style.cursor
  body.style.cursor = 'default'
  // 同一帧里改回去会被合并成一次、看不到效果：等下一帧再还原
  requestAnimationFrame(() => {
    body.style.cursor = prev
  })
}

/**
 * 兜底选文件：临时造一个 `<input type="file" multiple>` 再点它。
 *
 * 浏览器要求**用户手势**才允许打开文件框 —— rz 的检测紧跟用户按下回车（远端
 * ZRQINIT 一个往返就到，几十毫秒），落在 Chrome 的瞬时激活窗口（约 5s）内，所以能开。
 *
 * 框关掉后补一次指针重算（见 `refreshMouseCursor` 的说明：保险，不是修 24H2 那个坑）。
 */
function pickFilesViaInput(): Promise<ZmodemFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    // 挂到 body 上再点：某些浏览器对游离节点的 click 不弹框
    document.body.appendChild(input)
    let settled = false
    /** 收尾：摘掉 input、回结果（只生效一次） */
    const finish = (files: ZmodemFile[]): void => {
      if (settled) return
      settled = true
      input.remove()
      // 取消 / 空选也要重算（框关掉了，指针就该回来）
      refreshMouseCursor()
      resolve(files)
    }
    /** `change` 是否已经到过 —— 到了就说明用户做出了选择，focus 兜底不该再插手 */
    let chosen = false
    input.addEventListener('change', () => {
      // 框刚关上：不等读文件读完就先重算指针（读大文件要几百毫秒）
      refreshMouseCursor()
      /**
       * ⚠️ 这里**不能**等读文件读完再置位：读大文件要几百毫秒，而下面 focus
       * 兜底的计时器是 500ms —— 不先认领，兜底会把结果抢着回成空数组，
       * 用户刚选好的文件就白选了（`finish` 只生效一次）。
       */
      if (settled) return
      chosen = true
      const picked = Array.from(input.files ?? [])
      if (picked.length === 0) {
        finish([])
        return
      }
      void Promise.all(
        picked.map(async (file) => ({
          name: file.name,
          size: file.size,
          data: new Uint8Array(await file.arrayBuffer())
        }))
      ).then(finish)
    })
    // 取消选择不会派发 change：窗口重新拿到焦点后兜一次（`chosen` 已置位时空转）
    window.addEventListener(
      'focus',
      () =>
        window.setTimeout(() => {
          if (!chosen) finish([])
        }, 500),
      { once: true }
    )
    input.click()
  })
}

/**
 * 浏览器兜底的 ZMODEM 文件能力（desktop 走系统对话框，见宿主实现）。
 *
 * - `pickFiles`：优先 File System Access API（见 `pickFilesViaFileSystem`），
 *   不支持时才回退到隐藏 `<input type="file">`。
 * - `askSavePath`：浏览器**没有路径概念**，退化成「用清理过的文件名当落点」，
 *   永不取消（用户想中途放弃就用终端上的传输取消按钮）；真正落盘在 `saveFileTo`。
 * - `saveFileTo`：Blob + `<a download>` 触发下载。多文件会连下几份，浏览器可能
 *   提示「是否允许下载多个文件」。
 */
const browserZmodem: ZmodemBridge = {
  pickFiles: async () => {
    try {
      const api = fileSystemPicker()
      if (api) {
        const files = await pickFilesViaFileSystem(api)
        // `null` = 这条路这次用不了（没有用户手势 / 上下文不安全），往下走兜底
        if (files) return files
        console.info(
          '[zmodem] File System Access API 这次没能用上（多半是瞬时激活已过期或上下文不安全），改用隐藏 input 选文件'
        )
      } else {
        // 非安全上下文（如 http://<局域网 IP>）与 Firefox / Safari 都走到这里。
        // 留个日志：报障「选文件框不对劲」时，第一件事就是确认走的哪条路
        // （曾因此把「指针消失」误判成这条路的问题，见 `pickFilesViaFileSystem`）
        console.info('[zmodem] 当前上下文没有 File System Access API，改用隐藏 input 选文件')
      }
      return await pickFilesViaInput()
    } finally {
      // 框关掉之后再补一次（兜底那条路内部已经更早补过；这里覆盖 FSA 那条）
      refreshMouseCursor()
    }
  },
  askSavePath: (defaultName) => Promise.resolve(sanitizeFileName(defaultName)),
  saveFileTo: (target, data) =>
    Promise.resolve(triggerDownload(target, data) ? target : null)
}
