/**
 * 终端容器上的三条**鼠标 / 触摸侧交互**：Ctrl+滚轮缩放、右键粘贴、选中即复制。
 *
 * 它们原先连同 xterm 建实例、PTY 建会话、ZMODEM 嗅探一起摊在 `TerminalPanel` 那个 800 多行的
 * 主 effect 里，读起来像「建个终端顺手还管剪贴板」。共同点是：都挂在**容器 / term 的 DOM 上**、
 * 都只依赖偏好开关、跟会话生命周期无关 —— 于是抽成一个「挂上去，返回卸载函数」的独立单元。
 *
 * ⚠️ 容器上的监听必须走 **capture**（且卸载时也要带同一个 capture 参数，否则摘不掉）：
 * xterm 6 把滚轮挂在更深的 `.xterm-scrollable-element` 上、contextmenu / mouse 事件它自己
 * 也会 `stopPropagation`，冒泡阶段根本收不到。
 */
import type { Terminal } from '@xterm/xterm'
import {
  getTerminalCopyOnSelect,
  getTerminalPasteOnRightClick
} from '@fizz/agent-kit/shared/lib/terminal-prefs'
import { writeClipboard } from '@fizz/agent-kit/shared/lib/clipboard'

/**
 * 右键粘贴用：剥掉粘贴文本末尾的换行。
 *
 * 终端里粘贴的 `\n` 等于回车 —— 从网页 / 编辑器里复制一整段命令带个结尾换行是常态，
 * 不剥就成了「在终端里随便点一下 ← 命令被直接执行」。中间的换行保留（多行粘贴照旧）。
 */
export function stripTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, '')
}

export interface TerminalInteractionsOptions {
  term: Terminal
  /** 终端容器（滚轮与右键监听挂在这里） */
  container: HTMLElement
  /** 当前字号（缩放基准，走 ref 读最新值） */
  fontSizeRef: { current: number }
  /** 落地新字号（夹范围 + 持久化都在调用方） */
  applyFontSize: (size: number) => void
  /** 右键粘贴写入口子（预测缓冲 / ZMODEM 拦截 / 已退出都靠它兜） */
  sendInput: (data: string) => void
  /** 剪贴板读失败（浏览器权限被拒）：交给调用方在状态条上提示 */
  onPasteFailed: () => void
  /** 这个 term 是否仍是当前实例（异步读剪贴板期间可能已经换掉了会话） */
  isCurrent: () => boolean
  /**
   * 本次选区变化要不要跳过「选中即复制」。方向键选区模式下每次按键都会改选区，
   * 不跳过会每 70ms 写一次剪贴板（安卓还会反复弹「已复制」系统提示）。
   */
  suppressCopyOnSelect?: () => boolean
}

/** 挂上三条容器交互，返回卸载函数 */
export function attachTerminalInteractions(options: TerminalInteractionsOptions): () => void {
  const { term, container, fontSizeRef, applyFontSize, sendInput, onPasteFailed, isCurrent, suppressCopyOnSelect } =
    options

  /**
   * 滚轮缩放：Ctrl/Cmd + 滚轮调整字号（普通滚轮仍交给 xterm 翻滚动缓冲）。
   *
   * ⚠️ 必须**捕获阶段**拦截并 stopPropagation：xterm 6 把滚轮监听挂在更深的
   * `.xterm-scrollable-element` 上，冒泡阶段它会先于容器这一层触发 —— 只要还有可滚内容，
   * 它就 preventDefault + stopPropagation 把事件吃掉，于是 Ctrl+滚轮变成「上下翻滚缓冲」，
   * 而不是缩放；只有刚好滚到顶 / 底、无内容可滚时才会轮到缩放。捕获阶段是从外往里走，
   * 先于它拿到事件，缩放才能稳定生效。另：非 passive 才能 preventDefault 掉页面缩放。
   */
  const onWheel = (e: WheelEvent): void => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    e.stopPropagation()
    applyFontSize(fontSizeRef.current + (e.deltaY < 0 ? 1 : -1))
  }
  container.addEventListener('wheel', onWheel, { capture: true, passive: false })

  // 旧 WebView 的 contextmenu 可能仍是 MouseEvent、不带 pointerType；从按下事件记住来源。
  // 用户改用真实鼠标时，下一次 pointerdown 会自然切回 mouse，不按设备型号一刀切。
  let lastPointerType = ''
  const onPointerDown = (event: PointerEvent): void => {
    lastPointerType = event.pointerType
  }
  container.addEventListener('pointerdown', onPointerDown, { capture: true })

  /**
   * 右键粘贴（设置 → 终端 → 右键粘贴，默认开）：点右键把剪贴板文本写进当前命令行
   * （Windows Terminal / PuTTY 同款）。偏好每次现读，拨开关立即生效，不用重建终端。
   *
   * 三条边界：
   * - **触摸 / 手写笔长按不接管**：长按也会触发 contextmenu，不能把它当鼠标右键。
   *   放行给 xterm 聚焦 textarea、显示系统菜单，避免 WebView 主动读剪贴板失败后连菜单也没了；
   * - **有选区时不接管**：那时用户点右键多半是要「复制 / 在浏览器中搜索」，把菜单放过去更稳妥；
   * - 环境没有 `navigator.clipboard.readText`（老浏览器 / 非安全上下文）时也别把菜单吞掉 ——
   *   吞了就既没菜单、也粘不了，看起来像坏了。
   */
  const onContextMenuForPaste = (e: MouseEvent): void => {
    if (!getTerminalPasteOnRightClick()) return
    const event = e as MouseEvent & {
      pointerType?: string
      sourceCapabilities?: { firesTouchEvents?: boolean } | null
    }
    const pointerType = event.pointerType || lastPointerType
    if (pointerType === 'touch' || pointerType === 'pen' || event.sourceCapabilities?.firesTouchEvents) return
    if (term.hasSelection()) return
    const clipboard = navigator.clipboard
    if (!clipboard?.readText) return
    e.preventDefault()
    e.stopPropagation()
    void clipboard.readText().then(
      (text) => {
        // 异步返回期间可能已经拆掉终端（换 shell / 关标签）：只在还是同一个 term 时写
        if (!isCurrent()) return
        const data = stripTrailingNewlines(text)
        // 剪贴板为空：只把焦点还给终端，什么都不写（否则像是「右键没反应」）
        if (!data) {
          term.focus()
          return
        }
        sendInput(data)
        term.focus()
      },
      () => onPasteFailed()
    )
  }
  // 必须挂 **capture**：xterm 自己会处理 contextmenu / mouse 事件并 stopPropagation，
  // 冒泡阶段收不到。非 passive 才能 preventDefault 掉原生右键菜单。
  container.addEventListener('contextmenu', onContextMenuForPaste, { capture: true })

  /**
   * 选中即复制：拖选过程中选区一变就写剪贴板（Windows Terminal 的 copyOnSelect 同款）。
   * 每次回调直接读偏好（localStorage），设置页开关实时生效，不用重建终端；
   * 空选区不能写 —— 那会把剪贴板覆盖成空串。
   */
  const selectionSub = term.onSelectionChange(() => {
    if (suppressCopyOnSelect?.()) return
    if (!getTerminalCopyOnSelect()) return
    const selection = term.getSelection()
    if (!selection) return
    /**
     * 非安全上下文（用 `http://192.168.x.x` 打开 web 端 / 远程访问）里 `navigator.clipboard`
     * **整个不存在**，直接调会抛 TypeError 把选区回调打断（表现为选不中、拖选卡住）。
     * 而且不能在这里退回 execCommand：它要聚焦隐藏 textarea 抢走 xterm 的焦点，
     * 拖选会被打断，`selectionchange` 也不保证带用户手势。这条路径只留给安全上下文，
     * 非安全上下文交给下面的 `pointerup` 兜底。
     */
    const clipboard = navigator.clipboard
    if (!clipboard?.writeText) return
    // 写失败（页面没聚焦 / 权限被拒）不打断拖选：粘一次就知道没成，别每选一次弹一次错
    void clipboard.writeText(selection).catch(() => {})
  })

  /**
   * 非安全上下文的「选中即复制」：拖选结束（`pointerup`，真实用户手势）时复制一次。
   *
   * 不能放在 `selectionchange` 里走 execCommand 退路：隐藏 textarea 的 `focus()` 会
   * 抢走 xterm 焦点、打断正在进行的拖选，而且拖选途中的回调不保证还有用户手势。
   * `pointerup` 时选区已经落定，复制完再把焦点还给终端，接着敲键盘才不会丢。
   *
   * 触屏跳过：聚焦 textarea 会弹软键盘；键盘扩选仍走 Ctrl+C（`terminal-key-handler`
   * 在有选区时是复制，不会发 SIGINT）。
   */
  const onPointerUpForCopy = (event: PointerEvent): void => {
    if (event.button !== 0) return
    if (event.pointerType === 'touch') return
    // 安全上下文已经由 selectionchange 实时写过，这里再写一次是重复
    // （DOM 类型把 clipboard 写成恒存在，非安全上下文运行时其实是 undefined）
    const clipboard = navigator.clipboard as Clipboard | undefined
    if (clipboard?.writeText) return
    if (suppressCopyOnSelect?.()) return
    if (!getTerminalCopyOnSelect()) return
    const selection = term.getSelection()
    if (!selection) return
    void writeClipboard(selection).catch(() => {})
    // 退路会 focus 隐藏 textarea；这里同步还回焦点（execCommand 在 writeClipboard 里同步执行）
    term.focus()
  }
  container.addEventListener('pointerup', onPointerUpForCopy, { capture: true })

  return () => {
    // 移除时必须与注册时的 capture 一致，否则摘不掉（监听会跟着容器泄漏到重建后的终端）
    container.removeEventListener('wheel', onWheel, { capture: true })
    container.removeEventListener('pointerdown', onPointerDown, { capture: true })
    container.removeEventListener('contextmenu', onContextMenuForPaste, { capture: true })
    container.removeEventListener('pointerup', onPointerUpForCopy, { capture: true })
    selectionSub.dispose()
  }
}
