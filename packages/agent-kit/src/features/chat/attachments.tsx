/**
 * 主会话输入区的附件交互（图片 / PDF / 其它）：上传入口 + 待发送预览行。
 *
 * 交互对齐 ainav/sdk 的 ChatInput：回形针 → 向上弹几项（图片 / PDF / 其它文件）→ 各自的
 * 隐藏 file input（可多选）。预览行改成了 dissolve 上传瓦片（见 `dissolve/`）：上传中由
 * 颗粒逐颗拼成卡片，完成后才露出移除钮；取消 / 移除 / 失败都以颗粒散开收场。状态
 * （ChatAttachment[]）归 ChatPanel 持有，这里只收 state + 回调。
 *
 * **上传源选择器**：可选的源超过一个时（内置存储 + 装了上传插件），菜单底部多一段
 * 「传到哪儿」，点一下切换（选择状态同样归 ChatPanel）。只装了内置那一个源时这段不出现
 * —— 不给一个只有一个选项的下拉。
 */
import { useRef, type RefObject } from 'react'
import { Check, FileText, ImageIcon, Paperclip } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { CHAT_ICON_PILL } from '@fizz/agent-kit/features/chat/composer'
import type { ChatAttachment } from '@fizz/agent-kit/shared/lib/attachments'
import type { UploadProviderView } from '@fizz/contracts/agent-api'
import { DissolveAttachmentRow } from '@fizz/agent-kit/features/chat/dissolve/UploadTray'

/**
 * 操作行最左的上传入口。向上弹（side="top" + sideOffset 6）与权限 / 模型 pill 同款
 * （触发器都贴着窗口底部，popper 向上才不顶出屏幕）；触发器用 title 而非 IconTip ——
 * 与 `ModelPicker` 的触发器同款（Tooltip.Trigger 与 DropdownMenuTrigger 双 asChild 嵌套没必要）。
 */
export function AttachmentUploadButton({
  disabled,
  onPick,
  providers,
  providerId,
  onSelectProvider,
  onMenuOpen
}: {
  disabled?: boolean
  onPick: (files: FileList | File[]) => void
  /** 可选上传源（由 ChatPanel 按当前项目拉取）；不传 / 只有一个 = 不显示选择器 */
  providers?: UploadProviderView[]
  /** 当前选中的上传源（缺省那个用 null 表示） */
  providerId?: string | null
  onSelectProvider?: (id: string) => void
  /**
   * 菜单打开时回调（ChatPanel 用它重拉上传源清单）。
   *
   * 为什么要有：清单是**按项目拉的快照**，而在设置里刚启用一个上传插件、或刚往插件目录里
   * 放了文件时，这份快照是旧的 —— 不重拉的话用户会以为插件没生效（菜单里根本没那一项）。
   * 打开的这一刻重拉，是「即时而准确」最省的口子（不必轮询、不必全局状态）。
   */
  onMenuOpen?: () => void
}) {
  const imageRef = useRef<HTMLInputElement>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)
  const pick = (input: HTMLInputElement | null) => input?.click()

  /** 选择器里能选的源（插件可以声明 selectable:false 表示「只想被显式指定」） */
  const pickable = (providers ?? []).filter((p) => p.selectable)
  const selected =
    pickable.find((p) => p.id === providerId) ?? pickable.find((p) => p.isDefault) ?? pickable[0]
  /**
   * 「其它文件」这一项只在**选中的源支持图片 / PDF 之外的类型**时出现，`accept` 也按它算。
   * 少了这条，插件声明了 `text/csv` 这类 accept 也选不进来（回形针只认图片和 PDF）。
   */
  const extraAccept = (selected?.acceptMime ?? []).filter(
    (mime) => !mime.startsWith('image/') && mime !== 'application/pdf'
  )

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
      <DropdownMenu
        onOpenChange={(open) => {
          // 只在打开时重拉（关闭时没必要打一次服务端）
          if (open) onMenuOpen?.()
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="上传附件"
            title={
              selected && selected.id !== 'local'
                ? `上传附件（当前传到：${selected.title}）`
                : '上传附件（图片 / PDF）'
            }
            disabled={disabled}
            className={CHAT_ICON_PILL}
          >
            <Paperclip className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={6}>
          <DropdownMenuItem onSelect={() => pick(imageRef.current)}>
            <ImageIcon className="size-4" />
            图片
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => pick(pdfRef.current)}>
            <FileText className="size-4" />
            PDF
          </DropdownMenuItem>
          {extraAccept.length > 0 && (
            <DropdownMenuItem onSelect={() => pick(otherRef.current)}>
              <FileText className="size-4" />
              其它文件
            </DropdownMenuItem>
          )}
          {pickable.length > 1 && (
            <>
              <DropdownMenuSeparator />
              {pickable.map((provider) => (
                <DropdownMenuItem
                  key={provider.id}
                  onSelect={() => onSelectProvider?.(provider.id)}
                  title={provider.source === 'plugin' ? `插件：${provider.sourceName}` : '内置存储'}
                >
                  {/* 勾选位：用固定宽度的空位占位，避免未选中项文字错位 */}
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {selected?.id === provider.id && <Check className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{provider.title}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {inputEl(imageRef, 'image/*')}
      {inputEl(pdfRef, 'application/pdf')}
      {extraAccept.length > 0 && inputEl(otherRef, extraAccept.join(','))}
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
