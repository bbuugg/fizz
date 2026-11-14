/**
 * 「源代码管理」面板的**历史提交**区（从 GitPanel.tsx 抽出，含「就地展开看这次改了什么」）。
 *
 * 独立成文件的理由：它自带一套异步状态（展开了哪次 / 取到没 / 报什么错），
 * 而 GitPanel 已经有 30+ 个 state。再往里加三个，主组件的渲染函数就更没法读了。
 *
 * 数据流：`GitCommit[]`（log 接口，只要 subject 那一行）→ 用户点开某次 →
 * `app.gitCommit(id, hash)` 取文件清单 + unified 文本 → 就地展开。
 * 取回来的结果**按 hash 缓存**：反复展开同一次提交不再打网络。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { GitCommit, GitCommitDiffResult } from '@fizz/git'
import { t } from '@fizz/i18n'
import { Button } from '@fizz/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@fizz/ui/context-menu'
import { FileDiffView } from '@fizz/agent-kit/features/git/FileDiffView'
import { parseUnifiedDiff } from '@fizz/agent-kit/shared/lib/diff'
import { splitDiffByFile } from '@fizz/agent-kit/shared/lib/git-commit-diff'
import { statusTone } from '@fizz/agent-kit/features/git/ChangeRow'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** unified diff 里切分文件的边界行（`diff --git a/x b/x`） */
const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/

/** 复制提交哈希后的提示文案（导出来单测，不让文案散在 JSX 里） */
export function copyHashToastLabel(kind: 'full' | 'short'): string {
  // 「完整」两个字要留着：拿到的是 40 位那个，而列表里显示的一直是短哈希
  return kind === 'full' ? t('已复制完整提交哈希') : t('已复制短哈希')
}

/** 复制并把结果告诉用户（剪贴板失败要报出来：静默失败的话用户以为复制过了） */
function copyHash(text: string, kind: 'full' | 'short'): void {
  if (!text) {
    toast.error(t('没有可复制的提交哈希'))
    return
  }
  // 走 promise 而不是 void 一把梭：clipboard 在非安全上下文 / 无焦点时会拒
  navigator.clipboard.writeText(text).then(
    () => toast.success(copyHashToastLabel(kind)),
    (err: unknown) =>
      toast.error(
        t('复制失败：{error}', { error: err instanceof Error ? err.message : String(err) })
      )
  )
}

/** 复制提交信息（subject）；空 subject 与剪贴板失败都明确提示 */
function copyCommitMessage(subject: string): void {
  if (!subject) {
    toast.error(t('没有可复制的提交信息'))
    return
  }
  navigator.clipboard.writeText(subject).then(
    () => toast.success(t('已复制提交信息')),
    (err: unknown) =>
      toast.error(
        t('复制失败：{error}', { error: err instanceof Error ? err.message : String(err) })
      )
  )
}

/**
 * 一次提交的展开体：文件清单 + 逐文件 diff。
 *
 * diff 按文件切分的逻辑在 `lib/git-commit-diff.ts`（零依赖，可单测直跑）：
 * ⚠️ 不能整段喂 `parseUnifiedDiff` —— 它只认 `@@`，多文件的 hunk 会被扁平成
 * 一个数组，行与行的文件归属全丢，而 commit 的 diff 几乎总是多文件的。
 */
function CommitDetail({ detail }: { detail: GitCommitDiffResult }) {
  const t = useT()
  // 空提交 / 纯 merge：git 不给 diff。明说「没有文件改动」，别渲染一个空区让人以为加载失败
  if (detail.files.length === 0) {
    return (
      <div className="px-2 py-1.5 text-xs text-muted-foreground">
        {t('这次提交没有文件改动（空提交，或合并提交默认不带 diff）。')}
      </div>
    )
  }
  const segments = splitDiffByFile(detail.diff)
  return (
    <div className="space-y-1 py-1">
      {/* 文件清单：状态字母 + 路径 + 增删行数。点它滚到 / 定位到下面那段 diff（顺序一致） */}
      <div className="space-y-0.5">
        {detail.files.map((f) => (
          <div key={f.oldPath ? `${f.oldPath}→${f.path}` : f.path} className="flex items-center gap-2 px-2 text-xs">
            <span className={statusTone(f.status) + ' w-3 shrink-0 text-center font-mono font-semibold'} title={f.status}>
              {f.status}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
              {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {f.binary ? (
                <span className="text-muted-foreground">{t('二进制')}</span>
              ) : (
                <>
                  <span className="text-emerald-500">+{f.insertions}</span>{' '}
                  <span className="text-red-500">−{f.deletions}</span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
      {detail.diff ? (
        segments.map((seg) => <FileDiffView key={seg.path} path={seg.path} hunks={seg.hunks} />)
      ) : (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {t('这次提交没有可显示的文本改动（可能全是二进制文件或纯 mode 变更）。')}
        </div>
      )}
    </div>
  )
}

/** 历史提交区：列表 + 就地展开 */
export function GitHistory({
  app,
  workspaceId,
  commits,
  busy,
  hasMore,
  loadingMore,
  onLoadMore,
  onCheckout
}: {
  app: AgentApp
  workspaceId: string
  commits: GitCommit[]
  /** 整个面板正在忙（提交 / 推送…）：禁用检出按钮，别在一次操作中途再发一次 */
  busy: boolean
  /** 还有下一页历史 */
  hasMore: boolean
  /** 正在取下一页 */
  loadingMore: boolean
  onLoadMore: () => void
  onCheckout: (hash: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [openHash, setOpenHash] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 按 hash 缓存取回的结果（内存里，不落盘：一次会话内反复展开同一条是主要场景） */
  const [cache] = useState(() => new Map<string, GitCommitDiffResult>())

  /*
   * ⚠️ 依赖里用 `app.api`（稳定）而不是 `app`（每次渲染都是新对象）。
   *
   * `useAgentApp()` 每次调用都新建一个字面量（`agentAppFrom` 里 `return { … }`，无 memo），
   * 而流式期间每个 token 都会让上游重渲染 —— 把 `app` 写进依赖，展开一条提交详情后
   * **正文流式输出的每一帧都会重新拉一次 `gitCommit`**（与 `GitPanel` 那边同一类坑，
   * 那边的注释写了「直接进依赖会死循环」）。
   *
   * `app.api` 理论上可空（连接还没建好）；这里沿用调用方传入时的口径：拿不到就不拉，
   * 依赖值给 `null` 也是稳定的，不会造成多余重跑。
   */
  const gitApi = app.api
  useEffect(() => {
    if (!openHash || !gitApi) {
      setDetail(null)
      setError(null)
      return
    }
    const hit = cache.get(openHash)
    if (hit) {
      setDetail(hit)
      setError(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    setDetail(null)
    gitApi
      .gitCommit(workspaceId, openHash)
      .then((res) => {
        if (!alive) return
        cache.set(openHash, res)
        setDetail(res)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [gitApi, workspaceId, openHash, cache])

  return (
    <div>
      {/* 标题行 sticky：跟「更改」组同一套 —— 滚到这一段时标题钉在顶部；-mx-1 + px-1 把背景铺满左右 */}
      <div className="sticky top-0 z-10 -mx-1 bg-background px-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-sm font-medium text-muted-foreground hover:bg-foreground/5"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {t('历史提交')}
        </button>
      </div>
      {open && (
        <div className="pl-2">
          {commits.length ? (
            <>
              {commits.map((c) => {
              const expanded = openHash === c.hash
              return (
                <div key={c.hash}>
                  {/*
                    右键菜单只裹住**这一行**（不是整个列表）：层层嵌套的 contextmenu 事件会
                    一路冒泡上去，裹住列表的话点孙子的菜单能把爷爷的菜单同时打开
                    （Radix 不判断 defaultPrevented）。同 FilesPanel 的处理。

                    Radix 的 ContextMenu 自带触摸长按（约 700ms），所以手机上也用得上 ——
                    不需要再照 FilesPanel 那样单做一套底部 Sheet。
                  */}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-foreground/5">
                        {/* 展开开关：整行只有它一个按钮，点行内其它地方不触发展开（避免误触） */}
                        <button
                          type="button"
                          aria-label={expanded ? t('收起 {short} 的改动', { short: c.short }) : t('查看 {short} 改了什么', { short: c.short })}
                          aria-expanded={expanded}
                          onClick={() => setOpenHash(expanded ? null : c.hash)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          {expanded ? (
                            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                          )}
                          <span className="shrink-0 font-mono text-muted-foreground">{c.short}</span>
                          <span
                            className="min-w-0 flex-1 truncate"
                            title={`${c.subject}\n${c.author} · ${c.date}`}
                          >
                            {c.subject}
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          className="h-5! shrink-0 px-1.5! text-xs"
                          title={t('检出这次提交（分离头指针）')}
                          disabled={busy}
                          onClick={() => onCheckout(c.hash)}
                        >
                          {t('检出')}
                        </Button>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-56">
                      {/*
                        两个都给了：完整哈希是 `git revert / cherry-pick / blame` 唯一可靠的
                        入口（短哈希有碰撞与失效问题），而列表里显示的一直是短哈希 ——
                        只给一个，用户迟早要在命令行里再 `git log` 一次查另一个。
                      */}
                      <ContextMenuItem onSelect={() => copyHash(c.hash, 'full')}>
                        <Copy className="size-3.5" />
                        {t('复制完整哈希')}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => copyHash(c.short, 'short')}>
                        <Copy className="size-3.5" />
                        {t('复制短哈希（{short}）', { short: c.short })}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => copyCommitMessage(c.subject)}>
                        <Copy className="size-3.5" />
                        {t('复制提交信息')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem disabled={busy} onSelect={() => onCheckout(c.hash)}>
                        {t('检出这次提交（分离头指针）')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  {expanded &&
                    (loading ? (
                      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> {t('读取这次提交…')}
                      </div>
                    ) : error ? (
                      <div className="px-3 py-1.5 text-xs text-destructive">
                        {t('读取失败：{error}', { error })}
                      </div>
                    ) : detail ? (
                      <CommitDetail detail={detail} />
                    ) : null)}
                </div>
              )
            })}
            {hasMore && (
              <div className="px-2 pb-1 pt-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-full justify-center text-xs text-muted-foreground"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                >
                  {loadingMore ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ChevronDown className="size-3.5" />
                  )}
                  {loadingMore ? t('加载中…') : t('加载更多')}
                </Button>
              </div>
            )}
            </>
          ) : (
            <div className="px-2 py-1 text-xs text-muted-foreground">{t('还没有提交')}</div>
          )}
        </div>
      )}
    </div>
  )
}
