/**
 * 手机壳：**任意位置**向右滑动打开会话侧栏抽屉；抽屉开着时**向左滑动**关闭它。
 *
 * 手机版的侧栏只有一个入口 —— 顶栏那颗汉堡键；用户希望内容区任何地方横着一划
 * 也能开，和系统级抽屉手势一致。关同理：抽屉开着时（含手指落在遮罩 / 抽屉自身上）
 * 向左一划收起，不用非得去点遮罩或顶栏那颗键。这里只做「方向判定 + 触发」，
 * **不做跟随手指的联动**：滑入 / 滑出动画由 `ActivitySidebar` 的 `translate-x` 过渡
 * 负责（200ms），再叠一套手动 translate 会有两条动画互相抢，松手瞬间还会跳一下。
 *
 * 判定（任一不满足就放掉这次手势，交回浏览器自己处理）：
 * - 单指，且起手方向**横向为主**（先动的轴说了算；竖向 = 滚消息列表 / 终端）；
 * - 位移超过 `SWIPE_DISTANCE`（关着时向右、开着时向左），且横向位移大于纵向的
 *   `AXIS_RATIO` 倍；
 * - 起点不在**横向真的能滚**的容器里（代码块 / 宽表格）：那是它自己的滚动；
 * - 起点不在输入控件 / 弹层里：前者是文本光标拖动，后者盖在抽屉之上；
 * - 设置页盖在上面（`enabled = false`）时不接管。
 *
 * ⚠️ 开 / 关的判据是**起手那一刻**的 `open`：一次手势只做一件事，滑到一半状态
 * 变了也不会反过来再判一次。
 *
 * ⚠️ 用 `touch*` 而不是 `pointer*`：要的是**触屏手势**。桌面浏览器里开 `/m` 时
 * 按住鼠标左键拖不该弹侧栏（pointer 事件会把鼠标也算进来）。
 *
 * ⚠️ 监听一律 `passive`、**不 preventDefault**：竖向滚动与输入框选词保持原生行为。
 * 一旦在这里拦滚动，消息列表和终端的触屏滚动都会变钝（终端自己那套在
 * `terminal-touch-scroll.ts`，别跟它抢）。
 */
import { useEffect } from 'react'
import {
  setMobileSidebarOpen,
  useMobileSidebarOpen
} from '@fizz/agent-kit/shared/lib/mobile-sidebar'

/**
 * 横向移动多少 px 算一次「滑」。
 *
 * 手机上这个手势是**全局**的（正文任意位置都能开抽屉），阈值定得太低时，
 * 列表里横向拨一下、手滑擦过内容都会误开。56 实测过于灵敏，抬到 96，
 * 仍明显小于半屏宽度，正常刻意的横划不会觉得费力。
 */
const SWIPE_DISTANCE = 96
/** 横向位移要超过纵向的几倍：斜着划（一边滚列表一边偏）不算 */
const AXIS_RATIO = 2
/** 起手多少 px 内只用来定方向，不判触发 */
const AXIS_LOCK = 12

/**
 * 起点是否落在**横向真的能滚**的祖先里。
 *
 * 只看 `overflow-x: auto / scroll` 且内容确实超宽的元素 —— 一路 walk 到 `body`，
 * 但只有超宽的元素才会走到 `getComputedStyle`（正常情况下一次都不触发）。
 */
function startsInHorizontalScroller(target: Element): boolean {
  /*
   * 只避让**消息区里面**的横向滚动容器（代码块 / 宽表格）。
   *
   * 消息区自身（`[data-message-scroll]`）或它外面的任何一层，哪怕因为 1px 的
   * 误判能被横向滚，也**不能**吃掉抽屉手势 —— 那是手机的骨架屏 / 消息列表，
   * 用户在这里横划的意思就是开抽屉。实测过：加载骨架时消息区一旦被算成横向
   * 滚动容器，右滑开抽屉就整个失效（同时骨架还能被左右拖）。
   */
  const messageScroll = target.closest('[data-message-scroll]')
  for (let el: Element | null = target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue
    const overflowX = getComputedStyle(el).overflowX
    if (overflowX !== 'auto' && overflowX !== 'scroll') continue
    // 消息区 / 外壳层：不是「正文里那块自己该滚的内容」，放给抽屉手势
    if (messageScroll && (el === messageScroll || !messageScroll.contains(el))) continue
    return true
  }
  return false
}

/**
 * 当前有没有盖在抽屉之上的弹层。
 *
 * 手机上的 Dialog 已被 `vite.config.ts` 换成底部抽屉（vaul），所以除了 Radix 的
 * `role="dialog"` 还要认 vaul / 手机抽屉的标记 —— 只查 touch 目标本身不够：
 * 弹层的遮罩是内容的**兄弟节点**，手指落上去时 `closest` 找不到那个 role。
 *
 * 下拉菜单 / 选择器是 `role="menu"` / `role="listbox"`（不是 dialog），也要算弹层：
 * 模型选择器底部那颗思考强度滑条，拖动本身就是大距离横向手势，不排除的话滑到
 * 96px 就会被当成「右滑开抽屉」（用户反馈）。同理，菜单里任何按钮上的横向拖动
 * 也不该触发全局手势。
 *
 * `data-slot` 是兜底：`data-state` 在关闭动画期间会变成 `closed`，而弹层此时还挂在
 * DOM 里；只要这块面板还看得见，起手就该交回给它。
 */
function hasOpenLayer(): boolean {
  return !!document.querySelector(
    '[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"], [data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"], [data-slot="popover-content"], [data-mobile-dialog], [data-vaul-drawer]'
  )
}

export function useSidebarSwipe(enabled: boolean): void {
  const open = useMobileSidebarOpen()

  useEffect(() => {
    if (!enabled) return

    let startX = 0
    let startY = 0
    /** 手指还落在一次可能成立的手势上（起手那几像素内为 true） */
    let tracking = false
    /** 方向已经定成横向（定成竖向就直接放掉） */
    let horizontal = false
    /** 已经触发过一次，等下次 touchstart 再复位 */
    let fired = false
    /** 这次手势是「收起抽屉」：起手时抽屉开着，要求左移 */
    let closing = false

    const reset = (): void => {
      tracking = false
      horizontal = false
      fired = false
      closing = false
    }

    const onTouchStart = (event: TouchEvent): void => {
      reset()
      if (event.touches.length !== 1) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (hasOpenLayer()) return
      if (
        target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      )
        return
      // 滑条（思考强度等）本身就是横向拖动控件：哪怕弹层标记没查到，也不能当成抽屉手势
      if (target.closest('[role="slider"], [data-slot="slider"]')) return
      if (startsInHorizontalScroller(target)) return
      tracking = true
      closing = open
      startX = event.touches[0].clientX
      startY = event.touches[0].clientY
    }

    const onTouchMove = (event: TouchEvent): void => {
      if (!tracking || fired) return
      if (event.touches.length !== 1) {
        tracking = false
        return
      }
      const dx = event.touches[0].clientX - startX
      const dy = event.touches[0].clientY - startY
      if (!horizontal) {
        if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return
        // 先动的轴说了算：竖向就是滚列表 / 终端，立刻放掉这次手势
        if (Math.abs(dy) >= Math.abs(dx)) {
          tracking = false
          return
        }
        horizontal = true
      }
      // 关着向右 = 开；开着向左 = 关。方向反了就等手指回摆（手势本身仍成立）
      const forward = closing ? -dx : dx
      if (forward < SWIPE_DISTANCE || forward <= Math.abs(dy) * AXIS_RATIO) return
      fired = true
      tracking = false
      setMobileSidebarOpen(!closing)
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', reset, { passive: true })
    window.addEventListener('touchcancel', reset, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', reset)
      window.removeEventListener('touchcancel', reset)
    }
  }, [enabled, open])
}
