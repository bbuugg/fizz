// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { useRef, type RefObject } from "react";
import {
  AttachmentPreviewRow,
  AttachmentUploadButton,
} from "@fizz/agent-kit/features/chat/attachments";
import { type ChatComposerProps } from "@fizz/agent-kit/features/chat/chat-surface";
import { ConfirmQueue } from "@fizz/agent-kit/features/chat/ConfirmCard";
import { ModelSelect } from "@fizz/agent-kit/features/chat/ModelSelect";
import { QuotePreviewRow } from "@fizz/agent-kit/features/chat/quotes";
import { usePromptInputController } from "@fizz/agent-kit/shared/ai-elements/prompt-input";
import {
  type ChatAttachment,
} from "@fizz/agent-kit/shared/lib/attachments";
import { shouldClearChatDraft } from "@fizz/agent-kit/shared/lib/chat-draft";
import { type MessageQuote } from "@fizz/agent-kit/shared/lib/quotes";
import type { SlashCommandContext } from "@fizz/agent-kit/shared/lib/slash-commands";
import {
  builtinSlashCommands,
  resolveSlashDispatchFor,
} from "@fizz/agent-kit/shared/lib/slash-commands";
import type { UploadFileRef } from "@fizz/contracts/agent-api";
import { ComposerToolbar } from "@fizz/agent-kit/features/chat/ComposerToolbar";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type AgentChatMessage } from "@fizz/contracts/types";
import { AcpModePill } from "@fizz/agent-kit/features/chat/AcpModePill";
import { ComposerStatusBar } from "@fizz/agent-kit/features/chat/ComposerStatusBar";
import { EditMessageBar } from "@fizz/agent-kit/features/chat/EditMessageBar";
import { McpSelect } from "@fizz/agent-kit/features/chat/McpSelect";
import { QueuedMessages } from "@fizz/agent-kit/features/chat/QueuedMessages";
import { SteerEditBar } from "@fizz/agent-kit/features/chat/SteerEditBar";
import { attachmentsSupported } from "@fizz/agent-kit/features/chat/session-backend";
import { AskFollowupPanel } from "@fizz/agent-kit/shared/ai-elements/followup-card";

/**
 * 主会话输入区的接线：草稿（`PromptInputProvider`）/ 发送 / 停止 / 两侧 pill。
 *
 * 「开始新对话」初始页与正式会话共用这一份 —— 两边的输入框本来就该一模一样，初始页只是
 * 没有重发起点（不传 `editing`，输入框里也不会出现「编辑消息」条）。
 *
 * @param onSubmit 已 trim 的文本。**普通发送与「编辑并重发」的区分留给调用方** —— 初始页
 *   永远只是发新消息，正式会话还要先删掉被编辑那条及其后的消息（`resendMessage`）。
 */
export function useMainComposerProps(
  app: AgentApp,
  opts: {
    /**
     * 提交一条草稿。第二个参数是「这一轮确认开跑」的回调（由 store 的 `onStarted`
     * 一路透传而来）—— **输入框只在这里清**，不在提交那一刻清。
     *
     * 为什么不看返回值：`send` 返回的 Promise 要等整轮跑完才 resolve，等它清会把草稿
     * 一直留在输入框里；而「开始新对话」建 ACP 会话要起外部进程，失败时又不能把用户
     * 写的内容吃掉。`onStarted` 恰好是「会话已建好、消息已落本地」那一刻。
     */
    onSubmit: (text: string, onStarted: () => void) => void | boolean | Promise<boolean>;
    /**
     * 只入队、不立刻发（发送方式下拉里的「放入队列」）。不传 = 不显示带下拉的发送钮。
     *
     * 与 `onSubmit` 同一个签名、同样由 store 的 `onStarted` 驱动清草稿 —— 入队是本地
     * 同步动作，调用方会立刻回调它，输入框随即清空。
     */
    onEnqueue?: (text: string, onStarted: () => void) => void | boolean;
    /** 暴露 textarea 引用（编辑队列消息写回输入框后聚焦用）；不传则内部自建 */
    textareaRef?: RefObject<HTMLTextAreaElement | null>;
    /** 正在编辑重发的那条消息（非空时输入框卡片内显示「编辑消息」条）；初始页没有 */
    editing?: EditingMessage | null;
    /** 退出编辑态：清编辑标记 + 清输入框里的草稿 */
    onCancelEdit?: () => void;
    /** 正在编辑的插话（非空时输入框卡片内显示「编辑插话」条）；不传 = 无此功能 */
    editingSteer?: EditingSteer | null;
    /** 退出插话编辑态：清编辑标记 + 清输入框里的草稿 */
    onCancelEditSteer?: () => void;
    /** 点「插入中」列表的 ✎：写回输入框 + 撤回收件箱 + 记编辑态（见 ChatPanelInner） */
    onEditSteer?: (item: AgentChatMessage) => void;
    /** 待发送附件（输入卡片 header 的预览行 + 发送门控）；不传 = 无附件交互 */
    attachments?: ChatAttachment[];
    /** 上传入口选中文件（回形针 → 图片 / 文档）；不传 = 不渲染上传按钮、也不接管粘贴与拖放 */
    onPickFiles?: (files: FileList | File[]) => void;
    /**
     * 粘贴（截图 / 复制的图片）或拖拽进来的文件 —— 与 `onPickFiles` 是同一条链路，
     * 只是入口不同。不传 = 输入框不接管粘贴与拖放（空态）。
     */
    onAttachFiles?: (files: File[]) => void;
    /** 从预览行移除一条附件 */
    onRemoveAttachment?: (id: string) => void;
    /** 上传中点击瓦片取消上传（散开动画结束后再由 onRemoveAttachment 删条目） */
    onCancelUpload?: (id: string) => void;
    /** 队列「编辑」写回时还原附件（seed 用来生成稳定的附件 id） */
    onRestoreQueueFiles?: (files: UploadFileRef[], seed: string) => void;
    /**
     * 已挂上的引用片（划选消息里的文字得到）：输入卡片 header 里显示、
     * 发送时拼进正文。不传 = 本输入框没有引用交互（初始页）。
     */
    quotes?: MessageQuote[];
    /** 移除一片引用 */
    onRemoveQuote?: (id: string) => void;
    /**
     * 这个输入框所属**标签**的 key（必填）：输入卡片下方那条状态横条（git 分支 / 文件入口
     * / 权限档 / 上下文）要改**本标签**的面板现场，得知道自己是哪颗标签。「开始新对话」页
     * 是一颗草稿标签，同样有 key、同样有状态横条 —— 别写成「没有 key 就不渲染」，
     * 那样新对话页会整条横条消失。
     */
    panelKey: string;
  },
): ChatComposerProps {
  const t = useT()
  const { textInput } = usePromptInputController();
  /**
   * 提交那一刻的草稿 / 最新草稿：`onStarted` 可能在几百毫秒后才到（ACP 建会话），
   * 这期间用户可能已经在输入框里改了字 —— 只有「还是提交的那一份」才清，
   * 别把人新敲的内容一起抹掉。
   */
  const latestDraftRef = useRef(textInput.value);
  latestDraftRef.current = textInput.value;
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = opts.textareaRef ?? ownRef;
  const { streaming } = app;
  const running = streaming;
  /**
   * 正在等用户回答的提问（`ask`）。服务端一次只挂一个；真有多条就
   * 先答当前这条，答复后下一条自然顶上来。
   */
  const pendingFollowup = Object.values(app.followupRequests)[0] ?? null;
  const slashContext: SlashCommandContext = { app, running };
  /**
   * 命令分发（submit 路径）：浮层只在「前缀输入阶段」开着，带了参数后 Enter 走的
   * 就是这里 —— 例如 `/{命令} 参数` 若不在这里接住会被当正文发出去。
   *
   * ⚠️ 「是不是命令」只看 **`/名字` 形状**，**不是**「以 `/` 开头」：以 `/` 开头的
   * 路径、正则、分隔符（`/usr/local/bin` 那种）是用户要发的正文，早先这里
   * 只要看见 `/` 就报「未知命令」并吞掉，现在由 `resolveSlashDispatchFor` 兜回
   * text 分支照常发送（用户报的 bug）。名字不在表里的 `/xxx` 同样归 text
   * （用户要求：认不出就照发，别拦正文）；拦下的只剩缺参数 / 当前会话不可用。
   * 编辑重发态不分发：那段文本是要原样重发的旧消息，不是命令语境。
   */
  const slashDispatchOf = (text: string) =>
    resolveSlashDispatchFor(text, builtinSlashCommands(slashContext), (c) =>
      c.available ? c.available(slashContext) : true,
    );
  const dispatchSlashCommand = (text: string): boolean => {
    const outcome = slashDispatchOf(text);
    if (outcome.kind === "run") {
      outcome.command.run(slashContext, outcome.args);
      return true;
    }
    if (outcome.kind === "reject") {
      app.setError(outcome.message);
      return true;
    }
    return false;
  };

  /**
   * 「这一轮确认开跑」后才收草稿。
   *
   * 发送路径上原本是「提交即清、被拦下再异步回填」，但「开始新对话」建 ACP 会话
   * 要先起外部 agent 进程 + `session/new`，空窗有几百毫秒到几秒；建会话失败时草稿
   * 虽然会被回填，中间那段「输入框空了」足够让用户以为消息丢了（用户报过）。
   * 改成只由 store 的 `onStarted` 驱动：会话没建出来就一个字都没动过。
   *
   * 回填兜底也一并去掉：只有真发出去才会调用这里，不需要「先清再还」。
   */
  const clearDraftAfterStarted = (draft: string): void => {
    // 比的是**两边都 trim 过**的内容：提交出去的是 trim 后的正文，而输入框里往往还留着
    // 尾随空格 / 换行（顺手回车、粘贴带换行、输入法上屏）—— 直接比原文会判成「用户又改过」，
    // 于是消息发出去了、输入框却没清空。判据见 `shouldClearChatDraft`。
    if (shouldClearChatDraft(latestDraftRef.current, draft)) textInput.clear();
  };

  /**
   * 「放入队列」何时不可用：
   * - 编辑态（重发 / 编辑插话）：这条要走的是「替换 / 重插」，再另存一份进队列只会重复；
   * - 斜杠命令：命令要在提交那一刻执行，进了队列就只是普通正文，等发出去时已经没意义。
   * 仍然显示成灰项（不是隐藏）—— 选项突然消失会让人以为功能没了。
   */
  const draftTrimmed = textInput.value.trim();
  const enqueueDisabled =
    !!opts.editing ||
    !!opts.editingSteer ||
    // 先看首字符再建命令表：这段在渲染期跑，流式时每来一个 token 都会执行一次
    (draftTrimmed.startsWith("/") && slashDispatchOf(draftTrimmed).kind !== "text");

  return {
    value: textInput.value,
    onChange: textInput.setInput,
    onSubmit: () => {
      const trimmed = textInput.value.trim();
      // 「只发附件、不打字」也放行（附件本身就是有效内容）：空正文守卫不能把
      // 带完成附件的提交拦在这里 —— ChatPanelInner.onSubmit 才是附件感知的那层。
      // 只挂引用不打字同理放行（引用内容本身就是有效上下文）
      const hasSendableAttachment = (opts.attachments ?? []).some(
        (a) => a.uploaded && a.url,
      );
      const hasQuote = (opts.quotes ?? []).length > 0;
      if (!trimmed && !hasSendableAttachment && !hasQuote) return;
      // 手动压缩进行中禁发（双保险：发送钮已灰、Enter 已拦在 Composer，这里兜住队列等入口）
      if (app.contextCompressing) return;
      // 编辑态不分发命令：重发原文 / 编辑中的插话不是命令语境（与编辑重发同理由）
      if (
        !opts.editing &&
        !opts.editingSteer &&
        dispatchSlashCommand(trimmed)
      ) {
        textInput.clear();
        return;
      }
      opts.onSubmit(trimmed, () => clearDraftAfterStarted(trimmed));
    },
    /**
     * 只入队、不立刻发：守卫与 `onSubmit` 同一套（空正文 + 附件 / 引用兜底、压缩中禁发），
     * 但**不分发斜杠命令** —— 入队的是正文，命令该走的执行路径不存在了，所以上面把
     * 这条入口直接灰掉（`enqueueDisabled`）。
     */
    onEnqueue: opts.onEnqueue
      ? () => {
          const trimmed = textInput.value.trim();
          const hasSendableAttachment = (opts.attachments ?? []).some(
            (a) => a.uploaded && a.url,
          );
          const hasQuote = (opts.quotes ?? []).length > 0;
          if (!trimmed && !hasSendableAttachment && !hasQuote) return;
          if (app.contextCompressing) return;
          opts.onEnqueue?.(trimmed, () => clearDraftAfterStarted(trimmed));
        }
      : undefined,
    enqueueDisabled,
    onCancel: () => void app.stop(),
    streaming,
    // 没有工作区也能聊（无项目会话）：不再按 `!activeWorkspace` 整体禁用输入框
    disabled: false,
    // 上传中的附件禁发（连同压缩中的合并进 sendDisabled：Enter 与发送钮一起拦）
    sendDisabled:
      app.contextCompressing ||
      (opts.attachments ?? []).some((a) => !a.uploaded && !a.error),
    // 禁发原因说明（上传优先于压缩文案：两个同时为真时用户该先等上传）
    sendDisabledHint: (opts.attachments ?? []).some(
      (a) => !a.uploaded && !a.error,
    )
      ? t("附件上传中，等上传完成后再发")
      : undefined,
    // 有附件没文字也允许发（附件本身就是有效内容）；只有引用没文字同理
    allowEmptySend:
      (opts.attachments ?? []).length > 0 || (opts.quotes ?? []).length > 0,
    /**
     * 新建会话，以及已有 ACP 会话发送前的检测 / 恢复期间，发送钮转圈并拦住重复提交。
     * 准备失败时不触发 onStarted，正文、附件与引用继续留在输入框里。
     */
    sending: app.preparingSend || (!app.activeConversationId && app.creatingConversation),
    // 提示语不按工作区分支：没选项目也能聊（发送时服务端建临时工作区），
    // 换一句「不指定项目」的文案只会让人以为这里少了什么。
    placeholder: t("想让我帮你做什么…（Enter 发送，Shift+Enter 换行）"),
    // 输入框卡片内（`header`）从上到下：引用 / 附件预览 / 编辑条（正在改哪条历史）/
    // 编辑插话条（正在改哪条未生效插话）/ 统一的待发送列表（插话 + 队列），都与输入框浑然一体
    //（各自自带底部分隔线）
    //
    // ⚠️ 这里**刻意不再挂 `DndProvider`**：整个应用的唯一 manager 由 `app-shell`
    // 的根 provider 提供（它传了自定义 `context`，见那里的 `DND_CONTEXT` 注释）。
    // 之前在这里再挂一个，StrictMode 把单例槽清空后它就会**再造一个 HTML5 后端** ——
    // 队列 / 插话列表挂到新后端、标签页落区还挂在旧后端上，表现为「拖拽落区永远不响应」。
    // 直接用 Fragment 包住即可，插话与队列两组行照样共用同一个 manager。
    header: (
      <>
        {(opts.quotes ?? []).length > 0 && opts.onRemoveQuote ? (
          <QuotePreviewRow
            quotes={opts.quotes ?? []}
            onRemove={opts.onRemoveQuote}
          />
        ) : null}
        {/*
          行本身常驻（空列表时自己渲染 null）：最后一条附件的移除是「颗粒散开 + 整行
          高度收拢」两步，如果按 `length > 0` 在这里卸载，收起动画根本没机会播。
        */}
        {opts.onRemoveAttachment ? (
          <AttachmentPreviewRow
            attachments={opts.attachments ?? []}
            onRemove={opts.onRemoveAttachment}
            onCancelUpload={opts.onCancelUpload}
          />
        ) : null}
        {opts.editing ? (
          <EditMessageBar
            text={opts.editing.text}
            onCancel={opts.onCancelEdit}
          />
        ) : null}
        {opts.editingSteer ? (
          <SteerEditBar
            text={opts.editingSteer.text}
            onCancel={opts.onCancelEditSteer}
          />
        ) : null}
        {/* 待发送：队列与「插话中」合并成一张列表（顺序：插话在前，队列在后） */}
        <QueuedMessages
          app={app}
          onEdit={(item) => {
            // 点队列「编辑」：把这条（文本 + 附件）回填到输入框、移出队列，并聚焦输入框。
            // 附件回显回调由 ChatPanelInner 注入（restoreAttachments 在那边）
            textInput.setInput(item.text);
            opts.onRestoreQueueFiles?.(item.files ?? [], `queue-${item.id}`);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          onEditSteer={opts.onEditSteer}
        />
      </>
    ),
    // 输入框卡片上方：工具条（能力开关，常驻）+ 会话自己的后台进程。
    // ⚠️ 这一整块在 `cover`（审批卡 / 提问卡）出现时**整块让位**（见 `ChatComposer`）：
    // 等答复期间发不出消息，工具条点不动，后台进程也只是「顺便看一眼」，
    // 留着只会把「现在必须答」的那张卡往下挤。
    above: (
      <>
        {/* MCP 对内置 / ACP 都开放；浏览器适用范围与草稿占位由工具条独立处理。 */}
        <ComposerToolbar app={app}>
          <McpSelect app={app} />
        </ComposerToolbar>
        {/*
          会话自己的后台进程（agent 用 runInBackground 起的 dev server / watch）**不在这里**：
          它和「运行中的子智能体」合成了一排入口药丸，挂在 `ChatSurface` 的 `above` 里
          （见 `ComposerDock`）—— 两块本质是同一件事（「这个会话还有活在后台跑」），
          分两处渲染就会出现「一排在工具栏上、一张卡在审批卡下」的错位。

          位置：那一排**就贴在这一行的右端**（`ChatSurface` 的 `above` 壳用 `justify-between`
          把工具栏和它排成一行），不是另起一行挂在下面。所以这一行返回 `null` 时（浏览器
          没装、也没配 MCP）也要让壳保持满宽 —— 药丸量宽度靠的就是那条壳。

          ⚠️ 上面那一整块在 `cover`（审批卡 / 提问卡）出现时**整块让位**（见
          `ChatComposer`）：等答复期间发不出消息，工具条点不动，留着只会把「现在必须答」
          的那张卡往下挤。`ComposerDock` 继承同一套让位规则。
        */}
      </>
    ),
    /**
     * 待答复的审批 / 待回答的提问：**顶替输入卡片**（见 `ChatComposer` 的 `cover`）。
     *
     * 审批期间 agent 停着等答复，输入框没用；权限卡落在输入框的位置上比摞在它上方醒目，
     * 选项一多也不会把输入框越顶越高。选项在卡内整宽一行一个（见 `ConfirmCard`）。
     *
     * 优先级：审批 > 提问。两者都要求用户先答复，但审批是工具执行前的硬闸；把它排在
     * 前面，答复完这一项，提问会自动接上来（`followupRequests` 那时还在）。
     */
    cover:
      app.pendingConfirms.length > 0 ? (
        <ConfirmQueue
          confirms={app.pendingConfirms}
          onResolve={app.resolveConfirm}
        />
      ) : pendingFollowup ? (
        <AskFollowupPanel
          request={pendingFollowup}
          onResolve={(answer) =>
            void app.resolveFollowup(pendingFollowup.toolCallId, answer)
          }
        />
      ) : null,
    /*
     * 输入卡片**下方**：常驻状态横条（git 分支 / 权限档 / 上下文占用）。
     *
     * 工作区入口不在这里 —— 它在「开始新对话」页的标题句里（见 `NewTaskView`）。
     * `running` 传给横条：只有「这一轮正在跑」时 git 分支才置灰。
     */
    below: <ComposerStatusBar app={app} panelKey={opts.panelKey} running={streaming} />,
    leading: (
      <>
        {/* 上传不要求工作区；ACP 的图片能力只禁用图片选项，文档仍可提取为文字。 */}
        {opts.onPickFiles && (
          <AttachmentUploadButton
            disabled={!app.api}
            imagesSupported={attachmentsSupported(app)}
            onPick={opts.onPickFiles}
          />
        )}
      </>
    ),
    trailing: (
      <>
        {/*
          会随 Agent 切换而**出现 / 消失**的入口一律排在模型选择**左边**：
          模式（opencode 风格：build / plan）与思考档（pi 风格）都是 ACP 才有的，
          挂在模型右侧时，一切换 Agent 整排 pill 就把模型选择器往左挤一截。
          放左边之后模型 / 发送那一侧的位置稳定，变化只发生在左侧。
          两者没有对应能力时都返回 null。
        */}
        <AcpModePill app={app} />
        <ModelSelect app={app} />
      </>
    ),
    textareaRef,
    // 粘贴 / 拖拽进来的文件走同一条上传链路（`onPickFiles` 已能收 File[]）
    onAttachFiles: opts.onAttachFiles,
    // 斜线命令：`/` 浮出列表（Composer 渲染浮层，提交分发在 dispatchSlashCommand）。
    // 编辑态（重发 / 插话）不给命令 —— 那段文本不是命令语境
    ...(opts.editing || opts.editingSteer
      ? {}
      : {
          slashCommands: builtinSlashCommands(slashContext),
          slashContext,
        }),
  };
}

/**
 * 正在编辑重发的那条消息：`id` 是重发起点（重发时从它起删历史），`text` 是**原文**。
 *
 * 存原文而不只存 id：用户会在输入框里接着改，编辑条要引的是「改的是哪一条」的原文，
 * 拿输入框当前值当会在改了一半之后变成自引自。
 */
export interface EditingMessage {
  id: string;
  text: string;
  /** 消息所属会话：换会话后这条编辑态立刻作废（id 只在那个会话里有意义） */
  conversationId: string | null;
}

/**
 * 正在编辑的插话（插入中列表的 ✎）：`id` 只用来在收件箱里认「是哪条」，`text` 是**原文**
 * （引在编辑条上，用户改了草稿后仍能认出改的是哪条）。
 *
 * ⚠️ 点 ✎ 时就已把它移出收件箱（agent 从此看不到它），所以这里**不按收件箱成员关系
 * 校验** —— 收件箱里必然已经没有它了。有效性只看两件事：还在同一个会话、本轮还在跑
 * （跑完 = 收件箱语义已消失，重发就该是普通发送）。
 */
export interface EditingSteer {
  id: string;
  text: string;
  conversationId: string | null;
}
