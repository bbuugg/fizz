/**
 * action 层：conversation-fork。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import { toBuiltinHistory } from "@fizz/agent-kit/shared/lib/acp-convert";
import { errorMessage } from "@fizz/agent-kit/shared/lib/stores/shared";
import { t } from "@fizz/i18n";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createConversationForkActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "forkConversation" | "forkAcpConversation" | "convertAcpConversation"
> {
  const { set, get, api, readSlice, resolveConvId, preferredTarget, peekActiveRun, persistTarget } =
    ctx;
  const forkingAcpIds = new Set<string>();

  return {
    /** 整条 agent session 分叉；只绑定并更新清单，标签导航由外壳完成。 */
    forkAcpConversation: async (conversationId) => {
      const api = get().getApi();
      const source = get().conversations.find((c) => c.id === conversationId);
      if (!api || !source || source.backend !== "acp") return null;
      if (forkingAcpIds.has(conversationId)) return null;
      if (!source.configId || !source.acpSessionId) {
        get().setError(t("这条 ACP 会话尚未绑定 Agent 会话，无法分叉"));
        return null;
      }
      const workspace = get().workspaces.find((w) => w.id === source.workspaceId);
      if (!workspace?.path || workspace.dirMissing) {
        get().setError(t("找不到这条会话的工作区目录，无法分叉"));
        return null;
      }
      const local = readSlice(conversationId);
      if (
        get().runningConversations[conversationId] || local.streaming ||
        local.pendingConfirms.length || Object.keys(local.followupRequests).length
      ) {
        get().setError(t("这一轮还在运行或等待答复，结束后再分叉"));
        return null;
      }
      // 在第一次 await 前上锁，非焦点会话和重复点击也走同一道守卫。
      forkingAcpIds.add(conversationId);
      let forkedSessionId: string | undefined;
      try {
        // 别的客户端可能正在跑；探测失败也不能把未知状态当成空闲。
        const { run } = await api.activeRun(conversationId);
        if (run) {
          get().setError(t("这一轮还在运行或等待答复，结束后再分叉"));
          return null;
        }
        const result = await api.forkAcpSession(source.configId, {
          sessionId: source.acpSessionId,
          workspacePath: workspace.path,
        });
        const sessionId = result.sessionId?.trim();
        if (!sessionId || sessionId === source.acpSessionId) {
          throw new Error(t("Agent 未返回新的分叉会话 ID"));
        }
        forkedSessionId = sessionId;
        const created = await api.createConversation({
          workspaceId: source.workspaceId,
          title: t("{title}（分支）", { title: source.title.trim() || t("未命名会话") }),
          backend: "acp",
          configId: source.configId,
          modelId: source.modelId,
          acpSessionId: sessionId,
          ...(source.mcpServerIds ? { mcpServerIds: source.mcpServerIds } : {}),
          ...(source.browserSettings ? { browserSettings: source.browserSettings } : {}),
          ...(source.acpPermissionMode ? { acpPermissionMode: source.acpPermissionMode } : {}),
        });
        // 用创建接口的权威回包并入清单，不让额外的列表刷新失败变成“分叉失败”。
        set((state) => ({
          conversations: [created, ...state.conversations.filter((c) => c.id !== created.id)],
        }));
        return created.id;
      } catch (err) {
        const error = t(errorMessage(err));
        get().setError(forkedSessionId
          ? t("ACP 分支已创建，但本地绑定失败；可通过“导入会话”找回：{error}", { error })
          : error);
        return null;
      } finally {
        forkingAcpIds.delete(conversationId);
      }
    },
    /**
     * 会话分叉（「从此签出」）：fork **`scope` 那条会话**（不传 = 活跃会话）到某条消息
     * （含），刷新列表并**切到新会话**（走 openConversation 的装载链路）。
     * 分屏时从非焦点标签触发必须带上自己的 id —— 否则签出的是焦点会话的历史。
     * 失败（运行中 409 / ACP / 消息不存在）只提示。
     */
    forkConversation: async (upToMessageId, opts, scope) => {
      const conversationId = resolveConvId(scope);
      const api = get().getApi();
      if (!api || !conversationId) return;
      try {
        let targetWorkspaceId: string | undefined;
        if (opts?.worktreeIdentifier) {
          // 先建 worktree 项目（校验/落库都在服务端 createWorktree），再把分叉挂进去
          const source = get().conversations.find(
            (c) => c.id === conversationId,
          );
          if (!source) return;
          const workspace = await api.createWorktree(source.workspaceId, {
            identifier: opts.worktreeIdentifier,
            ...(opts.worktreeName?.trim()
              ? { name: opts.worktreeName.trim() }
              : {}),
          });
          targetWorkspaceId = workspace.id;
          set({ workspaces: await api.listWorkspaces() });
        }
        const { conversation } = await api.forkConversation(
          conversationId,
          upToMessageId,
          targetWorkspaceId,
        );
        set({ conversations: await api.listConversations() });
        // 分叉进了新工作区就一并切过去（侧栏要落在 worktree 项目树上看得到它）
        if (targetWorkspaceId) get().selectWorkspace(targetWorkspaceId);
        await get().openConversation(conversation.id);
      } catch (err) {
        get().setError(errorMessage(err));
        throw err;
      }
    },
    /**
     * ACP 会话 → 内置 Agent 会话（侧栏会话行「更多」里的一项）。
     *
     * 三步：拉转录（agent 侧 `session/load` 回放）→ 洗成内置格式 → 建一条 内置会话。
     * **不新增服务端路由**：`POST /api/conversations` 本来就收 `{ backend, messages }`，
     * 且对 内置后端不做任何特判（历史直接进 `domain.saveConversation`）。
     *
     * ⚠️ 转录必须**现拉**：acp 会话的本地 `messages` 恒为空（历史在 agent 侧）。
     * 拉不回来（agent 没广告 load / session 失效 / 找不到工作区目录）就明确失败 ——
     * 别造一条空会话骗用户。
     *
     * ⚠️ 收尾必须把模型选择摆到**内置**那一档：新会话落库时没带 configId / modelId
     * （与「新建任务」同一起点），`openConversation` 会把 chatTarget 恢复成 null；
     * 不补的话用户停在「选择模型」很别扭，更糟的是 —— 若 chatTarget 里还留着**那条 ACP
     * 会话**的值，下一轮就会带着 acp 后端发出去（服务端按输入的后端判分支）。
     * 用 `preferredTarget()`（= 上次真正发过的**内置**模型，刻意排除 ACP）兜一下；
     * 没有就保持 null 让用户自己选 —— 与空白页同一条规矩，绝不替他挑一个没选过的模型。
     */
    convertAcpConversation: async (conversationId, upToMessageId, opts) => {
      const api = get().getApi();
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (!api || !conv || conv.backend !== "acp") return false;
      // 运行中拉转录会 teardown 正在跑的 ACP 进程：等这一轮结束再转，别把现场打断
      if (await peekActiveRun(conversationId)) {
        get().setError("这一轮还在运行，结束后再转换");
        return false;
      }
      if (!conv.configId || !conv.acpSessionId) {
        get().setError("这条会话没有可回放的 agent 侧会话，转不了");
        return false;
      }
      const cwd = get().workspaces.find((w) => w.id === conv.workspaceId)?.path;
      if (!cwd) {
        get().setError("找不到这条会话的工作区目录，转不了");
        return false;
      }
      try {
        const { messages } = await api.getAcpTranscript(
          conv.configId,
          conversationId,
          conv.acpSessionId,
          cwd,
        );
        // 回放回来是空的（会话本来就空 / agent 不给内容）：造一条空会话没有任何意义，
        // 说清原因收场。注意这**不等于**「拉失败」—— 那种情况 getAcpTranscript 会抛。
        if (messages.length === 0) {
          get().setError("agent 侧没有可回放的内容，这条会话转不了");
          return false;
        }
        // 「从某条消息起转换」：只保留到该条（含）为止。回放 id 是 `u-replay-N` /
        // `a-replay-N`（每次按同一顺序回放，id 稳定），所以优先按 id 找终点；
        // 找不到（刚发出、agent 侧还没 load 出来）就退回**本地列表的位置**截断 ——
        // 本地那份与回放同源、前缀对齐，按位置切一样准。
        let history = messages;
        if (upToMessageId) {
          let endIndex = messages.findIndex((m) => m.id === upToMessageId);
          if (endIndex < 0) {
            endIndex = readSlice(conversationId).messages.findIndex(
              (m) => m.id === upToMessageId,
            );
          }
          // 终点都不认识：宁可显式失败，也别悄悄转出「比用户点的那条更长 / 更短」的历史
          if (endIndex < 0) {
            get().setError("找不到这条消息，转不了");
            return false;
          }
          history = messages.slice(0, endIndex + 1);
        }
        // worktree 模式：先在**源会话所属**项目下建工作树（与 forkConversation 同一套），
        // 新会话随后挂进去 —— 原项目一行代码不动
        let targetWorkspaceId = conv.workspaceId;
        if (opts?.worktreeIdentifier) {
          const workspace = await api.createWorktree(conv.workspaceId, {
            identifier: opts.worktreeIdentifier,
            ...(opts.worktreeName?.trim()
              ? { name: opts.worktreeName.trim() }
              : {}),
          });
          targetWorkspaceId = workspace.id;
          set({ workspaces: await api.listWorkspaces() });
        }
        const created = await api.createConversation({
          workspaceId: targetWorkspaceId,
          title: `${conv.title.trim() || "未命名会话"}（内置 Agent）`,
          backend: "builtin",
          // 转换产物整份作为新会话的历史（服务端整体写入）
          messages: toBuiltinHistory(history),
        });
        set({ conversations: await api.listConversations() });
        // 侧栏可能在别的项目下点的这一项：新会话属于**目标**工作区，先切过去再打开，
        // 否则打开后侧栏停在别的项目树里、看不见它
        if (get().activeWorkspaceId !== targetWorkspaceId)
          get().selectWorkspace(targetWorkspaceId);
        await get().openConversation(created.id);
        /**
         * 见方法头注释：把模型选择摆回内置那一档（没有上次用过的内置模型就留 null）。
         *
         * 写到**这条新会话自己**上（清单项），而不是写一份全局「当前会话的模型」——
         * 后者在分屏时会把别的标签的 composer 一起改掉（用户报过的那个 bug）。
         */
        persistTarget(created.id, preferredTarget());
        return true;
      } catch (err) {
        get().setError(errorMessage(err));
        return false;
      }
    },
  };
}
