/**
 * HTML 预览的**资源内联**：把 HTML 里写死的相对引用解析成工作区相对路径，
 * 交给 `FileHtmlPreview` 取字节后换成 `data:` URL。
 *
 * ## 为什么非内联不可
 *
 * 预览是 `srcdoc` 沙箱 iframe，它的 base URL **继承宿主页面**：
 * - desktop：`file:///…/app.asar/out/renderer/` —— 相对引用会解析到安装目录，且
 *   Electron 会直接拦掉（`Not allowed to load local resource`）；
 * - web：`http://<host>/` —— 解析到网页根目录，同样 404。
 *
 * 而沙箱 iframe 刻意没有 `allow-same-origin`（见 `FileHtmlPreview` 文件头），
 * 既带不了鉴权头，也用不了父页创建的 `blob:` URL（opaque origin 视作跨域）。
 * `data:` URL 是唯一两端都稳的形态：不依赖鉴权、不依赖 origin。
 *
 * 本文件只放**纯函数**（路径解析 / `url()` / `srcset` 的改写），DOM 操作与取字节
 * 在 `FileHtmlPreview` 里；node 环境下的单测覆盖的就是这几个。
 */

/**
 * 是否是需要内联的「本地相对引用」。
 *
 * 带协议的（`http:` / `data:` / `blob:` / `javascript:` …）、协议相对的（`//cdn…`）、
 * 纯锚点 / 查询串一律不碰 —— 它们要么本来就能用，要么内联了也不对。
 */
export function isLocalAssetRef(ref: string): boolean {
  const v = ref.trim()
  if (!v || v.startsWith('#') || v.startsWith('?')) return false
  if (v.startsWith('//')) return false
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)
}

/** 百分号解码；文件名里带裸 `%` 时解码会抛，原样返回 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 把 HTML / CSS 里的相对引用解析成工作区相对路径。
 *
 * - `baseDir` 是**引用所在文件**的目录（根目录传空串）；
 * - 以 `/` 开头 = 工作区根目录；
 * - `../` 用 URL 规范化处理，无法越过工作区根（URL 本身也越不过 host 根）；
 * - 外部 / data / 锚点返回 `null`（调用方保持原样）。
 */
export function resolveAssetPath(baseDir: string, ref: string): string | null {
  if (!isLocalAssetRef(ref)) return null
  const raw = ref.trim().split('#')[0].split('?')[0]
  if (!raw) return null
  const encodedBase = baseDir
    ? baseDir.split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/'
    : ''
  let pathname: string
  try {
    pathname = new URL(raw, `http://fizz.local/${encodedBase}`).pathname
  } catch {
    return null
  }
  return safeDecode(pathname.replace(/^\/+/, '')) || null
}

/** CSS `url(…)`（引号可选） */
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi
/** `@import "x.css"` / `@import 'x.css'`（url(…) 形态由上面的规则覆盖） */
const CSS_IMPORT_STRING_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi

function cssUrlValue(match: RegExpMatchArray): string {
  return (match[1] ?? match[2] ?? match[3] ?? '').trim()
}

/** 收集一段 CSS 里出现的所有本地引用（去重；已排除外部 / data） */
export function collectCssRefs(css: string): string[] {
  const found = new Set<string>()
  for (const m of css.matchAll(CSS_IMPORT_STRING_RE)) {
    const ref = cssUrlValue(m)
    if (isLocalAssetRef(ref)) found.add(ref)
  }
  for (const m of css.matchAll(CSS_URL_RE)) {
    const ref = cssUrlValue(m)
    if (isLocalAssetRef(ref)) found.add(ref)
  }
  return [...found]
}

/**
 * 按 `map` 改写 CSS 里的引用；`map` 返回 `null` = 保持原样。
 * 改写后的统一写成 `url("…")`（对 data: URL 最稳，不含歧义字符）。
 */
export function mapCssRefs(css: string, map: (ref: string) => string | null): string {
  const withImports = css.replace(CSS_IMPORT_STRING_RE, (whole, double: string, single: string) => {
    const ref = (double ?? single ?? '').trim()
    const next = ref ? map(ref) : null
    return next === null ? whole : `@import url("${next}")`
  })
  return withImports.replace(CSS_URL_RE, (whole, double: string, single: string, bare: string) => {
    const ref = (double ?? single ?? bare ?? '').trim()
    const next = ref ? map(ref) : null
    return next === null ? whole : `url("${next}")`
  })
}

/** 收集 `srcset` 里的本地引用（含 `data:` 的整条跳过：逗号分隔规则会被它打破） */
export function collectSrcsetRefs(srcset: string): string[] {
  if (/data:/i.test(srcset)) return []
  const found = new Set<string>()
  for (const part of srcset.split(',')) {
    const ref = /^\s*(\S+)/.exec(part)?.[1] ?? ''
    if (isLocalAssetRef(ref)) found.add(ref)
  }
  return [...found]
}

/** 按 `map` 改写 `srcset`；`map` 返回 `null` = 保持原样 */
export function mapSrcset(srcset: string, map: (ref: string) => string | null): string {
  if (/data:/i.test(srcset)) return srcset
  return srcset
    .split(',')
    .map((part) => {
      const m = /^(\s*)(\S+)(\s+.*)?$/.exec(part)
      if (!m) return part
      const next = map(m[2])
      return next === null ? part : `${m[1]}${next}${m[3] ?? ''}`
    })
    .join(',')
}
