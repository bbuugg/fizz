/**
 * 面板组的用户手势动作（标签条 / 内容层 / 手机顶栏共用）。
 *
 * 原先它在 `PanelView.tsx` 里。手机版把标签条收掉了（**单标签**，见 `panel-store` 的
 * `setSingleTabMode`），但「顶栏读当前标签」「关掉当前标签（Ctrl / ⌘ + W）」仍是
 * 同一套语义（尤其「同步当前会话」那段必须在用户手势里做），不能各写一份，所以抽到这里。
 *
 * ## 为什么抽成 hook
 *
 * 「标签内容」与「组外壳」是**两棵子树**：内容在 `PanelContentLayer`（挂在 `PanelView`
 * 根部，为的是不换 React 父节点），外壳（标签条 / 空态 / 落区）在布局树里。两边都要
 * 「点一下把这组设为焦点 + 把当前会话切过去」，逻辑必须只有一份。
 *
 * ## ⚠️ 同步「当前会话」必须由**用户手势**直接触发
 *
 * 不能放进「观察面板状态」的 effect 里：`openTab` 写的是外部 store，effect 在同一次提交里
 * 读到的是**上一帧**的 state，于是「按旧 state 纠正会话」和「按新会话开标签」会来回打架
 * —— 实测会直接触发 React 的 `Maximum update depth exceeded`。
 *
 * ## ⚠️ 工具标签不参与
 *
 * 主机 / 本机终端跟哪个会话都没关系，点一下就把当前会话换掉的话，顶栏与侧栏会跟着高亮到
 * 一个毫不相干的会话上。「已经是它」时也直接返回：`openConversation` 会再走一遍
 * `selectWorkspace` + `loadMessages`，重复打开等于白拉一次历史。
 */
import { useCallback } from 'react'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import {
  activateTab,
  activeTabKey,
  conversationOfTab,
  getPanelState,
  requestCloseGroup,
  requestCloseTabs,
  setActiveGroup
} from '@fizz/agent-kit/shared/lib/panel-store'

/** `useGroupActions` 的返回值：组外壳（标签条 / 手机顶栏）与标签内容层共用这一份 */
export interface GroupActions {
  /** 把这组设为焦点，并把「当前会话」对齐到它的活动标签 */
  focusGroup: (groupId: string) => void
  /** 点标签：切过去，再同步「当前会话」 */
  activateAndSync: (key: string) => void
  /** 关一批标签，再把「当前会话」对齐到焦点组顺移后的活动标签 */
  closeAndSync: (keys: string[]) => void
  /** 关掉整组（组里全部标签），再把「当前会话」对齐到焦点组顺移后的活动标签 */
  closeGroupAndSync: (groupId: string) => void
  /** 重命名对话标签（工具标签的名字不给改） */
  renameTab: (key: string, title: string) => void
}

export function useGroupActions(): GroupActions {
  const { app, openConversation } = useAppContext()

  const syncConversation = useCallback(
    (key: string): void => {
      // 标签 key 不是会话 id：指向谁问 store（`undefined` = 工具标签，不参与）
      const conversationId = conversationOfTab(key)
      if (conversationId === undefined) return
      if (conversationId === null) {
        if (app.activeConversationId === null) return
        app.openConversation(null, { keepScroll: true })
        return
      }
      if (conversationId === app.activeConversationId) return
      openConversation(conversationId)
    },
    [app, openConversation]
  )

  /**
   * ⚠️ 这里读的是 `getPanelState()`（调用那一刻的现值），不是渲染时闭包里的 `group`。
   * 内容层的 pointerdown 与标签条的点击都可能发生在「上一次渲染之后」，读闭包会拿到
   * 过期的活动标签。
   */
  const focusGroup = useCallback(
    (groupId: string): void => {
      const s = getPanelState()
      if (s.activeGroupId === groupId) return
      setActiveGroup(groupId)
      const key = s.groups[groupId]?.activeTabId ?? null
      if (key) syncConversation(key)
    },
    [syncConversation]
  )

  const activateAndSync = useCallback(
    (key: string): void => {
      activateTab(key)
      syncConversation(key)
    },
    [syncConversation]
  )

  /**
   * 关标签（一个 = 关自己，多个 = 右键的批量关闭）：先过每个标签的守卫
   * （守卫可以弹确认 / 先停会话），**真关掉了**才把「当前会话」对齐到**焦点组**顺移后的
   * 活动标签（用户取消时绝不能动当前会话）。
   *
   * ⚠️ 对齐读的是 `activeTabKey()`（焦点组），不是「我们操作的那个组」：关掉本组最后一个
   * 标签时整组连同它的格子会被摘掉，焦点会落到别的组上 —— 只看本组的话读到的永远是
   * `undefined`，界面就会停在「侧栏高亮 A、面板显示 B」的错位上。
   * 整块面板被关空的情况由 `PanelView` 的兜底 effect 处理。
   */
  const closeAndSync = useCallback(
    (keys: string[]): void => {
      if (keys.length === 0) return
      void requestCloseTabs(keys).then((closed) => {
        if (!closed) return
        // store 是同步的：关完立刻读，拿到顺移后的活动标签
        const nextKey = activeTabKey()
        if (nextKey) syncConversation(nextKey)
      })
    },
    [syncConversation]
  )

  /** 重命名对话标签 = 重命名那个会话（工具标签的名字不给改，见 `PanelTabItem`） */
  const renameTab = useCallback(
    (key: string, title: string): void => {
      const conversationId = conversationOfTab(key)
      if (!conversationId) return
      void app.renameConversation(conversationId, title)
    },
    [app]
  )

  /**
   * 关掉**整组**（标签条行尾那颗 ×，以及右键菜单的「关闭整个组」）。
   *
   * 复用 `requestCloseGroup` 而不是 `requestCloseTabs(group.tabIds)`：读的是 store 里的现值，
   * 不依赖调用方渲染时的那份 `group`（标签条上的点击可能发生在「上一次渲染之后」）。
   *
   * ⚠️ 与 `closeAndSync` 同一条规矩：先过守卫、**真关掉了**才对齐，且对齐必须在 store
   * 写入**之后**读 `activeTabKey()`（焦点组）。关掉整组时焦点组自己会被摘空，读本组只会
   * 拿到 `undefined`。把最后一块面板也关空的情况由 `PanelView` 的兜底 effect 处理。
   */
  const closeGroupAndSync = useCallback(
    (groupId: string): void => {
      void requestCloseGroup(groupId).then((closed) => {
        if (!closed) return
        const nextKey = activeTabKey()
        if (nextKey) syncConversation(nextKey)
      })
    },
    [syncConversation]
  )

  return { focusGroup, activateAndSync, closeAndSync, closeGroupAndSync, renameTab }
}
