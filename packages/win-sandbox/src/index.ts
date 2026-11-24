/**
 * Windows 写受限沙箱后端。
 *
 * 移植自 deepseek-harness（MIT License, Copyright (c) 2026 DeepSeek）的
 * `packages/sandbox/sandbox-windows-acl` 与 `packages/subprocess/win32-process`，
 * 去掉了上游的插件外壳（cordis）与内部工具包依赖，算法与 Win32 调用序列保持不变。
 *
 * 只有 `./runner` 需要在独立进程里跑；其余导出都可在主进程内直接用（koffi 懒加载）。
 */

export { AclSandbox } from './acl/index'
export type {
  AclSandboxChild,
  AclSandboxChildResult,
  AclSandboxOptions,
  AclSandboxSpawnOptions
} from './acl/index'
export { AclWriteGrant } from './acl/grant'
export { assertTempRootOutsideWorkspace, isTempRootInsideWorkspace } from './acl/path-boundary'
export { tempWriteSid, workspaceWriteSid } from './acl/workspace-sid'
export { WIN32_ERROR, Win32Error } from './win32/errors'
