/**
 * Win32 调用失败。
 *
 * 保留**具体是哪个 API、哪个错误码**：受限令牌 / DACL 这条链上任何一步失败
 * （CreateRestrictedToken、SetEntriesInAclW、CreateProcessAsUserW……）的错误码
 * 都不一样，只报「沙箱创建失败」等于没报。
 */

/** Code of every {@link Win32Error}。 */
export const WIN32_ERROR = 'WIN32_ERROR'

/** Win32 call failure with the exact API name and error code. */
export class Win32Error extends Error {
  /** 稳定的机器可读错误码（上层据它判断是不是「环境不支持」）。 */
  readonly code = WIN32_ERROR
  /** Win32 function whose checked result failed. */
  readonly api: string
  /** Exact GetLastError value or direct Win32 API error code. */
  readonly win32Code: number

  /**
   * @param api - Win32 function whose checked result failed.
   * @param win32Code - exact GetLastError value or direct API error code.
   * @param detail - optional subject, such as the path the call targeted.
   */
  constructor(api: string, win32Code: number, detail?: string) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? '' : `: ${detail}`}`)
    this.name = 'Win32Error'
    this.api = api
    this.win32Code = win32Code
  }
}
