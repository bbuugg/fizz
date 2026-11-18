/**
 * 主视图的顶部工具条（目前只有对话页在用）。
 *
 * 之前三个视图各手写一份 `h-12`，于是「高度一样、细节全不一样」：流程那条多一条
 * `border-b`、标题是 `text-sm font-semibold px-2`、按钮 `h-8`；任务那条干脆不是一个
 * 工具条（`px-5 py-3` 的标题块 + 工作台自带的第二条 `h-12`）。抽出来之后「顶栏长
 * 什么样」只有这一处定义。
 *
 * 结构：**左**是名字（可选再挂一行次要信息）/ **右**是操作区。
 *
 * ## 第二行是**可选**的，没有就不占位
 *
 * 早先这里恒定渲染一条 `h-4` 的空行（为了「切视图时顶栏高度不跳」）。但对话页现在
 * 不显示分支了，那条空行就变成一段白留白 —— 表现为「名字和下面的正文之间隔得有点大」，
 * 而且只在没有分支名的时候出现（用户反馈）。所以改成：**传了 `subtitle` 才有第二行**，
 * 没有就整条顶栏只有一栏高，名字与右侧按钮同处一行、垂直居中。
 *
 * 代价是「有 / 无第二行」时顶栏高度不同（差 16px）。现在只有一个视图用它，不存在
 * 切视图跳一下的问题；将来真有第二个视图要共用，请给两个视图传同样有无的 `subtitle`。
 *
 * ## 手机端顶栏不再有「展开侧栏」按钮
 *
 * 早先最左有一颗 `PanelLeft`（打开侧栏抽屉）。手机上侧栏的入口已经收拢到底部状态栏
 * （「侧栏」直接拉出当前功能区的抽屉、「功能区」开功能区列表）—— 顶栏这颗是第三个
 * 入口，纯冗余，且它把标题往右挤了一格。拆掉之后手机与桌面的顶栏长得一样。
 */
import type { ReactNode } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function ViewHeader({
  title,
  titleHint,
  afterTitle,
  subtitle,
  subtitleHint,
  leading,
  trailing,
  className
}: {
  /** 名字（会被截断，长名字靠 `titleHint` 看全） */
  title: ReactNode
  /** 名字的 hover 提示 */
  titleHint?: string
  /** 紧贴名字右侧的东西（状态徽标 / 连接状态点） */
  afterTitle?: ReactNode
  /**
   * 名字**下面**那一行（分支 / 基线 / 时间…）。**不传就没有这一行**，顶栏只有一栏高
   * —— 留一条空行会让名字与下方正文之间凭空多出一段间距。
   */
  subtitle?: ReactNode
  /** 第二行的 hover 提示（第二行同样会被截断） */
  subtitleHint?: string
  /** 名字左侧的额外内容 */
  leading?: ReactNode
  /** 右侧操作区 */
  trailing?: ReactNode
  className?: string
}) {
  const hasSubtitle = subtitle !== undefined && subtitle !== null && subtitle !== false
  return (
    <header
      className={cn(
        'flex shrink-0 gap-1 p-2 sm:px-3',
        // 只有一栏时按钮与名字垂直居中；两栏时按钮顶对齐，免得被第二行拖着往下沉
        hasSubtitle ? 'items-start' : 'items-center',
        className
      )}
    >
      {leading}
      <div className={cn('flex min-w-0 flex-1 flex-col justify-center', hasSubtitle && 'gap-1')}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base font-medium leading-tight" title={titleHint}>
            {title}
          </span>
          {afterTitle}
        </div>
        {hasSubtitle ? (
          <div
            className="flex h-4 min-w-0 items-center gap-3 overflow-hidden text-xs leading-tight text-muted-foreground"
            title={subtitleHint}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{trailing}</div>
    </header>
  )
}
