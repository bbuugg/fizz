"use client";

import { useState } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useDragResize } from '@fizz/agent-kit/shared/components/ResizeHandle'
import { ResizeGrip } from '@fizz/agent-kit/shared/components/ResizeGrip'
import { type PaneSplit } from '@fizz/agent-kit/shared/lib/pane-layout'
import { resizeSplit } from '@fizz/agent-kit/shared/lib/panel-store'

/**
 * 拖动分隔条改权重。
 *
 * ⚠️ `sizes` 会被**直接当 `flex-grow` 用**，所以总和必须保持 1（`pane-layout.ts` 的
 * `normalizeSizes` 负责兜住）：flexbox 在「flex-grow 之和 < 1」时只分配
 * 「剩余空间 × 总和」，会空出一截、露出容器底色。这里的增量按当前总和换算，
 * 写回时再由 `resizeSplit` → `normalizeSizes` 归一到 1。
 *
 * 指针管线与其他分隔条同一份（`useDragResize`），单位是**权重**，所以先把 px 换算好：
 * 位移 `delta`（px）÷ `pxPerWeight` = 权重增量。两格的份额守恒（另一格永远是
 * `pairSum - weight`），下限对**两边**同时成立。
 */
export function Splitter({
  split,
  index,
  containerRef
}: {
  split: PaneSplit
  /** 边界位于 `children[index]` 与 `children[index + 1]` 之间 */
  index: number
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const horizontal = split.direction === 'row'
  const axis = horizontal ? 'x' : 'y'
  /** 拖动中（只用来让抓手保持不透明） */
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useDragResize<{
    /** 1 权重 = 多少 px */
    pxPerWeight: number
    startSizes: number[]
    /** 分隔线起点位置（px） */
    startPx: number
    /** 这一对的权重和（守恒） */
    pairSum: number
    /** 这一对的合法位置区间（px） */
    minPx: number
    maxPx: number
  }>({
    axis,
    onStart: () => {
      const container = containerRef.current
      if (!container) return null
      const rect = container.getBoundingClientRect()
      const total = horizontal ? rect.width : rect.height
      if (total <= 0) return null
      const startSizes = [...split.sizes]
      const totalWeight = startSizes.reduce((a, b) => a + b, 0)
      if (!(totalWeight > 0)) return null
      const startA = startSizes[index] ?? 1 / startSizes.length
      const startB = startSizes[index + 1] ?? 0
      const pairSum = startA + startB
      const pxPerWeight = total / totalWeight
      /**
       * 每一侧最少留 6% 权重 —— 别让用户把某一格拖到看不见（看不见就再也拖不回来）。
       *
       * 再按 `pairSum / 2` 兜一层：这一对的份额本来就不足 12% 时（三栏里两格都很窄），
       * 上下界会颠倒、拖起来像完全没反应。
       */
      const minWeight = Math.min(totalWeight * 0.06, pairSum / 2)
      setDragging(true)
      return {
        pxPerWeight,
        startSizes,
        startPx: startA * pxPerWeight,
        pairSum,
        minPx: minWeight * pxPerWeight,
        // 上限用「这一对的份额」减下限，而不是整层总和 —— 右侧那格也得留够 minWeight
        maxPx: (pairSum - minWeight) * pxPerWeight
      }
    },
    onMove: (delta, ctx) => {
      const px = Math.max(ctx.minPx, Math.min(ctx.maxPx, ctx.startPx + delta))
      const weight = px / ctx.pxPerWeight
      const next = [...ctx.startSizes]
      next[index] = weight
      next[index + 1] = ctx.pairSum - weight
      resizeSplit(split.id, next)
    },
    onEnd: () => setDragging(false)
  })

  /** 双击均分这一层（与 `ResizeHandle` 的双击复位同义：回到「没调过」的状态） */
  const resetToEqual = (): void => {
    const n = split.sizes.length
    if (n < 2) return
    resizeSplit(
      split.id,
      Array.from({ length: n }, () => 1 / n)
    )
  }

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label="拖动调整分栏大小（双击均分）"
      onPointerDown={onPointerDown}
      onDoubleClick={resetToEqual}
      title="拖动调整分栏大小（双击均分）"
      className={cn(
        /*
         * 命中热区 8px（窄屏 16px），但用 -mx-* / -my-* 的负 margin 把**占位抵成 0** —— 两侧面板
         * 直接相邻，缝里**不画任何线**（见下面那段注释）。
         *
         * ⚠️ 负 margin 不能省：以前这里是裸的 `w-1`，那 4px 是**实打实占位**的。未激活组用
         * `bg-background/60`，容器底色从这 4px 里透出来，看起来就是「一道缝」。
         *
         * ⚠️ `touch-none` 也不能省：少了它手机上手指一动就被浏览器当成滚动手势抢走
         * （`pointercancel`），表现是「一次只能拖一点点」。
         */
        'group/resize relative z-10 shrink-0 touch-none select-none [-webkit-touch-callout:none]',
        horizontal
          ? '-mx-2 w-4 cursor-col-resize sm:-mx-1 sm:w-2'
          : '-my-2 h-4 cursor-row-resize sm:-my-1 sm:h-2'
      )}
    >
      {/*
        **不画分隔线**：竖排（左右分栏）时那条竖线、横排（上下分栏）时那条横线，
        与面板自身的边框挤在一起就是双线，观感脏。可拖的提示交给抓手 ——
        平时透明，悬停淡入，触摸设备常显（见 `ResizeGrip`，拖动时不做形变）。
      */}
      <ResizeGrip axis={axis} dragging={dragging} />
    </div>
  )
}
