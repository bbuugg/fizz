/**
 * 手机版弹窗「底部抽屉」形态的共用件。
 *
 * 两个入口别名在窄屏下画的是**同一套抽屉**：
 * `@fizz/ui/dialog` → `mobile-dialog.tsx`，`@fizz/ui/alert-dialog` → `mobile-alert-dialog.tsx`。
 * 手柄、满宽内容区、底部动作行的具体类名只写在这里，两边都别各抄一份 —— 抄了之后
 * 「取消贴底」「三颗按钮竖排」这类规则迟早只改到一边（见 `apps/mobile/src/styles.css`）。
 *
 * 形态判据为什么是 `min-width: 640px and (hover: hover)`、为什么关掉 vaul 的
 * `repositionInputs`、宽屏为什么要退回居中弹窗：见 `mobile-dialog.tsx` 文件头，
 * 那段是这套做法的主文档，这里不重复。
 */
import * as React from 'react'
import { orderDialogActions } from '@fizz/ui/dialog-actions'
import { X } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  DrawerClose,
  DrawerContent as DrawerContentPrimitive,
  DrawerDescription,
  DrawerTitle,
} from '@fizz/ui/drawer'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/**
 * 「桌面式居中弹窗」的判据：`min-width: 640px` 就是 Tailwind 的 `sm`（调用方的宽度类
 * 恰好从这一刻起生效），`hover: hover` 把手机横屏留在抽屉侧。
 */
export const MODAL_FORM_QUERY = '(min-width: 640px) and (hover: hover)'

/**
 * 当前这棵弹窗是哪种形态。由根（Dialog / AlertDialog）写、其余原语读。
 *
 * 走 Context 而不是让每个组件各自调一次 hook：形态一旦分叉，`Content` 落在
 * `Drawer` 的根里就会直接抛错（Radix / vaul 都拿 Context 校验父子关系）。根与子孙
 * 必须看到**同一个**值；各调一次 hook 只是「大概率同一拍」。
 *
 * Dialog 与 AlertDialog 共用同一个 Context 是安全的：两边算出来的都是同一个媒体查询的
 * 结果，嵌套时内层 Provider 只会盖住自己的子树。
 */
export const SheetFormContext = React.createContext(false)

export function useIsSheetForm(): boolean {
  return React.useContext(SheetFormContext)
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined
  }
  const mql = window.matchMedia(MODAL_FORM_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(MODAL_FORM_QUERY).matches
}

/**
 * `useSyncExternalStore` 而不是 `useState` + `useEffect`：媒体查询是外部数据源，**首帧就要
 * 真值**。用 effect 的话扩展里首帧会先按抽屉画一遍，第二帧才翻成居中弹窗 —— 一次可见的
 * 闪烁，还得先进一次 `Drawer` 的动画。
 */
export function useModalFormQuery(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/**
 * 抽屉的壳：手柄 + 内层滚动容器 + 右上角关闭 ×。
 *
 * - `className` 落在**内层滚动容器**上：调用方那些 `sm:max-w-md`（宽度提示，手机上没意义）
 *   与 `flex max-h-[85dvh] flex-col p-0`（真正管布局的）都能落在正确的一层，滚动条由这一层自己出。
 * - 内层容器被 `styles.css` 里一条不受宽度类影响的规则钉成满宽
 *   （`[data-mobile-dialog] [data-slot='mobile-dialog-body']`）。
 * - 安全区由 `styles.css` 的 `[data-slot='drawer-content']` 补 —— 抽屉 portal 到 body、
 *   在外壳那条 `--safe-area-inset-*` 内边距之外。
 */
export function SheetContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DrawerContentPrimitive> & {
  showCloseButton?: boolean
}) {
  return (
    <DrawerContentPrimitive
      data-mobile-dialog=""
      // 共享 Drawer 默认 80dvh；调用方有 85dvh 的弹窗，抬到 90 才不裁掉底部按钮
      className="data-[vaul-drawer-direction=bottom]:max-h-[90dvh]"
      {...props}
    >
      <div
        data-slot="mobile-dialog-body"
        className={cn(
          // 手柄 1.25rem + 上下留白 ≈ 1.5rem，剩下的都留给内容
          'flex max-h-[calc(90dvh-1.5rem)] flex-col gap-4 overflow-y-auto p-4',
          className,
        )}
      >
        {restoreDismissVariants(children)}
      </div>
      {showCloseButton && (
        <DrawerClose asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-3 right-3"
            aria-label="关闭"
          >
            <X />
          </Button>
        </DrawerClose>
      )}
    </DrawerContentPrimitive>
  )
}

export function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      // pr-8：右上角那颗关闭键是绝对定位，长标题别钻到它底下
      className={cn('flex flex-col gap-2 pr-8', className)}
      {...props}
    />
  )
}

export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerTitle>) {
  return (
    <DrawerTitle
      data-slot="dialog-title"
      className={cn('font-heading leading-none', className)}
      {...props}
    />
  )
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerDescription>) {
  return (
    <DrawerDescription
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function SheetFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      // 手机抽屉的底部动作条：**始终一行**，按钮自动撑满剩余宽度。
      // 不能默认竖排：调用方的 `items-center`（ThemeEditor 的
      // footer 就有）一叠加就变成「一列小按钮居中堆着」—— 用户报过「外观设置底部的
      // 几个按钮竖着排、宽度也不是 100%」。`grow` 而不是 `flex-1`：footer 里可能还有
      // 路径 / 错误提示这类自带 `flex-1` 的兄弟（ServerDirPicker），保留它们的宽度。
      //
      // 三颗及以上按钮改竖排、恰好两颗等宽，都在 `styles.css` 里按这个 data-slot 统一定。
      // `data-slot` 与 Dialog 共用一套：AlertDialog 的 footer 也落同一条规则。
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 pt-1 [&>[data-slot=button]]:grow',
        className,
      )}
      {...props}
    >
      {restoreDismissVariants(orderDialogActions(children, [DrawerClose]))}
      {showCloseButton && (
        <DrawerClose asChild>
          <Button variant="outline">Close</Button>
        </DrawerClose>
      )}
    </div>
  )
}

/**
 * 共享组件里的「取消 / 关闭」按钮曾统一是 `outline`，后来有一批被改成了 `ghost`
 * （web / desktop 保持 ghost 不动）。手机上 ghost 贴在抽屉底边几乎看不出是按钮，
 * 所以只在这里把**带 `data-dialog-dismiss` 的 ghost 按钮**升回 outline。
 *
 * 只下钻 Fragment 与原生标签（包住按钮的 div / 片段），不碰组件内部：`SheetContent` /
 * `SheetFooter` 自己会各过一遍，避免把组件树重挂。
 */
export function restoreDismissVariants(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return child
    const props = child.props as {
      variant?: string
      'data-dialog-dismiss'?: unknown
      children?: React.ReactNode
    }
    if (props['data-dialog-dismiss'] !== undefined && props.variant === 'ghost') {
      return React.cloneElement(child as React.ReactElement<{ variant?: string }>, {
        variant: 'outline',
      })
    }
    const canDescend = child.type === React.Fragment || typeof child.type === 'string'
    if (canDescend && props.children !== undefined) {
      return React.cloneElement(child as React.ReactElement<{ children?: React.ReactNode }>, {
        children: restoreDismissVariants(props.children),
      })
    }
    return child
  })
}
