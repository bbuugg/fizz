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
 * 下方那条常驻横条 —— 那条只留 git / 权限 / 上下文，由 `useMainComposerProps` 的
 * `below` 渲染，**这一页和正式会话都有**（按 `panelKey` 读写本标签的面板现场）。
 *
 * 附件与正式会话走**同一份**草稿（`useAttachmentDraft`）：截图 / 图片先行的对话是
 * 最常见的开场（「这是什么」），初始页少了回形针，用户只能先随便发一句把会话建出来。
 * 发送即建会话，附件随这一轮一起落库（`app.send` 的 `files` 参数本来就支持）。
 *
 * ## 居中必须是「安全居中」
 *
 * 手机键盘弹起会缩布局视口（见 `apps/mobile` 的 `interactive-widget=resizes-content`），
 * 这个 `flex-1` 容器可能比「标题 + 输入框」还矮。用 `justify-center` 时，内容会**同时向
 * 上下两侧溢出**：上沿画到 `ConversationTab` 的 `ViewHeader` 底下 —— header 是透明的，
 * 两行字直接叠在一起。所以改成容器 `overflow-y-auto` + 子块 `my-auto`：空间够时居中，
 * 不够时 auto margin 归零、内容从顶部开始并随容器滚动，永远不会越过 header。
 */
export function NewTaskView({
  app,
  panelKey
}: {
  app: AgentApp
  /**
   * 「新对话」页所在那颗**草稿标签**的 key（必填）：语音快捷键的作用域、输入框下方状态
   * 横条要改的面板现场，都按它找 —— 这颗标签的 key 终生不变，发出第一条消息后它只是
   * 指向了一条会话，现场原地不动。
   */
  panelKey: string
}) {
  const t = useT()
  const draft = useAttachmentDraft(app)
  // 文案里的 `{workspace}` 由下面的工作区入口顶替（英文语序也靠这个占位符保持通顺）
  const [before, after] = t('在 {workspace} 里做点什么？').split('{workspace}')
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto">
      {/* `shrink-0`：空间不足时保持内容原高、交给外层滚动，别让 flex 把它压扁 */}
      <div className="my-auto w-full max-w-2xl shrink-0 pb-20 pt-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-center gap-x-1 text-center text-xl font-semibold">
          <span>{before.trim()}</span>
          <WorkspaceSelect app={app} variant="inline" />
          <span>{after.trim()}</span>
        </div>
        {/* 草稿在「确认开跑」后才清：建 ACP 会话要先起外部进程，失败时输入框必须还在 */}
        <ChatComposer
          voiceScope={panelKey}
          {...useMainComposerProps(app, {
            panelKey,
            attachments: draft.attachments,
            onPickFiles: draft.onPickFiles,
            onAttachFiles: draft.onPickFiles,
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
              }, panelKey)
            }
          })}
        />
      </div>
    </div>
  );
}
