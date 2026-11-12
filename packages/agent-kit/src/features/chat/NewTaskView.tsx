// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { ChatComposer } from "@fizz/agent-kit/features/chat/chat-surface";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { useMainComposerProps } from "@fizz/agent-kit/features/chat/use-main-composer-props";
import { useAttachmentDraft } from "@fizz/agent-kit/features/chat/use-attachment-draft";

/**
 * 初始页：中央输入框 + 下方常驻的工作区选择行（不指定项目也能直接聊）。
 *
 * 附件与正式会话走**同一份**草稿（`useAttachmentDraft`）：截图 / 图片先行的对话是
 * 最常见的开场（「这是什么」），初始页少了回形针，用户只能先随便发一句把会话建出来。
 * 发送即建会话，附件随这一轮一起落库（`app.send` 的 `files` 参数本来就支持）。
 */
export function NewTaskView({ app }: { app: AgentApp }) {
  const t = useT()
  const draft = useAttachmentDraft(app)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 sm:px-6 pb-20">
      <div className="w-full max-w-2xl">
        <div className="mb-5 flex flex-col items-center gap-1 text-center space-y-4">
          <div className="text-lg font-semibold">{t('开始新对话')}</div>
        </div>
        {/* 草稿在「确认开跑」后才清：建 ACP 会话要先起外部进程，失败时输入框必须还在 */}
        <ChatComposer
          {...useMainComposerProps(app, {
            attachments: draft.attachments,
            onPickFiles: draft.onPickFiles,
            onAttachFiles: draft.onPickFiles,
            uploadProviders: draft.uploadProviders,
            uploadProviderId: draft.uploadProviderId,
            onSelectUploadProvider: draft.setUploadProviderId,
            onRefreshUploadProviders: () => void draft.loadUploadProviders(),
            onRemoveAttachment: draft.removeAttachment,
            onSubmit: (text, onStarted) => {
              // 附件还在上传 → 不发（按钮与 Enter 已拦，这里是兜底）
              if (draft.hasUploadingAttachment) return false
              const files = draft.collectSendFiles()
              return app.send(text, files, () => {
                onStarted()
                // 这一轮发出去才清：被本地守卫拦下（没选模型 / 配置被删 / 连不上）时，
                // 用户刚拖进来的附件必须还在输入框里
                draft.clearAttachments()
              })
            }
          })}
        />
      </div>
    </div>
  );
}
