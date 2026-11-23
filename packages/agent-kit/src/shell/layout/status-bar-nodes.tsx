import { activeTabKey, usePanelState } from '@fizz/agent-kit/shared/lib/panel-store'
import { hostIdOfTabKey } from '@fizz/agent-kit/shared/lib/panel-tabs'
import { HostMonitorBadge } from '@fizz/agent-kit/features/hosts/HostMonitorBadge'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/**
 * 状态栏右侧那一段「跟着焦点标签走」的信息。
 *
 * 只有主机 / 终端标签给东西：主机监控（CPU / 内存）。对话标签**不占位置** ——
 * 分支入口已从底栏撤掉（看分支 / 切分支都在右侧「源代码管理」面板头部那颗），
 * 底栏右侧空着就行，不再额外查面板现场。
 */
export function StatusBarNodes({ app }: { app: AgentApp }) {
  const state = usePanelState()
  const tabKey = activeTabKey(state)
  if (!tabKey) return null

  const hostId = hostIdOfTabKey(tabKey)
  if (hostId) return <HostMonitorBadge key={hostId} api={app.api} hostId={hostId} />
  return null
}
