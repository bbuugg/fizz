/**
 * 连接页（登录）：单用户，表单只填密码，**点「登录」之后才拉验证码、才弹滑块**。
 * 服务端还没有密码时（`FIZZ_AUTH_PASS` 为空），这次输入的密码就是新密码。
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
 * 视觉与工作台同一套语言：画布色（默认 `bg-sidebar`，手机壳传 `background`）上浮一张
 * 「浮岛」卡片，黑白灰主体；
 * 彩色只从 logo 的渐变里借 —— 几团重 blur 的低透明度光斑 + 细点阵做氛围，克制不抢戏。
 *
 * 登录 / 鉴权失败统一由服务端回 401。表单级错误提示走**右下角 sonner toast**
 * （`useErrorToast`，与工作台那条全局错误提示同一个机制、同一个固定 id），
 * **不显示在输入框下面**。
 */
import { useRef, useState } from 'react'
// 已去掉 next/image：SPA 下用原生 <img>
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
// 品牌 logo：直接 import 图片，Turbopack 会返回可访问的 URL（assets/logo.png）
import logoSrc from '@fizz/agent-kit/shared/assets/logo.png'
import { useErrorToast } from '@fizz/agent-kit/shared/hooks/use-error-toast'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useCaptcha } from '@fizz/agent-kit/shared/components/captcha'
import { resolveServerUrl, type Connection } from '@fizz/agent-client/api'
// 服务端地址只认 `setServerBase()` 那一份覆盖（各端 `main.tsx` 在 render 之前注入）：
// 不自己读 env / localStorage，也不读某个宿主的 `loadConnection` —— 各端 localStorage
// 的 key 不同（web `fizz.web.*` / mobile `fizz.mobile.*`），读错宿主就是「登录打到 A、
// 工作台连 B」或者干脆打回页面自己的 origin。
import { getServerBaseOverride } from '@fizz/agent-client/host'

/** 登录失败时服务端回的机器可读原因（见 apps/server 的 login 路由） */
type LoginErrorCode = 'captcha' | 'credentials' | 'rate-limited'

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
   * 手机壳的外层 / 顶栏 / 底栏 / 主区全是 `bg-background`，传 `background`
   * （暗色下 `--sidebar` 比 `--background` 亮一档，不传就是一块更浅的灰）。
   */
  canvas?: 'sidebar' | 'background'
}) {
  // 密码**不存 React state**，而是提交时从表单 DOM 里读。原因：浏览器刷新后自动填充
  // 是直接改 input.value 的，不保证触发 React 的 onChange；受控写法会让「屏幕上有字、state 里是空串」，
  // 登录按钮就永久置灰，而且 disabled 的提交按钮还会让回车也触发不了提交。
  // 验证码弹窗要提交时也得再读一次表单，所以这里留住 form 的引用。
  const t = useT()
  const formRef = useRef<HTMLFormElement>(null)
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
   * 错误提示 → 右下角 toast（固定 id：同一条反复触发只更新那一条，connect 失败重试时最容易堆）。
   *
   * 本地错误（没填 / 密码错 / 连不上）优先于从 store 带过来的 `error`（401 掉线时
   * app-shell 特意留着的那份）—— 两者都通过这一个 hook 显示，不会同时弹两条。
   * `duration: Infinity`：错误不自己消失，用户处理完或主动关掉才收（见 useErrorToast）。
   */
  useErrorToast(localError ?? error, () => {
    setLocalError(null)
    onDismissError?.()
  })

  /**
   * 登录请求打哪个服务端：**同源**（页面由 server 托管）或绝对地址
   * （独立 vite 工程 / Capacitor 本地 `www`，见 `@fizz/agent-client/host` 的 `setServerBase`）。
   *
   * 现取而不是渲染期取值：`setServerBase` 在 `main.tsx` 里注入，虽然早于渲染，
   * 但 HMR / 模块热替换期间可能重跑一遍，现取最稳（一次函数调用，无副作用）。
   */
  const currentServerBase = (): string | undefined => getServerBaseOverride() ?? undefined

  /**
   * 验证码弹窗（本仓库内置滑块）。返回值的含义：
   * 非空字符串 = 一次性票据；`''` = 服务端不要求验证码；`null` = 用户取消。
   */
  const captcha = useCaptcha()

  /** 从表单 DOM 读密码（自动填充也能读到） */
  const readPassword = (): string | null => {
    const form = formRef.current
    if (!form) return null
    return String(new FormData(form).get('password') ?? '')
  }

  /** 真正发登录请求。凭据每次都重新从表单读 */
  const doLogin = async (captchaPass: string): Promise<void> => {
    if (busyRef.current) return
    /*
     * 服务端地址**提交时现取**：`loadConnection()` 在渲染那一刻可能还是 null（模块求值
     * 与 `setServerBase` 之间的时序、HMR 都会错开一拍），现取一次没有副作用，
     * 而地址错了（打到页面自己的 origin）是「登录页根本上不去」这种硬故障。
     */
    const base = currentServerBase()
    const password = readPassword()
    if (password === null || !password) {
      setLocalError('请输入密码')
      return
    }
    busyRef.current = true
    setBusy(true)
    setLocalError(null)
    try {
      // 登录接口：同源，或 `VITE_FIZZ_SERVER_URL` 指定的绝对地址（跨源时服务端要放行 CORS）
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
    void (async () => {
      busyRef.current = true
      setBusy(true)
      setLocalError(null)
      // needLogin：要不要接着发登录请求（验证码取消 = 不发）
      let passToken: string | null = null
      let needLogin = true
      try {
        // 一次请求就拿到挑战（服务端不要求时返回 enabled: false，hook 内部直接放行成 ''）
        passToken = await captcha.request(currentServerBase())
        needLogin = passToken !== null
      } finally {
        // 弹窗阶段的占用先放掉，doLogin 自己会重新判重 + 占用
        busyRef.current = false
        setBusy(false)
      }
      if (needLogin) await doLogin(passToken ?? '')
    })()
  }

  /** 画布底色：见 `canvas` prop 的说明 */
  const canvasClass = canvas === 'background' ? 'bg-background' : 'bg-sidebar'

  return (
    // 外层不裁剪：视口过矮时卡片要能随文档滚动；裁剪收在装饰层自己身上
    <div
      className={`relative flex min-h-dvh items-center justify-center p-6 ${canvasClass}`}
    >
      {/* 氛围层：点阵 + 品牌渐变光斑，纯装饰（aria-hidden + pointer-events-none） */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* 点阵：muted-foreground 调出低对比灰点，椭圆蒙版向四周淡出，随主题自适应 */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(color-mix(in oklab, var(--muted-foreground) 16%, transparent) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            maskImage: 'radial-gradient(ellipse 55% 45% at 50% 42%, black, transparent)',
            WebkitMaskImage: 'radial-gradient(ellipse 55% 45% at 50% 42%, black, transparent)'
          }}
        />
        {/* 光斑颜色取自 logo 渐变（橙 → 紫 → 蓝），重 blur 压成一片氛围，明暗主题都成立 */}
        <div className="absolute -top-24 left-[8%] size-72 rounded-full bg-orange-500/15 blur-[110px]" />
        <div className="absolute top-[30%] right-[4%] size-80 rounded-full bg-blue-500/15 blur-[110px]" />
        <div className="absolute -bottom-24 left-[30%] size-72 rounded-full bg-purple-500/10 blur-[110px]" />
      </div>

      <div className="relative w-full max-w-sm animate-in fade-in slide-in-from-bottom-2 [animation-duration:500ms]">
        {/* 浮岛卡片：与工作台主区域同源（border + bg-card + 项目圆角），只多一档轻阴影 */}
        <div className="rounded-lg bg-card p-8 shadow-sm">
          {/* 品牌区：与侧栏同一份 logo 素材，居中放大 */}
          <div className="flex flex-col items-center text-center">
            <img src={logoSrc} alt="" className="size-16" />
            <h1 className="mt-4 text-xl font-semibold tracking-tight">{t('登录 Fizz')}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">{t('自托管的 AI Agent 工作台')}</p>
          </div>

          <form
            ref={formRef}
            onSubmit={submit}
            className="mt-8 space-y-4"
            // 有输入就把上一次的报错收掉，避免旧提示一直挂着
            onChange={() => localError && setLocalError(null)}
          >
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-sm font-medium">
                {t('密码')}
              </label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t('输入密码')}
                  className="pr-10"
                  autoComplete="current-password"
                  autoFocus
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={t(showPassword ? '隐藏密码' : '显示密码')}
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
            <Button type="submit" className="w-full mt-2" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t('登录中…') : t('登录')}
            </Button>
          </form>
        </div>
      </div>

      {/* 验证码弹窗（portal）：不渲染在卡片里，避免卡片内 overflow / 层叠上下文干扰 */}
      {captcha.node}
    </div>
  )
}
