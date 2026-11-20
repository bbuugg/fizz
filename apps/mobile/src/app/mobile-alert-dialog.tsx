/**
 * 手机版的 AlertDialog 形态：与 Dialog 同一条策略 —— **窄屏底部抽屉，宽屏居中卡片**。
 *
 * 为什么要有这个文件：`packages/agent-kit` 里所有「确认 / 危险操作」都走
 * `@fizz/ui/alert-dialog`（`useConfirm` / `useChoose` 命令式确认、GitPanel 的丢弃贮藏、
 * 消息条上的「重试这条」……）。用户在手机上点「重试这条消息」时弹的是居中卡片，
 * 与其它弹窗（底部抽屉）形态对不上，够不着、也容易被当成另一套东西。
 *
 * 做法与 `mobile-dialog.tsx` 完全相同：`vite.config.ts` 把这个入口别名到本文件，
 * 抽屉布局复用 `mobile-sheet.tsx`（两边一份，别各写一套）。
 *
 * ## 与桌面版的差异（只落在抽屉形态）
 *
 * - `AlertDialogContent` 多一个 `showCloseButton`（默认给 ×）：确认框多一颗关闭键不算错，
 *   手机上「拖走 / 点遮罩 / 点 × 」都落到调用方的 `onOpenChange(false)`（= 取消）。
 * - `AlertDialogCancel` 的默认变体从 `ghost` 改成 `outline`：ghost 贴在抽屉底边几乎看不出
 *   是按钮（`restoreDismissVariants` 那条注释同理）。
 * - `size`（`default` / `sm`）是桌面居中卡片的尺寸档，抽屉恒满宽，这里收下但不往下传
 *   （传给 DOM 会变成非法属性）。
 * - `AlertDialogAction` / `Cancel` 在抽屉里换成 `DrawerClose` + `Button`：Radix 的
 *   Action / Cancel 必须挂在 AlertDialog 的根里，vaul 的树里取不到那个 Context。
 *   点击仍然「先答复再关」——`DrawerClose` 与 Action 的自动关闭语义一致。
 *
 * 宽屏（`min-width: 640px` 且有鼠标）整棵交回 Radix 版，与 web / desktop 逐字同源。
 * 判据与开关理由见 `mobile-dialog.tsx` 文件头。
 */
import * as React from 'react'
import { Button } from '@fizz/ui/button'
import { orderDialogActions } from '@fizz/ui/dialog-actions'
import {
  Drawer,
  DrawerClose,
  DrawerOverlay,
  DrawerPortal,
  DrawerTrigger,
} from '@fizz/ui/drawer'
/**
 * 桌面版实现。
 *
 * ⚠️ 只能走相对路径：`@fizz/ui/alert-dialog` 这个说明符**正是本文件**（别名），
 * 从本文件里 import 它就是自指。
 */
import * as Desktop from '../../../../packages/ui/src/alert-dialog'
import {
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetFormContext,
  SheetHeader,
  SheetTitle,
  useIsSheetForm,
  useModalFormQuery,
} from './mobile-sheet'

/** 两种形态都认的根属性（Radix AlertDialog 与 vaul Drawer 的交集，按窄的那一套声明） */
type AlertDialogProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
  children?: React.ReactNode
}

function AlertDialog({ children, ...props }: AlertDialogProps) {
  const modal = useModalFormQuery()
  return (
    <SheetFormContext.Provider value={modal}>
      {modal ? (
        <Desktop.AlertDialog {...props}>{children}</Desktop.AlertDialog>
      ) : (
        <Drawer {...props} repositionInputs={false}>
          {children}
        </Drawer>
      )}
    </SheetFormContext.Provider>
  )
}

function AlertDialogTrigger(props: React.ComponentProps<typeof DrawerTrigger>) {
  const modal = useIsSheetForm()
  return modal ? <Desktop.AlertDialogTrigger {...props} /> : <DrawerTrigger {...props} />
}

function AlertDialogPortal(props: React.ComponentProps<typeof DrawerPortal>) {
  const modal = useIsSheetForm()
  return modal ? <Desktop.AlertDialogPortal {...props} /> : <DrawerPortal {...props} />
}

function AlertDialogOverlay(props: React.ComponentProps<typeof DrawerOverlay>) {
  const modal = useIsSheetForm()
  return modal ? <Desktop.AlertDialogOverlay {...props} /> : <DrawerOverlay {...props} />
}

function AlertDialogContent({
  className,
  children,
  size,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetContent> & {
  /** 桌面居中卡片的尺寸档；抽屉恒满宽，只在居中形态往下传 */
  size?: 'default' | 'sm'
  showCloseButton?: boolean
}) {
  const modal = useIsSheetForm()
  if (modal) {
    return (
      <Desktop.AlertDialogContent className={className} size={size} {...props}>
        {children}
      </Desktop.AlertDialogContent>
    )
  }
  // role="alertdialog"：与桌面版同一套语义（屏幕阅读器按「警报对话框」播报）。
  // vaul 的 Content 把 props 展开在自己那串 data-vaul-* 之后，role 不会被盖掉。
  return (
    <SheetContent
      role="alertdialog"
      className={className}
      showCloseButton={showCloseButton}
      {...props}
    >
      {children}
    </SheetContent>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  const modal = useIsSheetForm()
  if (modal) return <Desktop.AlertDialogHeader className={className} {...props} />
  return <SheetHeader className={className} {...props} />
}

function AlertDialogFooter({ className, children, ...props }: React.ComponentProps<'div'>) {
  const modal = useIsSheetForm()
  const actions = orderDialogActions(children, [AlertDialogCancel])
  if (modal) return <Desktop.AlertDialogFooter className={className} {...props}>{actions}</Desktop.AlertDialogFooter>
  return <SheetFooter className={className} {...props}>{actions}</SheetFooter>
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof SheetTitle>) {
  const modal = useIsSheetForm()
  if (modal) return <Desktop.AlertDialogTitle className={className} {...props} />
  return <SheetTitle className={className} {...props} />
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetDescription>) {
  const modal = useIsSheetForm()
  if (modal) return <Desktop.AlertDialogDescription className={className} {...props} />
  return <SheetDescription className={className} {...props} />
}

/**
 * 图标块：两个形态都是同一个 `div`（桌面那份没有 Radix 依赖），直接借用，
 * 不必为它分叉。
 */
function AlertDialogMedia(props: React.ComponentProps<typeof Desktop.AlertDialogMedia>) {
  return <Desktop.AlertDialogMedia {...props} />
}

function AlertDialogAction({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<typeof Desktop.AlertDialogAction>) {
  const modal = useIsSheetForm()
  if (modal) {
    return (
      <Desktop.AlertDialogAction className={className} variant={variant} size={size} {...props} />
    )
  }
  return (
    <DrawerClose asChild>
      <Button className={className} variant={variant} size={size} {...props} />
    </DrawerClose>
  )
}

function AlertDialogCancel({
  className,
  variant,
  size = 'default',
  ...props
}: React.ComponentProps<typeof Desktop.AlertDialogCancel>) {
  const modal = useIsSheetForm()
  // 居中形态照旧交给桌面版（它自己默认 ghost，不能在这里替它填死）
  if (modal) {
    return (
      <Desktop.AlertDialogCancel className={className} variant={variant} size={size} {...props} />
    )
  }
  return (
    <DrawerClose asChild>
      <Button className={className} variant={variant ?? 'outline'} size={size} {...props} />
    </DrawerClose>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
