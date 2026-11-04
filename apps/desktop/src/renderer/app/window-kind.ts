/**
 * 从 `location.search` 判定当前渲染端要画哪个窗口。
 * `?window=` 是主进程用 `loadRenderer` 传的查询参数，**不是路由**。
 *
 * 只剩两种：主窗口 / 会话浮窗。`?window=settings` 随「设置并入主区域标签」一起删除 ——
 * 它存在的唯一理由是「再开一个 BrowserWindow」，而那正是两个渲染进程 = 两份 store 单例
 * 的来源（设置里改完主窗口不知道）。别再把它加回来。
 */
export type WindowKind =
  | { kind: 'main' }
  | { kind: 'conversation'; initialConversationId?: string }

export function resolveWindowKind(search: string): WindowKind {
  const params = new URLSearchParams(search)
  if (params.get('window') === 'conversation') {
    const id = params.get('conversationId')
    // id 只是「首次打开显示哪条会话」的种子；没有它也照样渲染浮窗（落草稿 / 当前项目）
    return id ? { kind: 'conversation', initialConversationId: id } : { kind: 'conversation' }
  }
  return { kind: 'main' }
}
