"use client";

/**
 * 功能区侧边栏的**外壳**：手机抽屉形态 / 桌面占位形态、宽度、遮罩。
 *
 * 活动栏里的每个功能区都有自己的侧边栏面板（见 `app/activities.tsx`），面板本身只管
 * 内容；「它长什么样、多宽、手机上怎么进出」是**每个功能区都一样**的部分 —— 抽到这里，
 * 免得每加一个功能区就抄一遍手机抽屉那串类名（抄漏一处就是「手机版侧栏关不掉」）。
 *
 * 刻意**不含**头部 / 底部：那两块各功能区差别很大（AI Agent 不要顶栏、主机是标题 + 添加菜单，
 * 插件面是插件自己声明的），硬塞进来会变成一个到处是插槽的万能组件。
 *
 * ⚠️ 往上还有一层 `shared/components/SidebarScaffold`：它把「本组件 + 顶部栏 +
 * `StackedSections` 分区容器」拼成功能区侧栏的通用骨架（主机 / 接口请求 / AI Agent 用它）。
 * **别把两者合并**：这一层管像素级行为（抽屉内缩、过渡与阴影、`h-full` 与 `top/bottom`
 * 的过约束……），那一层管面板视觉结构。混在一起后，改抽屉动画得先读完那几个槽位。
 *
 * ## ⚠️ 手机抽屉必须**避开常驻 chrome**（踩过一次）
 *
 * 抽屉原先写的是 `fixed inset-y-0 left-0 w-72`：铺满整屏左半边，**连活动栏、顶部顶栏与
 * 底部状态栏一起盖住**。症状是用户报的「手机版 功能区展开后 第一个图标（AI）点不动」——
 * 竖条（`w-10`）和状态栏左侧那组入口（菜单 / 功能区 / 侧栏，都在 `x≈8..96`）全在
 * `w-72` 的抽屉底下，`elementFromPoint` 打到的是抽屉自己的品牌 logo。
 *
 * 根因还是 §60 那条老规矩：**常驻的东西不能被「会展开 / 收起」的容器盖住**。竖条是
 * 「切功能区」的唯一入口、状态栏是全局入口条、顶部 `WebTitleBar` 放着品牌与「收起侧栏」
 * 那颗按钮，三者都必须一直点得到。所以手机抽屉往内缩三条边：
 *
 * - **上**：顶部 `WebTitleBar` 的高度（`h-9`），它与下面两条同色，缩进来视觉上无缝；
 * - **左**：竖条占位时留出它的宽度 `w-10`（`2.5rem`）—— 竖条与抽屉同进同出，所以
 *   「竖条不在」就等于「抽屉没开」，这条内缩直接由抽屉状态派生（见下面 `mobileInset`）；
 * - **下**：底部状态栏的高度（`h-9` = `2.25rem`）。两者同色（都是 `bg-sidebar`），
 *   缩进来视觉上无缝，只是不再压住那些入口。
 *
 * 抽屉与遮罩**都要缩**：只缩抽屉不缩遮罩的话，竖条虽然点得到，却被半透明遮罩压暗，
 * 看起来仍是「不可点」的。
 *
 * ⚠️ 左边那条内缩读的是 **`--sidebar-mobile-inset`**（定义在
 * `ui-tokens/src/tokens.css`，默认 `2.5rem` = 竖条宽度）。**安卓壳**整个不要活动栏，
 * 由它自己的 `styles.css` 把这个 token 覆盖成 `0` —— 形态差异走 token，不给这个组件加
 * 「有没有竖条」的 prop，否则每端一种形态，API 就会长成一串 `xxxRail` 开关。
 */
import type { ReactNode } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'

export function ActivitySidebar({
  width,
  mobileOpen,
  onMobileOpenChange,
  forceDrawer = false,
  children
}: {
  /** 桌面端宽度（px）：由 AppShell 持有并持久化（右缘拖拽条也在 AppShell） */
  width: number
  /** 手机端抽屉开关（isMobile 时生效） */
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
  /**
   * **强制抽屉形态**，不看视口宽度。
   *
   * 默认（`false`）按 `useIsMobile()` 的 768px 断点判形态，这是 web / desktop 的语义：
   * 窄屏变抽屉、宽屏是占位的一列。
   *
   * 手机壳（`apps/mobile`，以及复用它的 Chrome 扩展 `apps/extension`）必须传 `true`：
   * 那两端的**整个外壳**都是手机形态写死的（见 `apps/mobile/src/app/app-shell.tsx`
   * 的文件头），侧栏只有抽屉这一种形态，`width` 恒为 0。一旦窗口比 768px 宽
   * （扩展侧栏被拖宽 / 在大屏上开成标签页），断点判定会让它落进桌面分支 ——
   * 那支按 `width` 占位，于是侧栏变成 **0 宽且没有任何开关** 的一条缝，
   * 用户报的「屏幕宽了侧栏就展不开」就是这个。
   *
   * ⚠️ 别把这件事做成「把全局断点改大」：断点变的是**所有**共享组件的形态
   * （`useIsMobile` 还管着模型选择器是下拉还是抽屉、工具卡是不是触摸交互），
   * 那些地方在宽屏 + 鼠标下仍该用桌面形态。要强制的是**这一个外壳的这一个分支**。
   */
  forceDrawer?: boolean
  children: ReactNode
}) {
  /**
   * 形态判定：`forceDrawer` 优先。
   *
   * hook 必须无条件先调用（`useIsMobile` 内部是 `useState` + `useEffect`），
   * 再把结果和 prop 合起来 —— 不能写成 `forceDrawer ? true : useIsMobile()`（条件 hook）。
   */
  const isMobile = useIsMobile() || forceDrawer
  /**
   * ⚠️ 抽屉的**可见性**用传进来的 `mobileOpen`，**不是**模块状态 `useMobileSidebarOpen()`。
   *
   * 两者名字像，来源却不同：`mobileOpen` 一路从 `AppShell` 的 `useAppContext()` 传下来
   * （与 `AppShell` 画遮罩用的是同一个值），而 `useMobileSidebarOpen()`
   * 是 store 自己的订阅 —— Provider 为了少渲染一点可能把它**选择器化**（只在真正开合时
   * 才更新）。一旦两者有一拍之差，抽屉就会与遮罩脱节，表现为**「点两下才展开」**：
   * 第一下把 store 打开（遮罩出来），抽屉却还留在关闭态，第二下才跟上。
   *
   * 下面 `mobileInset` 里「开着才让位」的判断之所以成立，靠的就是这里同源
   * （遮罩与抽屉读同一个值）。
   */
  const open = mobileOpen

  /**
   * 手机抽屉要避开的两条常驻边（见文件头「手机抽屉必须避开常驻 chrome」）：
   * 上边留出顶栏（`--app-titlebar-height`）、下边留出状态栏（`--status-bar-height`），
   * 两边都再加上系统栏安全区；左边让出**活动栏竖条**的宽度
   * （`--sidebar-mobile-inset`，默认 `2.5rem`）。没有竖条的外壳（安卓壳）把这个 token
   * 覆盖成 `0`，于是自然贴左缘 —— 这里不需要任何「有没有竖条」的开关。
   *
   * 「开着才让位」：竖条与抽屉同进同出，抽屉关着时左边没有任何常驻 chrome。
   */
  const mobileInset = isMobile && open ? 'left-[var(--sidebar-mobile-inset)]' : 'left-0'

  return (
    <>
      {/* 手机：固定定位的覆盖抽屉（选中即收起）；桌面：占位侧栏 + 可拖拽宽度 */}
      {/*
        `data-fizz-sidebar`：主题层的**作用域钩子**（规则在 `ui-tokens/src/themes.css`）。
        侧栏里的文字 / 分隔线 / 悬停底用的是通用变量（`text-foreground`、`border-border`、
        `hover:bg-accent`），不是 shadcn 那套 `--sidebar-*`；没有这个属性的话，主题里改
        「侧栏文字」永远没人听（踩过：用户报「侧栏文字改了不起作用」）。
        别把它当样式类用，也别在别处复制 —— 加宽 / 改色都不该动这个标记。
      */}
      <aside
        data-fizz-sidebar=""
        className={cn(
          'flex min-w-0 flex-col',
          isMobile
            ? cn(
              // 抽屉关着时必须整个 `invisible`：原来只是把抽屉 `-translate-x-full` 推出
              // 屏幕，Tab / 读屏仍然能碰到里面的按钮（宿主的投影也同理 —— 画在元素右缘
              // 之外，抽屉走了影子还留在视口左缘）。
              //
              // 用 `invisible` 而不是干脆不渲染：`visibility` 会跟着过渡走
              // （规范：只要有一端是 visible，过渡期间都按 visible 渲染，最后一刻才翻成 hidden），
              // 所以滑出动画完整播完才彻底消失，不会「刷」一下没。
              // ⚠️ 过渡属性必须把 `translate` 带上：`-translate-x-full` 用的是 CSS 的
              // **`translate`** 属性（不是 `transform`），而 Tailwind v4 的 `transition-transform`
              // 展开是 `transform, translate, scale, rotate` 四个 —— 直接写
              // `transition-[transform,visibility]` 会让抽屉变成「瞬移」（实测产物 CSS 里
              // `.transition-transform` 确实是四条属性）。这里就是那四条 + visibility。
              //
              // ⚠️ 上沿读 `--sidebar-drawer-top`、下边避让状态栏，两边都加系统栏安全区 ——
              // **不写死 `top-9`**：web / desktop 的抽屉从顶栏下沿开始，安卓壳连顶栏一起
              // 盖住（`MobileAppBar` 是 `h-11`，状态栏整条不渲染）。上沿必须走 token：
              // 抽屉与遮罩是同一条边，各写一份就会露出半截可点的顶栏（见 token 处的注释）。
              // 安全区必须算进来：`fixed` 相对视口定位，外壳容器上的
              // `padding-top: var(--safe-area-inset-top)` 根本不作用到它。
              //
              // ⚠️ 宽度是 `w-64`（256px）而不是早先的 `w-72`：手机形态左边已经多了竖条
              // （`w-10`）与顶部顶栏，抽屉再占 288px，内容区就只剩一条缝。
              //
              // ⚠️⚠️ 这里**绝对不能带 `h-full`**（踩过一次）：`h-full` = `height:100%` 会与
              // `top-*` + `bottom-*` 一起构成「过约束」，按 CSS 规则 `height` 与 `top` 胜出、
              // `bottom` 被忽略 —— 抽屉照样铺满整屏高，`bottom-*` 形同虚设，底部状态栏那排
              // 入口仍被盖住（实测：computed `bottom:36px`，但 rect 高度仍是 844）。所以
              // `h-full` 只在**桌面占位**那支里给（那里没有 top/bottom，靠它撑满列高）。
              'fixed top-[var(--sidebar-drawer-top)] bottom-[calc(var(--safe-area-inset-bottom,0px)_+_var(--status-bar-height))] z-40 w-64 max-w-[78vw] bg-sidebar transition-[transform,translate,scale,rotate,visibility] duration-200',
              mobileInset,
              mobileOpen ? 'translate-x-0' : '-translate-x-full invisible'
            )
            : 'h-full shrink-0'
        )}
        style={isMobile ? undefined : { width }}
      >
        {children}
      </aside>
      {/* 手机抽屉的遮罩：点一下收起。底色读 `--sidebar-scrim`（默认 `foreground/30`，
          安卓壳覆盖成 `transparent` —— 那边正文是被推走的，不需要压暗，见 token 处的注释）；
          高斯模糊读 `--sidebar-scrim-blur`（安卓壳覆盖成 `0`，理由同前）。
          **与抽屉同一条内缩**（见文件头）—— 不缩的话竖条虽然点得到，却被压暗，
          看起来仍像不可点。上沿也与抽屉同一个 token：不然顶栏右半截露在遮罩之外，
          点那颗按钮不会收起抽屉。 */}
      {isMobile && mobileOpen && (
        <div
          className={cn(
            'fixed top-[var(--sidebar-drawer-top)] bottom-[calc(var(--safe-area-inset-bottom,0px)_+_var(--status-bar-height))] right-0 z-30 bg-[var(--sidebar-scrim)] backdrop-blur-(--sidebar-scrim-blur)',
            mobileInset
          )}
          onClick={() => onMobileOpenChange(false)}
        />
      )}
    </>
  )
}
