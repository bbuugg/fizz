/**
 * action 层：stream。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import { reconnectNudges } from "../reconnect";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createStreamActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "reconnectRun" | "reconcileDroppedRun"
> {
  const { loadConversation, reconcileDroppedRound } = ctx;

  return {
    /**
     * 重接一条进行中的对话：用户点消息区「连接中断」条上的按钮、或页面从后台回来时调。
     * 共用恢复流程补齐历史，现有订阅与占位由 attachRun 复用，不另开一条流。
     *
     * 已经在重接中（退避睡眠还没醒）时，把那个睡眠**提前唤醒**：退避 sleep 一醒循环
     * 立刻重试，等于 "立即重连" 真的立即。以前做不到这一点 —— attachRun 对「正在接」
     * 的会话直接去重早退，按钮点下去石沉大海。
     */
    reconnectRun: (conversationId: string) => {
      reconnectNudges.get(conversationId)?.();
      return loadConversation(conversationId, { resetScroll: false });
    },
    /**
     * 对账一个「断线失败」的轮次：拉服务端权威历史，它确实存下了这一轮就用它替换本地
     * 那条网络错误。页面回前台 / 网络恢复时调（那时网络才刚通，第一次往往拉不到）。
     */
    reconcileDroppedRun: (conversationId: string) =>
      reconcileDroppedRound(conversationId),
  };
}
