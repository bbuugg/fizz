/**
 * desktop 主进程：**一个窗口 + 一个进程内后端**。
 *
 * 与根应用（`src/main/index.ts`）刻意保持最小差别：没有终端 / SSH / 插件，也不 seed
 * 本地数据 —— 智能体客户端只需要
 * 「窗口 → preload 传输桥 → 进程内 Hono（`@fizz/agent-host`）」这一条链路。
 * 托盘是唯一「比根应用多」的东西：关闭按钮默认把窗口收进托盘而不是退出进程。
 *
 * 数据目录由 `@fizz/agent-host/env` 兜底为 `~/.fizz-server`（与 web / server 共用一份）。
 * dev 态（`npm run dev:desktop`）另用 `Fizz Dev` 的 userData 与数据目录，见 `./dev-profile`
 * —— 安装版与 dev 版因此可以同时运行。
 */
// ⚠️ 必须排在所有 `@fizz/*` 导入之前：dev-profile 要在 agent-host/env 读取 FIZZ_DATA_DIR 之前求值
import { IS_DEV_INSTANCE } from './dev-profile'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  screen,
  Tray
} from 'electron'
import {
  backendManager,
  getRemoteAccessInfo,
  killAllPtySessions,
  openExternalUrl,
  registerAgentTransportIpc,
  startRemoteAccess,
  stopRemoteAccess
} from '@fizz/agent-host'
import { listInstalledIdes, openFileManagerAt, openIdeWith, revealInFileManager } from './opener'
import {
  deliverStartupArgs,
  initExternalFiles,
  openMarkdownDocument,
  takePendingExternalFiles
} from './external-files'
import {
  cancelDownload,
  checkForUpdates,
  initUpdater,
  quitAndInstall,
  scheduleSilentCheck,
  startDownload,
  updaterStatus
} from './updater'
import {
  WINDOW_IPC,
  type DesktopAppInfo,
  type DesktopThemeMode,
  type RemoteAccessInput,
  type RemoteAccessState
} from '../shared/window'

/** 托盘 / 退出菜单里的名字；dev 实例带后缀，两个实例同时跑时能分清 */
const APP_NAME = IS_DEV_INSTANCE ? 'Fizz Dev' : 'Fizz'

let mainWindow: BrowserWindow | null = null
/** 会话浮窗（**单例**）；关闭即置空。开关语义见 openConversationWindow */
let conversationWindow: BrowserWindow | null = null
/**
 * 浮窗当前载的是哪条会话（`?window=conversation&conversationId=`）。
 *
 * 只用来判「同一条就聚焦、换一条就重载」—— 窗口销毁时一并置空，别把上一条的 id
 * 留给下一个窗口（会静默不重载，浮窗停在旧会话）。
 */
let conversationWindowConversationId: string | null = null
/** 托盘常驻：关闭窗口后应用继续在后台跑（流式回复 / 正在跑的 Agent 都不受影响） */
let tray: Tray | null = null
/** 真正的退出流程（托盘菜单「退出」/ Cmd+Q / 安装器）：只有这时才放行 close */
let quitting = false
/** 电源请求句柄（`prevent-app-suspension`）；退出时释放，见 will-quit */
let powerSaveBlockerId: number | null = null

/**
 * 当前有几个标签「改了还没保存」（渲染端持续推来的）。
 *
 * 退出路径上**不做往返询问**（那时渲染进程已经不保证还在响应，等不到就是永久卡住），
 * 所以渲染端一有变化就推，这里只当缓存读 —— 见 `before-quit`。
 */
let dirtyTabCount = 0

/**
 * 用户已确认过「有未保存修改，仍然退出」。
 *
 * 与 `quitting` **不是一回事**，别合并：`quitting` 在 `createWindow()` 的 `close` 处理里
 * 是「放行关闭、别收托盘」的开关（`WINDOW_IPC.quit` / 安装器都要提前置它），而这一位
 * 只回答「退出拦截还要不要再拦一次」。
 */
let quitConfirmed = false

/**
 * 退出确认框正开着。
 *
 * 不加这道闸的话，连点两下「退出」（托盘菜单 / `Ctrl+Q` 都行）就会**叠出两个原生确认框** ——
 * 原生框是模态的，第二个通常藏在第一个后面，用户点掉一个还得再点掉一个，看起来就是
 * 「退不掉」。`before-quit` 是会被触发多次的，别假设它只有一次。
 */
let quitPromptOpen = false

/**
 * 后端异步收尾（`backendManager.drain()`）是否已经跑过。
 *
 * `will-quit` 会被拦一次去等 drain，落地后再 `app.exit()`；这个标记保证
 * 即便 `app.exit()` 之外还有别的路径让 `will-quit` 再来一次，也不会重复收尾
 * （重复 drain 本身无害，但会把退出多拖一轮）。
 */
let backendDrained = false

/**
 * Windows 的 toast 通知（`Notification`）要求应用带 AppUserModelId，否则
 * `notification.show()` **静默失败** —— 不弹、不报错，看起来就像「通知功能坏了」。
 *
 * - 打包安装后：必须与 electron-builder 的 `appId`（com.fizz.agent）一致，
 *   系统才能把 toast 归到开始菜单里那个应用（通知设置 / 免打扰都按它走）；
 * - 开发态（未打包）：没有安装器写的快捷方式，官方推荐用 `process.execPath`。
 */
app.setAppUserModelId(app.isPackaged ? 'com.fizz.agent' : process.execPath)

/**
 * 关掉「窗口一进后台就被降级」的默认行为。
 *
 * 起因：窗口失去焦点 / 被别的窗口完全遮挡 / 最小化到托盘时，Chromium 会把渲染进程降到低
 * 优先级，并把 `setTimeout` / `setInterval` 降频（后台标签是 1s 一次），Windows 还会给
 * 「后台进程」套上 EcoQoS（任务管理器里的「效率模式」）。对本应用是肉眼可见的卡顿：
 * 流式回复一段一段地跳、终端输出一顿一顿的，窗口藏进托盘后的 markdown 重排也慢半拍。
 *
 * 三件事各管一段，缺一不可：
 * - `disable-renderer-backgrounding`：不因「后台」降渲染进程优先级；
 * - `disable-background-timer-throttling`：后台页面照样按原频率跑定时器；
 * - `disable-backgrounding-occluded-windows` + 关掉 Windows 的原生遮挡检测：
 *   「被遮挡」不再等同于「后台」（Windows 上「先被别的窗口盖住、再最小化」是最常见的路径）。
 *
 * ⚠️ 必须在 `app` ready **之前**执行（ready 后再 append 不生效），所以写成模块顶层的立即
 * 调用，而不是塞进 `whenReady`。代价是后台时会多耗一点电 —— 这正是要换掉的东西。
 * 这是**进程级**兜底；窗口级还有 `backgroundThrottling`（见 sharedWebPreferences），
 * 两层一起上才盖得住「最小化 / 被遮挡 / 后台」三种情形。
 */
function disableBackgroundThrottling(): void {
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  // 同名开关在 Chromium 里是**覆盖**而不是追加：这里先读一次再拼，以后别处要关别的
  // feature 时照抄这段（或把清单提出来），别直接 appendSwitch 把这一项冲掉。
  //
  // `HideCursorWhileTyping`：Windows 上「敲字时自动隐藏鼠标指针」。本仓 Electron 44.3.0
  // 命中 Electron issue #54630 —— 敲完字再弹模态框（如 sz 的「另存为」系统框）时，指针会在
  // 所有窗口上（含那个原生框）一直不显示，框里没法选路径。这是该 issue 的官方 workaround。
  // 代价：失去「打字时自动隐指针」这一 UX —— 相比「下载框里指针完全看不见」值得。
  const disabledFeatures = app.commandLine.getSwitchValue('disable-features')
  app.commandLine.appendSwitch(
    'disable-features',
    [disabledFeatures, 'CalculateNativeWinOcclusion', 'HideCursorWhileTyping']
      .filter(Boolean)
      .join(',')
  )
}
disableBackgroundThrottling()

/**
 * 窗口行为偏好。**由主进程持有**（不放渲染端 localStorage）：关闭按钮的行为必须
 * 在渲染端加载完成前就确定，否则渲染端还没起来时点关闭会直接退出。渲染端通过
 * 窗口桥读写（见 ../shared/window）。
 */
interface WindowPrefs {
  /** 点关闭时收起到托盘（默认 true）；false = 直接退出 */
  closeToTray: boolean
  /**
   * 主题模式（渲染端 useTheme 推送过来的缓存）：启动时直接设 `nativeTheme.themeSource`，
   * 托盘右键菜单这类原生 UI 从第一个菜单起就跟随应用主题，不用等渲染端起来再推。
   * **亮暗的真源在渲染端**（localStorage，与「跟随系统」的 matchMedia 同处），
   * 这里只是「上次已知值」的缓存。
   */
  theme?: DesktopThemeMode
  /**
   * 远程访问（desktop 专属）：把进程内后端暴露到一个真实端口，浏览器里的 web 端
   * 直接连它。**真值由主进程持有**（服务器就跑在这里），与 closeToTray 同一套路。
   *
   * 只存密码**哈希**（scrypt）；首次从浏览器登录时输入密码，之后一直用它。
   * 没有用户名——这是单用户系统。
   */
  remoteAccess: { enabled: boolean; port: number; passwordHash?: string }
  /** 会话浮窗是否置顶（默认 true）；图钉改的就是这份，新开的浮窗沿用 */
  conversationAlwaysOnTop: boolean
}

const DEFAULT_REMOTE_ACCESS = { enabled: false, port: 7801 }

let windowPrefs: WindowPrefs = {
  closeToTray: true,
  conversationAlwaysOnTop: true,
  remoteAccess: { ...DEFAULT_REMOTE_ACCESS }
}

function prefsPath(): string {
  return join(app.getPath('userData'), 'window-prefs.json')
}

function loadWindowPrefs(): WindowPrefs {
  const fallback: WindowPrefs = {
    closeToTray: true,
    conversationAlwaysOnTop: true,
    remoteAccess: { ...DEFAULT_REMOTE_ACCESS }
  }
  try {
    const parsed = JSON.parse(readFileSync(prefsPath(), 'utf8')) as Partial<WindowPrefs>
    const ra = parsed.remoteAccess
    const theme: DesktopThemeMode | undefined =
      parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system'
        ? parsed.theme
        : undefined
    return {
      closeToTray: parsed.closeToTray !== false,
      conversationAlwaysOnTop: parsed.conversationAlwaysOnTop !== false,
      ...(theme ? { theme } : {}),
      remoteAccess: {
        enabled: ra?.enabled === true,
        port: Number(ra?.port) > 0 ? Math.trunc(Number(ra?.port)) : DEFAULT_REMOTE_ACCESS.port,
        ...(typeof ra?.passwordHash === 'string' && ra.passwordHash
          ? { passwordHash: ra.passwordHash }
          : {})
      }
    }
  } catch {
    // 文件不存在 / 解析失败：按默认（收起到托盘、不开远程访问）
    return fallback
  }
}

function saveWindowPrefs(): void {
  try {
    writeFileSync(prefsPath(), JSON.stringify(windowPrefs), 'utf8')
  } catch (err) {
    // 存不下只影响「下次启动的默认行为」，不该影响本次使用
    console.warn('[desktop] 保存窗口偏好失败：', err)
  }
}

// ---------------------------------------------------------------------------
// 远程访问：把进程内后端暴露到一个真实端口给 web 用（desktop 专属，见 WindowPrefs）
// ---------------------------------------------------------------------------

/** 组装渲染端要显示的状态（info 是 agent-host 里那份「服务器实况」） */
function remoteAccessState(): RemoteAccessState {
  const info = getRemoteAccessInfo()
  const cfg = windowPrefs.remoteAccess
  return {
    enabled: info.running,
    port: cfg.port,
    // 全列出来：多网卡机器上「哪一块能连」只有用户自己知道（见 remote-access.ts 的 listUrls）
    urls: info.urls,
    url: info.url,
    webServed: info.webServed,
    ...(info.error ? { error: info.error } : {})
  }
}

/**
 * 开 / 关端口监听（或改端口后重启）并落盘。
 *
 * 密码不在这里设置：`FIZZ_AUTH_PASS` 存的是哈希，为空时第一次从浏览器登录
 * 输入的密码即成为新密码，哈希由 `persistPasswordHash` 回调写回 `window-prefs.json`。
 *
 * ⚠️ 鉴权参数是**启动时**写进 `process.env.FIZZ_AUTH_*` 的（见 agent-host 的
 * `remote-access.ts`），所以改完必须 `startRemoteAccess` 重启一遍才生效 —— 它内部
 * 先 `stopRemoteAccess`，顺带把旧值撤掉。
 */
async function applyRemoteAccess(input: RemoteAccessInput): Promise<RemoteAccessState> {
  const cfg = windowPrefs.remoteAccess
  cfg.enabled = input.enabled !== false
  if (Number(input.port) > 0) cfg.port = Math.trunc(Number(input.port))
  saveWindowPrefs()
  if (cfg.enabled) {
    await startRemoteAccess({
      port: cfg.port,
      passwordHash: cfg.passwordHash,
      persistPasswordHash: (hash) => {
        cfg.passwordHash = hash
        saveWindowPrefs()
      },
      // dev 下从仓库根起步能找到 apps/web/dist；其余候选见 remote-access.ts
      webDirHint: join(process.cwd(), 'apps/web/dist'),
      // 手机版（build:mobile:hosted 的产物）：手机浏览器打开这个端口时会被 302 到 /m/
      mobileDirHint: join(process.cwd(), 'apps/mobile/dist-server')
    })
  } else {
    stopRemoteAccess()
  }
  return remoteAccessState()
}

/** 把主窗口拉回前台（托盘点击 / 第二实例 / mac 点 Dock 都走这里） */
function showMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 托盘左键：可见就收起、收起就拉回（一个键来回切） */
function toggleMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isVisible() && !win.isMinimized()) win.hide()
  else showMainWindow()
}

/** 收起到托盘（关闭按钮的收场） */
function hideToTray(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  win.hide()
}

/**
 * 托盘图标：Windows 用多尺寸 ico，其余平台用 png（两个都在 resources/，随包发）。
 * 读不出来就退成空图 —— 调用方（createWindow 的 close 拦截）会据此放弃「收起」。
 */
function trayImage(): Electron.NativeImage {
  const file = process.platform === 'win32' ? 'tray-icon.ico' : 'tray-icon.png'
  return nativeImage.createFromPath(join(app.getAppPath(), 'resources', file))
}

function createTray(): void {
  if (tray) return
  const image = trayImage()
  if (image.isEmpty()) {
    // 资源没随包发 / 读不出来：宁可不建托盘，也不能建一个看不见的 —— 否则窗口一
    // 收起来用户就再也叫不回来了（close 拦截会检查 tray 是否存在）。
    console.warn('[desktop] 托盘图标读取失败，本次不启用托盘（关闭按钮将直接退出）')
    return
  }
  tray = new Tray(image)
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主界面', click: showMainWindow },
      { type: 'separator' },
      {
        label: `退出 ${APP_NAME}`,
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', toggleMainWindow)
  tray.on('double-click', showMainWindow)
}

/**
 * 单实例锁：已在运行则把已有窗口调到前台（与根应用同一策略）。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // 又启动一次 = 用户想看到界面（也顺带把「收起到托盘」的窗口叫回来）
  app.on('second-instance', () => showMainWindow())
}

/**
 * 广播给**所有**窗口（主窗口 + 设置窗口）。
 *
 * 与 `mainWindow.webContents.send` 的区别：更新状态两个窗口都该看到（设置窗口里就是
 * 那个「软件更新」分区），只发主窗口的话在设置窗口点「检查更新」会没反应。
 * 窗口可能正在关闭（`isDestroyed`），逐个跳过。
 */
function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

/*
 * 外部 Markdown 文件（双击系统里的 `.md`）的三个入口。
 *
 * ⚠️ 必须在**模块求值期**就调：macOS 的 `open-file` 可能早于 `whenReady` 触发，
 * 放进 ready 回调里挂监听就晚了（这次打开的请求直接丢）。这里在 `broadcastToWindows`
 * 定义之后调用，读起来顺 —— 函数声明会提升，`whenReady` 又还没 resolve，时机是对的。
 */
initExternalFiles({
  broadcast: broadcastToWindows,
  getWindow: () => mainWindow
})

/**
 * 窗口控制 IPC：自定义标题栏的最小化 / 最大化(还原) / 关闭 / 状态查询 / 系统通知。
 * 与根应用同一套语义，通道名独立（见 ../shared/window）。
 *
 * ⚠️ 这些动作一律作用在**发起请求的那个窗口**上，不是「主窗口」：设置窗口也有自绘
 * 标题栏、也点关闭按钮 —— 按主窗口处理的话，点设置窗口的关闭会把主窗口收起来。
 */
function registerWindowIpc(): void {
  const senderWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle(WINDOW_IPC.minimize, (event) => senderWindow(event)?.minimize())
  ipcMain.handle(WINDOW_IPC.toggleMaximize, (event) => {
    const win = senderWindow(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  // 「关闭」：主窗口会被拦成「收起到托盘」（见 createWindow 的 close 处理），
  // 设置窗口则真的关掉自己
  ipcMain.handle(WINDOW_IPC.close, (event) => senderWindow(event)?.close())
  /**
   * 真·退出应用（标题栏 Window 菜单的「关闭」）。
   *
   * 必须先置 `quitting`：主窗口的 close 处理会按 `closeToTray` 偏好把它拦成「收起到
   * 托盘」，直接 `app.quit()` 也会走那条拦截。置上之后 `app.quit()` 才是真退出
   * （`before-quit` 里同样会置，这里提前置是为了让紧随其后的 close 不被拦）。
   */
  ipcMain.handle(WINDOW_IPC.quit, () => {
    quitting = true
    app.quit()
  })
  ipcMain.handle(WINDOW_IPC.isMaximized, (event) => senderWindow(event)?.isMaximized() ?? false)
  /**
   * 关闭按钮的行为偏好。**同步读**（preload 用 sendSync）：主进程是唯一真源，
   * 渲染端启动时同步取一次，界面不会先显示错的值再跳一下。
   */
  ipcMain.on(WINDOW_IPC.loadCloseToTray, (event) => {
    event.returnValue = windowPrefs.closeToTray
  })
  ipcMain.handle(WINDOW_IPC.setCloseToTray, (_e, enabled: boolean) => {
    windowPrefs = { ...windowPrefs, closeToTray: enabled !== false }
    saveWindowPrefs()
  })
  /**
   * 系统通知（参考根应用 services/system/notify.ts）：只在**应用不在前台**时发 ——
   * 窗口不存在 / 隐藏 / 最小化 / 失焦都算「用户看不到」，此时返回 false，渲染端会改发
   * 一条应用内 toast（见 `@fizz/agent-kit` 的 `shared/lib/notify.ts`）。前台判定必须在主进程做，
   * 渲染端的 document.hasFocus() 在窗口隐藏时不可靠。点通知把窗口拉回前台。
   */
  ipcMain.handle(WINDOW_IPC.notify, (_e, notice: { title: string; body: string }) => {
    if (!Notification.isSupported()) return false
    const win = mainWindow
    const inForeground = !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()
    if (inForeground) return false
    try {
      const notification = new Notification({
        title: notice.title,
        body: notice.body
      })
      notification.on('click', () => {
        const target = mainWindow
        if (!target || target.isDestroyed()) return
        if (target.isMinimized()) target.restore()
        target.show()
        target.focus()
      })
      notification.show()
      return true
    } catch (err) {
      // 通知失败（权限被拒等）不该影响业务
      console.warn('[desktop] 发送通知失败：', err)
      return false
    }
  })

  // ---------- 顶栏「打开」：文件管理器 / 已安装 IDE ----------
  // 设置已并回主区域的标签页（`agent-kit` 的 `settings:list`），主进程不再参与：
  // 原先是 `WINDOW_IPC.openSettings` 在这里 new 一个独立 BrowserWindow。
  // 会话浮窗：**单例**且**一条会话一个窗口**，见 openConversationWindow（参数必填）
  ipcMain.handle(WINDOW_IPC.openConversationWindow, (_e, conversationId?: unknown) => {
    if (typeof conversationId !== 'string' || !conversationId) return
    openConversationWindow(conversationId)
  })
  // 浮窗「在主窗口打开」：主进程只管拉窗口 + 递链接，会话怎么打开是渲染端的事
  ipcMain.handle(WINDOW_IPC.openInMainWindow, (_e, conversationId?: unknown) => {
    openInMainWindow(typeof conversationId === 'string' && conversationId ? conversationId : undefined)
  })
  // 同步读：主窗口首帧摆标签要用（异步会先落上一个会话再跳）
  ipcMain.on(WINDOW_IPC.takePendingDeepLink, (event) => {
    event.returnValue = pendingDeepLink
    pendingDeepLink = null
  })
  // 置顶作用于**发起窗口**（浮窗自己），不是主窗口 —— 与 minimize / close 同一语义
  ipcMain.handle(WINDOW_IPC.setAlwaysOnTop, (event, enabled: boolean) => {
    const flag = enabled !== false
    senderWindow(event)?.setAlwaysOnTop(flag)
    if (windowPrefs.conversationAlwaysOnTop !== flag) {
      windowPrefs = { ...windowPrefs, conversationAlwaysOnTop: flag }
      saveWindowPrefs()
    }
  })
  // 同步读：浮窗首帧就要正确的图钉状态（与 loadCloseToTray 同一套路）
  ipcMain.on(WINDOW_IPC.loadAlwaysOnTop, (event) => {
    event.returnValue = windowPrefs.conversationAlwaysOnTop
  })
  ipcMain.handle(WINDOW_IPC.listIdes, () => listInstalledIdes())
  ipcMain.handle(WINDOW_IPC.openFileManager, (_e, dir: string) => openFileManagerAt(dir))
  // 在文件管理器里**选中**一个文件（文件面板「定位」）：与 openFileManager 同一套启动方式
  ipcMain.handle(WINDOW_IPC.revealFile, (_e, path: string) => revealInFileManager(path))
  ipcMain.handle(WINDOW_IPC.openIde, (_e, id: string, dir: string) => openIdeWith(id, dir))

  // ---------- 外部 Markdown 文件（双击系统里的 .md） ----------
  /**
   * 渲染端启动时取走「监听挂上之前就发完了」的那批（先存后取，见 ./external-files 文件头）。
   * 拉一次就清空 —— 渲染端只该在挂载时调一次，重渲染反复调会把同一个文件重开一遍。
   */
  ipcMain.handle(WINDOW_IPC.takePendingExternalFiles, () => takePendingExternalFiles())
  /**
   * 脏标签计数（退出拦截用）。**只更新缓存，绝不在这里弹任何东西** ——
   * 渲染端每次 `dirty` 变化都会推一次，这里做重活会让打字变卡。
   */
  ipcMain.handle(WINDOW_IPC.setDirtyTabCount, (_e, count: number) => {
    dirtyTabCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  })

  // ---------- 远程访问（desktop 专属） ----------
  // sendSync：设置页挂载时同步取一次（与 loadCloseToTray 同一套路）
  ipcMain.on(WINDOW_IPC.loadRemoteAccess, (event) => {
    event.returnValue = remoteAccessState()
  })
  // 端口合法性 / 占用由 agent-host 兜（listen 失败会把 error 带回来显示在设置里）；
  // 凭据改动也走这里 —— 会重启监听，见 applyRemoteAccess
  ipcMain.handle(WINDOW_IPC.setRemoteAccess, (_e, input: RemoteAccessInput) =>
    applyRemoteAccess(input)
  )
  // 主题模式同步：themeSource 决定原生 UI（托盘右键菜单）的亮暗。缓存进窗口偏好，
  // 下次启动在 whenReady 里直接设上，不等渲染端起来推送。
  ipcMain.handle(WINDOW_IPC.setTheme, (_e, mode: DesktopThemeMode) => {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return
    nativeTheme.themeSource = mode
    if (windowPrefs.theme !== mode) {
      windowPrefs = { ...windowPrefs, theme: mode }
      saveWindowPrefs()
    }
  })

  /**
   * 「关于」弹窗的应用信息。**同步读**（sendSync）：弹窗一开就要图标和版本，异步
   * 会让图标先空一下再跳出来。图标路径只有主进程清楚（打包后渲染端产物在 asar 内、
   * 图标在 `resources/`），所以在这里拼好 URL 给渲染端。
   */
  ipcMain.on(WINDOW_IPC.loadAppInfo, (event) => {
    event.returnValue = appInfo()
  })

  // ---------- 应用内自动更新（desktop 专属） ----------
  // 状态机与事件订阅全在 ./updater（autoUpdater 是全局单例，订阅只能有一份），
  // 这里只做「渲染端能问什么 / 能让它做什么」的转发 + 状态广播。
  initUpdater((status) => broadcastToWindows(WINDOW_IPC.appUpdateChanged, status))
  ipcMain.handle(WINDOW_IPC.appUpdateStatus, () => updaterStatus())
  // 手动检查：失败会把文案带回去（静默检查的失败只在日志里）
  ipcMain.handle(WINDOW_IPC.appUpdateCheck, () => checkForUpdates(true))
  // 下载只有这一条入口 —— 发现新版本时不会自动下，必须用户点了这里
  ipcMain.handle(WINDOW_IPC.appUpdateDownload, () => startDownload())
  ipcMain.handle(WINDOW_IPC.appUpdateCancel, () => cancelDownload())
  /**
   * 退出并安装。**必须先置 `quitting`**：`quitAndInstall` 内部走 `app.quit()`，
   * 主窗口的 close 处理会按 `closeToTray` 偏好把它拦成「收起到托盘」，窗口关不掉就装不上
   * （与 WINDOW_IPC.quit 同一套路）。
   */
  ipcMain.handle(WINDOW_IPC.appUpdateInstall, () => {
    // ⚠️ 没有可安装的更新时**别动 `quitting`**：置上之后「关闭按钮收起到托盘」就永久失效了
    if (updaterStatus().state !== 'downloaded') return false
    quitting = true
    /**
     * 同时**绕过退出拦截**（`quitConfirmed`）。
     *
     * 这是用户明确点的「重启去装更新」，安装器还等着我们把进程让出来 —— 此时再拦一次
     * 弹个「有未保存的修改」，轻则莫名其妙，重则让更新装不上。顺带一提：`quitAndInstall`
     * 内部也走 `app.quit()`，不绕过的话 `before-quit` 那边会把这次退出拦下来。
     */
    quitConfirmed = true
    return quitAndInstall()
  })
}

/** 组装「关于」弹窗要的信息（见 WINDOW_IPC.loadAppInfo） */
function appInfo(): DesktopAppInfo {
  /**
   * 图标以 **data URL** 形式交给渲染端，而不是给文件路径。
   *
   * 为什么不用 file://：dev 下渲染端是 http://localhost:5175，Chromium 不允许 http
   * 页面引用 file:// 子资源（本应用的 webPreferences 也没有关 webSecurity），图标会
   * 静默空掉。读成 data URL 后 dev / 打包（file:// 页面）都通用，也省得渲染端猜路径。
   * 图标很小（几 KB），sendSync 传一份没有性能顾虑。
   */
  return {
    name: app.getName(),
    version: app.getVersion(),
    iconUrl: readIconDataUrl()
  }
}

/** 把 app 的 resources/app-icon.png 读成 data URL（读不到返回空串，弹窗里退化成不显示图标） */
function readIconDataUrl(): string {
  try {
    const bytes = readFileSync(join(app.getAppPath(), 'resources', 'app-icon.png'))
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch (err) {
    console.warn('[desktop] 读取应用图标失败：', err)
    return ''
  }
}

/**
 * 窗口图标：品牌图（与标题栏左上角、托盘同一张，都出自仓库根 `resources/app-icon.png`）。
 *
 * 打包后 Windows 本来就用 exe 的图标（那个由 electron-builder 的 `win.icon`
 * = `build/icon.ico` = 同一张品牌图决定）；这里显式设一次是为了 **dev**（此时 exe 是
 * electron.exe，不设就显示 Electron 默认图标）与 Linux（窗口图标不来自 exe）。
 * mac 走应用包图标，忽略这一项。
 */
function windowIconOption(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') return {}
  return { icon: join(app.getAppPath(), 'resources', 'app-icon.png') }
}

/**
 * 主窗口与设置窗口共用的 webPreferences。
 *
 * `backgroundThrottling: false`：窗口级再关一次后台节流（进程级开关见
 * disableBackgroundThrottling）。它同时管住 Chromium 的定时器降频、动画降帧，以及
 * 「窗口不可见」时对渲染进程的降级 —— 关窗到托盘后终端还在刷输出、AI 还在流式回包，
 * 被降频的正是这些。默认值 true 是给「后台标签就该省电」的网页用的，不适用于本应用。
 */
function sharedWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(import.meta.dirname, '../preload/index.cjs'),
    contextIsolation: true,
    // ⚠️ 显式关掉渲染进程沙箱：实测打包后（asar 内的 preload）沙箱模式下 preload
    // 会被静默跳过（无任何报错），bridge 整个消失 —— 「选择工作区」这类依赖
    // IPC 桥的能力全部失灵。preload 是我们自己打包出的最小 CJS 文件
    // （只 require electron），关沙箱是安全且必要的。
    sandbox: false,
    nodeIntegration: false,
    spellcheck: false,
    backgroundThrottling: false,
    /**
     * 会话面板里的「容器预览」用 `<webview>` 内嵌容器跑起来的页面。
     *
     * 为什么不用 iframe：目标站点一个 `X-Frame-Options: DENY` / `frame-ancestors` 就白屏，
     * 而容器里跑的多是用户自己的服务、我们管不了它的响应头。webview 是独立的 guest
     * 进程（不是子框架），不受这两个头限制；guest 的权限由 `secureWebviews` 收紧。
     */
    webviewTag: true
  }
}

/**
 * 各窗口的尺寸策略：**期望值 + 硬下限**，实际开多大由 `initialWindowSize` 算。
 *
 * 期望值按「内容真的需要多宽」定：主窗口 = 侧栏 288 + 卡片内边距 + 对话列
 * `max-w-4xl`(768) ≈ 1110，给到 1180 留点余量。
 *
 * （这里原先还有一项 `SETTINGS_WINDOW_SIZE`。设置已并回主区域的标签页，不再有独立
 * 设置窗口，那套「下限卡在布局断点 + 32px，防止拖动时 `useIsMobile()` 来回翻」的
 * 约束随之作废 —— 标签宽度由面板自己管。）
 */
const MAIN_WINDOW_SIZE = {
  preferred: { width: 1080, height: 720 },
  min: { width: 1024, height: 640 }
}
/**
 * 会话浮窗**故意**是窄的（贴在主窗口边上的小助手）：它一直在断点以下、按手机版排版渲染，
 * 「窄」不是 bug。别把下限抬到 768 —— 那会把它变成一个正常的大窗口。
 */
const CONVERSATION_WINDOW_SIZE = {
  preferred: { width: 380, height: 620 },
  min: { width: 340, height: 460 }
}

/**
 * 初始窗口尺寸：给一个「期望值」，再按主屏**可用区**（已扣掉任务栏）夹一次 —— 不写死。
 *
 * 起因（2026-09-24，用户反馈「初始化后窗口有点大，设置窗口也有点大」）：原来主窗口写死
 * 1280×860、设置窗口 980×720。本机是 200% 缩放，逻辑分辨率可能只有 1280×720 —— 860 高的
 * 窗口直接顶满整屏（Electron 还会把它裁进可用区），固定值在那种屏上怎么调都别扭。
 * 所以期望值调小 + 按可用区兜底：屏幕大就用期望值，屏幕小就贴着可用区。
 *
 * ⚠️ 只能在 `app.whenReady()` 之后调用（`screen` 模块的限制），各窗口都建在 ready 里，满足。
 */
function initialWindowSize(spec: { preferred: { width: number; height: number }; min: { width: number; height: number } }): {
  width: number
  height: number
} {
  const { workAreaSize } = screen.getPrimaryDisplay()
  return {
    width: Math.max(spec.min.width, Math.min(spec.preferred.width, workAreaSize.width - 80)),
    height: Math.max(spec.min.height, Math.min(spec.preferred.height, workAreaSize.height - 80))
  }
}

/**
 * 应用菜单：替换掉 Electron 默认菜单。
 *
 * 默认菜单的「视图」里有**重新加载 / 强制重新加载**（Ctrl+R / Ctrl+Shift+R，mac Cmd+R）。
 * 桌面端刷新会把渲染端状态整个打掉（WS 连接、流式现场、单槽状态全丢），且我们不支持
 * 用户手动刷新 —— 所以重设菜单时**去掉这两个角色**，保留编辑 / 缩放 / DevTools 等常用项。
 *
 * ⚠️ 菜单快捷键在浏览器进程里就被拦截，轮不到渲染端的 `before-input-event` ——
 * 所以光靠下面的 `blockPageReload` 拦不住 Ctrl+R，必须连菜单一起换掉。
 * （`autoHideMenuBar` 只是隐藏 UI，快捷键照样生效，别被它骗了。）
 *
 * ⚠️ 「窗口」菜单也是**逐项写**、不直接用 `{ role: 'windowMenu' }`：那个角色的默认子菜单里
 * 带「关闭窗口」（Win/Linux 上 accelerator = Ctrl+W）。菜单快捷键在浏览器进程里先行一步，
 * 一旦占住，渲染端的 `Ctrl/Cmd + W`「关闭当前标签」快捷键就**永远收不到**（设置在
 * `shared/lib/shortcuts.ts` 的 close-tab）。桌面端自绘标题栏自己有最小化 / 最大化 / 关闭
 * 三颗按钮，菜单里这条本来也多余，直接不列。
 */
function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    // mac 应用菜单（关于 / 隐藏 / 退出），里面本来就没有刷新项
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        /*
         * 「打开 Markdown…」是外部文件那条路的**第二个入口**（第一个是双击系统里的 .md）。
         * 加速键挂菜单而不是渲染端：菜单加速键在浏览器进程里先行一步，不会被渲染端的
         * 快捷键分发吞掉，也不依赖任何界面挂载出来。
         *
         * 走 `openMarkdownDocument()` 与双击关联**同一条出口**（选完过闸 → 入队 → 广播），
         * 渲染端因此只有一条处理路径。
         */
        {
          label: '打开 Markdown…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void openMarkdownDocument()
        }
      ]
    },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? ([{ type: 'separator' }, { role: 'front' }] as Electron.MenuItemConstructorOptions[])
          : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 拦掉菜单覆盖不到的刷新路径：**F5**（应用菜单里没有它，浏览器进程不拦），
 * 以及 Ctrl/Cmd+R 兜底（防以后有人把 reload 角色加回菜单）。
 * 只拦 keyDown，别的键一律放行。
 */
function blockPageReload(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 'f5' || ((input.control || input.meta) && key === 'r')) event.preventDefault()
  })
}

/** 同源判定（连协议一起比 —— `file:` / `data:` / `about:` 的 origin 都是字符串 `"null"`，只比 origin 会把它们混为一谈） */
function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.protocol === ub.protocol && ua.origin === ub.origin
  } catch {
    return false
  }
}

/**
 * 外链兜底：渲染端**绕过** `agent:system:openExternal` 直接 `window.open` / 改 `location` 时，
 * 别让 Electron 兜成内置窗口。
 *
 * ⚠️ 根因（终端 Ctrl+左键点 URL 弹出内置窗口那次）：`window.open` 在**没注册
 * `setWindowOpenHandler`** 的窗口上，Electron 的默认行为是新建一个 `BrowserWindow` 加载那个
 * URL —— 没有地址栏、没有前进后退，看着就是个「内置窗口」。渲染端只要有一处漏调
 * `openExternal`（当时是 xterm 的 WebLinksAddon 回调），就会漏出来一个。
 *
 * 策略：
 * - **弹窗**（`window.open`）：一律 `deny` —— 桌面端不存在「再开一个应用窗口」这种需求
 *   （设置窗口是主进程自己建的，不走这条路）；http/https/mailto 改交系统浏览器。
 * - **整页导航**（点了没有 `target=_blank` 的外链）：**同源放行**（dev 服务器 HMR、应用内
 *   跳转都靠它），跨源拦下并交系统浏览器 —— 否则整个 SPA 被导航掉，还没有后退按钮能回来。
 *
 * 协议白名单与 `agent:system:openExternal` 共用 `openExternalUrl`，两处判断不会漂移。
 */
function routeExternalLinks(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url, window.webContents.getURL())) return
    event.preventDefault()
    openExternalUrl(url)
  })
}

/**
 * `<webview>`（容器预览）的安全边界。
 *
 * webview 里跑的是**用户容器里的页面**，完全不受我们控制，所以：
 * - 只放行 `http(s)`：`file:` / `javascript:` / `data:` 一律拒绝挂载（否则一个被改过的
 *   预览地址就能读到本机文件）；
 * - guest **不要任何 Node 能力**：删掉继承来的 preload，关掉 nodeIntegration，
 *   沙箱 + 上下文隔离都打开 —— 它只需要能渲染网页；
 * - 页面里的 `target=_blank` / `window.open` 一律走系统浏览器（`openExternalUrl`），
 *   不在应用里开一个没有地址栏的内置窗口（与 `routeExternalLinks` 同一口径）。
 *
 * 注：不拦 `will-attach-webview` 的默认行为，只改 `webPreferences` —— 地址本身的合法性
 * 由渲染端（只填服务端算出的预览地址）与这里的协议白名单两道把关。
 */
function secureWebviews(window: BrowserWindow): void {
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    let protocol = ''
    try {
      protocol = new URL(params.src).protocol
    } catch {
      protocol = ''
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
  })
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url)
      return { action: 'deny' }
    })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    ...initialWindowSize(MAIN_WINDOW_SIZE),
    minWidth: MAIN_WINDOW_SIZE.min.width,
    minHeight: MAIN_WINDOW_SIZE.min.height,
    show: false,
    autoHideMenuBar: true,
    // 自定义标题栏：Windows / Linux 隐藏整条；mac 用 hiddenInset 保留交通灯
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 11 } } : {}),
    ...windowIconOption(),
    webPreferences: sharedWebPreferences()
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // 最大化状态推给渲染端（标题栏切换图标）
  const notifyMaximized = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(WINDOW_IPC.maximizedChanged, mainWindow.isMaximized())
  }
  mainWindow.on('maximize', notifyMaximized)
  mainWindow.on('unmaximize', notifyMaximized)
  /**
   * 关闭 = 收起到托盘（默认；设置「通用」里可改成直接退出）。
   *
   * `!tray` 时不拦截：托盘没建起来（图标缺失等）还去隐藏窗口，应用就再也叫不回来了。
   */
  mainWindow.on('close', (event) => {
    if (quitting || !windowPrefs.closeToTray || !tray) return
    event.preventDefault()
    hideToTray()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  blockPageReload(mainWindow)
  routeExternalLinks(mainWindow)
  secureWebviews(mainWindow)

  loadRenderer(mainWindow)
}

/** 渲染端入口（可带查询参数区分窗口：主界面 / `window=settings` 设置窗口） */
function loadRenderer(window: BrowserWindow, query?: Record<string, string>): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    const target = query ? `${devUrl}?${new URLSearchParams(query).toString()}` : devUrl
    void window.loadURL(target)
    return
  }
  const file = join(import.meta.dirname, '../renderer/index.html')
  if (query) void window.loadFile(file, { query })
  else void window.loadFile(file)
}

/**
 * 待交给主窗口渲染端的深链（浮窗点「在主窗口打开」时来的会话 id）。
 *
 * 主进程夹在中间只为一件事：**主窗口不在时这个请求得有地方放**。窗口可能在托盘里
 * （`hide` 只隐藏，`webContents` 还在，直接 send 就行），也可能彻底销毁了（用户选了
 * 「关闭 = 退出」，`createWindow` 重建要等 ready）—— 那时 send 出去没人听，会话就丢了。
 * 所以先存着，渲染端挂载后 `takePendingDeepLink` 取走；只在**被取走**或**被送达**后清空。
 */
let pendingDeepLink: string | null = null

/**
 * 把深链交给主窗口渲染端（没有就留着等它启动）。
 *
 * 用 `did-finish-load` 判「页面到底能不能收」而不是猜：窗口刚创建时 `webContents` 已存在、
 * `send` 不报错，但渲染端还没挂监听，消息就那么没了 —— 这类「有时灵」最难查。
 */
function deliverDeepLink(conversationId: string): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    pendingDeepLink = conversationId
    return
  }
  const contents = win.webContents
  if (contents.isLoading()) {
    pendingDeepLink = conversationId
    contents.once('did-finish-load', () => {
      // 加载期间又来了新的就交新的；没有就什么都不做
      const next = pendingDeepLink
      pendingDeepLink = null
      if (next && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(WINDOW_IPC.deepLink, next)
      }
    })
    return
  }
  pendingDeepLink = null
  contents.send(WINDOW_IPC.deepLink, conversationId)
}

/** 浮窗「在主窗口打开这个会话」：拉回主窗口 + 交出链接（空 id = 只拉窗口） */
function openInMainWindow(conversationId?: string): void {
  showMainWindow()
  if (conversationId) deliverDeepLink(conversationId)
}

/**
 * 会话浮窗：**单例**，且**一条会话一个窗口**。
 *
 * - 已开着且就是这一条：只恢复 / 聚焦 —— **不能重载**（重载会掐断正在跑的流、
 *   丢掉输入框里没发出去的内容）；
 * - 已开着的是**另一条**：带新 id 重新 `loadRenderer`。渲染端因此只认启动参数里的
 *   那一条 `conversationId`，不存在「窗内切换会话」这层状态（2026-11 改版：入口在
 *   会话详情区顶栏，见 `ConversationTab`）；
 * - 没开着：建窗口并载入这一条。
 *
 * `conversationId` **必填**：没有「无会话的草稿浮窗」这回事了（调用方只在真实会话上
 * 给入口），空 id 的一律由 IPC 那层挡掉。
 *
 * 与设置窗口同一套 webPreferences / 标题栏处理；**不**挂 close 拦截（关就是关）。
 */
function openConversationWindow(conversationId: string): void {
  if (conversationWindow && !conversationWindow.isDestroyed()) {
    if (conversationWindow.isMinimized()) conversationWindow.restore()
    conversationWindow.show()
    conversationWindow.focus()
    // 同一条会话：只聚焦。换了一条：让它按新 id 重新载入（见函数头）
    if (conversationWindowConversationId !== conversationId) {
      conversationWindowConversationId = conversationId
      loadRenderer(conversationWindow, { window: 'conversation', conversationId })
    }
    return
  }
  const win = new BrowserWindow({
    ...initialWindowSize(CONVERSATION_WINDOW_SIZE),
    minWidth: CONVERSATION_WINDOW_SIZE.min.width,
    minHeight: CONVERSATION_WINDOW_SIZE.min.height,
    show: false,
    autoHideMenuBar: true,
    alwaysOnTop: windowPrefs.conversationAlwaysOnTop,
    title: '会话',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 11 } } : {}),
    ...windowIconOption(),
    webPreferences: sharedWebPreferences()
  })
  conversationWindow = win
  conversationWindowConversationId = conversationId
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    // 按**窗口身份**判：销毁与 closed 之间若已重开，别把新窗口的记录抹掉
    if (conversationWindow === win) {
      conversationWindow = null
      conversationWindowConversationId = null
    }
  })
  blockPageReload(win)
  routeExternalLinks(win)
  secureWebviews(win)
  loadRenderer(win, { window: 'conversation', conversationId })
}

/**
 * 电源：请求系统「别因为我在后台就挂起我」。
 *
 * 上面的 `disable-*` 开关管的是 Chromium 内部的节流，管不住操作系统那一层：窗口收起
 * 托盘后应用没有可见窗口，Windows 会把进程放进 EcoQoS / 挂起，macOS 会 App Nap ——
 * 表现就是「挂着跑的长任务 / 流式请求会在几分钟后突然停住」。`powerSaveBlocker` 就是
 * Electron 对这个的正式 API。
 *
 * 选 `prevent-app-suspension` 而不是 `prevent-display-sleep`：前者挡系统挂起、**允许息屏**
 * （正是我们要的），后者会把屏幕一直点亮（那是看视频才需要的）。同理它也**不阻止用户
 * 手动睡眠 / 合盖**，只是让系统别把本应用当成可随手冻掉的后台进程。
 *
 * 只在 `whenReady` 之后有效（`powerSaveBlocker` 依赖 ready），对应释放见 will-quit。
 */
function keepAppAwake(): void {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) return
  powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
}

function releaseAppAwake(): void {
  if (powerSaveBlockerId === null) return
  if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId)
  powerSaveBlockerId = null
}

void app.whenReady().then(() => {
  // 先换掉默认菜单（去掉重新加载 / 强制重新加载），窗口还没建就要生效
  installApplicationMenu()
  // 窗口偏好要在建窗口 / 注册 IPC 之前读出来，close 拦截才有正确的行为
  windowPrefs = loadWindowPrefs()
  // 顺手重写一次：把旧版本 `remoteAccess` 里的明文 username / password 字段清掉
  saveWindowPrefs()
  // 上次的主题模式先设上：托盘菜单（原生 UI）从一开始就跟随应用主题，
  // 渲染端 useTheme 挂载后会再推一次当前值（幂等）
  nativeTheme.themeSource = windowPrefs.theme ?? 'system'
  // 传输桥先注册：窗口一加载就可能发请求
  registerAgentTransportIpc()
  registerWindowIpc()
  createTray()
  // 后端装配失败不阻塞 UI（渲染端只会看到请求报错），与根应用一致
  void backendManager.start()
  createWindow()

  /*
   * 首实例的「双击关联」参数：Windows / Linux 把文件路径放在 `process.argv` 里。
   *
   * 放在 `createWindow()` 之后读，但**顺序其实无关** —— 路径先进 `pending` 队列，
   * 渲染端挂载时会自己来取（那一刻它才听得到广播）。见 `./external-files` 的「先存后取」。
   */
  deliverStartupArgs()

  // 电源请求：托盘常驻意味着「没有可见窗口」是常态，别让系统把后台的我们冻掉
  keepAppAwake()

  // 上次开着远程访问就照旧起（与「关窗到托盘」同一套恢复逻辑）；
  // 凭据沿用已落盘的那份（不传 = 不改），端口回传当前配置值
  if (windowPrefs.remoteAccess.enabled) {
    void applyRemoteAccess({ enabled: true, port: windowPrefs.remoteAccess.port })
  }

  // 自动更新：延迟静默查一次（只查不下载，下载要用户点），之后定时再查。
  // 非打包态 / Linux 非 AppImage 在 updater.ts 里直接返回，不会碰 autoUpdater。
  scheduleSilentCheck()

  // mac 点 Dock 图标 / 应用被唤起：把（可能收起到托盘的）主窗口拉回来
  app.on('activate', () => showMainWindow())
})

/**
 * 有未保存的修改时问一句（原生确认框）。
 *
 * 用**主进程的**对话框而不是渲染端的弹窗：这一步发生时窗口可能已经不可见（收在托盘里
 * 通过托盘菜单退出），渲染端的弹窗会出现在一个看不见的窗口上 —— 用户只看到「退不掉」。
 */
async function confirmQuitWithDirtyTabs(count: number): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['取消', '仍然退出'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '有未保存的修改',
    message: `有 ${count} 个标签改了还没保存。`,
    detail: '现在退出会丢掉这些修改。'
  }
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const result = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

/**
 * 真退出（托盘菜单 / Cmd+Q / 卸载器）时才放行 close；否则一律拦成「收起到托盘」。
 *
 * ⚠️ **`quitting` 只在真的要退时才置**。它在 `createWindow()` 的 `close` 处理里是
 * 「放行关闭、别收托盘」的开关，抢跑到「用户取消了退出」那一支就会留下一个坏状态：
 * 之后点标题栏的 X 会直接退出应用，而不是收进托盘 —— 而用户以为自己刚取消了。
 */
app.on('before-quit', (event) => {
  /*
   * 退出拦截：有脏标签就先问一次。
   *
   * 计数是渲染端**持续推来的缓存**，这里零往返（见 `dirtyTabCount` 的注释）——
   * 退出路径上再等一次 IPC 很可能永远等不到，那会把退出卡死，比丢数据更难收拾。
   */
  if (!quitConfirmed && dirtyTabCount > 0) {
    event.preventDefault()
    // 确认框已经开着：只拦不停（否则连点退出会叠出好几个框，见 `quitPromptOpen`）
    if (quitPromptOpen) return
    quitPromptOpen = true
    void confirmQuitWithDirtyTabs(dirtyTabCount)
      .then((confirmed) => {
        if (!confirmed) {
          // 取消了：把可能被提前置上的 `quitting` 收回来（见这个监听的注释）
          quitting = false
          return
        }
        quitConfirmed = true
        app.quit()
      })
      .finally(() => {
        quitPromptOpen = false
      })
    return
  }
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 拆掉 server 侧常驻的 ACP agent 进程 + 收掉本机 PTY 终端的 shell 子进程 + 摘掉托盘
app.on('will-quit', (event) => {
  tray?.destroy()
  tray = null
  stopRemoteAccess()
  killAllPtySessions()
  // 交还电源请求（进程退出本来也会释放，显式收掉是为了不留下「谁还在挡睡眠」的悬念）
  releaseAppAwake()

  if (backendDrained) return
  /**
   * 后端还有一步**异步**收尾：把还在跑的那一轮对话停掉、等 chat-turn 把已产生的部分
   * 落盘，再把 store 的在途写盘等完（`backendManager.drain()`，与独立 server 的
   * `runShutdown` 第 4 / 6 步同一口径）。
   *
   * 为什么必须拦一下：桌面是**进程内直连**，关窗口 = 进程直接没，收不到 SIGTERM，
   * 那套收尾从来没人跑。而 `will-quit` 是同步事件，await 不了 —— 于是先
   * `preventDefault()`，等 drain 落地再 `app.exit()` 硬退（不走事件，避免二次进入）。
   *
   * 症状背景：agent 用 `ask_followup_question` 提问、正挂着等答复时关掉应用，
   * 再打开那一轮的消息整段没了（run 与半截正文都只在内存里）。
   */
  event.preventDefault()
  /**
   * 硬上限：drain 自己已经给「等在跑的对话收尾」封了 5s，这里再兜一层 ——
   * 收尾卡住（磁盘 IO 卡死之类）绝不能把用户留在「点了退出但退不掉」的状态里。
   */
  const bail = setTimeout(() => {
    backendDrained = true
    app.exit(0)
  }, 8_000)
  void backendManager
    .drain()
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(bail)
      backendDrained = true
      backendManager.stop()
      app.exit(0)
    })
})
