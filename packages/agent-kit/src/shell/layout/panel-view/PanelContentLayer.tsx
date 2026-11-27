"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useDragLayer } from 'react-dnd'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { ContainerTabGate } from '@fizz/agent-kit/features/projects/ContainerStartupView'
import { subscribeTabReloads, tabReloadsVersion, tabReloadGen } from '../tab-reload';
import { panelBodies, panelBodiesVersion, subscribePanelBodies } from '../panel-bodies';
import { PANEL_TAB_TYPE } from '@fizz/agent-kit/shared/lib/dnd-context'
import type { PanelState } from '@fizz/agent-kit/shared/lib/panel-groups'
import { allTabKeys, tabOwners } from '@fizz/agent-kit/shared/lib/panel-store';
import type { TabSlot } from './types'
import { useGroupActions } from './group-actions'
import { PanelTabContent } from './TabContent'

/** 两组落位是否逐项相同（相同就保持原引用，免得白白多渲染一轮） */
export function sameSlots(a: Record<string, TabSlot>, b: Record<string, TabSlot>): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (!x) return false
    if (x.left !== y.left || x.top !== y.top || x.width !== y.width || x.height !== y.height) {
      return false
    }
  }
  return true
}

/**
 * 标签**内容层**：主区域所有标签的内容在这里（`PanelView` 根部）平铺渲染一次，
 * 每个标签绝对定位到它所属组的车身矩形上。
 *
 * ## 为什么不在组里渲染
 *
 * 用户报的 bug：在同一个组里开两条终端，把其中一条拆到旁边 —— 两条终端都重开了一遍，
 * 输出清空、正在跑的程序被杀。根因不是「拆分」这个动作，而是**内容换了 React 父节点**：
 * 内容原来由 `PanelGroupView` 渲染，标签一旦换组（被拆走 / 拖到别的组），
 * 父节点就从「A 组」变成「B 组」，React 卸载重挂 —— `TerminalPanel` 的 cleanup 会把
 * PTY kill 掉。
 *
 * 所以内容必须**始终待在同一个父节点下**，位置只靠坐标变化来表达。于是：
 * 内容全挂在 `PanelView` 根部（这个扁平列表），组的坐标由
 * `panel-bodies.ts` 登记的车身元素量出来。标签换组 = 换一组坐标，React 看到的是
 * 同一个 key、同一层级的同一个节点 ⇒ **实例原样保留**。
 *
 * ## 为什么不是 `createPortal(内容, 车身)`
 *
 * React 19 的 `updatePortal` 里有一句「容器变了就 `createFiberFromPortal` 建新 fiber」
 * 的判定（原文抄在 `panel-bodies.ts` 的文件头）—— 标签换组时容器**正是要变**，
 * 于是 portal 版会照样重挂，比现在更隐蔽。详见 `panel-bodies.ts`。
 *
 * ## 四条必须守住的细节
 *
 * 1. **落位是量出来的，不是算出来的。** 布局树只有 `sizes` 权重，换算成像素要重做一遍
 *    flex 布局（还得算上分隔条宽度），迟早对不上。这里直接读车身的
 *    `getBoundingClientRect()`，相对内容层原点换算。
 * 2. **落位按「标签」缓存，量不到新组的车身时沿用上一次的位置。**
 *    拆分那一拍，新组的车身是**这次提交才挂出来**的 —— 提交前那次渲染里还没有它的矩形。
 *    若这时因为「查不到落位」就不渲染这个标签，React 会把它的内容卸载掉，正好又踩回
 *    要修的 bug（PTY 被杀）。所以量不到就退回上一次的落位，撑过这一帧；下一帧量到新矩形
 *    再挪过去（视觉上只是原地停一帧）。
 * 3. **拖动面板标签时必须把内容层让开（`pointer-events: none`）。**
 *    react-dnd 的 HTML5 后端是把 `dragenter/dragover/drop` 监听**挂在落区节点自己身上**的
 *    （`connectDropTarget` 里 `node.addEventListener(...)`），靠原生冒泡到达。内容层压在
 *    车身之上，如果它成了指针下的命中目标，那些事件就再也冒泡不到车身 —— 落区高亮与
 *    分屏全都失灵。让开之后指针下就是车身本身，与「内容不在这一层」时完全一致。
 * 4. **点内容区要能把这组设为焦点。** 内容层在 DOM 上落在车身里，但 React 树上是
 *    `PanelView` 的子节点 —— 事件按 **React 树**冒泡，不经过组的根节点，所以
 *    `PanelGroupView` 上那个 `onPointerDownCapture` 收不到。这里补一份。
 * 5. **容器型项目的「容器状态」卡片包在标签内容上（`ContainerTabGate`），不套在面板外面。**
 *    主区域是多标签的：门一旦套在 `PanelView` 外，容器一停（启动中 / 停止中 / 失败同理）
 *    就整块面板连标签条一起换成卡片，用户看不到也切不了别的标签（用户报过）。放在这里，
 *    标签条、拖拽、分屏、关闭全部照常，只有属于那个容器项目的标签内容换成卡片。
 */
export function PanelContentLayer({ state }: { state: PanelState }): ReactNode {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const { focusGroup } = useGroupActions()
  const version = useSyncExternalStore(
    subscribePanelBodies,
    panelBodiesVersion,
    panelBodiesVersion
  )
  /**
   * `标签 key → 落位`（不是按组存：换组时那条缓存正是要跨过去的，见上面第 2 条）。
   *
   * 标签 key 是终生不变的身份，所以这里**不需要**任何「迁移」：一颗标签从草稿变成会话、
   * 从这个组拖到那个组，key 都是同一个，缓存命中一直是它。
   */
  const [slots, setSlots] = useState<Record<string, TabSlot>>({})

  /** `measure` 要保持引用稳定（它是下面 effect 的依赖），又要读到最新的分组状态 —— 走 ref */
  const stateRef = useRef(state)
  stateRef.current = state

  /** 量一遍所有已登记的车身，换算成相对内容层的坐标，再落到每个标签头上 */
  const measure = useCallback((): void => {
    const layer = layerRef.current
    if (!layer) return
    const base = layer.getBoundingClientRect()
    const bodies = panelBodies()
    setSlots((prev) => {
      const next: Record<string, TabSlot> = {}
      for (const [tabKey, owner] of tabOwners(stateRef.current)) {
        const rect = bodies.get(owner.groupId)?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          next[tabKey] = {
            left: rect.left - base.left,
            top: rect.top - base.top,
            width: rect.width,
            height: rect.height
          }
        } else if (prev[tabKey]) {
          // 车身这一拍还没量到（刚挂出来 / 被折叠成 0 尺寸）：沿用上一次的落位（第 2 条）
          next[tabKey] = prev[tabKey]
        }
      }
      return sameSlots(prev, next) ? prev : next
    })
  }, [])

  /*
   * ⚠️ 每次提交后都重量一遍（无依赖）。会改布局的东西太多 —— 拖分隔条（走 panel-store
   * 的每帧更新）、开关侧栏、字体加载完成、窗口缩放…与其把触发源枚举全，不如「渲染完就量」：
   * 矩形没变时 `setSlots` 返回原引用，React 直接 bail out，不会多出一轮渲染。
   */
  useLayoutEffect(measure)

  /*
   * 车身集合变了（组新增 / 移除 / 换了 DOM 元素）→ 重挂 ResizeObserver 并立刻重量。
   * 「侧栏拖宽」这类**不经过 React 渲染**的尺寸变化，只有 ResizeObserver 接得住。
   */
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measure())
    for (const el of panelBodies().values()) observer.observe(el)
    const onWindowResize = (): void => measure()
    window.addEventListener('resize', onWindowResize)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
    }
  }, [measure, version])

  /**
   * 标签「刷新」代号变更的信号（`tab-reload.ts`）。代号本身按标签在下面 map 里读 ——
   * 不能在这里给每个标签挂一个 hook（map 里调 hook 不合法）。
   */
  useSyncExternalStore(subscribeTabReloads, tabReloadsVersion, tabReloadsVersion)

  /*
   * 面板标签拖拽中：把内容层让开，让原生 drag* 事件落到车身身上（见上面第 3 条）。
   * `useDragLayer` 读的是全局 monitor，与具体是哪个标签 / 哪组在拖无关。
   */
  const draggingTab = useDragLayer(
    (monitor) => monitor.isDragging() && monitor.getItemType() === PANEL_TAB_TYPE
  )

  const owners = tabOwners(state)

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-0">
      {allTabKeys(state).map((tabKey) => {
        const owner = owners.get(tabKey)
        const slot = slots[tabKey]
        // 从没量到过落位（刚开出来的新标签，首帧）：先不挂内容，免得 xterm 按 0×0 去 fit
        if (!owner || !slot) return null
        return (
          <div
            key={`${tabKey}#${tabReloadGen(tabKey)}`}
            /*
             * ⚠️ 这里是标签内容的宿主。层级恒定 —— 标签换组只改下面这组坐标，React 对账
             * 看到的是同一个节点，实例复用、不重挂；只有用户点了那颗「刷新」才通过末尾的
             * 刷新代号强制卸载重挂（见 `tab-reload.ts`）。
             *
             * key 直接用**标签 key**：它是终生不变的身份（`panel-tabs.ts` 的铁律），草稿
             * 标签发出第一条消息只是换了个指向，key 不变 ⇒ `ConversationTab` 不重挂，
             * 右侧面板里的终端 PTY、文件树展开状态（都只在组件内存里）原样留着。
             */
            style={{ left: slot.left, top: slot.top, width: slot.width, height: slot.height }}
            className={cn(
              'absolute overflow-hidden',
              // 拖拽中让开指针（见上面第 3 条）；用三元而不是叠加类名，避免优先级歧义
              draggingTab ? 'pointer-events-none' : 'pointer-events-auto',
              // 非活动标签 `hidden` 而**不卸载**：xterm 实例 / scrollback / 未保存内容只在内存里
              !owner.active && 'hidden'
            )}
            onPointerDownCapture={() => focusGroup(owner.groupId)}
          >
            {/*
              ⚠️ 内容宿主**必须是 flex 列**：`ConversationTab` 的根用 `flex-1`，
              只有父级是 flex 容器时它才有「确定的高度」可言。宿主若只是个块级
              `h-full`，`flex-1` 会被忽略、子级高度退化成 `auto` → 一路撑到内容高度，
              里面那些 `overflow-y-auto` 的滚动容器**永远不会触发滚动**。
              （与 dogi `PanelView` 的注释同一条约束，踩过两次了。）
            */}
            <div className="flex h-full flex-col">
              {/*
                ⚠️ 容器门（`ContainerTabGate`）必须在**这里**（每个标签内容各包一层），
                不能套在整个 `PanelView` 外面：容器一停就把标签条一起顶掉，用户看不到也
                切不了别的标签。门只拦「属于那个容器项目」的标签，见它的文件头。
              */}
              <ContainerTabGate tabKey={tabKey}>
                <PanelTabContent tabKey={tabKey} active={owner.active} />
              </ContainerTabGate>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 布局树递归
// ---------------------------------------------------------------------------
