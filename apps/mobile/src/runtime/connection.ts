import type { Connection } from '@fizz/agent-client/api'
import type { RuntimeStatus } from './bridge'

interface RuntimeConnectionOptions {
  readStatus: () => Promise<RuntimeStatus>
  onStatus: (status: RuntimeStatus) => void
  onConnect: (connection: Connection) => void
  onDisconnect: () => void
  onError: (error: unknown) => void
}

/** 原生状态与一次性凭据读取的接线；独立于 React，便于验证重启和卸载竞态。 */
export function createRuntimeConnection(options: RuntimeConnectionOptions) {
  let disposed = false
  let authenticated = false
  let pending: number | null = null
  let phase: RuntimeStatus['phase'] = 'starting'
  let generation = 0

  const apply = (next: RuntimeStatus): void => {
    if (disposed) return
    phase = next.phase
    options.onStatus(next)
    if (next.phase !== 'running') {
      generation++
      authenticated = false
      pending = null
      options.onDisconnect()
      return
    }
    if (authenticated || pending === generation) return
    const current = generation
    pending = current
    void options.readStatus().then((ready) => {
      if (disposed || phase !== 'running' || current !== generation) return
      if (ready.phase !== 'running') {
        apply(ready)
        return
      }
      if (!ready.connection) throw new Error('本机引擎未提供连接凭据')
      options.onConnect(ready.connection)
      authenticated = true
    }).catch((error: unknown) => {
      if (!disposed && current === generation) options.onError(error)
    }).finally(() => {
      if (pending === current) pending = null
    })
  }

  return { apply, dispose: () => { disposed = true } }
}
