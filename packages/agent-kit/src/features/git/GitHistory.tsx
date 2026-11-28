/**
 * 「源代码管理」面板的**历史提交**区（从 GitPanel.tsx 抽出，含「就地展开看这次改了什么」）。
 *
 * 独立成文件的理由：它自带一套异步状态（展开了哪次 / 取到没 / 报什么错），
 * 而 GitPanel 已经有 30+ 个 state。再往里加三个，主组件的渲染函数就更没法读了。
 *
 * 数据流：`GitCommit[]`（log 接口，只要 subject 那一行）→ 用户点开某次 →
 * `app.gitCommit(id, hash)` 取文件清单 + unified 文本 → 文件清单按目录树展开（跟随面板
 * 的树状 / 平铺偏好），点文件在**右侧文件面板**打开这次提交的 diff（只读快照）。
 * 取回来的结果**按 hash 缓存**：反复展开同一次提交不再打网络。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { GitCommit, GitCommitDiffResult, GitCommitFileStat } from '@fizz/git'
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
import { ChangeTreeList } from '@fizz/agent-kit/features/git/GitChangeTree'
import { splitDiffByFile } from '@fizz/agent-kit/shared/lib/git-commit-diff'
import { changeTreeIndent } from '@fizz/agent-kit/shared/lib/git-change-tree'
import type { DiffHunk } from '@fizz/agent-kit/shared/lib/diff'
import { statusTone } from '@fizz/agent-kit/features/git/ChangeRow'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { writeClipboard } from '@fizz/agent-kit/shared/lib/clipboard'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 历史提交里点一个文件、在右侧面板打开 diff 时交给调用方的东西 */
export interface CommitDiffOpenTarget {
  hash: string
  short: string
  path: string
  /** 重命名 / 复制时带旧名的完整 label（`old → new`），其余就是 path */
  label: string
  /** 从这次提交的 unified diff 里切出来的该文件片段（空 = 二进制 / 纯 mode 变更） */
  hunks: DiffHunk[]
}

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
  writeClipboard(text).then(
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
  writeClipboard(subject).then(
    () => toast.success(t('已复制提交信息')),
    (err: unknown) =>
      toast.error(
        t('复制失败：{error}', { error: err instanceof Error ? err.message : String(err) })
      )
  )
}

/** 重命名 / 复制：树状视图下只显示文件名（目录名已在父目录行里） */
function commitFileLabel(file: GitCommitFileStat, treeView: boolean): string {
  if (!treeView) return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
  const base = (p: string): string => p.split('/').pop() ?? p
  return file.oldPath ? `${base(file.oldPath)} → ${base(file.path)}` : base(file.path)
}

/**
 * 一次提交的展开体：文件清单（树状 / 平铺，与「更改」组同一套）+ 点文件看 diff。
 *
 * 点击文件默认**在右侧面板打开 diff**（`onOpenDiff` 由 `FilesPanel` 接上）——
 * 历史提交里的文件大多是历史版本 / 已删除，在文件树里根本打不开，diff 标签才是唯一去处。
 *
 * 没给回调时（理论上只剩调试用）退回原来的就地展开，且一次只展开一个。
 *
 * diff 按文件切分的逻辑在 `lib/git-commit-diff.ts`（零依赖，可单测直跑）：
 * ⚠️ 不能整段喂 `parseUnifiedDiff` —— 它只认 `@@`，多文件的 hunk 会被扁平成
 * 一个数组，行与行的文件归属全丢，而 commit 的 diff 几乎总是多文件的。
 */
function CommitDetail({
  detail,
  treeView,
  onOpenDiff
}: {
  detail: GitCommitDiffResult
  /** 树状还是平铺：跟随面板头部那颗「按目录树显示」的偏好 */
  treeView: boolean
  /** 点文件 → 在右侧面板打开这次提交里该文件的 diff */
  onOpenDiff?: (target: CommitDiffOpenTarget) => void
}) {
  const t = useT()
  /** 没有右侧面板时用：这次提交里正在就地看哪个文件的 diff */
  const [openPath, setOpenPath] = useState<string | null>(null)
  /** 折叠中的目录（树状视图；按目录路径索引） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // 空提交 / 纯 merge：git 不给 diff。组内没有东西就什么都不画（不要再补一句「没有文件改动」）
  if (detail.files.length === 0) return null
  /*
   * 文件清单与 diff 段按路径对上：`splitDiffByFile` 的 path 取自 `diff --git a/x b/x`
   * （rename 时是 `-M` 归一化之后的新路径），与 `files` 里的 `path` 同源。
   * 对不上的（二进制 / 纯 mode 变更 / 被服务端截断的文件）给空 hunks ——
   * `FileDiffView` 会自己说「没有可展示的文本差异」，不用这里另造一套文案。
   */
  const hunksByPath = new Map(splitDiffByFile(detail.diff).map((seg) => [seg.path, seg.hunks]))

  const renderFile = (file: GitCommitFileStat, depth: number): ReactNode => {
    const expanded = !onOpenDiff && openPath === file.path
    const fullLabel = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
    const label = commitFileLabel(file, treeView)
    const hunks = hunksByPath.get(file.path) ?? []
    return (
      <div key={file.path}>
        <div className="relative flex h-7 items-center gap-1.5 pr-2 text-sm text-foreground hover:bg-foreground/10">
          <button
            type="button"
            aria-expanded={onOpenDiff ? undefined : expanded}
            aria-label={
              onOpenDiff
                ? t('在右侧查看 {path} 在这次提交里的改动', { path: fullLabel })
                : expanded
                  ? t('收起 {path} 的改动', { path: fullLabel })
                  : t('查看 {path} 在这次提交里的改动', { path: fullLabel })
            }
            onClick={() => {
              if (onOpenDiff) {
                onOpenDiff({
                  hash: detail.hash,
                  short: detail.short,
                  path: file.path,
                  label: fullLabel,
                  hunks
                })
                return
              }
              setOpenPath(expanded ? null : file.path)
            }}
            title={fullLabel}
            style={changeTreeIndent(treeView ? depth : 0)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <span
              className={statusTone(file.status) + ' w-4 shrink-0 text-center font-mono text-xs font-semibold'}
              title={file.status}
            >
              {file.status}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono" title={fullLabel}>
              {label}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {file.binary ? (
                <span className="text-muted-foreground">{t('二进制')}</span>
              ) : (
                <>
                  <span className="text-emerald-500">+{file.insertions}</span>{' '}
                  <span className="text-red-500">−{file.deletions}</span>
                </>
              )}
            </span>
          </button>
        </div>
        {expanded && (
          // pl-14 ≈ 文件行缩进 + 状态字母 w-4 + gap-1.5：diff 正文与文件名左对齐
          <div className="pl-14">
            <FileDiffView path={fullLabel} hunks={hunks} hideHeader wrap />
          </div>
        )}
      </div>
    )
  }

  if (!treeView) {
    // 与树状同样的 pl-5 基准：两种视图切换时文件行的左边距不该跳一下（也等于原来的 pl-10）
    return (
      <div className="py-1 pl-5">{detail.files.map((file) => renderFile(file, 0))}</div>
    )
  }
  const collapsedSet = new Set(
    Object.entries(collapsed)
      .filter(([, value]) => value)
      .map(([path]) => path)
  )
  return (
    <div className="py-1 pl-5">
      <ChangeTreeList
        changes={detail.files}
        collapsed={collapsedSet}
        onToggleDir={(path) => setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))}
        renderFile={renderFile}
      />
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
  onCheckout,
  treeView,
  onOpenCommitDiff
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
  /** 文件清单树状还是平铺（跟随面板头部那颗「按目录树显示」的偏好） */
  treeView: boolean
  /** 点提交里的文件 → 在右侧文件面板打开它的 diff */
  onOpenCommitDiff?: (target: CommitDiffOpenTarget) => void
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
      {/* 标题行 sticky：跟「更改」组同一套 —— 滚到这一段时标题钉在顶部。
          ⚠️ 不要再用 `-mx-1 + px-1` 铺满底色：整列已经没有左右 padding，负外边距只会让
          这一行比内容宽 8px，滚动容器上就多出一条横向滚动条 */}
      <div className="sticky top-0 z-10 bg-background">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-foreground/10"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {t('历史提交')}
        </button>
      </div>
      {open && (
        // 不再给整列 `pl-*`：hover 底色要**贴到面板左缘**（内边距留给行内内容），
        // 否则灰底左侧会空出一截，和上面「更改」组的行对不齐
        <div>
          {commits.length > 0 && (
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
                      <div className="flex items-center gap-1.5 py-1 pr-2 text-sm hover:bg-foreground/10">
                        {/* 展开开关：整行只有它一个按钮，点行内其它地方不触发展开（避免误触） */}
                        <button
                          type="button"
                          aria-label={expanded ? t('收起 {short} 的改动', { short: c.short }) : t('查看 {short} 改了什么', { short: c.short })}
                          aria-expanded={expanded}
                          onClick={() => setOpenHash(expanded ? null : c.hash)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 pl-5 text-left"
                        >
                          {expanded ? (
                            <ChevronDown className="size-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="size-3.5 shrink-0" />
                          )}
                          <span className="shrink-0 font-mono text-muted-foreground">{c.short}</span>
                          <span
                            className="min-w-0 flex-1 truncate"
                            title={`${c.subject}\n${c.author} · ${c.date}`}
                          >
                            {c.subject}
                          </span>
                        </button>
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
                      <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> {t('读取这次提交…')}
                      </div>
                    ) : error ? (
                      <div className="px-2 py-1.5 text-sm text-destructive">
                        {t('读取失败：{error}', { error })}
                      </div>
                    ) : detail ? (
                      <CommitDetail
                        detail={detail}
                        treeView={treeView}
                        onOpenDiff={onOpenCommitDiff}
                      />
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
          )}
        </div>
      )}
    </div>
  )
}
