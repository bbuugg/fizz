"use client";

/**
 * 左侧活动栏（类 VS Code）：竖条图标 = 功能区，点击即切换，**拖拽可重排**。
 *
 * 条目来自 `app/activities.tsx` 的注册表，新增功能区不用改这里；高亮、侧边栏
 * 折叠、主区域内容都由 `activeActivityId` 派生，没有第二份视图状态。
 *
 * 点击「当前已激活」的功能区 = 折叠 / 展开它自己的侧边栏（没有侧边栏的功能区
 * 无此行为）。点**别的**功能区 = 切过去；侧栏正收着时**一并展开** —— 不展开的话这一下
 * 点击界面上什么都不变（侧栏没显示、图标也不高亮），用户会以为点了没反应、要点两下。
 * **手机形态**：侧栏是覆盖抽屉（`mobileSidebarOpen` 管），所以
 * 「折叠」就是「收起抽屉」—— 点当前功能区 = 开 / 关抽屉；点别的功能区 = 切过去 + 开抽屉。
 *
 * ## 只有一种容器
 *
 * 竖条**只有这一种形态**：参与横向 flex 布局的常驻竖条，**任何形态下都常驻**（手机上
 * 也一样 —— 侧栏抽屉是它右边那层，见 `WebTitleBar`）。早先手机还有第二种形态 ——
 * 「从状态栏叫出来的 `fixed` 浮层 + 半透明遮罩」（`MobileActivityRail`）。用户明确反馈
 * 不要浮层、要它像桌面那样**占位**把内容挤过去，所以那一份已整个删除；随后「能不能把
 * 竖条收起来」这个开关也去掉了（手机上横杆与侧栏必须一起进出，不留半截形态）。**别再照
 * 「两种容器，一份内容」把它加回来** —— 现在只有一种容器，没有共用的必要。
 *
 * ## 「更多」：把功能区收起来
 *
 * 功能区多了以后（内置几个 + 每个插件一颗），竖条会一直往下长。所以末尾有一颗
 * **「更多」**，任何功能区都能收进去：
 *
 * - **收进去**：右键图标 →「收进「更多」」，或直接把图标**拖到「更多」上**；
 * - **用**：点「更多」弹出列表，点一项就切过去（收起来的项**照样能激活**，
 *   它不是隐藏 / 禁用，只是不在主栏里占一格）；
 * - **移回来**：弹层里那一行的行尾按钮（hover 才出现）。
 *
 * 「更多」**只在有内容时出现** —— 没收任何东西时不显示，主栏因此不会多一颗
 * 点了没反应的按钮。当前功能区是被收起来的那些之一时，「更多」也高亮，
 * 用户看得出「现在这一屏是从这里来的」。
 *
 * 存的地方与顺序 / 激活项一样（`app/activity-state.ts`，localStorage）——
 * 收起来是**偏好**，重启后应当还在。
 *
 * ## 底缘不再挂东西
 *
 * 「菜单」与折叠态的「展开侧栏」原先是挂在活动栏底缘的两颗按钮（`footer`）。
 * 现在它们都搬到**底部状态栏**左侧（见 `StatusBar.tsx`）—— 那条是整宽的常驻横条，
 * 比 40px 宽的竖条更适合放「全局、与当前功能区无关」的入口，也不会和功能区图标挤在一列。
 *
 * ## 为什么用 react-dnd 而不是原生 HTML5 拖拽
 *
 * 参考实现（dogi）在活动栏用原生 `draggable`、在标签页用 react-dnd，两套拖拽
 * 系统并存。react-dnd 的 HTML5 后端会在根节点上挂全局 `drag*` 监听，与原生
 * `draggable` 的默认行为互相干扰（原生拖拽可能被后端吞掉 / 光标反馈错乱）。
 * 所以这里**统一走 react-dnd**：一个 manager，靠 item type 隔离不同的拖拽语义
 * （「更多」也吃同一个 type，于是拖拽既能重排、也能收起来）。
 */
import { useState } from 'react'
import { useDrag, useDrop } from 'react-dnd'
import { MoreHorizontal, PanelLeftOpen } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@fizz/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@fizz/ui/popover'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useActiveActivity, type Activity } from '../activities'
import {
  moveActivityOutOfOverflow,
  moveActivityToOverflow,
  setActiveActivityId,
  setActivityOrder,
  useActivityOverflow
} from '@fizz/agent-kit/shared/lib/activity-state'

import { setSidebarCollapsed, useSidebarCollapsed } from '@fizz/agent-kit/shared/lib/sidebar-collapsed'
import { useDndRef } from '@fizz/agent-kit/shared/lib/dnd-context'

/** 活动栏图标的拖拽类型（与面板标签 / ChatPanel 的 type 区分开） */
const ACTIVITY_ITEM_TYPE = 'fizz/activity'

interface ActivityDragItem {
  id: string
}

/** 活动栏里的一个图标：可点击、可拖拽、右键可收进「更多」 */
function ActivityButton({
  id,
  label,
  Icon,
  active,
  current,
  hasSidebar,
  onReorder
}: {
  id: string
  label: string
  Icon: React.ComponentType<{ className?: string }>
  /** 视觉上的高亮态（当前功能区 **且** 侧边栏展开） */
  active: boolean
  /** 是不是当前功能区（与高亮态不同：折叠时它仍为 true，只是不高亮） */
  current: boolean
  hasSidebar: boolean
  /** 把被拖项插入到本项位置（在完整顺序上重排） */
  onReorder: (dragId: string, targetId: string) => void
}) {
  const collapsed = useSidebarCollapsed()
  const isMobile = useIsMobile()
  const t = useT()
  const { mobileSidebarOpen, setMobileSidebarOpen } = useAppContext()

  const [{ isDragging }, dragRef] = useDrag<ActivityDragItem, void, { isDragging: boolean }>({
    type: ACTIVITY_ITEM_TYPE,
    item: { id },
    collect: (monitor) => ({ isDragging: monitor.isDragging() })
  })

  const [, dropRef] = useDrop<ActivityDragItem, void, { isOver: boolean }>({
    accept: ACTIVITY_ITEM_TYPE,
    drop: (item) => onReorder(item.id, id),
    collect: (monitor) => ({ isOver: monitor.isOver() })
  })

  /**
   * ⚠️ 判据必须是「是不是**当前**功能区」而不是「是否高亮」。
   * 高亮态在侧栏折叠后是 false，若拿它当判据，折叠一次之后就再点不开了 ——
   * 点击会走「选中」分支（选中同一个 id = 空操作），侧栏永远卡在收起状态。
   * （参考实现就是这么写的，实测点一下收起、再点没反应。）
   */
  const onClick = (): void => {
    /**
     * 手机：侧栏是**覆盖抽屉**（`mobileSidebarOpen`，见 activity-sidebar.tsx），
     * 「折叠偏好」对它无效 —— 所以这里既不能走下面的折叠分支，也不能只切功能区
     * （抽屉没开，点了界面上什么都不变）。
     *
     * - 点**当前**功能区：开 / 关抽屉。⚠️ 少了这一路，AI（默认就是当前功能区）那颗图标
     *   在抽屉开着时点下去**什么都不变** —— 用户看到的就是「第一个图标点不动」
     *   （它既不是「切过去」也不是「收起来」）。这与桌面「点当前功能区 = 折叠 / 展开侧栏」
     *   是同一条语义。
     * - 点别的功能区：切过去 + 开抽屉（该功能区没有侧栏时 `hasSidebar` 为 false，顺手收起）。
     */
    if (isMobile) {
      if (current && hasSidebar && mobileSidebarOpen) {
        setMobileSidebarOpen(false)
      } else {
        setActiveActivityId(id)
        // 竖条与侧栏**同进同出**（见 `mobile-sidebar.ts`）：抽屉开着 → 竖条就在，
        // 所以这里只要开抽屉，竖条自然回来，不需要第二个开关。
        setMobileSidebarOpen(hasSidebar)
      }
      return
    }
    if (current && hasSidebar) {
      setSidebarCollapsed(!collapsed)
      return
    }
    setActiveActivityId(id)
    /**
     * ⚠️ 切到**别的**功能区时，侧栏正收着就顺手展开。
     *
     * 少了这一句，这一下点击在界面上**什么都不变**：切过去的侧栏没显示（折叠着）、
     * 图标也不高亮（高亮态是 `current && !collapsed`）—— 用户看到的是「点了没反应」，
     * 必须再点一次才展开（第二次走上面那条「当前功能区 = 展开」分支）。
     * 表现就是「侧栏收起后切功能区要点两下」。
     */
    if (hasSidebar && collapsed) setSidebarCollapsed(false)
  }

  // ⚠️ 必须 memo（见 `useDndRef` 的注释）：裸箭头函数每次渲染都是新 ref → 无限更新循环
  const setRef = useDndRef<HTMLButtonElement>(dragRef, dropRef)

  return (
    <ContextMenu>
      {/* 嵌套顺序：最内层才是真正的 DOM（Button），两层的 asChild 依次往下传 ref 与事件 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <Button
              ref={setRef}
              variant="ghost"
              size="icon"
              aria-label={label}
              aria-pressed={active}
              onClick={onClick}
              className={cn(
                'size-7.5 text-muted-foreground hover:text-foreground',
                // 激活态用主题色底 + 主题色图标（深浅度令牌见 styles.css 的 --primary-*）
                active && 'bg-primary-soft text-primary-strong hover:bg-primary-subtle',
                isDragging && 'opacity-40'
              )}
            >
              <Icon className="size-4" />
            </Button>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
      {/* 这个 shadcn 变体的 ContextMenuContent 只收 `side`（没有 align） */}
      <ContextMenuContent side="right">
        <ContextMenuItem onSelect={() => moveActivityToOverflow(id)}>
          {t('收进「更多」')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 「更多」：收起来的功能区都在这里。
 *
 * 两种入口都能进：右键菜单，以及**把图标拖到这颗按钮上**（`useDrop` 吃同一个
 * drag type，落点语义是「收起来」而不是「插到这个位置」）。
 */
function MoreActivitiesButton({
  items,
  activeId
}: {
  /** 被收起来的功能区（按用户拖出来的顺序） */
  items: Activity[]
  /** 当前功能区 id：它是其中之一时这颗按钮也高亮 */
  activeId: string
}) {
  const [open, setOpen] = useState(false)
  const [{ isOver }, dropRef] = useDrop<ActivityDragItem, void, { isOver: boolean }>({
    accept: ACTIVITY_ITEM_TYPE,
    drop: (item) => moveActivityToOverflow(item.id),
    collect: (monitor) => ({ isOver: monitor.isOver() })
  })
  const setRef = useDndRef<HTMLButtonElement>(dropRef)
  const containsCurrent = items.some((a) => a.id === activeId)
  const collapsed = useSidebarCollapsed()
  const t = useT()


  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              ref={setRef}
              variant="ghost"
              size="icon"
              aria-label={t("更多功能区")}
              className={cn(
                'size-8 text-muted-foreground hover:text-foreground',
                // 拖到它上面 / 当前功能在它里面 → 高亮，让「落到哪了」有反馈
                (isOver || containsCurrent) && 'bg-primary-soft text-primary-strong hover:bg-primary-subtle'
              )}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">{t('更多（右键图标可收进这里）')}</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="start" className="w-52 p-1">
        <div className="px-2 py-1 text-[0.625rem] text-muted-foreground">
          {t('收起来的功能区')}
        </div>
        {items.map((item) => {
          const Icon = item.icon
          const current = item.id === activeId
          const moveBackLabel = t('把「{name}」移回主栏', { name: item.label })
          return (
            <div
              key={item.id}
              className={cn(
                'group flex items-center gap-1 rounded-md',
                current && 'bg-primary-soft'
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setActiveActivityId(item.id)
                  // 与活动栏图标同一条语义：侧栏收着时切过去要顺手展开（否则点了没反应）
                  if (item.sidebar && collapsed) setSidebarCollapsed(false)
                  setOpen(false)
                }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left text-xs transition-colors hover:bg-secondary"
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
              <button
                type="button"
                title={moveBackLabel}
                aria-label={moveBackLabel}
                onClick={() => moveActivityOutOfOverflow(item.id)}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover:opacity-100"
              >
                <PanelLeftOpen className="size-3.5" />
              </button>
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

/**
 * 竖条的**内容**：一列图标 + 末尾的「更多」。
 *
 * 抽成独立组件是因为它与容器无关（只读注册表 / 顺序 / 溢出偏好），容器以后要换
 * （比如再加一种宽度形态）不用动它。
 */
function ActivityRailItems() {
  const { activities, activity } = useActiveActivity()
  const collapsed = useSidebarCollapsed()
  const currentId = activity.id
  const overflow = useActivityOverflow()

  /** 把被拖项插入目标位置，写入完整 id 顺序（`orderActivities` 统一生效） */
  const reorder = (dragId: string, targetId: string): void => {
    if (dragId === targetId) return
    const ids = activities.map((a) => a.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    setActivityOrder(ids)
  }

  // 收起来的不在主栏里出现；其余按用户拖出来的顺序排
  const shown = activities.filter((a) => !overflow.includes(a.id))
  const hidden = activities.filter((a) => overflow.includes(a.id))

  return (
    <>
      {shown.map((a) => {
        const hasSidebar = Boolean(a.sidebar)
        const current = a.id === currentId
        // 没有侧边栏的功能区（整页界面）不显示侧边栏，始终算高亮
        const active = current && (hasSidebar ? !collapsed : true)
        return (
          <ActivityButton
            key={a.id}
            id={a.id}
            label={a.label}
            Icon={a.icon}
            active={active}
            current={current}
            hasSidebar={hasSidebar}
            onReorder={reorder}
          />
        )
      })}
      {/* 没收任何东西时**不显示**这颗按钮 */}
      {hidden.length > 0 && <MoreActivitiesButton items={hidden} activeId={currentId} />}
    </>
  )
}

/**
 * 活动栏竖条。**占位**（`shrink-0` 参与横向 flex），不是浮层，**任何形态下都常驻**
 * （手机上侧栏抽屉开合时它也在，抽屉往它右边让开 —— 见 `activity-sidebar.tsx`）。
 */
export function ActivityBar() {
  const t = useT()
  return (
    <nav
      className="flex w-10 shrink-0 flex-col items-center gap-1 py-2"
      aria-label={t("功能区")}
    >
      {/* 手机点当前功能区 = 开关抽屉（见 ActivityButton 的 onClick） */}
      <ActivityRailItems />
    </nav>
  )
}
