// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { type ReactNode } from "react";
import { supportsTouch } from "@fizz/agent-kit/shared/lib/supports-touch";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { type AgentChatMessage } from "@fizz/contracts/types";
import { SteerRow } from "@fizz/agent-kit/features/chat/SteerRow";

/**
 * 「待发送」列表里的插话行（与队列行同属一张列表，见 `QueuedMessages`）。
 *
 * 插话 = 已经投递进当前轮收件箱、等下一个工具步骤边界生效的消息。行上的 loading 从
 * 投递确认一直持续到 agent 消费它（`user-injected` 事件把它转正进会话流、从这里出列）。
 * 本轮结束时仍留在列表里的（停止 / 报错 / 断线）是没生效的插话，右侧换成 ➤ 可当新消息发出。
 *
 * 这里**不画标题、不画滚动容器**：标题与滚动区域由外层的统一列表负责，避免队列和插话
 * 各有一块头、看起来像两套东西。
 */
export function PendingSteerRows({
  app,
  onEdit,
}: {
  app: AgentApp;
  /** 点「编辑」：把整条交给调用方（写回输入框 + 撤回收件箱 + 记编辑态）；不传则不渲染 ✎ */
  onEdit?: (item: AgentChatMessage) => void;
}): ReactNode {
  if (app.pendingSteers.length === 0) return null;
  // 排序能力判定与队列一致：触屏上 HTML5 拖拽起不动，那些设备由把手自己扛指针事件
  const canTouch = supportsTouch();
  const running = app.streaming;
  return (
    <>
      {app.pendingSteers.map((item) => (
        <SteerRow
          key={item.id}
          item={item}
          canTouch={canTouch}
          running={running}
          app={app}
          onEdit={onEdit}
        />
      ))}
    </>
  );
}
