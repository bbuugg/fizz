/**
 * Win32 进程 / 标准输入输出 / Job Object 的底层绑定与封装。
 *
 * 只在 Windows 上被真正加载：`koffi` 是懒加载的（见 `./koffi`），
 * 其他平台 import 这个模块不会碰到原生层。
 */

export { ERROR_INSUFFICIENT_BUFFER } from './abi'
export * from './errors'
export {
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodeUint32,
  extendWin32ProcessBindings,
  isNullPtr,
  loadWin32ProcessBindings,
  throwLastError,
  throwWin32,
} from './ffi'
export type { CurrentTokenProcessBindings, NativePtr, Win32ProcessBindings } from './ffi'
export {
  closeHandleChecked,
  drainPipe,
  isJobEmpty,
  pollProcessExit,
  probeCurrentTokenJobSupport,
  spawnCurrentTokenJobProcess,
  spawnInheritedJobProcess,
  spawnPipedProcess,
  terminateJob,
  waitForProcessExit,
} from './process'
export type {
  CurrentTokenProcessSpawnOptions,
  CurrentTokenStdioFileDescriptors,
  SpawnedJobProcess,
  SpawnedPipedProcess,
} from './process'
