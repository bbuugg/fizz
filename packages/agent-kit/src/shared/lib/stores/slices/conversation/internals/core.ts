/**
 * 基础助手：会话现场的读写、模型目标的校验与记忆、会话参数持久化、队列与服务端同步。
 *
 * 刻意不依赖流式运行时（`run-loop`）—— 这条分层由依赖分析保证，改动时别打破，
 * 否则两者就成环、又只能合回一个文件。
 */
import type {
  AgentBackend,
  AgentChatMessage,
  AiReasoningEffort,
} from "@fizz/contracts/agent-api";
import type { AiModelEntry, CollabSettings, QueuedMessage } from "@fizz/contracts/types";
import { type BrowserSettings } from "@fizz/contracts";
import { loadLastTarget } from "@fizz/agent-kit/shared/lib/last-target";
import { errorMessage } from "@fizz/agent-kit/shared/lib/stores/shared";
import type { AcpProbeResult } from "@fizz/acp";
import { emptySlice, SLICE_KEEP } from "../state";
import type { ConvSlice, ScopedSettings } from "../types";
import type { ConvDeps } from "./context";

export function createConversationCore(deps: ConvDeps) {
  const { set, get, api } = deps;

  /**
   * 把动作的 `scope` 解析成真正的会话 id。**每一个会话级动作都从这里取 id**。
   *
   * - `undefined` → 活跃会话（旧行为，UI 焦点）；
   * - `null` → 「没有会话」（新对话页 → 建新会话，明确不回落焦点会话）；
   * - 有值 → 就是那条（分屏时视图层传自己标签的 id）。
   *
   * ## 为什么要收口成一个函数
   *
   * 「按活跃会话走」这个隐含默认值曾经散在 20 多个 action 里，分屏（两个标签同时可见）
   * 一上线就集体变成 bug：在非焦点标签发消息 / 换模型 / 删消息全作用到焦点会话上。
   * 现在默认值的解析只在这里——`scripts/check-conversation-scope.mjs` 会拦住
   * `actions/` 里任何一处裸读 `activeConversationId`，新写的动作没法再漏。
   */
  const resolveConvId = (scope: string | null | undefined): string | null =>
    scope === undefined ? get().activeConversationId : scope;

  /** 这条会话是不是**焦点**会话（唯一需要拿「焦点」做判断的地方：全局那份镜像归谁） */
  const isFocus = (conversationId: string | null): boolean =>
    !!conversationId && conversationId === get().activeConversationId;

  const readSlice = (conversationId: string | null): ConvSlice =>
    (conversationId && get().slices[conversationId]) || emptySlice();

  /**
   * 写某个会话的现场：patch 拿旧现场返回新现场。从 `get()` 的最新值出发计算，
   * 同一帧多次写同会话链式正确。
   */

  const writeSlice = (
    conversationId: string,
    patch: (s: ConvSlice) => ConvSlice,
  ): void => {
    const next = patch(get().slices[conversationId] ?? emptySlice());
    set((state) => ({ slices: { ...state.slices, [conversationId]: next } }));
  };

  /** 整个丢掉一个会话的现场（删除会话 / 断开连接用） */

  const dropSlice = (conversationId: string): void => {
    if (!(conversationId in get().slices)) return;
    set((state) => {
      const next = { ...state.slices };
      delete next[conversationId];
      return { slices: next };
    });
  };

  const pruneSlices = (keepId: string | null): void => {
    const entries = Object.entries(get().slices);
    if (entries.length <= SLICE_KEEP) return;
    const keep = new Set<string>();
    if (keepId) keep.add(keepId);
    for (const [id, s] of entries) {
      if (s.streaming || s.preparingSend || s.request || s.recoveryPhase || get().runningConversations[id])
        keep.add(id);
    }
    const rest = entries
      .filter(([id]) => !keep.has(id))
      .sort((a, b) => b[1].touchedAt - a[1].touchedAt);
    for (const [id] of rest.slice(0, Math.max(0, SLICE_KEEP - keep.size)))
      keep.add(id);
    const next: Record<string, ConvSlice> = {};
    for (const [id, s] of entries) if (keep.has(id)) next[id] = s;
    set({ slices: next });
  };

  /** 一份模型配置下可选的模型清单（老数据没有 models 时退回单个 model） */

  const catalogOf = (config: { models: AiModelEntry[] }): string[] =>
    config.models.map((model) => model.id);

  /**
   * 这个目标现在还能不能用：
   * - 内置：配置还在，且 `modelId` 仍在这份配置的模型清单里；
   * - acp：agent 还在（模型值由 agent 自己广告，本地清单里查不到也放行）。
   *
   * 「配置在但记的那个模型下架了」**不算还活着** —— 界面据此显示「选择模型」，
   * 而不是替用户挑一个清单里的别的模型。
   */

  const isTargetAlive = (
    target:
      | { backend: AgentBackend; configId?: string; modelId?: string }
      | null
      | undefined,
  ): boolean => {
    if (!target?.configId) return false;
    const { models, acpAgents } = get();
    if (target.backend === "acp")
      return acpAgents.some((a) => a.id === target.configId);
    const config = models.find((m) => m.id === target.configId);
    if (!config || !target.modelId) return false;
    return catalogOf(config).includes(target.modelId);
  };

  /**
   * 从会话记录里取出「它自己记住的模型」并校验：配置 / ACP agent 被删、模型下架
   * 一律返回 null（界面显示「选择模型」）—— **绝不回退到清单第一个**，
   * 那会让用户看到一个自己从没选过的模型。
   */

  const targetFromConversation = (conversation?: {
    backend?: AgentBackend;
    configId?: string;
    modelId?: string;
  }): { backend: AgentBackend; configId: string; modelId?: string } | null => {
    if (!conversation?.backend || !conversation.configId) return null;
    const target = {
      backend: conversation.backend,
      configId: conversation.configId,
      ...(conversation.modelId ? { modelId: conversation.modelId } : {}),
    };
    return isTargetAlive(target) ? target : null;
  };

  /**
   * 某个会话「自己的现场」：模型 / 思考强度 / MCP / 浏览器偏好。
   *
   * ## 为什么是「派生」，而不是「一份状态」
   *
   * 这四项以前是 store 上的四个裸字段，语义是「焦点会话的现场」——`openConversation`
   * 每开一个会话都按那个会话重写一遍。单标签时没问题（焦点即视图），主区域**分屏**时
   * 两个标签同时可见：非焦点那个的 composer 读的也是这份，于是点一下标签，两个标签的
   * 模型 pill（以及 MCP / 浏览器开关 / 思考强度）就一起变（用户报的 bug）。
   *
   * 现在**没有那份状态了**：会话的现场就是**会话清单项**上的字段 —— `persist*` 一律
   * 「先乐观改清单项、再发请求」，「刚改完还没落地」的中间态因此本来就在清单里，这里
   * 只是把它拆成 composer 要的形状。要写就写清单（`persistTarget` 等），没有第二份。
   *
   * ## 规则
   *
   * - `null`（新对话页）→ `draftSettings`：还没有会话，那份待定选择只活在内存里；
   * - 会话 → 清单项派生；清单里还没有它（刚建出来、清单没刷到）时同样退回草稿 ——
   *   那份选择正是建它用的，第一轮不能因为「清单慢半拍」变成「请先选择模型」。
   */
  const scopedSettingsOf = (conversationId: string | null): ScopedSettings => {
    const s = get();
    const conv = conversationId
      ? s.conversations.find((c) => c.id === conversationId)
      : undefined;
    if (!conv) return { ...s.draftSettings };
    return {
      chatTarget: targetFromConversation(conv),
      reasoningEffort: conv.reasoningEffort ?? null,
      mcpServerIds: conv.mcpServerIds ?? [],
      browserSettings: conv.browserSettings ?? null,
    };
  };

  /**
   * 新会话（空白页）的预选目标：只认「上次发送时用的模型」（localStorage，
   * 见 `lib/last-target.ts`）。没存过 / 校验不过就**什么都不选**，界面显示「选择模型」。
   *
   * **刻意排除 ACP**：ACP 的档位（模式 / 思考档）要起一次外部进程才问得到
   * （见 `probeDraftAcp`），而打开「开始新对话」页是高频动作 —— 预选 ACP 等于每次
   * 开新页都白起一个进程。用户真要 ACP 就在模型下拉里显式选，那时才探。
   * 上次用的是 ACP 会话时，空白页就什么都不预选。
   */

  const preferredTarget = (): {
    backend: AgentBackend;
    configId: string;
    modelId?: string;
  } | null => {
    const last = loadLastTarget();
    if (!last || last.backend === "acp") return null;
    return isTargetAlive(last) ? last : null;
  };

  /**
   * ACP 档位探针的进程内缓存：agentId → 探到的能力（或上次失败的原因）。
   *
   * ## 为什么需要
   *
   * 档位（模式 / 思考档）只有起一次 agent 进程问 `session/new` 才拿得到，一次几秒。
   * 原来只认 `draftAcp` 这一个槽位、且只判「同一个 agent 才复用」，所以**在几个外部
   * Agent 之间来回切每次都要重新转圈几秒**。缓存按 agent + 模型分开存，避免把一个
   * 模型的思考档挂到另一个模型上；切回已经探过的模型时仍然即时命中。
   *
   * ## 边界
   *
   * - **成功的条目永久有效**（本次会话内）：agent 的档位清单来自它自己的命令行参数 /
   *   配置文件，改完本来就得重启它；真要重问有 `reloadModels` 那条路。
   * - **失败的条目有 TTL**：agent 起不来常常是暂时性的（命令刚装上、端口刚腾出来），
   *   永久记住失败会让用户被迫重开整个页面。
   * - **正在飞的条目复用同一个 Promise**：连点两次下拉不会起两个进程。
   * - 不落盘：档位跟进程 / 环境走，跨启动未必还成立。
   */

  const draftAcpCache = new Map<
    string,
    | { ok: true; value: AcpProbeResult }
    | { ok: false; reason: string; at: number }
    | Promise<void>
  >();
  /** 失败条目多久后允许自动重试（也是用户「再点一次」能触发重探的时间） */

  const DRAFT_ACP_FAIL_TTL_MS = 60_000;

  /**
   * 探一次 ACP agent 的档位（模式 / 思考档）—— 新任务页在**建会话之前**就要把 pill 画出来。
   *
   * 幂等且**跨 agent 缓存**（见 `draftAcpCache`）：探过的 agent 再切回来立刻出数据，
   * 不重新起进程；正在探的复用同一个请求。失败只写 `error`，界面退化成「默认档」，
   * 不挡发送；失败的条目过了 TTL 才会重试。
   */

  const probeDraftAcp = async (agentId: string, modelId?: string): Promise<void> => {
    const current = get().draftAcp;
    const sameAgent = current?.agentId === agentId;
    const same = sameAgent && current.modelId === modelId;
    const key = JSON.stringify([agentId, modelId ?? null]);
    const matches = (draft: typeof current): boolean => draft?.agentId === agentId && draft.modelId === modelId;
    const seed = {
      agentId, ...(modelId ? { modelId } : {}), loading: true, error: null,
      modes: sameAgent ? current.modes : null,
      thoughtLevel: sameAgent ? current.thoughtLevel : null,
      mode: sameAgent ? current.mode : null,
      thought: sameAgent ? current.thought : null,
    };
    /** 只写仍在看这个 agent + 模型的草稿；迟到的旧响应不能覆盖新选择。 */
    const fill = (probe: AcpProbeResult): void => {
      set((state) =>
        matches(state.draftAcp) && state.draftAcp
          ? {
              draftAcp: {
                ...state.draftAcp,
                loading: false,
                error: null,
                modes: probe.modes,
                thoughtLevel: probe.thoughtLevel,
                mode: probe.modes?.available.some((o) => o.id === state.draftAcp?.mode) ? state.draftAcp.mode : null,
                thought: probe.thoughtLevel?.options.some((o) => o.value === state.draftAcp?.thought) ? state.draftAcp.thought : null,
              },
            }
          : state,
      );
    };

    const hit = draftAcpCache.get(key);
    if (!same) set({ draftAcp: seed });
    if (hit && !(hit instanceof Promise)) {
      if (hit.ok) {
        fill(hit.value);
        return;
      }
      // 失败缓存还在 TTL 内：不重新起进程，直接把上次的原因摆出来
      if (Date.now() - hit.at < DRAFT_ACP_FAIL_TTL_MS) {
        set((state) => matches(state.draftAcp) && state.draftAcp
          ? { draftAcp: { ...state.draftAcp, loading: false, error: hit.reason } } : state);
        return;
      }
      draftAcpCache.delete(key);
    }
    // 已经在飞 / 槽里已经是这个 agent 的成功结果：不必重探
    if (hit instanceof Promise) return hit;
    if (same && !current.loading && !current.error) return;

    set({
      draftAcp: seed,
    });
    const api = get().getApi();
    if (!api) {
      draftAcpCache.set(key, {
        ok: false,
        reason: "未连接服务端",
        at: Date.now(),
      });
      set((state) =>
        matches(state.draftAcp) && state.draftAcp
          ? {
              draftAcp: {
                ...state.draftAcp,
                loading: false,
                error: "未连接服务端",
              },
            }
          : state,
      );
      return;
    }
    /**
     * 把「这次探测」登记进缓存：成功存值、失败存原因 + 时间。同时在飞的 Promise 也占住
     * 槽位 —— 连点两次下拉时第二次直接返回，不重复起进程。
     */
    const run = (async (): Promise<void> => {
      try {
        const res = await api.probeAcpCapabilities(agentId, modelId);
        draftAcpCache.set(key, { ok: true, value: res });
        fill(res);
      } catch (err) {
        const reason = errorMessage(err);
        draftAcpCache.set(key, { ok: false, reason, at: Date.now() });
        set((state) =>
          matches(state.draftAcp) && state.draftAcp
            ? {
                draftAcp: {
                  ...state.draftAcp,
                  loading: false,
                  error: reason,
                },
              }
            : state,
        );
      }
    })();
    draftAcpCache.set(key, run);
    await run;
  };

  /** 标记某个会话「在跑 / 跑完」：侧栏转圈的唯一真源 */

  const markRunning = (conversationId: string, running: boolean): void => {
    set((state) => {
      if (running === !!state.runningConversations[conversationId])
        return state;
      const next = { ...state.runningConversations };
      if (running) next[conversationId] = true;
      else delete next[conversationId];
      return { runningConversations: next };
    });
  };

  const targetWrites = new Map<string, Promise<unknown>>();
  const targetRequests = new Map<string, symbol>();

  /**
   * 把模型选择持久化到会话；ACP 同步回传的能力，并在模型卡内报告失败。
   * 同时同步本地列表项 —— 会话摘要里带着 backend / configId / modelId，打开会话时要用来恢复。
   *
   * **清单先改、请求后发**（乐观）：分屏时非焦点标签的 pill 与「这一轮用哪个模型」都读
   * 清单里这条（`scopedSettingsOf` 派生），等往返回来再改会有一瞬按旧模型发送。
   */
  const persistTarget = (
    conversationId: string,
    target: {
      backend: AgentBackend;
      configId?: string;
      modelId?: string;
    } | null,
  ): void => {
    const api = get().getApi();
    if (!api) return;
    const request = Symbol();
    targetRequests.set(conversationId, request);
    if (target?.backend === 'acp') {
      writeSlice(conversationId, (slice) => ({ ...slice, acpConfigLoading: true, acpConfigError: null }));
    }
    const applyLocal = (): void => {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                backend: target?.backend,
                configId: target?.configId,
                modelId: target?.modelId,
              }
            : c,
        ),
      }));
    };
    applyLocal();
    const send = () => api.setConversationTarget(
        conversationId,
        target
          ? {
              backend: target.backend,
              configId: target.configId ?? null,
              modelId: target.modelId ?? null,
            }
          : { backend: null, configId: null, modelId: null },
      );
    // 同一会话的快速切换串行发出，服务端最终模型必须是用户最后一次选择。
    const previous = targetWrites.get(conversationId);
    const write = (previous ? previous.then(send, send) : send())
      .then((result) => {
        if (targetRequests.get(conversationId) !== request) return;
        const snapshot = result?.acpSessionState;
        if (snapshot) {
          set((state) => ({ conversations: state.conversations.map((c) =>
            c.id === conversationId && c.backend === target?.backend && c.configId === target?.configId && c.modelId === target?.modelId
              ? { ...c, acpModes: snapshot.modes ?? undefined, acpThoughtLevel: snapshot.thoughtLevel ?? undefined }
              : c
          ) }));
        }
      })
      .catch((error) => {
        if (targetRequests.get(conversationId) === request && target?.backend === 'acp') {
          writeSlice(conversationId, (slice) => ({ ...slice, acpConfigError: errorMessage(error) }));
        }
      })
      .finally(() => {
        if (targetRequests.get(conversationId) !== request) return;
        targetRequests.delete(conversationId);
        targetWrites.delete(conversationId);
        if (get().slices[conversationId]?.acpConfigLoading) {
          writeSlice(conversationId, (slice) => ({ ...slice, acpConfigLoading: false }));
        }
      });
    targetWrites.set(conversationId, write);
  };

  /** 把会话的思考强度持久化（fire-and-forget，同 persistTarget 的约定） */

  const persistReasoningEffort = (
    conversationId: string,
    effort: AiReasoningEffort | null,
  ): void => {
    const api = get().getApi();
    if (!api) return;
    const applyLocal = (): void => {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                ...(effort
                  ? { reasoningEffort: effort }
                  : { reasoningEffort: undefined }),
              }
            : c,
        ),
      }));
    };
    applyLocal();
    void api
      .setConversationTarget(conversationId, { reasoningEffort: effort })
      .then(applyLocal)
      .catch(() => undefined);
  };

  /**
   * 把「这个会话允许用哪些 MCP」持久化（fire-and-forget，与 persistTarget 同一套约定：
   * 失败不打扰，刷新时以服务端为准）。同时同步本地列表项 —— 会话摘要里带着 mcpServerIds，
   * 打开会话时要用来恢复。
   */

  const persistMcp = (conversationId: string, ids: string[]): void => {
    const api = get().getApi();
    if (!api) return;
    const applyLocal = (): void => {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, mcpServerIds: ids } : c,
        ),
      }));
    };
    applyLocal();
    void api
      .setConversationTarget(conversationId, { mcpServerIds: ids })
      .then(applyLocal)
      .catch(() => undefined);
  };

  /**
   * 把「这个会话的浏览器偏好」持久化（fire-and-forget，与 persistMcp 同一套约定：
   * 失败不打扰，刷新时以服务端为准）。同时同步本地列表项 —— 会话摘要里带着
   * `browserSettings`，切换会话 / 刷新后要用来恢复。
   *
   * 始终写**完整对象**（服务端 target 契约是整体语义）。
   */

  const persistBrowserSettings = (
    conversationId: string,
    settings: BrowserSettings,
  ): void => {
    const api = get().getApi();
    if (!api) return;
    const applyLocal = (): void => {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, browserSettings: settings } : c,
        ),
      }));
    };
    applyLocal();
    void api
      .setConversationTarget(conversationId, { browserSettings: settings })
      .then(applyLocal)
      .catch(() => undefined);
  };

  /** 拉某个会话的完整消息（列表接口刻意不带消息体）。结果写进**该会话自己的 slice** */

  const saveCollabSettings = async (
    settings: CollabSettings,
    scope?: string | null,
  ): Promise<boolean> => {
    const conversationId = resolveConvId(scope);
    const api = get().getApi();
    if (!conversationId || !api) return false;
    try {
      const updated = await api.saveCollabSettings(conversationId, settings);
      set({
        conversations: get().conversations.map((c) =>
          c.id === conversationId
            ? { ...c, kind: "collab", collab: updated.collab ?? settings }
            : c,
        ),
      });
      return true;
    } catch (err) {
      get().setError(errorMessage(err));
      return false;
    }
  };

  const cancelCollabTask = async (
    taskId: string,
    scope?: string | null,
  ): Promise<boolean> => {
    const conversationId = resolveConvId(scope);
    const api = get().getApi();
    if (!conversationId || !api) return false;
    try {
      const result = await api.cancelCollabTask(conversationId, taskId);
      return result.ok;
    } catch (err) {
      get().setError(errorMessage(err));
      return false;
    }
  };

  const fetchQueue = async (
    conversationId: string,
  ): Promise<QueuedMessage[] | null> => {
    const api = get().getApi();
    if (!api) return null;
    try {
      const { items } = await api.getConversationQueue(conversationId);
      return items;
    } catch {
      return null;
    }
  };

  /**
   * 把队列同步到服务端（**尽力而为**：失败只留本地缓存，绝不打断界面）。
   *
   * 每次变更都整份写（PATCH 是全量覆盖语义）—— 队列很短（几条短文本）、变更都是
   * 人肉触发的（加 / 删 / 编辑 / 拖完放手），不值得为它做 debounce 或增量协议。
   * 缓存在**本函数调用之前**就落好了，所以这里失败也只是「不跨端」，队列不丢。
   */

  const syncQueueToServer = (
    conversationId: string,
    items: QueuedMessage[],
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api.setConversationQueue(conversationId, items).catch(() => {
      // 服务端不可用（未连接 / 离线 / 5xx）：缓存已落好，静默即可
    });
  };

  /**
   * 把插话的顺序同步到服务端（**尽力而为**，与 `syncQueueToServer` 同一立场）。
   *
   * 与队列的差别：插话收件箱只活在服务端的活跃 run 上（没有 localStorage 那一层），
   * 所以失败（未连接 / 409 本轮已结束）时**保留本地的乐观顺序**即可 —— 真已经结束的话，
   * 这些插话马上会被 `user-injected` 转正出列，本轮没结束的下一帧也仍以服务端为准对齐。
   * 拖拽是 hover 即改、一次拖动会调很多次，但收件箱很短（几条短文本），不值得做 debounce。
   */

  const syncSteerOrder = (
    conversationId: string,
    items: AgentChatMessage[],
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .reorderSteers(
        conversationId,
        items.map((m) => m.id),
      )
      .catch(() => {});
  };

  /**
   * 改某个会话的队列：内存 slice + localStorage 缓存 + 服务端**三处一起落**。
   *
   * 顺序是先本地后服务端：本地立即可见（拖拽排序要跟手），服务端是尽力而为的
   * 补写（失败就只留本地缓存，见上面那个 helper 的说明）。
   */

  /**
   * 校验「这一轮要用的目标」还成立。
   *
   * `target` **必须**由调用方按会话给出（`scopedSettingsOf(id).chatTarget`）：store 上
   * 已经没有「当前会话的目标」可退，默认值一旦还留在那儿，分屏时校验的就是焦点会话的
   * 目标 —— 校验错的那条，然后带着错的目标发出去。
   */
  const guardTarget = (
    target: {
      backend: AgentBackend;
      configId?: string;
      modelId?: string;
    } | null,
  ): boolean => {
    if (isTargetAlive(target)) return true;
    /**
     * 悬空的目标顺手清掉，免得它一直挂在草稿页上。
     *
     * 只清草稿那份，且只在**确实是同一个目标**时清（按字段比，不按引用比：
     * `scopedSettingsOf` 每次都返回新对象，引用永远不相等）。会话的死目标不用清 ——
     * 视图读的是派生值，`targetFromConversation` 对它本来就返回 null。
     */
    const draft = get().draftSettings.chatTarget;
    if (
      target &&
      draft &&
      draft.backend === target.backend &&
      draft.configId === target.configId &&
      draft.modelId === target.modelId
    ) {
      set((state) => ({
        draftSettings: { ...state.draftSettings, chatTarget: null },
      }));
    }
    get().setError("请先在输入框上方选择模型（原来的配置或模型可能已被删除）");
    return false;
  };

  /**
   * 真正发起一轮对话（不含「进行中则入队」的判断）：把用户消息 + 空助手消息落本地、
   * 开 SSE、收流。本轮自然收尾后，把队列里的下一条顶上来接着跑。
   *
   * 返回 `true` = 这一轮**真的开跑了**；`false` = 还没发出去就被拦下（没连上 / 没选模型 /
   * 建会话失败）。调用方（`sendQueuedMessage` / `sendSteer`）据此把已经摘掉的条目放回去 ——
   * 拦下的那几种情况本来就同时给了错误提示，再把用户写的内容吃掉就更没道理了。
   */

  const waitConversationsLoaded = (): Promise<void> => {
    if (get().conversationsLoaded) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(finish, 15_000);
      const unsubscribe = api.subscribe((state) => {
        if (state.conversationsLoaded) finish();
      });
    });
  };

  /**
   * 打开会话后的历史装载：内置 拉服务端落盘存档 + acp 走 agent 侧 `session/load` 回放。
   * 从 `openConversation` 抽出，便于「加载失败 → 重试」复用同一段逻辑（重试不能再走
   * openConversation 的 id 去重早退）。失败统一写 slice 的 error，由消息列表展示错误 + 重试。
   */

  return {
    resolveConvId,
    isFocus,
    readSlice,
    writeSlice,
    dropSlice,
    pruneSlices,
    catalogOf,
    isTargetAlive,
    targetFromConversation,
    scopedSettingsOf,
    preferredTarget,
    draftAcpCache,
    DRAFT_ACP_FAIL_TTL_MS,
    probeDraftAcp,
    markRunning,
    persistTarget,
    persistReasoningEffort,
    persistMcp,
    persistBrowserSettings,
    saveCollabSettings,
    cancelCollabTask,
    fetchQueue,
    syncQueueToServer,
    syncSteerOrder,
    guardTarget,
    waitConversationsLoaded,
  };
}
