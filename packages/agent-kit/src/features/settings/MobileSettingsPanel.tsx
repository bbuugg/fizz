/**
 * 手机版设置：**菜单 / 详情两级**。菜单整宽铺开（一行一项 + 右侧箭头），点进去只看
 * 那一项，内容区顶部给一条「← 当前项」的返回行（整页设置页会通过 `onDetailChange`
 * 把它搬到宿主自己的标题栏）。
 *
 * ⚠️ 这个组件**不再由宿主直接用**：三端统一从 `SettingsShell` 进（按 `platform` / `form`
 * 挑到这里）。`platform` 是必须的 —— 菜单里出现哪几项按宿主过滤（手机版没有「快捷键」，
 * 见 `sections.ts`）。
 *
 * 为什么不跟桌面共用一份带断点的面板：390px 屏上桌面那条 `w-44` 竖排菜单连间距要
 * 吃掉 196px，内容区只剩 ~110px —— 模型 / MCP 这些带输入框的表单根本没法用；
 * 反过来，把两级导航塞进桌面面板又得给宽屏写一堆「用不到」的状态。
 * 所以和 `DesktopSettingsPanel` 是两个组件，只共享 `sections` 的分组清单与
 * `SettingsContent` 的表单。
 *
 * 手机专属的宿主入口（「数据 / 退出」）经 `extraGroups` 追加在菜单末尾 —— 与内置项
 * 同一套行样式，不另起炉灶。
 *
 * ## 菜单 ↔ 二级页 = 横滑转场（进场 + 退场）
 *
 * 两屏不是「一显一隐」，而是同一层级的左右两页：进二级页时内容从**右缘滑入**、菜单
 * 同时被留下一道视差（`-20%`）；返回时反过来。所以两块**都要一直在场**（不再用
 * `hidden` / 条件渲染 —— 那样离场的那块会当场消失，退场动画无从谈起），靠布局位置 +
 * `translate` 表达「谁在看」：
 * - 菜单 `w-full` 落在容器左缘、内容 `w-full` 钉在容器**右缘之外**（`left-full`）。
 *   两者都只占满宽、不挤压：容器是 `overflow-hidden`，不在场的那块就在裁切框外。
 * - 宽屏（平板横屏 / 桌面浏览器调试）不播转场：两块并排铺开（菜单固定宽度 + 内容占余宽），
 *   与原来的两栏形态一致，也不需要任何视差。
 *
 * ⚠️ 过渡属性写 `transition-transform` 而**不是** `transition-[transform]`：横移用的是 CSS
 * 的 `translate` 属性，Tailwind v4 的 `transition-transform` 正好展开成
 * `transform, translate, scale, rotate` 四条（见 `apps/mobile/src/styles.css` 的注释）。
 * 而且 `transition-transform` 必须**常驻**（在基础类里），不能只在动画那一帧补 —— 首帧
 * 没有过渡属性时状态一切换就是瞬移。
 *
 * ## 二级页必须自带实底（`bg-surface-1`）
 *
 * 两页是满宽**叠**在一起的（`absolute` 两块同位置）。分栏时中间有 `gap`、两栏同底色，
 * 谁都看不出「没铺底」；叠起来之后，内容页要是透明，底下的菜单文字会原样透上来 ——
 * 用户看到的就是「二级菜单打开了，背景是纯透明的」。所以：
 * - 内容页铺 `bg-surface-1`（比画布实一档，见 `themes.css`「压在人上面的面板用
 *   surface」），它是一整块**盖在菜单上**的面板；
 * - 菜单左移 `-20%` 后右缘会空出 20%，那一条交给宿主画（`SettingsPage` 的根是
 *   `bg-surface-1`）。两层**同色同透明度**，中间那块底不会比页面更实或更淡。
 *
 * ⚠️ 别给菜单再铺一层底：菜单走到屏外时铺了也看不见，但滑出去的途中它和内容页的
 * 半透明底会**叠两次**，中间那 250ms 那一块会明显比两边实（闪一下）。
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type {
  SettingsCommonProps,
  SettingsExtraGroup,
  SettingsNavGroup,
  SettingsNavItem,
  SettingsPlatform,
  SettingsSelectionProps,
  SettingsTabId
} from '@fizz/agent-kit/features/settings/types'
import { useLanguage, useT } from '@fizz/agent-kit/shared/lib/language'
import {
  buildSettingsGroups,
  hasSettingsTab,
  resolveInitialTab
} from '@fizz/agent-kit/features/settings/sections'
import { SettingsContent } from '@fizz/agent-kit/features/settings/SettingsContent'

/** 二级页的标题 / 返回动作：宿主（如整页设置）接管顶部标题与返回键时使用 */
export interface MobileSettingsDetail {
  title: string
  back: () => void
}

export function MobileSettingsPanel({
  platform,
  extraGroups,
  className,
  initialTab,
  tab: tabProp,
  onTabChange,
  animate = true,
  onDetailChange,
  ...common
}: SettingsCommonProps &
  SettingsSelectionProps & {
    /** 这台宿主是谁（菜单按它过滤：手机版没有「快捷键」，见 `sections.ts`） */
    platform: SettingsPlatform
    /**
     * 宿主扩展入口（手机版的「数据 / 退出」）：追加在内置分组之后（菜单列表底部）。
     * 设置项进二级页；一次性动作就是列表最后单独一行，点一下直接执行。
     */
    extraGroups?: SettingsExtraGroup[]
    className?: string
    /** 打开时落在哪一项（模型选择下拉的设置入口用）；不给 = 从菜单起步 */
    initialTab?: SettingsTabId
    /**
     * 菜单 ↔ 二级页是否播横滑转场（默认播）。
     * `false` 时两块原地切换（并排铺开），给**屏幕够宽**的宿主（平板横屏 / 桌面浏览器里
     * 调试手机壳）用 —— 那里两栏本来就放得下，再横滑一遍只是拖慢操作。
     */
    animate?: boolean
    /**
     * 二级页的标题 / 返回键交给宿主渲染（整页设置页把它放进自己的 header）。
     * 不传则退回自绘：返回行画在内容区顶部（窄屏 web 的弹窗用）。
     */
    onDetailChange?: (detail: MobileSettingsDetail | null) => void
  }) {
  // 订阅语言：分组标签由 sections.ts 用 t() 现算，切语言时要重渲染
  const tr = useT()
  /** 菜单模型：内置分组（按宿主过滤）+ 宿主扩展分组（后者追加在列表末尾） */
  const builtIn: SettingsNavGroup[] = buildSettingsGroups(common.app, platform)
  const groups: SettingsNavGroup[] = extraGroups?.length ? [...builtIn, ...extraGroups] : builtIn
  /** 选中值放宽成 string：扩展分组的 id 由宿主任意定，不进 `SettingsTabId` 联合 */
  const [ownTab, setOwnTab] = useState<string>(() => resolveInitialTab(groups, initialTab))
  // 受控时以宿主为准（设置标签把它提在标签层，见 `SettingsSelectionProps`）；不受控时
  // 自己管。过 `resolveInitialTab` 的作用同桌面壳：分组不在这台宿主上就退回第一项。
  const tab = resolveInitialTab(groups, tabProp ?? ownTab)
  const selectTab = (next: string): void => {
    if (tabProp === undefined) setOwnTab(next)
    onTabChange?.(next)
  }
  /**
   * 是否停在「菜单」这一层。选中项 `tab` **不跟着重置** —— 从某项退回来再进去，
   * 还停在原来那一项上。
   *
   * 初值看 `initialTab`：带分组进来的（模型下拉的「去设置里加模型」）就是要**直接看
   * 那一项**，落在菜单上等于让用户多点一下 —— 手机版菜单是独占一屏的。但那分组得
   * **真的在这台宿主的菜单里**（`hasSettingsTab`）：传了个当前宿主没有的项就别直接
   * 跳，否则打开就是「标题写着某一项、返回却无处可回」。
   */
  const [menuOpen, setMenuOpen] = useState(
    () => !(initialTab && hasSettingsTab(groups, initialTab))
  )

  /** 当前选中项的文案：宿主那条标题栏拿它当标题（省一个页面标题） */
  const currentLabel =
    groups.flatMap((group) => group.items).find((item) => item.id === tab)?.label ?? ''

  /**
   * 返回菜单。
   *
   * ⚠️ 必须是**稳定引用**（这一点靠 React 白送：`setMenuOpen` 本身恒定）。宿主把
   * `back` 塞进 `onDetailChange` 上报，调用方那边再 `setState` —— 如果这里换成每次渲染
   * 新造的箭头函数，就是一个「渲染 → 上报新对象 → 宿主 setState → 再渲染」的死循环。
   */
  const back = useCallback((): void => setMenuOpen(true), [])

  useEffect(() => {
    if (!onDetailChange) return
    if (menuOpen) {
      onDetailChange(null)
      return
    }
    onDetailChange({ title: currentLabel, back })
  }, [currentLabel, menuOpen, onDetailChange, back])

  /**
   * 点一项：`action` 项就地执行，其余切到内容页（内容占一屏，所以顺手收起菜单）。
   * 动作项不参与选中态（`tab` 不变），点完停在哪还在哪。
   */
  const pick = (item: SettingsNavItem): void => {
    if (item.action) {
      item.action()
      return
    }
    selectTab(item.id)
    setMenuOpen(false)
  }

  return (
    /*
      外层是横滑的**裁切框**（`relative` + `overflow-hidden`）：菜单与内容都 `w-full`，
      后者平时钉在 `left-full`（右缘之外），所以这里必须裁掉，不然它会把整页撑出横向滚动。
      内边距原来在面板根上（`px-2 pb-2`），现在挪到两块**各自**身上 —— 留在裁切框上会
      把「滑出屏幕」的那条边也一起内缩，滑动到一半能看见第二块的左边缘提前露出来。
    */
    <div
      className={cn(
        'relative flex min-h-0 flex-1 overflow-hidden',
        // 宽屏不播转场时退回原来的两栏（菜单定宽 + 内容占余宽）
        !animate && 'gap-2',
        className
      )}
    >
      {/*
        菜单：手机上整宽铺开、钉在左缘；进二级页时整体**左移一点点**（`-20%`）当视差背景，
        同时已经跑出裁切框。宽屏时它退成左侧定宽栏，不位移。
      */}
      <nav
        className={cn(
          'absolute inset-y-0 left-0 flex w-full flex-col px-2 pb-2',
          animate ? 'translate-x-0' : 'static w-44 shrink-0',
          // 进场 / 退场都播；常驻 `transition-transform`（见文件头：`translate` 属性靠它才有过渡）
          'transition-transform duration-250 ease-[cubic-bezier(0.32,0.72,0,1)]',
          animate && !menuOpen && '-translate-x-[20%]'
        )}
        // 不在场的那一块对读屏 / Tab 隐藏：它仍在 DOM 里（退场动画要它），但不该被聚焦到
        aria-hidden={!menuOpen || undefined}
        inert={!menuOpen || undefined}
      >
        {/* 分组列表自己滚。菜单底边不再放版本号 / 仓库那一行（手机上一屏本来就紧，
            版本号在「通用」里能看到，也不必在这里抢一行高度） */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto no-scrollbar">
          {groups.map((group) => (
            <div key={group.title ?? group.items[0]?.id}>
              {group.title && (
                <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                  {group.title}
                </div>
              )}
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => pick(item)}
                  className={cn(
                    'mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm transition-colors',
                    tab === item.id
                      ? 'bg-primary-subtle text-foreground'
                      : item.tone === 'destructive'
                        ? // 底色照旧走行 hover（`bg-destructive/10` 在暗色下几乎是透明的，见 `RowAction` 文件头），
                          // 红色只负责「这是什么性质的动作」，不负责「按钮在哪」
                          'text-destructive hover:bg-primary-soft'
                        : 'text-muted-foreground hover:bg-primary-soft hover:text-foreground'
                  )}
                >
                  {/* 图标用 currentColor 描边，选中 / 悬停的颜色变化自动跟随按钮文字色 */}
                  <item.icon className="size-4 shrink-0 mr-1.5" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {/* 只有会进二级页的项才给箭头；动作项（如「退出」）点了就执行，别暗示还有下一层 */}
                  {!item.action && <ChevronRight className="size-4 shrink-0 opacity-50" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>

      {/*
        内容页：手机上是**第二块满宽屏**，平时钉在裁切框右缘之外（`left-full`），
        进二级页时滑到 `left-0`，返回时再滑回去 —— 两块各自归位。
        **它压着菜单**，所以必须自带实底（`bg-surface-1`，见文件头）；宽屏时不位移、
        不铺底，只占菜单剩下的宽度（那里它旁边没有东西可透）。

        ⚠️ 这里过渡的是 **`left`**，不是 `translate`：第二块要用 `left: 0 / 100%` 这两个
        **相对于容器宽度的百分比**定位（`translate-x-full` 的百分比是相对元素自身宽度的，
        只有在这块恰好也是满宽时才等价 —— 而宽屏时它不是满宽，两个口径就对不上了）。
        `left` 触发的是布局动画，每帧重排；但这一块里只有一层滚动容器、没有大图，手机上
        实测够用。真要再省，得换成 `translate` + 一个自算的像素位移，不值当。
      */}
      <div
        className={cn(
          'flex min-w-0 flex-col px-2 pb-2',
          animate
            ? cn(
                // `bg-surface-1`：这一块是**盖在菜单上**的整屏面板，不铺底就是透明的
                // （底下菜单的字直接透上来，见文件头「二级页必须自带实底」）
                'absolute inset-y-0 w-full bg-surface-1 transition-[left] duration-250 ease-[cubic-bezier(0.32,0.72,0,1)]',
                menuOpen ? 'left-full' : 'left-0'
              )
            : 'relative flex-1'
        )}
        // 不在场的那一块（这一块）退出 Tab / 读屏，但仍然留在 DOM 里播动画
        aria-hidden={menuOpen || undefined}
        inert={menuOpen || undefined}
      >
        {/* 宿主没接管标题栏时（窄屏 web 的弹窗）才画在这里 */}
        {!onDetailChange && (
          <div className="mb-3 flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label={tr('返回设置')}
              title={tr('返回设置')}
              onClick={back}
              className="-ml-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="truncate text-sm font-medium">{currentLabel}</span>
          </div>
        )}

        {/*
          `key={tab}`：**每个分组用自己那份滚动容器**（容器共用的话，在「通用」滚到底
          再切到「模型」，新分组会停在底部而不是顶部）。孩子本来就会随 tab 重挂。
        */}
        <div key={tab} className="min-h-0 flex-1 overflow-auto no-scrollbar py-2">
          <SettingsContent tab={tab} extraGroups={extraGroups} {...common} />
        </div>
      </div>
    </div>
  )
}
