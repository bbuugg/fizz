/**
 * action 层：queue。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import type { QueuedMessage } from "@fizz/contracts/types";
import { ApiError } from "@fizz/agent-client/api";
import { textOf } from "@fizz/agent-kit/shared/lib/parts";
import { fileRefsOfParts } from "@fizz/agent-kit/shared/lib/attachments";
import { errorMessage, nextLocalId } from "@fizz/agent-kit/shared/lib/stores/shared";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createQueueActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "enqueueMessage" | "removeQueuedMessage" | "updateQueuedMessage" | "moveQueuedMessage" | "moveQueuedMessageBy" | "sendQueuedMessage" | "sendSteer" | "clearQueuedMessages" | "removeSteer" | "moveSteer" | "moveSteerBy"
> {
  const {
    get,
    api,
    readSlice,
    writeSlice,
    syncSteerOrder,
    patchQueue,
    runRound,
    resolveConvId,
  } = ctx;

  return {
    // ---------- 发一轮 ----------
    enqueueMessage: (text, files, scope) => {
      // 分屏时排队也要排到本标签的会话：`send` 会把本标签的会话 id 传进来
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      const item: QueuedMessage = {
        id: nextLocalId("q"),
        text,
        createdAt: Date.now(),
        ...(files && files.length > 0 ? { files } : {}),
      };
      patchQueue(conversationId, [
        ...readSlice(conversationId).queuedMessages,
        item,
      ]);
    },
    removeQueuedMessage: (id, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      patchQueue(
        conversationId,
        readSlice(conversationId).queuedMessages.filter((m) => m.id !== id),
      );
    },
    updateQueuedMessage: (id, text, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      patchQueue(
        conversationId,
        readSlice(conversationId).queuedMessages.map((m) =>
          m.id === id ? { ...m, text } : m,
        ),
      );
    },
    /**
     * 拖拽排序：把 `id` 这一条**挪到 `beforeId` 前面**（`beforeId` 为空 = 挪到最后）。
     *
     * 为什么收两个 id 而不是整个数组：拖拽时 react-dnd 的 `hover` 会连续触发，
     * 组件闭包里攥着的数组那时可能是旧的，让它自己算好下标再传过来等于按错的基准
     * 插。下标一律由这里从**最新的**队列里算。
     */
    moveQueuedMessage: (id, beforeId, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId || id === beforeId) return;
      const queue = readSlice(conversationId).queuedMessages;
      const from = queue.findIndex((m) => m.id === id);
      if (from < 0) return;
      const next = queue.slice();
      const [moved] = next.splice(from, 1);
      // 目标可能也被移走了：从**移完之后**的数组里找它的新位置
      const to = beforeId ? next.findIndex((m) => m.id === beforeId) : -1;
      next.splice(to < 0 ? next.length : to, 0, moved);
      patchQueue(conversationId, next);
    },
    /**
     * ↑ / ↓ 按钮微调（触屏设备拖不动，见 ChatPanel 的 QueuedRow）：`id` 这一条在队列里
     * 相对移动 `delta` 位（-1 = 往前提一位 = 更早发出）。越界（已是第一条 / 最后一条）不动。
     *
     * 为什么不复用 `moveQueuedMessage`：那是「挪到某一条前面」的语义，而「往下挪一位」
     * 得拿后一条反过来调它（`move(next.id, id)`），读起来反直觉。下标照样由这里从最新队列算。
     */
    moveQueuedMessageBy: (id, delta, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      const queue = readSlice(conversationId).queuedMessages;
      const from = queue.findIndex((m) => m.id === id);
      if (from < 0) return;
      const to = from + delta;
      if (to < 0 || to >= queue.length) return;
      const next = queue.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      patchQueue(conversationId, next);
    },
    /**
     * 发送队列里的一条：
     * - **本轮在跑** → 当插话递给服务端收件箱（下一个工具步骤边界停下当前步骤后注入，
     *   行上转圈直到生效）；成功后才把它移出队列、转进 `pendingSteers`；
     * - **本轮没跑** → 直接开新一轮（同以前的「立刻发送」）。失败时把它放回队尾。
     *
     * 返 `true` = 已经提交（入了收件箱或开了新一轮）；`false` = 被拦下（没连上 /
     * 服务端不接受），调用方据此收掉行上的转圈。
     */
    sendQueuedMessage: async (id, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return false;
      const queue = readSlice(conversationId).queuedMessages;
      const item = queue.find((m) => m.id === id);
      if (!item) return false;
      // 手动拍板要发：失败暂停的标记解除
      writeSlice(conversationId, (s) => ({ ...s, queuePausedReason: null }));

      /**
       * 跑着 → 插话。**先等投递结果再出队**：这样行上的转圈能一直转到收件箱确认，
       * 失败时条目原样留在队列里（用户不会看见「点了一下就没了」）。
       */
      if (get().runningConversations[conversationId]) {
        const api = get().getApi();
        if (!api) return false;
        try {
          const { message } = await api.steer(
            conversationId,
            item.text,
            item.files ?? [],
          );
          patchQueue(
            conversationId,
            readSlice(conversationId).queuedMessages.filter((m) => m.id !== id),
          );
          writeSlice(conversationId, (s) => ({
            ...s,
            pendingSteers: [...s.pendingSteers, message],
          }));
          return true;
        } catch (err) {
          // 409：投递到一半这一轮刚好结束。与 `steer` 同款回落，但先看队列泵有没有
          // 已经顶上别的消息 —— 有就让它继续留在队列里按序发，别再并发开一轮。
          if (err instanceof ApiError && err.status === 409) {
            if (get().runningConversations[conversationId]) return true;
            if (
              !readSlice(conversationId).queuedMessages.some((m) => m.id === id)
            )
              return true;
            patchQueue(
              conversationId,
              readSlice(conversationId).queuedMessages.filter((m) => m.id !== id),
            );
            void get()
              .runRound(item.text, item.files, undefined, conversationId)
              .then((started) => {
                if (!started) {
                  patchQueue(conversationId, [
                    ...readSlice(conversationId).queuedMessages,
                    item,
                  ]);
                }
              });
            return true;
          }
          get().setError(errorMessage(err));
          return false;
        }
      }

      // 没在跑：立刻开新一轮（先出队，失败再放回队尾）
      patchQueue(
        conversationId,
        queue.filter((m) => m.id !== id),
      );
      const started = await get().runRound(
        item.text,
        item.files,
        undefined,
        conversationId,
      );
      if (!started) {
        patchQueue(conversationId, [
          ...readSlice(conversationId).queuedMessages,
          item,
        ]);
      }
      return started;
    },
    /**
     * 立刻发送一条还没发出去的插话（行的 ➤）：与 `sendQueuedMessage` 同款 ——
     * 只有本轮不在跑时才可点（跑着时那颗钮是禁用的），把这条从「插入中」列表摘掉，
     * 再**按普通消息起新一轮**（文本 + 附件一起带走）。
     *
     * 为什么不是「让它立刻在边界生效」：收件箱只活在活跃 run 上。能点到这颗钮就说明
     * 那一轮已经结束了（用户停止 / 报错 / 断线），服务端早没有这条插话了 —— 此时唯一
     * 有意义的动作就是把它当新消息发出去。剩下的遗留条目会在 `runRound` 里转入待发送队列。
     */
    sendSteer: (messageId, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId || get().runningConversations[conversationId]) return;
      const item = readSlice(conversationId).pendingSteers.find(
        (m) => m.id === messageId,
      );
      if (!item) return;
      const text = textOf(item);
      const files = fileRefsOfParts(item.parts);
      if (!text && files.length === 0) return;
      writeSlice(conversationId, (s) => ({
        ...s,
        pendingSteers: s.pendingSteers.filter((m) => m.id !== messageId),
      }));
      void get()
        .runRound(text, files, undefined, conversationId)
        .then((started) => {
          // 没能开跑（没选模型 / 没连上…）：把它放回列表，别让用户刚写的话凭空消失
          if (!started) {
            writeSlice(conversationId, (s) => ({
              ...s,
              pendingSteers: [...s.pendingSteers, item],
            }));
          }
        });
    },
    /** 清空待发送队列（一并解除失败暂停的标记；服务端那份同步覆盖为空） */
    clearQueuedMessages: (scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      writeSlice(conversationId, (s) => ({ ...s, queuePausedReason: null }));
      patchQueue(conversationId, []);
    },
    removeSteer: async (messageId, scope) => {
      const conversationId = resolveConvId(scope);
      const api = get().getApi();
      if (!api || !conversationId) return;
      try {
        await api.removeSteer(conversationId, messageId);
      } catch {
        // 409（刚好跑完）/ 网络错误：本地照移 —— 收件箱是真源，后续 user-injected
        // 不来就说明确实没消费，消息也不在了
      }
      writeSlice(conversationId, (s) => ({
        ...s,
        pendingSteers: s.pendingSteers.filter((m) => m.id !== messageId),
      }));
    },
    /**
     * 重排插话：把 `messageId` 挪到 `beforeId` 前面（`beforeId` 为空 = 挪到最后）。
     *
     * 与队列的 `moveQueuedMessage` 同款：下标一律从**最新的**数组里算 —— 拖拽时 react-dnd
     * 的 `hover` 会连续触发，组件闭包里攥着的数组那时可能是旧的，让它自己算等于按错基准插。
     */
    moveSteer: (messageId, beforeId, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      const list = readSlice(conversationId).pendingSteers;
      const from = list.findIndex((m) => m.id === messageId);
      if (from < 0) return;
      const next = list.slice();
      const [moved] = next.splice(from, 1);
      // 目标可能也被移走了：从**移完之后**的数组里找它的新位置
      const to = beforeId ? next.findIndex((m) => m.id === beforeId) : -1;
      next.splice(to < 0 ? next.length : to, 0, moved);
      writeSlice(conversationId, (s) => ({ ...s, pendingSteers: next }));
      syncSteerOrder(conversationId, next);
    },
    /**
     * ↑ / ↓ 按钮微调（触屏拖不动，见 ChatPanel 的 SortableRow）：这条相对挪 `delta` 位
     * （-1 = 往前提一位 = 更早生效）。越界（已是第一条 / 最后一条）不动。
     */
    moveSteerBy: (messageId, delta, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      const list = readSlice(conversationId).pendingSteers;
      const from = list.findIndex((m) => m.id === messageId);
      if (from < 0) return;
      const to = from + delta;
      if (to < 0 || to >= list.length) return;
      const next = list.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      writeSlice(conversationId, (s) => ({ ...s, pendingSteers: next }));
      syncSteerOrder(conversationId, next);
    },
  };
}
