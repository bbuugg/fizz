import { useEffect, useRef, useState, type ReactNode } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { Loader2 } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { hydrateConnection } from '@fizz/agent-kit'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { setServerBase } from '@fizz/agent-client/host'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import logoSrc from '@fizz/agent-kit/shared/assets/logo.png'
import { getLocalRuntimeConnection, hasLocalRuntime, nativeRuntime, setLocalRuntimeConnection, type RuntimeStatus } from './bridge'
import { createRuntimeConnection } from './connection'

const INITIAL: RuntimeStatus = { phase: 'starting', progress: 0, logs: [] }

/** 运行时状态来自原生服务；卸载 UI 不停止引擎，打开页面也不重复创建 Node。 */
export function RuntimeGate({ children }: { children: ReactNode }) {
  const t = useT()
  const [status, setStatus] = useState<RuntimeStatus>(INITIAL)
  const [connected, setConnected] = useState(false)
  const accept = useRef<(value: RuntimeStatus) => void>(() => {})

  useEffect(() => {
    if (!hasLocalRuntime) return
    let disposed = false
    const handles: PluginListenerHandle[] = []
    const disconnect = (): void => {
      // 只在已连接时清场一次，避免旧 API / 对话队列继续使用重启前的令牌。
      if (getLocalRuntimeConnection()) useAgentStore.getState().disconnect()
      setLocalRuntimeConnection(null)
      setConnected(false)
    }
    const fail = (error: unknown): void => {
      if (disposed) return
      disconnect()
      setStatus((current) => ({ ...current, phase: 'error', error: error instanceof Error ? error.message : String(error) }))
    }
    const controller = createRuntimeConnection({
      readStatus: () => nativeRuntime.status(),
      onStatus: setStatus,
      onDisconnect: disconnect,
      onError: fail,
      onConnect: (connection) => {
        setLocalRuntimeConnection(connection)
        setServerBase(connection.serverBase ?? null)
        hydrateConnection()
        setConnected(true)
      }
    })
    const { apply } = controller
    accept.current = apply
    const keepHandle = async (promise: Promise<PluginListenerHandle>): Promise<void> => {
      const handle = await promise
      if (disposed) await handle.remove()
      else handles.push(handle)
    }
    void (async () => {
      await keepHandle(nativeRuntime.addListener('status', apply))
      await keepHandle(CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void nativeRuntime.status().then(apply).catch(fail)
      }))
      if (disposed) return
      const current = await nativeRuntime.status()
      apply(current)
      if (current.phase === 'stopped') {
        await nativeRuntime.start()
        if (!disposed) apply(await nativeRuntime.status())
      }
    })().catch(fail)
    return () => {
      disposed = true
      controller.dispose()
      for (const handle of handles) void handle.remove()
    }
  }, [])

  if (!hasLocalRuntime || connected) return children

  const busy = status.phase === 'installing' || status.phase === 'starting' || status.phase === 'stopping' || status.phase === 'running'
  const label = {
    installing: t('正在安装手机本地环境…'),
    starting: t('正在启动本机引擎…'),
    running: t('正在连接本机引擎…'),
    stopping: t('正在停止本机引擎…'),
    stopped: t('本机引擎已停止'),
    error: t('本机引擎启动失败')
  }[status.phase]

  const run = async (action: 'start' | 'stop'): Promise<void> => {
    setStatus((current) => ({ ...current, phase: action === 'start' ? 'starting' : 'stopping', error: undefined }))
    try {
      await nativeRuntime[action]()
      accept.current(await nativeRuntime.status())
    } catch (error) {
      setStatus((current) => ({ ...current, phase: 'error', error: error instanceof Error ? error.message : String(error) }))
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 py-10 text-foreground"
      style={{ paddingTop: 'max(2.5rem, var(--safe-area-inset-top, 0px))', paddingBottom: 'max(2.5rem, var(--safe-area-inset-bottom, 0px))' }}>
      <div className="w-full max-w-sm space-y-6">
        <img src={logoSrc} alt="Fizz" className="mx-auto size-20" />
        <h1 className="text-center text-xl font-semibold">{t('Fizz 在手机上运行')}</h1>
        <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 text-sm">
          {busy && <Loader2 className="size-4 animate-spin" />}
          {label}{status.phase === 'installing' ? ` ${status.progress}%` : ''}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{t('首次打开会解压 APK 内的 Linux 和 Node 环境，无需电脑、服务器或 Termux。模型服务仍需要网络。')}</p>
        {status.error && <p role="alert" className="break-words text-sm text-destructive">{t(status.error)}</p>}
        <Button className="w-full" variant={busy ? 'outline' : 'default'} disabled={status.phase === 'stopping'}
          onClick={() => void run(busy ? 'stop' : 'start')}>
          {busy ? t('停止') : t('启动本机引擎')}
        </Button>
        {status.logs.length > 0 && <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t('运行日志')}</summary>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border p-3 text-xs text-muted-foreground">{status.logs.join('\n')}</pre>
        </details>}
      </div>
    </main>
  )
}
