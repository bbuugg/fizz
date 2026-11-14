"use client";

/**
 * 会话内查找（Ctrl/Cmd+F）：在当前会话面板的**消息区**里找文本，Enter / Shift+Enter 上下跳，
 * Esc 关闭。命中项用 CSS Custom Highlight API 上色（见 `chat-find.css`），不动 DOM。
 *
 * ## 为什么自己不挂进全局快捷键表（`shared/lib/shortcuts.ts`）
 *
 * 那张表是「应用级」动作（命令面板 / 主题 / 新建会话…），由各端外壳 `app-shell.tsx` 的
 * window 捕获监听统一分发；而查找是**面板级**且要往具体面板里塞状态（每个会话面板各有一份
 * 查找条与命中集合）。照 `PANEL_SCOPED_SHORTCUT_ACTIONS` 的老路走，得让 PanelView 广播一个
 * 事件、各面板自己抢，还要在三个外壳里各改一处 —— 为了一个「Ctrl+F」不值得。
 * 这里由组件自己挂 window 捕获监听：**谁在鼠标下 / 谁里面有焦点，就在谁里面开**。
 *
 * ⚠️ 判定时**必须**放过编辑器与终端：Monaco 的 Ctrl+F 是它自己的查找浮层、xterm 里同理。
 * 不放过的话捕获阶段会先把按键吃掉，表现为「在文件里按 Ctrl+F 什么都不弹」。
 *
 * ## 搜索范围
 *
 * 直接扫滚动容器（`[data-message-scroll]`）里的文本节点，所以用户消息、助手正文、
 * 代码块、工具卡内容、思考内容都能搜到；按钮里的文字（「复制」「展开」）跳过 ——
 * 那是控件标签，不是会话内容。找不到时也不额外渲染，避免把 UI 噪声当结果。
 *
 * ## 为什么每次重算都要重建 Range
 *
 * Range 挂在文本节点上，消息一旦重渲染（流式每帧都会）旧 Range 就指向被丢弃的节点，
 * `getBoundingClientRect()` 返回全 0、高亮也自动失效。所以匹配集合只在 `useEffect` 里
 * 按当前 DOM 现算，并用 `RECOLLECT_MIN_MS` 节流 —— 流式期间最多每 250ms 扫一次。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import '@fizz/agent-kit/features/chat/chat-find.css'

/** 重算匹配的最小间隔（ms）：流式期间靠它把「每帧重扫」压成「每 250ms 扫一次」 */
const RECOLLECT_MIN_MS = 250
/**
 * 单次最多收集的命中数。上限存在的意义是兜底（搜「的」能出几千个），
 * 不是性能优化 —— 走查文本节点本身是 O(文本长度)，很快。
 */
const MAX_MATCHES = 500

/** highlight 名，与 `chat-find.css` 里的两条 `::highlight()` 逐字一致 */
const HL_ALL = 'fizz-find'
const HL_ACTIVE = 'fizz-find-active'

/**
 * 同一时刻只允许**一个**面板往 `CSS.highlights` 里写。
 *
 * 名字是全局的（CSS 里没法注册动态名），桌面端又能同时挂多个会话面板；某个面板关掉查找时
 * 若无条件 `delete`，会把另一个面板的高亮一起清没。所以「最近一次打开查找的面板」持有所有权。
 */
let highlightOwner: symbol | null = null

/**
 * 最近一次和用户打过交道的面板（鼠标进去过 / 里面有过焦点）。
 *
 * 用途只有一个：命令落点。焦点悬空（刚点完侧栏）且鼠标也没停在会话上时，Ctrl+F 交给
 * 「上一次用的那个会话面板」—— 否则分屏下会谁都不响应。**不是**高亮所有权。
 */
let lastTouched: symbol | null = null

/** CSS Custom Highlight API 的最小面（浏览器不支持时整块返回 null） */
function highlightApi(): {
  registry: { set: (name: string, value: unknown) => void; delete: (name: string) => void }
  Highlight: new (...ranges: Range[]) => unknown
} | null {
  const registry = (CSS as unknown as {
    highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void }
  }).highlights
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight
  if (!registry || !Highlight) return null
  return { registry, Highlight }
}

/** 把 Range 滚到滚动容器正中（`.scroll-mt-6` 那套是给「滚到顶部」用的，这里要居中） */
function revealRange(range: Range, panel: HTMLElement | null): void {
  const scroll = panel?.querySelector('[data-message-scroll]')
  if (!(scroll instanceof HTMLElement)) return
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    // 命中在折叠块里 / 刚被重渲染掉：退回「把宿主元素滚进视口」的粗略定位
    range.startContainer.parentElement?.scrollIntoView({ block: 'center' })
    return
  }
  const box = scroll.getBoundingClientRect()
  const top = scroll.scrollTop + (rect.top - box.top) - (scroll.clientHeight - rect.height) / 2
  scroll.scrollTop = Math.max(0, top)
}

export interface ChatFindProps {
  /** 会话面板根节点（`MessageList` 的那个 `relative` 容器）：定位查找条、限定生效范围 */
  panelRef: React.RefObject<HTMLDivElement | null>
  /** 消息列表：变化即视为「内容可能变了」，触发重算（内部已节流） */
  messages: AgentChatMessage[]
  /**
   * 开始搜索时回调：消息区默认只渲染最近一批（长会话），而查找扫的是**当前 DOM** ——
   * 不先把更早的展开，搜索会漏掉它们。由 `MessageList` 负责展开全部。
   */
  onSearchActive?: () => void
}

export function ChatFind({ panelRef, messages, onSearchActive }: ChatFindProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  /** 当前命中下标（0 基；-1 = 没有命中） */
  const [active, setActiveState] = useState(-1)
  /** 每次重算 +1：让绘制 effect 跟着重跑（Range 存在 ref 里，不进 state） */
  const [revision, setRevision] = useState(0)
  /** 每次「用户要求跳转」+1：即使 active 没变（只有一条命中）也要重新滚一次 */
  const [revealSeq, setRevealSeq] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])
  /** 本实例的 highlight 所有权凭据 */
  const idRef = useRef(Symbol('chat-find'))
  const openRef = useRef(false)
  const activeRef = useRef(-1)
  /** 指针是否在本面板上（没焦点时的「这是哪个面板」判据） */
  const hoverRef = useRef(false)
  /** 下一次绘制时是否要把当前命中滚进视口 */
  const wantRevealRef = useRef(false)
  const lastCollectAtRef = useRef(0)
  const lastQueryRef = useRef('')

  const setActive = useCallback((next: number): void => {
    activeRef.current = next
    setActiveState(next)
  }, [])

  useEffect(() => {
    openRef.current = open
  }, [open])

  /**
   * 判定「这一下 Ctrl+F 归不归本面板」的作用域。
   *
   * ⚠️ 不能用 `panelRef.current` 本身：它所在的根节点只包消息区，而用户敲 Ctrl+F 时焦点
   * 多半在**下方输入框**里（`ChatComposer` 是 `MessageList` 的兄弟）。往上取一层正是
   * `ChatSurface` 的根容器（消息区 + 输入框），这才是「一个会话面板」的边界。
   */
  const scopeOf = useCallback(
    (): HTMLElement | null => panelRef.current?.parentElement ?? panelRef.current,
    [panelRef]
  )

  // 悬停 / 焦点跟踪：Ctrl+F 常常是「鼠标在会话里、焦点却不在」的场景（比如刚点完侧栏）
  useEffect(() => {
    const scope = scopeOf()
    if (!scope) return
    const enter = (): void => {
      hoverRef.current = true
      lastTouched = idRef.current
    }
    const leave = (): void => {
      hoverRef.current = false
    }
    const focusIn = (): void => {
      lastTouched = idRef.current
    }
    scope.addEventListener('pointerenter', enter)
    scope.addEventListener('pointerleave', leave)
    scope.addEventListener('focusin', focusIn)
    return () => {
      scope.removeEventListener('pointerenter', enter)
      scope.removeEventListener('pointerleave', leave)
      scope.removeEventListener('focusin', focusIn)
    }
  }, [scopeOf])

  /**
   * 收集当前 DOM 里所有命中（按文档顺序，一条 Range 一个命中）。
   *
   * ⚠️ 只在**单个文本节点内**匹配：markdown 会把 `**粗**体` 这类切成多个文本节点，
   * 跨节点的词组（「粗体」两个字分属两个节点）搜不到。要跨节点就得先把整段拼成一条
   * 字符串、再映射回节点，每次重扫都多一层映射 —— 「搜会话内容」用不上，接受这个限制。
   */
  const collect = useCallback((): Range[] => {
    const scroll = panelRef.current?.querySelector('[data-message-scroll]')
    const needle = query.trim().toLowerCase()
    if (!scroll || needle.length === 0) return []
    const walker = document.createTreeWalker(scroll, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node): number {
        if (!node.nodeValue || node.nodeValue.trim() === '') return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        // 控件标签 / 显式标注跳过的区域不算「会话内容」
        if (!parent || parent.closest('button, [data-find-skip]')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    const ranges: Range[] = []
    let node = walker.nextNode()
    while (node && ranges.length < MAX_MATCHES) {
      const text = (node.nodeValue ?? '').toLowerCase()
      let from = text.indexOf(needle)
      while (from !== -1 && ranges.length < MAX_MATCHES) {
        const range = document.createRange()
        range.setStart(node, from)
        range.setEnd(node, from + needle.length)
        ranges.push(range)
        from = text.indexOf(needle, from + needle.length)
      }
      node = walker.nextNode()
    }
    return ranges
  }, [panelRef, query])

  const openFind = useCallback((): void => {
    highlightOwner = idRef.current
    wantRevealRef.current = true
    setOpen(true)
    // 条要等这一帧渲染出来才存在
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  const closeFind = useCallback((): void => {
    setOpen(false)
    // 只清自己的：另一个面板可能在用同一批 highlight 名（见 highlightOwner）
    if (highlightOwner === idRef.current) {
      highlightOwner = null
      const api = highlightApi()
      api?.registry.delete(HL_ALL)
      api?.registry.delete(HL_ACTIVE)
    }
  }, [])

  /** 上下跳（`delta` = ±1，越界环绕） */
  const goto = useCallback(
    (delta: number): void => {
      const total = rangesRef.current.length
      if (total === 0) return
      const current = activeRef.current
      const next =
        current < 0 || current >= total ? (delta > 0 ? 0 : total - 1) : (current + delta + total) % total
      setActive(next)
      wantRevealRef.current = true
      setRevealSeq((seq) => seq + 1)
    },
    [setActive]
  )

  // Ctrl/Cmd+F 开查找、Esc 关查找（捕获阶段：优先于输入框 / 终端自己的按键处理）
  useEffect(() => {
    /** 焦点落在本面板里？（编辑器 / 终端除外：它们自己的按键有语义） */
    const focusInside = (): boolean => {
      const focus = document.activeElement as HTMLElement | null
      if (!focus || focus === document.body) return false
      if (focus.closest('.monaco-editor, .xterm')) return false
      return !!scopeOf()?.contains(focus)
    }
    /**
     * 焦点「悬空」（body / 无）：用户刚点过侧栏、或刚关掉某个弹窗。
     * 分屏时多个面板都会满足它，所以不能直接当成本面板命中 —— 还得叠加鼠标位置。
     */
    const focusIsLoose = (): boolean => {
      const focus = document.activeElement as HTMLElement | null
      return !focus || focus === document.body
    }
    /** 这一下 Ctrl+F 该归本面板吗 */
    const isPanelTarget = (): boolean =>
      focusInside() || (focusIsLoose() && (hoverRef.current || lastTouched === idRef.current))
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && !event.altKey && !event.shiftKey && event.code === 'KeyF') {
        if (!isPanelTarget()) return
        event.preventDefault()
        event.stopPropagation()
        openFind()
        return
      }
      if (event.key === 'Escape' && openRef.current && isPanelTarget()) {
        /*
         * 只在「焦点还在本面板里」时才吃掉 Esc。
         *
         * 无脑拦 Esc 的后果很具体：查找条开着的同时用户用鼠标点开一个对话框（会话重命名 /
         * 工作区设置…），那一下 Esc 本该关对话框 —— 被这里先吃掉就成了「按 Esc 对话框不动、
         * 查找条反而关了」。
         *
         * 被吃掉的这一下也不能再落到输入框（「流式中按 Esc 停止本轮」）或终端上。
         */
        event.preventDefault()
        event.stopPropagation()
        closeFind()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [scopeOf, openFind, closeFind])

  // 卸载时别把高亮留在页面上
  useEffect(() => {
    const id = idRef.current
    return () => {
      if (highlightOwner !== id) return
      highlightOwner = null
      const api = highlightApi()
      api?.registry.delete(HL_ALL)
      api?.registry.delete(HL_ACTIVE)
    }
  }, [])

  // 重算匹配：query 变、消息变（流式会高频变）都要重扫，按 RECOLLECT_MIN_MS 节流
  useEffect(() => {
    if (!open) return
    const elapsed = Date.now() - lastCollectAtRef.current
    const delay = elapsed >= RECOLLECT_MIN_MS ? 0 : RECOLLECT_MIN_MS - elapsed
    const timer = window.setTimeout(() => {
      lastCollectAtRef.current = Date.now()
      const ranges = collect()
      rangesRef.current = ranges
      setCount(ranges.length)
      const needle = query.trim()
      const queryChanged = lastQueryRef.current !== needle
      lastQueryRef.current = needle
      const current = activeRef.current
      const next = ranges.length === 0 ? -1 : queryChanged || current < 0 ? 0 : Math.min(current, ranges.length - 1)
      setActive(next)
      setRevision((value) => value + 1)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [open, query, messages, collect, setActive])

  // 绘制高亮 + 需要时把当前命中滚进视口
  useEffect(() => {
    if (!open) return
    const ranges = rangesRef.current
    const index = activeRef.current
    const api = highlightApi()
    if (api && highlightOwner === idRef.current) {
      api.registry.set(HL_ALL, new api.Highlight(...ranges))
      api.registry.set(HL_ACTIVE, index >= 0 && ranges[index] ? new api.Highlight(ranges[index]) : new api.Highlight())
    } else if (!api) {
      // 老内核没有 Highlight API：至少把当前命中选进原生选区（`::selection` 会上色）
      const range = index >= 0 ? ranges[index] : undefined
      if (range) {
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    }
    if (wantRevealRef.current && index >= 0 && ranges[index]) {
      wantRevealRef.current = false
      revealRange(ranges[index], panelRef.current)
    }
  }, [open, active, revision, revealSeq, panelRef])

  if (!open) return null

  const needle = query.trim()
  return (
    <div
      role="search"
      className="absolute top-2 right-2 z-30 flex max-w-[calc(100%_-_1rem)] items-center gap-0.5 rounded-lg border border-border/70 bg-popover/95 py-1 pr-1 pl-1.5 text-popover-foreground shadow-md backdrop-blur-sm animate-in fade-in slide-in-from-top-1 duration-150"
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          const value = event.target.value
          if (value.trim()) onSearchActive?.()
          setQuery(value)
        }}
        onKeyDown={(event) => {
          // Esc 由 window 捕获那层统一处理（它先于这里拿到事件），这里只管上下跳
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          goto(event.shiftKey ? -1 : 1)
        }}
        placeholder="在会话中查找"
        aria-label="在会话中查找"
        spellCheck={false}
        autoComplete="off"
        className="h-6 w-40 max-w-[38vw] min-w-0 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
      />
      <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums">
        {needle === '' ? '' : count === 0 ? '无结果' : `${active + 1}/${count}`}
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label="上一个匹配"
        disabled={count === 0}
        onClick={() => goto(-1)}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label="下一个匹配"
        disabled={count === 0}
        onClick={() => goto(1)}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label="关闭查找"
        onClick={closeFind}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
