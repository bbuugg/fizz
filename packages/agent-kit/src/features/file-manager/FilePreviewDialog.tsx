/**
 * 文件预览弹窗：图片 / 视频 / 音频 / PDF / 压缩包 / 文本（可编辑）。
 *
 * ## 为什么媒体走 blob 而不是直接把 URL 塞进 `<img src>`
 *
 * `/api/files/content` 要鉴权，而 `<img>` / `<video>` **带不了 Authorization 头**：
 * - web 上只能用 `?token=`（token 会进浏览器历史 / 代理日志）；
 * - desktop 压根没有对外的 HTTP 口（服务端在进程内，走 IPC 桥）。
 *
 * 所以统一「带鉴权 fetch → blob → objectURL」（与工作区文件的 `fetchWorkspaceMedia` 同一条路），
 * 代价是整块进内存 —— 因此视频只适合中短视频，几个 G 的电影请下载后本机看。
 *
 * ## Office 不预览
 *
 * docx / xlsx / pptx 要做服务端转码（LibreOffice 那一套，镜像会胖一大圈），第一版不做：
 * 这类文件给「下载 / 用本机应用打开」两条路，明确说清楚，别让人等一个永远不来的转圈。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, FileArchive, Loader2, Pencil, Save } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import type { FmArchiveEntry, FmEntry } from '@fizz/contracts/agent-api'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import {
  formatSize,
  isTextual,
  kindOf
} from '@fizz/agent-kit/features/file-manager/file-kind'

export function FilePreviewDialog({
  entry,
  onClose
}: {
  entry: FmEntry | null
  onClose: () => void
}): React.JSX.Element {
  const { app } = useAppContext()
  /** api 的最新值（不进依赖数组，见 use-file-manager 文件头） */
  const apiRef = useRef(app.api)
  apiRef.current = app.api

  /** 取文件管理接口（未连接服务端时抛一句人能读懂的话） */
  const files = () => {
    const api = apiRef.current
    if (!api) throw new Error('还没连上服务端，稍后再试')
    return api.files
  }

  const kind = useMemo(() => (entry ? kindOf(entry.name, entry.isDir) : 'other'), [entry])

  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [archive, setArchive] = useState<FmArchiveEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 换文件 / 关闭：把上一份状态清干净（objectURL 必须 revoke，否则每看一张图漏一份内存）
  useEffect(() => {
    setMediaUrl(null)
    setText(null)
    setDraft('')
    setEditing(false)
    setArchive(null)
    setError(null)
    setLoading(false)
    if (!entry || entry.isDir) return

    let revoked: string | null = null
    let cancelled = false
    const path = entry.path

    void (async () => {
      setLoading(true)
      try {
        if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
          const url = await files().mediaUrl(path)
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          revoked = url
          setMediaUrl(url)
          return
        }
        if (kind === 'archive') {
          const result = await files().archive(path)
          if (!cancelled) setArchive(result.entries)
          return
        }
        if (isTextual(kind)) {
          const result = await files().read(path)
          if (cancelled) return
          setText(result.content)
          setDraft(result.content)
          if (result.truncated) setError('文件较大，只显示了前 2MB')
          return
        }
        // 其余类型：没有内建预览，下面给「下载」的出口
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [entry, kind])

  const save = async (): Promise<void> => {
    if (!entry) return
    setSaving(true)
    try {
      await files().op({ op: 'write', path: entry.path, content: draft })
      setText(draft)
      setEditing(false)
      toast.success('已保存')
    } catch (err) {
      toast.error('保存失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  const download = async (): Promise<void> => {
    if (!entry) return
    try {
      await files().download(entry.path, entry.name)
    } catch (err) {
      toast.error('下载失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  return (
    <Dialog open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(46rem,88dvh)] flex-col gap-3 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate">{entry?.name}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {entry?.path} · {entry?.isDir ? '文件夹' : formatSize(entry?.size ?? 0)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md bg-secondary/40">
          {loading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : error && !text && !mediaUrl && !archive ? (
            <p className="px-6 text-center text-sm text-destructive">{error}</p>
          ) : mediaUrl && kind === 'image' ? (
            <img src={mediaUrl} alt={entry?.name ?? ''} className="max-h-full max-w-full object-contain" />
          ) : mediaUrl && kind === 'video' ? (
            <video src={mediaUrl} controls className="max-h-full max-w-full" />
          ) : mediaUrl && kind === 'audio' ? (
            <audio src={mediaUrl} controls className="w-96 max-w-full" />
          ) : mediaUrl && kind === 'pdf' ? (
            <iframe src={mediaUrl} title={entry?.name ?? 'PDF'} className="h-full w-full" />
          ) : archive ? (
            <div className="h-full w-full overflow-auto p-2">
              <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground">
                <FileArchive className="size-3.5" />
                共 {archive.length} 项（名称 / 解压后大小）
              </div>
              <ul className="space-y-0.5 font-mono text-xs">
                {archive.map((item) => (
                  <li key={item.name} className="flex items-center gap-3 px-1 py-0.5">
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {item.isDir ? '-' : formatSize(item.size)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : text !== null ? (
            editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="h-full w-full resize-none bg-transparent p-3 font-mono text-xs leading-relaxed outline-none"
              />
            ) : (
              <pre className="h-full w-full overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                {text || '（空文件）'}
              </pre>
            )
          ) : (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              这类文件没有内建预览。
              <br />
              下载后用本机应用打开即可。
            </div>
          )}
        </div>

        {error && (text || mediaUrl || archive) ? (
          <p className="shrink-0 text-xs text-amber-600">{error}</p>
        ) : null}

        <DialogFooter className="shrink-0">
          {isTextual(kind) && text !== null ? (
            editing ? (
              <>
                <Button data-dialog-dismiss="" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                  取消编辑
                </Button>
                <Button onClick={() => void save()} disabled={saving || draft === text}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  保存
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="size-4" />
                编辑
              </Button>
            )
          ) : null}
          <Button variant="ghost" onClick={() => void download()}>
            <Download className="size-4" />
            下载
          </Button>
          <Button data-dialog-dismiss="" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
