import { GitBranch } from 'lucide-react'
import { activeTabKey, usePanelState } from '@fizz/agent-kit/shared/lib/panel-store'
import { NEW_TAB_KEY, hostIdOfTabKey } from '@fizz/agent-kit/shared/lib/panel-tabs'
import { draftPanelKey } from '@fizz/agent-kit/shared/lib/panel-session'
import { HostMonitorBadge } from '@fizz/agent-kit/features/hosts/HostMonitorBadge'
import { STATUS_ITEM_CLASS } from '@fizz/agent-kit/shared/lib/status-bar'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/**
 * 状态栏右侧那一段「跟着焦点标签走」的信息。
 *
 * 两种标签各给一样东西，**互斥**（一条底栏只有一个位置）：
 * - 终端 / 主机标签 → 主机监控（CPU / 内存）；
 * - 对话标签 → **当前 git 分支**（点它 = 开 / 收右侧「源代码管理」面板）。
 *
 * 分支为什么落在这儿：它是「当前环境」的信息，和旁边的 CPU / 内存同一类 —— 常驻、
 * 低频、扫一眼就走。顶栏那颗 git 按钮只够放图标 + 改动数徽标（右边已经有六七颗按钮），
 * 名字下面那条两行版头也已经撤掉了（多一条空行会把标题和正文撑开），所以底栏是
 * 「不开面板也能看见分支」的唯一常驻位置。
 *
 * 数据来自**这个标签自己的面板现场**（`panel.gitBranch`）：`app-provider` 在活跃会话上
 * 拉 git status 时顺手写进去，`GitPanel` 的 `onChanges` 在切分支 / 检出后也会回写，
 * 不额外打接口。非仓库 / 还没拉到 → 整段不渲染（不留一个空壳）。
 */
export function StatusBarNodes({ app }: { app: AgentApp }) {
  const state = usePanelState()
  const tabKey = activeTabKey(state)
  const t = useT()
  // 用 `panelOf(tabKey)` 而不是「当前会话那份」：分屏下同时开着几个会话，
  // 读全局那个会把 A 的分支显示到 B 的标签上（与 `ConversationTab` 同一条口径）
  const { panelOf, toggleSideTabOf } = useAppContext()
  // 主区域只有一套面板（流程视图已删），不必再判「当前是不是对话视图」
  if (!tabKey) return null

  const hostId = hostIdOfTabKey(tabKey)
  if (hostId) return <HostMonitorBadge key={hostId} api={app.api} hostId={hostId} />

  /*
   * 草稿标签（「新对话」）的 key 是 `__new__`，它的面板现场挂在 `draftPanelKey(工作区)`
   * 上（见 `app-provider` 的 `sessionKey`）—— 直接拿 `__new__` 去查永远是 undefined。
   * 但这一页恰恰是最该知道「当前在哪条分支上」的地方（准备开工），所以照 `ConversationTab`
   * 的算法换一次 key。
   */
  const panelKey = tabKey === NEW_TAB_KEY ? draftPanelKey(app.activeWorkspaceId) : tabKey
  const branch = panelOf(panelKey)?.gitBranch
  if (!branch) return null

  return (
    <button
      type="button"
      onClick={() => toggleSideTabOf(panelKey, 'git')}
      className={STATUS_ITEM_CLASS}
      title={t('当前分支：{branch}（点击打开源代码管理）', { branch })}
    >
      <GitBranch className="size-3.5 shrink-0" />
      {/* 长分支名截断：底栏是常驻的一条，不能让一段分支名把右边那些徽标挤走 */}
      <span className="max-w-[14rem] truncate font-mono">{branch}</span>
    </button>
  )
}
