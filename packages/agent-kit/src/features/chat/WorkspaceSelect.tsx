// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { WorkspacePicker } from "@fizz/agent-kit/features/chat/WorkspacePicker";
import { useWorkspaceAddActions } from "@fizz/agent-kit/features/chat/workspace-add-actions";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { selectNewWorkspace } from "@fizz/agent-kit/features/chat/select-new-workspace";

/**
 * 输入框**下方**的工作区选择行（**只在空会话时**出现）。
 *
 * 分工：顶栏那行是「这个会话属于哪个项目」的只读事实，这里是**下一条消息**的归属 ——
 * 会话的 `workspaceId` 落库后不可改，所以切换 = 回空会话，下一条消息按新归属新建。
 * 正因为进了会话就改不了，这一行在会话里一律收起（见 `useMainComposerProps` 的
 * `below`）：摆在那儿只会让人以为能改当前会话的归属。
 *
 * 「未指定工作区」**不是一种归属**，只是这一行上的「还没选」：真发消息时服务端会为这条
 * 会话建一个临时工作区（目录 `<数据目录>/conversations/<会话 id>`）再绑上去 —— 会话永远
 * 挂在真实工作区上，文件工具 / 终端 / 技能都能用。所以这里的 `null` 只活到发送为止。
 *
 * 「加项目」那四个入口（选目录 / Git / 远端 / 容器）与它们各自的弹窗都在
 * `useWorkspaceAddActions` 里，与定时任务表单**同一份** —— 那边也挂着同样的菜单，
 * 两处各写一遍迟早会漂（一边多一颗「远端」、一边少一颗）。
 */
export function WorkspaceSelect({ app }: { app: AgentApp }) {
  const t = useT();
  // 新建 / 导入成功后：选中它并回空会话（下一条消息按新归属新建）
  const { actions, onAction, dialogs } = useWorkspaceAddActions(app, (ws) =>
    selectNewWorkspace(app, ws),
  );

  return (
    <>
      {/* 长相与交互在 `WorkspacePicker`（定时任务表单也用同一颗）。
          「未指定工作区」= `null`：发送时服务端建临时工作区（见 `newConversation`）。 */}
      <WorkspacePicker
        value={app.activeWorkspaceId}
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
        actions={actions}
        onAction={onAction}
        title={t("工作区：Agent 只能读写这个目录里的东西。切换会回到空会话（会话归属不可改）")}
      />
      {dialogs}
    </>
  );
}
