"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { ChevronLeft, ChevronRight, Rows2, X } from 'lucide-react';
import { Button } from '@fizz/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { RowActionButton } from '@fizz/agent-kit/shared/components/RowAction'
import { registerPanelBody } from '../panel-bodies'
import {
  groupZoneOf,
  PANEL_TAB_TYPE,
  useDndRef,
  type GroupDropZone,
  type PanelTabDragItem,
} from '@fizz/agent-kit/shared/lib/dnd-context'
import { collectGroupIds } from '@fizz/agent-kit/shared/lib/pane-layout'
import {
  activateTab,
  moveGroup,
  moveTab,
  splitTab,
  usePanelState,
} from '@fizz/agent-kit/shared/lib/panel-store'
import { STRIP_H, useTabMeta } from './tab-meta'
import { PanelTabItem } from './PanelTabItem'
import { useGroupActions } from './group-actions'

export function PanelGroupView({ groupId }: { groupId: string }) {
  const state = usePanelState()
  const meta = useTabMeta()
  const { focusGroup, activateAndSync, closeAndSync, closeGroupAndSync, renameTab, reloadTab } =
    useGroupActions()
  const group = state.groups[groupId]
  const isActiveGroup = state.activeGroupId === groupId

  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** 标签条的横向滚动容器（活动标签要能被滚进来，见下面的 effect） */
  const tabsRef = useRef<HTMLDivElement | null>(null)
  /**
   * 标签条的溢出状态：`overflow` = 内容比可视区宽（出现横向滚动），
   * `left` / `right` = 该方向还能不能继续滚。
   *
   * 只有溢出了才渲染左右两颗箭头；到头的方向置灰（而不是让箭头消失）——
   * 箭头本身占宽度，一出现一消失会让标签条跟着跳一下。
   */
  const [scrollEdges, setScrollEdges] = useState({ overflow: false, left: false, right: false })
  const [groupZone, setGroupZone] = useState<GroupDropZone | null>(null)

  const tabIds = group?.tabIds ?? []
  const activeKey = group?.activeTabId ?? null
  /**
   * 是否**多个分组**（数布局树的叶子）。
   * 只有多组时「关闭整组」才算一个真动作；单组时关掉它等于把面板关空、只留一个空组占位，
   * 与逐个关标签没区别 —— 所以标签条行尾那颗 × 与右键里的「关闭整个组」都按它决定显不显示。
   */
  const canCloseGroup = collectGroupIds(state.layout).length > 1

  /**
   * 活动标签一变就把它滚进标签条的可视区。
   *
   * 标签条是 `overflow-x-auto`（标签多了要横向滚），于是点侧栏某个会话时，它的标签很可能
   * 正好落在可视区之外 —— 界面看起来像「点了没反应」。这里在活动标签落定后把对应那颗滚进来；
   * `inline: 'nearest'` 保证已经在可视区里的标签不会被无谓地挪动一下。
   *
   * 依赖里带 `overflow`：左右滚动键出现时标签条可视宽度会缩一截，需要再对齐一次，
   * 否则刚滚到右边缘的活动标签会被新出现的箭头挡住小半。
   */
  useEffect(() => {
    const container = tabsRef.current
    if (!container || !activeKey) return
    const el = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-key]')).find(
      (node) => node.dataset.tabKey === activeKey
    )
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [activeKey, scrollEdges.overflow])

  /** 重新量一次标签条的溢出 / 两端可达性（滚动、容器尺寸变化、标签增删后都要量） */
  const syncScrollEdges = useCallback((): void => {
    const el = tabsRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    const next = {
      overflow: max > 1,
      left: el.scrollLeft > 1,
      right: el.scrollLeft < max - 1
    }
    setScrollEdges((prev) =>
      prev.overflow === next.overflow && prev.left === next.left && prev.right === next.right
        ? prev
        : next
    )
  }, [])

  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    // 容器宽度变化（窗口 / 分屏拖拽）：ResizeObserver。内容宽度变化不走它 ——
    // 容器尺寸没变时它不触发，靠下面那个按标签数 / 活动标签重量的 effect 补。
    const observer = new ResizeObserver(syncScrollEdges)
    observer.observe(el)
    el.addEventListener('scroll', syncScrollEdges, { passive: true })
    syncScrollEdges()
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', syncScrollEdges)
    }
  }, [syncScrollEdges])

  useEffect(() => {
    syncScrollEdges()
  }, [syncScrollEdges, tabIds.length, activeKey])

  /** 点箭头：按可视区八成宽度滚一屏（滚到底时浏览器自会截断） */
  const scrollTabs = (direction: -1 | 1): void => {
    const el = tabsRef.current
    if (!el) return
    el.scrollBy({ left: direction * Math.max(160, el.clientWidth * 0.8), behavior: 'smooth' })
  }

  /**
   * 组车身落区：四边 = 分屏方向，中间 = 并入本组。
   * 指针在组矩形里的相对位置决定一切（见 `groupZoneOf`）。
   *
   * ⚠️ 与上面 `PanelTabItem` 同理，必须用「工厂函数 + deps」形式（原因见那里的长注释）。
   */
  const [{ isOver }, bodyDropRef] = useDrop<PanelTabDragItem, void, { isOver: boolean }>(
    () => ({
      accept: PANEL_TAB_TYPE,
      drop: (item, monitor) => {
        // 落在标签 / 标签条上时已由更内层的目标处理，避免重复
        if (monitor.didDrop()) return
        const rect = bodyRef.current?.getBoundingClientRect()
        const offset = monitor.getClientOffset()
        setGroupZone(null)
        if (!rect || !offset) return
        const zone = groupZoneOf(rect, offset.x, offset.y)
        if (item.groupId) {
          // 拖的是**整组**：center = 并入本组，四边 = 整组搬到那一侧
          moveGroup(item.groupId, groupId, zone)
          return
        }
        if (zone === 'center') {
          moveTab(item.key, groupId)
          activateTab(item.key)
          return
        }
        splitTab(item.key, groupId, zone)
      },
      hover: (item, monitor) => {
        // 拖自己所在的组（整组搬家）没有意义，不提示
        if (item.groupId === groupId) {
          setGroupZone(null)
          return
        }
        const rect = bodyRef.current?.getBoundingClientRect()
        const offset = monitor.getClientOffset()
        if (!rect || !offset) return
        setGroupZone(groupZoneOf(rect, offset.x, offset.y))
      },
      collect: (monitor) => ({ isOver: monitor.isOver() })
    }),
    [groupId]
  )

  useEffect(() => {
    if (!isOver) setGroupZone(null)
  }, [isOver])

  /**
   * 标签条拖起**整组**（落点见内容区 drop 的 `item.groupId` 分支）。
   *
   * 以前这是一根显式的抓手（标签条最左那条竖杠）。现在抓手去掉，改成**标签条空白区**即
   * 拖拽源：把拖拽源挂在标签条自身的容器上，而每颗标签自己也是拖拽源 —— 原生 HTML5
   * 拖拽取的是**离指针最近的那个可拖祖先**，于是「按在标签上 = 拖那颗标签、按在标签之间
   * 的空白处 = 拖整组」，同一个容器就分出了两种语义，不需要额外判定指针落在哪。
   */
  const [, groupDragRef] = useDrag<PanelTabDragItem, void>(
    () => ({
      type: PANEL_TAB_TYPE,
      item: { key: tabIds[0] ?? '', fromGroupId: groupId, groupId },
      canDrag: tabIds.length > 0
    }),
    [groupId, tabIds[0], tabIds.length]
  )

  // ⚠️ 必须 memo（见 `useDndRef` 的注释）：裸箭头函数每次渲染都是新 ref → 无限更新循环
  const tabsSetRef = useDndRef<HTMLDivElement>(groupDragRef, (node) => {
    tabsRef.current = node
  })
  /*
   * 车身元素一次干两件事：给落区判定当量尺（`bodyRef`），以及登记给内容层摆位用
   * （`registerPanelBody`）。React 卸载时会以 `null` 调这个回调，正好把登记注销掉。
   */
  const bodySetRef = useDndRef<HTMLDivElement>(bodyDropRef, (node) => {
    bodyRef.current = node
    registerPanelBody(groupId, node)
  })

  return (
    <div
      // 焦点组底色更实：一眼看出「拖拽会落到哪一组」
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
        isActiveGroup ? 'bg-background' : 'bg-background/60'
      )}
      // 点标签条 / 空态 / 落区浮层 → 把这组设为焦点。⚠️ 标签**内容**不在这棵子树里
      // （见 `PanelContentLayer`），它的事件按 React 树冒泡、不经过这里，那边另挂了一份。
      onPointerDownCapture={() => focusGroup(groupId)}
    >
      {/*
        标签条：左右滚动键（溢出时才有）+ 各标签 + 「全部标签」溢出菜单 + 关闭整组。
        ⚠️ `relative z-10` 是必需的：标签内容层是 PanelView 根部的 `absolute z-0`，
        按绘制顺序它会盖住所有**普通流内**的内容（见 `PanelContentLayer` 的注释）。

        这里**没有**「新建对话」：标签不在这条标签条上创建（空态里那颗按钮才是入口），
        把 + 摆在这儿只会让人以为「新标签从这里长出来」。行尾留给「关闭整组」——
        与参考实现（dogi）一致：分组之后的整组退出入口在标签条上，而不是只藏在右键菜单里。
      */}
      <div className={cn('relative z-10 flex shrink-0 items-center gap-1 px-1', STRIP_H)}>
        {/*
          左右滚动键：标签多到标签条溢出时才出现（到头的方向置灰，见 `scrollEdges`）。
          放在**滚动容器外面**：它们自己不该跟着滚走，也不吃「整组拖拽源」的拖拽。
        */}
        {scrollEdges.overflow && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label="向左滚动标签"
            title="向左滚动标签"
            disabled={!scrollEdges.left}
            onClick={() => scrollTabs(-1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
        )}
        {/*
          标签容器同时是**整组拖拽源**：按在标签上拖 = 拖那颗标签，按在标签之间的空白处拖 =
          拖整组（原生拖拽取离指针最近的可拖祖先，见上面 useDrag 的注释）。原先的显式抓手
          因此去掉 —— 少一件常驻装饰，拖拽入口反而更大（整条空白区）。
        */}
        <div ref={tabsSetRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
          {tabIds.map((key, index) => (
            <PanelTabItem
              key={key}
              tabKey={key}
              groupId={groupId}
              groupTabIds={tabIds}
              index={index}
              active={key === activeKey}
              meta={meta(key)}
              canCloseGroup={canCloseGroup}
              onActivate={activateAndSync}
              onClose={closeAndSync}
              onCloseGroup={closeGroupAndSync}
              onRename={renameTab}
              onReload={reloadTab}
            />
          ))}
        </div>
        {scrollEdges.overflow && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label="向右滚动标签"
            title="向右滚动标签"
            disabled={!scrollEdges.right}
            onClick={() => scrollTabs(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        )}
        {tabIds.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 text-muted-foreground"
                aria-label="全部标签"
                title="全部标签"
              >
                <Rows2 className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-xs text-muted-foreground">本组标签</DropdownMenuLabel>
              {tabIds.map((key) => (
                <DropdownMenuItem key={key} onSelect={() => activateAndSync(key)}>
                  <span className="truncate">{meta(key).label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/*
          关闭整组：把这组里的标签全关掉。
          ⚠️ **只有多个分组时才渲染**：单组时关掉整组只是把唯一的面板关空、留一个空组占位，
          与「逐个关标签」没有区别，摆一颗 × 反而让人以为关掉后面板会消失。多组时它是
          「退出这一格」的快捷入口（右键里的「关闭整个组」是同一个动作，也跟着这个条件走）。

          ⚠️ 关掉后**这一格不会消失**：`panel-groups` 的 `alignToTabs` 会保留一个空组占位
          （布局树不能是 `null`），组里那句「没有打开的标签」就是这个状态。把**最后一块**
          面板也关空时，`PanelView` 会补一张「新对话」草稿标签（会话同时退回空态）。
        */}
        {tabIds.length > 0 && canCloseGroup && (
          <RowActionButton
            className="flex size-6 shrink-0 items-center justify-center hover:text-destructive"
            aria-label="关闭整个组"
            title="关闭整个组"
            onClick={() => closeGroupAndSync(groupId)}
          >
            <X className="size-4" />
          </RowActionButton>
        )}
      </div>

      {/*
        车身：**只留一个洞**。标签内容不在这里渲染 —— 它由 `PanelContentLayer` 在
        `PanelView` 根部渲染一次，再按这个 div 的矩形摆过来（见 `panel-bodies.ts` 的文件头）。
        组里自己渲染内容的话，标签换组就会换 React 父节点、实例被卸载重挂，
        终端的 xterm 与 PTY 一起没。
        空态与落区浮层仍留在组里：它们不是「标签内容」，而且要压在内容之上。
      */}
      <div
        ref={bodySetRef}
        /*
         * `data-panel-body` 只为一件事存在：让验证脚本能**定位到某个组的车身**，
         * 从而真的把标签拖到它身上（`scripts/verify-panel-dnd.mjs`）。落区判定用的
         * `groupZoneOf` 读的就是这个 div 的矩形，脚本要打的也是同一个目标。
         */
        data-panel-body={groupId}
        className="relative min-h-0 flex-1"
      >
        {tabIds.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-sm text-muted-foreground">
            <span>没有打开的标签</span>
          </div>
        )}

        {/* 落区提示：四边分屏 = 半个高亮块；中间 = 整块描边（`z-20` 要压过内容层的 `z-0`） */}
        {groupZone && (
          <div className="pointer-events-none absolute inset-0 z-20">
            {groupZone === 'center' ? (
              <div className="absolute inset-0 rounded-lg ring-2 ring-primary ring-inset" />
            ) : (
              <div
                className={cn(
                  'absolute rounded-lg bg-primary/20 ring-2 ring-primary ring-inset',
                  groupZone === 'left' && 'inset-y-0 left-0 w-1/2',
                  groupZone === 'right' && 'inset-y-0 right-0 w-1/2',
                  groupZone === 'up' && 'inset-x-0 top-0 h-1/2',
                  groupZone === 'down' && 'inset-x-0 bottom-0 h-1/2'
                )}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 一个标签的内容
// ---------------------------------------------------------------------------
