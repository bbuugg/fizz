/**
 * 连接页（登录）：表单填服务地址 + 密码，**点「登录」之后才拉验证码、才弹滑块**。
 * 服务端还没有密码时（`FIZZ_AUTH_PASS` 为空），这次输入的密码就是新密码。
 *
 * 服务地址是这个 APK 连哪台 server 的唯一配置（不再构建期烘死）：填过就存进
 * `fizz.mobile.serverUrl`，下次启动 `main.tsx` 会先读出来再注入请求层，登录页也用它预填。
 *
 * 验证码是**本仓库内置**的滑块（服务端 `apps/server/src/lib/captcha`，前端
 * `agent-kit/shared/components/captcha`），不再加载任何外部 SDK 或请求第三方域名 ——
 * 离线 / 内网部署也能正常登录。
 *
 * 流程：
 * 1. 打开页面**什么都不请求** —— 不预取验证码，点登录才发；
 * 2. 点「登录」→ 校验表单填没填 → `GET /api/auth/captcha` 当场签发一张挑战：
 *    - `{ enabled: false }`（未启用鉴权 / 开发态 / `FIZZ_AUTH_CAPTCHA=0`）→ 直接 `POST /api/auth/login`；
 *    - `{ enabled: true, challenge }` → 弹滑块：拖对 → `POST /api/auth/captcha/verify` →
 *      服务端校验轨迹与位置 → 返回**一次性票据**；
 * 3. 票据作为 `captchaPass` 随登录请求上送，服务端消费作废后才验凭据；
 * 4. 失败按服务端返回的 `code` 分流：
 *    - `captcha`（票据无效 / 已消费）→ toast 提示，重新点「登录」再拖一次；
 *    - 其它（凭据错 / 限流 / 网络）→ toast，等用户重试。
 *
 * 弹窗的生命周期由 `useCaptcha()` 管（成功 / 取消 / Esc 都会 resolve），本组件只拿一个
 * 字符串票据。用户取消（resolve 为 null）就不发登录请求。票据一次性：无论登录成败都被
 * 消费，重试必须重新拖。
 *
 * 视觉：**满幅画布 + 一列到底，没有卡片**（用户明确要求）。
 *
 * - 画布色（默认 `bg-sidebar`，手机壳传 `background`）铺满整屏，表单直接落在画布上；
 *   没有 `bg-card` / 边框 / 阴影那一层「浮岛」—— 少一层容器，视线就只落在字和输入框上。
 * - 纵向三段：品牌区（logo + 标题）居中偏上 → 表单 → 页脚一行小字。整列 `max-w-sm`
 *   居中，`flex-1 justify-center`：屏幕高时居中留白，键盘弹起时自然往下滚。
 * - 彩色只从 logo 里借（青 / 天蓝 / 珊瑚），几团重 blur 的低透明度光斑 + 细点阵做氛围，
 *   克制不抢戏；输入框 / 按钮的圆角统一到 `rounded-xl`，比工作台里的 `rounded-md` 更松弛。
 * - 安全区：`--safe-area-inset-top/bottom`（SystemBars 注入）补在外层，
 *   状态栏 / 手势条不会压住标题和页脚。
 *
 * 登录 / 鉴权失败统一由服务端回 401。表单级错误提示走**右下角 sonner toast**
 * （`useErrorToast`，与工作台那条全局错误提示同一个机制、同一个固定 id），
 * **不显示在输入框下面**。
 */
import { useEffect, useRef, useState } from 'react'
// 已去掉 next/image：SPA 下用原生 <img>
import { Capacitor } from '@capacitor/core'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
// 品牌 logo：直接 import 图片，Turbopack 会返回可访问的 URL（assets/logo.png）
import logoSrc from '@fizz/agent-kit/shared/assets/logo.png'
import { useErrorToast } from '@fizz/agent-kit/shared/hooks/use-error-toast'
import { useCaptcha } from '@fizz/agent-kit/shared/components/captcha'
import {
  normalizeServerBase,
  resolveServerUrl,
  type Connection
} from '@fizz/agent-client/api'
// 服务端地址：`setServerBase()` 是运行时唯一真源（各端 `main.tsx` 在 render 之前注入）。
// 手机壳把地址交给用户填、存在自己的 `fizz.mobile.serverUrl`，不再从构建期 env 读 ——
// 同一个 APK 可以连不同服务器。
import { getServerBaseOverride, setServerBase } from '@fizz/agent-client/host'
import { loadServerUrl, saveServerUrl } from '@/server-url'

/** 登录失败时服务端回的机器可读原因（见 apps/server 的 login 路由） */
type LoginErrorCode = 'captcha' | 'credentials' | 'rate-limited'

/**
 * 「服务端地址必须填」的判据。
 *
 * 判的其实是**页面是不是由 server 托管**：托管时留空正是同源（相对路径的 `/api` 本来
 * 就通），不能逼用户填；不托管时页面的 origin 上**根本没有后端**，留空就等于把所有请求
 * 打到一个不存在的地方，表现是「登录页永远连不上」。
 *
 * 目前有两种不托管的情形：
 * - 安卓壳（Capacitor）的本地 `www`，origin 是 `https://localhost`；
 * - Chrome 扩展页（`apps/extension`，外壳就是本文件所在这套），origin 是
 *   `chrome-extension://<id>`。
 *
 * 与布局无关，别拿「是不是手机」之类的判断来代劳 —— 这里只认 origin。
 */
function mustFillServerBase(): boolean {
  if (Capacitor.isNativePlatform()) return true
  return typeof location !== 'undefined' && location.protocol === 'chrome-extension:'
}

export function ConnectGate({
  error,
  onConnect,
  onDismissError,
  canvas = 'sidebar'
}: {
  initial?: Connection | null
  error: string | null
  onConnect: (connection: Connection) => Promise<boolean>
  /** 关掉 toast 时把 store 里的 error 一并清掉（不传就只清本地那一份） */
  onDismissError?: () => void
  /**
   * 画布底色：默认 `sidebar`，与 web / desktop 外壳（`bg-sidebar`）连成一片；
   * 手机壳的顶栏 / 主区全是 `bg-background`，传 `background`
   * （暗色下 `--sidebar` 比 `--background` 亮一档，不传就是一块更浅的灰）。
   */
  canvas?: 'sidebar' | 'background'
}) {
  // 密码**不存 React state**，而是提交时从表单 DOM 里读。原因：浏览器刷新后自动填充
  // 是直接改 input.value 的，不保证触发 React 的 onChange；受控写法会让「屏幕上有字、state 里是空串」，
  // 登录按钮就永久置灰，而且 disabled 的提交按钮还会让回车也触发不了提交。
  // 验证码弹窗要提交时也得再读一次表单，所以这里留住 form 的引用。
  const formRef = useRef<HTMLFormElement>(null)
  /**
   * 服务地址输入框的初值：启动时 `main.tsx` 已经按「查询参数 → 本地保存 → 连接记录」
   * 注入过覆盖，这里直接取它；没有就空着，让用户填。
   */
  const [initialServerUrl] = useState(
    () => getServerBaseOverride() ?? loadServerUrl() ?? ''
  )
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * `busy` 的即时副本。同一个事件里要「先 await 拿验证码、再决定发不发登录请求」，
   * 而 state 在这次渲染结束前不会更新 —— 只看 `busy` 会读到过期的 false，
   * 连点两下「登录」就会发两轮请求。判重一律走这个 ref。
   */
  const busyRef = useRef(false)
  const [localError, setLocalError] = useState<string | null>(null)

  /**
   * 进登录页 = 干净的起点：把**上一轮（工作台）**留在屏幕上的 toast 全收掉。
   *
   * 错误 toast 是 `duration: Infinity`（「连不上 / 未授权」这类要等人处理的错误不自己消失），
   * 而 401 把用户踢回这一屏时，那几条报错讲的是**上一个会话**的事，这一屏没有任何上下文
   * 解释它们 —— 表现就是「进登录页，头顶挂着一堆未登录的提示」。
   *
   * ⚠️ 必须在 `useErrorToast` **之前**声明：effect 按声明顺序执行，先清场再弹这一屏自己的
   * 错误（登录失败 / 地址填错），否则会把刚弹出来的那条一起收掉。
   */
  useEffect(() => {
    toast.dismiss()
  }, [])

  /**
   * 错误提示 → 右下角 toast（固定 id：同一条反复触发只更新那一条，connect 失败重试时最容易堆）。
   *
   * 本地错误（没填 / 密码错 / 连不上）优先于从 store 带过来的 `error`（`connect()` 探测失败
   * 时写进去的那条）—— 两者都通过这一个 hook 显示，不会同时弹两条。
   * 注意 401 掉线**不会**走到这里：那条路是 `disconnect()`，它会把 `error` 一并清掉
   * （否则工作台那一轮的报错会跟到登录页上）。
   * `duration: Infinity`：错误不自己消失，用户处理完或主动关掉才收（见 useErrorToast）。
   */
  useErrorToast(localError ?? error, () => {
    setLocalError(null)
    onDismissError?.()
  })

  /**
   * 验证码弹窗（本仓库内置滑块）。返回值的含义：
   * 非空字符串 = 一次性票据；`''` = 服务端不要求验证码；`null` = 用户取消。
   */
  const captcha = useCaptcha()

  /**
   * 从表单读服务地址并规整。
   *
   * 返回 `null` = 填得不对（已经写好错误提示）；`{ base: undefined }` = hosted 版留空，
   * 走同源（页面由 server 托管）；`{ base }` = 绝对地址。
   *
   * ⚠️ 原生壳（Capacitor）与浏览器扩展必须填：页面 origin 分别是 `https://localhost` /
   * `chrome-extension://<id>`，留空后所有请求都打向它自己，表现是「登录页永远连不上」。
   * hosted 版反过来 —— 留空正是同源，不能逼填。判据见 `mustFillServerBase`。
   */
  const readServerBase = (): { base?: string } | null => {
    const form = formRef.current
    if (!form) return null
    const raw = String(new FormData(form).get('serverUrl') ?? '').trim()
    if (!raw) {
      if (mustFillServerBase()) {
        setLocalError('请输入服务地址，例如 http://192.168.1.5:7801')
        return null
      }
      return {}
    }
    const base = normalizeServerBase(raw)
    try {
      const url = new URL(base as string)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        setLocalError('服务地址只支持 http:// 或 https://')
        return null
      }
    } catch {
      setLocalError('服务地址格式不正确，例如 http://192.168.1.5:7801')
      return null
    }
    return { base }
  }

  /** 从表单 DOM 读密码（自动填充也能读到） */
  const readPassword = (): string | null => {
    const form = formRef.current
    if (!form) return null
    return String(new FormData(form).get('password') ?? '')
  }

  /** 真正发登录请求。凭据每次都重新从表单读 */
  const doLogin = async (captchaPass: string, base: string | undefined): Promise<void> => {
    if (busyRef.current) return
    const password = readPassword()
    if (password === null || !password) {
      setLocalError('请输入密码')
      return
    }
    busyRef.current = true
    setBusy(true)
    setLocalError(null)
    try {
      // 登录接口：同源（hosted），或用户填的绝对地址（跨源时服务端要放行 CORS）
      const res = await fetch(resolveServerUrl(base, '/api/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password,
          captchaPass: captchaPass || undefined
        })
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string; code?: LoginErrorCode }
          | null
        setLocalError(body?.error ?? '登录失败')
        return
      }
      const { token } = (await res.json()) as { token: string }
      // 拿到 JWT 即视为连接成功：交给上层存连接信息 + 拉 health 校验。
      // serverBase 随连接一起落盘 —— 后续 API / SSE / WS 全靠它才不会打到页面自己的 origin
      await onConnect({ token, ...(base ? { serverBase: base } : {}) })
    } catch {
      setLocalError('连不上服务端：请确认服务端已启动')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /**
   * 点「登录」：**此刻才去要验证码挑战**。
   *
   * 服务端没开验证码（开发态 / `FIZZ_AUTH_CAPTCHA=0`）就直接登录，全程没有弹窗；
   * 开了就弹内置滑块 —— 用户拖对后拿票据自动继续登录，取消则原地返回。
   */
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busyRef.current) return
    const password = readPassword()
    if (password === null || !password) {
      setLocalError('请输入密码')
      return
    }
    const parsed = readServerBase()
    if (!parsed) return
    const base = parsed.base
    // 先把地址交给请求层并落盘：登录失败（密码错 / 服务端没起来）也要记住它，
    // 下次重试不用重新敲 IP。`setServerBase` 必须在验证码请求之前 —— 挑战也从这台服务器签。
    saveServerUrl(base)
    setServerBase(base ?? null)
    void (async () => {
      busyRef.current = true
      setBusy(true)
      setLocalError(null)
      // needLogin：要不要接着发登录请求（验证码取消 = 不发）
      let passToken: string | null = null
      let needLogin = true
      try {
        // 一次请求就拿到挑战（服务端不要求时返回 enabled: false，hook 内部直接放行成 ''）
        passToken = await captcha.request(base)
        needLogin = passToken !== null
      } finally {
        // 弹窗阶段的占用先放掉，doLogin 自己会重新判重 + 占用
        busyRef.current = false
        setBusy(false)
      }
      if (needLogin) await doLogin(passToken ?? '', base)
    })()
  }

  /** 画布底色：见 `canvas` prop 的说明 */
  const canvasClass = canvas === 'background' ? 'bg-background' : 'bg-sidebar'

  /**
   * 输入框的共用造型：比工作台的 `h-9 rounded-md` 高一点、圆一点。
   * 底色 / 描边 / focus 态全交给 `Input` 自己（`border-input` → `focus-visible:border-ring`），
   * 这里只改尺寸 —— 覆盖 `bg-*` 会和 `Input` 里的 `dark:bg-input/30` 抢同一属性，
   * 谁赢取决于产物 CSS 顺序，不碰最稳。
   */
  const fieldClass = 'h-11 rounded-xl px-3.5'

  return (
    // 外层不裁剪：键盘弹起、视口过矮时整列要能随文档滚动；裁剪收在装饰层自己身上
    <div
      className={`relative flex min-h-dvh flex-col ${canvasClass}`}
      // 安全区补在最外层：状态栏那条不压标题，手势条那条不压页脚（web / hosted 下 fallback 0）
      style={{
        paddingTop: 'var(--safe-area-inset-top, 0px)',
        paddingBottom: 'var(--safe-area-inset-bottom, 0px)'
      }}
    >
      {/* 氛围层：点阵 + 品牌色光斑，纯装饰（aria-hidden + pointer-events-none） */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* 点阵：muted-foreground 调出低对比灰点，椭圆蒙版向四周淡出，随主题自适应。
            蒙版重心抬到品牌区（50% 28%），让氛围跟着标题走而不是平铺整屏。 */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(color-mix(in oklab, var(--muted-foreground) 16%, transparent) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            maskImage: 'radial-gradient(ellipse 68% 40% at 50% 28%, black, transparent)',
            WebkitMaskImage: 'radial-gradient(ellipse 68% 40% at 50% 28%, black, transparent)'
          }}
        />
        {/* 光斑颜色取自 logo（青盘 → 蓝鱼身 → 珊瑚鳍），重 blur 压成一片氛围，明暗主题都成立 */}
        <div className="absolute -top-32 left-1/2 size-96 -translate-x-1/2 rounded-full bg-teal-400/20 blur-[110px]" />
        <div className="absolute top-[42%] -right-24 size-80 rounded-full bg-sky-500/10 blur-[110px]" />
        <div className="absolute -bottom-28 -left-16 size-72 rounded-full bg-rose-400/10 blur-[110px]" />
      </div>

      {/* 主体：一列到底，没有卡片容器 */}
      <div className="relative mx-auto flex w-full max-w-sm flex-1 animate-in flex-col justify-center px-6 py-10 fade-in slide-in-from-bottom-2 [animation-duration:500ms]">
        {/* 品牌区：logo 背后一团同色柔光，代替卡片的「托底」 */}
        <div className="flex flex-col items-center text-center">
          <div className="relative">
            <span aria-hidden className="absolute -inset-6 rounded-full bg-teal-400/20 blur-2xl" />
            <img src={logoSrc} alt="" className="relative size-20" />
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">登录 Fizz</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">自托管的 AI Agent 工作台</p>
        </div>

        <form
          ref={formRef}
          onSubmit={submit}
          className="mt-10 space-y-4"
          // 有输入就把上一次的报错收掉，避免旧提示一直挂着
          onChange={() => localError && setLocalError(null)}
        >
          <div className="space-y-1.5">
            <label htmlFor="serverUrl" className="text-sm font-medium">
              服务地址
            </label>
            <Input
              id="serverUrl"
              name="serverUrl"
              type="text"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="http://192.168.1.5:7801"
              defaultValue={initialServerUrl}
              className={fieldClass}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              填服务端根地址（带 http:// 或 https://），保存后下次自动带出。
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium">
              密码
            </label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="输入密码"
                className={`${fieldClass} pr-11`}
                autoComplete="current-password"
                autoFocus
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </div>

          {/* 错误提示不走表单内联：统一是右下角 toast（见上面的 useErrorToast） */}

          {/* 只在提交中置灰：是否填齐没法从 state 判断（自动填充不经过 onChange），
              空值交给 submit 里的校验报错，否则会出现「已填却点不动」 */}
          <Button
            type="submit"
            className="mt-2 h-11 w-full rounded-xl text-[15px] shadow-lg shadow-primary/25"
            disabled={busy}
          >
            {busy && <Loader2 className="animate-spin" />}
            {busy ? '登录中…' : '登录'}
          </Button>
        </form>
      </div>

      {/* 页脚：一行小字，给整屏一个收口（没有卡片时最容易「飘」） */}
      <p className="relative px-6 pb-6 text-center text-xs text-muted-foreground">
        自托管 · 数据只留在你自己的服务器
      </p>

      {/* 验证码弹窗（portal）：不渲染在内容列里，避免 overflow / 层叠上下文干扰 */}
      {captcha.node}
    </div>
  )
}
