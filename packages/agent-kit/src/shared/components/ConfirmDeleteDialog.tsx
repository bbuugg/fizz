/**
 * 通用「删除 / 移除」二次确认弹窗（设置里各页共用）。
 *
 * 为什么统一走弹窗、不再用「点两次按钮就地确认」：
 * 列表里一个 28px 的小图标，点下去第一下只是变红、第二下就真删 —— 手滑（或者
 * 鼠标划过时误点）与「真的想删」在视觉上没有任何区分度，而且删除的连带影响
 * （模型白名单、密钥、环境变量）在按钮上根本写不下。弹窗能把「删的是哪一条、
 * 连带丢什么、什么不受影响」写清楚，再把「取消」做成默认安全选项。
 *
 * 用 AlertDialog 而不是 Dialog：语义上就是「必须先答复才能继续」的危险操作，
 * Radix 会给它 `role="alertdialog"`，焦点默认落在取消上（Esc / 点遮罩一律算取消）。
 * 它本身可以嵌在「设置」弹窗里 —— Radix 的嵌套 Dialog 各自独立 portal + focus scope，
 * Esc / 点遮罩只关最上层那一个（ACP agent 页已经这么用了）。
 */
import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@fizz/ui/alert-dialog'

export function ConfirmDeleteDialog({
  open,
  title,
  description,
  confirmLabel = '删除',
  onCancel,
  onConfirm
}: {
  open: boolean
  title: string
  /** 写清「删的是哪一条 + 连带丢什么」；可以是节点（需要强调名称时用 <span> 包一下） */
  description: ReactNode
  /** 确认按钮文案：删除 / 移除 */
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {/* wrap-anywhere 不能省：描述里常带请求名 / 地址这类无空格的长英文，
              不加的话它撑大 grid 轨道，底部 justify-end 的按钮会被推出弹窗 */}
          <AlertDialogDescription className="wrap-anywhere">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          {/* Action 点完 Radix 会自动关闭弹窗，关闭又会走 onOpenChange(false) → onCancel；
              调用方在 onConfirm 里自己清掉待删状态即可，不必手动关 */}
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
