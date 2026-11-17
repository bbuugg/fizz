/**
 * Chrome 扩展的宿主实现。
 *
 * 形态与 `apps/web` / `apps/mobile` 的宿主**同源**（这正是三端能共用同一套界面的原因）：
 * 连接 / 主题 / 权限模式落 `localStorage`，请求走浏览器 `fetch`，终端连服务端 PTY。
 * 差别只有下面几处，每一处都写在对应字段旁边：
 *
 * 1. **存储键前缀 `fizz.ext.*`**：扩展的 origin 是 `chrome-extension://<id>`，与 web
 *    （`fizz.web.*`）、手机壳 / 手机版网页（`fizz.mobile.*`）本来就隔离，前缀只是让
 *    DevTools 里一眼看得出是哪一份；
 * 2. **请求不受 CORS 约束**：`manifest.json` 里 `host_permissions` 覆盖了
 *    `http(s)://*`，所以跨源 `fetch` / SSE / WS 都能直连用户填的那台服务端；
 * 3. `capabilities.voice = false`：扩展页面的 Web Speech API 要额外权限
 *    （`audioCapture`），没配的情况下麦克风按钮点了只会静默失败 —— 与手机版同一取舍；
 * 4. `openExternal` 优先走 `chrome.tabs.create`：侧栏里 `window.open` 会弹一个**独立小窗**
 *    （而且没有地址栏），用户想「在新标签页里看这个链接」的意图会落空。
 */
import type { AiPermissionMode } from '@fizz/contracts/agent-api'
import { normalizeServerBase, type Connection } from '@fizz/agent-client/api'
import { getServerBaseOverride, type AgentHost } from '@fizz/agent-client/host'

/** 连接信息（token 与桌面端的「密钥」同级敏感，别塞进 URL） */
const CONNECTION_KEY = 'fizz.ext.connection'
const THEME_KEY = 'fizz.ext.theme'
/** 命令执行权限：存本地，默认 confirm —— 浏览器侧栏里更不该默认裸跑命令 */
const PERMISSION_KEY = 'fizz.ext.permissionMode'
/** confirm 审批超时（分钟）：默认 10，0 = 不超时 */
const CONFIRM_TIMEOUT_KEY = 'fizz.ext.confirmTimeout'
/** 对话结束后系统通知：默认开（扩展里没有 notify 实现，存着无害，与 web 一致） */
const NOTIFY_ON_FINISH_KEY = 'fizz.ext.notifyOnFinish'
/** 上次打开的工作区 / 会话（侧栏被关掉再打开时恢复现场，连带恢复会话记住的模型） */
const ACTIVE_WORKSPACE_KEY = 'fizz.ext.activeWorkspaceId'
const ACTIVE_CONVERSATION_KEY = 'fizz.ext.activeConversationId'
/** 终端字号：缺省 14，非数字 / 没存过都回落 14 */
const TERMINAL_FONT_KEY = 'fizz.ext.terminalFontSize'

function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(CONNECTION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Connection>
    if (typeof parsed.token !== 'string' || !parsed.token) return null
    /*
     * 服务端地址**以 `setServerBase()` 的覆盖为准**（`main.tsx` 从 `fizz.ext.serverUrl`
     * 注入），连接记录里存下来的只是兜底 —— 用户在登录页换了服务器后，若先信连接记录，
     * 就会拿着老地址打老服务器，表现是「改了没生效」。
     */
    const serverBase = getServerBaseOverride() ?? normalizeServerBase(parsed.serverBase)
    return { token: parsed.token, ...(serverBase ? { serverBase } : {}) }
  } catch {
    return null
  }
}

/**
 * `chrome.*` 的最小声明。
 *
 * 只为两个调用（开标签页、取扩展内 URL）引一整个 `@types/chrome` 不划算 —— 这个包里
 * 另外几百个 API 我们一个都不碰，而它们随 Chrome 版本变动最频繁。
 */
interface ChromeLike {
  tabs?: { create?(props: { url: string }): void }
  runtime?: { getURL?(path: string): string }
}

const chromeApi = (globalThis as { chrome?: ChromeLike }).chrome

export const extensionHost: AgentHost = {
  loadConnection,
  saveConnection: (connection) => {
    if (!connection) localStorage.removeItem(CONNECTION_KEY)
    else localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection))
  },
  fetch: globalThis.fetch,
  /*
   * 三种模式：light / dark / system（**默认**，跟随系统）；没存过、存坏、storage 被禁都回落 system。
   *
   * ⚠️ 回落值必须与 `index.html` 里那段首帧前内联脚本一致（它决定第一帧的 `<html class>`）——
   * 两边不一致就是「打开侧栏先亮一下再变暗」。
   *
   * ⚠️ `localStorage.getItem` 要包 try/catch：`useTheme` 拿这个函数当 `useState` 的初始化
   * 函数，抛出去是整棵树白屏（不是闪一下）。
   */
  loadTheme: () => {
    try {
      const raw = localStorage.getItem(THEME_KEY)
      return raw === 'light' || raw === 'dark' ? raw : 'system'
    } catch {
      return 'system'
    }
  },
  /** 写不进去（配额满 / 被禁）就算了：主题退化成「本次有效」，别让 effect 抛出炸掉整棵树 */
  saveTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* 同 web 宿主：存不下就只保留内存里的选择 */
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
  /** 上次打开的现场：侧栏关掉再打开、或切到独立标签页时恢复同一个会话 */
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
  // 刻意不实现 notify：扩展里没有可靠的「应用不在前台才弹」判定（该判定在宿主侧），
  // 与 web 宿主同一取舍 —— UI 里那个开关会随 canNotify 隐藏。
  showConnectionGate: true,
  canDisconnect: true,
  title: 'Fizz',
  /*
   * `platform` 只有 web / desktop 两档，扩展按 **web** 报：它确实是浏览器里的一份页面
   * （上传 / 保存 / 主题全走 web 那条分支）。布局的宽窄判断一直是视口宽度
   * （`use-mobile` / `useIsWide`），不是平台字符串 —— 侧栏 400px 自然走窄屏那套。
   */
  platform: 'web',
  capabilities: {
    nativeTitleBar: false,
    /** 扩展页面的语音识别要 `audioCapture` 权限，没配就别给一个点不动的麦克风 */
    voice: false,
    localServer: false,
    localMediaFetch: false,
    webview: false
  },
  /*
   * 终端 = 服务端 PTY（WS），与 web / 手机同一条通道 —— **刻意不在这里实现**。
   * `@fizz/agent-client/web-host` 的 `openTerminal` 是分发器，宿主实现了就走宿主、
   * 没实现才落到它自己的浏览器兜底。在这里实现会变成「分发器 → 宿主 → 分发器」的无限递归
   * （mobile 的 host.ts 里记着这个 `RangeError: Maximum call stack size exceeded`）。
   */
  /**
   * 打开链接：优先 `chrome.tabs.create`（侧栏里 `window.open` 会弹独立小窗，没有地址栏）；
   * 拿不到扩展 API（dev server 里跑同一份代码）时退回普通 `window.open`。
   */
  openExternal: (url) => {
    try {
      const protocol = new URL(url).protocol
      if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') {
        return Promise.resolve({ ok: false, error: `不允许的协议：${protocol}` })
      }
      if (chromeApi?.tabs?.create) chromeApi.tabs.create({ url })
      else window.open(url, '_blank', 'noopener,noreferrer')
      return Promise.resolve({ ok: true })
    } catch {
      return Promise.resolve({ ok: false, error: '链接格式不合法' })
    }
  }
  // 不实现 pickLocalDirectory / getPathForFile / pickLocalMarkdownFile / readLocalFile /
  // writeLocalFile / takePendingExternalFiles / onExternalFileOpen / setDirtyTabCount：
  // 扩展同样碰不到「本机文件系统」（那是服务端那台机器），理由与 apps/web/src/host.ts 逐字相同。
}
