// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { Clock } from "lucide-react";
import { useCallback } from "react";
import { useConfirm } from "@fizz/agent-kit/shared/components/ConfirmProvider";
import { supportsTouch } from "@fizz/agent-kit/shared/lib/supports-touch";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type AgentChatMessage, type QueuedMessage } from "@fizz/contracts/types";
import { PendingSteerRows } from "@fizz/agent-kit/features/chat/PendingSteers";
import { QueuedRow } from "@fizz/agent-kit/features/chat/QueuedRow";
import { LIST_HEIGHT_CLASS } from "@fizz/agent-kit/features/chat/queue-list";
import { turnIsAcp } from "@fizz/agent-kit/features/chat/session-backend";

/**
 * 「待发送」：队列与插话**合成一张列表**（用户要求统一）。
 *
 * 两种状态共用同一个容器与标题，只是行的行为不同：
 * - **插话（在前）**：已经投递进当前轮收件箱，等下一个工具步骤边界生效。行上转圈直到
 *   agent 消费它；本轮结束时还没生效的，右侧换成 ➤ 可当新消息发出。
 * - **队列（在后）**：本轮结束后按顺序自动发送。行上的 ➤ 是「插话」——点它就把这条投到
 *   当前轮，投递期间转圈，成功后才从队列移出、出现在上面的插话区。
 *
 * 所以用户脑子里只有一件事：「待发送的东西都在这儿；想让某条立刻插进当前轮，点它的 ➤」。
 * 不用在发送时先选「队列 / 插话」。
 */
export function QueuedMessages({
  app,
  onEdit,
  onEditSteer,
}: {
  app: AgentApp;
  /** 点队列的「编辑」：把这条（文本 + 附件）写回输入框，由调用方负责移出队列 */
  onEdit: (item: QueuedMessage) => void;
  /** 点插话的「编辑」：写回输入框 + 撤回收件箱 + 记编辑态（见 ChatPanelInner） */
  onEditSteer?: (item: AgentChatMessage) => void;
}) {
  const t = useT();
  const steers = app.pendingSteers;
  const items = app.queuedMessages;
  const total = steers.length + items.length;
  const running = app.streaming;
  /** 本轮在跑且是内置会话：队列行的 ➤ 才能当插话投递（ACP 协议给不了收件箱） */
  const canInterject = running && !turnIsAcp(app);
  // 触屏上 HTML5 拖拽起不动：那些设备改由把手自己扛指针事件（见 QueuedRow / SortableRow）
  const canTouch = supportsTouch();
  const confirm = useConfirm();
  /**
   * 「清空队列」也要二次确认：它一次丢掉**全部**未发送的消息（含附件），且不可撤销 ——
   * 恰恰是那排里最容易误点的一个按钮（就挨着「继续发下一条」）。
   */
  const onClear = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t("清空队列里的 {count} 条消息？", { count: items.length }),
      description: t("这些都还没发出去，清空后就没了。"),
      confirmLabel: t("清空"),
      destructive: true,
    });
    if (ok) app.clearQueuedMessages();
  }, [app, confirm, items.length, t]);
  /**
   * ⚠️ 这个提前返回**必须放在所有 Hook 之后**。
   *
   * 之前它写在 `useConfirm` / `useCallback` 之前：队列从 0 条变 1 条时，这次渲染
   * 突然比上一次多跑了两个 Hook，React 直接抛 "Rendered more hooks than during the
   * previous render"；反过来删掉最后一条 / 点「编辑」把它移出队列时又少跑两个 Hook，
   * 抛 "Rendered fewer hooks than expected"。两者都没有 ErrorBoundary 兜底 ——
   * 整个应用白屏，刷新后队列已有数据、Hook 数从首帧就稳定，于是「刷新就正常」。
   * 功能上「没消息就什么都不渲染」不变，只是把返回挪到 Hook 后面。
   */
  if (total === 0) return null;
  return (
    <div className="flex flex-col border-b border-border px-3 py-2">
      <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" />
        <span className="min-w-0 flex-1">
          {t("待发送 · {count} 条", { count: total })}
        </span>
      </span>
      {/* 失败停链提示（spec §3）：上一轮失败后队列静默停住没人知道，这里把状态
        挑明，并把「继续 / 清空」两个决定递到用户手边 */}
      {app.queuePausedReason === "failed" && (
        <div className="mb-1 flex items-center gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <span className="min-w-0 flex-1 truncate">{t("上轮失败，队列已暂停")}</span>
          <button
            type="button"
            disabled={running}
            onClick={() => app.pump()}
            className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("继续发下一条")}
          </button>
          <button
            type="button"
            onClick={() => void onClear()}
            className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-destructive/15"
          >
            {t("清空队列")}
          </button>
        </div>
      )}
      {/*
        固定高度 + 内部滚动：条数再多也不顶高输入框。
        `overscroll-contain`：滚到边界时别把页面 / 消息列表一起牵着滚（手机上很明显）。
      */}
      <div
        className={cn(
          LIST_HEIGHT_CLASS,
          "overflow-y-auto overscroll-contain pr-0.5",
        )}
      >
        <PendingSteerRows app={app} onEdit={onEditSteer} />
        {items.map((item) => (
          <QueuedRow
            key={item.id}
            item={item}
            running={running}
            canInterject={canInterject}
            canTouch={canTouch}
            app={app}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}
