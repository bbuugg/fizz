/** APK 的本机引擎桥；hosted /m 与浏览器扩展没有该能力，继续使用原有连接流程。 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { Connection } from '@fizz/agent-client/api'

export type RuntimePhase = 'stopped' | 'installing' | 'starting' | 'running' | 'stopping' | 'error'
export interface RuntimeStatus {
  phase: RuntimePhase
  progress: number
  logs: string[]
  error?: string
  connection?: Connection
}

interface RuntimePlugin {
  status(): Promise<RuntimeStatus>
  start(): Promise<RuntimeStatus>
  /** 等到 Node / PRoot 完成退出与清理才返回。 */
  stop(): Promise<RuntimeStatus>
  addListener(event: 'status', callback: (status: RuntimeStatus) => void): Promise<PluginListenerHandle>
}

// 原生 APK 必须有本机引擎；插件注册异常时显示启动错误，不能悄悄退回远程登录。
export const hasLocalRuntime = Capacitor.isNativePlatform()
export const nativeRuntime = registerPlugin<RuntimePlugin>('FizzRuntime')

// 本机 JWT 只保存在内存；旧版 APK 的远程连接记录独立保留，不覆盖、不拿来连接本机。
let connection: Connection | null = null
export function getLocalRuntimeConnection(): Connection | null { return connection }
export function setLocalRuntimeConnection(value: Connection | null): void { connection = value }
