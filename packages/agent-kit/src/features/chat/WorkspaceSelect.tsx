// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { useState } from "react";
import { GitCloneDialog } from "@fizz/agent-kit/features/projects/GitCloneDialog";
import {
  NewContainerProjectDialog,
} from "@fizz/agent-kit/features/projects/NewContainerProjectDialog";
import { useDirectoryPicker } from "@fizz/agent-kit/shared/hooks/use-directory-picker";
import { useStateValue } from "@fizz/agent-kit/shared/lib/state-ws";
import { WorkspacePicker } from "@fizz/agent-kit/features/chat/WorkspacePicker";
import { RemoteWorkspaceDialog } from "@fizz/agent-kit/features/chat/RemoteWorkspaceDialog";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type ContainerProjectsSnapshot } from "@fizz/contracts/types";
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
 */
export function WorkspaceSelect({ app }: { app: AgentApp }) {
  const t = useT();
  /**
   * 「添加项目」的三种方式里，只有 Git / 容器需要记状态（它们各开一个弹窗）；
   * 选目录那一路直接 `await pick()`。
   *
   * ⚠️ 侧栏那颗「+」**已经删掉**了，加项目只剩这一处入口 ——
   * 别再把入口往回加，两处维护同一组弹窗迟早会漂。
   */
  const [addMode, setAddMode] = useState<"git" | "container" | "remote" | null>(null);
  /** 容器型项目的唯一能力门控（服务端有 docker 才有这个选项） */
  const containerProjects = useStateValue<ContainerProjectsSnapshot>(
    "containerProjects",
    { available: false, projects: [] },
  );

  /**
   * 选目录：桌面端弹**系统目录框**，web 才用内置的服务端目录浏览器。
   * 工作区登记的是「跑 Agent 那台机器」上的路径 —— 桌面端后端就在本进程里，是同一台机器。
   */
  const { pick, node: dirPicker } = useDirectoryPicker(
    app,
    t("这里列的是服务端上的目录（Agent 就跑在那台机器上）。选中的目录会登记为项目。"),
  );

  const addDir = (path: string): void => {
    void app.addWorkspace({ path }).then((ws) => {
      if (ws) selectNewWorkspace(app, ws);
    });
  };

  const pickDir = (): void => {
    void pick().then((path) => {
      if (path) addDir(path);
    });
  };

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
        actions={[
          { value: "__add_dir__", label: t("选择文件夹…") },
          { value: "__add_git__", label: t("从 Git 导入…") },
          // 远端工作区：目录在 SSH 主机上，Agent 经 SFTP / 远端 shell 操作它
          { value: "__add_remote__", label: t("连接远端服务器…") },
          // 容器型项目：服务端有 docker 才出现（目录由服务端固定生成，用户不可选）
          ...(containerProjects.available
            ? [{ value: "__add_container__", label: t("新建容器型项目…") }]
            : []),
        ]}
        onAction={(action) => {
          if (action === "__add_dir__") pickDir();
          else if (action === "__add_container__") setAddMode("container");
          else if (action === "__add_remote__") setAddMode("remote");
          else setAddMode("git");
        }}
        title={t("工作区：Agent 只能读写这个目录里的东西。切换会回到空会话（会话归属不可改）")}
      />
      {/* 桌面端是系统目录框（这里为 null），web 才是内置的服务端目录浏览器 */}
      {dirPicker}
      <GitCloneDialog
        app={app}
        open={addMode === "git"}
        onOpenChange={(open) => setAddMode(open ? "git" : null)}
        onCloned={(ws) => selectNewWorkspace(app, ws)}
      />
      <NewContainerProjectDialog
        app={app}
        open={addMode === "container"}
        onOpenChange={(open) => setAddMode(open ? "container" : null)}
        onCreated={(ws) => selectNewWorkspace(app, ws)}
      />
      <RemoteWorkspaceDialog
        app={app}
        open={addMode === "remote"}
        onOpenChange={(open) => setAddMode(open ? "remote" : null)}
        onCreated={(ws) => selectNewWorkspace(app, ws)}
      />
    </>
  );
}
