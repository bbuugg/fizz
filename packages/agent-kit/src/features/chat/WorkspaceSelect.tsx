// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { WorkspacePicker } from "@fizz/agent-kit/features/chat/WorkspacePicker";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { requestCommandPalette } from "@fizz/agent-kit/shared/lib/command-palette";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/**
 * 空会话里的工作区选择（由「开始新对话」页的标题句挂进来）。
 *
 * 分工：顶栏那行是「这个会话属于哪个项目」的只读事实，这里是**下一条消息**的归属 ——
 * 会话的 `workspaceId` 落库后不可改，所以切换 = 回空会话，下一条消息按新归属新建。
 * 已有会话时不再渲染这个入口：摆一个能把人踢回空会话的选择器只会让人以为能改归属。
 *
 * 标题句里用 `variant="inline"`（文字入口 + 占位下划线）；定时任务表单仍用默认的 pill。
 *
 * 「未指定工作区」**不是一种归属**，只是这一行上的「还没选」：真发消息时服务端会为这条
 * 会话建一个临时工作区（目录 `<数据目录>/conversations/<年月日>/<会话 id>`）再绑上去 ——
 * 会话永远挂在真实工作区上，文件工具 / 终端 / 技能都能用。所以这里的 `null` 只活到发送为止。
 *
 * 「加项目」的四条动作（选目录 / Git / 远端 / 容器）**不在这里摆菜单**：它们全在命令面板
 * 的「新建工作区」页里（结果完全一样：登记成工作区 + 切过去）。下拉只留一条「新建工作区」
 * 直接把面板开到那一页 —— 两处各摆一套只会慢慢漂。原先那套 `useWorkspaceAddActions` +
 * 四个弹窗（含已删的 `RemoteWorkspaceDialog`）从这里撤掉了。
 */
export function WorkspaceSelect({
  app,
  variant,
  placeholder
}: {
  app: AgentApp
  variant?: 'pill' | 'inline'
  placeholder?: string
}) {
  const t = useT();

  return (
    <WorkspacePicker
      value={app.activeWorkspaceId}
      variant={variant}
      placeholder={placeholder}
      workspaces={app.workspaces.filter(
        // 临时工作区不进这个列表：它是「不选项目」发消息后自动建的，
        // 再把它们列出来等于让人能手动选一个 uuid 目录
        (workspace) => workspace.path && !workspace.scratch,
      )}
      onChange={(next) => {
        // 只决定**下一条消息**的归属（会话的 workspaceId 落库后不可改）。
        // 这一行平时只在空会话里出现，这里再退一次空会话是兜底：将来若有人把它放回会话页，
        // 也不会让人误以为改的是当前会话的归属。
        app.selectWorkspace(next, false);
        if (app.activeConversationId) void app.openConversation(null);
      }}
      remoteHostName={(workspace) =>
        app.sshHosts.find((host) => host.id === workspace.remote?.hostId)?.name ?? null
      }
      // 点到就直接把命令面板开到「新建工作区」那一页（四条入口都在那儿）
      onNewWorkspace={() => requestCommandPalette("new-workspace")}
      title={t("工作区：Agent 只能读写这个目录里的东西。切换会回到空会话（会话归属不可改）")}
    />
  );
}
