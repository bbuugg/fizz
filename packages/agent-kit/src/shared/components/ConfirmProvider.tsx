"use client";

/**
 * 命令式确认弹窗：`useConfirm()` 拿到一个「弹一个 AlertDialog 并等答复」的函数。
 *
 * ## 为什么要有它（而不是继续写声明式弹窗）
 *
 * 标签关闭守卫（`shared/lib/tab-close.ts`）是**命令式**的：关闭链路 await 一个
 * `Promise<'close' | 'cancel'>`，守卫内部需要「弹个框问一下，然后按用户的选择答复」。
 * 这用不了声明式的 `open/onCancel/onConfirm`（那个要求调用方把自己的渲染挂进 JSX）。
 * 设置页那份状态驱动的 `ConfirmDeleteDialog` 继续保留，不动。
 *
 * ## 一个在显示 + 队列
 *
 * 批量关闭是**逐个顺序确认**（见 `tab-close.ts` 纪律 2）：第二、第三个请求要排在后面，
 * 不能顶掉正在显示的那个。所以 confirm() 只入队，队首渲染。
 *
 * ## 为什么 Action 要 preventDefault
 *
 * Radix 的 `AlertDialogAction` 点完会**自动关闭**弹窗，于是走 `onOpenChange(false)`；
 * 如果不拦，这个「关闭」会被我们当成用户点了取消 —— 此时如果队里还有下一个请求，
 * 就会**把下一个误判成取消**。所以 Action 上 `e.preventDefault()` 阻止自动关闭，
 * 关不关由我们自己的受控 `open` 说（`setCurrent` 决定）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode
} from 'react'
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

interface PendingConfirm {
  options: ConfirmOptions
  resolve: (ok: boolean) => void
  /** 已答复（防同一次弹窗被 Esc + 按钮两条路径重复收口） */
  settled: boolean
}

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * 取命令式确认函数：`const confirm = useConfirm()`，调用 `await confirm({...})`
 * 拿到 `true`（确认）/ `false`（取消 / Esc / 点遮罩）。
 *
 * 必须在 `<ConfirmProvider>` 内使用（`app/app-shell.tsx` 已挂载）。
 */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext)
  if (!fn) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用')
  return fn
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const [current, setCurrent] = useState<PendingConfirm | null>(null)
  /** 待显示队列（`current` 恒等于队首） */
  const queueRef = useRef<PendingConfirm[]>([])
  /** 退场动画期间仍要渲染内容 —— 保留最后一份 options */
  const lastOptionsRef = useRef<ConfirmOptions | null>(null)

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      const item: PendingConfirm = { options, resolve, settled: false }
      queueRef.current.push(item)
      setCurrent((cur) => cur ?? item)
    })
  }, [])

  /** 收口队首：答复、出队、显示下一个（没有就收起来） */
  const close = useCallback((item: PendingConfirm, ok: boolean) => {
    if (item.settled) return
    item.settled = true
    item.resolve(ok)
    const idx = queueRef.current.indexOf(item)
    if (idx >= 0) queueRef.current.splice(idx, 1)
    setCurrent(queueRef.current[0] ?? null)
  }, [])

  if (current) lastOptionsRef.current = current.options
  const options = current?.options ?? lastOptionsRef.current

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={current !== null}
        onOpenChange={(next) => {
          // 只有「关掉」（Esc / 点遮罩 / Cancel）才收口；Action 已 preventDefault，不会走到这
          if (!next && current) close(current, false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title ?? ''}</AlertDialogTitle>
            {options?.description !== undefined && (
              <AlertDialogDescription>{options.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* 默认文案也要走翻译：英文界面下这里以前回落成硬编码中文（用户反馈） */}
            <AlertDialogCancel>{options?.cancelLabel ?? t('取消')}</AlertDialogCancel>
            <AlertDialogAction
              variant={options?.destructive ? 'destructive' : 'default'}
              onClick={(e) => {
                e.preventDefault()
                if (current) close(current, true)
              }}
            >
              {options?.confirmLabel ?? t('确定')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}