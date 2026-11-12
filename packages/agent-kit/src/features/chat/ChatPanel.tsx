/**
 * 对话区：消息流（ai-elements 的 Conversation / Message）+ 输入框（PromptInput）的**装配层**。
 *
 * **结构在 `chat/chat-surface.tsx`**（消息列表 + 输入区 + 落底指示器，与容器工作台共用
 * 同一份）；本文件只剩两件东西：`ChatPanel`（外壳 + `PromptInputProvider`）与
 * `ChatPanelInner`（真正的数据接线、消息级编辑重发与删除）。
 *
 * 原来这个文件里堆了二十来个组件，已按「一块视图一个文件」拆开 —— 改哪块去哪个文件，
 * 别再往回堆：
 * - 空态 / 加载：`NewTaskView`（唯一的初始页）、`MessagesLoadError`；
 * - 输入区接线：`use-main-composer-props`（含两个编辑态类型）；
 * - 待发送附件 + 上传源：`use-attachment-draft`（初始页 `NewTaskView` 也用同一份）；
 * - 编辑条：`EditMessageBar`、`SteerEditBar`；
 * - 待发送队列 / 插话：`QueuedMessages`、`QueuedRow`、`PendingSteers`、`SteerRow`、
 *   `RowIconButton`、`ExpandableRowText`、`queue-list`（两张列表共用的尺寸）；
 * - ACP 档位：`AcpPermissionPill`、`AcpModePill`、`AcpThoughtLevelSelect`；
 * - 上下文圆环：`ContextRing`；用量：`UsageRow`；
 * - 两个受控选择器的会话版薄壳：`WorkspaceSelect`、`McpSelect`；
 * - ACP 判定：`session-backend`；加项目后选中：`select-new-workspace`。
 *
 * 流式期间最后一条 assistant 消息会不断长大：每个 SSE 帧折进 parts，React 重渲染。
 * 跑起来时右下角那颗钮是「停止」（输入框空着才有），一输入字它就换成发送 ——
 * 发送在跑着时一律进待发送队列（本轮结束后由泵自动接着发）；想让某一条**立刻**插进
 * 当前轮，点队列行上的 ➤ 就是插话（到下一个工具步骤边界生效）。
 *
 * 消息条 hover 会出现操作栏（复制 / 编辑并重发 / 删除从这里重新开始），与桌面端 Agent 对齐。
 * 编辑走「把文本灌进底部输入框 + 标记重发起点」，重发时先删掉该条及其后的全部消息再发；
 * 编辑期间有两处标识：输入框卡片内的「编辑消息」条与消息列表里那条消息的描边压暗
 * （见 `EditMessageBar` 与 `MessageList` 的 `editingMessageId`）。
 */
import { MessageSquare, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChatSurface, CopyOnlyActions } from "@fizz/agent-kit/features/chat/chat-surface";
import { ConvertAcpDialog } from "@fizz/agent-kit/features/chat/ConvertAcpDialog";
import { ForkDialog } from "@fizz/agent-kit/features/chat/ForkDialog";
import { MessageActionRow } from "@fizz/agent-kit/features/chat/message-parts";
import { MessageQuoteLayer } from "@fizz/agent-kit/features/chat/quotes";
import { requestOpenWorkspaceFile } from "@fizz/agent-kit/features/files/open-file";
import { ArtifactChips } from "@fizz/agent-kit/shared/ai-elements/artifact-chips";
import { useConfirm } from "@fizz/agent-kit/shared/components/ConfirmProvider";
import {
  PromptInputProvider,
  usePromptInputController,
} from "@fizz/agent-kit/shared/ai-elements/prompt-input";
import { presentedDocsOf } from "@fizz/agent-kit/shared/lib/artifacts";
import { fileRefsOfParts } from "@fizz/agent-kit/shared/lib/attachments";
import { textOf } from "@fizz/agent-kit/shared/lib/parts";
import { takePendingDraft } from "@fizz/agent-kit/shared/lib/pending-draft";
import { buildQuotedText, type MessageQuote } from "@fizz/agent-kit/shared/lib/quotes";
import { useAppContext } from "@fizz/agent-kit/shared/hooks/use-app-context";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type AgentChatMessage } from "@fizz/contracts/types";
import { MessagesLoadError } from "@fizz/agent-kit/features/chat/MessagesLoadError";
import { NewTaskView } from "@fizz/agent-kit/features/chat/NewTaskView";
import { UsageRow } from "@fizz/agent-kit/features/chat/UsageRow";
import { activeConversationIsAcp } from "@fizz/agent-kit/features/chat/session-backend";
// 输入区接线；两个编辑态类型由它自己导出，本文件持有对应的 state，形状必须是同一份
import {
  useMainComposerProps,
  type EditingMessage,
  type EditingSteer,
} from "@fizz/agent-kit/features/chat/use-main-composer-props";
import { useAttachmentDraft } from "@fizz/agent-kit/features/chat/use-attachment-draft";

// 供侧边栏「编辑并重发」在消息 hover 栏上复用：把消息文本灌进输入框并标记重发起点。
// 通过 usePromptInputController 在 Provider 内取值，因此这里把逻辑拆到 ChatPanel 内层组件。

/**
 * 对话面板：`PromptInputProvider` 必须在最外层 —— 侧栏「编辑并重发」要把文本灌进这里
 * 的草稿，而草稿持有者（`ChatSurface` 的 `composer`）在面板内部。
 */
/**
 * @param panelKey 这个 ChatPanel 所属**标签**的面板 key（`ConversationTab` 传它自己那个：
 * 会话 id，或「新对话」标签的 `draft:<工作区>`）。消息下方的文档入口要把右侧「文件」面板
 * 挂出来，**必须挂在这个标签自己的面板上** —— 用 Provider 的 `showSideTab`（那是「当前
 * 会话」）会在多标签 / 分屏下把面板开到别的标签上。
 */
export function ChatPanel({
  app,
  panelKey,
}: {
  app: AgentApp;
  panelKey: string;
}) {
  return (
    /*
      `key` + `draftKey` 都绑到标签 key：草稿按会话隔离（真实会话 = 会话 id，
      「新对话」= `draft:<工作区>`），刷新后由 Provider 从 localStorage 读回。
      换标签时必须重挂 Provider —— 它只在挂载时读一次存档（见 prompt-input.tsx）。
    */
    <PromptInputProvider key={panelKey} draftKey={panelKey}>
      <ChatPanelInner app={app} panelKey={panelKey} />
    </PromptInputProvider>
  );
}

/**
 * 主会话面板：把 `useAgentApp` 的状态接到共用的 `ChatSurface` 上。
 *
 * 骨架（消息列表 / 输入区 / 落底指示器 / 消息目录）在 `chat/chat-surface.tsx`，与容器
 * 工作台同一份；这里只给主会话特有的东西：
 * - 消息流上方的连接中断 sticky 条；会话累计用量已从顶部移除
 * - 一轮结束后的用量统计行（随消息落盘）；
 * - 消息级操作（编辑重发 / 删除）+ 待发送队列 + 工作区 / 模型 / 权限 pill。
 */
function ChatPanelInner({
  app,
  panelKey,
}: {
  app: AgentApp;
  panelKey: string;
}) {
  const t = useT();
  /** 命令式二次确认（重试消息会不可逆地删历史，见 `onRetry`） */
  const confirm = useConfirm();
  const { messages, streaming, activeWorkspace } = app;
  /**
   * 协作会话：`@` 候选来自当前会话的 Agent 名单；实时回复来自 `app.collab.liveText`
   * （流式期间先挂在消息末尾，本轮结束由权威历史替换）。
   */
  const activeConversation = app.conversations.find(
    (item) => item.id === app.activeConversationId,
  );
  const collabAgents =
    activeConversation?.kind === "collab" ? (activeConversation.collab?.agents ?? []) : [];
  const mentionCandidates = collabAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
  }));
  const collabLiveMessages: AgentChatMessage[] = collabAgents.flatMap((agent) => {
    const text = app.collab?.liveText[agent.id] ?? "";
    const parts = app.collab?.liveParts[agent.id] ?? [];
    if (!text && parts.length === 0) return [];
    return [
      {
        id: `collab-live-${agent.id}`,
        role: "assistant" as const,
        parts: parts.length > 0 ? parts : [{ type: "text" as const, text }],
        createdAt: 0,
        agentId: agent.id,
        agentName: agent.name,
      },
    ];
  });
  const { textInput } = usePromptInputController();
  /**
   * 正在编辑重发的消息（null = 没在编辑）。编辑条引的是 `text`（原文），重发起点是 `id`。
   * ⚠️ 这个 id 是**某个会话里的消息 id**，所以连会话 id 一起记 —— 它只在那个会话里成立。
   */
  const [editing, setEditing] = useState<EditingMessage | null>(null);
  /**
   * 正在编辑的插话（null = 没在编辑）。与 `editing`（重发）同款：条上引原文，id 认条。
   * 点 ✎ 时这条已经移出收件箱，所以不按收件箱成员校验 —— 只看「换会话」与「本轮还在跑」。
   */
  const [editingSteer, setEditingSteer] = useState<EditingSteer | null>(null);
  /** 「从此签出」弹窗的终点消息：非空 = 弹窗开着（见 renderActions 的 onFork） */
  const [forkTarget, setForkTarget] = useState<string | null>(null);
  /**
   * 「转为内置 Agent 会话」弹窗的终点消息：非空 = 弹窗开着（见 renderActions 的 onConvert）。
   * 转换是形态变更、且要顺带选新会话落在哪个工作区（当前工作区分叉 / 新建 worktree），
   * 所以先弹确认再执行（`ConvertAcpDialog`）。
   */
  const [convertTarget, setConvertTarget] = useState<string | null>(null);

  /**
   * 面板动作（`showSideTabOf`）：消息下方的文档入口要先把**这个标签自己的**右侧「文件」
   * 面板挂出来，再把「打开哪个文件」的请求交给它（见 `renderArtifacts` 与
   * `features/files/open-file.ts`）。
   *
   * ⚠️ 用 `showSideTabOf(panelKey, …)` 而不是 `showSideTab(…)`：后者按「当前会话」找面板，
   * 多标签 / 分屏下会把面板开到**别的**标签上（那个会话凭空多出一个文件面板，这个标签
   * 却什么都没发生）。
   */
  const { showSideTabOf } = useAppContext();

  /**
   * 待发送附件 + 上传源：整套状态与上传逻辑由 `useAttachmentDraft` 持有 —— 初始页
   * （`NewTaskView`）用的是同一份，否则「新建会话时没有回形针」那种分叉会再犯。
   */
  const {
    attachments,
    onPickFiles,
    uploadProviders,
    uploadProviderId,
    setUploadProviderId,
    loadUploadProviders,
    removeAttachment,
    restoreAttachments,
    collectSendFiles,
    hasUploadingAttachment,
    clearAttachments,
  } = useAttachmentDraft(app);
  // ---------- 引用（划选消息里的文字）----------
  /**
   * 挂在输入框上方的引用片。与附件同款：**不落库**、换会话即清空、发出即清空；
   * 发送时由 `buildQuotedText` 拼进正文（不是独立字段，见 lib/quotes.ts 头注释）。
   */
  const [quotes, setQuotes] = useState<MessageQuote[]>([]);

  // 换会话清空：引用是「本会话没发出的草稿」，带到别的会话发出去只会发错地方
  //（附件的同一份清理在 `useAttachmentDraft` 里，同样跟着会话走）
  const draftConversationId = app.activeConversationId;
  useEffect(() => {
    setQuotes([]);
  }, [draftConversationId]);

  // acp 会话的消息在 agent 侧：编辑 / 删除这类「本地历史」操作没有对象，只给「复制」
  const activeIsAcp = activeConversationIsAcp(app);
  // 队列「编辑」把消息写回输入框后，聚焦到 textarea 让用户接着改
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 助手调 `create_conversation` 建好会话后带来的提示词 → 灌进这个会话的输入框。
   *
   * 放在 effect 里而不是派发那一刻：app-shell 是先导航、这边后挂上（见 lib/pending-draft.ts），
   * 单槽里存着不会漏。`takePendingDraft` 只在 id 命中时取走，所以打开别的会话不受影响。
   *
   * ⚠️ 是**替换**草稿不是追加：草稿是全局的、刻意跨会话保留（见下面「编辑态失效」的说明），
   * 这里是例外 —— 用户刚让助手建了个会话，输入框里那半句多半是上一个会话的残留，
   * 替他清掉比留着更糟。「只预填、不自动发」，发送与否交给用户。
   *
   * `setInput` 特意挪进 rAF 回调、不在 effect 体里同步调：同步 setState 会白白多跑一轮
   * 渲染（react-hooks/set-state-in-effect）。本来就要等一帧让 ChatSurface 把文本渲染进
   * textarea 才能聚焦，正好合成一步 —— 焦点早了就落空。
   */
  useEffect(() => {
    const prompt = takePendingDraft(app.activeConversationId);
    if (!prompt) return;
    requestAnimationFrame(() => {
      textInput.setInput(prompt);
      textareaRef.current?.focus();
    });
    // 依赖里的 `textInput` 是整个对象：Provider 拿输入框**字符串**当 useMemo 依赖
    // （prompt-input.tsx），所以每敲一个字它就换一个新引用，本 effect 会跟着重跑 ——
    // 无害，重跑也只是 `takePendingDraft` 的一次空判（单槽取走即清）。
  }, [app.activeConversationId, textInput]);

  /**
   * 编辑态失效的两种情况，都在渲染期直接判掉（React 的「渲染时调整 state」写法：
   * 不把过期状态提交出去，也省掉 effect + setState 的下一轮渲染）：
   *
   * 1. 会话变了：重发起点属于原会话，带到新会话上就是往新会话里发消息、同时把旧会话
   *    从那条起的历史删掉。草稿（`textInput`）是全局的、刻意不动 —— 用户可能自己
   *    敲了半句还没发，替他清掉比留着更糟（标识没了而已，文本还在）；
   * 2. 被编辑的那条不在消息列表里了（历史重拉 / 删过它）：别让重发起点变成野 id
   *    （拿它去 `deleteMessagesFrom` 只会白失败一次）。
   *    ⚠️ 装载窗口里 `messages` 是空的 —— 那不是「消息没了」，所以要等装载完再判。
   */
  if (
    editing &&
    (editing.conversationId !== app.activeConversationId ||
      (!app.messagesLoading && !messages.some((m) => m.id === editing.id)))
  ) {
    setEditing(null);
  }
  // 插话编辑态失效：换会话（id 只在那个收件箱里有意义）/ 本轮跑完了（收件箱语义
  // 已消失 —— 编辑条若还挂着「重新插回当前轮」就是撒谎）。文本留在草稿里不丢。
  if (
    editingSteer &&
    (editingSteer.conversationId !== app.activeConversationId || !streaming)
  ) {
    setEditingSteer(null);
  }

  /** 退出编辑态：清标记 + 清掉输入框里那份草稿 + 清附件（附件正是从这条消息回显来的） */
  const cancelEdit = (): void => {
    setEditing(null);
    textInput.clear();
    clearAttachments();
    textareaRef.current?.focus();
  };

  /** 退出插话编辑态：同上 —— 草稿就是这条插话灌进来的，清掉 */
  const cancelEditSteer = (): void => {
    setEditingSteer(null);
    textInput.clear();
    textareaRef.current?.focus();
  };

  /**
   * 点「插入中」列表的 ✎：与队列编辑同款三步 —— 写回输入框、移出收件箱（agent
   * 从此看不到它，防编辑期间被边界消费掉）、记编辑态（发送时走 steer 重新插回）。
   * 同时摘掉重发编辑态：一次只编辑一个东西，发送路由才不会打架。
   *
   * 附件与队列编辑同款回显：从这条插话的 file parts 还原（`restoreAttachments` 是
   * 整份替换，所以「这条没附件」会顺手清掉输入框里现有的附件 —— 与「编辑」语义一致）。
   */
  const startEditSteer = (item: AgentChatMessage): void => {
    const t = textOf(item);
    setEditing(null);
    setEditingSteer({
      id: item.id,
      text: t,
      conversationId: app.activeConversationId,
    });
    void app.removeSteer(item.id);
    textInput.setInput(t);
    restoreAttachments(fileRefsOfParts(item.parts), `steer-${item.id}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /**
   * 草稿区里那些**一次性资源**（附件 + 引用）的清理。
   *
   * 只在「这一轮确实要发」时才调（作为 store 的 `onStarted` 回调），**不在提交那一刻**：
   * 提交时就清等于赌这一轮一定发得出去 —— 被本地守卫拦下（没选模型 / 配置被删 / 连不上
   * 服务端）时，用户会发现自己不光消息没发出去，连刚拖进来的附件和挂的引用也没了。
   */
  const clearDraftArea = (): void => {
    clearAttachments();
    setQuotes([]);
  };

  /** 输入区接线：发送走重发分支（有编辑起点）/ 插话分支（在编辑插话）还是普通发送 */
  const composer = useMainComposerProps(app, {
    textareaRef,
    editing,
    onCancelEdit: cancelEdit,
    editingSteer,
    onCancelEditSteer: cancelEditSteer,
    onEditSteer: startEditSteer,
    attachments,
    onPickFiles,
    onAttachFiles: onPickFiles,
    uploadProviders,
    uploadProviderId,
    onSelectUploadProvider: setUploadProviderId,
    onRefreshUploadProviders: () => void loadUploadProviders(),
    onRemoveAttachment: removeAttachment,
    onRestoreQueueFiles: (files, seed) => restoreAttachments(files, seed),
    quotes,
    onRemoveQuote: (id) => setQuotes((prev) => prev.filter((q) => q.id !== id)),
    onSubmit: (text, onStarted) => {
      const target = editing;
      const steerTarget = editingSteer;
      const files = collectSendFiles();
      // 任一附件还在上传 → 不发（sendDisabled 已拦住按钮与 Enter，这里是兜底）
      if (hasUploadingAttachment) return false;
      // 引用拼进正文（markdown 引用块）：三条出口（普通发送 / 编辑重发 / 编辑插话）
      // 共用这一份拼装 —— 队列、插话因此天然带上引用（都是同一个 text）。
      // 拼一次、后面都递 `body`，别在各分支里各拼一遍（早晚漏一处）。
      const body = buildQuotedText(quotes, text);
      // 先摘掉编辑态再发：发出去的就是「编辑后的新消息」，输入框里不该还挂着编辑条。
      // 被拦下时再放回去（见下面两处的 `started`）—— 那两条消息**没被删**，用户还停
      // 在「编辑它」的语境里，编辑条与高亮就该原样在。
      setEditing(null);
      setEditingSteer(null);
      // 三条出口都把 `onStarted` 透传下去：输入框与草稿区都只在「确认开跑」后清，
      // 被拦下 / 建会话失败时用户写的内容原样还在（见 useMainComposerProps）
      if (target) {
        // 编辑并重发：先删掉该条及其后的全部消息再发（见 ChatPanel 文件头）
        const started = app.resendMessage(target.id, body, files, () => {
          onStarted();
          clearDraftArea();
        });
        // 拦下（没选模型 / 配置被删）：历史没删、消息还在，编辑态一并还回去。
        // 只在这个分支挂 `.then` —— 正常路径上编辑条已经在上面的 setEditing(null)
        // 摘掉了，不能等到 `onStarted` 才摘
        void started
          .then((ok) => {
            if (!ok) setEditing(target);
          })
          .catch(() => {});
        return started;
      }
      if (steerTarget) {
        // 编辑插话：重新走 steer（本轮还在跑 → 插回收件箱；刚好跑完 →
        // steer 自身回落普通发送，消息不离客户端）。附件一起递回 —— 不回传
        // 就会在这条路径上把图丢掉（编辑前明明回显在输入框里）
        const started = app.steer(body, files, () => {
          onStarted();
          clearDraftArea();
        });
        // 同上：拦下时把「正在编辑这条插话」还回去（它进编辑态时已从收件箱摘掉，
        // 这时还没插回去，所以留着编辑条才是诚实的）
        void started
          .then((ok) => {
            if (!ok) setEditingSteer(steerTarget);
          })
          .catch(() => {});
        return started;
      }
      return app.send(body, files, () => {
        onStarted();
        clearDraftArea();
      });
    },
  });

  // 初始页：没打开任何会话时（点「新建会话」/ 首次进入），中央输入框 + 下方选工作空间。
  //
  // **一个项目都没有也走这里**（与 web / 桌面一致）。以前的「还没有项目」引导页已删：
  // 它把「先建项目才能聊」当成前提，而输入框下面那颗工作区选择本来就能添加项目 /
  // 不绑项目直接聊 —— 多出去一屏拦一道，手机上是白占一屏。
  // 也正因为不再有那道 gate，「项目清单还没拉回来」不会被误判成「没有项目」，
  // 骨架屏（`NewTaskSkeleton`）随之没用，一并删了。
  if (!app.activeConversationId) return <NewTaskView app={app} />;

  return (
    <>
      <ChatSurface
        list={{
          messages,
          // 多智能体协作的实时回复：本轮结束前挂在末尾，不挂操作行
          ...(collabLiveMessages.length ? { liveMessages: collabLiveMessages } : {}),
          // 消息区上拉刷新（`onRefresh` → `reloadConversation`）要知道重拉哪一条 ——
          // 多标签下同时挂着好几条会话，不能读「当前会话」
          ...(app.activeConversationId ? { conversationId: app.activeConversationId } : {}),
          streaming,
          // 断线重连的回放窗口：滚动跟随降级成瞬时贴底（否则内容先塌后长时会被
          // 弹簧带着从顶部一路滚下来，观感是「列表像在重新加载」）
          replaying: app.replaying,
          // 模型请求正在重试：在「正在思考…」的位置显示单条「第 N 次重试」
          retryNotice: app.retryNotice,
          // 连接断了但服务端那轮还在跑：在「正在思考…」的位置显示「连接中断，正在重连」
          reconnectNotice: app.reconnectNotice,
          // 上下文交接文档：挂在触发压缩的那条助手消息里（和思考 part 同形态），
          // 不再占用列表顶部的 sticky 位置
          compaction: app.compaction,
          // resetKey：切换会话 / 消息装载完成 / **自己发出新消息**时立刻落底
          // （滚动容器内部同步赋值，无动画）
          resetKey: `${app.activeConversationId ?? ""}#${app.scrollResetSeq}`,
          // 正在编辑重发的那条消息（描边压暗）——与输入框卡片内的编辑条是一对
          editingMessageId: editing?.id ?? null,
          /**
           * 「继续」：撞上步数上限的那条消息底部那颗按钮。
           *
           * 发一条**真实的用户消息**而不是内部续跑：用户要能在历史里看见「这里是我让它
           * 继续的」。文案把「为什么停」写进去 —— 模型看不到界面上那行提示，这句话是它
           * 唯一的交接说明。
           */
          onContinueMessage: () =>
            void app.send(
              "继续（上一轮达到工具步数上限被停下，请接着未完成的部分继续，不要重复已完成的工作）"
            ),
          // 正在删消息：消息区压暗 + 不收点击 + 顶部「正在删除…」（删除完成后要整体
          // 回拉历史，中途再点别的消息只会让两边互相盖）
          deleting: app.messagesDeleting,
          header: (
            <>
              {/*
              切换会话的装载窗口：id 已切过去、历史还没拉回来。这里必须显示装载中 ——
              否则会一直挂着上一个会话的消息列表，用户在它上面删除 / 编辑拿的是旧 id
              配新会话，服务端对不上就报错（见 useAgentApp.openConversation 的注释）。
            */}
              {app.reconnectNotice && (
                <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
                  <span className="inline-flex items-center gap-1 font-medium text-foreground">
                    <Unplug className="size-3.5" />
                    {t("连接中断")}
                  </span>
                  <span>
                    {t("正在自动重连（第 {attempt} 次）· 服务端这一轮还在跑，接上就接着出", {
                      attempt: app.reconnectNotice.attempt,
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void app.reconnectRun(app.activeConversationId ?? "")
                    }
                    className="ml-auto rounded border px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-foreground/10"
                  >
                    {t("立即重连")}
                  </button>
                </div>
              )}
            </>
          ),
          // 会话历史加载失败：错误态 + 重试（替代原本静默吞掉的空视图）
          error:
            app.messagesError &&
            !app.messagesLoading &&
            messages.length === 0 ? (
              <MessagesLoadError
                error={app.messagesError}
                onRetry={app.retryLoadMessages}
              />
            ) : undefined,
          loading: app.messagesLoading,
          emptyState: (
            <div className="flex flex-col items-center gap-2 text-center">
              <MessageSquare className="size-8 opacity-40" />
              <div className="text-sm font-medium">
                {activeWorkspace
                  ? t("在「{name}」里说点什么", { name: activeWorkspace.name })
                  : t("先添加一个工作区")}
              </div>
              <div className="text-xs text-muted-foreground">
                {activeWorkspace
                  ? t("Agent 会在该目录内执行命令、读写文件；工作区外的路径一律拒绝")
                  : t("工作区就是 Agent 的边界：只有登记过的目录能被读写")}
              </div>
            </div>
          ),
          followup: {
            requests: app.followupRequests,
            onResolve: (toolCallId, answer) => {
              void app.resolveFollowup(toolCallId, answer);
            },
            /**
             * 补答：那一轮已经结束（应用退出 / 停止 / 进程崩了），提问卡上的答案回填不到
             * 工具里 —— 当一条普通用户消息发出去（文本由 `formatFollowupAnswer` 拼好，
             * 带着题目，模型才知道在回答什么）。会话正在跑时 `send` 会入队，不会插队。
             */
            onResume: (text) => {
              void app.send(text);
            },
          },
          /**
           * 消息下方的**文档入口**：本轮写出 / 改动的 markdown 文档（设计稿 /
           * 方案 / 规格等）各渲染成一颗 chip，点开在右侧「文件」面板里读 ——
           * 先是 `showSideTab('files')` 把面板挂出来（面板可能压根没开过），
           * 再递一条「打开这个文件」的请求。请求是**先存后取**的，面板这一刻
           * 才挂出来也不会丢（见 `features/files/open-file.ts`）。
           *
           * 为什么挂在消息下方而不是正文里：正文是模型说的话，工具卡是过程
           * （一轮结束还会被折叠）——「给你的交付物」需要一个稳定的位置。
           */
          renderArtifacts: (message) => {
            const docs = presentedDocsOf(message);
            if (docs.length === 0) return null;
            return (
              <ArtifactChips
                docs={docs}
                onOpen={(doc) => {
                  showSideTabOf(panelKey, "files");
                  requestOpenWorkspaceFile(
                    app.activeWorkspaceId ?? "",
                    doc.path,
                  );
                }}
              />
            );
          },
          /*
           * 「本轮用量」不再走 `renderFooter`（那一行比正文还宽、把消息列表压得很碎）。
           * 用户要求把它改成**与复制同一形态的一颗图标**、并排在同一行里 ——
           * 现在由 `renderActions` 通过 `usageSlot` 塞进操作行（见下面两处）。
           * `renderFooter` 就此不用了。
           */
          renderActions: ({ message, index, total }) => {
            /*
             * 「本轮用量」那颗图标：所有**助手**消息都给（只要有 usage）。
             * 内置 agent 每轮 finish 一定带 usage；ACP 没有（`acp.ts` 适配层丢弃），
             * 所以 ACP 会话自动就是「不显示」，不需要在这里判 activeIsAcp。
             * 用 `message.usage` 而不是「是不是末条」：历史里每一轮都有账目，
             * 翻上去看某一轮花了多少也是常见用法。
             */
            const usageSlot =
              message.role === "assistant" && message.usage ? (
                <UsageRow usage={message.usage} />
              ) : undefined;
            // acp 会话的历史在 agent 侧，改不了也删不掉 —— 挂「复制」+「从此转为内置会话」
            // （编辑 / 删除都给不了，见 `CopyOnlyActions`）
            if (activeIsAcp) {
              // 跑着 / 等答复时不给「从此转为内置 Agent 会话」：agent 侧那份转录还没落回
              // session，作为终点的历史会缺一段（与侧栏那一项的禁用判据同一道理）。
              return (
                <CopyOnlyActions
                  message={message}
                  index={index}
                  total={total}
                  usageSlot={usageSlot}
                  onConvert={
                    streaming ? undefined : () => setConvertTarget(message.id)
                  }
                />
              );
            }
            // 正在编辑重发的那条不挂 —— 编辑标识在「输入框上的编辑条 + 这条消息的描边」上，
            // 操作行再杵着只会诱导用户对着要重发的内容点删除（「流式末条不挂」由 MessageList 统一挡掉）
            if (message.id === editing?.id) return null;
            return (
              <MessageActionRow
                message={message}
                deleteCount={total - index}
                usageSlot={usageSlot}
                onRetry={
                  /*
                   * 「不改就重发」：与编辑重发同一条路（先删本条及其后的历史，再按原样发一轮），
                   * 只是不用把文本灌进输入框、也不用用户再按一次回车。
                   *
                   * 会话在跑 / 正在删历史时不给按钮：那两种状态下 `resendMessage` 会静默返回
                   * false（`deleteMessagesFrom` 有守卫），点了等于没反应 —— 不如先不摆出来。
                   * 其余失败（没选模型 / 目标被删）仍可能发生，用 toast 给个响：这条路径没有
                   * 编辑条那种「把状态还回去」的可见载体。
                   *
                   * 点了先**二次确认**再动手：这条路径会不可逆地删掉本条及其后的全部历史，
                   * 而按钮就挤在 hover 操作行里、紧挨着只读的复制 —— 误点一下就是整段对话没了，
                   * 还会连带重新跑一轮（费 token）。与队列删除同一形态：`useConfirm` 弹 AlertDialog，
                   * 描述里带上原文摘要，让人看清删的是哪条。
                   */
                  streaming || app.messagesDeleting
                    ? undefined
                    : () => {
                        const text = textOf(message);
                        const files = fileRefsOfParts(message.parts);
                        // 空文本且无附件：没有什么可重试的（与 onEdit 的判据同一套）
                        if (!text && files.length === 0) return;
                        void (async () => {
                          const ok = await confirm({
                            title: t("重试这条消息？"),
                            description: (
                              <span className="block space-y-1">
                                <span className="block whitespace-pre-wrap break-words line-clamp-6">
                                  {text || t("（仅附件）")}
                                </span>
                                <span className="block">
                                  {t(
                                    "将删除这条及其后的全部消息，再按原文重新发送（不可撤销）。",
                                  )}
                                </span>
                              </span>
                            ),
                            confirmLabel: t("重试"),
                            destructive: true,
                          });
                          if (!ok) return;
                          void app
                            .resendMessage(
                              message.id,
                              text,
                              files.length ? files : undefined,
                            )
                            .then((sent) => {
                              if (!sent) {
                                toast.error(
                                  t("没能重试：检查模型与会话状态后再试"),
                                );
                              }
                            })
                            .catch(() => {});
                        })();
                      }
                }
                onEdit={() => {
                  const t = textOf(message);
                  const fileParts = message.parts.filter(
                    (p) => p.type === "file",
                  );
                  // 空文本但带附件的历史消息也能编辑（附件回显就是编辑的起点之一）
                  if (!t && fileParts.length === 0) return;
                  // 灌原文 + 记住起点；聚焦到输入框让用户接着改。
                  // 同时摘掉插话编辑态：一次只编辑一个东西
                  setEditingSteer(null);
                  textInput.setInput(t);
                  // 附件回显：编辑带附件的消息时，附件回到输入框附件区（用户明确要求）
                  restoreAttachments(
                    fileParts.map((f) => ({
                      name: f.name,
                      mediaType: f.mediaType,
                      url: f.url,
                    })),
                    `edit-${message.id}`,
                  );
                  setEditing({
                    id: message.id,
                    text: t,
                    conversationId: app.activeConversationId,
                  });
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                onDelete={(mode) => {
                  void (mode === "single"
                    ? app.deleteMessage(message.id)
                    : app.deleteMessagesFrom(message.id));
                }}
                onFork={() => setForkTarget(message.id)}
              />
            );
          },
          // 消息目录：用户消息各占一段，悬停预览、点击跳转
          outline: true,
        }}
        composer={
          mentionCandidates.length
            ? { ...composer, mentionCandidates }
            : composer
        }
      />
      {/* 消息区划选 → 浮出「引用」按钮。浮层自挂 body（fixed），放在渲染树哪一层都行 */}
      <MessageQuoteLayer onQuote={(q) => setQuotes((prev) => [...prev, q])} />
      <ForkDialog
        app={app}
        messageId={forkTarget}
        open={forkTarget !== null}
        onOpenChange={(o) => {
          if (!o) setForkTarget(null);
        }}
      />
      {/* 「转为内置 Agent 会话」确认弹窗：与「从此签出」同一个壳（选工作区 / 建 worktree） */}
      <ConvertAcpDialog
        app={app}
        conversationId={app.activeConversationId ?? ""}
        messageId={convertTarget}
        open={convertTarget !== null}
        onOpenChange={(o) => {
          if (!o) setConvertTarget(null);
        }}
      />
    </>
  );
}
