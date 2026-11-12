/**
 * 上传能力的门面：**内置适配器**（`adapters.ts`）+ **插件上传源**（`registry.ts`）
 * 在这里汇合成两条对外接口 —— 「这条附件引用合法吗」（`validateUploadFiles`）与
 * 「交给模型的地址是什么」（`resolveUploadModelUrl`）。
 *
 * 插件那一条线的说明见 `registry.ts`（长驻 context、按项目、fail-closed）。
 */
import { isUploadAllowedMime } from '@fizz/contracts/agent-api'
import type { UploadFileRef } from '@fizz/contracts/types'
import { adapterFor } from './adapters'
import { pluginModelUrlResolver } from './registry'
import { issuedUploadRef } from './trust'

export type { UploadAdapter } from './types'
export { adapterFor, resolveUploadAdapter } from './adapters'
/** 附件「URL 直传 还是 内联字节」的判据（见 `attachments.ts` 文件头） */
export { createAttachmentResolver, isPubliclyFetchable } from './attachments'
export {
  BUILTIN_UPLOAD_PROVIDER_ID,
  getUploadProviders,
  putWithProvider,
  type UploadProviderView
} from './registry'
export { initUploadTrust, recordIssuedUpload } from './trust'

/**
 * 交给模型的绝对地址（`chat-turn` 的 `resolveFileUrl` 用它）。
 *
 * 三条路，按顺序问：
 * 1. 内置适配器认领 → 由它拼（相对路径 + `FIZZ_PUBLIC_BASE_URL ?? origin`）；
 * 2. 插件上传源认领 → 由插件的 `resolveModelUrl` 决定；
 * 3. 都不认 → 原样返回。**这是插件上传源的缺省情形**：它们交回来的一般就是公网 https
 *    绝对地址，直接给模型即可（服务端不下载、不转存，见 model-messages.ts 的说明）。
 */
export function resolveUploadModelUrl(url: string, origin: string): string {
  return (
    adapterFor(url)?.resolveModelUrl(url, origin) ??
    pluginModelUrlResolver(url, origin) ??
    url
  )
}

/**
 * 客户端递上来的附件引用（`ChatRequest.files` / `SteerInput.files`）的**唯一**校验入口。
 *
 * 返回 null = 全部合法；否则返回可直接回 400 的原因（带文件名，给用户看）。
 *
 * 判据（缺一不可）：
 * - 形状：`name` 是非空字符串；
 * - **归属**：要么 `adapterFor(url)` 认得这个 url（内置存储，走它自己的形状正则），
 *   要么这张 url 在**已签发记录**里（`trust.ts`：插件上传源交回来的第三方地址，
 *   比如 `https://storage.to/xxxx`）—— 只做形状校验的话，用户可以把任意外部 URL
 *   注进历史（附件是 URL 直传，服务端从不下载校验）；
 * - 类型：走签发记录的按**签发时记下的 mediaType** 比对（插件上传源可以放宽白名单，
 *   所以不能一律套契约白名单）；走内置适配器的仍按契约白名单判（老数据兼容）。
 *
 * 抽成共用是因为它现在有两个调用方（跑一轮 `startTurn`、插话 steer 路由）：两处各写
 * 一遍必然漂，而这是**安全边界**（放行一条外部 URL 就等于让模型去取任意地址）。
 */
export function validateUploadFiles(files: UploadFileRef[]): string | null {
  for (const f of files) {
    const name = typeof f?.name === 'string' ? f.name : ''
    if (!name) return `附件不合法：缺失文件名（仅支持已上传的图片 / PDF）`
    const issued = issuedUploadRef(f.url ?? '')
    if (issued) {
      // 签发过：类型在签发时已按该上传源的 accept 挡过一遍，这里只防「类型被改过」
      if (issued.mediaType && f.mediaType !== issued.mediaType) {
        return `附件不合法：${name}（类型与上传时不一致）`
      }
      continue
    }
    if (adapterFor(f.url ?? '') && isUploadAllowedMime(f.mediaType)) continue
    return `附件不合法：${name}（仅支持已上传的图片 / PDF）`
  }
  return null
}
