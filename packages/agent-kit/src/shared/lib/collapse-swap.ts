/**
 * 折叠面板「该渲染哪一份内容」的规则（**纯函数**，jiti 可直跑，零依赖）。
 *
 * ## 解决的观感问题
 *
 * 工具卡（`PartView` 的 ToolCallCard）收起时，`ToolContent`（ai-elements）带
 * `data-closed:animate-out slide-out-to-top-2`，有 ~150ms 的滑动淡出。如果正好
 * 在这一帧内容也换了（工具刚跑完：入参预览 → 结果 / diff；或用户点收起的同一刻收到结果），
 * 那 150ms 里屏幕上渲染的就是**新内容** —— 用户看到「内容先变成 diff，然后才折叠」，
 * 中间闪一下（用户报的）。
 *
 * ## 规则
 *
 * - **开着**：永远渲染最新的（用户要看实时内容）；
 * - **关着 / 正在关**：渲染「**上次开着时**」留存的那份快照。
 *
 * 关着的时候内容会被 Radix 卸掉（`CollapsibleContent` 没有 forceMount），所以快照旧一
 * 点**看不见**；等用户再点开，走的是「开着」这条，拿到的又是最新的。
 * 于是折叠动画里放着的是旧内容，观感变成「先折叠、再换状态」。
 *
 * ⚠️ 这能成立的前提是 **`open` 与内容同帧翻转**：调用方在 `onOpenChange` 里同步
 * `setOpen`（同一事件、同一 commit），不能拖到 `useEffect` 或下一轮 —— 那会多出一帧
 * 「还开着 + 已是新内容」，快照就被污染了。
 */

/**
 * 折叠动画期间该渲染的内容。
 *
 * @param open 当前是否展开
 * @param body 最新的内容（children）
 * @param openSnapshot 「上次展开时」留存的内容
 */
export function collapsedBody<T>(open: boolean, body: T, openSnapshot: T): T {
  return open ? body : openSnapshot
}

/**
 * 快照该不该跟着新内容更新：**只有展开时才更新**。
 *
 * 关着时也更新它，就等于把这个规则作废了（折叠那一瞬间渲染的会是新内容）。
 * 单独拎出来是为了让调用方那行 `if` 有名字、也让单测能单独钉这一条。
 */
export function shouldRefreshSnapshot(open: boolean): boolean {
  return open
}
