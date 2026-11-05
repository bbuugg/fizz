/**
 * 首次运行的语言推断：
 * 防的是「非中文环境首次打开仍是中文」—— AppImage 目录要求中文之外默认英文。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LANGUAGE, detectLanguageFromLocale } from './language'

describe('detectLanguageFromLocale', () => {
  it('中文 locale（含地区 / 脚本 / 下划线写法）都落到 zh', () => {
    for (const locale of ['zh', 'zh-CN', 'zh_TW', 'zh-Hans', 'zh-Hant-HK']) {
      expect(detectLanguageFromLocale(locale)).toBe('zh')
    }
  })

  it('其它语言一律回落 en', () => {
    for (const locale of ['en-US', 'de-DE', 'ja-JP', 'fr', 'pt_BR']) {
      expect(detectLanguageFromLocale(locale)).toBe('en')
    }
  })

  it('拿不到 locale 时回 DEFAULT_LANGUAGE，避免空白界面', () => {
    expect(detectLanguageFromLocale(undefined)).toBe(DEFAULT_LANGUAGE)
    expect(detectLanguageFromLocale(null)).toBe(DEFAULT_LANGUAGE)
    expect(detectLanguageFromLocale('  ')).toBe(DEFAULT_LANGUAGE)
  })

  it('大小写不敏感', () => {
    expect(detectLanguageFromLocale('ZH-cn')).toBe('zh')
    expect(detectLanguageFromLocale('EN-us')).toBe('en')
  })
})
