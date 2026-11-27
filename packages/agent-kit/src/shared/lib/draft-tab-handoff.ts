/**
 * 「新对话」页发出第一条消息建出的会话 → 它属于**发出消息的那颗草稿标签**。
 *
 * ## 这个记号回答的是什么
 *
 * 「这条会话是从草稿页发出来的」。标签层（`PanelView` 的同步 effect）在「当前会话变成 X」
 * 时要决定：给 X 新开一颗标签，还是让已有的草稿标签**指向** X
 * （`panel-store` 的 `alignConversationTab`）。判据**不能**是「草稿此刻是不是焦点标签」：
 * 建会话是异步的（ACP 要起外部 agent 进程 + `session/new`，内置模型也要一个往返），
 * 等得不耐烦的用户切去看别的标签是常事 —— 回来时焦点早就不在草稿上，按焦点判就会
 * 「草稿留着 + 旁边又多出一条同会话的标签」（用户报的「发个消息怎么又开了一个标签页」）。
 *
 * 会话是不是从草稿页发出来的，只有**建它的那一刻**知道。所以由 `runRound`
 * （`scope` 为空 = 新对话页）在这里打一枚一次性记号，`PanelView` 消费它 —— 谁建的、谁记，
 * 不靠事后猜。
 *
 * ## 它只是「来源」，不是「交接」
 *
 * 标签 key 是终生不变的身份：草稿标签变成会话标签，改的只是它在 store 里的**指向**，
 * 内容实例 / 落位 / 面板现场一概不动。所以这个记号**不驱动任何迁移**，只回答「归谁」。
 *
 * 消费者是**视图层**（`PanelView` 的同步 effect）；store 只负责打标，不碰面板状态
 * （反过来的话会把「会话数据」和「标签布局」耦在一起）。
 */

/** 每条新会话对应发起创建的草稿标签；创建期间标签可能被关闭或换成另一颗草稿。 */
const pending = new Map<string, string | null>()

/**
 * 记下「这条会话是从新对话页发出来的」。
 *
 * 只由 `runRound` 在 `scope` 为空、且会话**确实建成功**之后调用。
 */
export function markDraftConversation(conversationId: string, tabKey: string | null): void {
  pending.set(conversationId, tabKey)
}

/**
 * 消费记号：`true` = 这条会话确实是刚由新对话页建出来的，草稿标签应当指向它。
 *
 * 按 id 比对，不匹配就原样保留（可能是另一条会话的变化）；匹配即清空，
 * 保证只生效一次。
 */
export function consumeDraftConversation(
  conversationId: string
): { tabKey: string | null } | null {
  const tabKey = pending.get(conversationId)
  if (tabKey === undefined) return null
  pending.delete(conversationId)
  return { tabKey }
}
