/**
 * 设置 → 容器：公网访问域名 + 预置运行环境（镜像）的状态、重建，以及「让新镜像生效」的容器重建。
 *
 * ## 公网访问（第一块）
 *
 * 域名是**整个部署一件事**，所以放在全局设置里、按 `<slug>.<域名>` 分派给各个项目的预览
 * （服务端那侧见 `container-projects/public-gateway.ts`）。这一块只做三件事：填域名、
 * 把要加的 DNS 记录写清楚、说明「现在为什么还不能用」（没配域名 / 没对外监听）。
 *
 * ⚠️ 公网入口是**独立的监听端口**（`FIZZ_PUBLIC_HTTP_PORT`，默认关闭），与工作台端口分开。
 * 所以「能不能从外面进」取决于那个端口有没有启用 + 有没有被反代 / 防火墙放行；域名本身
 * 在设置里配（可多个），改完立刻生效、不用重启。
 *
 * ## 为什么需要镜像那一页
 *
 * 容器型项目的镜像是**全局共享**的（三个环境镜像都 `FROM fizz/agent-runtime`），
 * 而项目记录里只存环境 id、不存 tag。于是「镜像现在到底是什么状态」在界面上**没有
 * 任何地方能看见**：没构建时项目一打开就卡在「准备运行环境镜像」，构建坏了只能看
 * 启动页里那 400 行日志的尾巴。这一页把镜像层摊开：存在性、大小、构建时间、构建中、
 * 上次失败的错因与日志，以及强制重建。
 *
 * ## 两条不能省的解释文案
 *
 * 1. **重建镜像 ≠ 项目生效**：容器是 `docker run` 那一刻的镜像快照，已在跑的容器仍是
 *    旧镜像。所以每个镜像下面直接列出「正在用它的项目」并给「重建容器」——不然用户
 *    点完「重新构建」，项目行为一点没变，会以为按钮没生效。
 * 2. **重建基础层不会自动更新环境镜像**：环境镜像里是旧 base 的层，必须再各建一次。
 *
 * ## 轮询
 *
 * `docker build` 是长任务，服务端不 await（见 `api/container-images/[env]/build/route.ts`）。
 * 这里有构建在跑时每 2s 拉一次快照（同时把日志尾部带回来），全部结束后自动停。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Check,
  ChevronDown,
  Copy,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import type { ContainerPublicSettingsView } from '@fizz/agent-client/api'
import { Input } from '@fizz/ui/input'
import type {
  ContainerEnvId,
  ContainerImageInfo,
  ContainerImagesSnapshot,
  ContainerProjectsSnapshot
} from '@fizz/contracts/types'
import { Badge } from '@fizz/ui/badge'
import { Button } from '@fizz/ui/button'
import { SpinnerButton } from '@fizz/ui/spinner-button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@fizz/ui/collapsible'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useStateValue } from '@fizz/agent-kit/shared/lib/state-ws'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { writeClipboard } from '@fizz/agent-kit/shared/lib/clipboard'

/** 还没收到快照时的兜底：`available: false`（不误报成「docker 正常」） */
const EMPTY_PROJECTS: ContainerProjectsSnapshot = { available: false, projects: [] }

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 固定格式（不走 `toLocaleString`）：同一台机器上不同语言的系统不该显示成两种样子 */
function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ImageRow({
  info,
  users,
  busy,
  rebuilding,
  onBuild,
  onRebuild
}: {
  info: ContainerImageInfo
  /** 正在用这个镜像的容器型项目（`base` 没有直接用户） */
  users: Array<{ id: string; name: string }>
  /** 正在触发构建（请求还没回来） */
  busy: boolean
  /** 正在重建容器的项目 id */
  rebuilding: string | null
  onBuild: () => void
  onRebuild: (workspaceId: string) => void
}) {
  const tr = useT()
  const [logOpen, setLogOpen] = useState(false)
  const building = info.building || busy
  const canBuild = !info.overridden && !building

  /**
   * 复制报错原文。
   *
   * 为什么除了「可选」还要一个按钮：全局 `body` 是 `user-select: none`（`styles.css` 的
   * 白名单制，见文件头注释），下面那块补了 `data-selectable` 让手选也能选；但 docker
   * 的报错动辄十几行、还带长 URL，拖选到一半松手就得重来，按钮更省事。
   */
  const copyError = (): void => {
    if (!info.error) return
    void writeClipboard(info.error).then(
      () => toast.success(tr('已复制报错')),
      () => toast.error(tr('复制失败，请手动选择文本'))
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-start gap-2">
        {/*
          图标只表达「这个镜像在不在」，**不跟构建状态联动**：构建中换成 spinner 会让
          整行图标在每次轮询里闪，而「正在构建」该由右侧那颗按钮自己说（见下面的
          `SpinnerButton`）。
        */}
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
          {info.exists ? (
            <Check className="size-3.5 text-muted-foreground" />
          ) : (
            <Box className="size-3.5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{info.label}</span>
            {building ? (
              <Badge variant="secondary">{tr('构建中')}</Badge>
            ) : info.error ? (
              <Badge variant="destructive">{tr('构建失败')}</Badge>
            ) : info.exists ? (
              <Badge variant="outline">{tr('已就绪')}</Badge>
            ) : (
              <Badge variant="secondary">{tr('未构建')}</Badge>
            )}
            {info.overridden && <Badge variant="outline">{tr('环境变量指定')}</Badge>}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {info.tag}
          </div>
        </div>
        {/*
          构建中由**这颗按钮自己**表达（spinner 在文字前、loading 时自动 disabled），
          与启动页 / Git 面板同一套 `SpinnerButton` 观感；不再让左侧图标转圈。
        */}
        <SpinnerButton
          type="button"
          size="sm"
          variant="outline"
          loading={building}
          disabled={!canBuild}
          onClick={onBuild}
          title={
            info.overridden
              ? tr('该镜像由 FIZZ_CONTAINER_IMAGE_<ENV> 指定，请在外部构建')
              : info.exists
                ? tr('按当前 Dockerfile 重新构建（已有容器仍是旧镜像，重建后需要重建容器）')
                : tr('构建这个运行环境镜像')
          }
        >
          {building ? tr('构建中…') : info.exists ? tr('重新构建') : tr('构建')}
        </SpinnerButton>
      </div>

      <div className="text-xs leading-5 text-muted-foreground">
        {info.exists && info.sizeBytes !== undefined && info.createdAt !== undefined
          ? tr('{size} · 构建于 {time}', { size: formatBytes(info.sizeBytes), time: formatTime(info.createdAt) })
          : info.overridden
            ? tr('镜像由环境变量指定，这里只检测是否存在')
            : tr('尚未构建：首次启动容器型项目时会自动构建')}
      </div>

      {/*
        `data-selectable`：全局 `body` 是 `user-select: none`，只有 `.sd-md` / `pre` /
        显式标注的块能选中（见 `apps/<端>/src/styles.css` 的「放开选中分三档」）。报错是 `<p>`
        不在 `pre` 里，不标注就一个字都选不中（用户报过「构建报错不能复制」）。
      */}
      {info.error && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-2 py-1.5">
          <p
            data-selectable
            className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-5 text-destructive"
          >
            {info.error}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs text-destructive hover:text-destructive"
            onClick={copyError}
            title={tr('复制这段报错')}
          >
            <Copy className="mr-1 size-3" />
            {tr('复制')}
          </Button>
        </div>
      )}

      {info.log.length > 0 && (
        <Collapsible open={logOpen} onOpenChange={setLogOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', logOpen && 'rotate-180')}
              />
              {tr('构建日志（尾部 {count} 行）', { count: info.log.length })}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {/*
              `pre` 默认是 `white-space: pre`（不软换行）：`docker build` 的行里有很长的
              命令 / URL / 层 hash，整行会一路往右伸、只能横向滚才能看全（表现为「没换行、
              溢出去」）。这里显式 `whitespace-pre-wrap` 保留原换行 + 自动折行，再配
              `break-words` 让长串在任意处断；纵向仍由 `max-h-56 overflow-y-auto` 兜。
            */}
            <pre className="mt-1.5 max-h-56 overflow-y-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-4 break-words text-muted-foreground whitespace-pre-wrap break-all">
              {info.log.join('\n')}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* 重建镜像后必须重建容器才生效 —— 把「谁在用」直接列在这儿，省得用户自己找 */}
      {users.length > 0 && (
        <div className="space-y-1 rounded-md bg-muted/40 p-2">
          <div className="text-xs leading-5 text-muted-foreground">
            {tr('{count} 个项目在用这个镜像；重建容器会中断运行中的会话。', { count: users.length })}
          </div>
          {users.map((user) => (
            <div key={user.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs">{user.name}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                disabled={rebuilding !== null}
                onClick={() => onRebuild(user.id)}
              >
                {rebuilding === user.id ? (
                  <>
                    <Loader2 className="mr-1 size-3 animate-spin" />
                    {tr('重建中…')}
                  </>
                ) : (
                  <>
                    <RotateCcw className="mr-1 size-3" />
                    {tr('重建容器')}
                  </>
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 公网访问：域名输入 + 「现在能不能用」的状态 + 要加的 DNS 记录。
 *
 * 状态口径全在服务端（`api/system/container-public` 的 `enabled`）：前端**不自己猜**
 * 「远程访问开没开」—— 那要跨桥问宿主，而服务端本来就知道自己有没有对外监听。
 */
function PublicAccessSection({ app }: { app: AgentApp }) {
  const tr = useT()
  const api = app.api
  const [view, setView] = useState<ContainerPublicSettingsView | null>(null)
  /** 编辑中的域名清单（至少保留一行输入框，空行在保存时被丢弃） */
  const [draft, setDraft] = useState<string[]>([''])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 回填草稿：至少一行，避免清单空时没有可编辑的输入框 */
  const toDraft = (domains: string[]): string[] => (domains.length ? domains : [''])

  const load = useCallback(async () => {
    if (!api) return
    try {
      const next = await api.getContainerPublicSettings()
      setView(next)
      setDraft(toDraft(next.domains))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  // 「去掉空行 + 去空白」后比较，避免只多加一个空行就被当成改动
  const cleaned = draft.map((d) => d.trim()).filter(Boolean)
  const dirty = view !== null && cleaned.join('\n') !== view.domains.join('\n')

  /**
   * 存设置。`domains` 缺省 = 用当前草稿。
   *
   * 每一行都能用 × 删除；删光（草稿只剩空行）后保存 = 传空数组 = 关闭公网访问。
   * 服务端会逐个归一化（去 `*.` / 协议 / 端口、去重），所以以回传值为准对齐草稿。
   */
  const save = async (domains: string[] = draft): Promise<void> => {
    if (!api) return
    setSaving(true)
    try {
      const next = await api.saveContainerPublicSettings({ domains })
      setView(next)
      setDraft(toDraft(next.domains))
      setError(null)
      toast.success(
        next.domains.length ? tr('公网域名已保存（{count} 个）', { count: next.domains.length }) : tr('公网访问已关闭')
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const copy = (text: string): void => {
    writeClipboard(text).then(
      () => toast.success(tr('已复制')),
      () => toast.error(tr('复制失败，请手动选择文本'))
    )
  }

  const updateAt = (index: number, value: string): void => {
    setDraft((prev) => prev.map((d, i) => (i === index ? value : d)))
  }

  const addRow = (): void => setDraft((prev) => [...prev, ''])

  const removeAt = (index: number): void =>
    setDraft((prev) => {
      const next = prev.filter((_, i) => i !== index)
      return next.length ? next : ['']
    })

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Globe className="size-3.5" />
        {tr('公网访问')}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {tr('每个项目会获得')}
        <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          &lt;项目 slug&gt;.&lt;域名&gt;
        </code>
        {tr('子域。')}
      </p>

      <div className="space-y-2">
        {draft.map((value, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              variant="muted"
              value={value}
              onChange={(event) => updateAt(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && dirty && !saving) void save()
              }}
              placeholder={index === 0 ? 'example.com' : 'another.com'}
              spellCheck={false}
              className="h-8 max-w-72 font-mono text-xs"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              disabled={saving}
              onClick={() => removeAt(index)}
              title={tr('删除这个域名')}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={saving}
          onClick={addRow}
        >
          <Plus className="mr-1 size-3" />
          {tr('添加域名')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => void save()}
          title={dirty ? tr('保存后立刻生效（不用重启服务）') : tr('没有改动')}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : tr('保存')}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs leading-5 text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {view === null ? (
        error ? null : !api ? (
          <p className="text-xs leading-5 text-muted-foreground">{tr('还没有连上服务端。')}</p>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {tr('正在读取公网访问设置…')}
          </div>
        )
      ) : view.domains.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {tr('公网访问已关闭，只能使用内网地址。')}
        </p>
      ) : !view.enabled ? (
        /*
         * 域名有了、外面却进不来 —— 公网入口是独立端口，没启用时外面连不上。
         * 服务端只认「端口真的在监听」，所以这里不是错误、是还差一步。
         */
        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 p-2.5 text-xs leading-5 text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <div className="font-medium text-foreground">{tr('域名已保存，但公网入口端口没在监听')}</div>
            <div className="break-words">
              {tr('公网入口是一个独立端口，要用')}
              <code className="mx-1 font-mono">FIZZ_PUBLIC_HTTP_PORT</code>
              {tr('指定（默认关闭，填 0 表示不启用），配好后重启服务；再在防火墙 / 反代里放行它。')}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5 rounded-lg border border-border/60 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{tr('已启用')}</Badge>
            <span className="text-xs text-muted-foreground">
              {tr('预览地址形如')} <code className="font-mono">{`<slug>.${view.domains[0]}`}</code>
              {view.domains.length > 1 && tr('（共 {count} 个域名）', { count: view.domains.length })}
            </span>
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {tr('在 DNS 里把这些记录指到')}
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              {view.target ?? tr('这台机器')}
            </code>
            {view.target ? tr('（本机地址；有固定公网 IP 时换成它）') : tr('（本机没有对外网卡，填这台机器的公网 IP）')}。
            {tr('TLS 由你自己的反代终结。')}
          </div>
          <div className="space-y-1">
            {view.wildcards.map((wildcard) => (
              <div key={wildcard} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                  {wildcard}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2 text-xs"
                  onClick={() => copy(wildcard)}
                >
                  <Copy className="mr-1 size-3" />
                  {tr('复制')}
                </Button>
              </div>
            ))}
          </div>
          {view.target && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => copy(view.target!)}
            >
              <Copy className="mr-1 size-3" />
              {tr('复制目标地址')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

export function ContainerTab({ app }: { app: AgentApp }) {
  const tr = useT()
  const api = app.api
  const projects = useStateValue<ContainerProjectsSnapshot>('containerProjects', EMPTY_PROJECTS)
  const workspaces = app.workspaces
  const [snapshot, setSnapshot] = useState<ContainerImagesSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 正在触发构建的键（请求往返期间按钮立即禁用，不等下一份快照） */
  const [pending, setPending] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!api) {
      setError(tr('还没有连上服务端'))
      return
    }
    try {
      setSnapshot(await api.containerImages())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const building = snapshot
    ? [snapshot.base, ...snapshot.envs].some((info) => info.building)
    : false
  // 有构建在跑就每 2s 拉一次（日志尾部与结果都在这份快照里）；全部结束自动停
  useEffect(() => {
    if (!building) return
    const timer = setTimeout(() => void refresh(), 2000)
    return () => clearTimeout(timer)
  }, [building, snapshot, refresh])

  const build = async (env: ContainerImageInfo['env']): Promise<void> => {
    if (!api) return
    setPending(env)
    try {
      setSnapshot(await api.buildContainerImage(env))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const rebuild = async (workspaceId: string): Promise<void> => {
    if (!api) return
    setRebuilding(workspaceId)
    try {
      await api.rebuildContainerProject(workspaceId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRebuilding(null)
    }
  }

  /** 某个镜像正在被哪些容器型项目使用（`base` 没有直接用户：项目只用环境镜像） */
  const usersOf = (env: ContainerImageInfo['env']): Array<{ id: string; name: string }> => {
    if (env === 'base') return []
    return projects.projects
      .filter((project) => project.image === (env as ContainerEnvId))
      .map((project) => ({
        id: project.workspaceId,
        name:
          workspaces.find((workspace) => workspace.id === project.workspaceId)?.name ??
          project.slug
      }))
  }

  return (
    <div className="space-y-5">
      <PublicAccessSection app={app} />

      <div className="h-px bg-border/60" />

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{tr('容器运行环境')}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {tr('镜像全局共享，重建会影响所有项目')}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void refresh()}
          title={tr('重新检测')}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {!snapshot ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {tr('正在检测 docker…')}
        </div>
      ) : !snapshot.available ? (
        <div className="flex items-start gap-2 rounded-lg border border-border/60 p-3 text-xs leading-5 text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-foreground">{tr('这台机器上没有可用的 docker')}</div>
            <div className="mt-0.5 break-words">
              {snapshot.reason ?? tr('请确认 Docker 已安装且守护进程正在运行')}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            docker {snapshot.version ?? 'unknown'}
          </div>

          <ImageRow
            info={snapshot.base}
            users={[]}
            busy={pending === 'base'}
            rebuilding={rebuilding}
            onBuild={() => void build('base')}
            onRebuild={() => undefined}
          />
          <p className="-mt-1 px-1 text-[11px] leading-4 text-muted-foreground">
            {tr('重建基础层后，环境镜像需各自重建')}
          </p>

          {snapshot.envs.map((info) => (
            <ImageRow
              key={info.env}
              info={info}
              users={usersOf(info.env)}
              busy={pending === info.env}
              rebuilding={rebuilding}
              onBuild={() => void build(info.env)}
              onRebuild={(workspaceId) => void rebuild(workspaceId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
