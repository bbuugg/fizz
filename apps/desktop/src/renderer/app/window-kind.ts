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
  | { kind: 'conversation'; conversationId?: string }

export function resolveWindowKind(search: string): WindowKind {
  const params = new URLSearchParams(search)
  if (params.get('window') === 'conversation') {
    const id = params.get('conversationId')
    /**
     * 正常路径**一定**带 id（入口在会话详情区，「在浮窗中打开」把 id 递进来；换会话时
     * 主进程也会带新 id 重载）。没有 id 的形态照旧渲染窗口，交给 `ConversationWindow`
     * 给一句「没有指定会话」的空态 —— 那里只是兜底，别在这里抛错把窗口开成白屏。
     */
    return id ? { kind: 'conversation', conversationId: id } : { kind: 'conversation' }
  }
  return { kind: 'main' }
}
