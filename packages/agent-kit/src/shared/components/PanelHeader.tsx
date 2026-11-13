/**
 * 主区域工具面板的顶栏：**左标题（+ 一行说明）、右动作**，恒在同一行。
 *
 * ## 为什么抽这一层
 *
 * 定时任务 / 脚本 / 应用日志 / SSH 隧道四页本来就是同一套版式，各写一遍的结果是
 * 「隧道那份 `text-sm font-medium` + `px-3 py-2` + 图标钮刷新，另外三份 `text-base
 * font-semibold` + `px-4 py-3 sm:px-5` + 带字按钮」—— 切标签时标题跳字号、按钮跳位置。
 * 尺寸、间距、收窄规则现在只在这里一份。
 *
 * ## 两条硬约束
 *
 * - 标题块 `min-w-0`、动作区 `shrink-0`：动作区是一整排按钮，不让步；该被压缩的是标题。
 *   反过来写的话（两边都 `shrink-0`）窄容器下整行溢出，标题直接被挤出可视区。
 * - 动作按钮里的文案用 `PanelHeaderActionLabel` 包起来：容器窄于 32rem 时只留图标
 *   （`aria-label` 兜无障碍名）。判据是**这个顶栏自身**的宽度（`@container` 容器查询），
 *   不是视口 —— 这些面板会被拖进分栏 / 浮窗，窗口仍然很宽而这里只有几百像素。
 *
 * 不用 `flex-col` 竖排来「避免挤压」：竖排等于把新建 / 刷新挪到标题下面，长年用下来
 * 那一排按钮的位置和别的面板对不上（用户报过）。
 */
import type { ReactNode } from 'react'

export function PanelHeader({
  title,
  description,
  actions
}: {
  /** 标题（可以是节点：应用日志要在标题后面挂一颗「命名空间未注册」提示） */
  title: ReactNode
  /** 标题下面那行说明；不传就只显示标题 */
  description?: ReactNode
  /** 右侧动作区（一排按钮）；不传就只显示标题 */
  actions?: ReactNode
}) {
  return (
    <div className="@container flex shrink-0 items-start justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h1 className="text-base font-semibold">{title}</h1>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/**
 * 动作按钮的可收起文案：顶栏够宽才显示，窄了只剩图标。
 *
 * 只包**文字**，图标留在外面 —— `Button` 的 `has-[>svg]:px-2.5` 靠子 svg 生效，
 * 包在里面的图标一样能命中，但把 svg 留在外层读起来更清楚。`aria-label` 得挂在
 * `Button` 上，别指望隐藏的这段文字被读屏念出来。
 */
export function PanelHeaderActionLabel({ children }: { children: ReactNode }) {
  return <span className="hidden @lg:inline">{children}</span>
}
