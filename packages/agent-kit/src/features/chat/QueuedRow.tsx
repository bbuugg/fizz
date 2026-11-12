// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { Loader2, Pencil, SendHorizontal, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useConfirm } from "@fizz/agent-kit/shared/components/ConfirmProvider";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { SortableRow } from "@fizz/agent-kit/shared/components/SortableRow";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type QueuedMessage } from "@fizz/contracts/types";
import { ExpandableRowText } from "@fizz/agent-kit/features/chat/ExpandableRowText";
import { RowIconButton } from "@fizz/agent-kit/features/chat/RowIconButton";

/**
 * 队列条目的拖拽类型。顺序 = 「本轮结束后依次发」的顺序。
 * 与 `STEER_ITEM_TYPE` 分开是刻意的：跨列表拖拽没有语义，靠类型让两张列表互不接受。
 */
const QUEUE_ITEM_TYPE = "queued-message";
/**
 * 队列里的一条：排序交互由 `SortableRow` 提供，这里只给本列表的正文与按钮。
 *
 * 正文**默认一行**：稍长的消息不能把整张列表撑到内容高度（输入框在手机上尤其挤）。
 * 溢出时正文可点，弹 Dialog 看全文（见 `ExpandableRowText`）。
 *
 * ➤ 的语义：**本轮在跑 = 插话**（递到当前轮收件箱，下一个工具步骤边界停下当前步骤后
 * 生效），没在跑 = 立刻开新一轮。投递期间按钮转圈、不可点 —— 等收件箱确认了才出队。
 */
export function QueuedRow({
  item,
  running,
  canInterject,
  canTouch,
  app,
  onEdit,
}: {
  item: QueuedMessage;
  running: boolean;
  /** 本轮在跑且是内置会话：➤ 才能当插话投递（ACP 协议给不了收件箱） */
  canInterject: boolean;
  /** 触屏设备：HTML5 拖拽起不动，改由把手自己扛 */
  canTouch: boolean;
  app: AgentApp;
  onEdit: (item: QueuedMessage) => void;
}) {
  const t = useT();
  /** 投递中：➤ 转圈，同一行的编辑 / 删除一并锁住（避免投递和改写撞在一起） */
  const [sending, setSending] = useState(false);
  const onSend = useCallback(async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    try {
      await app.sendQueuedMessage(item.id);
    } finally {
      setSending(false);
    }
  }, [app, item.id, sending]);
  /**
   * 删除前二次确认：队列里删掉的这条**不会再发出去**（内容不会落到别处），而队列常常
   * 攒着几条还没发的话 —— 误点一颗 × 就是一整条消息凭空没了，且没有任何撤销。
   * 确认框里带上正文前若干字，让人能确认自己删的是哪一条（队列项本身就一行截断）。
   */
  const confirm = useConfirm();
  const onRemove = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t("删除这条待发送消息？"),
      description: (
        <span className="whitespace-pre-wrap break-words">{item.text}</span>
      ),
      confirmLabel: t("删除"),
      destructive: true,
    });
    if (ok) app.removeQueuedMessage(item.id);
  }, [app, confirm, item.id, item.text]);
  return (
    <SortableRow
      id={item.id}
      dragType={QUEUE_ITEM_TYPE}
      canTouch={canTouch}
      moveTo={(draggedId, beforeId) =>
        app.moveQueuedMessage(draggedId, beforeId)
      }
    >
      <ExpandableRowText
        text={item.text}
        className="text-sm text-muted-foreground"
      />
      <RowIconButton
        onClick={() => void onSend()}
        disabled={sending || (running && !canInterject)}
        tip={
          sending
            ? t("正在插话…")
            : running
              ? canInterject
                ? t("插话：下一个工具步骤边界停下当前步骤后发出")
                : t("对话进行中，本轮结束后会自动发送")
              : t("立刻发送这一条")
        }
        label={running && canInterject ? t("插话这一条") : t("发送这一条")}
        className={cn(
          "shrink-0 rounded p-1 transition-colors",
          sending || (running && !canInterject)
            ? "cursor-not-allowed text-muted-foreground/50"
            : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        )}
      >
        {sending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <SendHorizontal className="size-3.5" />
        )}
      </RowIconButton>
      <RowIconButton
        onClick={() => {
          onEdit(item);
          app.removeQueuedMessage(item.id);
        }}
        disabled={sending}
        tip={t("编辑并写回输入框")}
        label={t("编辑并写回输入框")}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Pencil className="size-3.5" />
      </RowIconButton>
      <RowIconButton
        onClick={() => void onRemove()}
        disabled={sending}
        tip={t("删除")}
        label={t("删除")}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Trash2 className="size-3.5" />
      </RowIconButton>
    </SortableRow>
  );
}
