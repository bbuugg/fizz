"use client";

/**
 * 右侧**多标签面板**：与根应用（dogi `features/agent/SidePanel.tsx`）同一套结构与交互。
 *
 * 面板本身不认识任何具体内容：终端 / 工作区文件 / 源代码管理都只是挂上来的一个标签，
 * 以后再加别的视图（日志、预览…）不用改这个组件。它只负责：可拖宽度、展开 / 收起动画、
 * 标签条（切换 + 关闭）、以及把内容**常挂载**住。
 *
 * 四条硬约束（都是踩出来的，与根应用一致）：
 * 1. 标签内容一律**常挂载**，非活动的用 `hidden` 藏起来 —— 终端卸载等于 xterm 重建、
 *    输出全丢（PTY 还在服务端跑着）。
 * 2. 内容区**宽度固定、外层只裁剪**（外层宽 0 ↔ 目标宽 + `overflow-hidden`）：动画期间
 *    内容不重排，终端不会因为「宽度先归零再长回去」而疯狂 reflow。
 * 3. **拖动期间不加宽度过渡**：过渡追不上指针，右侧会露出一条空白。
 * 4. 宽度过渡只服务于「展开 / 收起」，**跟着容器尺寸**变化的那一次不做过渡（那是「跟着
 *    容器走」，有动画就像被挤了一下）。
 *
 * 两种形态由容器宽度决定：
 * - **挤压**（宽容器）：面板是内容区右侧的兄弟节点，展开时把内容区压窄（最小
 *   `MIN_CONTENT_WIDTH`）；
 * - **覆盖**（窄容器 / 手机）：内容区本来就没地方可让（比如流程里 380px 的节点面板），
 *   面板改为盖在内容之上 —— 所以**调用方必须把它放进一个 `relative` 的容器**里。
 *
 * 宽度**按 `scope` 各记一份**（`lib/panel-width.ts`）：主会话传会话 key，所以每个会话
 * 记住自己的面板宽度，开合状态（`panelSessions[sessionKey].sideTab`）与它同一作用域。
 *
 * `ConversationTab` 给**每个对话标签**各渲染一份本组件（标签自带自己的面板），于是
 * xterm / 文件树 / 未保存的编辑内容在标签之间互不影响、切走也不丢。`parked` 保留给
 * 「同一个面板实例需要临时隐藏」的场景（当前主区域的多标签不再用它 —— 每个标签的面板
 * 本来就各归各的）。详见下面 `parked` 的注释。
 *
 * 展开时的宽度：**这个 scope 还没被拖过时默认占容器的一半**（与左侧内容区各 50%）——
 * 用户一旦拖过就交回他，之后收起再展开、换会话回来都尊重他拖出来的宽度。默认宽度是
 * **按容器实时算**的，窗口变大面板跟着长。默认值**不另存**，而是从「有没有记过宽度」
 * 推出来（`userWidth === null`），所以它天生跟 scope 走 —— 换会话不会把上一个会话的状态
 * 带过来（那正是「切会话面板先撑满再弹回」的成因）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'
import { ResizeHandle } from '@fizz/agent-kit/shared/components/ResizeHandle'
import { PanelTab } from '@fizz/agent-kit/shared/components/PanelTab'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { setPanelWidth, usePanelWidth } from '@fizz/agent-kit/shared/lib/panel-width'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export interface SidePanelTab {
  /** 唯一 key，同时作为「活动标签」的标识 */
  key: string
  /** 标签条上的短名 */
  label: string
  /** 悬停提示：放更完整的描述（如 `终端 · /path/to/ws`） */
  title: string
  icon: ReactNode
  /** 标签内容（常挂载；自己能撑满高度即可） */
  content: ReactNode
  /** 关闭该标签；不传则不显示关闭按钮 */
  onClose?: () => void
}

const PANEL_MIN_WIDTH = 380
/** 内容区最小宽度 —— 同时是面板拖拽的上限（「别把对话区挤没」） */
const MIN_CONTENT_WIDTH = 320
/** 容器窄于这个宽度就不挤压了，改为覆盖 */
const OVERLAY_THRESHOLD = 760

/**
 * 量出容器的可用宽度（面板要按它算默认宽度与拖拽上限）。
 *
 * 用**回调 ref** 而不是 `useRef` + effect：节点是「有条件渲染」的（工作台在目标没就绪时
 * 返回 null），ref 挂上 / 摘下都要重新接观察器，只在挂载时接一次会永远测不到宽度。
 * 量到的第一时间同步一次，避免首帧按兜底宽度画、下一帧才跳到真实宽度（面板会闪一下）。
 */
export function useContainerWidth(): [React.RefCallback<HTMLDivElement>, number] {
  const [width, setWidth] = useState(0)
  const observerRef = useRef<ResizeObserver | null>(null)

  const ref = useCallback((el: HTMLDivElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el) return
    const sync = (): void => {
      const w = el.clientWidth
      if (w > 0) setWidth(w)
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    observerRef.current = ro
  }, [])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return [ref, width]
}

export function SidePanel({
  open,
  tabs,
  activeKey,
  onSelect,
  onCollapse,
  containerWidth,
  scope,
  parked = false,
  className
}: {
  /** 是否展开：收起只把宽度裁到 0，标签一个不关、内容全部保留 */
  open: boolean
  tabs: SidePanelTab[]
  /** 活动标签 key（展开时才有意义） */
  activeKey: string | null
  onSelect: (key: string) => void
  /** 收起面板（不关任何标签） */
  onCollapse: () => void
  /** 内容区实测宽度：算默认宽度与拖拽上限 */
  containerWidth: number
  /**
   * 宽度的作用域：主会话传**会话 key**（于是每个会话各记一份宽度）、容器工作台传固定串。
   * 必须与「开合状态」同一作用域，否则两边对不上（见文件头）。
   */
  scope: string
  /**
   * 「停放」：这个面板属于**别的**会话，当前看不见，但**必须保持挂载**。
   *
   * 为什么要它：终端的 xterm 实例、文件树的展开状态、编辑器里**未保存**的内容都只存在于
   * 组件内存里 —— 一旦卸载就真没了（TerminalPanel 的 cleanup 还会 `kill()` 掉那条 PTY）。
   * 所以切会话不能卸载面板，只能把它 `hidden` 掉（与本组件内部对标签的处理同一手法）。
   *
   * 代价只是隐藏期间不参与布局：xterm 在 `display:none` 下尺寸为 0，回到可见时由它内部的
   * ResizeObserver 重新 fit 并回写 PTY 尺寸（见 TerminalPanel）。
   *
   * 停放期间不渲染拖拽条、不吃指针事件（`pointer-events-none`）——
   * 免得一条看不见的抓手混在可见面板旁边，也能防止误点击穿透到看不见的面板上。
   */
  parked?: boolean
  className?: string
}) {
  const isMobile = useIsMobile()
  /**
   * 用户为**这个 scope** 拖过的宽度；`null` = 没拖过（展开时按容器一半给）。
   *
   * 默认宽度刻意**不另存 state**（旧实现拿 `useState` + 「open 由 false 变 true 就
   * 撑满」的 effect）：scope 一换，「上轮是不是展开着」与「这是不是一次新的展开」就分不
   * 出来了 —— 切到面板开着的会话会被当成「用户刚展开」而重放一遍，面板于是「先撑
   * 满、再弹回用户拖过的宽度」。宽度既然按 scope 存了，默认还是用户值直接由它推出来，
   * 天然不串。
   */
  const userWidth = usePanelWidth(scope)
  /** 正在拖动：拖动期间关掉宽度过渡（见文件头约束 3） */
  const [dragging, setDragging] = useState(false)

  /**
   * 上一次渲染的容器宽度。ref **只在 effect 里推进**（渲染期不写 ref）：于是「本次提交
   * 容器宽度变了吗」在 StrictMode 的双渲染下答案一致（见文件头约束 4）。
   */
  const prevContainerRef = useRef(containerWidth)
  const containerChanged = prevContainerRef.current !== containerWidth
  useEffect(() => {
    prevContainerRef.current = containerWidth
  }, [containerWidth])

  const effectiveContainer = containerWidth > 0 ? containerWidth : 1200
  const overlay = isMobile || containerWidth < OVERLAY_THRESHOLD
  const maxWidth = Math.max(PANEL_MIN_WIDTH, effectiveContainer - MIN_CONTENT_WIDTH)
  /**
   * 挤压形态下的宽度。
   *
   * 没拖过（`userWidth === null`）→ **默认占容器的一半**（与左侧会话区各 50%），按容器
   * 实时算：窗口变大面板跟着长，不会卡在打开那一刻算出的旧值。
   * 拖过 → 夹到 [最小宽度, 上限] 之间：容器变窄时上限会跟着降。
   */
  const defaultWidth = Math.round(effectiveContainer / 2)
  const flowWidth =
    userWidth === null
      ? Math.round(Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, defaultWidth)))
      : Math.round(Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, userWidth)))
  /**
   * 覆盖形态：直接铺满容器宽度。
   *
   * 之前这里还套了一层 OVERLAY_MAX_WIDTH（520px）：中等屏幕（520~760px）下面板只到 520，
   * 右侧留一条空，看起来像「浮在一边没占满」。覆盖形态的语义就是盖住内容区，
   * 容器多大就铺多大（再宽就走挤压形态了，不会进这里）。
   */
  const overlayWidth = Math.round(containerWidth > 0 ? containerWidth : PANEL_MIN_WIDTH)
  const width = overlay ? overlayWidth : flowWidth

  /** 用户拖宽度 = 记到这个 scope 上（也就等于退出撑满：记过宽度就不撑满了） */
  const handleResize = (next: number): void => {
    setPanelWidth(scope, next)
  }

  /** 标签条（横向滚动容器）与每个标签元素的 ref：用来把激活的标签滚进视口 */
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const tabElRefs = useRef(new Map<string, HTMLDivElement>())

  /**
   * 激活的标签若被横向滚出视口，把它滚回可见。
   *
   * 最典型的触发：标签开了一长排，从左侧会话栏 / 对话里的入口点回一个**早就开着、但标签
   * 没露出来**的标签 —— 只有标签条自己滚过去，界面才不会看起来像「点了没反应」。
   *
   * 手法与 `FilesPanel` 同一份：只改标签条自己的 `scrollLeft`，**不用 `scrollIntoView`**
   * （它会把外层纵向滚动容器一起带走 —— 这里外面还套着可拖宽的 `ResizablePanel`）。
   *
   * `open` / `parked` 也在依赖里：面板收起（宽度裁到 0）或停放（`display:none`）期间挂出
   * 一个标签，等它重新可见后同样要滚进来 —— 那两种状态下量到的宽度都是 0，滚了也没意义。
   */
  useEffect(() => {
    if (!activeKey) return
    const strip = tabStripRef.current
    const el = tabElRefs.current.get(activeKey)
    if (!strip || !el || strip.clientWidth === 0) return
    const stripRect = strip.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    if (elRect.left < stripRect.left) {
      strip.scrollTo({ left: strip.scrollLeft + (elRect.left - stripRect.left), behavior: 'smooth' })
    } else if (elRect.right > stripRect.right) {
      strip.scrollTo({ left: strip.scrollLeft + (elRect.right - stripRect.right), behavior: 'smooth' })
    }
  }, [activeKey, open, parked])

  return (
    // 停放中的面板整体 `hidden`（display:none）：不占位、不渲染，但组件不卸载
    <div hidden={parked} className={cn('flex min-h-0 shrink-0', parked && 'pointer-events-none')}>
      {/* 拖拽条在面板**左侧**：往左拖才是把它拉宽。收起时不渲染，免得留一条无用的抓手。
          覆盖形态不给拖拽条 —— 那时宽度跟着容器走（见文件头）。停放中的面板同样不给。 */}
      {open && !overlay && !parked && (
        <ResizeHandle
          invert
          width={width}
          min={PANEL_MIN_WIDTH}
          max={maxWidth}
          onResize={handleResize}
          onDragStart={() => setDragging(true)}
          onDragEnd={() => setDragging(false)}
        />
      )}
      <div
        aria-hidden={!open}
        className={cn(
          'shrink-0 overflow-hidden',
          !dragging && !containerChanged && 'transition-[width] duration-200 ease-out',
          !open && 'pointer-events-none',
          /*
           * 拖拽中整块面板**不吃指针事件**。
           *
           * 面板里可能有预览的 `<iframe>` / `<webview>`（`PreviewPane`）：光标往右一进到
           * guest 里，window 上的 `pointermove` 就全被它吞掉 —— 拖拽条不再收事件，宽度卡在
           * 原地，等指针离开 guest 又猛跳一大段，看起来就是「不跟手」。跨源文档上
           * `setPointerCapture` 在部分 Chromium 版本里对这种 guest 也无效，只能靠这一层挡
           * （用户报过「预览里的页面一打开，侧栏拖宽度就不跟手」）。
           *
           * 拖拽窗口很短，期间面板内的按钮 / 页面不响应指针是可以接受的代价。
           */
          dragging && 'pointer-events-none',
          overlay ? 'absolute inset-y-0 right-0 z-30' : 'relative',
          className
        )}
        style={{ width: open ? width : 0 }}
      >
        {/* 内容区固定宽度：外层只裁剪、不动里面的排版（见文件头约束 2）。
            覆盖形态下它铺满整个容器，左边框会变成一条贴在屏幕边缘的多余竖线 —— 那时不给。 */}
        <div
          style={{ width }}
          className={cn(
            'flex h-full flex-col bg-surface-1 shadow-2xl',
            !overlay && 'border-l border-border/70'
          )}
        >
          {/* 标签条：左边各标签（图标 + 短名 + 悬停出现的关闭），右边收起面板 */}
          <div className="flex h-9 shrink-0 items-center gap-1 px-2">
            {/*
              标签多了要**横向滚动**，不能把它们一起压窄：标签本身 `shrink-0`，滚动交给
              这一层（与主区域 `PanelView` 的标签条同一口径）。右侧收起按钮在滚动区之外，
              始终固定在行尾。
            */}
            <div
              ref={tabStripRef}
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar"
            >
              {tabs.map((tab) => (
                <PanelTab
                  key={tab.key}
                  ref={(el: HTMLDivElement | null) => {
                    if (el) tabElRefs.current.set(tab.key, el)
                    else tabElRefs.current.delete(tab.key)
                  }}
                  active={tab.key === activeKey}
                  label={tab.label}
                  title={tab.title}
                  icon={tab.icon}
                  onActivate={() => onSelect(tab.key)}
                  onClose={tab.onClose}
                  className="max-w-52 min-w-28 shrink-0"
                />
              ))}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="收起面板"
                  title="收起面板"
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                  onClick={onCollapse}
                >
                  <X className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">收起面板</TooltipContent>
            </Tooltip>
          </div>
          {/* 内容区：所有标签都挂在这里，非活动的藏起来但**不卸载**（见文件头约束 1） */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {tabs.map((tab) => (
              <div key={tab.key} className={cn('h-full', tab.key !== activeKey && 'hidden')}>
                {tab.content}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
