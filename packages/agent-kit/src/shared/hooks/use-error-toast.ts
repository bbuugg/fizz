/**
 * 全局错误提示：把 store 里的 `error`（各 slice 写、app.error 读）统一弹成 sonner toast。
 *
 * 之前它在会话面板里是一条**贴在输入框上方**的红条（`between` 插槽）。问题是它会**长期挂着**：
 * 「连不上服务端」这类错误在恢复前一直成立，用户不点「知道了」就一直占着消息区上方那条位置，
 * 而它恰好是最容易被忽略的位置 —— 滚动消息时几乎看不见，却挡着视口顶部。
 * 换成 toast 之后：位置固定在右下角（全局 `AppToaster` 的位置）、不自动隐藏（`duration: Infinity`），
 * 用户处理完或主动关掉才消失，不会挡住任何东西。
 *
 * `id` 固定成同一个：同一条错误重复触发时更新而不是堆一串（connect失败重试时最容易堆）。
 *
 * 用法：组件里 `useErrorToast(app.error, app.clearError)`，**每个会渲染 error 的视图挂一次**。
 */
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

/** toast 的固定 id：同一个错误反复触发只更新那一条 */
const ERROR_TOAST_ID = 'fizz-app-error'

export function useErrorToast(error: string | null, onDismiss: () => void): void {
  /**
   * onDismiss 放进 ref：很多 slice 给的是内联箭头函数，每次渲染身份都变，
   * 直接进依赖会把上面的 effect 重新点着 —— 而 `toast.error` 是在 effect 里调的，
   * 等于每次父组件重渲染都重新弹一次错误。
   */
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (error) {
      toast.error(error, {
        id: ERROR_TOAST_ID,
        // 错误不该自己消失：不处理它就一直挂着（连不上服务端这类要等恢复）
        duration: Infinity,
        closeButton: true,
        onAutoClose: () => dismissRef.current()
      })
      return
    }
    // error 被别处清掉（重试成功等）：把还挂着的那条一起收掉
    toast.dismiss(ERROR_TOAST_ID)
  }, [error])
}