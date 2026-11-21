/**
 * 服务端媒体地址的「可显示化」。
 *
 * web：相对 url 同源直用（/api/uploads 与 /api/screenshots 都在公开白名单里，
 * `<img>` 带不了鉴权头也不是问题）。desktop：渲染进程没有 HTTP 端口，`<img src>`
 * 够不着进程内服务端 —— 走 IPC 桥 fetch 成 blob 再造 objectURL（`fetchWorkspaceMedia`
 * 同款先例）。跨源宿主把服务端媒体路径接到配置的地址；外链和自带协议的 URL 原样返回。
 */
import { getAgentHostOrNull, getServerBaseOverride } from '@fizz/agent-client/host'
import { hostFetch, resolveServerUrl } from '@fizz/agent-client/api'

const objectUrlCache = new Map<string, string>()

// Match the server screenshot route exactly; never route absolute/external URLs through desktop IPC.
const SCREENSHOT_URL_RE = /^\/api\/screenshots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$/

export function isServerScreenshotUrl(url: string): boolean {
  return SCREENSHOT_URL_RE.test(url)
}

export function resolveServerMediaUrl(url: string): string {
  return /^\/?api\/(?:uploads|screenshots)\//.test(url)
    ? resolveServerUrl(getServerBaseOverride() ?? undefined, url)
    : url
}

/** The caller owns the returned Blob and any object URL it creates; no screenshot cache is retained here. */
export async function fetchServerScreenshot(url: string): Promise<Blob> {
  if (!isServerScreenshotUrl(url)) throw new Error('Invalid screenshot URL')
  const res = await hostFetch(url)
  if (!res.ok) throw new Error(`Screenshot load failed (HTTP ${res.status})`)
  const blob = await res.blob()
  const ext = url.slice(url.lastIndexOf('.') + 1)
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
  return blob.type === mime ? blob : new Blob([blob], { type: mime })
}

/** 把服务端相对地址解析成当前宿主下 `<img>` 可直接用的 src */
export async function loadMediaObjectUrl(url: string): Promise<string> {
  if (!url) return url
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return url
  const host = getAgentHostOrNull()
  if (!host?.capabilities.localMediaFetch) return resolveServerMediaUrl(url)
  const cached = objectUrlCache.get(url)
  if (cached) return cached
  const res = await hostFetch(url)
  if (!res.ok) throw new Error(`媒体加载失败（HTTP ${res.status}）`)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  objectUrlCache.set(url, objectUrl)
  return objectUrl
}
