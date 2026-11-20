"use client";

/**
 * 命令式确认弹窗：`useConfirm()` 拿到一个「弹一个 AlertDialog 并等答复」的函数，
 * `useChoose()` 是它的**多选一**版本（可以给三颗以上的按钮）。
 *
 * ## 为什么要有它（而不是继续写声明式弹窗）
 *
 * 标签关闭守卫（`shared/lib/tab-close.ts`）是**命令式**的：关闭链路 await 一个
 * `Promise<'close' | 'cancel'>`，守卫内部需要「弹个框问一下，然后按用户的选择答复」。
 * 这用不了声明式的 `open/onCancel/onConfirm`（那个要求调用方把自己的渲染挂进 JSX）。
 * 设置页那份状态驱动的 `ConfirmDeleteDialog` 继续保留，不动。
 *
 * ## 为什么还需要多选一
 *
 * 关一个**正在生成**的对话标签，答案不止「是 / 否」：
 * 「仅关闭标签（这一轮在后台继续）」「取消」「停止并关闭」是三件不同的事。
 * 硬塞进 boolean 只能二选一，用户要么被迫停掉一轮，要么根本关不掉。
 *
 * 两者共用同一套队列与同一份渲染：`confirm()` 只是把二元问题包成 `choose()` 的两颗按钮
 * （取消 = `ghost`，确认 = `default` / `destructive`），所以外观与既有调用点**逐像素一致**。
 *
 * ## 一个在显示 + 队列
 *
 * 批量关闭是**逐个顺序确认**（见 `tab-close.ts` 纪律 2）：第二、第三个请求要排在后面，
 * 不能顶掉正在显示的那个。所以 confirm() / choose() 只入队，队首渲染。
 *
 * ## 为什么按钮不走 Action / Cancel
 *
 * 多选一可能有三颗，`AlertDialogAction` / `Cancel` 只覆盖「确认 / 取消」两种语义
 * （且 Action 点完会自动关闭）。这里统一用 `Button` + 自己的收口（`close()`），
 * 关不关由受控的 `open` 说 —— 顺带避开了「Action 自动关闭被误判成取消」那个老坑。
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@fizz/ui/alert-dialog'
import { Button } from '@fizz/ui/button'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export interface ConfirmOptions {
  /** 标题（一句话说清在问什么） */
  title: string
  /** 补充说明：为什么要问、确认后会丢什么 / 发生什么 */
  description?: ReactNode
  /** 确认按钮文案（默认「确定」） */
  confirmLabel?: string
  /** 取消按钮文案（默认「取消」） */
  cancelLabel?: string
  /** 危险操作：确认按钮走 destructive 样式（丢弃 / 停止 / 删除这类） */
  destructive?: boolean
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

/** 多选一里的一颗按钮 */
export interface ChooseAction<T extends string> {
  value: T
  label: string
  /**
   * 与 `Button` 的变体同名：`destructive` = 危险操作（停止 / 删除），
   * `outline` = 次要动作（另选一条路），`ghost` = 取消。
   */
  variant?: 'default' | 'destructive' | 'outline' | 'ghost'
}

export interface ChooseOptions<T extends string> {
  title: string
  description?: ReactNode
  /**
   * 非取消操作按从左到右的顺序给。`cancelValue` 对应的按钮由共享 Footer 固定放最后，
   * 横排靠右、竖排靠下，不要求调用方猜测断点布局。
   */
  actions: ChooseAction<T>[]
  /** Esc / 点遮罩 / 关掉弹窗时的答复（应当落在 `actions` 的某个 `value` 上） */
  cancelValue: T
}

export type ChooseFn = <T extends string>(options: ChooseOptions<T>) => Promise<T>

interface PendingChoice {
  options: ChooseOptions<string>
  resolve: (value: string) => void
  /** 已答复（防同一次弹窗被 Esc + 按钮两条路径重复收口） */
  settled: boolean
}

const ChooseContext = createContext<ChooseFn | null>(null)

/**
 * 取命令式多选一函数：`const choose = useChoose()`，调用
 * `await choose({ title, actions, cancelValue })` 拿到被点那颗的 `value`。
 *
 * 必须在 `<ConfirmProvider>` 内使用（`app/app-shell.tsx` 已挂载）。
 */
export function useChoose(): ChooseFn {
  const fn = useContext(ChooseContext)
  if (!fn) throw new Error('useChoose 必须在 <ConfirmProvider> 内使用')
  return fn
}

/**
 * 取命令式确认函数：`const confirm = useConfirm()`，调用 `await confirm({...})`
 * 拿到 `true`（确认）/ `false`（取消 / Esc / 点遮罩）。
 *
 * 必须在 `<ConfirmProvider>` 内使用（`app/app-shell.tsx` 已挂载）。
 */
export function useConfirm(): ConfirmFn {
  const choose = useChoose()
  const t = useT()
  return useCallback<ConfirmFn>(
    (options) =>
      choose({
        title: options.title,
        ...(options.description !== undefined ? { description: options.description } : {}),
        cancelValue: 'cancel',
        actions: [
          // 取消走 ghost、确认走 default / destructive —— 与 `AlertDialogCancel` /
          // `AlertDialogAction` 的默认变体逐字对齐，老调用点外观不变
          { value: 'cancel', label: options.cancelLabel ?? t('取消'), variant: 'ghost' },
          {
            value: 'ok',
            label: options.confirmLabel ?? t('确定'),
            variant: options.destructive ? 'destructive' : 'default'
          }
        ]
      }).then((value) => value === 'ok'),
    [choose, t]
  )
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<PendingChoice | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    // 移动 DOM 顺序后也不能让危险确认成为默认焦点；队列切到下一项时同样回到取消。
    if (current) cancelButtonRef.current?.focus()
  }, [current])
  /** 待显示队列（`current` 恒等于队首） */
  const queueRef = useRef<PendingChoice[]>([])
  /** 退场动画期间仍要渲染内容 —— 保留最后一份 options */
  const lastOptionsRef = useRef<ChooseOptions<string> | null>(null)

  /**
   * 队列内部一律按 `string` 收口（同一个弹窗可能来自不同的泛型实例），
   * 泛型只在这一层把返回值类型还回去 —— 调用方拿到的仍是自己的字面量联合。
   */
  const choose = useCallback(<T extends string,>(options: ChooseOptions<T>): Promise<T> => {
    return new Promise<T>((resolve) => {
      const item: PendingChoice = {
        options: options as ChooseOptions<string>,
        resolve: (value) => resolve(value as T),
        settled: false
      }
      queueRef.current.push(item)
      setCurrent((cur) => cur ?? item)
    })
  }, [])

  /** 收口队首：答复、出队、显示下一个（没有就收起来） */
  const close = useCallback((item: PendingChoice, value: string) => {
    if (item.settled) return
    item.settled = true
    item.resolve(value)
    const idx = queueRef.current.indexOf(item)
    if (idx >= 0) queueRef.current.splice(idx, 1)
    setCurrent(queueRef.current[0] ?? null)
  }, [])

  if (current) lastOptionsRef.current = current.options
  const options = current?.options ?? lastOptionsRef.current

  return (
    <ChooseContext.Provider value={choose}>
      {children}
      <AlertDialog
        open={current !== null}
        onOpenChange={(next) => {
          // 只有「关掉」（Esc / 点遮罩）才收口；按钮是普通 Button，不会触发这一支
          if (!next && current) close(current, current.options.cancelValue)
        }}
      >
        <AlertDialogContent onOpenAutoFocus={(event) => {
          if (cancelButtonRef.current) {
            event.preventDefault()
            cancelButtonRef.current.focus()
          }
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title ?? ''}</AlertDialogTitle>
            {options?.description !== undefined && (
              <AlertDialogDescription>{options.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            {(options?.actions ?? []).map((action) => (
              <Button
                key={action.value}
                ref={action.value === options?.cancelValue ? cancelButtonRef : undefined}
                variant={action.variant ?? 'outline'}
                // 「取消」那颗在手机版的底部抽屉里要升回 outline（ghost 贴底几乎看不出是
                // 按钮）：手机壳按这个属性做替换，见 `apps/mobile/src/app/mobile-sheet.tsx`
                // 的 `restoreDismissVariants`。共享 Footer 也用它把取消固定排到最后。
                {...(action.value === options?.cancelValue
                  ? { 'data-dialog-dismiss': '' }
                  : {})}
                onClick={() => {
                  if (current) close(current, action.value)
                }}
              >
                {action.label}
              </Button>
            ))}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ChooseContext.Provider>
  )
}
