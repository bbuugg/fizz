/**
 * Windows 上的「写受限」沙箱后端（受限令牌 + capability SID 白名单）。
 *
 * 移植自 deepseek-harness（MIT）的 `packages/sandbox/sandbox-windows-acl`，
 * 机制同 github.com/huoyaoyuan/windows-acl-restrict-poc @ 10e4dfb：
 *
 * - 令牌是 `WRITE_RESTRICTED` 的，restricting SID 里放**工作区**与**私有临时目录**
 *   各自的写 SID（`workspaceWriteSid` / `tempWriteSid`）；
 * - 这两个 SID 被加进各自目录的 DACL（带 Write ACE），于是写入的二次访问检查只在
 *   「任一 capability 有 Write ACE」的地方通过，其余一律拒；
 * - 令牌同时降到 Low 完整性级别，被授权的目录带 Low no-write-up 标签，外加
 *   `acl` 模块里写明的 ambient-delete deny；
 * - 工作区 SID 由**工作区路径确定性派生**，所以工作区根上的 ACE 每个工作区每台机器
 *   只落一次，之后每次 provisioning 都命中「ACE 已存在」的跳过分支；私有临时目录则
 *   每个会话一个独立 SID，同一工作区下的兄弟会话进不去彼此的临时树。
 *
 * 已知边界（限制性令牌本身的性质，不是移植缺陷）：
 * - 只限写；读、网络、进程可见性**不受限**（WRITE_RESTRICTED 只交集写访问）；
 * - 没有控制台隔离 —— 子进程共享宿主控制台（`CREATE_NO_WINDOW` /
 *   `CREATE_NEW_CONSOLE` 在受限下会 `STATUS_DLL_INIT_FAILED` 直接死）；
 * - 私有临时目录与每个可写目录必须属于调用者（owner 隐含 WRITE_DAC）；
 * - 授权是对真实目录 DACL 的**常驻**修改。工作区授权**故意不回收**（它就是跨会话复用
 *   缓存，回收会让下一次会话重新遍历整棵树）；临时目录授权可回收，`dispose()` 在私有
 *   目录被删掉之前移除它。`manageDacls: false` 表示 DACL 由调用方负责。
 *
 * 每个 API 失败都带 API 名与确切的 Win32 错误码；子进程**绝不**以无限制身份启动。
 */
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Win32Error } from '../win32'

import { grantWrite, revokeWrite } from './acl'
import { allocPtrSlot, decodePtr, isNullPtr, throwLastError, win32 } from './ffi'
import type { NativePtr, Win32Bindings } from './ffi'
import { assertPrivateTempDisjoint } from './path-boundary'
import { drainPipe, spawnSandboxed, spawnSandboxedInherited, waitForExit } from './spawn'
import { createRestrictedToken, findLogonSid, makeWellKnownSid, openCurrentProcessToken, restrictTokenIntegrity, setTokenDefaultDaclGrant } from './token'
import * as abi from './win32-abi'

export { AclWriteGrant } from './grant'
export { assertTempRootOutsideWorkspace, isTempRootInsideWorkspace } from './path-boundary'
export { tempWriteSid, workspaceWriteSid } from './workspace-sid'

/** Construction options: the workspace/temp allowlists and their distinct SID identities. */
export interface AclSandboxOptions {
  /** Directories the confined child may write into (must exist and be caller-owned). */
  writableDirs: readonly string[]
  /**
   * Existing private temp directory to grant. Workspace-write callers must
   * pass it explicitly or pass null to disable temp writes; the ambient temp
   * root is never an implicit grant. Read-only accepts only null/undefined.
   */
  tempDir?: string | null
  /**
   * The write SID forming the workspace-write allowlist: REQUIRED under
   * workspace-write, ignored (and must be absent) under read-only. Callers
   * derive it from the workspace via {@link workspaceWriteSid} — the identity
   * is per workspace, not per sandbox instance, so the workspace-root ACE
   * outlives every instance and later provisions hit the exact-ACE skip.
   */
  writeSid?: string
  /**
   * The private temp directory's write SID. Required whenever
   * workspace-write grants a temp directory, absent otherwise. It must be
   * distinct from {@link writeSid}, so sibling sessions sharing a workspace
   * cannot use the standing workspace capability in one another's temp tree.
   */
  tempWriteSid?: string
  /**
   * The file-effect mode this instance confines under — selects the
   * restricted token's restricting-SID list (I for read-only, J for
   * workspace-write) and MUST match the grant shape: read-only pairs with
   * zero grants. The runner validates the argv-borne mode string at its
   * boundary; this typed seam trusts the union.
   */
  mode: 'read-only' | 'workspace-write'
  /**
   * Whether this instance owns its DACL grants (default true). False means
   * the CALLER has already materialized the ACEs (the sandbox seam's
   * workspace/temp capability lifecycle): init()/dispose() skip grant/revoke entirely —
   * the caller holds the grants for its own lifetime and revokes them.
   */
  manageDacls?: boolean
}

/** Per-spawn options: the program, its argv/cwd, and the stdio shape. */
export interface AclSandboxSpawnOptions {
  /** Program to run (resolved via PATH search when unqualified, like CreateProcess). */
  command: string
  /** Arguments, quoted per CommandLineToArgvW rules. */
  args?: readonly string[]
  /** Working directory; defaults to the caller's cwd. */
  cwd?: string
  /**
   * 'pipe' (default): capture stdout/stderr via anonymous pipes.
   * 'inherit': the child inherits the caller's stdio directly (runner usage —
   * bytes flow straight through), always wrapped in a kill-on-close job so the
   * child dies with the caller; stdout/stderr in the result are empty.
   */
  stdio?: 'pipe' | 'inherit'
  /** Control pipe forwarded to the same payload descriptor in inherited-stdio mode. */
  controlFileDescriptor?: 7
}

/** A settled confined child: captured stdio and the exit code. */
export interface AclSandboxChildResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

/** A running confined child: its pid and a settlement promise. */
export interface AclSandboxChild {
  /** Child process id. */
  pid: number
  /** Resolve stdout/stderr and the exit code once the child exits. */
  wait(): Promise<AclSandboxChildResult>
}

/** Free one optional SID while retaining a failure for best-effort sibling cleanup. */
function freeSidBestEffort(
  api: Win32Bindings,
  sidPtr: NativePtr | undefined,
  label: string,
  failures: unknown[],
): void {
  if (sidPtr === undefined) return
  try {
    const freed = api.localFree(sidPtr)
    if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', label)
  } catch (error) {
    failures.push(error)
  }
}

/**
 * One write-restricted sandbox instance: token + write-SID grants + spawn.
 * `init()` is fail-closed — any Win32 failure revokes the revocable (temp)
 * grants and throws; `dispose()` revokes the temp grants, leaves the
 * standing workspace ACEs in place (the cross-instance reuse cache), frees
 * every allocation, and reports every cleanup failure. With
 * `manageDacls: false` the caller owns the grants (the sandbox seam's grant
 * reuse): init() applies none and dispose() revokes none.
 */
export class AclSandbox {
  /** Absolute writable directories (constructor-validated). */
  readonly writableDirs: string[]
  /** The workspace SID string whose ACEs form the workspace allowlist. */
  readonly writeSid: string | undefined
  /** The private temp directory's write SID (workspace-write with temp only). */
  readonly tempWriteSid: string | undefined
  /** The file-effect mode — the restricted token's restricting-SID list selection. */
  readonly mode: 'read-only' | 'workspace-write'
  private readonly tempDirOption: string | null | undefined
  private readonly manageDacls: boolean
  private tempDirResolved: string | null | undefined
  private api: Win32Bindings | undefined
  private token: NativePtr | undefined
  private writeSidPtr: NativePtr | undefined
  private tempWriteSidPtr: NativePtr | undefined
  /** The well-known/logon SID allocations init() makes; freed by dispose() alongside the write SIDs. */
  private sidAllocations: NativePtr[] = []
  private grantedPaths: Array<{ path: string; sidPtr: NativePtr }> = []

  constructor(options: AclSandboxOptions) {
    this.mode = options.mode
    this.manageDacls = options.manageDacls ?? true
    this.writableDirs = options.writableDirs.map((directory) => {
      const absolute = resolve(directory)
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        throw new Error(`AclSandbox writable dir does not exist or is not a directory: ${absolute}`)
      }
      return absolute
    })
    this.tempDirOption = options.tempDir
    this.writeSid = options.writeSid
    this.tempWriteSid = options.tempWriteSid
    if (this.mode === 'workspace-write' && this.writeSid === undefined) {
      throw new Error('AclSandbox workspace-write requires a write SID — derive it from the workspace via workspaceWriteSid()')
    }
    if (this.mode === 'workspace-write' && this.tempDirOption === undefined) {
      throw new Error('AclSandbox workspace-write requires an explicit private temp directory or null')
    }
    if (this.mode === 'read-only' && this.tempDirOption !== undefined && this.tempDirOption !== null) {
      throw new Error('AclSandbox read-only does not accept a temp directory')
    }
    if (this.mode === 'read-only' && (this.writeSid !== undefined || this.tempWriteSid !== undefined)) {
      throw new Error('AclSandbox read-only does not accept write SIDs')
    }
    if (this.mode === 'workspace-write' && this.tempDirOption !== null && this.tempWriteSid === undefined) {
      throw new Error('AclSandbox workspace-write with temp requires a temp write SID — derive it via tempWriteSid()')
    }
    if (this.tempDirOption === null && this.tempWriteSid !== undefined) {
      throw new Error('AclSandbox temp write SID requires a temp directory')
    }
    if (this.writeSid !== undefined && this.tempWriteSid === this.writeSid) {
      throw new Error('AclSandbox workspace and temp write SIDs must be distinct')
    }
  }

  /** Resolved temp directory (available after init; null when temp grants are disabled). */
  get tempDir(): string | null | undefined {
    return this.tempDirResolved
  }

  /** Create the restricted token and apply the capability-SID grants. Idempotent-unsafe: once per instance. */
  async init(): Promise<void> {
    if (this.api !== undefined) throw new Error('AclSandbox is already initialized')
    const api = await win32()
    const currentToken = openCurrentProcessToken(api)
    let currentTokenOpen = true
    let restrictedToken: NativePtr | undefined
    try {
      const parseSid = (sid: string): NativePtr => {
        const sidSlot = allocPtrSlot()
        if (api.convertStringSidToSidW(sid, sidSlot) === 0) {
          throwLastError(api, 'ConvertStringSidToSidW', sid)
        }
        const parsedSid = decodePtr(sidSlot)
        if (parsedSid === null) throw new Win32Error('ConvertStringSidToSidW', api.getLastError(), sid)
        return parsedSid
      }
      this.writeSidPtr = this.writeSid === undefined ? undefined : parseSid(this.writeSid)
      this.tempWriteSidPtr = this.tempWriteSid === undefined ? undefined : parseSid(this.tempWriteSid)

      const tempDir = this.mode === 'read-only' || this.tempDirOption === null ? null : this.tempDirOption
      /* v8 ignore next -- constructor validation requires workspace-write to supply
         an explicit temp directory or null; the other branches normalize to null. */
      if (tempDir === undefined) throw new Error('AclSandbox workspace-write temp directory was not resolved')
      if (tempDir !== null) {
        if (!existsSync(tempDir) || !statSync(tempDir).isDirectory()) {
          throw new Error(`AclSandbox temp dir does not exist or is not a directory: ${tempDir}`)
        }
        assertPrivateTempDisjoint(this.writableDirs, tempDir)
      }
      this.tempDirResolved = tempDir

      // manageDacls: false — the caller (the sandbox seam's grant) already
      // materialized the ACEs; this instance must neither add nor remove any.
      // When this instance owns the DACLs, writableDir ACEs are STANDING (the
      // per-workspace reuse cache — dispose() never revokes them, or the next
      // provision would re-propagate the whole tree) and the temp ACE is
      // REVOCABLE (dispose() removes it before the private directory is
      // deleted; the ambient temp root is never granted).
      // The Low label SID and the world SID the grants deny and label with.
      const lowLabelSid = makeWellKnownSid(api, abi.WinLowLabelSid)
      const worldSid = makeWellKnownSid(api, abi.WinWorldSid)
      this.sidAllocations.push(lowLabelSid, worldSid)

      if (this.manageDacls) {
        if (this.writeSidPtr !== undefined) {
          for (const path of this.writableDirs) {
            grantWrite(api, path, this.writeSidPtr, lowLabelSid, worldSid)
          }
          if (tempDir !== null && this.tempWriteSidPtr !== undefined) {
            // Record BEFORE granting: grantWrite can throw after a successful
            // apply (a LocalFree failure), and the fail-closed catch must still
            // revoke that path (revoking an ungranted path is a no-op merge).
            this.grantedPaths.push({ path: tempDir, sidPtr: this.tempWriteSidPtr })
            grantWrite(api, tempDir, this.tempWriteSidPtr, lowLabelSid, worldSid)
          }
        }
      }
      const logonSid = findLogonSid(api, currentToken)
      this.sidAllocations.push(logonSid)
      const writeSids = [this.writeSidPtr, this.tempWriteSidPtr].filter((sid): sid is NativePtr => sid !== undefined)
      restrictedToken = createRestrictedToken(
        api, currentToken, logonSid, writeSids,
        { world: worldSid },
        this.mode,
      )
      restrictTokenIntegrity(api, restrictedToken, lowLabelSid)
      this.token = restrictedToken
      // The restricted token's default DACL still names only the user's
      // ambient SIDs — none of the restricting SIDs. Every NEW object the
      // confined process creates (anonymous stdio pipes, sync objects) takes
      // its DACL from that default, so the write pass-2 check would deny
      // pipe creation (ERROR_ACCESS_DENIED; Node EPERM) and break every
      // piped-stdio grandchild spawn. Merge a full-access ACE for a
      // restricting SID (the PRIVATE temp SID when present, otherwise the
      // workspace SID, or Everyone under read-only): new-object creation
      // stays gated by the parent object's DACL, while the new object's own
      // DACL passes pass-2. Choosing the temp SID prevents default-DACL
      // objects in one session's temp tree from acquiring the shared
      // workspace capability.
      setTokenDefaultDaclGrant(api, restrictedToken, this.tempWriteSidPtr ?? this.writeSidPtr ?? worldSid)
      if (api.closeHandle(currentToken) === 0) throwLastError(api, 'CloseHandle', 'current process token')
      currentTokenOpen = false
      this.api = api
    } catch (error) {
      // Fail-closed cleanup: never leave a revocable (temp) grant or SID
      // allocation behind a failed init. Standing workspace ACEs are NOT
      // revoked — they are the intended end state (the reuse cache), not an
      // error artifact.
      const cleanupFailures: unknown[] = []
      if (currentTokenOpen && api.closeHandle(currentToken) === 0) {
        cleanupFailures.push(new Win32Error('CloseHandle', api.getLastError(), 'current process token after init failure'))
      }
      if (restrictedToken !== undefined && api.closeHandle(restrictedToken) === 0) {
        cleanupFailures.push(new Win32Error('CloseHandle', api.getLastError(), 'restricted token after init failure'))
      }
      for (const grant of this.grantedPaths) {
        try {
          revokeWrite(api, grant.path, grant.sidPtr)
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError)
        }
      }
      for (const [label, sidPtr] of [['workspace write SID', this.writeSidPtr], ['temp write SID', this.tempWriteSidPtr]] as const) {
        freeSidBestEffort(api, sidPtr, label, cleanupFailures)
      }
      for (const sidPtr of this.sidAllocations.splice(0)) {
        freeSidBestEffort(api, sidPtr, 'init SID allocation', cleanupFailures)
      }
      this.token = undefined
      this.writeSidPtr = undefined
      this.tempWriteSidPtr = undefined
      this.tempDirResolved = undefined
      this.grantedPaths = []
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `AclSandbox init failed and ${cleanupFailures.length} cleanup operation(s) also failed`,
        )
      }
      throw error
    }
  }

  /**
   * Spawn a process under the restricted token. Fails closed: throws on every
   * Win32 failure; the child is never created unrestricted. With
   * `stdio: 'inherit'` the child shares the caller's stdio directly and is
   * placed in a kill-on-close job (dies with the caller). Call dispose() only
   * after all children have exited — revoking grants under a live child
   * removes its remaining write allowance.
   * @param options - the program, argv/cwd, and stdio shape.
   * @returns the running child.
   */
  spawn(options: AclSandboxSpawnOptions): AclSandboxChild {
    const api = this.api
    const token = this.token
    if (api === undefined || token === undefined) throw new Error('AclSandbox is not initialized: call init() first')
    if (options.controlFileDescriptor !== undefined && options.stdio !== 'inherit') {
      throw new Error('control pipe requires inherited stdio')
    }
    const args = options.args ?? []
    const cwd = options.cwd ?? process.cwd()

    if (options.stdio === 'inherit') {
      const native = spawnSandboxedInherited(api, token, {
        command: options.command, args, cwd,
        ...options.controlFileDescriptor === undefined ? {} : { controlFileDescriptor: options.controlFileDescriptor },
      })
      let exitCodePromise: Promise<number> | undefined
      return {
        pid: native.pid,
        wait: async () => {
          exitCodePromise ??= Promise.resolve(waitForExit(api, native.process))
          const exitCode = await exitCodePromise
          if (api.closeHandle(native.job) === 0) throwLastError(api, 'CloseHandle', 'kill-on-close job')
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode }
        },
      }
    }

    const native = spawnSandboxed(api, token, { command: options.command, args, cwd })
    const stdout = drainPipe(api, native.stdoutRead)
    const stderr = drainPipe(api, native.stderrRead)
    // waitForExit is deliberately NOT started here: WaitForSingleObject blocks
    // the thread and would starve the drains while the child is still running
    // (pipe-buffer deadlock). The drains resolve only after the child closed
    // its pipe ends — by then the wait returns immediately.
    let exitCodePromise: Promise<number> | undefined
    return {
      pid: native.pid,
      wait: async () => {
        const stdoutBuffer = await stdout
        const stderrBuffer = await stderr
        exitCodePromise ??= Promise.resolve(waitForExit(api, native.process))
        return { stdout: stdoutBuffer, stderr: stderrBuffer, exitCode: await exitCodePromise }
      },
    }
  }

  /**
   * Revoke the revocable (temp) grants, free the SID, close the token; the
   * standing workspace ACEs stay (the reuse cache). Reports every cleanup
   * failure.
   */
  dispose(): void {
    const api = this.api
    if (api === undefined) return
    const failures: unknown[] = []
    if (this.manageDacls) {
      for (const grant of this.grantedPaths) {
        try {
          revokeWrite(api, grant.path, grant.sidPtr)
        } catch (error) {
          failures.push(error)
        }
      }
    }
    for (const [label, sidPtr] of [['workspace write SID', this.writeSidPtr], ['temp write SID', this.tempWriteSidPtr]] as const) {
      freeSidBestEffort(api, sidPtr, label, failures)
    }
    const token = this.token
    /* v8 ignore next -- init assigns this.api only after this.token, so an initialized instance always
       has its token; the guard mirrors the write-SID guard. */
    if (token !== undefined) {
      try {
        if (api.closeHandle(token) === 0) throwLastError(api, 'CloseHandle', 'restricted token')
      } catch (error) {
        failures.push(error)
      }
    }
    for (const sidPtr of this.sidAllocations.splice(0)) {
      freeSidBestEffort(api, sidPtr, 'init SID allocation', failures)
    }
    this.api = undefined
    this.token = undefined
    this.writeSidPtr = undefined
    this.tempWriteSidPtr = undefined
    this.grantedPaths = []
    if (failures.length > 0) {
      throw new AggregateError(failures, `AclSandbox dispose completed with ${failures.length} cleanup failure(s)`)
    }
  }
}
