/**
 * 「内容变了，高度跟着动」——给**高度由内容撑开**的浮层补一段高度动画。
 *
 * 用在：选择器面板（`picker-panel.tsx` 的 `PickerPanel`）、对话框（`dialog.tsx` 的
 * `DialogContent`）。两处都是「面板高度 = 内容高度」，一改内容就「啪」地跳一截。
 *
 * ## 为什么不能只用 CSS
 *
 * `transition: height` 对 `height: auto` 无效：两个状态的计算值都是 `auto`，
 * 浏览器认为没变化，压根不会触发过渡（`interpolate-size: allow-keywords` 也只解决
 * 「从定值过渡到 auto」，auto → auto 仍然不动）。所以只能量出来再手动过渡 —— 也就是 FLIP：
 *
 * 1. 读**旧高度**：动画在跑时取 `getBoundingClientRect()` 的**插值**（连续输入时不回跳），
 *    否则取上一轮记下的目标高度（DOM 已经更新过了，读不到旧值）；
 * 2. 清掉动画期间写下的行内 `height`（清成 `''` 而不是 `'auto'` —— 调用方可能用
 *    `h-[32rem]` 这类类名定高，清成 auto 会把定高也冲掉），量出**新高度**；
 * 3. 把高度写回旧值、强制回流，再打开 `transition` 过渡到新值；
 * 4. 结束后清空行内高度，回到样式表（`auto` / 定高都还原），窗口缩放时才不会被写死。
 *
 * 必须在**绘制前**（`useLayoutEffect`）做，否则会先闪一帧新高度再回跳。
 * 首帧不动：浮层每次打开都是新挂载，Radix 自己有 open 动画，两段一起放会打架。
 * `prefers-reduced-motion` 下直接落定，不折腾。
 */
import * as React from 'react'

/** 与 Radix 的 open 动画（100ms）错开一档：那是「出现」，这是「内容变了」 */
const DEFAULT_DURATION = 160

export function useHeightTransition<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  duration = DEFAULT_DURATION
): void {
  /**
   * 上一次量高度的那个节点。浮层关闭时**外层组件往往还挂着**（`<Dialog open>` 里的
   * `DialogContent` 每次都会执行），只有里面的 portal 节点被卸载；等下次打开，
   * 节点是新的，但这个 hook 的 ref 还留着上一次的 `lastHeight` —— 不按节点身份重置的话，
   * 重新打开会拿「上一次弹窗的高度」当起点，第一下输入就莫名跳一段。
   */
  const lastEl = React.useRef<T | null>(null)
  /** 上一段动画的目标高度：没有动画在跑时它就是当前高度 */
  const lastHeight = React.useRef<number | null>(null)
  const timer = React.useRef<number | null>(null)

  // 每次渲染都跑：内容变没变只有量了才知道（高度是算出来的，props 上看不出来）
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    // 新节点（浮层刚打开）：首帧不动画，只记下初始高度（Radix 自己还有入场动画）
    if (lastEl.current !== el) {
      lastEl.current = el
      lastHeight.current = el.offsetHeight
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
      return
    }

    const from =
      timer.current !== null
        ? el.getBoundingClientRect().height
        : (lastHeight.current ?? el.offsetHeight)

    el.style.transition = 'none'
    el.style.height = ''
    const to = el.offsetHeight
    lastHeight.current = to

    const settle = (): void => {
      el.style.height = ''
      el.style.transition = ''
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }

    // 高度没变（比如只是文案变了）或用户要求减少动效：直接落定，不折腾
    if (
      Math.abs(to - from) < 1 ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      settle()
      return
    }

    el.style.height = `${from}px`
    void el.offsetHeight
    el.style.transition = `height ${duration}ms cubic-bezier(0.32, 0.72, 0, 1)`
    el.style.height = `${to}px`

    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(settle, duration + 24)
  })

  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )
}
