/**
 * 这条测试在防什么回归：
 *
 * 安卓更新只认 CI 产出的 `Fizz-<version>-android.apk`（同一个 Release 里还挂着桌面端
 * 的 `latest.yml` / exe / dmg）。按「第一个资产」或按 tag 猜版本都会拿到装不上的包；
 * 版本比较若把空串 / 非数字当成 0，则「当前版本拿不到」时会永远提示有更新。
 */
import { describe, expect, it } from 'vitest'
import { isVersionNewer, normalizeVersion, parseAndroidRelease } from './github-release'

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