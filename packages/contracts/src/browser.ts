/**
 * 浏览器自动化（Agent 的 `browser_*` 工具 + 会话页内嵌面板）：前后端共用的纯契约。
 *
 * 这一层刻意**不牵 Node 代码**（与 types.ts 同款约束）：渲染端面板、后端引擎、
 * Agent 工具三方都要引用这里的类型与常量，必须放在浏览器安全入口里，否则 import 一次
 * contracts 就会把 node:fs / playwright 拖进前端产物。
 *
 * 会话 id 是后端与渲染端之间的唯一契约 —— 渲染端用同一个 id 订阅 screencast 帧，
 * 后端用它路由事件。推导规则与视口预设共用同一份，两边各写一份迟早会漂。
 */

/**
 * 浏览器来源。
 *
 * 现在**一律是 `bundled`**（Playwright 自带的 headless shell）：界面上已经没有来源选择，
 * `normalizeBrowserSettings` 会把所有值收敛到它。其余三值是历史数据里可能出现的值，
 * 保留在类型里只为让 `resolveBrowserChannel` / `launchAttempts` 的兜底分支能编译 ——
 * 新代码不要再往这里加来源。
 */
export type BrowserChannel = 'auto' | 'bundled' | 'msedge' | 'chrome'

/**
 * 浏览器偏好：**按会话**一份（落 `AgentConversation.browserSettings`，随会话目录持久化）。
 *
 * - `enabled`：**这个会话**要不要挂内置的 `browser_*` 工具集（连同系统提示词里那段浏览器
 *   说明一起撤，见 `apps/server/src/server/chat-turn.ts`）。**默认关** —— 浏览器工具是
 *   「用到才开」的能力，不该默认塞进每一轮的工具集里；要开就在输入框上方的工具条点一下
 *   （`ComposerToolbar` 的 `BrowserToggle`，改完下一轮生效）。
 * - `channel` 只决定**用哪一个浏览器**（`auto` 是历史上唯一的行为）。
 *
 * 全局那份（`CoreData.browserSettings`）只是**新会话的默认值**（因此 `enabled` 默认也是关；
 * 老数据文件里残留的 `true` 由 `store.ts` 的 v2 迁移压回默认值）。
 *
 * ⚠️ 会话**没单独设过**（`browserSettings` 缺省）时按全局默认走 —— 所以改默认值会同时影响
 * 「以后新建的会话」和「从没动过这颗开关的老会话」；显式设过的会话不受影响。
 *
 * 与外部 `playwright-mcp` 的关系：它的工具名与内置这套**完全同名**。以前靠用户手动二选一
 * 规避冲突（工具注册表对「同名并列最高 priority」直接抛错）；现在由装配层**自动让位** ——
 * 会话挂了带同名工具的外部 MCP 时，内置对应的 `browser_*` 直接不挂，用户什么都不用做。
 */
export interface BrowserSettings {
  enabled: boolean
  channel: BrowserChannel
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { enabled: false, channel: 'bundled' }

/**
 * 收敛：手改坏的数据文件 / 老版本缺字段都不该让读接口抛错。
 *
 * `channel` **恒为 `bundled`**：来源选项已经从界面上撤掉（内置浏览器与 `web_fetch`
 * 的 browser 引擎共用同一份 headless shell，选别的只会让两边行为不一致）。存量会话里
 * 写着 `auto` / `msedge` / `chrome` 的一律收敛 —— 不收敛的话，老会话会继续按旧来源跑，
 * 而界面上已经没有入口能改回来。
 */
export function normalizeBrowserSettings(value: unknown): BrowserSettings {
  const raw = value as Partial<BrowserSettings> | undefined
  return {
    enabled:
      typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_BROWSER_SETTINGS.enabled,
    channel: 'bundled'
  }
}

/**
 * 「网站数据」占用（设置页「浏览器」一节）。
 *
 * 内置浏览器**没有全局一份 cookie 池**：每个会话一份持久化 profile（
 * `chromium.launchPersistentContext`，目录 `<dataDir>/browser-profiles/<sessionId>`），
 * Cookie / 登录态 / localStorage / IndexedDB / HTTP 缓存全在各自那份里。所以这里的
 * 「清除」只能是**整份 profile 地删**，而统计也只能按目录累加。
 *
 * `count` 是磁盘上实际存在的 profile 目录数，**可能大于会话数**：历史版本删会话时没扫
 * profile（现已在删除路径上补了 purge，仍按磁盘数才能看见更早的残留，见
 * `packages/tools/src/browser/profiles.ts` 的 `browserProfileDirs`）。`sizeBytes` 为 0
 * 表示没有数据。
 */
export interface BrowserProfileUsage {
  count: number
  sizeBytes: number
}

/**
 * 自带浏览器运行时的安装状态（设置页「浏览器」一节）。
 *
 * `installed` 是**唯一的「装没装」判据**：输入框上方那颗开关显不显示、`web_fetch` 与
 * `screenshot` 要不要直接回绝，都看它。其余字段（装在哪、占多少、是不是正在装）
 * 只给安装 / 卸载那是几个按钮用。
 */
export interface BrowserRuntime {
  installed: boolean
  /** 安装目录；`playwright-core` 解析失败时 null */
  path: string | null
  /** 磁盘占用（字节）；没装或统计失败时 null */
  sizeBytes: number | null
  /** 与打包进来的 playwright-core 匹配的 headless shell revision */
  revision: string | null
  /** 是否有下载正在进行 */
  downloading: boolean
}

/** 视口形态：PC / 手机（决定响应式断点、DPR、UA） */
export type BrowserViewportMode = 'desktop' | 'mobile'

/** 鼠标按键（CDP 的 buttons 位掩码按它算） */
export type BrowserMouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward'

/** 渲染端合成输入 → CDP 命令的载荷（坐标已是页面视口坐标） */
export type BrowserInputEvent =
  | {
      kind: 'mouse'
      type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
      x: number
      y: number
      button: BrowserMouseButton
      clickCount?: number
      /** 修饰键位掩码（Alt=1 / Ctrl=2 / Meta=4 / Shift=8，可叠加） */
      modifiers?: number
    }
  | {
      kind: 'wheel'
      x: number
      y: number
      deltaX: number
      deltaY: number
      modifiers?: number
    }
  | {
      kind: 'key'
      type: 'keyDown' | 'keyUp'
      key: string
      code: string
      /** Windows 虚拟键码（CDP 必须，浏览器 KeyboardEvent 没有直接字段，由渲染端算） */
      windowsVirtualKeyCode: number
      modifiers?: number
      /** 可打印字符时带上，走 keyDown 会插入该字符 */
      text?: string
    }
  | { kind: 'text'; text: string }

/** 一帧 screencast 画面：JPEG 的 base64（含 data: 前缀，可直接喂 <img src>） */
export interface BrowserFrame {
  type: 'frame'
  sessionId: string
  /** `data:image/jpeg;base64,...` */
  data: string
  width: number
  height: number
}

/** 浏览器会话状态（地址栏 / 标题 / 导航可用性 / 视口） */
export interface BrowserSessionState {
  type: 'state'
  sessionId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewport: { width: number; height: number }
  viewportMode: BrowserViewportMode
  /** 实际采用的浏览器（'Chromium' / 'Edge' / 'Chrome' / null = 还没起） */
  channel: string | null
}

/** 会话关闭通知 */
export interface BrowserSessionClosed {
  type: 'closed'
  sessionId: string
  reason: string
}

/** 后端推给渲染端的事件（自带 type 判别字段，便于前端分发） */
export type BrowserEvent = BrowserFrame | BrowserSessionState | BrowserSessionClosed

/** 渲染端 → 后端：面板发出的控制 / 输入消息 */
export type BrowserClientMessage =
  | { type: 'input'; event: BrowserInputEvent }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'setViewportMode'; mode: BrowserViewportMode }
  /**
   * 只把浏览器拉起来，不导航、不动页面。
   *
   * 面板「切到这一页 / 连上」时发它，服务端据此 `ensureBrowserSession`（已有会话则原样
   * 复用）。不复用 `reload`：那会真的刷一次页面（登录态、表单、滚动位置全丢）。
   */
  | { type: 'ensure' }

// ---------------------------------------------------------------------------
// 会话 id
// ---------------------------------------------------------------------------

/** Agent 浏览器会话的 id 前缀 */
const AGENT_BROWSER_PREFIX = 'agent-browser:'

/**
 * 一个 Agent 会话对应一个浏览器会话。
 * 用 `:` 而不是 `-` 作分隔：conversationId 是 UUID，本身含 `-`，用 `-` 会让边界看不出来。
 */
export function agentBrowserSessionId(conversationId: string): string {
  return `${AGENT_BROWSER_PREFIX}${conversationId}`
}

/** 反解出 conversationId（调试用；不是 agent 会话则返回 null） */
export function conversationIdOfBrowserSession(sessionId: string): string | null {
  return sessionId.startsWith(AGENT_BROWSER_PREFIX)
    ? sessionId.slice(AGENT_BROWSER_PREFIX.length)
    : null
}

// ---------------------------------------------------------------------------
// 视口预设
// ---------------------------------------------------------------------------

export interface BrowserViewportPreset {
  mode: BrowserViewportMode
  /** 切换按钮上的文字 */
  label: string
  /** 视口逻辑尺寸（CSS px）—— 决定页面走哪套响应式断点 */
  width: number
  height: number
  /** 浏览器上下文的 deviceScaleFactor（= 页面里的 window.devicePixelRatio） */
  dpr: number
}

/**
 * ⚠️ 视口**不跟随面板尺寸**。
 *
 * 面板宽度取决于用户把窗口拉多宽、分隔条拖到哪，把它当视口会让同一个页面在不同窗口
 * 大小下走不同的响应式断点（窗口窄了页面就变「手机版」），既不可复现也没法跟浏览器
 * 里手动看到的效果对齐。所以固定成两个预设，画面由 `object-contain` 缩放填进面板。
 *
 * `desktop` 用 1280×800@1x（与改动前的默认视口一致，Agent 工具也用它）；
 * `mobile` 用 390×844@2x（iPhone 14 的逻辑尺寸与 DPR），页面里的
 * `devicePixelRatio` 也真的是 2，站点才会按手机给图。
 */
export const BROWSER_VIEWPORT_PRESETS: Record<BrowserViewportMode, BrowserViewportPreset> = {
  desktop: { mode: 'desktop', label: 'PC', width: 1280, height: 800, dpr: 1 },
  mobile: { mode: 'mobile', label: '手机', width: 390, height: 844, dpr: 2 }
}

/** 默认 PC 屏 —— 打开浏览器时不该先看到移动版布局 */
export const DEFAULT_BROWSER_VIEWPORT: BrowserViewportMode = 'desktop'

/** 取预设；传入未知值时回退到默认，别让一个坏值把会话搞崩 */
export function browserViewportPreset(mode?: BrowserViewportMode): BrowserViewportPreset {
  return BROWSER_VIEWPORT_PRESETS[mode ?? DEFAULT_BROWSER_VIEWPORT] ?? BROWSER_VIEWPORT_PRESETS.desktop
}

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------

/**
 * UA 必须跟视口预设一起切。
 *
 * 光切视口只能让**响应式**的那部分跟着变；站点按 UA 分流的那部分（`m.xxx` 跳转、
 * 服务端按 UA 出模板）在下次请求前一直是老样子 —— 「视口是 PC、页面却是手机」最常见
 * 的来源就是这里。所以两个预设各自带一份 UA。
 *
 * 桌面 UA 用宿主浏览器**自己报的那份**（版本号真实、与 Sec-CH-UA 自洽）；
 * 手机 UA 只把平台段换成 Android，**Chrome 版本号沿用桌面 UA 的** —— 写死版本号
 * 迟早会和浏览器真实版本对不上，而那些做指纹一致性校验的站点就吃这一套。
 */
export function browserUserAgent(mode: BrowserViewportMode, actualDesktopUa: string): string {
  const desktop = (actualDesktopUa.trim() || FALLBACK_DESKTOP_USER_AGENT).replace(
    /HeadlessChrome/g,
    'Chrome'
  )
  if (mode !== 'mobile') return desktop
  const version = /Chrome\/([\d.]+)/.exec(desktop)?.[1] ?? '131.0.0.0'
  return `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`
}

/** 手机 UA 对应的 `navigator.platform`（桌面不覆盖，保持宿主原样） */
export const MOBILE_PLATFORM = 'Linux armv8l'

/** 读不到真实 UA 时的兜底；正常情况下走不到这里 */
export const FALLBACK_DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
