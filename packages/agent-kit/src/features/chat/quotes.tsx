/**
 * 引用消息的两块 UI：
 * - `MessageQuoteLayer`：在消息里划选一段文字 → 浮出「引用 / 复制」两颗按钮；
 * - `QuotePreviewRow`：输入框卡片 header 里的引用片（摘录 + 来源 + 移除）。
 *
 * 引用状态与发送拼装归调用方（`ChatPanel`），这里只收 state + 回调 ——
 * 与 `attachments.tsx` 的分工一致。
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Quote, X } from 'lucide-react'
import { LiquidGlassSurface } from '@fizz/ui/liquid-glass'
import { nextQuoteId, type MessageQuote } from '@fizz/agent-kit/shared/lib/quotes'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 浮层与选区之间的间距（px）：按钮底边停在选区顶边上方这么远 */
const TOOLBAR_GAP = 8

/**
 * 浮层自身的高度估算（px）。
 *
 * 用来判断「选区上方还剩多少空间」——空间不够就把浮层翻到选区**下方**，
 * 而不是让它飘到消息区之外（那会压到标签条 / 面板 chrome 上，见下面的说明）。
 * 按 `py-1 + text-xs` 的实测高度给，宁可略大：差几像素只是判定保守一点。
 */
const TOOLBAR_HEIGHT = 30

/**
 * 选区所在的**滚动容器**（消息列表），浮层的可见边界就是它。
 *
 * 为什么不用 `window.innerHeight`：消息区在面板里，它的上缘下面是标签条、下缘上面是
 * 输入卡 —— 拿视口当边界，浮层就会飘进这些 chrome 里。而 chrome 是 `z-10`（标签条）、
 * 浮层是 body 上 `fixed z-50`，**浮层一定画在 chrome 之上**（跨了层叠上下文，比 z 值
 * 没意义）。所以边界必须取容器自己的 rect。
 *
 * 优先认 `[data-message-scroll]`（`Conversation` 显式标的锚点）；找不到才退回按
 * `overflow-y` 往上找祖先 —— 正文里的代码块也是 `overflow-auto`，那种通用找法会误判。
 */
function scrollParentOf(el: Element): Element | null {
  const explicit = el.closest('[data-message-scroll]')
  if (explicit) return explicit
  let cur = el.parentElement
  while (cur) {
    const overflowY = getComputedStyle(cur).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return cur
    cur = cur.parentElement
  }
  return null
}

/**
 * 「已复制」的回执时长（ms）。
 *
 * 与消息行尾那颗复制按钮同一个节奏（`message-parts.tsx` 的 1200ms）——同一件事在两处
 * 给不同时长的反馈，用户会以为其中一处没生效。
 */
const COPIED_MS = 1200

/**
 * 选区落定的静默期（ms）：最后一个 `selectionchange` 之后这么久才算「选完了」。
 *
 * 拖选期间这个计时器每次都被重置，所以真正的出现时机是**松手之后**；键盘扩选
 * （Shift + 方向键）同理，停手后才浮出。140ms 是「短于一次双击的间隔、又不至于
 * 让人觉得卡了一下」的量级 —— 再快会在拖选的尾巴上闪，再慢就像没反应。
 */
const SETTLE_MS = 140

/**
 * 关闭后延迟卸载的时长（ms）。
 *
 * ⚠️ 与动画层的 `duration-150` 是一对：比过渡略长一点点（多留 10ms 余量，避免末尾
 * 被截）。改一个必须改另一个 —— 短于过渡 = 播到一半被卸载（闪一下），远大于过渡 =
 * 浮层已经看不见却还挂在 DOM 上、白占一层 `backdrop-filter`。
 */
const EXIT_MS = 160

/**
 * 浮层里一颗按钮的排版。
 *
 * ⚠️ hover 用**白色半透明提亮**，不能用实心令牌（`bg-accent` / `bg-foreground/10` 都不行）：
 * 外壳是液态玻璃，底色本来就是半透明的，再叠一层实心色或「墨」会把玻璃压成一块实心方块，
 * 浮层瞬间从玻璃退回 tooltip。白色叠在半透明玻璃上是「这块玻璃被照亮」，材质还在。
 * 暗色主题那半档压得更淡 —— 同样的白在深底上过曝。
 *
 * ⚠️ `whitespace-nowrap` 不能省。浮层是 `fixed` + `left: 选区中心`，**没有固定宽度**
 * —— 它的可用宽度就是「left 到视口右缘」。选区靠右时那个空间小到装不下两颗按钮，
 * shrink-to-fit 于是把「引用 / 复制」压成两行。禁掉换行后它会按内容宽度排版，
 * 溢出由下面的水平夹取负责收回来（见 `left` 的计算）。
 */
const TOOLBAR_BUTTON =
  'flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/25 hover:text-foreground dark:hover:bg-white/10'

/**
 * 消息区划选 → 浮出「引用 / 复制」两颗按钮。
 *
 * 只**读**选区，不改选中策略：消息正文本来就可选（`.sd-md` / `pre` 在 `styles.css`
 * 的白名单里），缺的只是这两个入口。浮层挂 `body` + `position: fixed` —— 消息区是
 * 滚动容器，挂在它里面会被祖先裁剪、还会跟着滚。
 *
 * ## 什么时候出现（这条是行为契约，别退化）
 *
 * **只在选区落定之后出现，拖选过程中不出现**：
 * - 指针按着（`pointerdown` → `pointerup`）一律不显示 —— 拖选时浮层跟着跑会挡视线，
 *   还会把正在拖的选区搅乱；
 * - 松手之后还有一道静默期（`SETTLE_MS`）：期间又有新的 `selectionchange` 就重置。
 *   这样「拖着不放停在原地」也不会提前冒出来，双击选词 / 键盘扩选同样是停手才浮出。
 *
 * ## 出现与消失
 *
 * 用 `transition` + `starting:`（`@starting-style`），不是 `animate-in`：动画挂在
 * **内层包裹**上、外层只管定位 —— 既不吃 `-translate-x-1/2` 的 transform，
 * `starting:` 又能给「刚插入的那一帧」一个起点值（挂上即终态的话过渡根本不播）。
 * 关闭时先置 `open=false` 播退出过渡，`EXIT_MS` 后才从 DOM 里摘掉。
 *
 * 一条选区「可用」要同时满足：
 * - 非空、非折叠（点一下产生的折叠选区不算）；
 * - 起点落在 `[data-message-id]` 里（消息之外 —— 侧栏 / 通知 / chrome —— 的选区不参与）；
 * - 不在输入框 / contenteditable 里（那是用户在自己写东西）；
 * - 有几何（`getBoundingClientRect` 全零 = 选区不可见，例如折叠起来的区域）。
 */
export function MessageQuoteLayer({
  onQuote,
  scopeRef
}: {
  onQuote: (quote: MessageQuote) => void
  /**
   * 这一栏会话视图的根节点：分屏时两栏各挂一套浮层，而选区事件是**全局**的 ——
   * 必须只认「落在这棵子树里」的消息，否则两栏同时弹（叠在一起），顶层那颗按钮
   * 点下去就写进了另一栏的输入框。
   *
   * 不传 = 不限制（单栏 / 片段渲染场景）。
   */
  scopeRef?: RefObject<HTMLElement | null>
}) {
  /**
   * 浮层落点（选区边缘中点的视口坐标）+ 在选区上方还是下方；null = 已从 DOM 摘掉。
   *
   * 与 `open` 分开：`at` 管「在不在 DOM 里」，`open` 管「看不看得见」。消失动画要求
   * 关闭后再留一小会儿（`EXIT_MS`），直接置 null 就没有过渡可播。
   */
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null)
  /** 可见（驱动进入 / 退出过渡）；与 `at` 分开的理由见上 */
  const [open, setOpen] = useState(false)
  /** 「复制」按下的回执：图标就地换成勾（宽度不变，浮层不会因此横移） */
  const [copied, setCopied] = useState(false)
  /** `open` 的镜像：事件回调里必须读**当下**的值，不能靠闭包（闭包永远是首帧那份） */
  const openRef = useRef(false)
  /** 本次选区的正文 + 来源；与浮层同生共死（点按钮时读它） */
  const pendingRef = useRef<{ text: string; role: MessageQuote['role'] } | null>(null)
  /** 浮层此刻展示的是哪段文字：同一段（滚动跟随）只挪位置，换了一段要重新走「落定」 */
  const shownTextRef = useRef<string | null>(null)
  /** 指针按着（拖选中）：这段时间一律不显示，松手才谈出现 */
  const draggingRef = useRef(false)
  /** 落定静默期定时器（`SETTLE_MS`）；每次 `selectionchange` 重置 */
  const settleTimerRef = useRef(0)
  /** 关闭后延迟卸载的定时器（`EXIT_MS`） */
  const exitTimerRef = useRef(0)
  /** 组件级 `dismiss` 用它调 effect 内部的 `close`（那个 `close` 要读 refs，不放在渲染闭包里） */
  const closeRef = useRef<(() => void) | null>(null)
  /**
   * 「已复制」的回执定时器（到点才收浮层 + 清选区）。
   *
   * ⚠️ 复制**不能立刻**清选区：`removeAllRanges()` 会触发 `selectionchange`，而那个监听
   * 的第一件事就是把浮层收掉 —— 勾还没画出来就没了。所以先让勾亮 1.2 秒。
   */
  const ackTimerRef = useRef(0)
  /**
   * 浮层定位层（量宽度用）+ 量到的宽度。
   *
   * 水平夹取要知道浮层有多宽（见 `left` 的计算）。宽度由内容决定、只在首次量到后
   * 缓存 —— 两颗按钮的文字固定（「复制」的回执只换图标、不换文字，就是为了不让它变宽），
   * 所以量一次就够，不必每帧量（每帧量会强制同步布局）。缩放动画在**内层**包裹上，
   * 不影响这里的 `offsetWidth`。
   */
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [toolbarWidth, setToolbarWidth] = useState(0)
  /**
   * 本次选区是否已经量过宽度。
   *
   * ⚠️ 用「每次选区量一次」而不是「每帧量」：`at` 在滚动 / 流式输出时每帧都在变，
   * 若把测量挂在它上面，每帧都会读一次 `offsetWidth` —— 那是**强制同步布局**，
   * 长会话里就是滚动卡顿的来源。宽度只由那两颗按钮的文字决定（「复制」的回执
   * 刻意只换图标不换文字，正是为了不让它变宽），量一次足够。
   */
  const measuredRef = useRef(false)
  /** 最近一次算出的**消息区水平边界**（由 `sync` 写入，渲染时用来夹取浮层位置） */
  const boundsRef = useRef<{ left: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!at || measuredRef.current) return
    const width = layerRef.current?.offsetWidth ?? 0
    if (width > 0) {
      measuredRef.current = true
      setToolbarWidth(width)
    }
  }, [at])

  useEffect(() => {
    /**
     * 收浮层：先 `open=false` 播退出过渡，`EXIT_MS` 之后才从 DOM 摘掉。
     * 幂等 —— 拖选期间几乎每帧都会调它。
     */
    const close = (): void => {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = 0
      // 已经不可见（没出现过 / 正在退出）就别动：重排卸载定时器会让浮层一直挂在 DOM 上
      if (!openRef.current) return
      openRef.current = false
      setOpen(false)
      // 「已复制」的勾与回执定时器跟着浮层一起收：下次浮出来的必须是「复制」而不是勾
      window.clearTimeout(ackTimerRef.current)
      ackTimerRef.current = 0
      setCopied(false)
      window.clearTimeout(exitTimerRef.current)
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = 0
        shownTextRef.current = null
        pendingRef.current = null
        // 下一次选区要重新量宽度（按钮文字理论上不变，但别把「量过」当成永久事实）
        measuredRef.current = false
        setAt(null)
      }, EXIT_MS)
    }
    closeRef.current = close

    /** 量出来的落点 + 选区身份 */
    type Settled = {
      text: string
      role: MessageQuote['role']
      pos: { x: number; y: number; below: boolean }
    }

    /**
     * 量一遍当前选区 —— **只测量、不决定显示**。
     *
     * null = 这段选区不归这个浮层管（空 / 折叠 / 在输入框里 / 不在消息里 / 没几何）。
     * 「什么时候出现」全部由 `sync` 分派，别把显示条件写进这里。
     */
    const measure = (): Settled | null => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
      const text = sel.toString().trim()
      if (!text) return null
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
      if (!el || el.closest('input, textarea, [contenteditable="true"]')) return null
      const messageEl = el.closest('[data-message-id]')
      if (!messageEl) return null
      /*
        分屏：两个 `ChatPanel` 的浮层都在监听同一个全局选区。只认**自己这一栏**里的
        消息元素 —— 否则两栏都会 `reveal`、toolbar 叠在同一处，点上面那颗「引用」写进
        的是另一栏（用户报过：在左边选字，引用跑到右边输入框）。
      */
      const scope = scopeRef?.current
      if (scope && !scope.contains(messageEl)) return null
      const rect = range.getBoundingClientRect()
      if (!rect.width && !rect.height) return null
      // 选区已经被滚出视口：收掉（位置重算得再准也没意义）
      if (rect.bottom < 0 || rect.top > window.innerHeight) return null
      /**
       * 浮层必须待在**消息区**里（见 `scrollParentOf`）：上方放不下就翻到选区下面。
       * 不这么判的话，选区滚到顶部时浮层会飘进标签条 —— 而它是 body 上的 `fixed`
       * 浮层，一定画在 chrome 之上，看起来就是「浮层压住了标签页」。
       */
      const container = scrollParentOf(messageEl)
      const bounds = container?.getBoundingClientRect()
      boundsRef.current = bounds ? { left: bounds.left, right: bounds.right } : null
      const topLimit = bounds ? bounds.top : 0
      const bottomLimit = bounds ? bounds.bottom : window.innerHeight
      const above = rect.top - TOOLBAR_GAP - TOOLBAR_HEIGHT >= topLimit
      // 上面放不下、下面也放不下（选区几乎占满可视区）：这时没有合法位置，收掉
      if (!above && rect.bottom + TOOLBAR_GAP + TOOLBAR_HEIGHT > bottomLimit) return null
      return {
        text,
        role: messageEl.getAttribute('data-role') === 'user' ? 'user' : 'assistant',
        pos: {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(above ? rect.top - TOOLBAR_GAP : rect.bottom + TOOLBAR_GAP),
          below: !above
        }
      }
    }

    /** 写落点：位置没变就不 setState（流式输出时每帧都会重算一次，白重渲染） */
    const place = (pos: Settled['pos']): void => {
      setAt((prev) =>
        prev && prev.x === pos.x && prev.y === pos.y && prev.below === pos.below ? prev : pos
      )
    }

    /**
     * 让浮层出现（已经把旧的挪过去）。
     *
     * `setAt` 与 `setOpen(true)` 同批渲染、元素**首帧**就带上 `starting:` 的起点样式，
     * 过渡才播得出来 —— 不必先渲染一帧再置 open。
     */
    const reveal = (m: Settled): void => {
      window.clearTimeout(exitTimerRef.current)
      exitTimerRef.current = 0
      shownTextRef.current = m.text
      pendingRef.current = { text: m.text, role: m.role }
      place(m.pos)
      openRef.current = true
      setOpen(true)
    }

    /**
     * 一次「按最新选区更新浮层」。
     *
     * `allowReveal` 是这套东西的关键：默认**不放行出现**，只更新已经显示出来的浮层；
     * 要出现必须等静默期到点（`settle` 里以 true 再调一次）。拖选过程中浮层不跟着跑，
     * 靠的就是这个分派 + `draggingRef` 那道硬闸。
     */
    const sync = (allowReveal: boolean): void => {
      // 指针按着 = 正在拖选：一律不显示（连已经排进静默期的出现也一起取消）
      if (draggingRef.current) return close()
      const m = measure()
      if (!m) return close()
      pendingRef.current = { text: m.text, role: m.role }
      // 同一段选区、只是位置变了（滚动 / 流式输出）：跟随，别重播一次出现动画
      if (openRef.current && shownTextRef.current === m.text) return place(m.pos)
      if (allowReveal) return reveal(m)
      // 新选区还没落定：先收掉上一次的浮层，等静默期
      close()
      settle()
    }

    /**
     * 选区落定的静默期：`SETTLE_MS` 内没有新的 `selectionchange` 才算选完。
     *
     * ⚠️ 不能只靠它挡「拖选过程中出现」：按住不放停在原地时静默期照样会到点，
     * 那一路由 `draggingRef` 负责。两条一起才是「松手后才浮出」。
     */
    const settle = (): void => {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = 0
        sync(true)
      }, SETTLE_MS)
    }

    /**
     * `selectionchange` 在拖选过程中会连发多次，每次都量几何就是布局抖动 ——
     * 一帧合并一次（同一帧里调度多次只跑最后一次）。
     */
    let queued = 0
    const schedule = (): void => {
      if (queued) return
      queued = requestAnimationFrame(() => {
        queued = 0
        sync(false)
      })
    }
    /**
     * 拖选硬闸：`pointerdown` → `pointerup` 之间一律不显示。
     *
     * 松手时主动 `schedule()` 一次：拖回原位这种「选区没变化」的松手可能不再发
     * `selectionchange`，只等事件会永远不出来（静默期也就在这次 schedule 里重新起算）。
     */
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      const target = event.target as Element | null
      // 点在浮层自己身上：交给按钮（它们的 `pointerdown` 已 preventDefault）
      if (target?.closest('[data-quote-layer]')) return
      draggingRef.current = true
      close()
    }
    const onPointerUp = (): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      schedule()
    }
    /**
     * 在窗口外松手收不到 `pointerup`：硬闸会永久卡在「拖选中」，浮层再也不出现。
     * 失焦时兜底放开。
     */
    const onWindowBlur = (): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      schedule()
    }
    /**
     * 点「任何地方」都能取消选中 —— 包括消息区之外（侧栏、标签条、输入框、空白处）。
     *
     * 浏览器的默认行为只在**可选中的文字**上清选区：点在 `user-select: none` 的界面元素
     * （外壳、按钮、标签条）上时选区会保留，于是浮层一直挂着，用户只能回到消息里点一下
     * 才能收掉。
     *
     * 判据只有两条：
     * - 点在浮层自己身上 → 交给按钮的 onClick（它们的 `pointerdown` 已 preventDefault）；
     * - 其余**任何位置**（消息正文、侧栏、标签条、输入框、空白处）→ 清选区并收掉浮层。
     *
     * 消息正文**不排除**：清掉旧选区正是浏览器的默认行为（重新拖选会立刻建一个新的），
     * 而消息里那些 `user-select: none` 的按钮 / 卡片头不会清 —— 那正是「点了没收掉」的来源。
     * 唯一让路的是 `shift + 点`（扩选），那是浏览器的活。
     *
     * 用 `mousedown` 而不是 `pointerdown`：移动端滚动列表时 `pointerdown` 先到，
     * 边滚边清会把「选一段正在输出的内容再滚着看」这条路堵死；`mousedown` 只在
     * 真正的按下（点击）时来，滚动不会触发。
     */
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0 || event.shiftKey) return
      const target = event.target as Element | null
      if (target?.closest('[data-quote-layer]')) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return
      sel.removeAllRanges()
      close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('selectionchange', schedule)
    /**
     * 滚动 / 改窗口大小：**重算位置，而不是藏起来**。流式输出期间消息区一直在自动滚，
     * 一滚就藏的话「引用正在输出的那一段」根本点不着 —— 选区内容没变，变的只是位置。
     * （真滚出视口了，`measure` 里那道视口判断会收掉。）
     */
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      if (queued) cancelAnimationFrame(queued)
      window.clearTimeout(ackTimerRef.current)
      window.clearTimeout(settleTimerRef.current)
      window.clearTimeout(exitTimerRef.current)
      closeRef.current = null
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerUp, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('selectionchange', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('blur', onWindowBlur)
    }
    // `scopeRef` 是稳定的 ref 对象；换栏（split 里拖动标签）时元素可能换，但对象不变
  }, [scopeRef])

  /**
   * 收浮层 + 清选区（两颗按钮的收尾动作只有这一份）。
   *
   * 走 `closeRef` 而不是直接 `setAt(null)`：收起也要有过渡，由 effect 里的 `close`
   * 负责「先播动画、`EXIT_MS` 后再卸载」。
   */
  const dismiss = (): void => {
    window.getSelection()?.removeAllRanges()
    closeRef.current?.()
  }

  const quote = (): void => {
    const pending = pendingRef.current
    // 先收浮层、清选区（内容已经拿到手，高亮留着只碍眼），再交给调用方
    dismiss()
    if (pending) onQuote({ id: nextQuoteId(), ...pending })
  }

  const copy = (): void => {
    const pending = pendingRef.current
    if (!pending) return
    void navigator.clipboard.writeText(pending.text).then(() => {
      setCopied(true)
      ackTimerRef.current = window.setTimeout(() => {
        ackTimerRef.current = 0
        // 回执期间用户可能已经划到别处了：那就别动他现在的选区，只收掉勾
        setCopied(false)
        if (pendingRef.current?.text === pending.text) dismiss()
      }, COPIED_MS)
    })
  }

  if (!at) return null
  /**
   * 水平位置：选区中点居中，再**夹进消息区**。
   *
   * 不夹的话，选区靠右时浮层会有一半探出容器（它是 `-translate-x-1/2` 居中的），
   * 探出去那截要么压到右侧面板、要么被视口裁掉。夹取用「容器左右边界 ± 半宽」，
   * 容器比浮层还窄（极窄的面板）时退化成居中 —— 那时没有合法位置，居中最好看。
   */
  const bounds = boundsRef.current
  const half = toolbarWidth / 2
  let left = at.x
  if (bounds && toolbarWidth > 0) {
    left =
      bounds.left + half > bounds.right - half
        ? Math.round((bounds.left + bounds.right) / 2)
        : Math.round(Math.min(Math.max(at.x, bounds.left + half), bounds.right - half))
  }
  return createPortal(
    <div
      ref={layerRef}
      data-quote-layer
      // `-translate-y-full` 只在浮层位于选区**上方**时用（下方时它本来就该往下长）
      className={cn(
        'fixed z-50 -translate-x-1/2',
        at.below ? 'translate-y-0' : '-translate-y-full'
      )}
      style={{ left, top: at.y }}
    >
      {/*
        出现 / 消失的过渡挂在**这一层**，不挂在定位层：定位层管 `-translate-x-1/2` /
        `-translate-y-full`（贴选区的那条边），动画层只管缩放与透明度，两者互不干涉。

        `starting:`（Tailwind 4.1+ 的 `@starting-style`）给「元素刚插入的那一帧」一个
        起点值 —— 少了它，挂上就是终态、过渡不播。这也是不用 `animate-in` 的原因：
        那套要额外等一帧，而且它的 `transform` 会盖掉定位层的居中位移。

        ⚠️ **出现动画只缩不放透明度**（`starting:opacity-0` 已移除，别加回来）：
        透明度小于 1 的祖先会成为新的 **backdrop root**，里面 `LiquidGlassSurface` 的
        `backdrop-filter` 就只能采样到这个透明组本身、而不是背后的正文 —— 整段淡入期间
        浮层是一层没有磨砂的透明色，动画走完（opacity 回到 1、组消失）才「啪」地变成
        液态玻璃（用户报的「先透明，再变玻璃」）。终端悬浮球展开时那几颗动作球也踩过
        同一个坑，靠的同样是「别让玻璃待在 opacity 动画里」。
        消失方向不受影响（淡出时本来就该越来越透），所以 `opacity` 只留在收起态的
        过渡里 —— 展开只过渡 `scale`，收起才过渡 `scale + opacity`。
      */}
      <div
        className={cn(
          'duration-150 ease-out',
          open
            ? 'transition-[scale]'
            : 'pointer-events-none transition-[scale,opacity]',
          'starting:scale-90 motion-reduce:transition-none',
          // 收缩 / 展开的原点贴着选区那一侧：在上方就从底边冒出来，在下方就从头冒出来
          at.below ? 'origin-top' : 'origin-bottom',
          // 关闭态还要摘掉点击：退出过渡那 `EXIT_MS` 里浮层仍在 DOM 上
          open ? 'scale-100 opacity-100' : 'scale-90 opacity-0'
        )}
      >
        {/*
          外壳是液态玻璃（`LiquidGlassSurface`，与发送钮 / 终端悬浮球**同一份材质**）：
          半透明玻璃色 + 背后 22px 磨砂，浮在正文上时底下的字被虚化透出来 —— 像给选区
          盖了一块放大镜，而不是贴了一张不透明的小卡片。

          `tone="contrast"`：浅色会话背景上纯白玻璃等于隐形，这一档掺了石板灰才看得出
          「这是一块玻璃」（暗色主题两档同款，不受影响）。

          两颗按钮共用**一层**玻璃、中间一条发丝线隔开 —— 两个独立胶囊并排会显得是
          两个浮层，中间那道缝里还会漏出底下的正文。

          ⚠️ `overflow-hidden` 只能加在**内层** div 上：玻璃的描边与投影挂在
          `LiquidGlassSurface` 的最外层，在外层裁会把投影一起裁掉（浮层于是贴着正文、
          没有悬浮感）。内层只负责把按钮 hover 的亮底裁进圆角。
        */}
        <LiquidGlassSurface tone="contrast" className="rounded-lg">
          <div className="flex items-stretch overflow-hidden rounded-[inherit]">
            <button
              type="button"
              /**
               * ⚠️ `pointerdown` 必须 `preventDefault`：不拦的话浏览器会先把选区清掉，
               * 等 onClick 里再读 `getSelection()` 就是空的 —— 引用内容当场丢掉。
               * 「复制」那颗同理（它读的是同一个 `pendingRef`）。
               */
              onPointerDown={(e) => e.preventDefault()}
              onClick={quote}
              className={TOOLBAR_BUTTON}
            >
              <Quote className="size-3.5" />
              引用
            </button>
            {/* 发丝线在半透明玻璃上：`bg-border` 是给实心底配的，压不住玻璃的亮度 */}
            <span className="w-px shrink-0 bg-foreground/15 dark:bg-white/20" />
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={copy}
              // ⚠️ 文案**不换**（只换图标）：换了文字浮层会变宽，而它是 `-translate-x-1/2`
              // 居中的，一宽就整体横移几像素 —— 一个飘在选区上方的小浮层原地跳一下很显眼
              title={copied ? '已复制' : '复制选中的文字'}
              aria-label={copied ? '已复制' : '复制选中的文字'}
              className={TOOLBAR_BUTTON}
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                <Copy className="size-3.5" />
              )}
              复制
            </button>
          </div>
        </LiquidGlassSurface>
      </div>
    </div>,
    document.body
  )
}

/**
 * 待发送引用片：与**附件预览行**同一套 chip 排布（`flex flex-wrap gap-2` + 细边小卡），
 * 渲染在输入卡片 header 槽里、附件行之上。
 *
 * 早先是「整条 `bg-muted/40` + 左侧图标 + 小标题 + 两行正文」的状态条（与
 * `EditMessageBar` / `SteerEditBar` 同款）。用户要求改成**像附件那样的小片**：
 * 引用是「随消息一起发出去的内容」，不是「正在改哪条历史」那种模式提示 ——
 * 一条横幅压在卡片顶上，既占高度又容易被当成输入框之外的另一个控件。
 * 小片一行摘录、多个引用横向换行排开，与附件缩略图在同一个视觉层级上。
 *
 * 摘录只截一行（全文在 `title` 里；**发送的是完整原文**，与这里的截断无关），
 * 所以「引用你的消息 / 引用助手消息」这个区分也挪进 `title`，不再占一行字。
 */
export function QuotePreviewRow({
  quotes,
  onRemove
}: {
  quotes: MessageQuote[]
  onRemove: (id: string) => void
}) {
  if (quotes.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 py-2">
      {quotes.map((q) => (
        <div
          key={q.id}
          className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-lg border border-border bg-muted/40 py-1 pl-2 pr-1"
        >
          <Quote className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={`${q.role === 'user' ? '引用你的消息' : '引用助手消息'}：${q.text}`}
          >
            {q.text}
          </span>
          <button
            type="button"
            aria-label="移除引用"
            title="移除引用"
            onClick={() => onRemove(q.id)}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
