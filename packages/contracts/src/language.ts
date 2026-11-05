/**
 * 界面语言：前后端共用的纯契约（渲染端设置页 + 服务端工具 / 提示词都读它）。
 *
 * 与 `browser.ts` / `system-monitor.ts` 同款约束：**不牵任何 Node 代码**。
 *
 * 全局一份（落 `CoreData.language`）：语言是一个安装级偏好，不是按会话 / 按项目。
 * 服务端在构建工具描述与系统提示词时读取它，渲染端据此选择字典。
 */
export type AppLanguage = 'zh' | 'en'

/** 默认中文 —— 产品原有的界面语言 */
export const DEFAULT_LANGUAGE: AppLanguage = 'zh'

/** 可选项（设置页的语言切换直接用；顺序 = 展示顺序） */
export const APP_LANGUAGES: ReadonlyArray<{ value: AppLanguage; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' }
]

/** 收敛：手改坏的数据文件 / 老版本缺字段都不该让读接口抛错 */
export function normalizeLanguage(value: unknown): AppLanguage {
  return value === 'en' ? 'en' : DEFAULT_LANGUAGE
}

/**
 * 按系统 / 浏览器 locale 推断首次运行的界面语言。
 *
 * AppImage 目录要求「中文环境之外默认英文」：只有 locale 以 `zh` 开头（`zh-CN` /
 * `zh_TW` / `zh-Hans` …）才用中文，其余一律英文；空值回落 `DEFAULT_LANGUAGE`，
 * 避免连系统 locale 都拿不到的环境出现空白界面。
 *
 * 纯函数：服务端用 `Intl` / `LANG`、渲染端用 `navigator.languages` 取值后再进来。
 */
export function detectLanguageFromLocale(locale: string | null | undefined): AppLanguage {
  const tag = (locale ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (!tag) return DEFAULT_LANGUAGE
  return tag.startsWith('zh') ? 'zh' : 'en'
}
