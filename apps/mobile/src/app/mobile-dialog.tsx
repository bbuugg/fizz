/**
 * 手机版的 Dialog 形态：**窄屏是底部抽屉**（shadcn Drawer / vaul），
 * **宽到桌面尺寸时退回居中弹窗**（Radix，与 web / desktop 逐字同源）。
 *
 * 手机版会弹的原语级弹窗有几十处（新建会话 / 插件 / 工作区设置 /
 * 导入导出 / 工作树 / 设置里的模型与主题编辑 …），它们全都从 `@fizz/ui/dialog`
 * 取 `Dialog` / `DialogContent` 这些原语。翻遍整个 `apps/mobile/src` 也找不到
 * 「本工程自己的 Dialog 实现」—— 外壳只负责挂载，弹窗本身都在共享包里。
 *
 * 所以这里不在几十个共享组件里逐个加「手机走抽屉」的分支（那些组件 web / desktop
 * 也在用，不能动），而是在 `vite.config.ts` 里把 `@fizz/ui/dialog` 这个**入口**
 * 换成本文件：导出名与 Radix 版一一对应，内部换成 `@fizz/ui/drawer`（vaul）。
 * 共享组件一行不改，手机端所有 Dialog 自动变成底部抽屉。
 *
 * ## 为什么宽屏要换回居中弹窗
 *
 * Chrome 扩展的 side panel **可以拖宽**，而它整棵复用手机壳（`apps/extension` 的 `@`
 * 别名指向 `apps/mobile/src`）。拖过 640px 之后出现两个毛病：
 *
 * 1. 调用方写的是 `sm:max-w-md` / `sm:max-w-2xl` 这一大片**桌面宽度类**，`sm` 断点就是
 *    640px —— 抽屉本身恒满宽，于是内层容器被压成 384px 贴在左边，右边空一大片；
 * 2. 抽屉从底部升起、贴底无边角，在一块 900px 宽的面板里看着也不像弹窗。
 *
 * 所以从 `sm` 起换成**真正的居中弹窗**：那些 `sm:max-w-*` 在桌面版里本来就是为它写的，
 * 挪过去正好各归其位，不必去改几十处调用点。
 *
 * ## 判据为什么还要看 `hover`
 *
 * 只看宽度不行：手机横屏也有 640px 以上，那里必须继续用抽屉 —— 居中弹窗的高度上限
 * 是按桌面屏幕留的，在 390px 高的横屏里内容会被裁掉。`hover: hover` 把「手边有鼠标」
 * 这件事带进来，正好把手机（含横屏、含三星 S Pen 机型）留在抽屉侧。
 *
 * ## 视觉 / 行为（抽屉形态）
 *
 * 手柄、内层滚动容器、右上角关闭 ×、满宽钉子、安全区、90dvh 上限、`repositionInputs`
 * 关掉的理由，全在 `mobile-sheet.tsx`（Dialog 与 AlertDialog 共用同一套抽屉，别在这边
 * 再写一份）。
 *
 * ## AlertDialog 也换（2026-11）
 *
 * 早先只有 Dialog 换抽屉，`@fizz/ui/alert-dialog`（确认 / 危险操作）保持居中卡片。
 * 用户在手机上点「重试这条消息」时看到的是一张居中弹窗，与其它弹窗形态对不上 ——
 * 现在 `@fizz/ui/alert-dialog` 也指向 `mobile-alert-dialog.tsx`：窄屏同样是底部抽屉，
 * 宽屏退回 Radix 的居中卡片。确认框从底部升起，拖走 / 点遮罩 / Esc 都落到调用方的
 * `onOpenChange(false)` 那一支（= 取消），语义不变。
 *
 * ## 命令面板不受影响
 *
 * `packages/ui/src/command.tsx` 里的 `CommandDialog` 走的是**相对路径** `./dialog`，
 * 不经过本别名，所以手机版的命令面板仍是原来的居中弹窗（搜索浮层，不该是抽屉）。
 *
 * ## 切换时会重挂一次
 *
 * 形态变了就是换了一颗根组件（`Drawer` ↔ `Radix Dialog`），React 会卸载重挂整棵子树。
 * 弹窗本身是**受控**的（调用方持有 `open`），所以拖宽 / 拖窄时弹窗不会关，只是当场换成
 * 另一种形态 —— 这正是想要的。
 *
 * ⚠️ 组件的 props 类型按**窄的那一套**（`open` / `onOpenChange` / `children` 等）声明：
 * 调用方只传这几样，两种形态都收得下；vaul 专有的 `snapPoints` / `shouldScaleBackground`
 * 这里不暴露 —— 暴露了在居中弹窗形态下也无处可施，不如让类型当场报错。
 */

import * as React from 'react'
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
 * ⚠️ 只能走相对路径：`@fizz/ui/dialog` 这个说明符**正是本文件**（`vite.config.ts` 的别名），
 * 从本文件里 import 它就是自指。`apps/mobile` 与 `apps/extension` 拿到的是同一个物理文件，
 * 所以同一条相对路径在两边都成立。
 */
import * as Desktop from '../../../../packages/ui/src/dialog'
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

/** 两种形态都认的根属性（见文件头「props 类型按窄的那一套」） */
type DialogProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
  children?: React.ReactNode
}

function Dialog({ children, ...props }: DialogProps) {
  const modal = useModalFormQuery()
  return (
    <SheetFormContext.Provider value={modal}>
      {modal ? (
        <Desktop.Dialog {...props}>{children}</Desktop.Dialog>
      ) : (
        <Drawer {...props} repositionInputs={false}>
          {children}
        </Drawer>
      )}
    </SheetFormContext.Provider>
  )
}

function DialogTrigger(props: React.ComponentProps<typeof DrawerTrigger>) {
  const modal = useIsSheetForm()
  return modal ? <Desktop.DialogTrigger {...props} /> : <DrawerTrigger {...props} />
}

function DialogPortal(props: React.ComponentProps<typeof DrawerPortal>) {
  const modal = useIsSheetForm()
  return modal ? <Desktop.DialogPortal {...props} /> : <DrawerPortal {...props} />
}

function DialogClose(props: React.ComponentProps<typeof DrawerClose>) {
  const modal = useIsSheetForm()
  return modal ? <Desktop.DialogClose {...props} /> : <DrawerClose {...props} />
}

function DialogOverlay(props: React.ComponentProps<typeof DrawerOverlay>) {
  const modal = useIsSheetForm()
  return modal ? <Desktop.DialogOverlay {...props} /> : <DrawerOverlay {...props} />
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetContent> & {
  showCloseButton?: boolean
}) {
  const modal = useIsSheetForm()
  // 居中形态整棵交给桌面版：portal / 遮罩 / 动画 / 关闭键 / `sm:max-w-*` 全都与 web 一致，
  // 这里再拼一遍只会漂开。
  if (modal) {
    return (
      <Desktop.DialogContent className={className} showCloseButton={showCloseButton} {...props}>
        {children}
      </Desktop.DialogContent>
    )
  }
  return (
    <SheetContent className={className} showCloseButton={showCloseButton} {...props}>
      {children}
    </SheetContent>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  const modal = useIsSheetForm()
  if (modal) return <Desktop.DialogHeader className={className} {...props} />
  return <SheetHeader className={className} {...props} />
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  const modal = useIsSheetForm()
  const actions = orderDialogActions(children, [DialogClose])
  if (modal) {
    return (
      <Desktop.DialogFooter className={className} showCloseButton={showCloseButton} {...props}>
        {actions}
      </Desktop.DialogFooter>
    )
  }
  return (
    <SheetFooter className={className} showCloseButton={showCloseButton} {...props}>
      {actions}
    </SheetFooter>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof SheetTitle>) {
  const modal = useIsSheetForm()
  if (modal) return <Desktop.DialogTitle className={className} {...props} />
  return <SheetTitle className={className} {...props} />
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetDescription>) {
  const modal = useIsSheetForm()
  if (modal) return <Desktop.DialogDescription className={className} {...props} />
  return <SheetDescription className={className} {...props} />
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
