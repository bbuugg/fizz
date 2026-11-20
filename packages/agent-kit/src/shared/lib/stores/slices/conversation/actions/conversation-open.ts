/**
 * action 层：conversation-open。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import { errorMessage } from "@fizz/agent-kit/shared/lib/stores/shared";
import { saveActiveConversationId } from "../storage";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createConversationOpenActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "openConversation" | "retryLoadMessages" | "reloadAcpSession" | "reloadConversation"
> {
  const { set, get, api, readSlice, writeSlice, pruneSlices, preferredTarget, loadConversation, loadMessages, pump } = ctx;

  return {
    openConversation: (conversationId, opts) => {
      /**
       * 已是当前会话**且本地现场还在**：什么都不做（重复打开只会白白重拉，界面闪一下）。
       *
       * ⚠️ 「现场还在」这半个判据不能省。`newConversation` 建完会话就把
       * `activeConversationId` 设成了它（界面要立刻切进去），调用方紧接着那次
       * `openConversation(id)` 于是命中早退 —— 可那一刻 `slices[id]` 根本不存在，
       * **没有任何人触发装载**。消息区按 `messagesLoading` 的兜底（「本屏绑了会话、
       * 本地现场还没建」→ true）就恒显示骨架屏，而且永远等不到头：没有任何请求在飞。
       *
       * 必中场景：
       * - 「多智能体协作」建完即打开、不先发消息（用户报「打开后消息列表始终 loading」）；
       * - 刷新后由 `PanelView` 把当前会话对齐到焦点标签 —— 那时 `activeConversationId`
       *   已从 localStorage 还原成同一条，而 `slices` 是空的。
       *
       * 反之，现场在内存里时早退仍然是对的：切走期间流式帧一直写在它自己的 slice 上，
       * 这里重拉只会让界面白闪一次。
       */
      const existing = conversationId ? get().slices[conversationId] : undefined;
      if (
        conversationId &&
        conversationId === get().activeConversationId &&
        existing
      )
        return;
      // 空态 = 用户的明确意图（「新建会话」/ 删除后落空态）：记下来挡住兜底恢复
      set({
        activeConversationId: conversationId,
        blankIntent: conversationId === null,
      });
      // 记住现场：下次启动直接回到这个会话（它自己记着选的模型）
      saveActiveConversationId(conversationId);
      if (!conversationId) {
        // 回到「开始新对话」页：预选清单第一份**有可用模型**的配置（具体的配置 + 模型，
        // 下拉里显示真实名字）—— 不继承上一个会话的选择，也不存在「默认」概念。
        // 各会话的现场都留在会话清单项上，切回来原样还在 —— 不清任何东西。
        // MCP 待定选择照样清空：新会话建出来时会带上，残留会让新会话凭空多出几个 MCP。
        // 浏览器偏好同理：清成「未设」（null）= 按全局默认显示。
        // ACP 草稿档位一并清掉：那是上一个新任务页的临时选择，留着会让下一个新会话凭空带上。
        set({
          draftSettings: {
            chatTarget: preferredTarget(),
            mcpServerIds: [],
            browserSettings: null,
            reasoningEffort: null,
          },
          draftAcp: null,
        });
        return;
      }
      /**
       * 这个会话的现场（模型 / MCP / 浏览器偏好 / 思考强度）**不用搬到哪儿去**：
       * 视图读的是 `scopedSettingsOf(conversationId)`，直接从会话清单项派生。
       *
       * 以前这里得把这四项抄进 store 上的全局字段（顺带在装载收尾时按会话详情再校正
       * 一次）。分屏时那等于「打开 B 就把 A 的 composer 改成 B 的设置」—— 用户报的
       * 「点一下标签两个标签模型同步」正是它。
       */
      const stored = get().conversations.find((c) => c.id === conversationId);
      /**
       * 定时任务跑出来的会话（`unseen`）：**点开即算看过**。
       *
       * 本地先乐观清掉（红点立刻消失、侧栏不用等一个来回），服务端顺手落标记；
       * fire-and-forget —— 这颗红点晚消失几毫秒没关系，但请求失败绝不能挡住打开会话。
       * 应答是整份清单，直接覆盖（与归档 / 重命名同一条用法）。
       *
       * 只在这一处清：所有入口（侧栏行、定时任务管理页、深链、搜索结果）最终都走
       * `openConversation`，别在各处再抄一遍。
       */
      if (stored?.unseen) {
        const api = get().getApi();
        set({
          conversations: get().conversations.map((c) =>
            c.id === conversationId ? { ...c, unseen: undefined } : c,
          ),
        });
        void api
          ?.markConversationSeen(conversationId)
          .then((list) => set({ conversations: list }))
          .catch(() => undefined);
      }
      if (existing) {
        /**
         * 现场还在内存里：**直接切过去**。切走期间这轮的 SSE 帧一直落在它自己的
         * slice 上，这里看到的就是最新直播 —— 不清空、不重拉、不需要 attach。
         *
         * 后台再静默刷一遍历史兜底（别的端可能改过这个会话）：在跑 / 装载中都不刷
         * —— 在跑时流式帧才是真源，装载中时原装载链路自己会写。
         *
         * ⚠️ `scrollResetSeq` 是「消息区**复位落底**」的信号，**不是**「切过去了」的信号：
         * - 从侧栏 / 通知 / 深链打开一条会话 → 用户要看最新的 → bump（落底）；
         * - **切标签**（`keepScroll`）→ 那个面板从来没卸载过，用户可能正翻在上面读 →
         *   绝不能 bump。以前这里无条件 bump，表现就是「翻上去 → 点另一个标签 → 点回来，
         *   列表自己跳到底部」（用户报的）。
         */
        writeSlice(conversationId, (s) => ({
          ...s,
          touchedAt: Date.now(),
          scrollResetSeq: opts?.keepScroll ? s.scrollResetSeq : s.scrollResetSeq + 1,
        }));
        // 后台再静默刷一遍历史兜底（别的端可能改过这个会话）。
        // ⚠️ acp 例外：服务端历史恒为空，拉了会把内存里那份 transcript 回放**擦成空会话**
        //（切换走再切回来消息全没就是这个）—— 与 settleRound / runRound 收尾的豁免同一套
        // 道理：本地这份就是 ACP 会话的全部展示
        if (!existing.streaming && !existing.loading) {
          const convBackend = get().conversations.find(
            (c) => c.id === conversationId,
          )?.backend;
          if (convBackend !== "acp") void loadMessages(conversationId);
        }
        if (
          !get().runningConversations[conversationId] &&
          !existing.loading &&
          !existing.streaming
        ) {
          pump(conversationId);
        }
        pruneSlices(conversationId);
        return;
      }
      /**
       * 现场不在（首次打开 / 刷新后）：亮起「装载中」并走完整装载链路。装载窗口里
       * 消息区显示装载中而不是旧内容 —— 这个窗口若挂着别的会话的列表，用户在上面
       * 删除 / 编辑，拿的是旧消息 id 配新会话 id，服务端对不上就报错（实测踩过的坑）。
       */
      /** localStorage 缓存先顶上：服务端那份要等一个往返，不能让它拖住首帧 */
      void loadConversation(conversationId);
      pruneSlices(conversationId);
    },
    retryLoadMessages: () => {
      const id = get().activeConversationId;
      if (!id) return;
      writeSlice(id, (s) => ({
        ...s,
        loading: true,
        error: null,
      }));
      void loadConversation(id);
    },
    reloadAcpSession: async (conversationId) => {
      const conversation = get().conversations.find((c) => c.id === conversationId);
      if (conversation?.backend !== "acp") return false;
      const restored = await loadConversation(conversationId);
      if (!restored && readSlice(conversationId).error)
        get().setError(readSlice(conversationId).error!);
      return restored;
    },
    reloadConversation: (conversationId) => loadConversation(conversationId),
  };
}
