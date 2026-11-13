"use client";

/**
 * 侧栏「分区」模块（从 dogi 的 `shared/components/StackedSections.tsx` 平移）。
 *
 * 把一条侧栏纵向切成若干段，每段由一段**静态标签 + 内容**组成。**侧栏面板只负责往插槽里
 * 填东西**，「空间怎么分」全部由这里统一负责 —— 免得每加一个面板就抄一遍
 * 那串 flex / min-height 的类名。（分区级的高度拖拽已移除；内容组之间的拖动见
 * `shared/components/SidebarGroups`。）
 *
 * ## 分区**不折叠**（曾经可以，已移除）
 *
 * 标题现在是 shadcn `SidebarGroupLabel` 的形态：一行 12px 的灰字，**不是按钮**。
 * 原来标题栏带一颗箭头、点标题也能开合，理由是「分区多、想给下面的清单让高度」；
 * 实际用下来这套交互反而制造了三种问题，所以整条链路（折叠态 store、箭头、`display:none`）
 * 一起删了，不再保留「某些分区可折叠」的开关。
 *
 * ⚠️ 后来 `SectionHeader` 又长出了一个 `onToggle`，但它服务的**不是分区**，而是同一个
 * 滚动区里的**内容组**（AI Agent 侧栏的临时任务 / 工作区 / 定时任务）：折叠只切内容、
 * 不动布局高度、状态由调用方存内存（不落盘）。所以上面这三条教训依然成立 ——
 * 别把这个 prop 当成「分区折叠回来了」到处挂：
 *
 * 1. 折叠态落盘在 localStorage，改默认值 / 删分区之后老数据会把内容永久藏起来，
 *    而入口（那颗箭头）可能已经不在；
 * 2. 侧栏里已经有「项目行」的展开 / 收起，两套长得一样的箭头干不同的事；
 * 3. 标题的视觉语言和列表行打架 —— 15px 深色 + 悬停变深，看着比清单本身还重。
 *
 * 分区**不可拖高度**（曾经可以，已移除）：拖拽改高度是**内容组**的事（标题行就是抓手，
 * 见 `SidebarGroups`），分区只按 `grow` 权重瓜分空间。
 *
 * ## 空间分配规则
 *
 * - 每个分区按 `grow` 权重瓜分剩余空间，但永远不小于 `minHeight` —— 空间不够时先吃掉
 *   弹性部分，最小高度始终保留，任何分区都不会被挤出可视区；
 * - 极端情况下（窗口很矮、所有分区的最小高度之和超过侧栏）由容器整体滚动兜底。
 *
 * ## 用法（每个分区三段式，顺序固定）
 *
 * ```tsx
 * <StackedSections>
 *   <SectionShell grow={2} minHeight={200}>
 *     <SectionHeader title="主机" count={n} extra={<Button …/>} />
 *     <SectionContent>…列表…</SectionContent>
 *   </SectionShell>
 *   <SectionShell>…</SectionShell>
 * </StackedSections>
 * ```
 *
 * `SectionShell` 只收布局参数；`SectionHeader` / `SectionContent` 不需要任何状态。
 */
import type { PointerEventHandler, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { ROW_ACTION_CLASS } from "@fizz/agent-kit/shared/components/RowAction";

/**
 * 分区容器：纵向排列 + 整体滚动兜底（每个分区的滚动由自己的 SectionContent 负责）。
 *
 * `flex-1`（而不是 `h-full`）：侧栏外壳是个 `flex-col`，容器常常还有别的兄弟 ——
 * AI Agent 侧栏下面挂着 git 告警行（现在经由 `SidebarScaffold` 的 `footer` 槽）。
 * `h-full` 会让容器按整列高去占位，与那个兄弟一叠加就溢出、把底部的行挤出可视区；
 * `flex-1` 拿的是**剩余**高度，有没有兄弟都对。只有自己一个孩子时两者等价。
 *
 * ⚠️ 实际调用方**只有 `SidebarScaffold`** 一个（几个功能区侧栏都从那里进来）。
 * `className` 留着当兜底微调口，但**别用它补顶部留白**：AI Agent 侧栏曾经传
 * `className="pt-2"`，理由是「侧栏顶边紧贴窗口上沿、标题像被裁了一半，也和有顶栏的
 * 主机 / 接口请求对不齐」—— 那等于把「头顶没有东西」伪装成「头顶有一条看不见的栏」，
 * 纯占地方（见 §76）。要让这条侧栏的顶部有内容，就把内容填进 `SidebarScaffold` 的
 * `label` 走顶部栏，而不是补 `padding`。
 */
export function StackedSections({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}
    >
      {children}
    </div>
  );
}

/**
 * 分区外壳：负责弹性尺寸与最小高度约束。
 *
 * 分区**不可拖高度、不折叠**（见文件头）：高度完全由 `grow` 权重分配。
 */
export function SectionShell({
  grow = 1,
  minHeight = 160,
  className,
  children,
}: {
  /** 参与瓜分剩余空间的权重（同一容器内相对值），默认 1 */
  grow?: number;
  /** 最小高度（px），空间被挤压时也不会小于它，默认 160 */
  minHeight?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative flex min-h-0 flex-col",
        className,
      )}
      style={{ flex: `${grow} 1 0`, minHeight }}
    >
      {children}
    </section>
  );
}

/**
 * 分区标题：默认是**一行静态标签**（不是按钮、不带箭头、点不动）。
 *
 * 形态对齐 shadcn 的 `SidebarGroupLabel`（12px、`font-medium`、`px-2`、`h-8`、灰字），
 * 这样它与「临时会话 / 归档里的项目名」那些组内小标签是同一档 —— 侧栏里只有
 * **一档标题**，层级靠缩进和分隔线表达，不靠字号。
 *
 * 曾经是 15px 深色 + 一颗折叠箭头，还专门写过「字号只能有一档」的注释去压制两档字号；
 * 现在连「标题要不要更重」这个问题都不存在了：它比清单行（`text-sm`）**更小更淡**，
 * 是标准的 group label 语义。
 *
 * `extra`（刷新 / 添加 / 启用数…）留在右边，用 `ml-auto` 顶过去 —— 原来靠标题按钮的
 * `flex-1` 撑着，标题不再是弹性元素之后必须显式推。
 *
 * ## 传 `onToggle` 才可折叠（AI Agent 侧栏的「内容组」在用）
 *
 * 文件头说的「分区不折叠」针对的是 `SectionShell` 那种**按高度瓜分**的分区：它的折叠态
 * 曾经落盘、又和项目行箭头抢同一套视觉语言。这里给的是另一种东西 —— 同**一个**滚动区里
 * 的内容组（临时任务 / 工作区 / 定时任务），折叠**只切内容、不动布局高度**、状态由调用方
 * 存在内存里（不落盘，刷新即回默认展开）。
 *
 * 所以别把它当成「分区折叠回来了」：`SectionShell` 依然没有折叠能力，高度也不参与分配。
 * 有 `onToggle` 时整行可点，`extra` 里的按钮会 `stopPropagation`，避免点刷新顺带收起。
 *
 * ## 传 `onPointerDown` 就兼作高度拖拽把手
 *
 * `SidebarGroup` 把**下面那组**的标题行当两组交界处的抓手（见 `SidebarGroups` 文件头）：
 * 指针管线由调用方给（`useDragResize`），这里只负责挂上去 + 关掉触摸滚动。
 * 悬停光标**保持折叠按钮原来的 pointer**（不预先变成 resize 光标），只有 `dragging`
 * 期间才切成 `grab`。点击折叠照旧 —— 拖动与点击的区分（位移死区、吞掉松手那次 click）
 * 在调用方，标题行本身不掺和。
 *
 * ## 和顶部动作左对齐靠 `ps-10`，不摆图标
 *
 * 组标签**不摆图标**（它只是标签，摆图标就成了「第二个文件夹」，还和下面项目行的
 * 目录图标抢同一个位置），对齐靠内边距：AI Agent 侧栏顶部那两颗动作是
 * `px-2`(容器) + `px-2`(按钮) + `size-4`(图标) + `gap-2` = **40px** 起排文字，
 * 组标签就用 `ps-10`（40px）顶到同一条基准线 —— 差一个像素都能看出来，所以这里
 * 不用「视觉容差」糊过去，直接对齐到数值。
 *
 * ## 箭头藏在名字**后面**、hover 才现形
 *
 * 箭头排在 `title (count)` **之后**，且 `opacity-0` → 行 hover / 键盘聚焦才
 * `opacity-100`（与项目行、会话行的行尾按钮同一套：触摸端没有 hover，用
 * `max-md:opacity-100` 常显）。它跟在文字后面，不会把标题顶歪。
 *
 * 箭头本身还带一圈 18px 的圆角 hover 底色（`hover:bg-foreground/10`，与行尾动作
 * 按钮同一档）：整行虽然也能点，但侧栏里「文字标签」和「能点的小按钮」是两种视觉，
 * 只画裸图标时用户不会去点它 —— 三条侧栏（任务 / 工作区、主机与终端、笔记）的组
 * 折叠入口都是这一颗，别只改其中一条。
 */
export function SectionHeader({
  title,
  count,
  dot = false,
  alignIndent = false,
  extra,
  className,
  open = true,
  onToggle,
  onPointerDown,
  dragging = false,
}: {
  title: string;
  /** 标题后的数量（不传、**或为 0** 都不显示括号，见渲染处注释） */
  count?: number;
  /**
   * 标题后那颗小红点：组**收起来的时候**也能看出「里面有一轮跑出来的东西还没看过」
   * （AI Agent 侧栏的「任务」组在用，见 `AgentSidebar`）。
   *
   * 只表达「有未查看」，不带数字：数字回答的是「有几条」，两者混在一起
   * （`任务 (3) •`）反而没人读得懂。
   */
  dot?: boolean;
  /**
   * 缩进到 40px（`ps-10`）：AI Agent 侧栏三个内容组开着它，组标签就与顶部
   * 那两颗带图标的动作左对齐。见文件头说明。
   */
  alignIndent?: boolean;
  /** 标题栏右侧操作区（按钮等） */
  extra?: ReactNode;
  className?: string;
  /** 内容是否展开（仅在传了 `onToggle` 时有意义，用来画箭头方向） */
  open?: boolean;
  /** 传了才可折叠：点整行切换（见上方说明） */
  onToggle?: () => void;
  /**
   * 标题行兼作高度拖拽把手时传入（指针管线由调用方提供，见上方说明）。
   * 传了会关掉触摸滚动。
   */
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  /** 正在拖这个把手：光标切成 `grab`（悬停时仍是折叠按钮的 pointer） */
  dragging?: boolean;
}) {
  const tr = useT();
  const collapsible = Boolean(onToggle);
  const draggable = Boolean(onPointerDown);
  return (
    <div
      className={cn(
        "group/header flex h-8 shrink-0 items-center gap-1.5 px-2",
        // 可折叠时整行是个按钮：圆角 + 悬停底色，视觉上才认得出「这里能点」
        collapsible &&
          "rounded-md transition-colors hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
        // 光标三态互斥（两个 cursor 工具类同时写，谁生效取决于产物 CSS 顺序，
        // 见 `ResizeHandle` 里同类注释，不能靠「后写的赢」）：
        // 平时 = 折叠按钮的 pointer；拖动中 = grab
        collapsible && !dragging && "cursor-pointer",
        dragging && "cursor-grab",
        draggable && "touch-none select-none [-webkit-touch-callout:none]",
        className,
      )}
      // 用 div + role 而不是 <button>：`extra` 里就是按钮，button 套 button 是非法结构
      role={collapsible ? "button" : undefined}
      tabIndex={collapsible ? 0 : undefined}
      aria-expanded={collapsible ? open : undefined}
      title={draggable ? tr('拖动调整高度') : undefined}
      onPointerDown={onPointerDown}
      onClick={onToggle}
      onKeyDown={
        collapsible
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle?.();
              }
            }
          : undefined
      }
    >
      <span className="truncate text-xs font-medium text-muted-foreground">
        {title}
      </span>
      {/*
        `0` 不显示：括号里那个数回答的是「这里面有几条」。空的时候它只会是噪音 ——
        侧栏上「工作区 (0)」「任务 (0)」读起来像故障，而且每块都顶着 `(0)` 时没有
        任何一块显得「可以进去看看」。收起态的箭头仍然在（入口不受影响）。
      */}
      {count !== undefined && count > 0 && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          ({count})
        </span>
      )}
      {dot && (
        // 与数量分开：数量是「有几条」，红点是「有一条跑完还没看」
        <span
          aria-label={tr('有未查看的内容')}
          title={tr('有未查看的内容')}
          className="size-1.5 shrink-0 rounded-full bg-destructive"
        />
      )}
      {collapsible && (
        /*
          名字后面那颗箭头：hover / 键盘聚焦才浮现（见文件头「箭头藏在名字后面」）。

          外面套一层 18px 的圆角底（`p-0.5` + `rounded` + `hover:bg-foreground/10`）：
          与行尾动作按钮（`RowAction` 的共用底板）、主机侧栏分组行那颗箭头是**同一套
          按钮语言**。用户反馈「任务 / 工作区 / 主机与终端 / 笔记右边那颗折叠按钮，
          hover 上去背景没变化，看不出来能点」—— 它确实能点（整行也能点），只画一颗
          裸图标等于把可点性藏起来。

          ⚠️ 底色与「显形」都挂在**外层 span**，图标只负责旋转：两个 `opacity` 工具类
          写在同一个元素上时谁生效取决于产物 CSS 顺序（主机分组行踩过这个坑，见
          `HostsSidebar` 里「压暗要落在图标上」那条注释）。这里只有一份 opacity，安全。
        */
        <span
          className={cn(
            // 底板复用行尾动作按钮那份（`RowAction`）：圆角、`p-0.5`、hover 底色、
            // 触摸端放大可点面积都在里面，别在这里再写一遍字面量
            ROW_ACTION_CLASS,
            "flex shrink-0 items-center justify-center",
            "opacity-0 group-hover/header:opacity-100 group-focus-visible/header:opacity-100 max-md:opacity-100",
          )}
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
        </span>
      )}
      {extra && (
        <div
          className="ml-auto flex shrink-0 items-center"
          // 操作区自己的点击不该冒泡成「折叠 / 展开」，按按钮也不该起拖高度
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {extra}
        </div>
      )}
    </div>
  );
}

/**
 * 分区内容：恒显示（`flex` 列 + 自己滚动），没有「收起」这回事了。
 *
 * 内容自身负责滚动（`min-h-0 flex-1 overflow-y-auto`）。
 */
export function SectionContent({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {children}
    </div>
  );
}
