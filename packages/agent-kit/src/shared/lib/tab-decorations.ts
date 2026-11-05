/**
 * 标签装饰登记表：**外部**给标签条上的图标加东西的唯一入口。
 *
 * ## 为什么需要它
 *
 * 标签图标本来是 `useTabMeta()` 里一条 if 链按 key 前缀硬编码的（`host:` → 服务器、
 * `local:` → 终端、兜底 → 对话气泡），外部没法掺和。但「这个标签现在是什么状态」只有
 * 标签的内容方知道（终端活着没有、会话在跑还是在等你点头），所以需要一个**按 tabKey
 * 写入、由标签条统一读取**的旁路。
 *
 * 与 `tool-tabs.ts` 同一套机制：内存里的 Map + 自增版本号。表被就地改了而 `panel-store`
 * 没有任何变化（`openTab` 对已存在的 key 不 emit），不靠版本号订阅，标签条会一直停在
 * 旧图标上（与 `retargetNoteTab` 完全同一个坑）。
 *
 * ## 与内建状态的分工
 *
 * - **内建**：会话的「在跑 / 等你确认」由 `conversation-activity.ts` 派生，终端的
 *   「连接中 / 就绪 / 已退出」由 `terminal-registry.ts` 的 `setTerminalPhase` 推上来 ——
 *   这两份都在 `useTabMeta` 里直接合成，外部**不用传任何东西**；
 * - **外部**：只覆盖「内建算不出来的」那部分（比如某个插件面板自己的忙碌态）。
 *   写进这里的东西**优先级最高**（盖在内建之上）。
 *
 * ## 谁负责清理
 *
 * 表按 tabKey 存，**没有**在标签关闭时自动回收（这个模块不知道面板布局）。写入方在
 * 自己的组件卸载 / 标签关闭时调 `clearTabDecoration(key)`；忘了清只会留下一条没人读的
 * 死条目（标签条按当下的 tabIds 取，不会串到别的标签上），但会慢慢涨。
 */
import type { ReactNode } from 'react'

/**
 * 状态点的语义色。**只有这四个**，颜色由标签条统一给：
 * - `busy` 主色（正在跑）
 * - `waiting` 琥珀（在等人 / 还在连）
 * - `ok` 绿色（活着 / 就绪）
 * - `error` 红色（已退出 / 出错）
 */
export type TabStatusTone = 'busy' | 'waiting' | 'ok' | 'error'

/** 图标右上角的状态点 */
export interface TabStatus {
  tone: TabStatusTone
  /** 悬停提示 / 无障碍名（如「终端已退出」）；不传就只有颜色 */
  label?: string
}

/** 外部能往一颗标签上叠的东西 */
export interface TabDecoration {
  /** 覆盖类型图标；不传 = 保留标签条自己算的那个 */
  icon?: ReactNode
  /** 盖在内建状态之上的状态点；不传 = 保留内建算出来的那个 */
  status?: TabStatus
}

const decorations = new Map<string, TabDecoration>()
let version = 0
const listeners = new Set<() => void>()

function changed(): void {
  version += 1
  for (const listener of listeners) listener()
}

function sameStatus(a: TabStatus | undefined, b: TabStatus | undefined): boolean {
  if (!a || !b) return a === b
  return a.tone === b.tone && a.label === b.label
}

/**
 * 写入（或就地更新）一颗标签的装饰。
 *
 * 内容没变就**不通知订阅者**：调用方常在 effect / 每次渲染里写，无脑 bump 会让整条
 * 标签条跟着每帧重渲染（流式输出期间就是灾难）。
 */
export function setTabDecoration(tabKey: string, decoration: TabDecoration): void {
  const prev = decorations.get(tabKey)
  if (prev && prev.icon === decoration.icon && sameStatus(prev.status, decoration.status)) return
  decorations.set(tabKey, decoration)
  changed()
}

/** 清掉一颗标签的装饰（标签关闭 / 外部状态复位时调） */
export function clearTabDecoration(tabKey: string): void {
  if (!decorations.delete(tabKey)) return
  changed()
}

export function getTabDecoration(tabKey: string): TabDecoration | undefined {
  return decorations.get(tabKey)
}

/** 订阅版本变化（`useSyncExternalStore` 的 subscribe） */
export function subscribeTabDecorations(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 登记表版本（`useSyncExternalStore` 的 getSnapshot；没订阅时也得是稳定值） */
export function getTabDecorationsVersion(): number {
  return version
}
