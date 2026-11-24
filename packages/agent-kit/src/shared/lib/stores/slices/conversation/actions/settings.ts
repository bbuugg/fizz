/**
 * action 层：settings。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import type { AcpPermissionMode } from "@fizz/contracts/types";
import { resolveMaxSteps, resolveToolCallConcurrency } from "@fizz/contracts/agent-api";
import { savePermissionMode } from "@fizz/agent-kit/shared/lib/permission";
import {
  saveConfirmTimeout,
  saveMaxRetries,
  saveMaxSteps,
  saveSandboxMode,
  saveToolCallConcurrency,
  saveToolIntent,
} from "../storage";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createSettingsActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  | "setPermissionMode"
  | "setSandboxMode"
  | "setAcpPermissionMode"
  | "setConfirmTimeoutMin"
  | "setMaxRetries"
  | "setToolCallConcurrency"
  | "setMaxSteps"
  | "setToolIntent"
> {
  const { set, get, api, readSlice, resolveConvId } = ctx;

  return {
    setPermissionMode: (mode, scope) => {
      savePermissionMode(mode);
      set({ permissionMode: mode });
      /**
       * 运行中的轮也要立刻改活档：工具集一轮建一次，闸门靠 `getPermissionMode` 现取 ——
       * 服务端那次 POST 改的就是这一轮 run 上的字段，改完**下一次工具调用**就按新档裁决，
       * 不必等下一轮。没有在跑的轮就什么都不做（下一轮自然带上新档）。
       *
       * 改的是**本标签那条会话**正在跑的轮：分屏时两个标签各跑各的，按活跃会话改会把
       * 另一个标签的权限档悄悄换掉。
       */
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      const requestId = readSlice(conversationId).request?.id;
      const api = get().getApi();
      if (!requestId || !api) return;
      // 幂等：run 已结束 = 空成功，静默即可（不值得为它弹错误）
      void api.setChatPermission(requestId, mode).catch(() => undefined);
    },
    setSandboxMode: (mode) => {
      // 只影响**下一轮**：沙箱策略在工具集构建时随请求带给服务端，
      // 正在跑的那一轮已经装配完了（与权限档不同，它没有运行中改档端点）。
      saveSandboxMode(mode);
      set({ sandboxMode: mode });
    },
    setAcpPermissionMode: (mode, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return;
      // 乐观更新会话列表（权限 pill 读的是会话对象），失败回滚；服务端标脏后推权威快照
      const prev = get().conversations.find(
        (c) => c.id === conversationId,
      )?.acpPermissionMode;
      const apply = (value: AcpPermissionMode | undefined): void =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  acpPermissionMode: value === "allow" ? "allow" : undefined,
                }
              : c,
          ),
        }));
      apply(mode);
      const api = get().getApi();
      if (!api) return;
      void api
        .setConversationTarget(conversationId, {
          acpPermissionMode: mode === "allow" ? "allow" : null,
        })
        .catch(() => apply(prev));
    },
    setConfirmTimeoutMin: (minutes) => {
      const value =
        Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
      saveConfirmTimeout(value);
      set({ confirmTimeoutMin: value });
    },
    setMaxRetries: (value) => {
      const next = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
      saveMaxRetries(next);
      set({ maxRetries: next });
    },
    setToolCallConcurrency: (value) => {
      const next = resolveToolCallConcurrency(value);
      saveToolCallConcurrency(next);
      set({ toolCallConcurrency: next });
    },
    setMaxSteps: (value) => {
      const next = resolveMaxSteps(value);
      saveMaxSteps(next);
      set({ maxSteps: next });
    },
    setToolIntent: (value) => {
      saveToolIntent(value);
      set({ toolIntent: value });
    },
  };
}
