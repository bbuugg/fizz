/**
 * 组装 Hono 应用：日志 / 跨域 / 鉴权 / 全部业务路由 / 静态托管 / 兜底错误。
 *
 * 与 Next 版（`app/api/**`）的关系：**业务路由就是那批 Route Handler 文件本身**，
 * 通过 `next-route.ts` 的适配层挂上来（URL 由目录结构推导），所以这里没有一行
 * `app.get('/x', …)`。新增接口 = 在 `./api/` 下加一个 `route.ts`，装配代码不用动。
 *
 * 鉴权语义与 Next 版的 `proxy.ts` 逐条对齐（JWT，不再是旧的固定 TOKEN）。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { authEnabled, extractTokenFromRequest, verifyJwt } from './lib/auth-jwt'
import { resolveClientIp, setClientIp } from './lib/rate-limit'
import { compareRoutePaths, mountRouteModule, routePathFromModuleKey, type RouteModule } from './next-route'

const NAME = 'fizz-server'
const VERSION = '0.0.21'

/**
 * 编译期收集全部 Next 风格路由模块（`api/**\/route.ts`）。
 *
 * ⚠️ `import.meta.glob` 的模式**必须是字面量**（Vite 在构建期做静态替换），别改成变量。
 */
const ROUTE_MODULES = import.meta.glob<RouteModule>('./api/**/route.ts', { eager: true })

export interface CreateAppOptions {
  /**
   * 是否给 `/api/*` 挂 JWT 鉴权。默认 `true`（部署形态：端口暴露出去，必须鉴权）。
   *
   * 桌面端是**进程内直连**（`app.fetch()`，不占端口、不出进程），没有第三方能碰到这个
   * 请求通道，所以关掉 —— 少一层「token 从哪来」的耦合。
   */
  auth?: boolean
  /** 是否托管 `apps/web/dist`（同源部署用）。默认 `true`；桌面端渲染进程走 file://，不需要。 */
  staticWeb?: boolean
}

/**
 * 不需要 JWT 的路径（逐条对齐 Next 版的 `proxy.ts`，每条都写清为什么）：
 * - 登录接口本身：否则永远登不进去；
 * - 验证码配置下发：登录页还没拿到 token，前端要靠它知道「要不要弹滑块、去哪儿弹」；
 * - 容器内 bridge 回传节点事件：用固定回调 token，在路由内自己比对；
 * - 截图：文件名是随机 UUID（高熵不可猜），且 markdown 里的 `<img>` 带不了
 *   Authorization 头，启用鉴权时也得能直接加载。
 * - 上传附件：与截图同款 —— 文件名是服务端生成的 UUID（高熵不可猜），消息里的
 *   `<img>` / 预览带不了 Authorization 头。
 */
function isPublicPath(pathname: string): boolean {
  if (pathname === '/api/auth/login' || pathname.startsWith('/api/auth/login/')) return true
  if (pathname === '/api/auth/captcha' || pathname.startsWith('/api/auth/captcha/')) return true
  if (/^\/api\/flow-projects\/[^/]+\/nodes\/[^/]+\/events$/.test(pathname)) return true
  if (/^\/api\/uploads\/[^/]+$/.test(pathname)) return true
  return /^\/api\/screenshots\/[^/]+$/.test(pathname)
}

function unauthorized(): Response {
  return Response.json({ error: '未授权：请重新登录' }, { status: 401 })
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const { auth = true, staticWeb = true } = options
  const app = new Hono()

  /** 全站访问日志（method / path / 状态 / 耗时） */
  app.use('*', async (c, next) => {
    const started = Date.now()
    await next()
    console.log(`${c.req.method} ${c.req.path} → ${c.res.status} ${Date.now() - started}ms`)
  })

  /**
   * 跨域白名单：默认放行本机的 Vite dev 端口（web 5178 / desktop 5175 / mobile 5180）——
   * dev 时想让前端直连 server 就走 CORS。要加更多来源设 `FIZZ_CORS_ORIGINS`（逗号分隔）。
   *
   * 还有 Capacitor 本地 `www` 的三条：安卓壳的页面 origin 是 `https://localhost`
   * （`androidScheme`），API 却在**另一台机器**上 —— 不放行的话壳里所有 `/api` 与 SSE
   * 都会被浏览器按 CORS 拦掉，表现是「登录页都上不去」，而同一份前端在浏览器里好好的。
   *
   * ⚠️ 必须注册在鉴权中间件**之前**：OPTIONS 预检请求不带 token，
   * cors 中间件要能直接应答它（否则预检先吃 401，浏览器直接拒绝后续真请求）。
   */
  const CORS_ORIGINS = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5175',
    'http://127.0.0.1:5175',
    'http://localhost:5178',
    'http://127.0.0.1:5178',
    'http://localhost:5180',
    'http://127.0.0.1:5180',
    /*
     * Chrome 扩展的 **dev** 端口（`npm run dev:extension`）。
     *
     * 只有调试样式时才用得上：装进浏览器的扩展页面 origin 是 `chrome-extension://<id>`，
     * 靠 manifest 的 `host_permissions` 直连，**不经过 CORS**（也放不进来 —— 扩展 id 是
     * 装上去才生成的，白名单写死不了）。
     */
    'http://localhost:5190',
    'http://127.0.0.1:5190',
    // Capacitor 本地 www（androidScheme https 是默认；另外两条是历史 / iOS 写法）
    'https://localhost',
    'http://localhost',
    'capacitor://localhost',
    ...(process.env.FIZZ_CORS_ORIGINS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [])
  ]
  app.use(
    '*',
    cors({
      origin: CORS_ORIGINS,
      allowMethods: ['GET', 'POST', 'DELETE', 'PATCH', 'PUT', 'OPTIONS'],
      allowHeaders: ['authorization', 'content-type'],
      maxAge: 86_400
    })
  )

  /** 探活：不需要 token（容器 / 负载均衡用） */
  app.get('/healthz', (c) => c.text('ok'))

  /**
   * 客户端 IP 旁路：把解析好的 IP 绑到 `c.req.raw` 上，供限流器（登录 / 验证码）读取。
   *
   * 为什么在这里做而不是路由里：路由处理函数拿到的是原生 `Request`（见 `next-route.ts`），
   * 拿不到 Hono 的 `Context`，也就调不了 `getConnInfo(c)`。中间件先解析、`setClientIp`
   * 挂到同一个 `Request` 对象上，路由里 `clientIpOf(request)` 就能取回。
   *
   * 只挂 `/api/*`：静态资源不需要 IP，而 `resolveClientIp` 在非 Node 场景（桌面端进程内
   * `app.fetch()`）靠 try/catch 兜底 —— 每个静态文件都抛一次异常太浪费。
   */
  app.use('/api/*', async (c, next) => {
    setClientIp(c.req.raw, resolveClientIp(c))
    await next()
  })

  /**
   * 其余 `/api/*` 一律要 JWT：
   * - 未启用鉴权（没配 `FIZZ_AUTH_*` / `FIZZ_JWT_SECRET`）= 开发态，全部放行；
   * - token 从 `Authorization: Bearer` 头或 `?token=` 查询参数取（WS / `<img>` 带不了头）。
   */
  if (auth) {
    app.use('/api/*', async (c, next) => {
      if (isPublicPath(c.req.path)) return next()
      if (!authEnabled()) return next()
      const token = extractTokenFromRequest(c.req.raw)
      if (!token || !(await verifyJwt(token))) return unauthorized()
      return next()
    })
  }

  /**
   * 挂载全部业务路由。排序见 `compareRoutePaths`：具体路径优先，catch-all
   * （`api/[...notfound]`）永远最后，免得把具体路由吞掉。
   */
  const keys = Object.keys(ROUTE_MODULES).sort((a, b) =>
    compareRoutePaths(routePathFromModuleKey(a), routePathFromModuleKey(b))
  )
  for (const key of keys) {
    const mod = ROUTE_MODULES[key]
    if (mod) mountRouteModule(app, key, mod)
  }

  // ---------- Mobile 产物托管（/m/*） + 手机浏览器自动跳转 ----------
  // 产物位置：apps/mobile/dist-server（`npm run build:mobile:hosted` 的产物，base=/m/）。
  // 与 APK 版互不干扰：APK 用 dist/（base=/），这里用 dist-server/（base=/m/）。
  // 没构建过 hosted 产物时不挂也不跳 —— 手机浏览器照旧用 web 的响应式布局。
  const MOBILE_DIR = process.env.FIZZ_MOBILE_DIR ?? join(import.meta.dirname, '../../mobile/dist-server')
  if (staticWeb && existsSync(join(MOBILE_DIR, 'index.html'))) {
    /**
     * 手机 UA 访问 web 首页的 HTML 导航 → 302 到 /m/。刻意收窄，避免误伤：
     * - 只有 `/` 与 `/index.html`：其余路径交给 web 静态 / SPA 回退；
     * - 必须带 `Accept: text/html`：API、SSE、静态资源、健康检查都不跳；
     * - 只认 UA：iPad 默认报 Macintosh 桌面 UA 这类误判随它去 web（想用 mobile 版手动开 `/m/`）。
     */
    const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i
    app.use('*', async (c, next) => {
      const path = c.req.path
      if (c.req.method !== 'GET' || (path !== '/' && path !== '/index.html')) return next()
      if (!(c.req.header('accept') ?? '').includes('text/html')) return next()
      if (!MOBILE_UA.test(c.req.header('user-agent') ?? '')) return next()
      return c.redirect('/m/', 302)
    })
    app.get('/m', (c) => c.redirect('/m/'))
    /** 去掉 `/m` 前缀：`/m/assets/x.js` → `/assets/x.js`（产物内部已是 base=/m/ 的绝对引用） */
    const stripMobile = (p: string): string => p.slice(2)
    app.use('/m/*', serveStatic({ root: MOBILE_DIR, rewriteRequestPath: stripMobile }))
    // SPA 回退：/m/ 下的未知路径回 mobile 的 index.html（mobile 不注册 SW，无跨缓存歧义）
    app.get('/m/*', serveStatic({ root: MOBILE_DIR, path: 'index.html', rewriteRequestPath: stripMobile }))
  }

  // ---------- 静态托管 Web 产物（同源部署：不用配 CORS） ----------
  // 产物位置：apps/web/dist（可用 FIZZ_WEB_DIR 覆盖）。存在才挂，不存在就只提供 API。
  const WEB_DIR = process.env.FIZZ_WEB_DIR ?? join(import.meta.dirname, '../../web/dist')
  if (staticWeb && existsSync(join(WEB_DIR, 'index.html'))) {
    /**
     * Service Worker 脚本单独挂一条，为的是两件静态中间件给不了的事：
     * 1. **`Cache-Control: no-cache`** —— SW 脚本被 HTTP 缓存住的话，改了缓存策略 / 版本要
     *    等浏览器自己那套上限（最长 24h）才看得到；明确 no-cache = 每次导航都回来核对；
     * 2. **文件缺失时如实 404** —— 此前 `/sw.js` 不存在，靠下面的 SPA 回退把 index.html 发了
     *    回来，客户端拿到的是 `text/html`，报「unsupported MIME type」这种很难查的错。
     */
    app.get('/sw.js', async (c) => {
      const file = join(WEB_DIR, 'sw.js')
      if (!existsSync(file)) return c.notFound()
      return c.body(await readFile(file, 'utf8'), 200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache'
      })
    })
    app.use('*', serveStatic({ root: WEB_DIR }))
    // SPA 回退：其余未知路径交给前端（当前是单页，直接把 index.html 发回去）。
    // 未命中的 `/api/*` 不用在这里兜 —— `api/[...notfound]` 会如实回 404 JSON。
    app.get('*', serveStatic({ root: WEB_DIR, path: 'index.html' }))
  }

  app.onError((err, c) => {
    console.error('[server] 未捕获错误：', err)
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  })

  return app
}

export const SERVER_INFO = { name: NAME, version: VERSION }

/** 供宿主（桌面端远程访问）注入密码哈希的持久化方式，见 `lib/auth-password.ts` */
export { setPasswordPersister } from './lib/auth-password'
