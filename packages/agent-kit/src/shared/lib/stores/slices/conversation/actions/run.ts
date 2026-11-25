/**
 * action 层：run。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import { ApiError } from "@fizz/agent-client/api";
import { errorMessage } from "@fizz/agent-kit/shared/lib/stores/shared";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createRunActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "send" | "steer" | "stop" | "stopConversation" | "stopCommand"
> {
  const { set, get, api, readSlice, writeSlice, markRunning, runRound, resolveConvId } =
    ctx;

  return {
    send: async (text, files, onStarted, scope) => {
      const trimmed = text.trim();
      if (!trimmed && !(files && files.length > 0)) return false;
      /**
       * 发到哪条会话**不能只看活跃会话**：主区域分屏时两个标签同时可见，非焦点标签的
       * 输入框也得发到它自己那条上（`scope` 由视图层（`agentAppFrom`）按标签传入）。
       * `scope === null` 是明确「新对话页」→ 建新会话，别回落到某个焦点会话。
       */
      const conversationId = resolveConvId(scope);
      // 这条会话正在跑 → 入队等待；否则立即开新一轮
      if (conversationId && get().runningConversations[conversationId]) {
        get().enqueueMessage(trimmed, files, conversationId);
        // 入队也是「发出去了」：内容已经落进界面上看得见的「待发送」列表，没被吃掉
        onStarted?.();
        return true;
      }
      /**
       * 兜底熄转圈：`runRound` 的每条出口都已收（建会话的 `done` / 守卫早退），这里
       * 再加一层 —— 转圈卡住比不转更糟（按钮一直不可点 = 输入框废了），宁可多熄一次。
       */
      try {
        return await runRound(trimmed, files, onStarted, scope);
      } finally {
        if (get().creatingConversation) set({ creatingConversation: false });
      }
    },
    /**
     * 运行中插话（steer）：活跃会话在跑 → 递给服务端收件箱（agent 下一个工具步骤
     * 边界注入当前轮，**附件一起注入**）；409（刚好跑完了）或没在跑 → 回落普通发送
     * —— 空闲时插话语义上就是发消息，附件照带，零损失。其余错误（网络 / 400）原样上抛提示。
     */
    steer: async (text, files, onStarted, scope) => {
      const trimmed = text.trim();
      const sendable = files ?? [];
      // 只带附件不写字也放行（与 send / enqueueMessage 同一口径）
      if (!trimmed && sendable.length === 0) return false;
      // 同上：分屏下插话也要落到本标签的会话，而不是焦点会话
      const conversationId = resolveConvId(scope);
      if (conversationId && get().runningConversations[conversationId]) {
        const api = get().getApi();
        if (api) {
          try {
            const { message } = await api.steer(
              conversationId,
              trimmed,
              sendable,
            );
            // 立刻出现在「插入中」列表（agent 消费时会随 user-injected 事件转正出列）
            writeSlice(conversationId, (s) => ({
              ...s,
              pendingSteers: [...s.pendingSteers, message],
            }));
            // 已经进了收件箱 = 发出去了（界面上看得见这条「插入中」）
            onStarted?.();
            return true;
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              // 恰好跑完了：按普通消息发送（见方法注释）
            } else {
              get().setError(errorMessage(err));
              return false;
            }
          }
        }
      }
      // 回落普通发送：附件照带（空闲插话 ≡ 发消息，图不能丢在这一步）
      return runRound(trimmed, sendable, onStarted, scope);
    },
    stop: async (scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      await get().stopConversation(conversationId);
    },

    stopConversation: async (conversationId: string) => {
      const current = readSlice(conversationId).request;
      if (!current) return;
      /**
       * 手动停止 = 自动续发到此为止：队列原样留着，等用户自己点「启动 / 发送下一条」。
       *
       * ⚠️ 必须**在 `await api.abort()` 之前同步掐住**：abort 会让服务端先关掉这条
       * SSE，`runRound` 的收场可能在下面 `current.controller.abort()` 执行前就走到
       * 「自然收尾」分支去 `pump()` —— 那一瞬间队列已经被顶上去了（随后这里再清
       * `request`，还会把新一轮的现场抹掉）。先落 `queuePaused`，`pump` 就地认得它。
       */
      if (readSlice(conversationId).queuedMessages.length > 0) {
        get().setQueuePaused(true, conversationId);
      }
      const api = get().getApi();
      // 先让服务端停下 Agent 循环，再断开 HTTP（顺序反了会留下孤儿循环）。
      // 服务端在 abort 时会把正等着的审批按拒绝解开（否则工具会卡到超时）
      if (current.id) await api?.abort(current.id).catch(() => undefined);
      current.controller.abort();
      writeSlice(conversationId, (s) => ({
        ...s,
        streaming: false,
        replaying: false,
        request: null,
        pendingConfirms: [],
        followupRequests: {},
        // ⚠️ 不清 `pendingSteers`（与 settleRound 同理）：服务端 abort 会把收件箱清空，
        // 这些插话已经不可能生效，但**内容是用户刚写的**，留在列表里让他能 ➤ 立刻发送
        // 或 ✕ 丢弃；直接清掉就等于把人写的东西弄没了。
        retryNotice: null,
        // 用户点了停止：圆环旁的实时估算一起收掉
        liveTps: null,
      }));
      markRunning(conversationId, false);
    },

    stopCommand: async (toolCallId: string, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      const current = readSlice(conversationId).request;
      // 没有在跑的轮 = 无从停（按钮本来也不该出现：没有 request.id）
      if (!current?.id) return;
      const api = get().getApi();
      // 幂等：没命中（命令已结束）就是空成功，静默即可 —— 不值得为它弹错误
      await api?.stopCommand(current.id, toolCallId).catch(() => undefined);
    },

  };
}
