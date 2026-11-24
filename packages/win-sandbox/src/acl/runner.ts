/**
 * 受限执行的 runner：沙箱层把它当作「命令前缀」spawn，由它去建受限令牌、
 * 在令牌下起真正的命令（**继承**调用方的 stdio，字节直通）、镜像子进程退出码，
 * 退出时收回临时目录那份授权（工作区授权作为复用缓存保留）。
 *
 * argv 契约（tools 侧拼装，**不要改**，改了表现是「所有命令都起不来」）：
 *   [node, runner.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write>,
 *    ['--write-sid', <S-1-4-…>, '--temp-write-sid', <S-1-4-…>], '--', <argv...>]
 *
 * 两种模式：
 *  - workspace-write：工作区与临时目录各带一个 capability SID 的 Write 授权；
 *    其余可寻址的写入一律被拒（Everyone 与硬链接这两条已知边界见 README）；
 *  - read-only：不发任何 capability 授权，restricting 列表里也没有 capability SID，
 *    所以早前 workspace-write 期留下的常驻 ACE 保持惰性。两种模式都去掉
 *    Authenticated Users / INTERACTIVE / LOCAL（理由见上游 README），只共用
 *    保活的 logon SID 与 Everyone。
 *
 * `--write-sid` + `--temp-write-sid`：由调用方管 DACL 的形态 —— 工作区与私有临时
 * 目录的 ACE 已经由调用方落好、也由它负责回收，runner 既不授权也不回收
 * （`manageDacls: false`）。两个值都会与各自路径对账。不传这一对时（独立运行），
 * workspace-write 把 `--temp` 当**根**，在其下建随机私有子目录、自派生临时 SID，
 * 子进程退出后删掉该目录。两种流程都在 spawn 前把 runner **自己环境**里的
 * TMP/TEMP 改到私有目录，子进程继承这个块（`lpEnvironment` 传 NULL；通过 koffi 显式
 * 构造环境块会让 CreateProcessAsUserW 返回 ERROR_INVALID_PARAMETER，实测如此）。
 * read-only 不动环境里的临时目录（写本来就被拒）。
 *
 * 失败契约：runner 侧的任何失败（参数错、目录不存在、令牌/授权/spawn 失败）都向 stderr
 * 打印 `windows-acl-run: <detail>` 并退出 127 —— tools 侧的 RUNNER_FAILURE_RULES 认这个
 * 签名。子进程**绝不**以无限制身份启动。
 *
 * ⚠️ 这是**独立进程入口**：顶层直接执行 `main()`，不要 import 它。
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { win32 } from './ffi'
import { AclSandbox, assertTempRootOutsideWorkspace } from './index'
import { tempWriteSid, workspaceWriteSid } from './workspace-sid'

const RUNNER_SIGNATURE = 'windows-acl-run'
const RUNNER_FAILURE_EXIT = 127

class RunnerFailure extends Error {}

/** Print the runner-failure signature line and unwind. */
function fail(detail: string): never {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`)
  throw new RunnerFailure(detail)
}

interface ParsedArgs {
  workspace: string
  temp: string
  mode: 'read-only' | 'workspace-write'
  writeSid: string | undefined
  tempWriteSid: string | undefined
  command: string
  args: string[]
}

function parseArgs(raw: string[]): ParsedArgs {
  let workspace: string | undefined
  let temp: string | undefined
  let mode: string | undefined
  let writeSid: string | undefined
  let parsedTempWriteSid: string | undefined
  let index = 0
  for (; index < raw.length; index++) {
    const token = raw[index]
    if (token === '--') {
      index++
      break
    }
    index++
    const value = raw[index]
    if (value === undefined) fail(`missing value after ${token}`)
    switch (token) {
      case '--workspace': workspace = value; break
      case '--temp': temp = value; break
      case '--mode': mode = value; break
      case '--write-sid': writeSid = value; break
      case '--temp-write-sid': parsedTempWriteSid = value; break
      default: fail(`unknown argument: ${token}`)
    }
  }
  if (workspace === undefined) fail('missing --workspace')
  if (temp === undefined) fail('missing --temp')
  if (mode !== 'read-only' && mode !== 'workspace-write') fail(`unknown mode: ${String(mode)}`)
  const argv = raw.slice(index)
  const command = argv[0]
  if (command === undefined) fail('missing command after --')
  return { workspace, temp, mode, writeSid, tempWriteSid: parsedTempWriteSid, command, args: argv.slice(1) }
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`)
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  // Both directories are validated in both modes: a provider bug that passes
  // a bogus root must fail loudly at the runner boundary, never mid-child.
  requireDirectory('--workspace', parsed.workspace)
  requireDirectory('--temp', parsed.temp)

  const seamManaged = parsed.writeSid !== undefined || parsed.tempWriteSid !== undefined
  if (parsed.mode === 'read-only' && seamManaged) {
    fail('read-only does not accept --write-sid or --temp-write-sid')
  }
  if (parsed.mode === 'workspace-write' && (parsed.writeSid === undefined) !== (parsed.tempWriteSid === undefined)) {
    fail('workspace-write requires --write-sid and --temp-write-sid together')
  }
  if (parsed.mode === 'workspace-write') {
    assertTempRootOutsideWorkspace(parsed.workspace, parsed.temp)
  }

  const api = await win32()
  // Ignore this process's own CTRL+C: the confined child (same console) keeps
  // handling its own; the runner must survive to revoke grants and mirror the
  // child's exit code.
  if (api.setConsoleCtrlHandler(null, 1) === 0) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`)
  }

  let ownedTempDir: string | undefined
  let sandbox: AclSandbox | undefined
  let initialized = false
  try {
    let privateTempDir: string | null = null
    let writeSid: string | undefined
    let privateTempSid: string | undefined
    if (parsed.mode === 'workspace-write') {
      writeSid = workspaceWriteSid(parsed.workspace)
      if (seamManaged) {
        if (parsed.writeSid !== writeSid) fail('--write-sid does not match --workspace')
        privateTempDir = parsed.temp
        privateTempSid = tempWriteSid(privateTempDir)
        if (parsed.tempWriteSid !== privateTempSid) fail('--temp-write-sid does not match --temp')
      } else {
        ownedTempDir = mkdtempSync(join(parsed.temp, 'fizz-'))
        privateTempDir = ownedTempDir
        privateTempSid = tempWriteSid(privateTempDir)
      }
    }
    sandbox = new AclSandbox({
      writableDirs: parsed.mode === 'workspace-write' ? [parsed.workspace] : [],
      tempDir: privateTempDir,
      mode: parsed.mode,
      ...writeSid === undefined ? {} : { writeSid },
      ...privateTempSid === undefined ? {} : { tempWriteSid: privateTempSid },
      manageDacls: !seamManaged,
    })
    await sandbox.init()
    initialized = true

    if (privateTempDir !== null) {
      if (api.setEnvironmentVariableW('TMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TMP failed (Win32 ${api.getLastError()})`)
      }
      if (api.setEnvironmentVariableW('TEMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TEMP failed (Win32 ${api.getLastError()})`)
      }
    }

    /*
     * 别把 runner 自己的启动开关漏给真正的命令。
     *
     * Electron 打包态用 `ELECTRON_RUN_AS_NODE=1` 把本 runner 当纯 node 起；子进程以
     * 继承环境（`lpEnvironment` 传 NULL）创建，会原样带上它 —— 于是沙箱里再启动 Electron
     * （`npm run dev` 之类）会被当成 node 跑，表现为莫名其妙的 "Cannot find module"。
     * 删掉这一项只影响之后创建的子进程，对本进程已经生效的 node 模式没有影响。
     */
    delete process.env.ELECTRON_RUN_AS_NODE

    const child = sandbox.spawn({
      command: parsed.command,
      args: parsed.args,
      stdio: 'inherit',
    })
    const result = await child.wait()
    return result.exitCode
  } finally {
    // Cleanup failures must not mask the child's exit code: report and keep going.
    if (initialized) {
      try {
        sandbox?.dispose()
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (ownedTempDir !== undefined) {
      try {
        rmSync(ownedTempDir, { recursive: true, force: true })
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
}

main().then(
  (exitCode) => {
    // Exit-code mirroring is full-width on Windows, verified empirically on
    // this machine (Windows 11 build 26200, Node 24): a child that exits
    // with the NTSTATUS 0xC0000005 (STATUS_ACCESS_VIOLATION) is read back
    // by GetExitCodeProcess as the uint32 3221225477, and after
    // process.exitCode = 3221225477 the parent observes exactly
    // 3221225477 (spawnSync status). PowerShell's $LASTEXITCODE and cmd
    // print the signed view (-1073741819), but no truncation or masking
    // happens anywhere in the chain — the mirror contract holds for the
    // full 32-bit range, so no re-mapping is needed.
    process.exitCode = exitCode
  },
  (error: unknown) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(`${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = RUNNER_FAILURE_EXIT
  },
)
