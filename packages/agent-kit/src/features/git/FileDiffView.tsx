/**
 * 「代码修改前后对比」：git 风格的 unified diff 视图。
 *
 * 两个来源共用这一个视图：
 * - 工具卡（见 PartView 里的 `buildFileDiff`）：edit_file 的 oldText / newText 做行级
 *   diff、write_file 的整文件当作「空 → 全文」的全量新增、delete_file 只给一句提示；
 * - 源代码管理面板：`git diff` 的原始文本解析出来的 hunks（见 `parseUnifiedDiff`）。
 *
 * 不放进工具返回值、不送回模型：那样会把整文件灌进模型上下文。
 */
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { DiffHunk } from '@fizz/agent-kit/shared/lib/diff'

/** `DiffHunk` 的定义搬到了 `lib/diff`（解析器和视图共用）；这里转出，保持老引用可用 */
export type { DiffHunk }

/** 统计 hunks 的增删行数（对比视图顶部 +N / −M 用） */
function diffStat(hunks: DiffHunk[]): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') adds++
      else if (l.type === 'del') dels++
    }
  }
  return { adds, dels }
}

export function FileDiffView({
  path,
  hunks,
  deleted
}: {
  path: string
  hunks: DiffHunk[]
  /** delete_file：入参没有内容，无法对比，只提示删了哪个文件 */
  deleted?: boolean
}) {
  const t = useT()
  const { adds, dels } = diffStat(hunks)

  let oldNo = 1
  let newNo = 1

  return (
    <div className="overflow-hidden font-mono text-xs">
      {/* 文件头：路径 + 增删计数 */}
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-muted-foreground">
        <span className="truncate" title={path}>
          {path}
        </span>
        <span className="shrink-0 tabular-nums">
          <span className="text-emerald-500">+{adds}</span> <span className="text-red-500">−{dels}</span>
        </span>
      </div>

      {deleted ? (
        <div className="px-2 py-1.5 text-muted-foreground">
          {t('文件已删除（工具入参没有内容，无原文可对比）')}
        </div>
      ) : hunks.length === 0 ? (
        <div className="px-2 py-1.5 text-muted-foreground">
          {t('没有可展示的文本差异（二进制文件，或只有权限 / 模式变化）')}
        </div>
      ) : (
        // 整块 diff 正文进内容白名单（styles.css）：挂在滚动容器上，跨行拖选才连得起来。
        // 行号 / 增删号 / ± 号各自带 `select-none`（utilities 层，压得住这条），不会被一起划中。
        <div data-selectable className="overflow-x-auto">
          {/*
            min-w-max：让整块内容按**最宽的那一行**撑开（而不是被滚动容器卡在可视宽度）。
            里面的行都是块级盒子，宽度自动铺满这块内容宽 —— 增/删的行底色、片段头
            的灰底才会一直铺到横向滚动的最右侧；否则滚到右边就只剩文字、没有底色。
          */}
          <div className="min-w-max">
            {hunks.map((h, hi) => {
              // git diff 的每个片段各有起点（@@ -a,b +c,d @@），按它对上行号；
              // 工具卡的片段对比没有起点，就沿用老行为：整段从 1 连续累加
              if (h.oldStart !== undefined) oldNo = h.oldStart
              if (h.newStart !== undefined) newNo = h.newStart
              return (
                <div key={hi}>
                  {h.header && (
                    <div className="px-2 py-0.5 text-muted-foreground">
                      {h.header}
                    </div>
                  )}
                  {h.lines.map((l, li) => {
                    const oldGutter = l.type === 'add' ? '' : String(oldNo++)
                    const newGutter = l.type === 'del' ? '' : String(newNo++)
                    return (
                      <div
                        key={li}
                        className={cn(
                          // w-full：宽度铺满外层 min-w-max 的整块内容，底色才会铺到横向
                          // 滚动的最右侧（只靠内容撑宽的话，滚到右边就没底色了）
                          'flex w-full',
                          l.type === 'del' && 'bg-red-500/10',
                          l.type === 'add' && 'bg-emerald-500/10'
                        )}
                      >
                        <span
                          className={cn(
                            'w-9 shrink-0 select-none px-1 text-right tabular-nums',
                            l.type === 'del'
                              ? 'text-red-500/60'
                              : l.type === 'add'
                                ? 'text-emerald-500/60'
                                : 'text-muted-foreground/40'
                          )}
                        >
                          {oldGutter}
                        </span>
                        <span
                          className={cn(
                            'w-9 shrink-0 select-none px-1 text-right tabular-nums',
                            l.type === 'del'
                              ? 'text-red-500/60'
                              : l.type === 'add'
                                ? 'text-emerald-500/60'
                                : 'text-muted-foreground/40'
                          )}
                        >
                          {newGutter}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 select-none px-1',
                            l.type === 'del'
                              ? 'text-red-500'
                              : l.type === 'add'
                                ? 'text-emerald-500'
                                : 'text-muted-foreground/50'
                          )}
                        >
                          {l.type === 'del' ? '−' : l.type === 'add' ? '+' : ' '}
                        </span>
                        <span
                          className={cn(
                            'whitespace-pre px-1',
                            l.type === 'del'
                              ? 'text-red-300'
                              : l.type === 'add'
                                ? 'text-emerald-300'
                                : 'text-foreground/80'
                          )}
                        >
                          {l.text === '' ? ' ' : l.text}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
