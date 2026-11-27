/**
 * action 层：targets。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 *
 * ## 这四项只有一份真源：会话清单项
 *
 * 模型 / 思考强度 / MCP / 浏览器偏好都落在会话清单那条上（`persist*` 一律「先乐观改
 * 清单项、再发请求」），`scopedSettingsOf` 只是把清单项拆成 composer 要的形状。全局只
 * 剩草稿页（还没有会话时）那一份 `draftSettings`。
 *
 * `scope` 约定（全 store 统一）：
 * - 不传 → 旧行为，作用于 `activeConversationId`；
 * - `null` → 明确「新对话页」，只写 `draftSettings`，不落任何会话；
 * - 会话 id → 作用于那个会话（乐观改写它的清单项 + 落盘）。
 *
 * 写错的代价是用户报过的那个 bug：分屏时在 B 标签选模型，A（焦点）会话的待发目标
 * 被一起改掉，两个 composer 的 pill 同步变。
 */
import {
  DEFAULT_BROWSER_SETTINGS,
  type BrowserSettings,
} from "@fizz/contracts";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice, ScopedSettings } from "../types";

export function createTargetsActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "setReasoningEffort" | "setChatTarget" | "setDraftAcpMode" | "setDraftAcpThought" | "clearDraftAcp" | "setMcpServerIds" | "setBrowserSettings"
> {
  const { set, get, probeDraftAcp, scopedSettingsOf, resolveConvId, persistTarget, persistReasoningEffort, persistMcp, persistBrowserSettings } = ctx;

  /** 写草稿页那份待定选择（只在还没有会话时用） */
  const writeDraft = (patch: Partial<ScopedSettings>): void => {
    set((state) => ({ draftSettings: { ...state.draftSettings, ...patch } }));
  };

  /**
   * 浏览器偏好的合并基线：草稿页用草稿里那份，会话用该会话落盘的配置。
   *
   * 调用方只给要改的那一项（如只翻总开关），这里补上其余字段再整体落库 ——
   * 服务端的 target 契约是整体对象语义，缺字段会被当成"清空"。
   */
  const browserBase = (conversationId: string | null): BrowserSettings =>
    (conversationId
      ? scopedSettingsOf(conversationId).browserSettings
      : get().draftSettings.browserSettings) ?? DEFAULT_BROWSER_SETTINGS;

  return {
    setReasoningEffort: (effort, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) {
        writeDraft({ reasoningEffort: effort });
        return;
      }
      persistReasoningEffort(conversationId, effort);
    },
    setChatTarget: (target, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) {
        writeDraft({ chatTarget: target });
      } else {
        // persist* 会先乐观改清单：下拉 / pill 立刻生效，不用等往返
        persistTarget(conversationId, target);
        // 已有会话直接由 target 接口应用模型并回传能力，不启动无关的草稿探针。
        return;
      }
      /**
       * 新任务页（还没有会话）：切到 ACP 就顺手探一次档位，切回内置 agent 就把草稿清掉。
       * 已有会话时不探 —— 会话自己带着 `acpModes` / `acpThoughtLevel`，再探一次纯属白起
       * 一个进程。
       *
       * 同一个 agent 换模型也要按模型读取能力；仍有效的选择由探针合并保留。
       */
      if (target?.backend === "acp" && target.configId)
        void probeDraftAcp(target.configId, target.modelId);
      else if (get().draftAcp) set({ draftAcp: null });
    },
    setDraftAcpMode: (modeId) => {
      set((state) =>
        state.draftAcp && !state.draftAcp.loading && !state.draftAcp.error &&
          (modeId === null || state.draftAcp.modes?.available.some((mode) => mode.id === modeId))
          ? { draftAcp: { ...state.draftAcp, mode: modeId } }
          : state,
      );
    },
    setDraftAcpThought: (value) => {
      set((state) =>
        state.draftAcp && !state.draftAcp.loading && state.draftAcp.thoughtLevel?.options.some((o) => o.value === value)
           ? { draftAcp: { ...state.draftAcp, thought: value } }
          : state,
      );
    },
    clearDraftAcp: () => {
      if (get().draftAcp) set({ draftAcp: null });
    },
    setMcpServerIds: (ids, scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) {
        writeDraft({ mcpServerIds: ids });
        return;
      }
      persistMcp(conversationId, ids);
    },
    setBrowserSettings: (patch, scope) => {
      const conversationId = resolveConvId(scope);
      const next: BrowserSettings = {
        ...browserBase(conversationId),
        ...patch,
      };
      if (!conversationId) {
        writeDraft({ browserSettings: next });
        return;
      }
      persistBrowserSettings(conversationId, next);
    },
  };
}
