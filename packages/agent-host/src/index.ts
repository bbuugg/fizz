/**
 * `@fizz/agent-host`：桌面侧 Agent 宿主（Node / Electron，无 React）。
 *
 * 两个宿主共用：
 * - `manager`：把共享的 `@fizz/server` 装进**进程内**（根应用与 apps/desktop 都用它）；
 * - `transport-ipc` / `preload`：`apps/desktop` 渲染端 ↔ 主进程的传输桥
 *   （根应用不用它 —— 根应用的渲染端走自己的 `src/main/ipc/agent.ts` relay）。
 *
 * `./env` 是副作用模块，**必须先于任何 `@fizz/server` 导入求值**，所以单独一个入口
 * （`@fizz/agent-host/env`），由 manager 内部第一时间 import。
 */
export {
  BackendUnavailableError,
  backendManager,
  type BackendStatus
} from './manager'
export { registerAgentTransportIpc } from './transport-ipc'
export { isAllowedExternalUrl, openExternalUrl } from './external-link'
export { createAgentTransportBridge } from './preload'
export { killAllPtySessions } from './pty'
export {
  startRemoteAccess,
  stopRemoteAccess,
  getRemoteAccessInfo,
  type RemoteAccessInfo
} from './remote-access'
export * from './channels'
