/**
 * 主会话输入区的附件交互（图片 / 文档）：上传入口 + 待发送预览行。
 *
 * 交互对齐 ainav/sdk 的 ChatInput：回形针 → 向上弹几项（图片 / 文档）→ 各自的
 * 隐藏 file input（可多选）。预览行改成了 dissolve 上传瓦片（见 `dissolve/`）：上传中由
 * 颗粒逐颗拼成卡片，完成后才露出移除钮；取消 / 移除 / 失败都以颗粒散开收场。状态
 * （ChatAttachment[]）归 ChatPanel 持有，这里只收 state + 回调。
 */
import { useRef, type RefObject } from 'react'
import { FileText, ImageIcon, Paperclip } from 'lucide-react'
import { UPLOAD_DOCUMENT_ACCEPT, UPLOAD_IMAGE_ACCEPT } from '@fizz/contracts/agent-api'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { CHAT_ICON_PILL } from '@fizz/agent-kit/features/chat/composer'
import type { ChatAttachment } from '@fizz/agent-kit/shared/lib/attachments'
import { DissolveAttachmentRow } from '@fizz/agent-kit/features/chat/dissolve/UploadTray'

/**
 * 操作行最左的上传入口。向上弹（side="top" + sideOffset 6）与权限 / 模型 pill 同款
 * （触发器都贴着窗口底部，popper 向上才不顶出屏幕）；触发器用 title 而非 IconTip ——
 * 与 `ModelPicker` 的触发器同款（Tooltip.Trigger 与 DropdownMenuTrigger 双 asChild 嵌套没必要）。
 */
export function AttachmentUploadButton({
  disabled,
  imagesSupported = true,
  onPick
}: {
  disabled?: boolean
  imagesSupported?: boolean
  onPick: (files: FileList | File[]) => void
}) {
  const imageRef = useRef<HTMLInputElement>(null)
  const documentRef = useRef<HTMLInputElement>(null)
  const tr = useT()
  const pick = (input: HTMLInputElement | null) => input?.click()

  const inputEl = (ref: RefObject<HTMLInputElement | null>, accept: string) => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      multiple
      className="hidden"
      onChange={(e) => {
        if (e.target.files?.length) onPick(e.target.files)
        e.target.value = ''
      }}
    />
  )

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={tr('上传附件')}
            title={tr('上传附件（图片 / 文档）')}
            disabled={disabled}
            className={CHAT_ICON_PILL}
          >
            <Paperclip className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={6}>
          <DropdownMenuItem disabled={!imagesSupported} onSelect={() => pick(imageRef.current)}>
            <ImageIcon className="size-4" />
            {tr('图片')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => pick(documentRef.current)}>
            <FileText className="size-4" />
            {tr('文档')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {inputEl(imageRef, UPLOAD_IMAGE_ACCEPT)}
      {inputEl(documentRef, UPLOAD_DOCUMENT_ACCEPT)}
    </>
  )
}

/**
 * 待发送附件的预览行：渲染在输入卡片 header 槽位的最上方（队列区之上）。
 *
 * 每一条是一张 dissolve 上传瓦片（见 `dissolve/upload-tile.ts`）：上传时由颗粒逐颗
 * 拼成卡片、完成才露出移除钮，取消 / 移除 / 失败都以颗粒散开收场。
 */
export function AttachmentPreviewRow({
  attachments,
  onRemove,
  onCancelUpload
}: {
  attachments: ChatAttachment[]
  onRemove: (id: string) => void
  /** 上传中点击瓦片取消（不传 = 点了不会取消，但也不会误删） */
  onCancelUpload?: (id: string) => void
}) {
  return (
    <DissolveAttachmentRow
      attachments={attachments}
      onRemove={onRemove}
      onCancelUpload={onCancelUpload}
    />
  )
}
