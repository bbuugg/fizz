/**
 * web 宿主的实现：连接 / 主题 / 权限模式落 localStorage，请求走浏览器 fetch。
 *
 * 与 desktop 宿主（`apps/desktop/src/renderer/host.ts`）的差别只有这四处 ——
 * 上层零件（`@fizz/agent-kit`）与能力层（`@fizz/agent-client`）两个宿主完全共用。
 */
import type { AiPermissionMode } from '@fizz/contracts/agent-api'
import { normalizeServerBase, type Connection } from '@fizz/agent-client/api'
import type { AgentHost } from '@fizz/agent-client/host'

/** 连接信息（token 与桌面端的「密钥」同级敏感，别塞进 URL） */
const CONNECTION_KEY = 'fizz.web.connection'
const THEME_KEY = 'fizz.web.theme'
/** 命令执行权限：存本地（跟着浏览器走），默认 confirm —— 网页端不该默认裸跑命令 */
const PERMISSION_KEY = 'fizz.web.permissionMode'
/** confirm 审批超时（分钟）：默认 10，0 = 不超时 */
const CONFIRM_TIMEOUT_KEY = 'fizz.web.confirmTimeout'
/** 对话结束后系统通知：默认开（web 没有 notify 能力，存着无害） */
const NOTIFY_ON_FINISH_KEY = 'fizz.web.notifyOnFinish'
/** 上次打开的工作区 / 会话（启动恢复现场，连带恢复会话记住的模型） */
const ACTIVE_WORKSPACE_KEY = 'fizz.web.activeWorkspaceId'
const ACTIVE_CONVERSATION_KEY = 'fizz.web.activeConversationId'
/** 终端字号：缺省 14，非数字 / 没存过都回落 14 */
const TERMINAL_FONT_KEY = 'fizz.web.terminalFontSize'

function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(CONNECTION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Connection>
    if (typeof parsed.token !== 'string' || !parsed.token) return null
    // `serverBase` 缺省 = 同源（页面由 server 托管）；填了就是跨源，规整一遍再落
    const serverBase = normalizeServerBase(parsed.serverBase)
    return { token: parsed.token, ...(serverBase ? { serverBase } : {}) }
  } catch {
    return null
  }
}

export const webHost: AgentHost = {
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
   * 两边不一致就是「刷新时先亮一下再变暗」。
   *
   * ⚠️ `localStorage.getItem` 要包 try/catch：隐私模式 / 部分 WebView 下访问 storage 会**直接抛**，
   * 而 `useTheme` 拿这个函数当 `useState` 的初始化函数，抛出去是整个应用白屏（不是闪一下）。
   */
  loadTheme: () => {
    try {
      const raw = localStorage.getItem(THEME_KEY)
      return raw === 'light' || raw === 'dark' ? raw : 'system'
    } catch {
      return 'system'
    }
  },
  /** 写不进去（隐私模式 / 配额满）就算了：主题退化成「本次会话有效」，别让 effect 抛出去炸掉整棵树 */
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
  saveNotifyOnFinish: (enabled) => localStorage.setItem(NOTIFY_ON_FINISH_KEY, enabled ? 'true' : 'false'),
  /** 上次打开的现场：刷新 / 下次打开页面时恢复同一个会话（连带恢复它选的模型） */
  loadActiveWorkspaceId: () => localStorage.getItem(ACTIVE_WORKSPACE_KEY),
  saveActiveWorkspaceId: (id) => localStorage.setItem(ACTIVE_WORKSPACE_KEY, id ?? ''),
  loadActiveConversationId: () => localStorage.getItem(ACTIVE_CONVERSATION_KEY) || null,
  saveActiveConversationId: (id) => localStorage.setItem(ACTIVE_CONVERSATION_KEY, id ?? ''),
  // 终端字号：缺省 14；非数字 / 没存过都回落 14
  loadTerminalFontSize: () => {
    const raw = localStorage.getItem(TERMINAL_FONT_KEY)
    if (raw === null) return 14
    const n = Number(raw)
    return Number.isFinite(n) ? n : 14
  },
  saveTerminalFontSize: (size) => localStorage.setItem(TERMINAL_FONT_KEY, String(size)),
  // 刻意不实现 notify：浏览器没有可靠的「应用不在前台才弹」系统通知（该判定在宿主侧），
  // UI 里这个开关会随 canNotify 隐藏。
  showConnectionGate: true,
  canDisconnect: true,
  title: 'Fizz',
  platform: 'web',
  capabilities: {
    nativeTitleBar: false,
    voice: true,
    localServer: false,
    localMediaFetch: false,
    webview: false
  },
  /*
   * 终端 = 服务端 PTY（WS）—— **刻意不在这里实现**。
   *
   * `@fizz/agent-client/web-host` 的 `openTerminal` 是**分发器**：宿主实现了就走宿主，
   * 没实现才落到它自己的浏览器兜底（跨源地址解析、心跳保活、二进制 / ZMODEM 通道全在
   * 兜底里，服务端地址与 API 层共用同一份判断）。之前这里写的是
   * `openTerminal: (o) => openBrowserTerminal(o)`，而 `openBrowserTerminal` 正是那个
   * 分发器 —— 于是「分发器 → 宿主 → 分发器 → …」，一开终端就
   * `RangeError: Maximum call stack size exceeded`。要服务端 PTY 就别实现它。
   */
  /**
   * 快捷功能「打开链接」：浏览器自己开新标签页（noopener 防 opener 攻击）。
   * 刻意不实现 openPath：浏览器碰不到本机文件系统，这类动作由 UI 提示不支持。
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
  // 刻意不实现 pickLocalDirectory / getPathForFile：浏览器碰不到本机文件系统，
  // 工作区目录只能通过「浏览服务端目录」弹窗（GET /api/fs/dirs）来选。
  // 拖进来的 `File` 也已经被涂掉路径（`webkitRelativePath` 只是相对路径，而且指向
  // **用户那台**机器，跟跑 Agent 的机器不是一回事）—— 所以侧栏没有「拖目录进来」这条路。
}
