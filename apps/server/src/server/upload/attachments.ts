/**
 * 附件投递策略：给模型的到底是**可取的 URL**，还是**请求体里的字节**（base64）。
 *
 * ## 为什么需要这一层
 *
 * 附件一直是「URL 直传」：`model-messages` 把 `/api/uploads/<uuid>.png` 拼成绝对地址，
 * 由 provider 自己去取。拼的基址是 `FIZZ_PUBLIC_BASE_URL ?? 请求 origin`（见 `local.ts`），
 * 于是**桌面端 / 局域网 / 没配公网地址的部署**拼出来就是 `http://127.0.0.1:7801/...` ——
 * 云端 provider 回连不到用户的机器，图片要么报错要么静默丢失。
 *
 * 内联（把文件读回、以 `image` part 的字节形态发出去）绕开了「谁能访问谁」这个问题：
 * provider 不再发起任何请求。代价是请求体 ×4/3，而且**每轮都要重发整段历史里的图**——
 * 所以真正需要管的是体积，不是 token（图片 token 由像素决定，传 URL 与传字节完全相同，
 * 见 `MAX_INLINE_TOTAL_BYTES`）。
 *
 * ## 判据
 *
 * `FIZZ_ATTACHMENT_DELIVERY`：
 * - `auto`（缺省）：基址（`FIZZ_PUBLIC_BASE_URL`，没配就看请求 origin）**公网可拉**时才用
 *   URL，否则读回字节内联。这是唯一能同时照顾「本地跑」与「有反代 / 隧道」的判据 ——
 *   只看「是不是内置存储」会在配了 Caddy / Cloudflare Tunnel 时白传一遍 base64。
 * - `inline` / `url`：强制某一种（排查用；也可以给「我不想让图片 URL 公开可访问」的人）。
 *
 * 插件上传源（`adapterFor` 不认的那些）一律原样返回：它们交回来的本来就是公网地址，
 * 服务端不下载、不转存。
 */
import type { ResolvedAttachment } from '@fizz/agent'
import type { UploadFileRef } from '@fizz/contracts/types'
import { adapterFor } from './adapters'

/**
 * 单文件内联上限：对齐 Anthropic 的单图 5MB（超了它连图片都传不进去）。
 * 先看大小再读盘，避免为一个注定发不出去的 100MB 文件把内存撑爆。
 */
const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024

type Delivery = 'auto' | 'inline' | 'url'

function deliveryMode(): Delivery {
  const raw = process.env.FIZZ_ATTACHMENT_DELIVERY?.trim().toLowerCase()
  if (raw === 'inline' || raw === 'url') return raw
  return 'auto'
}

/**
 * 这个基址公网能不能拉到：`false` = 只能内联。
 *
 * 保守判定（拿不准就当私网）：回环 / 私网 IPv4 / IPv6 ULA 与链路本地 / `.local` /
 * `.internal` 这类内网后缀一律不可拉；域名带点就认为可拉（`xxx.trycloudflare.com`
 * 这种隧道地址没有别的特征可认）。
 */
export function isPubliclyFetchable(base: string): boolean {
  const trimmed = base.trim()
  if (!trimmed) return false
  let host: string
  try {
    host = new URL(trimmed).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return false
  if (host === '0.0.0.0' || host === 'host.docker.internal') return false
  // IPv6 字面量：URL.hostname 带方括号
  if (host.startsWith('[')) {
    const inner = host.slice(1, -1)
    if (inner === '::1' || inner === '::') return false
    if (/^f[cd]/.test(inner)) return false // fc00::/7 唯一本地地址
    if (/^fe[89ab]/.test(inner)) return false // fe80::/10 链路本地
    if (/^::ffff:/.test(inner)) return false // IPv4 映射，一律当私网
    return true
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 169 && b === 254) return false
    return true
  }
  return host.includes('.')
}

/**
 * 一轮的附件解析器（`runAgent` 的 `resolveAttachment`）。
 *
 * 每次起跑建一个：判据在创建时算好，一轮之内不变。
 *
 * @param origin 本次请求的 origin（`FIZZ_PUBLIC_BASE_URL` 未配时的兜底基址）
 */
export function createAttachmentResolver(
  origin: string
): (file: UploadFileRef) => Promise<ResolvedAttachment | undefined> {
  const mode = deliveryMode()
  const publicBase = (process.env.FIZZ_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '')
  /**
   * 配了公网基址看它，没配看 origin（反代没设 `FIZZ_PUBLIC_BASE_URL` 但 Host 头是公网域名
   * 时，拼出来的地址其实也是可取的）。
   */
  const fetchable = isPubliclyFetchable(publicBase || origin)

  return async (file) => {
    const adapter = adapterFor(file.url)
    // 插件上传源 / 第三方地址：不吃这一层的判据，交给 resolveFileUrl 原样返回
    if (!adapter) return undefined
    const absolute = adapter.resolveModelUrl(file.url, origin)
    if (mode === 'url') return { kind: 'url', url: absolute }
    if (mode === 'auto' && fetchable) return { kind: 'url', url: absolute }
    if (!adapter.get) return { kind: 'url', url: absolute }
    const got = await adapter.get(file.url)
    if (!got) return { kind: 'omit', note: `（附件「${file.name}」读取失败，未随本轮发送）` }
    if (got.bytes.byteLength > MAX_INLINE_FILE_BYTES) {
      return {
        kind: 'omit',
        note: `（附件「${file.name}」超过 ${MAX_INLINE_FILE_BYTES / (1024 * 1024)}MB，未随本轮发送）`
      }
    }
    return { kind: 'inline', bytes: got.bytes }
  }
}
