/**
 * 输入框的**待发送附件**（图片 / PDF）：占位（本地预览 + 进度）→ 上传完成（服务端 url）。
 *
 * 为什么抽成 hook：**初始页也要能带附件**。`NewTaskView`（还没有会话，发送即建会话）与
 * `ChatPanelInner`（已有会话）是两个组件，但「回形针 / 粘贴 / 拖拽 → 上传 → 发送时带上」
 * 这一整套完全一样。各写一份的结果是行为悄悄分叉 —— 用户报过：新建会话时左侧根本没有
 * 回形针，发出第一条消息之后才出现（那时才切到 ChatPanel）。
 *
 * 状态**不落库**（与 ainav 一致）：换会话 / 组件卸载即清空，异步回调（进度 / 完成）
 * 读 ref 镜像，不吃闭包旧值。编辑回显 / 队列回显也是往这里灌（uploaded: true 的服务端引用）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  nextAttachmentId,
  readImagePreview,
  sendableAttachments,
  splitUploadable,
  type ChatAttachment,
} from "@fizz/agent-kit/shared/lib/attachments";
import { useAgentStore } from "@fizz/agent-kit/shared/lib/stores/agent-store";
import { attachmentsSupported } from "@fizz/agent-kit/features/chat/session-backend";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import type { UploadFileRef, UploadProviderView } from "@fizz/contracts/agent-api";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";

/**
 * 清单为空时共用一个常量引用：`setUploadProviders` 拿到同一个引用会直接 bail out，
 * 不白跑一轮渲染。
 */
const NO_UPLOAD_PROVIDERS: UploadProviderView[] = [];

export interface AttachmentDraft {
  /** 预览行要渲染的待发送附件 */
  attachments: ChatAttachment[];
  /**
   * 上传入口选中文件。三个入口共用这一条链路：回形针选文件（`FileList`）、
   * 粘贴截图、拖拽文件（`File[]`）。
   */
  onPickFiles: (picked: FileList | File[]) => void;
  /** 当前上下文可用的上传源（内置 + 插件注册的） */
  uploadProviders: UploadProviderView[];
  /** 这次上传用哪个源（null = 服务端的缺省那个） */
  uploadProviderId: string | null;
  setUploadProviderId: (id: string | null) => void;
  /**
   * 重新拉一遍上传源清单。**两个时机**：换项目时（清单跟着项目走），以及打开回形针
   * 菜单时 —— 后者是「刚在设置里启用了上传插件」那条路径的唯一刷新点。
   */
  loadUploadProviders: () => Promise<void>;
  removeAttachment: (id: string) => void;
  /** 从消息 / 队列条目还原附件回显（整份替换，见实现处的注释） */
  restoreAttachments: (files: UploadFileRef[], seed: string) => void;
  /** 发送时提交的附件：剥掉未完成 / 失败的（三处出口共用一份，见 lib/attachments） */
  collectSendFiles: () => UploadFileRef[];
  /** 还有附件在上传中 —— 发送前要拦一下（按钮与 Enter 已拦，这里是兜底） */
  hasUploadingAttachment: boolean;
  /** 清空草稿区（发送确认开跑 / 退出编辑态时清） */
  clearAttachments: () => void;
}

const EMPTY_ATTACHMENTS: ChatAttachment[] = [];

export function useAttachmentDraft(app: AgentApp): AttachmentDraft {
  const t = useT();
  const [attachments, setAttachments] = useState<ChatAttachment[]>(EMPTY_ATTACHMENTS);
  const attachmentsRef = useRef<ChatAttachment[]>(EMPTY_ATTACHMENTS);
  const setBothAttachments = (next: ChatAttachment[]): void => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
  /** 就地更新一条附件（进度 / 完成 / 失败） */
  const updateAttachment = (
    id: string,
    patch: Partial<ChatAttachment>,
  ): void => {
    setBothAttachments(
      attachmentsRef.current.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
  };
  const clearAttachments = (): void => setBothAttachments(EMPTY_ATTACHMENTS);

  // ---------- 上传源（内置存储 + 插件注册的）----------
  /**
   * 当前可用上传源 + 这次用哪个。**按项目现拉**：插件目录是按项目扫的（项目级插件
   * 也能提供上传源），所以换项目要重拉。拉不到就当「只有内置」—— 上传本身照常可用，
   * 不值得为一份清单弹错打扰用户。
   *
   * 选择本身是用户偏好，**不随会话切换重置**（换到别的项目时下面会回落成缺省那个）。
   * 初始页没有项目（`activeWorkspaceId` 为空）时清单只有内置 + 全局插件 —— 上传照常，
   * 服务端那一步本来也不要求 workspace。
   */
  const [uploadProviders, setUploadProviders] =
    useState<UploadProviderView[]>(NO_UPLOAD_PROVIDERS);
  const [uploadProviderId, setUploadProviderId] = useState<string | null>(null);
  const uploadProvidersApi = app.api;
  const uploadProvidersWorkspaceId = app.activeWorkspaceId;
  /** 代次防护：晚到的旧项目响应不许覆盖当前项目的清单 */
  const uploadProvidersGenRef = useRef(0);
  const loadUploadProviders = useCallback(async (): Promise<void> => {
    if (!uploadProvidersApi) return;
    const gen = ++uploadProvidersGenRef.current;
    try {
      const list = await uploadProvidersApi.listUploadProviders(
        uploadProvidersWorkspaceId ?? undefined,
      );
      // 空数组用共享常量：引用不变 → React 直接 bail out，不白跑一轮渲染
      if (gen === uploadProvidersGenRef.current) {
        setUploadProviders(list.length ? list : NO_UPLOAD_PROVIDERS);
      }
    } catch {
      /* 清单拿不到 = 只有内置那一个源，静默处理 */
    }
  }, [uploadProvidersApi, uploadProvidersWorkspaceId]);
  useEffect(() => {
    void loadUploadProviders();
  }, [loadUploadProviders]);
  /** 这次上传用哪个源：显式选的（还在清单里）→ 服务端缺省那个 → 第一个 */
  const selectedUploadProvider = useMemo(
    () =>
      uploadProviders.find((p) => p.id === uploadProviderId) ??
      uploadProviders.find((p) => p.isDefault) ??
      uploadProviders[0],
    [uploadProviders, uploadProviderId],
  );

  // 换会话清空：附件是「本会话没发出的草稿」，带到别的会话发出去只会发错地方
  const draftConversationId = app.activeConversationId;
  useEffect(() => {
    setBothAttachments(EMPTY_ATTACHMENTS);
  }, [draftConversationId]);

  const onPickFiles = (picked: FileList | File[]): void => {
    /**
     * ACP agent 明确声明不收图（`promptCapabilities.image === false`）→ 当场拒。
     * 放它到协议层只会收到一句 JSON-RPC invalid params，用户根本看不出是自己带了图。
     * 未探测（`undefined`）与内置会话都放行 —— 前端不替服务端判模型能力。
     */
    if (!attachmentsSupported(app)) {
      toast.error(
        t("当前 Agent 不支持图片输入，请改用文字描述，或把文件放进工作区"),
      );
      return;
    }
    // 知道用哪个上传源时**只按它的 accept 判**（插件可以比契约宽，也可以更窄）；
    // 清单还没拉到就退回契约口径，服务端那一关才是最终判据
    const { ok: okFiles, rejected } = splitUploadable(
      picked,
      selectedUploadProvider
        ? {
            mime: selectedUploadProvider.acceptMime,
            maxBytes: selectedUploadProvider.maxBytes,
          }
        : undefined,
    );
    for (const r of rejected) toast.warning(`${r.name}：${r.reason}`);
    if (okFiles.length === 0) return;
    const api = app.api;
    if (!api) {
      toast.error(t("未连接服务端，无法上传附件"));
      return;
    }
    // 预览是异步的：选完文件到占位上屏之间用户可能已切会话 —— 以 store 的实时快照
    // 判归属（闭包里的 app.activeConversationId 是渲染时旧值，判不了），不一致就丢弃
    const pickedIn = app.activeConversationId;
    // 上传源在**选中文件那一刻**定下来（整批一样）：之后用户改选别的源，不该把已经
    // 在传的那几条挪走 —— 每条附件落到哪儿，是它自己带的信息（见 ChatAttachment.provider）
    const providerAtPick = selectedUploadProvider?.id;
    const workspaceAtPick = app.activeWorkspaceId ?? undefined;
    for (const file of okFiles) {
      const id = nextAttachmentId();
      const placeholder: ChatAttachment = {
        id,
        name: file.name,
        mediaType: file.type,
        url: "",
        uploaded: false,
        progress: 0,
        ...(providerAtPick ? { provider: providerAtPick } : {}),
      };
      // 图片先出本地预览（失败不致命——占位卡退回图标形态），随后立刻开传
      const withPreview: Promise<ChatAttachment> = file.type.startsWith(
        "image/",
      )
        ? readImagePreview(file)
            .then((previewUrl) => ({ ...placeholder, previewUrl }))
            .catch(() => placeholder)
        : Promise.resolve(placeholder);
      void withPreview.then((att) => {
        // 会话已切走：占位不能追加进新会话（useEffect 刚清空的正是它）
        if (useAgentStore.getState().activeConversationId !== pickedIn) return;
        attachmentsRef.current = [...attachmentsRef.current, att];
        setAttachments(attachmentsRef.current);
        void api
          .uploadFile(file, {
            onProgress: (percent) =>
              updateAttachment(id, { progress: percent }),
            provider: providerAtPick,
            workspaceId: workspaceAtPick,
          })
          .then((result) =>
            updateAttachment(id, {
              url: result.url,
              uploaded: true,
              progress: 100,
              // 服务端回的就是它实际用的那个源，以它为准（缺省 / 回落都在那边发生）
              provider: result.provider ?? providerAtPick,
            }),
          )
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : t("上传失败");
            updateAttachment(id, { error: message });
            toast.error(`${file.name}：${message}`);
          });
      });
    }
  };
  const collectSendFiles = (): UploadFileRef[] =>
    sendableAttachments(attachments);
  const hasUploadingAttachment = attachments.some(
    (a) => !a.uploaded && !a.error,
  );
  /**
   * 从消息 / 队列条目还原附件回显（uploaded: true 的服务端引用，图片预览走服务端 url）。
   *
   * 是**整份替换**：所以「这条消息没有附件」会顺手清掉输入框里现有的附件 ——
   * 与「编辑并重发」的语义一致（编辑的就是它，不该夹带上一次的残留）。
   */
  const restoreAttachments = (files: UploadFileRef[], seed: string): void => {
    setBothAttachments(
      files.map((f, i) => ({
        id: `${seed}-${i}`,
        name: f.name,
        mediaType: f.mediaType,
        url: f.url,
        uploaded: true,
        progress: 100,
        // 回显保留它原来是哪个源传的（`undefined` = 该字段出现之前的老附件）
        ...(f.provider ? { provider: f.provider } : {}),
      })),
    );
  };
  const removeAttachment = (id: string): void =>
    setBothAttachments(attachmentsRef.current.filter((a) => a.id !== id));

  return {
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
  };
}
