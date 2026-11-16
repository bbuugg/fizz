"use client";

import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { isConversationTabKey, NEW_TAB_KEY } from '@fizz/agent-kit/shared/lib/panel-tabs';
import { renameToolTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { requestReloadTab } from '../tab-reload'
import {
  activateTab,
  activeTabKey,
  cycleTab,
  getPanelState,
  requestCloseGroup,
  requestCloseTabs,
  setActiveGroup,
} from '@fizz/agent-kit/shared/lib/panel-store'
import type { GroupActions } from './types'

/**
 * 组相关的用户手势动作。
 *
 * ## 为什么抽成 hook
 *
 * 「标签内容」与「组外壳」现在是**两棵子树**：内容在 `PanelContentLayer`（挂在
 * `PanelView` 根部，为的是不换 React 父节点），外壳（标签条 / 空态 / 落区）在布局树里。
 * 两边都要「点一下把这组设为焦点 + 把当前会话切过去」，逻辑必须只有一份。
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
export function useGroupActions(): GroupActions {
  const { app, openConversation } = useAppContext()

  const syncConversation = useCallback(
    (key: string): void => {
      if (!isConversationTabKey(key)) return
      if (key === NEW_TAB_KEY) {
        if (app.activeConversationId === null) return
        app.openConversation(null)
        return
      }
      if (key === app.activeConversationId) return
      /*
       * `keepScroll`：**切标签不是「打开会话」**。这条会话的面板一直在内存里（后台标签
       * 只是 `hidden`，滚动盒与 scrollTop 都还在），用户翻在上面读的时候点到别的标签再
       * 点回来，不该被复位落底（用户报的「切回来列表自己跳到底部」）。
       * 从侧栏 / 通知 / 深链打开走的是别的入口，那边照旧落底。
       */
      openConversation(key, undefined, { keepScroll: true })
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
   * 快捷键「上一个 / 下一个标签」（默认 Ctrl / ⌘ + Tab，可改）—— 等价于点相邻那颗标签。
   *
   * ## 为什么必须和 `activateAndSync` 走同一份同步（这条修的是真 bug）
   *
   * `cycleTab` 只写面板 store（哪个标签是激活的），而**「当前会话」是另一份状态**
   * （`app.activeConversationId`）。两份状态的同步一直只由**用户手势**触发（见上面
   * `syncConversation` 的长注释：不能放进观察面板状态的 effect，会死循环）。
   *
   * 早先快捷键这条只调了 `cycleTab`、没有同步 —— 于是按 Ctrl+Tab 换到 B 标签后，
   * `app.activeConversationId` 还停在 A：顶栏的文件 / 源码管理 / 终端按钮、以及它们
   * 的快捷键（`toggle-files` / `toggle-git` / `toggle-terminal`）全都按 `sessionKey`
   * 去找面板现场，改的是 **A 的面板**。用户看到的就是「切了标签，快捷键还在上一个
   * 标签里操作」，而且 A 那边还被真的改脏了（再切回去文件面板已经莫名打开）。
   *
   * ⚠️ `cycleTab` 是同步写 store 的，所以切完立刻读 `activeTabKey()` 拿到的就是新标签
   * —— 与 `closeAndSync` 同一个套路。组里只有一颗标签时 `cycleTab` 空操作，这里读回来
   * 还是原来那颗，`syncConversation` 自己会早退，不会白拉一次历史。
   */
  const cycleAndSync = useCallback(
    (delta: 1 | -1): void => {
      cycleTab(delta)
      const key = activeTabKey()
      if (key) syncConversation(key)
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

  /**
   * 标签改名，两条完全不同的路：
   *
   * - **对话标签** → 改的是**那个会话的标题**（`renameConversation`）：落盘、侧栏同步、
   *   重开还是新名字。标题是会话自己的数据，不是这层壳的显示细节。
   * - **工具标签** → 只是主区域标签的**显示名**（`renameToolTab`）：内存里的一层别名，
   *   不回写主机清单 / 接口清单 / 脚本名，**标签关掉就恢复原名**（登记表条目被回收）。
   *   这些标签的名字本来就来自各自功能区的数据，标签条上的改动不该反向污染它们。
   *
   * 「新对话」草稿标签没有名字可改（它就是那个页面的语义）。
   */
  const renameTab = useCallback(
    (key: string, title: string): void => {
      if (key === NEW_TAB_KEY) return
      if (isConversationTabKey(key)) {
        void app.renameConversation(key, title)
        return
      }
      renameToolTab(key, title)
    },
    [app]
  )

  /**
   * 标签右键的「刷新」。按标签类型分派 —— 两者是**完全不同**的动作，别合并：
   *
   * - **对话标签** → `reloadConversation`：等价于「刷新页面 → 点开这个会话」，
   *   内置 拉服务端权威历史、acp 走 `session/load` 回放。**不卸载重挂**：
   *   `ConversationTab` 重挂不会重新拉消息（消息在 store 里），只会把右侧面板的终端 /
   *   文件现场一起拆掉。
   * - **工具标签** → `requestReloadTab` 的卸载重挂（接口页重发请求、插件面重新 `render()`）。
   *   这条路会先问标签自己的 `beforeReload` 守卫。
   *
   * 「新对话」草稿标签没有会话可加载，走工具标签那条（重挂一次，等于清掉面板现场）。
   */
  const reloadTab = useCallback(
    (key: string): void => {
      if (key !== NEW_TAB_KEY && isConversationTabKey(key)) {
        // 正在生成时 store 会拒绝（权威历史会把流式现场整段盖掉）—— 这里先说清为什么没反应
        if (app.runningConversations[key]) {
          toast('这一轮还在生成，先停止再刷新')
          return
        }
        void app.reloadConversation(key)
        return
      }
      void requestReloadTab(key)
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

  return {
    focusGroup,
    activateAndSync,
    cycleAndSync,
    closeAndSync,
    closeGroupAndSync,
    renameTab,
    reloadTab,
  }
}

// ---------------------------------------------------------------------------
// 一个面板组
// ---------------------------------------------------------------------------
