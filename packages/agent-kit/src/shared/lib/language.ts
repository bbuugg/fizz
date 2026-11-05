/**
 * 渲染端的语言：在 `@fizz/i18n` 的进程级语言状态之上，补两件宿主相关的事。
 *
 * - **持久化**：首帧前从 localStorage 读回上次选择（服务端设置还没拉到时界面不会闪回中文）；
 * - **React 订阅**：`useLanguage()` 走 `useSyncExternalStore`，切语言后所有用到 `useT()`
 *   的组件一起重渲染。
 *
 * 服务端那份是**权威值**（工具 / 提示词要用），连接后 `refresh()` 会把它同步回来并覆盖
 * localStorage（见 store 的 `server-lists`）。
 */
import { useSyncExternalStore } from 'react'
import {
  detectLanguageFromLocale,
  getLanguage,
  setLanguage,
  subscribeLanguage,
  t,
  type AppLanguage
} from '@fizz/i18n'
import { readPref, subscribePrefs, writePref } from '@fizz/agent-kit/shared/lib/prefs-sync'

const STORAGE_KEY = 'fizz.language'

export function readStoredLanguage(): AppLanguage | null {
  const value = readPref(STORAGE_KEY)
  return value === 'en' || value === 'zh' ? value : null
}

/**
 * 首帧前调用：把 localStorage 里的语言灌进 i18n 单例。
 *
 * 本机还没选过语言时跟随浏览器 / 系统 locale —— 中文环境 zh，其它 en，与
 * 服务端 `detectDefaultLanguage` 同一口径；服务端连上后仍会以落盘的值为准。
 */
export function bootstrapLanguage(): void {
  const stored = readStoredLanguage()
  if (stored) {
    setLanguage(stored)
    return
  }
  const locale = typeof navigator === 'undefined' ? undefined : navigator.languages?.[0] ?? navigator.language
  setLanguage(detectLanguageFromLocale(locale))
}

/** 记住选择（服务端保存成功后调用；失败也先让本机界面切过去） */
export function persistLanguage(language: AppLanguage): void {
  // 写盘即广播：别的窗口（desktop 的设置窗口）会收到 storage 事件，见 prefs-sync
  writePref(STORAGE_KEY, language)
}

/**
 * 订阅「**别的窗口**改了界面语言」。
 *
 * 与其余本地偏好同一套：desktop 的设置页是独立窗口，在那边切完语言只写了 localStorage，
 * 不订阅的话主窗口界面仍是旧语言（同上一个「必须重启」家族，见 `prefs-sync`）。
 * 服务端那份是权威值，`refresh()` 仍会对账覆盖。
 */
export function watchStoredLanguage(onChange: (language: AppLanguage) => void): () => void {
  return subscribePrefs(STORAGE_KEY, () => {
    const stored = readStoredLanguage()
    if (stored) onChange(stored)
  })
}

/** 当前语言（订阅变化） */
export function useLanguage(): AppLanguage {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage)
}

/**
 * 取当前语言的翻译函数（key = 中文原文）。
 *
 * 返回的函数依赖 `language`，所以只要组件用了 `useT()`，切语言就会重渲染。
 */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  useLanguage()
  return t
}
