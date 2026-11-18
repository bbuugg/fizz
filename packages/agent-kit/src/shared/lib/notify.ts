/**
 * 通知的唯一出口：**偏好**一道闸门 + **前台 / 后台**两条通道。
 * 同时装着偏好本身（模块级 + 订阅，和 `lib/sidebar-collapsed.ts` 同一个路子）。
 *
 * ## 为什么单独一个模块
 *
 * 「要不要发通知」这个判断散在多处会各写各的，最后必然出现「设置里关了，通知还在弹」
 * 这种前后不一致。这里把它收成唯一的 `notify()`：想发通知的代码只管**描述事件**，
 * 判断留给这一层。
 *
 * ## 两条通道，按前台状态分流
 *
 * | 状态 | 通道 | 为什么 |
 * |---|---|---|
 * | 后台（页面不可见 / 桌面窗口不在前台） | **系统通知**：web = `Notification` API，desktop = 主进程 Electron Notification，**安卓壳 = Capacitor 本地通知**（见 `native-notify.ts`） | 用户此刻看不到应用，只有 OS 通知中心能把他叫回来 |
 * | 前台（用户正盯着应用） | **应用内 toast**（sonner，右下角） | OS 通知在这种情况下反而经常看不见（被折叠 / 弹到别的显示器），而 toast 就在眼前，还能带「查看」按钮直接跳到对应任务 / 会话 |
 *
 * 一条事件**只会走一条通道**：前台发了 toast 就不要再补一条系统通知，否则用户
 * 回到桌面时会在通知中心翻到一条自己早看过的东西。
 *
 * ⚠️ 一个例外（`alreadyInView`）：用户**正看的就是这一屏**时连前台 toast 也不发 ——
 * 通知的用途（把人叫回来 / 告知他看不到的事）此时根本不成立，结果就在眼前。
 *
 * 后台判定放两处，各按环境来：desktop 必须在主进程（托盘隐藏、多窗口这些渲染端
 * 根本看不全，见 `apps/desktop/src/main/index.ts` 的 `WINDOW_IPC.notify`），web 按
 * `visibilityState === 'hidden' || !document.hasFocus()` 判（页面维度，没有窗口可问；
 * 并排两个浏览器窗口时页面仍是 visible，人却在另一个窗口里干活，所以带上 focus）。
 * 系统通知**拿不到授权**时也退到 toast：偏好开着就不该把事件静默丢掉，
 * 用户至少能在回到页面时看到 —— 缺的只是「后台把他叫回来」那一条。
 *
 * ## 偏好默认开
 *
 * 默认 `true`（要通知，需用户主动关）。这是**总闸门**：两条通道都归它管，
 * 关了就都不发（设置里说成「已关闭」）。后台那条通道另需浏览器授权，
 * 授权只能由用户在真实手势里点出来（见 `requestNotifyPermission`）。
 *
 * 偏好走 `prefs-sync`：`localStorage` 是首帧缓存，真源在服务端 `CoreData.prefs`
 * （`fizz.web.notify` 在 `PREF_KEYS` 里）—— 桌面上关了通知，手机上也不该再弹。
 * 注意**系统授权不在这一层**：那是每台设备各问一次的，设置成开但没授权的端会自己
 * 退到应用内 toast（见下面 `notify` 的分流）。
 */
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { getAgentHost } from '@fizz/agent-client/host'
import { readPref, subscribePrefs, writePref } from './prefs-sync'
import {
  cachedNativePermission,
  ensureNativeAppStateTracking,
  ensureNativeNotifyPermission,
  isNativeAppForeground,
  isNativeShell,
  refreshNativePermission,
  requestNativePermission,
  sendNativeNotification,
  toWebPermission
} from './native-notify'

const STORAGE_KEY = 'fizz.web.notify'

// ---------------------------------------------------------------------------
// 偏好
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>()

/** 读盘口径与旧实现一致：`!== '0'` 即开（没存过 = 开）；SSR 上 `readPref` 返回 null 也落在开 */
function readEnabled(): boolean {
  return readPref(STORAGE_KEY) !== '0'
}

/** 模块级缓存：`useSyncExternalStore` 要求 `getSnapshot` 返回同一个值 */
let enabled = readEnabled()

/*
 * 订阅变更：本地总线（别的窗口，desktop 的设置页是独立渲染进程）**和**服务端下行
 * （`state-ws` 推来的快照，见 `agent-store.ts`）。模块级单例，不需要退订。
 */
subscribePrefs(STORAGE_KEY, () => {
  const next = readEnabled()
  if (next === enabled) return
  enabled = next
  for (const listener of listeners) listener()
})

function getEnabled(): boolean {
  return enabled
}

function subscribePreference(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 读偏好（存坏了当没存过 = 默认开） */
export function loadNotifyEnabled(): boolean {
  return enabled
}

/**
 * 写偏好并通知订阅者。
 *
 * `writePref` 会先写本地（首帧 / 离线可用）再合并上行到 `POST /api/prefs`；同窗口写盘
 * 不触发 `storage`，所以这里的 `enabled` 与订阅者得自己更新一次。
 */
export function saveNotifyEnabled(next: boolean): void {
  if (next === enabled) return
  enabled = next
  writePref(STORAGE_KEY, next ? '1' : '0')
  for (const listener of listeners) listener()
}

/** React 版的偏好读取：设置开关与外壳共享同一个值 */
export function useNotifyEnabled(): boolean {
  return useSyncExternalStore(subscribePreference, getEnabled, () => true)
}

// ---------------------------------------------------------------------------
// 能力与权限
// ---------------------------------------------------------------------------

/**
 * 有没有「系统通知」能力（SSR 一律当没有）。
 *
 * 两种环境都算有：浏览器有 `Notification`，安卓壳里则是 Capacitor 原生插件
 * （WebView **不实现** Web Notification，所以这里不能只看 `'Notification' in window`，
 * 否则手机上永远显示「此环境不支持」，见 `native-notify.ts`）。
 */
export function notifySupported(): boolean {
  if (isNativeShell()) return true
  return typeof window !== 'undefined' && 'Notification' in window
}

/**
 * 当前权限；不支持时返回 `'unsupported'`（区别于「支持但被拒」）。
 *
 * 原生壳里的权限是**异步**的，这里读 `native-notify.ts` 的同步缓存 ——
 * 首次挂载时可能还是 `'default'`，由 `refreshNotifyPermission()` 校正。
 */
export function notifyPermission(): NotificationPermission | 'unsupported' {
  if (isNativeShell()) return toWebPermission(cachedNativePermission())
  if (!notifySupported()) return 'unsupported'
  return Notification.permission
}

/**
 * 安卓壳启动时补一次系统授权（偏好关着就别问 —— 用户明确说了不要通知，
 * 还在启动时弹系统权限框是纯粹的打扰）。非原生环境什么都不做。
 */
export async function ensureNativeNotifyReady(): Promise<void> {
  // 前后台判定先挂上：它跟「要不要通知」无关，别因为通知关着就让状态停在「前台」
  await ensureNativeAppStateTracking()
  if (!enabled) return
  await ensureNativeNotifyPermission()
}

/**
 * 重新问一次系统权限（原生壳专用；web / desktop 直接回读同步值）。
 *
 * 设置页挂载时调它：原生权限只能跨桥查询，而 `notifyPermission()` 必须是同步的。
 */
export async function refreshNotifyPermission(): Promise<NotifyPermissionResult> {
  if (!notifySupported()) return 'unsupported'
  if (isNativeShell()) return toWebPermission(await refreshNativePermission())
  return Notification.permission
}

/**
 * 授权申请的结果。`'stuck'` = 等了 `PROMPT_TIMEOUT_MS` 也没等到浏览器给结果，
 * 基本可以断定弹窗被 quiet permission UI 静默掉了（见 `requestNotifyPermission`）。
 */
export type NotifyPermissionResult = NotificationPermission | 'unsupported' | 'stuck'

/** 授权弹窗的等待上限：弹窗真会弹的话，点下按钮的瞬间就出现了；超时还没结果 = 被静默拦截 */
const PROMPT_TIMEOUT_MS = 4000

/**
 * 申请通知权限。
 *
 * ⚠️ **必须在真实用户手势的调用栈里调**（按钮 onClick），否则浏览器直接拒绝 ——
 * 这是浏览器的硬性要求，不是这里能绕开的，所以调用点不能放到 useEffect 里。
 * （原生壳没有这条限制：安卓的系统权限弹窗不需要手势，见 `ensureNativeNotifyPermission`。）
 *
 * ## 超时兜底（浏览器的「安静模式」）
 *
 * Chrome / Edge 对被关闭过几次弹窗的站点会进入 quiet permission UI：授权弹窗**根本
 * 不弹**，`Notification.requestPermission()` 的 Promise 永远 pending，而且没有任何
 * API 能问「弹窗到底弹没弹」。这里限时等一个结果，超时按「弹窗没出来」返回
 * `'stuck'`，让设置页把「去站点设置手动允许」讲出来，而不是让用户面对一个
 * 点了永远没反应的按钮。
 *
 * 超时不必然是被拦截 —— 也可能弹窗真弹了、用户还没点。真弹了的话结果最终会落在
 * 全局 `Notification.permission` 上，再点一次（顶部有全局值短路）或刷新页面就能读到。
 */
export async function requestNotifyPermission(): Promise<NotifyPermissionResult> {
  if (isNativeShell()) return toWebPermission(await requestNativePermission())
  if (!notifySupported()) return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  try {
    const answer = await Promise.race([
      Notification.requestPermission(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROMPT_TIMEOUT_MS))
    ])
    if (answer !== null) return answer
    // 超时：权限值已经变了说明结果刚落下来，顺着拿；还停在 default 才算「弹窗没出来」
    return Notification.permission === 'default' ? 'stuck' : Notification.permission
  } catch {
    return Notification.permission
  }
}

// ---------------------------------------------------------------------------
// 文本截断
// ---------------------------------------------------------------------------

/**
 * 失败原因之类可能几百字，系统通知塞不下 —— 取首行 + 限长。
 *
 * 取首行是因为错误常常是「首行 = 结论、后面 = 堆栈 / 日志尾巴」。
 * 取的是**第一个非空行**而不是第 0 行：`Error: xxx` 这类消息前面常带一个空行
 * （拼接的日志、上一步的残留输出），死取第 0 行会得到空字符串，整条通知就白发了。
 *
 * `max` 按字符数算（够用即可；系统通知的实际渲染宽度由 OS 决定，这里只防爆量）。
 */
export function truncateText(text: string | undefined | null, max = 80): string {
  if (!text) return ''
  // 换行、空行、制表都算分隔；跳过开头的空行
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return ''
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine
}

/**
 * 给通知用的正文摘要：**结论 + 尾部**，而不是只取首行。
 *
 * ## 为什么不用 `truncateText`
 *
 * 错误类的正文往往是「首行结论 + 多行细节」（命令输出、错误堆栈）。只取首行 80 字的
 * 后果是：结论被截断、而真正能定位问题的**尾部整段丢掉** —— 收到通知的人既不知道成没成、
 * 也不知道下一步看哪。
 *
 * ## 具体策略
 *
 * 1. 首行（结论）优先，占预算的大头；
 * 2. 预算有剩时，从**末尾**再取几行（错误堆栈的最后一帧往往就在那里），
 *    用 `⋯` 标出中间被跳过的部分；
 * 3. 单行就超长时仍按 `max` 截断并补省略号。
 *
 * 放在末尾而不是开头，是因为调用方的拼接方式固定是「`xxx：` + 原文」——
 * 结论在前更符合读通知的直觉，而尾部才是补充信息。
 */
export function summarizeForNotify(text: string | undefined | null, max = 160): string {
  if (!text) return ''
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (!lines.length) return ''
  if (lines.length === 1) {
    const only = lines[0]
    return only.length > max ? `${only.slice(0, max)}…` : only
  }

  const head = lines[0]
  // 首行自己就超预算：没空间再取尾部，退回截断首行（与 truncateText 同行为）
  if (head.length >= max) return `${head.slice(0, max)}…`

  const tail: string[] = []
  let used = head.length
  // 从最后一行往前收：越靠后的通常是最终的错误帧
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]
    // 「首行 + ⋯ + 一行」至少要 10 字才不至于只剩省略号
    if (used + line.length + 3 > max - 4) break
    tail.unshift(line)
    used += line.length + 3
  }
  if (!tail.length) return head.length > max ? `${head.slice(0, max)}…` : head
  return `${head}⋯${tail.join(' ')}`
}

// ---------------------------------------------------------------------------
// 发通知
// ---------------------------------------------------------------------------

export interface NotifyOptions {
  /** 标题：一句话说清发生了什么 */
  title: string
  /** 正文：补充信息（失败原因、回复摘…）。过长会被 `summarizeForNotify` 摘要 */
  body?: string
  /**
   * 同 tag 的通知会**互相替换**而不是堆叠 —— 给「同一个任务 / 会话」用，
   * 重跑一次时旧的失败通知被新的顶掉，不会在通知中心堆一串同义的。
   */
  tag?: string
  /** 点击通知时干什么（通常是打开某个会话 / 任务，见 `hooks/use-notify-watcher.ts`） */
  onClick?: () => void
  /**
   * 用户此刻**正看着它**（当前就停在对应的那一屏）。
   *
   * 置 true 时**前台连应用内 toast 也不发** —— 结果 / 待办就在他眼前，右下角再飘一条
   * 纯属打扰（典型：自己正盯着的那个会话跑完了）。
   *
   * ⚠️ **后台时忽略它**：人根本看不到那一屏，系统通知照发，否则「跑完了」这件事就丢了。
   * 前台判定仍留在 `notify` 里做（desktop 问主进程、web 看 visibility/focus）——
   * 调用方只需要回答「他是不是正看着这一屏」。
   */
  alreadyInView?: boolean
}

/**
 * 前台用的**应用内**通知：右下角一条 sonner toast。**不判闸门** ——
 * 偏好那一层在 `notify` 里已经判过，这里只管发。
 *
 * `tag` 变成 toast 的 `id`：同一个任务 / 会话连着出多条时，后来的顶掉前面的，
 * 与系统通知 `tag` 的语义一致，不会在右下角堆一串同义的。
 * `id` 加 `notify:` 前缀，免得和别处的 toast id 撞上。
 */
export function notifyInApp({ title, body, tag, onClick }: NotifyOptions): void {
  const description = body ? summarizeForNotify(body, 120) : ''
  toast(title, {
    ...(tag ? { id: `notify:${tag}` } : {}),
    ...(description ? { description } : {}),
    // 不用 Infinity（那是「连不上服务端」这类要人处理的错误的待遇）：
    // 这些是顺便告知类消息，看一眼就该走，要看细节有「查看」按钮和侧栏角标。
    duration: 8000,
    closeButton: true,
    ...(onClick
      ? {
          // sonner 的 action 是落在 toast 上的按钮：点一下直接跳到对应任务 / 会话
          action: { label: '查看', onClick: () => onClick() }
        }
      : {})
  })
}

/**
 * 发一条通知：**偏好没开就静默返回 null**（调用方不用各自判断，也就不用担心某处
 * 漏判导致「用户关了还弹」），否则按前台 / 后台选通道，见文件头那张表。
 *
 * 返回系统通知实例或 `null`，调用方一般不用管返回值（留它是给将来想做
 * 「通知里带按钮」之类扩展的）。
 */
export function notify(options: NotifyOptions): Notification | null {
  if (!enabled) return null
  const { title, body, tag, onClick, alreadyInView } = options

  // 桌面端走主进程通知通道：渲染端的 Web Notification 在 Electron 里拿不到 OS 级通知
  // （权限恒为 default、授权框被静默），而主进程的 Notification 可靠、前台判定也在那边
  // （托盘隐藏 / 多窗口，渲染端看不全），点通知 = 把主窗口拉回前台。
  // tag / onClick 仅 web 端生效。
  const host = getAgentHost()
  if (host.notify) {
    // 它返回 false = 主进程没发：窗口在前台（用户正看着）/ 系统通知不可用 /
    // 创建失败。三种都该由应用内 toast 顶上，否则这条事件就白瞎了 ——
    // 唯一的例外是 `alreadyInView`：他正看着这一屏，飘 toast 才是多余。
    void host
      .notify({ title, body: body ? summarizeForNotify(body) : '' })
      .then((sent) => {
        if (!sent && !alreadyInView) notifyInApp(options)
      })
    return null
  }

  // 「后台」按**页面维度**判（这里没有窗口可问）：不可见，或者可见但窗口没聚焦
  // （并排放两个浏览器窗口时 visibilityState 仍是 visible，人却在另一个窗口里干活）。
  const visibility = typeof document !== 'undefined' ? document.visibilityState : 'visible'
  const focused = typeof document !== 'undefined' ? document.hasFocus() : false
  const inBackground = visibility === 'hidden' || !focused

  // 安卓壳：WebView 没有 Notification API，系统通知只能走 Capacitor 的本地通知。
  // 「后台」用原生 `appStateChange` 判（`isNativeAppForeground()`）；WebView 的
  // `visibilityState` 在切 App 后仍常常是 `'visible'`，只信它会把系统通知吞成一条
  // 看不见的应用内 toast（见 `native-notify.ts` 那段注释）。两者取或：哪个说后台都算后台。
  if (isNativeShell()) {
    if (visibility === 'hidden' || !isNativeAppForeground()) {
      // 原生通道是异步的：先当「发出去了」，真发失败（没授权 / 桥不可用）再补一条应用内提示
      void sendNativeNotification({
        title,
        body: body ? summarizeForNotify(body) : undefined,
        tag,
        onClick
      }).then((sent) => {
        if (!sent && !alreadyInView) notifyInApp(options)
      })
      return null
    }
    if (alreadyInView) return null
    notifyInApp(options)
    return null
  }

  // web 端：只有「后台 + 已授权」才发系统通知。
  const canSystemNotify = notifySupported() && Notification.permission === 'granted'
  if (canSystemNotify && inBackground) {
    const notificationOptions: NotificationOptions = {}
    if (body) notificationOptions.body = summarizeForNotify(body)
    if (tag) notificationOptions.tag = tag

    const instance = new Notification(title, notificationOptions)

    if (onClick) {
      instance.onclick = () => {
        // 先把窗口叫回来：通知点击发生在别的窗口时，不 focus 用户会以为没点中
        try {
          window.focus()
        } catch {
          // 某些浏览器在无手势上下文里 focus 会抛，忽略 —— 打开动作照走
        }
        instance.close()
        onClick()
      }
    }
    return instance
  }

  // 前台（或系统通知不可用）：用户正看着这一屏就静默收场 —— 结果就在眼前，
  // 右下角再飘一条纯属打扰；否则应用内 toast
  if (alreadyInView) return null
  notifyInApp(options)
  return null
}
