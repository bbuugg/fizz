/**
 * desktop 渲染端 ↔ 主进程的传输桥（**主进程侧**）。
 *
 * 渲染端不碰网络：所有请求经 IPC 交给主进程，主进程直接丢给**进程内**的 Hono 应用
 * （`backendManager.fetch`）—— 零端口、零 token、不出进程。
 *
 * 两条通路：
 * - `agent:http`：一次性请求（invoke，等结果回来）；
 * - `agent:sse:open` + `agent:sse:close`（invoke 打开/关闭）配合 `agent:sse:chunk`
 *   / `agent:sse:end`（主进程主动推）：流式请求。
 *
 * 为什么 SSE 要拆成「打开 + 推送」：`ipcRenderer.invoke` 只能一次性返回，拿不到
 * 「边读边推」；而 AI 对话必须实时出字。渲染端把这两类事件拼成一个 `ReadableStream`，
 * 于是 `@fizz/agent-client` 的数据层照旧是「fetch + 读 SSE 字节流」，一行都不用改。
 *
 * `closeSse` 只断开**这条读流**（渲染端重载 / 窗口销毁时用），服务端那条 run 照跑
 * —— 要真停下它得显式调 `/api/chat/abort`（与根应用 `server-client.openSse` 的语义一致）。
 *
 * 另外挂了一条 `agent:pickDirectory`：它不是传输，但同样是「渲染端碰主进程」的能力
 * （选工作区目录要的是**本机**真实路径，渲染进程给不了），所以一并注册在这里，
 * 桌面端不必再单独维护一套 IPC。
 */
import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import {
  AGENT_IPC,
  type AgentHttpResponse,
  type AgentSseOpenRequest,
  type AgentSseOpenResult,
  type AgentTransportRequest,
  type PtyDataEvent,
  type PtyExitEvent,
  type PtyOpenRequest,
  type PtyOpenResult,
  type WsOpenRequest,
  type WsOpenResult,
  type WsSendPayload,
  type ZmodemPickedFile
} from './channels'
import { getPtySession, openPtySession } from './pty'
import { createWsBatcher } from './ws-batch'
import { backendManager } from './manager'
import { openExternalUrl } from './external-link'
import { registerLocalFileIpc } from './local-files'

/** 进程内直连用的假 origin：Hono 只拿它做路由匹配，不发网络请求 */
const ORIGIN = 'http://fizz.local'

function buildRequest(input: AgentTransportRequest, signal?: AbortSignal): Request {
  const method = input.method ?? 'GET'
  const hasBody = input.body !== undefined && method !== 'GET' && method !== 'HEAD'
  return new Request(`${ORIGIN}${input.path}`, {
    method,
    ...(input.headers ? { headers: input.headers } : {}),
    ...(signal ? { signal } : {}),
    ...(hasBody ? { body: input.body } : {})
  })
}

interface StreamHandle {
  controller: AbortController
  sender: WebContents
}

interface HttpRequestHandle {
  controller: AbortController
  sender: WebContents
}

/** 活跃的 SSE 读流。key 是渲染端给的 streamId */
const streams = new Map<string, StreamHandle>()
/** 活跃的一次性请求。key 是渲染端给的 requestId（桌面上传取消用） */
const httpRequests = new Map<string, HttpRequestHandle>()
/** PTY 会话归属：sessionId → 打开它的 webContents（窗口销毁时收掉它的终端） */
const ptyOwners = new Map<string, WebContents>()
/**
 * 活跃的 WebSocket 桥：streamId → 主进程代为建立的那条连接。
 *
 * 渲染端**不碰网络** —— 真正的 WebSocket 由主进程建（目标是进程内后端的内部
 * loopback server，见 `manager.ts`），帧经 IPC 转发。与 SSE / PTY 同一套模式，
 * 「渲染端与后端的往来只走 IPC、不出进程」对四类通道一体成立。
 */
const wsStreams = new Map<string, WebSocket>()
/** WS 归属：streamId → 打开它的 webContents（窗口销毁时一并收掉） */
const wsOwners = new Map<string, WebContents>()

function httpRequestKey(sender: WebContents, requestId: string): string {
  return `${sender.id}:${requestId}`
}

// ---------------------------------------------------------------------------
// WS 下行合批
// ---------------------------------------------------------------------------

/**
 * 一帧一条 IPC 消息会让一次 `ls -la` 变成几百次 `webContents.send`。合批逻辑在
 * `./ws-batch`（**纯逻辑、零依赖**）—— 单拆出来是为了让 `scripts/verify-ws-batch.mjs`
 * 能直接跑真代码，而不是抄一份到测试里漂掉。
 *
 * 这里只提供 `safeSend`：把「已销毁就丢弃」这道闸接到合批器的出口上。
 */
const wsBatcher = createWsBatcher({
  onSend: (streamId, data) => {
    const sender = wsOwners.get(streamId)
    if (!sender) return
    safeSend(sender, AGENT_IPC.wsData, { streamId, data })
  }
})

/** 已经挂过生命周期监听的 webContents（避免重复挂） */
const hooked = new WeakSet<WebContents>()
let registered = false

/**
 * 主进程**主动推**事件给渲染端的唯一出口 —— 必须先确认那个 webContents 还活着。
 *
 * 为什么非有这道闸：退出流程里 `will-quit` → `killAllPtySessions()` 会杀掉 shell，
 * 而 node-pty 的 `onData` / `onExit` 是**异步**回调进来的（ConPTY 走 socket），
 * 那时窗口早已销毁。裸 `webContents.send()` 会抛
 * `TypeError: Object has been destroyed`，Electron 把它当未捕获异常 → 弹
 * 「A JavaScript error occurred in the main process」对话框（关闭应用时必现）。
 *
 * `isDestroyed()` 与 `send()` 之间仍有一个极窄的竞态窗口（同一 tick 内销毁），
 * 所以再兜一层 try/catch：**推送失败从来不该影响业务**，静默丢弃即可。
 */
function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return
  try {
    sender.send(channel, payload)
  } catch {
    // 窗口在判定与发送之间被销毁：丢掉这一条，不往上冒
  }
}

/**
 * 收尾一条流并通知渲染端。已被主动关闭（`sseClose` / 窗口销毁）的流不在这里 —— 
 * 那种情况 map 里已经没有条目，直接 no-op。
 */
function finish(streamId: string, error?: string): void {
  const handle = streams.get(streamId)
  if (!handle) return
  streams.delete(streamId)
  safeSend(handle.sender, AGENT_IPC.sseEnd, error ? { streamId, error } : { streamId })
}

/** 把这个 webContents 的流全收掉（页没了，读流不该继续往它推） */
function dropStreamsOf(sender: WebContents): void {
  for (const [id, handle] of streams) {
    if (handle.sender !== sender) continue
    streams.delete(id)
    handle.controller.abort()
  }
}

/** 页面卸载 / 窗口关闭时中止它发起的普通 HTTP 请求（例如仍在上传的附件）。 */
function dropHttpRequestsOf(sender: WebContents): void {
  for (const [id, handle] of httpRequests) {
    if (handle.sender !== sender) continue
    httpRequests.delete(id)
    handle.controller.abort()
  }
}

/**
 * 收掉这个 webContents 开的 WS 桥。顺序与 `wsClose` 一致：**先冲尾巴、再摘 owner、
 * 最后 close**（合批器发消息时按 streamId 找发送方，见 `onSend` / `onclose` 的注释）。
 */
function dropWsOf(sender: WebContents): void {
  for (const [id, owner] of wsOwners) {
    if (owner !== sender) continue
    wsBatcher.flush(id)
    wsOwners.delete(id)
    const socket = wsStreams.get(id)
    wsStreams.delete(id)
    try {
      socket?.close()
    } catch {
      // 已经关了
    }
  }
}

/**
 * 挂窗口 / 页面的生命周期收尾。幂等（`hooked` 挡重复挂）。
 *
 * 两个时机，缺一不可：
 * - **窗口销毁**（`destroyed`）：常规退出路径；
 * - **整页导航**（`did-start-navigation`，主框架、非同文档）：dev 的 HMR 全量刷新、
 *   DevTools 的 Reload 都走这条 —— `webContents` **没有**销毁，但旧页那份 JS 上下文
 *   已经丢了，它开的桥再也没人认领。不收的话：服务端那条 SSH 会话 / `/api/state`
 *   订阅照跑（白占一条连接、多一份推送），而且那些 streamId 一直被主进程占着，
 *   渲染端重载后序号归零就会撞上「streamId 已存在」（见 `apps/desktop/src/renderer/host.ts`
 *   的 `bridgeIdPrefix`）。
 *
 * PTY **不在这里收**：它不占 streamId，且 node-pty 会话没有「跨页面接管」的协议
 * （`sessionId` 只活在旧页内存里）；在重载时杀掉可能误伤用户正在跑的构建，
 * 所以宁可留给 `destroyed` 那道兜底。
 */
function hookLifecycle(sender: WebContents): void {
  if (hooked.has(sender)) return
  hooked.add(sender)
  sender.once('destroyed', () => {
    dropStreamsOf(sender)
    dropHttpRequestsOf(sender)
    // 它开的终端也一并杀掉（shell 是给人交互用的，窗口都没了就没人看了）
    for (const [id, owner] of ptyOwners) {
      if (owner !== sender) continue
      ptyOwners.delete(id)
      getPtySession(id)?.kill()
    }
    // 它开的 WebSocket 桥也一并关掉（状态推送 / 工作台，没人看了就该断）
    dropWsOf(sender)
  })
  sender.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    dropStreamsOf(sender)
    dropHttpRequestsOf(sender)
    dropWsOf(sender)
  })
}

async function pump(
  streamId: string,
  body: ReadableStream<Uint8Array>
): Promise<void> {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const handle = streams.get(streamId)
      // 流已被关掉 / 窗口已销毁：静默收工，不再推
      if (!handle || handle.sender.isDestroyed()) return
      safeSend(handle.sender, AGENT_IPC.sseChunk, { streamId, chunk: value })
    }
    finish(streamId)
  } catch (err) {
    finish(streamId, err instanceof Error ? err.message : String(err))
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/**
 * 注册传输桥的 IPC 处理器。幂等（重复调用直接返回，避免 `ipcMain.handle` 重名报错）。
 * 在 `app.whenReady()` 之后调用。
 */
export function registerAgentTransportIpc(): void {
  if (registered) return
  registered = true

  // 「用本应用打开的本机 Markdown 文件」那三条（含路径闸）单独一个模块：
  // 闸的取舍值得一整段注释，塞这里会把传输桥的文件头淹掉。
  registerLocalFileIpc()

  ipcMain.handle(AGENT_IPC.http, async (event, input: AgentTransportRequest): Promise<AgentHttpResponse> => {
    const controller = new AbortController()
    const requestId = input.requestId
    const key = requestId ? httpRequestKey(event.sender, requestId) : undefined
    if (key) {
      hookLifecycle(event.sender)
      httpRequests.set(key, { controller, sender: event.sender })
    }
    try {
      const res = await backendManager.fetch(buildRequest(input, controller.signal))
      const body = await res.arrayBuffer()
      return {
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
        body
      }
    } finally {
      if (key && httpRequests.get(key)?.controller === controller) {
        httpRequests.delete(key)
      }
    }
  })

  ipcMain.handle(AGENT_IPC.httpCancel, (event, requestId: string): void => {
    const key = httpRequestKey(event.sender, requestId)
    const handle = httpRequests.get(key)
    // A renderer may only cancel requests it owns.
    if (!handle || handle.sender !== event.sender) return
    httpRequests.delete(key)
    handle.controller.abort()
  })

  ipcMain.handle(
    AGENT_IPC.sseOpen,
    async (event, input: AgentSseOpenRequest): Promise<AgentSseOpenResult> => {
      const sender = event.sender
      hookLifecycle(sender)
      // 同一 streamId 重开：先把旧的收掉，否则两条读流会把同一段 delta 推两遍
      const previous = streams.get(input.streamId)
      if (previous) {
        streams.delete(input.streamId)
        previous.controller.abort()
      }
      const controller = new AbortController()
      try {
        const res = await backendManager.fetch(buildRequest(input, controller.signal))
        if (!res.ok || !res.body) {
          return { ok: false, status: res.status, error: `HTTP ${res.status}` }
        }
        streams.set(input.streamId, { controller, sender })
        void pump(input.streamId, res.body)
        return { ok: true, status: res.status }
      } catch (err) {
        return {
          ok: false,
          status: 0,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle(AGENT_IPC.sseClose, (_event, streamId: string): void => {
    const handle = streams.get(streamId)
    if (!handle) return
    streams.delete(streamId)
    handle.controller.abort()
  })

  // 选工作区目录：模态挂在发起请求的那个窗口上（多窗口时对话框不会飘到别的窗口前面）
  ipcMain.handle(AGENT_IPC.pickDirectory, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '选择工作区目录', properties: ['openDirectory' as const] }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ---------- WebSocket 桥（状态推送 / 节点工作台） ----------

  /**
   * 主进程代为建连。目标永远是进程内后端的内部 loopback server（见 `manager.ts`），
   * 未启用鉴权（desktop 进程内直连）无需 token —— 渲染端因此不需要知道任何端口。
   */
  ipcMain.handle(AGENT_IPC.wsOpen, (event, input: WsOpenRequest): WsOpenResult => {
    const port = backendManager.wsPort()
    if (!port) return { ok: false, error: '进程内后端还没就绪' }
    if (wsStreams.has(input.streamId)) return { ok: false, error: 'streamId 已存在' }
    const sender = event.sender
    hookLifecycle(sender)

    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}${input.path}`)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    /**
     * ⚠️ 必须显式设成 `arraybuffer`：主进程的 `WebSocket` 是 Node（undici）实现，
     * 二进制帧默认按 **Blob** 投递。下面 `new Uint8Array(msg.data)` 拿到 Blob 会得到
     * 一个 **0 长度**数组 —— SSH 终端的输出全是二进制帧，于是「连上了、一直在跑、
     * 但终端永远是空的」（实测用户反馈）。状态推送 / 工作台的文本帧不受影响，
     * 所以只在这类纯文本通道上看不出问题。
     */
    socket.binaryType = 'arraybuffer'
    wsStreams.set(input.streamId, socket)
    wsOwners.set(input.streamId, sender)

    socket.onmessage = (msg: MessageEvent) => {
      const data = typeof msg.data === 'string' ? msg.data : new Uint8Array(msg.data as ArrayBuffer)
      wsBatcher.push(input.streamId, data)
    }
    socket.onclose = (msg: CloseEvent) => {
      /**
       * ⚠️ 顺序要紧：**先冲尾巴，再摘 owner，最后才报关闭**。
       * 合批器发消息时按 `streamId` 去 `wsOwners` 找 webContents（见上面 `onSend`），
       * 先 `delete` 的话那次查找拿不到人，尾巴就被**静默丢掉** —— 症状是
       * 「终端最后几行不见了」，而关闭流程一切正常，极难定位。
       */
      wsBatcher.flush(input.streamId)
      wsStreams.delete(input.streamId)
      wsOwners.delete(input.streamId)
      // 服务端给的 close reason（节点没在跑时带一句人话）原样透传，UI 要显示它
      safeSend(sender, AGENT_IPC.wsClosed, {
        streamId: input.streamId,
        code: msg.code,
        ...(msg.reason ? { reason: msg.reason } : {})
      })
    }
    socket.onerror = () => undefined
    return { ok: true }
  })

  ipcMain.handle(AGENT_IPC.wsSend, (_event, payload: WsSendPayload): void => {
    const socket = wsStreams.get(payload.streamId)
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(payload.data)
  })

  ipcMain.handle(AGENT_IPC.wsClose, (_event, streamId: string): void => {
    const socket = wsStreams.get(streamId)
    // ⚠️ 同样**先冲尾巴再摘 owner**（见 onclose 处的注释：合批器靠 wsOwners 找发送方，
    //    顺序反了尾巴会被静默丢掉）。连接已经不在了也要冲 —— 那正是「有尾巴没出口」的场景。
    wsBatcher.flush(streamId)
    wsStreams.delete(streamId)
    wsOwners.delete(streamId)
    if (!socket) return
    try {
      socket.close()
    } catch {
      // 已经关了
    }
  })

  // ---------- 快捷功能的系统能力 ----------

  // 协议白名单与「交给系统」的动作都在 `./external-link`，主进程的窗口级兜底
  // （`setWindowOpenHandler`）复用同一份，别在这儿再写一遍协议判断。
  ipcMain.handle(
    AGENT_IPC.openExternal,
    (_event, url: string): { ok: boolean; error?: string } => openExternalUrl(url)
  )

  ipcMain.handle(
    AGENT_IPC.openPath,
    async (_event, path: string): Promise<{ ok: boolean; error?: string }> => {
      const result = await shell.openPath(path).catch((err: unknown) => {
        return err instanceof Error ? err.message : String(err)
      })
      // shell.openPath 成功返回空字符串，失败返回错误消息
      return result ? { ok: false, error: result } : { ok: true }
    }
  )

  // ---------- 本机 PTY 终端 ----------

  ipcMain.handle(AGENT_IPC.ptyOpen, (event, input: PtyOpenRequest): PtyOpenResult => {
    try {
      const sender = event.sender
      // 与 SSE 同一套收尾：窗口销毁时把它开的终端一起收掉
      hookLifecycle(sender)
      const sessionId = openPtySession(input, {
        // ⚠️ 这两条回调都是**窗口销毁之后**仍可能被调到的（见 safeSend 的注释）：
        // 应用退出时 will-quit 杀掉 shell，node-pty 才异步把尾包输出与 exit 送进来。
        // 绝不能裸 send —— 那正是「关闭桌面端必弹 main process 错误」的来源。
        onData: (data) => {
          const payload: PtyDataEvent = { sessionId, data: new Uint8Array(data) }
          safeSend(sender, AGENT_IPC.ptyData, payload)
        },
        onExit: (exitCode) => {
          ptyOwners.delete(sessionId)
          const payload: PtyExitEvent = { sessionId, exitCode }
          safeSend(sender, AGENT_IPC.ptyExit, payload)
        }
      })
      ptyOwners.set(sessionId, sender)
      return { ok: true, sessionId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    AGENT_IPC.ptyWrite,
    (_event, sessionId: string, data: string | Uint8Array): void => {
      getPtySession(sessionId)?.write(data)
    }
  )

  ipcMain.handle(AGENT_IPC.ptyResize, (_event, sessionId: string, cols: number, rows: number): void => {
    getPtySession(sessionId)?.resize(cols, rows)
  })

  ipcMain.handle(AGENT_IPC.ptyKill, (_event, sessionId: string): void => {
    ptyOwners.delete(sessionId)
    getPtySession(sessionId)?.kill()
  })

  // 「停止」：只收前台命令的进程树，**不删 `ptyOwners`** —— 终端还是这个窗口的，
  // 还能接着用。与 ptyKill（关终端）是两件事，别合并。
  ipcMain.handle(AGENT_IPC.ptyStop, (_event, sessionId: string): void => {
    getPtySession(sessionId)?.stop()
  })

  // ---------- ZMODEM（rz/sz）文件传输 ----------
  //
  // 与 `pickDirectory` 同一类：不是「传输」，但都是「渲染端唯一能碰主进程文件系统」的能力。
  // 浏览器端没有这三条（用 file input + Blob 下载顶替，实现见 `@fizz/agent-kit`）。

  /** 弹系统文件选择框，读出选中文件的字节给渲染端（远端 rz 时上传） */
  ipcMain.handle(AGENT_IPC.zmodemPickFiles, async (event): Promise<ZmodemPickedFile[]> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    // ⚠️ Windows 上模态文件框可能被主窗口遮住（electron#32857）：临时置顶并聚焦，
    // 保证框在最前、鼠标能正常交互；finally 里务必还原
    if (window) {
      if (window.isMinimized()) window.restore()
      window.setAlwaysOnTop(true)
      window.focus()
    }
    let result: Electron.OpenDialogReturnValue
    try {
      const options = { properties: ['openFile' as const, 'multiSelections' as const] }
      result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
    } finally {
      window?.setAlwaysOnTop(false)
      window?.focus()
    }
    if (result.canceled || result.filePaths.length === 0) return []
    const files: ZmodemPickedFile[] = []
    for (const path of result.filePaths) {
      try {
        const buf = await fs.readFile(path)
        files.push({
          name: path.split(/[\\/]/).pop() || 'file',
          size: buf.length,
          // 结构化克隆把 Buffer 变成 Uint8Array（与 PtyDataEvent 同款约定）
          data: new Uint8Array(buf)
        })
      } catch {
        // 单个文件读不到（权限 / 已被删）：跳过它，别让整次选择失败
      }
    }
    return files
  })

  /** 弹系统保存框，返回用户选定的落点（远端 sz 时下载；先选位置再收字节） */
  ipcMain.handle(
    AGENT_IPC.zmodemAskSavePath,
    async (event, defaultName: string): Promise<string | null> =>
      askSavePathFor(event.sender, defaultName)
  )

  /** 把收到的字节写到落点；失败返回 null（渲染端只提示，不中断会话） */
  ipcMain.handle(
    AGENT_IPC.zmodemSaveFileTo,
    async (_event, target: string, data: Uint8Array): Promise<string | null> => {
      try {
        await fs.writeFile(target, Buffer.from(data))
        return target
      } catch {
        return null
      }
    }
  )

  // ---------- SFTP 分片传输的落盘通道 ----------
  //
  // 与 zmodem 那两条**并列不合并**（`fileSaveChunk` 是追加语义，见 `channels.ts`）。
  // 浏览器端没有这两条：那边的下载落盘由渲染端自己走 FSA / Blob（见 `@fizz/agent-kit` 的
  // `shared/lib/file-transfer/sink.ts`）。

  /** 弹系统保存框，返回用户选定的落点（下载落盘用；取消返回 null，不是错误） */
  ipcMain.handle(
    AGENT_IPC.fileAskSavePath,
    async (event, defaultName: string): Promise<string | null> =>
      askSavePathFor(event.sender, defaultName)
  )

  /**
   * 追加一片。`append = false` 时截断（第一片）→ 于是「同名文件直接覆盖」这条语义
   * 天然成立。失败返回 null，由渲染端收成 failed（不抛，IPC 抛异常会把渲染端调用点
   * 变成未捕获 rejection）。
   */
  ipcMain.handle(
    AGENT_IPC.fileSaveChunk,
    async (_event, target: string, data: Uint8Array, append: boolean): Promise<string | null> => {
      try {
        // ⚠️ `data` 经结构化克隆过来已经是 `Uint8Array`，`fs` 直接吃得下（Node 的
        // `BinaryLike`）—— **不要**再 `Buffer.from` 包一层，那会多复制一份 4MB
        if (append) await fs.appendFile(target, data)
        else await fs.writeFile(target, data)
        return target
      } catch {
        return null
      }
    }
  )

  /**
   * 删掉落点上的半份文件（取消下载时用）。只删文件、**不递归** —— `fs.rm` 不给 `recursive`
   * 时对目录抛 `EISDIR`，于是「渲染端能 `rm -rf` 任意路径」这条口子天然关着。
   * `force: true` 让「本来就不存在」也算成功（幂等）。
   */
  ipcMain.handle(AGENT_IPC.fileRemovePath, async (_event, target: string): Promise<boolean> => {
    try {
      await fs.rm(target, { force: true })
      return true
    } catch {
      return false
    }
  })
}

/**
 * 弹系统保存框并保证它出现在最前。
 *
 * ⚠️ 置顶那几步是 Windows 的绕法（electron#32857：模态文件框可能被主窗口遮住），
 * `finally` 里务必还原 —— 少了它，用户点「下载」后框藏在窗口后面，看起来像卡死了。
 * zmodem 与分片传输共用这一份，别各写一遍。
 */
async function askSavePathFor(wc: WebContents, defaultName: string): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(wc)
  if (window) {
    if (window.isMinimized()) window.restore()
    window.setAlwaysOnTop(true)
    window.focus()
  }
  let result: Electron.SaveDialogReturnValue
  try {
    const options = { defaultPath: defaultName }
    result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
  } finally {
    window?.setAlwaysOnTop(false)
    window?.focus()
  }
  if (result.canceled || !result.filePath) return null
  return result.filePath
}
