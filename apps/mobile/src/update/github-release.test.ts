/**
 * 这条测试在防什么回归：
 *
 * 安卓更新只认 CI 产出的 `Fizz-<version>-android.apk`（同一个 Release 里还挂着桌面端
 * 的 `latest.yml` / exe / dmg）。按「第一个资产」或按 tag 猜版本都会拿到装不上的包；
 * 版本比较若把空串 / 非数字当成 0，则「当前版本拿不到」时会永远提示有更新。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  androidAssetUrl,
  fetchLatestAndroidRelease,
  isVersionNewer,
  normalizeVersion,
  parseAndroidRelease,
  parseReleaseTagUrl
} from './github-release'

/**
 * 原生 HTTP 的桩：兜底那条只在 APK 里跑，node 里必须整体替掉。
 * （`vi.mock` 会被提升，动态 `import('@capacitor/core')` 拿到的也是这份。）
 */
vi.mock('@capacitor/core', () => ({
  CapacitorHttp: { get: vi.fn(), request: vi.fn() }
}))

describe('normalizeVersion', () => {
  it('去掉 v 前缀与预发布后缀', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3')
    expect(normalizeVersion('1.2.3-beta.1')).toBe('1.2.3')
    expect(normalizeVersion('  v0.0.35  ')).toBe('0.0.35')
  })
})

describe('isVersionNewer', () => {
  it('按数字段比较，补零对齐', () => {
    expect(isVersionNewer('0.0.35', '0.0.34')).toBe(true)
    expect(isVersionNewer('0.0.34', '0.0.35')).toBe(false)
    expect(isVersionNewer('0.1', '0.0.99')).toBe(true)
    expect(isVersionNewer('1.0.0', '1')).toBe(false)
    expect(isVersionNewer('1.0.1', '1.0.1')).toBe(false)
  })

  it('带 v 前缀与预发布后缀照样可比', () => {
    expect(isVersionNewer('v0.0.36', '0.0.35')).toBe(true)
    expect(isVersionNewer('0.0.36-rc.1', '0.0.35')).toBe(true)
  })

  it('版本号拿不到 / 不成形时判为「不更新」', () => {
    expect(isVersionNewer('0.0.35', '')).toBe(false)
    expect(isVersionNewer('0.0.35', 'dev')).toBe(false)
    expect(isVersionNewer('latest', '0.0.34')).toBe(false)
  })
})

describe('parseAndroidRelease', () => {
  const url = 'https://github.com/bbuugg/fizz/releases/download/v0.0.35/Fizz-0.0.35-android.apk'

  it('在桌面端资产里挑出安卓 APK', () => {
    expect(
      parseAndroidRelease({
        tag_name: 'v0.0.35',
        assets: [
          { name: 'latest.yml', browser_download_url: 'https://example.com/latest.yml' },
          { name: 'Fizz-0.0.35-android.apk', browser_download_url: url },
          { name: 'Fizz-Setup-0.0.35.exe', browser_download_url: 'https://example.com/setup.exe' }
        ]
      })
    ).toEqual({ version: '0.0.35', url })
  })

  it('没有安卓 APK 时返回 null（不能回落到 tag 让用户下错包）', () => {
    expect(
      parseAndroidRelease({
        tag_name: 'v0.0.35',
        assets: [{ name: 'latest.yml', browser_download_url: 'https://example.com/latest.yml' }]
      })
    ).toBeNull()
    expect(parseAndroidRelease({ assets: [] })).toBeNull()
  })

  it('形状不对不抛错', () => {
    expect(parseAndroidRelease(null)).toBeNull()
    expect(parseAndroidRelease({})).toBeNull()
    expect(parseAndroidRelease({ assets: [null, 1, { name: 'x.apk' }] })).toBeNull()
  })
})
/**
 * 兜底查询（API 403 时读发布页的 302）用到的两个纯函数。
 *
 * 这条测试在防：GitHub 匿名 API 限流（60 次/小时/IP，手机 NAT 出口很容易打满）时
 * 拿不到版本；兜底必须能从 `Location: .../releases/tag/v0.0.36` 里认出 tag，
 * 并按 CI 的 `Fizz-<version>-android.apk` 命名契约拼出下载地址。
 */
describe('parseReleaseTagUrl', () => {
  it('从发布页跳转地址里取 tag', () => {
    expect(parseReleaseTagUrl('https://github.com/bbuugg/fizz/releases/tag/v0.0.36')).toBe(
      'v0.0.36'
    )
    expect(parseReleaseTagUrl('https://github.com/bbuugg/fizz/releases/tag/v0.0.36/')).toBe(
      'v0.0.36'
    )
  })

  it('不是 tag 地址 / 坏地址返回 null', () => {
    expect(parseReleaseTagUrl('https://github.com/bbuugg/fizz/releases')).toBeNull()
    expect(parseReleaseTagUrl('https://github.com/bbuugg/fizz/releases/tag/')).toBeNull()
    expect(parseReleaseTagUrl('not a url')).toBeNull()
  })
})

describe('androidAssetUrl', () => {
  it('按 CI 的命名契约拼下载地址（tag 的 v 前缀不进文件名）', () => {
    expect(androidAssetUrl('v0.0.36')).toBe(
      'https://github.com/bbuugg/fizz/releases/download/v0.0.36/Fizz-0.0.36-android.apk'
    )
    expect(androidAssetUrl('1.2.3')).toBe(
      'https://github.com/bbuugg/fizz/releases/download/1.2.3/Fizz-1.2.3-android.apk'
    )
  })

  it('预发布 tag 的资产名保留后缀；不成形的 tag 不拼地址', () => {
    expect(androidAssetUrl('v0.0.36-rc.1')).toBe(
      'https://github.com/bbuugg/fizz/releases/download/v0.0.36-rc.1/Fizz-0.0.36-rc.1-android.apk'
    )
    expect(androidAssetUrl('nightly')).toBeNull()
  })
})

/**
 * 这条测试在防「检查更新失败：HTTP 403」再次变成死路：
 * `api.github.com` 对匿名请求限流（60 次/小时/IP）或被网络拦截时，必须能退回发布页
 * 的 302（原生 HTTP 读 Location），按命名契约拼出 APK 地址，而不是把 403 直接报给用户。
 */
describe('fetchLatestAndroidRelease 兜底', () => {
  beforeEach(() => {
    // node 环境没有 window：`isNativeShell()` 靠它判定
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('API 403 时读发布页 302，拼出安卓 APK 地址', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 }))
    )
    const { CapacitorHttp } = await import('@capacitor/core')
    vi.mocked(CapacitorHttp.get).mockResolvedValue({
      status: 302,
      headers: { Location: 'https://github.com/bbuugg/fizz/releases/tag/v0.0.36' },
      url: '',
      data: ''
    })
    // HEAD 探测：302 = 资产存在
    vi.mocked(CapacitorHttp.request).mockResolvedValue({ status: 302, headers: {}, url: '', data: '' })

    await expect(fetchLatestAndroidRelease()).resolves.toEqual({
      version: '0.0.36',
      url: 'https://github.com/bbuugg/fizz/releases/download/v0.0.36/Fizz-0.0.36-android.apk'
    })
  })

  it('发布页认出来了但 APK 资产不存在（安卓 job 失败）：按「没有更新」处理', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 }))
    )
    const { CapacitorHttp } = await import('@capacitor/core')
    vi.mocked(CapacitorHttp.get).mockResolvedValue({
      status: 302,
      headers: { Location: 'https://github.com/bbuugg/fizz/releases/tag/v0.0.35' },
      url: '',
      data: ''
    })
    vi.mocked(CapacitorHttp.request).mockResolvedValue({ status: 404, headers: {}, url: '', data: '' })

    await expect(fetchLatestAndroidRelease()).resolves.toBeNull()
  })

  it('API 成功时直接返回资产（不走兜底）', async () => {
    const asset = 'https://github.com/bbuugg/fizz/releases/download/v0.0.36/Fizz-0.0.36-android.apk'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            assets: [{ name: 'Fizz-0.0.36-android.apk', browser_download_url: asset }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    const { CapacitorHttp } = await import('@capacitor/core')

    await expect(fetchLatestAndroidRelease()).resolves.toEqual({ version: '0.0.36', url: asset })
    expect(CapacitorHttp.get).not.toHaveBeenCalled()
  })
})
