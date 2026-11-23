/**
 * 安卓壳的更新来源：GitHub Release（与桌面包同一个 Release / tag）。
 *
 * 只认名为 `Fizz-<version>-android.apk` 的资产（CI 就是这么改名的，见
 * `.github/workflows/build.yml` 的 Rename APK 一步）—— 同一 Release 里还挂着桌面端的
 * `latest.yml` / exe / dmg，不按文件名筛会拿到装不上的东西。
 *
 * 纯函数单独放一份是为了能在 node 环境里测（仓库没有 jsdom / 不起网络）。
 */

const RELEASE_API = 'https://api.github.com/repos/bbuugg/fizz/releases/latest'
const ANDROID_ASSET = /^Fizz-(.+)-android\.apk$/i
/** 查询超时：GitHub 在部分网络下会一直挂着不回，不能让「检查更新」永远转圈 */
const FETCH_TIMEOUT_MS = 15_000

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

/** 查最新 Release；网络 / 限流 / 无 APK 资产都返回 null（调用方决定要不要报错） */
export async function fetchLatestAndroidRelease(signal?: AbortSignal): Promise<AndroidRelease | null> {
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
    return parseAndroidRelease(await response.json())
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}