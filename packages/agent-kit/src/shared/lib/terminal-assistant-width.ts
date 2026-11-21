/**
 * 终端标签里**内嵌 AI 助手**的宽度。
 *
 * ## 为什么全局一份，不按 tab 各记（与 `lib/panel-width.ts` 相反）
 *
 * `panel-width` 按会话各记一份，是因为那边宽度与「面板开合状态」同属一个作用域
 * （`panelSessions[sessionKey]`）。内嵌助手的开合状态是 `TerminalTabView` 里的
 * 组件级 `useState`（收起即卸载，不持久化），没有这个绑定；按 tabKey 记的话，
 * localStorage 会随终端标签开开关关不断攒键，且关掉的标签那份再也读不回来。
 * 用户对「助手多宽」的预期也是一份整体的偏好：在 A 标签拖窄了，在 B 标签不该
 * 突然变回默认。
 *
 * ## 值域：`null` = 用户没拖过
 *
 * `null` 不是「宽度 0」，而是「**没记录**」→ 由 `defaultTerminalAssistantWidth`
 * 按容器宽度现场算（与 `files-pane-width.ts` 同一条理由：容器宽度是会变的 ——
 * 侧栏被拖窄、终端标签从主区挪进对话右侧的面板，都算）。
 *
 * 键名 `fizz.web.terminalAssistantWidth`（沿用 `fizz.web.*` 约定，见 AGENTS.md）。
 */
import { useSyncExternalStore } from 'react'

const KEY = 'fizz.web.terminalAssistantWidth'

/** 再窄消息就折行了：消息区与全局面板取同一个下限（app-shell 的 `min={320}`） */
export const TERMINAL_ASSISTANT_MIN_WIDTH = 320
/** 分屏时留给终端的最小宽：与 `SidePanel` 的 `MIN_CONTENT_WIDTH` 一致（只用来算分屏阈值） */
export const TERMINAL_MIN_WIDTH = 320
/**
 * 左右分屏所需的最小容器宽：助手最小可用宽 + 终端最小宽。
 *
 * 容器窄于它时**分屏本就不成立** —— 两个 320 放不下，`max()` 兜底会把助手顶到 320、
 * 把终端压到几十 px（手机上 `375px` 只给终端剩 55px）。所以低于它时 `TerminalTabView`
 * 改成**覆盖形态**：助手盖住终端，一次只看一个（与 `SidePanel` 手机端的 overlay 同约定）。
 */
export const TERMINAL_SPLIT_MIN_WIDTH = TERMINAL_ASSISTANT_MIN_WIDTH + TERMINAL_MIN_WIDTH
/** 容器宽度还没量到时的兜底（`useContainerWidth` 首帧就是 0） */
const FALLBACK_CONTAINER_WIDTH = 900

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 读内嵌助手的宽度（px）；`null` = 没拖过 */
export function getTerminalAssistantWidth(): number | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const n = Number(raw)
    /**
     * 这里**只判正数**，不判 `>= 最小宽`。
     *
     * 合法区间随容器变（窄容器下默认宽度与上限都会退让），存进去的值合不合法只有渲染那一刻
     * 说了算 —— 在这里判最小宽，窄窗里存下的宽度会被当成「非法值 → 清除记录 → 回默认宽度」，
     * 表现是**展开时面板猛地撑宽再弹回**。真正的夹取在渲染层（`TerminalTabView`）。
     */
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  } catch {
    return null
  }
}

/**
 * 记下宽度；非法值（`NaN`）当「清除记录」，回到按容器算的默认值。
 *
 * ⚠️ 下限**不在这里**卡：合法区间随容器变（理由见 `getTerminalAssistantWidth`），
 * 这里只挡 `NaN` / 非正数，夹取交给渲染层。
 */
export function setTerminalAssistantWidth(width: number): void {
  const next = Number.isFinite(width) && width > 0 ? Math.round(width) : null
  if (getTerminalAssistantWidth() === next) return
  try {
    // null = 清除记录（双击复位条走这条路）
    if (next === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(next))
  } catch {
    // 存不进去也不致命：本次会话内仍然生效（与 panel-width 一致）
  }
  notify()
}

/** 清除记录，回到按容器算的默认宽度（双击拖拽条） */
export function resetTerminalAssistantWidth(): void {
  setTerminalAssistantWidth(Number.NaN)
}

/**
 * 助手宽度的**下限**：320（消息区还能读的最小宽），但容器不够时退让到容器的一半。
 *
 * 320 是给宽容器的；窄容器下它反过来会把终端挤没 —— `375px` 的手机上助手顶到 320、
 * 终端只剩 55px。分屏本身要求 640（见 `TERMINAL_SPLIT_MIN_WIDTH`），低于它
 * `TerminalTabView` 会走覆盖形态；这里的退让是给「容器刚好卡在阈值上下」与拖拽下限
 * 留的余量：一半给助手、一半给终端，谁也别把谁挤没。
 */
export function minTerminalAssistantWidth(containerWidth: number): number {
  const w = containerWidth > 0 ? containerWidth : FALLBACK_CONTAINER_WIDTH
  return Math.min(TERMINAL_ASSISTANT_MIN_WIDTH, Math.round(w / 2))
}

/** 没拖过时的默认宽度：容器的三成出头（1200 宽 ≈ 384，即原来写死的 `w-96`） */
const DEFAULT_RATIO = 0.32
/**
 * 默认宽度的封顶 400。
 *
 * 只有比例不行：宽屏主区 1600+ 时四成就是 640+，助手比终端还宽，默认一开就喧宾夺主
 * （用户报过「终端里的助手默认太宽」）。窄容器一侧由 `minTerminalAssistantWidth` 退让，
 * 宽容器一侧由这里封顶。
 */
const DEFAULT_MAX_WIDTH = 400

/**
 * 没拖过时给多宽：容器宽度的 32%，并夹在 [下限, min(上限, 400)] 之间。
 *
 * 原来的 `w-96 max-w-[45%]` 断的是死值 384 —— 终端标签被塞进对话右侧窄面板
 * （380~600px 常见）时，384 会把终端挤到只剩几十 px。所以默认值必须跟着容器走，
 * 但仍要封顶：纯比例在宽屏上会一路涨到 600+。
 */
export function defaultTerminalAssistantWidth(containerWidth: number): number {
  if (containerWidth <= 0) return TERMINAL_ASSISTANT_MIN_WIDTH
  const cap = Math.min(maxTerminalAssistantWidth(containerWidth), DEFAULT_MAX_WIDTH)
  return Math.max(
    minTerminalAssistantWidth(containerWidth),
    Math.min(Math.round(containerWidth * DEFAULT_RATIO), cap)
  )
}

/**
 * 拖拽上限：**容器的一半**。
 *
 * 助手是「陪着看终端」的角色，最多和终端平分，再宽就把输出挤没了。原来按
 * 「容器 − 终端最小宽（320）」算，1200 宽时能拖到 880（73%）、终端只剩一条；
 * 现在硬性对半，另一半永远留给终端。
 *
 * 封顶不能低于下限：窄容器下下限会退让到容器的一半（见 `minTerminalAssistantWidth`），
 * 上限若掉到它下面，可拖区间就倒挂了（拖起来像完全没反应）。
 */
export function maxTerminalAssistantWidth(containerWidth: number): number {
  const w = containerWidth > 0 ? containerWidth : FALLBACK_CONTAINER_WIDTH
  return Math.max(minTerminalAssistantWidth(w), Math.round(w / 2))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 组件版：内嵌助手宽度（`null` = 没拖过，按容器算默认） */
export function useTerminalAssistantWidth(): number | null {
  return useSyncExternalStore(subscribe, getTerminalAssistantWidth, () => null)
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === KEY) notify()
  })
}
