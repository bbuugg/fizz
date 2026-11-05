/**
 * desktop 自有窗口桥：自定义标题栏的通道名与渲染端可用的类型。
 *
 * 放 desktop 自己这里（不进 agent-host）：窗口控制是桌面壳的事，agent-ui 不需要，
 * 而且 preload / 渲染端两边的 tsconfig 都能直接 include 这个纯类型文件。
 */

  /** IPC 通道名（main 与 preload 共用，别手抄字符串） */
export const WINDOW_IPC = {
  minimize: 'agent-window:minimize',
  toggleMaximize: 'agent-window:toggleMaximize',
  close: 'agent-window:close',
  /**
   * 真·退出应用（标题栏 Window 菜单的「关闭」）。
   *
   * 与 `close`（收起到托盘）是两件事：`close` 只关窗口，主进程会按 `closeToTray`
   * 偏好把它收进托盘；这里是用户明确要退出，直接把 `quitting` 置上再 `app.quit()`，
   * 免得被托盘逻辑拦下。
   */
  quit: 'agent-window:quit',
  isMaximized: 'agent-window:isMaximized',
  /** 最大化状态变化事件（main → renderer，标题栏据此切换最大化/还原图标） */
  maximizedChanged: 'agent-window:maximized',
  /** 系统通知（renderer → main）：是否弹由主进程按前台状态判定 */
  notify: 'agent-window:notify',
  /** 关闭按钮行为偏好：收起到托盘（true，默认）/ 直接退出（同步读，见下） */
  loadCloseToTray: 'agent-window:loadCloseToTray',
  setCloseToTray: 'agent-window:setCloseToTray',
  /*
    ⚠️ 这里原先有 `openSettings` / `settingsTab` 两条通道（主进程开独立设置窗口、
    并向它推送「切到某个分组」）。设置已经并回主区域的标签页
    （`agent-kit` 的 `settings:list`），整个窗口生命周期的概念不存在了，
    两条通道随之删除 —— 别再按「宿主有 openSettingsWindow 就开窗口」的思路加回来。
  */
  /**
   * 把一条会话开到浮窗（单例窗口）。参数是**这条会话**的 id：已开着且是同一条只
   * 聚焦，是另一条就带新 id 重载渲染端（一条会话一个窗口，见主进程的同名函数）。
   */
  openConversationWindow: 'agent-window:openConversationWindow',
  /**
   * 浮窗请求「在主窗口里打开这个会话」（浮窗右上角那颗按钮）。
   *
   * 主进程不认会话、也不碰列表：它只负责把主窗口拉到前台，外加把深链暂存下来
   * （冷启动 / 主窗口已销毁时没人接）—— 打开会话的语义全在主窗口渲染端
   * （`app/layout/use-deep-link.ts`，与 `takePendingExternalFiles` 同一套「先存后取」）。
   */
  openInMainWindow: 'agent-window:openInMainWindow',
  /** 取走暂存的深链（sendSync：主窗口首帧就要把标签摆对，见 `DesktopWindowBridge`） */
  takePendingDeepLink: 'agent-window:takePendingDeepLink',
  /** 深链增量事件（main → 主窗口渲染端） */
  deepLink: 'agent-window:deepLink',
  /*
    `closeConversationWindow` / `conversationWindowChange` / `isConversationWindowOpen`
    三条已于 2026-11 删除：它们只服务主窗口标题栏那颗「浮窗开关」（一个全局开关 +
    开 / 关状态广播）。浮窗改成「一条会话一个窗口」后，入口下沉到会话详情区
    （`openConversationWindow` 带 id），关闭由浮窗自己的标题栏按钮做 —— 不再有人需要
    问「浮窗开着吗」，别再加回来（一个凭据两个真源的老问题）。
  */
  /** 切换本窗口置顶（作用于发起窗口；同时落盘为「新浮窗默认值」） */
  setAlwaysOnTop: 'agent-window:setAlwaysOnTop',
  /** 同步读置顶偏好（sendSync，首帧不闪） */
  loadAlwaysOnTop: 'agent-window:loadAlwaysOnTop',
  /** 列出检测到的已安装 IDE（顶栏「打开」下拉用） */
  listIdes: 'agent-window:listIdes',
  /** 用系统文件管理器打开目录 */
  openFileManager: 'agent-window:openFileManager',
  /** 在系统文件管理器里显示（选中）一个文件 */
  revealFile: 'agent-window:revealFile',
  /** 用指定 IDE 打开目录 */
  openIde: 'agent-window:openIde',
  /**
   * 外部 Markdown 文件（双击系统里的 `.md` 用本应用打开）。
   *
   * 两条组合起来才完整：`externalFileOpen` 是**增量**事件，`takePendingExternalFiles`
   * 是**存量**拉取。只用前者会丢「监听挂上之前就发完」的那些（见桥上的注释）。
   */
  externalFileOpen: 'agent-window:externalFileOpen',
  takePendingExternalFiles: 'agent-window:takePendingExternalFiles',
  /**
   * 渲染端报告当前「改了还没保存」的标签数量（退出拦截用）。
   *
   * **单向推送 + 主进程缓存**，不是退出时回来问 —— 见 `DesktopWindowBridge` 上的注释。
   */
  setDirtyTabCount: 'agent-window:setDirtyTabCount',
  /** 远程访问：读当前状态（desktop 专属，把进程内后端暴露到一个真实端口给 web 用） */
  loadRemoteAccess: 'agent-window:loadRemoteAccess',
  /** 远程访问：开 / 关（或改端口 / 凭据后重启）端口监听（主进程落盘并立刻起 / 停服务器） */
  setRemoteAccess: 'agent-window:setRemoteAccess',
  /** 主题模式同步（renderer → main）：主进程据此设 nativeTheme.themeSource */
  setTheme: 'agent-window:setTheme',
  /**
   * 「关于」弹窗要用的应用信息（名称 / 版本 / 图标文件 URL）。
   *
   * 刻意走主进程而不是渲染端读 package.json：打包后渲染端产物在 asar 里，图标
   * 却在 `resources/`（extraResources / 源码目录），只有主进程知道它的真实落点；
   * 版本号同理只有 `app.getVersion()` 是准的（dev 下读 package.json 会拿不到）。
   */
  loadAppInfo: 'agent-window:loadAppInfo',
  /**
   * 应用内自动更新（`electron-updater`，只在**打包版**上工作，见 `main/updater.ts`）。
   *
   * 五个动作通道 + 一条状态广播。**没有「自动下载」这一档**：静默只做检查，
   * 发现新版本只把状态推给界面，下载必须由用户点（`appUpdateDownload`）。
   */
  appUpdateStatus: 'agent-window:appUpdateStatus',
  /** 手动检查一次（发现新版本只置状态，不下载） */
  appUpdateCheck: 'agent-window:appUpdateCheck',
  /** 开始下载已发现的新版本 —— 只有用户点了「下载」才会走到这里 */
  appUpdateDownload: 'agent-window:appUpdateDownload',
  /** 取消正在进行的下载（取消后状态回到 `available`，可以重下） */
  appUpdateCancel: 'agent-window:appUpdateCancel',
  /** 退出并安装已下载的更新（主进程置 `quitting` 后 `quitAndInstall`） */
  appUpdateInstall: 'agent-window:appUpdateInstall',
  /** 更新状态变化（main → renderer）；主窗口与设置窗口都收，各自决定怎么展示 */
  appUpdateChanged: 'agent-window:appUpdateChanged'
} as const

/**
 * 主题模式（与 `@fizz/agent-ui` 的 `ThemeMode` **同构**）。刻意在这里再声明一份
 * 而不是 import：preload 绝不能顺着类型把 `@fizz/agent-ui`（进而 React 全家）
 * 拖进 preload 产物（与 `RemoteAccessState` 同一处理）。
 */
export type DesktopThemeMode = 'light' | 'dark' | 'system'

/*
  `DesktopSettingsTab` / `isDesktopSettingsTab` 已删除：它们只服务「独立设置窗口 +
  `?window=settings&tab=`」那条链路。设置进主区域后，分组请求在渲染端内部由
  `openSettingsTab(tab)` 直接写进标签登记表，不过 IPC、也不进查询参数。
*/

/**
 * 远程访问的状态（与 `@fizz/agent-ui` 的 `RemoteAccessState` **同构**）。
 *
 * 刻意在这里再声明一份而不是 import：preload 绝不能顺着类型引把 `@fizz/agent-ui`
 * （进而 React 全家）拖进 preload 产物，而 `shared/window.ts` 是纯类型文件、两边
 * tsconfig 都能直接 include（与 `SystemNotice` 同一处理）。
 */
export interface RemoteAccessState {
  enabled: boolean
  port: number
  /** 全部可用的局域网访问地址（每块非回环 IPv4 一条，私网段在前）；没有对外网卡时是空数组 */
  urls: string[]
  /** `urls` 的第一条（旧字段，兼容既有调用点）；没有对外网卡时是 null */
  url: string | null
  /** 是否同时托管了 web 产物（false = 只有 API，浏览器打开没有界面） */
  webServed: boolean
  error?: string
}

/**
 * `setRemoteAccess` 的入参（与 `@fizz/agent-client` 的 `RemoteAccessInput` **同构**）。
 *
 * 密码不在这里传：首次从浏览器登录时设置，哈希由主进程持久化。
 */
export interface RemoteAccessInput {
  enabled: boolean
  port: number
}

/** 系统通知的内容（与根应用 notify.ts 的 SystemNotice 同构） */
export interface SystemNotice {
  title: string
  body: string
}

/** 「关于」弹窗的应用信息（主进程组装，见 WINDOW_IPC.loadAppInfo） */
export interface DesktopAppInfo {
  /** 应用名（productName，如 Fizz） */
  name: string
  /** 版本号（app.getVersion()） */
  version: string
  /**
   * 应用图标，**data URL**（`data:image/png;base64,…`）。主进程读成 base64 再给渲染端，
   * dev（http 页面）与打包（file:// 页面）都通用 —— http 页面引用 file:// 子资源会被
   * Chromium 拦掉。读不到时是空串，弹窗退化成不显示图标。
   */
  iconUrl: string
}

/**
 * 应用内更新的状态机档位（与 `@fizz/agent-ui` 的 `AppUpdateState` **同构**）。
 *
 * - `idle`：还没查过（或 dev 态 / 不支持自动更新的平台，此时 `supported` 为 false）
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

/**
 * 更新状态快照（与 `@fizz/agent-ui` 的 `AppUpdateStatus` **同构**）。
 *
 * 刻意在这里再声明一份而不是 import：preload 绝不能顺着类型引把 `@fizz/agent-ui`
 * （进而 React 全家）拖进 preload 产物（与 `RemoteAccessState` 同一处理）。
 */
export interface AppUpdateStatus {
  state: AppUpdateState
  /** 当前版本（`app.getVersion()`） */
  current: string
  /** 查到的新版本号；没查到 / 已是最新时为 null */
  latest: string | null
  /** 本平台能不能自动更新（dev 态、非 GitHub 源、Linux 非 AppImage 一律 false） */
  supported: boolean
  /** 下载进度百分比 0~100（非下载态为 0） */
  percent: number
  /** 出错文案（检查 / 下载失败时给界面显示；正常为 null） */
  error: string | null
}

/** 渲染端能用的窗口桥（由 preload 经 contextBridge 暴露） */
export interface DesktopWindowBridge {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  /** 真·退出应用（Window 菜单的「关闭」）；与 `close` 不同，不会收起到托盘 */
  quit(): Promise<void>
  isMaximized(): Promise<boolean>
  /** 订阅最大化状态变化；返回退订函数 */
  onMaximizedChange(cb: (maximized: boolean) => void): () => void
  /**
   * 发一条系统通知。**是否真的弹由主进程判定**：应用在前台（窗口可见且聚焦）时不发 ——
   * 那时返回 `false`，调用方（`lib/notify.ts` 的 `notify`）会改发一条应用内 toast。
   * 系统不支持 / 创建失败同样返回 `false`，也走 toast 兜底。
   */
  notify(notice: SystemNotice): Promise<boolean>
  /**
   * 点关闭按钮时是否收起到托盘。**同步**读：偏好存在主进程（窗口关不掉时也得知道），
   * 主进程是唯一真源，这里只是取一次当前值。
   */
  loadCloseToTray(): boolean
  /** 改「关闭时收起到托盘」（主进程落盘，下次启动仍是这个值） */
  setCloseToTray(enabled: boolean): Promise<void>
  /*
    这里原先有 `openSettings` / `onSettingsTab` 两个窗口桥方法。设置改成主区域标签后
    不需要任何跨窗口协作（改完就在同一份 store 里），故一并删除。
  */
  /**
   * 把这条会话开到浮窗里。
   *
   * 主进程持有唯一的那个浮窗：已经开着同一条就只恢复 / 聚焦；开着的是**另一条**
   * 就带新 id 重载它的渲染端（渲染端因此不需要任何「跟随外部切换」的逻辑）。
   */
  openConversationWindow(conversationId: string): Promise<void>
  /**
   * 浮窗请求「在主窗口里打开这个会话」：把主窗口拉到前台并把链接交过去。
   *
   * 空 id 只是兜底（浮窗没有会话时那颗按钮是禁用的）：只把主窗口拉回前台。
   */
  openInMainWindow(conversationId?: string): Promise<void>
  /**
   * 取走暂存的深链（sendSync）。
   *
   * **同步**而不是 Promise：主窗口首帧就要把标签摆对（`main.tsx` 在渲染前调一次，
   * `useDeepLink` 挂载时再调一次）。异步的话首帧必然先落「上一个会话」再跳，闪一下。
   * 与 `takePendingExternalFiles` 同一套「先存后取」，只是这边不给异步的机会。
   */
  takePendingDeepLink(): string | null
  /** 订阅后续的深链；返回退订函数 */
  onDeepLink(cb: (conversationId: string) => void): () => void
  /** 切换本窗口置顶（主进程落盘为新浮窗默认值，作用于发起窗口） */
  setAlwaysOnTop(enabled: boolean): Promise<void>
  /** 同步读置顶偏好（sendSync，与 loadCloseToTray 同一套路） */
  loadAlwaysOnTop(): boolean
  /** 检测到的已安装 IDE（顶栏「打开」下拉用；每次现探测） */
  listIdes(): Promise<IdeInfo[]>
  /** 用系统文件管理器打开目录 */
  openFileManager(dir: string): Promise<OpenResult>
  /** 在系统文件管理器里显示（选中）一个**文件**（文件面板「定位」用；目录请用 openFileManager） */
  revealFile(path: string): Promise<OpenResult>
  /** 用指定 IDE 打开目录（id 来自 listIdes） */
  openIde(id: string, dir: string): Promise<OpenResult>
  /**
   * 取走「待打开的外部文件」并清空队列。
   *
   * **先存后取**：系统事件（双击关联的 argv / 二实例 / macOS `open-file`）可能在渲染端
   * 挂上监听**之前**就发完了，只靠订阅会丢 —— 症状是「有时灵」，最难查。所以渲染端启动时
   * 先拉一次，之后才靠 `onExternalFileOpen` 接增量（与 `@fizz/agent-ui` 的
   * `features/files/open-file.ts` 同一个坑，那边文件头有完整复盘）。
   */
  takePendingExternalFiles(): Promise<string[]>
  /** 订阅后续的「用本应用打开这个文件」事件；返回退订函数 */
  onExternalFileOpen(cb: (path: string) => void): () => void
  /**
   * 报告当前「改了还没保存」的标签数量。主进程缓存它，`before-quit` 时据它决定要不要拦。
   *
   * 为什么是**单向推送 + 主进程缓存**而不是「退出时回来问一句」：退出那一刻渲染进程
   * 已经不保证还在正常响应，再等一次往返可能永远等不到 —— 那会把退出**卡死**，
   * 比丢数据更难收拾。缓存下来则退出路径上零往返。
   */
  setDirtyTabCount(count: number): Promise<void>
  /** 读远程访问状态（desktop 专属；web 宿主不实现）。**同步**读（sendSync，与 loadCloseToTray 同一套路） */
  loadRemoteAccess(): RemoteAccessState
  /** 开 / 关端口监听（或改端口 / 凭据后重启），返回最新状态 */
  setRemoteAccess(input: RemoteAccessInput): Promise<RemoteAccessState>
  /**
   * 把主题模式推给主进程：主进程设 `nativeTheme.themeSource`，托盘右键菜单这类
   * **原生 UI** 的亮暗才会跟随应用主题（渲染端的 DOM 类名管不到它们）。
   * 幂等：两个窗口都会在 useTheme 挂载时推一次当前值，值相同无副作用。
   */
  setTheme(mode: DesktopThemeMode): Promise<void>
  /** 「关于」弹窗的应用信息（名称 / 版本 / 图标 URL）；**同步**读（sendSync，与 loadRemoteAccess 同一套路） */
  loadAppInfo(): DesktopAppInfo
  /** 读更新状态快照（每次现读，主进程持有唯一状态机） */
  appUpdateStatus(): Promise<AppUpdateStatus>
  /** 手动检查更新（发现新版本只置状态，**不下载**） */
  appUpdateCheck(): Promise<AppUpdateStatus>
  /** 开始下载（只有用户点了「下载」才会走到这里） */
  appUpdateDownload(): Promise<AppUpdateStatus>
  /** 取消下载（回到 `available`） */
  appUpdateCancel(): Promise<AppUpdateStatus>
  /** 退出并安装（主进程置 `quitting` 后 `quitAndInstall`）；返回 false = 当前没有可安装的更新 */
  appUpdateInstall(): Promise<boolean>
  /** 订阅更新状态变化；返回退订函数 */
  onAppUpdateChange(cb: (status: AppUpdateStatus) => void): () => void
}

/** 已安装 IDE 的展示信息 */
export interface IdeInfo {
  id: string
  name: string
}

/** 外部打开动作的结果（shell 侧失败时带 error 文案） */
export interface OpenResult {
  ok: boolean
  error?: string
}

/**
 * preload 经 contextBridge 暴露到 `window.fizzWindow`。
 *
 * 声明放在这里（而不是各自的入口文件）：主窗口与浮窗是**两个渲染入口**、各自的 bundle，
 * 但共用同一份 preload —— 谁都能直接 `window.fizzWindow.xxx()`，不该靠「另一个入口文件
 * 顺手声明了一次」才编得过。
 */
declare global {
  interface Window {
    fizzWindow: DesktopWindowBridge
  }
}
