/**
 * 安卓壳（Capacitor）的宿主实现。
 *
 * 形态与 `apps/web` 的 web 宿主**同源**：页面在 WebView 里跑，连接 / 主题 / 权限模式落
 * `localStorage`，请求走浏览器 `fetch`，终端连服务端 PTY。差别只有下面几处，都写在
 * 对应字段旁边：
 *
 * 1. `localStorage` 前缀用 `fizz.mobile.*`：壳的 origin 是 `https://localhost`，
 *    与 server 托管的 web 端（同域 `fizz.web.*`）天然隔离，但真被远程加载时也不该串数据；
 * 2. **服务端地址是绝对地址**（`main.tsx` 用 `setServerBase()` 注入）：页面自己的 origin
 *    是 `https://localhost`，相对路径的 `/api` / SSE / WS 一条都到不了 server；
 * 3. `capabilities.voice` **按运行时探测**（见下面的 `detectVoiceInput`）：APK 的安卓
 *    WebView 不实现 Web Speech API，探出来就是 false；hosted `/m/` 跑在手机浏览器的真
 *    引擎里，该有按钮就有。别按「手机包」身份写死 —— 同一份产物两种运行环境都要用；
 * 4. 不注册 Service Worker（见 `app/client-root.tsx`）。
 */
import type { AiPermissionMode } from '@fizz/contracts/agent-api'
import { normalizeServerBase, type Connection } from '@fizz/agent-client/api'
import { getServerBaseOverride, type AgentHost } from '@fizz/agent-client/host'
import { isNativeShell } from '@fizz/agent-kit/shared/lib/native-notify'
import { mobileAppUpdate } from '@/update/mobile-update'
import { getLocalRuntimeConnection, hasLocalRuntime, setLocalRuntimeConnection } from './runtime/bridge'

/**
 * 语音输入能力：`SpeechRecognition` 构造器存在、且页面处于安全上下文时才算有。
 *
 * - APK（Capacitor WebView）：安卓 WebView 不实现该 API → 构造器不存在 → false；
 * - hosted `/m/`（手机浏览器直接访问）：Chrome Android 有 `webkitSpeechRecognition` → true。
 *   但语音识别是 secure-context-only 的 API，用 `http://局域网IP` 打开时不给按钮，
 *   免得用户点了只拿到一个 `not-allowed`。
 *
 * 判据与 `useVoiceInput` 保持一致（那边同样只认这两个构造器），改一处要想到另一处。
 */
function detectVoiceInput(): boolean {
  if (!window.isSecureContext) return false
  const w = window as unknown as {
    SpeechRecognition?: unknown
    webkitSpeechRecognition?: unknown
  }
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition)
}

/** 连接信息（token 与桌面端的「密钥」同级敏感，别塞进 URL） */
const CONNECTION_KEY = 'fizz.mobile.connection'
const THEME_KEY = 'fizz.mobile.theme'
/** 命令执行权限：存本地，默认 confirm —— 手机上更不该默认裸跑命令 */
const PERMISSION_KEY = 'fizz.mobile.permissionMode'
/** confirm 审批超时（分钟）：默认 10，0 = 不超时 */
const CONFIRM_TIMEOUT_KEY = 'fizz.mobile.confirmTimeout'
/** 对话结束后系统通知：默认开（壳里走 `@capacitor/local-notifications`） */
const NOTIFY_ON_FINISH_KEY = 'fizz.mobile.notifyOnFinish'
/** 上次打开的工作区 / 会话（启动恢复现场，连带恢复会话记住的模型） */
const ACTIVE_WORKSPACE_KEY = 'fizz.mobile.activeWorkspaceId'
const ACTIVE_CONVERSATION_KEY = 'fizz.mobile.activeConversationId'
/** 终端字号：缺省 14，非数字 / 没存过都回落 14 */
const TERMINAL_FONT_KEY = 'fizz.mobile.terminalFontSize'

function loadConnection(): Connection | null {
  if (hasLocalRuntime) return getLocalRuntimeConnection()
  try {
    const raw = localStorage.getItem(CONNECTION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Connection>
    if (typeof parsed.token !== 'string' || !parsed.token) return null
    /*
     * 服务端地址**以 `setServerBase()` 的覆盖为准**（`main.tsx` 从本地保存的
     * `fizz.mobile.serverUrl` 注入），连接记录里存下来的只是兜底。
     *
     * 顺序不能反：用户在登录页换了服务端地址后，老 token / 老地址还躺在 localStorage 里，
     * 若先信连接记录，登录页改完地址仍会打旧服务器 —— 表现是「改了没生效」。
     */
    const serverBase = getServerBaseOverride() ?? normalizeServerBase(parsed.serverBase)
    return { token: parsed.token, ...(serverBase ? { serverBase } : {}) }
  } catch {
    return null
  }
}

export const mobileHost: AgentHost = {
  loadConnection,
  saveConnection: (connection) => {
    if (hasLocalRuntime) {
      setLocalRuntimeConnection(connection)
      return
    }
    if (!connection) localStorage.removeItem(CONNECTION_KEY)
    else localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection))
  },
  fetch: globalThis.fetch,
  /*
   * 三种模式：light / dark / system（**默认**，跟随系统）；没存过、存坏、storage 被禁都回落 system。
   *
   * ⚠️ 回落值必须与 `index.html` 里那段首帧前内联脚本一致 —— 它同时决定首屏启动屏
   * （`#boot-splash`）的底色，不一致就是「启动屏黑一下、进去变白」。
   *
   * ⚠️ `localStorage.getItem` 要包 try/catch：Capacitor WebView 里 storage 也可能不可用，
   * 而 `useTheme` 拿这个函数当 `useState` 的初始化函数，抛出去是整个应用白屏。
   */
  loadTheme: () => {
    try {
      const raw = localStorage.getItem(THEME_KEY)
      return raw === 'light' || raw === 'dark' ? raw : 'system'
    } catch {
      return 'system'
    }
  },
  /** 写不进去就算了：主题退化成「本次会话有效」，别让 effect 抛出去炸掉整棵树 */
  saveTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* 同 desktop 的 writeKey：存不下就只保留内存里的选择 */
    }
  },
  // 三种模式：full / confirm（默认）/ readonly；存坏了都回落到 confirm
  loadPermissionMode: (): AiPermissionMode => {
    const raw = localStorage.getItem(PERMISSION_KEY)
    return raw === 'full' || raw === 'readonly' ? raw : 'confirm'
  },
  savePermissionMode: (mode) => localStorage.setItem(PERMISSION_KEY, mode),
  /** 审批超时（分钟）：默认 10，0 = 不超时。随每轮 ChatRequest 带给服务端 */
  loadConfirmTimeout: () => {
    const raw = localStorage.getItem(CONFIRM_TIMEOUT_KEY)
    if (raw === null) return 10
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 10
  },
  saveConfirmTimeout: (minutes) => localStorage.setItem(CONFIRM_TIMEOUT_KEY, String(minutes)),
  loadNotifyOnFinish: () => localStorage.getItem(NOTIFY_ON_FINISH_KEY) !== 'false',
  saveNotifyOnFinish: (enabled) =>
    localStorage.setItem(NOTIFY_ON_FINISH_KEY, enabled ? 'true' : 'false'),
  /** 上次打开的现场：切后台被回收后再打开，恢复同一个会话（连带恢复它选的模型） */
  loadActiveWorkspaceId: () => localStorage.getItem(ACTIVE_WORKSPACE_KEY),
  saveActiveWorkspaceId: (id) => localStorage.setItem(ACTIVE_WORKSPACE_KEY, id ?? ''),
  loadActiveConversationId: () => localStorage.getItem(ACTIVE_CONVERSATION_KEY) || null,
  saveActiveConversationId: (id) => localStorage.setItem(ACTIVE_CONVERSATION_KEY, id ?? ''),
  loadTerminalFontSize: () => {
    const raw = localStorage.getItem(TERMINAL_FONT_KEY)
    if (raw === null) return 14
    const n = Number(raw)
    return Number.isFinite(n) ? n : 14
  },
  saveTerminalFontSize: (size) => localStorage.setItem(TERMINAL_FONT_KEY, String(size)),
  /*
   * 刻意不实现 `notify`：系统通知在壳里走 `@capacitor/local-notifications`
   * （`@fizz/agent-kit` 的 `shared/lib/native-notify.ts`，靠原生桥注入的 `window.Capacitor`
   * 自己识别，不需要宿主表态）。Web Notification API 在安卓 WebView 里根本不存在。
   */
  showConnectionGate: !hasLocalRuntime,
  canDisconnect: !hasLocalRuntime,
  title: 'Fizz',
  /*
   * `platform` 只有 web / desktop 两档，壳按 **web** 报：
   * 它确实是「浏览器里的一份页面」，上传通道 / 保存通道 / 主题这些都走 web 那条分支。
   * 别为了「知道自己是手机」去加第三档 —— 布局的移动端判断一直是视口宽度
   * （`use-mobile`），不是平台字符串。
   */
  platform: 'web',
  capabilities: {
    nativeTitleBar: false,
    /** 运行时探测：APK 的 WebView 探出来是 false，手机浏览器里的 hosted `/m/` 是 true */
    voice: detectVoiceInput(),
    localServer: hasLocalRuntime,
    localMediaFetch: false,
    webview: false
  },
  /*
   * 应用内更新：**只有 APK（原生壳）有**。hosted `/m/` 跑在浏览器里，装不了包，
   * 露出来只会让「软件更新」分区多一段不可用说明，所以按运行时探测挂或不挂
   * （设置页的 `AppUpdateSection` 靠桥存在与否决定显示）。
   * 状态机在 `@/update/mobile-update`，与 desktop 的 updater 同一套约定：
   * 静默只查、下载 / 安装都要用户点。
   */
  appUpdate: isNativeShell() ? mobileAppUpdate : undefined,
  /*
   * 终端 = 服务端 PTY（WS），与 web 端同一条通道 —— **刻意不在这里实现**。
   *
   * `@fizz/agent-client/web-host` 的 `openTerminal` 是**分发器**：宿主实现了就走宿主，
   * 没实现才落到它自己的浏览器兜底（跨源地址解析、心跳保活、二进制 / ZMODEM 通道全在
   * 兜底里）。之前这里写的是 `openTerminal: (o) => openBrowserTerminal(o)`，而
   * `openBrowserTerminal` 正是那个分发器 —— 于是「分发器 → 宿主 → 分发器 → …」，
   * 一开终端就 `RangeError: Maximum call stack size exceeded`。
   *
   * 要服务端 PTY，**别实现它**，让兜底生效。（`apps/web` 的宿主同一个坑，已一并删掉。）
   */
  /**
   * 「打开链接」：壳里 `window.open` 会被 WebView 吞掉（没有多标签页），
   * 走 Capacitor 的 `App.openUrl`？—— 那需要额外插件，而这条路径的**主用途**
   * （对话里的链接、快捷功能）在手机上本来就该交给系统浏览器。
   * 这里保留 web 的实现：Capacitor 8 的本地 server 会把 `window.open` 转给系统浏览器。
   */
  openExternal: (url) => {
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
  // 不实现 pickLocalDirectory / getPathForFile：
  // 壳里同样碰不到「本机文件系统」（那是服务端那台机器），理由与 apps/web/src/host.ts 逐字相同。
}
