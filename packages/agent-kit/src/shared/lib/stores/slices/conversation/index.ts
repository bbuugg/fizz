/**
 * 对话 slice 的组装点。只做三件事：贴初始状态、把内部助手按层拼成 ctx、把叶子 action 展开成
 * `ConversationSlice`。
 *
 * 找逻辑请按「层」找：
 *   - 发一轮 / 收流 / 接回 → `internals/run-loop.ts`
 *   - 模型目标、会话参数持久化 → `internals/core.ts`
 *   - 点某个按钮做了什么 → `actions/*`
 *   - 类型 → `types.ts`
 */
import type { StateCreator } from "zustand";
import type { AgentStore } from "@fizz/agent-kit/shared/lib/stores/agent-store";
import type { ConversationSlice } from "./types";
import { createConversationCore } from "./internals/core";
import { createConversationRunLoop } from "./internals/run-loop";
import { createMessageOps } from "./internals/messages";
import { createLocalStateActions } from "./actions/local-state";
import { createTargetsActions } from "./actions/targets";
import { createSettingsActions } from "./actions/settings";
import { createStreamActions } from "./actions/stream";
import { createConversationOpenActions } from "./actions/conversation-open";
import { createConversationManageActions } from "./actions/conversation-manage";
import { createConversationForkActions } from "./actions/conversation-fork";
import { createQueueActions } from "./actions/queue";
import { createRunActions } from "./actions/run";
import { createApprovalsActions } from "./actions/approvals";
import { createContextActions } from "./actions/context";
import { emptyDraftSettings } from "./state";
import {
  loadActiveWorkspaceId,
  loadConfirmTimeout,
  loadMaxRetries,
  loadMaxSteps,
  loadSandboxMode,
  loadToolCallConcurrency,
  loadToolIntent,
} from "./storage";
import { loadPermissionMode } from "@fizz/agent-kit/shared/lib/permission";

// 对外导出的面与拆分前的 `conversation.ts` 完全一致，调用方的 import 路径不用动
export * from "./types";
export {
  loadActiveWorkspaceId,
  saveActiveWorkspaceId,
  loadActiveConversationId,
  saveActiveConversationId,
  clearActiveConversationId,
  loadBlankIntent,
} from "./storage";
export {
  NO_MESSAGES,
  NO_CONFIRMS,
  NO_QUEUE,
  NO_STEERS,
  NO_FOLLOWUPS,
  emptyDraftSettings,
  recoveryStatusText,
} from "./state";

export const createConversationSlice: StateCreator<
  AgentStore,
  [],
  [],
  ConversationSlice
> = (set, get, api) => {
  const deps = { set, get, api };
  const core = createConversationCore(deps);
  const runLoop = createConversationRunLoop({ ...deps, ...core });
  const messages = createMessageOps({ ...deps, ...core, ...runLoop });
  const ctx = { ...deps, ...core, ...runLoop, ...messages };

  return {
    // ---------- 状态 ----------
    slices: {},
    activeWorkspaceId: loadActiveWorkspaceId(),
    activeConversationId: null,
    // 会话的现场只有一份真源（清单项），全局只留「新对话页」这一份草稿
    draftSettings: emptyDraftSettings(),
    draftAcp: null,
    runningConversations: {},
    blankIntent: false,
    permissionMode: loadPermissionMode(),
    sandboxMode: loadSandboxMode(),
    confirmTimeoutMin: loadConfirmTimeout(),
    maxRetries: loadMaxRetries(),
    toolCallConcurrency: loadToolCallConcurrency(),
    maxSteps: loadMaxSteps(),
    toolIntent: loadToolIntent(),

    readSlice: ctx.readSlice,
    writeSlice: ctx.writeSlice,
    dropSlice: ctx.dropSlice,
    pruneSlices: ctx.pruneSlices,
    markRunning: ctx.markRunning,
    persistTarget: ctx.persistTarget,
    // 视图层按会话读「现场」（模型 / 思考强度 / MCP / 浏览器偏好）：从清单项派生，
    // 分屏时各读各的（见 types.ts 顶部的说明）
    scopedSettingsOf: ctx.scopedSettingsOf,
    probeDraftAcp: ctx.probeDraftAcp,
    loadMessages: ctx.loadMessages,
    handleFrame: ctx.handleFrame,
    attachRun: ctx.attachRun,
    loadConversation: ctx.loadConversation,
    pump: ctx.pump,
    runRound: ctx.runRound,
    ...createLocalStateActions(ctx),
    ...createTargetsActions(ctx),
    ...createSettingsActions(ctx),
    ...createStreamActions(ctx),
    ...createConversationOpenActions(ctx),
    ...createConversationManageActions(ctx),
    ...createConversationForkActions(ctx),
    ...createQueueActions(ctx),
    ...createRunActions(ctx),
    ...createApprovalsActions(ctx),
    ...createContextActions(ctx),
  };
};
