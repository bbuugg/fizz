import { readFileSync } from 'node:fs'
import { setServers } from 'node:dns'

/** c-ares 和 glibc 使用同一份由 Android 原生层写入的 DNS 配置。 */
export function startRuntimeDnsSync() {
  let applied = ''
  let lastError = ''
  const refresh = () => {
    try {
      const config = readFileSync('/etc/resolv.conf', 'utf8')
      if (config === applied) return
      const servers = [...config.matchAll(/^nameserver\s+(\S+)/gm)].map((match) => match[1])
      if (!servers.length) return // 离线也允许启动；联网回调写入后再更新。
      setServers(servers)
      applied = config // 查询进行中可能拒绝 setServers，成功后才记住配置。
      lastError = ''
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastError) console.warn(`[local-runtime] 更新 DNS 失败，将重试：${message}`)
      lastError = message
    }
  }
  refresh()
  const timer = setInterval(refresh, 5000)
  timer.unref()
  return () => clearInterval(timer)
}
