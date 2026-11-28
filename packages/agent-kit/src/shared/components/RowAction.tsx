/**
 * **行尾动作按钮**：hover 整行才在右缘浮现的那颗小图标钮。
 *
 * 会话行、项目行、主机行、主区域的标签行末用的都是同一颗。原先每处各写一份类名
 * 字面量（`AgentSidebar` / `HostsSidebar` / `QuickActionsDialog` / `PanelView` 各一份），
 * 于是「hover 底色」这种最该一致的地方反而最容易走样 —— 标签那颗里的
 * `hover:bg-destructive/10` 就是这样漂出来的：**暗色主题下 `--destructive` 是暗红，
 * 10% 叠在深色标签底上几乎是透明的**，而会话行用的 `hover:bg-foreground/10` 在暗色下
 * 是 10% 白，肉眼清楚。同一个交互在不同位置给出两种可见度。
 *
 * ## 为什么不直接用 `hover:bg-destructive/10`
 *
 * 半透明色（`/10`）的可见度**完全取决于它叠在什么底色上**，而 tab 的底色随激活 /
 * 悬停变、会话行的底色又是另一套 —— 拿语义色拼半透明等于把结果交给运气。这里统一用
 * `foreground`（会话行同一套）：它是「当前文字色」，在亮 / 暗两个主题下都会变成
 * 「比底色明显一点的同色系」，不需要为每种底色单独调。
 *
 * 摧毁性动作（关闭 / 删除 / 归档）想要红色提示的，把 `hover:text-destructive` 加在
 * `className` 上即可 —— 底色照旧是这套（`HostsSidebar` 的删除、会话行的归档都是
 * 这个组合），红色只负责「这是什么性质的按钮」，不负责「按钮在哪」。
 */
import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/**
 * 行尾动作按钮的**共用水底**。
 *
 * - `p-0.5`：图标 14px + 一圈 2px ≈ 18px 的可点面积（会话行那套）；
 * - `transition-[background-color,color,opacity]`：底色 / 字色 / 显形都要过渡。
 *   会话行外层那层浮层靠 `opacity` 淡入淡出，所以 opacity 不能漏；
 * - `[@media(hover:none)]:p-1.5`：触摸设备没有 hover 态，按钮常显，可点面积相应放大
 *   （判的是**能力**而不是视口宽度，理由见 `lib/supports-touch.ts` 文件头）。
 */
export const ROW_ACTION_CLASS =
  'rounded p-0.5 text-muted-foreground transition-[background-color,color,opacity] hover:bg-foreground/10 [@media(hover:none)]:p-1.5'

/**
 * 行尾动作按钮的**显形**：平时透明，hover 所在行 / 自身获得焦点时显示，触摸设备常显。
 *
 * ⚠️ 触发行必须带 `group/row`（命名 group）—— 用裸 `group-hover:` 会被外层任何 `group`
 * 误触发（消息气泡上就挂着 group，结果一轮里所有按钮一起亮，见 `lib/hover-reveal-arrow.ts`）。
 * ⚠️ Tailwind v4 把 `group-hover:` 包进 `@media (hover:hover)`，触摸端必须补常显，
 * 判的是能力 (`hover:none`) 而不是视口宽度（理由见 `lib/supports-touch.ts`）。
 */
export const ROW_ACTION_REVEAL_CLASS =
  'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'

/** 行尾动作按钮：`type="button"` 兜底 + 与共用底板拼接 `className` */
export function RowActionButton({
  className,
  ...rest
}: ComponentPropsWithoutRef<'button'>): React.ReactElement {
  return <button type="button" className={cn(ROW_ACTION_CLASS, className)} {...rest} />
}
