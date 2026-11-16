/**
 * 消息下方的**交付物卡片**：本轮写出 / 改动的 markdown 文档各渲染成一张小卡
 * （识别见 `shared/lib/artifacts.ts` 的 `presentedDocsOf`）。
 *
 * 为什么放在消息下方的独立一行、而不是塞进正文或工具卡：
 * - 正文是**模型说的话**，工具卡是**过程**（一轮结束还会被折叠进「工具调用 ×N」里）——
 *   两者都不适合承载「给你的交付物」；
 * - 文档入口要能**离消息最近**、且点一下就到位，独立一行是唯一稳定的位置
 *   （与用量统计 `renderFooter`、操作行 `renderActions` 并列，见 `chat-surface.tsx`）。
 *
 * 视觉是**一张文件卡**，不是一排标签：图标块 + 文件名（主）+ 所在目录（次），
 * 悬停底色加深、右侧箭头淡入。早先是 `px-2 py-1 text-xs` 的灰底 chip 带一个常驻的
 * 「查看」二字 —— 侧栏一窄就挤成折行的小标签，既不像交付物、又占宽度。现在竖排一列、
 * 宽度封顶（`max-w-sm`），多份文档也不会把消息区撑成一排散落的药丸。
 *
 * 仍然**不用主题色**：这只是「交付物入口」，一排主题色卡片会把消息区抢成广告位。
 */
import { ArrowUpRight, FileText } from 'lucide-react'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { PresentedDoc } from '@fizz/agent-kit/shared/lib/artifacts'

/** 路径里的目录部分（'docs/a.md' → 'docs'）；文件就在工作区根上则返回 '' */
function dirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : ''
}

export function ArtifactChips({
  docs,
  onOpen,
  className
}: {
  docs: PresentedDoc[]
  /** 点开某一份文档（落点由调用方决定：主会话是右侧「文件」面板） */
  onOpen: (doc: PresentedDoc) => void
  className?: string
}) {
  const tr = useT()
  if (docs.length === 0) return null
  return (
    <div className={cn('mt-2 flex flex-col items-start gap-1.5', className)}>
      {docs.map((doc) => {
        const dir = dirOf(doc.path)
        return (
          // 提示里给完整相对路径 —— 卡上的标题会被截断，且同名文档（README.md）
          // 得靠路径区分是哪一份
          <IconTip key={doc.path} label={doc.path}>
            <button
              type="button"
              aria-label={tr('查看文档 {title}', { title: doc.title })}
              onClick={() => onOpen(doc)}
              className="group/doc flex w-full max-w-sm items-center gap-2.5 rounded-xl border border-border bg-card/60 px-2.5 py-2 text-left transition-colors hover:bg-secondary/40 focus-visible:ring-1 focus-visible:ring-ring/70 focus-visible:outline-none"
            >
              {/* 图标块：hover 时抬到卡片底色上，与文件面板里「选中一行」的观感一致 */}
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover/doc:bg-background group-hover/doc:text-foreground">
                <FileText className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[0.8125rem] leading-tight font-medium text-foreground">
                  {doc.title}
                </span>
                {dir ? (
                  <span className="truncate text-[0.6875rem] leading-tight text-muted-foreground">
                    {dir}/
                  </span>
                ) : null}
              </span>
              {/* 手机上永远看得见（没有 hover），桌面上悬停才滑出来 —— 与操作行同一口径 */}
              <ArrowUpRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-opacity max-md:opacity-100',
                  'opacity-0 md:group-hover/doc:opacity-100'
                )}
              />
            </button>
          </IconTip>
        )
      })}
    </div>
  )
}
