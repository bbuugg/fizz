/**
 * 容器型项目的**预览面板**（会话右侧 SidePanel 里的一个标签）。
 *
 * ## 为什么在 SidePanel 里，而不是主区域的一条工具标签
 *
 * 预览是「一边和 agent 说话、一边看它改出来的页面」—— 看的动作和对话强绑定，放进会话
 * 面板才能与终端 / 文件并排，且**跟着会话走**（切走再切回来，页面还在原地）。
 *
 * ## 用 `<webview>`（桌面端），其余宿主退回 `<iframe>`
 *
 * iframe 能不能嵌**取决于目标站点的 `frame-ancestors` / `X-Frame-Options`**（与 CORS
 * 不是一回事）：容器里跑的多是我们模板起的服务（不设这两个头），用户也可能塞一个设了头
 * 的进去 —— 那种页面在 iframe 里就是白屏。所以桌面端（宿主能力 `webview`）用 Electron 的
 * `<webview>`：它是独立的 guest 进程，不受这两个响应头限制（权限收紧见主进程
 * `secureWebviews`）。web / 手机端没有这个能力，照旧用 iframe。
 *
 * ## 两个地址（spec §4.6）
 *
 * | 地址 | 何时有 | 用途 |
 * |---|---|---|
 * | `http://127.0.0.1:<预览宿主端口>` | 在跑且映射到宿主端口 | 服务端就在本机时的快捷看（**不要求已发布**） |
 * | `https://<slug>.<域名>` | `exposed === true` 且服务端配了域名（且确实在对外监听） | 对外分享同一条 |
 *
 * ⚠️ 本机地址指向**浏览器自己那台机器** —— 服务端在别处（多机部署 / 远程 server）时它打不开。
 * 所以默认值按宿主能力定：**本机后端（桌面端）默认内网**，其余默认公网（走服务端的公网入口，
 * 见 `public-gateway.ts`）。工具条上那对「内网 / 公网」分段控件用来手动切；公网不可用
 * （没发布 / 没配域名）时自动退回本机，公网那一段同时置灰。
 *
 * ## 运行态从哪读
 *
 * 落盘配置（slug / exposed / 有没有配预览端口）从 `app.workspaces` 读；运行态（state / 端口）
 * 读 state ws 的 `containerProjects` 域（**不读 `app` 这个每帧换引用的对象**）。
 *
 * ## ⚠️ 这个面板**不负责启动容器**
 *
 * 以前「容器没起来」这里给一个「重新唤醒」按钮，还顺带走 `startContainerProject`。用户要求
 * 改掉：**看预览不该有副作用** —— 他只是想看一眼页面，后台却开始拉容器、建镜像、占内存。
 * 现在只要拿不到地址就统一显示 `PreviewErrorPage`（Tailwind 写的错误页，容器没启动 / 启动
 * 失败 / 没有 docker / 缺端口 / 公网被 key 挡住都是同一张），报错页里**不给启动按钮**，
 * 只把原因与下一步说清楚（去哪启动）。
 *
 * **不登记关闭守卫**：这个面板没有未保存现场（就是个页面加一条工具条）。
 *
 * ## 每次加载都挂 cache-bust 参数
 *
 * 容器里的服务普遍带缓存头，浏览器 / `<webview>` 会把上一次的页面复用掉 —— 用户看到
 * 「agent 改完了、刷新了，还是旧的」。所以 frame 的地址上挂一个随加载变化的 `_fizzv`
 * 时间戳（见 `withCacheBust`）：换 URL = 必回源。工具条**显示 / 复制 / 外开**的仍是干净
 * 地址（`activeUrl`），只有内嵌加载那一路带参数。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  Container,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Play,
  PlugZap,
  RefreshCw,
  ServerCrash,
  ShieldAlert
} from 'lucide-react'
import { toast } from 'sonner'
import { PREVIEW_KEY_QUERY, type ContainerProjectsSnapshot } from '@fizz/contracts/types'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { Button } from '@fizz/ui/button'
import { Label } from '@fizz/ui/label'
import { Switch } from '@fizz/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@fizz/ui/toggle-group'
import { subscribeServerEvent, useStateSnapshot } from '@fizz/agent-kit/shared/lib/state-ws'
import { PHASE_LABELS } from '@fizz/agent-kit/features/projects/ContainerStartupView'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { openExternal } from '@fizz/agent-client/web-host'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { writeClipboard } from '@fizz/agent-kit/shared/lib/clipboard'

/** 预览走哪个地址：`内网` = 宿主映射端口，「公网」= `<slug>.<域名>` */
type Via = 'local' | 'public'

/**
 * 预览 frame 上挂的 cache-bust 参数名。
 *
 * 容器里的 dev server / 应用常带 `Cache-Control`，浏览器（尤其 Electron `<webview>` 的
 * guest）会直接复用上一份缓存 —— 表现为「agent 改完了、也点了刷新，页面还是旧的」。
 * 每次加载往地址上挂一个会变的时间戳，等于换了个 URL，缓存自然失效。
 */
const CACHE_BUST_QUERY = '_fizzv'

/** 给地址挂 cache-bust 参数（保留原有 query，比如未发布时的 `fizz_key`） */
function withCacheBust(url: string, token: number): string {
  try {
    const u = new URL(url)
    u.searchParams.set(CACHE_BUST_QUERY, String(token))
    return u.toString()
  } catch {
    // 理论上 activeUrl 都是绝对地址；真解析失败就手工拼一次，别让它把预览整个搞挂
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}${CACHE_BUST_QUERY}=${token}`
  }
}

/** Electron 的 webview 元素：只用到这两个成员，其余按 HTMLElement 处理 */
type WebviewElement = HTMLElement & { src: string; reload: () => void }

/**
 * 预览打不开时的统一错误页。
 *
 * **所有「看不了」都走这一张**：容器没启动 / 启动失败 / 没有 docker / 缺预览端口 /
 * 公网被 key 挡住 —— 以前每种情况是一行灰字，用户分不清是「要等」还是「要修」。现在固定四段：
 *
 * 1. 图标块（状态色：`wait` 主色呼吸、`error` 破坏色、`blocked` 中性）；
 * 2. 一句话标题 + 一段说清「为什么 / 接下来怎么办」的正文；
 * 3. 可选的**诊断明细**（服务端原话、slug、镜像、阶段）—— 等宽小字，能直接拿去搜。
 *    ⚠️ **不写端口**：端口是宿主侧实现细节，用户不关心，而且每次重建都会变；
 * 4. 动作按钮（重新检测 / 切换地址），挤在底部一行。
 *
 * 颜色只用语义令牌（`primary` / `destructive` / `muted` / `border` / `accent`），跟主题走，
 * 别写死 hex —— 深浅两套主题下都得读得清。
 */
function PreviewErrorPage({
  tone,
  icon,
  title,
  description,
  details,
  actions
}: {
  tone: 'wait' | 'error' | 'blocked'
  icon: ReactElement
  title: string
  description: string
  /** 「键 / 值」明细：键进左侧弱化列，值可换行、mono 显示 */
  details?: ReadonlyArray<{ key: string; value: string }>
  actions?: ReactElement
}): ReactElement {
  const halo =
    tone === 'error'
      ? 'bg-destructive/10 text-destructive ring-destructive/25'
      : tone === 'blocked'
        ? 'bg-muted text-muted-foreground ring-border'
        : 'bg-primary/10 text-primary ring-primary/25'
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center overflow-auto px-6 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <div
          className={cn(
            'flex size-12 items-center justify-center rounded-2xl ring-1 ring-inset',
            halo,
            tone === 'wait' && 'animate-pulse'
          )}
        >
          {icon}
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="text-xs leading-6 text-muted-foreground">{description}</p>
        </div>

        {details && details.length > 0 && (
          /*
           * 明细卡片：左侧键固定宽（`w-14`）、右侧值可换行。整块 `bg-muted/40` 比背景低一档，
           * 一眼能看出「这不是正文，是可以拿去搜的诊断信息」。
           */
          <dl className="w-full divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-muted/40 text-left">
            {details.map((row) => (
              <div key={row.key} className="flex gap-3 px-3 py-2 text-[0.6875rem] leading-5">
                <dt className="w-14 shrink-0 text-muted-foreground">{row.key}</dt>
                <dd className="min-w-0 flex-1 break-words font-mono text-foreground/80">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {actions && <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

/**
 * 加载遮罩：页面还没吐出来时盖在预览上。
 *
 * 每次加载（首次打开、点刷新、agent 改完文件重载、切内网 / 公网）都由调用方按「加载
 * 身份」重新点亮一次 `loading`。
 *
 * 遮罩**常挂、只切透明度**（`transition-opacity`）：卸载重挂会让每次加载都新建一棵子树，
 * 而遮罩背后是 `<webview>`（独立 guest 进程，被合成层单独提出来）—— 让它别随着遮罩
 * 增删而抖动。淡出期间 `pointer-events-none`，不会挡住下面的页面。
 */
function LoadingVeil({ loading }: { loading: boolean }): ReactElement {
  const t = useT()
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={loading}
      className={
        'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface-1 ' +
        'transition-opacity duration-200 ease-out ' +
        (loading ? 'opacity-100' : 'pointer-events-none opacity-0')
      }
    >
      {/*
        自绘的「呼吸 + 三点」加载符（不用 spinner 的 Lucide 转圈）：外圈一圈主色辉光
        慢慢胀缩，里面三个点错峰上浮 —— 与对话里的 `TypingBubble` 同一套令牌
        （`--animate-preview-*`，见 `@fizz/ui-tokens` 的 theme.css）。
      */}
      <span className="relative inline-flex size-9 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-primary/10 animate-preview-halo" />
        <span className="absolute inset-[0.3rem] rounded-full border border-primary/20" />
        <span className="relative inline-flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 rounded-full bg-primary animate-preview-dot"
              style={{ animationDelay: `${i * 0.16}s` }}
            />
          ))}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">{t("正在加载预览…")}</span>
    </div>
  )
}

/**
 * 页面主体：桌面端用 `<webview>`，其余宿主用 `<iframe>`。
 *
 * webview 用 `document.createElement` 手动挂（而不是 JSX 标签）：
 * ① `agent-kit` 是跨端 UI 包，**不能 import electron 的类型**，JSX 里没有 `webview` 这个
 *    intrinsic element；② 地址变化时重建一个 guest 比改 `src` 属性更可靠（与 iframe 的
 *    `key` 同一个语义：真的重新加载，而不是原地留着旧页面）。
 *
 * ## 加载态
 *
 * 遮罩在**新的一次加载开始时就盖上**（`loadId` 变化 = 新加载：换地址、点刷新、agent 改完
 * 文件重载），webview 靠 `did-stop-loading`、iframe 靠 `load` 收掉。
 * ⚠️**只认「停」不认「失败」**：`did-fail-load` 是「页面没加载出来」（容器刚起来、dev server
 * 还没监听端口时就是 `errorCode -102`），监听它收遮罩等于把遮罩换成一片白。而
 * `did-stop-loading` 无论成败最后都会来，用它兜底才既不早退也不会一直转。
 */
function PreviewFrame({ url, useWebview, reloadSeq }: { url: string; useWebview: boolean; reloadSeq: number }): ReactElement {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<WebviewElement | null>(null)
  /**
   * 挂载那一刻的时间戳做基数：**第一次打开也要换 URL**。只用 `reloadSeq`（初值 0）的话，
   * 本次会话首次打开会跟上次会话用同一个地址，浏览器直接命中旧缓存 —— 正好是「改完看不到新的」。
   */
  const mountNonce = useRef(Date.now()).current
  /** 真正交给 frame 的地址：挂上会变的时间戳，绕开缓存（保留原有 query） */
  const src = withCacheBust(url, mountNonce + reloadSeq)
  /** 一次加载的身份：变化时把遮罩拉起来（渲染期比对，不在 effect 里补状态，免得先闪一帧旧页面） */
  const loadId = src
  const [loaded, setLoaded] = useState<{ id: string; done: boolean }>({ id: loadId, done: false })
  const done = loaded.id === loadId ? loaded.done : false
  const markDone = (): void => setLoaded({ id: loadId, done: true })

  useEffect(() => {
    if (!useWebview) return
    const host = hostRef.current
    if (!host) return
    const el = document.createElement('webview') as WebviewElement
    el.setAttribute('src', src)
    // guest 默认 `display: inline-flex`，不给尺寸会塌成 0 高
    el.style.display = 'flex'
    el.style.width = '100%'
    el.style.height = '100%'
    el.style.border = '0'
    el.style.background = 'var(--background)'
    // 重建 guest 时遮罩已经重新拉起了（见上面的 loadId），这里只负责在结束时收掉
    el.addEventListener('did-stop-loading', markDone)
    host.appendChild(el)
    webviewRef.current = el
    return () => {
      el.removeEventListener('did-stop-loading', markDone)
      webviewRef.current = null
      el.remove()
    }
    // reloadSeq 参与依赖：点「刷新」时重建 guest（webview.reload() 在部分版本上对
    // 卡死的页面无效，重建一定重来）。markDone 随 loadId 重建，无需进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadId, useWebview])

  return (
    <div className="relative size-full">
      {!useWebview && (
        <iframe
          key={loadId}
          src={src}
          title={t("容器预览")}
          onLoad={markDone}
          // `block`：iframe 默认是行内元素，底边会留一条基线空隙 → 外层比它高几像素，
          // 面板右/下缘冒出本不该存在的滚动条。`size-full` 负责铺满。
          className="block size-full border-0 bg-background"
        />
      )}
      {useWebview && <div ref={hostRef} className="size-full bg-white" />}
      <LoadingVeil loading={!done} />
    </div>
  )
}

export function PreviewPane({ workspaceId }: { workspaceId: string }): ReactElement {
  const t = useT()
  const { app } = useAppContext()
  const host = getAgentHostOrNull()
  /*
   * ⚠️ 未就绪是 `undefined`，不是「`available: false`」：兜底快照里的 `false` 会被下面渲染成
   * 「服务端没有可用的 docker」——刷新页面后快照到达前就会先闪一句这个（用户报过）。
   */
  const snapshot = useStateSnapshot<ContainerProjectsSnapshot>('containerProjects')
  const [publishing, setPublishing] = useState(false)
  /** 点「刷新」时 +1：让 webview / iframe 都真的重新加载 */
  const [reloadSeq, setReloadSeq] = useState(0)
  /**
   * 用户**显式**选过的地址；`null` = 还没选过，跟着「哪个能用」自动走。
   *
   * 为什么不干脆把初值设成默认值：用户先打开预览、再打开「对外发布」时，面板不会
   * 自己切到公网那条（得手动再点一次），很别扭。用「显式选择」记法就没这个问题 ——
   * 没选过就一直跟随可用性，选过之后才由它说了算。
   */
  const [choice, setChoice] = useState<Via | null>(null)

  /**
   * agent 改完文件 → 重新加载预览。
   *
   * 为什么还要这一层：容器里跑的是**用户自己的服务**，我们不知道它有没有 HMR。Vite 模板
   * 有（会先自己热更新），但 node / php / golang 镜像里的服务大多没有 —— 没有这一层时，
   * agent 改完代码，预览面板里永远是改之前的页面（用户报过）。
   *
   * 延迟 1.5s 再刷：给 HMR 一点时间先自己更新完（Vite 通常 100-300ms），避免「刚更新完
   * 又被整个重载」的抖动；连续改多个文件时用 debounce 只刷一次。
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = subscribeServerEvent((event) => {
      if (event.type !== 'container:files-changed' || event.workspaceId !== workspaceId) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setReloadSeq((n) => n + 1), 1_500)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [workspaceId])

  const container = app.workspaces.find((w) => w.id === workspaceId)?.container
  // `?.`：快照未就绪时这里是 `undefined`（下面先判 `!snapshot` 再往下用）
  const project = snapshot?.projects.find((p) => p.workspaceId === workspaceId)

  if (!container) {
    return (
      <PreviewErrorPage
        tone="blocked"
        icon={<ServerCrash className="size-6" />}
        title={t("这个项目不存在了")}
        description={t("它可能已经被删除。关掉这个标签，从左侧项目列表重新打开即可。")}
      />
    )
  }
  if (!snapshot) {
    // 快照还没到（刷新页面后那一两百毫秒）：说「正在读」而不是「没有 docker」
    return (
      <PreviewErrorPage
        tone="wait"
        icon={<Loader2 className="size-6 animate-spin" />}
        title={t("正在读取容器状态…")}
        description={t("马上就好。这一步只是问服务端容器在不在，不会启动任何东西。")}
      />
    )
  }
  if (!snapshot.available) {
    return (
      <PreviewErrorPage
        tone="blocked"
        icon={<Container className="size-6" />}
        title={t("服务端没有可用的 docker")}
        description={t("这类项目的预览要跑在容器里，没有 docker 就起不来。在服务端机器上装好 docker（或修好 docker 连接）后刷新即可。")}
        details={[{ key: t('服务端'), value: snapshot.reason ?? t('未给出原因') }]}
      />
    )
  }
  if (container.previewPort === undefined) {
    // 正常情况下服务端建项目时就按镜像填好了；走到这里只有「老数据 / 手改坏」两种可能
    return (
      <PreviewErrorPage
        tone="blocked"
        icon={<PlugZap className="size-6" />}
        title={t("这个项目没有配预览端口")}
        description={t("服务端建项目时会按镜像自动填好；这里是老数据或被手改坏了。删掉重建一个项目最省事，也可以去「容器设置」里补。")}
        details={[{ key: t('项目'), value: container.slug }]}
      />
    )
  }

  // 宿主端口要等容器真的起来才有映射（`docker ps -a` 现读，见 lifecycle.ts）
  const running = project?.state === 'running'
  const localUrl =
    running && project?.previewPort !== undefined ? `http://127.0.0.1:${project.previewPort}` : null
  /** 公网域名：快照里可能配了多个，取第一个拼预览地址（多个域名等价，任一个都能打开） */
  const domain = snapshot.domains?.[0] ?? null
  /**
   * 公网地址：服务端配了域名就给（快照里的 `domains` 已门控过）。
   *
   * **未发布时也生成**，但带上预览 key（`?fizz_key=...`）—— 公网入口对未发布项目只认
   * 带对 key 的访问（见 `public-gateway.ts`）。老数据没有 key 时不给（给了也是死路：
   * 用户手里没有 key 可输），工具条上会提示去「容器设置」生成。
   */
  const publicUrl = (() => {
    if (!domain) return null
    const base = `https://${container.slug}.${domain}`
    if (container.exposed === true) return base
    if (!container.previewKey) return null
    return `${base}?${PREVIEW_KEY_QUERY}=${encodeURIComponent(container.previewKey)}`
  })()

  /**
   * 实际用的地址：**默认走公网域名** —— 用户拿到的就是这个（`https://<slug>.<域名>`），
   * 它由服务端公网入口按 slug 现查当前端口，宿主端口再怎么漂都不影响它。
   *
   * 内网回环地址在公网不可用时兜底（没配域名 / 未发布且没有预览 key）；桌面端用户
   * 仍可以用工具条上的分段控件手动切过来看一眼。
   *
   * `via` 只在 `publicUrl` 真有值时才可能是 `'public'`，否则分段控件的选中态会跟
   * 页面用的地址对不上。
   *
   * 容器没在跑时两个地址都不用（**这个面板不负责启动容器**：起停都在项目菜单「容器状态」
   * 和主区域的启动卡片上），下面走 `PreviewErrorPage`。
   */
  const via: Via = (choice ?? 'public') === 'public' && publicUrl ? 'public' : 'local'
  const activeUrl = running ? (via === 'public' ? publicUrl : localUrl) : null

  /**
   * 没有地址时工具条上那行占位字。
   *
   * 以前一律写「容器未运行」—— 停止中 / 启动中 / 启动失败全被说成「没运行」，
   * 用户看不出后台到底在干什么。这里按状态分开写。
   */
  const urlPlaceholder =
    project?.state === 'stopping'
      ? t('容器正在停止…')
      : project?.state === 'starting'
        ? t('容器正在启动（{phase}）…', { phase: t(PHASE_LABELS[project.phase ?? ''] ?? '准备中') })
        : project?.state === 'error'
          ? t('容器启动失败')
          : t('容器未运行')

  /**
   * 公网那条地址**结构上还有救吗**（配了域名、也拿得到 key）。
   *
   * 未发布且没有 key 时 `publicUrl` 为 `null` —— 那不是「容器没起来」，是「公网入口一定会
   * 401」，值得单独说一句，别混进容器错误里让用户去重启容器（重启也没用）。
   */
  const publicBlockedReason: string | null = !domain
    ? t('公网访问不可用：没配域名，或公网入口端口没启用（设置 → 容器 → 公网访问）。只能走「内网」地址（需要服务端就在本机）。')
    : !container.exposed && !container.previewKey
      ? t('这个项目还没对外发布，也没有预览 key，公网入口会一律拒绝。去「容器设置」生成一个预览 key，或打开「对外发布」。')
      : null

  /**
   * 公网访问开关（口径：**新建默认开**，因为用户要的就是「一条域名」；关掉后退回本机回环，
   * 适合「只是自己在本机看一眼」）。
   *
   * 落盘到项目的 `container.exposed`（`app.updateContainerProject` 成功后会刷工作区列表，
   * 所以 `container.exposed` 会自己跟上；失败原因进底部错误条，不用在这里另做提示）。
   * `publishing` 只是顶住开关别在往返期间被连点。
   */
  const publish = (next: boolean): void => {
    setPublishing(true)
    void app.updateContainerProject(workspaceId, { exposed: next }).finally(() => setPublishing(false))
  }

  const copy = (): void => {
    if (!activeUrl) return
    void writeClipboard(activeUrl).then(
      () => toast.success(t('已复制')),
      () => toast.error(t('复制失败，请手动选中地址'))
    )
  }

  const open = (): void => {
    if (!activeUrl) return
    void openExternal(activeUrl).then((result) => {
      if (!result.ok) toast.error(result.error ?? t('打不开这个地址'))
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具条：一行地址 + 一行发布开关。面板最窄 380px，所以地址用 truncate、按钮全走图标 */}
      <div className="flex flex-col gap-1.5 border-b border-border/60 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={via}
            onValueChange={(next) => {
              if (next) setChoice(next as Via)
            }}
            className="w-fit shrink-0"
          >
            <ToggleGroupItem
              value="local"
              disabled={localUrl === null}
              className="h-6! px-2 text-xs"
              title={
                localUrl === null
                  ? t('容器没在跑，还没有本机地址')
                  : t('服务端就在本机时用它 —— 服务端在别处时这个地址指向的是浏览器自己那台机器')
              }
            >
              {t("内网")}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="public"
              disabled={publicUrl === null}
              className="h-6! px-2 text-xs"
              title={
                publicUrl === null
                  ? domain
                    ? t('还没有预览 key：去「容器设置」生成一个')
                    : t('公网访问不可用（设置 → 容器 → 公网访问）')
                  : t('走服务端的公网入口（未发布时会带上预览 key）')
              }
            >
              {t("公网")}
            </ToggleGroupItem>
          </ToggleGroup>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-muted-foreground"
            title={activeUrl ?? undefined}
          >
            {activeUrl ?? urlPlaceholder}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            title={t("刷新")}
            disabled={!activeUrl}
            onClick={() => setReloadSeq((n) => n + 1)}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            title={t("复制地址")}
            disabled={!activeUrl}
            onClick={copy}
          >
            <Copy className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            title={t("在系统浏览器打开")}
            disabled={!activeUrl}
            onClick={open}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <Switch
            id={`preview-publish-${workspaceId}`}
            checked={container.exposed === true}
            disabled={publishing}
            onCheckedChange={publish}
          />
          <Label htmlFor={`preview-publish-${workspaceId}`} className="shrink-0 text-xs text-muted-foreground">
            {t("对外发布")}
          </Label>
          {!domain && (
            <span className="min-w-0 truncate text-[0.625rem] text-muted-foreground">
              {t("服务端没配公网域名，发布后也访问不到")}
            </span>
          )}
          {domain && container.exposed !== true && (
            <span
              className="min-w-0 truncate text-[0.625rem] text-muted-foreground"
              title={
                container.previewKey
                  ? t('未对外发布：公网入口只认带预览 key 的访问，复制地址时会把 key 一起带上')
                  : t('未对外发布且还没有预览 key，公网入口一律拒绝：去「容器设置」点一次「重新生成」')
              }
            >
              {container.previewKey ? t('未发布：链接自带预览 key') : t('未发布：去「容器设置」生成预览 key')}
            </span>
          )}
        </div>
      </div>

      {activeUrl ? (
        // `overflow-hidden`：iframe 是行内元素、底边会多出几像素的基线空隙，不加裁切时
        // 面板右/下缘会冒出一条本不该存在的滚动条
        <div className="min-h-0 flex-1 overflow-hidden">
          <PreviewFrame
            url={activeUrl}
            useWebview={host?.capabilities.webview === true}
            reloadSeq={reloadSeq}
          />
        </div>
      ) : project?.state === 'starting' ? (
        // 用户自己在别处（项目菜单 / 主区域卡片）点了启动：这里只**如实显示进度**，不参与启动
        <PreviewErrorPage
          tone="wait"
          icon={<Loader2 className="size-6 animate-spin" />}
          title={t("容器正在启动")}
          description={t("就绪后这里会自动显示页面，不用手动刷新。")}
          details={[
            { key: t('当前阶段'), value: t(PHASE_LABELS[project.phase ?? ''] ?? '准备中') },
            { key: t('项目'), value: container.slug }
          ]}
        />
      ) : project?.state === 'stopping' ? (
        // `docker stop` 的优雅退出窗口（最多 5 秒）：容器还在，但已经不该再往里发请求了
        <PreviewErrorPage
          tone="wait"
          icon={<Loader2 className="size-6 animate-spin" />}
          title={t("容器正在停止")}
          description={t("停好之后预览会回到「容器没有启动」。想继续看页面，等它停完再点一次启动（或去项目菜单的「容器状态 → 启动容器」）。")}
          details={[
            { key: t('项目'), value: container.slug },
            { key: t('状态'), value: t('停止中（docker stop 优雅退出窗口）') }
          ]}
        />
      ) : project?.state === 'running' ? (
        // 已经在跑但还没拿到端口映射（`docker ps` 现读，刚起来那一两秒）—— 别说成「已停止」
        <PreviewErrorPage
          tone="wait"
          icon={<Loader2 className="size-6 animate-spin" />}
          title={t("正在等预览服务就绪")}
          description={t("容器已经起来了，里面的预览服务还在监听。通常一两秒，就绪后自动显示。")}
        />
      ) : project?.state === 'error' ? (
        <PreviewErrorPage
          tone="error"
          icon={<ServerCrash className="size-6" />}
          title={t("容器启动失败")}
          description={t("预览要跑在容器里，容器没起来就没有页面可看。下面这段是启动时的原话，可以拿去搜或者贴给 agent；修好之后去项目菜单的「容器状态 → 启动容器」重试。")}
          details={[
            { key: t('原因'), value: project.error ?? t('服务端没有给出原因') },
            { key: t('项目'), value: `${container.slug} · ${container.image}` }
          ]}
        />
      ) : (
        <PreviewErrorPage
          tone="blocked"
          icon={<Container className="size-6" />}
          title={publicBlockedReason ? t('公网预览被挡住了') : t('容器没有启动')}
          description={
            publicBlockedReason ??
            (t('预览页面跑在容器里，容器没起来就没有东西可看。') +
              (localUrl
                ? t('可以直接切到「内网」看，或者去左侧项目菜单的「容器状态 → 启动容器」。')
                : t('这个面板不会替你启动容器 —— 去左侧项目菜单的「容器状态 → 启动容器」。')))
          }
          // ⚠️ 明细里**不写端口**：端口是宿主侧的实现细节，用户要的是「能不能看到页面」，
          // 换一次容器映射就变一个数，写出来只会让人以为要自己记 / 自己转发。
          details={[{ key: t('项目'), value: `${container.slug} · ${container.image}` }]}
          actions={
            // ⚠️ 这里**没有启动按钮**：看预览不该把容器拉起来（用户明确要求）。
            // 只给「再问一次服务端状态」，以及本机后端时切去内网地址。
            <>
              <Button size="sm" variant="outline" onClick={() => setReloadSeq((n) => n + 1)}>
                <RefreshCw className="size-4" />
                {t("重新检测")}
              </Button>
              {localUrl && (
                <Button size="sm" variant="ghost" onClick={() => setChoice('local')}>
                  <PlugZap className="size-4" />
                  {t("看内网地址")}
                </Button>
              )}
            </>
          }
        />
      )}
    </div>
  )
}
