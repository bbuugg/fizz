/**
 * 流式运行时：接流 / 收帧 / 断线重接 / 轮次对账 / 跑完一轮。
 *
 * ⚠️ 这里十个函数是**互递归**的（`runRound → attachRun → handleFrame → pump → runRound`），
 * 硬拆只会得到一堆循环 import。「一轮对话推进到哪了」的全部状态机就收在这一个文件里。
 */
import type {
  AgentChatMessage,
  AgentConversation,
  ChatRunSummary,
  ChatStreamFrame,
  UploadFileRef,
} from "@fizz/contracts/agent-api";
import type { QueuedMessage } from "@fizz/contracts/types";
import { assistantSliceId, buildUserParts } from "@fizz/contracts/agent-api";
import {
  applyEvent,
  textOf,
  truncateToLastSettledTool,
} from "@fizz/agent-kit/shared/lib/parts";
import { fileRefsOfParts } from "@fizz/agent-kit/shared/lib/attachments";
import { createFrameBatcher } from "@fizz/agent-kit/shared/lib/frame-batch";
import {
  dispatchProjectUiAction,
  uiActionsFromEvent,
} from "@fizz/agent-kit/shared/lib/tool-actions";
import { httpStatusOf } from "@fizz/agent-client/api";
import { saveLastTarget } from "@fizz/agent-kit/shared/lib/last-target";
import { errorMessage, nextLocalId } from "@fizz/agent-kit/shared/lib/stores/shared";
import { saveQueue } from "../storage";
import { subscribing, reconciling, sleep, sleepReconnect } from "../reconnect";
import { isSteerAssistant } from "../state";
import { applyCollabEvent } from "../collab";
import type { ConvCore } from "./context";

export function createConversationRunLoop(ctx: ConvCore) {
  const {
    set,
    get,
    api,
    readSlice,
    writeSlice,
    markRunning,
    persistTarget,
    syncQueueToServer,
    guardTarget,
    waitConversationsLoaded,
    // 「这条会话是不是焦点」只从这两个助手取，别在这里裸读 activeConversationId
    // （`scripts/check-conversation-scope.mjs` 会拦）
    resolveConvId,
    isFocus,
  } = ctx;

  const attachRun = async (
    conversationId: string,
    opts?: { requestId?: string; assistantId?: string },
  ): Promise<boolean> => {
    const api = get().getApi();
    if (!api || !conversationId) return false;
    const resume =
      opts?.requestId && opts.assistantId
        ? { requestId: opts.requestId, assistantId: opts.assistantId }
        : null;
    // 已经有个循环在接这条会话（自动重接的退避睡眠还没醒 / 正接着）：别重复接 ——
    // 多一条空占位消息是小事，`handleFrame` 是追加式的，回放帧追加两遍会让正文重复
    if (!resume && subscribing.has(conversationId)) return true;
    subscribing.add(conversationId);
    try {
      let requestId = resume?.requestId ?? "";
      /** `GET /api/chat/active` 探到的这条 run（resume 路径不探：调用方把 id 都给全了） */
      let probed: ChatRunSummary | null = null;
      if (!requestId) {
        try {
          const { run } = await api.activeRun(conversationId);
          if (!run) return false;
          requestId = run.requestId;
          probed = run;
        } catch (err) {
          get().setError(errorMessage(err));
          return false;
        }
      }

      /**
       * 占位消息：服务端落盘的历史里还没有这条助手消息，回放的帧要往它上面追加。
       * 本地已经挂着这一轮的占位（断线续接 / 断线重连）就**复用**，别再 push 一条空的 ——
       * 否则消息列表里会并排出现两条空助手消息。
       */
      const live = readSlice(conversationId);
      const reuseId =
        live.request?.assistantId &&
        live.messages.some((m) => m.id === live.request!.assistantId)
          ? live.request.assistantId
          : null;
      /**
       * id 优先级：本轮自己传的 > 本地已在的同轮占位 > **run 上记的**（发起那一轮的客户端
       * 递上来的）> 现生成。
       *
       * 第三档是「刷新页面 / 另一个标签页接手一条已经在跑的 run」：本地没有占位（历史里还
       * 没这条消息），只能问 run —— 服务端落盘用的就是它，占位沿用同一个 id，收尾换权威
       * 历史时这回放出来的正文才不会整棵重挂载。缺省（老客户端没传）退回自生成，行为同以前。
       */
      const assistantId =
        resume?.assistantId ??
        reuseId ??
        probed?.assistantMessageId ??
        nextLocalId("a");
      /**
       * 占位与否只看「本地**真的**有没有这条助手消息」，不看「调用方传没传 resume」。
       *
       * 曾经写的是 `!reuseId && !resume?.assistantId`，隐含假设「传了 resume 就一定已经有
       * 本地占位」—— 断线续接那条路成立，但**刷新页面**不成立：ACP 会话刷新时本地消息
       * 是空的（进程内快照还会把本轮助手消息摘掉，见 transcript 路由），于是占位不建、
       * 回放的帧在 `handleFrame` 里找不到落点（`liveIndex < 0` 直接返回），整轮正文被
       * 静默丢掉 —— 表现就是「跑到一半刷新，回复不见了，再刷也还是没有」。
       * 服务端那一轮照旧跑完并写进快照，只有刷新到「已跑完」那一刻才靠 `session/load` 补回来。
       */
      const needPlaceholder = !live.messages.some((m) => m.id === assistantId);
      writeSlice(conversationId, (s) => ({
        ...s,
        messages: needPlaceholder
          ? [
              ...s.messages,
              {
                id: assistantId,
                role: "assistant",
                parts: [],
                createdAt: Date.now(),
              },
            ]
          : s.messages,
        streaming: true,
        pendingConfirms: [],
        followupRequests: {},
        retryNotice: null,
        reconnectNotice: null,
        // 作废在途的消息加载：从现在起本地这份「回放现场」是真源
        loadGen: s.loadGen + 1,
        request: s.request
          ? { ...s.request, id: requestId, assistantId }
          : { id: requestId, controller: new AbortController(), assistantId },
      }));
      const controller = readSlice(conversationId).request!.controller;
      // 接回正在跑的会话：侧栏转圈要亮起来（哪怕这不是当前打开的会话）
      markRunning(conversationId, true);

      let attempt = 0;
      for (;;) {
        /**
         * 每次（重）接入前先把占位清空：回放是从帧日志**头部**开始的，清空后回放出来的
         * parts 与断线前完全一致（服务端 `compactFrames` 只合并不丢帧，见
         * `lib/server/chat-run.ts`）。不清就会把断线前那截又追加一遍，正文重复。
         */
        writeSlice(conversationId, (s) => ({
          ...s,
          // 插话拆分出的后继助手（`assistantSliceId()` 的形状，见 contracts）也是这一轮的
          // 占位：回放会从帧日志头部重建整轮（含 user-injected 的拆分），不清会把
          // 后继段里已有的 parts 又追加一遍
          messages: s.messages.map((m) =>
            isSteerAssistant(m, assistantId) ? { ...m, parts: [] } : m,
          ),
          /**
           * 从这一刻到 `replay-end` 帧之间就是「回放窗口」：内容先塌（上面的清空）
           * 后长（逐帧重建）。`MessageList` 据此把滚动跟随降级成瞬时贴底 —— 否则内容
           * 一长高，库的 spring 就带着视口从上面一路滚下来（用户实测反馈的「列表像在
           * 重新加载、一直从顶部往下滚」）。放在**清空的那一次写入**里，与清空同帧生效。
           */
          replaying: true,
        }));

        /**
         * 这一条连接的帧合批器（见 `lib/frame-batch.ts`）。
         *
         * ⚠️ **必须每次重连各建一个**：上一轮缓冲里的残留不能跨连接漏到下一轮 ——
         * 下一轮开头刚把这一轮的 parts 清空，漏一帧过去就是「回放重建完又被追加一遍」。
         */
        const batch = createFrameBatcher((frame) =>
          handleFrame(conversationId, assistantId, frame),
        );

        try {
          /**
           * 「真的接上了」的信号 = 收到第一个帧（回放从帧日志头部开始，第一帧一定是
           * start 帧）。这一刻就把「连接中断」提示撤掉 —— 以前只有整轮收尾
           * （`settleRound`）才清它，于是重连成功后那条提示会一直挂到本轮结束，
           * 观感就是「已经连上了，提示却不消失」，点「立即重连」也不管用。
           */
          let reconnected = false;
          await api.attachRun(
            requestId,
            (frame) => {
              if (!reconnected) {
                reconnected = true;
                writeSlice(conversationId, (s) =>
                  s.reconnectNotice ? { ...s, reconnectNotice: null } : s,
                );
              }
              batch.push(frame);
            },
            controller.signal,
          );
          // 流关了：先把缓冲里的尾巴落干净再收场，别让最后几帧等 16ms 的定时器
          batch.flush();
          // 流正常关闭 = 收到过 end 帧（服务端把已结束的 run 回放完也会直接 close）
          settleRound(conversationId, controller.signal);
          return true;
        } catch (err) {
          /*
           * 断线也要先把已收到的帧落干净：用户看到的应该是「停在这一刻」，
           * 而不是回退到几帧之前（缓冲里那些帧还没写进 store）。
           */
          batch.flush();
          // 用户点了「停止」（或睡眠期间点了）：这条流是我们自己断的，照常收场
          if (controller.signal.aborted) {
            settleRound(conversationId, controller.signal);
            return true;
          }
          const status = httpStatusOf(err);
          // 401：token 失效（api 层已顺手触发登出收场）。别重接 —— 越重越乱，
          // 也不写本地现场，`disconnect` 会把 slice 全清掉
          if (status === 401) {
            get().setError(errorMessage(err));
            return true;
          }
          /**
           * 404：run 已经结束并被清理（断线期间跑完了，或 retention 过了）。
           * 这一轮就是结束了 —— 照常收场拉权威历史。以前这里会抛成网络错误，
           * 把 `streaming` 永久留在 true、侧栏一直转圈，用户只能刷新页面。
           */
          if (status === 404) {
            settleRound(conversationId, controller.signal);
            return true;
          }
          /**
           * 其余就是**连接断了**（fetch reject / 流读到一半断），而服务端那轮大概率
           * 还在跑：run 的生命周期不挂在客户端连接上（POST /api/chat 一断，服务端照样
           * 把这一轮跑完并落盘，见 `app/api/chat/route.ts` 顶部）。页面切到后台
           * （标签页冻结 / 电脑休眠 / 网络切换）时 SSE 断得最勤，而这正是任务还在跑的时候。
           *
           * 确认它还活着就退避重接；确认不了（服务端也没这条 run 了）才收场。
           * 以前这里直接把错误抛成「网络错误」，用户只能刷新整页才能接回现场。
           */
          const alive = await peekActiveRun(conversationId);
          if (!alive || alive.requestId !== requestId) {
            settleRound(conversationId, controller.signal);
            return true;
          }
          attempt += 1;
          /**
           * 把**真实原因**打出来。
           *
           * 这条提示以前只报「断了」，排查时看不到到底为什么断（服务端断开 / 客户端帧处理
           * 抛错 / 桥的异常全都长得一样）。`readSseFrames` 已经把「帧处理异常」挡在连接之外
           * （见那里的注释），所以正常情况这里只该出现真正的传输错误；一旦又出现，日志里
           * 这一行就是线索。
           */
          console.warn(
            `[chat] 会话 ${conversationId} 的流断了（第 ${attempt} 次重连，status=${status ?? "无"}）：`,
            err,
          );
          writeSlice(conversationId, (s) => ({
            ...s,
            reconnectNotice: { attempt },
          }));
          await sleepReconnect(conversationId, attempt);
        }
      }
    } finally {
      subscribing.delete(conversationId);
    }
  };

  /**
   * 等会话清单第一次成功落地（`conversationsLoaded` 置位；workspaces 与它同一次
   * refresh() 写入，到位即同时到位）。
   *
   * 刷新后的深链走「乐观打开」：清单还没到，深链 effect 就先 openConversation 了。
   * 此时 loadConversation 里的 convMeta / workspaces 查找全是空 —— ACP 的 transcript
   * 回放会被静默跳过（界面就是一个空会话，观感即「消息全没了，成了新会话」），
   * chatTarget 也恢复不了。清单到位后这些查找才有意义。
   *
   * 超时兜底：服务端一直不可达时直接放行，流程按「清单拉不到」的原样收场
   * （loadMessages 已经写过错误态，界面上有重试按钮）。
   */

  const handleFrame = (
    conversationId: string,
    assistantId: string,
    frame: ChatStreamFrame,
  ): void => {
    if (frame.type === "start") {
      // 回放 / 服务端确认的 requestId 落回当前轮（stop 用它调 /api/chat/abort）
      writeSlice(conversationId, (s) => ({
        ...s,
        request: s.request ? { ...s.request, id: frame.requestId } : s.request,
      }));
      return;
    }
    // confirm 模式下要执行破坏性操作：服务端在此**停住等答复**，
    // 我们把它渲染成一张卡，用户点一下再 POST 回去
    if (frame.type === "confirm" && frame.confirm) {
      const confirm = frame.confirm;
      writeSlice(conversationId, (s) => ({
        ...s,
        pendingConfirms: s.pendingConfirms.some((c) => c.id === confirm.id)
          ? s.pendingConfirms
          : [...s.pendingConfirms, confirm],
      }));
      return;
    }
    if (frame.type === "confirm-resolved" && frame.confirmId) {
      // 别的标签页答复 / 整轮中止：把本地这张卡撤掉
      writeSlice(conversationId, (s) => ({
        ...s,
        pendingConfirms: s.pendingConfirms.filter(
          (c) => c.id !== frame.confirmId,
        ),
      }));
      return;
    }
    // ask_followup_question：把提问按 toolCallId 存起来，供工具调用卡片渲染；跳过 =
    // 「无问题」用于服务端把提问插到对话流正确位置，但不是待回答态，忽略即可
    if (frame.type === "ask-followup" && frame.followup) {
      const f = frame.followup;
      if (f.toolCallId) {
        writeSlice(conversationId, (s) => ({
          ...s,
          followupRequests: { ...s.followupRequests, [f.toolCallId]: f },
        }));
      }
      return;
    }
    if (frame.type === "ask-followup-resolved" && frame.followupId) {
      // 慢发布：把这条提问对应的栏位撤掉（无 toolCallId 时就按 id 清）
      writeSlice(conversationId, (s) => {
        const hit = Object.entries(s.followupRequests).find(
          ([, v]) => v.id === frame.followupId,
        );
        if (!hit) return s;
        const next = { ...s.followupRequests };
        delete next[hit[0]];
        return { ...s, followupRequests: next };
      });
      return;
    }
    if (frame.type === "replay-end") {
      /**
       * 这条连接的回放放完了：把「正在回放现场」撤掉，滚动跟随恢复成流式的平滑动画。
       *
       * 只写 `replaying`，**不碰 messages，也不动 `reconnectNotice`** ——「接上了」的
       * 提示仍在 `attachRun` 的帧回调里收到第一个帧时就撤（回放整批几毫秒就到，两个
       * 时机的可见差异可以忽略），收场统一由那一轮循环的收尾负责。
       *
       * `runRound` 那条初始 POST 也会收到这条帧（服务端对任何连接都先回放再直播），
       * 那时 `replaying` 本来就是 false，这里按「没在回放就不写」跳过，避免白白多一次
       * store 写入。
       */
      if (readSlice(conversationId).replaying) {
        writeSlice(conversationId, (s) => ({ ...s, replaying: false }));
      }
      return;
    }
    if (frame.type === "end") {
      /**
       * 一轮真的结束了（收尾统一在 runRound / attachRun 的收场逻辑里做）。
       *
       * 交接文档没等到 `context-compressed` 就结束了 = 摘要失败 / 本轮中止：
       * `compactHistory` 不会落半份检查点，界面也不该留半份文档（会误导用户以为
       * 已压缩）。已完成的那份不动。
       */
      writeSlice(conversationId, (s) =>
        s.compaction?.status === "streaming"
          ? { ...s, compaction: null }
          : s,
      );
      return;
    }
    if (frame.type !== "event" || !frame.event) return;
    const event = frame.event;
    // 项目管理工具的 UI 动作解释器(见 lib/tool-actions.ts):普通会话里说
    // 「打开 xx」「建个项目」也能驱动界面跳转 / 高亮;浏览器工具则据此弹出画面面板
    // (带上 conversationId,让收方只在「正看的这个会话」里动作)
    for (const action of uiActionsFromEvent(event, conversationId))
      dispatchProjectUiAction(action);
    // 上下文交接文档：开始 / 增量只更新展示态，不动消息 parts（见 parts.ts）。
    if (event.type === "context-compaction-start") {
      writeSlice(conversationId, (s) => {
        let liveIndex = -1;
        for (let i = s.messages.length - 1; i >= 0; i -= 1) {
          if (isSteerAssistant(s.messages[i], assistantId)) {
            liveIndex = i;
            break;
          }
        }
        const live = liveIndex >= 0 ? s.messages[liveIndex] : undefined;
        return {
          ...s,
          compaction: {
            status: "streaming",
            text: "",
            phase: null,
            beforeTokens: event.beforeTokens,
            summarizedTurns: event.summarizedTurns,
            keptTurns: event.keptTurns,
            ...(live
              ? { messageId: live.id, afterPartIndex: live.parts.length }
              : {}),
            updatedAt: Date.now(),
          },
        };
      });
      return;
    }
    if (event.type === "context-compaction-delta") {
      writeSlice(conversationId, (s) => {
        const prev = s.compaction;
        const text = prev?.text ?? "";
        // 切回合时第二段前面要补上服务端最终拼装用的分隔标题，否则界面里的
        // 中间态和终稿对不上（终稿会覆盖，但流式期间看着会突兀）。
        const splitPrefix =
          event.phase === "turn-prefix" &&
          prev?.phase !== "turn-prefix" &&
          !text.includes("**Turn Context (split turn):**")
            ? "\n\n---\n\n**Turn Context (split turn):**\n\n"
            : "";
        return {
          ...s,
          compaction: {
            status: "streaming",
            text: text + splitPrefix + event.delta,
            phase: event.phase,
            ...(prev?.beforeTokens !== undefined
              ? { beforeTokens: prev.beforeTokens }
              : {}),
            ...(prev?.summarizedTurns !== undefined
              ? { summarizedTurns: prev.summarizedTurns }
              : {}),
            ...(prev?.keptTurns !== undefined
              ? { keptTurns: prev.keptTurns }
              : {}),
            ...(prev?.messageId ? { messageId: prev.messageId } : {}),
            ...(prev?.afterPartIndex !== undefined
              ? { afterPartIndex: prev.afterPartIndex }
              : {}),
            updatedAt: Date.now(),
          },
        };
      });
      return;
    }
    // 上下文压缩是「通知」不是内容增量：不往消息列表里塞东西，
    // 只是告诉用户这一轮上下文被压过了（展示走 ContextRing 的 contextNotice 详情）。
    if (event.type === "context-compressed") {
      writeSlice(conversationId, (s) => ({
        ...s,
        compaction: {
          status: "done",
          text: event.summary ?? s.compaction?.text ?? "",
          phase: s.compaction?.phase ?? null,
          beforeTokens: event.beforeTokens,
          afterTokens: event.afterTokens,
          summarizedTurns: event.summarizedTurns,
          keptTurns: event.keptTurns,
          ...(s.compaction?.messageId ? { messageId: s.compaction.messageId } : {}),
          ...(s.compaction?.afterPartIndex !== undefined
            ? { afterPartIndex: s.compaction.afterPartIndex }
            : {}),
          updatedAt: Date.now(),
        },
      }));
      // 提示条落在**这一轮所属的会话**上：分屏时别的标签不该跟着闪
      get().setContextNotice(
        {
          beforeTokens: event.beforeTokens,
          afterTokens: event.afterTokens,
          at: Date.now(),
          summarizedTurns: event.summarizedTurns,
          keptTurns: event.keptTurns,
        },
        conversationId,
      );
      return;
    }
    if (event.type === "retry") {
      // 重试有两种，对已渲染内容的处理不同：
      // - 整轮重来：清掉这次尝试的输出（模型从头生成，留着就会正文重复）；
      // - 断点续跑（`resume`）：模型接着失败的那一步跑，已完成的步骤它看得见 —— 全清会
      //   和上下文对不上，只回滚到最后一个已落定的工具结果。
      // 每次重试直接覆盖上一条（`retryNotice` 只有一份，屏幕上永远只留最新一次）。
      writeSlice(conversationId, (s) => ({
        ...s,
        retryNotice: {
          attempt: event.attempt,
          maxRetries: event.maxRetries,
          // 失败原文（限流 / 断网 / 空响应）：提示里跟在次数后面，用户才知道在等什么
          ...(event.message ? { message: event.message } : {}),
          ...(event.resume ? { resume: true } : {}),
        },
        messages: s.messages.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                parts: event.resume ? truncateToLastSettledTool(m.parts) : [],
              }
            : m,
        ),
      }));
      return;
    }
    // -----------------------------------------------------------------------
    // 多智能体协作：旁路事件，只更新 collab 现场，不碰主消息
    // -----------------------------------------------------------------------
    if (
      event.type === "collab-task" ||
      event.type === "collab-message" ||
      event.type === "collab-agent" ||
      event.type === "collab-delta" ||
      event.type === "collab-tool"
    ) {
      writeSlice(conversationId, (s) => {
        const base = s.collab ?? {
          state: {
            version: 1 as const,
            tasks: [],
            messages: [],
            statuses: {},
            updatedAt: Date.now(),
          },
          liveText: {},
          liveParts: {},
        };
        const collab = applyCollabEvent(base, event);
        return { ...s, collab };
      });
      return;
    }
    if (event.type === "context-usage") {
      // 上下文占用快照（`used` / `size`）。两条来源都走这里、同一形状：
      // - **ACP agent** 上报（session/update 的 usage_update）——ACP 拿不到 finish.usage，
      //   圆环的数据只能走它；跨刷新保留的那份由**服务端**写进会话配置（见 chat-turn.ts
      //   的 setAcpContextUsage），客户端不重复这一步。
      // - **内置 agent（内置）** 在每个工具步骤边界估算后推来 —— 圆环因此在一轮之内
      //   也持续更新，而不是只在 finish 时跳一下。
      // 都挂到**本轮 live 助手消息**上（`contextUsage`），圆环优先读它。
      // ⚠️ 悬垂时（没有 live 助手消息，如 attach 时该段已结束）静默跳过即可，
      //    不影响 finish 时那份权威的 `usage.contextTokens`。
      writeSlice(conversationId, (s) => {
        let liveIndex = -1;
        for (let i = s.messages.length - 1; i >= 0; i -= 1) {
          if (isSteerAssistant(s.messages[i], assistantId)) {
            liveIndex = i;
            break;
          }
        }
        if (liveIndex < 0) return s;
        return {
          ...s,
          messages: s.messages.map((message, i) =>
            i === liveIndex
              ? {
                  ...message,
                  contextUsage: {
                    used: event.used,
                    size: event.size,
                    // 「压缩动不了的那块」只有内置 agent 会带（ACP 没有），没有就别塞 undefined
                    ...(event.base !== undefined ? { base: event.base } : {}),
                  },
                }
              : message,
          ),
        };
      });
      return;
    }
    if (event.type === "user-injected") {
      // 运行中插话被 agent 消费：把 live 助手消息「封口」，把这条 user 消息插到它
      // 后面，再开一条后继助手消息承接后续增量（折叠目标按「最后一条带该前缀的助手
      // 消息」解析 —— 见下方内容增量的落点）。
      //
      // ⚠️ 后继 id 走 contracts 的 `assistantSliceId()`，**服务端落盘用的是同一个推导**
      // （chat-turn 的 persistAssistant）—— 收尾拉权威历史覆盖本地现场时 id 不变，
      // 插话之后的正文才不会整棵重挂载。键是**这条插话消息的 id**（两端共享：服务端
      // POST /api/chat/steer 里生成，这里从事件里拿到），所以不依赖「前面切出了几段」。
      writeSlice(conversationId, (s) => {
        const injected = event.message;
        // 断线重连回放去重（帧日志里有这条 user-injected 时会重放）：消息已在就不再插
        if (s.messages.some((m) => m.id === injected.id))
          return {
            ...s,
            pendingSteers: s.pendingSteers.filter((m) => m.id !== injected.id),
          };
        // 消费即转正：从「插入中」列表出列（发送方那一端维护着它）
        if (s.pendingSteers.some((m) => m.id === injected.id)) {
          s = {
            ...s,
            pendingSteers: s.pendingSteers.filter((m) => m.id !== injected.id),
          };
        }
        let liveIndex = -1;
        for (let i = s.messages.length - 1; i >= 0; i -= 1) {
          const m = s.messages[i];
          if (isSteerAssistant(m, assistantId)) {
            liveIndex = i;
            break;
          }
        }
        if (liveIndex < 0) return s;
        const next = [...s.messages];
        next.splice(liveIndex + 1, 0, injected, {
          id: assistantSliceId(assistantId, injected.id),
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
        });
        return { ...s, messages: next };
      });
      return;
    }
    writeSlice(conversationId, (s) => {
      // 折叠目标 = live 助手消息（原占位，或插话拆分出的最后一个 `-s` 后继）——
      // 插话之后到达的增量必须写进后继那条，否则正文会跑到插话上面去
      let liveIndex = -1;
      for (let i = s.messages.length - 1; i >= 0; i -= 1) {
        if (isSteerAssistant(s.messages[i], assistantId)) {
          liveIndex = i;
          break;
        }
      }
      if (liveIndex < 0) return s;
      return {
        ...s,
        // 走到这里的都是「内容增量 / 错误 / 结束」事件：说明重试后的新尝试已经开始产出内容
        // （或这一轮已结束）—— 把重试提示撤掉，只在重试等待的那一小段可见。
        retryNotice: null,
        messages: s.messages.map((message, i) =>
          i === liveIndex
            ? {
                ...message,
                parts: applyEvent(message.parts, event),
                // finish 带来的一轮用量统计：立刻展示（跑完还会拉一次服务端权威历史，把它落定）。
                // 服务端把 usage 挂在切片后的最后一段上，两边一致
                //
                // `durationMs` 是没有 token 用量、只有耗时的那些轮次（ACP 全程如此；内置后端
                // 被中止 / 出错时也常常一个 usage chunk 都没收到）：同样当场挂上，否则这轮刚
                // 结束、权威历史还没换下来的这一瞬，折叠条抬头会先退回计数摘要
                ...(event.type === "finish"
                  ? {
                      ...(event.usage ? { usage: event.usage } : {}),
                      ...(event.durationMs != null
                        ? { durationMs: event.durationMs }
                        : {}),
                    }
                  : {}),
              }
            : message,
        ),
      };
    });
  };

  /**
   * 这个会话有没有在跑的服务端 run（**查不到一律算没有**：网络不通 / 401 / 5xx）。
   *
   * 多试几次再放弃（每次间隔 500ms）：调用点都在「连接刚断」的异常路径上，那时一次
   * `activeRun` 很可能只是同一个网络抖动，直接判「没在跑」会把还活着的 run 误判成结束。
   */

  const loadConversation = async (conversationId: string): Promise<void> => {
    // 拉服务端落盘的权威历史（内置）；acp 服务端历史恒为空，这里只是走个过场
    // resetScroll：首次装载，消息写入与复位落底同帧（见 loadMessages 的 opts 注释）
    const fetched = await loadMessages(conversationId, {
      loadError: true,
      resetScroll: true,
    });
    // 乐观打开（刷新后的深链）时清单多半还没到：先等它落地，再查 convMeta。
    // loadMessages 收尾已把「装载中」撤掉，等清单 + 回放的这段窗口里重新亮起，
    // 免得界面是一片无提示的空白；清单已到的常规路径（点侧栏 / 重试）瞬间放行。
    if (!get().conversationsLoaded) {
      writeSlice(conversationId, (s) => ({ ...s, loading: true }));
      await waitConversationsLoaded();
    }
    /**
     * acp 会话下面还要走两个往返：`peekActiveRun`（这一轮是不是还在跑）+ 回放 / attach。
     * 而 `loadMessages` 收尾已经把装载标记撤掉了 —— **清单已经到齐的路径根本没进上面那个
     * 分支**，于是这段窗口 `loading` 是 false、`messages` 还空着，消息区就按「一条消息都
     * 没有」渲染空态（「在「x」里说点什么」），回放一到又被消息顶掉。
     *
     * 刷新页面必中：现在的恢复入口是 `PanelView` 等清单落地后把当前会话对齐到焦点标签，
     * 所以进 `loadConversation` 时 `conversationsLoaded` 恒为 true。ACP 比内置多这两个
     * 往返，肉眼就是「刷新闪一下空态」。
     *
     * 这里补亮，撤掉的地方不变（各分支的 finally 与收尾统一撤）。
     */
    if (
      get().conversations.find((c) => c.id === conversationId)?.backend === "acp"
    ) {
      writeSlice(conversationId, (s) => ({ ...s, loading: true }));
    }
    // 协作会话：任务 / 消息状态在独立的 collab.json，随打开一起拉（失败不挡主历史）
    if (
      (fetched ?? get().conversations.find((c) => c.id === conversationId))
        ?.kind === "collab"
    ) {
      const api = get().getApi();
      if (api) {
        try {
          const { collab } = await api.getCollabState(conversationId);
          if (isFocus(conversationId)) {
            writeSlice(conversationId, (s) => ({
              ...s,
              collab: { state: collab, liveText: {}, liveParts: {} },
            }));
          }
        } catch (err) {
          console.warn("[collab] 运行态装载失败：", err);
        }
      }
    }
    // acp 会话：消息在 agent 侧，用 session/load 回放重建视图（不落盘，刷新后重放）
    const convMeta = get().conversations.find((c) => c.id === conversationId);
    let resumedActive = false;
    if (convMeta?.backend === "acp" && isFocus(conversationId)) {
      /**
       * ⚠️ 先看这一轮是不是还在跑。
       *
       * 跑动中刷新**不能**走 session/load：服务端回放入口的第一件事是 teardown 同 key
       * 的 ACP 进程，正在等 nextUpdate 的 ActiveSession 会以 `ACP connection closed`
       * 失败（用户看到的就是这条报错）。正确恢复方式是「进程内视图快照 + attach 帧日志」：
       * 快照给出已完成的轮次与本轮用户消息，attach 从帧日志头部回放当前助手消息并接回直播。
       */
      // 装载标记已在上面按 backend 亮起（含 `peekActiveRun` 这次往返），这里不再重复写
      const activeRun = await peekActiveRun(conversationId);
      if (activeRun) {
        try {
          const api = get().getApi();
          // 有 active run 时服务端只读内存快照，不会碰 agent 进程；sessionId / cwd
          // 这时可以不齐（会话刚新建、还没绑定 session）—— 服务端按 conversationId 判断。
          if (api && convMeta.configId) {
            const cwd = get().workspaces.find(
              (w) => w.id === convMeta.workspaceId,
            )?.path;
            try {
              const { messages: snapshot } = await api.getAcpTranscript(
                convMeta.configId,
                conversationId,
                convMeta.acpSessionId ?? "",
                cwd ?? "",
              );
              if (isFocus(conversationId) && snapshot.length > 0) {
                /**
                 * ⚠️ **不能只在本地消息为空时才写快照**。
                 *
                 * 刷新时 `useAttachRemoteRun` 可能抢在本次装载前面先 `attachRun`，那时
                 * 本地已经挂了本轮助手占位（`messages.length` = 1，但不是历史）。原来的
                 * `length === 0` 判据会因此整份丢弃快照 —— 表现就是「跑到一半刷新，
                 * 历史消息不显示，结束后再刷新才回来」。
                 *
                 * 改成合并：快照（已完成的轮次 + 本轮用户消息）在前，本地那些快照里
                 * 没有的（当前助手占位 / 已回放的 part）接在后面，按 id 去重。
                 * 本地已经有用户消息（用户刚发的乐观消息）时不合并 —— 快照里多半还没
                 * 有它，硬并会重复一条。
                 */
                writeSlice(conversationId, (s) => {
                  if (s.messages.some((m) => m.role === "user")) return s;
                  const ids = new Set(snapshot.map((m) => m.id));
                  const extras = s.messages.filter((m) => !ids.has(m.id));
                  return {
                    ...s,
                    messages: [...snapshot, ...extras],
                    scrollResetSeq: s.scrollResetSeq + 1,
                  };
                });
              }
            } catch {
              // 快照拉不到不该挡住 attach：帧日志仍然能恢复当前这一轮
            }
          }
          resumedActive = await attachRun(
            conversationId,
            activeRun.assistantMessageId
              ? {
                  requestId: activeRun.requestId,
                  assistantId: activeRun.assistantMessageId,
                }
              : undefined,
          );
        } finally {
          writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        }
      }
    }
    if (
      !resumedActive &&
      convMeta?.backend === "acp" &&
      convMeta.acpSessionId &&
      convMeta.configId &&
      isFocus(conversationId)
    ) {
      const cwd = get().workspaces.find(
        (w) => w.id === convMeta.workspaceId,
      )?.path;
      if (cwd) {
        // loadMessages 收尾已把「装载中」撤掉，回放又要一个往返 —— 这段窗口里界面
        // 只是一片空白。重新亮起装载标记，回放结束（成功 / 失败）再撤。
        writeSlice(conversationId, (s) => ({ ...s, loading: true }));
        try {
          const api = get().getApi();
          const { messages: replayed } = await api!.getAcpTranscript(
            convMeta.configId,
            conversationId,
            convMeta.acpSessionId,
            cwd,
          );
          // 回放期间用户可能已经发出了新一轮（本地已有消息）或切走了会话：都不覆盖
          if (
            replayed.length > 0 &&
            isFocus(conversationId) &&
            readSlice(conversationId).messages.length === 0
          ) {
            // 回放出来的消息与复位落底同一次写入（同 loadMessages 的 resetScroll，别拆两帧）
            writeSlice(conversationId, (s) => ({
              ...s,
              messages: replayed,
              scrollResetSeq: s.scrollResetSeq + 1,
            }));
          }
        } catch (err) {
          // 回放失败（agent 不支持 load / 会话失效 / OpenCode 服务故障）：写错误态，
          // 让消息列表展示错误 + 重试，而不是静默吞掉变成「历史丢了」
          writeSlice(conversationId, (s) => ({
            ...s,
            error: errorMessage(err),
          }));
        } finally {
          writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        }
      }
    }
    /*
     * 收尾：撤掉「装载中」，并兜底再复位一次落底。
     *
     * 消息本身的写入已经各自带上了 resetScroll（内置 走 loadMessages、acp 走回放那块），
     * 这里的 bump 只为覆盖「压根没有消息可写」的窗口 —— 比如等会话清单期间用户就切走了、
     * 或回放没跑（缺 cwd / 非当前会话）。空会话落底本来就无副作用。
     */
    writeSlice(conversationId, (s) => ({
      ...s,
      scrollResetSeq: s.scrollResetSeq + 1,
      loading: false,
    }));
    // 这里原本还有一段「把会话详情里的模型 / MCP / 浏览器偏好 / 思考强度搬进全局现场」
    // 的恢复块（还得比对引用，防止盖掉装载期间用户自己改的选择）。现在不需要了：视图的
    // 现场从**会话清单项**派生（`scopedSettingsOf`），`loadMessages` 收尾已经把详情校正
    // 进清单项，派生出来自然最新 —— 「搬运」这件事一旦存在，就总会有人漏一个分支。
    //
    // 本地没人订着这条会话、但服务端还挂着 run（刷新 / 断线重连 / 换端回来）：
    // 接回去回放现场继续看直播。接上了就到此为止 —— 收尾（拉权威历史 / 续队列）
    // 由 attachRun 的收场负责
    if (!get().runningConversations[conversationId]) {
      const attached = await attachRun(conversationId);
      if (attached) return;
    }
    // 本会话没在跑但有排队消息：依次发出（刷新后也能续上；被停掉的那轮结束后同样接着跑）
    if (!get().runningConversations[conversationId]) pump(conversationId);
  };

  const loadMessages = async (
    conversationId: string,
    opts?: {
      loadError?: boolean;
      /**
       * 「打开会话的首次装载」才传：消息到位与**复位落底**（`scrollResetSeq`）必须在
       * **同一次 writeSlice** 里落下去。
       *
       * 拆成两次（先写 messages、后 bump seq）会漏出一个中间帧：那一帧消息已经渲染、
       * resetKey 却没变，滚动容器不做同步落底，内容高度暴增就交给库的 ResizeObserver
       * 用 spring 接管 —— 观感是「切进长会话时从顶部平滑滚到底部」。而且这两次写入
       * 是否落在同一个 React 批里取决于调用链的 await 时序（内置 与 acp 两条路径不同），
       * 于是出现了「有的会话滚、有的不滚」。
       *
       * 静默刷新 / 每轮收尾的权威回拉刻意**不传** —— 那几种情况不能把正在翻历史的
       * 用户拽到底部（见 `scrollResetSeq` 的注释）。
       */
      resetScroll?: boolean;
    },
  ): Promise<AgentConversation | null> => {
    const api = get().getApi();
    if (!api) return null;
    const gen = readSlice(conversationId).loadGen;
    get().setBusy(true);
    try {
      const conversation: AgentConversation =
        await api.getConversation(conversationId);
      // 唯一的过期条件是代次：期间这个会话已经开出了新一轮（runRound / attachRun 会
      // +1），本地正在流式攒的消息不能被服务端快照盖掉
      if (gen === readSlice(conversationId).loadGen) {
        /**
         * 权威历史里已经出现的插话，从「插入中 / 未发出」列表里划掉。
         *
         * 收尾兜底落盘时**复用插话自己的 id**（`drainSteerInbox` 传 `userMessageId`），
         * 所以「id 出现在历史里」= 它已经被服务端收下（作为普通消息），本地不该再留一份
         * —— 否则下一轮开跑时它会被转进待发送队列，等于**同一句话发两遍**。
         * 正常情况客户端早就按 `user-injected` 出列了，这里兜的是「断线恰好错过那批事件」。
         */
        const known = new Set(conversation.messages.map((m) => m.id));
        writeSlice(conversationId, (s) => ({
          ...s,
          messages: conversation.messages,
          ...(s.pendingSteers.some((m) => known.has(m.id))
            ? { pendingSteers: s.pendingSteers.filter((m) => !known.has(m.id)) }
            : {}),
          error: null,
          scrollResetSeq: opts?.resetScroll
            ? s.scrollResetSeq + 1
            : s.scrollResetSeq,
        }));
        /**
         * 顺手把**会话设置**（模型 / 思考强度 / MCP / 浏览器偏好）按这份详情校正进清单项。
         *
         * 视图的现场是从清单项派生的（`scopedSettingsOf`），清单项不跟着校就等于「别的端
         * 改过模型，这边还显示旧的」。放在代次判断里：刚开新一轮时清单已经由 `persistTarget`
         * 写过，这份快照比它旧，不能拿它盖回去。
         */
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  backend: conversation.backend,
                  configId: conversation.configId,
                  modelId: conversation.modelId,
                  reasoningEffort: conversation.reasoningEffort,
                  mcpServerIds: conversation.mcpServerIds,
                  browserSettings: conversation.browserSettings,
                }
              : c,
          ),
        }));
      } else if (conversation.messages.length > 0) {
        /**
         * 代次变了（刷新时 `attachRun` 抢在前面把 `loadGen` +1）也不能把这份历史**丢掉**。
         *
         * 这是「跑到一半刷新，历史消息全不见了」的直接成因：`attachRun` 先挂了本轮
         * 助手占位，随后的历史响应因代次不符被整份丢弃 —— 界面上只剩占位 + 回放的
         * 当前一轮，更早的消息没了，要等这一轮结束、再刷新一次靠空闲路径重拉才回来。
         *
         * 这里改成**合并**：服务端历史在前（权威顺序），本地那些历史里还没有的消息
         * （本轮占位 / 回放出来的助手内容 / 乐观发送的用户消息）按原顺序接在后面。
         * 按 id 去重 —— 收尾落盘会复用占位 id，届时服务端那份覆盖本地那份正好。
         */
        writeSlice(conversationId, (s) => {
          const historyIds = new Set(conversation.messages.map((m) => m.id));
          const extras = s.messages.filter((m) => !historyIds.has(m.id));
          if (extras.length === 0) return s;
          return { ...s, messages: [...conversation.messages, ...extras] };
        });
      }
      // 把服务端那份回给调用方：打开会话时用它判断 kind / 是否需要回放，比列表快照新
      return conversation;
    } catch (err) {
      // 打开会话这条装载链路：失败归到消息列表的错误态（带重试），不污染底部通用错误条
      if (opts?.loadError) {
        writeSlice(conversationId, (s) => ({ ...s, error: errorMessage(err) }));
      } else {
        get().setError(errorMessage(err));
      }
      return null;
    } finally {
      get().setBusy(false);
      writeSlice(conversationId, (s) => ({ ...s, loading: false }));
    }
  };

  /**
   * 断线轮次的**对账**：这一轮在客户端看是失败了（`runRound` 渲染了「网络错误」），
   * 但服务端多半在断线期间把它跑完并落盘了 —— run 的生命周期不挂在客户端连接上。
   * 拉一次服务端权威历史：确实多出了这一轮的助手回复就用它盖掉本地那条错误。
   *
   * 息屏 / 休眠醒来时网络往往**刚**恢复，一次拉不到很正常，所以重试几次再放弃。
   *
   * 只在「服务端历史比这一轮开跑前更长、且末位是助手消息」时才采纳 —— 否则
   * （这一轮压根没开跑 / 落盘失败）保留本地渲染出来的错误，别拿一份旧历史把它擦成
   * 「什么都没发生过」。acp 会话没有权威历史可对（服务端历史恒为空），直接放弃。
   */

  const patchQueue = (conversationId: string, next: QueuedMessage[]): void => {
    writeSlice(conversationId, (s) => ({ ...s, queuedMessages: next }));
    saveQueue(conversationId, next);
    syncQueueToServer(conversationId, next);
  };

  /**
   * 本地守卫：这一轮的**目标**（模型配置 / ACP agent）现在还能不能用。
   *
   * 不能用就**就地报错并把悬空的目标清掉**（界面上那颗 pill 因此回到「选择模型」），返回
   * `false`。**绝不回退到清单第一个** —— 那会替用户发出一个他从来没选过的模型。
   *
   * 两个调用点，对「早」的要求不同，所以抽成函数：
   * - `runRound` 在开跑前问（拦住才不会留下一条绑着死目标的空会话）；
   * - `resendMessage` 在**删历史之前**问 —— 编辑重发是先删后发，晚一步用户就白丢一段历史。
   */

  const peekActiveRun = async (
    conversationId: string,
    tries = 3,
  ): Promise<ChatRunSummary | null> => {
    const api = get().getApi();
    if (!api) return null;
    for (let i = 0; i < tries; i += 1) {
      try {
        const { run } = await api.activeRun(conversationId);
        return run;
      } catch {
        if (i < tries - 1) await sleep(500 * (i + 1));
      }
    }
    return null;
  };

  /**
   * 队列泵：这条会话没在跑且队列非空时，弹出第一条开新一轮（`settleRound` 收尾时也会
   * 再调它，形成「一条接一条」的链式执行）。正在跑 / 队列空都不动。
   *
   * `scope` 不传 = 活跃会话；分屏时非焦点标签的续跑带上自己的 id —— 队列是**那条会话
   * 自己的事**，用户此刻在看哪块不该决定它跑不跑。
   */
  const pump = (scope?: string | null): void => {
    const conversationId = resolveConvId(scope);
    if (!conversationId) return;
    if (get().runningConversations[conversationId]) return;
    const queue = readSlice(conversationId).queuedMessages;
    const next = queue[0];
    if (!next) return;
    // 有下一条要发：失败暂停的标记就地解除（继续执行 = 用户拍板过了）
    writeSlice(conversationId, (s) => ({ ...s, queuePausedReason: null }));
    patchQueue(conversationId, queue.slice(1));
    void get().runRound(next.text, next.files, undefined, conversationId);
  };

  /**
   * 读服务端上的队列（权威）。返回 null = 拉不到（未连接 / 离线 / 报错），
   * 调用方据此继续用本地缓存 —— 队列降级成「只在本地用」，不弹错误。
   */

  const reconcileDroppedRound = async (
    conversationId: string,
  ): Promise<boolean> => {
    const api = get().getApi();
    if (!api) return false;
    const dropped = readSlice(conversationId).droppedRound;
    if (!dropped) return false;
    const convBackend = get().conversations.find(
      (c) => c.id === conversationId,
    )?.backend;
    if (convBackend === "acp") return false;
    // 采纳的判据要在同一次快照里成立：拿住代次，中途用户又开了一轮（代次 +1）就放弃
    const gen = readSlice(conversationId).loadGen;
    if (reconciling.has(conversationId)) return false;
    reconciling.add(conversationId);
    try {
      for (let i = 0; i < 4; i += 1) {
        try {
          const conversation: AgentConversation =
            await api.getConversation(conversationId);
          const live = readSlice(conversationId);
          const last = conversation.messages[conversation.messages.length - 1];
          if (
            gen === live.loadGen &&
            !live.streaming &&
            last?.role === "assistant" &&
            conversation.messages.length > dropped.baseCount
          ) {
            writeSlice(conversationId, (s) => ({
              ...s,
              messages: conversation.messages,
              droppedRound: null,
              error: null,
            }));
            return true;
          }
          return false;
        } catch {
          if (i < 3) await sleep(1000 * (i + 1));
        }
      }
      return false;
    } finally {
      reconciling.delete(conversationId);
    }
  };

  /**
   * 一帧 SSE → 界面状态。`conversationId` 是这一轮所属的会话（后台轮也写自己的
   * slice），`assistantId` 是这一轮要往里追加 part 的助手消息 id（`runRound` /
   * `attachRun` 创建的那条本地占位助手消息）。
   */

  const runRound = async (
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
    /**
     * 发到哪条会话。不传 = 旧行为（活跃会话）；`null` = 明确「新对话页」→ 建新会话
     * （**不要回落到焦点会话**：分屏时草稿标签旁边可能有另一个会话标签）。
     * 视图层按标签传入（见 `agentAppFrom`），否则非焦点标签发的消息会插到焦点会话里。
     */
    scope?: string | null,
  ): Promise<boolean> => {
    const api = get().getApi();
    if (!api) return false;
    const trimmed = text.trim();
    if (!trimmed && !(files && files.length > 0)) return false;

    /**
     * 会话的现场（模型 / 思考强度 / MCP）**只有**清单项这一份来源（`scopedSettingsOf`）。
     * 清单还没到时派生不出它自己的选择、会退回草稿那份 —— 那就会带着「上一个新对话页选
     * 的模型」开跑。窗口极窄（刷新后深链秒发），但正是我们在治的那类串台，所以先等一趟
     * （已到就是同步放行，不产生额外往返）。
     */
    if (
      resolveConvId(scope) &&
      !get().conversationsLoaded &&
      get().getApi()
    ) {
      await waitConversationsLoaded();
    }

    /**
     * 这一轮的现场（模型 / 思考强度）取**本会话**那份：从会话清单项派生。必须在建会话
     * 之前算 —— 草稿页要靠它拿到 `chatTarget` 去建会话。
     */
    const scoped = get().scopedSettingsOf(resolveConvId(scope));

    /**
     * 发之前先确认目标还成立（见 `guardTarget`）。校验必须放在建会话之前，否则会留下
     * 一条绑着死目标的空会话。校验的是**这条会话**的目标，不是焦点会话的。
     */
    if (!guardTarget(scoped.chatTarget)) return false;

    let conversationId = resolveConvId(scope);
    if (!conversationId) {
      // 「开始新对话」页发送即建会话：会话类型在创建时就按当前选中的目标定死 ——
      // 选的是 ACP agent（或其模型）就是 acp 会话（agent 从此绑定、acpSessionId 后续回填），
      // 选的是 AI 模型（或默认）就是内置 agent 会话。类型落库后不能再换，模型可换。
      const { chatTarget } = scoped;
      /**
       * 建会话这段空窗要让输入框看得见（发送钮转圈）：ACP 要起外部 agent 进程 +
       * `session/new` 才拿得到会话，几秒钟界面毫无反应，用户会以为没点上而反复点。
       *
       * ⚠️ 用 `done` 回调收尾，**不能用 `finally` 把 `await` 包起来** —— `newConversation`
       * 建完会话还要下发 ACP 档位（又一次进程往返），而这一刻界面已经从空态页切进会话、
       * 用户消息也快落屏了，再转圈就是「转得比实际久」。
       */
      set({ creatingConversation: true });
      try {
        conversationId = await get().newConversation(
          undefined,
          undefined,
          chatTarget
            ? {
                backend: chatTarget.backend,
                ...(chatTarget.configId ? { configId: chatTarget.configId } : {}),
                ...(chatTarget.modelId ? { modelId: chatTarget.modelId } : {}),
              }
            : undefined,
          () => set({ creatingConversation: false }),
        );
      } catch (err) {
        // `newConversation` 自己兜了错，理论到不了这里；真到了也别把转圈留在屏幕上
        set({ creatingConversation: false });
        throw err;
      }
      if (!conversationId) return false;
    }

    const userMessage: AgentChatMessage = {
      id: nextLocalId("u"),
      role: "user",
      // files 在前、text 在后（与服务端落盘同一份 buildUserParts，两端形状才不会漂）
      parts: buildUserParts(trimmed, files),
      createdAt: Date.now(),
    };
    const assistantId = nextLocalId("a");
    const controller = new AbortController();
    // 模型 / 思考强度按会话取（见上面 `scoped`）；其余是全局偏好，仍从 store 现取
    const { chatTarget, reasoningEffort } = scoped;
    const {
      permissionMode,
      confirmTimeoutMin,
      maxRetries,
      toolCallConcurrency,
      maxSteps,
      toolIntent,
    } = get();
    // 记下「上次使用的模型」（新会话预选用它），并把这次真正发出去的选择写回会话目录
    // （`config.json`）—— 「用某个模型发消息就更新这个配置的值」。
    if (chatTarget?.configId) {
      saveLastTarget({
        backend: chatTarget.backend,
        configId: chatTarget.configId,
        ...(chatTarget.modelId ? { modelId: chatTarget.modelId } : {}),
      });
      persistTarget(conversationId, chatTarget);
    }
    // 用户消息 + 空助手消息落进**这个会话自己的现场**；从现在起它就是真源
    // 对账基准：这一轮开跑前本地有多少条消息（断线失败后拿它判断服务端有没有存下这一轮）
    const baseCount = readSlice(conversationId).messages.length;
    /**
     * 新一轮开跑时，把上一轮**遗留的插话**转入待发送队列（见 settleRound 的说明：
     * 只有「用户点了停止」与「断线丢了事件」会留下来）。它们已经不在服务端收件箱里，
     * 继续挂在「插入中」列表只会撒谎 —— 那里写着「下个步骤边界生效」，而这一轮它们
     * 根本不会被注入。转入队列则内容不丢，且队列本来就有 ➤ 立刻发送 / 编辑 / 删除。
     */
    const straySteers = readSlice(conversationId).pendingSteers;
    writeSlice(conversationId, (s) => ({
      ...s,
      messages: [
        ...s.messages,
        userMessage,
        {
          id: assistantId,
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
        },
      ],
      /**
       * 自己发的消息**必须立刻出现在底部**（用户要求）：bump 一下 scrollResetSeq，
       * 让 Conversation 在本次 commit 的 layout 阶段直接落底，顺带把跟随状态重新打开。
       */
      scrollResetSeq: s.scrollResetSeq + 1,
      streaming: true,
      // 新一轮是全新开跑（不是回放）：万一上一轮的回放窗口没收干净，这里一并复位
      replaying: false,
      // 新一轮开始时清掉上一轮残留的审批卡片（上一轮的审批已随落盘的消息给过结论）
      pendingConfirms: [],
      followupRequests: {},
      retryNotice: null,
      // 新一轮开跑：上一轮遗留的待对账断线轮次作废（这一轮的代次已经 +1，对账自然也不会采纳）
      droppedRound: null,
      // 作废在途的消息加载：从现在起本地消息就是真源（流式帧在往里追加）
      loadGen: s.loadGen + 1,
      // 上轮遗留的插话已转交队列（下面 patchQueue），这里一并从「插入中」摘掉
      ...(straySteers.length > 0 ? { pendingSteers: [] } : {}),
      request: { id: "", controller, assistantId },
    }));
    if (straySteers.length > 0) {
      const adopted: QueuedMessage[] = straySteers.map((message) => {
        const files = fileRefsOfParts(message.parts);
        return {
          id: nextLocalId("q"),
          text: textOf(message),
          createdAt: message.createdAt,
          ...(files.length > 0 ? { files } : {}),
        };
      });
      patchQueue(conversationId, [
        ...readSlice(conversationId).queuedMessages,
        ...adopted,
      ]);
    }
    /**
     * 走到这里就是**确定要发**了：乐观消息已落进本地现场，后面只剩「服务端接不接受」
     * （那属于这一轮的成败，不再是「没发出去」）。草稿区的一次性资源（附件 / 引用）
     * 就是在这里清的 —— 早于这里清等于赌，赌输了用户得把文件重传一遍（见 `send` 的
     * `onStarted` 说明）。
     */
    onStarted?.();
    get().setError(null);
    /** 这一轮是不是「没能开跑」（服务端也没起过 run / 被拒 / 连不上）—— 决定收尾要不要拉权威历史 */
    let failed = false;
    /** 连接断了但服务端那轮还在跑：已经转交 attachRun 续接，收场归它管 */
    let handedOff = false;
    // 这一轮开跑：侧栏在它的会话上转圈（之后切到别的会话也不挪窝）
    markRunning(conversationId, true);
    // 初始页选好的模型：上面建会话时已作为 target 一并落库，这里无需再 PATCH

    /**
     * 这一轮的帧合批器（见 `lib/frame-batch.ts`）：把逐 token 的 delta 攒到一个动画帧
     * 再一次性落进 store，避免「一 token 一次整树渲染」。
     */
    const batch = createFrameBatcher((frame) =>
      handleFrame(conversationId, assistantId, frame),
    );

    try {
      const requestId = await api.streamChat(
        {
          conversationId,
          text: trimmed,
          /**
           * 这一轮两条消息的 id **由客户端定、服务端沿用**（见 `ChatRequest` 的两个 id 字段）：
           * 收尾时 `loadMessages` 会用服务端权威历史覆盖本地现场，id 一致 React 才不会把
           * 刚跑完这一轮的子树整棵重挂载（观感是「消息列表跳一下 / 图片重走骨架」）。
           */
          userMessageId: userMessage.id,
          assistantMessageId: assistantId,
          // 附件：先经 /api/uploads 上传拿到的引用，服务端转成 file parts 落盘
          ...(files && files.length > 0 ? { files } : {}),
          permissionMode,
          // 审批超时（毫秒）：0 = 不超时；服务端按这个值等用户答复
          confirmTimeoutMs:
            confirmTimeoutMin > 0 ? Math.round(confirmTimeoutMin * 60000) : 0,
          // 模型请求自动重试次数（0 = 不限制）：服务端据此在可重试的请求错误（网络 / 空响应）上重试
          maxRetries,
          // 同一批 tool-call 的并发上限：模型一次返回一大批工具调用时，服务端按这个数排队
          toolCallConcurrency,
          // 一轮最多跑多少步：达到上限后服务端会停下这一轮（即使还有没跑完的工具调用）
          maxSteps,
          // 工具卡是否带「意图」：服务端据此决定要不要往工具 schema 注入 intent 字段
          toolIntent,
          // 思考强度：随请求带一份，避免刚切完档、PATCH 还没落盘时这一轮按旧档跑
          ...(chatTarget?.backend !== "acp" && reasoningEffort
            ? { reasoningEffort }
            : {}),
          // 选了 ACP agent 就走外部进程（configId 此时是 ACP agent id）
          ...(chatTarget
            ? {
                backend: chatTarget.backend,
                ...(chatTarget.configId
                  ? { configId: chatTarget.configId }
                  : {}),
                // 一份配置带多个模型时，告诉服务端这一轮用哪个
                ...(chatTarget.modelId ? { modelId: chatTarget.modelId } : {}),
              }
            : {}),
        },
        (frame: ChatStreamFrame) => batch.push(frame),
        controller.signal,
      );
      // 流关了：先把缓冲里的尾巴落干净，再写 requestId（收场紧接着会读消息列表）
      batch.flush();
      writeSlice(conversationId, (s) => ({
        ...s,
        request: s.request ? { ...s.request, id: requestId } : s.request,
      }));
    } catch (err) {
      // 断线也要先把已收到的帧落干净：停在「最后一帧」而不是回退几帧
      batch.flush();
      /**
       * ⚠️ 这一轮**没能开跑**时，错误也走消息流，**不再弹输入框上方那条横幅**（用户要求）。
       * 刻意复用 `applyEvent` 的 `error` 事件 —— `⚠️ ` 前缀与 part 形状只在
       * `lib/parts.ts` 里定义一次。服务端对「配置没弄好」这类失败会自己落一条同样的
       * 助手消息（刷新后还在）；连不上服务端时它落不了盘，但本地这条至少能立刻看到。
       */
      if (!controller.signal.aborted) {
        /**
         * 连接断了 ≠ 这一轮没跑。run 的生命周期不挂在客户端连接上（POST /api/chat 一断，
         * 服务端照样把这一轮跑完并落盘，见 `app/api/chat/route.ts` 顶部）—— 页面切到后台
         * （标签页冻结 / 电脑休眠 / 网络切换）时断的正是这条 SSE。
         *
         * 先查一眼：服务端还挂着这条 run 就**转交 attachRun 续接**（复用现在这条占位消息，
         * 断线它会自动重接），而不是把半截现场标成失败。以前这里直接渲染「网络错误」并
         * 复位现场，用户只能刷新整页才能把这一轮接回来。
         */
        const alive = await peekActiveRun(conversationId);
        if (alive) {
          handedOff = true;
          await attachRun(conversationId, {
            requestId: alive.requestId,
            assistantId,
          });
        } else {
          failed = true;
          const message = errorMessage(err);
          /**
           * 先把错误渲染出来（马上能看到发生了什么），同时**记下待对账**：服务端那轮
           * 很可能在断线期间跑完并落盘了（`peekActiveRun` 查不到只说明「现在没有在跑的
           * run」—— 它刚结束、或已经被 retention 清掉，两种都查不到）。对账会用服务端
           * 权威历史把这条错误换成真正的回复，不用刷新页面。
           */
          writeSlice(conversationId, (s) => ({
            ...s,
            droppedRound: { baseCount },
            messages: s.messages.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    parts: applyEvent(m.parts, { type: "error", message }),
                  }
                : m,
            ),
          }));
        }
      }
    } finally {
      // 这一轮已经被接回去了（断线续接）：收场归 attachRun —— 这里复位 streaming /
      // 拉历史 / 顶队列都会把刚接上的现场打乱。
      // ⚠️ 在 finally 里 `return true`（而不是裸 `return`）既保住了「这一轮确实开跑了」的
      // 语义，也保留原来那个副作用：finally 里的 return 会吞掉在途异常（调用方是
      // `void runRound(...)`，抛出去就是 unhandledrejection）。
      if (handedOff) return true;
      // 这一会话的现场复位（streaming / 当前轮 / 审批卡 / 提问表都是它自己的）
      writeSlice(conversationId, (s) => ({
        ...s,
        streaming: false,
        replaying: false,
        request: null,
        pendingConfirms: [],
        followupRequests: {},
        retryNotice: null,
      }));
      markRunning(conversationId, false);
      // 标题 / 消息数 / 排序都变了，收流后同步一次列表
      try {
        set({ conversations: await api.listConversations() });
      } catch {
        // 列表刷新失败不影响本轮结果
      }
      /**
       * 用服务端落盘的权威历史覆盖本地（本地是流式期间临时攒的）。
       *
       * ⚠️ **失败的这一轮不能直接拉**：服务端可能压根没存下这条错误（5xx / 连不上），
       * 拉回来只会把刚渲染出来的错误又擦掉。改走对账（`reconcileDroppedRound`）：
       * 它只在服务端**确实多存了这一轮的助手回复**时才采纳，否则保留本地的错误。
       * acp 会话的消息不落本地（服务端历史恒为空）：本地这份就是它的全部展示。
       */
      if (failed) {
        void reconcileDroppedRound(conversationId);
      } else {
        const convBackend = get().conversations.find(
          (c) => c.id === conversationId,
        )?.backend;
        if (convBackend !== "acp") void loadMessages(conversationId);
      }
      /**
       * 自然收尾（没被中止、也没失败）：把**这条会话**队列里的下一条顶上来接着跑；
       * 用户点了停止（aborted）则保留队列，等他之后手动再发时一并续上。
       *
       * **不看焦点**：以前这里要求「必须还是活跃会话」，分屏时在 B 标签排了三条、切回 A
       * 看别的东西，B 的第一轮跑完队列就停在那儿不动了 —— 队列是「我自己会接着跑」的
       * 承诺，与用户此刻看哪块无关。`pump(conversationId)` 会把下一轮也发到 B 上。
       */
      if (!controller.signal.aborted && !failed) {
        pump(conversationId);
      } else if (
        failed &&
        readSlice(conversationId).queuedMessages.length > 0
      ) {
        // 失败停链（spec §3）：不自动发下一条（防坏配置把整个队列烧完），队列保留，
        // 头部显式提示「已暂停」+ 一键继续 / 清空 —— 现状是静默卡住，用户只能猜
        writeSlice(conversationId, (s) => ({
          ...s,
          queuePausedReason: "failed",
        }));
      }
    }
    // 走到这里 = 这一轮**确实发出去了**（跑完了 / 断了但由 attachRun 接上 / 落成错误）
    return true;
  };

  /**
   * 这一轮收场：复位本地现场、拉服务端权威历史、把队列的下一条顶上来接着跑。
   * `runRound` 与 `attachRun`（含断线重接循环）共用同一套收场语义。
   */
  const settleRound = (conversationId: string, signal: AbortSignal): void => {
    writeSlice(conversationId, (s) => ({
      ...s,
      streaming: false,
      // 收场时一定不在回放里了（回放只在 attachRun 的循环内），兜底一并撤掉
      replaying: false,
      request: null,
      pendingConfirms: [],
      followupRequests: {},
      // ⚠️ **这里刻意不清 `pendingSteers`**：收件箱随 run 结束消失，但没被消费的插话不能
      // 跟着一起丢。绝大多数收场（被边界消费 / 收尾兜底）服务端都会广播 `user-injected`，
      // 客户端早已按事件出列；真正会残留的只有两种：**用户点了停止**（服务端 abort 时清箱
      // 丢弃，见 chat-turn 的 abort 监听）与断线丢了事件。这两种情况把条目留在列表里，
      // 用户才能用 ➤ 立刻发送 / ✕ 移除（见 `sendSteer`）；起下一轮时它们会自动转入待发送队列。
      retryNotice: null,
      reconnectNotice: null,
      // 这一轮有着落（收到 end / 服务端已落盘），没有待对账的断线轮次了
      droppedRound: null,
    }));
    markRunning(conversationId, false);
    // 服务端这时已经把整轮落盘了：拉权威历史覆盖本地回放出来的那份。
    // acp 例外：服务端历史恒为空，拉了会把刚回放完的现场擦掉 —— 本地这份就是全部
    const convBackend = get().conversations.find(
      (c) => c.id === conversationId,
    )?.backend;
    if (convBackend !== "acp") void loadMessages(conversationId);
    // 自然收尾（没被中止）：把队列里的下一条顶上来接着跑；用户点了停止则保留队列。
    // 同样不看焦点 —— 后台标签的队列自己跑完（见 settleRound 里的说明）
    if (!signal.aborted) pump(conversationId);
  };

  /**
   * 接回一条**正在服务端跑**的对话（刷新 / 断线重连 / 换端后恢复现场）。
   *
   * 与 `runRound` 的区别：这一轮早就跑起来了，这里只订阅（回放 + 直播），**不新开一轮**。
   * 返回 true = 确实接上了一条在跑的对话（调用方据此跳过「没在跑」的后续动作）。
   *
   * @param opts.requestId / opts.assistantId 断线续接（`runRound` 的连接断了之后转交过来）：
   *   直接复用已知的 requestId 与本地占位消息，省掉一次 activeRun 查询、也绝不新建空消息。
   */

  return {
    attachRun,
    handleFrame,
    loadConversation,
    loadMessages,
    patchQueue,
    peekActiveRun,
    pump,
    reconcileDroppedRound,
    runRound,
    settleRound,
  };
}
