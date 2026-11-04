/**
 * 导入 OpenAPI / Swagger 规格（从本地文件或 URL）。
 *
 * 三段式：**取数**（选文件 / 抓 URL）→ **预览**（格式 / 标题 / 版本 / 分组 / 条数）→
 * **落库**（`app.importApiRequests`：按 `operation.tags[0]` 建组 + 建请求）。
 * 「文本 → 条目」全在 `openapi-import.ts` 里（纯函数，OpenAPI 3 / Swagger 2 都认），
 * 这里只做编排与提示，不碰解析细节。
 *
 * ## 抓 URL 为什么走服务端
 *
 * 用 `app.sendApiRequest`（GET）而不是渲染端 `fetch`：浏览器直连第三方域名会被 CORS
 * 拦下（绝大多数规格文件不带 CORS 头），桌面端经 IPC 桥也只能打本机 server —— 服务端
 * 转发两端行为一致，而且与「发请求」共用同一条链路（超时 / 重定向 / 证书开关都一样）。
 * 服务端把正文原样回给我们，超过 5 MB 直接拒掉（一份规格撑到几 MB 是极少见的，
 * 真遇到就是该拆分了）。
 *
 * ## 落库不在这里逐条建
 *
 * 只调一次 `app.importApiRequests(batch)`：一次导入可能几百条，逐条 `refresh()` 会把
 * 界面拖死（见 `server-lists.ts` 那段注释）。返回这一批新建出来的请求，用来打开第一条。
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FileUp, Link2, Loader2 } from 'lucide-react'
import type { ApiRequestEntry } from '@fizz/contracts/types'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { ApiImportBatch } from '@fizz/agent-kit/shared/lib/stores/slices/server-lists'
import { pickTextFile } from '@fizz/agent-kit/shared/lib/pick-file'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Badge } from '@fizz/ui/badge'
import { Label } from '@fizz/ui/label'
import { Alert, AlertDescription } from '@fizz/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@fizz/ui/tabs'
import { parseOpenApiSpec, type OpenApiImportResult } from '@fizz/agent-kit/features/api/openapi-import'

/** 选择框只过滤常见规格后缀；拖进来的东西是什么内容仍以解析结果为准 */
const SPEC_ACCEPT = '.json,.yaml,.yml,application/json,text/yaml'

/** 规格大小上限（文本长度，粗略当字节数用；见文件头） */
const MAX_SPEC_BYTES = 5 * 1024 * 1024

/** 抓取超时：规格文件是静态资源，卡 15 秒就该让用户换个地址试 */
const FETCH_TIMEOUT_MS = 15_000

type Source = 'file' | 'url'

/** 解析结果 → 批量导入载荷（`headers` 空时补一行空行，与「新建请求」的初值一致） */
function toBatch(result: OpenApiImportResult): ApiImportBatch {
  return {
    groups: result.groups,
    entries: result.entries.map((e) => ({
      group: e.group,
      entry: {
        name: e.name,
        method: e.method,
        url: e.url,
        headers: e.headers.length ? e.headers : [{ key: '', value: '' }],
        body: e.body,
        bodyType: e.bodyType,
        bodyUrlencoded: e.bodyUrlencoded,
        bodyFormFields: e.bodyFormFields
      }
    }))
  }
}

/** 补全协议头并校验：只认 http / https（`file:` / `data:` 之类交给服务端只会拿到一句 fetch failed） */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withScheme)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

export function OpenApiImportModal({
  app,
  open,
  onClose,
  onImported
}: {
  app: AgentApp
  open: boolean
  onClose: () => void
  /** 导入成功后把第一条新建的请求交回面板（由它开标签 + 切视图） */
  onImported: (request: ApiRequestEntry) => void
}) {
  const [source, setSource] = useState<Source>('file')
  const [fileName, setFileName] = useState('')
  const [url, setUrl] = useState('')
  /** 取数中（选文件 / 抓 URL） */
  const [busy, setBusy] = useState(false)
  /** 落库中（建组 + 建请求可能几百条，要挡住重复点） */
  const [importing, setImporting] = useState(false)
  const [parsed, setParsed] = useState<OpenApiImportResult | null>(null)
  const [error, setError] = useState('')

  // 每次打开都是一次全新导入：上一次的文件名 / 地址 / 预览都不该留着
  // ⚠️ 依赖只放 `open`：`app` 每次渲染都是新对象，放进来会每帧重置（见 AGENTS.md）
  useEffect(() => {
    if (!open) return
    setSource('file')
    setFileName('')
    setUrl('')
    setBusy(false)
    setImporting(false)
    setParsed(null)
    setError('')
  }, [open])

  /** 拿到文本 → 解析 → 预览（两份来源共用的收尾） */
  const acceptText = (text: string): void => {
    if (text.length > MAX_SPEC_BYTES) {
      setParsed(null)
      setError('规格文件过大（超过 5 MB）')
      return
    }
    try {
      setParsed(parseOpenApiSpec(text))
      setError('')
    } catch (err) {
      setParsed(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const pickFile = async (): Promise<void> => {
    const picked = await pickTextFile(SPEC_ACCEPT)
    if (!picked) return
    setFileName(picked.name)
    acceptText(picked.text)
  }

  const fetchUrl = async (): Promise<void> => {
    const target = normalizeUrl(url)
    if (!target) {
      setError('请填写 http / https 地址')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await app.sendApiRequest({
        sendId: crypto.randomUUID(),
        request: {
          method: 'GET',
          url: target,
          // 不带 accept 时有些网关会回 HTML 错误页（解析出来就是「不是规格」）
          headers: { accept: 'application/json, text/yaml, text/plain, */*' },
          timeoutMs: FETCH_TIMEOUT_MS
        }
      })
      if (res.error) {
        setParsed(null)
        setError(`抓取失败：${res.error}`)
        return
      }
      if (!res.ok) {
        setParsed(null)
        setError(`抓取失败：HTTP ${res.status} ${res.statusText}`)
        return
      }
      acceptText(res.body)
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    if (!parsed || parsed.entries.length === 0) return
    setImporting(true)
    try {
      const created = await app.importApiRequests(toBatch(parsed))
      // 失败时 store 已经 setError 了，外壳会把那句话弹成全局 toast（app-shell 的
      // useErrorToast），这里不再叠一条「导入失败」——两条 toast 只会互相盖住
      if (created.length === 0) return
      const groupCount = new Set(created.map((r) => r.groupId).filter(Boolean)).size
      toast.success(
        `已导入 ${created.length} 个请求${groupCount ? `、${groupCount} 个分组` : ''}`
      )
      onClose()
      onImported(created[0])
    } finally {
      setImporting(false)
    }
  }

  const switchSource = (next: Source): void => {
    if (next === source) return
    setSource(next)
    // 换了来源就是换了一份内容：上一次的预览留着只会让人以为「已经选好了」
    setParsed(null)
    setError('')
    setFileName('')
  }

  const groups = parsed?.groups ?? []

  return (
    // 落库中也不挡关闭：导入是服务端在跑，关掉弹窗不会中断它（列表会自己长出来，
    // 成功那条 toast 与「打开第一条」照样会到）—— 挡住反而像卡死，让人反复按 Esc
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导入 OpenAPI / Swagger</DialogTitle>
          <DialogDescription>
            支持 OpenAPI 3.x 与 Swagger 2.0；按接口的 tag 建分组，导入后可直接发请求。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/*
            来源切换用 shadcn `Tabs`，不再是分段控件（`Segmented` 那套 ToggleGroup 在
            DOM 里是 `role="radiogroup"` + 单选按钮）：它切的是**两块面板**（选文件 /
            抓 URL），不是一个筛选值 —— 只有 Tabs 才给得到「触发器 ↔ 面板」同源的无障碍
            关系（`aria-controls` / `aria-labelledby`），读屏念的是「从文件，标签页 1/2」
            而不是「单选按钮，已选中」。

            与 `ApiPage` 里那几处（请求头 / 参数 / 请求体、响应体 / 响应头）同一套组件、
            同一个理由 —— 见 `shared/components/Segmented` 文件头那段说明。
          */}
          <Tabs
            value={source}
            onValueChange={(value) => switchSource(value as Source)}
            className="gap-3"
          >
            {/* `w-full`：分段控件原来就是等宽两段，TabsList 默认 `w-fit` 会缩成一小坨 */}
            <TabsList className="w-full">
              <TabsTrigger value="file">从文件</TabsTrigger>
              <TabsTrigger value="url">从 URL</TabsTrigger>
            </TabsList>

            <TabsContent value="file" className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => void pickFile()}>
                  <FileUp className="size-4" />
                  选择文件
                </Button>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {fileName || '支持 .json / .yaml / .yml'}
                </span>
              </div>
            </TabsContent>

            <TabsContent value="url" className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="openapi-url">规格地址</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="openapi-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void fetchUrl()
                    }}
                    placeholder="https://example.com/openapi.json"
                    className="h-8 text-sm"
                  />
                  <Button
                    variant="ghost"
                    disabled={busy || !url.trim()}
                    onClick={() => void fetchUrl()}
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                    获取
                  </Button>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {parsed ? (
            <div className="flex flex-col gap-1.5 rounded-lg border bg-primary/5 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {parsed.title || '未命名接口'}
                  {parsed.version ? ` v${parsed.version}` : ''}
                </span>
                <Badge variant="secondary" className="shrink-0">
                  {parsed.format}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                将导入{' '}
                <span className="font-semibold text-foreground">{parsed.entries.length}</span>{' '}
                个请求
                {groups.length ? `，按 ${groups.length} 个分组：` : '。'}
              </div>
              {/* 分组名可能很多：给个高度上限自己滚，别把弹窗撑长 */}
              {groups.length ? (
                <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
                  {groups.map((name) => (
                    <Badge key={name} variant="outline">
                      {name}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {parsed.entries.some((e) => !e.group) ? (
                <div className="text-xs text-muted-foreground">
                  没有 tag 的请求会放进「未分组」。
                </div>
              ) : null}
              {parsed.skipped > 0 ? (
                <div className="text-xs text-muted-foreground">
                  另有 {parsed.skipped} 个操作无法解析，已跳过
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!parsed || parsed.entries.length === 0 || busy || importing}
            onClick={() => void handleImport()}
          >
            {importing
              ? '导入中…'
              : parsed && parsed.entries.length > 0
                ? `导入 ${parsed.entries.length} 个请求`
                : '导入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
