/**
 * 传输桥的通道名与载荷类型（**零依赖模块**）。
 *
 * 单独一个文件的原因：preload 也要用这些通道名，但 preload 绝不能顺着
 * `transport-ipc.ts` 把 `./manager`（进而 `electron.app` + `@fizz/server`）拖进来
 * —— 那是主进程的东西。类型都是纯声明，运行时只有一组字符串常量。
 */

/** IPC 通道名（主进程与 preload 共用，别手抄字符串） */
export const AGENT_IPC = {
  http: 'agent:http',
  httpCancel: 'agent:http:cancel',
  sseOpen: 'agent:sse:open',
  sseChunk: 'agent:sse:chunk',
  sseEnd: 'agent:sse:end',
  sseClose: 'agent:sse:close',
  /** 弹系统目录选择框（桌面端选工作区目录用；web 没有本机文件系统） */
  pickDirectory: 'agent:pickDirectory',
  /** 系统默认浏览器打开链接（快捷功能 link；协议白名单在主进程侧校验） */
  openExternal: 'agent:system:openExternal',
  /** 系统默认程序打开本地路径（快捷功能 path） */
  openPath: 'agent:system:openPath',
  /** 本机 PTY 终端（桌面端工作区内嵌终端用；web 走服务端 WS，不经 IPC） */
  ptyOpen: 'agent:pty:open',
  ptyWrite: 'agent:pty:write',
  ptyResize: 'agent:pty:resize',
  ptyKill: 'agent:pty:kill',
  /**
   * 「停止」：收掉**前台作业**（连同它的子进程），shell 保留（与 ptyKill 的「关掉终端」区分）。
   * 拿不到前台作业（停在提示符上 / Windows 的 ConPTY）时什么都不做 —— 这条由 Ctrl+C 的
   * 延时补刀调用，杀 shell 等于替用户关终端。
   */
  ptyStop: 'agent:pty:stop',
  ptyData: 'agent:pty:data',
  ptyExit: 'agent:pty:exit',
  /**
   * ZMODEM（rz/sz）传文件的三条通道：选文件 / 选保存位置 / 写盘。
   * 桌面端才走它们（浏览器端由 web 兜底实现用 file input + Blob 下载顶替）。
   */
  zmodemPickFiles: 'agent:zmodem:pickFiles',
  zmodemAskSavePath: 'agent:zmodem:askSavePath',
  zmodemSaveFileTo: 'agent:zmodem:saveFileTo',
  /**
   * SFTP 分片传输落盘的两条通道：选保存位置 / **追加**一片。
   *
   * 与上面 zmodem 那两条**刻意并列、不合并**：`zmodemSaveFileTo` 是「一次写完整份、
   * `fs.writeFile` 覆盖」，传输要的是「追加一片」。混用会让两边的注释都跟实际行为对不上。
   */
  fileAskSavePath: 'agent:file:askSavePath',
  fileSaveChunk: 'agent:file:saveChunk',
  fileRemovePath: 'agent:file:removePath',
  /**
   * WebSocket 桥（状态推送 / 节点工作台）。
   *
   * 与 SSE / PTY 同一套模式：渲染端**不碰网络**，只拿一个 streamId 收发帧；
   * 真正的 WebSocket 连接由主进程建立（目标是进程内后端的内部 loopback server）。
   * 这样「渲染端与后端的全部往来只走 IPC、不出进程」这条原则对 HTTP / SSE / PTY / WS
   * 四类通道一体成立 —— 渲染端永远不需要知道后端在哪个端口。
   */
  wsOpen: 'agent:ws:open',
  wsSend: 'agent:ws:send',
  wsClose: 'agent:ws:close',
  wsData: 'agent:ws:data',
  wsClosed: 'agent:ws:closed'
} as const

export interface AgentTransportRequest {
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Optional renderer-generated id for canceling an in-flight one-shot request. */
  requestId?: string
}

export interface AgentHttpResponse {
  status: number
  statusText: string
  headers: [string, string][]
  /** 一次性响应的整个 body（ArrayBuffer 可直接喂给 `new Response(...)`） */
  body: ArrayBuffer
}

export interface AgentSseOpenRequest extends AgentTransportRequest {
  streamId: string
}

export interface AgentSseOpenResult {
  ok: boolean
  status: number
  error?: string
}

export interface AgentSseChunkEvent {
  streamId: string
  chunk: Uint8Array
}

export interface AgentSseEndEvent {
  streamId: string
  error?: string
}

// ---------- 本机 PTY 终端 ----------

export interface PtyOpenRequest {
  /** 工作目录（= 当前工作区的绝对路径） */
  cwd: string
  cols: number
  rows: number
  /**
   * 用哪个 shell（`ShellProfile.id`，清单见 `/api/terminal/shells`）。
   * 不传 = 平台默认；**认不出来的 id 会回落到默认**，不会让开终端失败。
   */
  shellId?: string
  /** 追加到 shell 自带 args **之后**的额外启动参数 */
  args?: string[]
  /** 启动后自动执行的一条命令（shell 起来后写进 PTY） */
  autoCommand?: string
}

export interface PtyOpenResult {
  ok: boolean
  sessionId?: string
  error?: string
}

export interface PtyDataEvent {
  sessionId: string
  /** PTY 原始输出（IPC 结构化克隆对 Buffer 会变成 Uint8Array，跨桥正好无损） */
  data: Uint8Array
}

export interface PtyExitEvent {
  sessionId: string
  exitCode: number
}

// ---------- ZMODEM（rz/sz）文件传输 ----------

/** 系统文件选择框选中的一个文件：名字 + 字节（结构化克隆把 Buffer 变成 Uint8Array） */
export interface ZmodemPickedFile {
  name: string
  size: number
  data: Uint8Array
}

// ---------- WebSocket 桥（状态推送 / 节点工作台） ----------

export interface WsOpenRequest {
  /** 渲染端生成的连接 id（帧回传时原样带回） */
  streamId: string
  /** 后端路径（含查询串），如 `/api/state`、`/api/flow-projects/:id/nodes/:nodeId/workbench/ws` */
  path: string
}

export interface WsOpenResult {
  ok: boolean
  error?: string
}

/** 上行帧：文本为主（会话事件 / 订阅指令），PTY 输入是二进制 */
export interface WsSendPayload {
  streamId: string
  /** 结构化克隆：字符串原样、二进制用 Uint8Array */
  data: string | Uint8Array
}

export interface WsDataEvent {
  streamId: string
  /** 下行帧（文本 = 会话事件，二进制 = PTY 字节） */
  data: string | Uint8Array
}

export interface WsClosedEvent {
  streamId: string
  code: number
  /** 服务端给的 close reason（节点没在跑时带一句人话），UI 要显示它 */
  reason?: string
}

// ---------- 拖拽进窗口的文件 ----------

/**
 * 渲染端 drop 进来的一个文件 / 目录。
 *
 * 刻意只声明 `name`：`File` 是 DOM 类型，而本文件给**主进程**也编（`lib` 里没有 DOM）。
 * 运行时必须是 `dataTransfer.files` 里的真实 `File` 实例 —— `webUtils.getPathForFile` 只认它。
 */
export interface DroppedFile {
  readonly name: string
}

/** 渲染端能用的桌面桥（由 preload 经 contextBridge 暴露） */
export interface AgentTransportBridge {
  /** 一次性请求 */
  request(input: AgentTransportRequest): Promise<AgentHttpResponse>
  /** 中止一条正在主进程执行的一次性请求 */
  cancelRequest(requestId: string): Promise<void>
  /** 打开一条 SSE 读流；chunk / end 通过订阅回调送达 */
  openSse(input: AgentSseOpenRequest): Promise<AgentSseOpenResult>
  /** 断开某条读流（不中止服务端那一轮） */
  closeSse(streamId: string): Promise<void>
  /** 订阅 chunk；返回退订函数 */
  onSseChunk(cb: (event: AgentSseChunkEvent) => void): () => void
  /** 订阅 end；返回退订函数 */
  onSseEnd(cb: (event: AgentSseEndEvent) => void): () => void
  /**
   * 弹系统目录选择框，返回选中的**本机**绝对路径（用户取消返回 null）。
   *
   * 这条不是「传输」，但和传输桥一样属于「渲染端唯一能碰主进程的入口」，
   * 所以放在同一个对象上暴露（工作区目录必须是跑 Agent 那台机器上的真实路径）。
   */
  pickDirectory(): Promise<string | null>
  /**
   * 把 drop 进来的 `File` 换成本机绝对路径（Electron 32+ 起 `File.path` 已被移除，
   * 唯一入口是 preload 里的 `webUtils.getPathForFile`）。
   *
   * 只取值，**不校验也不落盘**：是不是目录、路径存不存在都由调用方（`addWorkspace`）判
   * —— 这条通道刻意不构成「渲染端能探测任意路径」的口子。
   * 同步返回：drop 事件里要立刻用；拿不到路径（传进来的不是 File）返回空串。
   */
  getPathForFile(file: DroppedFile): string
  /** 开一个**本机** PTY 终端（shell 由 `shellId` 指定，不传则按平台默认挑；可带额外 args / 启动后自动命令），失败返回 error */
  openPty(input: PtyOpenRequest): Promise<PtyOpenResult>
  /** 向终端写输入（按键 / 粘贴的文本，或 ZMODEM 的二进制帧） */
  ptyWrite(sessionId: string, data: string | Uint8Array): Promise<void>
  /** 调整终端尺寸（xterm fit 之后回写给 PTY） */
  ptyResize(sessionId: string, cols: number, rows: number): Promise<void>
  /** 关闭终端（杀掉 shell 进程**及其整棵子进程树**） */
  ptyKill(sessionId: string): Promise<void>
  /**
   * 「停止」：收掉**前台作业**（POSIX 上按 `ps` 探到的终端前台进程组），终端标签本身不动。
   *
   * 与 `ptyKill` 的区别：那是「关掉终端」，这是「把跑着的东西停掉」。用户在 AI 跑完
   * `npx vite --port 30000` 之后点停止，要的是端口释放，不是把终端关了。
   * 拿不到前台作业（停在提示符上 / Windows）时**什么都不做** —— 这条由 Ctrl+C 的延时
   * 补刀调用，杀 shell 等于替用户关终端（用户报过「按几次 Ctrl+C 直接断开」）。
   */
  ptyStop(sessionId: string): Promise<void>
  /** 订阅终端输出；返回退订函数 */
  onPtyData(cb: (event: PtyDataEvent) => void): () => void
  /** 订阅终端退出；返回退订函数 */
  onPtyExit(cb: (event: PtyExitEvent) => void): () => void
  /** ZMODEM：弹系统文件选择框，返回选中文件的字节（用户取消返回空数组） */
  zmodemPickFiles(): Promise<ZmodemPickedFile[]>
  /** ZMODEM：弹系统保存框，返回用户选定的绝对路径（取消返回 null） */
  zmodemAskSavePath(defaultName: string): Promise<string | null>
  /** ZMODEM：把字节写到指定路径，返回实际路径（失败返回 null） */
  zmodemSaveFileTo(target: string, data: Uint8Array): Promise<string | null>
  /** SFTP 分片传输：弹系统保存框，返回用户选定的绝对路径（用户取消返回 null） */
  fileAskSavePath(defaultName: string): Promise<string | null>
  /**
   * SFTP 分片传输：把**一片**字节写到 `target`，返回实际路径（失败返回 null）。
   *
   * `append = false` 时截断（第一片），`true` 时追加 —— 与 `zmodemSaveFileTo` 的
   * 「整份覆盖」语义不同，别互相顶替。
   */
  fileSaveChunk(target: string, data: Uint8Array, append: boolean): Promise<string | null>
  /**
   * SFTP 分片传输：删掉**一个文件**（取消下载时收拾落点上的半份文件）。
   *
   * 只删文件、**不递归**（传目录进来会失败并回 `false`）—— 免得变成一条「渲染端能 `rm -rf`
   * 任意路径」的通道。路径本来就是用户自己在保存框里选的，`true` = 删掉了或本来就不存在
   * （幂等），`false` = 没删成（失败 / 是目录）。
   */
  fileRemovePath(target: string): Promise<boolean>
  /** 用系统默认浏览器打开链接（仅 http/https/mailto，失败返回 error） */
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>
  /** 用系统默认程序打开本地路径（文件夹 / 文件均可），失败返回 error */
  openPath(path: string): Promise<{ ok: boolean; error?: string }>
  /** 打开一条 WebSocket（主进程侧建连；失败返回 error） */
  openWs(input: WsOpenRequest): Promise<WsOpenResult>
  /** 发一帧上行 */
  sendWs(payload: WsSendPayload): Promise<void>
  /** 关闭这条 WS（只断这条连接，不影响别的） */
  closeWs(streamId: string): Promise<void>
  /** 订阅下行帧；返回退订函数 */
  onWsData(cb: (event: WsDataEvent) => void): () => void
  /** 订阅关闭；返回退订函数 */
  onWsClosed(cb: (event: WsClosedEvent) => void): () => void
}

/** Race a one-shot IPC call against its AbortSignal and notify the host to stop it. */
export function invokeWithAbort<T>(
  signal: AbortSignal,
  invoke: () => Promise<T>,
  cancel: () => Promise<unknown>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('请求已中止', 'AbortError'))
      return
    }

    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        void Promise.resolve(cancel()).catch(() => undefined)
      } catch {
        // Cancellation is best-effort; callers must still observe AbortError immediately.
      }
      reject(new DOMException('请求已中止', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    let request: Promise<T>
    try {
      request = invoke()
    } catch (error) {
      settled = true
      cleanup()
      reject(error)
      return
    }
    if (signal.aborted) onAbort()
    request.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
    )
  })
}
