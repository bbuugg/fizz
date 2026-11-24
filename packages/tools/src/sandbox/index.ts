/**
 * 进程沙箱 seam：把一条即将 spawn 的 argv 包成受文件效果策略约束的 argv。
 *
 * 语义照 DeepSeek Harness 的 `ctx.sandbox`（`sandbox-conclusion.md` 是它的结论摘要），
 * 但**不引入 cordis**：我们只需要「选后端 → 包 argv → 给判定事实」这三件事。
 *
 * 三条规矩，改这里之前先看一眼：
 *
 * 1. **fail closed**：受限模式拿不到可用后端就抛 {@link SandboxUnavailableError}，
 *    绝不静默裸跑 —— 「以为隔离了其实没有」比直接报错危险得多；
 * 2. **传 argv 数组，不传 shell 字符串**：包装层不做任何拼接 / 转义；
 * 3. **判定事实跟着这一次包装走**（`denialSignatures` 是方言，不是并集），
 *    并发调用可能落在不同后端上。
 *
 * 平台支持：Linux 用 bwrap（Landlock 需要原生 launcher，暂未接）；macOS 用
 * `sandbox-exec`；Windows 用随包分发的 windows-acl runner（受限令牌 + capability
 * SID 写入白名单）。三种后端都要探针跑通才算可用 —— 一律如实报不可用，不给假承诺。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandSandboxMode } from '@fizz/contracts/types'
import type { ConfinedSandboxMode, SandboxMode, SandboxPolicy, WorkspaceBackend } from '@fizz/contracts/workspace'
import { bwrapProfileArgs, seatbeltProfileArgs } from './profiles'
import {
  WINDOWS_ACL_DENIAL_SIGNATURES,
  WINDOWS_ACL_RUNNER_FAILURE_RULES,
  windowsAclArgv,
  windowsAclProbeArgv
} from './windows'
import type { ConfinedArgv, RunnerFailureRule } from './types'

export * from './profiles'
export * from './classify'
export * from './escalation'
export * from './windows'
export type { ConfinedArgv, RunnerFailureRule } from './types'

/**
 * 把一个具体的沙箱档翻译成一次命令的策略（`danger-full-access` = 不隔离）。
 * 提权之后要走的就是它：调用方已经知道**确切**的档位，不需要再过一遍开关。
 *
 * 远端工作区同样返回策略 —— 包装由远端后端在**远端主机**上做（bwrap），
 * 这里只负责把模式与写边界（远端 POSIX 根）描述清楚。
 */
export function sandboxPolicyForMode(mode: SandboxMode, workspaceRoot: string): SandboxPolicy | undefined {
  if (mode === 'danger-full-access') return undefined
  return { mode, workspaceRoot }
}

/**
 * 把「设置里的开关」翻译成一次命令的策略。
 *
 * - 开关是 `off` → 不传策略（完全不进沙箱路径）；
 * - 其余 → `workspace-write`，写边界就是工作区根（本地路径或远端 POSIX 路径）。
 */
export function resolveCommandSandbox(
  setting: CommandSandboxMode | undefined,
  backend: Pick<WorkspaceBackend, 'root'>
): SandboxPolicy | undefined {
  if (setting !== 'workspace-write') return undefined
  return sandboxPolicyForMode('workspace-write', backend.root)
}


/** 与 harness 同一个错误码，方便上层区分「沙箱不可用」和「命令失败」 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/**
 * bwrap 的方言：本地 backend 与远端（SSH）backend 共用同一份。
 * 两处各写一份的话，远端改了签名、本地没改，归因就会一边对一边错。
 */
export const BWRAP_DENIAL_SIGNATURES: readonly string[] = ['read-only file system']
export const BWRAP_RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = [
  { fatalSignatures: ['bwrap: '] }
]

/** 受限模式没有可用后端时抛出（命令**没有**执行） */
export class SandboxUnavailableError extends Error {
  readonly code = SANDBOX_UNAVAILABLE

  constructor(
    readonly mode: ConfinedSandboxMode,
    detail?: string
  ) {
    super(
      `沙箱模式 "${mode}" 在当前系统上没有可用的后端，命令没有执行。` +
        'Linux 需要安装 bubblewrap（bwrap）；macOS 需要 sandbox-exec；' +
        'Windows 需要随包分发的 windows-acl runner 能正常启动。' +
        '也可以在「设置 → AI → 偏好」里把「命令沙箱」切到关闭再试。' +
        (detail === undefined ? '' : `（${detail}）`)
    )
    this.name = 'SandboxUnavailableError'
  }
}

/** 本机实际选中的 runner（也是各自的拒绝方言来源） */
export type SandboxRunner = 'bwrap' | 'seatbelt' | 'windows-acl'

export type SandboxAvailability =
  | { available: true; runner: SandboxRunner }
  | { available: false; reason: string }

export interface SandboxOptions {
  /** 测试注入：替换 `process.platform`，用于在任意机器上跑三平台分支 */
  platform?: NodeJS.Platform
  /** 功能探针的超时（毫秒）。必须是正数 —— Node 把 `0` 当成「不设超时」 */
  probeTimeoutMs?: number
  /**
   * 测试注入：替换真实的 `spawnSync` 探针。
   *
   * 真实探针返回 {@link ProbeOutcome}（失败要带 runner 的原话，否则界面只剩一句
   * 猜测性的原因）；测试只关心通过与否，返回 `boolean` 即可。
   */
  probe?: SandboxProbe
  /** 测试注入：替换 `os.tmpdir()`（Seatbelt 的写口之一 / Windows 的临时根） */
  tempRoot?: string
  /**
   * Windows：ACL runner 的启动前缀（`[node, runner.js]` 或原生 exe）。
   *
   * 不传 = 自动解析随包分发的 `win-sandbox/runner.mjs`（见 {@link resolveWindowsRunner}）；
   * 只有测试 / 特殊分发才需要显式给。
   */
  windowsLauncher?: readonly string[]
  /** 与 `windowsLauncher` 配套的环境变量（如 Electron 的 `ELECTRON_RUN_AS_NODE`） */
  windowsLauncherEnv?: Record<string, string>
}

export interface Sandbox {
  /** 包装 argv；不可用时 reject `SandboxUnavailableError`（绝不返回裸 argv） */
  confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    opts?: { signal?: AbortSignal }
  ): Promise<ConfinedArgv>
  /** 后端是否可用；首次调用才探针，结果在进程生命周期内缓存 */
  availability(): Promise<SandboxAvailability>
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000
/** 失败原因里保留的原话长度上限（够看清一行报错，又不会把整段栈灌进错误卡片） */
const PROBE_DETAIL_MAX = 300

/** 探针结果：失败时尽量带上被探对象自己说的话 */
export interface ProbeOutcome {
  ok: boolean
  detail?: string
}

export type SandboxProbe = (
  argv: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>
) => boolean | ProbeOutcome | Promise<boolean | ProbeOutcome>

/** 探针 stderr 只留尾巴：够看清最后一行，又不至于把整段日志抱在内存里 */
const PROBE_STDERR_MAX = 8_000

/**
 * 真实探针：跑一次最简单的受限命令，退出 0 才算这个 runner 真能用。
 *
 * ⚠️ **必须异步 spawn**：探针跑在服务端进程里，`spawnSync` 会把整个事件循环按住
 * （SSE 心跳、其它会话的请求、PTY 转发全停），而探针超时默认就有 5 秒。
 *
 * 失败时**必须**把 stderr 的最后一句话带出来：runner 起不来有很多种原因
 * （依赖没打进包里、受限令牌创建被拒、koffi 原生模块加载失败……），
 * 界面只显示「探针失败」时，排查只能靠手动重跑一遍探针。
 */
function runProbe(
  argv: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>
): Promise<ProbeOutcome> {
  const [program, ...args] = argv
  if (program === undefined) return Promise.resolve({ ok: false, detail: '探针 argv 为空' })
  return new Promise((resolve) => {
    let settled = false
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    const settle = (outcome: ProbeOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(outcome)
    }
    const child = spawn(program, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {})
    })
    timer = setTimeout(() => {
      settle({ ok: false, detail: `探针超时（${timeoutMs}ms）` })
      try {
        child.kill()
      } catch {
        // 已退出
      }
    }, timeoutMs)
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + String(d)).slice(-PROBE_STDERR_MAX)
    })
    child.on('error', (err) => {
      settle({ ok: false, detail: err.message.slice(0, PROBE_DETAIL_MAX) })
    })
    child.on('close', (code) => {
      if (code === 0) return settle({ ok: true })
      const lastLine = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .pop()
      const exit = code === null ? '被信号终止' : `退出码 ${code}`
      settle({
        ok: false,
        detail: (lastLine === undefined ? exit : `${exit}：${lastLine}`).slice(0, PROBE_DETAIL_MAX)
      })
    })
  })
}

/** 探针失败原因 = 归因 + 对方原话（有就带上） */
function probeReason(reason: string, outcome: ProbeOutcome): string {
  return outcome.detail === undefined || outcome.detail === ''
    ? reason
    : `${reason}：${outcome.detail}`
}

function bwrapProbeArgv(): string[] {
  return ['bwrap', ...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true']
}

function seatbeltProbeArgv(tempRoot?: string): string[] {
  return [
    'sandbox-exec',
    ...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }, tempRoot),
    '--',
    'true'
  ]
}

/** Windows runner 的启动方式（命令前缀 + 需要注入的环境变量） */
export interface WindowsRunner {
  command: string[]
  env?: Record<string, string>
}

/** 显式指定 runner 产物的环境变量（自定义部署 / 排障用） */
const RUNNER_ENV = 'FIZZ_WIN_SANDBOX_RUNNER'

/**
 * runner 产物相对**当前 bundle** 的候选位置。
 *
 * - server：`apps/server/dist/index.js` → 同目录下的 `win-sandbox/`；
 * - desktop：`apps/desktop/out/main/index.js` → 上一层的 `win-sandbox/`；
 * - vitest：源码 `packages/tools/src/sandbox/index.ts` → 再上一层。
 *
 * 构建脚本（`packages/win-sandbox/build.mjs`）负责把产物放到这些位置。
 */
const RUNNER_CANDIDATES = [
  './win-sandbox/runner.mjs',
  '../win-sandbox/runner.mjs',
  '../../win-sandbox/runner.mjs'
] as const

/**
 * 解析随包分发的 windows-acl runner。
 *
 * - 普通 node / 服务端：`[process.execPath, <产物>/win-sandbox/runner.mjs]`；
 * - Electron 打包态：`process.execPath` 是 Electron 本体，必须带
 *   `ELECTRON_RUN_AS_NODE=1` 才会当 node 跑；子进程也读不到 asar，所以路径要换成
 *   `app.asar.unpacked` 镜像（打包配置已把 runner 与 koffi 解包出来）。
 *
 * 解析失败（没构建 / 被裁剪）返回 undefined —— 上层按「后端不可用」fail closed。
 */
export function resolveWindowsRunner(): WindowsRunner | undefined {
  const entry = resolveRunnerEntry()
  if (entry === undefined) return undefined
  return {
    command: [process.execPath, entry],
    ...(process.versions.electron !== undefined ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {})
  }
}

/** 先试显式环境变量，再试相对当前 bundle 的固定位置；asar 内的路径换成解包镜像 */
function resolveRunnerEntry(): string | undefined {
  const explicit = process.env[RUNNER_ENV]
  const explicitHit = explicit === undefined || explicit === '' ? undefined : existingFile(explicit)
  if (explicitHit !== undefined) return explicitHit
  for (const relative of RUNNER_CANDIDATES) {
    let path: string
    try {
      path = fileURLToPath(new URL(relative, import.meta.url))
    } catch {
      continue
    }
    const hit = existingFile(path)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * 文件存在就返回它；在 asar 里则返 `app.asar.unpacked` 里的同位置镜像。
 *
 * ⚠️ **解包镜像优先**：Electron 的 fs 补丁让 asar 内的路径 `existsSync` 也为真，
 * 但 runner 是 `ELECTRON_RUN_AS_NODE` 起的**纯 node** 子进程，它不认 asar 虚拟路径 ——
 * 拿到 asar 内的路径就会 ENOENT。
 */
function existingFile(path: string): string | undefined {
  const marker = `${sep}app.asar${sep}`
  if (path.includes(marker)) {
    const unpacked = path.replace(marker, `${sep}app.asar.unpacked${sep}`)
    if (existsSync(unpacked)) return unpacked
  }
  return existsSync(path) ? path : undefined
}

/**
 * 建一个沙箱实例。不传 `options` 就是生产形态；测试用 `probe` / `platform` 注入，
 * 不要为了测分支真的去起 bwrap。
 */
export function createSandbox(options: SandboxOptions = {}): Sandbox {
  const platform = options.platform ?? process.platform
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const probe = options.probe ?? runProbe
  const tempRoot = options.tempRoot
  let resolvedRunner: WindowsRunner | undefined
  let runnerResolved = false
  let cached: SandboxAvailability | undefined

  /** 显式注入优先（空数组 = 明确「没有 runner」）；否则第一次需要时解析随包分发的 */
  function windowsRunner(): WindowsRunner | undefined {
    if (options.windowsLauncher !== undefined) {
      if (options.windowsLauncher.length === 0) return undefined
      return {
        command: [...options.windowsLauncher],
        ...(options.windowsLauncherEnv ? { env: options.windowsLauncherEnv } : {})
      }
    }
    if (!runnerResolved) {
      runnerResolved = true
      resolvedRunner = resolveWindowsRunner()
    }
    return resolvedRunner
  }

  /** 跑探针并把「测试注入的 boolean」与「真实探针的结构化结果」归一化 */
  async function runProbeFor(
    argv: readonly string[],
    env?: Record<string, string>
  ): Promise<ProbeOutcome> {
    const result = await probe(argv, probeTimeoutMs, env)
    return typeof result === 'boolean' ? { ok: result } : result
  }

  /**
   * 选后端：按平台选，Linux 只认 bwrap。
   *
   * 探针只跑一次并缓存 —— 每条命令都探一次等于每条命令多起一个进程，
   * 而「bwrap 能不能用」在一次运行里不会变。并发调用共享同一个 pending promise：
   * 探针是异步的，两条命令同时进来时不能各起一个。
   */
  let pending: Promise<SandboxAvailability> | undefined
  async function select(): Promise<SandboxAvailability> {
    if (cached !== undefined) return cached
    if (pending !== undefined) return pending
    pending = probeAvailability()
    try {
      cached = await pending
      return cached
    } finally {
      pending = undefined
    }
  }

  async function probeAvailability(): Promise<SandboxAvailability> {
    if (platform === 'linux') {
      const outcome = await runProbeFor(bwrapProbeArgv())
      cached = outcome.ok
        ? { available: true, runner: 'bwrap' }
        : {
            available: false,
            reason: probeReason('bwrap 探针失败（未安装，或容器里缺 user namespace 权限）', outcome)
          }
    } else if (platform === 'darwin') {
      const outcome = await runProbeFor(seatbeltProbeArgv(tempRoot))
      cached = outcome.ok
        ? { available: true, runner: 'seatbelt' }
        : {
            available: false,
            reason: probeReason('sandbox-exec 探针失败（系统不提供或被限制）', outcome)
          }
    } else if (platform === 'win32') {
      // 没构建 / 被裁剪就不用探针了：探一个不存在的路径只会得到一句没用的 ENOENT。
      const runner = windowsRunner()
      if (runner === undefined) {
        cached = {
          available: false,
          reason: '未找到 windows-acl runner（随包的 win-sandbox/runner.mjs 缺失，见 packages/win-sandbox/build.mjs）'
        }
      } else {
        const outcome = await runProbeFor(
          windowsAclProbeArgv(runner.command, tempRoot ?? tmpdir()),
          runner.env
        )
        cached = outcome.ok
          ? { available: true, runner: 'windows-acl' }
          : {
              available: false,
              reason: probeReason('windows-acl runner 探针失败（受限令牌或进程创建被拒绝）', outcome)
            }
      }
    } else {
      cached = {
        available: false,
        reason: `当前平台（${platform}）没有已接入的沙箱后端`
      }
    }
    return cached
  }

  return {
    availability: select,

    async confine(argv, policy, opts = {}) {
      const selected = await select()
      if (!selected.available) throw new SandboxUnavailableError(policy.mode, selected.reason)
      // 探针是异步的，取消只能在包装前检查一次；spawn 之后由调用方的 abortSignal 负责
      opts.signal?.throwIfAborted()

      if (selected.runner === 'bwrap') {
        return {
          argv: ['bwrap', ...bwrapProfileArgs(policy), '--', ...argv],
          enforcement: 'full',
          denialSignatures: BWRAP_DENIAL_SIGNATURES,
          runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES
        }
      }

      if (selected.runner === 'seatbelt') {
        return {
          argv: ['sandbox-exec', ...seatbeltProfileArgs(policy, tempRoot), '--', ...argv],
          enforcement: 'full',
          // Seatbelt 拒绝写入是 EPERM
          denialSignatures: ['operation not permitted'],
          runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }]
        }
      }

      // windows-acl：runner 自己管 DACL（不传 SID），只能报 partial ——
      // NTFS 硬链接、读取不受限、AppContainer ACL 边界都不在它管得住的范围内。
      const runner = windowsRunner()
      if (runner === undefined) {
        throw new SandboxUnavailableError(policy.mode, 'windows-acl runner 未安装')
      }
      return {
        argv: windowsAclArgv(runner.command, policy, tempRoot ?? tmpdir(), argv),
        enforcement: 'partial',
        denialSignatures: WINDOWS_ACL_DENIAL_SIGNATURES,
        runnerFailureRules: WINDOWS_ACL_RUNNER_FAILURE_RULES,
        ...(runner.env ? { env: runner.env } : {})
      }
    }
  }
}

/** 生产单例：首次 `confine` 才探针，import 本身不起进程 */
export const sandbox: Sandbox = createSandbox()
