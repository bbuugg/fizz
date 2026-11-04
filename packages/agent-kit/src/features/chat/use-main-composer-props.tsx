// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { useRef, type RefObject } from "react";
import {
  AttachmentPreviewRow,
  AttachmentUploadButton,
} from "@fizz/agent-kit/features/chat/attachments";
import { type ChatComposerProps } from "@fizz/agent-kit/features/chat/chat-surface";
import { ConfirmQueue } from "@fizz/agent-kit/features/chat/ConfirmCard";
import { BackgroundTaskDock } from "@fizz/agent-kit/features/chat/BackgroundTaskDock";
import { ModelSelect } from "@fizz/agent-kit/features/chat/ModelSelect";
import { ReasoningEffortSelect } from "@fizz/agent-kit/features/chat/ReasoningEffortSelect";
import { QuotePreviewRow } from "@fizz/agent-kit/features/chat/quotes";
import { usePromptInputController } from "@fizz/agent-kit/shared/ai-elements/prompt-input";
import {
  sendableAttachments,
  type ChatAttachment,
} from "@fizz/agent-kit/shared/lib/attachments";
import { shouldClearChatDraft } from "@fizz/agent-kit/shared/lib/chat-draft";
import { type MessageQuote } from "@fizz/agent-kit/shared/lib/quotes";
import type { SlashCommandContext } from "@fizz/agent-kit/shared/lib/slash-commands";
import {
  builtinSlashCommands,
  resolveSlashDispatchFor,
} from "@fizz/agent-kit/shared/lib/slash-commands";
import type { UploadFileRef, UploadProviderView } from "@fizz/contracts/agent-api";
import { PermissionPill } from "@fizz/agent-kit/features/chat/composer";
import {
  ComposerToolbar,
  ComposerToolbarPlaceholder,
} from "@fizz/agent-kit/features/chat/ComposerToolbar";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type AgentChatMessage } from "@fizz/contracts/types";
import { AcpModePill } from "@fizz/agent-kit/features/chat/AcpModePill";
import { AcpPermissionPill } from "@fizz/agent-kit/features/chat/AcpPermissionPill";
import { AcpThoughtLevelSelect } from "@fizz/agent-kit/features/chat/AcpThoughtLevelSelect";
import { ContextRing } from "@fizz/agent-kit/features/chat/ContextRing";
import { EditMessageBar } from "@fizz/agent-kit/features/chat/EditMessageBar";
import { McpSelect } from "@fizz/agent-kit/features/chat/McpSelect";
import { PendingSteers } from "@fizz/agent-kit/features/chat/PendingSteers";
import { QueuedMessages } from "@fizz/agent-kit/features/chat/QueuedMessages";
import { SteerEditBar } from "@fizz/agent-kit/features/chat/SteerEditBar";
import { WorkspaceSelect } from "@fizz/agent-kit/features/chat/WorkspaceSelect";
import { turnIsAcp } from "@fizz/agent-kit/features/chat/session-backend";

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
     * 插话：跑一轮时发送钮选「插话」后调用（文本已 trim，`files` 是本次要带走的
     * 可发附件）。不传（初始页）/ ACP 会话 / 编辑态下都不暴露这颗钮的能力 ——
     * 那时「跑着 + 有内容」仍只给普通发送。`onStarted` 语义同 `onSubmit`。
     */
    onSteer?: (
      text: string,
      files: UploadFileRef[],
      onStarted: () => void,
    ) => void | boolean | Promise<boolean>;
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
    /** 上传入口选中文件（回形针 → 图片 / PDF）；不传 = 不渲染上传按钮、也不接管粘贴与拖放 */
    onPickFiles?: (files: FileList | File[]) => void;
    /** 可用上传源（内置 + 插件注册的）；不传 / 只有一个 = 上传菜单里不出现选择器 */
    uploadProviders?: UploadProviderView[];
    /** 当前选中的上传源（null = 用服务端的缺省那个） */
    uploadProviderId?: string | null;
    /** 切换上传源（选择状态归 ChatPanel 持有） */
    onSelectUploadProvider?: (id: string) => void;
    /**
     * 重新拉一遍上传源清单。上传按钮在**菜单打开时**调它 —— 这样在设置里刚启用的
     * 上传插件不必等切换项目 / 刷新页面。
     */
    onRefreshUploadProviders?: () => void;
    /**
     * 粘贴（截图 / 复制的图片）或拖拽进来的文件 —— 与 `onPickFiles` 是同一条链路，
     * 只是入口不同。不传 = 输入框不接管粘贴与拖放（空态）。
     */
    onAttachFiles?: (files: File[]) => void;
    /** 从预览行移除一条附件 */
    onRemoveAttachment?: (id: string) => void;
    /** 队列「编辑」写回时还原附件（seed 用来生成稳定的附件 id） */
    onRestoreQueueFiles?: (files: UploadFileRef[], seed: string) => void;
    /**
     * 已挂上的引用片（划选消息里的文字得到）：输入卡片 header 里显示、
     * 发送时拼进正文。不传 = 本输入框没有引用交互（初始页）。
     */
    quotes?: MessageQuote[];
    /** 移除一片引用 */
    onRemoveQuote?: (id: string) => void;
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
  const { streaming, activeWorkspace } = app;
  const isAcp = turnIsAcp(app);
  const running = streaming;
  const slashContext: SlashCommandContext = { app, running };
  /**
   * 插话能力：只给 **内置后端的已打开会话** —— steer 依赖服务端把消息注入
   * 内置 循环，ACP 会话的协议给不了；初始页（还没有会话）也没有「当前这一轮」可插。
   */
  const canSteer = !!app.activeConversationId && !isAcp;
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
  const dispatchSlashCommand = (text: string): boolean => {
    const all = builtinSlashCommands(slashContext);
    const outcome = resolveSlashDispatchFor(text, all, (c) =>
      c.available ? c.available(slashContext) : true,
    );
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
    // 插话（发送钮选择器的一项）：只在「已打开会话 + 非 ACP + 非编辑态」时暴露给
    // Composer，否则发送钮保持普通发送。草稿与附件的读取、清空在这里统一处理，
    // 调用方（ChatPanelInner）只管把文本 + 附件送进收件箱。
    ...(canSteer && opts.onSteer && !opts.editing && !opts.editingSteer
      ? {
          onSteer: () => {
            const trimmed = textInput.value.trim();
            const files = sendableAttachments(opts.attachments ?? []);
            // 空草稿 + 无附件 + 无引用 = 没有要插的内容；只带附件 / 只带引用都合法
            if (
              !trimmed &&
              files.length === 0 &&
              (opts.quotes ?? []).length === 0
            )
              return;
            // 手动压缩进行中禁发（与 onSubmit 同一道守卫）
            if (app.contextCompressing) return;
            opts.onSteer?.(trimmed, files, () => clearDraftAfterStarted(trimmed));
          },
        }
      : {}),
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
     * 「发送即建会话」期间发送钮转圈（见 store 的 `creatingConversation`）。
     *
     * 只有**还没打开会话**时才有意义：已打开的会话发消息不建会话，`send` 直接进
     * `runRound` 的流式那一段，转圈会变成「点了没反应又忽然开始流」。ACP 那条路最慢
     * （起外部 agent 进程 + `session/new`），内置模型也一并转 —— 反正都是同一条建会话链路，
     * 分支只会多一处不一致。
     */
    sending: !app.activeConversationId && app.creatingConversation,
    placeholder: activeWorkspace
      ? t("交给 Agent 做点什么…（Enter 发送，Shift+Enter 换行）")
      : t("有什么想问的？…（不指定项目，会话存在服务端）"),
    // 输入框卡片内（`header`）从上到下三块：编辑条（正在改哪条历史）/ 编辑插话条
    // （正在改哪条未生效插话）/ 插入中列表 + 待发送队列，都与输入框浑然一体
    //（各自自带底部分隔线）
    //
    // ⚠️ 这里**刻意不再挂 `DndProvider`**：整个应用的唯一 manager 由 `app-shell`
    // 的根 provider 提供（它传了自定义 `context`，见那里的 `DND_CONTEXT` 注释）。
    // 之前在这里再挂一个，StrictMode 把单例槽清空后它就会**再造一个 HTML5 后端** ——
    // 队列 / 插话列表挂到新后端、标签页落区还挂在旧后端上，表现为「拖拽落区永远不响应」。
    // 直接用 Fragment 包住即可，队列与插话两张列表照样共用同一个 manager。
    header: (
      <>
        {(opts.quotes ?? []).length > 0 && opts.onRemoveQuote ? (
          <QuotePreviewRow
            quotes={opts.quotes ?? []}
            onRemove={opts.onRemoveQuote}
          />
        ) : null}
        {(opts.attachments ?? []).length > 0 && opts.onRemoveAttachment ? (
          <AttachmentPreviewRow
            attachments={opts.attachments ?? []}
            onRemove={opts.onRemoveAttachment}
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
        <PendingSteers app={app} onEdit={opts.onEditSteer} />
        <QueuedMessages
          app={app}
          onEdit={(item) => {
            // 点队列「编辑」：把这条（文本 + 附件）回填到输入框、移出队列，并聚焦输入框。
            // 附件回显回调由 ChatPanelInner 注入（restoreAttachments 在那边）
            textInput.setInput(item.text);
            opts.onRestoreQueueFiles?.(item.files ?? [], `queue-${item.id}`);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
        />
      </>
    ),
    // 输入框卡片上方：工具条（能力开关，常驻）+ confirm 模式待答复的审批
    //（工具卡默认折叠，折起来就等于没提示，所以审批卡也要放这儿）。
    // 工具条排在审批卡之上：它常驻、位置固定，审批卡插在它与输入框之间
    above: (
      <>
        {/* 浏览器 / MCP 开关只在 内置（本地）链路生效：browser_* 工具与提示词里的浏览器
            说明只在那边注入，ACP 走外部 agent，它自带工具、也不读会话的 browserSettings /
            MCP 勾选。所以 ACP 会话里这一排干脆**不渲染** —— 两颗点不动的灰图标只会让人
            以为是自己没配好。
            ⚠️ 只有「开始新对话」页（还没成会话）保留同高占位：那里能当场把模型从内置切到
            外部 Agent（`ModelSelect` 的 ACP 组，有会话就换不了类型），少了这一行输入卡片
            会在切换的瞬间往上跳 32px（用户反馈过）。已打开的会话不会再切后端，扒掉不抖。 */}
        {isAcp ? (
          app.activeConversationId ? null : (
            <ComposerToolbarPlaceholder
              // 与真工具条的隐藏判据同源：没装浏览器 / 没配 MCP 时那两颗不出现，
              // 占位也得跟着少画，否则切回内置 agent 的那一下高度对不上
              browser={app.browserInstalled}
              mcp={app.mcpServers.length > 0}
            />
          )
        ) : (
          <ComposerToolbar app={app}>
            {/* MCP 从 `trailing` 搬上来：它与浏览器同属「给这一轮装能力」 */}
            <McpSelect app={app} />
          </ComposerToolbar>
        )}
        {/*
          会话自己的后台进程（agent 用 runInBackground 起的 dev server / watch）：
          排在审批卡**之上** —— 审批是「现在必须答」的，任务只是「顺便看一眼」，
          抢不到位置时就该它让位（面板自己在 min(200px,24vh) 内滚）。
          没有会话、或这个会话没有后台任务时它自己返回 null，不占位。
        */}
        {app.activeConversationId && !isAcp && (
          <BackgroundTaskDock app={app} conversationId={app.activeConversationId} />
        )}
        {app.pendingConfirms.length > 0 && (
          <ConfirmQueue
            confirms={app.pendingConfirms}
            onResolve={app.resolveConfirm}
          />
        )}
      </>
    ),
    /*
     * 输入卡片**下方**：工作区选择行（含「未指定工作区」）——**只在空会话时**出现。
     *
     * 会话的 `workspaceId` 落库后不可改，进了会话还摆一行「切换工作区」只会让人以为
     * 能改当前会话的归属（点它其实只会把人踢回空会话）。会话的归属在顶栏那行只读
     * 事实里看就够了；要换归属就点「新建会话」回空态，那一行自然又出现。
     */
    below: app.activeConversationId ? null : <WorkspaceSelect app={app} />,
    leading: (
      <>
        {/* 上传附件：内置会话专属（ACP 链路只发纯文本）——排在最左，与 ainav 的回形针一致 */}
        {!isAcp && opts.onPickFiles && (
          <AttachmentUploadButton
            disabled={!activeWorkspace}
            onPick={opts.onPickFiles}
            providers={opts.uploadProviders}
            providerId={opts.uploadProviderId}
            onSelectProvider={opts.onSelectUploadProvider}
            onMenuOpen={opts.onRefreshUploadProviders}
          />
        )}
        {/* 工具权限：非 ACP 会话用内置三档 `permissionMode` —— 只有 内置 那条路读它
            （runAgent → tools 的 guardWrite）。ACP 那边要控权限是 agent 自己发
            session/request_permission，所以这里给的是**答复策略**（确认 / 完全放行，按会话记住）；
            agent 自己的模式（opencode 的 build / plan）在右侧模型选择器之后 */}
        {isAcp ? (
          <AcpPermissionPill app={app} />
        ) : (
          <PermissionPill
            value={app.permissionMode}
            onChange={app.setPermissionMode}
          />
        )}
      </>
    ),
    trailing: (
      <>
        {/* 上下文用量圆环：模型选择左侧；点击出详情 + 手动压缩。
            ACP 会话也渲染：agent 通过 session/update 的 usage_update 上报占用
            （→ 流事件 context-usage → 消息的 contextUsage），圆环用 agent 实测的
            分子 / 分母；本地压缩那几项对 ACP 不可用，组件里按 isAcp 隐掉 */}
        <ContextRing app={app} />
        <ModelSelect app={app} />
        {/* 思考强度：内置 Agent 专属；ACP 的思考档由下面的 AcpThoughtLevelSelect 负责 */}
        {!isAcp && <ReasoningEffortSelect app={app} />}
        {/* 模式：**只有 opencode 风格**才显示（build / plan），摆在模型选择器之后；
            没有模式时返回 null —— 不做中性 pill */}
        <AcpModePill app={app} />
        {/* 思考档：**只有 pi 风格**才显示（pi 用 configOptions 的 thought_level 表达它，
            不是 Session Modes）；没有思考档时返回 null */}
        <AcpThoughtLevelSelect app={app} />
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
