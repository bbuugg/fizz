/**
 * action 层：conversation-manage。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import { isRemoteWorkspace } from "@fizz/contracts/types";
import { errorMessage } from "@fizz/agent-kit/shared/lib/stores/shared";
import { saveActiveWorkspaceId, saveActiveConversationId, saveQueue } from "../storage";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createConversationManageActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "selectWorkspace" | "newConversation" | "deleteConversation" | "clearConversation" | "deleteMessage" | "deleteMessagesFrom" | "resendMessage"
> {
  const { set, get, api, readSlice, writeSlice, dropSlice, preferredTarget, guardTarget, removeMessages, resolveConvId, isFocus } = ctx;

  return {
    selectWorkspace: (workspaceId, openNewest = true) => {
      // `null` = 不选项目（界面上的临时状态，见接口注释）：落盘一个 null，
      // 下次启动回到「没选」而不是被拽回第一个项目
      set({ activeWorkspaceId: workspaceId });
      saveActiveWorkspaceId(workspaceId);
      /**
       * 切到**远端工作区**时，把草稿页上挂着的 ACP 目标清掉。
       *
       * 远端工作区不能跑外部 Agent（ACP，它要在服务端本机 spawn 一个进程、cwd 就是工作区
       * 目录，远端目录够不着）：模型下拉里那一组已经整组不可选了，可**已经选好的那个目标
       * 还挂在 `draftSettings` 上** —— pill 继续显示那个 agent，一发就被服务端拒成「远端
       * 工作区首期不支持外部 Agent（ACP）」，用户看到的是「我明明没选它」。
       *
       * 只清 ACP 那一份：内置模型的目标在远端工作区照样能用，别顺手把用户的选择抹掉。
       * 所有入口（输入框下方那颗、侧栏项目行、深链恢复）最终都走这里，所以只写这一处。
       */
      const next = workspaceId
        ? get().workspaces.find((w) => w.id === workspaceId)
        : undefined;
      if (
        isRemoteWorkspace(next) &&
        get().draftSettings.chatTarget?.backend === "acp"
      ) {
        set((state) => ({
          draftSettings: { ...state.draftSettings, chatTarget: null },
          draftAcp: null,
        }));
      }
      if (!openNewest) return;
      const newest = get().conversations.find(
        (c) => c.workspaceId === workspaceId,
      );
      get().openConversation(newest?.id ?? null);
    },
    newConversation: async (workspaceId, title, target, done) => {
      /**
       * `done` 只调一次（成功 / 失败都要调，见接口注释）。`settle` 收成幂等：早退的几条
       * 分支都从同一个出口走，漏一条就等于「转圈永远不停」。
       */
      let settled = false;
      const settle = (conversationId: string | null): string | null => {
        if (!settled) {
          settled = true;
          done?.(conversationId);
        }
        return conversationId;
      };
      const api = get().getApi();
      if (!api) return settle(null);
      /**
       * `wid` 为空 = 用户没选项目（输入框下方那颗「未指定工作区」）。**不是错误**：
       * 服务端会当场建一个临时工作区（目录 `<数据目录>/conversations/<会话 id>`）再建会话，
       * 返回的 `created.workspaceId` 就是它 —— 会话永远绑在真实工作区上。
       */
      const wid = workspaceId ?? get().activeWorkspaceId;
      /**
       * 目录不在了就别建：服务端 `POST /api/conversations` 也有同一道校验（那才是真拦），
       * 但它的错误要等一个往返才回来；这里先拦一道，让**所有入口**（侧栏「新建会话」按钮 /
       * 命令面板 / 快捷键 / 空白页写回）都在同一处拿到同一句人话。
       * 标记是服务端巡检的结论（见 `AgentWorkspace.dirMissing`），可能慢半拍 —— 所以别把它
       * 当成唯一防线。
       */
      const ws = wid ? get().workspaces.find((w) => w.id === wid) : undefined;
      if (ws?.dirMissing) {
        get().setError(
          `工作区目录不存在：${ws.path}（可能已被删除或移动），无法新建会话`,
        );
        return settle(null);
      }
      try {
        const clean = title?.trim();
        // 草稿页（新任务页）上选好的 MCP / 浏览器偏好 / 思考强度都是**待定选择**：
        // 跟着会话一起落库，否则用户白选。
        // `target` 里已显式带了 mcpServerIds 时以它为准（调用方更清楚）。
        const draftSettings = get().draftSettings;
        const sourceConversationId = resolveConvId(undefined);
        const {
          activeWorkspaceId: sourceWorkspaceId,
          draftAcp: draft,
        } = get();
        const mcpServerIds = target?.mcpServerIds ?? draftSettings.mcpServerIds;
        const browserSettings = draftSettings.browserSettings;
        const reasoningEffort = draftSettings.reasoningEffort;
        const created = await api.createConversation({
          // 缺省 = 服务端建临时工作区（见 api.createConversation 的注释）
          ...(wid ? { workspaceId: wid } : {}),
          ...(clean ? { title: clean } : {}),
          ...(target ?? {}),
          ...(mcpServerIds.length ? { mcpServerIds } : {}),
          ...(browserSettings ? { browserSettings } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        });
        /**
         * 并进清单时要**带上刚下发的选择**（模型 / 思考强度 / MCP / 浏览器偏好）。
         *
         * 视图的现场是从清单项派生的（`scopedSettingsOf`），清单项缺这几项就等于「刚建
         * 好的会话没选模型」—— 第一轮会被 `guardTarget` 拦成「请先在输入框上方选择模型」。
         * 服务端返回的 `created` 一般带着它们，但那是另一端的实现细节；这里按**我刚发出去
         * 的那份**补齐，不赌它回显。
         */
        const createdWithSettings = {
          ...created,
          ...(target?.backend ? { backend: target.backend } : {}),
          ...(target?.configId ? { configId: target.configId } : {}),
          ...(target?.modelId ? { modelId: target.modelId } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(mcpServerIds.length ? { mcpServerIds } : {}),
          ...(browserSettings ? { browserSettings } : {}),
        };
        set((state) => ({
          conversations: [createdWithSettings, ...state.conversations],
        }));
        // 没选项目：服务端刚建了个临时工作区 —— 清单不刷新的话顶栏 / 侧栏认不出它
        if (!wid) set({ workspaces: await api.listWorkspaces() });
        /**
         * 新任务页选好的 ACP 档位：会话一建好就下发。agent 侧 `session/new` 给的默认档
         * 未必是用户选的那个，而这一轮马上就要发 —— 等下一轮再补就是「第一轮按错的档跑」。
         * 失败不挡发送：pill 会显示回滚后的真实档，用户能看见。
         */
        if (
          created.backend === "acp" &&
          draft &&
          draft.agentId === created.configId
        ) {
          if (draft.mode)
            await get().setAcpAgentMode(draft.agentId, created.id, draft.mode);
          if (draft.thought)
            await get().setAcpThoughtLevel(
              draft.agentId,
              created.id,
              draft.thought,
            );
        }
        // 页面切换放到所有异步准备之后：否则新会话会先以空列表露出，档位设置结束后才出现
        // 乐观用户消息，造成消息区闪一下。等待期间用户若切走，迟到结果只并入清单、不抢焦点。
        if (
          resolveConvId(undefined) === sourceConversationId &&
          get().activeWorkspaceId === sourceWorkspaceId
        ) {
          set({
            activeWorkspaceId: created.workspaceId,
            activeConversationId: created.id,
          });
          saveActiveWorkspaceId(created.workspaceId);
          saveActiveConversationId(created.id);
        }
        // 只消费本次创建的草稿；等待期间新选的档位属于下一次创建。
        if (draft && get().draftAcp === draft) set({ draftAcp: null });
        // 会话已经建好、界面立刻就能用：档位下发在上面（要等 agent 应答），那几百毫秒
        // 不该继续转圈 —— 用户已经从「空态页」切进会话里了
        return settle(created.id);
      } catch (err) {
        get().setError(errorMessage(err));
        return settle(null);
      }
    },
    deleteConversation: async (id) => {
      const api = get().getApi();
      if (!api) return { ok: false, nextId: null };
      try {
        const rest = await api.deleteConversation(id);
        set({ conversations: rest });
        // 本地现场与队列一并清掉（不论删的是不是当前会话）
        dropSlice(id);
        saveQueue(id, []);
        if (!isFocus(id))
          return { ok: true, nextId: null };
        const wsId = get().conversations.find((c) => c.id === id)?.workspaceId;
        const next = wsId
          ? (rest.find((c) => c.workspaceId === wsId)?.id ?? null)
          : null;
        get().openConversation(next);
        return { ok: true, nextId: next };
      } catch (err) {
        get().setError(errorMessage(err));
        return { ok: false, nextId: null };
      }
    },
    clearConversation: async (id) => {
      const api = get().getApi();
      if (!api) return;
      try {
        set({ conversations: await api.clearConversation(id) });
        if (get().slices[id]) writeSlice(id, (s) => ({ ...s, messages: [] }));
      } catch (err) {
        get().setError(errorMessage(err));
      }
    },
    deleteMessage: async (messageId, scope) => {
      // 分屏时删的是**本标签**那条会话里的消息，不是焦点会话的
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      const slice = readSlice(conversationId);
      // 这个会话自己正在跑就不许删（别的会话在跑不妨碍）——删除会动服务端消息，与流式写冲突
      if (slice.streaming || get().runningConversations[conversationId]) return;
      // 已经有一个删除在飞：两个删除的「删完回拉」会互相盖。界面上也点了（消息区不收点击），
      // 这里是兜底（多面板 / 快捷键等别的入口）
      if (slice.deleting) return;
      // 不在列表里（历史重拉 / 刚被删过）：别拿野 id 去删
      if (!slice.messages.some((m) => m.id === messageId)) return;
      await removeMessages(conversationId, messageId, "single");
    },
    deleteMessagesFrom: async (messageId, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      const slice = readSlice(conversationId);
      // 这个会话自己正在跑就不许删（别的会话在跑不妨碍）——删除会动服务端消息，与流式写冲突
      if (slice.streaming || get().runningConversations[conversationId]) return;
      if (slice.deleting) return;
      // 本地先确认这条还在（历史重拉 / 刚被删过时不拿野 id 去打服务端）
      if (!slice.messages.some((m) => m.id === messageId)) return;
      await removeMessages(conversationId, messageId, "from");
    },
    resendMessage: async (messageId, text, files, onStarted, scope) => {
      /**
       * 编辑重发是「本标签那条会话」上的操作：截断与重发都必须落在它上面 —— 分屏时
       * 按活跃会话走会把焦点会话的历史切掉。
       */
      const conversationId = resolveConvId(scope);
      /**
       * ⚠️ 编辑重发是**先删历史、再发**：目标失效（没选模型 / 配置被删 / 模型下架）时
       * 必须在删之前拦下 —— 否则用户既发不出去、又平白丢了那段历史，比「草稿被吃掉」
       * 严重得多。`guardTarget` 正好就是这个判据，这里问得比 `runRound` 更早；
       * 校验的是**本会话**的目标（分屏时焦点会话的目标与本会话无关）。
       *
       * 剩下的失败点（服务端 400 / 连不上）仍落在删之后：编辑重发本来就有「以这条为
       * 起点重来」的语义，那种情况靠 `send` 回传 `false` 让输入框把草稿还回去。
       */
      if (!guardTarget(get().scopedSettingsOf(conversationId).chatTarget))
        return false;
      // 已经有一个删除在飞（另一个入口刚点的）：别在它上面再叠一次「删 + 发」——
      // 那样两条回拉会互相盖，历史可能停在错的那一份
      if (readSlice(conversationId).deleting) return false;
      await get().deleteMessagesFrom(messageId, conversationId);
      return get().send(text, files, onStarted, conversationId);
    },

  };
}
