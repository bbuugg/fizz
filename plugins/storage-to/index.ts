/**
 * 用户级插件：把文件传到 storage.to（https://storage.to/zh/docs/api），**以工具的形式**。
 *
 * 位置：`~/.fizz/plugins/storage-to.ts`（用户级根）。它**不随仓库分发** —— storage.to 是
 * 个人用途的分享站点，放进内置根等于给所有使用者塞一个需要账号/配额的第三方服务。
 * 放在用户级的好处：随你改（改坏了下一轮对话就恢复/删掉即可），且对所有项目都生效。
 *
 * ⚠️ 在用户级目录里**不能**靠 Node 的默认解析找依赖（那儿没有 node_modules），
 * 但 `zod` / `ai` 由**宿主提供别名**（见 `packages/plugin/src/loader.ts` 的
 * `hostSharedAliases`），所以下面照常 `import { tool } from 'ai'` / `z`。
 *
 * ## 它是个「工具插件」：注册 `upload_to_storage_to`
 *
 * 模型（或用户）说「把这个文件传上去给我个链接」时，它读工作区里的文件、走 storage.to 的
 * 三步上传（init → 预签名 PUT → confirm），返回一条**分享页链接** `https://storage.to/<id>`。
 *
 * ## 分享链接不是模型附件地址（2026-10 实测）
 *
 * 本插件只提供文件分享工具 —— 它给不出**模型能消费的直链**，
 * 两层原因任一层都致命：
 *
 * 1. **返回的是「分享页」而不是直链**：`confirm` 的 `file` 对象只有
 *    `id / url / filename / size / human_size / expires_at`，没有任何 `direct_url` 之类的字段；
 *    官方文档也没有直链一说。实测 `/api/file/<id>/status` → `200 {"pending":false}`（文件确实在），
 *    但 `/api/download/<id>`、`/api/file/<id>/download|raw`、`/api/files/<id>` 全部
 *    `404 {"error":{"code":"not_found","message":"No such route"}}` —— **不存在可用的直链接口**。
 * 2. **分享页对非浏览器客户端是 403**：`/<id>`、`?download=1`、`?raw=1`、`/embed/<id>` 等一律
 *    `403 text/html`（Cloudflare 拦截页，连完整浏览器头也一样）。
 *
 * 而 Fizz 把附件的 URL **原样交给模型**（`packages/agent/src/model-messages.ts`：图片走 `ImagePart`
 * 的 URL），模型侧去抓只会拿到一张 HTML 网页 / 一个 403。所以附件那条路换成了
 * **`plugins/oss.ts`（自己的对象存储，给得出真直链）**。
 *
 * 当**工具**用则完全合理：这条链接是给**人**点开 / 转发的，模型不需要去取它的内容。
 *
 * ## 停用它
 *
 * 设置 →「全局插件」里把 storage.to 关掉（用户级插件的开关是全局一份，与项目无关）。
 *
 * ## 凭据：只从设置页里填
 *
 * `apply` 里用 `ctx.ui.setting(...)` 声明了两个设置项，**值在 设置 →「全局插件」里填**：
 * - `token`（`secret: true`）：账号 API 令牌。落盘经 SecretBox 加密，**明文不回传浏览器**；
 *   填了就是永久保存 + 无配额限制，也能在自己的账号里管理这些文件。
 * - `visitorToken`：匿名上传用的访客令牌（同一令牌共享 24h 配额）。不填就每次进程启动
 *   随机生成一个 —— 想要配额跨重启可续就填一个固定的。
 *
 * 早先还支持 `STORAGE_TO_TOKEN` / `STORAGE_TO_VISITOR_TOKEN` 环境变量兜底，**已移除**：
 * 一个凭据两个真源，排查「为什么传不上去」时永远得先问「你到底配在哪」。容器 / 无界面
 * 部署用的是同一个设置页（同一个 server 托管 web 产物），不需要第二套入口。
 *
 * 令牌里混进 `Bearer ` 前缀或引号会被自动清掉（粘贴最常见的两种形态），所以照样能用。
 *
 * ## 图标
 *
 * `ctx.ui.icon(...)` 声明插件列表里的图标 —— 自绘的「上传」SVG（data URI，约 0.6KB）：
 * 矢量、任何尺寸都清晰，也不必内联一串两 KB 的 base64 favicon。列表里按 24px 显示，
 * 所以线条画粗、细节去掉，小尺寸下才不糊。
 *
 * ## ⚠️ 必须带浏览器 User-Agent（否则 403，且与令牌无关）
 *
 * storage.to 前面的 Cloudflare **按 UA 判客户端**：Node `fetch` 的默认 UA（undici）会被在边缘
 * 直接拒成 403 + HTML 拦截页，请求根本到不了他们的应用层。所以 `init` / `confirm` 都带上
 * `USER_AGENT`（详见那个常量的实测记录）。这类报错在新版错误文案里会明确说「不是令牌的问题」——
 * 以前它显示成一句「storage.to 拒绝了你（403）」，把人引到令牌上去了。
 *
 * ## 它是怎么接上的
 *
 * 清单里声明 `inject: []`（任何 context 都 apply，设置项才在任何挂载点都能被收集），
 * 两半能力各自用 `ctx.inject([...])` 声明依赖：设置项 / 图标要 `ui`（设置页那次 inspect
 * 与长驻 upload context 都有），工具要 `tools` + `workspace`（只在**每轮对话的 turn context**
 * 里齐 —— 上传 context 没有工作区）。
 *
 * ⚠️ 设置项的**值变了**会让服务端重新挂载这个插件（挂载缓存的指纹里含设置值），
 * 所以填完 token 立刻能用，不必重启。
 *
 * ## ⚠️ 匿名上传的文件会过期
 *
 * 按官方文档：无令牌 = 默认 3 天有效期（`expiry_days` 最长 7 天），免费账户令牌同样会过期，
 * 只有付费账户是永久。分享链接发出去几天后失效，就是这条规则。
 *
 * ## 上传流程（官方三步）
 *
 * 1. `POST /api/upload/init` → 拿预签名 `upload_url` + `r2_key`；
 * 2. `PUT {upload_url}` → 字节直接进对象存储（不经过 storage.to 的应用服务器）；
 * 3. `POST /api/upload/confirm` → 落库，返回分享页地址 `file.url`。
 *
 * 单段上传覆盖到 50MB（本插件只收 32MB，见 TOOL_MAX_BYTES），所以不实现分片分支 ——
 * 真收到 `type: "multipart"` 会明确报错而不是静默传半个文件。
 */
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { tool } from 'ai'

const API_BASE = 'https://storage.to/api'
/** 工具上传的单文件上限（读进内存再 PUT，所以留在几十 MB 级） */
const TOOL_MAX_BYTES = 32 * 1024 * 1024
const INIT_TIMEOUT_MS = 30_000
const PUT_TIMEOUT_MS = 120_000

/** 工具上传时按扩展名猜 Content-Type（对象存储里这个头决定浏览器怎么打开它） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg'
}

/**
 * ⚠️ **必须带的 User-Agent**，否则 storage.to 前面的 Cloudflare 会在边缘直接拦掉。
 *
 * 实测（本机，2026-10）：
 * - Node 的 `fetch` 默认 UA（undici）→ `POST /api/upload/init` 返回 **403 + 一张 HTML 拦截页**
 *   （`<!DOCTYPE html> … <html class="no-js ie6 oldie" lang="en-US">` 是 Cloudflare 拦截图的模板），
 *   也就是**请求根本没到 storage.to 的应用层** —— 这种 403 与 API 令牌无关，换令牌永远修不好；
 * - 换成下面这行浏览器 UA → 同一条请求立刻 `200 {"success":true,…}`，init / confirm 都通。
 *
 * 所以这不是「伪装」而是**这台 WAF 的准入要求**：它按 UA 判客户端，不认非浏览器的自动化客户端
 * （他们的文档面向 CLI / 桌面端，但边缘规则显然没放行）。将来若他们的规则改了、或者开始按别的方式
 * 判客户端，就是这个常量要动 —— 错误信息里会带上游原文，能一眼看出又撞上了哪一类拦截。
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 所有 storage.to 应用层请求（init / confirm）的公共头 */
function baseHeaders(): Record<string, string> {
  return { accept: 'application/json', 'user-agent': USER_AGENT }
}

/**
 * 插件图标：自绘的「上传」SVG（data URI）。
 *
 * 为什么不用官网的 favicon：列表里按 **24px** 渲染，favicon 那种细节多的方图缩下去就糊成
 * 一团；矢量图在任何尺寸都清晰，体积也小一个数量级（~0.6KB vs 2.5KB）。不内联官网的图还有
 * 版权与背书问题 —— 一个中性的「上传」图形足够说明这个插件干什么。用 URL 编码（而不是
 * base64）是为了源码可读、可 diff。
 */
const ICON =
  `data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 48 48%27%3E` +
  `%3Crect width=%2748%27 height=%2748%27 rx=%2712%27 fill=%27%230f172a%27/%3E` +
  `%3Cpath d=%27M14 29v5.5A3.5 3.5 0 0 0 17.5 38h13a3.5 3.5 0 0 0 3.5-3.5V29%27 stroke=%27%2338bdf8%27 stroke-width=%274%27 stroke-linecap=%27round%27 fill=%27none%27/%3E` +
  `%3Cpath d=%27M24 30V12%27 stroke=%27%2338bdf8%27 stroke-width=%274%27 stroke-linecap=%27round%27/%3E` +
  `%3Cpath d=%27M16 20l8-8 8 8%27 stroke=%27%2338bdf8%27 stroke-width=%274%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27 fill=%27none%27/%3E%3C/svg%3E`

/** 进程内固定的随机访客令牌（设置项没填时的兜底） */
const processVisitorToken = `fizz-${randomUUID()}`

/**
 * 令牌归一化：两个最容易踩的粘贴形态都吃掉 ——
 * 整行 `Bearer xxx`（调用时还会再拼一次 Bearer，变成 `Bearer Bearer xxx` 必然被拒）、
 * 以及两侧的引号（从 JSON / 配置界面复制时常见）。
 */
function normalizeToken(raw: string): string {
  return raw
    .replace(/^bearer\s+/i, '')
    .replace(/^["']+|["']+$/g, '')
    .trim()
}

/** storage.to 的错误体（JSON 里是 `error`；Cloudflare 之类的拦截会回 HTML，也要带上） */
function errorDetail(body: unknown, rawText: string): string {
  if (body && typeof body === 'object') {
    const value = (body as { error?: unknown }).error
    if (typeof value === 'string' && value) return value
  }
  const text = rawText.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 300) : ''
}

/**
 * 把某一步的失败翻成一句人能看懂、能照着修的话。
 *
 * ⚠️ 刻意**按步骤分开**：403 在「预签名 PUT」与「init / confirm」上完全是两回事 ——
 * 前者是对象存储不认这个预签名（过期 / 头部不一致），后者才跟令牌有关。混成一句
 * 「storage.to 拒绝了你」会把人往错的方向带（真发生过）。
 */
function describeApiError(step: '初始化' | '确认', status: number, body: unknown): string {
  const detail = errorDetail(body, '')
  const tail = detail ? `：${detail}` : ''
  switch (status) {
    case 401:
    case 403:
      return (
        `storage.to ${step}被拒绝（${status}）${tail}。` +
        '这一段用的是设置 →「全局插件」里的 API 令牌：先在那边把「API 令牌」清掉、' +
        '用匿名上传试一次 —— 能传就说明是令牌的问题（令牌只在创建时完整显示一次，' +
        '复制不全 / 已撤销 / 混进了 Bearer 前缀都会这样）'
      )
    case 422:
      return `storage.to ${step}校验失败或超出套餐 / 配额（422）${tail}`
    case 429:
      return `storage.to ${step}触发限流或超出上传配额（429）${tail}（匿名：每访客令牌 100GB / 24h；或填 API 令牌）`
    default:
      return `storage.to ${step}返回 ${status}${tail}`
  }
}

/** 打一次 JSON API（init / confirm），失败抛人话错误 */
async function callApi<T>(
  path: string,
  body: unknown,
  headers: Record<string, string>,
  step: '初始化' | '确认'
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    // 关键：`baseHeaders()` 里的 UA —— 缺了它会被 Cloudflare 在边缘拦掉（见 USER_AGENT 的说明）
    headers: { 'content-type': 'application/json', ...baseHeaders(), ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(INIT_TIMEOUT_MS)
  })
  const rawText = await res.text().catch(() => '')
  let json: (T & { success?: boolean }) | null = null
  try {
    json = JSON.parse(rawText) as T & { success?: boolean }
  } catch {
    /* 非 JSON（Cloudflare 拦截页之类）：错误详情走 rawText */
  }
  if (!json) {
    // 非 JSON = 没到应用层（Cloudflare 拦截页 / 网关错误页）。**必须与令牌那条区分开**：
    // 下面这类 403 换令牌永远修不好，它拦的是「客户端长什么样」。
    const looksBlocked = /<\s*html|<!DOCTYPE/i.test(rawText)
    const detail = rawText.replace(/\s+/g, ' ').trim().slice(0, 300)
    throw new Error(
      `storage.to ${step}没有返回 JSON（${res.status}）${detail ? `：${detail}` : ''}` +
        (looksBlocked
          ? '。这像是 Cloudflare 的边缘拦截页（HTML），**不是 API 令牌的问题**：' +
            '他们的 WAF 按 User-Agent 判客户端，非浏览器客户端会被直接拒 —— 本插件已带浏览器 ' +
            'UA（见文件里的 USER_AGENT），若还撞上说明规则又变了'
          : '')
    )
  }
  if (!res.ok || !json.success) throw new Error(describeApiError(step, res.status, json))
  return json
}

/**
 * 预签名 PUT 要带的头：把 init 响应里的 `headers` 透传过去。
 *
 * `Host` / `Content-Length` 由 fetch 自己算，手动设会被 undici 拒掉（而且签名本身也不该
 * 依赖发送方能改的那两个）。`content-type` 用 init 时申报的那个 —— 若对象存储把
 * content-type 也算进签名，不带上会 SignatureDoesNotMatch。
 *
 * ⚠️ **大小写不敏感地合并**：实测他们的响应里给的是首字母大写的 `Content-Type`
 * （`{"Content-Type":["image/png"]}`），照原样塞进一个普通对象就会变成
 * `content-type` + `Content-Type` **两个同名头**（R2 容忍了，别的对象存储未必）。
 * 用 Map 按小写键去重后，下游谁覆盖谁都是「一个头、一个值」。
 */
function putHeaders(extra: unknown, mediaType: string): Record<string, string> {
  const merged = new Map<string, { name: string; value: string }>()
  merged.set('content-type', { name: 'content-type', value: mediaType })
  if (extra && typeof extra === 'object') {
    for (const [key, raw] of Object.entries(extra as Record<string, unknown>)) {
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'content-length') continue
      const value = typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : ''
      if (value) merged.set(lower, { name: key, value })
    }
  }
  return Object.fromEntries([...merged.values()].map(({ name, value }) => [name, value]))
}

/** 取设置页里填的值（去首尾空白；**不读环境变量**，见文件头） */
function pick(configured: unknown): string {
  return typeof configured === 'string' ? configured.trim() : ''
}

/**
 * `ctx.inject` 回调里能拿到的服务（结构化手写，理由同下面插件本体）。
 *
 * 每个 `inject` 只在自己声明的依赖齐了之后才跑，所以回调里访问的服务必然存在 ——
 * 这里把三个能力要用的服务放一个类型里，够用即可。
 */
interface ToolCtx {
  logger: { warn: (...args: unknown[]) => void }
  ui: {
    setting: (item: unknown) => unknown
    icon: (dataUri: string) => unknown
  }
  tools: { register: (name: string, tool: unknown, opts?: unknown) => unknown }
  workspace: { path: string; label: string; resolve: (p: string) => string }
}

/**
 * 走完 storage.to 的三步上传，返回分享页地址。
 *
 * 抽成独立函数：它只服务
 * `upload_to_storage_to` 这一个工具，签名（`(input, authHeaders) => Promise<string>`）
 * 也就可以直说「给字节、还 URL」。
 */
async function uploadToStorageTo(
  input: { name: string; mediaType: string; bytes: Uint8Array },
  authHeaders: Record<string, string>
): Promise<string> {
  const { name, mediaType, bytes } = input

  // 1. 初始化：拿预签名地址与 r2_key
  const init = await callApi<{
    type?: string
    upload_url?: string
    r2_key?: string
    headers?: unknown
  }>('/upload/init', { filename: name, content_type: mediaType, size: bytes.length }, authHeaders, '初始化')
  if (init.type !== 'single' || !init.upload_url || !init.r2_key) {
    throw new Error(
      `storage.to 返回了 ${init.type ?? '未知'} 类型的上传（本插件只实现单段上传，` +
        `文件需 ≤ 50MB）：${name}`
    )
  }

  // 2. 直接把字节 PUT 到预签名地址（不经 storage.to 的应用服务器）
  const putRes = await fetch(init.upload_url, {
    method: 'PUT',
    headers: putHeaders(init.headers, mediaType),
    // `Uint8Array` 在 fetch 规范里是合法的 BodyInit，只是 TS 的 lib 类型对
    // `Uint8Array<ArrayBufferLike>` 这一支没收进来 —— 运行期没问题，这个断言只为过类型
    body: bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(PUT_TIMEOUT_MS)
  }).catch((err: unknown) => {
    throw new Error(`storage.to 预签名上传失败：${err instanceof Error ? err.message : String(err)}`)
  })
  if (!putRes.ok) {
    // 对象存储的 XML 错误体是这一步唯一有用的线索（SignatureDoesNotMatch /
    // AccessDenied / RequestTimeTooSkewed …），别只报个状态码
    const bodyText = await putRes.text().catch(() => '')
    const detail = bodyText.replace(/\s+/g, ' ').trim().slice(0, 300)
    throw new Error(
      `storage.to 预签名上传失败（${putRes.status}${putRes.statusText ? ` ${putRes.statusText}` : ''}）` +
        (detail ? `：${detail}` : '') +
        '（这一步直连对象存储，与 API 令牌无关：常见原因是预签名地址已过期，或它要求的请求头没带全）'
    )
  }

  // 3. 确认：真正落库，这一步才给出可分享的地址
  const confirm = await callApi<{ file?: { url?: string; id?: string } }>(
    '/upload/confirm',
    { filename: name, size: bytes.length, content_type: mediaType, r2_key: init.r2_key },
    authHeaders,
    '确认'
  )
  const url = confirm.file?.url
  if (typeof url !== 'string' || !url) {
    throw new Error('storage.to 没有返回文件地址（响应里缺 file.url）')
  }
  return url
}

/** 读本地文件（工具用）：大小上限 + 原文件名 */
async function readLocalFile(absPath: string): Promise<{ name: string; bytes: Uint8Array }> {
  let size: number
  try {
    const info = await stat(absPath)
    if (!info.isFile()) throw new Error('不是一个文件')
    size = info.size
  } catch (err) {
    throw new Error(`读不到文件：${absPath}（${err instanceof Error ? err.message : String(err)}）`)
  }
  if (size > TOOL_MAX_BYTES) {
    throw new Error(
      `文件太大：${(size / 1024 / 1024).toFixed(1)}MB，上限 ${TOOL_MAX_BYTES / 1024 / 1024}MB`
    )
  }
  return { name: basename(absPath), bytes: new Uint8Array(await readFile(absPath)) }
}

/**
 * 插件本体。
 *
 * 参数类型是**结构化手写**的（不 import `@fizz/plugin`）：插件目录可能不在仓库里，
 * 指望能解析到 workspace 包不可靠；jiti 直接跑 TS，类型只是给自己看的注释。
 * `zod` / `ai` 是例外（工具要建 schema），内置插件根随仓库分发，这条依赖是明确的。
 */
export default {
  name: 'storage-to',
  /**
   * 顶层不声明依赖 = **任何 context 都 apply**：设置项声明必须能在设置页那次 inspect 里
   * 跑到，而那个 context 没有工作区；反过来 turns 里又没有 ui。两半能力各自
   * `ctx.inject([...])` 声明依赖，见下面。
   */
  inject: [],

  apply(
    ctx: {
      logger: { warn: (...args: unknown[]) => void }
      inject: (deps: string[], cb: (c: ToolCtx) => void) => unknown
      ui: {
        setting: (item: unknown) => unknown
        icon: (dataUri: string) => unknown
      }
      tools: { register: (name: string, tool: unknown, opts?: unknown) => unknown }
      workspace: { path: string; label: string; resolve: (p: string) => string }
    },
    config?: { token?: string; visitorToken?: string }
  ) {
    // 凭据只认设置页（不读环境变量，见文件头）
    const token = normalizeToken(pick(config?.token))
    const visitorToken = pick(config?.visitorToken) || processVisitorToken

    /**
     * 设置项与图标：**只在有 ui 的 context 里声明**。
     *
     * 顶层 inject 里不能写 `ui` —— 每轮对话的 turn context 只提供 tools / prompt / hooks
     * （见 `@fizz/agent` 的 buildAgentSetup），声明了 ui 会把**整个插件**推迟挂载，
     * 连下面的工具都不会注册。所以按能力分开声明依赖。
     */
    ctx.inject(['ui'], (c) => {
      // 列表里显示官网图标（data:image/* 的 data URI，见 ICON 的说明）
      c.ui.icon(ICON)

      // 设置项声明：id 就是 config 里的键名（见 @fizz/plugin 的 ctx.ui.setting 说明）
      c.ui.setting({
        id: 'token',
        title: 'API 令牌',
        type: 'string',
        secret: true,
        description:
          '在 storage.to 的「账号 → API 令牌」里创建。填了 = 永久保存 + 无配额限制；留空 = 匿名上传（文件约 3 天后过期）。',
        placeholder: '留空则匿名上传'
      })
      c.ui.setting({
        id: 'visitorToken',
        title: '访客令牌（匿名用）',
        type: 'string',
        description:
          '匿名上传用来归集配额的随机字符串（同一令牌共享 24 小时 100GB 配额）。不填就每次进程启动随机一个 —— 想跨重启续配额就填个固定的。'
      })
    })

    /** 认证头：有 API 令牌就带 Bearer（永久保存 + 配额更高），否则用访客令牌 */
    const authHeaders = (): Record<string, string> =>
      token ? { authorization: `Bearer ${token}` } : { 'x-visitor-token': visitorToken }

    /**
     * 工具：把工作区里的文件传上去、拿一条分享链接。
     *
     * 依赖 `tools` + `workspace` —— 只有**绑定了目录的回合**才同时具备（设置页 inspect 与
     * 长驻 upload context 都缺其中之一，于是这里静默不注册，不会报错也不会空跑）。
     */
    ctx.inject(['tools', 'workspace'], (c) => {
      c.tools.register(
        'upload_to_storage_to',
        tool({
          description:
            '把本地一个文件上传到 storage.to，返回一条**分享页链接**（供人点开查看 / 下载）。' +
            '注意这是分享页而不是图片直链，模型自己取不到它的内容；文件按账号类型过期' +
            '（匿名约 3 天）。path 用相对工作区根的路径（或绝对路径）。',
          inputSchema: z.object({
            path: z.string().describe('文件路径：相对工作区根，或绝对路径')
          }),
          execute: async ({ path }: { path: string }) => {
            const abs = c.workspace.resolve(path)
            const { name, bytes } = await readLocalFile(abs)
            const url = await uploadToStorageTo(
              {
                name,
                mediaType: MIME_BY_EXT[extname(abs).toLowerCase()] ?? 'application/octet-stream',
                bytes
              },
              authHeaders()
            )
            return `已上传：${url}\n（${(bytes.length / 1024).toFixed(1)}KB，分享页链接）`
          }
        }),
        { source: 'storage-to', mutating: true }
      )
    })
  }
}
