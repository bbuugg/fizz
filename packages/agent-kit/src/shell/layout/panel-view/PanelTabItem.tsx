"use client";

import { useEffect, useRef, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Pencil,
  RefreshCw,
  Split,
  X,
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@fizz/ui/context-menu'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { PanelTab } from '@fizz/agent-kit/shared/components/PanelTab'
import { NEW_TAB_KEY } from '@fizz/agent-kit/shared/lib/panel-tabs'
import {
  horizontalRatio,
  PANEL_TAB_TYPE,
  useDndRef,
  zoneOf,
  type PanelTabDragItem,
  type TabDropZone,
} from '@fizz/agent-kit/shared/lib/dnd-context'
import {
  activateTab,
  moveTab,
  reorderTab,
  splitTab,
} from '@fizz/agent-kit/shared/lib/panel-store'
import type { TabMeta } from './types'
import { tabIndexIn } from './tab-meta'

export function PanelTabItem({
  tabKey,
  groupId,
  groupTabIds,
  index,
  active,
  meta,
  canCloseGroup,
  onActivate,
  onClose,
  onCloseGroup,
  onRename,
  onReload
}: {
  tabKey: string
  groupId: string
  /** 本组的标签 key（顺序即标签条顺序）—— 右键的「关闭左侧 / 右侧 / 其他」按它算范围 */
  groupTabIds: string[]
  /** 本标签在组内的下标 */
  index: number
  active: boolean
  meta: TabMeta
  /**
   * 是否**多个分组**（由 `PanelGroupView` 按布局树的叶子数给出）。
   * 单组时「关闭整组」没有意义（关完只是留一个空组占位），所以右键里也不显示它。
   */
  canCloseGroup: boolean
  /** 点标签：切到它，并把「当前会话」同步过去（焦点标签 ≡ 当前会话；工具标签除外） */
  onActivate: (key: string) => void
  /** 关闭一批标签（一个 = 关自己，多个 = 右键的批量关闭） */
  onClose: (keys: string[]) => void
  /** 关闭本组全部标签（右键的「关闭整个组」）—— 也要同步「当前会话」，见 `closeGroupAndSync` */
  onCloseGroup: (groupId: string) => void
  /** 标签改名：对话标签改会话标题，工具标签只改显示名（两条路的语义见 `renameTab`） */
  onRename: (key: string, title: string) => void
  /** 刷新这个标签（对话标签 = 重新加载会话；工具标签 = 卸载重挂），见 `reloadTab` */
  onReload: (key: string) => void
}) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const [zone, setZone] = useState<TabDropZone | null>(null)
  /** 就地重命名：草稿跟着当前标题走，提交后交给 `onRename` */
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  /** 重命名输入框（菜单关完之后要靠它补一次焦点，见下面 `onCloseAutoFocus`） */
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const tabCount = groupTabIds.length
  /**
   * 除了「新对话」草稿标签（名字就是那个页面的语义，改了没意义），**所有标签都能改名**：
   * - **对话标签** → 改的是**会话标题**（落盘，侧栏同步）；
   * - **工具标签** → 只改主区域标签的**显示名**（内存里的一层别名，关掉重开恢复原名，
   *   不回写主机清单 / 接口清单，见 `renameToolTab`）。
   */
  const renamable = tabKey !== NEW_TAB_KEY

  /**
   * ⚠️ `useDrag` / `useDrop` **必须用「工厂函数 + deps 数组」形式**，不能直接传对象字面量。
   *
   * react-dnd 的 `useOptionalFactory(arg, deps)` 在 `deps == null` 且 `arg` 不是函数时，
   * 会把 **`arg` 对象本身**塞进 `useMemo` 的依赖里。传字面量 = 每次渲染都是新对象 =
   * `spec` 每次重算 → `handler` 每次重算 → `useRegisteredDragSource` 的
   * `useIsomorphicLayoutEffect(..., [manager, monitor, connector, handler, itemType])`
   * **每次渲染都重跑**：`unregister()` + `registerSource()` 换来一个新的 handlerId。
   * 拖拽中途任何一次重渲染（`isDragging` 翻转就会重渲染）都会让 handlerId 漂掉，
   * 于是拖拽目标再也匹配不上 —— 表现为「拖起来有 `dragstart`，但**永远不触发
   * `hover` / `canDrop` / `drop`**，落区高亮和分屏全都不出现」。
   *
   * 传工厂函数 + 显式 deps，spec 才在依赖不变时保持同一引用（与参考实现 dogi 同款写法）。
   */
  const [{ isDragging }, dragRef] = useDrag<PanelTabDragItem, void, { isDragging: boolean }>(
    () => ({
      type: PANEL_TAB_TYPE,
      item: { key: tabKey, fromGroupId: groupId },
      collect: (monitor) => ({ isDragging: monitor.isDragging() })
    }),
    [tabKey, groupId]
  )

  /** 把落区翻译成 store 调用（同组 = 重排、异组 = 移动）—— 逻辑内联进 spec，避免闭包过期 */
  const [{ isOver }, dropRef] = useDrop<PanelTabDragItem, void, { isOver: boolean }>(
    () => ({
      accept: PANEL_TAB_TYPE,
      drop: (item, monitor) => {
        // 落点已被更内层的目标处理过就别重复（标签条内部的标签互相之间会层层冒泡）
        if (monitor.didDrop()) return
        const target = zoneOf(horizontalRatio(monitor, elRef.current))
        setZone(null)
        if (item.key === tabKey) return
        if (target === 'inside') {
          // 并入本标签所在的组（追加到组尾），并切过去
          moveTab(item.key, groupId)
          activateTab(item.key)
          return
        }
        // 同组重排 / 跨组移动：目标下标 = 本标签下标（插到它前）或 +1（插到它后）
        const at = tabIndexIn(groupId, tabKey) + (target === 'after' ? 1 : 0)
        if (item.fromGroupId === groupId) reorderTab(groupId, item.key, at)
        else moveTab(item.key, groupId, at)
      },
      hover: (item, monitor) => {
        setZone(item.key === tabKey ? null : zoneOf(horizontalRatio(monitor, elRef.current)))
      },
      collect: (monitor) => ({ isOver: monitor.isOver() })
    }),
    [tabKey, groupId]
  )

  // 指针离开本标签时清掉落区高亮（`hover` 只在指针仍在本标签上时触发）
  useEffect(() => {
    if (!isOver) setZone(null)
  }, [isOver])

  // ⚠️ 必须 memo（见 `useDndRef` 的注释）：裸箭头函数每次渲染都是新 ref → 无限更新循环
  const setRef = useDndRef<HTMLDivElement>(dragRef, dropRef, (node) => {
    elRef.current = node
  })

  const startRename = (): void => {
    setDraft(meta.label)
    setRenaming(true)
  }

  const submitRename = (): void => {
    setRenaming(false)
    onRename(tabKey, draft.trim())
  }

  /** 右键「拆分」：把**本标签**拎到该方向的新组（组里只剩它一个时右键里根本没有这一项） */
  const split = (direction: 'up' | 'down' | 'left' | 'right'): void => {
    if (tabCount === 1) return
    splitTab(tabKey, groupId, direction)
  }

  /**
   * 「刷新」= 让**这一个标签的内容**重新加载。
   *
   * 两条路（由 `reloadTab` 按标签类型分派）：
   * - **对话标签** → 「重新加载这条会话」（等价于刷新页面后点开它：内置 拉服务端权威
   *   历史、acp 走 `session/load` 回放）。刻意**不走卸载重挂** —— `ConversationTab` 重挂
   *   并不会重新拉消息（消息在 store 里），只会把右侧面板的终端 / 文件现场一起拆掉。
   * - **工具标签** → `requestReloadTab` 的卸载重挂（接口页重发请求、插件面重新 `render()`）。
   *
   * ⚠️ 两条路都要**先问标签自己的守卫**（`tab-close.ts` 的 `beforeReload`）：重挂是破坏性的
   * —— 终端里正在跑的进程会一起结束、接口页草稿会丢。
   */
  const reloadTab = (): void => {
    onReload(tabKey)
  }

  return (
    <ContextMenu>
      {/*
        ⚠️ 右键菜单挂在**标签本身**上（`asChild` 让 Radix 把 `onContextMenu` / `ref` 合并进来）。
        菜单内容 portal 到 body，所以不会被标签条的 `overflow-x-auto` 裁掉。
        参考实现（dogi）的标签右键菜单也是这一套（拆分 / 重命名 / 各种关闭）。
      */}
      <ContextMenuTrigger asChild>
        {/*
          标签本体是共享的 `shared/components/PanelTab`（与对话右侧的 SidePanel 同一颗）：
          图标 + 名字 + 行尾带渐变底的关闭 × 都在那里，两处标签条肉眼上才是同一套控件。
          这里只额外挂「主区域特有」的东西：拖拽源 ref（`setRef`）、右键菜单（`asChild` 让
          Radix 把 `onContextMenu` / `ref` 合并进来）、`data-tab-key`（供标签条把它滚进
          可视区）、重命名草稿，以及拖拽落区提示（走 children）。
        */}
        <PanelTab
          ref={setRef}
          data-tab-key={tabKey}
          active={active}
          label={meta.label}
          title={meta.title}
          icon={meta.icon}
          status={meta.status}
          onActivate={() => onActivate(tabKey)}
          onClose={() => onClose([tabKey])}
          renaming={renaming}
          renameValue={draft}
          renameInputRef={renameInputRef}
          onRenameChange={setDraft}
          onRenameSubmit={submitRename}
          onRenameCancel={() => setRenaming(false)}
          // 高度（`h-7`）与图标尺寸已由 `PanelTab` 统一，这里只加主区域特有的：`max-w-52`
          // 是标签宽度的上限（主区域标签条要横向滚动），`min-w-28` 是**默认最小宽度**
          // （96px 时中文名字两个半字就被截成省略号、悬停才看得全，抬到 112px 更够用），
          // `shrink-0` 拒绝被压窄（侧栏那份要能挤）
          className={cn('max-w-52 min-w-28 shrink-0', isDragging && 'opacity-40')}
        >
          {/* 落区提示：一条竖线（插到前 / 后）或一圈描边（并入本组） */}
          {zone === 'inside' ? (
            <span className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-primary" />
          ) : zone ? (
            <span
              className={cn(
                'pointer-events-none absolute inset-y-0 w-0.5 bg-primary',
                zone === 'before' ? 'left-0' : 'right-0'
              )}
            />
          ) : null}
        </PanelTab>
      </ContextMenuTrigger>

      <ContextMenuContent
        className="w-52"
        /*
         * ⚠️ 这里干两件事：**别把焦点还给标签**（否则菜单关掉后标签上会亮一圈
         * `focus-visible` 边框），以及**把焦点补给重命名输入框**。
         *
         * 为什么非要在这一刻补：输入框挂出来时 `autoFocus` 抢不到焦点 —— Radix 模态菜单的
         * `FocusScope` 要等退场动画（内容上的 `duration-100`）跑完、内容真正卸载才撤掉，
         * 那 100ms 里任何外部 `focus()` 都会被它同步拽回菜单项。用户看到的就是「右键 →
         * 重命名 → 变成输入框了，但光标不在里面，敲字没反应」。这个回调正好在**内容卸载
         * 之后**才派发（`FocusScope` 的 unmount autofocus，见 `ui/src/focus-dismiss.ts`），
         * 是唯一能稳稳拿到焦点的那一刻。
         */
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const input = renameInputRef.current
          // 已经拿到了（没有退场动画 / 菜单非模态时 `autoFocus` 就能成）就别再碰它，
          // 免得搅掉用户这一拍里已经敲进去的字。不是重命名态（Esc / 点空白关的菜单）也没事：
          // 输入框没挂出来，ref 是 null。
          if (!input || document.activeElement === input) return
          input.focus()
        }}
      >
        {/*
          ⚠️ 只渲染**当下真的能用**的项：用不了的整条不出现，不是置灰。
          只留一个标签时没得拆、也没法「关闭其他」；已经在首 / 末位就没有左侧 / 右侧可关；
          只有一组时「关闭整个组」没意义（关完只是留一个空组占位）。免得到处是灰条、还得
          逐条去猜为什么点不动。
        */}
        {/* 拆分：把本标签拎到某个方向的新组（组里只剩它一个时无处可拆） */}
        {tabCount > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Split className="size-4" />
              拆分
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => split('up')}>
                <ArrowUp className="size-4" />
                向上拆分
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => split('down')}>
                <ArrowDown className="size-4" />
                向下拆分
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => split('left')}>
                <ArrowLeft className="size-4" />
                向左拆分
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => split('right')}>
                <ArrowRight className="size-4" />
                向右拆分
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {renamable && (
          <ContextMenuItem onSelect={startRename}>
            <Pencil className="size-4" />
            重命名
          </ContextMenuItem>
        )}
        {/* 刷新：内容卸载重挂（会先过标签自己的守卫，见 `reloadTab`）。
            放在「重命名」之后、「关闭」一族之前 —— 前两条都是「改这一个标签」，后面是一族关闭 */}
        <ContextMenuItem onSelect={reloadTab}>
          <RefreshCw className="size-4" />
          刷新
        </ContextMenuItem>
        {/* 分隔线恒有：「刷新」与「关闭」一族之间一定要分开 */}
        <ContextMenuSeparator />
        {/*
          关闭方式**全部平铺在一级**：原先「关闭其他 / 左侧 / 右侧 / 整个组」收在一个也叫
          「关闭」的二级菜单里（与一级的「关闭」重名，还要多一层点击）。三种批量关闭都只
          作用于**本组**，且都保留当前这个标签。
        */}
        <ContextMenuItem onSelect={() => onClose([tabKey])}>
          <X className="size-4" />
          关闭
        </ContextMenuItem>
        {tabCount > 1 && (
          <ContextMenuItem onSelect={() => onClose(groupTabIds.filter((k) => k !== tabKey))}>
            关闭其他标签
          </ContextMenuItem>
        )}
        {index > 0 && (
          <ContextMenuItem onSelect={() => onClose(groupTabIds.slice(0, index))}>
            关闭左侧标签
          </ContextMenuItem>
        )}
        {index < tabCount - 1 && (
          <ContextMenuItem onSelect={() => onClose(groupTabIds.slice(index + 1))}>
            关闭右侧标签
          </ContextMenuItem>
        )}
        {canCloseGroup && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onCloseGroup(groupId)}>关闭整个组</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ---------------------------------------------------------------------------
// 组相关的用户手势动作
// ---------------------------------------------------------------------------
