/**
 * HTML 文件预览：**沙箱 iframe + `srcdoc`**，两端行为一致。
 *
 * 为什么是这个形态（而不是把源码注进父页面 DOM / 走自定义协议）：
 * - **注入 DOM 等于 XSS**：HTML 里可以带 `<script>`，直接 render 到宿主页面上它能碰
 *   localStorage、cookie、token，甚至改 UI;
 * - **自定义协议**（`fizz-ws://` 那套）能解析相对资源，但要在 desktop 里重建
 *   `registerSchemesAsPrivileged` + `protocol.handle` + Range/206 一整条链，web 端还用不上
 *   （跨域）；而且 desktop 的 `<webview>` 安全边界只放行 http(s)（见主进程 `secureWebviews`），
 *   不能为了预览本机 HTML 把 file:// 放进白名单。
 *
 * `sandbox` **刻意不给 `allow-same-origin`**：脚本照样能跑（`allow-scripts`），但 iframe 落在
 * opaque origin 上，摸不到父页的存储与 DOM，也发不了同源请求。`allow-popups` /
 * `allow-forms` 让「点链接开新窗 / 提交表单」这类正常交互不被沙箱拦死。
 *
 * ## 相对资源：先取字节、再换成 data: URL
 *
 * `srcdoc` 文档的 base URL **继承宿主页面**：desktop 是
 * `file:///…/app.asar/out/renderer/`（Electron 还会直接拦掉本机文件请求，报
 * `Not allowed to load local resource`），web 是网页根目录。所以 `./vendor/three.min.js`
 * 这类引用在两端都拿不到工作区里的真文件。
 *
 * 于是预览前先做一轮**资源内联**（`source.mediaUrl` 带鉴权取字节 → `data:` URL）：
 * 沙箱没有 `allow-same-origin`，拿不到鉴权头、也用不了父页创建的 `blob:` URL
 * （opaque origin 视作跨域），`data:` 是唯一两端都稳的形态。
 *
 * 覆盖范围：HTML 里**静态写死**的 `script[src]` / `link[href]`（样式 / 图标 / manifest /
 * preload）/ `img[src|srcset]` / `source[src|srcset]` / `video[src|poster]` / `audio[src]` /
 * `track[src]`，以及 `<style>`、`style=""`、外部 CSS 里的 `url()` 与 `@import`（递归）。
 *
 * **不覆盖**：运行时自己拼出来的地址（`new FileLoader().load('tex.png')`、`fetch('./data.json')`）、
 * 模块脚本里的相对 `import`（它们相对的是 data: / blob:，没有目录概念）、嵌套 iframe /
 * `object`。这些仍然会 404 —— 这是预览，不是本地服务器。
 *
 * 另外：沙箱 iframe 的主题**不跟随**宿主（它是一份独立文档，`class="dark"` 到不了里面），
 * 所以底色固定给白 —— 网页里的 `<body>` 大多也没写背景色。
 *
 * ## 滚动条：把宿主那套「美化条」注入进去
 *
 * iframe 是**独立文档**，宿主 `styles.css` 里的 `::-webkit-scrollbar` 到不了里面（也没有
 * `allow-same-origin`，父页读 `contentDocument` 会被拦）。不注入的话预览里就是一条原生
 * 系统滚动条 —— 白底配一条宽灰轨，跟面板其余部分不像同一套界面。
 *
 * 所以把同一套规则以 `<style>` 拼进 `srcdoc`（见 `PREVIEW_SCROLLBAR_CSS`）。两个与宿主的差异：
 * - **判据只用 `pointer`，不用宽度**：iframe 的视口 = 侧栏宽度（300~600px），照搬宿主的
 *   `(min-width: 768px)` 会让桌面端永远命中不到、等于没生效；
 * - **颜色不能用 `--muted-foreground`**：预览文档里没有我们的令牌，改用系统色 `CanvasText`
 *   混一点透明（页面写了 `color-scheme: dark` 时它自己会变白）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import {
  collectCssRefs,
  collectSrcsetRefs,
  isLocalAssetRef,
  mapCssRefs,
  mapSrcset,
  resolveAssetPath
} from '@fizz/agent-kit/features/files/html-preview-assets'

/**
 * 注入预览文档的滚动条样式：数值 / 观感与 `styles.css` 的全局那一套对齐
 * （10px 轨道、4px 视觉粗细、圆角、透明轨道）。
 *
 * ⚠️ **不要给同一个元素同时写标准属性与 `::-webkit-scrollbar`**：Chromium 121+ 看到
 * `scrollbar-width` / `scrollbar-color` 就完全不画伪元素那套（圆角、hover 全失效）。
 * 标准属性只给不认伪元素的引擎（Firefox），用 `@supports` 隔开。
 */
const PREVIEW_SCROLLBAR_CSS = `
@media (pointer: fine) {
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background-color: rgb(120 120 120 / 0.45);
    background-color: color-mix(in oklab, CanvasText 28%, transparent);
    border-radius: 9999px;
    border: 3px solid transparent;
    background-clip: content-box;
  }
  ::-webkit-scrollbar-thumb:hover {
    background-color: rgb(120 120 120 / 0.7);
    background-color: color-mix(in oklab, CanvasText 45%, transparent);
  }
  ::-webkit-scrollbar-corner { background: transparent; }
}
/* 触摸设备：占位式滚动条会永久吃掉 10px，藏掉（与宿主一致，滚动本身不受影响） */
@media (pointer: coarse) {
  ::-webkit-scrollbar { display: none; }
}
@supports not selector(::-webkit-scrollbar) {
  html { scrollbar-width: thin; scrollbar-color: rgb(120 120 120 / 0.45) transparent; }
}
`

/**
 * 把样式塞进预览文档。
 *
 * 优先插在 `</head>` 前（排在页面自己的样式之后，同特异性下压得住它）；没有 `head` 时跟在
 * doctype 后面。**绝不能把 `<style>` 放到 `<!DOCTYPE>` 之前** —— 那会把文档打成 quirks 模式，
 * 预览里的排版跟真实浏览器打开的不一样。
 */
function withScrollbarStyles(html: string): string {
  const style = `<style data-fizz-preview-scrollbar>${PREVIEW_SCROLLBAR_CSS}</style>`
  const headClose = /<\/head\s*>/i
  if (headClose.test(html)) return html.replace(headClose, (match) => `${style}${match}`)
  const doctype = /<!doctype[^>]*>/i
  if (doctype.test(html)) return html.replace(doctype, (match) => `${match}${style}`)
  return `${style}${html}`
}

/** 预览需要的取字节能力；`FilesSource` 结构上直接满足（只要 `mediaUrl`） */
export interface HtmlPreviewSource {
  /** 同 `FilesSource.mediaUrl`：带鉴权拿到文件字节的可用 URL（desktop / web 通常都是 blob:） */
  mediaUrl(path: string): Promise<string>
}

/** 单个资源内联上限：再大就该直接下载 / 用本机应用打开，塞进 srcdoc 只会拖垮面板 */
const INLINE_MAX_BYTES = 16 * 1024 * 1024
/** CSS `@import` / `url()` 的递归上限（同时兜住循环引用） */
const MAX_CSS_DEPTH = 8

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function isCssPath(path: string): boolean {
  return /\.css$/i.test(path)
}

/**
 * 补充 MIME：服务端的 media 路由只认图片 / 音视频，`.js` / `.wasm` / 字体一律回
 * `application/octet-stream`。经典脚本不挑 MIME 也能跑，但**模块脚本必须**是 JS 类型。
 */
const MIME_BY_EXT: Record<string, string> = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  wasm: 'application/wasm',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject'
}

function mimeOf(path: string, blobType: string): string {
  if (blobType && blobType !== 'application/octet-stream') return blobType
  const name = path.slice(path.lastIndexOf('/') + 1)
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return MIME_BY_EXT[ext] ?? blobType ?? 'application/octet-stream'
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(out)
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`
}

function textToDataUrl(text: string, mime: string): string {
  return toDataUrl(new TextEncoder().encode(text), mime)
}

/** 是否该内联这个 `<link>`（只处理会实际加载资源的 rel，别把 canonical 之类改成 data:） */
function linkNeedsInlining(el: Element): { yes: boolean; css: boolean } {
  const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const yes = rel.some((r) => r === 'stylesheet' || r === 'icon' || r === 'manifest' || r === 'preload')
  const css = rel.includes('stylesheet') || (rel.includes('preload') && el.getAttribute('as') === 'style')
  return { yes, css }
}

/**
 * 原地把 HTML 里的相对资源换成 `data:` URL，返回可塞进 `srcdoc` 的新 HTML。
 *
 * 每一项失败都**只跳过它自己**（原引用留着）：一个坏掉的贴图不该让整页预览变白屏。
 */
export async function inlineHtmlResources(
  html: string,
  source: HtmlPreviewSource,
  htmlPath: string
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  /**
   * 解析基准目录。页面自己写了 `<base href>` 时要认它：
   * - 相对的 base：并入解析目录后**删掉**元素（留着会让 iframe 继续按宿主 base 走）；
   * - 绝对的 http(s) base：子资源本来就该走网络，直接原样返回，不做任何内联。
   */
  let baseDir = dirOf(htmlPath)
  const baseEl = doc.querySelector('base[href]')
  const baseHref = (baseEl?.getAttribute('href') ?? '').trim()
  if (baseHref) {
    if (!isLocalAssetRef(baseHref)) return html
    // 与浏览器一致：结尾是 `/` 就把它当目录，否则当文件、取其所在目录
    const resolved = resolveAssetPath(baseDir, baseHref)
    if (resolved !== null) baseDir = baseHref.endsWith('/') ? resolved : dirOf(resolved)
    baseEl?.remove()
  }

  /** 已取过的资源（按路径 + 是否 CSS 区分）；`null` = 取过但失败，别反复重试 */
  const cache = new Map<string, string | null>()

  async function loadAsset(
    assetPath: string,
    cssHint: boolean,
    depth: number,
    chain: Set<string>
  ): Promise<string | null> {
    if (depth > MAX_CSS_DEPTH || chain.has(assetPath)) return null
    const asCss = cssHint || isCssPath(assetPath)
    const key = `${asCss ? 'css' : 'bin'}:${assetPath}`
    if (cache.has(key)) return cache.get(key) ?? null

    let result: string | null = null
    let objectUrl = ''
    try {
      objectUrl = await source.mediaUrl(assetPath)
      const res = await fetch(objectUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      if (blob.size > INLINE_MAX_BYTES) {
        console.warn(`[html-preview] 资源过大，不内联：${assetPath}`)
      } else if (asCss) {
        const nextChain = new Set(chain)
        nextChain.add(assetPath)
        result = textToDataUrl(await rewriteCss(await blob.text(), dirOf(assetPath), depth + 1, nextChain), 'text/css')
      } else {
        result = toDataUrl(new Uint8Array(await blob.arrayBuffer()), mimeOf(assetPath, blob.type))
      }
    } catch (err) {
      console.warn(`[html-preview] 读取资源失败：${assetPath}`, err)
    } finally {
      // mediaUrl 每次都造一个新 blob:，取完就还（不还每预览一次漏一份内存）
      if (objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl)
    }
    cache.set(key, result)
    return result
  }

  /** 改写一段 CSS；`dir` 是这段 CSS 所在目录，嵌套引用相对它解析 */
  async function rewriteCss(
    css: string,
    dir: string,
    depth: number,
    chain: Set<string>
  ): Promise<string> {
    const refs = collectCssRefs(css)
    const mapped = new Map<string, string>()
    await Promise.all(
      refs.map(async (ref) => {
        const assetPath = resolveAssetPath(dir, ref)
        if (!assetPath) return
        const url = await loadAsset(assetPath, isCssPath(assetPath), depth, chain)
        if (url) mapped.set(ref, url)
      })
    )
    return mapCssRefs(css, (ref) => mapped.get(ref) ?? null)
  }

  async function rewriteSrcset(value: string): Promise<string> {
    const refs = collectSrcsetRefs(value)
    if (!refs.length) return value
    const mapped = new Map<string, string>()
    await Promise.all(
      refs.map(async (ref) => {
        const assetPath = resolveAssetPath(baseDir, ref)
        if (!assetPath) return
        const url = await loadAsset(assetPath, false, 0, new Set())
        if (url) mapped.set(ref, url)
      })
    )
    return mapSrcset(value, (ref) => mapped.get(ref) ?? null)
  }

  const jobs: Promise<void>[] = []

  // 单个地址属性：脚本 / 图 / 来源 / 视频封面…
  const singleAttrs: Array<[selector: string, attr: string]> = [
    ['script[src]', 'src'],
    ['img[src]', 'src'],
    ['source[src]', 'src'],
    ['video[src]', 'src'],
    ['video[poster]', 'poster'],
    ['audio[src]', 'src'],
    ['track[src]', 'src'],
    ['input[type="image"][src]', 'src']
  ]
  for (const [selector, attr] of singleAttrs) {
    for (const el of doc.querySelectorAll(selector)) {
      const value = el.getAttribute(attr) ?? ''
      const assetPath = resolveAssetPath(baseDir, value)
      if (!assetPath) continue
      jobs.push(
        loadAsset(assetPath, false, 0, new Set()).then((url) => {
          if (url) el.setAttribute(attr, url)
        })
      )
    }
  }

  // <link>：只认会加载资源的 rel
  for (const el of doc.querySelectorAll('link[href]')) {
    const { yes, css } = linkNeedsInlining(el)
    if (!yes) continue
    const href = el.getAttribute('href') ?? ''
    const assetPath = resolveAssetPath(baseDir, href)
    if (!assetPath) continue
    jobs.push(
      loadAsset(assetPath, css, 0, new Set()).then((url) => {
        if (url) el.setAttribute('href', url)
      })
    )
  }

  // 响应式图片
  for (const el of doc.querySelectorAll('img[srcset], source[srcset]')) {
    const value = el.getAttribute('srcset') ?? ''
    jobs.push(
      rewriteSrcset(value).then((next) => {
        if (next !== value) el.setAttribute('srcset', next)
      })
    )
  }

  // 内联样式表
  for (const el of doc.querySelectorAll('style')) {
    const css = el.textContent ?? ''
    jobs.push(
      rewriteCss(css, baseDir, 0, new Set()).then((next) => {
        if (next !== css) el.textContent = next
      })
    )
  }

  // style=""（按 HTML 所在目录解析）
  for (const el of doc.querySelectorAll('[style]')) {
    const css = el.getAttribute('style') ?? ''
    jobs.push(
      rewriteCss(css, baseDir, 0, new Set()).then((next) => {
        if (next !== css) el.setAttribute('style', next)
      })
    )
  }

  await Promise.all(jobs)

  const doctype = /<!doctype[^>]*>/i.test(html) ? '<!DOCTYPE html>' : ''
  return `${doctype}${doc.documentElement?.outerHTML ?? html}`
}

export function FileHtmlPreview({
  html,
  source,
  path,
  className
}: {
  html: string
  /** 给了它（且给了 `path`）才会内联资源；不给 = 原样 srcdoc（相对引用会 404） */
  source?: HtmlPreviewSource
  /** HTML 在工作区里的相对路径 —— 相对引用按它的目录解析 */
  path?: string
  className?: string
}) {
  /** `null` + preparing = 正在取资源；拿到结果后是改写过的 HTML */
  const [prepared, setPrepared] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)

  useEffect(() => {
    if (!source || path === undefined) {
      setPrepared(null)
      setPreparing(false)
      return
    }
    let cancelled = false
    setPrepared(null)
    setPreparing(true)
    void inlineHtmlResources(html, source, path)
      .then((out) => {
        if (!cancelled) setPrepared(out)
      })
      .catch((err: unknown) => {
        // 内联整体失败（极少见）就退回原始 HTML：至少还能看到页面骨架 / 报错
        console.warn('[html-preview] 资源内联失败，退回原始 HTML', err)
        if (!cancelled) setPrepared(html)
      })
      .finally(() => {
        if (!cancelled) setPreparing(false)
      })
    return () => {
      cancelled = true
    }
  }, [html, path, source])

  const srcDoc = useMemo(() => withScrollbarStyles(prepared ?? html), [prepared, html])

  if (preparing) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center bg-background', className)}>
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <iframe
      title="HTML 预览"
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-popups allow-forms"
      className={cn('h-full w-full border-0 bg-background', className)}
    />
  )
}
