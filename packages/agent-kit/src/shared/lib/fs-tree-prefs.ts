/**
 * 文件树的「显示被忽略的文件」开关。
 *
 * 工作区文件树默认**不列**命中忽略规则的条目：一套内置黑名单（`DEFAULT_IGNORE_DIRS`：
 * `node_modules` / `.git` / `dist` / `vendor` / `.env` 之类）+ 工作区自己的 `.gitignore`，
 * 而且是**任意层级**命中即整棵子树跳过。这套规则本来是给 Agent 的 `glob` /
 * `grep` 用的（别把依赖目录翻成上下文），但人翻文件时经常就是要去 `.env`、
 * `vendor`、`dist` 里看一眼 —— 从前界面上没有任何办法，用户只能得出「我文件不见了」。
 *
 * 所以给文件树一个开关：打开后连被忽略的条目一起列（由界面压暗 + 标注），
 * **Agent 那边的工具不受影响**（它的上下文该干净还是干净）。
 *
 * 默认关：`node_modules` 动辄上万条，默认摊开既慢又吵，而且会顶到服务端的单目录
 * 上限（`truncated`）。
 *
 * 全局一份（不按工作区）：这是「我要不要看见被忽略的东西」的浏览习惯，不是某个项目的状态。
 * 与 `lib/editor-view-prefs.ts` 同一套 `useSyncExternalStore` 写法。
 */
import { useSyncExternalStore } from 'react'
import { writePref } from '@fizz/agent-kit/shared/lib/prefs-sync'

const SHOW_IGNORED_KEY = 'fizz.web.fsShowIgnored'

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 是否列出被忽略的条目；没存过 = 关（保持原有观感） */
export function getShowIgnored(): boolean {
  try {
    return localStorage.getItem(SHOW_IGNORED_KEY) === '1'
  } catch {
    return false
  }
}

export function setShowIgnored(value: boolean): void {
  // 写盘即广播 + 同步到服务端（见 prefs-sync）
  writePref(SHOW_IGNORED_KEY, value ? '1' : '0')
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// 服务端快照 = 默认值，与客户端首帧一致，不会 hydration 打架
export function useShowIgnored(): boolean {
  return useSyncExternalStore(subscribe, getShowIgnored, () => false)
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === SHOW_IGNORED_KEY) notify()
  })
}
