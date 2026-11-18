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
 * - `DialogContent` 的 `className` 落在**内层滚动容器**上：调用方那些
 *   `sm:max-w-md`（宽度提示，手机上没意义）与 `flex max-h-[85dvh] flex-col p-0`
 *   （真正管布局的）都能落在正确的一层；滚动条由这一层自己出。
 * - 内层容器被一条**不受宽度类影响**的 CSS 规则钉成满宽（`styles.css` 里的
 *   `[data-mobile-dialog] [data-slot='mobile-dialog-body']`）：抽屉是贴着屏幕底边的整条，
 *   内容跟着满宽才对；调用方的 `max-w-md` 在 <640px 时仍会生效，不钉一下就是「内容
 *   缩在左边」。切到居中弹窗后那条规则不再命中（`max-w` 由桌面版自己管）。
 * - 抽屉最高 90dvh（共享 Drawer 默认 80dvh，调用方有 85dvh 的弹窗，留点余量），
 *   内层滚动区再减掉拖拽手柄那 1.5rem。
 * - 右上角保留关闭 ×（对应原 DialogContent 的 `showCloseButton`）：拖动 / 点遮罩
 *   也能关，但 × 是最容易被找到的那一个。
 * - 安全区由 `styles.css` 的 `[data-slot='drawer-content']` 补 —— 抽屉 portal 到
 *   body、在外壳那条 `--safe-area-inset-*` 内边距之外。
 *
 * ## 为什么关掉 vaul 的 `repositionInputs`
 *
 * 手机壳的键盘是**缩布局视口**的（`capacitor.config.ts` 的 `Keyboard.resize: 'native'`，
 * 见 `index.css` 的高度链说明），`fixed bottom-0` 与 `dvh` 自己就会贴到键盘上沿。
 * vaul 默认还会按 `visualViewport` 再补偿一次，而它把**第一次收到 resize 时**的抽屉高度
 * 记成「初始高度」—— 那时布局视口已经缩了，抽屉也被 `max-h` 压过，于是「初始高度」
 * 记的就是压缩后的值；它还会写死一条内联 `height: Npx`。键盘收起后它只把内联高度恢复成
 * 那个错误的值，表现为「打开一次输入法，弹窗变矮后永远恢复不了」（用户反馈）。
 * 关掉之后高度完全交给 CSS 与布局视口：键盘弹起自然压短，收起自然恢复。
 *
 * ## 只换 Dialog，不换 AlertDialog
 *
 * `@fizz/ui/alert-dialog` 是「确认 / 危险操作」的小弹窗（`useConfirm`、删除会话），
 * 居中的卡片形态在手机上依旧合适，也避免手一滑把确认框拖走。要改那套得单独再说。
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
import { X } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent as DrawerContentPrimitive,
  DrawerDescription,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
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
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/**
 * 「桌面式居中弹窗」的判据。
 *
 * `min-width: 640px` 就是 Tailwind 的 `sm` —— 调用方的宽度类全是 `sm:max-w-*`，它们
 * 恰好从这一刻起生效，形态就跟着它们一起换。
 *
 * `hover: hover` 见文件头：手机横屏也过 640，那里必须留抽屉。
 *
 * ⚠️ 扩展（`apps/extension/src/main.tsx`）没有强制覆盖这一条：它本来就有鼠标，媒体查询
 * 自己会判对。反过来说，若哪天要把「扩展恒用居中弹窗」钉死，得先给本文件加一个宿主开关 ——
 * 现在没有这个需求，不预先造。
 */
export const MODAL_DIALOG_QUERY = '(min-width: 640px) and (hover: hover)'

/**
 * 当前这棵弹窗是哪种形态。由 `Dialog`（根）写、其余原语读。
 *
 * 走 Context 而不是让每个组件各自调一次 hook：形态一旦分叉，`Content` 落在 `Drawer`
 * 的根里就会直接抛错（Radix / vaul 都拿 Context 校验父子关系）。根与子孙必须看到**同一个**
 * 值，Context 保证这一点；各调一次 hook 只是「大概率同一拍」。
 */
const ModalForm = React.createContext(false)

function useIsModalForm(): boolean {
  return React.useContext(ModalForm)
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined
  }
  const mql = window.matchMedia(MODAL_DIALOG_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(MODAL_DIALOG_QUERY).matches
}

/**
 * `useSyncExternalStore` 而不是 `useState` + `useEffect`：媒体查询是外部数据源，**首帧就要
 * 真值**。用 effect 的话扩展里首帧会先按抽屉画一遍，第二帧才翻成居中弹窗 —— 一次可见的
 * 闪烁，还得先进一次 `Drawer` 的动画。
 */
function useModalForm(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** 两种形态都认的根属性（见文件头「props 类型按窄的那一套」） */
type DialogProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
  children?: React.ReactNode
}

function Dialog({ children, ...props }: DialogProps) {
  const modal = useModalForm()
  return (
    <ModalForm.Provider value={modal}>
      {modal ? (
        <Desktop.Dialog {...props}>{children}</Desktop.Dialog>
      ) : (
        <Drawer {...props} repositionInputs={false}>
          {children}
        </Drawer>
      )}
    </ModalForm.Provider>
  )
}

function DialogTrigger(props: React.ComponentProps<typeof DrawerTrigger>) {
  const modal = useIsModalForm()
  return modal ? <Desktop.DialogTrigger {...props} /> : <DrawerTrigger {...props} />
}

function DialogPortal(props: React.ComponentProps<typeof DrawerPortal>) {
  const modal = useIsModalForm()
  return modal ? <Desktop.DialogPortal {...props} /> : <DrawerPortal {...props} />
}

function DialogClose(props: React.ComponentProps<typeof DrawerClose>) {
  const modal = useIsModalForm()
  return modal ? <Desktop.DialogClose {...props} /> : <DrawerClose {...props} />
}

function DialogOverlay(props: React.ComponentProps<typeof DrawerOverlay>) {
  const modal = useIsModalForm()
  return modal ? <Desktop.DialogOverlay {...props} /> : <DrawerOverlay {...props} />
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DrawerContentPrimitive> & {
  showCloseButton?: boolean
}) {
  const modal = useIsModalForm()
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

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  const modal = useIsModalForm()
  if (modal) return <Desktop.DialogHeader className={className} {...props} />
  return (
    <div
      data-slot="dialog-header"
      // pr-8：右上角那颗关闭键是绝对定位，长标题别钻到它底下
      className={cn('flex flex-col gap-2 pr-8', className)}
      {...props}
    />
  )
}

/**
 * 共享组件里的「取消 / 关闭」按钮曾统一是 `outline`，后来有一批被改成了 `ghost`
 * （web / desktop 保持 ghost 不动）。手机上 ghost 贴在抽屉底边几乎看不出是按钮，
 * 所以只在这里把**带 `data-dialog-dismiss` 的 ghost 按钮**升回 outline。
 *
 * 只下钻 Fragment 与原生标签（包住按钮的 div / 片段），不碰组件内部：`DialogFooter`
 * 自己会在抽屉形态里再过一遍，避免把组件树重挂。
 */
function restoreDismissVariants(children: React.ReactNode): React.ReactNode {
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

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  const modal = useIsModalForm()
  if (modal) {
    return (
      <Desktop.DialogFooter className={className} showCloseButton={showCloseButton} {...props}>
        {children}
      </Desktop.DialogFooter>
    )
  }
  return (
    <div
      data-slot="dialog-footer"
      // 手机抽屉的底部动作条：**始终一行**，按钮自动撑满剩余宽度。
      // 不能沿用桌面版的 `flex-col-reverse`：调用方的 `items-center`（ThemeEditor 的
      // footer 就有）一叠加就变成「一列小按钮居中堆着」—— 用户报过「外观设置底部的
      // 几个按钮竖着排、宽度也不是 100%」。`grow` 而不是 `flex-1`：footer 里可能还有
      // 路径 / 错误提示这类自带 `flex-1` 的兄弟（ServerDirPicker），保留它们的宽度。
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 pt-1 [&>[data-slot=button]]:grow',
        className,
      )}
      {...props}
    >
      {restoreDismissVariants(children)}
      {showCloseButton && (
        <DrawerClose asChild>
          <Button variant="outline">Close</Button>
        </DrawerClose>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DrawerTitle>) {
  const modal = useIsModalForm()
  if (modal) return <Desktop.DialogTitle className={className} {...props} />
  return (
    <DrawerTitle
      data-slot="dialog-title"
      className={cn('font-heading leading-none', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerDescription>) {
  const modal = useIsModalForm()
  if (modal) return <Desktop.DialogDescription className={className} {...props} />
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
