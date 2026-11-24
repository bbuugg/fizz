/**
 * 远端主机上的 bwrap 可用性：**每台主机只探一次**，失败短 TTL 后重探。
 *
 * 为什么不在每条命令前探：探针是一次完整的 SSH 往返 + 一次 bwrap 启动，按命令付这个
 * 成本不可接受；为什么失败要过期：用户很可能是在会话中途去远端 `apt install bubblewrap`
 * 的，缓存死失败会让「装好了还得重启服务端」。
 *
 * 成功也缓存：bwrap 不会在运行中消失，而它是最常见的稳态。
 */
import { remoteExecService } from './exec'
import { buildSandboxProbeScript } from './remote-command'

export type RemoteSandboxAvailability = { available: true } | { available: false; reason: string }

/** 探针超时：一次 userns 初始化 + true，10 秒足够；卡住按不可用处理 */
const PROBE_TIMEOUT_MS = 10_000

/** 失败结果的缓存时长（成功永久缓存到主机被删 / 进程结束） */
const FAILURE_TTL_MS = 30_000

interface CacheEntry {
  value: RemoteSandboxAvailability
  at: number
  /** 失败条目会过期，成功条目不会 */
  expires: boolean
}

const cache = new Map<string, CacheEntry>()

/**
 * 问远端「bwrap 能用吗」。
 *
 * 探针只读：`bwrap --ro-bind / / … -- true`，不绑定工作区、不写任何文件。
 * 失败原因优先取 stderr 最后一行（通常是 `bwrap: setting up uid map: Permission denied`
 * 这类可读的一句话），拿不到再退回退出码。
 */
export async function remoteSandboxAvailability(hostId: string): Promise<RemoteSandboxAvailability> {
  const hit = cache.get(hostId)
  if (hit && (!hit.expires || Date.now() - hit.at < FAILURE_TTL_MS)) return hit.value

  let value: RemoteSandboxAvailability
  try {
    const result = await remoteExecService.exec(hostId, buildSandboxProbeScript(), {
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if (result.reason === 'error') {
      value = { available: false, reason: result.error ?? '无法连接远端主机' }
    } else if (result.reason === 'timeout') {
      value = { available: false, reason: `探针超时（${PROBE_TIMEOUT_MS}ms）` }
    } else if (result.exitCode === 0) {
      value = { available: true }
    } else {
      const lastLine = result.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop()
      value = { available: false, reason: lastLine ?? `探针退出码 ${String(result.exitCode)}` }
    }
  } catch (err) {
    value = { available: false, reason: err instanceof Error ? err.message : String(err) }
  }
  cache.set(hostId, { value, at: Date.now(), expires: !value.available })
  return value
}

/** 删除主机 / 连接彻底重连时清掉（下次重新探） */
export function forgetRemoteSandbox(hostId: string): void {
  cache.delete(hostId)
}

/** 测试用：清空整个缓存 */
export function clearRemoteSandboxCache(): void {
  cache.clear()
}
