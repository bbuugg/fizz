/**
 * 安卓壳的应用内更新（与 desktop 的 `apps/desktop/src/main/updater.ts` 同一套产品约定）：
 *
 * - **静默检查**：启动 8 秒后查一次，之后每 6 小时（以及回到前台时）再查；
 *   失败只在日志里留一笔 —— 手机断网 / GitHub 不可达是常态，不该变成界面上的红字；
 * - **绝不自动下载**：查到新版本只进 `available`，下载与安装都必须用户点
 *   （安卓本来也不允许静默安装，安装器确认永远存在）；
 * - 安装前先查「安装未知应用」授权，没给就跳系统设置页并留下提示，用户回来再点。
 *
 * 状态机与 desktop 同构（六个档位），`AppUpdateSection` 一份界面两端共用；
 * 这里只把 `AppUpdateBridge` 的五件事映射到 Capacitor 插件与 GitHub Release。
 */
import { t } from '@fizz/i18n'
import type { AppUpdateBridge, AppUpdateState, AppUpdateStatus } from '@fizz/agent-client/host'
import { appVersion } from '@fizz/agent-kit/shared/lib/app-version'
import { isNativeShell } from '@fizz/agent-kit/shared/lib/native-notify'
import { fetchLatestAndroidRelease, isVersionNewer } from './github-release'
import { FizzUpdater } from './fizz-updater'

/** 启动后多久开始静默检查（ms）：别和首屏抢网 */
const SILENT_CHECK_DELAY = 8000
/** 常驻后台的应用可能几天不重启，隔一段时间再查（回到前台时也补一次） */
const SILENT_CHECK_INTERVAL = 6 * 60 * 60 * 1000

let state: AppUpdateState = 'idle'
let latest: string | null = null
/** `available` 时待下载的 APK 地址（GitHub Release 资产） */
let downloadUrl: string | null = null
let percent = 0
let error: string | null = null
/** 用户主动取消：之后在途的进度 / 失败事件一律忽略（DownloadManager 的失败事件分不出来） */
let canceled = false
/** 上次检查时间（含失败）：回前台时据此决定要不要补查 */
let lastCheckAt = 0

const listeners = new Set<(status: AppUpdateStatus) => void>()

function snapshot(): AppUpdateStatus {
  return { state, current: appVersion(), latest, supported: true, percent, error }
}

function setState(
  next: AppUpdateState,
  patch: Partial<Pick<AppUpdateStatus, 'latest' | 'percent' | 'error'>> = {}
): void {
  state = next
  if ('latest' in patch) latest = patch.latest ?? null
  if ('percent' in patch) percent = patch.percent ?? 0
  if ('error' in patch) error = patch.error ?? null
  const snap = snapshot()
  for (const cb of listeners) cb(snap)
}

/** 原生失败码 → 当前语言文案（原生侧刻意不留中文字符串） */
function downloadFailureText(code: string): string {
  switch (code) {
    case 'space':
      return t('存储空间不足，清理后再试。')
    case 'file':
      return t('写入安装包失败，请重试。')
    case 'network':
      return t('下载地址无响应，请检查网络后重试。')
    case 'redirect':
      return t('下载地址重定向次数过多。')
    case 'interrupted':
      return t('下载中断，请重试。')
    default:
      return t('下载失败，请重试。')
  }
}

function installFailureText(err: unknown): string {
  const code = err instanceof Error ? err.message : String(err)
  switch (code) {
    case 'install-permission':
      return t('请先在系统设置里允许安装未知应用，再回来点安装。')
    case 'install-missing':
      return t('安装包不存在，请重新下载。')
    case 'install-activity':
      return t('没有可用的系统安装器。')
    default:
      return t('无法打开系统安装器，请重试。')
  }
}

/** 插件事件只挂一次（模块级单例，与 desktop 的 `autoUpdater` 同一理由） */
let eventsAttached = false

function attachPluginEvents(): void {
  if (eventsAttached || !isNativeShell()) return
  eventsAttached = true
  void (async () => {
    try {
      await FizzUpdater.addListener('downloadProgress', (event) => {
        if (state !== 'downloading' || canceled) return
        const next = Math.min(100, Math.max(0, Math.round(event.percent)))
        if (next === percent) return
        setState('downloading', { percent: next })
      })
      await FizzUpdater.addListener('downloadCompleted', () => {
        if (canceled) {
          canceled = false
          return
        }
        setState('downloaded', { percent: 100, error: null })
      })
      await FizzUpdater.addListener('downloadFailed', (event) => {
        if (canceled) {
          canceled = false
          return
        }
        setState('available', { percent: 0, error: downloadFailureText(event.code) })
      })
    } catch (err) {
      eventsAttached = false
      console.warn('[app-update] 订阅下载事件失败：', err)
    }
  })()
}

attachPluginEvents()

async function check(manual: boolean): Promise<AppUpdateStatus> {
  // 检查中 / 下载中 / 已下完不重入：已下完再查会把「打开安装器」的入口冲掉
  if (state === 'checking' || state === 'downloading' || state === 'downloaded') return snapshot()
  // 静默检查不打扰已有结论（发现新版本 / 下载中）；手动点仍可重查
  if (!manual && state !== 'idle' && state !== 'up-to-date') return snapshot()
  // 冷启动时原生桥可能还没就绪（首次订阅失败过），这里补一次
  attachPluginEvents()

  lastCheckAt = Date.now()
  setState('checking', { error: null })
  try {
    const release = await fetchLatestAndroidRelease()
    if (!release || !isVersionNewer(release.version, appVersion())) {
      downloadUrl = null
      setState('up-to-date', { latest: null, percent: 0, error: null })
    } else {
      downloadUrl = release.url
      setState('available', { latest: release.version, percent: 0, error: null })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (manual) setState('idle', { error: t('检查更新失败：{reason}', { reason: message }) })
    else {
      console.warn('[app-update] 静默检查失败：', message)
      setState('idle', { error: null })
    }
  }
  return snapshot()
}

async function download(): Promise<AppUpdateStatus> {
  if (state !== 'available' || !downloadUrl) return snapshot()
  attachPluginEvents()
  canceled = false
  setState('downloading', { percent: 0, error: null })
  try {
    await FizzUpdater.download({ url: downloadUrl })
  } catch (err) {
    console.warn('[app-update] 下载任务创建失败：', err)
    setState('available', { percent: 0, error: t('下载失败，请重试。') })
  }
  return snapshot()
}

async function cancel(): Promise<AppUpdateStatus> {
  if (state !== 'downloading') return snapshot()
  canceled = true
  setState('available', { percent: 0, error: null })
  try {
    await FizzUpdater.cancel()
  } catch (err) {
    console.warn('[app-update] 取消下载失败：', err)
  }
  return snapshot()
}

async function install(): Promise<boolean> {
  if (!isNativeShell() || state !== 'downloaded') return false
  try {
    const { allowed } = await FizzUpdater.canInstall()
    if (!allowed) {
      setState('downloaded', { error: t('请先在系统设置里允许安装未知应用，再回来点安装。') })
      await FizzUpdater.openInstallPermissionSettings().catch(() => undefined)
      return false
    }
    setState('downloaded', { error: null })
    await FizzUpdater.install()
    return true
  } catch (err) {
    console.warn('[app-update] 调起安装器失败：', err)
    setState('downloaded', { error: installFailureText(err) })
    return false
  }
}

/** 给 `AgentHost.appUpdate` 用（只在原生壳里挂，见 `apps/mobile/src/host.ts`） */
export const mobileAppUpdate: AppUpdateBridge = {
  status: async () => snapshot(),
  check: () => check(true),
  download,
  cancel,
  install,
  onStatus: (cb) => {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  }
}

let scheduled = false

/**
 * 启动静默检查（在 `ClientRoot` 里挂一次）：首查延迟 8s，之后每 6h 查一次；
 * 手机长期在后台时定时器会被节流，回到前台且距上次检查超过 6h 再补一次。
 *
 * 模块级 `scheduled` 挡重复：StrictMode 下 effect 会挂两次，别让定时器翻倍。
 */
export function scheduleSilentAppUpdateCheck(): void {
  if (scheduled || !isNativeShell()) return
  scheduled = true
  setTimeout(() => {
    void check(false)
  }, SILENT_CHECK_DELAY)
  setInterval(() => {
    if (document.visibilityState === 'visible') void check(false)
  }, SILENT_CHECK_INTERVAL)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastCheckAt < SILENT_CHECK_INTERVAL) return
    void check(false)
  })
}