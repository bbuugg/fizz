/**
 * 宿主适配接口：Agent UI 与「它跑在哪儿」之间的唯一缝。
 *
 * 同一份 Agent UI 要同时跑在浏览器（`apps/web`，HTTP/SSE 打远端 server）和
 * Electron 渲染进程（`apps/desktop`，IPC 桥直连进程内 Hono）里，差异只有四处：
 * 请求怎么发、连接信息存哪、主题存哪、以及有没有「连接页 / 断开」这个概念。
 * 全部由宿主实现本接口注入，UI 本体不碰 localStorage / fetch 全局。
 *
 * 注入方式：宿主在 `render()` 之前调 `setAgentHost()`。UI 内部通过 `getAgentHost()`
 * 取用（原来是 `AgentApp host={...}` 的 props 透传，改成模块级注册是为了让 UI 里
 * 那些「不在 React 树里」的模块也能拿到它，见 `web-host.ts`）。
 *
 * ## 哪些能力可选、不实现时怎么办
 *
 * 传输类方法（`openTerminal` / `openStateSocket` / `open*Workbench` / `openExternal`）
 * 都是**可选**的：不实现时 `web-host.ts` 会回退到**浏览器实现**（同源 fetch / WS）。
 * 所以 web 宿主可以什么都不实现就用起来，desktop 只覆盖它真正不同的那几条。
 */
import type { AiPermissionMode, SshConnectProgress } from '@fizz/contracts/agent-api'
import type { Connection } from './api'

/**
 * 一条已打开的终端（web = WS 打服务端 PTY；desktop = IPC 桥打本机 PTY）。
 * 交互协议两边一致：write 进去按键，onData 出来渲染字节，onExit 收场。
 */
export interface TerminalProcess {
  /**
   * 写入终端输入。
   *
   * `string` 是键盘 / 粘贴的常规文本；`Uint8Array` 是**二进制**键入 —— 只有 ZMODEM
   * （rz/sz 传输）会用到，必须逐字节保真、不能按字符集编码。传输层两条路都支持：
   * WS 走二进制帧（服务端 `/api/terminal` 与 `/api/ssh/terminal` 都按裸字节直通 PTY / ssh 流），
   * IPC 走结构化克隆（node-pty 的 `write` 收 Buffer）。
   *
   * ⚠️ 反例：浏览器画面那条 JSON 桥**没有**二进制键入通道，
   * 所以那里的 TerminalPanel 传 `zmodemEnabled={false}`。
   */
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
  /**
   * 「停止」：收掉**当前前台命令**（连同它的子进程），终端本身保留。
   *
   * 与 `write('\x03')` 的区别是**强制**：`\x03` 只是 SIGINT 请求，程序可以不理（用户
   * 报过「AI 跑 `npx vite` 之后我手动停止，停不下来」），所以停止按钮除了发 `\x03`
   * 还要调它。引擎侧：web 发 `{type:'stop'}` 让服务端按前台进程组杀；desktop 走 IPC
   * （`agent:pty:stop`，按 `ps` 探到的前台进程组杀）。
   *
   * ⚠️ **必须只动前台那条命令，绝不能把终端一起收掉**：它由 Ctrl+C 的延时补刀调用，
   * 杀 shell = 用户按几次 Ctrl+C 终端就断开（用户报过）。拿不到前台作业（停在提示符上 /
   * Windows 的 ConPTY / 容器）就**什么都不做**。不实现时 UI 退回只发 `\x03`。
   *
   * ⚠️ SSH 通道**必须不实现**：远端进程组不在宿主视野里，能做到的只有「再发一次 `\x03`」，
   * 而那是替用户自动又按一次 Ctrl+C —— 命令已经退出时，那记迟到的中断会在提示符上再回显
   * 一个 `^C`（见 `apps/desktop/src/renderer/host.ts`）。
   */
  stop?(): void
  /** 订阅输出（PTY 原始字节）；返回退订函数 */
  onData(cb: (data: Uint8Array) => void): () => void
  /**
   * 订阅退出；返回退订函数。
   *
   * `reason` 只在**不是 shell 自己退出**时有值 —— 连接断了 / 启动失败之类。
   * 那时 `exitCode` 是宿主编的兜底值（web 端恒为 `-1`：它压根不知道真实退出码），
   * 拿它去猜原因没有意义，UI 要优先显示 `reason`。
   */
  onExit(cb: (exitCode: number, reason?: string) => void): () => void
  /**
   * 订阅 **SSH 建连进度**（可选）；返回退订函数。
   *
   * 只有 SSH 终端（`openSshTerminal`）会实现它 —— 本机 PTY / 容器终端没有这条通道，
   * 渲染端调用前要判存在。收到 `stage: 'ready'`（或首帧输出）即代表连接就绪，进度浮层应收起。
   */
  onProgress?(cb: (progress: SshConnectProgress) => void): () => void
}

/** `openTerminal` 的入参：目录 / 初始尺寸 / 可选 shell / 可选启动参数 */
export interface TerminalOpenOptions {
  /** 当前工作区的绝对路径 */
  cwd: string
  cols: number
  rows: number
  /**
   * shell 标识；不传 = 平台默认，**认不出来的 id 由宿主回落到默认**
   * （用户可能刚把某个 shell 卸了）。
   */
  shellId?: string
  /** 追加到 shell 自带 args **之后**的额外启动参数 */
  args?: string[]
  /** 启动后自动执行的一条命令（shell 起来后写进 PTY） */
  autoCommand?: string
  /**
   * 容器型项目的终端：目标**工作区 id**（服务端据此现算容器名并校验它确实是容器型项目）。
   *
   * 不由前端传容器名，原因是：① 「`fizz-proj-<slug>`」那条命名约定只在服务端有一份；
   * ② 客户端指定容器名 = 能 `docker exec` 进任意容器（包括流程节点容器），收窄成
   * 「只能进自己的容器型项目容器」。不传 = 宿主本机终端（逐字不变）。
   *
   * 桌面端也消费这个字段：主进程的 node-pty 只管宿主本机 shell，容器终端改走 IPC 桥连
   * **进程内后端**的 `/api/terminal?container=…`（与 web 端同一条 WS 协议，见 desktop
   * `host.ts` 的 `openBridgeContainerTerminal`）—— 容器名约定与校验只留在服务端一份。
   */
  containerWorkspaceId?: string
  /** 容器内 shell（缺省 `/bin/bash`，由服务端决定）；仅 `containerWorkspaceId` 生效时有意义 */
  containerShell?: string
}

/** `openSshTerminal` 的入参：目标主机 + 初始尺寸（凭据在服务端解密，不下发） */
export interface SshTerminalOpenOptions {
  /** SSH 主机配置 id（见 `SshHostConfig.id`） */
  hostId: string
  cols: number
  rows: number
}

/**
 * ZMODEM（rz/sz）文件传输要用到的一次文件。
 *
 * `data` 是**整份文件字节**：rz 上传时由宿主读出来给渲染端，sz 下载时反向。
 * 大小以 `data.byteLength` 为准（`size` 只是给进度条用的元信息）。
 */
export interface ZmodemFile {
  name: string
  size: number
  data: Uint8Array
}

/**
 * ZMODEM 传文件的三个「碰本机文件系统」的动作。**归宿主**，因为它必须落在
 * 用户手边那台机器上：
 *
 * - desktop：Electron 系统对话框（主进程 IPC，见 `agent-host/src/transport-ipc.ts`），
 *   保存位置是真实绝对路径；
 * - web：浏览器自己的能力 —— 选文件用 `<input type="file">`，保存用 Blob + `<a download>`
 *   （浏览器里**没有路径概念**，`askSavePath` 退化成「用清理过的文件名当落点」，
 *   详见 `web-host.ts` 的 `browserZmodem`）。
 */
export interface ZmodemBridge {
  /** 打开文件选择框，返回选中文件的字节（远端 `rz` 时上传）；取消 / 未选返回空数组 */
  pickFiles(): Promise<ZmodemFile[]>
  /**
   * 选保存位置，返回一个「落点句柄」（远端 `sz` 时下载用）。
   * desktop = 用户选定的绝对路径；取消返回 null。web = 清理过的文件名（无对话框，永不取消）。
   */
  askSavePath(defaultName: string): Promise<string | null>
  /** 把字节写到 `askSavePath` 给的落点；desktop 返回实际路径，web 触发下载后回文件名。失败返回 null */
  saveFileTo(target: string, data: Uint8Array): Promise<string | null>
}

/**
 * 一条已打开的**透传式**双向连接（浏览器画面 / 接口调试中继共用）。
 *
 * 消息是**透传**的：发送 / 收到的都是对端（服务端）的原始协议，
 * 由各自的调用点解释。
 */
export interface WorkbenchSocket {
  /** 上行帧：文本（协议 JSON）+ 二进制（PTY 字节 / ZMODEM 帧） */
  send(data: string | ArrayBuffer | Blob | Uint8Array): void
  /** 订阅消息（`binary` 区分文本 / 二进制帧）；返回退订函数 */
  onMessage(cb: (data: string | ArrayBufferLike, binary: boolean) => void): () => void
  /**
   * 订阅关闭。`reason` 是服务端给的 close reason —— 节点没在跑时服务端会带着
   * 「该节点没有在运行中的容器」之类的说明关掉，UI 要把它显示出来而不是只报「已断开」。
   */
  onClose(cb: (reason?: string) => void): () => void
  close(): void
}

/**
 * 一条已打开的**全局状态**连接：服务端把各数据域的最新快照推下来，前端不再轮询。
 * 客户端连上先收 `init`（全量），之后收 `snapshot`（单域更新），还可发 `sub` 订阅按 id 的域。
 */
export interface StateSocket {
  /** 订阅 / 心跳等上行消息（JSON 文本） */
  send(data: string): void
  /** 订阅消息；返回退订函数 */
  onMessage(cb: (data: string) => void): () => void
  /** 连接建立（含重连）；返回退订函数 */
  onOpen(cb: () => void): () => void
  /** 订阅关闭；返回退订函数 */
  onClose(cb: (reason?: string) => void): () => void
  close(): void
}

/**
 * 读一个本机文档的结果。
 *
 * 与 `@fizz/agent-host/channels` 的同名类型**结构相同、刻意各写一份**：本包（与
 * `@fizz/agent-kit`）是 web 与 desktop 共用的，绝不能 import `@fizz/agent-host`（那把 Electron 连同
 * `@fizz/server` 拖进浏览器产物）。同一处理见下面的 `RemoteAccessState` / `AppUpdateStatus`。
 *
 * 用可辨识联合而不是「失败时返回 `null`」：界面要区分「读失败」和「内容为空」，
 * 而空文件是合法的一种文档。
 */
export type LocalFileReadResult = { ok: true; content: string } | { ok: false; error: string }

/** 写回一个本机文档的结果（同上，与 agent-host 的同名类型结构相同） */
export type LocalFileWriteResult = { ok: true } | { ok: false; error: string }

/**
 * 宿主能力位：把「环境差异」从 `platform` 字符串比较里拎出来。
 *
 * 判断标准是**「这个宿主有没有这个功能」**，不是「它是哪个平台」。加 mobile 端时只要在
 * 它的实现里声明这几个布尔值，UI 一行都不用改。
 *
 * 纯环境形态（要不要注册 Service Worker、上传走哪条通道）仍看 `platform` —— 那不是能力
 * 有无，是两条都要能跑的路。
 */
export interface AgentCapabilities {
  /** 有原生标题栏（desktop 的 main 进程画）；false 时 web 自己画 `WebTitleBar` */
  nativeTitleBar: boolean
  /** 有语音输入服务（web 端 server 提供 STT）；desktop 宿主没有 */
  voice: boolean
  /** 后端就跑在本机进程内：日志能「打开目录」、服务端显示名是「本机」、截图能直读 */
  localServer: boolean
  /** 能把远端媒体按 `fizz-ws://` 自定义协议直接取字节（desktop 有，web 只能走 fetch） */
  localMediaFetch: boolean
  /**
   * 能用 Electron 的 `<webview>` 标签内嵌第三方页面（只有 desktop 有）。
   *
   * 与 `<iframe>` 的差别是**不受目标站点 `X-Frame-Options` / `frame-ancestors` 限制**
   * （webview 是独立的 guest 进程，不是子框架）—— 容器型项目的预览面板靠它才能看那些
   * 明确禁止被嵌入的服务。没有这个能力的宿主退回 iframe（见 `PreviewPane`）。
   */
  webview: boolean
}

export interface AgentHost {
  /**
   * 能力位（见 `AgentCapabilities`）。
   *
   * **必填**：漏写会在类型层面直接报错，而不是运行时静默走错分支 —— 之前用
   * `platform === 'desktop'` 散落判断时，加新宿主最容易漏的就是这种。
   */
  capabilities: AgentCapabilities
  /** 初始连接；返回 null 表示需要显示连接页（desktop 恒有值，直接进主界面） */
  loadConnection(): Connection | null
  /** 持久化连接（null = 断开，清掉记录） */
  saveConnection(connection: Connection | null): void
  /** 请求实现：web = `globalThis.fetch`；desktop = preload 注入的 IPC 桥 */
  fetch: typeof fetch
  /** 主题模式持久化（`light` / `dark` / `system`） */
  loadTheme(): ThemeMode
  saveTheme(theme: ThemeMode): void
  /** 命令执行权限（confirm / full）持久化 */
  loadPermissionMode(): AiPermissionMode
  savePermissionMode(mode: AiPermissionMode): void
  /**
   * confirm 模式的审批超时（分钟）持久化；0 = 不超时。
   * 没实现时 UI 用缺省 10 分钟（不落盘，本次会话有效）。
   */
  loadConfirmTimeout?(): number
  saveConfirmTimeout?(minutes: number): void
  /**
   * 「对话结束后系统通知」开关持久化。没实现时恒为开（反正没 notify 也不弹）。
   */
  loadNotifyOnFinish?(): boolean
  saveNotifyOnFinish?(enabled: boolean): void
  /**
   * 「上次打开的现场」持久化：当前工作区 / 当前会话。刷新或**下次启动**时恢复 ——
   * 会话上记着它自己选的模型，所以恢复会话就等于恢复了模型配置。
   * 没实现时退化为「第一个工作区 + 它最新的会话」。
   */
  loadActiveWorkspaceId?(): string | null
  saveActiveWorkspaceId?(id: string | null): void
  loadActiveConversationId?(): string | null
  saveActiveConversationId?(id: string | null): void
  /**
   * 终端字号（Ctrl+滚轮 / Ctrl +/- 缩放，缺省 14）。没实现 = 终端只在本次会话内缩放、不落盘。
   * 缩放由 TerminalPanel 调用，UI 不另设滑块。
   */
  loadTerminalFontSize?(): number
  saveTerminalFontSize?(size: number): void
  /**
   * 点关闭按钮时收起到托盘（默认 true）/ 直接退出。**同步**读：真值在主进程
   * （窗口关不掉时它也得知道），这里只是取它的当前值。没实现 = 宿主没有这个概念
   * （web 没有窗口），设置里不显示这一项。
   */
  loadCloseToTray?(): boolean
  saveCloseToTray?(enabled: boolean): void
  /*
    ⚠️ 这里原先有 `openSettingsWindow?(tab)`：desktop 实现 = 设置开独立窗口，没实现 =
    退回应用内弹窗。

    设置现在是**主区域的一条标签**（`agent-kit` 的 `settings:list`），三端同一形态，
    不再需要宿主能力来分叉 —— 别再加回来。两个渲染进程 = 两份模块级 store 单例，
    正是「设置里改完主窗口不知道」的根因（面板宽度、插件图标、系统监控开关都踩过）。
  */

  // -------------------------------------------------------------------------
  // 远程访问（只有 desktop 实现）：把进程内后端暴露到一个真实端口，供浏览器里的 web 端连
  // -------------------------------------------------------------------------

  /** 当前远程访问状态；没实现（web）= 设置里不显示这一块 */
  loadRemoteAccess?(): RemoteAccessState
  /**
   * 开 / 关端口监听，或改完端口 / 凭据后**重启**监听；返回最新状态。
   * 关闭时 `port` / 凭据仍回传当前配置值，便于界面回填。
   */
  saveRemoteAccess?(input: RemoteAccessInput): Promise<RemoteAccessState>
  /**
   * 发一条**系统级**通知（desktop = 主进程 Electron Notification，前台判定在主进程；
   * web 不实现）。返回是否真的弹了 —— **false（在前台 / 系统不支持 / 失败）时**
   * `lib/notify.ts` 会改发一条应用内 toast，调用方不用管。
   */
  notify?(notice: { title: string; body: string }): Promise<boolean>

  // -------------------------------------------------------------------------
  // 应用内自动更新（只有 desktop 打包版实现）：静默只查，下载必须用户点
  // -------------------------------------------------------------------------

  /**
   * 应用内自动更新。没实现（web、dev 态）= 设置里不显示「软件更新」分区、
   * 也不会出现新版本提示（`AppUpdateStatus.supported` 同样会报 false）。
   */
  appUpdate?: AppUpdateBridge
  /** 是否显示连接页（desktop 无此概念） */
  showConnectionGate: boolean
  /** 是否提供「断开连接」按钮（desktop 无此概念） */
  canDisconnect: boolean
  /** 顶栏标题 */
  title: string
  /**
   * 宿主运行环境：web = 浏览器；desktop = Electron 渲染进程。
   * UI 据此做少数环境相关的布局微调（如工作区浮岛的外边距）。
   */
  platform: 'web' | 'desktop'
  /**
   * 选一个**本机**目录（返回绝对路径；用户取消返回 null）。
   *
   * 实现了 = 这个宿主跑在有本机文件系统的地方（desktop → 系统目录选择框）；
   * 不实现 = 只能选**服务端**目录（web → 内置目录浏览器打 `/api/fs/dirs`）。
   * 工作区登记的都是「跑 Agent 的那台机器」上的路径，所以这个区分是本质的。
   */
  pickLocalDirectory?(): Promise<string | null>
  /**
   * 弹系统文件选择框选一个本机 **Markdown** 文件（返回绝对路径；用户取消返回 null）。
   *
   * 与 `pickLocalDirectory` 同一判定：实现了 = 这个宿主有本机文件系统（desktop）。
   * **web 刻意不实现** —— 浏览器拿不到路径、也写不回去，「保存到源文件位置」在 web 上
   * 本质上做不到；入口因此直接不出现，而不是摆一个必然失败的按钮。
   */
  pickLocalMarkdownFile?(): Promise<string | null>
  /**
   * 读 / 写一篇**本机 Markdown 文档**（绝对路径）。
   *
   * ⚠️ 这里的路径**只该来自带外信息**（`pickLocalMarkdownFile` 的结果，或系统双击关联
   * 交来的路径），不是「随便传一个绝对路径就能用」的通用读写口子：主进程持一份**授权集合**，
   * 没被授权过的路径一律回 `ok: false`（见 `@fizz/agent-host` 的 `local-files`）。
   * 别把 `readLocalFile` 当成「读任意文件」的能力去用。
   */
  readLocalFile?(path: string): Promise<LocalFileReadResult>
  writeLocalFile?(path: string, content: string): Promise<LocalFileWriteResult>
  /**
   * 取走「系统要求用本应用打开」的文件路径（双击 `.md` 关联 / 二实例 / macOS `open-file`）。
   *
   * **先存后取**：这些事件可能在渲染端挂上监听**之前**就发完了，只靠订阅会丢。所以启动时
   * 调一次拉走存量，之后再用 `onExternalFileOpen` 接增量（见 `host.ts` 的实现注释）。
   */
  takePendingExternalFiles?(): Promise<string[]>
  /** 订阅后续的「用本应用打开这个文件」事件；返回退订函数 */
  onExternalFileOpen?(cb: (path: string) => void): () => void
  /**
   * 跨窗口打开会话：浮窗点「在主窗口打开」→ 宿主把请求递给主进程 → 主窗口自己接住。
   *
   * `openInMainWindow` 由**浮窗**调用（空 id = 只把主窗口拉到前台）；另外两个由**主窗口**
   * 用 —— 存量同步取（首帧就要把标签摆对，异步会先落旧会话再跳），增量靠订阅。
   * 不实现 = 没有多窗口（web），入口不该出现。
   */
  openInMainWindow?(conversationId?: string): Promise<void>
  takePendingDeepLink?(): string | null
  onDeepLink?(cb: (conversationId: string) => void): () => void
  /**
   * 报告当前「改了还没保存」的标签数量。主进程缓存它，**退出时**据它决定要不要拦。
   *
   * 不实现 = 宿主没有退出拦截这回事（web 关页面本来也没什么可拦的语义）。
   */
  setDirtyTabCount?(count: number): Promise<void>

  // -------------------------------------------------------------------------
  // 传输类能力（都可选；不实现时 `web-host.ts` 回退到浏览器实现）
  // -------------------------------------------------------------------------

  /**
   * 在 `cwd` 开一条**交互式终端**。
   * 不实现（web）= 用浏览器实现打服务端 PTY（`/api/terminal` 的 WS）。
   */
  openTerminal?(options: TerminalOpenOptions): TerminalProcess
  /**
   * 打开一条到**远端 SSH 主机**的交互式终端。
   * 不实现（web）= 用浏览器实现打服务端 `/api/ssh/terminal` 的 WS；
   * desktop 走 IPC 桥（凭据只在服务端解密，客户端只传 hostId）。
   */
  openSshTerminal?(options: SshTerminalOpenOptions): TerminalProcess
  /**
   * 打开**全局状态**推送连接。不实现（web）= 浏览器实现打 `/api/state`。
   * desktop 走 IPC 桥的话在这里覆盖。
   */
  openStateSocket?(): StateSocket
  /**
   * ZMODEM（rz/sz）的文件选择 / 保存能力。不实现 = 走浏览器兜底实现
   * （`web-host.ts` 的 `browserZmodem`：file input + Blob 下载）。
   */
  zmodem?: ZmodemBridge
  /**
   * 弹系统保存框，返回用户选定的**本机绝对路径**（取消返回 `null`）。分片传输下载落盘用。
   *
   * 不实现（web）= 渲染端自己走 FSA / Blob（`shared/lib/file-transfer/sink.ts` 的第 2、3 支），
   * **必须可选** —— web 端没有 host（`getAgentHostOrNull()` 回 `null`），
   * 且宿主有无本机文件系统是**运行时**才知道的事。
   */
  fileAskSavePath?(defaultName: string): Promise<string | null>
  /**
   * 把**一片**字节写到 `target`（`append = false` 时截断，即第一片），返回实际路径；
   * 失败返回 `null`（由渲染端收成 `failed`，不抛）。分片传输下载落盘用。
   *
   * 与 `zmodem.saveFileTo` 的区别就是「追加一片」vs「一次写完整份」—— 别互相顶替。
   */
  fileSaveChunk?(target: string, data: Uint8Array, append: boolean): Promise<string | null>
  /**
   * 删掉一个**文件**（取消下载时收拾落点上的半份文件）。只删文件、不递归，
   * `true` = 删掉了或本来就不存在，`false` = 没删成。分片传输下载落盘用。
   *
   * 不实现（web）= 渲染端自己收尾（FSA 支 `stream.abort()`，Blob 支丢弃数组）。
   */
  fileRemovePath?(target: string): Promise<boolean>
  /**
   * 打开**浏览器画面**连接（会话 screencast + 状态）；渲染端据此实时显示 Agent 操作的浏览器。
   * 不实现（web）= 浏览器实现打 `/api/browser`。
   *
   * `autostart`：连上就让服务端把浏览器拉起来。**只在用户点了「启动浏览器」之后
   * 需要重连时置 true** —— 面板打开只订阅、不启动（手动启动走连接上的 `ensure`）。
   */
  openBrowserSocket?(
    conversationId: string,
    opts?: { autostart?: boolean }
  ): WorkbenchSocket
  /**
   * 打开一条**接口调试中继** WS（WebSocket 调试页用）：双方用 JSON 帧通信
   * （见 `@fizz/contracts/types` 的 `WsRelayClientMessage` / `WsEvent`）。
   * 不实现（web）= 浏览器实现打 `/api/api-client/ws/:connId`；
   * desktop 走 IPC 桥打服务端的同一条路径。
   */
  openApiClientSocket?(connId: string): WorkbenchSocket
  /**
   * 用系统默认浏览器打开链接（快捷功能 `link`）。
   * 不实现（web）= 浏览器自己开新标签页（`window.open`）。
   */
  openExternal?(url: string): Promise<{ ok: boolean; error?: string }>

  /**
   * 用系统默认程序打开本地路径（快捷功能 `path`）。
   * 只有 desktop 实现它 —— web 端没有「本机」概念，不实现则这类动作提示不支持。
   */
  openPath?(path: string): Promise<{ ok: boolean; error?: string }>
  /**
   * 在系统文件管理器里**显示（选中）**一个文件（不是打开它）。只有 desktop 实现 ——
   * web 宿主没有本机文件系统，不实现则文件面板不渲染「在文件管理器中显示」入口
   * （不要给浏览器一个必然失败的按钮）。
   */
  revealInFileManager?(absPath: string): Promise<{ ok: boolean; error?: string }>
  /**
   * 顶栏「打开」下拉的能力（只有 desktop 实现）：
   * 用系统文件管理器打开目录、检测已安装的 IDE 并用其打开目录。
   * 未实现时 UI 不展示这个下拉。
   */
  openFileManagerAt?(dir: string): Promise<{ ok: boolean; error?: string }>
  listIdes?(): Promise<Array<{ id: string; name: string }>>
  openIde?(id: string, dir: string): Promise<{ ok: boolean; error?: string }>
}

/** 主题模式：亮 / 暗 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * `AgentHost.saveRemoteAccess` 的入参。密码不在这里设置：首次从浏览器登录时
 * 输入的密码即成为新密码，服务端只保存哈希。
 */
export interface RemoteAccessInput {
  enabled: boolean
  port: number
}

/**
 * 远程访问的状态（desktop 专属能力，见 `AgentHost.loadRemoteAccess`）。
 */
export interface RemoteAccessState {
  enabled: boolean
  port: number
  /**
   * 全部可用的局域网访问地址（每块非回环 IPv4 一条，私网段在前）。
   *
   * 为什么是列表：多网卡机器（WiFi / 有线 / VMware / Docker / WSL / Tailscale）里
   * 系统给的枚举顺序不代表「别人连得上的那块」，只显示一条经常是虚拟网卡。
   */
  urls: string[]
  /** `urls` 的第一条（旧字段，兼容既有调用点）；没有对外网卡时是 null */
  url: string | null
  /** 是否同时托管了 web 产物（false = 只有 API，浏览器打开没有界面） */
  webServed: boolean
  error?: string
}

/**
 * 应用内更新的状态机档位（与 `apps/desktop/src/shared/window.ts` 的
 * `AppUpdateState` **同构** —— 那边刻意不复用这份类型，免得 preload 顺着类型
 * 把整个 UI 包拖进产物）。
 *
 * - `idle`：还没查过（或非打包态，此时 `supported` 为 false）
 * - `checking`：正在查
 * - `up-to-date`：查完，已是最新
 * - `available`：查到新版本，**等用户点下载**（不会自动下）
 * - `downloading`：正在下载（用户点的）
 * - `downloaded`：下好了，等用户点「重启安装」
 */
export type AppUpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'

/** 更新状态快照（见 `AgentHost.appUpdate`） */
export interface AppUpdateStatus {
  state: AppUpdateState
  /** 当前版本 */
  current: string
  /** 查到的新版本号；没查到 / 已是最新时为 null */
  latest: string | null
  /** 本平台能不能自动更新（dev 态、Linux 非 AppImage 一律 false） */
  supported: boolean
  /** 下载进度百分比 0~100（非下载态为 0） */
  percent: number
  /** 出错文案（检查 / 下载失败时给界面显示；正常为 null） */
  error: string | null
}

/**
 * 应用内自动更新桥（desktop 打包版专属，见 `AgentHost.appUpdate`）。
 *
 * 五个动作全是「问一次 / 让主进程做一件事」，进度靠 `onStatus` 推回来 ——
 * 状态机在主进程（`autoUpdater` 是全局单例，订阅只能有一份）。
 *
 * ⚠️ **没有「自动下载」这一档**：`check()` 发现新版本只会把状态置成 `available`，
 * 下载必须由用户点 `download()`。这是产品约定，别在宿主侧偷偷接上自动下载。
 */
export interface AppUpdateBridge {
  /** 读当前状态快照 */
  status(): Promise<AppUpdateStatus>
  /** 手动检查一次（失败时状态里带 error 文案） */
  check(): Promise<AppUpdateStatus>
  /** 开始下载已发现的新版本 */
  download(): Promise<AppUpdateStatus>
  /** 取消下载（回到 `available`） */
  cancel(): Promise<AppUpdateStatus>
  /** 退出并安装已下载的更新；返回 false = 当前没有可安装的更新 */
  install(): Promise<boolean>
  /** 订阅状态变化；返回退订函数 */
  onStatus(cb: (status: AppUpdateStatus) => void): () => void
}

// ---------------------------------------------------------------------------
// 宿主注册表（模块级单例）
// ---------------------------------------------------------------------------

let currentHost: AgentHost | null = null

/** 宿主在渲染前注入实现（重复注入覆盖，便于 HMR） */
export function setAgentHost(host: AgentHost): void {
  currentHost = host
}

/** UI 内部取当前宿主；没注入就抛错（说明宿主漏了接线） */
export function getAgentHost(): AgentHost {
  if (!currentHost) {
    throw new Error('[agent-client] 宿主尚未注入：请在 render 之前调用 setAgentHost()')
  }
  return currentHost
}

/**
 * 取当前宿主，**没注入时返回 null 而不抛错**。
 *
 * 给「有浏览器兜底实现」的传输层用（见 `web-host.ts`）：那些能力在没注入宿主时
 * 走浏览器默认实现照样能跑（web 宿主干脆可以不实现它们），不该为此炸掉整个界面。
 */
export function getAgentHostOrNull(): AgentHost | null {
  return currentHost
}

// ---------------------------------------------------------------------------
// 服务端地址覆盖（跨源形态：独立 vite 工程 / Capacitor 本地 `www`）
// ---------------------------------------------------------------------------

/**
 * 状态真源在 `./server-base`（`api.ts` 也要用，放这里会形成循环依赖）。
 * 这里只做转出，保持 `@fizz/agent-client` 根入口的既有导出形状。
 */
export { setServerBase, getServerBaseOverride } from './server-base'
