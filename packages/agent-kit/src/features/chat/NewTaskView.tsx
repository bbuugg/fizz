// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { ChatComposer } from "@fizz/agent-kit/features/chat/chat-surface";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { WorkspaceSelect } from "@fizz/agent-kit/features/chat/WorkspaceSelect";
import { useMainComposerProps } from "@fizz/agent-kit/features/chat/use-main-composer-props";
import { useAttachmentDraft } from "@fizz/agent-kit/features/chat/use-attachment-draft";

/**
 * 初始页：标题句（工作区入口内嵌）+ 中央输入框。
 *
 * 标题「在 ▁▁▁ 里做点什么？」里的空位条就是工作区入口：点了弹与输入行同一个
 * `WorkspacePicker`，未选工作区时是一条不依赖字符的淡色空位条（换字体不走形），
 * 选中后宽度补间展开成名字、整句重新居中。工作区选择因此**不再占**输入框
 * 下方那条常驻横条 —— 那条只留 git / 权限 / 上下文。
 *
 * 附件与正式会话走**同一份**草稿（`useAttachmentDraft`）：截图 / 图片先行的对话是
 * 最常见的开场（「这是什么」），初始页少了回形针，用户只能先随便发一句把会话建出来。
 * 发送即建会话，附件随这一轮一起落库（`app.send` 的 `files` 参数本来就支持）。
 */
export function NewTaskView({ app }: { app: AgentApp }) {
  const t = useT()
  const draft = useAttachmentDraft(app)
  // 文案里的 `{workspace}` 由下面的工作区入口顶替（英文语序也靠这个占位符保持通顺）
  const [before, after] = t('在 {workspace} 里做点什么？').split('{workspace}')
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 sm:px-6 pb-20">
      <div className="w-full max-w-2xl">
        <div className="mb-3 flex flex-wrap items-baseline justify-center gap-x-1 text-center text-xl font-semibold">
          <span>{before.trim()}</span>
          <WorkspaceSelect app={app} variant="inline" />
          <span>{after.trim()}</span>
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
            onCancelUpload: draft.cancelUpload,
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
