/**
 * 会话详情那颗「模型 / 后端」pill —— `ModelPicker` 的**会话版薄壳**。
 *
 * 职责只有三件，别往这里加第四件：
 * 1. 把 `app` 里的清单灌给 `ModelPicker`（`models` / `acpAgents` / 默认窗口）；
 * 2. 按**活动会话**算出「该不该锁后端」：会话已创建时 `agentLocked` 让面板直接进二级
 *    （内置会话 → 内置模型，ACP 会话 → 它绑定的那个 agent），一级不再出现；
 * 3. 读写 `chatTarget`（`setChatTarget` 会顺手探 ACP 档位、把目标持久化到会话目录）。
 *    思考强度面板也在这里挂到下拉底部：它和 `chatTarget` 同源，选完模型要立刻跟着变。
 *
 * 控件本身（分组 / 齿轮 / 手机拍平 / 勾选）全在 `ModelPicker` 里，定时任务表单复用的
 * 就是同一份 —— 那边没有 `AgentApp`，只多了一层局部状态。
 */
import { isRemoteWorkspace } from '@fizz/contracts/types'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { ModelPicker } from '@fizz/agent-kit/features/chat/ModelPicker'
import { ReasoningEffortPanel } from '@fizz/agent-kit/features/chat/ReasoningEffortPanel'
import { AcpThoughtLevelSelect, acpThoughtLevelState } from '@fizz/agent-kit/features/chat/AcpThoughtLevelSelect'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'

export function ModelSelect({ app }: { app: AgentApp }) {
  // 订阅语言：tooltip 文案是渲染期求值的
  useT()
  const { openSettingsTab } = useAppContext()

  const activeConversation = app.conversations.find((c) => c.id === app.activeConversationId)
  // acp 会话绑定的 agent 被删了（会话里记的还是旧 id）→ 当作没锁：`lockedAgent` 为
  // undefined 时两组全出，用户能看到「原来那个已经不在清单里」并重选
  const lockedAgent =
    activeConversation?.backend === 'acp'
      ? app.acpAgents.find((a) => a.id === activeConversation.configId)
      : undefined

  /**
   * 这条「下一轮」属于哪个工作区：有会话按**会话自己的** `workspaceId`（分屏下两个标签
   * 可能来自不同工作区），没有会话就是输入框下方选的那个。
   *
   * 远端工作区里**不能选外部 Agent（ACP）**：ACP 是服务端在本机 `spawn` 一个进程、
   * cwd 指向工作区目录，而远端工作区的目录在 SSH 主机上，那个进程够不着（服务端建会话时
   * 按同一条判据拒掉，见 `apps/server/src/api/conversations/route.ts`）。所以这一组
   * 整组不可选，只留一行说明。
   *
   * 只对**空态**生效：已有会话时 ACP 组本来就不出（换后端 = 新建会话），而远端工作区上
   * 也不可能存在 ACP 会话（建的时候就拦了）。
   */
  const workspace = app.workspaces.find(
    (w) => w.id === (activeConversation?.workspaceId ?? app.activeWorkspaceId)
  )
  const acpDisabledReason =
    !activeConversation && isRemoteWorkspace(workspace)
      ? t(
          '远端工作区不能用外部 Agent（ACP）：它要在服务端本机起一个进程，够不到 SSH 主机上的目录。请用内置模型。'
        )
      : undefined

  /**
   * 下拉底部「思考强度」的显示条件：只有这一轮确实会走**内置模型**才出现。
   *
   * - ACP 会话一律没有（`activeConversation.backend === 'acp'`）：即使绑定的 agent
   *   被删、下拉临时退回内置清单，这一轮的 backend 也已经锁死，档位不会生效；
   * - 切到外部 Agent（ACP）→ 使用同一卡片内的能力驱动面板；
   * - 选中的配置还没有具体模型 → 隐藏（没有可作用的档位）。
   *
   * 它读的是 `app.chatTarget`，所以在下拉里换模型时会立即跟着变。
   */
  const showReasoningEffort =
    activeConversation?.backend !== 'acp' &&
    app.chatTarget?.backend === 'builtin' &&
    !!app.chatTarget.configId &&
    !!app.chatTarget.modelId
  const showAcpThought = acpThoughtLevelState(app).visible

  return (
    <ModelPicker
      models={app.models}
      acpAgents={app.acpAgents}
      value={app.chatTarget}
      onChange={app.setChatTarget}
      // 会话已创建：一级（内置 / 哪个 ACP agent）锁死，打开直接进二级
      agentLocked={!!activeConversation}
      {...(lockedAgent ? { lockedAgent } : {})}
      // 一级里出不出 ACP 组：空态（还没建会话）才有得选
      showAcp={!activeConversation}
      {...(acpDisabledReason ? { acpDisabledReason } : {})}
      emptyTitle={t('这一轮用哪个模型 / 哪个外部 Agent（下一轮生效）')}
      // `defaultContextWindow` 是 `number | null`（服务端没配就是 null），
      // 这里转成 undefined 让 `ModelPicker` 走它自己的 DEFAULT_CONTEXT_WINDOW 兜底
      defaultContextWindow={app.defaultContextWindow ?? undefined}
      onOpenSettings={openSettingsTab}
      // ACP 模型清单：首次进入某个 agent 时拉一次并落盘，标题行尾的刷新按钮强制重拉
      onLoadAcpModels={app.loadAcpModels}
      // 选完模型不关闭：底部思考强度要能接着调；首次选模型时面板也会当场出现
      closeOnSelect={false}
      {...(showReasoningEffort
        ? {
            footer: (
              <ReasoningEffortPanel
                value={app.reasoningEffort}
                onChange={app.setReasoningEffort}
              />
            ),
          }
         : showAcpThought ? { footer: <AcpThoughtLevelSelect app={app} /> } : {})}
    />
  )
}
