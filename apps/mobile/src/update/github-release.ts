/**
 * 安卓壳的更新来源：GitHub Release（与桌面包同一个 Release / tag）。
 *
 * 只认名为 `Fizz-<version>-android.apk` 的资产（CI 就是这么改名的，见
 * `.github/workflows/build.yml` 的 Rename APK 一步）—— 同一 Release 里还挂着桌面端的
 * `latest.yml` / exe / dmg，不按文件名筛会拿到装不上的东西。
 *
 * 查询有两条路：先打 GitHub API（拿到完整资产清单）；**403**（匿名限流 / 网络拦截）时
 * 退回发布页的 302（走原生 HTTP，不消耗 API 配额），见 `fetchLatestFromReleasePage`。
 *
 * 纯函数单独放一份是为了能在 node 环境里测（仓库没有 jsdom / 不起网络）。
 */

const REPO = 'bbuugg/fizz'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
/**
 * 发布页（不消耗 GitHub API 配额）。`/releases/latest` 会 302 到
 * `/releases/tag/<tag>`，兜底查询就靠这个 Location。
 */
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`
/** APK 的下载前缀：资产名由 CI 固定成 `Fizz-<版本>-android.apk`（见 build.yml 的 Rename APK） */
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`
const ANDROID_ASSET = /^Fizz-(.+)-android\.apk$/i
/** 查询超时：GitHub 在部分网络下会一直挂着不回，不能让「检查更新」永远转圈 */
const FETCH_TIMEOUT_MS = 15_000
/** 原生兜底请求的超时（302 很快回来，不需要 15s） */
const NATIVE_TIMEOUT_MS = 10_000

export interface AndroidRelease {
  version: string
  url: string
}

/** 去掉 `v` 前缀与预发布后缀，只留数字段（`v1.2.3` → `1.2.3`） */
export function normalizeVersion(value: string): string {
  return (value.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? '').trim()
}

function versionParts(value: string): number[] | null {
  const core = normalizeVersion(value)
  if (!/^\d+(?:\.\d+)*$/.test(core)) return null
  return core.split('.').map(Number)
}

/**
 * `latest` 是否比 `current` 新。任一边解析不出数字（如空串、`dev`）都返回 false ——
 * 宁可漏一次提示，也不要在版本号缺失时永远弹「有新版本」。
 */
export function isVersionNewer(latest: string, current: string): boolean {
  const a = versionParts(latest)
  const b = versionParts(current)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** 从 GitHub 的 release JSON 里挑出安卓 APK；找不到返回 null（视为没有可用更新） */
export function parseAndroidRelease(json: unknown): AndroidRelease | null {
  if (!json || typeof json !== 'object') return null
  const assets = (json as { assets?: unknown }).assets
  if (!Array.isArray(assets)) return null
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue
    const { name, browser_download_url: url } = asset as {
      name?: unknown
      browser_download_url?: unknown
    }
    if (typeof name !== 'string' || typeof url !== 'string' || !url) continue
    const version = ANDROID_ASSET.exec(name)?.[1]
    if (version) return { version: normalizeVersion(version), url }
  }
  return null
}

/**
 * 从一个 `/releases/tag/<tag>` 的地址里取 tag；不是这个形状返回 null。
 *
 * 兜底查询拿到的 Location（或最终 URL）就长这样，e.g.
 * `https://github.com/bbuugg/fizz/releases/tag/v0.0.36`。
 */
export function parseReleaseTagUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const match = /\/releases\/tag\/([^/?#]+)\/?$/.exec(parsed.pathname)
    const tag = match ? decodeURIComponent(match[1] ?? '') : ''
    return tag || null
  } catch {
    return null
  }
}

/**
 * 由 tag 拼出安卓 APK 的下载地址。
 *
 * 这是与 CI 的**命名契约**：`Rename APK` 那一步把 `app-release.apk` 改成
 * `Fizz-<apps/mobile 的 version>-android.apk`，而发版脚本会把 tag 与各
 * `package.json` 的 version 一起对齐（`npm run version:set -- vX.Y.Z`），
 * 所以 `v0.0.36` → `Fizz-0.0.36-android.apk`。tag 不成形（不是 `x.y.z[-预发布]`）时返回 null。
 */
export function androidAssetUrl(tag: string): string | null {
  // 资产名用的是 **package.json 的 version**（含预发布后缀），不是 tag 的归一化结果
  const version = tag.trim().replace(/^v/i, '')
  if (!/^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null
  return `${DOWNLOAD_BASE}/${encodeURIComponent(tag)}/Fizz-${version}-android.apk`
}

/** 原生壳判定（与 `shared/lib/native-notify.ts` 的 `isNativeShell` 同一口径，避免为此引入整包） */
function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false
  const bridge = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return typeof bridge?.isNativePlatform === 'function' && bridge.isNativePlatform() === true
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null
  const hit = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
  return hit ? (headers[hit] ?? null) : null
}

/**
 * 兜底：读发布页的 302，从 `Location` 里拿最新 tag，再按命名契约拼 APK 地址。
 *
 * 为什么需要它：`api.github.com` 对匿名请求是 **60 次/小时/IP** 限流，手机走运营商
 * NAT 时一个出口被很多设备共享，403 是常态（用户实测「检查更新失败：HTTP 403」）；
 * 也有网络直接把 api.github.com 拦掉、只放行 github.com 的。发布页本身不限流，但跨域
 * `fetch` 读不到它的 302（github.com 不带 CORS 头），所以这条只能走**原生 HTTP**
 * （CapacitorHttp 绕开 CORS，`disableRedirects` 后直接读 Location）。
 *
 * 返回 `null` = 环境不支持（浏览器 / hosted）或页面形状不认识，由调用方抛 API 的原始错误；
 * 返回 `{ release: null }` = 页面认出来了但**没有可用的 APK 资产**（安卓 job 失败的那种
 * Release），应当按「没有更新」处理，而不是把 API 的 403 甩给用户。
 */
async function fetchLatestFromReleasePage(): Promise<{ release: AndroidRelease | null } | null> {
  if (!isNativeShell()) return null
  const { CapacitorHttp } = await import('@capacitor/core')
  const response = await CapacitorHttp.get({
    url: RELEASE_PAGE,
    headers: { Accept: 'text/html', 'User-Agent': 'Fizz-Android-Updater' },
    disableRedirects: true,
    connectTimeout: NATIVE_TIMEOUT_MS,
    readTimeout: NATIVE_TIMEOUT_MS
  })
  if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
  const target = headerOf(response.headers, 'location') ?? response.url
  const tag = target ? parseReleaseTagUrl(target) : null
  const url = tag ? androidAssetUrl(tag) : null
  if (!tag || !url) return null
  /*
   * 发布页拿不到资产清单，只能探一下这个 APK 在不在：CI 的安卓 job 失败时 Release
   * 仍然存在（只有桌面资产），直接报「有新版本」会让用户下到 404。
   * `disableRedirects` 下 302 = 资产存在（真身重定向到 objects.githubusercontent.com）。
   * 探测本身失败（网络抖动）不挡更新 —— 下载那步失败了会给明确提示。
   */
  const exists = await CapacitorHttp.request({
    method: 'HEAD',
    url,
    disableRedirects: true,
    connectTimeout: NATIVE_TIMEOUT_MS,
    readTimeout: NATIVE_TIMEOUT_MS
  })
    .then((res) => res.status !== 404)
    .catch(() => true)
  return { release: exists ? { version: normalizeVersion(tag), url } : null }
}

/** 查最新 Release：先打 API；失败（限流 / 被网络拦截 / CORS）再走发布页兜底 */
export async function fetchLatestAndroidRelease(signal?: AbortSignal): Promise<AndroidRelease | null> {
  let apiError: unknown = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const forward = () => controller.abort()
    signal?.addEventListener('abort', forward, { once: true })
    try {
      const response = await fetch(RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      /*
       * 这里**不再兜底**：API 成功但没有 APK 资产 = 这次 Release 没打安卓包，
       * 应该如实报「没有更新」，拿 tag 硬拼只会让用户下到一个 404。
       */
      return parseAndroidRelease(await response.json())
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  } catch (err) {
    apiError = err
  }
  try {
    const fallback = await fetchLatestFromReleasePage()
    if (fallback) return fallback.release
  } catch {
    // 兜底也失败：把 API 那个错抛回去（403 会被界面换成一句人话）
  }
  throw apiError instanceof Error ? apiError : new Error(String(apiError ?? 'unknown'))
}