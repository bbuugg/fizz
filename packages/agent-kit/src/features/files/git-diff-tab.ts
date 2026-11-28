/**
 * Git diff 标签**后台刷新**的两条判据（纯函数，零 React）。
 *
 * 背景：面板每 5 秒（`GitPanel` 的 `RUNNING_POLL_MS`）会把打开的 diff 全部重拉一次。
 * 以前每次都先置 `loading`，右侧于是每几秒换成「读取 diff…」占位再换回来 ——
 * 整块 diff 被卸载重挂，看着就是闪一下、滚动位置也回顶。
 *
 * 防的回归：
 * 1. 已有内容（`hunks !== null`）的刷新**绝不能再显示占位**；
 * 2. 原文与删除态都没变的刷新**一个字段都不动** —— `setDiffTabs` 换个新数组同样会把
 *    几千行 diff 重渲染一遍，滚动位置与选中的文字也跟着遭殃。
 */
export interface DiffTabRefreshView {
  hunks: readonly unknown[] | null
  diffText: string | null
  deleted: boolean
  loading: boolean
  error: string | null
}

/** 该不该显示「读取 diff…」占位：只有还没拿到过内容（首次打开）才显示 */
export function showsDiffPlaceholder(tab: DiffTabRefreshView | undefined): boolean {
  return !tab || tab.hunks === null
}

/** 这次刷新是不是无事可做（原文 / 删除态都没变，且当前没有加载中 / 报错态要清） */
export function diffRefreshIsNoop(
  tab: DiffTabRefreshView,
  nextText: string,
  nextDeleted: boolean
): boolean {
  return tab.diffText === nextText && tab.deleted === nextDeleted && !tab.loading && tab.error === null
}
