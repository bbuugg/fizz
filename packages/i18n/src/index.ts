/**
 * Fizz 国际化内核：语言状态 + 中英文文案。
 *
 * 设计取舍：
 * - **中文是源文案**，也是默认语言；英文走 `EN` 字典（key 就是中文原文）；
 * - 未翻译的条目自动回落到中文，新增界面文案不会因为漏翻而变成空白；
 * - 零 React / 零 Node 依赖：服务端工具描述与前端组件共用同一份 `t()`；
 * - 需要「中英成对」的静态长文案（工具描述 / 系统提示词）用 `tr(zh, en)`，不必进字典。
 *
 * 语言是**进程级 / 页面级单例**：设置页改完立刻 `setLanguage`，订阅者重渲染；
 * 服务端在构建工具 / 提示词前从 `CoreData` 同步一次（见 `apps/server` 的启动段）。
 */
import { DEFAULT_LANGUAGE, normalizeLanguage, type AppLanguage } from '@fizz/contracts'
import { EN } from './en'

export type { AppLanguage } from '@fizz/contracts'
export {
  DEFAULT_LANGUAGE,
  APP_LANGUAGES,
  normalizeLanguage,
  detectLanguageFromLocale
} from '@fizz/contracts'

let current: AppLanguage = DEFAULT_LANGUAGE
const listeners = new Set<() => void>()

export function getLanguage(): AppLanguage {
  return current
}

export function setLanguage(next: AppLanguage): void {
  const normalized = normalizeLanguage(next)
  if (normalized === current) return
  current = normalized
  for (const listener of listeners) listener()
}

/** 订阅语言变化；返回退订函数（React 的 useSyncExternalStore 直接用这个） */
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match
  )
}

/**
 * 取当前语言的文案：`key` 是中文原文。
 *
 * 英文词典里没有的 key 原样回落到中文 —— 允许分批翻译，先上基础设施。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const text = current === 'en' ? EN[key] ?? key : key
  return interpolate(text, vars)
}

/**
 * 中英成对文案：给工具描述 / 系统提示词这种「长、且只在服务端用」的字符串。
 * 比把它们塞进字典更好读，也不会让字典变成第二份源码。
 */
export function tr(zh: string, en: string): string {
  return current === 'en' ? en : zh
}
