/**
 * 浏览器设置：内置浏览器运行时的**检测 / 安装 / 卸载**。
 *
 * ## 这一页管的是什么
 *
 * Playwright 自带的 `chromium_headless_shell`。它**不随安装包分发**（约 150MB，
 * 见 `@fizz/tools` 的 `playwright-browsers.ts` 文件头），而这台机器上凡是「要真开一个
 * 浏览器」的能力都共用这一份：
 *
 * - Agent 的 `browser_*` 工具集（含右侧「浏览器」面板的画面）；
 * - `web_fetch` 的 browser 引擎（JS 渲染的页面靠它）；
 * - 网页截图。
 *
 * 所以这一页只回答一个问题：**这台机器上到底有没有那套浏览器**。没装时聊天工具条上
 * 连浏览器开关都不显示（见 `ComposerToolbar` 的 `browserInstalled`），免得用户点开一个
 * 下一轮必然报 `Executable doesn't exist` 的开关。
 *
 * ## 网站数据
 *
 * 内置浏览器**每个会话一份**持久化 profile（`<dataDir>/browser-profiles/<sessionId>`，
 * 见 `@fizz/tools` 的 `browser/profiles.ts`）：Cookie / 登录态 / localStorage / 缓存都
 * 在各自那一份里，没有全局池子。所以这里**不提供**「清缓存」「清 Cookie」两颗按钮 ——
 * 用户真正想做的「这个会话登错号了」在右侧浏览器面板里清（作用域才对），这一页只留
 * 一颗「清除全部」，负责兜住历史残留与「干脆全部重来」。
 *
 * ## 为什么安装是后台任务
 *
 * 150MB 在国内源上常常只有几 KB/s。挂在请求上等，关掉设置页就等于放弃；挂成后台任务后
 * 关页面不影响，进度在状态栏那一排里也能看到，要停就显式取消（`cancelBackgroundTask`）。
 *
 * ## 与 playwright MCP 的关系
 *
 * 想用外部 `playwright-mcp` 完全可行：在「MCP」页加一条 `npx @playwright/mcp@latest`。
 * 会话里挂了带同名工具的 MCP 时，内置的 `browser_*` 会自动让位（服务端装配时判断），
 * 所以不需要手动关内置开关 —— 也不该靠卸载运行时来「腾位置」，卸载只会连带
 * `web_fetch` / 截图一起停摆。
 */
import { useCallback, useEffect, useState } from 'react'
import { Cookie, Download, Globe, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { BrowserProfileUsage, BrowserRuntimeResult } from '@fizz/contracts'
import { Button } from '@fizz/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@fizz/ui/alert-dialog'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'

/** 轮询间隔：下载是分钟级的，1.5s 足够跟手，又不至于把接口刷成流水 */
const POLL_MS = 1500

export function BrowserTab({ app }: { app: AgentApp }) {
  const tr = useT()
  // `app` 每次渲染都是新对象，**不能进依赖数组**（流式期间每帧重渲染）；只取稳定的
  // 成员：`api` 是 createApi 的那一份，`refresh` 是 store 的 action
  const { api, refresh: refreshApp } = app

  const [state, setState] = useState<BrowserRuntimeResult | null>(null)
  /** 最近一次动作的错误（安装失败走任务的 `error`，这里是请求本身失败） */
  const [error, setError] = useState<string | null>(null)
  /** 装卸请求在飞（不是下载）：只用来禁用按钮 */
  const [busy, setBusy] = useState(false)
  /** 安装日志的最新一行（进度条那行），`cleanLogLine` 已经把它压成一行 */
  const [lastLine, setLastLine] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)

  /**
   * 网站数据（每个会话一份 profile）。与运行时那份状态**分开取**：运行时那份被安装进度
   * 1.5s 轮询，而这份要遍历目录算体积 —— 混在一起会让每次轮询都 walk 一遍 Chromium
   * profile（见 `api/browser/data/route.ts` 的注释）。
   */
  const [data, setData] = useState<BrowserProfileUsage | null>(null)
  const [dataBusy, setDataBusy] = useState(false)
  const [dataError, setDataError] = useState<string | null>(null)
  const [confirmClearAll, setConfirmClearAll] = useState(false)

  const load = useCallback(async (): Promise<BrowserRuntimeResult | null> => {
    // `app.api` 在宿主还没连上服务端时是 null（与其它设置页同一套判断）
    if (!api) return null
    try {
      const next = await api.getBrowserRuntime()
      setState(next)
      setError(null)
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [api])

  /**
   * 网站数据占用。**只在挂载 / 清完之后取**，不进任何轮询。
   *
   * 失败不挡页面：运行时那部分照样能用，这里只在卡片里写一行原因（最常见的原因是
   * 后端还是旧版本、没有这条路由）。
   */
  const loadData = useCallback(async () => {
    if (!api) return
    try {
      setData(await api.getBrowserData())
      setDataError(null)
    } catch (err) {
      setDataError(err instanceof Error ? err.message : String(err))
    }
  }, [api])

  // 挂载拉一次（只拉一次：依赖是稳定的 load）
  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const task = state?.task ?? null
  const installing = state?.runtime.downloading === true || task?.status === 'running'

  // 安装中：链式 setTimeout 轮询。`state` 变化会重挂这个 effect，于是自然形成
  // 「每 1.5s 一次」的链；比 setInterval 好在不会在上一次还没回来时叠请求
  useEffect(() => {
    if (!installing) return
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        const next = await load()
        if (cancelled || !next) return
        // 进度行：任务自带的 `lastLog`（服务端把下载器的百分比原地覆盖成一行），
        // 不必再拉整份日志
        if (next.task && next.task.status === 'running') {
          if (!cancelled) setLastLine(next.task.lastLog ?? null)
        }
        // 刚收场（成功或失败）：让 store 重拉一次浏览器探测，工具条那颗开关据此出现/消失
        if (next.task && next.task.status !== 'running') {
          setLastLine(null)
          void refreshApp()
        }
      })()
    }, POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [installing, state, load, api, refreshApp])

  async function install() {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      setState(await api.installBrowserRuntime())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function uninstall() {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      setState(await api.uninstallBrowserRuntime())
      // 卸载后工具条上那颗开关要消失
      void refreshApp()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setConfirmUninstall(false)
    }
  }

  /**
   * 清除**所有会话**的网站数据（兜底动作）。
   *
   * 服务端会先把所有浏览器会话关掉再删目录 —— 所以正开着面板的标签会收到 `closed`，
   * 这是预期行为，不是崩了（关掉的原因就写着「网站数据已清除」）。
   */
  async function clearAllData() {
    if (!api) return
    setDataBusy(true)
    setDataError(null)
    try {
      setData(await api.clearAllBrowserData())
      toast.success(tr('已清除全部网站数据'))
    } catch (err) {
      setDataError(err instanceof Error ? err.message : String(err))
    } finally {
      setDataBusy(false)
      setConfirmClearAll(false)
    }
  }

  const installed = state?.runtime.installed === true
  const size = formatBytes(state?.runtime.sizeBytes ?? null)
  const dataSize = formatBytes(data?.sizeBytes ?? null)

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Globe className="size-3.5" />
          {tr('内置浏览器')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr(
            'Playwright 自带的 Chromium（headless shell），约 150MB，不随安装包分发。浏览器工具、网页抓取（JS 渲染）与网页截图共用这一份 —— 没装时聊天工具条上不会出现浏览器开关。'
          )}
        </p>

        {/* 状态卡片：装没装、装在哪、占多少 */}
        <div className="rounded-md border border-border px-3 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={
                installed
                  ? 'inline-block size-1.5 rounded-full bg-emerald-500'
                  : 'inline-block size-1.5 rounded-full bg-muted-foreground/40'
              }
              aria-hidden
            />
            <span className="font-medium">
              {state === null
                ? tr('检测中…')
                : installed
                  ? tr('已安装')
                  : tr('未安装')}
            </span>
            {installed && size && (
              <span className="text-muted-foreground">{size}</span>
            )}
            {installed && state?.runtime.revision && (
              <span className="text-muted-foreground">
                {tr('版本 {rev}', { rev: state.runtime.revision })}
              </span>
            )}
          </div>
          {state?.runtime.path && (
            <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
              {state.runtime.path}
            </p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {!installed && (
              <Button size="sm" onClick={() => void install()} disabled={busy || installing}>
                {busy || installing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {installing ? tr('安装中…') : tr('安装')}
              </Button>
            )}
            {installed && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmUninstall(true)}
                disabled={busy || installing}
              >
                <Trash2 className="size-3.5" />
                {tr('卸载')}
              </Button>
            )}
            {(busy || installing) && (
              <span className="text-[11px] text-muted-foreground">
                {tr('下载在后台进行，关掉设置页不会中断')}
              </span>
            )}
          </div>

          {/* 下载进度：任务日志的最后一行（下载器输出里就是 `|███ 45%` 那种） */}
          {installing && lastLine && (
            <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={lastLine}>
              {lastLine}
            </p>
          )}
          {/* 任务失败：原因在任务上（`task.error`），比「安装失败」有用得多 */}
          {task && task.status === 'failed' && (
            <p className="mt-2 break-all font-mono text-[11px] text-destructive">
              {task.error ?? tr('安装失败')}
            </p>
          )}
          {error && (
            <p className="mt-2 break-all font-mono text-[11px] text-destructive">{error}</p>
          )}
        </div>
      </section>

      {/*
        * 网站数据：一个会话一份 profile，所以「清缓存 / 清 Cookie」在这里只能是整份地删。
        * 日常入口在右侧「浏览器」面板（会话级），这里是**兜底**：删过会话的历史残留、
        * 或者干脆想全部重来。
        */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Cookie className="size-3.5" />
          {tr('网站数据')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr(
            '每个会话各存一份独立的浏览数据（Cookie、登录状态、本地存储与缓存），互不共享 —— 所以才会「这个会话登着、那个会话没登」。删除会话时会一并清掉；只想换账号请到右侧「浏览器」面板里清那一个会话，这里只做兜底。'
          )}
        </p>

        <div className="rounded-md border border-border px-3 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">
              {data === null
                ? tr('统计中…')
                : data.count === 0
                  ? tr('暂无网站数据')
                  : tr('{count} 份浏览数据', { count: data.count })}
            </span>
            {dataSize && <span className="text-muted-foreground">{dataSize}</span>}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmClearAll(true)}
              disabled={dataBusy || !data || data.count === 0}
            >
              {dataBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              {tr('清除全部网站数据')}
            </Button>
          </div>

          {dataError && (
            <p className="mt-2 break-all font-mono text-[11px] text-destructive">{dataError}</p>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {tr('也可以用 playwright MCP')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr(
            '不想装这份运行时，可以在「MCP」页加一条 Playwright 官方 MCP（npx @playwright/mcp@latest）。会话里挂了带同名工具的 MCP 时，内置浏览器工具会自动让位，不需要手动关。注意两点：MCP 用自己的浏览器实例，右侧「浏览器」面板看不到它的画面；没装这份运行时，网页截图工具不会挂出来，网页抓取也只剩不需要浏览器的 fetch 引擎。'
          )}
        </p>
      </section>

      <AlertDialog open={confirmUninstall} onOpenChange={(open) => !open && setConfirmUninstall(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('卸载内置浏览器？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr(
                '会删掉这份 headless shell（约 150MB）。卸载期间先关掉所有浏览器会话；之后浏览器工具与网页截图不再挂出来，网页抓取只剩不需要浏览器的 fetch 引擎，想再用需要重新下载。'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('取消')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void uninstall()}>{tr('卸载')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmClearAll}
        onOpenChange={(open) => !open && setConfirmClearAll(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('清除全部网站数据？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr(
                '会先关掉所有正在运行的浏览器，再删除每个会话的 Cookie、登录状态、本地存储与缓存。会话与聊天记录不受影响；之后每个会话再打开浏览器都需要重新登录。'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('取消')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void clearAllData()}>{tr('清除')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 人类可读的占用（150MB 那种量级，别再显示一堆字节） */
function formatBytes(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  /**
   * 一整个会话的浏览数据常常只有几百 KB（只开过一两个站、缓存还是冷的），按 MB 四舍五入
   * 会显示成「0 MB」，看着像统计失败。运行时那份是 150MB 量级，不受这条影响。
   */
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${mb.toFixed(0)} MB`
}
